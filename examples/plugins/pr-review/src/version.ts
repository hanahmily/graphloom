// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** The graph's identity, which stays in this plugin; the constants the review kit shares are in `kit/constants.ts`. */
export const GRAPH_ID = "pr-review";
/**
 * The stage list is fixed per plugin version (design-pr-review-graph.md §5,
 * §18): 0.1 declares Fetch, Report, Questions and Answers; 0.18 adds Review
 * and Draft; 0.21 adds the round-1 gate (Round 1) and Publish, and removes
 * every human touchpoint. Checks arrive with a later version.
 */
export const GRAPH_VERSION = "0.27.1";
