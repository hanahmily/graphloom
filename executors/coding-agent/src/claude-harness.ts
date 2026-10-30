// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyReferenceEnums, checkReferences, validateResultShape } from "@graphloom/sdk";
import {
  BUDGET_EXHAUSTED,
  SESSION_ABORTED,
  captureClaudeTurn,
  openClaudeSession,
  runClaudeProcess,
  type ClaudeResultEvent,
  type ClaudeSession,
  type ClaudeSessionSettings,
  type ClaudeSessionStore,
} from "#agent-harness/claude";
import { envList, minimalEnv } from "#agent-harness/process";
import { bounded, inlineObjectSchema, scopeNotes } from "./assignment.js";
import {
  CLAUDE_API_KEY_CREDENTIAL,
  CLAUDE_BIN_ENV,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS,
  CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS,
  CLAUDE_MODEL_ENV,
  CLAUDE_PASS_ENV_ENV,
  CLAUDE_RESPONSE_TIMEOUT_ENV,
  CLAUDE_STARTUP_TIMEOUT_ENV,
} from "./claude-config.js";
import {
  JOB_CONTRACT_ENV,
  JOB_IDENTITY_ENV,
  JOB_REFERENCES_ENV,
  fitWatchdog,
  type CodingHarness,
  type CodingRunRequest,
  type CodingRunResult,
  type CodingSessionOptions,
} from "./harness.js";
import { evaluateClaudePermission } from "./claude-permissions.js";
import { startToolBridge, type ToolBridge } from "./mcp-bridge.js";

export interface ClaudeCodeHarnessOptions {
  /** Claude Code executable. Default: `GRAPHLOOM_CLAUDE_BIN`, then `claude` on PATH. */
  command?: string;
  /** Model alias or name; a job's `harnessOptions.model` overrides it. Default: `GRAPHLOOM_CLAUDE_MODEL`, then Claude Code's own. */
  model?: string;
  /**
   * Claude Code config dir: its login, settings, and transcripts, so it selects
   * the account or gateway. Default: `GRAPHLOOM_CLAUDE_CONFIG_DIR`, then
   * `CLAUDE_CONFIG_DIR`, then `~/.claude`.
   */
  configDir?: string;
  /** Appended to Claude Code's system prompt. */
  systemPrompt?: string;
  /** How long a stopped process gets before SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
  /** Time for an interrupt to finish the turn before falling back to SIGTERM. Default 1000 ms. */
  interruptGraceMs?: number;
  /**
   * Extra environment variable names Claude Code may see. It otherwise gets
   * only `PATH`, `HOME`, locale, proxy, and similar basics, never the
   * controller's secrets. Default: `GRAPHLOOM_CLAUDE_PASS_ENV` (comma-separated).
   */
  passEnv?: string[];
  /** Stop Claude Code when it shows no model output this long after starting; 0 disables. Default: `GRAPHLOOM_CLAUDE_STARTUP_TIMEOUT_MS`, then 300000. */
  startupTimeoutMs?: number;
  /**
   * Stop Claude Code when no model output arrives this long while no tool is
   * running; 0 disables. Default: `GRAPHLOOM_CLAUDE_RESPONSE_TIMEOUT_MS`, then 600000.
   */
  responseTimeoutMs?: number;
}

/** The `--effort` levels of `claude --help`. */
export const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** MCP server name; graph tools appear to the model as `mcp__graphloom__<tool>`. */
const BRIDGE_NAME = "graphloom";

const DEFAULT_SYSTEM_PROMPT = [
  "You are running as a GraphLoom coding agent in a git worktree.",
  `Tools from the ${BRIDGE_NAME} MCP server go through the GraphLoom controller, which records each call; treat their results as the recorded observations.`,
  "Finish with a short summary of what you did and what you observed. Do not include secrets.",
].join(" ");

const RESULT_NOTE =
  "StructuredOutput is your final answer and ends your turn: call it once, with the complete result under `result`, and never with test or placeholder values.";

/**
 * Every flag a job's Claude Code run is passed (the shared driver's
 * `CLAUDE_STREAM_FLAGS` plus the ones `runClaude` below adds), for the B2
 * capability probe (docs/design-graph-rehearsal.md §3.1): a binary whose
 * `--help` is missing one of these silently lacks a feature this adapter
 * depends on. Keep this in sync with both.
 */
export const CLAUDE_CODE_ADAPTER_FLAGS: readonly string[] = [
  "-p",
  "--output-format",
  "--input-format",
  "--verbose",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--permission-mode",
  "--permission-prompt-tool",
  "--settings",
  "--tools",
  "--strict-mcp-config",
  "--append-system-prompt",
  "--mcp-config",
  "--model",
  "--effort",
  "--json-schema",
  "--resume",
  "--session-id",
];

/**
 * A `CodingHarness` that runs the user's Claude Code CLI headless in the
 * worktree with its full toolset. Graph tools are served to it over a local
 * MCP endpoint whose calls go to the controller as child operations. Claude
 * Code keeps its own login and transcripts; the harness copies each transcript
 * into the controller's session directory and restores it before a resume.
 */
export function createClaudeCodeHarness(harnessOptions: ClaudeCodeHarnessOptions = {}): CodingHarness {
  return {
    name: "claude-code",
    resumable: true,
    async createSession(options) {
      const command = harnessOptions.command ?? (process.env[CLAUDE_BIN_ENV] || "claude");
      const jobModel = options.options?.model;
      if (jobModel !== undefined && typeof jobModel !== "string") throw new Error("harnessOptions.model must be a string");
      const model = jobModel ?? harnessOptions.model ?? (process.env[CLAUDE_MODEL_ENV] || undefined);
      const configDir =
        harnessOptions.configDir ?? (process.env[CLAUDE_CONFIG_DIR_ENV] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
      const systemPrompt = harnessOptions.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      const passEnv = harnessOptions.passEnv ?? envList(process.env[CLAUDE_PASS_ENV_ENV]);
      if (passEnv.includes("ANTHROPIC_API_KEY")) {
        throw new Error(`passEnv cannot include ANTHROPIC_API_KEY; bind the ${CLAUDE_API_KEY_CREDENTIAL} credential instead`);
      }
      // Each job's own wall clock bounds the watchdogs, so a longer job keeps the full ones and a shorter one still reports a stall.
      const startupTimeoutMs = fitWatchdog(harnessOptions.startupTimeoutMs ?? envMs(CLAUDE_STARTUP_TIMEOUT_ENV, CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS), options.timeoutMs);
      const responseTimeoutMs = fitWatchdog(harnessOptions.responseTimeoutMs ?? envMs(CLAUDE_RESPONSE_TIMEOUT_ENV, CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS), options.timeoutMs);
      const jobEffort = options.options?.effort;
      if (jobEffort !== undefined && typeof jobEffort !== "string") throw new Error("harnessOptions.effort must be a string");
      if (jobEffort !== undefined && !CLAUDE_EFFORTS.has(jobEffort)) {
        throw new Error(`Claude Code effort must be one of ${[...CLAUDE_EFFORTS].join(", ")}`);
      }
      const effort = jobEffort;
      const settings: ClaudeSessionSettings = { model: model ?? null, ...(effort !== undefined ? { effort } : {}), systemPromptSha256: sha256(systemPrompt) };
      const store: ClaudeSessionStore = { configDir, settings, ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}) };
      const saved = await openClaudeSession(store, options.resume);
      const apiKey = await options.credentials?.get(CLAUDE_API_KEY_CREDENTIAL);
      const redact = (text: string) => (apiKey ? text.replaceAll(apiKey, "[REDACTED]") : text);

      return {
        async run(request) {
          const { value: result, sessionRef } = await captureClaudeTurn(
            store,
            saved,
            {
              resumed: options.resume !== undefined,
              ...(options.onSessionSaved !== undefined ? { onSessionSaved: (ref: string) => options.onSessionSaved?.(ref) } : {}),
            },
            (onActivity) =>
              runClaude({
                command,
                model,
                effort,
                systemPrompt,
                killGraceMs: harnessOptions.killGraceMs ?? 5_000,
                interruptGraceMs: harnessOptions.interruptGraceMs ?? 1_000,
                startupTimeoutMs,
                responseTimeoutMs,
                env: childEnv(passEnv, configDir, apiKey),
                request,
                options,
                saved,
                ...(onActivity !== undefined ? { onActivity } : {}),
              }),
          );
          const summary = redact(result.summary);
          return sessionRef !== undefined ? { ...result, summary, sessionRef } : { ...result, summary };
        },
      };
    },
  };
}

function envMs(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} must be a non-negative number of milliseconds`);
  return ms;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Claude Code's environment: the basics it needs plus `passEnv`, never the rest of the controller's. */
function childEnv(passEnv: string[], configDir: string, apiKey: string | undefined): NodeJS.ProcessEnv {
  const env = minimalEnv(process.env, passEnv);
  env.CLAUDE_CONFIG_DIR = configDir;
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

interface RunArgs {
  command: string;
  model: string | undefined;
  effort: string | undefined;
  systemPrompt: string;
  killGraceMs: number;
  interruptGraceMs: number;
  startupTimeoutMs: number;
  responseTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  request: CodingRunRequest;
  options: CodingSessionOptions;
  saved: ClaudeSession;
  /** Called on each event Claude Code streams, while its transcript may be growing. */
  onActivity?: () => void;
}

async function runClaude(args: RunArgs): Promise<CodingRunResult> {
  const { options, request, saved } = args;
  if (options.signal?.aborted) return { status: "failed", summary: SESSION_ABORTED };
  // Claude Code has no hook before each provider request: the first is
  // reserved up front, and each later one when the stream shows it coming.
  if (!(await options.reserveModelCall())) return { status: "failed", summary: BUDGET_EXHAUSTED };

  const turn = randomBytes(4).toString("hex");
  let seq = 0;
  let bridge: ToolBridge | undefined;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "gl-claude-"));
  try {
    // The driver adds the stream-json protocol flags before these and the session flag after them.
    const cli = [
      "--settings", JSON.stringify({ permissions: { ask: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "mcp__graphloom__*"] } }),
      "--tools", "default",
      "--strict-mcp-config",
      "--append-system-prompt", args.systemPrompt,
    ];
    if (options.tools.length > 0) {
      bridge = await startToolBridge(options.tools, () => `claude-${turn}-${(seq += 1)}`);
      const config = path.join(scratch, "mcp.json");
      const server = { type: "http", url: bridge.url, headers: { Authorization: `Bearer ${bridge.token}` } };
      await writeFile(config, JSON.stringify({ mcpServers: { [BRIDGE_NAME]: server } }), { mode: 0o600 });
      cli.push("--mcp-config", config);
    }
    if (args.model !== undefined) cli.push("--model", args.model);
    if (args.effort !== undefined) cli.push("--effort", args.effort);
    const wantsResult = request.resultContract !== undefined || request.resultSchema !== undefined;
    if (wantsResult) {
      // Claude has no in-turn retry in this harness, so the reference id
      // set is baked into the schema as `enum` up front (§4.3) rather than left
      // for a post-turn reconciliation pass to catch.
      const schema =
        (request.resultContract !== undefined
          ? applyReferenceEnums(request.resultContract.schema, request.resultContract.references, request.resultContract.knownReferences)
          : undefined) ??
        inlineObjectSchema(request.resultSchema!) ?? {
          type: "object",
          description: `${request.resultSchema} result`,
          additionalProperties: true,
        };
      // With one object parameter the model writes the result as JSON. With one parameter per
      // field, a long raw-text field can swallow the fields after it.
      const wrapped = { type: "object", properties: { result: schema }, required: ["result"], additionalProperties: false };
      cli.push("--json-schema", JSON.stringify(wrapped));
    }

    const childEnv = { ...args.env };
    const contractName = request.resultContract?.name ?? request.resultSchema;
    if (contractName !== undefined) childEnv[JOB_CONTRACT_ENV] = contractName;
    if (request.identity !== undefined) childEnv[JOB_IDENTITY_ENV] = JSON.stringify(request.identity);
    if (request.resultContract?.knownReferences !== undefined) childEnv[JOB_REFERENCES_ENV] = JSON.stringify(request.resultContract.knownReferences);

    const run = await runClaudeProcess({
      command: args.command,
      args: cli,
      session: saved,
      cwd: options.cwd,
      env: childEnv,
      prompt: [request.assignment, ...scopeNotes(options), ...(wantsResult ? [RESULT_NOTE] : [])].join("\n\n"),
      killGraceMs: args.killGraceMs,
      interruptGraceMs: args.interruptGraceMs,
      startupTimeoutMs: args.startupTimeoutMs,
      responseTimeoutMs: args.responseTimeoutMs,
      toolPolicy: (toolName, input) => evaluateClaudePermission(toolName, input, options),
      reserveModelCall: () => options.reserveModelCall(),
      ...(bridge !== undefined
        ? { requiredMcpServer: { name: BRIDGE_NAME, failure: "Claude Code could not connect to the GraphLoom tool server" } }
        : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(args.onActivity !== undefined ? { onActivity: args.onActivity } : {}),
    });
    const outcome: CodingRunResult =
      run.outcome.kind === "failed" ? { status: "failed", summary: run.outcome.summary } : interpretResult(run.outcome.result, request);
    const tooled: CodingRunResult = run.nativeTools === undefined ? outcome : { ...outcome, nativeTools: run.nativeTools };
    return run.usage !== undefined ? { ...tooled, usage: run.usage } : tooled;
  } finally {
    await bridge?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** A successful turn as the job's result: its submission checked against the job's result contract, or its final text. */
function interpretResult(result: ClaudeResultEvent, request: CodingRunRequest): CodingRunResult {
  if (request.resultContract !== undefined || request.resultSchema !== undefined) {
    const name = request.resultContract?.name ?? request.resultSchema!;
    const output = (result.structured_output as { result?: unknown } | null | undefined)?.result;
    if (output === undefined) {
      return { status: "failed", summary: `agent finished without submitting a ${name} result` };
    }
    if (request.resultContract !== undefined) {
      const problems = validateResultShape(output, request.resultContract.schema);
      let value: unknown = output;
      if (problems.length === 0 && request.resultContract.references !== undefined && request.resultContract.knownReferences !== undefined) {
        const checked = checkReferences(output, request.resultContract.references, request.resultContract.knownReferences);
        problems.push(...checked.problems);
        value = checked.value;
      }
      if (problems.length > 0) {
        // B2's --json-schema makes a type-level miss rare; a reference
        // outside the shown set is the likely case here. Claude Code
        // has no further turn in this run to correct it in, so the job
        // fails as a named contract violation rather than recording an
        // invalid result as if it were accepted.
        return {
          status: "failed",
          summary: bounded(`result did not satisfy its declared contract (${name}): ${problems.join("; ")}`),
          failureKind: "contract_violation",
          output,
        };
      }
      const submitted = (value as { summary?: unknown } | null)?.summary;
      return {
        status: "completed",
        summary: bounded(typeof submitted === "string" ? submitted : `Claude Code submitted a ${name} result`),
        output: value,
      };
    }
    const submitted = (output as { summary?: unknown } | null)?.summary;
    return {
      status: "completed",
      summary: bounded(typeof submitted === "string" ? submitted : `Claude Code submitted a ${name} result`),
      output,
    };
  }
  return { status: "completed", summary: bounded(result.result?.trim() || "Claude Code completed") };
}
