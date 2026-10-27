// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { BUDGET_EXHAUSTED, SESSION_ABORTED, bounded, count, type AgentUsage, type NativeToolUse } from "../common.js";
import { directLaunch, type Launch, type LaunchScope } from "../launch/index.js";
import { drainOnExit, signalGroup } from "../process/group.js";
import type { CodexThread } from "./session.js";

const MAX_STDERR_CHARS = 8_000;
const THREAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The `codex exec` flags `runCodexProcess` itself passes; a caller's own come in `CodexProcessOptions.args`. */
export const CODEX_EXEC_FLAGS: readonly string[] = [
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "--cd",
  "--output-last-message",
  "--model",
  "--config",
];

interface CodexEvent {
  type?: string;
  thread_id?: unknown;
  item?: { id?: unknown; type?: unknown };
  usage?: Record<string, unknown>;
  error?: { message?: unknown };
  message?: unknown;
}

export interface CodexProcessOptions {
  /** Codex executable. */
  command: string;
  /** The thread this turn continues once started; a fresh run records the id Codex names. */
  thread: CodexThread;
  cwd: string;
  /** Codex's whole environment. */
  env: NodeJS.ProcessEnv;
  /** The prompt, written to Codex's stdin. */
  prompt: string;
  /** Codex's `--sandbox` mode for a fresh thread and a resumed one. */
  sandbox: string;
  /** Persist nothing (`--ephemeral`): nothing will continue this thread. */
  ephemeral: boolean;
  model?: string;
  /** `model_reasoning_effort`, passed through `--config`. */
  reasoningEffort?: string;
  /** The caller's flags (an output schema), placed after the model settings. */
  args?: readonly string[];
  /** Where Codex writes its final message (`--output-last-message`). */
  lastMessageFile: string;
  /** How the process is spawned. Default: `directLaunch`. */
  launch?: Launch;
  launchScope?: LaunchScope;
  signal?: AbortSignal;
  /** Stop when Codex shows no activity this long while no command is running; 0 disables. */
  responseTimeoutMs: number;
  /** How long a stopped process gets before SIGKILL. */
  killGraceMs: number;
  /**
   * Reserve one more provider request after each command whose output goes
   * back to the model; false refuses it and stops the turn. The caller
   * reserves the first one, before starting the process.
   */
  reserveModelCall(): Promise<boolean>;
  /** Called on each event Codex streams, while its rollout may be growing. */
  onActivity?: () => void;
  /** Sees each event Codex streams, as parsed (the supervisor records its investigation steps from them). */
  onEvent?: (event: Readonly<Record<string, unknown>>) => void;
}

/** How a Codex turn ended: a failure summary, or its final message for the caller to interpret. */
export type CodexProcessOutcome = { kind: "failed"; summary: string } | { kind: "completed"; message: string };

export interface CodexProcessRun {
  outcome: CodexProcessOutcome;
  /** Every item Codex ran on its own; undefined when the process never ran or its output could not be parsed. */
  nativeTools?: NativeToolUse[];
  usage?: AgentUsage;
}

/**
 * Runs one `codex exec --json` turn (or `exec resume` of a started thread)
 * in its own process group: writes the prompt to its stdin, records the
 * thread Codex names, reserves a provider request after each command, watches
 * for stalls, and stops the group on abort or once the turn is over. Nothing
 * it started outlives the call.
 */
export async function runCodexProcess(args: CodexProcessOptions): Promise<CodexProcessRun> {
  const { thread } = args;
  const last = args.lastMessageFile;
  // `resume` takes the sandbox and working directory from `exec` itself, and the rest after it.
  const cli =
    thread.started && thread.threadId !== undefined
      ? ["exec", "--sandbox", args.sandbox, "--cd", args.cwd, "resume", "--json", "--skip-git-repo-check", "--output-last-message", last]
      : ["exec", "--json", ...(args.ephemeral ? ["--ephemeral"] : []), "--skip-git-repo-check", "--sandbox", args.sandbox, "--cd", args.cwd, "--output-last-message", last];
  if (args.model !== undefined) cli.push("--model", args.model);
  if (args.reasoningEffort !== undefined) cli.push("--config", `model_reasoning_effort="${args.reasoningEffort}"`);
  cli.push(...(args.args ?? []));
  if (thread.started && thread.threadId !== undefined) cli.push(thread.threadId);
  cli.push("-");

  // Nothing awaits between this check and the abort listener, so a stop during setup cannot miss the process.
  if (args.signal?.aborted) return { outcome: { kind: "failed", summary: SESSION_ABORTED } };
  const launched = (args.launch ?? directLaunch)(args.command, cli, args.env, args.cwd, args.launchScope ?? {});
  const child = spawn(launched.command, launched.args, { cwd: args.cwd, env: launched.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  let terminated = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (terminated || child.pid === undefined) return;
    terminated = true;
    signalGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(child.pid!, "SIGKILL"), args.killGraceMs);
  };
  const drainGroup = drainOnExit(child, terminate, args.killGraceMs);
  args.signal?.addEventListener("abort", terminate, { once: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(args.prompt);

  let budgetRefused = false;
  let reservations = Promise.resolve();
  let accountingFailed = false;
  const reserve = () => {
    reservations = reservations.then(async () => {
      if (budgetRefused) return;
      if (!(await args.reserveModelCall())) {
        budgetRefused = true;
        terminate();
      }
    }).catch(() => {
      accountingFailed = true;
      terminate();
    });
  };
  // While a command runs, silence is expected.
  const running = new Set<unknown>();
  let stalled = false;
  let watchdog: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(watchdog);
    watchdog = undefined;
    if (args.responseTimeoutMs <= 0 || running.size > 0) return;
    watchdog = setTimeout(() => {
      stalled = true;
      terminate();
    }, args.responseTimeoutMs);
  };
  arm();

  const nativeTools: NativeToolUse[] = [];
  const toolIds = new Set<unknown>();
  let unparsed = false;
  let completed = false;
  let closeTimer: NodeJS.Timeout | undefined;
  let closedAfterTurn = false;
  let failure: string | undefined;
  // An `error` event alone is not the end: Codex reports each reconnect it
  // retries itself this way, and a turn that then completes has succeeded.
  let streamError: string | undefined;
  let usage: AgentUsage | undefined;
  let reaped = false;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        if (line.trim() !== "") unparsed = true;
        continue;
      }
      if (event === null || typeof event !== "object" || Array.isArray(event)) {
        unparsed = true;
        continue;
      }
      if (event.type === "thread.started" && typeof event.thread_id === "string" && THREAD_ID.test(event.thread_id)) {
        // Codex names the thread first: from here its rollout can be saved and resumed.
        if (!thread.started) {
          // A fresh run names a new thread, whatever an earlier unsaved run of this session named.
          if (thread.threadId !== event.thread_id) delete thread.rollout;
          thread.threadId = event.thread_id;
        } else if (thread.threadId?.toLowerCase() !== event.thread_id.toLowerCase()) {
          failure = `Codex continued thread ${event.thread_id}, not the saved thread ${thread.threadId}`;
          terminate();
        }
      }
      args.onActivity?.();
      args.onEvent?.(event as Readonly<Record<string, unknown>>);
      const item = event.item;
      if (item !== undefined && item !== null && (event.type === "item.started" || event.type === "item.completed") && !toolIds.has(item.id)) {
        if (item.type !== "agent_message" && item.type !== "reasoning") {
          toolIds.add(item.id);
          nativeTools.push(codexToolUse(item));
        }
      }
      if (event.type === "item.started" && item?.type === "command_execution") running.add(item.id);
      if (event.type === "item.completed" && item?.type === "command_execution") {
        running.delete(item.id);
        reserve();
      }
      if (event.type === "turn.failed") failure = text(event.error?.message) ?? "turn failed";
      if (event.type === "error") streamError = text(event.message) ?? "error";
      if (event.type === "turn.completed") {
        completed = true;
        usage = codexUsage(event.usage) ?? usage;
        clearTimeout(watchdog);
        // A descendant can retain the pipes after Codex has finished its turn.
        closeTimer = setTimeout(() => {
          closedAfterTurn = true;
          terminate();
        }, args.killGraceMs);
      }
      if (!completed) arm();
    }
    clearTimeout(watchdog);
    const { code, error } = await exited;
    await drainGroup();
    reaped = true;
    await reservations;
    clearTimeout(closeTimer);
    clearTimeout(killTimer);

    const outcome = await (async (): Promise<CodexProcessOutcome> => {
      const failed = (summary: string): CodexProcessOutcome => ({ kind: "failed", summary });
      if (budgetRefused) return failed(BUDGET_EXHAUSTED);
      if (args.signal?.aborted) return failed(SESSION_ABORTED);
      if (stalled) return failed(`Codex stalled: no activity for ${args.responseTimeoutMs / 1000}s`);
      if (accountingFailed) return failed("Codex model request accounting failed");
      if (error !== undefined) return failed(bounded(`could not start Codex (${args.command}): ${error.message}`));
      if (failure !== undefined || (code !== 0 && !closedAfterTurn) || !completed) {
        const detail = failure ?? streamError ?? (stderr.trim() || `exit code ${code}`);
        return failed(bounded(`Codex run failed: ${detail}`));
      }
      return { kind: "completed", message: (await readFile(last, "utf8").catch(() => "")).trim() };
    })();
    return {
      outcome,
      ...(unparsed ? {} : { nativeTools }),
      ...(usage !== undefined ? { usage } : {}),
    };
  } finally {
    clearTimeout(watchdog);
    clearTimeout(closeTimer);
    args.signal?.removeEventListener("abort", terminate);
    if (!reaped) {
      terminate();
      await exited;
      await drainGroup();
    }
    clearTimeout(killTimer);
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Codex reports `input_tokens` including the cached part. */
export function codexUsage(usage: Record<string, unknown> | undefined): AgentUsage | undefined {
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  const input = count(usage.input_tokens);
  const cached = count(usage.cached_input_tokens);
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: cached,
    cacheWriteTokens: count(usage.cache_write_input_tokens),
  };
}

/** Every command, patch, search or other item counts: nothing Codex runs on its own is proven side-effect free. */
function codexToolUse(item: { type?: unknown }): NativeToolUse {
  return { name: typeof item.type === "string" ? item.type : "unknown" };
}
