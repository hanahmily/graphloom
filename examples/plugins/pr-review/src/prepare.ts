// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { PrepareTaskInput, PrepareTaskReply } from "@graphloom/sdk";
import { GRAPH_ID } from "./version.js";
import { pullTaskPlan, type PullTaskSpec } from "./kit/taskplan.js";
import { NO_REPORT_SUFFIX } from "./kit/request.js";

export { parsePullArgument } from "./kit/taskplan.js";

const USAGE = "graphloom task new pr-review <owner/repo#N | https://github.com/owner/repo/pull/N> --profile <name|path> [--base <branch>] [--no-report] [--repo <clone>]";

/** `--no-report` (design-pr-review-split §7.1): no report-only prelude; the request carries the suffix the validators read. */
const NO_REPORT = "--no-report";

const SPEC: PullTaskSpec = {
  graphId: GRAPH_ID,
  profileGraph: "pr-review",
  usage: USAGE,
  flags: [NO_REPORT],
  // Accepted and ignored since 0.21: every run reviews its head (design §2); earlier invocations keep working.
  ignored: ["--review"],
  refused: {
    "--all-questions": "it is the design review's (graphloom task new pr-design-review … --all-questions): pr-review 1.x asks no question",
  },
  taskPath: ({ repo, number }) => `reviews/${repo}-${number}/task.yaml`,
  request: ({ owner, repo, number }, set) => `Review on ${owner}/${repo}#${number} at \${headSha}${set.has(NO_REPORT) ? NO_REPORT_SUFFIX : ""}.`,
  summary: ({ owner, repo, number }, base, set) => `review of ${owner}/${repo}#${number} against ${base}${set.has(NO_REPORT) ? ", without a report (no report-only prelude)" : ""}`,
};

/**
 * `graphloom task new pr-review … [--no-report]` (design §3.1, design-pr-review-split §7.1): the plan that fetches the
 * pull request's head and its base branch into the graph's own ref namespace,
 * pins the head by sha, and writes the task. Pure over its input: it reads no
 * file, runs no process and has no network; the CLI validates and runs the plan.
 */
export function prepareTask(input: PrepareTaskInput): PrepareTaskReply {
  return pullTaskPlan(input, SPEC);
}
