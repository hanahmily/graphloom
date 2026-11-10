// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The review layer's contracts and its per-aspect sweep (design §8.1), from the evidence alone. This is issue-fix's review
 * convergence with one candidate, the reviewed head, run once per aspect: a pass reviews the scope; every finding it raised
 * is verified by a read-only verifier in a fresh session on another harness; when one was confirmed or disputed another pass
 * runs (at most `MAX_SWEEP_PASSES`); the sweep ends at the first pass whose findings were all dismissed. The ledger is a
 * pure function of the recorded passes and verdicts, so a resume or a supervisor decision cannot lose it.
 *
 * Contract `pr-code-review-v1` is `code-review-v2` plus `side`, `suggestion`, `aspect`, `kind`, `principle` and `repro` (a
 * behavioral comment's test, design §8.2). A pass's behavioral findings that carry a test are run in the Docker sandbox, one at
 * a time, before they are verified (`repro.ts`); the verifier reads the test and its recorded run, and `proof.ts` reads the
 * finding's `proof`, which this module computes from the recorded runs and the verdict alone.
 *
 * On a later head (design §9.3) the first pass is also given the findings an earlier head left open, already re-anchored to this
 * head, and judges each `still_present` or `fixed`; the verifier confirms the ones still present like a new finding (confirmed
 * keeps it open, refuted makes it fixed). A new comment that overlaps a closed or an earlier finding is suppressed before it is verified.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { isAspect, type Aspect } from "./aspects.js";
import { agentRuns, commandRuns, succeeded, reportText, type AgentRun, type CommandRun } from "./evidence.js";
import { overlaps as priorOverlaps } from "./prior.js";
import { hasTest, judgeRun, reproCommandId, reproProblems, REPRO_SCHEMA, reproSpec, type FindingProof, type Repro, type ReproLanguage, type ReproRunSpec } from "./repro.js";
import { treeQuotePlan, readTreeQuotes, type TreeQuotePlan } from "./treequotes.js";

export const REVIEW_SCHEMA_NAME = "pr-code-review-v1";
export const VERIFY_SCHEMA_NAME = "pr-finding-verification-v1";
export const REVIEW_REFERENCES = ["comments[].finding", "comments[].principle", "prior[].finding"];
export const VERIFY_REFERENCES = ["verdicts[].finding"];
/** Passes one aspect may run on the head (issue-fix's `MAX_SWEEP_PASSES`); hitting it is noted unsaturated and does not fail the stage. */
export const MAX_SWEEP_PASSES = 4;
/** Results that may come back unusable (against the contract or the deterministic rules) before the supervisor. */
export const MAX_REVIEW_RETRIES = 2;
/** The longest suggestion kept, in lines (`suggestions.maxLines`). */
export const MAX_SUGGESTION_LINES = 20;
const DEFAULT_MAX_TEST_BYTES = 16 * 1024;
const MAX_CONTENT_CHARS = 4_000;
const MAX_SPAN_LINES = 400;
const MIN_QUOTE_CHARS = 8;

export const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SIDES = ["RIGHT", "LEFT"] as const;
export type CommentSide = (typeof SIDES)[number];
export const KINDS = ["behavioral", "non-behavioral"] as const;
export type FindingKind = (typeof KINDS)[number];
export const REVIEW_VERDICTS = ["confirmed", "refuted", "uncertain"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type FindingState = "pending" | "confirmed" | "disputed" | "dismissed";

export const PRIOR_STATUSES = ["still_present", "fixed"] as const;
export type PriorStatus = (typeof PRIOR_STATUSES)[number];

const ASPECT_ENUM = ["correctness", "maintainability", "security"];

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["comments", "summary", "prior"],
  properties: {
    // The judgment of each earlier finding the assignment lists (empty when it lists none).
    prior: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "status", "reason"],
        properties: { finding: { type: "string" }, status: { type: "string", enum: [...PRIOR_STATUSES] }, reason: { type: "string" } },
      },
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "side", "start_line", "end_line", "aspect", "kind", "severity", "content", "suggestion", "finding", "evidence", "distinct", "principle", "repro"],
        properties: {
          path: { type: "string" },
          side: { type: "string", enum: [...SIDES] },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
          aspect: { type: "string", enum: ASPECT_ENUM },
          kind: { type: "string", enum: [...KINDS] },
          severity: { type: "string", enum: [...SEVERITIES] },
          content: { type: "string" },
          suggestion: { type: "string" },
          finding: { type: "string" },
          evidence: { type: "string" },
          distinct: { type: "boolean" },
          // The id of a design principle (design §8.1) the comment says the change breaks; "" for none. The job constrains it to the ids given to this reviewer.
          principle: { type: "string" },
          // A behavioral comment's test (design §8.2); every field empty when the reviewer writes none.
          repro: REPRO_SCHEMA,
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["total_files", "reviewed_files", "skipped"],
      properties: {
        total_files: { type: "integer" },
        reviewed_files: { type: "integer" },
        skipped: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "reason"], properties: { path: { type: "string" }, reason: { type: "string" } } } },
      },
    },
  },
};

export const VERIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "verdict", "kind", "witness", "quotes", "reason", "fixes", "test"],
        properties: {
          finding: { type: "string" },
          verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
          kind: { type: "string", enum: [...KINDS] },
          witness: { type: "string" },
          quotes: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "line", "text"], properties: { path: { type: "string" }, line: { type: "integer" }, text: { type: "string" } } } },
          reason: { type: "string" },
          fixes: { type: "boolean" },
          // For a behavioral finding with a test: whether the test, as the graph ran it, demonstrates the claimed bug (design §8.2). false (reason "") when there is no test.
          test: { type: "object", additionalProperties: false, required: ["demonstrates", "reason"], properties: { demonstrates: { type: "boolean" }, reason: { type: "string" } } },
        },
      },
    },
  },
};

export interface ReviewComment {
  path: string;
  side: CommentSide;
  start_line: number;
  end_line: number;
  aspect: Aspect;
  kind: FindingKind;
  severity: Severity;
  content: string;
  suggestion: string;
  finding: string;
  evidence: string;
  distinct: boolean;
  /** The design principle the comment says the change breaks (design §8.1); "" or absent for none. */
  principle?: string;
  /** The test of a behavioral comment (design §8.2); absent or with empty text for none. */
  repro?: Repro;
}

export interface PassSummary {
  total_files: number;
  reviewed_files: number;
  skipped: Array<{ path: string; reason: string }>;
}

export interface VerdictQuote {
  path: string;
  line: number;
  text: string;
}

/** What a verifier said of one finding, as recorded. */
export interface FindingVerdict {
  verdict: ReviewVerdict;
  kind: FindingKind;
  witness: string;
  quotes: VerdictQuote[];
  reason: string;
  fixes: boolean;
  /** Whether the reviewer's test, as run, demonstrates the claimed bug (design §8.2); absent in a record written before tests. */
  test?: { demonstrates: boolean; reason: string };
}

export interface Finding {
  /** `F1`, `F2`, ... in the order they first appear across the review (aspect by aspect). */
  id: string;
  /** The aspect the comment declared; it is held to that aspect's rules and listed under it. */
  aspect: Aspect;
  /** The aspect whose pass raised it, and so whose verifier judged it. */
  raisedBy: Aspect;
  pass: number;
  path: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  severity: Severity;
  /** After the verifier's reclassification. */
  kind: FindingKind;
  content: string;
  suggestion: string;
  evidence: string;
  distinct: boolean;
  /** The design principle the finding says the change breaks; absent for none (and in records written before it existed). */
  principle?: string;
  /** The reviewer's test (design §8.2), when it wrote one: its text is what the graph ran and the verifier read. */
  repro?: Repro;
  /** What the graph and the verifier made of the test (`proofOf` reads it); absent for a non-behavioral finding and in records written before tests. */
  proof?: FindingProof;
  /** An earlier head's finding that this sweep re-judges (design §9.3), not one it raised; never in an aspect record's `findings`. */
  prior?: boolean;
  state: FindingState;
  /** The passes that raised it again by name. */
  reaffirmed: number[];
  verdict?: FindingVerdict;
  /** Why it is disputed, or what the plugin did to the verdict (a reclassification, a dropped suggestion). */
  notes: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** What the plugin tells a pass about the scope and the findings it knows, to read the pass's result against. */
export interface PassContext {
  aspect: Aspect;
  /** The files in scope, as repository-relative paths. */
  scope: ReadonlySet<string>;
  /** The ids of findings already raised in this review (any aspect). */
  known: ReadonlySet<string>;
  /** The ids of the design principles given to this reviewer (design §8.1); none means a comment names no principle. */
  principles?: ReadonlySet<string>;
  /** The ids of the earlier findings this pass must judge: each exactly once in `prior`. */
  prior?: ReadonlySet<string>;
  /** The longest test file a comment's `repro` may carry, in bytes (the profile's `review.repro.maxTestBytes`). */
  maxTestBytes?: number;
}

export interface ParsedPass {
  comments: ReviewComment[];
  summary: PassSummary;
  /** The pass's judgment of each earlier finding it was given. */
  prior: Array<{ finding: string; status: PriorStatus; reason: string }>;
}

/** An earlier head's open finding as the first pass is given it: re-anchored to this head, or outdated (no longer anchored to its diff). */
export interface PriorFinding {
  id: string;
  path: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  /** The anchor could not be found again on this head: the reviewer looks for the code in the file. */
  outdated: boolean;
  severity: Severity;
  kind: FindingKind;
  /** The finding's text as it was posted. */
  text: string;
}

/** What a sweep concluded of one earlier finding. */
export interface PriorOutcome {
  id: string;
  status: "open" | "fixed";
  /** Who decided: the reviewer, the verifier's refutation, the file leaving the change, or `carried` (not re-checked on this head). */
  how: "reviewer" | "verifier" | "gone" | "carried";
  reason: string;
  path: string;
  side: CommentSide;
  line: number;
  endLine: number;
  outdated: boolean;
}

/** A pass's result, read against the deterministic rules: the comments and the summary, or every problem at once. */
export function parsePass(output: unknown, ctx: PassContext): ParsedPass | { problems: string[] } {
  if (!isObj(output) || !Array.isArray(output.comments) || !isObj(output.summary)) return { problems: ["the result is not an object with comments and summary"] };
  const problems: string[] = [];
  const comments: ReviewComment[] = [];
  output.comments.forEach((raw, i) => {
    const at = `comments[${i}]`;
    if (!isObj(raw)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const c = raw as Partial<Record<keyof ReviewComment, unknown>>;
    const start = c.start_line;
    const end = c.end_line;
    if (typeof c.path !== "string" || !ctx.scope.has(c.path)) problems.push(`${at}.path ${JSON.stringify(String(c.path).slice(0, 80))} is not a file in the review's scope`);
    if (!SIDES.includes(c.side as CommentSide)) problems.push(`${at}.side must be RIGHT (the head) or LEFT (the base)`);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 1 || (end as number) < (start as number) || (end as number) - (start as number) >= MAX_SPAN_LINES) problems.push(`${at} needs 1 <= start_line <= end_line, a range of at most ${MAX_SPAN_LINES} lines`);
    if (!isAspect(c.aspect)) problems.push(`${at}.aspect must be correctness, maintainability or security`);
    if (!KINDS.includes(c.kind as FindingKind)) problems.push(`${at}.kind must be behavioral or non-behavioral`);
    else if (c.aspect === "correctness" && c.kind === "non-behavioral") problems.push(`${at}: a correctness finding is behavioral; a comment that claims no wrong behavior belongs to maintainability`);
    if (!SEVERITIES.includes(c.severity as Severity)) problems.push(`${at}.severity must be P0, P1, P2 or P3`);
    if (typeof c.content !== "string" || c.content.trim() === "" || c.content.length > MAX_CONTENT_CHARS) problems.push(`${at}.content must be text of at most ${MAX_CONTENT_CHARS} characters`);
    if (typeof c.finding !== "string" || (c.finding !== "" && !ctx.known.has(c.finding))) problems.push(`${at}.finding must be "" for a new finding, or the id of one already reported`);
    if (typeof c.suggestion !== "string" || typeof c.evidence !== "string" || typeof c.distinct !== "boolean") problems.push(`${at} needs suggestion and evidence (text, "" for none) and distinct (true or false)`);
    // A result without the field (a recorded one, or an executor that left it out) names no principle.
    if (c.principle !== undefined && (typeof c.principle !== "string" || (c.principle !== "" && !(ctx.principles ?? new Set<string>()).has(c.principle)))) {
      problems.push(`${at}.principle must be "" or ${ctx.principles !== undefined && ctx.principles.size > 0 ? `one of the principle ids you were given (${[...ctx.principles].join(", ")})` : "empty: no design principle was given to you"}`);
    }
    problems.push(...reproProblems(c.repro, { path: String(c.path), kind: String(c.kind) }, at, ctx.maxTestBytes ?? DEFAULT_MAX_TEST_BYTES));
    if (problems.length === 0 || problems.every((p) => !p.startsWith(at))) comments.push(c as unknown as ReviewComment);
  });
  const priorIds = ctx.prior ?? new Set<string>();
  const prior: ParsedPass["prior"] = [];
  if (priorIds.size > 0) {
    const raw = Array.isArray(output.prior) ? output.prior : [];
    const seen = new Set<string>();
    raw.forEach((p, i) => {
      if (!isObj(p) || typeof p.finding !== "string" || !priorIds.has(p.finding) || !PRIOR_STATUSES.includes(p.status as PriorStatus) || typeof p.reason !== "string") {
        problems.push(`prior[${i}] must name one of the earlier findings listed to you, with status still_present or fixed and a reason`);
      } else if (seen.has(p.finding)) problems.push(`prior[${i}]: ${p.finding} is judged twice`);
      else {
        seen.add(p.finding);
        prior.push({ finding: p.finding, status: p.status as PriorStatus, reason: oneLine(p.reason) });
      }
    });
    const left = [...priorIds].filter((id) => !seen.has(id));
    if (left.length > 0) problems.push(`prior must judge every earlier finding listed to you; missing ${left.join(", ")}`);
  }
  const s = output.summary as Record<string, unknown>;
  const skipped = Array.isArray(s.skipped) ? (s.skipped as Array<{ path?: unknown; reason?: unknown }>) : [];
  if (!Number.isSafeInteger(s.total_files) || !Number.isSafeInteger(s.reviewed_files)) problems.push("summary.total_files and summary.reviewed_files must be integers");
  else if (s.total_files !== ctx.scope.size || s.reviewed_files !== s.total_files || skipped.length > 0) {
    problems.push(`the pass must review every one of the ${ctx.scope.size} file(s) in scope and skip none (it reported ${String(s.reviewed_files)} of ${String(s.total_files)} reviewed, ${skipped.length} skipped)`);
  }
  if (problems.length > 0) return { problems };
  return { comments, summary: { total_files: s.total_files as number, reviewed_files: s.reviewed_files as number, skipped: [] }, prior };
}

/** A verifier's result against the pending findings: one verdict each, or every problem at once (a finding left out is judged later, as disputed). */
export function parseVerification(output: unknown, pending: ReadonlySet<string>): { verdicts: Map<string, FindingVerdict>; ignored: string[] } | { problems: string[] } {
  if (!isObj(output) || !Array.isArray(output.verdicts)) return { problems: ["the result is not an object with verdicts"] };
  const problems: string[] = [];
  const verdicts = new Map<string, FindingVerdict>();
  const ignored: string[] = [];
  output.verdicts.forEach((raw, i) => {
    const at = `verdicts[${i}]`;
    if (!isObj(raw)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const v = raw as Partial<Record<keyof FindingVerdict | "finding", unknown>>;
    if (typeof v.finding !== "string" || !pending.has(v.finding)) {
      ignored.push(String(v.finding).slice(0, 40));
      return;
    }
    if (!REVIEW_VERDICTS.includes(v.verdict as ReviewVerdict)) problems.push(`${at}.verdict must be confirmed, refuted or uncertain`);
    if (!KINDS.includes(v.kind as FindingKind)) problems.push(`${at}.kind must be behavioral or non-behavioral`);
    if (typeof v.witness !== "string" || typeof v.reason !== "string" || typeof v.fixes !== "boolean" || !Array.isArray(v.quotes)) problems.push(`${at} needs witness and reason (text), quotes (a list) and fixes (true or false)`);
    const t = (v as { test?: unknown }).test;
    if (t !== undefined && (!isObj(t) || typeof t.demonstrates !== "boolean" || typeof t.reason !== "string")) problems.push(`${at}.test must be { demonstrates: true or false, reason: text }`);
    if (problems.length === 0) {
      verdicts.set(v.finding, {
        verdict: v.verdict as ReviewVerdict,
        kind: v.kind as FindingKind,
        witness: (v.witness as string).trim(),
        quotes: (v.quotes as unknown[]).filter(isObj).map((q) => ({ path: String(q.path ?? ""), line: Number(q.line), text: String(q.text ?? "") })),
        reason: oneLine(v.reason as string),
        fixes: v.fixes as boolean,
        ...(isObj(t) ? { test: { demonstrates: t.demonstrates as boolean, reason: oneLine(t.reason as string) } } : {}),
      });
    }
  });
  return problems.length > 0 ? { problems } : { verdicts, ignored };
}

/**
 * `path:line` with a repository-relative path and a positive line: what a confirmation's own call path must name.
 * The path needs no extension (Makefile:12, Dockerfile:8, bin/build:3), is not absolute and has no `..` segment.
 */
export const WITNESS = /^(?!\/)(?!(?:[^\n:]*\/)?\.\.(?:\/|:))[^\s:][^\n:]*:[1-9][0-9]*/;

/** The quotes a refutation pins, when they are usable (1 to 3, a relative path, a positive line, at least eight characters). */
function quoteProblem(v: FindingVerdict): string | undefined {
  if (v.quotes.length < 1 || v.quotes.length > 3) return `a refutation pins one to three quotes of the head's lines; it gave ${v.quotes.length}`;
  for (const q of v.quotes) {
    if (q.path === "" || q.path.startsWith("/") || q.path.split("/").some((s) => s === ".." || s === "") || /[\n\u0000]/.test(q.path)) return `a quote names the path ${JSON.stringify(q.path.slice(0, 60))}, which is not a repository-relative file`;
    if (!Number.isSafeInteger(q.line) || q.line < 1) return "a quote has no line";
    if (oneLine(q.text).length < MIN_QUOTE_CHARS) return `a quote is shorter than ${MIN_QUOTE_CHARS} characters`;
  }
  return undefined;
}

/** The refutations' quotes as a tree check: each one against the head's working tree, with command ids of this pass's own. */
export function quotePlan(findings: ReadonlyArray<Finding>, base: string | undefined, idPrefix: string): TreeQuotePlan {
  return treeQuotePlan(findings.filter((f) => f.verdict?.verdict === "refuted" && quoteProblem(f.verdict) === undefined).map((f) => ({ id: f.id, tree: "head" as const, quotes: f.verdict!.quotes })), base, idPrefix);
}

/** The proof once the verifier has judged (design §8.2 condition 4): a failing test proves the finding only when the verifier confirmed it and judged that the test demonstrates the claimed bug. */
export function settledProof(base: FindingProof, v: FindingVerdict): FindingProof {
  if (base.state !== "proven" || v.verdict !== "confirmed" || v.test?.demonstrates === true) return base;
  return { state: "unproven", reason: "does not demonstrate", record: base.record };
}

/** The suggestion the draft keeps, or why it does not: the verifier says it fixes the finding, it is short, and it replaces exactly the commented RIGHT range. */
export function keptSuggestion(f: Finding): { text: string } | { dropped: string } | undefined {
  if (f.suggestion.trim() === "") return undefined;
  if (f.verdict?.verdict !== "confirmed") return { dropped: "the finding is not confirmed" };
  if (f.side !== "RIGHT") return { dropped: "a suggestion replaces lines of the head, and this comment is on the base" };
  // Design §8.2: a behavioral finding's suggestion is kept only when the test passes with it applied (the fix run), which a later part adds.
  if (f.kind === "behavioral") return { dropped: "a suggestion of a behavioral finding is kept only when its test passes with the suggestion applied, and the fix run is not part of this version" };
  if (!f.verdict.fixes) return { dropped: "the verifier did not say the suggestion fixes the finding" };
  const lines = f.suggestion.replace(/\n$/, "").split("\n").length;
  if (lines > MAX_SUGGESTION_LINES) return { dropped: `it is ${lines} lines, more than ${MAX_SUGGESTION_LINES}` };
  return { text: f.suggestion.replace(/\n$/, "") };
}

// ---- the sweep ----

export interface PassRecord {
  n: number;
  /** The pass's own account of the files it reviewed. */
  reviewed: number;
  raised: string[];
  reaffirmed: string[];
  /** Comments of severity P3, which are not verified (the profile has no `comments.nits`). */
  nits: number;
  /** Comments folded into another of the same pass on overlapping lines. */
  merged: number;
  /** New comments left out because they overlap a closed or an earlier finding (design §9.3). */
  suppressed?: number;
}

/** What an aspect's sweep recorded: everything the draft and the validators need, without the agent evidence. */
export interface AspectRecord {
  schema: "pr-review-aspect-v1";
  aspect: Aspect;
  /** The harnesses that ran the aspect's reviewer passes and its verifier. */
  reviewer: string;
  verifier: string;
  /** How each pass started: seeded or forked, and why. */
  context: { kind: "seeded" | "forked"; reason: string };
  scopeFiles: number;
  passes: PassRecord[];
  findings: Finding[];
  /** The sweep hit `MAX_SWEEP_PASSES` with the last pass still raising findings that survived verification. */
  unsaturated: boolean;
  /** What this head's sweep concluded of each earlier finding it re-judged; absent for a run with none. */
  prior?: PriorOutcome[];
}

export const ASPECT_RECORD_SCHEMA = "pr-review-aspect-v1";
export const aspectRecordId = (aspect: Aspect): string => `review-aspect-${aspect}`;
export const aspectRecordJson = (r: AspectRecord): string => JSON.stringify(r);

/** The record a command wrote, read back; undefined when it is not an aspect record of that aspect. */
export function parseAspectRecord(json: string, aspect: Aspect): AspectRecord | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObj(v) || v.schema !== ASPECT_RECORD_SCHEMA || v.aspect !== aspect || !Array.isArray(v.passes) || !Array.isArray(v.findings) || !isObj(v.context)) return undefined;
    return v as unknown as AspectRecord;
  } catch {
    return undefined;
  }
}

/** The command ids of an aspect pass's quote checks: `rvq-<aspect>-<findings known before the pass>` keeps passes apart. */
export const quotePrefix = (aspect: Aspect, pass: number): string => `rvq-${aspect}-${pass}`;

export type AspectFlow =
  | { state: "pass"; n: number; feedback: string[]; known: Finding[]; /** The earlier findings the first pass judges. */ prior: PriorFinding[] }
  | { state: "repro"; finding: Finding; plan: ReproPlan; run: ReproRunSpec }
  | { state: "verify"; n: number; findings: Finding[]; feedback: string[] }
  | { state: "quotes"; commands: EnvironmentCommand[] }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; findings: Finding[]; passes: PassRecord[]; unsaturated: boolean; refs: string[]; prior: PriorOutcome[] };

/** Where and how a finding's test runs: its language, the TypeScript workspace and the sandbox image. */
export interface ReproPlan {
  language: ReproLanguage;
  workspace: string;
  image: string;
}

/** What the sweep needs of the sandbox and the profile to run the reviewers' tests (design §8.2). */
export interface ReproEnv {
  config: { enabled: boolean; perFindingMs: number; timeBudgetMs: number; maxTestBytes: number };
  /** Tests of earlier aspects of this head that ran: they count against the time budget. */
  used: number;
  /** The plan for a test of the cited file, or why the sandbox cannot run it. */
  plan(path: string): ReproPlan | { reason: string };
  /** The sandbox's refusal of a job after the evidence record `ref`, when it refused one (Docker or the image is missing). */
  refusedSince(ref: string): string | undefined;
}

/** Seconds each of a test's two runs may take: half the finding's cap (design §8.2: `perFindingMs`). */
export const reproRunSeconds = (config: { perFindingMs: number }): number => Math.max(5, Math.floor(config.perFindingMs / 2000));

/** The most tests one head's review runs: the time budget over the per-finding cap. */
export const maxReproRuns = (config: { perFindingMs: number; timeBudgetMs: number }): number => Math.max(1, Math.floor(config.timeBudgetMs / config.perFindingMs));

export interface AspectSpec {
  aspect: Aspect;
  scope: ReadonlySet<string>;
  /** The ids of the design principles given to this aspect's reviewer (design §8.1). */
  principles?: ReadonlySet<string>;
  /** The findings the earlier aspects recorded: their ids are known, and numbering goes on after them. */
  earlier: readonly Finding[];
  /** The number the first new finding of the review takes: after the ledger's last `F<n>` (1 for a first run). */
  firstId?: number;
  /** The earlier heads' open findings of this aspect that this head's first pass judges. */
  prior?: readonly PriorFinding[];
  /** Places where a new comment is not raised again: closed earlier findings and the ones judged here, re-anchored to this head. */
  suppress?: ReadonlyArray<{ path: string; side: CommentSide; start: number; end: number }>;
  base: string | undefined;
  retryable?: (r: CommandRun) => boolean;
  /** The reviewers' tests (design §8.2); absent runs none, as `review.repro.enabled: false`. */
  repro?: ReproEnv;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Two comments of one pass on the same file and side whose lines overlap are one problem, unless the reviewer marked them `distinct`. */
const overlaps = priorOverlaps;

/**
 * Where an aspect's sweep stands, from the evidence after the aspect's own start (`evidence` is that slice): the reviewer
 * pass, the verifier's job for the findings the pass raised, the check of the refutations' quotes, and the next pass or the end.
 */
export function aspectFlow(evidence: readonly EvidenceRecord[], spec: AspectSpec): AspectFlow {
  const index = new Map(evidence.map((e, i) => [e.ref, i] as const));
  const at = (r: { record: EvidenceRecord }): number => index.get(r.record.ref) ?? 0;
  const events: Array<{ kind: "pass" | "verify"; run: AgentRun }> = [
    ...agentRuns(evidence, REVIEW_SCHEMA_NAME).map((run) => ({ kind: "pass" as const, run })),
    ...agentRuns(evidence, VERIFY_SCHEMA_NAME).map((run) => ({ kind: "verify" as const, run })),
  ].sort((a, b) => at(a.run) - at(b.run));
  const findings: Finding[] = [];
  const passes: PassRecord[] = [];
  const given = spec.prior ?? [];
  // The earlier findings are judged beside the new ones, but are never among them: they keep their ids and leave the sweep's numbering and saturation alone.
  const priors: Finding[] = given.map((p) => ({ id: p.id, aspect: spec.aspect, raisedBy: spec.aspect, pass: 1, path: p.path, side: p.side, startLine: p.startLine, endLine: p.endLine, severity: p.severity, kind: p.kind, content: p.text, suggestion: "", evidence: "", distinct: true, prior: true, state: "pending", reaffirmed: [], notes: [] }));
  const said = new Map<string, { status: PriorStatus; reason: string }>();
  const known = (): Set<string> => new Set([...spec.earlier, ...findings, ...priors].map((f) => f.id));
  let next = (spec.firstId ?? 1) + spec.earlier.length;
  let phase: "start" | "verify" | "need-pass" | "saturated" | "unsaturated" = "start";
  let retries = 0;
  let feedback: string[] = [];
  /** The ids the latest pass raised, awaiting verification, and the verdicts read for them. */
  let awaiting: string[] = [];
  let verdicts: Map<string, FindingVerdict> | undefined;
  let verifyRetries = 0;
  let verifyFeedback: string[] = [];
  const refs: string[] = [];

  /** The latest pass's behavioral findings that carry a test: they run before they are verified. */
  let reproFor: Finding[] = [];
  let passRef = "";
  const noTest = (f: Finding): FindingProof => ({ state: "unproven", reason: hasTest(f.repro) ? "inconclusive (the test was not run)" : "no test" });
  /** What each test's recorded run says (design §8.2 conditions 1 to 3), and the next run still to make, in the order P0 first. */
  const reproProofs = (): { proofs: Map<string, FindingProof>; next?: { finding: Finding; plan: ReproPlan; run: ReproRunSpec } } => {
    const proofs = new Map<string, FindingProof>();
    const env = spec.repro;
    let used = env?.used ?? 0;
    let next: { finding: Finding; plan: ReproPlan; run: ReproRunSpec } | undefined;
    const order = [...reproFor].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
    for (const f of order) {
      const repro = f.repro!;
      const unproven = (reason: string): void => void proofs.set(f.id, { state: "unproven", reason });
      if (env === undefined || !env.config.enabled) {
        unproven("execution disabled by the profile");
        continue;
      }
      const plan = env.plan(f.path);
      if ("reason" in plan) {
        unproven(`sandbox unavailable (${plan.reason})`);
        continue;
      }
      const run: ReproRunSpec = { finding: f.id, language: plan.language, repro, workspace: plan.workspace, timeoutSeconds: reproRunSeconds(env.config) };
      const made = commandRuns(evidence, reproCommandId(f.id)).at(-1);
      if (made !== undefined) {
        used += 1;
        proofs.set(f.id, judgeRun(f, repro, plan.language, made, reproSpec(run), plan.image));
        continue;
      }
      if (used >= maxReproRuns(env.config)) {
        unproven("repro budget exhausted");
        continue;
      }
      const refused = env.refusedSince(passRef);
      if (refused !== undefined) {
        unproven(`sandbox unavailable (${refused})`);
        continue;
      }
      used += 1;
      next ??= { finding: f, plan, run };
    }
    return { proofs, ...(next !== undefined ? { next } : {}) };
  };

  type Resolved = { kind: "ok"; blocking: boolean } | { kind: "quotes"; commands: EnvironmentCommand[] } | { kind: "supervise"; reason: string; refs: string[] };
  /** Applies the verifier's verdicts to the findings the latest pass raised: a confirmation needs its own witness, a refutation quotes the tree shows, anything else is disputed. */
  const resolve = (): Resolved => {
    const pending = [...findings, ...priors].filter((f) => awaiting.includes(f.id));
    const n = passes.length;
    const ran = reproProofs();
    for (const f of pending) {
      const v = verdicts!.get(f.id);
      if (v === undefined) {
        f.state = "disputed";
        f.notes.push("the verifier gave no verdict for it");
        if (f.kind === "behavioral") f.proof = ran.proofs.get(f.id) ?? noTest(f);
        continue;
      }
      f.verdict = v;
      if (v.kind === "behavioral" && f.kind === "non-behavioral") {
        f.kind = "behavioral";
        f.notes.push("the verifier reclassified it as behavioral: it claims wrong behavior");
      }
      if (f.kind === "behavioral") f.proof = settledProof(ran.proofs.get(f.id) ?? noTest(f), v);
      if (v.verdict === "confirmed") {
        if (WITNESS.test(v.witness)) f.state = "confirmed";
        else {
          f.state = "disputed";
          f.notes.push("the verifier confirmed it without a path:line witness of its own");
        }
      } else if (v.verdict === "uncertain") {
        f.state = "disputed";
        f.notes.push("the verifier could not decide");
      } else {
        const bad = quoteProblem(v);
        if (bad !== undefined) {
          f.state = "disputed";
          f.notes.push(`the refutation is not usable: ${bad}`);
        }
      }
    }
    const refuted = pending.filter((f) => f.verdict?.verdict === "refuted" && f.state === "pending");
    if (refuted.length > 0) {
      const plan = quotePlan(refuted, spec.base, quotePrefix(spec.aspect, n));
      if (plan.unavailable !== undefined) return { kind: "supervise", reason: plan.unavailable, refs: refs.slice(-10) };
      const runs = commandRuns(evidence).filter((r) => r.command.id.startsWith(`${quotePrefix(spec.aspect, n)}-`));
      const missing: EnvironmentCommand[] = [];
      const texts: string[] = [];
      for (const c of plan.commands) {
        const run = runs.filter((r) => r.command.id === c.id && sameArgv(r.command.argv, c.argv)).at(-1);
        if (run === undefined || (!succeeded(run.command) && (spec.retryable?.(run) ?? false))) {
          missing.push(c);
          continue;
        }
        if (!succeeded(run.command)) return { kind: "supervise", reason: `${c.id} did not run: exit ${run.command.exitCode ?? "signal"}`, refs: [run.record.ref] };
        texts.push(reportText(run).text);
      }
      if (missing.length > 0) return { kind: "quotes", commands: missing };
      const failed = readTreeQuotes(plan, texts);
      for (const f of refuted) {
        const why = failed.get(f.id);
        if (why !== undefined) {
          f.state = "disputed";
          f.notes.push(`the refutation's quotes do not match the head: ${why.replace(/^unsupported: /, "")}`);
        } else f.state = "dismissed";
      }
    }
    return { kind: "ok", blocking: pending.some((f) => f.prior !== true && (f.state === "confirmed" || f.state === "disputed")) };
  };

  for (const ev of events) {
    refs.push(ev.run.record.ref);
    if (ev.kind === "pass") {
      if (phase === "verify") {
        // The next pass exists, so the verification before it was settled: its verdicts apply now.
        if (verdicts === undefined) continue;
        const r = resolve();
        if (r.kind !== "ok") continue;
        phase = r.blocking ? (passes.length < MAX_SWEEP_PASSES ? "need-pass" : "unsaturated") : "saturated";
      }
      if (phase === "saturated" || phase === "unsaturated") continue;
      if (ev.run.status !== "completed") {
        retries += 1;
        continue;
      }
      const parsed = ev.run.contract?.status === "invalid" ? { problems: ev.run.contract.problems.slice(0, 20) } : parsePass(ev.run.output, { aspect: spec.aspect, scope: spec.scope, known: known(), ...(spec.repro !== undefined ? { maxTestBytes: spec.repro.config.maxTestBytes } : {}), ...(spec.principles !== undefined ? { principles: spec.principles } : {}), ...(passes.length === 0 && given.length > 0 ? { prior: new Set(given.map((p) => p.id)) } : {}) });
      if ("problems" in parsed) {
        retries += 1;
        feedback = parsed.problems;
        continue;
      }
      retries = 0;
      feedback = [];
      const n = passes.length + 1;
      const raised: Finding[] = [];
      const reaffirmed: string[] = [];
      let nits = 0;
      let merged = 0;
      let suppressed = 0;
      for (const j of parsed.prior) said.set(j.finding, { status: j.status, reason: j.reason });
      for (const c of parsed.comments) {
        if (c.finding === "" && (spec.suppress ?? []).some((x) => overlaps({ path: c.path, side: c.side, start: c.start_line, end: c.end_line }, { path: x.path, side: x.side, start: x.start, end: x.end }))) {
          suppressed += 1;
          continue;
        }
        if (c.finding !== "") {
          const mine = findings.find((f) => f.id === c.finding);
          if (mine !== undefined) mine.reaffirmed.push(n);
          reaffirmed.push(c.finding);
          continue;
        }
        if (c.severity === "P3") {
          nits += 1;
          continue;
        }
        const span = { path: c.path, side: c.side, start: c.start_line, end: c.end_line };
        const twin = c.distinct ? undefined : raised.find((f) => !f.distinct && overlaps(span, { path: f.path, side: f.side, start: f.startLine, end: f.endLine }));
        if (twin !== undefined) {
          merged += 1;
          if (SEVERITIES.indexOf(c.severity) < SEVERITIES.indexOf(twin.severity)) twin.severity = c.severity;
          if (c.kind === "behavioral") twin.kind = "behavioral";
          if (c.kind === "behavioral" && !hasTest(twin.repro) && hasTest(c.repro)) twin.repro = c.repro;
          if (twin.principle === undefined && c.principle !== undefined && c.principle !== "") twin.principle = c.principle;
          twin.notes.push(`merged with another comment of pass ${n} on overlapping lines`);
          continue;
        }
        const f: Finding = {
          id: `F${next++}`,
          aspect: c.aspect,
          raisedBy: spec.aspect,
          pass: n,
          path: c.path,
          side: c.side,
          startLine: c.start_line,
          endLine: c.end_line,
          severity: c.severity,
          kind: c.kind,
          content: c.content.trim(),
          suggestion: c.suggestion,
          evidence: oneLine(c.evidence),
          distinct: c.distinct,
          ...(c.principle !== undefined && c.principle !== "" ? { principle: c.principle } : {}),
          ...(c.kind === "behavioral" && hasTest(c.repro) ? { repro: c.repro } : {}),
          state: "pending",
          reaffirmed: [],
          notes: [],
        };
        raised.push(f);
        findings.push(f);
      }
      passes.push({ n, reviewed: parsed.summary.reviewed_files, raised: raised.map((f) => f.id), reaffirmed, nits, merged, ...(suppressed > 0 ? { suppressed } : {}) });
      reproFor = raised.filter((f) => f.kind === "behavioral" && hasTest(f.repro));
      passRef = ev.run.record.ref;
      // The earlier findings are judged in the first pass only: a later pass verifies what it raised, and what was settled stays settled.
      awaiting = [...raised.map((f) => f.id), ...(n === 1 ? priors.filter((f) => said.get(f.id)?.status === "still_present").map((f) => f.id) : [])];
      verdicts = undefined;
      verifyRetries = 0;
      verifyFeedback = [];
      phase = awaiting.length > 0 ? "verify" : "saturated";
      continue;
    }
    // A verifier's result for the findings the latest pass raised.
    if (phase !== "verify" || verdicts !== undefined) continue;
    if (ev.run.status !== "completed") {
      verifyRetries += 1;
      continue;
    }
    const read = ev.run.contract?.status === "invalid" ? { problems: ev.run.contract.problems.slice(0, 20) } : parseVerification(ev.run.output, new Set(awaiting));
    if ("problems" in read) {
      verifyRetries += 1;
      verifyFeedback = read.problems;
      continue;
    }
    verdicts = read.verdicts;
  }
  const tail = refs.slice(-10);
  /** What the sweep concluded of each earlier finding: fixed when the reviewer said so or the verifier refuted it, else it stays open. */
  const outcomes = (): PriorOutcome[] =>
    priors.map((f, i): PriorOutcome => {
      const at = { id: f.id, path: f.path, side: f.side, line: f.startLine, endLine: f.endLine, outdated: given[i]!.outdated };
      const s = said.get(f.id);
      if (s?.status === "fixed") return { ...at, status: "fixed", how: "reviewer", reason: s.reason };
      if (f.state === "dismissed") return { ...at, status: "fixed", how: "verifier", reason: f.verdict?.reason ?? s?.reason ?? "refuted" };
      return { ...at, status: "open", how: "verifier", reason: f.state === "confirmed" ? (f.verdict?.reason ?? s?.reason ?? "still present") : (f.notes[0] ?? s?.reason ?? "the verifier could not settle it, so it stays open") };
    });
  if (phase === "verify") {
    if (verdicts === undefined) {
      if (verifyRetries > MAX_REVIEW_RETRIES) return { state: "supervise", reason: `the ${spec.aspect} verifier's result still fails the contract after ${MAX_REVIEW_RETRIES} retries: ${verifyFeedback.slice(0, 3).join("; ")}`, refs: tail };
      // The reviewers' tests run before the verifier reads them, one at a time.
      const ran = reproProofs();
      if (ran.next !== undefined) return { state: "repro", ...ran.next };
      for (const f of reproFor) f.proof = ran.proofs.get(f.id) ?? noTest(f);
      return { state: "verify", n: passes.length, findings: [...priors, ...findings].filter((f) => awaiting.includes(f.id)), feedback: verifyFeedback };
    }
    const r = resolve();
    if (r.kind === "quotes") return { state: "quotes", commands: r.commands };
    if (r.kind === "supervise") return { state: "supervise", reason: r.reason, refs: r.refs };
    if (r.blocking && passes.length < MAX_SWEEP_PASSES) return { state: "pass", n: passes.length + 1, feedback: [], known: [...spec.earlier, ...findings], prior: [] };
    return { state: "done", findings, passes, unsaturated: r.blocking, refs: tail, prior: outcomes() };
  }
  if (phase === "saturated" || phase === "unsaturated") return { state: "done", findings, passes, unsaturated: phase === "unsaturated", refs: tail, prior: outcomes() };
  if (retries > MAX_REVIEW_RETRIES) return { state: "supervise", reason: `the ${spec.aspect} reviewer's result still fails the contract or the deterministic rules after ${MAX_REVIEW_RETRIES} retries: ${feedback.slice(0, 3).join("; ")}`, refs: tail };
  return { state: "pass", n: passes.length + 1, feedback, known: [...spec.earlier, ...findings], prior: passes.length === 0 ? [...given] : [] };
}

/** The review's findings in id order across the aspects' records. */
export const findingsOf = (records: readonly AspectRecord[]): Finding[] => records.flatMap((r) => r.findings).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
