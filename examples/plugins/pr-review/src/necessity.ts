// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The design review's necessity record (`necessity.json`, `pr-necessity-v1`), as pr-review 1.x reads it: round 1 is
 * pr-design-review's (design-pr-review-split §3), and when its report is the context of round 2 (§4.2) the review renders N1's
 * answer, its conclusion and the principles' verdicts from the record the ledger's design section keeps. Nothing here asks or
 * checks N1.
 */
import type { PrinciplesRecord } from "./kit/principles.js";
import type { MeasuredSearch } from "./kit/searches.js";

export const NECESSITY_ID = "N1";
export const NECESSITY_JSON_SCHEMA = "pr-necessity-v1";
export const SKIPPED_NOTE = "Remaining questions skipped: the change was judged unnecessary (see N1).";

export const CONCLUSIONS = ["necessary", "questionable", "unnecessary", "needs author"] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];

type Cite = { path: string; tree: "base" | "head"; start: number; end: number; quote: string };

export interface PrincipleVerdict {
  id: string;
  verdict: "preserves" | "breaks" | "not-applicable";
  explanation: string;
  citations: Cite[];
}

/** The checker's judgment of one principle verdict: `supported` holds it, anything else does not. */
export interface PrincipleCheck {
  id: string;
  verdict: "supported" | "partial" | "unsupported";
  note: string;
}

/** N1's structured answer (`necessity-v1`), as the record keeps it. */
export interface Necessity {
  conclusion: Conclusion;
  rationale: string;
  problem: { claim: string; quotes: Array<{ source: string; quote: string }>; trace: Array<Cite & { step: string }>; canHappen: string; explanation: string };
  reproduction: string;
  design: { statements: Cite[]; changed: Cite[]; effect: string; explanation: string; searches: MeasuredSearch[] };
  principles: PrincipleVerdict[];
  alternatives: { exists: boolean; explanation: string; citations: Cite[] };
  searches: MeasuredSearch[];
}

/** N1's checked answer as the record keeps it. */
export interface NecessityAnswer {
  question: string;
  answer: string;
  status: string;
  citations: Array<{ path: string; tree: string; start: number; end: number; quote: string }>;
  searches: MeasuredSearch[];
  necessity?: Necessity;
  check: { verdict: string; note: string; searches: MeasuredSearch[]; principles?: PrincipleCheck[] };
  notes: string[];
  history: Array<{ answer: string; status: string }>;
}

export type NecessityDecision = { action: "skip"; reason: string } | { action: "ask-all"; reason: string; override?: true };

/** N1's checked answer and the decision it led to: what `necessity.json` records. */
export interface NecessityRecord {
  final: NecessityAnswer;
  decision: NecessityDecision;
  /** The design principles file read for the design review's run (design §7.5.1), when its profile names one. */
  principles?: PrinciplesRecord;
  /** Set when a later head carried this record from the head it was answered on (design-pr-review-split §3.5). */
  carried?: { head: string };
}

type Judged = { necessity?: Pick<Necessity, "conclusion"> & { principles?: readonly PrincipleVerdict[] }; check: { verdict: string; principles?: readonly PrincipleCheck[] } };

/** The principles the answerer says the change breaks and the checker supports (its verdict on that principle is `supported`). */
export function supportedBreaks(a: Judged): string[] {
  const checked = new Set((a.check.principles ?? []).filter((c) => c.verdict === "supported").map((c) => c.id));
  return (a.necessity?.principles ?? []).filter((p) => p.verdict === "breaks" && checked.has(p.id)).map((p) => p.id);
}

/**
 * The conclusion as round 1 shows it: the answerer's, unless its answer stayed unsupported after the correction, which makes it
 * `questionable`; and a design principle the checker supports as broken makes `necessary` `questionable` (design §7.5.1).
 */
export function effectiveConclusion(a: Judged): Conclusion {
  const stated = a.necessity?.conclusion ?? "needs author";
  const settled = a.check.verdict === "downgraded" && stated !== "needs author" ? "questionable" : stated;
  return settled === "necessary" && supportedBreaks(a).length > 0 ? "questionable" : settled;
}

/** The sentence that names the principles a supported break rests on, or empty. */
export function brokenNote(a: Judged): string {
  const ids = supportedBreaks(a);
  return ids.length === 0 ? "" : `Design principle${ids.length > 1 ? "s" : ""} broken (the checker supports it): ${ids.join(", ")}.`;
}

/** The record a `necessity.json` text holds, or undefined when it is not one. */
export function parseNecessityRecord(json: string): NecessityRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const o = value as { schema?: unknown; carried?: { head?: unknown }; decision?: { action?: unknown; reason?: unknown }; principles?: Record<string, unknown>; answer?: Partial<NecessityAnswer> } | null;
  if (o === null || typeof o !== "object" || o.schema !== NECESSITY_JSON_SCHEMA) return undefined;
  const a = o.answer;
  if (a === undefined || a === null || typeof a !== "object" || a.question !== NECESSITY_ID || typeof a.necessity !== "object" || a.necessity === null || typeof a.check !== "object" || a.check === null) return undefined;
  const d = o.decision;
  if (d === undefined || d === null || (d.action !== "skip" && d.action !== "ask-all") || typeof d.reason !== "string") return undefined;
  const { verdicts: _v, checks: _c, broken: _b, ...recorded } = o.principles ?? {};
  return { final: a as NecessityAnswer, decision: d as NecessityDecision, ...(typeof o.carried?.head === "string" ? { carried: { head: o.carried.head } } : {}), ...(o.principles !== undefined ? { principles: recorded as unknown as PrinciplesRecord } : {}) };
}
