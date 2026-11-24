// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** The graph's identity, which stays in this plugin; the constants the review kit shares are in `kit/constants.ts`. */
export const GRAPH_ID = "pr-review";
/**
 * The stage list is fixed per plugin version (design-pr-review-graph.md §5,
 * §18): 0.1 declares Fetch, Report, Questions and Answers; 0.18 adds Review
 * and Draft; 0.21 adds the round-1 gate (Round 1) and Publish, and removes
 * every human touchpoint. 1.0 is round 2 only (design-pr-review-split §4):
 * Fetch, Report, Review, Draft and Publish; round 1 is pr-design-review.
 * Checks arrive with a later version.
 */
export const GRAPH_VERSION = "1.1.5";
