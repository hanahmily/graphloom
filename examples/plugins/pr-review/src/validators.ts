// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { analyze, evidencePull, reportFlowOf, type Analysis } from "./analysis.js";
import { checkoutCommand, guardCommand, headTreeCommand, parseHeadTree, parseLedger, pinnedBase } from "./commands.js";
import { COMMAND, ENV_PLUGIN_ROOT, LEDGER_JSON_FILE, LEDGER_MD_FILE, PART_BASE, QA_JSON, REPORT_JSON, REVIEW_MD } from "./constants.js";
import { diagramFlow, diagramInputOf, type DiagramFlow } from "./diagrams.js";
import { commandRuns, describeCommand, environmentOutput, outputTail, reportText, succeeded } from "./evidence.js";
import type { ReportFlow } from "./flow.js";
import { measurementState, type MeasurementState } from "./measurements.js";
import { reportJson, reviewMarkdown } from "./output.js";
import { parseProfile, ProfileError, type Profile } from "./profile.js";
import type { PullRequest } from "./request.js";
import { afterNecessity, answerContext, batchedAnswers, answerWrites, necessityFlow, qaContext, questionSet, questionerFlow, recordedNecessity, skippedWrites, type AnswerWrites, type QaContext } from "./qaflow.js";
import { answersFlow, type FinalAnswer } from "./answers.js";
import { admissibleDecision, effectiveConclusion, necessityJson, NECESSITY_ID, ROUNDS_SKIP_REASON, roundsSkipJson, type NecessityRecord } from "./necessity.js";
import { describeReasons, isLarge } from "./mode.js";
import { requiredQuestions, statedPurposes } from "./questions.js";
import { principlesRecord } from "./principles.js";
import { htmlPagesFrom, htmlProblems } from "./html.js";
import { writtenLedger } from "./ledger.js";
import { codeReview, draftComposed, findingsProven, reviewPublished, round1Gated } from "./reviewvalidators.js";
import { readParts, recordedAppendix, recordedHtml, recordedNecessityJson, recordedQa, recordedReport, sha256 } from "./parts.js";

const passed = (reason: string): ValidationResult => ({ status: "passed", reason });
const failed = (reason: string): ValidationResult => ({ status: "failed", reason });
const inconclusive = (reason: string): ValidationResult => ({ status: "inconclusive", reason });

/** A validator that judges against the run's profile, which the controller passes as the task's config. */
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

type Context = { analysis: Analysis; pr: PullRequest } | ValidationResult;
const isResult = (c: Context): c is ValidationResult => "status" in c;

function context(input: ValidationInput, profile: Profile): Context {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const a = analyze(input.evidence, profile, pr);
  if (a.state === "pending") return inconclusive(a.reason);
  if (a.state === "incompatible") return failed(a.problem);
  return { analysis: a.analysis, pr };
}

export const prSnapshot: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const s = c.analysis.snapshot;
  return passed(`the pull request ${c.pr.owner}/${c.pr.repo}#${c.pr.number} was read whole at head ${c.pr.head.slice(0, 12)}: ${s.files.length} files, ${s.commits.length} commits, ${s.reviews.length} reviews, ${s.reviewComments.length} review comments, ${s.threads.length} threads, ${s.checks.length} check runs${s.mode.mode === "large" ? `; large mode (${describeReasons(s.mode.reasons)}): ${s.partition?.areas.filter((a) => a.kind === "read").length ?? 0} area(s)${s.partition?.areas.some((a) => a.kind === "generated") ? " and the generated files" : ""}, ${s.partition?.omitted.length ?? 0} file(s) without a patch from the host` : ""}`);
});

export { pinnedBase };

export const headTree: Validator = profiled((input, profile) => {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const guard = commandRuns(input.evidence, COMMAND.guard).at(-1);
  if (guard === undefined) return inconclusive("the head was not checked for a change under .graphloom/ before it was checked out");
  const wantGuard = guardCommand(pr.head).argv;
  if (guard.command.argv.length !== wantGuard.length || guard.command.argv.some((a, i) => a !== wantGuard[i])) return failed("the .graphloom/ guard did not name the head");
  if (!succeeded(guard.command)) return failed(`${describeCommand(guard.command)}: ${outputTail(guard.command)}`);
  const checkout = commandRuns(input.evidence, COMMAND.checkout).at(-1);
  if (checkout === undefined) return inconclusive("the head has not been checked out");
  const want = checkoutCommand(pr.head).argv;
  if (checkout.command.argv.length !== want.length || checkout.command.argv.some((a, i) => a !== want[i])) {
    return failed(`the checkout ran ${JSON.stringify(checkout.command.argv)}, not the fixed ${JSON.stringify(want)}`);
  }
  if (!succeeded(checkout.command)) return failed(`${describeCommand(checkout.command)}: ${outputTail(checkout.command)}`);
  const tree = commandRuns(input.evidence, COMMAND.headTree).at(-1);
  if (tree === undefined) return inconclusive("the head's tree was not compared with the worktree");
  const wantTree = headTreeCommand(pr.head).argv;
  if (tree.command.argv.length !== wantTree.length || tree.command.argv.some((a, i) => a !== wantTree[i])) return failed("the tree comparison did not name the head");
  if (!succeeded(tree.command)) return failed(`${describeCommand(tree.command)}: ${outputTail(tree.command)}`);
  const facts = parseHeadTree(reportText(tree).text);
  if (facts === undefined) return failed("the tree comparison printed no tree ids");
  if (facts.head !== facts.index) return failed(`the index holds tree ${facts.index}, not the head's ${facts.head}`);
  if (!facts.clean) return failed("the worktree's files differ from the head's tree");
  const dir = commandRuns(input.evidence, COMMAND.reviewDir).at(-1);
  if (dir === undefined || !succeeded(dir.command)) return inconclusive("the review directory was not prepared");
  return passed(`the worktree holds exactly the head's tree ${facts.head.slice(0, 12)} on the pinned base ${facts.base.slice(0, 12)}, checked out with no hook and no global Git configuration; no repository code ran`);
});

export const reviewScope: Validator = {
  evaluate(input) {
    const run = commandRuns(input.evidence, COMMAND.ledger).at(-1);
    if (run === undefined) return inconclusive("the pull request's ledger has not been read");
    if (!succeeded(run.command)) return failed(`${describeCommand(run.command)}: ${outputTail(run.command)}`);
    const ledger = parseLedger(reportText(run).text);
    if (ledger === undefined) return failed("the ledger read printed neither a commit nor `absent`");
    return passed(
      ledger.present
        ? `a prior ledger exists at ${ledger.sha.slice(0, 12)}; this version reports the whole pull request, since delta reports arrive with a later version`
        : "no prior ledger: everything is new",
    );
  },
};

/** The measurements as the evidence stands. */
export function measurementsOf(evidence: readonly EvidenceRecord[], analysis: Analysis, profile: Profile): MeasurementState {
  return measurementState(evidence, analysis.snapshot.files, profile);
}

export interface Outputs {
  json: string;
  markdown: string;
  /** `review.html`, the briefing, rendered from `report.json` with the Q&A pending (design §6.11). */
  html: string;
  /** `review-appendix.html`, rendered likewise. */
  appendix: string;
}

/** Where the report's diagrams stand (design §6.10), from the evidence: the graph and the validators ask the same function. */
export function diagramsOf(evidence: readonly EvidenceRecord[], flow: Extract<ReportFlow, { state: "done" }>): DiagramFlow {
  return diagramFlow(evidence, diagramInputOf(flow.final), environmentOutput(evidence, ENV_PLUGIN_ROOT));
}

/** The files the report writes, recomputed from the evidence: what the report write must have written. The diagrams must be resolved (`diagramsOf`); otherwise the plugin draws them all. */
export function outputsOf(evidence: readonly EvidenceRecord[], profile: Profile, pr: PullRequest, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }>, measurements: MeasurementState): Outputs {
  const drawn = diagramsOf(evidence, flow);
  const input = { pr, snapshot: analysis.snapshot, base: pinnedBase(evidence), final: flow.final, facts: analysis.facts, measurements, profile, mode: analysis.snapshot.mode, ...(drawn.state === "resolved" ? { diagrams: drawn.doc } : {}), ...(flow.info !== undefined ? { large: flow.info } : {}) };
  const json = reportJson(input);
  const pages = htmlPagesFrom(json)!;
  return { json, markdown: reviewMarkdown(input), html: pages.review, appendix: pages.appendix };
}

/** The deterministic check of the written bytes of `review.html` and `review-appendix.html` (design §6.11): self-contained and inert. */
export function writtenHtmlProblems(html: string, pr: PullRequest, base: string | undefined): string[] {
  return htmlProblems(html, { owner: pr.owner, repo: pr.repo, head: pr.head, base });
}

export const changeReport: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const flow = reportFlowOf(input.evidence, c.analysis);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the report is not finished (${flow.state})`);
  const m = measurementsOf(input.evidence, c.analysis, profile);
  if (m.state !== "ready" && m.state !== "none") return inconclusive("the measurements are not recorded yet");
  if (diagramsOf(input.evidence, flow).state !== "resolved") return inconclusive("the diagrams are not drawn and checked yet");
  // report.json and review.md as the evidence holds them: one command, or parts reconstructed and checked against their digest (design §6.6).
  const w = recordedReport(input.evidence);
  if (w.state === "none") return inconclusive("the report has not been written");
  if (w.state === "failed") return failed(`the report was not written whole: ${w.reason}`);
  const written = w.value;
  const want = outputsOf(input.evidence, profile, c.pr, c.analysis, flow, m);
  if (written.json !== want.json) return failed(`${REPORT_JSON} is not the report the evidence recomputes`);
  if (written.markdown !== want.markdown) return failed(`${REVIEW_MD} is not the report the evidence recomputes`);
  const h = recordedHtml(input.evidence, false);
  if (h.state === "none") return inconclusive("review.html has not been written");
  if (h.state === "failed") return failed(`review.html was not written whole: ${h.reason}`);
  if (h.value !== want.html) return failed("review.html is not the report the evidence recomputes");
  const inert = writtenHtmlProblems(h.value, c.pr, pinnedBase(input.evidence));
  if (inert.length > 0) return failed(`review.html is not self-contained and inert: ${inert.slice(0, 3).join("; ")}`);
  const ap = recordedAppendix(input.evidence, false);
  if (ap.state === "none") return inconclusive("review-appendix.html has not been written");
  if (ap.state === "failed") return failed(`review-appendix.html was not written whole: ${ap.reason}`);
  if (ap.value !== want.appendix) return failed("review-appendix.html is not the appendix the evidence recomputes");
  const inertAppendix = writtenHtmlProblems(ap.value, c.pr, pinnedBase(input.evidence));
  if (inertAppendix.length > 0) return failed(`review-appendix.html is not self-contained and inert: ${inertAppendix.slice(0, 3).join("; ")}`);
  const items = flow.final.sections.reduce((n, s) => n + s.items.length, 0);
  return passed(
    `every template section is present (${flow.final.sections.length}), with ${items} cited item(s) or None; every citation lies in the pull request's diff; every changed file and detector fact is cited; ${flow.final.removed.length} item(s) removed by the claim check; ${REPORT_JSON} and ${REVIEW_MD} are written as recomputed`,
  );
});

export const measurements: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const m = measurementsOf(input.evidence, c.analysis, profile);
  switch (m.state) {
    case "none":
      return passed(`no function to measure: ${m.reason}`);
    case "ready": {
      const measured = m.records.filter((r) => r.coverage?.source === "measured").length;
      const where = m.coverage.runs.filter((r) => r.ran).map((r) => r.language).join(", ");
      const modified = m.records.filter((r) => r.change === "modified" && !r.test);
      const atBase = modified.filter((r) => r.base !== undefined && !("unavailable" in r.base)).length;
      return passed(
        `${m.records.length} function(s) the pull request adds or modifies were measured by the pinned static tools over the head tree and recompute from its bytes (${modified.length > 0 ? `${atBase} of the ${modified.length} modified function(s) also at the base, recomputed from the base file's recorded text` : "none is modified, so none has a base value"}); coverage ${m.coverage.enabled ? `was measured in the Docker sandbox for ${measured} of them${where !== "" ? ` (${where})` : ""}, recomputed from its reports by line range, and the rest say why it was not run` : "is off in the profile"}; mutation is recorded as not run`,
      );
    }
    case "failed":
      return failed(m.problems.slice(0, 3).join("; "));
    default:
      return inconclusive(`the measurements are not complete (${m.state})`);
  }
});

export const claimsChecked: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const flow = reportFlowOf(input.evidence, c.analysis);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the claim check is not finished (${flow.state})`);
  const unsupported = flow.final.sections.flatMap((s) => s.items).filter((i) => i.auto === undefined && !flow.reading.supported.has(i.id));
  if (unsupported.length > 0) return failed(`item(s) ${unsupported.map((i) => i.id).join(", ")} stand without a supported verdict`);
  const kept = flow.final.sections.flatMap((s) => s.items).filter((i) => i.auto === undefined).length;
  return passed(`an independent checker judged every report item; ${kept} stand, each supported with matching quotes, and ${flow.final.removed.length} were removed`);
});

type QaStart = { ctx: QaContext; pr: PullRequest } | ValidationResult;

/** The Questions and Answers stages' context, or why the requirement cannot be judged yet. */
function qaStart(input: ValidationInput, profile: Profile): QaStart {
  const pr = evidencePull(input.evidence, profile);
  if (pr === undefined) return inconclusive("the pull request has not been read");
  const c = qaContext(input.evidence, profile, pr);
  if (c.state === "pending") return inconclusive(c.reason);
  if (c.state === "groundwork") {
    if (c.step.state === "incompatible") return failed(c.step.problem);
    if (c.step.state === "failed") return failed(`the groundwork could not be read: ${c.step.problems.slice(0, 2).join("; ")}`);
    return inconclusive(`the groundwork is not complete (${c.step.state})`);
  }
  return { ctx: c.ctx, pr };
}
const isFailure = (s: QaStart): s is ValidationResult => "status" in s;

/** N1's checked answer and its recorded decision, as the Questions stage left them, or why they cannot be judged yet. */
function necessityOutcome(evidence: readonly EvidenceRecord[], ctx: QaContext): { record: NecessityRecord } | ValidationResult {
  const nf = necessityFlow(evidence, ctx);
  if (nf.state === "supervise") return failed(nf.reason);
  if (nf.state !== "done") return inconclusive(`the necessity question N1 is not answered and checked yet (${nf.state})`);
  const rec = recordedNecessity(evidence);
  if (rec.state === "missing") return inconclusive("N1's checked answer and its decision are not recorded yet");
  if (rec.state === "failed") return failed(rec.reason);
  const final = nf.final[0]!;
  if (JSON.stringify(rec.record.final) !== JSON.stringify(final)) return failed("necessity.json is not N1's checked answer as the evidence recomputes it");
  if (!admissibleDecision(final, rec.record.decision)) return failed(`necessity.json decides ${rec.record.decision.action}, which N1's conclusion (${effectiveConclusion(final)}) and the checker's verdict (${final.check.verdict}) do not allow`);
  const expected = ctx.principles !== undefined ? principlesRecord(ctx.principles) : undefined;
  if (JSON.stringify(rec.record.principles) !== JSON.stringify(expected)) return failed("necessity.json does not record the design principles file as the evidence recomputes it (its path, ref, commit and what applied)");
  const written = recordedNecessityJson(evidence);
  if (written.state === "failed") return failed(`necessity.json was not written whole: ${written.reason}`);
  if (written.state === "none" || written.value !== necessityJson(rec.record)) return failed("necessity.json is not what the evidence recomputes");
  return { record: rec.record };
}

const isOutcomeFailure = (o: { record: NecessityRecord } | ValidationResult): o is ValidationResult => "status" in o;

/** `rounds: review-only` (design §3.2): the recorded skip of Questions (N1 included), the only thing the stage records. */
function skippedQuestions(input: ValidationInput, profile: Profile): ValidationResult {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const w = recordedNecessityJson(input.evidence);
  if (w.state === "none") return inconclusive(`the skip of the Questions stage (${ROUNDS_SKIP_REASON}) is not recorded`);
  if (w.state === "failed") return failed(`necessity.json was not written whole: ${w.reason}`);
  if (w.value !== roundsSkipJson()) return failed(`necessity.json is not the recorded skip the profile's rounds (review-only) calls for`);
  return passed(`the operator chose ${ROUNDS_SKIP_REASON}: the necessity question N1 and every other question were skipped, and necessity.json records the skip with that reason`);
}

/** Whether necessity.json holds the rounds skip: admissible only when the profile says review-only. */
const roundsSkipRecorded = (evidence: readonly EvidenceRecord[]): boolean => {
  const w = recordedNecessityJson(evidence);
  return w.state === "read" && w.value === roundsSkipJson();
};

export const questionsComplete: Validator = profiled((input, profile) => {
  if (profile.rounds === "review-only") return skippedQuestions(input, profile);
  if (roundsSkipRecorded(input.evidence)) return failed("necessity.json records a rounds skip, but the profile's rounds is both: the skip is admissible only with rounds: review-only");
  const start = qaStart(input, profile);
  if (isFailure(start)) return start;
  // N1, the necessity question, is asked first (design §7.5); a confirmed unnecessary conclusion is the only question.
  const n1 = necessityOutcome(input.evidence, start.ctx);
  if (isOutcomeFailure(n1)) return n1;
  const conclusion = effectiveConclusion(n1.record.final);
  if (n1.record.decision.action === "skip") {
    return passed(
      `the necessity question N1 was asked first, with its three parts (the problem traced on the base, the design statements and changed lines, the simpler or existing way) and a conclusion of ${conclusion}; the answer checker supports it, and the skip is recorded in necessity.json, so no other question is required: only N1`,
    );
  }
  const flow = questionerFlow(input.evidence, start.ctx);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the questions are not asked yet (${flow.state})`);
  const m = measurementsOf(input.evidence, start.ctx.analysis, profile);
  if (m.state !== "ready" && m.state !== "none") return inconclusive("the measurements are not recorded yet");
  const set = questionSet(start.ctx, flow.output);
  const { stated } = statedPurposes(flow.output, start.ctx.view, start.ctx.pinned, isLarge(start.ctx.mode));
  const have = new Set(set.questions.map((q) => q.key));
  const missing = requiredQuestions({ view: start.ctx.view, groundwork: start.ctx.groundwork, large: isLarge(start.ctx.mode) }, stated).filter((r) => !have.has(r.key));
  if (missing.length > 0) return failed(`required question(s) not asked: ${missing.slice(0, 5).map((r) => r.key).join(", ")}`);
  const asked = set.questions.filter((q) => q.id !== NECESSITY_ID);
  const required = asked.filter((q) => q.origin === "required").length;
  return passed(
    `the necessity question N1 was asked first (${conclusion}; ${n1.record.decision.reason}); ${asked.length} further question(s) asked: ${required} required by the plugin's rules (none dropped) and ${asked.length - required} added by the questioner; ${set.purposes.filter((p) => p.status === "stated").length} purpose(s) stated with a quote that matches the pull request's text, ${set.purposes.filter((p) => p.status === "asked").length} asked; ${start.ctx.groundwork.symbols.length} symbol(s) read from the packs and searched over the whole base commit; weak-test questions: none (mutation testing is a later version)`,
  );
});

type AnswersState = { start: { ctx: QaContext; pr: PullRequest }; set: ReturnType<typeof questionSet>; record: NecessityRecord; final: FinalAnswer[]; pending?: undefined; failure?: undefined } | { start: { ctx: QaContext; pr: PullRequest }; set: ReturnType<typeof questionSet>; record: NecessityRecord; final?: undefined; pending?: string; failure?: string };

/** The answers as the Answers stage holds them: N1's recorded answer, then (unless it was skipped past) the other answers' flow. */
function answersState(input: ValidationInput, profile: Profile): AnswersState | ValidationResult {
  const start = qaStart(input, profile);
  if (isFailure(start)) return start;
  const rec = recordedNecessity(input.evidence);
  if (rec.state === "missing") return inconclusive("N1's checked answer and its decision are not recorded");
  if (rec.state === "failed") return failed(rec.reason);
  if (!admissibleDecision(rec.record.final, rec.record.decision)) return failed(`necessity.json decides ${rec.record.decision.action}, which N1's conclusion and the checker's verdict do not allow`);
  if (rec.record.decision.action === "skip") {
    const set = questionSet(start.ctx, undefined, true);
    return { start, set, record: rec.record, final: [rec.record.final] };
  }
  const qf = questionerFlow(input.evidence, start.ctx);
  if (qf.state !== "done") return inconclusive(`the questions are not asked yet (${qf.state})`);
  const set = questionSet(start.ctx, qf.output);
  if (isLarge(start.ctx.mode)) {
    // Large mode: each answered batch is a record in the evidence (a validator sees only the newest review).
    const b = batchedAnswers(input.evidence, start.ctx, afterNecessity(set));
    if (b.state === "supervise") return { start, set, record: rec.record, failure: b.reason };
    if (b.state !== "done") return { start, set, record: rec.record, pending: b.state };
    return { start, set, record: rec.record, final: [rec.record.final, ...b.final] };
  }
  const flow = answersFlow(input.evidence, answerContext(start.ctx, afterNecessity(set)), start.ctx.base);
  if (flow.state === "supervise") return { start, set, record: rec.record, failure: flow.reason };
  if (flow.state !== "done") return { start, set, record: rec.record, pending: flow.state };
  return { start, set, record: rec.record, final: [rec.record.final, ...flow.final] };
}

/** `rounds: review-only` (design §3.2): the Answers stage records the skipped Q&A and advances the ledger with no question. */
function skippedAnswers(input: ValidationInput, profile: Profile): ValidationResult {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const base = pinnedBase(input.evidence);
  const w = skippedWrites(input.evidence, c.analysis, c.pr, base);
  const files = writtenAnswerFiles(input, w, c.pr, base);
  if (files !== undefined) return files;
  return passed(`the operator chose ${ROUNDS_SKIP_REASON}: ${QA_JSON} and ${REVIEW_MD} say the Q&A was skipped by the operator's choice (no question, no answer), review.html and review-appendix.html say so too, and the ledger was advanced with no question, keeping the earlier heads' questions and posted items as they were`);
}

export const answersComplete: Validator = profiled((input, profile) => {
  if (profile.rounds === "review-only") return skippedAnswers(input, profile);
  const st = answersState(input, profile);
  if ("status" in st) return st;
  const { start, set, record } = st;
  if (st.failure !== undefined) return failed(st.failure);
  if (st.final === undefined) return inconclusive(`the answers are not finished (${st.pending ?? "pending"})`);
  const final = st.final;
  const w = answerWrites(input.evidence, start.ctx, set, final, record);
  const problem = writtenAnswerFiles(input, w, start.pr, start.ctx.base);
  if (problem !== undefined) return problem;
  return answersPassed(final, set, record, w);
});

/** The files of the Answers stage as the evidence holds them against what it recomputes (qa.json, review.md, both HTML pages, the ledger write); undefined when they agree. */
function writtenAnswerFiles(input: ValidationInput, w: AnswerWrites, pr: PullRequest, base: string | undefined): ValidationResult | undefined {
  if (w.qa === undefined || w.texts === undefined) return failed(w.problem ?? "the Q&A cannot be written");
  // qa.json and the whole review.md as the evidence holds them: one command, or parts reconstructed and checked against their digest (design §6.6).
  const q = recordedQa(input.evidence);
  if (q.state === "none") return inconclusive("the Q&A has not been written");
  if (q.state === "failed") return failed(`the Q&A was not written whole: ${q.reason}`);
  if (q.value.json !== w.texts.json || q.value.markdown !== w.texts.markdown) return failed(`${QA_JSON} and ${REVIEW_MD} are not what the evidence recomputes`);
  const h = recordedHtml(input.evidence, true);
  if (h.state === "none") return inconclusive("review.html has not been written whole with the answers");
  if (h.state === "failed") return failed(`review.html was not written whole: ${h.reason}`);
  if (h.value !== w.texts.html) return failed("review.html is not what the evidence recomputes from report.json, qa.json and necessity.json");
  const inert = writtenHtmlProblems(h.value, pr, base);
  if (inert.length > 0) return failed(`review.html is not self-contained and inert: ${inert.slice(0, 3).join("; ")}`);
  const ap = recordedAppendix(input.evidence, true);
  if (ap.state === "none") return inconclusive("review-appendix.html has not been written whole with the answers");
  if (ap.state === "failed") return failed(`review-appendix.html was not written whole: ${ap.reason}`);
  if (ap.value !== w.texts.appendix) return failed("review-appendix.html is not what the evidence recomputes from report.json, qa.json and necessity.json");
  const inertAppendix = writtenHtmlProblems(ap.value, pr, base);
  if (inertAppendix.length > 0) return failed(`review-appendix.html is not self-contained and inert: ${inertAppendix.slice(0, 3).join("; ")}`);
  if (w.ledger === undefined || w.old === undefined) return w.problem !== undefined ? failed(w.problem) : inconclusive("the ledger value Fetch read is not in the evidence");
  const lw = commandRuns(input.evidence, COMMAND.ledgerWrite).at(-1);
  if (lw === undefined) return inconclusive("the ledger has not been advanced");
  if (!succeeded(lw.command)) return failed(`${describeCommand(lw.command)}: ${outputTail(lw.command)}`);
  if (lw.command.argv.length !== w.ledger.argv.length || lw.command.argv.some((a, i) => a !== w.ledger!.argv[i])) return failed("the ledger write is not the compare-and-swap from the value Fetch read with this head's report and Q&A");
  // A ledger too large for one command was written as part sets first; they are read back and checked like the other artifacts.
  if (w.ledgerParts !== undefined && w.ledgerParts.length > 0) {
    const lj = readParts(input.evidence, PART_BASE.ledgerJson, LEDGER_JSON_FILE);
    const lm = readParts(input.evidence, PART_BASE.ledgerMd, LEDGER_MD_FILE);
    if (lj.state !== "read" || lm.state !== "read") return failed(`the ledger files were not written whole: ${lj.state === "failed" ? lj.reason : lm.state === "failed" ? lm.reason : "no recorded parts"}`);
    if (sha256(lj.value) !== writtenLedger(lw.command.argv)?.files?.json || sha256(lm.value) !== writtenLedger(lw.command.argv)?.files?.markdown) return failed("the ledger write commits files other than the parts the evidence holds");
  }
  return undefined;
}

function answersPassed(final: FinalAnswer[], set: ReturnType<typeof questionSet>, record: NecessityRecord, w: AnswerWrites): ValidationResult {
  const rest = final.filter((a) => a.question !== NECESSITY_ID);
  const by = (status: string): number => rest.filter((a) => a.status === status).length;
  const n1 = `N1 (${effectiveConclusion(record.final)}) is answered first with its three parts and evidence${set.skipped ? ", and the remaining questions are recorded as skipped" : ""}`;
  return passed(
    `${n1}; ${rest.length} further question(s) answered (${by("answered")} answered, ${by("partially answered")} partially answered, ${by("needs author")} needs author), each with evidence; every citation resolves in the tree it names, every cited number equals its record, every proposal lies inside its function with names new to the package; ${QA_JSON} and ${REVIEW_MD} are written as recomputed; the ledger ref advanced by compare-and-swap from ${w.old === undefined || w.old === "absent" ? "absent" : w.old.slice(0, 12)}`,
  );
}

export const answersGrounded: Validator = profiled((input, profile) => {
  if (profile.rounds === "review-only") {
    const c = context(input, profile);
    if (isResult(c)) return c;
    if (recordedNecessityJson(input.evidence).state === "none") return inconclusive("the skip of the Questions stage is not recorded");
    if (!roundsSkipRecorded(input.evidence)) return failed("necessity.json is not the recorded skip the profile's rounds (review-only) calls for");
    return passed(`the operator chose ${ROUNDS_SKIP_REASON}: no answer was given, so none needed an independent check`);
  }
  if (roundsSkipRecorded(input.evidence)) return failed("necessity.json records a rounds skip, but the profile's rounds is both: the skip is admissible only with rounds: review-only");
  const st = answersState(input, profile);
  if ("status" in st) return st;
  if (st.failure !== undefined) return failed(st.failure);
  if (st.final === undefined) return inconclusive(`the answer check is not finished (${st.pending ?? "pending"})`);
  const final = st.final;
  const bad = final.filter((a) => a.check.verdict !== "supported" && a.check.verdict !== "partial" && !(a.check.verdict === "downgraded" && a.status === "needs author"));
  if (bad.length > 0) return failed(`answer(s) ${bad.map((a) => a.question).join(", ")} stand without a supported or partial verdict`);
  const downgraded = final.filter((a) => a.check.verdict === "downgraded");
  return passed(
    `an independent checker verified N1's cited design statements, trace steps and conclusion (${effectiveConclusion(st.record.final)}, ${st.record.final.check.verdict}) and re-checked every other answer, with searches of its own where a none-found or test claim needs them; ${final.filter((a) => a.check.verdict === "supported").length} supported, ${final.filter((a) => a.check.verdict === "partial").length} partial, ${downgraded.length} downgraded to needs author with both statements recorded`,
  );
});

const VALIDATORS: Record<string, Validator> = {
  "pr-snapshot": prSnapshot,
  "head-tree": headTree,
  "review-scope": reviewScope,
  "change-report": changeReport,
  measurements,
  "claims-checked": claimsChecked,
  "questions-complete": questionsComplete,
  "answers-complete": answersComplete,
  "answers-grounded": answersGrounded,
  "code-review": codeReview,
  "findings-proven": findingsProven,
  "draft-composed": draftComposed,
  "round1-gated": round1Gated,
  "review-published": reviewPublished,
};

/** A shipped validator; it reads the run's profile from `ValidationInput.config`. */
export function validatorById(id: string): Validator | undefined {
  return VALIDATORS[id];
}

/** The shipped validators with `config` bound, for a caller that evaluates them in-process. */
export function validatorsFor(config: unknown): Record<string, Validator> {
  return Object.fromEntries(Object.entries(VALIDATORS).map(([id, v]) => [id, { evaluate: (input: ValidationInput) => v.evaluate({ ...input, config: input.config ?? config }) }]));
}
