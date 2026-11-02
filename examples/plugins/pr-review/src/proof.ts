// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Whether a finding is proven (design §8.2): the one place the reproducing tests plug in.
 *
 * Part 1 of the review layer has no reproducing tests, so every behavioral finding is `unproven`, as design §8.2 specifies for
 * a profile with `review.repro.enabled: false`: it is never drafted as P0 or P1, never makes the verdict `request-changes`,
 * and is listed under "Needs your judgment" with its reason. A non-behavioral finding claims no wrong behavior, so it
 * needs no test.
 *
 * Part 2 replaces `proofOf` with a function of the run's `graphloom-repro-v1` command reports (the `findings-proven`
 * recomputation), adds its requirement and validator to the Review stage, and extends `pr-code-review-v1` with `repro` and
 * `pr-finding-verification-v1` with `test`. Nothing else reads a finding's kind to decide where it is drafted: the
 * draft (`draft.ts`) and the report sections ask `proofOf`, and no other module does.
 */
import type { Finding } from "./review.js";

/** Why every behavioral finding of this version is unproven. */
export const NO_REPRO_REASON = "reproducing tests are not available in this version";

export type Proof =
  | { state: "proven"; summary: string }
  | { state: "non-behavioral" }
  | { state: "unproven"; reason: string };

/** The proof of a finding: what the draft labels it with and whether it may be drafted as P0 or P1. */
export function proofOf(f: Pick<Finding, "kind">): Proof {
  if (f.kind === "non-behavioral") return { state: "non-behavioral" };
  return { state: "unproven", reason: NO_REPRO_REASON };
}

/** Whether a finding may be drafted as P0 or P1: only a proven one. A non-behavioral finding is drafted at most as P2 (it claims no wrong behavior). */
export const mayBeBlocking = (f: Pick<Finding, "kind">): boolean => proofOf(f).state === "proven";
