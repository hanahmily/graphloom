import type { ExecutorPin } from "@graphloom/sdk";

export const FIX_STAGE = "fix";
export const REVIEW_STAGE = "review";

export const REQUIREMENT_DECISIONS = "decisions-recorded";
export const REQUIREMENT_REPRODUCES = "reproduces";
export const REQUIREMENT_PASSES = "passes";
export const REQUIREMENT_BUILDS = "builds";
export const REQUIREMENT_SCOPE = "in-scope";
export const REQUIREMENT_CHANGELOG = "changelog-entry";
export const REQUIREMENT_REVIEW = "code-review";

/** Plan, implement and corrections share this key, so each continues the previous session. */
export const IMPLEMENTER_JOB = "implementer";

export const CODING_AGENT: ExecutorPin = { id: "graphloom.coding-agent/run", version: "1" };
export const GET_ISSUE: ExecutorPin = { id: "graphloom.github/get-issue", version: "1" };
export const LIST_ISSUE_COMMENTS: ExecutorPin = { id: "graphloom.github/list-issue-comments", version: "1" };

/** Corrections the graph dispatches itself in Fix before it asks the supervisor. */
export const MAX_FIX_CORRECTIONS = 2;
/** Code review passes on one change in one generation; a sweep that reaches it has not saturated. */
export const MAX_SWEEP_PASSES = 4;

/**
 * Command ids the graph itself owns. A profile's own commands (GREEN's
 * further checks and the build checks) take any other id.
 */
export const COMMAND = {
  regression: "regression",
  changesDiff: "changes-diff",
  deliver: "deliver",
} as const;
