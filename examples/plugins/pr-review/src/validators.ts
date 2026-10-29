// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { analyze, evidencePull, type Analysis } from "./analysis.js";
import { checkoutCommand, guardCommand, headTreeCommand, parseHeadTree, parseLedger } from "./commands.js";
import { COMMAND, NOT_IMPLEMENTED, REPORT_JSON, REVIEW_MD } from "./constants.js";
import { commandRuns, describeCommand, outputTail, reportText, succeeded } from "./evidence.js";
import { reportFlow, type ReportFlow } from "./flow.js";
import { measurementState, type MeasurementState } from "./measurements.js";
import { reportJson, reviewMarkdown } from "./output.js";
import { parseProfile, ProfileError, type Profile } from "./profile.js";
import type { PullRequest } from "./request.js";
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

/** The base the checkout recorded: the pinned commit the worktree is built on. */
export function pinnedBase(evidence: readonly EvidenceRecord[]): string | undefined {
  const run = commandRuns(evidence, COMMAND.headTree).at(-1);
  return run === undefined || !succeeded(run.command) ? undefined : parseHeadTree(reportText(run).text)?.base;
}

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

/** A requirement of a stage this version has not built: it fails closed, never passes. */
function notBuilt(what: string): Validator {
  return { evaluate: () => failed(`${what}: ${NOT_IMPLEMENTED}`) };
}

const VALIDATORS: Record<string, Validator> = {
  "pr-snapshot": prSnapshot,
  "head-tree": headTree,
  "review-scope": reviewScope,
  "change-report": changeReport,
  measurements,
  "claims-checked": claimsChecked,
  "questions-complete": notBuilt("the questions were asked"),
  "answers-complete": notBuilt("the questions were answered"),
  "answers-grounded": notBuilt("the answers were checked"),
};

/** A shipped validator; it reads the run's profile from `ValidationInput.config`. */
export function validatorById(id: string): Validator | undefined {
  return VALIDATORS[id];
}

/** The shipped validators with `config` bound, for a caller that evaluates them in-process. */
export function validatorsFor(config: unknown): Record<string, Validator> {
  return Object.fromEntries(Object.entries(VALIDATORS).map(([id, v]) => [id, { evaluate: (input: ValidationInput) => v.evaluate({ ...input, config: input.config ?? config }) }]));
}
