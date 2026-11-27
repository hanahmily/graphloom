// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LoopRead } from "@graphloom/sdk";
import type { ReadOutcome } from "@graphloom/loop";
import { createBuiltinExecutorRunner, type JobResult, type Runner } from "@graphloom/runner";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { executors as githubExecutors } from "@graphloom/executor-github/executors";
import type { RunnerConfig } from "./runner-config.js";

/** Runs a loop evaluator's reads (docs/design-loop.md section 14.9): GitHub read executors only, never a write. */
export interface LoopReadHost {
  read(read: LoopRead, signal: AbortSignal): Promise<ReadOutcome>;
  /** Removes the scratch directory; idempotent. */
  close(): Promise<void>;
}

export interface LoopReadHostOptions {
  /** Only its `github.tokenEnv` and `github.baseUrl` are read; `github.writeTokenEnv` is ignored on purpose. */
  config: Pick<RunnerConfig, "github">;
  env: NodeJS.ProcessEnv;
  loopName: string;
  tickId: string;
  scratchRoot?: string;
}

/** The read executors of the GitHub package, by id, from the definitions' declared effect. */
const READS = new Map(
  githubExecutors
    .filter((e) => e.effect === "read" && githubExecutorPackage.executorIds.includes(e.id))
    .map((e) => [e.id as string, e.version ?? "1"] as const),
);
const KNOWN = new Map(githubExecutors.map((e) => [e.id as string, e.effect] as const));

function failed(summary: string): ReadOutcome {
  return { status: "failed", summary };
}

export async function createLoopReadHost(options: LoopReadHostOptions): Promise<LoopReadHost> {
  const github = options.config.github;
  if (github === undefined) throw new Error("loop reads need a github section in the runner config; none is configured");
  const tokenEnv = github.tokenEnv;
  if (tokenEnv === undefined) throw new Error("loop reads need github.tokenEnv in the runner config; none is configured, and anonymous reads are refused");
  const token = options.env[tokenEnv];
  if (token === undefined || token === "") throw new Error(`loop reads need the token in environment variable ${tokenEnv}, which is not set or is empty`);

  // The read token only, and no allowWrites: the package binding then allows the read effect alone.
  const fallback: Runner = {
    managed: { async check() { return undefined; }, async drain() { return { drained: true, resources: [] }; } },
    async runJob(job, ctx) {
      return { status: "failed", summary: `loop read host does not serve executor ${job.executor?.id ?? job.kind}`, runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation };
    },
  };
  const runner = createBuiltinExecutorRunner({
    managedProcessOnly: true,
    packages: [{ manifest: githubExecutorPackage, ...githubBinding({ token, ...(github.baseUrl !== undefined ? { baseUrl: github.baseUrl } : {}) }) }],
    fallback,
  });

  const scratch = await mkdtemp(path.join(options.scratchRoot ?? os.tmpdir(), "graphloom-loop-read-"));
  const runId = `loop-${options.loopName}-${options.tickId}`;
  let operations = 0;
  let closed = false;

  /** A token a failing endpoint echoed back never leaves the host. */
  const scrub = (outcome: ReadOutcome): ReadOutcome => {
    const text = JSON.stringify(outcome);
    return text.includes(token) || text.includes(JSON.stringify(token).slice(1, -1))
      ? JSON.parse(text.split(token).join("[redacted]")) as ReadOutcome
      : outcome;
  };

  const run = async (read: LoopRead, signal: AbortSignal): Promise<ReadOutcome> => {
    const version = READS.get(read.executor);
    if (version === undefined) {
      const effect = KNOWN.get(read.executor);
      return failed(effect !== undefined
        ? `executor ${read.executor} has effect ${effect}; loop reads may use read executors only`
        : `executor ${read.executor} is not a read executor this host serves`);
    }
    if (closed) return failed("read host is closed");
    operations += 1;
    let result: JobResult;
    try {
      result = await runner.runJob(
        {
          stageId: "loop-read",
          kind: "command",
          purpose: "check",
          instruction: `loop read ${read.id}`,
          effect: "read",
          readOnly: true,
          executor: { id: read.executor, version },
          input: read.input,
        },
        { runId, operationId: `op-${operations}`, generation: 1, worktreePath: scratch, artifactDir: scratch, signal },
      );
    } catch (err) {
      return failed(`read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      status: result.status,
      summary: result.summary,
      ...(result.evidence !== undefined ? { evidence: result.evidence.map((e) => ({ payload: e.payload })) } : {}),
      ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  };

  return {
    async read(read, signal) {
      if (signal.aborted) return failed("read aborted");
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<ReadOutcome>((resolve) => {
        onAbort = () => resolve(failed("read aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        // The signal is also given to the runner, which terminates the job's executor process, so an aborted read stops and the host stays usable.
        return scrub(await Promise.race([run(read, signal), aborted]));
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    },
    async close() {
      closed = true;
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
