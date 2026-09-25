import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  pinJobExecutor,
  validateExecutorInput,
  type ExecutorDefinition,
  type ExecutorEffect,
  type ExecutorPin,
  type JobSpec,
} from "@graphloom/sdk";
import { assertSandboxSupported, sandboxNodeArgs } from "./sandbox.js";
import type { JobContext, JobEvidenceItem, JobResult, Runner } from "./types.js";

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
}

/** Replace every bound credential value in a result before it can become durable. */
function redactCredentials(result: JobResult, credentials: Record<string, string> | undefined): JobResult {
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
  return walk(result) as JobResult;
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
    };
    return {
      status: o.status === "failed" || o.status === "conflict" ? o.status : status,
      summary: typeof o.summary === "string" ? o.summary : "executor completed",
      runId: ctx.runId,
      operationId: ctx.operationId,
      generation: ctx.generation,
      ...(o.evidence !== undefined ? { evidence: o.evidence } : {}),
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

function executorCtx(job: JobSpec, ctx: JobContext) {
  return {
    runId: ctx.runId,
    operationId: ctx.operationId,
    generation: ctx.generation,
    worktreePath: ctx.worktreePath,
    artifactDir: ctx.artifactDir,
    ...(job.writeScope !== undefined ? { writeScope: job.writeScope } : {}),
    ...(job.readOnly !== undefined ? { readOnly: job.readOnly } : {}),
  };
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

  return {
    async runJob(job: JobSpec, ctx: JobContext): Promise<JobResult> {
      const pinned = pinJobExecutor(job);
      const pin = pinned.executor as ExecutorPin;
      const def = byId.get(pin.id);
      if (!def) {
        return options.fallback.runJob(pinned, ctx);
      }
      try {
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
        const output = await def.execute(pinned.input, executorCtx(pinned, ctx));
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
  const extraCa = options.env?.NODE_EXTRA_CA_CERTS;
  const nodeArgs =
    options.sandbox === true
      ? (assertSandboxSupported(), sandboxNodeArgs([workerModule, entryModule], extraCa ? [extraCa] : []))
      : [];

  return {
    async runJob(job: JobSpec, ctx: JobContext): Promise<JobResult> {
      const pinned = pinJobExecutor(job);
      const pin = pinned.executor as ExecutorPin;
      if (!served.has(pin.id)) {
        return options.fallback.runJob(pinned, ctx);
      }

      return await new Promise<JobResult>((resolve) => {
        const child = spawn(process.execPath, [...nodeArgs, workerModule, entryModule], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: options.cwd ?? path.dirname(entryModule),
          env: options.env ?? process.env,
        });
        const stderr: string[] = [];
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c: string) => {
          stderr.push(c);
        });

        let settled = false;
        const finish = (result: JobResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill("SIGKILL");
          resolve(redactCredentials(result, options.credentials));
        };

        const timer = setTimeout(() => {
          finish({
            status: "failed",
            summary: `executor child timed out after ${timeoutMs}ms`,
            runId: ctx.runId,
            operationId: ctx.operationId,
            generation: ctx.generation,
          });
        }, timeoutMs);

        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        rl.once("line", (line) => {
          try {
            const msg = JSON.parse(line) as {
              kind?: string;
              output?: unknown;
              message?: string;
            };
            if (msg.kind === "ok") {
              finish(resultFromOutput(msg.output, ctx));
              return;
            }
            finish({
              status: "failed",
              summary: msg.message ?? "executor child error",
              runId: ctx.runId,
              operationId: ctx.operationId,
              generation: ctx.generation,
            });
          } catch (err) {
            finish({
              status: "failed",
              summary: err instanceof Error ? err.message : String(err),
              runId: ctx.runId,
              operationId: ctx.operationId,
              generation: ctx.generation,
            });
          }
        });

        child.on("error", (err) => {
          finish({
            status: "failed",
            summary: `executor child spawn failed: ${err.message}`,
            runId: ctx.runId,
            operationId: ctx.operationId,
            generation: ctx.generation,
          });
        });
        child.on("exit", (code) => {
          if (!settled) {
            finish({
              status: "failed",
              summary: `executor child exited (code=${String(code)}): ${stderr.join("")}`,
              runId: ctx.runId,
              operationId: ctx.operationId,
              generation: ctx.generation,
            });
          }
        });

        const req = {
          kind: "execute",
          id: pin.id,
          ...(pin.version !== undefined ? { version: pin.version } : {}),
          input: pinned.input,
          ctx: executorCtx(pinned, ctx),
          ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
          ...(options.allowedEffects !== undefined
            ? { allowedEffects: [...options.allowedEffects] }
            : {}),
        };
        child.stdin.write(`${JSON.stringify(req)}\n`);
        child.stdin.end();
      });
    },
  };
}
