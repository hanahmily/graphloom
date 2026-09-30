import type { EvidenceRecord } from "@graphloom/sdk";
import { MAX_SWEEP_PASSES, REVIEW_STAGE } from "./constants.js";
import { agentRuns, type AgentRun } from "./evidence.js";
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

/**
 * The findings ledger: every critical or high code review finding of the run,
 * rebuilt from the review passes, verification jobs and file observations in
 * evidence order. It holds no private state, so a resume or a supervisor
 * decision cannot lose it.
 */

export type FindingState = "pending" | "confirmed" | "disputed" | "fixed" | "dismissed";
export type Verdict = "confirmed" | "refuted" | "uncertain";

/** A line of a candidate file, as a verifier quotes it. */
export interface Quote {
  path: string;
  line: number;
  text: string;
}

export interface Finding {
  /** F1, F2, … in the order findings first appear. */
  id: string;
  comment: ReviewComment;
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
}

export interface ReviewPass {
  run: AgentRun;
  digest: string;
  report?: CodeReviewReport;
  problem?: string;
  /** Findings this pass raised: new ones, regressions and dismissed ones raised again. */
  raised: string[];
  /** Open findings the pass was shown and gave no status. */
  missingStatus: string[];
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
}

/** Quotes a refutation may pin; the verifier is told the same bound. */
export const MAX_REFUTATION_QUOTES = 3;
/** Shorter quotes match too easily to disprove anything. */
const MIN_QUOTE_CHARS = 8;
/** How far a quote may sit from the line it cites. */
const QUOTE_WINDOW = 3;

const OPEN: ReadonlySet<FindingState> = new Set(["pending", "confirmed", "disputed"]);
export const isOpen = (f: Finding | undefined): f is Finding => f !== undefined && OPEN.has(f.state);

export function findingLedger(evidence: EvidenceRecord[]): FindingLedger {
  const files = fileIndex(evidence);
  const ledger: FindingLedger = { findings: [], passes: [], verifications: [] };
  for (const record of evidence) {
    const digest = record.candidateDigest;
    if (digest === undefined) continue;
    const pass = agentRuns([record], REVIEW_STAGE, "review")[0];
    if (pass !== undefined) applyPass(ledger, pass, digest, files);
    const verification = agentRuns([record], REVIEW_STAGE, "diagnostic")[0];
    if (verification !== undefined) applyVerification(ledger, verification, digest, files);
  }
  return ledger;
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
  const known = (f: Finding) => ({ id: f.id, state: f.state, description: describeComment(f.comment) });
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
    `passes on this change: ${passes.length} (${sweep}); ${fixed} fixed, ${dismissed} dismissed, ${confirmed} new confirmed, ${regressions} regression(s), ${disputed} disputed` +
    (fixed === 0 && !done ? "; not converging" : "")
  );
}

/** A finding with the verifier's argument, for the implementer, the supervisor or the pull request. */
export function describeFinding(f: Finding): string {
  const verdict = f.state === "dismissed" ? f.refutation : f.state === "disputed" ? { reason: f.dispute ?? "", quotes: [] } : f.verdict;
  const quotes = (verdict?.quotes ?? []).slice(0, 4).map((q) => `${q.path}:${q.line} \`${clip(q.text, 160)}\``);
  const why = verdict !== undefined && verdict.reason.trim() !== "" ? ` Verifier: ${clip(verdict.reason, 600)}` : "";
  return `${f.id} ${describeComment(f.comment)}${why}${quotes.length > 0 ? ` (${quotes.join("; ")})` : ""}`;
}

function applyPass(ledger: FindingLedger, run: AgentRun, digest: string, files: FileIndex): void {
  const parsed = run.status === "completed" ? parseCodeReview(run.output) : { problem: `the code reviewer did not finish (${run.status})` };
  const pass: ReviewPass = { run, digest, raised: [], missingStatus: [], ...("report" in parsed ? { report: parsed.report } : { problem: parsed.problem }) };
  ledger.passes.push(pass);
  if (pass.report === undefined) return;
  const report = pass.report;
  const open = ledger.findings.filter(isOpen);
  const status = new Map<string, PriorStatus>();
  for (const p of report.prior) if (!status.has(p.finding)) status.set(p.finding, p.status);
  // A comment that names an open finding says it is still there.
  for (const c of report.comments) {
    if (c.finding !== undefined && open.some((f) => f.id === c.finding) && !status.has(c.finding)) status.set(c.finding, "still_present");
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
    const f: Finding = { id: `F${ledger.findings.length + 1}`, comment: c, state: "pending", on: digest, raisedOn: digest };
    ledger.findings.push(f);
    pass.raised.push(f.id);
  }
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

function applyVerification(ledger: FindingLedger, run: AgentRun, digest: string, files: FileIndex): void {
  const covered = toVerify(ledger, digest);
  const parsed = run.status === "completed" ? parseVerification(run.output) : { problem: `the verifier did not finish (${run.status})` };
  ledger.verifications.push({ run, digest, covered: covered.map((f) => f.id), ...("problem" in parsed ? { problem: parsed.problem } : {}) });
  for (const f of covered) {
    const v = "verdicts" in parsed ? parsed.verdicts.get(f.id) : undefined;
    if (v === undefined) {
      dispute(f, digest, "problem" in parsed ? parsed.problem : "the verifier gave no verdict");
      continue;
    }
    f.verdict = v;
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

type FileIndex = Map<string, string>;
const fileKey = (digest: string, path: string) => `${digest}\n${path}`;

/** Observed file bytes by candidate and path; a file's bytes on one candidate never change. */
function fileIndex(evidence: EvidenceRecord[]): FileIndex {
  const files: FileIndex = new Map();
  for (const e of evidence) {
    const payload = e.payload as { path?: unknown; bytes?: unknown } | undefined;
    if (e.kind === "file" && e.candidateDigest !== undefined && typeof payload?.path === "string") {
      files.set(fileKey(e.candidateDigest, payload.path), String(payload.bytes ?? ""));
    }
  }
  return files;
}

/**
 * A repository file path the controller can observe: relative, no `.` or `..`
 * segment, outside `.git`, and naming a file by its extension, since observing
 * a directory or an escaping path stops the run.
 */
export function observablePath(p: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(p)) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s === ".git")) return false;
  return parts.at(-1)!.indexOf(".", 1) > 0;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The quote's text, whitespace collapsed, is on a line within three of the one it cites. */
export function quoteMatches(q: Quote, bytes: string): boolean {
  const text = collapse(q.text);
  if (text.length < MIN_QUOTE_CHARS || q.line < 1) return false;
  const lines = bytes.split("\n");
  for (let i = Math.max(1, q.line - QUOTE_WINDOW); i <= Math.min(lines.length, q.line + QUOTE_WINDOW); i += 1) {
    if (collapse(lines[i - 1]!).includes(text)) return true;
  }
  return false;
}

/** "match", "mismatch", or the paths still to observe on `digest`. */
function checkQuotes(quotes: Quote[], digest: string, files: FileIndex): "match" | "mismatch" | string[] {
  const missing: string[] = [];
  for (const q of quotes) {
    if (!observablePath(q.path)) return "mismatch";
    const bytes = files.get(fileKey(digest, q.path));
    if (bytes === undefined) {
      if (!missing.includes(q.path)) missing.push(q.path);
    } else if (!quoteMatches(q, bytes)) {
      return "mismatch";
    }
  }
  return missing.length > 0 ? missing : "match";
}

const VERDICTS: readonly Verdict[] = ["confirmed", "refuted", "uncertain"];

const QUOTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "line", "text"],
  properties: { path: { type: "string" }, line: { type: "integer" }, text: { type: "string" } },
};

/** The verifier's result (finding-verification-v1): every property required, none extra. */
export const VERIFICATION_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "verdict", "reason", "quotes"],
        properties: {
          finding: { type: "string" },
          verdict: { type: "string", enum: VERDICTS },
          reason: { type: "string" },
          quotes: { type: "array", items: QUOTE_SCHEMA },
        },
      },
    },
  },
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The verifier's verdicts by finding; conflicting verdicts for one finding count as uncertain. */
export function parseVerification(output: unknown): { verdicts: Map<string, { verdict: Verdict; reason: string; quotes: Quote[] }> } | { problem: string } {
  const list = object(output)?.verdicts;
  if (!Array.isArray(list)) return { problem: "the verifier returned no verdicts" };
  const verdicts = new Map<string, { verdict: Verdict; reason: string; quotes: Quote[] }>();
  for (const raw of list) {
    const v = object(raw);
    const verdict = VERDICTS.find((x) => x === v?.verdict);
    if (v === undefined || typeof v.finding !== "string" || verdict === undefined) continue;
    const quotes = (Array.isArray(v.quotes) ? v.quotes : []).flatMap((q) => {
      const o = object(q);
      return o !== undefined && typeof o.path === "string" && typeof o.text === "string" && Number.isInteger(o.line) ? [{ path: o.path, line: o.line as number, text: o.text }] : [];
    });
    const id = v.finding.trim();
    const earlier = verdicts.get(id);
    const reason = String(v.reason ?? "");
    verdicts.set(id, earlier === undefined || earlier.verdict === verdict ? { verdict, reason: earlier?.reason ?? reason, quotes: earlier?.quotes ?? quotes } : { verdict: "uncertain", reason: "the verifier gave conflicting verdicts", quotes: [] });
  }
  return { verdicts };
}

/** The verifier's assignment: judge each finding against the current code, with its own evidence. */
export function verificationInstruction(args: { findings: Finding[]; background: string; changed: string[] }): string {
  return [
    "You are an independent verifier of code review findings on the uncommitted change in this worktree (apache/skywalking-banyandb). You did not write the change or the review. Do not modify any file. Read the code with your file tools; you cannot run commands.",
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
