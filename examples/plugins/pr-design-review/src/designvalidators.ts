// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The validators of the design review's gate and its Publish stage (design-pr-review-split §3.6, §3.7). `round1-gated` recomputes
 * round 1's open items from `necessity.json` and `qa.json` and compares them with the recorded `round1.json`. `review-published`
 * recomputes what this head posts (round 1's open items, nothing when clean, or the profile's note) and that the ledger's design
 * section records the head, its result and any review and comment ids.
 */
import type { ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { analyze, evidencePull } from "./kit/analysis.js";
import { parseProfile, ProfileError, type Profile } from "./kit/profile.js";
import { secretFindings } from "./kit/secrets.js";
import { publishFlow, publishPlan, PASSED_LINE } from "./publish.js";
import { recordedRound1, round1Computed, round1Json } from "./round1.js";

const passed = (reason: string): ValidationResult => ({ status: "passed", reason });
const failed = (reason: string): ValidationResult => ({ status: "failed", reason });
const inconclusive = (reason: string): ValidationResult => ({ status: "inconclusive", reason });

function profiled(evaluate: (input: ValidationInput, profile: Profile) => ValidationResult): Validator {
  return {
    evaluate(input) {
      let profile: Profile;
      try {
        profile = parseProfile(input.config, "pr-design-review");
      } catch (err) {
        if (err instanceof ProfileError) return inconclusive(err.message);
        throw err;
      }
      return evaluate(input, profile);
    },
  };
}

export const round1Gated: Validator = profiled((input, profile) => {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  const computed = round1Computed(input.evidence, a.analysis, pr);
  if (computed.state === "pending") return inconclusive(computed.reason);
  const rec = recordedRound1(input.evidence);
  if (rec.state === "none") return inconclusive("round 1 has not been recorded");
  if (rec.state === "failed") return failed(rec.reason);
  if (round1Json(rec.value) !== round1Json(computed.record)) return failed("the recorded round-1 items are not what necessity.json and qa.json recompute");
  const secrets = secretFindings(round1Json(rec.value));
  if (secrets.length > 0) return failed(`the round-1 record holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  const n = computed.record.issues.length;
  const earlier = computed.record.prior ?? [];
  const judged = earlier.length > 0 ? `; ${earlier.length} earlier item(s) judged by key (${earlier.filter((p) => p.status === "fixed").length} fixed)` : "";
  return passed(n === 0 ? `round 1 has no open item (N1: ${computed.record.necessity})${judged}` : `round 1 has ${n} open item${n === 1 ? "" : "s"} (${computed.record.issues.map((x) => `${x.id}: ${x.kinds.join(", ")}`).join("; ")})${judged}`);
});

export const reviewPublished: Validator = profiled((input, profile) => {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  const p = publishPlan(input.evidence, a.analysis, pr, profile.comments);
  if (p.state === "pending") return inconclusive(p.reason);
  if (p.state === "failed") return failed(p.reason);
  const plan = p.plan;
  if (plan.problem !== undefined) return failed(plan.problem);
  if (plan.post && !plan.body.startsWith(`${plan.firstLine}\n`)) return failed("the review body does not open with its verdict");
  if (!plan.post && (plan.open > 0 || p.round1.issues.length > 0)) return failed("round 1 has open items, but nothing is posted");
  if (plan.note && (plan.open > 0 || plan.firstLine !== PASSED_LINE || plan.items.length > 0)) return failed("the design-review-passed note is posted only for a clean round 1, with no item");
  if (plan.post && !plan.note && plan.open === 0) return failed("a clean round 1 posts nothing unless the profile asks for the note");
  const flow = publishFlow(input.evidence, plan, pr);
  if (flow.state !== "done") return inconclusive(flow.state === "supervise" ? flow.reason : plan.post ? "the review is not posted and recorded in the ledger yet" : "this head is not recorded in the ledger's design section yet");
  const noId = flow.patch.items.filter((x) => x.inline && x.commentId === null).map((x) => x.id);
  if (noId.length > 0) return failed(`the ledger holds no comment id for the inline item${noId.length === 1 ? "" : "s"} ${noId.join(", ")}`);
  const secrets = secretFindings(plan.body);
  if (secrets.length > 0) return failed(`the posted review holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  if (flow.posted === undefined) return passed(`round 1 is clean at head ${pr.head.slice(0, 12)}: nothing is posted, and the ledger's design section records the head as clean`);
  return passed(`one COMMENT review (${flow.posted.reviewId}, ${flow.posted.how}) at head ${pr.head.slice(0, 12)}: ${plan.firstLine}; ${plan.items.length} item(s), ${plan.comments.length} inline; its comments were read back and the ledger's design section records the review id and each item's ids`);
});
