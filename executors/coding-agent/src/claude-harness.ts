import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
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
import type { CodingHarness, CodingRunRequest, CodingRunResult, CodingSessionOptions, CodingUsage } from "./harness.js";
import { envList, minimalEnv } from "./child-env.js";
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
    const file = path.join(projects, project, `${saved.sessionId}.jsonl`);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || !PROJECT_DIR.test(project)) continue;
    const transcript = await readFile(file, "utf8");
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
  if (side === undefined) return;
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await copyFiles(source, side.files, tmp);
    await rm(target, { recursive: true, force: true });
    await rename(tmp, target);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Regular files under `root`, relative to it; `other` flags symlinks and special files. Undefined when `root` is absent. */
async function filesUnder(root: string): Promise<{ files: string[]; other: boolean } | undefined> {
  const info = await lstat(root).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isDirectory()) return { files: [], other: true };
  const files: string[] = [];
  let other = false;
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(child);
      else other = true;
    }
  };
  await walk("");
  return { files, other };
}

async function copyFiles(from: string, files: string[], to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const file of files) {
    await mkdir(path.dirname(path.join(to, file)), { recursive: true, mode: 0o700 });
    await copyFile(path.join(from, file), path.join(to, file));
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
      "--verbose",
      // Subagents' responses reach the stream, so each of their requests is charged too.
      "--forward-subagent-text",
      "--permission-mode", "bypassPermissions",
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
    if (request.resultSchema !== undefined) {
      const schema = inlineObjectSchema(request.resultSchema) ?? {
        type: "object",
        description: `${request.resultSchema} result`,
        additionalProperties: true,
      };
      cli.push("--json-schema", JSON.stringify(schema));
    }
    cli.push(saved.started ? "--resume" : "--session-id", saved.sessionId);

    // Nothing awaits between this check and the abort listener, so a stop during setup cannot miss the process.
    if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
    const child = spawn(args.command, cli, {
      cwd: options.cwd,
      env: args.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("error", (error) => resolve({ code: null, error }));
      child.once("close", (code) => resolve({ code }));
    });

    let stopped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopped || child.pid === undefined) return;
      stopped = true;
      signalGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => signalGroup(child.pid!, "SIGKILL"), args.killGraceMs);
    };
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end([request.assignment, ...scopeNotes(options)].join("\n\n"));

    // A background subagent's report starts another turn, which ends with its own result.
    const results: ResultEvent[] = [];
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
      });
    };

    // Model output is progress; while a tool (or a subagent) runs, silence is expected.
    let stalled: string | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    const running = new Set<string>();
    const arm = (ms: number, reason: string) => {
      clearTimeout(watchdog);
      watchdog = undefined;
      if (ms <= 0 || running.size > 0) return;
      watchdog = setTimeout(() => {
        stalled = reason;
        stop();
      }, ms);
    };
    arm(args.startupTimeoutMs, `no model output within ${seconds(args.startupTimeoutMs)} of starting`);

    for await (const line of createInterface({ input: child.stdout })) {
      let event: { type?: string; subtype?: string; message?: { id?: unknown; content?: unknown }; mcp_servers?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (event.type === "assistant" || event.type === "user" || (event.type === "system" && event.subtype === "thinking_tokens")) {
        trackTools(event.message?.content, running);
        arm(args.responseTimeoutMs, `no model output for ${seconds(args.responseTimeoutMs)}`);
      }
      if (event.type === "system" && event.subtype === "init" && bridge !== undefined) {
        const servers = Array.isArray(event.mcp_servers) ? (event.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
        if (servers.find((s) => s.name === BRIDGE_NAME)?.status !== "connected") {
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
        results.push(event as ResultEvent);
      }
    }
    const result = results.at(-1);
    clearTimeout(watchdog);
    const { code, error } = await exited;
    await reservations;
    clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", onAbort);

    const outcome = ((): CodingRunResult => {
      if (budgetRefused) return { status: "failed", summary: BUDGET_EXHAUSTED };
      if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
      if (stalled !== undefined) return { status: "failed", summary: `Claude Code stalled: ${stalled}` };
      if (bridgeFailed) return { status: "failed", summary: "Claude Code could not connect to the GraphLoom tool server" };
      if (error !== undefined) return { status: "failed", summary: bounded(`could not start Claude Code (${args.command}): ${error.message}`) };
      if (result === undefined) {
        return { status: "failed", summary: bounded(`Claude Code exited with code ${code} and no result${stderr.trim() ? `: ${stderr.trim()}` : ""}`) };
      }
      if (result.is_error === true || result.subtype !== "success") {
        const detail = stderr.trim() || result.result || "";
        return { status: "failed", summary: bounded(`Claude Code run failed (${result.subtype ?? "error"})${detail ? `: ${detail}` : ""}`) };
      }
      if (request.resultSchema !== undefined) {
        if (result.structured_output === undefined) {
          return { status: "failed", summary: `agent finished without submitting a ${request.resultSchema} result` };
        }
        const submitted = (result.structured_output as { summary?: unknown } | null)?.summary;
        return {
          status: "completed",
          summary: bounded(typeof submitted === "string" ? submitted : `Claude Code submitted a ${request.resultSchema} result`),
          output: result.structured_output,
        };
      }
      return { status: "completed", summary: bounded(result.result?.trim() || "Claude Code completed") };
    })();
    const usage = usageOf(results, saved.baseline);
    return usage !== undefined ? { ...outcome, usage } : outcome;
  } finally {
    await bridge?.close();
    await rm(scratch, { recursive: true, force: true });
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

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
