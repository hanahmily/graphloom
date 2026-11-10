// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The validators of the round-1 gate, the Review, Draft and Publish stages. Review and Draft pass when round 1 found issues
 * (the run publishes round 1 and ends, as their requirements' statements say); otherwise they judge the review's records, which plugin code wrote
 * from the agent evidence, against the rules a record must keep: the scope and base were recorded with a reason, every
 * rule file is the effective one and covers the scope, every aspect swept at least once with an independent verifier, and
 * every finding was judged. The draft is recomputed from those records and must be what was written.
 */
import type { ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { ASPECTS, ruleFileText, type Aspect } from "./aspects.js";
import { analyze, evidencePull } from "./analysis.js";
import { htmlProblems } from "./html.js";
import { pinnedBase } from "./commands.js";
import { parseProfile, ProfileError, reviewerRole, verifierRole, type Profile } from "./profile.js";
import { MAX_SWEEP_PASSES, reproRunSeconds, type AspectRecord } from "./review.js";
import { commandRuns } from "./evidence.js";
import { hasTest, judgeRun, reproCommandId, reproSpec } from "./repro.js";
import { reproPlanFor } from "./reproplan.js";
import { FRESH_START_REASON } from "./reviewscope.js";
import { draftWrites, recordedAspect, recordedRound1, recordedRules, recordedScope, round1Computed, writtenDraftFiles } from "./reviewdraft.js";
import { round1Json } from "./round1.js";
import { publishFlow, publishPlan } from "./publish.js";
import { aspectOfItem, registryFromEvidence } from "./prior.js";
import { secretFindings } from "./secrets.js";

const passed = (reason: string): ValidationResult => ({ status: "passed", reason });
const failed = (reason: string): ValidationResult => ({ status: "failed", reason });
const inconclusive = (reason: string): ValidationResult => ({ status: "inconclusive", reason });

function profiled(evaluate: (input: ValidationInput, profile: Profile) => ValidationResult): Validator {
  return {
    evaluate(input) {
      let profile: Profile;
      try {
        profile = parseProfile(input.config);
      } catch (err) {
        if (err instanceof ProfileError) return inconclusive(err.message);
        throw err;
      }
      return evaluate(input, profile);
    },
  };
}

/** Round 1 found issues: the review layer does not run in this run (design §9.4). */
const blocked = (input: ValidationInput): boolean => {
  const r = recordedRound1(input.evidence);
  return r.state === "read" && r.value.issues.length > 0;
};

/** The problems of one aspect's record against the scope and the profile, empty when it keeps every rule. */
function aspectProblems(r: AspectRecord, aspect: Aspect, files: number, reason: string, profile: Profile, firstId: number): string[] {
  const out: string[] = [];
  const at = `${aspect}:`;
  if (r.reviewer !== profile.roles[reviewerRole(aspect)] || r.verifier !== profile.roles[verifierRole(aspect)]) out.push(`${at} the recorded harnesses (${r.reviewer}, ${r.verifier}) are not the profile's`);
  if (r.reviewer === r.verifier) out.push(`${at} the verifier ran on the reviewer's harness (${r.reviewer})`);
  if (r.context.kind !== "seeded" || r.context.reason !== reason) out.push(`${at} the passes were not recorded as seeded with the review's reason`);
  if (r.scopeFiles !== files) out.push(`${at} it reviewed ${r.scopeFiles} files, the scope has ${files}`);
  if (r.passes.length < 1 || r.passes.length > MAX_SWEEP_PASSES) out.push(`${at} ${r.passes.length} passes, not 1 to ${MAX_SWEEP_PASSES}`);
  for (const p of r.passes) if (p.reviewed !== files) out.push(`${at} pass ${p.n} reviewed ${p.reviewed} of ${files} files`);
  r.findings.forEach((f, i) => {
    if (f.id !== `F${firstId + i}`) out.push(`${at} finding ${f.id} is out of order`);
    if (f.state === "pending") out.push(`${at} ${f.id} was never judged`);
    if (f.state === "confirmed" && f.verdict?.verdict !== "confirmed") out.push(`${at} ${f.id} is confirmed without a confirming verdict`);
    if (f.state === "dismissed" && (f.verdict?.verdict !== "refuted" || f.verdict.quotes.length === 0)) out.push(`${at} ${f.id} is dismissed without a refutation that quotes the head`);
    if (f.state === "disputed" && f.notes.length === 0) out.push(`${at} ${f.id} is disputed without a reason`);
  });
  const last = r.passes.at(-1);
  if (last !== undefined) {
    const raised = r.findings.filter((f) => last.raised.includes(f.id));
    const blocking = raised.some((f) => f.state === "confirmed" || f.state === "disputed");
    if (blocking && !r.unsaturated) out.push(`${at} the last pass raised findings that stand, so the sweep is not saturated`);
    if (!blocking && r.unsaturated) out.push(`${at} the sweep is marked unsaturated though the last pass raised nothing that stands`);
    if (r.unsaturated && r.passes.length < MAX_SWEEP_PASSES) out.push(`${at} marked unsaturated after only ${r.passes.length} passes`);
  }
  return out;
}

export const codeReview: Validator = profiled((input, profile) => {
  if (blocked(input)) return passed("round 1 found issues: they are published and round 2 runs on a later head, so no review was required");
  const scope = recordedScope(input.evidence);
  if (scope.state === "none") return inconclusive("the review has not started: its scope was not recorded");
  if (scope.state === "failed") return failed(scope.reason);
  const s = scope.value;
  if (s.files.length === 0) return failed("the review's scope holds no file");
  if (s.mode === "large" && s.areas.length === 0) return failed("a large pull request's review names no area");
  if (s.context.kind !== "seeded" || s.context.reason !== FRESH_START_REASON) return failed("the reviewers' session start was not recorded as a fresh session seeded with review.md only");
  const problems: string[] = [];
  const registry = registryFromEvidence(input.evidence);
  let firstId = registry.nextF;
  const records: AspectRecord[] = [];
  for (const a of ASPECTS) {
    const rules = recordedRules(input.evidence, a, s.files);
    if (rules.state === "none") return inconclusive(`the ${a} rule file was not written`);
    if (rules.state === "failed") return failed(`the ${a} rule file does not cover the scope: ${rules.reason}`);
    if (rules.text !== ruleFileText(a, profile.review.rules[a])) return failed(`the ${a} rule file is not the effective one (the shipped rules with the profile's entries)`);
    const r = recordedAspect(input.evidence, a);
    if (r.state === "none") return inconclusive(`the ${a} review is not finished`);
    if (r.state === "failed") return failed(r.reason);
    problems.push(...aspectProblems(r.value, a, s.files.length, s.context.reason, profile, firstId));
    // Every earlier finding of the aspect that was open is judged on this head, once.
    const owed = registry.items.filter((x) => x.origin === "round2" && x.status === "open" && aspectOfItem(x) === a).map((x) => x.id).sort();
    const judged = (r.value.prior ?? []).map((x) => x.id).sort();
    if (JSON.stringify(owed) !== JSON.stringify(judged)) problems.push(`${a}: the earlier findings ${owed.join(", ") || "(none)"} are open, and the record judges ${judged.join(", ") || "none"}`);
    firstId += r.value.findings.length;
    records.push(r.value);
  }
  if (problems.length > 0) return failed(problems.slice(0, 4).join("; "));
  const findings = records.flatMap((r) => r.findings);
  const count = (state: string): number => findings.filter((f) => f.state === state).length;
  return passed(
    `${s.files.length} file(s) of ${s.source === "whole" ? "the whole pull request" : `${s.areas.map((a) => a.id).join(", ")} (${s.source === "all-areas" ? "every readable area: the briefing cites none" : "cited by the briefing's risks, behavior and compatibility entries"})`} were reviewed for correctness, maintainability and security (${s.context.reason}); ${records.map((r) => `${r.aspect}: ${r.passes.length} pass(es)${r.unsaturated ? " (unsaturated)" : ""}`).join(", ")}; ${findings.length} finding(s), each judged by a verifier on another harness than its reviewer's: ${count("confirmed")} confirmed, ${count("disputed")} disputed, ${count("dismissed")} dismissed`,
  );
});

/**
 * `findings-proven` (design §8.2): every behavioral finding that the record calls proven is recomputed from the evidence: the recorded
 * test text, the command the graph ran for it in the sandbox and the verifier's judgment. The reviewer's claim, and the record's own proof,
 * are never trusted. A behavioral finding with no proof recorded fails: the sweep always records one.
 */
export const findingsProven: Validator = profiled((input, profile) => {
  if (blocked(input)) return passed("round 1 found issues: they are published and round 2 runs on a later head, so no finding was proven or left unproven");
  const problems: string[] = [];
  let proven = 0;
  let unproven = 0;
  let nonBehavioral = 0;
  for (const a of ASPECTS) {
    const r = recordedAspect(input.evidence, a);
    if (r.state === "none") return inconclusive(`the ${a} review is not finished`);
    if (r.state === "failed") return failed(r.reason);
    for (const f of r.value.findings) {
      if (f.kind !== "behavioral") {
        nonBehavioral += 1;
        continue;
      }
      if (f.repro !== undefined && Buffer.byteLength(f.repro.text, "utf8") > profile.review.repro.maxTestBytes) problems.push(`${f.id}: its test is over the ${profile.review.repro.maxTestBytes} bytes a test may be`);
      if (f.proof === undefined) {
        problems.push(`${f.id} is behavioral and records no proof`);
        continue;
      }
      if (f.proof.state !== "proven") {
        unproven += 1;
        if (f.proof.reason.trim() === "") problems.push(`${f.id} is unproven without a reason`);
        continue;
      }
      proven += 1;
      const why = (m: string): number => problems.push(`${f.id} is recorded as proven but ${m}`);
      if (!profile.review.repro.enabled) why("the profile turns reproducing tests off");
      else if (f.state !== "confirmed" || f.verdict?.verdict !== "confirmed") why("its verifier did not confirm it");
      else if (f.verdict.test?.demonstrates !== true) why("its verifier did not judge that the test demonstrates the bug");
      else if (f.repro === undefined || !hasTest(f.repro)) why("it has no test text");
      else {
        const plan = reproPlanFor(input.evidence, profile, f.path);
        if ("reason" in plan) why(`the sandbox could not run its test (${plan.reason})`);
        else {
          const run = commandRuns(input.evidence, reproCommandId(f.id)).at(-1);
          const planned = reproSpec({ finding: f.id, language: plan.language, repro: f.repro, workspace: plan.workspace, timeoutSeconds: reproRunSeconds(profile.review.repro) });
          const again = judgeRun(f, f.repro, plan.language, run, planned, plan.image);
          if (again.state !== "proven") why(`the recorded run of its test does not recompute as a proof (${again.reason})`);
          else if (JSON.stringify(again.record) !== JSON.stringify(f.proof.record)) why("the recorded run does not match what its evidence recomputes");
        }
      }
    }
  }
  if (problems.length > 0) return failed(problems.slice(0, 4).join("; "));
  return passed(`${proven} behavioral finding${proven === 1 ? "" : "s"} proven by a failing test the graph ran (recomputed from the evidence), ${unproven} unproven with a reason, ${nonBehavioral} non-behavioral (no test needed)`);
});

export const draftComposed: Validator = profiled((input, profile) => {
  if (blocked(input)) return passed("round 1 found issues: they are published and round 2 runs on a later head, so no draft was required");
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  const w = draftWrites(input.evidence, a.analysis, pr, pinnedBase(input.evidence));
  if (w.state === "pending") return inconclusive(w.reason);
  if (w.state === "failed") return failed(w.reason);
  const written = writtenDraftFiles(input.evidence);
  const names: Record<keyof typeof written, string> = { draftJson: "draft.json", draftMd: "draft.md", markdown: "review.md with the Review section", html: "review.html with the Review section", appendix: "review-appendix.html with the Review section" };
  for (const key of Object.keys(written) as Array<keyof typeof written>) {
    const f = written[key];
    if (f.state === "none") return inconclusive(`${names[key]} has not been written`);
    if (f.state === "failed") return failed(`${names[key]} was not written whole: ${f.reason}`);
    if (f.value !== w.writes.texts[key]) return failed(`${names[key]} is not what the evidence recomputes from the review's records, report.json and qa.json`);
  }
  const secrets = Object.values(w.writes.texts).flatMap((t) => secretFindings(t));
  if (secrets.length > 0) return failed(`the draft holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  for (const key of ["html", "appendix"] as const) {
    const bad = htmlProblems(w.writes.texts[key], { owner: pr.owner, repo: pr.repo, head: pr.head, base: pinnedBase(input.evidence) });
    if (bad.length > 0) return failed(`${names[key]} is not self-contained and inert: ${bad.slice(0, 3).join("; ")}`);
  }
  const d = w.writes.draft;
  const unanchored = [...d.comments, ...d.judgment].filter((e) => !e.anchored).length;
  return passed(
    `the draft was composed from the review's records and the Q&A: ${d.comments.filter((c) => c.kind === "finding").length} finding comment(s), ${d.comments.filter((c) => c.kind === "question").length} question(s) for the author, ${d.judgment.length} entr${d.judgment.length === 1 ? "y" : "ies"} for the maintainer's judgment, ${d.notSelected.length} not selected; recommended verdict ${d.recommended}, drafted as ${d.verdict}${unanchored > 0 ? `; ${unanchored} entr${unanchored === 1 ? "y" : "ies"} outside the diff go in the review body` : ""}; draft.json, draft.md and the report files with the Review section recompute from the evidence; the Publish stage posts the findings`,
  );
});

export const round1Gated: Validator = profiled((input, profile) => {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  const computed = round1Computed(input.evidence, a.analysis, pr, profile);
  if (computed.state === "pending") return inconclusive(computed.reason);
  const rec = recordedRound1(input.evidence);
  if (rec.state === "none") return inconclusive("round 1 has not been recorded");
  if (rec.state === "failed") return failed(rec.reason);
  if (round1Json(rec.value) !== round1Json(computed.record)) return failed("the recorded round-1 issues are not what necessity.json and qa.json recompute");
  const n = computed.record.issues.length;
  const secrets = secretFindings(round1Json(rec.value));
  if (secrets.length > 0) return failed(`the round-1 record holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  return passed(n === 0 ? `round 1 found no issue (N1: ${computed.record.necessity}): the same run continues into the review layer` : `round 1 found ${n} issue${n === 1 ? "" : "s"} (${computed.record.issues.map((x) => `${x.id}: ${x.kinds.join(", ")}`).join("; ")}): they are published and round 2 runs on a later head`);
});

export const reviewPublished: Validator = profiled((input, profile) => {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  const p = publishPlan(input.evidence, a.analysis, pr, pinnedBase(input.evidence));
  if (p.state === "pending") return inconclusive(p.reason);
  if (p.state === "failed") return failed(p.reason);
  const plan = p.plan;
  if (!plan.body.startsWith(`${plan.firstLine}\n`)) return failed("the review body does not open with its verdict");
  if (plan.verdict === "passed" && (p.round1.issues.length > 0 || plan.open > 0)) return failed("a review with an open item is not a pass");
  if (plan.problem !== undefined) return failed(plan.problem);
  const flow = publishFlow(input.evidence, plan, pr);
  if (flow.state !== "done") return inconclusive(flow.state === "supervise" ? flow.reason : "the review is not posted and recorded in the ledger yet");
  const noId = flow.patch.items.filter((x) => x.inline && x.commentId === null).map((x) => x.id);
  if (noId.length > 0) return failed(`the ledger holds no comment id for the inline item${noId.length === 1 ? "" : "s"} ${noId.join(", ")}`);
  const secrets = secretFindings(plan.body);
  if (secrets.length > 0) return failed(`the posted review holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  return passed(`one COMMENT review (${flow.posted.reviewId}, ${flow.posted.how}) at head ${pr.head.slice(0, 12)}: ${plan.firstLine}; round ${plan.round}, ${plan.items.length} item(s), ${plan.comments.length} inline; its comments were read back and the ledger records the review id and each item's ids`);
});
