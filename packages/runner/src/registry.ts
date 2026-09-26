import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_SESSION_REF_CHARS,
  pinJobExecutor,
  validateExecutorInput,
  type ExecutorContext,
  type ExecutorDefinition,
  type ExecutorEffect,
  type ExecutorPin,
  type JobSpec,
  type ToolCallResult,
} from "@graphloom/sdk";
import { digestExecutorSource } from "./digest.js";
import { assertSandboxSupported, sandboxNodeArgs } from "./sandbox.js";
import type { ExecutorDescriptor, JobContext, JobEvidenceItem, JobResult, Runner } from "./types.js";

/** Qualified ids under this namespace belong to GraphLoom built-in packages. */
export const BUILTIN_EXECUTOR_NAMESPACE = "graphloom.";

/** A custom registration must never shadow a built-in qualified id. */
export function assertNoBuiltinShadowing(ids: Iterable<string>, builtin: boolean): void {
  if (builtin) return;
  for (const id of ids) {
    if (id.startsWith(BUILTIN_EXECUTOR_NAMESPACE)) {
      throw new Error(
        `custom executor cannot claim built-in id ${id}; register it under your own namespace`,
      );
    }
  }
}

export interface TrustedInProcessRunnerOptions {
  /**
   * Executors run in-process. Only for trusted CI/scripted code — never for
   * untrusted plugin packages. Prefer `createChildExecutorRunner`.
   */
  executors: ExecutorDefinition[];
  fallback: Runner;
  /** Registering `graphloom.*` ids requires declaring the executors built-in. */
  builtin?: boolean;
}

/** @deprecated Alias of TrustedInProcessRunnerOptions. */
export type RegistryRunnerOptions = TrustedInProcessRunnerOptions;

export interface ChildExecutorRunnerOptions {
  /** Absolute path to a module exporting `executors: ExecutorDefinition[]`. */
  entryModule: string;
  /** Ids served by the child; others fall through to `fallback`. */
  executorIds: string[];
  fallback: Runner;
  /** Per-call timeout (ms). Default 30_000. */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Override worker entry (tests). */
  workerModule?: string;
  /** Serving `graphloom.*` ids requires declaring the package built-in. */
  builtin?: boolean;
  /**
   * Operator-bound credentials, delivered over stdin (never argv or env) and
   * exposed as `ctx.credentials`. Their values are redacted from job results.
   */
  credentials?: Record<string, string>;
  /** Effects the operator granted; executors declaring any other effect are refused. */
  allowedEffects?: readonly ExecutorEffect[];
  /**
   * Run the executor under Node's permission model: it may read only its own
   * package and dependencies, and cannot write files, spawn processes or
   * workers, or load native addons. Network access is not restricted.
   */
  sandbox?: boolean;
  /**
   * Package root the executor digest covers, which also makes the package
   * repairable from a run-local copy. Default: the entry module file alone.
   */
  sourceRoot?: string;
}

/** Replace every bound credential value in a value before it can become durable. */
function redactCredentials<T>(result: T, credentials: Record<string, string> | undefined): T {
  // Longest first, so a secret containing another is removed whole.
  const secrets = Object.values(credentials ?? {})
    .filter((s) => s.length > 0)
    .sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return result;
  const scrub = (s: string) => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), s);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), walk(v)]));
    }
    return value;
  };
  return walk(result) as T;
}

function resultFromOutput(
  output: unknown,
  ctx: JobContext,
  status: "ok" | "failed" = "ok",
): JobResult {
  if (
    output !== null &&
    typeof output === "object" &&
    "status" in output &&
    "summary" in output
  ) {
    const o = output as Partial<JobResult> & {
      status?: string;
      summary?: string;
      evidence?: JobEvidenceItem[];
      retryAfterMs?: unknown;
      sessionRef?: unknown;
    };
    const resultStatus = o.status === "failed" || o.status === "conflict" ? o.status : status;
    const retryAfterMs =
      resultStatus !== "ok" && typeof o.retryAfterMs === "number" && Number.isFinite(o.retryAfterMs) && o.retryAfterMs >= 0
        ? Math.ceil(o.retryAfterMs)
        : undefined;
    // Only a job the controller gave a session directory can name a continuable session.
    const sessionRef =
      ctx.session !== undefined &&
      typeof o.sessionRef === "string" &&
      o.sessionRef.length > 0 &&
      o.sessionRef.length <= MAX_SESSION_REF_CHARS
        ? o.sessionRef
        : undefined;
    return {
      status: resultStatus,
      summary: typeof o.summary === "string" ? o.summary : "executor completed",
      runId: ctx.runId,
      operationId: ctx.operationId,
      generation: ctx.generation,
      ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(sessionRef !== undefined ? { sessionRef } : {}),
    };
  }
  return {
    status,
    summary: "executor completed",
    runId: ctx.runId,
    operationId: ctx.operationId,
    generation: ctx.generation,
    evidence: [{ kind: "other", payload: { executorOutput: output } }],
  };
}

/** Serializable context fields sent to an executor process. */
function executorCtx(job: JobSpec, ctx: JobContext) {
  return {
    runId: ctx.runId,
    operationId: ctx.operationId,
    generation: ctx.generation,
    worktreePath: ctx.worktreePath,
    artifactDir: ctx.artifactDir,
    ...(job.writeScope !== undefined ? { writeScope: job.writeScope } : {}),
    ...(job.readOnly !== undefined ? { readOnly: job.readOnly } : {}),
    ...(ctx.session !== undefined ? { session: { ...ctx.session } } : {}),
  };
}

/** Tool bindings visible to the executor: names and effects, never pins. */
function toolView(job: JobSpec) {
  return (job.tools ?? []).map((t) => ({
    name: t.name,
    effect: t.effect,
    ...(t.description !== undefined ? { description: t.description } : {}),
  }));
}

function inProcessCtx(job: JobSpec, ctx: JobContext): ExecutorContext {
  const children = ctx.children;
  return {
    ...executorCtx(job, ctx),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    ...(children !== undefined && job.tools !== undefined
      ? { tools: { bindings: toolView(job), call: (req) => children.callTool(req) } }
      : {}),
    ...(children !== undefined ? { usage: { reserveModelCall: () => children.reserveModelCall() } } : {}),
  };
}

/** In-process code has no files to hash; its identity and implementation text stand in. */
function inProcessDigest(def: ExecutorDefinition): string {
  return createHash("sha256")
    .update(`${def.id}\0${def.version ?? ""}\0${def.effect}\0${def.execute.toString()}`)
    .digest("hex");
}

/** The digest covers `root`, so the module that runs must really live inside it. */
async function containedIn(root: string, file: string): Promise<boolean> {
  try {
    const rel = path.relative(await realpath(root), await realpath(file));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function digestMismatch(pin: ExecutorPin, serving: string): string | undefined {
  if (pin.digest === undefined || pin.digest === serving) return undefined;
  return `executor ${pin.id} digest ${serving.slice(0, 12)} does not match pinned ${pin.digest.slice(0, 12)}`;
}

async function describeFallback(fallback: Runner, served: { has(id: string): boolean }): Promise<ExecutorDescriptor[]> {
  return ((await fallback.describeExecutors?.()) ?? []).filter((d) => !served.has(d.id));
}

function effectMismatch(def: ExecutorDefinition, job: JobSpec): string | undefined {
  if (job.effect !== undefined && job.effect !== def.effect) {
    return `executor ${def.id} effect ${def.effect} does not match declared ${job.effect}`;
  }
  return undefined;
}

/**
 * @deprecated Use createTrustedInProcessRunner — alias retained for call sites.
 * In-process only; does not isolate untrusted executor code.
 */
export const createRegistryRunner = createTrustedInProcessRunner;

/**
 * Trusted in-process executor registry for CI/scripted tests.
 * Untrusted plugin executors must use `createChildExecutorRunner`.
 */
export function createTrustedInProcessRunner(
  options: TrustedInProcessRunnerOptions,
): Runner {
  assertNoBuiltinShadowing(
    options.executors.map((def) => def.id),
    options.builtin === true,
  );
  const byId = new Map<string, ExecutorDefinition>();
  for (const def of options.executors) {
    if (byId.has(def.id)) {
      throw new Error(`duplicate executor registration: ${def.id}`);
    }
    byId.set(def.id, def);
  }
  const digests = new Map([...byId.values()].map((def) => [def.id, inProcessDigest(def)]));

  return {
    async describeExecutors() {
      const own = [...byId.keys()].map((id) => ({
        id,
        digest: digests.get(id)!,
        source: "in-process",
        isolation: "in-process" as const,
        builtin: options.builtin === true,
      }));
      return [...own, ...(await describeFallback(options.fallback, byId))];
    },
    async runJob(job: JobSpec, ctx: JobContext): Promise<JobResult> {
      const pinned = pinJobExecutor(job);
      const pin = pinned.executor as ExecutorPin;
      const def = byId.get(pin.id);
      if (!def) {
        return options.fallback.runJob(pinned, ctx);
      }
      try {
        if (ctx.executorSource !== undefined) {
          throw new Error(`executor ${def.id} runs in-process and cannot be served from a run-local copy`);
        }
        const digestError = digestMismatch(pin, digests.get(def.id)!);
        if (digestError) throw new Error(digestError);
        const mismatch = effectMismatch(def, pinned);
        if (mismatch) throw new Error(mismatch);
        validateExecutorInput(def, pinned.input);
      } catch (err) {
        return {
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
          runId: ctx.runId,
          operationId: ctx.operationId,
          generation: ctx.generation,
        };
      }
      try {
        const output = await def.execute(pinned.input, inProcessCtx(pinned, ctx));
        if (def.outputSchema && !def.outputSchema(output)) {
          return {
            status: "failed",
            summary: `executor ${def.id}: output failed schema validation`,
            runId: ctx.runId,
            operationId: ctx.operationId,
            generation: ctx.generation,
          };
        }
        return resultFromOutput(output, ctx);
      } catch (err) {
        return {
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
          runId: ctx.runId,
          operationId: ctx.operationId,
          generation: ctx.generation,
        };
      }
    },
  };
}

/**
 * Runs registered custom executor pins in a child Node process loaded from
 * `entryModule`. Built-in / unknown pins use `fallback` (still the caller's
 * runner — typically scripted or agent — which may itself be in-process).
 */
export function createChildExecutorRunner(
  options: ChildExecutorRunnerOptions,
): Runner {
  assertNoBuiltinShadowing(options.executorIds, options.builtin === true);
  const served = new Set(options.executorIds);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const workerModule =
    options.workerModule ??
    fileURLToPath(new URL("./executor-worker.js", import.meta.url));
  const entryModule = path.resolve(options.entryModule);
  for (const [name, value] of Object.entries(options.credentials ?? {})) {
    if (value.length === 0) throw new Error(`credential "${name}" is empty`);
  }
  const sourceRoot = options.sourceRoot !== undefined ? path.resolve(options.sourceRoot) : undefined;
  const extraCa = options.env?.NODE_EXTRA_CA_CERTS;
  const sandboxArgs = (entry: string) =>
    options.sandbox === true ? sandboxNodeArgs([workerModule, entry], extraCa ? [extraCa] : []) : [];
  if (options.sandbox === true) assertSandboxSupported();
  const nodeArgs = sandboxArgs(entryModule);

  return {
    async describeExecutors() {
      const digest = await digestExecutorSource(sourceRoot ?? entryModule);
      const own: ExecutorDescriptor[] = options.executorIds.map((id) => ({
        id,
        digest,
        source: sourceRoot ?? entryModule,
        ...(sourceRoot !== undefined ? { entryModule } : {}),
        isolation: options.sandbox === true ? "sandbox" : "unrestricted",
        builtin: options.builtin === true,
      }));
      return [...own, ...(await describeFallback(options.fallback, served))];
    },
    async runJob(job: JobSpec, ctx: JobContext): Promise<JobResult> {
      const pinned = pinJobExecutor(job);
      const pin = pinned.executor as ExecutorPin;
      if (!served.has(pin.id)) {
        return options.fallback.runJob(pinned, ctx);
      }
      const failed = (summary: string): JobResult => ({
        status: "failed",
        summary,
        runId: ctx.runId,
        operationId: ctx.operationId,
        generation: ctx.generation,
      });
      if (options.sandbox === true && ctx.session !== undefined) {
        // A sandboxed executor cannot write, so it cannot keep a session, and must not silently start over.
        if (ctx.session.resume !== undefined) {
          return failed(`executor ${pin.id} runs sandboxed and cannot continue agent session ${ctx.session.resume}`);
        }
        const { session: _unusable, ...withoutSession } = ctx;
        void _unusable;
        ctx = withoutSession;
      }
      const override = ctx.executorSource;
      if (override !== undefined && pin.digest === undefined) {
        return failed(`executor ${pin.id}: a run-local copy runs only under a pinned digest`);
      }
      const entry = override !== undefined ? path.resolve(override.entryModule) : entryModule;
      if (override !== undefined && !(await containedIn(override.root, entry))) {
        return failed(`executor ${pin.id}: run-local entry module ${entry} is outside its root ${override.root}`);
      }
      if (pin.digest !== undefined) {
        let serving: string;
        try {
          serving = await digestExecutorSource(override !== undefined ? override.root : (sourceRoot ?? entryModule));
        } catch (err) {
          return failed(`executor ${pin.id} source unreadable: ${err instanceof Error ? err.message : String(err)}`);
        }
        const mismatch = digestMismatch(pin, serving);
        if (mismatch) return failed(mismatch);
      }
      const args = override !== undefined ? sandboxArgs(entry) : nodeArgs;

      return await new Promise<JobResult>((resolve) => {
        if (ctx.signal?.aborted) {
          resolve(failed("executor cancelled before start"));
          return;
        }
        const child = spawn(process.execPath, [...args, workerModule, entry], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: options.cwd ?? path.dirname(entry),
          env: options.env ?? process.env,
        });
        const stderr: string[] = [];
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c: string) => {
          stderr.push(c);
        });
        child.stdin.on("error", () => undefined);

        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        let settled = false;
        const onAbort = () => finish(failed("executor cancelled: run stopped"));
        const finish = (result: JobResult) => {
          if (settled) return;
          settled = true;
          rl.close();
          clearTimeout(timer);
          ctx.signal?.removeEventListener("abort", onAbort);
          child.stdin.end();
          child.kill("SIGKILL");
          resolve(redactCredentials(result, options.credentials));
        };
        ctx.signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          finish(failed(`executor child timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        const send = (message: unknown) => {
          if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`);
        };
        const children = ctx.children;
        const toolNames = new Set((pinned.tools ?? []).map((t) => t.name));

        rl.on("line", (line) => {
          // Lines buffered before the job settled must not start work after it.
          if (settled) return;
          let msg: {
            kind?: string;
            seq?: number;
            output?: unknown;
            message?: string;
            toolCallId?: unknown;
            tool?: unknown;
            input?: unknown;
          };
          try {
            msg = JSON.parse(line) as typeof msg;
          } catch (err) {
            finish(failed(err instanceof Error ? err.message : String(err)));
            return;
          }
          if ((msg.kind === "tool_call" || msg.kind === "model_call") && !(Number.isSafeInteger(msg.seq) && msg.seq! > 0)) {
            finish(failed(`executor sent ${msg.kind} without a positive integer seq`));
            return;
          }
          if (msg.kind === "tool_call") {
            const seq = msg.seq;
            const answer = (result: ToolCallResult) =>
              send({ kind: "tool_result", seq, result: redactCredentials(result, options.credentials) });
            if (!children || typeof msg.toolCallId !== "string" || typeof msg.tool !== "string" || !toolNames.has(msg.tool)) {
              answer({ status: "failed", summary: `tool ${String(msg.tool)} is not admitted for this job` });
              return;
            }
            children
              .callTool({
                toolCallId: msg.toolCallId,
                tool: msg.tool,
                input: redactCredentials(msg.input, options.credentials),
              })
              .then(answer, (err: unknown) =>
                answer({ status: "failed", summary: err instanceof Error ? err.message : String(err) }),
              );
            return;
          }
          if (msg.kind === "model_call") {
            const seq = msg.seq;
            const grant = (granted: boolean) => send({ kind: "model_call_result", seq, granted });
            if (!children) {
              grant(false);
              return;
            }
            children.reserveModelCall().then(grant, () => grant(false));
            return;
          }
          if (msg.kind === "ok") {
            finish(resultFromOutput(msg.output, ctx));
            return;
          }
          finish(failed(msg.message ?? "executor child error"));
        });

        child.on("error", (err) => {
          finish(failed(`executor child spawn failed: ${err.message}`));
        });
        child.on("exit", (code) => {
          if (!settled) {
            finish(failed(`executor child exited (code=${String(code)}): ${stderr.join("")}`));
          }
        });

        const req = {
          kind: "execute",
          id: pin.id,
          ...(pin.version !== undefined ? { version: pin.version } : {}),
          ...(pinned.effect !== undefined ? { effect: pinned.effect } : {}),
          input: pinned.input,
          ctx: executorCtx(pinned, ctx),
          ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
          ...(options.allowedEffects !== undefined
            ? { allowedEffects: [...options.allowedEffects] }
            : {}),
          ...(children !== undefined && pinned.tools !== undefined ? { tools: toolView(pinned) } : {}),
          ...(children !== undefined ? { usage: true } : {}),
        };
        send(req);
        // Without a controller port nothing more is sent; closing stdin lets the worker exit.
        if (children === undefined) child.stdin.end();
      });
    },
  };
}

export interface DescribedExecutor {
  id: string;
  version?: string;
  effect: ExecutorEffect;
}

/**
 * Load an executor module in a worker process and list the executors it
 * defines, without running any. Used to check a repaired copy still serves
 * the pinned identities.
 */
export async function describeExecutorModule(options: {
  entryModule: string;
  sandbox?: boolean;
  workerModule?: string;
  timeoutMs?: number;
}): Promise<DescribedExecutor[]> {
  const workerModule = options.workerModule ?? fileURLToPath(new URL("./executor-worker.js", import.meta.url));
  const entry = path.resolve(options.entryModule);
  if (options.sandbox === true) assertSandboxSupported();
  const args = options.sandbox === true ? sandboxNodeArgs([workerModule, entry]) : [];
  const child = spawn(process.execPath, [...args, workerModule, entry], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: path.dirname(entry),
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => stderr.push(c));
  child.stdin.on("error", () => undefined);
  return await new Promise<DescribedExecutor[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`describing ${entry} timed out`));
    }, options.timeoutMs ?? 10_000);
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let msg: { kind?: string; executors?: DescribedExecutor[]; message?: string };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (msg.kind === "described" && Array.isArray(msg.executors)) resolve(msg.executors);
      else reject(new Error(msg.message ?? `unexpected describe reply from ${entry}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`executor module ${entry} exited (code=${String(code)}): ${stderr.join("").trim()}`));
    });
    child.stdin.end(`${JSON.stringify({ kind: "describe" })}\n`);
  });
}
