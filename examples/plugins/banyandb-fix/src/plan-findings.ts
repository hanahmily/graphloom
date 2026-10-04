import type { EvidenceRecord, ReferenceSet } from "@graphloom/sdk";
import { agentRuns, reviews } from "./evidence.js";
import type { ReviewVerdict } from "./evidence.js";
import { checkQuotes, clip, fileIndex, MAX_REFUTATION_QUOTES, parseVerification, type FileIndex, type PriorStatus, type Quote, type Verdict } from "./review-common.js";

/**
 * The plan-review ledger: every blocking plan-review finding of the run's
 * current generation, rebuilt from the plan's own revisions, the reviewer's
 * passes and the verifier's judgements, in evidence order. Unlike the code
 * review ledger, plan review is one pass per plan revision, not a multi-pass
 * sweep on one candidate: there is exactly one reviewer pass to judge each
 * plan version, and a finding only reaches the verifier once the planner has
 * had a chance to answer it (in a decision's `basis`, or by changing the
 * plan) and the reviewer repeats it anyway.
 */

export const PLAN_AXES = ["spec", "decisions", "reach", "test"] as const;
export type PlanAxis = (typeof PLAN_AXES)[number];

export const PLAN_SEVERITIES = ["blocking", "minor"] as const;
export type PlanSeverity = (typeof PLAN_SEVERITIES)[number];

/**
 * `resolved` is never asked of the reviewer: it is set internally once an
 * answered finding's next pass does not repeat it, mirroring the code review
 * ledger's `fixed`. The wire states are the design's own five.
 */
export type PlanFindingState = "raised" | "answered" | "confirmed" | "dismissed" | "disputed" | "resolved";

export interface PlanFinding {
  /** P1, P2, … in the order findings first appear. */
  id: string;
  axis: PlanAxis;
  severity: PlanSeverity;
  /** The finding's current occurrence. */
  detail: string;
  /** The detail it was first raised with, kept once a later occurrence replaces `detail`. */
  original?: string;
  state: PlanFindingState;
  /** The plan record (the plan-writing run's own evidence ref) the state applies to. */
  on: string;
  raisedOn: string;
  regressedOn?: string;
  /** Rounds where the planner answered and the reviewer repeated it anyway; caps at MAX_FINDING_ROUNDS. */
  rounds: number;
  /** The verifier's latest verdict. */
  verdict?: { verdict: Verdict; reason: string; quotes: Quote[] };
  /** Why the finding is disputed, when the verifier could not settle it. */
  dispute?: string;
  /** The quotes a dismissal rests on, and the candidate they matched. */
  refutation?: { reason: string; quotes: Quote[]; digest: string };
  /** Quoted paths to observe before a refutation settles. */
  awaiting?: string[];
}

export interface PlanReviewPass {
  record: EvidenceRecord;
  /** The plan record (evidence ref) this pass reviewed. */
  planRef: string;
  verdict?: "approved" | "request_changes";
  summary: string;
  productDecision?: string;
  /** Findings this pass raised: new ones, regressions and dismissed ones raised again. */
  raised: string[];
  /** Answered findings the pass was shown and gave no status. */
  missingStatus: string[];
}

export interface PlanVerification {
  record: EvidenceRecord;
  /** The candidate the quotes were checked against; undefined when nothing is implemented yet. */
  digest: string | undefined;
  covered: string[];
  problem?: string;
}

export interface PlanLedger {
  findings: PlanFinding[];
  passes: PlanReviewPass[];
  verifications: PlanVerification[];
}

const OPEN: ReadonlySet<PlanFindingState> = new Set(["raised", "answered", "confirmed", "disputed"]);
export const isPlanOpen = (f: PlanFinding | undefined): f is PlanFinding => f !== undefined && OPEN.has(f.state);

/**
 * Rebuilds the plan ledger from evidence already scoped to the run's current
 * generation (`view.evidence.filter(e => e.generation === view.generation)`):
 * a reentry into Fix plans afresh, informed by code review's confirmed
 * findings via `reentryFeedback`, not by continuing an old plan dialogue.
 */
export function planFindingLedger(evidence: EvidenceRecord[], stageId: string): PlanLedger {
  const files = fileIndex(evidence);
  const ledger: PlanLedger = { findings: [], passes: [], verifications: [] };
  const plans = new Map(agentRuns(evidence, stageId, "diagnostic").map((r) => [r.record.ref, r.status]));
  const planReviews = new Map(reviews(evidence, stageId).map((v) => [v.record.ref, v]));
  const verifications = new Map(agentRuns(evidence, stageId, "verify").map((r) => [r.record.ref, r]));
  let planRef: string | undefined;
  for (const record of evidence) {
    const planStatus = plans.get(record.ref);
    if (planStatus !== undefined) {
      if (planStatus === "completed" && planRef !== record.ref) {
        if (planRef !== undefined) answerOpenFindings(ledger, record.ref);
        planRef = record.ref;
      }
      continue;
    }
    if (planRef === undefined) continue;
    const pass = planReviews.get(record.ref);
    if (pass !== undefined) applyPlanPass(ledger, pass, planRef);
    const verification = verifications.get(record.ref);
    if (verification !== undefined) applyPlanVerification(ledger, verification.record, verification.status, verification.output, record.candidateDigest, files);
  }
  return ledger;
}

/** Findings disputed but not yet sent to a verifier, or whose quoted paths still need observation. */
export function toVerifyPlan(ledger: PlanLedger): PlanFinding[] {
  return ledger.findings.filter((f) => f.state === "disputed" && f.verdict === undefined && f.awaiting === undefined);
}

/** Quoted paths a verifier's refutation needs observed before it can settle. */
export function pathsToObservePlan(ledger: PlanLedger): string[] {
  return [...new Set(ledger.findings.flatMap((f) => f.awaiting ?? []))];
}

export interface KnownPlanFinding {
  id: string;
  state: string;
  description: string;
}

export interface KnownPlanFindings {
  open: KnownPlanFinding[];
  settled: KnownPlanFinding[];
}

/** What a plan review pass is told: open findings need a status, settled ones must not come back unnamed. */
export function knownPlanFindings(ledger: PlanLedger): KnownPlanFindings {
  const known = (f: PlanFinding) => ({ id: f.id, state: f.state, description: describePlanFinding(f) });
  return { open: ledger.findings.filter(isPlanOpen).map(known), settled: ledger.findings.filter((f) => !isPlanOpen(f)).map(known) };
}

/**
 * The valid id set for `findings[].finding`/`prior[].finding` (§4.3): every
 * finding the reviewer was shown, open or settled, by id — plus `""` for "no
 * repeat, this is new" — with each id's shown description, so a reviewer
 * that writes the description instead of the id can still be reconciled.
 */
export function planFindingReferenceSet(known: KnownPlanFindings): ReferenceSet {
  const all = [...known.open, ...known.settled];
  return { ids: ["", ...all.map((f) => f.id)], descriptions: Object.fromEntries(all.map((f) => [f.id, f.description])) };
}

export function planFindingById(ledger: PlanLedger, id: string): PlanFinding | undefined {
  return ledger.findings.find((f) => f.id === id);
}

/** A finding with the verifier's argument, for the planner, the supervisor or the pull request. */
export function describePlanFinding(f: PlanFinding): string {
  const verdict = f.state === "dismissed" ? f.refutation : f.state === "disputed" ? { reason: f.dispute ?? "", quotes: [] } : f.verdict;
  const quotes = (verdict?.quotes ?? []).slice(0, 4).map((q) => `${q.path}:${q.line} \`${clip(q.text, 160)}\``);
  const why = verdict !== undefined && verdict.reason.trim() !== "" ? ` Verifier: ${clip(verdict.reason, 600)}` : "";
  return `${f.id} ${f.axis} (${f.severity}): ${clip(f.detail, 600)}${why}${quotes.length > 0 ? ` (${quotes.join("; ")})` : ""}`;
}

/** A new plan record exists: findings open against the old one get their chance at an answer. */
function answerOpenFindings(ledger: PlanLedger, planRef: string): void {
  for (const f of ledger.findings) {
    if (isPlanOpen(f) && f.on !== planRef) {
      f.state = "answered";
      f.on = planRef;
    }
  }
}

function applyPlanPass(ledger: PlanLedger, verdict: ReviewVerdict, planRef: string): void {
  const resolvedVerdict = verdict.verdict === "approved" || verdict.verdict === "request_changes" ? verdict.verdict : undefined;
  const pass: PlanReviewPass = {
    record: verdict.record,
    planRef,
    summary: verdict.summary,
    ...(resolvedVerdict !== undefined ? { verdict: resolvedVerdict } : {}),
    ...(verdict.productDecision !== undefined ? { productDecision: verdict.productDecision } : {}),
    raised: [],
    missingStatus: [],
  };
  ledger.passes.push(pass);
  const answered = ledger.findings.filter((f) => f.state === "answered");
  for (const c of verdict.findings) {
    if (c.finding === undefined) continue;
    const known = planFindingById(ledger, c.finding);
    if (known !== undefined && answered.includes(known)) updateDetail(known, c.detail);
  }
  const status = new Map<string, PriorStatus>();
  for (const p of verdict.prior) if (!status.has(p.finding)) status.set(p.finding, p.status);
  for (const c of verdict.findings) {
    if (c.finding !== undefined && answered.some((f) => f.id === c.finding) && !status.has(c.finding)) status.set(c.finding, "still_present");
  }
  for (const f of answered) {
    const s = status.get(f.id);
    if (s === undefined) pass.missingStatus.push(f.id);
    else if (s === "still_present") disputeAgain(f, planRef);
    else resolve(f, planRef);
  }
  for (const c of verdict.findings.filter(isPlanBlocking)) {
    const known = c.finding !== undefined ? planFindingById(ledger, c.finding) : undefined;
    if (known !== undefined && (answered.includes(known) || pass.raised.includes(known.id))) continue;
    // A dismissed or resolved finding is never raised again for the same
    // plan record it settled on; only a later plan record can reopen it.
    if (known !== undefined && (known.state === "dismissed" || known.state === "resolved") && known.on === planRef) continue;
    if (known !== undefined && (known.state === "dismissed" || known.state === "resolved")) {
      reraise(known, planRef, c.detail);
      pass.raised.push(known.id);
      continue;
    }
    const axis = PLAN_AXES.find((a) => a === c.axis) ?? "spec";
    const f: PlanFinding = { id: `P${ledger.findings.length + 1}`, axis, severity: "blocking", detail: c.detail, state: "raised", on: planRef, raisedOn: planRef, rounds: 0 };
    ledger.findings.push(f);
    pass.raised.push(f.id);
  }
}

/** A comment without a severity, or explicitly `blocking`, counts as blocking; only `minor` does not. */
function isPlanBlocking(c: { severity?: string }): boolean {
  return c.severity === undefined || c.severity === "blocking";
}

function applyPlanVerification(ledger: PlanLedger, record: EvidenceRecord, status: string, output: unknown, digest: string | undefined, files: FileIndex): void {
  const covered = toVerifyPlan(ledger);
  const parsed = status === "completed" ? parseVerification(output) : { problem: `the verifier did not finish (${status})` };
  ledger.verifications.push({ record, digest, covered: covered.map((f) => f.id), ...("problem" in parsed ? { problem: parsed.problem } : {}) });
  for (const f of covered) {
    const v = "verdicts" in parsed ? parsed.verdicts.get(f.id) : undefined;
    if (v === undefined) {
      const reason = "problem" in parsed ? parsed.problem : "the verifier gave no verdict";
      // Record the attempt as a verdict too (uncertain), not just a dispute
      // reason: toVerifyPlan selects by verdict === undefined, and leaving it
      // unset here would make this finding eligible for verification again
      // next turn, dispatching the same verification forever instead of
      // letting the round cap route it to the supervisor.
      f.verdict = { verdict: "uncertain", reason, quotes: [] };
      f.dispute = reason;
      continue;
    }
    f.verdict = v;
    if (v.verdict === "uncertain") {
      f.dispute = v.reason || "the verifier could not decide";
    } else if (v.verdict === "confirmed") {
      if (v.quotes.some((q) => q.path !== "" && q.line > 0)) {
        f.state = "confirmed";
        delete f.dispute;
      } else {
        f.dispute = "the verifier confirmed it without a file:line witness";
      }
    } else {
      const quotes = v.quotes.slice(0, MAX_REFUTATION_QUOTES);
      const check = quotes.length === 0 ? "mismatch" : checkQuotes(quotes, digest, files);
      if (check === "mismatch") {
        f.dispute = `the verifier refuted it, but ${quotes.length === 0 ? "quoted no line" : "its quotes do not match the change"}: ${v.reason}`;
        continue;
      }
      f.refutation = { reason: v.reason, quotes, digest: digest! };
      if (check === "match") {
        f.state = "dismissed";
        delete f.dispute;
        delete f.awaiting;
      } else {
        f.awaiting = check;
      }
    }
  }
}

/** Replace a finding's detail with its latest occurrence, keeping the first for history. */
function updateDetail(f: PlanFinding, detail: string): void {
  if (f.original === undefined) f.original = f.detail;
  f.detail = detail;
}

function disputeAgain(f: PlanFinding, planRef: string): void {
  f.state = "disputed";
  f.on = planRef;
  f.rounds += 1;
  delete f.awaiting;
  delete f.verdict;
  delete f.dispute;
}

function resolve(f: PlanFinding, planRef: string): void {
  f.state = "resolved";
  f.on = planRef;
  delete f.awaiting;
  delete f.dispute;
}

function reraise(f: PlanFinding, planRef: string, detail: string): void {
  f.regressedOn = planRef;
  f.state = "raised";
  f.on = planRef;
  f.detail = detail;
  delete f.verdict;
  delete f.dispute;
  delete f.refutation;
  delete f.awaiting;
}

const QUOTE_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, line: { type: "integer" }, text: { type: "string" } },
  required: ["path", "line", "text"],
};

/** The plan reviewer's result (review-verdict-v1), in Pi's own looser schema style: every property named, none strictly exclusive. */
export const PLAN_REVIEW_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "request_changes"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          axis: { type: "string", enum: PLAN_AXES },
          severity: { type: "string", enum: PLAN_SEVERITIES },
          detail: { type: "string" },
          finding: { type: "string" },
        },
        required: ["axis", "severity", "detail"],
      },
    },
    prior: {
      type: "array",
      items: {
        type: "object",
        properties: { finding: { type: "string" }, status: { type: "string", enum: ["resolved", "still_present", "withdrawn"] }, reason: { type: "string" } },
        required: ["finding", "status", "reason"],
      },
    },
    productDecision: { type: "string" },
  },
  required: ["verdict", "summary", "findings", "prior"],
});

/** The verifier's assignment for a disputed plan finding: judge it against the current code, with its own evidence. */
export function planVerificationInstruction(args: { findings: PlanFinding[]; background: string; changed: string[] }): string {
  return [
    "You are an independent verifier of plan review findings for a fix to apache/skywalking-banyandb. You did not write the plan or the review. Do not modify any file. Read the code with your file tools; you cannot run commands.",
    "",
    "What the change is for:",
    args.background,
    "",
    ...(args.changed.length > 0 ? ["Changed files so far:", ...args.changed.map((p) => `- ${p}`), ""] : []),
    "Findings to verify (each one the planner answered and the reviewer repeated anyway):",
    ...args.findings.map((f) => `- ${f.id} ${f.axis} (${f.severity}): ${clip(f.detail, 1_200)}`),
    "",
    "Judge whether each defect is real, not how severe it is. For each finding return one verdict:",
    "- `confirmed`: the defect is real. In `quotes`, give your own witness, the call path or the steps that trigger it, each step a line of the current code; do not restate the reviewer's argument.",
    `- \`refuted\`: the claim is false. In \`quotes\`, give at most ${MAX_REFUTATION_QUOTES} lines of the current code that disprove it. A refutation counts only if every quote matches the file.`,
    "- `uncertain`: you cannot decide. Give the argument for and against in `reason`.",
    "",
    "Each quote is one line: `path` relative to the repository root, `line` its line number in the current file, and `text` copied from that line without the line number. Your result: `verdicts`, one for every finding listed, each with `finding` (its name), `verdict`, `reason` and `quotes`.",
  ].join("\n");
}
