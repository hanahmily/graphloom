// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { ExecutorPin } from "@graphloom/sdk";

export const GRAPH_ID = "pr-review";
/**
 * The stage list is fixed per plugin version (design-pr-review-graph.md §5,
 * §18): 0.1 declares Fetch, Report, Questions and Answers. Review, Checks,
 * Draft and Publish arrive with later versions.
 */
export const GRAPH_VERSION = "0.1.0";

export const FETCH_STAGE = "fetch";
export const REPORT_STAGE = "report";
export const QUESTIONS_STAGE = "questions";
export const ANSWERS_STAGE = "answers";

export const REQUIREMENT_SNAPSHOT = "pr-snapshot";
export const REQUIREMENT_CHECKED_OUT = "head-checked-out";
export const REQUIREMENT_LEDGER = "prior-ledger";
export const REQUIREMENT_REPORT = "change-report";
export const REQUIREMENT_MEASUREMENTS = "measurements";
export const REQUIREMENT_CLAIMS = "claims-checked";
export const REQUIREMENT_QUESTIONS = "questions-complete";
export const REQUIREMENT_ANSWERS = "answers-complete";
export const REQUIREMENT_GROUNDED = "answers-grounded";

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_PULL: ExecutorPin = { id: "graphloom.github/get-pull", version: "1" };
export const LIST_PULL_FILES: ExecutorPin = { id: "graphloom.github/list-pull-files", version: "1" };
export const LIST_PULL_COMMITS: ExecutorPin = { id: "graphloom.github/list-pull-commits", version: "1" };
export const LIST_PULL_REVIEWS: ExecutorPin = { id: "graphloom.github/list-pull-reviews", version: "1" };
export const LIST_PULL_REVIEW_COMMENTS: ExecutorPin = { id: "graphloom.github/list-pull-review-comments", version: "1" };
export const LIST_REVIEW_THREADS: ExecutorPin = { id: "graphloom.github/list-review-threads", version: "1" };
export const LIST_CHECK_RUNS: ExecutorPin = { id: "graphloom.github/list-check-runs", version: "1" };

/** Deterministic corrections of the reporter's result before the supervisor (design §6.4). */
export const MAX_REPORT_CORRECTIONS = 2;
/** Checker calls that may come back unusable (missing items) before the supervisor. */
export const MAX_CHECK_RETRIES = 2;

/** Environment checks the graph adds to the profile's own: where the worktree and the plugin live. */
export const ENV_WORKTREE = "worktree";
export const ENV_PLUGIN_ROOT = "plugin-root";
export const RESERVED_CHECKS: readonly string[] = [ENV_WORKTREE, ENV_PLUGIN_ROOT];

/** Command ids the graph owns. */
export const COMMAND = {
  guard: "head-guard",
  checkout: "head-checkout",
  headTree: "head-tree",
  reviewDir: "review-dir",
  ledger: "ledger-read",
  metricsDiff: "metrics-diff",
  reportWrite: "report-write",
  baseDefs: "base-defs",
  baseTree: "base-tree",
  baseManifests: "base-manifests",
  search: "search",
  candidate: "cand",
  depSites: "dep-sites",
  depSource: "dep-source",
  cite: "cite",
  names: "names",
  qaWrite: "qa-write",
  ledgerPrior: "ledger-prior",
  ledgerWrite: "ledger-write",
} as const;

/** The questioner's and the answerer's session keys, so a correction continues the previous session. */
export const QUESTIONER_JOB = "questioner";
export const ANSWERER_JOB = "answerer";

/** The exit status of the ledger write when its compare-and-swap lost the race (design §9.1). */
export const LEDGER_MOVED = 4;

/** The reporter's session key, so a correction continues the previous session. */
export const REPORTER_JOB = "reporter";

export const REVIEW_DIR = ".graphloom/review";
export const REPORT_JSON = `${REVIEW_DIR}/report.json`;
export const REVIEW_MD = `${REVIEW_DIR}/review.md`;
export const QA_JSON = `${REVIEW_DIR}/qa.json`;

/** `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`: the per-PR ledger (design §9.1). */
export const ledgerRef = (owner: string, repo: string, n: number): string => `refs/graphloom/pr-review/${owner}/${repo}/${n}/ledger`;
