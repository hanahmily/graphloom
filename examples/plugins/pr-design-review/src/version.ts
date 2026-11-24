// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** The graph's identity; the constants the review kit shares are in `kit/constants.ts`. */
export const GRAPH_ID = "pr-design-review";
/**
 * The stage list is fixed per plugin version (design-pr-review-split.md §3.1): 0.1 declares Fetch, Report, Questions,
 * Answers, Round 1 and Publish, round 1 of a pull-request review as its own graph. Round 2 is `pr-review`'s.
 */
export const GRAPH_VERSION = "0.1.6";
