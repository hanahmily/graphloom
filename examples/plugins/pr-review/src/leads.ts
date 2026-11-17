// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Leads (design-pr-review-split §4.3): deterministic pointers, computed by plugin code before the first pass of the sweep, at what
 * round 1's detail questions used to ask. A lead is not a finding and is never posted. Every source is recorded evidence: the
 * measurement records (complexity, nesting, coverage, CRAP, mutation), the test map and the whole-repository searches of the
 * groundwork, and the report's high-level changes. The maintainability reviewer is given at most `MAX_LEADS` of them in its first
 * pass and gives each one exactly one status, `raised` (naming the comment it raised) or `not-an-issue` (with a reason); the rest
 * are recorded as not given. The `leads-judged` validator recomputes them with these same functions.
 */
import type { Groundwork } from "./kit/groundwork.js";
import { checkThresholds, exceeds, LIMITS, originText, type Metric } from "./kit/metrics/crap.js";
import { isTestPath, type MetricsRecord } from "./kit/metrics/record.js";
import type { ViewItem } from "./kit/reportview.js";
import type { SymbolDef } from "./kit/symbols.js";

export const LEAD_KINDS = ["untested-feature", "missing-test", "weak-test", "split-function", "crap", "reuse"] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];
/** The most leads one reviewer is given (design-pr-review-split §4.3, §1.1); the rest are recorded as not given. */
export const MAX_LEADS = 60;
export const NOT_GIVEN = `not given: over the lead bound of ${MAX_LEADS}`;
/** The highest priority a finding raised from a lead may be drafted at: P1 for `untested-feature`, P2 for every other kind. */
export const LEAD_CEILING: Readonly<Record<LeadKind, "P1" | "P2">> = { "untested-feature": "P1", "missing-test": "P2", "weak-test": "P2", "split-function": "P2", crap: "P2", reuse: "P2" };

export interface Lead {
  /** `L1`… in the order of `orderLeads`, per run. */
  id: string;
  kind: LeadKind;
  /** The place it points at, on this head. */
  path: string;
  line: number;
  endLine: number;
  /** What it is about: a function, a symbol, or a high-level change (`W2`). */
  subject: string;
  /** The measured facts behind it, as one line each. */
  facts: string[];
  /** Whether the reviewer was given it (the first `MAX_LEADS` are). */
  given: boolean;
}

/** A surviving mutant of a record's mutation result: the design's shape (`original`, `mutated`), or an older one (`from`, `to`). */
export function survivors(r: Pick<MetricsRecord, "mutation">): Array<{ line: number; from: string; to: string; operator?: string }> {
  const m = r.mutation as { status?: unknown; survivors?: unknown } | undefined;
  if (m === undefined || m === null || typeof m !== "object" || !Array.isArray(m.survivors)) return [];
  return m.survivors.flatMap((s) => {
    const o = s as { line?: unknown; from?: unknown; to?: unknown; original?: unknown; mutated?: unknown; operator?: unknown };
    const from = typeof o.original === "string" ? o.original : o.from;
    const to = typeof o.mutated === "string" ? o.mutated : o.to;
    return typeof o.line === "number" && typeof from === "string" && typeof to === "string" ? [{ line: o.line, from, to, ...(typeof o.operator === "string" ? { operator: o.operator } : {}) }] : [];
  });
}

/** The symbol a measurement record is of: by qualified name, else by its lines. */
export function symbolOfRecord(r: Pick<MetricsRecord, "path" | "function" | "startLine" | "endLine">, symbols: readonly SymbolDef[]): SymbolDef | undefined {
  const same = symbols.filter((s) => s.path === r.path);
  return same.find((s) => s.qualified === r.function) ?? same.find((s) => s.startLine === r.startLine && s.endLine === r.endLine);
}

/** The record of a symbol, when one was measured. */
const recordOfSymbol = (s: SymbolDef, records: readonly MetricsRecord[]): MetricsRecord | undefined => records.find((r) => r.path === s.path && (r.function === s.qualified || (r.startLine === s.startLine && r.endLine === s.endLine)));

/** A function the test rule applies to: not a type or an interface, and not in a test file. */
const isFunction = (s: SymbolDef): boolean => s.kind !== "type" && s.kind !== "interface" && !isTestPath(s.path);

export interface LeadInput {
  records: readonly MetricsRecord[];
  groundwork: Pick<Groundwork, "symbols" | "testMap" | "candidates" | "prSimilar">;
  /** The report's high-level changes (the briefing's `whatsNew`, or the items standing in), with cites on this head; none without a report. */
  changes: readonly ViewItem[];
  /** The files of the review's scope: leads are computed for them only. */
  scope: ReadonlySet<string>;
  /** Every file the pull request changes: a `reuse` candidate is outside them. */
  changed: ReadonlySet<string>;
  /** `questions.similarity`. */
  similarity: number;
  /** Whether the searches ran: past `limits.maxNewSymbols` they do not, and no `reuse` lead is computed. */
  searched: boolean;
}

/** Whether a function has no covering test (§4.3): the test map finds none, and coverage, when measured, executed none of its lines. */
function untested(s: SymbolDef, i: Pick<LeadInput, "records" | "groundwork">): boolean {
  if ((i.groundwork.testMap.get(s.id) ?? []).length > 0) return false;
  const c = recordOfSymbol(s, i.records)?.coverage;
  return c === undefined || c.source !== "measured" || (c.covered === 0 && c.total > 0);
}

const where = (s: Pick<SymbolDef, "qualified" | "path" | "startLine">): string => `${s.qualified} (${s.path}:${s.startLine})`;
const coverageText = (r: MetricsRecord | undefined): string => (r?.coverage?.source === "measured" ? `coverage ${r.coverage.covered}/${r.coverage.total} statements` : "coverage not measured");

type Draft = Omit<Lead, "id" | "given">;

/**
 * Every lead of the pull request, in the order they are given: `untested-feature` first, then by kind in the table's order, then by
 * path and line. The first `MAX_LEADS` are given, the rest recorded as not given.
 */
export function computeLeads(i: LeadInput): Lead[] {
  const out: Draft[] = [];
  const fns = i.groundwork.symbols.filter((s) => isFunction(s) && i.scope.has(s.path));
  // untested-feature: a high-level change whose every new or modified function, in the files its cites name, has no covering test.
  const inFeature = new Set<string>();
  for (const w of i.changes) {
    const files = new Set(w.cites.filter((c) => c.side !== "base").map((c) => c.path).filter((p) => i.scope.has(p)));
    const mine = fns.filter((s) => files.has(s.path));
    if (mine.length === 0 || !mine.every((s) => untested(s, i))) continue;
    for (const s of mine) inFeature.add(s.id);
    const first = w.cites.find((c) => c.side !== "base" && files.has(c.path)) ?? { path: mine[0]!.path, start: mine[0]!.startLine, end: mine[0]!.startLine };
    out.push({
      kind: "untested-feature",
      path: first.path,
      line: Math.max(1, first.start),
      endLine: Math.max(1, first.end, first.start),
      subject: w.id,
      facts: [`${w.id}: ${w.text.replace(/\s+/g, " ").trim().slice(0, 200)}`, `none of its ${mine.length} new or modified function${mine.length === 1 ? "" : "s"} has a covering test: the test map finds none in the pull request${mine.some((s) => recordOfSymbol(s, i.records)?.coverage?.source === "measured") ? ", and the measured coverage executed none of their statements" : ", and coverage was not measured"}`, ...mine.slice(0, 12).map((s) => `${where(s)}: ${coverageText(recordOfSymbol(s, i.records))}`)],
    });
  }
  // missing-test: a new or modified function with no covering test, not already inside an untested-feature lead.
  for (const s of fns) {
    if (inFeature.has(s.id) || !untested(s, i)) continue;
    out.push({ kind: "missing-test", path: s.path, line: s.startLine, endLine: s.endLine, subject: s.qualified, facts: [`${s.change === "new" ? "new" : "modified"} ${s.kind} ${where(s)}: the test map finds no test of the pull request that covers it`, coverageText(recordOfSymbol(s, i.records))] });
  }
  const recs = i.records.filter((r) => !r.test && !isTestPath(r.path) && i.scope.has(r.path));
  // weak-test: a surviving mutant at a covered site (mutation runs at covered sites only); none when coverage was not measured.
  for (const r of recs) {
    if (r.coverage?.source !== "measured") continue;
    for (const m of survivors(r)) {
      out.push({ kind: "weak-test", path: r.path, line: m.line, endLine: m.line, subject: r.function, facts: [`a mutant of ${r.function} survived at ${r.path}:${m.line}: \`${m.from}\` → \`${m.to}\`${m.operator !== undefined ? ` (${m.operator})` : ""}; no test failed`, coverageText(r)] });
    }
  }
  // split-function: complexity ≥ 10 or nesting > 3, with whether the excess is inherited, made worse or introduced.
  for (const r of recs) {
    const over = (["complexity", "nesting"] as Metric[]).filter((m) => exceeds(m, r[m]));
    if (over.length === 0) continue;
    out.push({ kind: "split-function", path: r.path, line: r.startLine, endLine: r.endLine, subject: r.function, facts: [`${r.function} has complexity ${r.complexity} (limit < ${LIMITS.complexity}) and nesting ${r.nesting} (limit ≤ ${LIMITS.nesting})`, ...over.map((m) => `${m}: ${originText(r, m)}`)] });
  }
  // crap: measured coverage and CRAP ≥ 30, or unknown coverage and complexity ≥ 10.
  for (const r of recs) {
    const t = checkThresholds(r);
    if (!t.crap.triggers) continue;
    out.push({ kind: "crap", path: r.path, line: r.startLine, endLine: r.endLine, subject: r.function, facts: [`${r.function}: complexity ${r.complexity}, ${coverageText(r)}, CRAP ${t.crap.value}${t.crap.upperBound ? " (upper bound: coverage unknown)" : ""} (threshold ${LIMITS.crap})`] });
  }
  // reuse: a new symbol with a candidate outside the changed files (a name or signature hit, or a body over the similarity), or another new symbol of the pull request over it.
  if (i.searched) {
    for (const s of i.groundwork.symbols.filter((x) => x.change === "new" && i.scope.has(x.path) && !isTestPath(x.path))) {
      const outside = i.groundwork.candidates.filter((c) => c.symbol === s.id && !i.changed.has(c.path) && (c.via.includes("name") || c.via.includes("signature") || c.similarity >= i.similarity));
      const twins = i.groundwork.prSimilar.filter((p) => (p.a === s.id || p.b === s.id) && p.score >= i.similarity).map((p) => ({ other: i.groundwork.symbols.find((x) => x.id === (p.a === s.id ? p.b : p.a)), score: p.score })).filter((t) => t.other !== undefined);
      if (outside.length === 0 && twins.length === 0) continue;
      out.push({
        kind: "reuse",
        path: s.path,
        line: s.startLine,
        endLine: s.endLine,
        subject: s.qualified,
        facts: [
          `new ${s.kind} ${where(s)}`,
          ...outside.slice(0, 4).map((c) => `the search found ${c.path}:${c.line} (${c.via.join(", ")}${c.body !== undefined ? `, body similarity ${c.similarity}` : ""}), outside the files the pull request changes`),
          ...twins.slice(0, 3).map((t) => `another new symbol of the pull request, ${where(t.other!)}, is ${t.score} similar`),
        ],
      });
    }
  }
  return orderLeads(out);
}

/** The order leads are numbered and given in: kind (the table's order), then path, then line. */
export function orderLeads(leads: readonly Draft[]): Lead[] {
  const rank = new Map(LEAD_KINDS.map((k, n) => [k, n] as const));
  return [...leads]
    .sort((a, b) => rank.get(a.kind)! - rank.get(b.kind)! || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || (a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0))
    .map((l, n) => ({ ...l, id: `L${n + 1}`, given: n < MAX_LEADS }));
}

/**
 * What the correctness reviewer is given as context, with no status required (§4.3): the surviving mutants and the untested functions
 * of its scope, as lines.
 */
export function correctnessContext(leads: readonly Lead[]): string[] {
  return leads.filter((l) => l.kind === "weak-test" || l.kind === "missing-test" || l.kind === "untested-feature").map((l) => `${l.kind === "weak-test" ? "surviving mutant" : l.kind === "missing-test" ? "untested function" : `untested feature ${l.subject}`} at ${l.path}:${l.line}: ${l.facts[0] ?? ""}`);
}

// ---- the reviewer's statuses ----

export const LEAD_STATUSES = ["raised", "not-an-issue"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** One entry of a pass's `leads`: the lead, its status, the index of the comment it raised (`-1` for none) and a reason. */
export interface LeadEntry {
  lead: string;
  status: LeadStatus;
  comment: number;
  reason: string;
}

/** The `leads` part of the reviewer's contract (`pr-code-review-v2`). */
export const LEADS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["lead", "status", "comment", "reason"],
    properties: { lead: { type: "string" }, status: { type: "string", enum: [...LEAD_STATUSES] }, comment: { type: "integer" }, reason: { type: "string" } },
  },
} as const;

/**
 * The statuses a pass gave, read against the leads it was given (`ids`) and its comments: every given lead exactly once, a raised
 * one naming one of its new comments by index, a not-an-issue one with a reason. A missing, repeated or unknown lead is a problem,
 * which goes back to the same session as a correction.
 */
export function parseLeadStatuses(raw: unknown, ids: ReadonlySet<string>, comments: ReadonlyArray<{ finding?: unknown }>): { entries: LeadEntry[] } | { problems: string[] } {
  const list = Array.isArray(raw) ? raw : [];
  if (ids.size === 0) return list.length === 0 ? { entries: [] } : { problems: ["leads must be empty: no lead was given to you"] };
  const problems: string[] = [];
  const entries: LeadEntry[] = [];
  const seen = new Set<string>();
  list.forEach((e, k) => {
    const o = e as Partial<Record<keyof LeadEntry, unknown>> | null;
    const at = `leads[${k}]`;
    if (o === null || typeof o !== "object" || typeof o.lead !== "string" || !(LEAD_STATUSES as readonly unknown[]).includes(o.status) || typeof o.comment !== "number" || typeof o.reason !== "string") {
      problems.push(`${at} must be { lead, status: raised or not-an-issue, comment, reason }`);
      return;
    }
    if (!ids.has(o.lead)) {
      problems.push(`${at}: ${JSON.stringify(o.lead.slice(0, 20))} is not a lead you were given`);
      return;
    }
    if (seen.has(o.lead)) {
      problems.push(`${at}: ${o.lead} has a status twice`);
      return;
    }
    seen.add(o.lead);
    if (o.status === "raised") {
      const c = comments[o.comment];
      if (!Number.isSafeInteger(o.comment) || c === undefined) problems.push(`${at}: ${o.lead} is raised, so comment must be the index of the comment you raised about it (0 to ${comments.length - 1})`);
      else if (c.finding !== "" && c.finding !== undefined) problems.push(`${at}: ${o.lead} is raised by comment ${o.comment}, which names an earlier finding: a lead is raised by a new comment`);
    } else if (o.reason.trim() === "") problems.push(`${at}: ${o.lead} is not an issue, so it needs a reason`);
    entries.push({ lead: o.lead, status: o.status as LeadStatus, comment: o.status === "raised" ? (o.comment as number) : -1, reason: o.reason.replace(/\s+/g, " ").trim() });
  });
  const left = [...ids].filter((id) => !seen.has(id));
  if (left.length > 0) problems.push(`every lead you were given needs exactly one status in leads; missing ${left.join(", ")}`);
  return problems.length > 0 ? { problems } : { entries };
}

/** A lead as an aspect record keeps it (`pr-review-aspect-v2`): the lead, and its status, its reason and the finding it became. */
export interface LeadRecord extends Lead {
  /** `raised`, `not-an-issue`, or the not-given note. */
  status: LeadStatus | typeof NOT_GIVEN;
  reason?: string;
  /** The finding a raised lead became (`F3`), or what became of its comment when it is no finding (a nit, a merge, a suppression). */
  finding?: string;
}

/** The lead lines of a reviewer's assignment. */
export const leadLine = (l: Lead): string => `${l.id} [${l.kind}] ${l.path}:${l.line}${l.endLine > l.line ? `-${l.endLine}` : ""} (${l.subject}): ${l.facts.join("; ")}`;
