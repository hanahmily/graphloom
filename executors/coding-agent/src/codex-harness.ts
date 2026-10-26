import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  fitWatchdog,
  type CodingHarness,
  type CodingRunRequest,
  type CodingRunResult,
  type CodingSessionOptions,
  type CodingUsage,
  type NativeToolUse,
} from "./harness.js";
import { drainOnExit, signalGroup } from "./process-group.js";

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
  item?: { id?: unknown; type?: unknown };
  usage?: Record<string, unknown>;
  error?: { message?: unknown };
  message?: unknown;
}

/**
 * A `CodingHarness` that runs the user's Codex CLI (`codex exec`) headless in
 * the worktree, in Codex's read-only sandbox. It serves read-only jobs without
 * graph tools and does not save sessions: Codex cannot confine writes to a
 * job's write scope, and its graph tools would bypass the controller.
 */
export function createCodexHarness(harnessOptions: CodexHarnessOptions = {}): CodingHarness {
  return {
    name: "codex",
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
      return {
        run: (request) =>
          runCodex({ command, model, reasoningEffort, env, responseTimeoutMs, killGraceMs: harnessOptions.killGraceMs ?? 5_000, request, options }),
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

interface RunArgs {
  command: string;
  model: string | undefined;
  reasoningEffort: string | undefined;
  env: NodeJS.ProcessEnv;
  responseTimeoutMs: number;
  killGraceMs: number;
  request: CodingRunRequest;
  options: CodingSessionOptions;
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
    const cli = ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--cd", options.cwd, "--output-last-message", last];
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
