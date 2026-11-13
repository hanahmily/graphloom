// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { ExecutorPin } from "@graphloom/sdk";

export const GRAPH_ID = "pr-review";
/**
 * The stage list is fixed per plugin version (design-pr-review-graph.md §5,
 * §18): 0.1 declares Fetch, Report, Questions and Answers; 0.18 adds Review
 * and Draft; 0.21 adds the round-1 gate (Round 1) and Publish, and removes
 * every human touchpoint. Checks arrive with a later version.
 */
export const GRAPH_VERSION = "0.26.1";

export const FETCH_STAGE = "fetch";
export const REPORT_STAGE = "report";
export const QUESTIONS_STAGE = "questions";
export const ANSWERS_STAGE = "answers";
/** The round-1 gate (design §9.4): the issues of the report and the Q&A, decided by plugin code. */
export const ROUND1_STAGE = "round1";
export const REVIEW_STAGE = "review";
export const DRAFT_STAGE = "draft";
export const PUBLISH_STAGE = "publish";

export const REQUIREMENT_SNAPSHOT = "pr-snapshot";
export const REQUIREMENT_CHECKED_OUT = "head-checked-out";
export const REQUIREMENT_LEDGER = "prior-ledger";
export const REQUIREMENT_REPORT = "change-report";
export const REQUIREMENT_MEASUREMENTS = "measurements";
export const REQUIREMENT_CLAIMS = "claims-checked";
export const REQUIREMENT_QUESTIONS = "questions-complete";
export const REQUIREMENT_ANSWERS = "answers-complete";
export const REQUIREMENT_GROUNDED = "answers-grounded";
export const REQUIREMENT_CODE_REVIEW = "code-review";
export const REQUIREMENT_FINDINGS_PROVEN = "findings-proven";
export const REQUIREMENT_DRAFT = "draft-composed";
export const REQUIREMENT_ROUND1 = "round1-gated";
export const REQUIREMENT_PUBLISHED = "review-published";

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_PULL: ExecutorPin = { id: "graphloom.github/get-pull", version: "1" };
export const LIST_PULL_FILES: ExecutorPin = { id: "graphloom.github/list-pull-files", version: "1" };
export const LIST_PULL_COMMITS: ExecutorPin = { id: "graphloom.github/list-pull-commits", version: "1" };
export const LIST_PULL_REVIEWS: ExecutorPin = { id: "graphloom.github/list-pull-reviews", version: "1" };
export const LIST_PULL_REVIEW_COMMENTS: ExecutorPin = { id: "graphloom.github/list-pull-review-comments", version: "1" };
export const LIST_REVIEW_THREADS: ExecutorPin = { id: "graphloom.github/list-review-threads", version: "1" };
/** The one write the graph makes: a single `COMMENT` review (design §8.5). */
export const CREATE_PULL_REVIEW: ExecutorPin = { id: "graphloom.github/create-pull-review", version: "1" };
/** The login the credential authenticates as: who a review of this graph is authored by. */
export const GET_VIEWER: ExecutorPin = { id: "graphloom.github/get-viewer", version: "1" };
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
  /** The reads of the ledger commit's `qa.json` and `necessity.json` (parts `-<k>`), the head delta and the base delta of incremental round 1 (design §9.2). */
  ledgerPriorQa: "ledger-prior-qa",
  ledgerPriorNecessity: "ledger-prior-nec",
  delta: "ledger-delta",
  deltaBase: "ledger-delta-base",
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
  /** The check of the claims' quotes against the trees their cites name (design §6.9): `tree-quote-<n>`. */
  treeQuote: "tree-quote",
  /** The review layer's scope and base-session record (design §8.1), and the aspects' own (`review-aspect-<aspect>`). */
  reviewScope: "review-scope",
  /** The advance of the ledger ref with the published review's ids (design §9.1), after the review was posted. */
  ledgerPublished: "ledger-published",
} as const;

/**
 * Part-set bases of the multi-part writes (design §6.6): a part command is `<base>-p<k>`. An artifact that fits one
 * command is written by its single command (`report-write`, `qa-write`, `necessity-write`); one that does not, by a part set.
 */
export const PART_BASE = {
  reportJson: "report-json",
  reviewMd: "review-md",
  reviewHtml: "review-html",
  reviewAppendix: "review-appendix-html",
  qaJson: "qa-json",
  qaMd: "review-md-qa",
  qaHtml: "review-html-qa",
  qaAppendix: "review-appendix-html-qa",
  necessityJson: "necessity-json",
  ledgerJson: "ledger-json",
  ledgerMd: "ledger-md",
  /** The patch the Publish stage records in the ledger, as a part set (design §6.6): it can be far past one argument. */
  publishPatch: "publish-patch",
  /** The rule file of an aspect: `review-rules-<aspect>` (design §8.1). */
  reviewRules: "review-rules",
  /** The draft (design §10.1) and the report files rewritten with the Review section. */
  draftJson: "draft-json",
  draftMd: "draft-md",
  finalMd: "review-md-final",
  finalHtml: "review-html-final",
  finalAppendix: "review-appendix-html-final",
} as const;

/** The questioner's and the answerer's session keys, so a correction continues the previous session. */
export const QUESTIONER_JOB = "questioner";
/** The review layer's job keys: `reviewer-<aspect>` and `verifier-<aspect>`. */
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
/** The review layer's files (design §8.1, §10.1): the aspects' rule files, the draft, and the records of the sweep. */
export const REVIEW_RULES_DIR = `${REVIEW_DIR}/rules`;
export const ruleFilePath = (aspect: string): string => `${REVIEW_RULES_DIR}/${aspect}.json`;
export const DRAFT_JSON = `${REVIEW_DIR}/draft.json`;
export const DRAFT_MD = `${REVIEW_DIR}/draft.md`;
export const REVIEW_HTML = `${REVIEW_DIR}/review.html`;
/** The appendix of the HTML report (design §6.11): every change item, the measurements, the whole Q&A. */
export const REVIEW_APPENDIX_HTML = `${REVIEW_DIR}/review-appendix.html`;
export const QA_JSON = `${REVIEW_DIR}/qa.json`;
export const NECESSITY_JSON = `${REVIEW_DIR}/necessity.json`;
/** The ledger blobs of a multi-part ledger write, which the `ledger-write` command reads (ignored like the rest of `.graphloom/review/`). */
export const LEDGER_JSON_FILE = `${REVIEW_DIR}/ledger/ledger.json`;
export const PUBLISH_PATCH_FILE = `${REVIEW_DIR}/ledger/publish-patch.json`;
export const LEDGER_MD_FILE = `${REVIEW_DIR}/ledger/ledger.md`;

/** `refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger`: the per-PR ledger (design §9.1). */
export const ledgerRef = (owner: string, repo: string, n: number): string => `refs/graphloom/pr-review/${owner}/${repo}/${n}/ledger`;
