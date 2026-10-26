// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { JobSpec } from "@graphloom/sdk";
import type { JobContext, JobResult, Runner } from "./types.js";

export type ScriptedJobHandler = (
  job: JobSpec,
  ctx: JobContext,
  index: number,
) => Omit<JobResult, "runId" | "operationId" | "generation"> | Promise<Omit<JobResult, "runId" | "operationId" | "generation">>;

export interface ScriptedRunnerOptions {
  /** Handlers invoked in order for successive jobs. Functions may ignore index. */
  jobs: ScriptedJobHandler[];
}

/**
 * CI/scripted Runner: returns canned job results without live agents.
 * Throws when more jobs are requested than scripted.
 * Echoes run/operation/generation from context onto every result.
 */
export function createScriptedRunner(options: ScriptedRunnerOptions): Runner {
  let index = 0;
  const { jobs } = options;

  return {
    async runJob(job: JobSpec, ctx: JobContext): Promise<JobResult> {
      if (index >= jobs.length) {
        throw new Error(
          `scripted runner exhausted: job ${index + 1} requested, only ${jobs.length} scripted`,
        );
      }
      const handler = jobs[index];
      if (handler === undefined) {
        throw new Error(`scripted runner missing handler at index ${index}`);
      }
      const current = index;
      index += 1;
      const partial = await handler(job, ctx, current);
      return {
        ...partial,
        runId: ctx.runId,
        operationId: ctx.operationId,
        generation: ctx.generation,
      };
    },
  };
}
