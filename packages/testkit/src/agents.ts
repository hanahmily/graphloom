// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobSpec } from "@graphloom/sdk";
import type { JobContext, JobEvidenceItem, JobResult, Runner } from "@graphloom/runner";

/** What a scripted agent returns for one job (the controller's identity fields are filled in). */
export type AgentReply = Omit<JobResult, "runId" | "operationId" | "generation">;

export interface ScriptedAgentsOptions {
  /** Answer one job. Called for every job the runner receives. */
  reply(job: JobSpec, ctx: JobContext, seen: number): AgentReply | Promise<AgentReply>;
  /** Executors this runner claims to serve (for intake pinning). */
  executors?: Awaited<ReturnType<NonNullable<Runner["describeExecutors"]>>>;
  /**
   * Fail this many `work` jobs first, as an agent that "finished without a
   * result" — the failure that opens a recovery episode and calls the
   * supervisor. Default 0.
   */
  failWork?: number;
  /** Fail this many `review` jobs first, the same way. Default 0. */
  failReview?: number;
  /** Called before each job is answered (e.g. to request an operator stop mid-run). */
  onJob?: (job: JobSpec, ctx: JobContext, seen: number) => void | Promise<void>;
}

export interface ScriptedAgents extends Runner {
  /** Every job received, in order. */
  readonly jobs: JobSpec[];
}

/**
 * A Runner standing in for coding agents: it answers each job by what it is
 * (its stage and purpose), not by its position in a fixed list, so the same
 * agents serve a run whatever path the graph and supervisor take.
 */
export function scriptedAgents(options: ScriptedAgentsOptions): ScriptedAgents {
  const jobs: JobSpec[] = [];
  let failures = options.failWork ?? 0;
  let reviewFailures = options.failReview ?? 0;
  return {
    jobs,
    ...(options.executors !== undefined ? { describeExecutors: async () => options.executors! } : {}),
    async runJob(job, ctx) {
      const seen = jobs.length;
      jobs.push(job);
      await options.onJob?.(job, ctx, seen);
      let reply: AgentReply;
      if (job.purpose === "work" && failures > 0) {
        failures -= 1;
        reply = { status: "failed", summary: "agent finished without a result" };
      } else if (job.purpose === "review" && reviewFailures > 0) {
        reviewFailures -= 1;
        reply = { status: "failed", summary: "agent finished without a result" };
      } else {
        reply = await options.reply(job, ctx, seen);
      }
      return { ...reply, runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation };
    },
  };
}

/** A coding-agent result whose structured output is `output` (the shape the controller checks contracts on). */
export function agentOutput(output: unknown, extra: JobEvidenceItem[] = [], harness?: string): AgentReply {
  return {
    status: "ok",
    summary: "done",
    evidence: [{ kind: "other", payload: { codingAgent: { ...(harness !== undefined ? { harness } : {}), status: "completed", output } } }, ...extra],
  };
}

/** Exact bytes the hello graph's Write stage requires. */
export const HELLO_GREETING = "Hello, GraphLoom!\n";
export const HELLO_REQUEST =
  'Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by one newline. Do not modify other files.';

/** Agents for the hello graph: the writer writes GREETING.txt, the reviewer approves. */
export function helloAgents(options: Omit<ScriptedAgentsOptions, "reply"> = {}): ScriptedAgents {
  return scriptedAgents({
    ...options,
    async reply(job, ctx) {
      if (job.purpose === "review") return agentOutput({ verdict: "approved", summary: "GREETING.txt holds exactly the requested bytes." });
      if (job.purpose === "work") {
        await writeFile(path.join(ctx.worktreePath, "GREETING.txt"), HELLO_GREETING, "utf8");
        return agentOutput({});
      }
      return { status: "failed", summary: `hello agents have no reply for a ${job.purpose} job` };
    },
  });
}
