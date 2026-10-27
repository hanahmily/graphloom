// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Codex supervisor harness (design-supervisor-harnesses.md, S4): the
 * user's own `codex` CLI and login, driven headless with the shared Codex
 * driver (`codex exec --json`, `exec resume`). Codex keeps its native tools
 * for investigation, with `--sandbox danger-full-access` inside GraphLoom's
 * bwrap, which is the real limit; the decision comes back as JSON in the
 * final message. Each prompt is one Codex process: the first starts the
 * thread, every follow-up resumes it, so feedback is the next user turn of the
 * same thread.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUDGET_EXHAUSTED,
  SESSION_ABORTED,
  captureCodexTurn,
  codexSessionRef,
  openCodexThread,
  runCodexProcess,
  type CodexSessionSettings,
  type CodexSessionStore,
  type CodexThread,
} from "@graphloom/agent-harness/codex";
import { directLaunch, type Launch } from "@graphloom/agent-harness/launch";
import { minimalEnv } from "@graphloom/agent-harness/process";
import { commandPaths } from "./claude-harness.js";
import { classifyCodexFailure } from "./codex-failure.js";
import { codexStepRecorder } from "./codex-steps.js";
import {
  bindingHarness,
  type HarnessCapabilities,
  type HarnessProbe,
  type HarnessPromptOptions,
  type HarnessSession,
  type HarnessSessionRole,
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

/** The harness name bindings record, and the `provider` of its model refs (`codex/gpt-5-codex`). */
export const CODEX_HARNESS = "codex";

/** The model id that runs on Codex's own default model (no `--model`). */
export const CODEX_DEFAULT_MODEL = "default";

/** None of Pi's capabilities: the JSON reply protocol, fresh sessions for switches and overflow (§8). */
export const CODEX_HARNESS_CAPABILITIES: HarnessCapabilities = Object.freeze({
  toolCalling: false,
  inSessionModelSwitch: false,
  compaction: false,
  exactResend: false,
  exactProviderCalls: false,
  rawStreamCapture: false,
});

/** Inactivity limit of one prompt when the operator sets none (as Pi's). */
export const CODEX_DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
/** Total cap of one prompt when the operator sets none (as Pi's). */
export const CODEX_DEFAULT_PROMPT_TOTAL_TIMEOUT_MS = 900_000;

/** Codex's own sandbox is off: GraphLoom's bwrap is the limit (§5.1), so nothing depends on Codex's sandbox nesting inside it. */
export const CODEX_SUPERVISOR_SANDBOX = "danger-full-access";

/**
 * Every `codex exec` flag a supervisor turn passes: the shared driver's own
 * (`--ephemeral` is never passed: the thread is resumed) plus
 * `--ignore-user-config`, so the operator's `config.toml` (its MCP servers,
 * plugins, hooks, profiles, and default model) does not reach the supervisor,
 * as `--strict-mcp-config` keeps Claude Code's out. Codex's login in its home
 * is still used.
 */
export const CODEX_SUPERVISOR_FLAGS: readonly string[] = [
  "--json",
  "--skip-git-repo-check",
  "--sandbox",
  "--cd",
  "--output-last-message",
  "--model",
  "--config",
  "--ignore-user-config",
];

/** Environment variables that would sign Codex in with an API key; never passed (§6.2). OpenAI by API key is the Pi route. */
export const CODEX_API_KEY_ENV: readonly string[] = ["OPENAI_API_KEY", "CODEX_API_KEY"];

/** GraphLoom's reasoning levels as Codex's `model_reasoning_effort`; `off` leaves Codex's own default. */
const REASONING_EFFORT: Readonly<Partial<Record<ThinkingLevel, string>>> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

const DEFAULT_SYSTEM_PROMPT = [
  "You are the GraphLoom run supervisor, running as Codex.",
  "Investigate failures with your own tools (read files, search, run read-only commands) and decide how the run recovers, within its pinned steps and budgets.",
  "The run worktree, the plugin and executor installs, and GraphLoom's state are read-only to you: a command or patch that writes there fails. You change the run only by the decision you return.",
  "When you are asked for a decision, end your reply with exactly one JSON object, as the prompt describes.",
  "Be concise; do not include private reasoning.",
].join(" ");

const REVIEW_SYSTEM_PROMPT = [
  "You are an independent GraphLoom reviewer, running as Codex in a read-only session.",
  "Read whatever you need with your own tools; you cannot change anything, and you share no chat with the supervisor whose work you judge.",
  "Answer exactly in the form the prompt asks for. Be concise; do not include private reasoning.",
].join(" ");

/** Where a confined Codex process may write, and how it is launched. */
export interface CodexConfinement {
  /** The injected launch (the runner's `confineWorker` under bwrap). */
  launch: Launch;
  /** Why this host cannot confine the process, or undefined when it can. */
  unsupported(): Promise<string | undefined>;
}

export interface CodexSupervisorHarnessOptions {
  runId: string;
  /** GraphLoom's copies of each thread's rollout and its session records: `<stateDir>/supervisor/codex`. */
  sessionDir: string;
  /** The supervisor's own writable scratch directory. Default `<sessionDir>/scratch`. */
  scratchDir?: string;
  /** Working directory of decide turns, read-only to the agent (the run worktree). Default: the scratch directory. */
  cwd?: string;
  /** Codex executable. Default `codex`. */
  command?: string;
  /** Codex's home (its login and rollouts). Default `CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Models the operator configured (`provider` `codex`), the initial one first. Default: Codex's own default model. */
  configuredModels?: SupervisorModelRef[];
  /** Extra environment variable names Codex may see; `OPENAI_API_KEY` and `CODEX_API_KEY` are refused. */
  passEnv?: string[];
  /** The environment the process environment is taken from (`minimalEnv` plus `passEnv`). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** bwrap confinement. Without it the probe fails, unless `allowUnconfined` (tests only). */
  confinement?: CodexConfinement;
  /** Tests only: run Codex unconfined, as given. */
  allowUnconfined?: boolean;
  /** The instructions that open each decide session's thread. */
  systemPrompt?: string;
  /** Inactivity limit of one prompt: no event while no command runs. Default 120000. */
  promptTimeoutMs?: number;
  /** Total cap of one prompt. Default 900000. */
  promptTotalTimeoutMs?: number;
  /** How long a stopped process gets before SIGKILL. Default 5000. */
  killGraceMs?: number;
  /** Timeout for one candidate patch prompt (see CreateSupervisorHostOptions). */
  patchTimeoutMs?: number;
  /** Operator fallback wait for a quota error with no reset time (see CreateSupervisorHostOptions). */
  quotaRetryMs?: number;
  /** First transient-error backoff (see CreateSupervisorHostOptions). */
  transientRetryBaseMs?: number;
  /** Reads `codex exec --help` for the probe. Default: run `<command> exec --help`. */
  readHelp?: () => Promise<string | undefined>;
  /**
   * Whether Codex has a login, without a provider call: true, false, `"api-key"`
   * for an API key stored in Codex's home (refused: OpenAI by API key is the Pi
   * route), or undefined when it cannot be told. Default: `codex login status`.
   */
  loggedIn?: () => Promise<boolean | "api-key" | undefined>;
  /** Sees each session as it opens and may wrap it (conformance tests record what the host does with them). */
  observeSession?: (session: HarnessSession, opened: { model: SupervisorModelRef; role: HarnessSessionRole }) => HarnessSession;
}

export interface CodexReviewSessionOptions {
  /** The working directory the reviewer reads from (the candidate root). */
  cwd: string;
  /** Default: the first configured model. */
  model?: SupervisorModelRef;
}

export interface CodexSupervisorHarness extends SupervisorHarness {
  readonly name: typeof CODEX_HARNESS;
  /** A new logical supervisor on the first configured model. */
  start(): Promise<SupervisorHost>;
  /** An independent read-only session in `cwd`, for a reviewer (core §7): no grants, no shared chat. */
  openReviewSession(options: CodexReviewSessionOptions): Promise<HarnessSession>;
}

/**
 * The record GraphLoom writes for each session when it opens
 * (`<sessionDir>/codex-session-<id>.json`), before Codex has named a thread.
 * It names the session's model, so an interrupted model switch is settled
 * from it (`reconcileSupervisorBinding`), and, once Codex has named it, the
 * thread whose rollout GraphLoom keeps as `codex-<thread>.jsonl`. The
 * binding's `sessionFile` is this record: a session has no transcript until
 * its first prompt.
 */
export interface CodexSessionRecord {
  harness: typeof CODEX_HARNESS;
  /** GraphLoom's id of the session (the binding's `sessionId` for the first one). */
  session: string;
  model: string | null;
  systemPromptSha256: string;
  role: HarnessSessionRole;
  opened: string;
  threadId?: string;
  /** GraphLoom's copy of the thread's rollout, beside this record. */
  transcript?: string;
}

const SESSION_RECORD = /^codex-session-([0-9a-f-]{36})\.json$/;

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

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string } | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err !== null && typeof (err as { code?: unknown }).code !== "number") return resolve(undefined);
      resolve({ code: err === null ? 0 : ((err as { code?: number }).code ?? 1), out: `${stdout}\n${stderr}` });
    });
  });
}

/** Codex's own answer to `codex login status` (no provider call); undefined when it cannot be read. */
async function defaultLoggedIn(command: string, env: NodeJS.ProcessEnv): Promise<boolean | "api-key" | undefined> {
  const status = await run(command, ["login", "status"], env);
  if (status === undefined) return undefined;
  if (/not logged in/i.test(status.out)) return false;
  // `codex login --with-api-key` stores a key that Codex would bill to: not a CLI login.
  if (/logged in using an api key/i.test(status.out)) return "api-key";
  return status.code === 0 ? true : undefined;
}

/** Flag-shaped tokens of `--help`, matched whole so `--model-x` never stands in for `--model`. */
function missingFlags(help: string, flags: readonly string[]): string[] {
  const tokens = new Set(help.match(/--?[a-zA-Z][a-zA-Z0-9-]*/g) ?? []);
  return flags.filter((f) => !tokens.has(f));
}

/** What every session of one harness shares. */
interface Shared {
  command: string;
  codexHome: string;
  sessionDir: string;
  scratchDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  launch: Launch;
  promptTimeoutMs: number;
  promptTotalTimeoutMs: number;
  killGraceMs: number;
  systemPrompt: string;
}

async function openCodexSupervisorSession(
  shared: Shared,
  model: SupervisorModelRef,
  role: HarnessSessionRole,
  cwd: string,
): Promise<HarnessSession> {
  const systemPrompt = role === "review" ? REVIEW_SYSTEM_PROMPT : shared.systemPrompt;
  const id = randomUUID();
  const record: CodexSessionRecord = {
    harness: CODEX_HARNESS,
    session: id,
    model: model.modelId === CODEX_DEFAULT_MODEL ? null : model.modelId,
    systemPromptSha256: sha256(systemPrompt),
    role,
    opened: new Date().toISOString(),
  };
  const recordFile = path.join(shared.sessionDir, `codex-session-${id}.json`);
  // The shared driver compares only the model on a restore, and writes these
  // settings, the rest included, beside every rollout copy it saves.
  const settings: CodexSessionSettings = { ...record };
  const store: CodexSessionStore = { home: shared.codexHome, sessionDir: shared.sessionDir, settings };
  let thread: CodexThread = await openCodexThread(store, undefined);
  await mkdir(shared.sessionDir, { recursive: true });
  await mkdir(shared.scratchDir, { recursive: true });
  // Written before any turn, so a switch that opened this session is on record even if the controller dies before its first prompt.
  await writeFile(recordFile, JSON.stringify(record));

  const recorder = codexStepRecorder(CODEX_HARNESS);
  const reasoningEffort = model.thinkingLevel !== undefined ? REASONING_EFFORT[model.thinkingLevel] : undefined;
  let turns = 0;
  let prompts = 0;
  let lastFailure: ProviderFailure | undefined;
  let lastUsage: HarnessUsage | undefined;
  let grantRoot: string | undefined;
  let closed = false;
  let running = false;

  const writableRoots = () => [shared.scratchDir, ...(grantRoot !== undefined ? [grantRoot] : [])];

  /** Name the thread in the session's record once Codex has named it. */
  const noteThread = async () => {
    if (thread.threadId === undefined || record.threadId === thread.threadId) return;
    record.threadId = thread.threadId;
    record.transcript = `${codexSessionRef(thread.threadId)}.jsonl`;
    await writeFile(recordFile, JSON.stringify(record)).catch(() => undefined);
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
    // Codex has no hook before each provider request: the first is reserved
    // here, and one more after each command whose output goes back to the model.
    if (!(await reserve())) throw exceeded();

    const resumed = thread.started && thread.threadId !== undefined;
    if (resumed) {
      // The shared write-back: GraphLoom's copy of the rollout is restored into
      // Codex's home before the resume, so a rollout Codex lost is not a lost session.
      thread = await openCodexThread(store, codexSessionRef(thread.threadId!)).catch(() => thread);
    }
    // Codex has no appended system prompt: the instructions open the thread, and the thread keeps them.
    const body = resumed ? text : `${systemPrompt}\n\n---\n\n${text}`;
    const turnCwd = grantRoot ?? cwd;
    const totalMs = options?.timeoutMs ?? shared.promptTotalTimeoutMs;
    const limit = new AbortController();
    const total = setTimeout(() => limit.abort(), totalMs);
    const signal = options?.signal !== undefined ? AbortSignal.any([options.signal, limit.signal]) : limit.signal;
    const lastMessageFile = path.join(shared.scratchDir, `last-message-${id}-${(prompts += 1)}.txt`);
    // Whether Codex itself reported the failure (an `error` or `turn.failed` event), or exited without one.
    let reported = false;
    let outcomeRun: Awaited<ReturnType<typeof runCodexProcess>> | undefined;
    try {
      ({ value: outcomeRun } = await captureCodexTurn(store, thread, { resumed }, (onActivity) =>
        runCodexProcess({
          command: shared.command,
          thread,
          cwd: turnCwd,
          env: shared.env,
          prompt: body,
          sandbox: CODEX_SUPERVISOR_SANDBOX,
          // The thread is resumed by every follow-up, so Codex keeps it.
          ephemeral: false,
          ...(model.modelId !== CODEX_DEFAULT_MODEL ? { model: model.modelId } : {}),
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          args: ["--ignore-user-config"],
          lastMessageFile,
          launch: shared.launch,
          launchScope: {
            writable: writableRoots(),
            trustedWritable: [shared.codexHome],
            // The executable must stay visible inside the sandbox (a private /tmp would hide one there).
            readPaths: [turnCwd, ...commandPaths(shared.command, shared.env.PATH)],
          },
          signal,
          responseTimeoutMs: shared.promptTimeoutMs,
          killGraceMs: shared.killGraceMs,
          reserveModelCall: reserve,
          onEvent: (event) => {
            if (event.type === "error" || event.type === "turn.failed") reported = true;
            recorder.observe(event);
          },
          ...(onActivity !== undefined ? { onActivity } : {}),
        }),
      ));
    } finally {
      clearTimeout(total);
      recorder.flush();
      await noteThread();
      await rm(lastMessageFile, { force: true }).catch(() => undefined);
    }
    if (outcomeRun === undefined) throw new Error("Codex turn did not run");
    const outcome = outcomeRun.outcome;
    if (outcome.kind === "failed") {
      if (outcome.summary === SESSION_ABORTED) {
        if (options?.signal?.aborted === true || !limit.signal.aborted) throw new Error("supervisor prompt aborted");
        throw new SupervisorProviderError({ failureClass: "timeout", message: `no complete reply within ${seconds(totalMs)}` });
      }
      if (outcome.summary === BUDGET_EXHAUSTED || capHit) throw exceeded();
      if (outcome.summary.startsWith("Codex stalled:")) {
        throw new SupervisorProviderError({ failureClass: "timeout", message: outcome.summary });
      }
      const failure = classifyCodexFailure(outcome.summary);
      if (failure.failureClass === "unknown" && !reported && outcome.summary.startsWith("Codex run failed:")) {
        // A crash or an exit with no reported failure (§8): the host retries it
        // once in a fresh session, as it does a timeout, then stops by name.
        throw new SupervisorProviderError({ failureClass: "unknown", message: failure.message });
      }
      lastFailure = failure;
      return "";
    }
    if (outcomeRun.usage !== undefined) {
      lastUsage = {
        inputTokens: outcomeRun.usage.inputTokens,
        outputTokens: outcomeRun.usage.outputTokens,
        cacheReadTokens: outcomeRun.usage.cacheReadTokens,
        cacheWriteTokens: outcomeRun.usage.cacheWriteTokens,
      };
    }
    const reply = outcome.message.trim();
    if (reply === "") lastFailure = { failureClass: "empty", message: "Codex's final message had no text" };
    return reply;
  };

  const session: HarnessSession = {
    provider: CODEX_HARNESS,
    modelId: model.modelId,
    sessionId: id,
    sessionFile: recordFile,
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
      // The host opens a fresh session on the target instead (§4.4); a thread is never resumed under another model.
      throw new Error("a Codex session keeps its model; switching opens a fresh session");
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

/** The supervisor's Codex harness for one run. */
export function createCodexSupervisorHarness(options: CodexSupervisorHarnessOptions): CodexSupervisorHarness {
  const passEnv = options.passEnv ?? [];
  const key = passEnv.find((n) => CODEX_API_KEY_ENV.includes(n));
  if (key !== undefined) {
    throw new Error(`the Codex supervisor uses your own Codex login; passEnv cannot include ${key} (OpenAI by API key is the Pi supervisor's route)`);
  }
  const command = options.command ?? "codex";
  const source = options.env ?? process.env;
  const codexHome = path.resolve(options.codexHome ?? (source.CODEX_HOME || path.join(os.homedir(), ".codex")));
  const scratchDir = path.resolve(options.scratchDir ?? path.join(options.sessionDir, "scratch"));
  const env = minimalEnv(source, passEnv);
  // Codex's own login and rollouts; no API key is ever passed (§6.2).
  env.CODEX_HOME = codexHome;
  for (const name of CODEX_API_KEY_ENV) delete env[name];
  const shared: Shared = {
    command,
    codexHome,
    sessionDir: path.resolve(options.sessionDir),
    scratchDir,
    cwd: path.resolve(options.cwd ?? scratchDir),
    env,
    launch: options.confinement?.launch ?? directLaunch,
    promptTimeoutMs: options.promptTimeoutMs ?? CODEX_DEFAULT_PROMPT_TIMEOUT_MS,
    promptTotalTimeoutMs: options.promptTotalTimeoutMs ?? CODEX_DEFAULT_PROMPT_TOTAL_TIMEOUT_MS,
    killGraceMs: options.killGraceMs ?? 5_000,
    systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
  const configuredModels = options.configuredModels;
  const initial = (): SupervisorModelRef => configuredModels?.[0] ?? { provider: CODEX_HARNESS, modelId: CODEX_DEFAULT_MODEL };
  const hostOptions = {
    ...(options.patchTimeoutMs !== undefined ? { patchTimeoutMs: options.patchTimeoutMs } : {}),
    ...(options.quotaRetryMs !== undefined ? { quotaRetryMs: options.quotaRetryMs } : {}),
    ...(options.transientRetryBaseMs !== undefined ? { transientRetryBaseMs: options.transientRetryBaseMs } : {}),
  };
  const open = (model: SupervisorModelRef, role: HarnessSessionRole, cwd = shared.cwd) => {
    if (model.provider !== CODEX_HARNESS) {
      return Promise.reject(new Error(`${model.provider}/${model.modelId} is not a Codex model; a model on another harness needs \`graphloom resume --supervisor <harness>\``));
    }
    return openCodexSupervisorSession(shared, model, role, cwd).then((s) => options.observeSession?.(s, { model, role }) ?? s);
  };

  const harness: CodexSupervisorHarness = {
    name: CODEX_HARNESS,
    capabilities: CODEX_HARNESS_CAPABILITIES,
    async probe(): Promise<HarnessProbe> {
      if (options.confinement === undefined && options.allowUnconfined !== true) {
        return { ok: false, reason: "the Codex supervisor runs under bwrap confinement, and none was configured" };
      }
      const unconfinable = await options.confinement?.unsupported();
      if (unconfinable !== undefined) return { ok: false, reason: `the Codex supervisor runs confined: ${unconfinable}` };
      const help = await (options.readHelp ?? (async () => (await run(command, ["exec", "--help"], env))?.out))();
      if (help === undefined || help.trim() === "") return { ok: false, reason: `cannot run ${command} exec --help; is Codex installed?` };
      const missing = missingFlags(help, CODEX_SUPERVISOR_FLAGS);
      if (!/\bresume\b/.test(help)) missing.push("resume");
      if (!help.includes(CODEX_SUPERVISOR_SANDBOX)) missing.push(`--sandbox ${CODEX_SUPERVISOR_SANDBOX}`);
      if (missing.length > 0) return { ok: false, reason: `${command} exec --help does not mention ${missing.join(", ")}; update Codex` };
      const loggedIn = await (options.loggedIn ?? (() => defaultLoggedIn(command, env)))();
      if (loggedIn === false) return { ok: false, reason: `Codex has no login in ${codexHome}; run \`codex login\`` };
      if (loggedIn === "api-key") {
        return {
          ok: false,
          reason: `Codex in ${codexHome} is signed in with an API key; the Codex supervisor uses a ChatGPT login only: run \`codex login\` (OpenAI by API key is the Pi supervisor's route)`,
        };
      }
      return { ok: true };
    },
    openSession: ({ model, role }) => open(model, role),
    openReviewSession: ({ cwd, model }) => open(model ?? initial(), "review", path.resolve(cwd)),
    async start() {
      const model = initial();
      return createSupervisorHost({
        harness,
        session: await open(model, "decide"),
        configuredModels: configuredModels ?? [model],
        ...hostOptions,
      });
    },
    async restore(binding: SupervisorBinding) {
      const pinned = bindingHarness(binding);
      if (pinned !== CODEX_HARNESS) {
        throw new Error(`cannot restore supervisor: the binding is pinned to the ${pinned} harness, not ${CODEX_HARNESS}`);
      }
      const configured = configuredModels ?? binding.configuredModels ?? configuredModelsFromBinding(binding);
      // A fresh session on the bound model: earlier rollouts stay on disk and are never reopened.
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
export interface CodexSessionOpened {
  openedAt: number;
  model: SupervisorModelRef;
}

/** The sessions the records in `sessionDir` name, oldest first. */
export async function codexSessionsOpened(sessionDir: string): Promise<CodexSessionOpened[]> {
  const names = await readdir(sessionDir).catch(() => [] as string[]);
  const opened: CodexSessionOpened[] = [];
  for (const name of names) {
    if (!SESSION_RECORD.test(name)) continue;
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
      model: { provider: CODEX_HARNESS, modelId: parsed.model ?? CODEX_DEFAULT_MODEL },
    });
  }
  return opened.sort((x, y) => x.openedAt - y.openedAt);
}

/** The model of the newest session record in `sessionDir`, or undefined when there is none. */
export async function lastCodexSessionModel(sessionDir: string): Promise<SupervisorModelRef | undefined> {
  return (await codexSessionsOpened(sessionDir)).at(-1)?.model;
}
