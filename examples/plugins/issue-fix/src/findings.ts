import type { EvidenceRecord } from "@graphloom/sdk";
import { MAX_DISCOVERY_ROUNDS, MAX_SWEEP_PASSES, REVIEW_STAGE } from "./constants.js";
import { agentRuns, type AgentRun } from "./evidence.js";
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
  type Quote,
  type Verdict,
} from "./review-common.js";
import {
  applyFixerRead,
  createIssue,
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
  type IssueTable,
} from "./issues.js";

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

export type FindingState = "pending" | "confirmed" | "disputed" | "fixed" | "dismissed";

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
  verdict?: { verdict: Verdict; reason: string; quotes: Quote[] };
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
}

const OPEN: ReadonlySet<FindingState> = new Set(["pending", "confirmed", "disputed"]);
export const isOpen = (f: Finding | undefined): f is Finding => f !== undefined && OPEN.has(f.state);

export function findingLedger(evidence: EvidenceRecord[]): FindingLedger {
  const files = fileIndex(evidence);
  const entered = reviewedCandidates(evidence);
  const ledger: FindingLedger = { findings: [], passes: [], verifications: [], followUps: [], reviewed: entered.map((c) => c.digest), issues: emptyIssueTable() };
  for (const [i, record] of evidence.entries()) {
    const digest = record.candidateDigest;
    if (digest === undefined) continue;
    const at = position(record, i);
    const round = entered.filter((c) => !after(c.at, at)).length;
    const ctx: EventContext = { round, digest, ref: record.ref };
    const pass = agentRuns([record], REVIEW_STAGE, "review")[0];
    if (pass !== undefined) applyPass(ledger, pass, digest, files, round);
    const verification = agentRuns([record], REVIEW_STAGE, "diagnostic")[0];
    if (verification !== undefined) applyVerification(ledger, verification, digest, files, ctx);
    const written = issueCommand(record, ISSUES_COMMAND.write);
    if (written?.ok === true) {
      const json = writtenJson(written.argv);
      const issues = json !== undefined ? writtenIssues(json) : undefined;
      if (issues !== undefined) ledger.issues.written = issues;
    }
    const read = issueCommand(record, ISSUES_COMMAND.read);
    if (read?.ok === true) {
      const present = read.stdout.trim().split("\n").at(-1)?.trim() === "present";
      applyFixerRead(ledger.issues, { present, ...(read.report !== undefined ? { text: read.report.text, truncated: read.report.truncated } : {}) }, ctx);
    }
  }
  return ledger;
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
  return { open: ledger.findings.filter(isOpen).map(known), settled: ledger.findings.filter((f) => !isOpen(f)).map(known) };
}

/** The sweep's last pass raised nothing that survived verification. */
export function saturated(ledger: FindingLedger, pass: ReviewPass): boolean {
  return passUsable(pass) && pass.raised.every((id) => findingById(ledger, id)?.state === "dismissed");
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

function applyPass(ledger: FindingLedger, run: AgentRun, digest: string, files: FileIndex, round: number): void {
  const parsed = run.status === "completed" ? parseCodeReview(run.output) : { problem: `the code reviewer did not finish (${run.status})` };
  const phase: ReviewPhase = verifyOnly(round) ? "verify-only" : "discovery";
  const pass: ReviewPass = { run, digest, round, raised: [], missingStatus: [], followUps: 0, ...("report" in parsed ? { report: parsed.report } : { problem: parsed.problem }) };
  ledger.passes.push(pass);
  if (pass.report === undefined) return;
  // The reviewer names findings by their issue ids (I3 is F3); earlier runs used F3.
  const report: CodeReviewReport = {
    ...pass.report,
    comments: pass.report.comments.map((c) => (c.finding !== undefined ? { ...c, finding: findingIdOf(c.finding) } : c)),
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
    if (known !== undefined) updateComment(known, c);
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
    else applyStatus(f, s, digest);
  }
  for (const c of report.comments.filter(isBlocking)) {
    const known = c.finding !== undefined ? findingById(ledger, c.finding) : undefined;
    if (known !== undefined && (open.includes(known) || pass.raised.includes(known.id))) continue;
    if (known?.state === "fixed") {
      reopen(known, digest);
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
    const f: Finding = { id: `F${ledger.findings.length + 1}`, comment: c, state: "pending", on: digest, raisedOn: digest, round };
    ledger.findings.push(f);
    pass.raised.push(f.id);
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

/** How a pass's status for an open finding changes it; fixing needs a candidate other than the one it was last seen on. */
function applyStatus(f: Finding, status: PriorStatus, digest: string): void {
  if (f.state === "confirmed") {
    if (status === "resolved") {
      if (f.confirmedOn !== digest) settle(f, "fixed", digest);
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

/** A dismissal holds while every line its refutation quoted still matches. */
function recheckDismissal(f: Finding, digest: string, files: FileIndex): void {
  const refutation = f.refutation!;
  if (refutation.digest === digest) return;
  const check = checkQuotes(refutation.quotes, digest, files);
  if (check === "match") return;
  reopen(f, digest);
  if (check !== "mismatch") {
    f.refutation = refutation;
    f.awaiting = check;
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
    if (v.verdict === "uncertain") {
      dispute(f, digest, v.reason || "the verifier could not decide");
    } else if (v.verdict === "confirmed") {
      if (v.quotes.some((q) => q.path !== "" && q.line > 0)) {
        settle(f, "confirmed", digest);
        f.confirmedOn = digest;
      } else {
        dispute(f, digest, "the verifier confirmed it without a file:line witness");
      }
    } else {
      const quotes = v.quotes.slice(0, MAX_REFUTATION_QUOTES);
      const check = quotes.length === 0 ? "mismatch" : checkQuotes(quotes, digest, files);
      if (check === "mismatch") {
        dispute(f, digest, `the verifier refuted it, but ${quotes.length === 0 ? "quoted no line" : "its quotes do not match the change"}: ${v.reason}`);
        continue;
      }
      f.refutation = { reason: v.reason, quotes, digest };
      if (check === "match") settle(f, "dismissed", digest);
      else f.awaiting = check;
    }
  }
  syncIssuesAfterVerification(ledger, covered, before, ctx);
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

/** Replace a finding's comment with its latest occurrence, keeping the first for history. */
function updateComment(f: Finding, c: ReviewComment): void {
  if (f.original === undefined) f.original = f.comment;
  f.comment = c;
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
export function verificationInstruction(profile: Profile, args: { findings: Finding[]; background: string; changed: string[] }): string {
  return [
    `You are an independent verifier of code review findings on the uncommitted change in this worktree (${profile.project}). You did not write the change or the review. Do not modify any file. Read the code with your file tools; you cannot run commands.`,
    "",
    "What the change is for:",
    args.background,
    "",
    ...(args.changed.length > 0 ? ["Changed files:", ...args.changed.map((p) => `- ${p}`), ""] : []),
    "Findings to verify:",
    ...args.findings.flatMap((f) => [
      `- ${f.id} ${describeComment(f.comment)}`,
      ...(f.comment.evidence !== undefined ? [`  Reviewer's failure scenario: ${clip(f.comment.evidence, 1_200)}`] : []),
    ]),
    "",
    "Judge whether each defect exists in the current code, not how severe it is. For each finding return one verdict:",
    "- `confirmed`: the defect is real. In `quotes`, give your own witness, the call path or the steps that trigger it, each step a line of the current code; do not restate the reviewer's argument.",
    `- \`refuted\`: the claim is false. In \`quotes\`, give at most ${MAX_REFUTATION_QUOTES} lines of the current code that disprove it, such as the lock that is held, the caller that does not exist, or the check that covers the path. A refutation counts only if every quote matches the file.`,
    "- `uncertain`: you cannot decide. Give the argument for and against in `reason`.",
    "",
    "Each quote is one line: `path` relative to the repository root, `line` its line number in the current file, and `text` copied from that line without the line number. Your result: `verdicts`, one for every finding listed, each with `finding` (its name), `verdict`, `reason` and `quotes`.",
  ].join("\n");
}
