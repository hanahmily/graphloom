// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The validators of Fetch and Report (design §5, design-pr-review-split §4.1), and the functions the graph and the validators share
 * to recompute what a stage must have written. The review layer's, the draft's, the ledger write's and Publish's are in
 * `reviewvalidators.ts`. Each reads the run's profile from `ValidationInput.config` and, for the context source, the task's pinned
 * request from `ValidationInput.request` (design-pr-review-split §10): `none` is admissible only when the request says
 * `, without a report`.
 */
import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { analyze, evidencePull, reportFlowOf, type Analysis } from "./kit/analysis.js";
import { checkoutCommand, guardCommand, headTreeCommand, parseHeadTree, parseLedger, pinnedBase } from "./kit/commands.js";
import { COMMAND, ENV_PLUGIN_ROOT, REPORT_JSON, REVIEW_MD } from "./kit/constants.js";
import { diagramFlow, diagramInputOf, type DiagramFlow } from "./kit/diagrams.js";
import { agentRuns, commandRuns, describeCommand, environmentOutput, outputTail, reportText, succeeded, type CommandRun } from "./kit/evidence.js";
import type { ReportFlow } from "./kit/flow.js";
import { measurementState, type MeasurementState } from "./kit/measurements.js";
import { reportJson, reviewMarkdown } from "./kit/output.js";
import { parseProfile, ProfileError, type Profile } from "./kit/profile.js";
import { requestsNoReport, type PullRequest } from "./kit/request.js";
import { describeReasons } from "./kit/mode.js";
import { CLAIM_CHECK_SCHEMA_NAME } from "./kit/claims.js";
import { recordedAppendix, recordedHtml, recordedRecord, recordedReport } from "./kit/parts.js";
import { CLAIM_RECORD_ID, claimRecordJson, withRecordedClaimChecks } from "./kit/claimrecord.js";
import { htmlPagesFrom, htmlProblems } from "./html.js";
import { contextJson, contextLine, decideContext, designSeedMarkdown, noneSeedMarkdown, preludeMarkdown, type ContextRecord } from "./context.js";
import { designRecordsOf, designState, priorRead, recordedContext, recordedSeed } from "./runcontext.js";

export { groundworkOptions, leadInputOf } from "./runcontext.js";
import { chooseScope } from "./reviewscope.js";
import { NO_DESIGN_HTML } from "./reviewdraft.js";
import { codeReview, draftComposed, findingsProven, leadsJudged, ledgerCas, reviewPublished } from "./reviewvalidators.js";

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

/** `prior-ledger` (design-pr-review-split §4.1): the two sections read or recorded absent; the design head's records and the delta read, or the reason they are not usable. */
export const reviewScope: Validator = profiled((input, profile) => {
  const run = commandRuns(input.evidence, COMMAND.ledger).at(-1);
  if (run === undefined) return inconclusive("the pull request's ledger has not been read");
  if (!succeeded(run.command)) return failed(`${describeCommand(run.command)}: ${outputTail(run.command)}`);
  const ledger = parseLedger(reportText(run).text);
  if (ledger === undefined) return failed("the ledger read printed neither a commit nor `absent`");
  const c = context(input, profile);
  if (isResult(c)) return c;
  if (ledger.present) {
    const p = priorRead(input.evidence);
    if (p === undefined || p.prior.state === "missing") return inconclusive("the prior ledger's sections are not read yet");
    if (p.prior.state === "unreadable") return failed(`the prior ledger cannot be read: ${p.prior.reason}`);
  }
  const reads = designState(input.evidence, c.pr, c.analysis);
  if (reads.state === "run") return inconclusive(`the design review's records are not read yet (${reads.why})`);
  const sections = ledger.present ? `a prior ledger exists at ${ledger.sha.slice(0, 12)}; its review and design sections were read (a section absent is a graph that has not run)` : "no prior ledger: there is no earlier finding and no design review";
  if (reads.state === "unusable") return passed(`${sections}; no design report is usable as the context: ${reads.reason}`);
  return passed(`${sections}; the design review's report, Q&A and necessity record of ${reads.records.head.slice(0, 12)} were read${reads.delta !== undefined ? `, with the delta to this head (${reads.delta.size} file(s) changed)` : " (this head)"}`);
});

/** `review-context` (design-pr-review-split §4.1, §4.2): the source recomputed from the ledger reads, the delta's usability and the task's request. */
export const reviewContext: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const reads = designState(input.evidence, c.pr, c.analysis);
  if (reads.state === "run") return inconclusive(`the design review's records are not read yet (${reads.why})`);
  const want = decideContext(reads, requestsNoReport(input.request));
  const rec = recordedContext(input.evidence);
  if (rec.state === "none") return inconclusive("context.json has not been written");
  if (rec.state === "failed") return failed(rec.reason);
  if (contextJson(rec.value) !== contextJson(want)) {
    if (rec.value.source === "none" && want.source !== "none") return failed(`context.json says none, which only a request that says "without a report" (--no-report) allows when no design report is usable; the context recomputes as ${want.source}`);
    return failed(`context.json records ${rec.value.source}, and the evidence and the request recompute ${want.source}${want.reasons.length > 0 ? ` (${want.reasons[0]})` : ""}`);
  }
  return passed(`the reviewers' context is ${contextLine(want, c.pr.head)}${want.reasons.length > 0 ? `; ${want.reasons.join("; ")}` : ""}`);
});

/** The measurements as the evidence stands. */
export function measurementsOf(evidence: readonly EvidenceRecord[], analysis: Analysis, profile: Profile): MeasurementState {
  return measurementState(evidence, analysis.snapshot.files, profile);
}

export interface Outputs {
  json: string;
  markdown: string;
  /** `review.html`, the briefing, rendered from `report.json` (design §6.11). */
  html: string;
  /** `review-appendix.html`, rendered likewise. */
  appendix: string;
}

/** Where the report's diagrams stand (design §6.10), from the evidence: the graph and the validators ask the same function. */
export function diagramsOf(evidence: readonly EvidenceRecord[], flow: Extract<ReportFlow, { state: "done" }>): DiagramFlow {
  return diagramFlow(evidence, diagramInputOf(flow.final), environmentOutput(evidence, ENV_PLUGIN_ROOT));
}

/**
 * The files the prelude's report writes, recomputed from the evidence (design-pr-review-split §4.2 item 2): report.json, the report's
 * review.md with no design review in it, and the HTML pages saying so. The diagrams must be resolved (`diagramsOf`).
 */
export function outputsOf(evidence: readonly EvidenceRecord[], profile: Profile, pr: PullRequest, analysis: Analysis, flow: Extract<ReportFlow, { state: "done" }>, measurements: MeasurementState): Outputs {
  const drawn = diagramsOf(evidence, flow);
  const input = { pr, snapshot: analysis.snapshot, base: pinnedBase(evidence), final: flow.final, facts: analysis.facts, measurements, profile, mode: analysis.snapshot.mode, ...(drawn.state === "resolved" ? { diagrams: drawn.doc } : {}), ...(flow.info !== undefined ? { large: flow.info } : {}) };
  const json = reportJson(input);
  const pages = htmlPagesFrom(json, undefined, undefined, undefined, { noDesign: NO_DESIGN_HTML })!;
  return { json, markdown: preludeMarkdown(reviewMarkdown(input)), html: pages.review, appendix: pages.appendix };
}

/** The reviewers' seed review.md of a `design-review` or `none` source (design-pr-review-split §4.2), recomputed from the evidence. */
export function contextOutputs(evidence: readonly EvidenceRecord[], profile: Profile, pr: PullRequest, analysis: Analysis, ctx: ContextRecord, m: MeasurementState): { markdown: string } | { pending: string } {
  const base = pinnedBase(evidence);
  if (ctx.source === "design-review") {
    const records = designRecordsOf(evidence, pr, analysis, ctx);
    if (records === undefined) return { pending: "the design review's records do not read back from the ledger" };
    return { markdown: designSeedMarkdown({ pr, base, context: ctx, records, measurements: m, profile }) };
  }
  // No report: the scope is the whole pull request, or in large mode every readable area (there is no briefing to narrow it).
  const scope = chooseScope({ mode: analysis.snapshot.mode, files: analysis.snapshot.files, partition: analysis.snapshot.partition, check: { risks: [], behavior: [], compatibility: [] } });
  return { markdown: noneSeedMarkdown({ pr, base, context: ctx, snapshot: analysis.snapshot, scope: scope.files, measurements: m, profile }) };
}

/** The deterministic check of the written bytes of `review.html` and `review-appendix.html` (design §6.11): self-contained and inert. */
export function writtenHtmlProblems(html: string, pr: PullRequest, base: string | undefined, also: readonly string[] = []): string[] {
  return htmlProblems(html, { owner: pr.owner, repo: pr.repo, head: pr.head, base, also });
}

/** `change-report` (design-pr-review-split §4.1): the prelude's report as written, or the seed review.md of the other sources, each recomputed. */
export const changeReport: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const rec = recordedContext(input.evidence);
  if (rec.state === "none") return inconclusive("context.json has not been written");
  if (rec.state === "failed") return failed(rec.reason);
  const ctx = rec.value;
  const m = measurementsOf(input.evidence, c.analysis, profile);
  if (m.state !== "ready" && m.state !== "none") return inconclusive("the measurements are not recorded yet");
  if (ctx.source !== "prelude") {
    const want = contextOutputs(input.evidence, profile, c.pr, c.analysis, ctx, m);
    if ("pending" in want) return inconclusive(want.pending);
    const seed = recordedSeed(input.evidence);
    if (seed.state === "none") return inconclusive("the reviewers' seed review.md has not been written");
    if (seed.state === "failed") return failed(`review.md was not written whole: ${seed.reason}`);
    if (seed.value !== want.markdown) return failed(`${REVIEW_MD} is not the seed the evidence recomputes for the ${ctx.source} context`);
    return passed(`the context is ${contextLine(ctx, c.pr.head)}: the Report stage writes no report of its own, and ${REVIEW_MD}, the reviewers' seed, is written as recomputed`);
  }
  const flow = reportFlowOf(input.evidence, c.analysis);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the report is not finished (${flow.state})`);
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
    `the report-only prelude: every template section is present (${flow.final.sections.length}), with ${items} cited item(s) or None; every citation lies in the pull request's diff; every changed file and detector fact is cited; ${flow.final.removed.length} item(s) removed by the claim check; ${REPORT_JSON} and ${REVIEW_MD} are written as recomputed, with no design review in this run`,
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

/** Whether every claim check of the prelude came from a read-only review job: the independence the binding does not ask the controller for. */
function checkerRunsIndependent(evidence: readonly EvidenceRecord[]): string | undefined {
  // A validator sees only the latest review evidence (the controller's candidate evidence): a later review of the same candidate
  // supersedes the claim checks, and the graph's record of them puts them back (`kit/claimrecord.ts`), so they are judged here either way.
  const runs = agentRuns(withRecordedClaimChecks(evidence), CLAIM_CHECK_SCHEMA_NAME);
  if (runs.length === 0) return "no claim check is recorded";
  const bad = runs.find((r) => r.record.kind !== "review" && r.status === "completed" && r.contract?.status !== "invalid") ?? runs.find((r) => !r.producer.readOnly || r.producer.purpose !== "review");
  if (bad !== undefined) return `the claim check ${bad.record.ref} is not the review evidence of a read-only review job`;
  // The record of the checks is written before the report: it must be the checks the evidence holds.
  const record = recordedRecord(evidence, CLAIM_RECORD_ID, "report");
  if (record.state !== "read") return "the claim checks are not recorded";
  if (record.value !== claimRecordJson(withRecordedClaimChecks(evidence))) return "the recorded claim checks are not the ones the evidence holds";
  return undefined;
}

export const claimsChecked: Validator = profiled((input, profile) => {
  const c = context(input, profile);
  if (isResult(c)) return c;
  const rec = recordedContext(input.evidence);
  if (rec.state === "none") return inconclusive("context.json has not been written");
  if (rec.state === "failed") return failed(rec.reason);
  if (rec.value.source !== "prelude") return passed(`the context is ${contextLine(rec.value, c.pr.head)}: this run writes no report of its own, so there is no claim to check`);
  const flow = reportFlowOf(input.evidence, c.analysis);
  if (flow.state === "supervise") return failed(flow.reason);
  if (flow.state !== "done") return inconclusive(`the claim check is not finished (${flow.state})`);
  const independence = checkerRunsIndependent(input.evidence);
  if (independence !== undefined) return failed(independence);
  const unsupported = flow.final.sections.flatMap((s) => s.items).filter((i) => i.auto === undefined && !flow.reading.supported.has(i.id));
  if (unsupported.length > 0) return failed(`item(s) ${unsupported.map((i) => i.id).join(", ")} stand without a supported verdict`);
  const kept = flow.final.sections.flatMap((s) => s.items).filter((i) => i.auto === undefined).length;
  return passed(`an independent checker, in a read-only review job, judged every report item of the prelude; ${kept} stand, each supported with matching quotes, and ${flow.final.removed.length} were removed`);
});

const VALIDATORS: Record<string, Validator> = {
  "pr-snapshot": prSnapshot,
  "head-tree": headTree,
  "review-scope": reviewScope,
  "review-context": reviewContext,
  "change-report": changeReport,
  measurements,
  "claims-checked": claimsChecked,
  "code-review": codeReview,
  "leads-judged": leadsJudged,
  "findings-proven": findingsProven,
  "draft-composed": draftComposed,
  "ledger-cas": ledgerCas,
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

export type { CommandRun };
