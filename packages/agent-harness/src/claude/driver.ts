// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { BUDGET_EXHAUSTED, SESSION_ABORTED, bounded, type AgentUsage, type NativeToolUse } from "../common.js";
import { directLaunch, type Launch, type LaunchScope } from "../launch/index.js";
import { drainOnExit, signalGroup } from "../process/group.js";
import type { ClaudeSession } from "./session.js";
import { claudeUsage, type ClaudeResultEvent } from "./usage.js";

const MAX_STDERR_CHARS = 8_000;

/**
 * The flags `runClaudeProcess` itself passes Claude Code: the stream-json
 * control protocol and the session flag. A caller's own flags come in
 * `ClaudeProcessOptions.args`, between the two.
 */
export const CLAUDE_STREAM_FLAGS: readonly string[] = [
  "-p",
  "--output-format",
  "--input-format",
  "--verbose",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--permission-mode",
  "--permission-prompt-tool",
  "--resume",
  "--session-id",
];

/** The answer to a `can_use_tool` control request. */
export type ClaudeToolPermission =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface ClaudeProcessOptions {
  /** Claude Code executable. */
  command: string;
  /** The caller's flags (settings, tools, system prompt, MCP config, model, schema), placed after the protocol flags. */
  args: readonly string[];
  /** The session this turn runs in; a started session is resumed. */
  session: ClaudeSession;
  cwd: string;
  /** Claude Code's whole environment. */
  env: NodeJS.ProcessEnv;
  /** The user message that starts the turn. */
  prompt: string;
  /** How the process is spawned. Default: `directLaunch`. */
  launch?: Launch;
  launchScope?: LaunchScope;
  signal?: AbortSignal;
  /** How long a stopped process gets before SIGKILL. */
  killGraceMs: number;
  /** Time for an interrupt to finish the turn before falling back to SIGTERM. */
  interruptGraceMs: number;
  /** Stop when no model output arrives this long after starting; 0 disables. */
  startupTimeoutMs: number;
  /** Stop when no model output arrives this long while no tool is running; 0 disables. */
  responseTimeoutMs: number;
  /** Answers each `can_use_tool` control request while the turn is active; outside it every request is denied. */
  toolPolicy(toolName: unknown, input: unknown): Promise<ClaudeToolPermission>;
  /**
   * Reserve one more provider request when the stream shows it coming; false
   * refuses it and stops the turn. The caller reserves the first one, before
   * starting the process.
   */
  reserveModelCall(): Promise<boolean>;
  /** An MCP server that must report connected at `init`, and the failure summary when it does not. */
  requiredMcpServer?: { name: string; failure: string };
  /** Called on each event Claude Code streams, while its transcript may be growing. */
  onActivity?: () => void;
  /**
   * Called with each parsed stream event (assistant and user messages, system
   * and result events; control messages excluded), for a caller that records
   * what the agent did. It observes only: its return value is ignored.
   */
  onEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

/** How a Claude Code turn ended: a failure summary, or a successful `result` event for the caller to interpret. */
export type ClaudeProcessOutcome = { kind: "failed"; summary: string } | { kind: "result"; result: ClaudeResultEvent };

export interface ClaudeProcessRun {
  outcome: ClaudeProcessOutcome;
  /** Native (non-MCP) tools the turn ran; undefined when the process never ran or its output could not be parsed. */
  nativeTools?: NativeToolUse[];
  usage?: AgentUsage;
}

/**
 * Runs one Claude Code turn headless over the stream-json control protocol:
 * spawns it in its own process group, initializes the protocol, sends
 * `prompt`, answers permission requests through `toolPolicy`, reserves each
 * further provider request as the stream shows it coming, watches for
 * stalls, and stops it (interrupt, then SIGTERM, then SIGKILL) on abort or
 * when the turn is over. Nothing it started outlives the call.
 */
export async function runClaudeProcess(args: ClaudeProcessOptions): Promise<ClaudeProcessRun> {
  const { session: saved } = args;
  const turn = randomBytes(4).toString("hex");
  const cli = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--forward-subagent-text",
    "--permission-mode", "default",
    "--permission-prompt-tool", "stdio",
    ...args.args,
    saved.started ? "--resume" : "--session-id", saved.sessionId,
  ];

  // Nothing awaits between this check and the abort listener, so a stop during setup cannot miss the process.
  if (args.signal?.aborted) return { outcome: { kind: "failed", summary: SESSION_ABORTED } };
  const launched = (args.launch ?? directLaunch)(args.command, cli, args.env, args.cwd, args.launchScope ?? {});
  const child = spawn(launched.command, launched.args, {
    cwd: args.cwd,
    env: launched.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });

  let stopped = false;
  let terminated = false;
  let interruptTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const send = (message: unknown): boolean => {
    if (child.stdin.destroyed || child.stdin.writableEnded) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };
  const terminate = () => {
    // A descendant can retain the pipes after the CLI parent has exited.
    if (terminated || child.pid === undefined) return;
    terminated = true;
    signalGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(child.pid!, "SIGKILL"), args.killGraceMs);
  };
  const stop = () => {
    if (stopped || child.pid === undefined) return;
    stopped = true;
    if (!send({ type: "control_request", request_id: `interrupt-${turn}`, request: { subtype: "interrupt" } })) {
      terminate();
      return;
    }
    interruptTimer = setTimeout(terminate, args.interruptGraceMs);
  };
  const drainGroup = drainOnExit(child, terminate, args.killGraceMs);
  const onAbort = () => stop();
  args.signal?.addEventListener("abort", onAbort, { once: true });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  child.stdin.on("error", () => undefined);
  const initializeId = `initialize-${turn}`;
  send({ type: "control_request", request_id: initializeId, request: { subtype: "initialize", hooks: {} } });

  let result: ClaudeResultEvent | undefined;
  const results: ClaudeResultEvent[] = [];
  const background = new Set<string>();
  let finished = false;
  let initialized = false;
  // A resumed session can run a turn of its own before it reads the prompt.
  let prompted = false;
  let protocolFailed: string | undefined;
  let bridgeFailed = false;
  let budgetRefused = false;
  const seen = new Set<string>();
  let charged = 1;
  let lastResponse: string | undefined;
  let reservedAfter: string | undefined;
  let reservations = Promise.resolve();
  const reserve = () => {
    charged += 1;
    reservations = reservations.then(async () => {
      if (budgetRefused) return;
      if (!(await args.reserveModelCall())) {
        budgetRefused = true;
        stop();
      }
    }).catch(() => {
      protocolFailed = "Claude Code model request accounting failed";
      stop();
    });
  };

  // Model output is progress; while a tool (or a subagent) runs, silence is expected.
  let stalled: string | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  const running = new Set<string>();
  const arm = (ms: number, reason: string) => {
    clearTimeout(watchdog);
    watchdog = undefined;
    if (ms <= 0 || running.size > 0 || background.size > 0) return;
    watchdog = setTimeout(() => {
      stalled = reason;
      stop();
    }, ms);
  };
  arm(args.startupTimeoutMs, `no model output within ${seconds(args.startupTimeoutMs)} of starting`);

  let reaped = false;
  const nativeTools: NativeToolUse[] = [];
  let unparsed = false;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let event: {
        type?: string;
        subtype?: string;
        message?: { id?: unknown; content?: unknown };
        mcp_servers?: unknown;
        tool_use_id?: unknown;
        is_backgrounded?: unknown;
        isReplay?: unknown;
        request_id?: unknown;
        request?: { subtype?: unknown; tool_name?: unknown; input?: unknown };
        response?: { request_id?: unknown; subtype?: unknown; error?: unknown };
      };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        if (line.trim() !== "") unparsed = true;
        continue;
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        unparsed = true;
        continue;
      }
      // Any event may follow a transcript write; the session is copied while the turn goes on.
      args.onActivity?.();
      if (args.onEvent !== undefined && event.type !== "control_response" && event.type !== "control_request") {
        try {
          args.onEvent(event as Record<string, unknown>);
        } catch {
          // An observer's failure never changes the turn.
        }
      }
      if (event.type === "control_response") {
        if (event.response?.request_id === initializeId && !initialized) {
          if (event.response.subtype !== "success") {
            protocolFailed = "Claude Code rejected the control protocol initialization";
            stop();
          } else {
            initialized = true;
            if (!stopped) send({
              type: "user",
              session_id: saved.sessionId,
              parent_tool_use_id: null,
              message: { role: "user", content: args.prompt },
            });
          }
        }
        continue;
      }
      if (event.type === "control_request") {
        if (typeof event.request_id !== "string" || event.request_id.length === 0) {
          protocolFailed = "Claude Code sent a control request without an identity";
          stop();
          continue;
        }
        if (event.request?.subtype !== "can_use_tool") {
          send({ type: "control_response", response: {
            subtype: "error", request_id: event.request_id, error: "Unsupported control request",
          } });
          continue;
        }
        const permission = await args.toolPolicy(event.request.tool_name, event.request.input);
        send({ type: "control_response", response: {
          subtype: "success", request_id: event.request_id,
          response: stopped || !initialized || finished
            ? { behavior: "deny", message: "No active job turn" } : permission,
        } });
        continue;
      }
      if (event.type === "user" && event.isReplay === true) {
        prompted = true;
        continue;
      }
      if (event.type === "assistant" || event.type === "user" || (event.type === "system" && event.subtype === "thinking_tokens")) {
        trackTools(event.message?.content, running);
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content as { type?: unknown; name?: unknown }[]) {
            if (block?.type !== "tool_use") continue;
            const name = typeof block.name === "string" ? block.name : "unknown";
            // MCP tools are served by the caller, which accounts for them itself.
            if (!name.startsWith("mcp__")) nativeTools.push({ name });
          }
        }
        if (Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block?.type === "tool_use" && ["Agent", "Task"].includes(block.name) &&
                block.input?.run_in_background === true && typeof block.id === "string") background.add(block.id);
            if (block?.type === "tool_result" && block.is_error === true && typeof block.tool_use_id === "string") background.delete(block.tool_use_id);
          }
        }
        arm(args.responseTimeoutMs, `no model output for ${seconds(args.responseTimeoutMs)}`);
      }
      if (event.type === "system" && event.subtype === "task_started" && event.is_backgrounded === true && typeof event.tool_use_id === "string") {
        background.add(event.tool_use_id);
      }
      if (event.type === "system" && event.subtype === "task_notification" && typeof event.tool_use_id === "string") {
        background.delete(event.tool_use_id);
        arm(args.responseTimeoutMs, `no model output for ${seconds(args.responseTimeoutMs)}`);
      }
      if (event.type === "system" && event.subtype === "init" && args.requiredMcpServer !== undefined) {
        const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
        if (servers.find((s) => s?.name === args.requiredMcpServer!.name)?.status !== "connected") {
          bridgeFailed = true;
          stop();
        }
      } else if (event.type === "assistant" && typeof event.message?.id === "string" && !seen.has(event.message.id)) {
        // One response may arrive as several events and carry several tool calls.
        seen.add(event.message.id);
        lastResponse = event.message.id;
        if (seen.size > charged) reserve();
      } else if (event.type === "user" && hasToolResult(event.message?.content) && lastResponse !== undefined) {
        // Tool results go back in the next request: reserve it once per response.
        if (reservedAfter !== lastResponse && charged <= seen.size) {
          reservedAfter = lastResponse;
          reserve();
        }
      } else if (event.type === "result") {
        if (!initialized) protocolFailed = "Claude Code returned a result before control initialization";
        else if (!prompted && !stopped && (event as ClaudeResultEvent).is_error !== true) {
          results.push(event as ClaudeResultEvent);
          continue;
        }
        // A background subagent's report turn ends without repeating an earlier submission.
        const submitted = result?.structured_output;
        result = event as ClaudeResultEvent;
        if (result.structured_output === undefined && submitted !== undefined) result = { ...result, structured_output: submitted };
        results.push(result);
        if (background.size > 0 && !stopped && result.is_error !== true) continue;
        finished = true;
        clearTimeout(watchdog);
        clearTimeout(interruptTimer);
        // Close after the final turn, including background reports or an interrupted turn.
        child.stdin.end();
        interruptTimer = setTimeout(terminate, args.interruptGraceMs);
      }
    }
    clearTimeout(watchdog);
    // EOF without a result is terminal even if the process keeps running.
    if (result === undefined) terminate();
    const { code, error } = await exited;
    await drainGroup();
    reaped = true;
    await reservations;
    clearTimeout(interruptTimer);
    clearTimeout(killTimer);
    args.signal?.removeEventListener("abort", onAbort);

    const outcome = ((): ClaudeProcessOutcome => {
      const failed = (summary: string): ClaudeProcessOutcome => ({ kind: "failed", summary });
      if (budgetRefused) return failed(BUDGET_EXHAUSTED);
      if (args.signal?.aborted) return failed(SESSION_ABORTED);
      if (stalled !== undefined) return failed(`Claude Code stalled: ${stalled}`);
      if (bridgeFailed) return failed(args.requiredMcpServer!.failure);
      if (protocolFailed !== undefined) return failed(protocolFailed);
      if (error !== undefined) return failed(bounded(`could not start Claude Code (${args.command}): ${error.message}`));
      if (result === undefined) {
        return failed(bounded(`Claude Code exited with code ${code} and no result${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
      if (result.is_error === true || result.subtype !== "success") {
        const detail = stderr.trim() || result.result || "";
        return failed(bounded(`Claude Code run failed (${result.subtype ?? "error"})${detail ? `: ${detail}` : ""}`));
      }
      return { kind: "result", result };
    })();
    const usage = claudeUsage(results, saved.baseline);
    return {
      outcome,
      ...(unparsed ? {} : { nativeTools }),
      ...(usage !== undefined ? { usage } : {}),
    };
  } finally {
    clearTimeout(watchdog);
    clearTimeout(interruptTimer);
    args.signal?.removeEventListener("abort", onAbort);
    if (!reaped) {
      terminate();
      await exited;
      await drainGroup();
    }
    clearTimeout(killTimer);
  }
}

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}

/** Track tool calls still running: a `tool_use` starts one, its `tool_result` ends it. */
function trackTools(content: unknown, running: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content as { type?: unknown; id?: unknown; tool_use_id?: unknown }[]) {
    if (block?.type === "tool_use" && typeof block.id === "string") running.add(block.id);
    else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") running.delete(block.tool_use_id);
  }
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => (c as { type?: unknown })?.type === "tool_result");
}
