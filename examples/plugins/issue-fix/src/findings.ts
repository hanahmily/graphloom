// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord } from "@graphloom/sdk";
import { COMMAND, MAX_DISCOVERY_ROUNDS, MAX_SWEEP_PASSES, REVIEW_STAGE } from "./constants.js";
import { agentRuns, latestCheckoutRun, type AgentRun } from "./evidence.js";
import { contextPrompt, type ContextDocument } from "./context.js";
import type { Profile } from "./profile.js";
import {
  clip,
  describeComment,
  isBlocking,
  parseCodeReview,
  reviewComplete,
  type CodeReviewReport,
  type KnownFindings,
  type PriorStatus,
  type ReviewComment,
} from "./ocr.js";
import {
  MAX_REFUTATION_QUOTES,
  checkQuotes,
  fileIndex,
  observablePath,
  parseVerification,
  quoteMatches,
  VERIFICATION_SCHEMA,
  type FileIndex,
  type ParsedVerdict,
  type Quote,
  type Verdict,
} from "./review-common.js";
import {
  applyFixerRead,
  conflictNote,
  createIssue,
  descriptionOf,
  fixerNote,
  emptyIssueTable,
  findingIdOf,
  issueById,
  issueCommand,
  issueIdOf,
  ISSUES_COMMAND,
  moveIssue,
  writtenIssues,
  writtenJson,
  type EventContext,
  type IssueActor,
  type IssueTable,
} from "./issues.js";
import {
  acceptedRulingSources,
  arbiterRuns,
  asQuote,
  describeRuling,
  designPointBefore,
  parseArbiterResult,
  proofProblem,
  proofResult,
  proofRun,
  rulingApproval,
  type DeferredPoint,
  type Ruling,
  type RulingContext,
  type RulingDecision,
} from "./rulings.js";

import { describeAttempt, describeTest, parseReproduction, redProblem, redRun, regressionState, reproductionRuns, testProblem, type FindingTest } from "./test-first.js";

export {
  MAX_REFUTATION_QUOTES,
  observablePath,
  parseVerification,
  quoteMatches,
  VERIFICATION_SCHEMA,
  type Quote,
  type Verdict,
} from "./review-common.js";

/**
 * The findings ledger: every critical or high code review finding of the run,
 * rebuilt from the review passes, verification jobs and file observations in
 * evidence order. It holds no private state, so a resume or a supervisor
 * decision cannot lose it.
 */

/** `deferred`: the operator declined to rule on the finding's design point; it no longer blocks. */
export type FindingState = "pending" | "confirmed" | "disputed" | "fixed" | "dismissed" | "deferred";

export interface Finding {
  /** F1, F2, … in the order findings first appear. */
  id: string;
  /** The finding's current occurrence: where and how it manifests on `on`. */
  comment: ReviewComment;
  /** The comment it was first raised with, kept once a later occurrence replaces `comment`. */
  original?: ReviewComment;
  state: FindingState;
  /** The candidate digest the state applies to. */
  on: string;
  raisedOn: string;
  /** The candidate it was last confirmed or seen still present on. */
  confirmedOn?: string;
  regressedOn?: string;
  /** The verifier's latest verdict. */
  verdict?: ParsedVerdict;
  /**
   * The design ruling that holds for the finding (`R<n>`): it dismissed it
   * (implementation-stands, or a refutation citing one), or confirmed it
   * (review-stands). It lapses when the lines it cites no longer match.
   */
  ruling?: string;
  /** Why the finding turns on the design: the verifier's `designBasis` on a design-level verdict. */
  designBasis?: string;
  /** Why the finding is disputed. */
  dispute?: string;
  /** The quotes a dismissal rests on, and the candidate they matched. */
  refutation?: { reason: string; quotes: Quote[]; digest: string };
  /** Quoted paths to observe on `on` before a refutation or a dismissal settles. */
  awaiting?: string[];
  /** The candidate the verifier's latest verdict judged. */
  verifiedOn?: string;
  /** The code reviewer's latest word on this finding: its `prior` status and reason, or a comment naming it. */
  note?: ReviewerNote;
  /** The review round the pass that raised it belongs to. */
  round?: number;
  /**
   * Later comments of the same round on the same lines, merged into this
   * finding rather than recorded as findings of their own; the history keeps
   * their texts.
   */
  merged?: MergedComment[];
  /**
   * The verifier's latest verdict judged it behavioral (finding-verification-v2's `behavioral`, since 0.18.0):
   * about runtime behaviour a test can show. A confirmed behavioral finding is
   * fixed test-first. Absent on findings verified before issue-fix 0.18.0.
   */
  behavioral?: boolean;
  /** The test the implementer returned for it, waiting for its run on the reviewed change. */
  claim?: { test: FindingTest; digest: string; ref: string; attempt: string };
  /** Its regression test: a test that failed by assertion on the reviewed change, which the fix carries and must pass. */
  reproduction?: Reproduction;
  /** The implementer's attempt that did not reproduce it: the finding is disputed and goes to the arbiter. */
  unreproduced?: Unreproduced;
}

/** A behavioral finding's regression test, and the run that showed it fails on the reviewed change. */
export interface Reproduction {
  test: FindingTest;
  /** The reviewed change it failed on. */
  digest: string;
  /** The record the test came from: the implementer's reproduction, or the ruling's decision record. */
  source: string;
  /** The run that failed by assertion. */
  red: string;
  /** Who wrote it: the implementer, or the design ruling (`R<n>`) whose proof test it is. */
  by: string;
}

/** An attempt that did not reproduce a behavioral finding. */
export interface Unreproduced {
  attempt: string;
  test?: { path: string; name: string };
  observed: string;
  /** The reproduction record, and the reviewed change it was made on. */
  ref: string;
  digest: string;
}

/** A comment merged into an earlier finding of its round, and where it came from. */
export interface MergedComment {
  comment: ReviewComment;
  digest: string;
  ref: string;
}

/** What a review pass last said about a known finding, on which candidate, in which evidence record. */
export interface ReviewerNote {
  status: PriorStatus;
  /** The reviewer's reason verbatim, with any file:line locations it names. */
  reason: string;
  digest: string;
  ref: string;
}

export interface ReviewPass {
  run: AgentRun;
  digest: string;
  /** The review round the pass belongs to: how many distinct candidates had been reviewed, this one included. */
  round: number;
  report?: CodeReviewReport;
  problem?: string;
  /** Findings this pass raised: new ones, regressions and dismissed ones raised again. */
  raised: string[];
  /** Open findings the pass was shown and gave no status. */
  missingStatus: string[];
  /** New critical or high comments of a verify-only round, recorded as follow-ups instead of findings. */
  followUps: number;
}

/**
 * A critical or high comment a pass raised after the discovery rounds closed:
 * not a finding, so it neither blocks nor goes to the verifier, but the pull
 * request lists it so a maintainer can follow it up.
 */
export interface FollowUp {
  comment: ReviewComment;
  digest: string;
  round: number;
  ref: string;
}

export interface Verification {
  run: AgentRun;
  digest: string;
  /** The findings pending on the candidate when it ran. */
  covered: string[];
  problem?: string;
}

export interface FindingLedger {
  findings: Finding[];
  passes: ReviewPass[];
  verifications: Verification[];
  followUps: FollowUp[];
  /** The candidates with a review pass, in the order the run first reached them: round n reviewed `reviewed[n - 1]`. */
  reviewed: string[];
  /** The issues file's content, rebuilt from the same evidence (issues.ts). */
  issues: IssueTable;
  /** The design rulings an Arbitrate receipt accepted, R1, R2, … in evidence order. */
  rulings: Ruling[];
  /** The design points the operator declined to rule on. */
  deferred: DeferredPoint[];
  /** Accepted rulings and deferrals on findings this evidence has not raised yet (a validator's partial view), by finding id. */
  unapplied?: Map<string, { ruling: Ruling; ctx: EventContext } | { defer: string; ctx: EventContext }>;
}

const OPEN: ReadonlySet<FindingState> = new Set(["pending", "confirmed", "disputed"]);
export const isOpen = (f: Finding | undefined): f is Finding => f !== undefined && OPEN.has(f.state);

/** What the ledger needs beyond evidence to apply rulings: the receipts and admitted bindings, and the profile for proof results and the arbiter's model. */
export interface LedgerOptions extends RulingContext {
  profile?: Profile;
}

/** What applying a pass or a reproduction reads beyond the record itself: the run's evidence and its profile. */
interface LedgerEnv {
  evidence: EvidenceRecord[];
  profile: Profile | undefined;
}

export function findingLedger(evidence: EvidenceRecord[], options: LedgerOptions = {}): FindingLedger {
  const files = fileIndex(evidence);
  const env: LedgerEnv = { evidence, profile: options.profile };
  const entered = reviewedCandidates(evidence);
  const accepted = acceptedRulingSources(evidence, options);
  const ledger: FindingLedger = { findings: [], passes: [], verifications: [], followUps: [], reviewed: entered.map((c) => c.digest), issues: emptyIssueTable(), rulings: [], deferred: [] };
  // The candidate the run was on at each record: an operator's decision carries none of its own.
  let lastDigest: string | undefined;
  for (const [i, record] of evidence.entries()) {
    const digest = record.candidateDigest ?? lastDigest;
    if (digest === undefined) continue;
    lastDigest = digest;
    const at = position(record, i);
    const round = entered.filter((c) => !after(c.at, at)).length;
    const ctx: EventContext = { round, digest, ref: record.ref };
    const receipt = accepted.get(record.ref);
    if (receipt !== undefined) applyRuling(ledger, evidence, i, receipt, ctx, options.profile);
    if (record.candidateDigest === undefined) continue;
    const pass = agentRuns([record], REVIEW_STAGE, "review")[0];
    if (pass !== undefined) applyPass(ledger, pass, digest, files, round, env);
    const verification = agentRuns([record], REVIEW_STAGE, "diagnostic")[0];
    if (verification !== undefined) applyVerification(ledger, verification, digest, files, ctx);
    const reproduction = reproductionRuns([record])[0];
    if (reproduction !== undefined) applyReproduction(ledger, reproduction, digest, i, env);
    const written = issueCommand(record, ISSUES_COMMAND.write);
    if (written?.ok === true) {
      const json = writtenJson(written.argv);
      const issues = json !== undefined ? writtenIssues(json) : undefined;
      if (issues !== undefined) ledger.issues.written = issues;
    }
    const read = issueCommand(record, ISSUES_COMMAND.read);
    if (read?.ok === true) {
      const present = read.stdout.trim().split("\n").at(-1)?.trim() === "present";
      applyFixerRead(ledger.issues, { present, ...(read.report !== undefined ? { text: read.report.text, truncated: read.report.truncated } : {}) }, ctx, (id) => findingById(ledger, findingIdOf(id))?.ruling);
    }
  }
  // Each issue carries the ruling that holds for its finding, and a behavioral finding's regression test.
  for (const issue of ledger.issues.issues) {
    const f = findingById(ledger, findingIdOf(issue.id));
    const ruling = f?.ruling;
    if (ruling !== undefined) issue.ruling = ruling;
    else delete issue.ruling;
    const test = f !== undefined ? regressionNote(f) : undefined;
    if (test !== undefined) issue.regressionTest = test;
    else delete issue.regressionTest;
  }
  return ledger;
}

/**
 * A confirmed finding that is fixed test-first and has no regression test on
 * the change it was last confirmed on: the verifier judged it behavioral, and
 * no ruling holds for it (a design ruling's finding keeps today's handling,
 * except the proof test of a review-stands ruling after a failed reproduction).
 */
export function needsReproduction(f: Finding): boolean {
  return f.state === "confirmed" && f.behavioral === true && f.ruling === undefined && (f.reproduction === undefined || f.reproduction.digest !== f.confirmedOn);
}

/**
 * The pull request's "Regression tests": for each behavioral finding with a
 * test-first story, the regression test that failed on the reviewed change
 * and passes with the fix, or the attempt that did not reproduce it and the
 * ruling that settled it.
 */
export function regressionSectionLines(ledger: FindingLedger): string[] {
  return ledger.findings.flatMap((f) => {
    const id = `${issueIdOf(f.id)} (\`${f.comment.path}:${f.comment.start_line}\`)`;
    const r = f.reproduction;
    if (r !== undefined && f.state === "fixed") {
      const by = r.by === "implementer" ? "" : `, the proof test of design ruling ${r.by},`;
      return [`- ${id}: ${describeTest(r.test)}${by} failed by assertion on the reviewed change (${shortDigest(r.digest)}) with only it added, and passes with the fix.`];
    }
    if (f.unreproduced === undefined) return [];
    const ruling = holdingRuling(ledger, f);
    const settled = ruling !== undefined ? `design ruling ${ruling.id} (${ruling.decision}) settled it` : f.state === "deferred" ? "the operator left it open" : `it is ${f.state}`;
    return [`- ${id}: not reproduced with a failing test (${clip(describeAttempt(f.unreproduced), 400)}); ${settled}.`];
  });
}

/** The regression test the issue shows for a behavioral finding: its test, or why it has none. */
export function regressionNote(f: Finding): string | undefined {
  const r = f.reproduction;
  if (r !== undefined) return `${r.test.name} (${r.test.path})${r.by !== "implementer" ? `, the proof test of design ruling ${r.by}` : ""}: fails on the reviewed change ${shortDigest(r.digest)}, must pass with the fix`;
  if (f.unreproduced !== undefined) return `not reproduced: ${clip(describeAttempt(f.unreproduced), 300)}`;
  return undefined;
}

/**
 * The implementer's reproduction on the reviewed change `digest`: an attempt
 * that did not reproduce a finding disputes it (the arbiter takes it up); a
 * test whose run on the reviewed change, with only it added, failed by
 * assertion becomes the finding's regression test; any other run, or a test
 * that cannot be added there, is an attempt that did not reproduce it. A test
 * not run yet waits as the finding's claim. Answers for a finding that does
 * not need one on this change are ignored.
 */
function applyReproduction(ledger: FindingLedger, run: AgentRun, digest: string, at: number, env: LedgerEnv): void {
  if (run.status !== "completed") return;
  const parsed = parseReproduction(run.output);
  if ("problem" in parsed) return;
  const changed = latestCheckoutRun(env.evidence, COMMAND.regression, "candidate", digest)?.checkout?.paths ?? [];
  for (const entry of parsed.entries) {
    const f = findingById(ledger, entry.finding);
    if (f === undefined || !needsReproduction(f) || f.confirmedOn !== digest) continue;
    delete f.claim;
    const tried = entry.test.path !== "" && entry.test.name !== "" ? { test: { path: entry.test.path, name: entry.test.name } } : {};
    const unreproduced = (observed: string) => {
      f.unreproduced = { attempt: entry.attempt, ...tried, observed, ref: run.record.ref, digest };
      dispute(f, digest, `the implementer could not reproduce it with a test that fails on the reviewed change: ${describeAttempt(f.unreproduced)}`);
    };
    if (entry.outcome === "cannot-reproduce") {
      unreproduced(entry.observed);
      continue;
    }
    if (env.profile === undefined) {
      f.claim = { test: entry.test, digest, ref: run.record.ref, attempt: entry.attempt };
      continue;
    }
    const problem = testProblem(env.profile, entry.test, changed);
    if (problem !== undefined) {
      unreproduced(`the test cannot be added to the reviewed change: ${problem}`);
      continue;
    }
    const red = redRun(env.evidence, env.profile, entry.test, digest, at);
    if (red === undefined) {
      f.claim = { test: entry.test, digest, ref: run.record.ref, attempt: entry.attempt };
      continue;
    }
    const failed = redProblem(env.profile, entry.test, red);
    if (failed !== undefined) unreproduced(`${failed}; a test that does not fail on the reviewed change does not reproduce it`);
    else f.reproduction = { test: entry.test, digest, source: run.record.ref, red: red.record.ref, by: "implementer" };
  }
}

/**
 * The design conflicts no ruling holds for, in ledger order: a finding the
 * verifier could not settle or judged at the design level (disputed), and an
 * issue the fixer contests (`design-conflict`). The first is the point
 * Arbitrate settles next.
 */
export function designConflicts(ledger: FindingLedger): Finding[] {
  return ledger.findings.filter((f) => f.ruling === undefined && (f.state === "disputed" || issueById(ledger.issues, issueIdOf(f.id))?.status === "design-conflict"));
}

/** Whether the fixer, rather than the verifier, raised the conflict on `f`. */
export function fixerRaised(ledger: FindingLedger, f: Finding): boolean {
  return issueById(ledger.issues, issueIdOf(f.id))?.status === "design-conflict";
}

/** Whether `f` is disputed because the implementer could not reproduce it: a point raised in Fix, like the fixer's conflict. */
export const unreproducedInFix = (f: Finding): boolean => f.state === "disputed" && f.unreproduced !== undefined;

/** A design conflict in one line, for the supervisor: its issue id, location, title and why it is a conflict. */
export function describeConflict(ledger: FindingLedger, f: Finding): string {
  const issue = issueById(ledger.issues, issueIdOf(f.id));
  const where = `${f.comment.path}:${f.comment.start_line}-${f.comment.end_line}`;
  const title = issue?.title ?? clip(f.comment.content.trim().split("\n")[0] ?? "", 120);
  const contested = issue !== undefined ? conflictNote(issue) : undefined;
  const why =
    contested !== undefined
      ? `the fixer contests it: ${clip(contested.note, 300)}`
      : unreproducedInFix(f)
        ? `the implementer could not reproduce it with a failing test: ${clip(describeAttempt(f.unreproduced!), 300)}`
        : f.designBasis !== undefined && f.designBasis !== ""
        ? `the verifier judged it at the design level: ${clip(f.designBasis, 300)}`
        : `the verifier could not settle it: ${clip(f.dispute ?? "", 300)}`;
  return `${issueIdOf(f.id)} ${where} ${title} (${why})`;
}

/** The question and both sides' cases for a point the arbiter did not decide (capped, or no ruling after a revision). */
export function pointCases(ledger: FindingLedger, f: Finding): { question: string; implementation: string; review: string } {
  const issue = issueById(ledger.issues, issueIdOf(f.id));
  const contested = issue !== undefined ? conflictNote(issue) : undefined;
  const verifier = f.designBasis !== undefined && f.designBasis !== "" ? ` The verifier: ${f.designBasis}` : f.dispute !== undefined ? ` The verifier: ${f.dispute}` : "";
  return {
    question: `Does ${issueIdOf(f.id)} (${f.comment.path}:${f.comment.start_line}) hold against the project's design, so that the change must address it?`,
    implementation:
      contested !== undefined
        ? `The fixer: ${clip(contested.note, 1_200)}`
        : unreproducedInFix(f)
          ? `The implementer could not reproduce it with a test that fails on the reviewed change: ${clip(describeAttempt(f.unreproduced!), 1_200)}`
          : "The change as it stands; the implementer has not contested the finding.",
    review: clip(`${describeComment(f.comment)}${f.comment.evidence !== undefined ? ` ${f.comment.evidence}` : ""}${verifier}`, 1_200),
  };
}

/** The ruling that holds for `f`, when one does. */
export function holdingRuling(ledger: FindingLedger, f: Finding): Ruling | undefined {
  return f.ruling === undefined ? undefined : ledger.rulings.find((r) => r.id === f.ruling);
}

/** The rulings that hold, as a review pass, the verifier or the fixer is told them. */
export function holdingRulings(ledger: FindingLedger): string[] {
  return ledger.rulings.filter((r) => ledger.findings.some((f) => f.ruling === r.id)).map((r) => describeRuling(r, issueIdOf(r.finding)));
}

/**
 * Apply a ruling an Arbitrate receipt accepted, at its decision record:
 * `implementation-stands` dismisses the finding on the ruling's code
 * citations (rule 6: it stays dismissed while they match), `review-stands`
 * confirms it with the ruling as its witness, and the operator's decline
 * defers the point waiting then.
 */
function applyRuling(ledger: FindingLedger, evidence: EvidenceRecord[], at: number, receipt: string, ctx: EventContext, profile: Profile | undefined): void {
  const record = evidence[at]!;
  const approval = rulingApproval(record);
  let ruling: Omit<Ruling, "id">;
  if (approval !== undefined) {
    if (approval.decision === "decline") {
      // The point the visit pinned with its design-point record; the first open conflict when none was pinned.
      const pinned = designPointBefore(evidence, at);
      const point = pinned !== undefined ? findingById(ledger, pinned) : designConflicts(ledger)[0];
      const note = `the operator left the design point open${approval.reason !== undefined ? `: ${approval.reason}` : ""}`;
      const reason = approval.reason !== undefined ? { reason: approval.reason } : {};
      if (point === undefined) {
        // A validator's partial view: the deferral waits, like a ruling, for the first comment naming the point.
        if (pinned === undefined) return;
        const cases = undecidedCases(evidence, at, pinned) ?? { question: `Does ${issueIdOf(pinned)} hold against the project's design?`, implementation: "", review: "" };
        ledger.deferred.push({ finding: pinned, ...cases, ...reason, source: record.ref, receipt });
        (ledger.unapplied ??= new Map()).set(pinned, { defer: note, ctx });
        return;
      }
      const cases = undecidedCases(evidence, at, point.id) ?? pointCases(ledger, point);
      ledger.deferred.push({ finding: point.id, ...cases, ...reason, source: record.ref, receipt });
      defer(ledger, point, note, ctx);
      return;
    }
    if (approval.finding === undefined || approval.ruling === undefined) return;
    ruling = { finding: approval.finding, decision: approval.ruling, decider: { kind: "operator", operator: approval.operator }, summary: approval.note ?? "", design: [], code: [], proofTests: [], source: record.ref, receipt };
  } else {
    const run = arbiterRuns([record])[0];
    const parsed = run !== undefined && run.status === "completed" ? parseArbiterResult(run.output) : undefined;
    if (parsed === undefined || "problem" in parsed || parsed.result.ruling === "undecidable") return;
    const r = parsed.result;
    const harness = String((record.payload as { codingAgent?: { harness?: unknown } } | undefined)?.codingAgent?.harness ?? profile?.roles.arbiter ?? "codex");
    const proofTests = r.proofTests.map((t) => {
      if (profile === undefined) return { ...t, result: "recorded with the ruling" };
      const run = proofRun(evidence, profile, t, record.candidateDigest, at);
      return { ...t, result: proofResult(profile, t, run), ...(run !== undefined && proofProblem(profile, t, run) === undefined ? { run: run.record.ref } : {}) };
    });
    ruling = {
      finding: r.finding,
      decision: r.ruling as RulingDecision,
      decider: { kind: "arbiter", harness, ...(profile !== undefined ? { model: profile.arbiter.model } : {}) },
      summary: r.summary,
      design: r.design,
      code: r.code,
      proofTests,
      source: record.ref,
      receipt,
      ...(record.candidateDigest !== undefined ? { digest: record.candidateDigest } : {}),
    };
  }
  const r: Ruling = { id: `R${ledger.rulings.length + 1}`, ...ruling };
  ledger.rulings.push(r);
  const f = findingById(ledger, ruling.finding);
  // A validator's view keeps only the latest review pass of a candidate, so the pass that raised the finding may be
  // missing: the ruling waits for the first comment that names the finding, and applies to it then.
  if (f === undefined) (ledger.unapplied ??= new Map()).set(ruling.finding, { ruling: r, ctx });
  else rule(ledger, f, r, ctx);
}

/** The next finding id: one past every finding the ledger holds and every id a waiting ruling or deferral reserves. */
function nextFindingId(ledger: FindingLedger): string {
  const ids = [...ledger.findings.map((f) => f.id), ...(ledger.unapplied?.keys() ?? [])];
  return `F${ids.reduce((n, id) => Math.max(n, Number(id.slice(1)) || 0), 0) + 1}`;
}

/** The operator's decline: the point no longer blocks. */
function defer(ledger: FindingLedger, f: Finding, note: string, ctx: EventContext): void {
  settle(f, "deferred", ctx.digest);
  moveOrCreate(ledger, f, "deferred", "operator", note, ctx);
}

/** A ruling's effect on its finding and the finding's issue. */
function rule(ledger: FindingLedger, f: Finding, r: Ruling, ctx: EventContext): void {
  const actor: IssueActor = r.decider.kind === "operator" ? "operator" : "arbiter";
  const note = `design ruling ${r.id} (${r.decision}): ${r.summary}`;
  if (r.decision === "implementation-stands") {
    settle(f, "dismissed", ctx.digest);
    f.refutation = { reason: note, quotes: r.code.map(asQuote), digest: r.digest ?? ctx.digest };
    f.ruling = r.id;
    moveOrCreate(ledger, f, "dismissed", actor, note, ctx);
  } else {
    settle(f, "confirmed", ctx.digest);
    delete f.refutation;
    f.confirmedOn = ctx.digest;
    f.verdict = { verdict: "confirmed", reason: note, quotes: r.code.map(asQuote) };
    f.ruling = r.id;
    // After a failed reproduction, the ruling's proof test that failed on the change as claimed is the finding's regression test.
    const proof = f.unreproduced !== undefined ? r.proofTests.find((t) => t.expect === "fail" && t.run !== undefined) : undefined;
    if (proof !== undefined) f.reproduction = { test: { path: proof.path, name: proof.name, content: proof.content }, digest: r.digest ?? ctx.digest, source: r.source, red: proof.run!, by: r.id };
    moveOrCreate(ledger, f, "open", actor, note, ctx);
  }
}

/** Move the finding's issue to `to`, or create it there: a disputed finding has no issue until a ruling gives it one. */
function moveOrCreate(ledger: FindingLedger, f: Finding, to: "open" | "dismissed" | "deferred", actor: IssueActor, note: string, ctx: EventContext): void {
  const issue = issueById(ledger.issues, issueIdOf(f.id));
  if (issue === undefined) createIssue(ledger.issues, f, { status: to, actor, note, raisedIn: f.round ?? ctx.round, ctx });
  else if (issue.status !== to) moveIssue(issue, actor, to, note, ctx);
}

/** The cases of the newest undecidable result on `finding` before the record at `at`. */
function undecidedCases(evidence: EvidenceRecord[], at: number, finding: string): { question: string; implementation: string; review: string } | undefined {
  for (let i = at - 1; i >= 0; i -= 1) {
    const run = arbiterRuns([evidence[i]!])[0];
    if (run === undefined || run.status !== "completed") continue;
    const parsed = parseArbiterResult(run.output);
    if ("result" in parsed && parsed.result.ruling === "undecidable" && parsed.result.finding === finding && parsed.result.undecidable.question !== "") return parsed.result.undecidable;
  }
  return undefined;
}

/** Where a record falls in the run: its generation first, then its place in the list. */
type Position = readonly [generation: number, index: number];
const position = (record: EvidenceRecord, index: number): Position => [record.generation ?? 0, index];
const after = (a: Position, b: Position): boolean => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/**
 * The candidates with a review pass, each at its first record of any kind, in
 * that order. The first record, not the first pass: the controller shows a
 * validator the other candidates as history before the current one, and only
 * the current candidate's latest pass, so a candidate the run returned to
 * would otherwise look new and later than every other. Its Fix records keep
 * their generation, and generations order the run the same way in either view.
 */
function reviewedCandidates(evidence: EvidenceRecord[]): Array<{ digest: string; at: Position }> {
  const first = new Map<string, Position>();
  const reviewed = new Set<string>();
  for (const [i, record] of evidence.entries()) {
    const digest = record.candidateDigest;
    if (digest === undefined) continue;
    const at = position(record, i);
    const seen = first.get(digest);
    if (seen === undefined || after(seen, at)) first.set(digest, at);
    if (agentRuns([record], REVIEW_STAGE, "review").length > 0) reviewed.add(digest);
  }
  return [...reviewed].map((digest) => ({ digest, at: first.get(digest)! })).sort((a, b) => (after(a.at, b.at) ? 1 : after(b.at, a.at) ? -1 : 0));
}

/**
 * The review round a pass on `digest` belongs to: how many reviewed candidates
 * the run had reached by then, this one included. Rounds only move forward: a
 * new candidate starts the next one, and a candidate reviewed before (the
 * implementer went back to it) stays in the latest round rather than reopening
 * discovery. This is the round of the next pass, after every recorded one.
 */
export function reviewRound(ledger: FindingLedger, digest: string): number {
  return ledger.reviewed.includes(digest) ? ledger.reviewed.length : ledger.reviewed.length + 1;
}

/** After the discovery rounds the reviewer only verifies the findings already raised. */
export const verifyOnly = (round: number): boolean => round > MAX_DISCOVERY_ROUNDS;

export type ReviewPhase = "discovery" | "verify-only";

/**
 * The one decision on how a candidate is reviewed: its round, and whether
 * the reviewer may still raise new findings on it. The graph, the ledger's
 * summary and the assignment all ask here.
 */
export function reviewPhase(ledger: FindingLedger, digest: string): { round: number; phase: ReviewPhase } {
  const round = reviewRound(ledger, digest);
  return { round, phase: verifyOnly(round) ? "verify-only" : "discovery" };
}

/** The pass read every file on its list, skipped none, and gave every status it owed. */
export function passUsable(pass: ReviewPass): boolean {
  return pass.run.producer.readOnly && pass.run.status === "completed" && pass.report !== undefined && reviewComplete(pass.report) && pass.missingStatus.length === 0;
}

/** Findings pending on `digest` that a verifier has yet to judge. */
export function toVerify(ledger: FindingLedger, digest: string): Finding[] {
  return ledger.findings.filter((f) => f.state === "pending" && f.on === digest && f.awaiting === undefined);
}

/** Quoted paths to observe on `digest`. */
export function pathsToObserve(ledger: FindingLedger, digest: string): string[] {
  return [...new Set(ledger.findings.flatMap((f) => (f.on === digest ? (f.awaiting ?? []) : [])))];
}

/** What a review pass is told: open findings need a status, settled ones must not come back unnamed. */
export function knownFindings(ledger: FindingLedger): KnownFindings {
  // By issue id and issue status once the verifier has judged a finding; before that it awaits verification.
  const known = (f: Finding) => {
    const issue = issueById(ledger.issues, issueIdOf(f.id));
    const fixer = issue !== undefined && issue.status === "fixed" ? fixerNote(issue) : undefined;
    const state = f.state === "pending" ? "awaiting verification" : (issue?.status ?? f.state);
    return { id: issueIdOf(f.id), state, description: `${describeComment(f.comment)}${fixer !== undefined ? ` Fixer's note: ${clip(fixer.note, 800)}` : ""}` };
  };
  const rulings = holdingRulings(ledger);
  return { open: ledger.findings.filter(isOpen).map(known), settled: ledger.findings.filter((f) => !isOpen(f)).map(known), ...(rulings.length > 0 ? { rulings } : {}) };
}

/** A finding that no longer blocks a pass: dismissed, or deferred by the operator. */
export const settledAway = (f: Finding | undefined): boolean => f?.state === "dismissed" || f?.state === "deferred";

/** The sweep's last pass raised nothing that survived verification. */
export function saturated(ledger: FindingLedger, pass: ReviewPass): boolean {
  return passUsable(pass) && pass.raised.every((id) => settledAway(findingById(ledger, id)));
}

export function findingById(ledger: FindingLedger, id: string): Finding | undefined {
  return ledger.findings.find((f) => f.id === id);
}

/** A round's progress for the supervisor: passes on the candidate and what they settled. */
export function roundSummary(ledger: FindingLedger, digest: string, passes: ReviewPass[]): string {
  const { round, phase } = reviewPhase(ledger, digest);
  const mode = phase === "verify-only" ? `verify-only after ${MAX_DISCOVERY_ROUNDS} discovery rounds` : `discovery round, ${MAX_DISCOVERY_ROUNDS} at most`;
  const followUps = ledger.followUps.filter((f) => f.digest === digest).length;
  const last = passes.at(-1);
  const done = last !== undefined && saturated(ledger, last);
  const sweep = done ? "sweep saturated" : passes.length >= MAX_SWEEP_PASSES ? `sweep stopped at the ${MAX_SWEEP_PASSES}-pass limit` : "sweep not saturated";
  const count = (keep: (f: Finding) => boolean) => ledger.findings.filter(keep).length;
  const fixed = count((f) => f.state === "fixed" && f.on === digest);
  const dismissed = count((f) => f.state === "dismissed" && passes.some((p) => p.raised.includes(f.id)));
  const confirmed = count((f) => f.state === "confirmed" && f.raisedOn === digest && f.regressedOn === undefined);
  const regressions = count((f) => f.regressedOn === digest);
  const disputed = count((f) => f.state === "disputed");
  return (
    `review round ${round} (${mode}); passes on this change: ${passes.length} (${sweep}); ${fixed} fixed, ${dismissed} dismissed, ${confirmed} new confirmed, ${regressions} regression(s), ${disputed} disputed` +
    (followUps > 0 ? `, ${followUps} new comment(s) kept as follow-ups` : "") +
    (fixed === 0 && !done ? "; not converging" : "")
  );
}

/**
 * A finding with the verifier's argument, for the implementer, the supervisor
 * or the pull request. A finding the reviewer last saw still present on a
 * later candidate than the one it was reported on leads with that note: the
 * original report and the verifier's quotes may describe code that has since
 * been rewritten. `current` is the candidate the reader works on, when known.
 */
export function describeFinding(f: Finding, current?: string): string {
  const verdict = f.state === "dismissed" ? f.refutation : f.state === "disputed" ? { reason: f.dispute ?? "", quotes: [] } : f.verdict;
  const quotes = (verdict?.quotes ?? []).slice(0, 4).map((q) => `${q.path}:${q.line} \`${clip(q.text, 160)}\``);
  const why = verdict !== undefined && verdict.reason.trim() !== "" ? ` Verifier: ${clip(verdict.reason, 600)}` : "";
  const report = `${describeComment(f.comment)}${why}${quotes.length > 0 ? ` (${quotes.join("; ")})` : ""}`;
  const note = stillPresentNote(f);
  if (note === undefined) return `${issueIdOf(f.id)} ${report}`;
  const reportedOn = f.verifiedOn ?? f.raisedOn;
  // Reported and re-checked on the same candidate: nothing in the report is stale.
  if (reportedOn === note.digest) return `${issueIdOf(f.id)} ${report.replace(/\.$/, "")}. ${reviewerLead(note, current)}`;
  return (
    `${issueIdOf(f.id)} ${reviewerLead(note, current)} Background, the original report ` +
    `(it describes an earlier revision, candidate ${shortDigest(reportedOn)}; its line numbers and quotes may no longer match the code): ${report}`
  );
}

/** The reviewer's latest note on an open finding, when its last status was still present. */
export function stillPresentNote(f: Finding): ReviewerNote | undefined {
  return isOpen(f) && f.note?.status === "still_present" ? f.note : undefined;
}

export const shortDigest = (digest: string): string => digest.slice(0, 8);

function reviewerLead(note: ReviewerNote, current: string | undefined): string {
  const on =
    current === undefined ? `on candidate ${shortDigest(note.digest)}` : note.digest === current ? "on the current candidate" : `on candidate ${shortDigest(note.digest)}, before your latest change`;
  return `Reviewer, latest pass ${on} (${note.ref}): still present — ${clip(note.reason, 1_500).replace(/\.$/, "")}.`;
}

function applyPass(ledger: FindingLedger, run: AgentRun, digest: string, files: FileIndex, round: number, env: LedgerEnv): void {
  const parsed = run.status === "completed" ? parseCodeReview(run.output) : { problem: `the code reviewer did not finish (${run.status})` };
  const phase: ReviewPhase = verifyOnly(round) ? "verify-only" : "discovery";
  const pass: ReviewPass = { run, digest, round, raised: [], missingStatus: [], followUps: 0, ...("report" in parsed ? { report: parsed.report } : { problem: parsed.problem }) };
  ledger.passes.push(pass);
  if (pass.report === undefined) return;
  // The reviewer names findings by their issue ids (I3 is F3); earlier runs used F3.
  const report0 = pass.report;
  const report: CodeReviewReport = {
    ...pass.report,
    // A new comment on the lines of an earlier finding of this round names it: the same problem, found twice.
    comments: pass.report.comments
      .map((c) => (c.finding !== undefined ? { ...c, finding: findingIdOf(c.finding) } : c))
      .map((c) => {
        if (!report0.dedupe || !mergeable(c) || (c.finding !== undefined && findingById(ledger, c.finding) !== undefined)) return c;
        const twin = mergeTarget(ledger.findings, c, round);
        return twin !== undefined ? { ...c, finding: twin.id } : c;
      }),
    prior: pass.report.prior.map((p) => ({ ...p, finding: findingIdOf(p.finding) })),
  };
  pass.report = report;
  const before = new Map(ledger.findings.map((f) => [f.id, f.state]));
  const open = ledger.findings.filter(isOpen);
  // A named comment carries the finding's current occurrence, so the verifier and the
  // pull request describe where and how it manifests now, not where it first appeared.
  for (const c of report.comments) {
    if (c.finding === undefined) continue;
    const known = findingById(ledger, c.finding);
    if (known !== undefined) updateComment(known, c, report.dedupe ? round : undefined, { digest, ref: run.record.ref });
  }
  const status = new Map<string, PriorStatus>();
  const note = (id: string, s: PriorStatus, reason: string) => {
    const known = findingById(ledger, id);
    if (known !== undefined && reason.trim() !== "") known.note = { status: s, reason: reason.trim(), digest, ref: run.record.ref };
  };
  for (const p of report.prior) {
    if (status.has(p.finding)) continue;
    status.set(p.finding, p.status);
    // The reviewer's latest reason, not only its status: the implementer must
    // read what the reviewer saw on this candidate, not the original report.
    note(p.finding, p.status, p.reason);
  }
  // A comment that names an open finding says it is still there.
  for (const c of report.comments) {
    if (c.finding !== undefined && open.some((f) => f.id === c.finding) && !status.has(c.finding)) {
      status.set(c.finding, "still_present");
      note(c.finding, "still_present", [describeComment(c), ...(c.evidence !== undefined ? [clip(c.evidence, 1_200)] : [])].join(" "));
    }
  }
  for (const f of open) {
    const s = status.get(f.id);
    if (s === undefined) pass.missingStatus.push(f.id);
    else applyStatus(f, s, digest, env);
    // Rule 6: a review-stands ruling holds while the lines it cites match; once they are observed changed it lapses.
    const r = holdingRuling(ledger, f);
    if (r?.decision === "review-stands" && r.code.length > 0 && r.digest !== digest && checkQuotes(r.code.map(asQuote), digest, files) === "mismatch") delete f.ruling;
  }
  for (const c of report.comments.filter(isBlocking)) {
    const known = c.finding !== undefined ? findingById(ledger, c.finding) : undefined;
    if (known !== undefined && (open.includes(known) || pass.raised.includes(known.id))) continue;
    // A ruled finding this view never saw raised (a validator sees only a candidate's latest pass): the comment
    // naming it stands for it, with the ruling applied, and is then judged as a ruled finding raised again.
    const waiting = known === undefined && c.finding !== undefined ? ledger.unapplied?.get(c.finding) : undefined;
    if (waiting !== undefined) {
      const f: Finding = { id: c.finding!, comment: c, state: "pending", on: digest, raisedOn: digest, round };
      ledger.findings.push(f);
      ledger.unapplied!.delete(f.id);
      if ("defer" in waiting) {
        defer(ledger, f, waiting.defer, waiting.ctx);
        continue;
      }
      rule(ledger, f, waiting.ruling, waiting.ctx);
      if (f.state === "dismissed") {
        recheckDismissal(f, digest, files);
        pass.raised.push(f.id);
      }
      continue;
    }
    // The operator left the point open: naming it again neither blocks nor makes a new finding.
    if (known?.state === "deferred") continue;
    if (known?.state === "fixed") {
      reopen(known, digest);
      // A regression is a new state of the code: a ruling on the old one no longer holds.
      delete known.ruling;
      known.regressedOn = digest;
      pass.raised.push(known.id);
      continue;
    }
    if (known?.state === "dismissed") {
      recheckDismissal(known, digest, files);
      pass.raised.push(known.id);
      continue;
    }
    // Discovery is closed: a new comment is a follow-up, not a finding.
    if (phase === "verify-only") {
      pass.followUps += 1;
      const key = followUpKey(c);
      if (!ledger.followUps.some((f) => followUpKey(f.comment) === key)) ledger.followUps.push({ comment: c, digest, round, ref: run.record.ref });
      continue;
    }
    // The same problem raised twice in this pass (per-file and cross-file) is one finding.
    const twin = pass.report!.dedupe && mergeable(c) ? mergeTarget(ledger.findings, c, round) : undefined;
    if (twin !== undefined) {
      mergeInto(twin, c, { digest, ref: run.record.ref });
      continue;
    }
    // The next number after every finding the ledger holds or a waiting ruling reserves (a partial view may skip ahead).
    const f: Finding = { id: nextFindingId(ledger), comment: c, state: "pending", on: digest, raisedOn: digest, round };
    ledger.findings.push(f);
    pass.raised.push(f.id);
  }
  // A twin merged after the issue exists adds its text to the issue's description.
  for (const f of ledger.findings) {
    const issue = f.merged !== undefined ? issueById(ledger.issues, issueIdOf(f.id)) : undefined;
    if (issue !== undefined) issue.description = descriptionOf(f);
  }
  syncIssuesAfterPass(ledger, before, status, { round, digest, ref: run.record.ref });
}

/**
 * The code reviewer's statuses on the issues: a finding the ledger now counts
 * fixed is `done` (the graph records the `fixed` step when the fixer did not
 * mark it), and a `fixed` issue the reviewer still sees is `reopened` with its
 * note. Nothing else a pass says moves an issue: new findings and withdrawals
 * wait for the verifier.
 */
function syncIssuesAfterPass(ledger: FindingLedger, before: Map<string, FindingState>, status: Map<string, PriorStatus>, ctx: EventContext): void {
  for (const f of ledger.findings) {
    const issue = issueById(ledger.issues, issueIdOf(f.id));
    if (issue === undefined) continue;
    const said = status.get(f.id);
    const reason = f.note?.ref === ctx.ref && f.note.status === said ? f.note.reason : "";
    if (f.state === "fixed" && before.get(f.id) !== "fixed") {
      if (issue.status === "done") continue;
      if (issue.status !== "fixed") moveIssue(issue, "graph", "fixed", "the fixer did not mark it fixed; the code reviewer reports it resolved on a changed candidate", ctx);
      moveIssue(issue, "reviewer", "done", reason || "resolved", ctx);
    } else if (f.state === "confirmed" && issue.status === "fixed" && said === "still_present") {
      moveIssue(issue, "reviewer", "reopened", reason || "still present", ctx);
    }
  }
}

const followUpKey = (c: ReviewComment): string => `${c.path}:${c.start_line}:${c.content.trim()}`;

/** A follow-up for the pull request: where and what, and the round that raised it. */
export function describeFollowUp(f: FollowUp): string {
  return `${describeComment(f.comment)} (raised in review round ${f.round}, after the ${MAX_DISCOVERY_ROUNDS} discovery rounds; not verified or fixed in this change)`;
}

/**
 * How a pass's status for an open finding changes it; fixing needs a candidate other than the one it was last seen on,
 * and a finding with a regression test needs that test to hold on the candidate: its exact bytes in the change, passing.
 */
function applyStatus(f: Finding, status: PriorStatus, digest: string, env: LedgerEnv): void {
  if (f.state === "confirmed") {
    if (status === "resolved") {
      if (f.confirmedOn !== digest && regressionHolds(f, digest, env)) settle(f, "fixed", digest);
    } else if (status === "still_present") {
      f.on = digest;
      f.confirmedOn = digest;
    } else {
      reopen(f, digest);
    }
    return;
  }
  if (status === "resolved") {
    if (f.on !== digest) settle(f, "fixed", digest);
    return;
  }
  reopen(f, digest);
}

/** A finding without a regression test, or whose test holds on `digest`. Without a profile a test cannot be judged, so it does not hold. */
export function regressionHolds(f: Finding, digest: string, env: { evidence: EvidenceRecord[]; profile: Profile | undefined }): boolean {
  if (f.reproduction === undefined) return true;
  return env.profile !== undefined && regressionState(env.evidence, env.profile, f.reproduction.test, digest).kind === "holds";
}

/**
 * A dismissal holds while every line its refutation quoted still matches; a
 * dismissal by ruling rests on the ruling's code citations (an operator's
 * ruling cites none and holds for the rest of the run). When they no longer
 * match, the ruling lapses and the finding is verified again.
 */
function recheckDismissal(f: Finding, digest: string, files: FileIndex): void {
  const refutation = f.refutation!;
  if (refutation.digest === digest) return;
  const check = checkQuotes(refutation.quotes, digest, files);
  if (check === "match") return;
  reopen(f, digest);
  if (check !== "mismatch") {
    f.refutation = refutation;
    f.awaiting = check;
  } else {
    delete f.ruling;
  }
}

function applyVerification(ledger: FindingLedger, run: AgentRun, digest: string, files: FileIndex, ctx: EventContext): void {
  const covered = toVerify(ledger, digest);
  const before = new Map(covered.map((f) => [f.id, f.state]));
  const parsed = run.status === "completed" ? parseVerification(run.output) : { problem: `the verifier did not finish (${run.status})` };
  ledger.verifications.push({ run, digest, covered: covered.map((f) => f.id), ...("problem" in parsed ? { problem: parsed.problem } : {}) });
  for (const f of covered) {
    const v = "verdicts" in parsed ? parsed.verdicts.get(f.id) : undefined;
    if (v === undefined) {
      dispute(f, digest, "problem" in parsed ? parsed.problem : "the verifier gave no verdict");
      continue;
    }
    f.verdict = v;
    f.verifiedOn = digest;
    if (v.designLevel === true) f.designBasis = v.designBasis ?? "";
    else delete f.designBasis;
    if (v.behavioral === true) f.behavioral = true;
    else delete f.behavioral;
    // A new verdict starts the finding's test-first story over.
    delete f.claim;
    delete f.unreproduced;
    // A review-stands ruling that holds keeps the finding confirmed, its witness the ruling: only a matching refutation settles it otherwise.
    const stands = holdingRuling(ledger, f)?.decision === "review-stands";
    if (v.verdict === "uncertain") {
      if (stands) settleConfirmed(f, digest);
      else dispute(f, digest, v.reason || "the verifier could not decide");
    } else if (v.verdict === "confirmed") {
      if (v.designLevel === true && !stands) {
        // A design-level confirmation does not go to Fix: it is disputed until ruled on.
        dispute(f, digest, `the verifier confirmed it, but at the design level: ${v.designBasis || v.reason}`);
      } else if (v.quotes.some((q) => q.path !== "" && q.line > 0) || stands) {
        settleConfirmed(f, digest);
      } else {
        dispute(f, digest, "the verifier confirmed it without a file:line witness");
      }
    } else {
      // A refutation citing a ruling rests on the ruling's code citations, matched as usual; an operator's ruling cites none and holds.
      const cited = v.ruling !== undefined ? ledger.rulings.find((r) => r.id === v.ruling && r.decision === "implementation-stands") : undefined;
      const quotes = cited !== undefined ? cited.code.map(asQuote) : v.quotes.slice(0, MAX_REFUTATION_QUOTES);
      const check = cited !== undefined && quotes.length === 0 ? "match" : quotes.length === 0 ? "mismatch" : checkQuotes(quotes, digest, files);
      if (check === "mismatch") {
        if (stands) {
          settleConfirmed(f, digest);
          continue;
        }
        dispute(f, digest, `the verifier refuted it, but ${quotes.length === 0 ? "quoted no line" : cited !== undefined ? `the lines ruling ${cited.id} cites no longer match the change` : "its quotes do not match the change"}: ${v.reason}`);
        continue;
      }
      f.refutation = { reason: cited !== undefined ? `${v.reason} (design ruling ${cited.id})` : v.reason, quotes, digest };
      if (cited !== undefined) f.ruling = cited.id;
      if (check === "match") settle(f, "dismissed", digest);
      else f.awaiting = check;
    }
  }
  syncIssuesAfterVerification(ledger, covered, before, ctx);
}

function settleConfirmed(f: Finding, digest: string): void {
  settle(f, "confirmed", digest);
  f.confirmedOn = digest;
}

/**
 * The verifier's verdicts on the issues: a confirmed finding becomes an `open`
 * issue, or reopens one that was fixed, done or dismissed; a dismissed one
 * becomes a `dismissed` issue. A refuted regression of a done issue leaves it
 * done. Disputed findings wait.
 */
function syncIssuesAfterVerification(ledger: FindingLedger, covered: Finding[], before: Map<string, FindingState>, ctx: EventContext): void {
  for (const f of covered) {
    if (f.state === before.get(f.id)) continue;
    const issue = issueById(ledger.issues, issueIdOf(f.id));
    const reason = f.state === "dismissed" ? (f.refutation?.reason ?? "") : (f.verdict?.reason ?? "");
    if (f.state === "confirmed") {
      if (issue === undefined) createIssue(ledger.issues, f, { status: "open", actor: "verifier", note: reason || "confirmed", raisedIn: f.round ?? ctx.round, ctx });
      else if (issue.status === "fixed" || issue.status === "done" || issue.status === "dismissed") moveIssue(issue, "verifier", "reopened", `confirmed again: ${reason}`, ctx);
    } else if (f.state === "dismissed") {
      if (issue === undefined) createIssue(ledger.issues, f, { status: "dismissed", actor: "verifier", note: reason || "refuted", raisedIn: f.round ?? ctx.round, ctx });
      else if (issue.status !== "done" && issue.status !== "dismissed") moveIssue(issue, "verifier", "dismissed", reason || "refuted", ctx);
    }
  }
}

/**
 * A comment naming a finding. In the finding's own round it is the same
 * occurrence found again, so its text joins the finding's history; in a later
 * round it replaces the comment with the latest occurrence, keeping the first.
 */
function updateComment(f: Finding, c: ReviewComment, round: number | undefined, at: { digest: string; ref: string }): void {
  if (round !== undefined && f.round === round) {
    mergeInto(f, c, at);
    return;
  }
  if (f.original === undefined) f.original = f.comment;
  f.comment = c;
}

/** A new blocking comment the reviewer did not mark distinct and that says where it is: the merge default applies. */
const mergeable = (c: ReviewComment): boolean => isBlocking(c) && c.distinct !== true && c.start_line > 0;

const occurrences = (f: Finding): ReviewComment[] => [f.comment, ...(f.original !== undefined ? [f.original] : []), ...(f.merged ?? []).map((m) => m.comment)];
const overlaps = (a: ReviewComment, b: ReviewComment): boolean => a.path === b.path && a.start_line > 0 && a.start_line <= Math.max(b.end_line, b.start_line) && b.start_line <= Math.max(a.end_line, a.start_line);

/**
 * The first finding of `round` (in raised order) whose lines overlap the comment's, unless it is already
 * fixed. A comment the reviewer marked `distinct` never merges, and nothing merges into one, whichever
 * order the comments come in.
 */
function mergeTarget(findings: Finding[], c: ReviewComment, round: number): Finding | undefined {
  if (c.distinct === true) return undefined;
  return findings.find((f) => f.round === round && f.state !== "fixed" && occurrences(f).some((o) => o.distinct !== true && overlaps(o, c)));
}

function mergeInto(f: Finding, c: ReviewComment, at: { digest: string; ref: string }): void {
  const text = c.content.trim();
  if (occurrences(f).some((o) => o.content.trim() === text)) return;
  const { finding: _named, ...comment } = c;
  (f.merged ??= []).push({ comment, digest: at.digest, ref: at.ref });
}

function settle(f: Finding, state: FindingState, digest: string): void {
  f.state = state;
  f.on = digest;
  delete f.awaiting;
  delete f.dispute;
}

function reopen(f: Finding, digest: string): void {
  settle(f, "pending", digest);
  delete f.refutation;
}

function dispute(f: Finding, digest: string, why: string): void {
  settle(f, "disputed", digest);
  delete f.refutation;
  f.dispute = why;
}

/** The verifier's assignment: judge each finding against the current code, with its own evidence. */
export function verificationInstruction(profile: Profile, args: { findings: Finding[]; background: string; changed: string[]; context?: ContextDocument[]; rulings?: string[] }): string {
  const rulings = args.rulings ?? [];
  return [
    `You are an independent verifier of code review findings on the uncommitted change in this worktree (${profile.project}). You did not write the change or the review. Do not modify any file. Read the code with your file tools; you cannot run commands.`,
    "",
    "What the change is for:",
    args.background,
    ...contextPrompt(args.context),
    "",
    ...(args.changed.length > 0 ? ["Changed files:", ...args.changed.map((p) => `- ${p}`), ""] : []),
    "Findings to verify:",
    ...args.findings.flatMap((f) => [
      `- ${f.id} ${describeComment(f.comment)}`,
      ...(f.comment.evidence !== undefined ? [`  Reviewer's failure scenario: ${clip(f.comment.evidence, 1_200)}`] : []),
      ...(f.merged ?? []).map((m) => `  The same problem, raised again on the same lines: ${describeComment(m.comment)}`),
    ]),
    "",
    "Judge whether each defect exists in the current code, not how severe it is. For each finding return one verdict:",
    "- `confirmed`: the defect is real. In `quotes`, give your own witness, the call path or the steps that trigger it, each step a line of the current code; do not restate the reviewer's argument.",
    `- \`refuted\`: the claim is false. In \`quotes\`, give at most ${MAX_REFUTATION_QUOTES} lines of the current code that disprove it, such as the lock that is held, the caller that does not exist, or the check that covers the path. A refutation counts only if every quote matches the file.`,
    "- `uncertain`: you cannot decide. Give the argument for and against in `reason`.",
    "",
    "Set `behavioral` to true when the finding is about runtime behaviour a test can show: wrong output, a crash, a race, a leak, or wrong error handling. Set it false for a finding about the design, the documentation, style or naming, or a missing test, and whenever `designLevel` is true. The reviewer's category is a hint, not the answer. A confirmed behavioral finding is fixed test-first: the implementer must first write a test that fails on the current code.",
    "",
    "Set `designLevel` to true when the claim turns on the project's design rather than on the code: whether it is a defect depends on which reading of the issue, its discussion or the design documents is right (an intended behaviour, an API or format choice, a trade-off the design makes), not on what the code does. Then give in `designBasis` the design statement or decision it turns on, in one or two sentences. A design-level finding does not go to the implementer; an independent arbiter rules on it. Otherwise `designLevel` is false and `designBasis` is \"\".",
    ...(rulings.length > 0
      ? [
          "",
          "Design rulings that hold in this run. They settle their design points: do not judge a point again against a ruling. A finding that raises the point a ruling dismissed (implementation-stands) is `refuted` with `ruling` set to that ruling's id; its cited lines are then matched against the current code as your quotes would be. Otherwise `ruling` is \"\".",
          ...rulings.map((r) => `- ${r}`),
        ]
      : ["", "No design ruling holds in this run: `ruling` is \"\"."]),
    "",
    "Each quote is one line: `path` relative to the repository root, `line` its line number in the current file, and `text` copied from that line without the line number. Your result: `verdicts`, one for every finding listed, each with `finding` (its name), `verdict`, `reason`, `quotes`, `behavioral`, `designLevel`, `designBasis` and `ruling`.",
  ].join("\n");
}
