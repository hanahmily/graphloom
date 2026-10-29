// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { analyze, evidencePull, type Analysis } from "./analysis.js";
import { checkoutCommand, guardCommand, headTreeCommand, parseHeadTree, parseLedger, pinnedBase } from "./commands.js";
import { COMMAND, QA_JSON, REPORT_JSON, REVIEW_MD } from "./constants.js";
import { commandRuns, describeCommand, outputTail, reportText, succeeded } from "./evidence.js";
import { reportFlow, type ReportFlow } from "./flow.js";
import { measurementState, type MeasurementState } from "./measurements.js";
import { reportJson, reviewMarkdown } from "./output.js";
import { parseProfile, ProfileError, type Profile } from "./profile.js";
import type { PullRequest } from "./request.js";
import { answerContext, answerWrites, qaContext, questionSet, questionerFlow, type QaContext } from "./qaflow.js";
import { answersFlow } from "./answers.js";
import { requiredQuestions, statedPurposes } from "./questions.js";
import { writtenReport } from "./write.js";

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
  return passed(`the pull request ${c.pr.owner}/${c.pr.repo}#${c.pr.number} was read whole at head ${c.pr.head.slice(0, 12)}: ${s.files.length} files, ${s.commits.length} commits, ${s.reviews.length} reviews, ${s.reviewComments.length} review comments, ${s.threads.length} threads, ${s.checks.length} check runs`);
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
}

/** The files the report writes, recomputed from the evidence: what `report-write` must have written. */
export function outputsOf(evidence: readonly EvidenceRecord[], profile: Profile, pr: PullRequest, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }>, measurements: MeasurementState): Outputs {
  const input = { pr, snapshot: analysis.snapshot, base: pinnedBase(evidence), final: flow.final, facts: analysis.facts, measurements, profile };
  return { json: reportJson(input), markdown: reviewMarkdown(input) };
}

export const changeReport: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const flow = reportFlow(input.evidence, c.analysis.ctx);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the report is not finished (${flow.state})`);
  const m = measurementsOf(input.evidence, c.analysis, profile);
  if (m.state !== "ready" && m.state !== "none") return inconclusive("the measurements are not recorded yet");
  const run = commandRuns(input.evidence, COMMAND.reportWrite).at(-1);
  if (run === undefined) return inconclusive("the report has not been written");
  if (!succeeded(run.command)) return failed(`${describeCommand(run.command)}: ${outputTail(run.command)}`);
  const written = writtenReport(run.command.argv);
  if (written === undefined) return failed("the report-write command carries no report");
  const want = outputsOf(input.evidence, profile, c.pr, c.analysis, flow, m);
  if (written.json !== want.json) return failed(`${REPORT_JSON} is not the report the evidence recomputes`);
  const cutNote = /\n… \(cut short; see [^)]*\)\n$/;
  const markdownOk = written.markdown === want.markdown || (cutNote.test(written.markdown) && want.markdown.startsWith(written.markdown.replace(cutNote, "")));
  if (!markdownOk) return failed(`${REVIEW_MD} is not the report the evidence recomputes`);
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
    case "ready":
      return passed(`${m.records.length} function(s) the pull request adds or modifies were measured by the pinned static tools over the head tree and recompute from its bytes; coverage and mutation are recorded as not run`);
    case "failed":
      return failed(m.problems.slice(0, 3).join("; "));
    default:
      return inconclusive(`the static measurements are not complete (${m.state})`);
  }
});

export const claimsChecked: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const flow = reportFlow(input.evidence, c.analysis.ctx);
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

export const questionsComplete: Validator = profiled((input, profile) => {
  const start = qaStart(input, profile);
  if (isFailure(start)) return start;
  const flow = questionerFlow(input.evidence, start.ctx);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the questions are not asked yet (${flow.state})`);
  const m = measurementsOf(input.evidence, start.ctx.analysis, profile);
  if (m.state !== "ready" && m.state !== "none") return inconclusive("the measurements are not recorded yet");
  const set = questionSet(start.ctx, flow.output);
  const { stated } = statedPurposes(flow.output, start.ctx.view, start.ctx.pinned);
  const have = new Set(set.questions.map((q) => q.key));
  const missing = requiredQuestions({ view: start.ctx.view, groundwork: start.ctx.groundwork }, stated).filter((r) => !have.has(r.key));
  if (missing.length > 0) return failed(`required question(s) not asked: ${missing.slice(0, 5).map((r) => r.key).join(", ")}`);
  const required = set.questions.filter((q) => q.origin === "required").length;
  return passed(
    `${set.questions.length} question(s) asked: ${required} required by the plugin's rules (none dropped) and ${set.questions.length - required} added by the questioner; ${set.purposes.filter((p) => p.status === "stated").length} purpose(s) stated with a quote that matches the pull request's text, ${set.purposes.filter((p) => p.status === "asked").length} asked; ${start.ctx.groundwork.symbols.length} symbol(s) read from the packs and searched over the whole base commit; weak-test questions: none (mutation testing is a later version)`,
  );
});

/** The answers' flow and the questions behind it, once the questions are settled. */
function answersState(input: ValidationInput, profile: Profile): { start: { ctx: QaContext; pr: PullRequest }; set: ReturnType<typeof questionSet>; flow: ReturnType<typeof answersFlow> } | ValidationResult {
  const start = qaStart(input, profile);
  if (isFailure(start)) return start;
  const qf = questionerFlow(input.evidence, start.ctx);
  if (qf.state !== "done") return inconclusive(`the questions are not asked yet (${qf.state})`);
  const set = questionSet(start.ctx, qf.output);
  const flow = answersFlow(input.evidence, answerContext(start.ctx, set.questions), start.ctx.base);
  return { start, set, flow };
}

export const answersComplete: Validator = profiled((input, profile) => {
  const st = answersState(input, profile);
  if ("status" in st) return st;
  const { start, set, flow } = st;
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the answers are not finished (${flow.state})`);
  const w = answerWrites(input.evidence, start.ctx, set, flow.final);
  if (w.qa === undefined) return failed(w.problem ?? "the Q&A cannot be written");
  const qa = commandRuns(input.evidence, COMMAND.qaWrite).at(-1);
  if (qa === undefined) return inconclusive("the Q&A has not been written");
  if (!succeeded(qa.command)) return failed(`${describeCommand(qa.command)}: ${outputTail(qa.command)}`);
  if (qa.command.argv.length !== w.qa.argv.length || qa.command.argv.some((a, i) => a !== w.qa!.argv[i])) return failed(`${QA_JSON} and ${REVIEW_MD} are not what the evidence recomputes`);
  if (w.ledger === undefined || w.old === undefined) return w.problem !== undefined ? failed(w.problem) : inconclusive("the ledger value Fetch read is not in the evidence");
  const lw = commandRuns(input.evidence, COMMAND.ledgerWrite).at(-1);
  if (lw === undefined) return inconclusive("the ledger has not been advanced");
  if (!succeeded(lw.command)) return failed(`${describeCommand(lw.command)}: ${outputTail(lw.command)}`);
  if (lw.command.argv.length !== w.ledger.argv.length || lw.command.argv.some((a, i) => a !== w.ledger!.argv[i])) return failed("the ledger write is not the compare-and-swap from the value Fetch read with this head's report and Q&A");
  const by = (status: string): number => flow.final.filter((a) => a.status === status).length;
  return passed(
    `${flow.final.length} question(s) answered (${by("answered")} answered, ${by("partially answered")} partially answered, ${by("needs author")} needs author), each with evidence; every citation resolves in the tree it names, every cited number equals its record, every proposal lies inside its function with names new to the package; ${QA_JSON} and ${REVIEW_MD} are written as recomputed; the ledger ref advanced by compare-and-swap from ${w.old === "absent" ? "absent" : w.old.slice(0, 12)}`,
  );
});

export const answersGrounded: Validator = profiled((input, profile) => {
  const st = answersState(input, profile);
  if ("status" in st) return st;
  const { flow } = st;
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the answer check is not finished (${flow.state})`);
  const bad = flow.final.filter((a) => a.check.verdict !== "supported" && a.check.verdict !== "partial" && !(a.check.verdict === "downgraded" && a.status === "needs author"));
  if (bad.length > 0) return failed(`answer(s) ${bad.map((a) => a.question).join(", ")} stand without a supported or partial verdict`);
  const downgraded = flow.final.filter((a) => a.check.verdict === "downgraded");
  return passed(
    `an independent checker re-checked every answer, with searches of its own where a none-found or test claim needs them; ${flow.final.filter((a) => a.check.verdict === "supported").length} supported, ${flow.final.filter((a) => a.check.verdict === "partial").length} partial, ${downgraded.length} downgraded to needs author with both statements recorded`,
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
};

/** A shipped validator; it reads the run's profile from `ValidationInput.config`. */
export function validatorById(id: string): Validator | undefined {
  return VALIDATORS[id];
}

/** The shipped validators with `config` bound, for a caller that evaluates them in-process. */
export function validatorsFor(config: unknown): Record<string, Validator> {
  return Object.fromEntries(Object.entries(VALIDATORS).map(([id, v]) => [id, { evaluate: (input: ValidationInput) => v.evaluate({ ...input, config: input.config ?? config }) }]));
}
