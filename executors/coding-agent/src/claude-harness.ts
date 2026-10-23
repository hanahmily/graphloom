import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { applyReferenceEnums, checkReferences, validateResultShape } from "@graphloom/sdk";
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
  type CodingHarness,
  type CodingRunRequest,
  type CodingRunResult,
  type CodingSessionOptions,
  type CodingUsage,
  type NativeToolUse,
} from "./harness.js";
import { drainOnExit, signalGroup } from "./process-group.js";
import { envList, minimalEnv } from "./child-env.js";
import { copyFiles, filesUnder, readScanned } from "./session-files.js";
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

const SESSION_REF = /^claude-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const PROJECT_DIR = /^[A-Za-z0-9._-]+$/;
const BUDGET_EXHAUSTED = "model request budget exhausted";
const MAX_STDERR_CHARS = 8_000;
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
 * Every flag `runClaude` below passes Claude Code, for the B2 capability
 * probe (docs/design-graph-rehearsal.md §3.1): a binary whose `--help` is
 * missing one of these silently lacks a feature this adapter depends on. Keep
 * this in sync with the `cli.push(...)` calls in `runClaude`.
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
  "--json-schema",
  "--resume",
  "--session-id",
];

interface SavedSession {
  sessionId: string;
  ref: string;
  /** True once the Claude Code session exists, so the next run resumes it. */
  started: boolean;
  /** Session totals Claude Code restores when it resumes, from the transcript's last `cost-state` record. */
  baseline?: Totals;
}

/** Usage totals; Claude Code's `modelUsage` and `total_cost_usd` span the whole session, subagents included. */
interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

/** Settings a resumed session must share with the one that recorded its earlier turns. */
interface SessionSettings {
  model: string | null;
  systemPromptSha256: string;
}

interface ResultEvent {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: unknown;
  total_cost_usd?: unknown;
}

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
      const startupTimeoutMs = harnessOptions.startupTimeoutMs ?? envMs(CLAUDE_STARTUP_TIMEOUT_ENV, CLAUDE_DEFAULT_STARTUP_TIMEOUT_MS);
      const responseTimeoutMs = harnessOptions.responseTimeoutMs ?? envMs(CLAUDE_RESPONSE_TIMEOUT_ENV, CLAUDE_DEFAULT_RESPONSE_TIMEOUT_MS);
      const settings: SessionSettings = { model: model ?? null, systemPromptSha256: sha256(systemPrompt) };
      const saved = await openSession(options, configDir, settings);
      const apiKey = await options.credentials?.get(CLAUDE_API_KEY_CREDENTIAL);
      const redact = (text: string) => (apiKey ? text.replaceAll(apiKey, "[REDACTED]") : text);

      return {
        async run(request) {
          const result = await runClaude({
            command,
            model,
            systemPrompt,
            killGraceMs: harnessOptions.killGraceMs ?? 5_000,
            interruptGraceMs: harnessOptions.interruptGraceMs ?? 1_000,
            startupTimeoutMs,
            responseTimeoutMs,
            env: childEnv(passEnv, configDir, apiKey),
            request,
            options,
            saved,
          });
          const summary = redact(result.summary);
          if (options.sessionDir === undefined || !(await saveTranscript(configDir, options.sessionDir, saved, settings))) {
            return { ...result, summary };
          }
          saved.started = true;
          return { ...result, summary, sessionRef: saved.ref };
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

function describeModel(model: string | null): string {
  return model === null ? "Claude Code's default model" : `model ${model}`;
}

/** Restore the session `resume` names into Claude Code's store, or fail; never start a fresh one in its place. */
async function openSession(options: CodingSessionOptions, configDir: string, settings: SessionSettings): Promise<SavedSession> {
  if (options.resume === undefined) {
    const sessionId = randomUUID();
    return { sessionId, ref: `claude-${sessionId}`, started: false };
  }
  const ref = options.resume;
  const sessionId = SESSION_REF.exec(ref)?.[1];
  if (sessionId === undefined) throw new Error(`malformed session ref ${ref}`);
  if (options.sessionDir === undefined) throw new Error("no session directory to restore from");
  const [meta, transcript] = await Promise.all([
    readFile(path.join(options.sessionDir, `${ref}.json`), "utf8").catch(() => undefined),
    readFile(path.join(options.sessionDir, `${ref}.jsonl`), "utf8").catch(() => undefined),
  ]);
  if (meta === undefined || transcript === undefined) throw new Error(`no saved session for ${ref}`);
  if (transcript.trim() === "") throw new Error(`saved session ${ref} is empty`);
  let recorded: { project?: unknown; model?: unknown; systemPromptSha256?: unknown };
  try {
    recorded = JSON.parse(meta) as typeof recorded;
    for (const line of transcript.split("\n")) if (line.trim() !== "") JSON.parse(line);
  } catch {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  const { project, model, systemPromptSha256 } = recorded ?? {};
  if (
    typeof project !== "string" ||
    !PROJECT_DIR.test(project) ||
    project === "." ||
    project === ".." ||
    (model !== null && typeof model !== "string") ||
    typeof systemPromptSha256 !== "string"
  ) {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  // Claude Code resumes under any settings; earlier turns reasoned under others would pass as continuity.
  if (model !== settings.model) {
    throw new Error(`saved session ${ref} ran on ${describeModel(model)}; this job asks for ${describeModel(settings.model)}`);
  }
  if (systemPromptSha256 !== settings.systemPromptSha256) {
    throw new Error(`saved session ${ref} ran with a different system prompt`);
  }
  const savedSide = path.join(options.sessionDir, ref);
  const side = await filesUnder(savedSide);
  if (side?.other) throw new Error(`saved session ${ref} is corrupt`);
  await writeAtomic(path.join(configDir, "projects", project, `${sessionId}.jsonl`), transcript);
  // The saved copy is authoritative for the side files too, so none of the store's own survive.
  const storeSide = path.join(configDir, "projects", project, sessionId);
  await rm(storeSide, { recursive: true, force: true });
  if (side !== undefined) await copyFiles(savedSide, side.files, storeSide);
  const baseline = costState(transcript);
  return { sessionId, ref, started: true, ...(baseline !== undefined ? { baseline } : {}) };
}

/** Copy Claude Code's transcript into the controller's session directory; false when it wrote none. */
async function saveTranscript(configDir: string, sessionDir: string, saved: SavedSession, settings: SessionSettings): Promise<boolean> {
  const projects = path.join(configDir, "projects");
  const dirs = await readdir(projects).catch(() => [] as string[]);
  for (const project of dirs) {
    if (!PROJECT_DIR.test(project) || !(await lstat(path.join(projects, project)).catch(() => undefined))?.isDirectory()) continue;
    const file = path.join(projects, project, `${saved.sessionId}.jsonl`);
    const info = await lstat(file, { bigint: true }).catch(() => undefined);
    if (!info?.isFile()) continue;
    const transcript = (await readScanned(file, info)).toString("utf8");
    await saveSide(path.join(projects, project, saved.sessionId), path.join(sessionDir, saved.ref));
    await writeAtomic(path.join(sessionDir, `${saved.ref}.jsonl`), transcript);
    await writeAtomic(path.join(sessionDir, `${saved.ref}.json`), JSON.stringify({ project, ...settings }));
    const baseline = costState(transcript);
    if (baseline !== undefined) saved.baseline = baseline;
    return true;
  }
  return false;
}

/**
 * Mirror the session's side directory (subagent transcripts, which a resumed
 * session needs to continue a subagent, and tool output spilled to files) into
 * `target`, replacing what was there. Only regular files are session state.
 */
async function saveSide(source: string, target: string): Promise<void> {
  const side = await filesUnder(source);
  if (side === undefined) {
    await rm(target, { recursive: true, force: true });
    return;
  }
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await copyFiles(source, side.files, tmp);
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

interface RunArgs {
  command: string;
  model: string | undefined;
  systemPrompt: string;
  killGraceMs: number;
  interruptGraceMs: number;
  startupTimeoutMs: number;
  responseTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  request: CodingRunRequest;
  options: CodingSessionOptions;
  saved: SavedSession;
}

async function runClaude(args: RunArgs): Promise<CodingRunResult> {
  const { options, request, saved } = args;
  if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
  // Claude Code has no hook before each provider request: the first is
  // reserved up front, and each later one when the stream shows it coming.
  if (!(await options.reserveModelCall())) return { status: "failed", summary: BUDGET_EXHAUSTED };

  const turn = randomBytes(4).toString("hex");
  let seq = 0;
  let bridge: ToolBridge | undefined;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "gl-claude-"));
  try {
    const cli = [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--forward-subagent-text",
      "--permission-mode", "default",
      "--permission-prompt-tool", "stdio",
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
    if (request.resultContract !== undefined || request.resultSchema !== undefined) {
      // Claude has no in-turn retry in this harness, so the reference id set
      // is baked into the schema as `enum` up front (§4.3) rather than left
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
    cli.push(saved.started ? "--resume" : "--session-id", saved.sessionId);

    const childEnv = { ...args.env };
    const contractName = request.resultContract?.name ?? request.resultSchema;
    if (contractName !== undefined) childEnv[JOB_CONTRACT_ENV] = contractName;
    if (request.identity !== undefined) childEnv[JOB_IDENTITY_ENV] = JSON.stringify(request.identity);
    if (request.resultContract?.knownReferences !== undefined) childEnv[JOB_REFERENCES_ENV] = JSON.stringify(request.resultContract.knownReferences);

    // Nothing awaits between this check and the abort listener, so a stop during setup cannot miss the process.
    if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
    const child = spawn(args.command, cli, {
      cwd: options.cwd,
      env: childEnv,
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
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on("error", () => undefined);
    const initializeId = `initialize-${turn}`;
    send({ type: "control_request", request_id: initializeId, request: { subtype: "initialize", hooks: {} } });

    let result: ResultEvent | undefined;
    const results: ResultEvent[] = [];
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
        if (!(await options.reserveModelCall())) {
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
                message: { role: "user", content: [request.assignment, ...scopeNotes(options), ...(request.resultContract !== undefined || request.resultSchema !== undefined ? [RESULT_NOTE] : [])].join("\n\n") },
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
          const permission = await evaluateClaudePermission(event.request.tool_name, event.request.input, options);
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
              // Graph tools reach Claude through the MCP bridge and are accounted by the controller.
              if (!name.startsWith("mcp__")) nativeTools.push({ name, readOnly: CLAUDE_READ_ONLY_TOOLS.has(name) });
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
        if (event.type === "system" && event.subtype === "init" && bridge !== undefined) {
          const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
          if (servers.find((s) => s?.name === BRIDGE_NAME)?.status !== "connected") {
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
          else if (!prompted && !stopped && (event as ResultEvent).is_error !== true) {
            results.push(event as ResultEvent);
            continue;
          }
          // A background subagent's report turn ends without repeating an earlier submission.
          const submitted = result?.structured_output;
          result = event as ResultEvent;
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
      options.signal?.removeEventListener("abort", onAbort);

      const outcome = ((): CodingRunResult => {
        if (budgetRefused) return { status: "failed", summary: BUDGET_EXHAUSTED };
        if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
        if (stalled !== undefined) return { status: "failed", summary: `Claude Code stalled: ${stalled}` };
        if (bridgeFailed) return { status: "failed", summary: "Claude Code could not connect to the GraphLoom tool server" };
        if (protocolFailed !== undefined) return { status: "failed", summary: protocolFailed };
        if (error !== undefined) return { status: "failed", summary: bounded(`could not start Claude Code (${args.command}): ${error.message}`) };
        if (result === undefined) {
          return { status: "failed", summary: bounded(`Claude Code exited with code ${code} and no result${stderr.trim() ? `: ${stderr.trim()}` : ""}`) };
        }
        if (result.is_error === true || result.subtype !== "success") {
          const detail = stderr.trim() || result.result || "";
          return { status: "failed", summary: bounded(`Claude Code run failed (${result.subtype ?? "error"})${detail ? `: ${detail}` : ""}`) };
        }
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
      })();
      const usage = usageOf(results, saved.baseline);
      const tooled: CodingRunResult = unparsed ? outcome : { ...outcome, nativeTools };
      return usage !== undefined ? { ...tooled, usage } : tooled;
    } finally {
      clearTimeout(watchdog);
      clearTimeout(interruptTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!reaped) {
        terminate();
        await exited;
        await drainGroup();
      }
      clearTimeout(killTimer);
    }
  } finally {
    await bridge?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}

/** Claude Code's own tools that cannot change anything outside the transcript. */
const CLAUDE_READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "LS"]);

/** Track tool calls still running: a `tool_use` starts one, its `tool_result` ends it. */
function trackTools(content: unknown, running: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const block of content as { type?: unknown; id?: unknown; tool_use_id?: unknown }[]) {
    if (block?.type === "tool_use" && typeof block.id === "string") running.add(block.id);
    else if (block?.type === "tool_result" && typeof block.tool_use_id === "string") running.delete(block.tool_use_id);
  }
}

/**
 * This run's usage. Streamed per-message counts are partial, and a result's
 * `usage` covers only its turn's main thread, so prefer the session totals in
 * `modelUsage`, which include subagents, less what Claude Code restored.
 */
function usageOf(results: ResultEvent[], baseline: Totals | undefined): CodingUsage | undefined {
  const last = results.at(-1);
  const totals = last !== undefined ? modelTotals(last.modelUsage, last.total_cost_usd) : undefined;
  if (totals !== undefined) {
    // Totals below the baseline mean Claude Code started this run from zero.
    return baseline !== undefined && covers(totals, baseline) ? less(totals, baseline) : totals;
  }
  const usage = last?.usage;
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    ...(typeof last!.total_cost_usd === "number" ? { costUsd: last!.total_cost_usd } : {}),
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum Claude Code's per-model `modelUsage`; undefined when it reports none. */
function modelTotals(modelUsage: unknown, costUsd: unknown): Totals | undefined {
  if (modelUsage === null || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return undefined;
  const models = Object.values(modelUsage as Record<string, Record<string, unknown> | null>).filter(
    (m): m is Record<string, unknown> => m !== null && typeof m === "object",
  );
  if (models.length === 0) return undefined;
  const sum = (key: string) => models.reduce((total, m) => total + count(m[key]), 0);
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadInputTokens"),
    cacheWriteTokens: sum("cacheCreationInputTokens"),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

/** The session totals in a transcript's last `cost-state` record, which Claude Code restores on resume. */
function costState(transcript: string): Totals | undefined {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]!.includes('"cost-state"')) continue;
    try {
      const entry = JSON.parse(lines[i]!) as { type?: unknown; modelUsage?: unknown; totalCostUSD?: unknown };
      if (entry.type === "cost-state") return modelTotals(entry.modelUsage, entry.totalCostUSD);
    } catch {
      // Not a record.
    }
  }
  return undefined;
}

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

function covers(totals: Totals, baseline: Totals): boolean {
  return (
    TOKEN_KEYS.every((k) => totals[k] >= baseline[k]) &&
    (totals.costUsd === undefined || baseline.costUsd === undefined || totals.costUsd >= baseline.costUsd)
  );
}

function less(totals: Totals, baseline: Totals): CodingUsage {
  const usage: CodingUsage = {
    inputTokens: totals.inputTokens - baseline.inputTokens,
    outputTokens: totals.outputTokens - baseline.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - baseline.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - baseline.cacheWriteTokens,
  };
  if (totals.costUsd !== undefined) usage.costUsd = totals.costUsd - (baseline.costUsd ?? 0);
  return usage;
}

function hasToolResult(content: unknown): boolean {
  return Array.isArray(content) && content.some((c) => (c as { type?: unknown })?.type === "tool_result");
}