// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import os from "node:os";
import type { ExecutorPackageManifest } from "@graphloom/sdk";
import { createBuiltinExecutorRunner, createScriptedRunner, type JobResult, type Runner } from "@graphloom/runner";
import { githubBinding, githubExecutorPackage, type GitHubBindingOptions } from "@graphloom/executor-github";

export interface GitHubRunnerOptions extends GitHubBindingOptions {
  fallback?: Runner;
  timeoutMs?: number;
  /** Serve an independently installed copy of the package. */
  manifest?: ExecutorPackageManifest;
}

/** Host wiring for the built-in GitHub package, as an operator composes it. */
export function githubRunner(options: GitHubRunnerOptions = {}): Runner {
  const { fallback, timeoutMs, manifest, ...binding } = options;
  return createBuiltinExecutorRunner({
    packages: [{ manifest: manifest ?? githubExecutorPackage, ...githubBinding(binding) }],
    fallback: fallback ?? createScriptedRunner({ jobs: [] }),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

let opSeq = 0;
export function runGitHub(
  runner: Runner,
  name: string,
  input: unknown,
  opts: { runId?: string; version?: string } = {},
): Promise<JobResult> {
  opSeq += 1;
  return runner.runJob(
    {
      stageId: "select",
      kind: "command",
      purpose: "check",
      instruction: `github ${name}`,
      readOnly: true,
      executor: { id: `graphloom.github/${name}`, version: opts.version ?? "1" },
      input,
    },
    {
      runId: opts.runId ?? "run-1",
      operationId: `op-${opSeq}`,
      generation: 1,
      worktreePath: os.tmpdir(),
      artifactDir: os.tmpdir(),
    },
  );
}

export function githubEvidence(result: JobResult): Record<string, unknown> {
  return (result.evidence?.[0]?.payload as { github: Record<string, unknown> }).github;
}
