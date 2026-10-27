// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Claude Code supervisor harness (design-supervisor-harnesses.md, S3):
 * the user's own `claude` CLI and login, driven headless over the same
 * stream-json control protocol the coding-agent executor uses. Claude Code
 * keeps its native tools for investigation, confined by the injected launch
 * (bwrap); the decision comes back as JSON in the final message. Each prompt
 * is one Claude Code process: the first creates the session (`--session-id`),
 * every follow-up resumes it (`--resume`), so feedback is the next user turn
 * of the same session.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUDGET_EXHAUSTED,
  CLAUDE_STREAM_FLAGS,
  SESSION_ABORTED,
  captureClaudeTurn,
  openClaudeSession,
  runClaudeProcess,
  type ClaudeSession,
  type ClaudeSessionStore,
  type ClaudeToolPermission,
} from "@graphloom/agent-harness/claude";
import { directLaunch, type Launch } from "@graphloom/agent-harness/launch";
import { minimalEnv } from "@graphloom/agent-harness/process";
import { classifyClaudeFailure } from "./claude-failure.js";
import { claudeStepRecorder, CLAUDE_WRITE_TOOLS } from "./claude-steps.js";
import {
  bindingHarness,
  type HarnessCapabilities,
  type HarnessProbe,
  type HarnessPromptOptions,
  type HarnessSession,
  type HarnessSessionRole,
  type HarnessStartOptions,
  type HarnessUsage,
  type SupervisorBinding,
  type SupervisorHarness,
  type SupervisorHost,
  type SupervisorModelRef,
  type ThinkingLevel,
} from "./harness.js";
import { createSupervisorHost, findConfigured } from "./host.js";
import type { InvestigationStep } from "./investigation.js";
import { configuredModelsFromBinding } from "./pi-harness.js";
import { SupervisorProviderError, type ProviderFailure } from "./provider-failure.js";

/** The harness name bindings record, and the `provider` of its model refs (`claude-code/opus`). */
export const CLAUDE_CODE_HARNESS = "claude-code";

/** The model id that runs on Claude Code's own default model (no `--model`). */
export const CLAUDE_DEFAULT_MODEL = "default";

/** None of Pi's capabilities: the JSON reply protocol, fresh sessions for switches and overflow (§8). */
export const CLAUDE_HARNESS_CAPABILITIES: HarnessCapabilities = Object.freeze({
  toolCalling: false,
  inSessionModelSwitch: false,
  compaction: false,
  exactResend: false,
  exactProviderCalls: false,
  rawStreamCapture: false,
});

/** Inactivity limit of one prompt when the operator sets none (as Pi's). */
export const CLAUDE_DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
/** Total cap of one prompt when the operator sets none (as Pi's). */
export const CLAUDE_DEFAULT_PROMPT_TOTAL_TIMEOUT_MS = 900_000;

/**
 * Every flag a supervisor turn passes Claude Code: the shared driver's
 * protocol flags plus the harness's own. `--effort` is passed only for a
 * model configured with a reasoning level, and probed only then.
 */
export const CLAUDE_SUPERVISOR_FLAGS: readonly string[] = [
  ...CLAUDE_STREAM_FLAGS,
  "--tools",
  "--strict-mcp-config",
  "--append-system-prompt",
  "--model",
];

/** Claude Code `--effort` levels; GraphLoom's `off` and `minimal` leave Claude Code's own default. */
const EFFORT_LEVELS: ReadonlySet<ThinkingLevel> = new Set(["low", "medium", "high", "xhigh", "max"]);

const DEFAULT_SYSTEM_PROMPT = [
  "You are the GraphLoom run supervisor, running as Claude Code.",
  "Investigate failures with your own tools (read files, search, run read-only commands) and decide how the run recovers, within its pinned steps and budgets.",
  "The run worktree, the plugin and executor installs, and GraphLoom's state are read-only to you: a command that writes there fails. You change the run only by the decision you return.",
  "When you are asked for a decision, end your reply with exactly one JSON object, as the prompt describes.",
  "Be concise; do not include private reasoning.",
].join(" ");

const REVIEW_SYSTEM_PROMPT = [
  "You are an independent GraphLoom reviewer, running as Claude Code in a read-only session.",
  "Read whatever you need with your own tools; you cannot change anything, and you share no chat with the supervisor whose work you judge.",
  "Answer exactly in the form the prompt asks for. Be concise; do not include private reasoning.",
].join(" ");

/** Where a confined Claude Code process may write, and how it is launched. */
export interface ClaudeConfinement {
  /** The injected launch (the runner's `confineWorker` under bwrap). */
  launch: Launch;
  /** Why this host cannot confine the process, or undefined when it can. */
  unsupported(): Promise<string | undefined>;
}

export interface ClaudeSupervisorHarnessOptions {
  runId: string;
  /** GraphLoom's copies of each session's transcript: `<stateDir>/supervisor/claude-code`. */
  sessionDir: string;
  /** The supervisor's own writable scratch directory. Default `<sessionDir>/scratch`. */
  scratchDir?: string;
  /** Working directory of decide turns, read-only to the agent (the run worktree). Default: the scratch directory. */
  cwd?: string;
  /** Claude Code executable. Default `claude`. */
  command?: string;
  /** Claude Code's config dir (its login and transcripts). Default `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  configDir?: string;
  /** Models the operator configured (`provider` `claude-code`), the initial one first. Default: Claude Code's own default model. */
  configuredModels?: SupervisorModelRef[];
  /** Extra environment variable names Claude Code may see; `ANTHROPIC_API_KEY` is refused. */
  passEnv?: string[];
  /** The environment the process environment is taken from (`minimalEnv` plus `passEnv`). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** bwrap confinement. Without it the probe fails, unless `allowUnconfined` (tests only). */
  confinement?: ClaudeConfinement;
  /** Tests only: run Claude Code unconfined, as given. */
  allowUnconfined?: boolean;
  /** Appended to Claude Code's system prompt for decide sessions. */
  systemPrompt?: string;
  /** Inactivity limit of one prompt: no model output while no tool runs. Default 120000. */
  promptTimeoutMs?: number;
  /** Total cap of one prompt. Default 900000. */
  promptTotalTimeoutMs?: number;
  /** No model output this long after the process starts. Default: `promptTimeoutMs`. */
  startupTimeoutMs?: number;
  /** How long a stopped process gets before SIGKILL. Default 5000. */
  killGraceMs?: number;
  /** Time for an interrupt to finish the turn before SIGTERM. Default 1000. */
  interruptGraceMs?: number;
  /** Timeout for one candidate patch prompt (see CreateSupervisorHostOptions). */
  patchTimeoutMs?: number;
  /** Operator fallback wait for a quota error with no reset time (see CreateSupervisorHostOptions). */
  quotaRetryMs?: number;
  /** First transient-error backoff (see CreateSupervisorHostOptions). */
  transientRetryBaseMs?: number;
  /** Reads Claude Code's `--help` for the probe. Default: run `<command> --help`. */
  readHelp?: () => Promise<string | undefined>;
  /** Whether Claude Code has a login, readable without a call; undefined when it cannot be told. Default: look in the config dir. */
  loggedIn?: () => Promise<boolean | undefined>;
  /** Sees each session as it opens and may wrap it (conformance tests record what the host does with them). */
  observeSession?: (session: HarnessSession, opened: { model: SupervisorModelRef; role: HarnessSessionRole }) => HarnessSession;
}

export interface ClaudeReviewSessionOptions {
  /** The working directory the reviewer reads from (the candidate root). */
  cwd: string;
  /** Default: the first configured model. */
  model?: SupervisorModelRef;
}

export interface ClaudeSupervisorHarness extends SupervisorHarness {
  readonly name: typeof CLAUDE_CODE_HARNESS;
  /** A new logical supervisor on the first configured model, or one continuing another harness's (§7.4). */
  start(options?: HarnessStartOptions): Promise<SupervisorHost>;
  /** An independent read-only session in `cwd`, for a reviewer (core §7): no grants, no shared chat. */
  openReviewSession(options: ClaudeReviewSessionOptions): Promise<HarnessSession>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function inside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function seconds(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(
    () => true,
    () => false,
  );
}

/** The configured Claude Code model a ref names, as CLI flags. */
function modelFlags(ref: SupervisorModelRef): string[] {
  return [
    ...(ref.modelId !== CLAUDE_DEFAULT_MODEL ? ["--model", ref.modelId] : []),
    ...(ref.thinkingLevel !== undefined && EFFORT_LEVELS.has(ref.thinkingLevel) ? ["--effort", ref.thinkingLevel] : []),
  ];
}

/** Where `command` resolves (as given, on `PATH`, and through links), for the sandbox to keep visible. */
export function commandPaths(command: string, searchPath: string | undefined): string[] {
  const found = command.includes("/")
    ? [path.resolve(command)]
    : (searchPath ?? "")
        .split(path.delimiter)
        .filter((dir) => dir !== "")
        .map((dir) => path.join(dir, command))
        .filter((candidate) => existsSync(candidate))
        .slice(0, 1);
  const resolved = found.flatMap((p) => {
    try {
      return [p, realpathSync(p)];
    } catch {
      return [p];
    }
  });
  return [...new Set(resolved)];
}

/** Claude Code's own login in `configDir`: its credentials file, or an OAuth account in its config; undefined where the OS keychain holds it. */
async function defaultLoggedIn(configDir: string): Promise<boolean | undefined> {
  if (await exists(path.join(configDir, ".credentials.json"))) return true;
  const config = await readFile(path.join(configDir, ".claude.json"), "utf8").catch(() => undefined);
  if (config !== undefined && config.includes('"oauthAccount"')) return true;
  // macOS keeps the login in the keychain, which cannot be read without asking.
  return process.platform === "darwin" ? undefined : false;
}

function defaultReadHelp(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, ["--help"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/** Flag-shaped tokens of `--help`, matched whole so `--model-x` never stands in for `--model`. */
function missingFlags(help: string, flags: readonly string[]): string[] {
  const tokens = new Set(help.match(/--?[a-zA-Z][a-zA-Z0-9-]*/g) ?? []);
  return flags.filter((f) => !tokens.has(f));
}

/** What every session of one harness shares. */
interface Shared {
  command: string;
  configDir: string;
  sessionDir: string;
  scratchDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  launch: Launch;
  promptTimeoutMs: number;
  promptTotalTimeoutMs: number;
  startupTimeoutMs: number;
  killGraceMs: number;
  interruptGraceMs: number;
  systemPrompt: string;
}

/**
 * The record GraphLoom writes beside each session's transcript copy when the
 * session opens (`<ref>.json`; the shared driver later adds the transcript's
 * project to it). It names the session's model, so an interrupted model
 * switch is settled from the newest one (`reconcileSupervisorBinding`).
 */
export interface ClaudeSessionRecord {
  harness: typeof CLAUDE_CODE_HARNESS;
  model: string | null;
  systemPromptSha256: string;
  role?: HarnessSessionRole;
  opened?: string;
}

async function openClaudeSupervisorSession(
  shared: Shared,
  model: SupervisorModelRef,
  role: HarnessSessionRole,
  cwd: string,
): Promise<HarnessSession> {
  const systemPrompt = role === "review" ? REVIEW_SYSTEM_PROMPT : shared.systemPrompt;
  // The shared driver compares only the model and the prompt digest on a
  // restore, and writes these settings, the rest of the record included,
  // beside every transcript copy it saves.
  const settings: ClaudeSessionRecord = {
    harness: CLAUDE_CODE_HARNESS,
    model: model.modelId === CLAUDE_DEFAULT_MODEL ? null : model.modelId,
    systemPromptSha256: sha256(systemPrompt),
    role,
    opened: new Date().toISOString(),
  };
  const store: ClaudeSessionStore = { configDir: shared.configDir, sessionDir: shared.sessionDir, settings };
  let claude: ClaudeSession = await openClaudeSession(store, undefined);
  const ref = claude.ref;
  await mkdir(shared.sessionDir, { recursive: true });
  await mkdir(shared.scratchDir, { recursive: true });
  // Written before any turn, so a switch that opened this session is on record even if the controller dies before its first prompt.
  await writeFile(path.join(shared.sessionDir, `${ref}.json`), JSON.stringify(settings));

  const recorder = claudeStepRecorder(CLAUDE_CODE_HARNESS);
  let turns = 0;
  let lastFailure: ProviderFailure | undefined;
  let lastUsage: HarnessUsage | undefined;
  let grantRoot: string | undefined;
  let closed = false;
  let running = false;

  const writableRoots = () => [shared.scratchDir, ...(grantRoot !== undefined ? [grantRoot] : [])];

  /** Allow and record every request; refuse only file writes outside the scratch dir and a granted candidate root (§5.1). */
  const toolPolicy = async (toolName: unknown, input: unknown, turnCwd: string): Promise<ClaudeToolPermission> => {
    const name = typeof toolName === "string" ? toolName : "";
    const args = input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    if (CLAUDE_WRITE_TOOLS.has(name)) {
      const target = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : undefined;
      const resolved = target !== undefined ? path.resolve(turnCwd, target) : undefined;
      if (resolved === undefined || !writableRoots().some((root) => inside(resolved, root))) {
        return {
          behavior: "deny",
          message:
            grantRoot !== undefined
              ? `GraphLoom's supervisor may change files only inside the repair candidate ${grantRoot}; everything else is read-only to you`
              : "GraphLoom's supervisor changes the run only by deciding: the worktree, the installs, and GraphLoom's state are read-only to you",
        };
      }
    }
    return { behavior: "allow", updatedInput: args };
  };

  const runPrompt = async (text: string, options: HarnessPromptOptions | undefined): Promise<string> => {
    const cap = () => (options?.maxTurns === undefined ? undefined : options.maxTurns - Math.max(0, options.reservedTurns?.() ?? 0));
    let promptTurns = 0;
    let capHit = false;
    const reserve = async (): Promise<boolean> => {
      const c = cap();
      if (c !== undefined && promptTurns >= c) {
        capHit = true;
        return false;
      }
      promptTurns += 1;
      turns += 1;
      return true;
    };
    const exceeded = () => new Error(`supervisor prompt exceeded its ${cap() ?? options?.maxTurns}-turn allowance`);
    if (options?.signal?.aborted) throw new Error("supervisor prompt aborted");
    // Claude Code has no hook before each provider request: the first is
    // reserved here, and each later one when the stream shows it coming.
    if (!(await reserve())) throw exceeded();

    if (claude.started) {
      // The shared write-back: GraphLoom's copy is restored into Claude Code's
      // store before the resume, so a transcript Claude Code lost is not a lost session.
      claude = await openClaudeSession(store, ref).catch(() => claude);
    }
    const turnCwd = grantRoot ?? cwd;
    const totalMs = options?.timeoutMs ?? shared.promptTotalTimeoutMs;
    const limit = new AbortController();
    const total = setTimeout(() => limit.abort(), totalMs);
    const signal = options?.signal !== undefined ? AbortSignal.any([options.signal, limit.signal]) : limit.signal;
    let run: Awaited<ReturnType<typeof runClaudeProcess>> | undefined;
    try {
      ({ value: run } = await captureClaudeTurn(store, claude, { resumed: claude.started }, (onActivity) =>
        runClaudeProcess({
          command: shared.command,
          args: [
            "--tools", "default",
            "--strict-mcp-config",
            "--append-system-prompt", systemPrompt,
            ...modelFlags(model),
          ],
          session: claude,
          cwd: turnCwd,
          env: shared.env,
          prompt: text,
          launch: shared.launch,
          launchScope: {
            writable: writableRoots(),
            trustedWritable: [shared.configDir],
            // The executable must stay visible inside the sandbox (a private /tmp would hide one there).
            readPaths: [turnCwd, ...commandPaths(shared.command, shared.env.PATH)],
          },
          signal,
          killGraceMs: shared.killGraceMs,
          interruptGraceMs: shared.interruptGraceMs,
          startupTimeoutMs: shared.startupTimeoutMs,
          responseTimeoutMs: shared.promptTimeoutMs,
          toolPolicy: (toolName, input) => toolPolicy(toolName, input, turnCwd),
          reserveModelCall: reserve,
          onEvent: (event) => recorder.observe(event),
          ...(onActivity !== undefined ? { onActivity } : {}),
        }),
      ));
    } finally {
      clearTimeout(total);
      recorder.flush();
    }
    if (run === undefined) throw new Error("Claude Code turn did not run");
    const outcome = run.outcome;
    if (outcome.kind === "failed") {
      if (outcome.summary === SESSION_ABORTED) {
        if (options?.signal?.aborted === true || !limit.signal.aborted) throw new Error("supervisor prompt aborted");
        throw new SupervisorProviderError({ failureClass: "timeout", message: `no complete reply within ${seconds(totalMs)}` });
      }
      if (outcome.summary === BUDGET_EXHAUSTED || capHit) throw exceeded();
      if (outcome.summary.startsWith("Claude Code stalled:")) {
        throw new SupervisorProviderError({ failureClass: "timeout", message: outcome.summary });
      }
      if (outcome.summary.startsWith("Claude Code exited with code")) {
        // A crash or an exit with no result (§8): the host retries it once in
        // a fresh session, as it does a timeout, then stops by name.
        throw new SupervisorProviderError({ failureClass: "unknown", message: classifyClaudeFailure(outcome.summary).message });
      }
      lastFailure = classifyClaudeFailure(outcome.summary);
      return "";
    }
    if (run.usage !== undefined) {
      lastUsage = {
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cacheReadTokens: run.usage.cacheReadTokens,
        cacheWriteTokens: run.usage.cacheWriteTokens,
        ...(run.usage.costUsd !== undefined ? { costUsd: run.usage.costUsd } : {}),
      };
    }
    const reply = (outcome.result.result ?? "").trim();
    if (reply === "") lastFailure = { failureClass: "empty", message: "Claude Code's final message had no text" };
    return reply;
  };

  const session: HarnessSession = {
    provider: CLAUDE_CODE_HARNESS,
    modelId: model.modelId,
    sessionId: claude.sessionId,
    sessionFile: path.join(shared.sessionDir, `${ref}.jsonl`),
    async prompt(text, options) {
      if (closed) throw new Error("supervisor session is closed");
      if (running) throw new Error("supervisor session is still answering an earlier prompt");
      running = true;
      lastFailure = undefined;
      lastUsage = undefined;
      try {
        return await runPrompt(text, options);
      } finally {
        running = false;
      }
    },
    drainTurnCount() {
      const n = turns;
      turns = 0;
      return n;
    },
    peekTurnCount() {
      return turns;
    },
    lastReplyFailure() {
      return lastFailure;
    },
    async setModel() {
      // The host opens a fresh session on the target instead (§4.4); a transcript is never resumed under another model.
      throw new Error("a Claude Code session keeps its model; switching opens a fresh session");
    },
    ...(role === "decide"
      ? {
          async grantCandidateCoding(candidateRoot: string) {
            if (closed) throw new Error("supervisor session is closed");
            grantRoot = path.resolve(candidateRoot);
          },
          async revokeCandidateCoding() {
            grantRoot = undefined;
          },
        }
      : {}),
    investigation(): InvestigationStep[] {
      return recorder.steps();
    },
    lastUsage() {
      return lastUsage;
    },
    async close() {
      // No process outlives a prompt, so there is nothing to stop.
      closed = true;
    },
  };
  return session;
}

/** The supervisor's Claude Code harness for one run. */
export function createClaudeSupervisorHarness(options: ClaudeSupervisorHarnessOptions): ClaudeSupervisorHarness {
  const passEnv = options.passEnv ?? [];
  if (passEnv.includes("ANTHROPIC_API_KEY")) {
    throw new Error("the Claude Code supervisor uses your own Claude Code login; passEnv cannot include ANTHROPIC_API_KEY");
  }
  const command = options.command ?? "claude";
  const configDir = path.resolve(options.configDir ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")));
  const scratchDir = path.resolve(options.scratchDir ?? path.join(options.sessionDir, "scratch"));
  const promptTimeoutMs = options.promptTimeoutMs ?? CLAUDE_DEFAULT_PROMPT_TIMEOUT_MS;
  const env = minimalEnv(options.env ?? process.env, passEnv);
  // Claude Code's own login and transcripts; the key is never passed (§6.2).
  env.CLAUDE_CONFIG_DIR = configDir;
  delete env.ANTHROPIC_API_KEY;
  const shared: Shared = {
    command,
    configDir,
    sessionDir: path.resolve(options.sessionDir),
    scratchDir,
    cwd: path.resolve(options.cwd ?? scratchDir),
    env,
    launch: options.confinement?.launch ?? directLaunch,
    promptTimeoutMs,
    promptTotalTimeoutMs: options.promptTotalTimeoutMs ?? CLAUDE_DEFAULT_PROMPT_TOTAL_TIMEOUT_MS,
    startupTimeoutMs: options.startupTimeoutMs ?? promptTimeoutMs,
    killGraceMs: options.killGraceMs ?? 5_000,
    interruptGraceMs: options.interruptGraceMs ?? 1_000,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
  const configuredModels = options.configuredModels;
  const initial = (): SupervisorModelRef => configuredModels?.[0] ?? { provider: CLAUDE_CODE_HARNESS, modelId: CLAUDE_DEFAULT_MODEL };
  const hostOptions = {
    ...(options.patchTimeoutMs !== undefined ? { patchTimeoutMs: options.patchTimeoutMs } : {}),
    ...(options.quotaRetryMs !== undefined ? { quotaRetryMs: options.quotaRetryMs } : {}),
    ...(options.transientRetryBaseMs !== undefined ? { transientRetryBaseMs: options.transientRetryBaseMs } : {}),
  };
  const open = (model: SupervisorModelRef, role: HarnessSessionRole, cwd = shared.cwd) => {
    if (model.provider !== CLAUDE_CODE_HARNESS) {
      return Promise.reject(new Error(`${model.provider}/${model.modelId} is not a Claude Code model; a model on another harness needs \`graphloom resume --supervisor <harness>\``));
    }
    return openClaudeSupervisorSession(shared, model, role, cwd).then((s) => options.observeSession?.(s, { model, role }) ?? s);
  };

  const harness: ClaudeSupervisorHarness = {
    name: CLAUDE_CODE_HARNESS,
    capabilities: CLAUDE_HARNESS_CAPABILITIES,
    async probe(): Promise<HarnessProbe> {
      if (options.confinement === undefined && options.allowUnconfined !== true) {
        return { ok: false, reason: "the Claude Code supervisor runs under bwrap confinement, and none was configured" };
      }
      const unconfinable = await options.confinement?.unsupported();
      if (unconfinable !== undefined) return { ok: false, reason: `the Claude Code supervisor runs confined: ${unconfinable}` };
      const help = await (options.readHelp ?? (() => defaultReadHelp(command)))();
      if (help === undefined) return { ok: false, reason: `cannot run ${command} --help; is Claude Code installed?` };
      const effort = [...(configuredModels ?? [])].some((m) => m.thinkingLevel !== undefined && EFFORT_LEVELS.has(m.thinkingLevel));
      const missing = missingFlags(help, [...CLAUDE_SUPERVISOR_FLAGS, ...(effort ? ["--effort"] : [])]);
      if (missing.length > 0) return { ok: false, reason: `${command} --help does not mention ${missing.join(", ")}; update Claude Code` };
      const loggedIn = await (options.loggedIn ?? (() => defaultLoggedIn(configDir)))();
      if (loggedIn === false) return { ok: false, reason: `Claude Code has no login in ${configDir}; run \`claude /login\`` };
      return { ok: true };
    },
    openSession: ({ model, role }) => open(model, role),
    openReviewSession: ({ cwd, model }) => open(model ?? initial(), "review", path.resolve(cwd)),
    async start(options: HarnessStartOptions = {}) {
      const model = initial();
      return createSupervisorHost({
        harness,
        session: await open(model, "decide"),
        configuredModels: configuredModels ?? [model],
        ...(options.logicalSessionId !== undefined ? { logicalSessionId: options.logicalSessionId } : {}),
        ...(options.switchJournal !== undefined ? { initialSwitchJournal: options.switchJournal } : {}),
        ...hostOptions,
      });
    },
    async restore(binding: SupervisorBinding) {
      const pinned = bindingHarness(binding);
      if (pinned !== CLAUDE_CODE_HARNESS) {
        throw new Error(`cannot restore supervisor: the binding is pinned to the ${pinned} harness, not ${CLAUDE_CODE_HARNESS}`);
      }
      const configured = configuredModels ?? binding.configuredModels ?? configuredModelsFromBinding(binding);
      // A fresh session on the bound model: earlier transcripts stay on disk and are never reopened.
      const session = await open(findConfigured(configured, binding) ?? { provider: binding.provider, modelId: binding.modelId }, "decide");
      return createSupervisorHost({
        harness,
        session,
        logicalSessionId: binding.sessionId,
        configuredModels: configured,
        initialSwitchJournal: binding.switchJournal,
        ...hostOptions,
      });
    },
  };
  return harness;
}

/** One session the harness opened in `sessionDir`, from its record: when, and on which model. */
export interface ClaudeSessionOpened {
  openedAt: number;
  model: SupervisorModelRef;
}

/** The sessions the records in `sessionDir` name, oldest first. */
export async function claudeSessionsOpened(sessionDir: string): Promise<ClaudeSessionOpened[]> {
  const names = await readdir(sessionDir).catch(() => [] as string[]);
  const opened: ClaudeSessionOpened[] = [];
  for (const name of names) {
    if (!/^claude-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const file = path.join(sessionDir, name);
    const [info, text] = await Promise.all([stat(file).catch(() => undefined), readFile(file, "utf8").catch(() => undefined)]);
    if (info === undefined || text === undefined) continue;
    let parsed: { model?: unknown; opened?: unknown };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.model !== null && typeof parsed.model !== "string") continue;
    const at = typeof parsed.opened === "string" ? Date.parse(parsed.opened) : Number.NaN;
    opened.push({
      openedAt: Number.isFinite(at) ? at : info.mtimeMs,
      model: { provider: CLAUDE_CODE_HARNESS, modelId: parsed.model ?? CLAUDE_DEFAULT_MODEL },
    });
  }
  return opened.sort((x, y) => x.openedAt - y.openedAt);
}

/** The model of the newest session record in `sessionDir`, or undefined when there is none. */
export async function lastClaudeSessionModel(sessionDir: string): Promise<SupervisorModelRef | undefined> {
  return (await claudeSessionsOpened(sessionDir)).at(-1)?.model;
}
