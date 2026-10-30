// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { Profile } from "./profile.js";

export interface PullRequest {
  mode: "report";
  owner: string;
  repo: string;
  number: number;
  /** The head commit the run reports on: 40 hex digits. */
  head: string;
  /** The operator asked for every question, whatever N1 concludes (`task new … --all-questions`, design §7.5). */
  askAll?: true;
}

/**
 * The pull request the task's request names (design §3.1): `Report on
 * owner/repo#N at <40-hex>.` with the repository the profile's `project`, or
 * the pull request's URL in place of `owner/repo#N`. Anything else, `Review`
 * mode included, is an incompatible task with the reason returned.
 */
export function requestedPull(request: string, profile: Pick<Profile, "project">): PullRequest | { problem: string } {
  const text = request.trim();
  const m = /^(Report|Review) on (?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)) at ([0-9a-f]{40})(, asking every question)?\.?$/.exec(text);
  if (m === null) {
    return { problem: `the request must be "Report on <owner>/<repo>#<N> at <40-hex head commit>[, asking every question]." (graphloom task new pr-review writes it), got ${JSON.stringify(text.slice(0, 200))}` };
  }
  if (m[1] === "Review") {
    return { problem: 'Review mode continues into the review layer, which this version of pr-review does not have; ask for "Report on …"' };
  }
  const owner = (m[2] ?? m[5])!;
  const repo = (m[3] ?? m[6])!;
  const number = Number((m[4] ?? m[7])!);
  if (`${owner}/${repo}`.toLowerCase() !== profile.project.toLowerCase()) {
    return { problem: `the request names ${owner}/${repo}, but the profile's project is ${profile.project}` };
  }
  if (!Number.isSafeInteger(number) || number < 1) return { problem: `the pull request number ${m[4] ?? m[7]} is not valid` };
  return { mode: "report", owner, repo, number, head: m[8]!, ...(m[9] !== undefined ? { askAll: true as const } : {}) };
}
