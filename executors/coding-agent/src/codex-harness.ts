import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { applyReferenceEnums, checkReferences, validateResultShape } from "@graphloom/sdk";
import { bounded, inlineObjectSchema, scopeNotes } from "./assignment.js";
import { envList, minimalEnv } from "./child-env.js";
import {
  CODEX_BIN_ENV,
  CODEX_DEFAULT_RESPONSE_TIMEOUT_MS,
  CODEX_HOME_ENV,
  CODEX_MODEL_ENV,
  CODEX_PASS_ENV_ENV,
  CODEX_REASONING_EFFORT_ENV,
  CODEX_RESPONSE_TIMEOUT_ENV,
} from "./codex-config.js";
import {
  JOB_CONTRACT_ENV,
  JOB_IDENTITY_ENV,
  JOB_REFERENCES_ENV,
  completeJsonl,
  fitWatchdog,
  sessionSaver,
  type CodingHarness,
  type CodingRunRequest,
  type CodingRunResult,
  type CodingSessionOptions,
  type CodingUsage,
  type NativeToolUse,
} from "./harness.js";
import { drainOnExit, signalGroup } from "./process-group.js";
import { readScanned } from "./session-files.js";

export interface CodexHarnessOptions {
  /** Codex executable. Default: `GRAPHLOOM_CODEX_BIN`, then `codex` on PATH. */
  command?: string;
  /** Model name; a job's `harnessOptions.model` overrides it. Default: `GRAPHLOOM_CODEX_MODEL`, then Codex's own. */
  model?: string;
  /** Reasoning effort (`minimal` to `xhigh`). Default: `GRAPHLOOM_CODEX_REASONING_EFFORT`, then Codex's own. */
  reasoningEffort?: string;
  /** Codex home: its login and config, so it selects the account. Default: `GRAPHLOOM_CODEX_HOME`, then `CODEX_HOME`, then Codex's own `~/.codex`. */
  codexHome?: string;
  /** Extra environment variable names Codex may see, beyond its minimal set. Default: `GRAPHLOOM_CODEX_PASS_ENV` (comma-separated). */
  passEnv?: string[];
  /** Stop Codex when it shows no activity this long while no command is running; 0 disables. Default: `GRAPHLOOM_CODEX_RESPONSE_TIMEOUT_MS`, then 600000. */
  responseTimeoutMs?: number;
  /** How long a stopped process gets before SIGKILL. Default 5000 ms. */
  killGraceMs?: number;
}

const BUDGET_EXHAUSTED = "model request budget exhausted";
const MAX_STDERR_CHARS = 8_000;
const RESULT_NOTE = "Your final message is your result: only the JSON object, with no prose and no code fence.";
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);

/**
 * Every flag `runCodex` below passes Codex's `exec` subcommand, for the B2
 * capability probe (docs/design-graph-rehearsal.md §3.1): a binary whose
 * `codex exec --help` is missing one of these silently lacks a feature this
 * adapter depends on. Keep this in sync with the `cli` array in `runCodex`.
 */
export const CODEX_ADAPTER_FLAGS: readonly string[] = [
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "--sandbox",
  "--cd",
  "--output-last-message",
  "--model",
  "--config",
  "--output-schema",
];

interface CodexEvent {
  type?: string;
  thread_id?: unknown;
  item?: { id?: unknown; type?: unknown };
  usage?: Record<string, unknown>;
  error?: { message?: unknown };
  message?: unknown;
}

const THREAD_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SESSION_REF = /^codex-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Where Codex keeps a thread's rollout under its home: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`. */
const ROLLOUT_PATH = /^sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-[0-9A-Za-z.:_-]+\.jsonl$/;

/** What a saved Codex session ran under; a resume under another model would pass its turns off as continuity. */
interface CodexSettings {
  model: string | null;
}

/** The Codex thread a session continues, once Codex has named it. */
interface CodexThread {
  threadId?: string;
  /** Its rollout file, relative to the Codex home, once found. */
  rollout?: string;
  /** True once Codex has recorded the thread, so the next run resumes it. */
  started: boolean;
}

/**
 * A `CodingHarness` that runs the user's Codex CLI (`codex exec`) headless in
 * the worktree, in Codex's read-only sandbox. It serves read-only jobs without
 * graph tools: Codex cannot confine writes to a job's write scope, and its
 * graph tools would bypass the controller. With a session directory, Codex
 * persists the thread (no `--ephemeral`); the harness copies its rollout file
 * there while the turn runs and restores it before `codex exec resume`.
 */
export function createCodexHarness(harnessOptions: CodexHarnessOptions = {}): CodingHarness {
  return {
    name: "codex",
    resumable: true,
    async createSession(options) {
      if (!options.readOnly) throw new Error("the Codex harness runs read-only jobs only");
      if (options.tools.length > 0) throw new Error("the Codex harness cannot serve graph tools");
      const command = harnessOptions.command ?? (process.env[CODEX_BIN_ENV] || "codex");
      const jobModel = options.options?.model;
      if (jobModel !== undefined && typeof jobModel !== "string") throw new Error("harnessOptions.model must be a string");
      const model = jobModel ?? harnessOptions.model ?? (process.env[CODEX_MODEL_ENV] || undefined);
      const reasoningEffort = harnessOptions.reasoningEffort ?? (process.env[CODEX_REASONING_EFFORT_ENV] || undefined);
      if (reasoningEffort !== undefined && !REASONING_EFFORTS.has(reasoningEffort)) {
        throw new Error(`Codex reasoning effort must be one of ${[...REASONING_EFFORTS].join(", ")}`);
      }
      const codexHome = harnessOptions.codexHome ?? (process.env[CODEX_HOME_ENV] || process.env.CODEX_HOME || undefined);
      const env = minimalEnv(process.env, harnessOptions.passEnv ?? envList(process.env[CODEX_PASS_ENV_ENV]));
      if (codexHome !== undefined) env.CODEX_HOME = codexHome;
      const responseTimeoutMs = fitWatchdog(harnessOptions.responseTimeoutMs ?? envMs(CODEX_RESPONSE_TIMEOUT_ENV, CODEX_DEFAULT_RESPONSE_TIMEOUT_MS), options.timeoutMs);
      // Codex's own default home, where it keeps rollouts when none is set.
      const home = codexHome ?? path.join(os.homedir(), ".codex");
      const settings: CodexSettings = { model: model ?? null };
      const thread = await openThread(options, home, settings);
      return {
        async run(request) {
          const sessionDir = options.sessionDir;
          const spawnedAt = new Date();
          // Codex appends to the rollout as the turn goes; a copy kept in the
          // session directory during the run leaves a resumable session even
          // if the job is killed before the final save below.
          let copied = false;
          const early =
            sessionDir !== undefined
              ? sessionSaver(
                  async () => (copied = (await saveRollout(home, sessionDir, thread, settings, spawnedAt, false)) || copied),
                  () => options.onSessionSaved?.(sessionRef(thread.threadId!)),
                )
              : undefined;
          let result: CodingRunResult;
          try {
            result = await runCodex({
              command,
              model,
              reasoningEffort,
              env,
              responseTimeoutMs,
              killGraceMs: harnessOptions.killGraceMs ?? 5_000,
              request,
              options,
              thread,
              ...(early !== undefined ? { onActivity: () => early.poke() } : {}),
            });
          } finally {
            await early?.close();
          }
          if (sessionDir === undefined) return result;
          if (!(await saveRollout(home, sessionDir, thread, settings, spawnedAt, true))) {
            // What it copied during the run is no longer what Codex holds, so no unreported session is left behind.
            if (copied && options.resume === undefined && thread.threadId !== undefined) {
              const ref = sessionRef(thread.threadId);
              await rm(path.join(sessionDir, `${ref}.jsonl`), { force: true });
              await rm(path.join(sessionDir, `${ref}.json`), { force: true });
            }
            return result;
          }
          // A later run of this session (a transient retry) resumes the thread instead of starting another.
          thread.started = true;
          return { ...result, sessionRef: sessionRef(thread.threadId!) };
        },
      };
    },
  };
}

function sessionRef(threadId: string): string {
  return `codex-${threadId}`;
}

/** Restore the thread `resume` names into the Codex home, or fail; never start a fresh one in its place. */
async function openThread(options: CodingSessionOptions, home: string, settings: CodexSettings): Promise<CodexThread> {
  if (options.resume === undefined) return { started: false };
  const ref = options.resume;
  const threadId = SESSION_REF.exec(ref)?.[1];
  if (threadId === undefined) throw new Error(`malformed session ref ${ref}`);
  if (options.sessionDir === undefined) throw new Error("no session directory to restore from");
  const [meta, rollout] = await Promise.all([
    readFile(path.join(options.sessionDir, `${ref}.json`), "utf8").catch(() => undefined),
    readFile(path.join(options.sessionDir, `${ref}.jsonl`), "utf8").catch(() => undefined),
  ]);
  if (meta === undefined || rollout === undefined) throw new Error(`no saved session for ${ref}`);
  if (rollout.trim() === "") throw new Error(`saved session ${ref} is empty`);
  let recorded: { rollout?: unknown; model?: unknown };
  try {
    recorded = JSON.parse(meta) as typeof recorded;
    for (const line of rollout.split("\n")) if (line.trim() !== "") JSON.parse(line);
  } catch {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  const { rollout: file, model } = recorded ?? {};
  if (typeof file !== "string" || !ROLLOUT_PATH.test(file) || !file.endsWith(`-${threadId}.jsonl`) || (model !== null && typeof model !== "string")) {
    throw new Error(`saved session ${ref} is corrupt`);
  }
  if (model !== settings.model) {
    const describe = (m: string | null) => (m === null ? "Codex's default model" : `model ${m}`);
    throw new Error(`saved session ${ref} ran on ${describe(model)}; this job asks for ${describe(settings.model)}`);
  }
  // The saved copy is authoritative: Codex resumes the thread from this file.
  await writeAtomic(path.join(home, file), rollout);
  return { threadId, rollout: file, started: true };
}

/**
 * Copy the thread's rollout into the controller's session directory; false
 * until Codex has named the thread and written its rollout. Codex may still
 * be appending (an early save during the run), so only complete records are
 * copied. `final` also searches the whole session store for the rollout.
 */
async function saveRollout(
  home: string,
  sessionDir: string,
  thread: CodexThread,
  settings: CodexSettings,
  spawnedAt: Date,
  final: boolean,
): Promise<boolean> {
  if (thread.threadId === undefined) return false;
  if (thread.rollout === undefined) {
    const found = await findRollout(home, thread.threadId, [spawnedAt, new Date()], final);
    if (found === undefined) return false;
    thread.rollout = found;
  }
  const file = path.join(home, thread.rollout);
  // Only a regular file Codex wrote, never a link out of its store.
  const info = await lstat(file, { bigint: true }).catch(() => undefined);
  if (!info?.isFile()) return false;
  const rollout = completeJsonl((await readScanned(file, info)).toString("utf8"));
  if (rollout.trim() === "") return false;
  const ref = sessionRef(thread.threadId);
  // The settings first: a rollout in the session directory is restorable once it lands.
  await writeAtomic(path.join(sessionDir, `${ref}.json`), JSON.stringify({ rollout: thread.rollout, ...settings }));
  await writeAtomic(path.join(sessionDir, `${ref}.jsonl`), rollout);
  return true;
}

/**
 * The rollout Codex keeps for `threadId`, relative to its home: looked up in
 * the day directories of `times` (local and UTC), and, with `everywhere`, in
 * every day directory of the store.
 */
async function findRollout(home: string, threadId: string, times: Date[], everywhere: boolean): Promise<string | undefined> {
  const suffix = `-${threadId}.jsonl`;
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = new Set<string>();
  for (const t of times) {
    days.add(`${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`);
    days.add(`${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`);
  }
  const inDay = async (day: string): Promise<string | undefined> => {
    const names = await readdir(path.join(home, "sessions", day)).catch(() => [] as string[]);
    const name = names.find((n) => n.startsWith("rollout-") && n.endsWith(suffix));
    const rel = name !== undefined ? `sessions/${day}/${name}` : undefined;
    return rel !== undefined && ROLLOUT_PATH.test(rel) ? rel : undefined;
  };
  for (const day of days) {
    const found = await inDay(day);
    if (found !== undefined) return found;
  }
  if (!everywhere) return undefined;
  const sessions = path.join(home, "sessions");
  for (const year of await readdir(sessions).catch(() => [] as string[])) {
    for (const month of await readdir(path.join(sessions, year)).catch(() => [] as string[])) {
      for (const day of await readdir(path.join(sessions, year, month)).catch(() => [] as string[])) {
        const key = `${year}/${month}/${day}`;
        if (days.has(key)) continue;
        const found = await inDay(key);
        if (found !== undefined) return found;
      }
    }
  }
  return undefined;
}

async function writeAtomic(target: string, contents: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

function envMs(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} must be a non-negative number of milliseconds`);
  return ms;
}

interface RunArgs {
  command: string;
  model: string | undefined;
  reasoningEffort: string | undefined;
  env: NodeJS.ProcessEnv;
  responseTimeoutMs: number;
  killGraceMs: number;
  request: CodingRunRequest;
  options: CodingSessionOptions;
  thread: CodexThread;
  /** Called on each event Codex streams, while its rollout may be growing. */
  onActivity?: () => void;
}

async function runCodex(args: RunArgs): Promise<CodingRunResult> {
  const { options, request } = args;
  if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
  // Codex has no hook before each provider request: the first is reserved up
  // front, and one more after each command whose output goes back to the model.
  if (!(await options.reserveModelCall())) return { status: "failed", summary: BUDGET_EXHAUSTED };

  const scratch = await mkdtemp(path.join(os.tmpdir(), "gl-codex-"));
  try {
    const last = path.join(scratch, "last-message.txt");
    const { thread } = args;
    // Without a session directory nothing is continued, so Codex persists nothing.
    // `resume` takes the sandbox and working directory from `exec` itself, and the rest after it.
    const cli =
      thread.started && thread.threadId !== undefined
        ? ["exec", "--sandbox", "read-only", "--cd", options.cwd, "resume", "--json", "--skip-git-repo-check", "--output-last-message", last]
        : ["exec", "--json", ...(options.sessionDir === undefined ? ["--ephemeral"] : []), "--skip-git-repo-check", "--sandbox", "read-only", "--cd", options.cwd, "--output-last-message", last];
    if (args.model !== undefined) cli.push("--model", args.model);
    if (args.reasoningEffort !== undefined) cli.push("--config", `model_reasoning_effort="${args.reasoningEffort}"`);
    // Codex has no in-turn retry in this harness either, so the reference id
    // set is baked into the schema as `enum` up front (§4.3).
    const schema =
      request.resultContract !== undefined
        ? applyReferenceEnums(request.resultContract.schema, request.resultContract.references, request.resultContract.knownReferences)
        : request.resultSchema !== undefined
          ? inlineObjectSchema(request.resultSchema)
          : undefined;
    if (schema !== undefined) {
      const file = path.join(scratch, "schema.json");
      await writeFile(file, JSON.stringify(schema), { mode: 0o600 });
      cli.push("--output-schema", file);
    }
    if (thread.started && thread.threadId !== undefined) cli.push(thread.threadId);
    cli.push("-");
    const wantsResult = request.resultContract !== undefined || request.resultSchema !== undefined;
    const prompt = [request.assignment, ...scopeNotes(options), ...(wantsResult ? [RESULT_NOTE] : [])].join("\n\n");

    const childEnv = { ...args.env };
    const contractName = request.resultContract?.name ?? request.resultSchema;
    if (contractName !== undefined) childEnv[JOB_CONTRACT_ENV] = contractName;
    if (request.identity !== undefined) childEnv[JOB_IDENTITY_ENV] = JSON.stringify(request.identity);
    if (request.resultContract?.knownReferences !== undefined) childEnv[JOB_REFERENCES_ENV] = JSON.stringify(request.resultContract.knownReferences);

    // Nothing awaits between this check and the abort listener, so a stop during setup cannot miss the process.
    if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
    const child = spawn(args.command, cli, { cwd: options.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
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
    options.signal?.addEventListener("abort", terminate, { once: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);

    let budgetRefused = false;
    let reservations = Promise.resolve();
    let accountingFailed = false;
    const reserve = () => {
      reservations = reservations.then(async () => {
        if (budgetRefused) return;
        if (!(await options.reserveModelCall())) {
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
    let usage: CodingUsage | undefined;
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
        if (event.type === "error") failure = text(event.message) ?? "error";
        if (event.type === "turn.completed") {
          completed = true;
          usage = usageOf(event.usage) ?? usage;
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

      const outcome = await (async (): Promise<CodingRunResult> => {
        if (budgetRefused) return { status: "failed", summary: BUDGET_EXHAUSTED };
        if (options.signal?.aborted) return { status: "failed", summary: "agent session aborted" };
        if (stalled) return { status: "failed", summary: `Codex stalled: no activity for ${args.responseTimeoutMs / 1000}s` };
        if (accountingFailed) return { status: "failed", summary: "Codex model request accounting failed" };
        if (error !== undefined) return { status: "failed", summary: bounded(`could not start Codex (${args.command}): ${error.message}`) };
        if (failure !== undefined || (code !== 0 && !closedAfterTurn) || !completed) {
          const detail = failure ?? (stderr.trim() || `exit code ${code}`);
          return { status: "failed", summary: bounded(`Codex run failed: ${detail}`) };
        }
        const message = (await readFile(last, "utf8").catch(() => "")).trim();
        if (!wantsResult) return { status: "completed", summary: bounded(message || "Codex completed") };
        const kind = request.resultContract?.name ?? (schema !== undefined ? "structured" : request.resultSchema);
        const output = parseJson(message);
        if (output === undefined) return { status: "failed", summary: `agent finished without submitting a ${kind} result` };
        if (request.resultContract !== undefined) {
          const problems = validateResultShape(output, request.resultContract.schema);
          let value: unknown = output;
          if (problems.length === 0 && request.resultContract.references !== undefined && request.resultContract.knownReferences !== undefined) {
            const checked = checkReferences(output, request.resultContract.references, request.resultContract.knownReferences);
            problems.push(...checked.problems);
            value = checked.value;
          }
          if (problems.length > 0) {
            // --output-schema makes a type-level miss rare; a reference
            // outside the shown set is the likely case here. Codex has no
            // further turn in this run to correct it in, so the job fails as
            // a named contract violation instead of recording the result.
            return {
              status: "failed",
              summary: bounded(`result did not satisfy its declared contract (${kind}): ${problems.join("; ")}`),
              failureKind: "contract_violation",
              output,
            };
          }
          const submitted = (value as { summary?: unknown } | null)?.summary;
          return {
            status: "completed",
            summary: bounded(typeof submitted === "string" ? submitted : `Codex submitted a ${kind} result`),
            output: value,
          };
        }
        const submitted = (output as { summary?: unknown } | null)?.summary;
        return {
          status: "completed",
          summary: bounded(typeof submitted === "string" ? submitted : `Codex submitted a ${kind} result`),
          output,
        };
      })();
      const tooled: CodingRunResult = unparsed ? outcome : { ...outcome, nativeTools };
      return usage !== undefined ? { ...tooled, usage } : tooled;
    } finally {
      clearTimeout(watchdog);
      clearTimeout(closeTimer);
      options.signal?.removeEventListener("abort", terminate);
      if (!reaped) {
        terminate();
        await exited;
        await drainGroup();
      }
      clearTimeout(killTimer);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The final message as a JSON object; a code fence around it is tolerated. */
function parseJson(message: string): Record<string, unknown> | undefined {
  const body = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(message)?.[1] ?? message;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Codex reports `input_tokens` including the cached part. */
function usageOf(usage: Record<string, unknown> | undefined): CodingUsage | undefined {
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

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Every command, patch, search or other item counts: nothing Codex runs on its own is proven side-effect free. */
function codexToolUse(item: { type?: unknown }): NativeToolUse {
  return { name: typeof item.type === "string" ? item.type : "unknown" };
}
