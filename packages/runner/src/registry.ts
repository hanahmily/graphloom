import {
  pinJobExecutor,
  validateExecutorInput,
  type ExecutorDefinition,
  type ExecutorPin,
  type JobSpec,
} from "@graphloom/sdk";
import type { JobContext, JobResult, Runner } from "./types.js";

export interface RegistryRunnerOptions {
  /** Executors loaded outside the controller (plugin/built-in packages). */
  executors: ExecutorDefinition[];
  /**
   * Fallback for built-in agent/command pins (or unknown ids).
   * Typically the scripted or live agent runner.
   */
  fallback: Runner;
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
    const o = output as Partial<JobResult> & { status?: string; summary?: string };
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

/**
 * Runner that resolves pinned executor ids from a registry (never imported by
 * the controller). Unregistered pins fall through to `fallback` so legacy
 * agent/command jobs keep working.
 */
export function createRegistryRunner(options: RegistryRunnerOptions): Runner {
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
        const output = await def.execute(pinned.input, {
          runId: ctx.runId,
          operationId: ctx.operationId,
          generation: ctx.generation,
          worktreePath: ctx.worktreePath,
          artifactDir: ctx.artifactDir,
        });
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
