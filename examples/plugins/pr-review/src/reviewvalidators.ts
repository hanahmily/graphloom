// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The validators of the Review, Draft and Publish stages (design §8; design-pr-review-split §4.1). They judge the review's records,
 * which plugin code wrote from the agent evidence, against the rules a record must keep: the scope was recorded with its reason and
 * the context source `context.json` names, every rule file is the effective one and covers the scope, every aspect swept at least
 * once with an independent verifier, every finding was judged, and every lead recomputes and has its status. The draft, the review
 * section's write and the posted review are recomputed from those records and must be what was written.
 */
import type { ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { ASPECTS, ruleFileText, type Aspect } from "./kit/aspects.js";
import { analyze, evidencePull, type Analysis } from "./kit/analysis.js";
import { htmlProblems } from "./html.js";
import { pinnedBase } from "./kit/commands.js";
import { COMMAND, LEDGER_DESIGN_JSON_FILE, LEDGER_DESIGN_MD_FILE, LEDGER_JSON_FILE, LEDGER_MD_FILE, PART_BASE } from "./kit/constants.js";
import { groundworkState } from "./kit/groundwork.js";
import { parseSectionRecord, writtenReviewLedger } from "./kit/ledger.js";
import { migratedTrees } from "./kit/ledgerv2.js";
import { measurementState, type MeasurementState } from "./kit/measurements.js";
import { readParts, sha256 } from "./kit/parts.js";
import { parseProfile, ProfileError, reviewerRole, verifierRole, type Profile } from "./kit/profile.js";
import type { PullRequest } from "./kit/request.js";
import { MAX_SWEEP_PASSES, reproRunOf, type AspectRecord } from "./review.js";
import { commandRuns, reportText, succeeded } from "./kit/evidence.js";
import { hasTest, judgeRun, reproCommandId, reproSpec } from "./repro.js";
import { reproPlanFor } from "./reproplan.js";
import { FRESH_START_REASON } from "./reviewscope.js";
import { draftWrites, recordedAspect, recordedRules, recordedScope, writtenDraftFiles } from "./reviewdraft.js";
import { priorityMismatch } from "./draft.js";
import { ledgerPriorityMismatch, publishFlow, publishPlan } from "./publish.js";
import { aspectOfItem, registryFromEvidence } from "./prior.js";
import { secretFindings } from "./kit/secrets.js";
import { computeLeads, fixedP0Lead, NOT_GIVEN, type Lead, type LeadRecord } from "./leads.js";
import { contextLine, type ContextRecord } from "./context.js";
import { contextReport, groundworkOptions, leadInputOf, priorRead, recordedContext } from "./runcontext.js";
import { reviewLedgerWrite } from "./reviewledger.js";

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

type Run = { analysis: Analysis; pr: PullRequest; context: ContextRecord; m: MeasurementState };

/** The snapshot, the recorded context and the measurements, or why a requirement cannot be judged yet. */
function runOf(input: ValidationInput, profile: Profile): Run | ValidationResult {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  const c = recordedContext(input.evidence);
  if (c.state === "none") return inconclusive("context.json has not been written");
  if (c.state === "failed") return failed(c.reason);
  const m = measurementState(input.evidence, a.analysis.snapshot.files, profile);
  if (m.state !== "ready" && m.state !== "none") return inconclusive(`the measurements are not complete (${m.state})`);
  return { analysis: a.analysis, pr, context: c.value, m };
}
const isResult = (r: Run | ValidationResult): r is ValidationResult => "status" in r;

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
  const run = runOf(input, profile);
  if (isResult(run)) return run;
  const scope = recordedScope(input.evidence);
  if (scope.state === "none") return inconclusive("the review has not started: its scope was not recorded");
  if (scope.state === "failed") return failed(scope.reason);
  const s = scope.value;
  if (s.files.length === 0) return failed("the review's scope holds no file");
  if (s.mode === "large" && s.areas.length === 0) return failed("a large pull request's review names no area");
  if (s.context.kind !== "seeded" || s.context.reason !== FRESH_START_REASON) return failed("the reviewers' session start was not recorded as a fresh session seeded with review.md only");
  if (s.contextSource !== run.context.source) return failed(`the review-scope record names the context source ${s.contextSource}, and context.json says ${run.context.source}`);
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
    `${s.files.length} file(s) of ${s.source === "whole" ? "the whole pull request" : `${s.areas.map((a) => a.id).join(", ")} (${s.source === "all-areas" ? "every readable area: the context's report cites none, or there is none" : "cited by the context report's risks, behavior and compatibility entries"})`} were reviewed for correctness, maintainability and security from ${contextLine(run.context, run.pr.head)} (${s.context.reason}); ${records.map((r) => `${r.aspect}: ${r.passes.length} pass(es)${r.unsaturated ? " (unsaturated)" : ""}`).join(", ")}; ${findings.length} finding(s), each judged by a verifier on another harness than its reviewer's: ${count("confirmed")} confirmed, ${count("disputed")} disputed, ${count("dismissed")} dismissed`,
  );
});

/** The leads of the review's scope recomputed from the evidence (design-pr-review-split §4.3), or why they cannot be yet. */
function recomputedLeads(input: ValidationInput, profile: Profile, run: Run): Lead[] | ValidationResult {
  const scope = recordedScope(input.evidence);
  if (scope.state === "none") return inconclusive("the review's scope was not recorded");
  if (scope.state === "failed") return failed(scope.reason);
  const base = pinnedBase(input.evidence);
  if (base === undefined) return inconclusive("the pinned base is not recorded");
  const g = groundworkState(groundworkOptions(input.evidence, run.analysis, profile, base));
  if (g.state === "incompatible") return failed(g.problem);
  if (g.state === "failed") return failed(`the groundwork could not be read: ${g.problems.slice(0, 2).join("; ")}`);
  if (g.state !== "ready") return inconclusive(`the groundwork is not complete (${g.state})`);
  const report = contextReport(input.evidence, run.pr, run.analysis, run.context, run.m, profile);
  if ("pending" in report) return inconclusive(report.pending);
  return computeLeads(leadInputOf(run.analysis, profile, scope.value.files, report, run.m, g.groundwork));
}

const leadKey = (l: Lead): string => JSON.stringify([l.id, l.kind, l.path, l.line, l.endLine, l.subject, l.facts, l.given]);

/** `leads-judged` (design-pr-review-split §4.3): the leads recompute, and every given lead has exactly one status from the maintainability reviewer. */
export const leadsJudged: Validator = profiled((input, profile) => {
  const run = runOf(input, profile);
  if (isResult(run)) return run;
  const leads = recomputedLeads(input, profile, run);
  if (!Array.isArray(leads)) return leads;
  const problems: string[] = [];
  let record: AspectRecord | undefined;
  for (const a of ASPECTS) {
    const r = recordedAspect(input.evidence, a);
    if (r.state === "none") return inconclusive(`the ${a} review is not finished`);
    if (r.state === "failed") return failed(r.reason);
    if (a === "maintainability") record = r.value;
    else if (r.value.leads.length > 0) problems.push(`the ${a} record holds leads: only maintainability is given leads`);
  }
  const recorded = record!.leads;
  if (recorded.length !== leads.length || recorded.some((l, i) => leadKey(l) !== leadKey(leads[i]!))) problems.push(`the recorded leads (${recorded.length}) are not the ${leads.length} the measurements, the test map and the searches recompute`);
  const findings = new Set(record!.findings.map((f) => f.id));
  for (const l of recorded) {
    if (!l.given) {
      if (l.status !== NOT_GIVEN) problems.push(`${l.id} was not given, and records the status ${l.status}`);
      continue;
    }
    if (l.status === "raised") {
      if (l.finding === undefined) problems.push(`${l.id} is raised without the comment it raised`);
      else if (/^F\d+$/.test(l.finding) && !findings.has(l.finding)) problems.push(`${l.id} names ${l.finding}, which the maintainability sweep did not raise`);
    } else if (l.status === "not-an-issue") {
      if ((l.reason ?? "").trim() === "") problems.push(`${l.id} is not an issue without a reason`);
    } else problems.push(`${l.id} was given and has no status`);
  }
  if (problems.length > 0) return failed(problems.slice(0, 4).join("; "));
  const given = recorded.filter((l) => l.given);
  const raised = given.filter((l) => l.status === "raised").length;
  return passed(`${leads.length} lead(s) recompute from the measurement records, the test map and the searches (${[...new Set(leads.map((l) => l.kind))].join(", ") || "none"}); ${given.length} were given to the maintainability reviewer, each with exactly one status: ${raised} raised, ${given.length - raised} not an issue with a reason${leads.length > given.length ? `; ${leads.length - given.length} not given (over the bound)` : ""}`);
});

/**
 * `findings-proven` (design §8.2; design-pr-review-split §4.3): every behavioral finding that the record calls proven is recomputed from
 * the evidence: the recorded test text, the command the graph ran for it in the sandbox and the verifier's judgment. A finding raised
 * from an `untested-feature` lead (drafted at P1) or a `weak-test`, `split-function`, `crap` or `reuse` lead (drafted at P0) is proven
 * by its lead: a given lead of that kind that recomputes from the measurement records, the test map and the searches, recorded as
 * raised by this finding.
 */
export const findingsProven: Validator = profiled((input, profile) => {
  const run = runOf(input, profile);
  if (isResult(run)) return run;
  const problems: string[] = [];
  let proven = 0;
  let unproven = 0;
  let nonBehavioral = 0;
  let untested = 0;
  let fixedP0 = 0;
  let leads: Lead[] | undefined;
  const records: AspectRecord[] = [];
  for (const a of ASPECTS) {
    const r = recordedAspect(input.evidence, a);
    if (r.state === "none") return inconclusive(`the ${a} review is not finished`);
    if (r.state === "failed") return failed(r.reason);
    records.push(r.value);
  }
  const statuses: LeadRecord[] = records.flatMap((r) => r.leads);
  for (const r of records) {
    for (const f of r.findings) {
      if (f.leadKind === "untested-feature" || fixedP0Lead(f.leadKind)) {
        leads ??= (() => {
          const l = recomputedLeads(input, profile, run);
          return Array.isArray(l) ? l : [];
        })();
        const lead = leads.find((l) => l.id === f.lead && l.kind === f.leadKind && l.given);
        const status = statuses.find((l) => l.id === f.lead);
        if (lead === undefined) problems.push(`${f.id} is raised from the ${f.leadKind} lead ${f.lead ?? "?"}, which does not recompute from the measurement records, the test map and the searches`);
        else if (status?.status !== "raised" || status.finding !== f.id) problems.push(`${f.id} names the ${f.leadKind} lead ${f.lead}, which the record does not show raised by it`);
        else if (f.leadKind === "untested-feature") untested += 1;
        else fixedP0 += 1;
      }
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
          const ran = commandRuns(input.evidence, reproCommandId(f.id)).at(-1);
          const planned = reproSpec(reproRunOf(f.id, plan, f.repro, profile.review.repro));
          const again = judgeRun(f, f.repro, plan.language, ran, planned, plan.image);
          if (again.state !== "proven") why(`the recorded run of its test does not recompute as a proof (${again.reason})`);
          else if (JSON.stringify(again.record) !== JSON.stringify(f.proof.record)) why("the recorded run does not match what its evidence recomputes");
        }
      }
    }
  }
  if (problems.length > 0) return failed(problems.slice(0, 4).join("; "));
  return passed(`${proven} behavioral finding${proven === 1 ? "" : "s"} proven by a failing test the graph ran (recomputed from the evidence), ${unproven} unproven with a reason, ${nonBehavioral} non-behavioral (no test needed)${untested > 0 ? `; ${untested} raised from an untested-feature lead, whose test map and coverage recompute` : ""}${fixedP0 > 0 ? `; ${fixedP0} raised from a weak-test, split-function, crap or reuse lead (drafted at P0), whose lead recomputes` : ""}`);
});

export const draftComposed: Validator = profiled((input, profile) => {
  const run = runOf(input, profile);
  if (isResult(run)) return run;
  const { pr } = run;
  const w = draftWrites(input.evidence, run.analysis, pr, pinnedBase(input.evidence), run.context, run.m, profile);
  if (w.state === "pending") return inconclusive(w.reason);
  if (w.state === "failed") return failed(w.reason);
  const written = writtenDraftFiles(input.evidence);
  const names: Record<keyof typeof written, string> = { draftJson: "draft.json", draftMd: "draft.md", markdown: "review.md with the Review section", html: "review.html with the Review section", appendix: "review-appendix.html with the Review section" };
  // A finding has one priority wherever it is shown: the final one the draft rules give it, recomputed here (design §8.4).
  if (written.draftJson.state === "read") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(written.draftJson.value);
    } catch {
      parsed = undefined;
    }
    const wrong = priorityMismatch(parsed, w.writes.draft);
    if (wrong !== undefined) return failed(`draft.json holds a priority the draft rules do not give: ${wrong}`);
  }
  for (const key of Object.keys(written) as Array<keyof typeof written>) {
    const f = written[key];
    const want = w.writes.texts[key];
    if (want === undefined) {
      if (f.state !== "none") return failed(`${names[key]} is written, but there is no report to render (the context is none)`);
      continue;
    }
    if (f.state === "none") return inconclusive(`${names[key]} has not been written`);
    if (f.state === "failed") return failed(`${names[key]} was not written whole: ${f.reason}`);
    if (f.value !== want) return failed(`${names[key]} is not what the evidence recomputes from the review's records and the context`);
  }
  const secrets = Object.values(w.writes.texts).flatMap((t) => (t === undefined ? [] : secretFindings(t)));
  if (secrets.length > 0) return failed(`the draft holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  const also = run.context.head !== undefined ? [run.context.head, ...(run.context.base !== undefined ? [run.context.base] : [])] : [];
  for (const key of ["html", "appendix"] as const) {
    const text = w.writes.texts[key];
    if (text === undefined) continue;
    const bad = htmlProblems(text, { owner: pr.owner, repo: pr.repo, head: pr.head, base: pinnedBase(input.evidence), also });
    if (bad.length > 0) return failed(`${names[key]} is not self-contained and inert: ${bad.slice(0, 3).join("; ")}`);
  }
  const d = w.writes.draft;
  const unanchored = [...d.comments, ...d.judgment].filter((e) => !e.anchored).length;
  return passed(
    `the draft was composed from the review's records: ${d.comments.length} finding comment(s), ${d.judgment.length} entr${d.judgment.length === 1 ? "y" : "ies"} for the maintainer's judgment, no Q&A item; round 1: ${d.round1 === null ? "not run on this pull request" : `${d.round1.open.length} open item(s) as of ${d.round1.head.slice(0, 7)}`}; recommended verdict ${d.recommended}, drafted as ${d.verdict}${unanchored > 0 ? `; ${unanchored} entr${unanchored === 1 ? "y" : "ies"} outside the diff go in the review body` : ""}; the draft and the report files recompute from the evidence`,
  );
});

/** `ledger-recorded` (design-pr-review-split §5.2): the review section's compare-and-swap from the value Fetch read, recomputed. */
export const ledgerCas: Validator = profiled((input, profile) => {
  const run = runOf(input, profile);
  if (isResult(run)) return run;
  const w = draftWrites(input.evidence, run.analysis, run.pr, pinnedBase(input.evidence), run.context, run.m, profile);
  if (w.state === "pending") return inconclusive(w.reason);
  if (w.state === "failed") return failed(w.reason);
  const plan = reviewLedgerWrite(input.evidence, run.pr, w.writes.draft);
  if (plan.state === "read") return inconclusive("the prior ledger's sections are not read");
  if (plan.state === "problem" || plan.state === "stale") return failed(plan.reason);
  const lw = commandRuns(input.evidence, COMMAND.reviewLedgerWrite).at(-1);
  if (lw === undefined) return inconclusive("the ledger's review section has not been advanced");
  if (!succeeded(lw.command)) return failed(`the review section's write did not succeed (exit ${lw.command.exitCode ?? "signal"})`);
  if (lw.command.argv.length !== plan.write.argv.length || lw.command.argv.some((a, i) => a !== plan.write.argv[i])) return failed("the ledger write is not the compare-and-swap of the review section from the value Fetch read with this head");
  const written = writtenReviewLedger(lw.command.argv);
  if (written?.files !== undefined) {
    const lj = readParts(input.evidence, PART_BASE.ledgerJson, LEDGER_JSON_FILE);
    const lm = readParts(input.evidence, PART_BASE.ledgerMd, LEDGER_MD_FILE);
    if (lj.state !== "read" || lm.state !== "read") return failed("the review section's files were not written whole");
    if (sha256(lj.value) !== written.files.json || sha256(lm.value) !== written.files.markdown) return failed("the ledger write commits files other than the parts the evidence holds");
  }
  const record = parseSectionRecord(reportText(lw).text);
  if (record === undefined) return failed("the ledger write's record names no commit");
  if (plan.migration.from === "v1") {
    const dj = readParts(input.evidence, PART_BASE.ledgerDesignJson, LEDGER_DESIGN_JSON_FILE);
    const dm = readParts(input.evidence, PART_BASE.ledgerDesignMd, LEDGER_DESIGN_MD_FILE);
    if (dj.state !== "read" || dm.state !== "read") return failed("the migrated design section was not written whole");
    if (dj.value !== plan.migration.design.json || dm.value !== plan.migration.design.markdown) return failed("the migrated design section is not the migration of the v1 ledger Fetch read");
    const p = priorRead(input.evidence);
    const read = commandRuns(input.evidence, COMMAND.ledger).at(-1);
    if (p !== undefined && p.prior.state === "read" && p.prior.v1 !== undefined && record.cur === plan.old && read !== undefined) {
      const entries = new Map<string, string>();
      for (const raw of reportText(read).text.split("\n")) {
        const e = /^\d{6} (?:blob|tree) ([0-9a-f]{40})\t(.+)$/.exec(raw);
        if (e !== null) entries.set(e[2]!, e[1]!);
      }
      if (record.sections.design !== migratedTrees(p.prior.v1, run.pr, entries).design) return failed("the ledger write migrated the v1 ledger, but its design section is not the migrated one");
    }
  }
  return passed(`the ledger's review section advanced by compare-and-swap from ${plan.old === "absent" ? "absent" : plan.old.slice(0, 12)} (baseline ${plan.baseline === "absent" ? "absent" : plan.baseline.slice(0, 12)}) with this head, its ${run.context.source} context and the round-1 head it counts; the design section was carried${plan.migration.from === "v1" ? " (a v1 ledger, migrated by this write)" : " unchanged"}`);
});

export const reviewPublished: Validator = profiled((input, profile) => {
  const run = runOf(input, profile);
  if (isResult(run)) return run;
  const { pr } = run;
  const p = publishPlan(input.evidence, run.analysis, pr, pinnedBase(input.evidence), run.context, run.m, profile);
  if (p.state === "pending") return inconclusive(p.reason);
  if (p.state === "failed") return failed(p.reason);
  const plan = p.plan;
  if (!plan.body.startsWith(`${plan.firstLine}\n`)) return failed("the review body does not open with its verdict");
  if (plan.verdict === "passed" && plan.open > 0) return failed("a review with an open item is not a pass");
  if (plan.problem !== undefined) return failed(plan.problem);
  // The ledger keeps one priority per finding, the final one, recomputed here (design §9.1).
  const wrong = ledgerPriorityMismatch(input.evidence, plan);
  if (wrong !== undefined && commandRuns(input.evidence, COMMAND.ledgerPublished).some((r) => succeeded(r.command))) return failed(`the published review was recorded with a priority the draft rules do not give: ${wrong}`);
  const flow = publishFlow(input.evidence, plan, p.draft, pr);
  if (flow.state !== "done") return inconclusive(flow.state === "supervise" ? flow.reason : "the review is not posted and recorded in the ledger yet");
  const noId = flow.patch.items.filter((x) => x.inline && x.commentId === null).map((x) => x.id);
  if (noId.length > 0) return failed(`the ledger holds no comment id for the inline item${noId.length === 1 ? "" : "s"} ${noId.join(", ")}`);
  const secrets = secretFindings(plan.body);
  if (secrets.length > 0) return failed(`the posted review holds what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")})`);
  return passed(`one COMMENT review (${flow.posted.reviewId}, ${flow.posted.how}) at head ${pr.head.slice(0, 12)}: ${plan.firstLine} (${plan.openFindings} open finding(s)${plan.round1 !== null ? `, ${plan.round1.open.length} open round-1 item(s) as of ${plan.round1.head.slice(0, 7)}` : "; round 1 not run"}); ${plan.items.length} item(s), ${plan.comments.length} inline; its comments were read back and the ledger's review section records the review id and each item's ids`);
});
