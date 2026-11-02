// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The validators of the Review and Draft stages. Both pass on the operator's decline of the review layer (the run is
 * report only, as their requirements' statements say); otherwise they judge the review's records, which plugin code wrote
 * from the agent evidence, against the rules a record must keep: the scope and base were recorded with a reason, every
 * rule file is the effective one and covers the scope, every aspect swept at least once with an independent verifier, and
 * every finding was judged. The draft is recomputed from those records and must be what was written.
 */
import type { ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { ASPECTS, ruleFileText, type Aspect } from "./aspects.js";
import { analyze, evidencePull } from "./analysis.js";
import { REVIEW_LAYER_APPROVAL } from "./constants.js";
import { htmlProblems } from "./html.js";
import { pinnedBase } from "./commands.js";
import { parseProfile, ProfileError, reviewerRole, verifierRole, type Profile } from "./profile.js";
import { MAX_SWEEP_PASSES, type AspectRecord } from "./review.js";
import { draftWrites, recordedAspect, recordedRules, recordedScope, writtenDraftFiles } from "./reviewdraft.js";
import { approvalOf, sha256, summaryFor } from "./reviewscope.js";
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

const declined = (input: ValidationInput): boolean => approvalOf(input.evidence, REVIEW_LAYER_APPROVAL)?.decision === "decline";

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
  if (declined(input)) return passed("report only: the operator declined the review layer, so no review was required");
  const scope = recordedScope(input.evidence);
  if (scope.state === "none") return inconclusive("the review has not started: its scope was not recorded");
  if (scope.state === "failed") return failed(scope.reason);
  const s = scope.value;
  if (s.files.length === 0) return failed("the review's scope holds no file");
  if (s.mode === "large" && s.areas.length === 0) return failed("a large pull request's review names no area");
  if (s.context.kind !== "seeded" || s.context.reason.trim() === "") return failed("the reviewers' session start was not recorded with its reason");
  const summary = summaryFor(input.evidence, s.base);
  if (summary.bytes !== s.summary.bytes || sha256(summary.text) !== s.summary.sha256) return failed("the conversation summary the reviewers were seeded with is not what the recorded conversations recompute");
  const problems: string[] = [];
  let firstId = 1;
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
    firstId += r.value.findings.length;
    records.push(r.value);
  }
  if (problems.length > 0) return failed(problems.slice(0, 4).join("; "));
  const findings = records.flatMap((r) => r.findings);
  const count = (state: string): number => findings.filter((f) => f.state === state).length;
  return passed(
    `${s.files.length} file(s) of ${s.source === "whole" ? "the whole pull request" : `${s.areas.map((a) => a.id).join(", ")} (${s.source === "operator" ? "chosen by the operator" : "cited by the briefing's risks, behavior and compatibility entries"})`} were reviewed for correctness, maintainability and security, every reviewer seeded (${s.context.reason}); ${records.map((r) => `${r.aspect}: ${r.passes.length} pass(es)${r.unsaturated ? " (unsaturated)" : ""}`).join(", ")}; ${findings.length} finding(s), each judged by a verifier on another harness than its reviewer's: ${count("confirmed")} confirmed, ${count("disputed")} disputed, ${count("dismissed")} dismissed`,
  );
});

export const draftComposed: Validator = profiled((input, profile) => {
  if (declined(input)) return passed("report only: the operator declined the review layer, so no draft was required");
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
    `the draft was composed from the review's records and the Q&A: ${d.comments.filter((c) => c.kind === "finding").length} finding comment(s), ${d.comments.filter((c) => c.kind === "question").length} question(s) for the author, ${d.judgment.length} entr${d.judgment.length === 1 ? "y" : "ies"} for the maintainer's judgment, ${d.notSelected.length} not selected; recommended verdict ${d.recommended}, drafted as ${d.verdict}${unanchored > 0 ? `; ${unanchored} entr${unanchored === 1 ? "y" : "ies"} outside the diff go in the review body` : ""}; draft.json, draft.md and the report files with the Review section recompute from the evidence; nothing was posted`,
  );
});
