// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { Profile, ProfileGraph } from "./profile.js";

export interface PullRequest {
  /** The request's prefix: `review` for both graphs since the split (pr-review 1.x refuses the 0.x `Report on …` form). */
  mode: "report" | "review";
  owner: string;
  repo: string;
  number: number;
  /** The head commit the run reports on: 40 hex digits. */
  head: string;
  /** The operator asked for every question, whatever N1 concludes (`task new … --all-questions`, design §7.5). */
  askAll?: true;
  /** The operator asked pr-review for no report-only prelude (`task new pr-review … --no-report`, design-pr-review-split §4.2, §7.1). */
  noReport?: true;
}

/** The request suffix of `--no-report` (design-pr-review-split §7.1): the validators read it from the task's pinned request (§10). */
export const NO_REPORT_SUFFIX = ", without a report";

/** Whether a pinned request carries the `--no-report` suffix: what pr-review's validators read from `ValidationInput.request`. */
export const requestsNoReport = (request: string | undefined): boolean => request !== undefined && /, without a report\.?$/.test(request.trim());

/**
 * The pull request the task's request names (design-pr-review-split §7.1): for pr-review 1.x, `Review on <owner>/<repo>#<N> at
 * <40-hex>[, without a report].`, with the repository the profile's `project`, or the pull request's URL in place of `owner/repo#N`
 * (the request `graphloom task new pr-review` writes). The 0.x `Report on …` form and `, asking every question` are refused, naming
 * pr-design-review, which runs round 1 now. Anything else is an incompatible task with the reason returned.
 */
export function requestedPull(request: string, profile: Pick<Profile, "project">, graph: ProfileGraph = "pr-review"): PullRequest | { problem: string } {
  const text = request.trim();
  if (graph === "pr-design-review") return designRequest(text, profile);
  if (/^Report on /.test(text)) {
    return { problem: `a "Report on …" request is the two-round pr-review of 0.x; pr-review 1.x is round 2 only (the PR review) and round 1 is pr-design-review: write the task again with graphloom task new pr-review … (or graphloom task new pr-design-review … for the design review)` };
  }
  if (/, asking every question\.?$/.test(text)) {
    return { problem: `"asking every question" is the design review's (graphloom task new pr-design-review … --all-questions); pr-review 1.x asks no question` };
  }
  const m = /^Review on (?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)) at ([0-9a-f]{40})(, without a report)?\.?$/.exec(text);
  if (m === null) {
    return { problem: `the request must be "Review on <owner>/<repo>#<N> at <40-hex head commit>[, without a report]." (graphloom task new pr-review writes it), got ${JSON.stringify(text.slice(0, 200))}` };
  }
  const owner = (m[1] ?? m[4])!;
  const repo = (m[2] ?? m[5])!;
  const number = Number((m[3] ?? m[6])!);
  if (`${owner}/${repo}`.toLowerCase() !== profile.project.toLowerCase()) {
    return { problem: `the request names ${owner}/${repo}, but the profile's project is ${profile.project}` };
  }
  if (!Number.isSafeInteger(number) || number < 1) return { problem: `the pull request number ${m[3] ?? m[6]} is not valid` };
  return { mode: "review", owner, repo, number, head: m[7]!, ...(m[8] !== undefined ? { noReport: true as const } : {}) };
}

/**
 * The design review's request (design-pr-review-split §7.1): `Design review on <owner>/<repo>#<N> at <40-hex>[, asking every
 * question].`, or the pull request's URL in place of `owner/repo#N`, as `graphloom task new pr-design-review` writes it.
 */
function designRequest(text: string, profile: Pick<Profile, "project">): PullRequest | { problem: string } {
  const m = /^Design review on (?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)) at ([0-9a-f]{40})(, asking every question)?\.?$/.exec(text);
  if (m === null) {
    return { problem: `the request must be "Design review on <owner>/<repo>#<N> at <40-hex head commit>[, asking every question]." (graphloom task new pr-design-review writes it), got ${JSON.stringify(text.slice(0, 200))}` };
  }
  const owner = (m[1] ?? m[4])!;
  const repo = (m[2] ?? m[5])!;
  const number = Number((m[3] ?? m[6])!);
  if (`${owner}/${repo}`.toLowerCase() !== profile.project.toLowerCase()) {
    return { problem: `the request names ${owner}/${repo}, but the profile's project is ${profile.project}` };
  }
  if (!Number.isSafeInteger(number) || number < 1) return { problem: `the pull request number ${m[3] ?? m[6]} is not valid` };
  return { mode: "review", owner, repo, number, head: m[7]!, ...(m[8] !== undefined ? { askAll: true as const } : {}) };
}
