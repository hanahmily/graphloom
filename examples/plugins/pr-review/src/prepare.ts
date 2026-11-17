// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { PrepareTaskInput, PrepareTaskReply } from "@graphloom/sdk";
import { GRAPH_ID } from "./version.js";
import { pullTaskPlan, type PullTaskSpec } from "./kit/taskplan.js";

export { parsePullArgument } from "./kit/taskplan.js";

const USAGE = "graphloom task new pr-review <owner/repo#N | https://github.com/owner/repo/pull/N> --profile <name|path> [--base <branch>] [--all-questions] [--repo <clone>]";

const ALL = "--all-questions";

const SPEC: PullTaskSpec = {
  graphId: GRAPH_ID,
  profileGraph: "pr-review",
  usage: USAGE,
  flags: [ALL],
  // Accepted and ignored since 0.21: every run reviews its head (design §2); earlier invocations keep working.
  ignored: ["--review"],
  taskPath: ({ repo, number }) => `reviews/${repo}-${number}/task.yaml`,
  request: ({ owner, repo, number }, set) => `Review on ${owner}/${repo}#${number} at \${headSha}${set.has(ALL) ? ", asking every question" : ""}.`,
  summary: ({ owner, repo, number }, base, set) => `review of ${owner}/${repo}#${number} against ${base}${set.has(ALL) ? ", asking every question even if the change is judged unnecessary" : ""}`,
};

/**
 * `graphloom task new pr-review …` (design §3.1): the plan that fetches the
 * pull request's head and its base branch into the graph's own ref namespace,
 * pins the head by sha, and writes the task. Pure over its input: it reads no
 * file, runs no process and has no network; the CLI validates and runs the plan.
 */
export function prepareTask(input: PrepareTaskInput): PrepareTaskReply {
  return pullTaskPlan(input, SPEC);
}
