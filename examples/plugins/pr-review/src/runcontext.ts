// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The run's context as the evidence holds it (design-pr-review-split §4.2): the design section Fetch read and what is usable of it,
 * the recorded `context.json`, the report the reviewers' scope and leads read (this run's prelude, the design review's with its cites
 * on this head, or none), and round 1's status on the pull request. The graph and the validators read the context through these
 * functions only, so they decide the same.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import type { Analysis } from "./kit/analysis.js";
import type { Bullet } from "./kit/briefing.js";
import { pinnedBase } from "./kit/commands.js";
import { CONTEXT_JSON, PART_BASE, REVIEW_MD } from "./kit/constants.js";
import { isObject } from "./kit/evidence.js";
import { ledgerRead, oldValue, priorState, type PriorLedger } from "./kit/ledger.js";
import type { MeasurementState } from "./kit/measurements.js";
import type { Groundwork, GroundworkOptions } from "./kit/groundwork.js";
import type { LeadInput } from "./leads.js";
import { measurementsJson } from "./kit/output.js";
import { readParts, recordedReport, type Written } from "./kit/parts.js";
import type { Profile } from "./kit/profile.js";
import { reportViewOf, type ReportView } from "./kit/reportview.js";
import type { PullRequest } from "./kit/request.js";
import { designReads, parseContextRecord, round1Status, type ContextRecord, type DesignReads, type DesignRecords, type Round1Status } from "./context.js";

export type Recorded<T> = { state: "none" } | { state: "failed"; reason: string; refs: string[] } | { state: "read"; value: T; refs: string[] };

/** The `context.json` the Report stage wrote. */
export function recordedContext(evidence: readonly EvidenceRecord[]): Recorded<ContextRecord> {
  const w = readParts(evidence, PART_BASE.contextJson, CONTEXT_JSON);
  if (w.state === "none") return { state: "none" };
  if (w.state === "failed") return w;
  const value = parseContextRecord(w.value);
  return value === undefined ? { state: "failed", reason: "context.json is not a context record of this review", refs: w.refs } : { state: "read", value, refs: w.refs };
}

/** The seed `review.md` the Report stage wrote for a `design-review` or `none` source. */
export const recordedSeed = (evidence: readonly EvidenceRecord[]): Written<string> => readParts(evidence, PART_BASE.seedMd, REVIEW_MD);

/** The prior ledger Fetch read, when one was read whole. */
export function priorRead(evidence: readonly EvidenceRecord[]): { prior: PriorLedger; sha: string } | undefined {
  const read = ledgerRead(evidence);
  if (read === undefined || !read.ledger.present) return undefined;
  return { prior: priorState(evidence, oldValue(read.ledger)), sha: read.ledger.sha };
}

/** Where reading the design head's report stands, from the ledger Fetch read (design-pr-review-split §4.2). */
export function designState(evidence: readonly EvidenceRecord[], pr: Pick<PullRequest, "head">, analysis: Pick<Analysis, "snapshot">, node = process.execPath): DesignReads {
  const files = analysis.snapshot.files.map((f) => f.path);
  const common = { head: pr.head, files, base: pinnedBase(evidence), mode: analysis.snapshot.mode.mode, node };
  const p = priorRead(evidence);
  if (p === undefined) return designReads(evidence, { ...common, ledger: undefined, design: undefined, dir: "" });
  if (p.prior.state === "missing") return { state: "run", commands: p.prior.next, why: "read the prior ledger's sections" };
  if (p.prior.state !== "read") return { state: "unusable", reason: p.prior.state === "unreadable" ? `the prior ledger cannot be read (${p.prior.reason})` : "the prior ledger is absent" };
  return designReads(evidence, { ...common, ledger: p.sha, design: p.prior.value.design, dir: p.prior.layout === "v2" ? "design/" : "" });
}

/**
 * Round 1 on the pull request (§4.5), from the design section Fetch read; null when the ledger records no design outcome. `records`,
 * the design head's records the context read, give the open items' questions when they are of round 1's head.
 */
export function round1Of(evidence: readonly EvidenceRecord[], pr: Pick<PullRequest, "owner" | "repo" | "number">, records?: Pick<DesignRecords, "head" | "qaJson">): Round1Status | null {
  const p = priorRead(evidence);
  return p === undefined || p.prior.state !== "read" ? null : round1Status(p.prior.value.design, pr, records !== undefined ? { head: records.head, qaJson: records.qaJson } : undefined);
}

/** The design head's records, when the context is `design-review` and they read back. */
export function designRecordsOf(evidence: readonly EvidenceRecord[], pr: Pick<PullRequest, "head">, analysis: Pick<Analysis, "snapshot">, context: ContextRecord): DesignRecords | undefined {
  if (context.source !== "design-review") return undefined;
  const r = designState(evidence, pr, analysis);
  return r.state === "usable" && r.records.head === context.head ? r.records : undefined;
}

/** A report whose cites are kept only where their files are in this head's change: a design head's report mapped to this head (§4.2). */
function onThisHead(view: ReportView, files: ReadonlySet<string>): ReportView {
  const keep = (cites: ReportView["items"][number]["cites"]): typeof cites => cites.filter((c) => files.has(c.path));
  return { ...view, items: view.items.map((i) => ({ ...i, cites: keep(i.cites) })), ...(view.changes !== undefined ? { changes: view.changes.map((c) => ({ ...c, cites: keep(c.cites) })) } : {}) };
}

/** What the scope and the leads read of the context's report: its view (items, high-level changes) and its "what to check" bullets. */
export interface ContextReport {
  /** `report.json` as the html renders it: this run's, or the design head's with this run's measurements; none without a report. */
  json?: string;
  view?: ReportView;
  check: Record<"risks" | "behavior" | "compatibility", Bullet[]>;
  /** The design head's records, for the `design-review` source. */
  records?: DesignRecords;
}

const EMPTY_CHECK = { risks: [], behavior: [], compatibility: [] };

/** The report of the context source (design-pr-review-split §4.2), with its cites on this head, or why it is not there yet. */
export function contextReport(evidence: readonly EvidenceRecord[], pr: Pick<PullRequest, "head">, analysis: Pick<Analysis, "snapshot">, context: ContextRecord, m: MeasurementState, profile: Pick<Profile, "metrics">): ContextReport | { pending: string } {
  const files = new Set(analysis.snapshot.files.map((f) => f.path));
  if (context.source === "none") return { check: EMPTY_CHECK };
  let json: string;
  let records: DesignRecords | undefined;
  if (context.source === "prelude") {
    const r = recordedReport(evidence);
    if (r.state !== "read") return { pending: "report.json was not written" };
    json = r.value.json;
  } else {
    records = designRecordsOf(evidence, pr, analysis, context);
    if (records === undefined) return { pending: "the design review's report does not read back from the ledger" };
    // The design head's report, with this run's measurements (§4.2: coverage, CRAP and mutation included).
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(records.reportJson) as Record<string, unknown>;
    } catch {
      return { pending: "the design review's report.json is not JSON" };
    }
    json = JSON.stringify({ ...doc, measurements: measurementsJson(m, profile) });
  }
  const view = reportViewOf(json);
  if (view === undefined) return { pending: "the context's report.json is not a change report" };
  const doc = JSON.parse(json) as { briefing?: { check?: Record<string, unknown> } };
  const check = Object.fromEntries((["risks", "behavior", "compatibility"] as const).map((k) => [k, (Array.isArray(doc.briefing?.check?.[k]) ? (doc.briefing!.check![k] as Bullet[]) : []).filter(isObject).map((b) => ({ ...b, cites: (b.cites ?? []).filter((c) => files.has(c.path)) }))])) as ContextReport["check"];
  return { json, view: context.source === "design-review" ? onThisHead(view, files) : view, check, ...(records !== undefined ? { records } : {}) };
}

/** The groundwork the leads rest on (design-pr-review-split §4.3): every symbol and its test map; the searches up to `limits.maxNewSymbols` new symbols. */
export function groundworkOptions(evidence: readonly EvidenceRecord[], analysis: Analysis, profile: Profile, base: string, retryable?: GroundworkOptions["retryable"]): GroundworkOptions {
  return { evidence, files: analysis.snapshot.files, profile, base, perSymbol: true, maxSearched: profile.limits.maxNewSymbols, ...(retryable !== undefined ? { retryable } : {}) };
}

/** What the leads are computed from (design-pr-review-split §4.3): the graph and `leads-judged` build the same input. */
export function leadInputOf(analysis: Analysis, profile: Profile, scopeFiles: readonly string[], report: { view?: ReportView | undefined }, m: MeasurementState, groundwork: Groundwork): LeadInput {
  const changed = new Set(analysis.snapshot.files.flatMap((f) => [f.path, ...(f.previousPath !== null ? [f.previousPath] : [])]));
  return {
    records: m.state === "ready" ? m.records : [],
    groundwork,
    changes: report.view?.changes ?? [],
    scope: new Set(scopeFiles),
    changed,
    similarity: profile.questions.similarity,
    searched: groundwork.symbols.filter((s) => s.change === "new").length <= profile.limits.maxNewSymbols,
  };
}
