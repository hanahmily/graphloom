// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { ExecutorPin } from "@graphloom/sdk";


export const FIX_STAGE = "fix";
export const REVIEW_STAGE = "review";
/** The supervisor-only node that rules on a design conflict (docs/design-issue-fix-graph.md, "Arbitrate"). */
export const ARBITRATE_STAGE = "arbitrate";

export const REQUIREMENT_DECISIONS = "decisions-recorded";
export const REQUIREMENT_REPRODUCES = "reproduces";
export const REQUIREMENT_PASSES = "passes";
export const REQUIREMENT_BUILDS = "builds";
export const REQUIREMENT_SCOPE = "in-scope";
export const REQUIREMENT_CHANGELOG = "changelog-entry";
export const REQUIREMENT_REVIEW = "code-review";
/** Review requirement for the `final` tier commands judged by their own success. */
export const REQUIREMENT_FINAL = "final-checks";
/** Review requirement for the `final` tier commands judged by the hard gates of the benchmark report they write. */
export const REQUIREMENT_BENCH = "bench-gates";
/** Arbitrate's requirement: an independent arbiter, or the operator, ruled on the design point. */
export const REQUIREMENT_RULING = "design-ruling";
/** The operator approval an undecidable or capped design point waits on; its id is the requirement's. */
export const DESIGN_RULING_APPROVAL = "design-ruling";

/** Plan, implement and corrections share this key, so each continues the previous session. */
export const IMPLEMENTER_JOB = "implementer";
/** The arbiter's dispatch key: a fresh session per Arbitrate visit, continued only by its own revision. */
export const ARBITER_JOB = "arbiter";

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_ISSUE: ExecutorPin = { id: "graphloom.github/get-issue", version: "1" };
export const LIST_ISSUE_COMMENTS: ExecutorPin = { id: "graphloom.github/list-issue-comments", version: "1" };
export const GET_FILE: ExecutorPin = { id: "graphloom.github/get-file", version: "1" };

/** Corrections the graph dispatches itself in Fix before it asks the supervisor. */
export const MAX_FIX_CORRECTIONS = 2;
/** Times the graph itself sends a converging review failure back to Fix when the profile does not say (`review.maxReentries`). */
export const DEFAULT_MAX_REVIEW_REENTRIES = 4;
/** Code review passes on one change in one generation; a sweep that reaches it has not saturated. */
export const MAX_SWEEP_PASSES = 4;
/**
 * Review rounds in which the code reviewer may raise new findings. A round is
 * the review of one candidate (one distinct candidate digest); the sweep's
 * passes on that candidate belong to it. From the next round on the reviewer
 * only verifies the findings already raised: a new critical or high comment
 * becomes a non-blocking follow-up for the pull request.
 */
export const MAX_DISCOVERY_ROUNDS = 3;
/** Arbiter rulings per run before every further design conflict goes to the operator (`review.maxRulings`). */
export const DEFAULT_MAX_RULINGS = 3;
/** The arbiter's model and reasoning effort when the profile does not say (`review.arbiter`). */
export const DEFAULT_ARBITER = { model: "gpt-6-astra", effort: "high" } as const;
/** Visits of Arbitrate beyond `review.maxRulings`: points the operator rules on after the cap. */
export const OPERATOR_VISITS = 3;

/**
 * Command ids the graph itself owns. A profile's own commands (GREEN's
 * further checks and the build checks) take any other id.
 */
export const COMMAND = {
  regression: "regression",
  changesDiff: "changes-diff",
  deliver: "deliver",
  /** An arbiter's proof test, run by the profile's regression runner in a checkout with the test added. */
  proof: "proof-test",
  /**
   * A behavioral finding's regression test, run by the profile's regression runner: on the reviewed change with
   * only the test added (it must fail by assertion), then on the fix (it must pass) (test-first.ts).
   */
  findingTest: "finding-test",
} as const;

/** Reproduction jobs per reviewed change before the graph hands an unreproduced finding's missing answer to the supervisor. */
export const MAX_REPRODUCTION_RUNS = 2;
