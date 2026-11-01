// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { ExecutorPin } from "@graphloom/sdk";

export const GRAPH_ID = "pr-review";
/**
 * The stage list is fixed per plugin version (design-pr-review-graph.md §5,
 * §18): 0.1 declares Fetch, Report, Questions and Answers. Review, Checks,
 * Draft and Publish arrive with later versions.
 */
export const GRAPH_VERSION = "0.12.0";

/** The operator decision that would continue into the review layer (design §11). */
export const REVIEW_LAYER_APPROVAL = "review-layer";

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
export const RESERVED_CHECKS: readonly string[] = [ENV_WORKTREE, ENV_PLUGIN_ROOT, "docker-go", "docker-typescript"];

/** Command ids the graph owns. */
export const COMMAND = {
  guard: "head-guard",
  checkout: "head-checkout",
  headTree: "head-tree",
  reviewDir: "review-dir",
  ledger: "ledger-read",
  /** The read of the project's design principles file at the profile's ref (design §7.5.1). */
  principles: "principles-read",
  metricsDiff: "metrics-diff",
  reportWrite: "report-write",
  baseDefs: "base-defs",
  baseTree: "base-tree",
  /** The read-only export of the pinned base commit's files into `BASE_DIR`, for the agents that read base files. */
  baseExport: "base-export",
  baseManifests: "base-manifests",
  search: "search",
  candidate: "cand",
  depSites: "dep-sites",
  depSource: "dep-source",
  cite: "cite",
  /** The verification of the necessity answer's citations, apart from the answers' own (`cite-<n>`). */
  citeNecessity: "cite-n",
  /** `base-file-<n>` reads a modified function's file at the base; `static-base-<language>-<n>` measures it. */
  baseFile: "base-file",
  necessityWrite: "necessity-write",
  names: "names",
  qaWrite: "qa-write",
  ledgerPrior: "ledger-prior",
  ledgerWrite: "ledger-write",
  /** The Docker sandbox image checks of Fetch: `sandbox-go`, `sandbox-typescript` (design §12.2). */
  sandboxPrefix: "sandbox-",
  hostGoModcache: "host-go-modcache",
  hostNpmCache: "host-npm-cache",
  /** Where a language's profile-declared read-only mounts are on the host: `host-mounts-go`. */
  hostMountsPrefix: "host-mounts-",
  /** The coverage commands, `cover-go` and `cover-ts-<n>`. */
  coverGo: "cover-go",
  coverTs: "cover-ts",
  /** The architecture diagram's tree check (design §6.10): `arch-check-<n>` resolves cites and paths, and lists Go imports. */
  archCheck: "arch-check",
  /** The check of the architecture claims' quotes against the tree their cite names (design §6.10): `arch-quote-<n>`. */
  archQuote: "arch-quote",
} as const;

/**
 * Part-set bases of the multi-part writes (design §6.6): a part command is `<base>-p<k>`. An artifact that fits one
 * command is written by its single command (`report-write`, `qa-write`, `necessity-write`); one that does not, by a part set.
 */
export const PART_BASE = {
  reportJson: "report-json",
  reviewMd: "review-md",
  reviewHtml: "review-html",
  qaJson: "qa-json",
  qaMd: "review-md-qa",
  qaHtml: "review-html-qa",
  necessityJson: "necessity-json",
  ledgerJson: "ledger-json",
  ledgerMd: "ledger-md",
} as const;

/** The questioner's and the answerer's session keys, so a correction continues the previous session. */
export const QUESTIONER_JOB = "questioner";
export const ANSWERER_JOB = "answerer";

/** The exit status of the ledger write when its compare-and-swap lost the race (design §9.1). */
export const LEDGER_MOVED = 4;

/** Most questions one answerer job answers in large mode (design §7.6); the answerer continues its own session from batch to batch. */
export const QUESTION_BATCH_SIZE = 15;

/** The reporter's session key, so a correction continues the previous session. */
export const REPORTER_JOB = "reporter";

export const REVIEW_DIR = ".graphloom/review";
/** The pinned base commit's files, exported once per run for the answerer, N1 and their checkers (design §7.3); ignored like the rest of `.graphloom/review/`. */
export const BASE_DIR = `${REVIEW_DIR}/base`;
export const REPORT_JSON = `${REVIEW_DIR}/report.json`;
export const REVIEW_MD = `${REVIEW_DIR}/review.md`;
export const REVIEW_HTML = `${REVIEW_DIR}/review.html`;
export const QA_JSON = `${REVIEW_DIR}/qa.json`;
export const NECESSITY_JSON = `${REVIEW_DIR}/necessity.json`;
/** The ledger blobs of a multi-part ledger write, which the `ledger-write` command reads (ignored like the rest of `.graphloom/review/`). */
export const LEDGER_JSON_FILE = `${REVIEW_DIR}/ledger/ledger.json`;
export const LEDGER_MD_FILE = `${REVIEW_DIR}/ledger/ledger.md`;

/** `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`: the per-PR ledger (design §9.1). */
export const ledgerRef = (owner: string, repo: string, n: number): string => `refs/graphloom/pr-review/${owner}/${repo}/${n}/ledger`;
