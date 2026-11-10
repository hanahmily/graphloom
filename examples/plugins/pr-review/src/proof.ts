// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Whether a finding is proven (design §8.2): the one place the draft, the reports and the verdict ask. A behavioral finding is
 * `proven` only when the graph ran its test and the recorded run met every condition of §8.2 (`judgeRun`, `settledProof`
 * in `review.ts`: the named test built and failed in both runs, each failure attributable to the cited behavior, the test text
 * that was run is the text the verifier judged, and the verifier confirmed the finding and judged the test demonstrates it). Anything
 * else is `unproven` with the reason the proof carries (`no test`, `test does not fail`, `inconclusive (<kind>)`, `flaky`,
 * `does not demonstrate`, `sandbox unavailable`, `execution disabled by the profile`, `repro budget exhausted`): it is never drafted as P0 or P1,
 * never makes the verdict `request-changes`, and is listed under "Needs your judgment". A non-behavioral finding claims no wrong
 * behavior, so it needs no test and is drafted at most as P2.
 *
 * `proofOf` reads the proof recorded in the aspect record, computed by the sweep from the evidence; the `findings-proven`
 * validator recomputes it from the evidence again and never trusts the record. Nothing else reads a finding's kind to decide where it is
 * drafted: the draft (`draft.ts`) and the report sections ask `proofOf`, and no other module does.
 */
import type { Finding } from "./review.js";

export type Proof =
  | { state: "proven"; summary: string }
  | { state: "non-behavioral" }
  | { state: "unproven"; reason: string };

/** The proof of a finding: what the draft labels it with and whether it may be drafted as P0 or P1. */
export function proofOf(f: Pick<Finding, "kind"> & { proof?: Finding["proof"] }): Proof {
  if (f.kind === "non-behavioral") return { state: "non-behavioral" };
  if (f.proof?.state === "proven") return { state: "proven", summary: `proven by a failing test the graph ran${f.proof.record.name !== "" ? ` (${f.proof.record.name})` : ""}` };
  return { state: "unproven", reason: f.proof?.state === "unproven" ? f.proof.reason : "no test" };
}

/** Whether a finding may be drafted as P0 or P1: only a proven one. A non-behavioral finding is drafted at most as P2 (it claims no wrong behavior). */
export const mayBeBlocking = (f: Pick<Finding, "kind"> & { proof?: Finding["proof"] }): boolean => proofOf(f).state === "proven";
