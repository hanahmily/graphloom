// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { PrepareTaskInput, PrepareTaskReply } from "@graphloom/sdk";
import { GRAPH_ID } from "./version.js";
import { pullTaskPlan, type PullTaskSpec } from "./kit/taskplan.js";

export { parsePullArgument } from "./kit/taskplan.js";

const USAGE = "graphloom task new pr-design-review <owner/repo#N | https://github.com/owner/repo/pull/N> --profile <name|path> [--base <branch>] [--all-questions] [--repo <clone>]";

const ALL = "--all-questions";

const SPEC: PullTaskSpec = {
  graphId: GRAPH_ID,
  profileGraph: "pr-design-review",
  usage: USAGE,
  flags: [ALL],
  refused: {
    "--no-report": "it is pr-review's (graphloom task new pr-review … --no-report): the design review is the report and its questions",
    "--review": "a design review is round 1 only; run graphloom task new pr-review … for the PR review",
  },
  // A task directory holds one task.yaml and one profile.json link, so the design review's has its own (design-pr-review-split §7.1).
  taskPath: ({ repo, number }) => `reviews/${repo}-${number}-design/task.yaml`,
  request: ({ owner, repo, number }, set) => `Design review on ${owner}/${repo}#${number} at \${headSha}${set.has(ALL) ? ", asking every question" : ""}.`,
  summary: ({ owner, repo, number }, base, set) => `design review of ${owner}/${repo}#${number} against ${base}${set.has(ALL) ? ", asking every question even if the change is judged unnecessary" : ""}`,
};

/**
 * `graphloom task new pr-design-review …` (design-pr-review-split §7.1): the plan that fetches the pull request's head and its
 * base branch into this graph's own ref namespace (`refs/graphloom/pr-design-review/<owner>/<repo>/<N>/`), pins the head by sha,
 * and writes the task. Pure over its input: it reads no file, runs no process and has no network; the CLI validates and runs it.
 */
export function prepareTask(input: PrepareTaskInput): PrepareTaskReply {
  return pullTaskPlan(input, SPEC);
}
