// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the review layer recorded and what the Draft stage writes, from the evidence alone (design §8.1, §8.4): the scope
 * record, the aspects' records, the rule files, and the draft with the report files rewritten with the Review section.
 * The graph writes these and the validators recompute them with the same functions.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { ASPECTS, ruleFileText, ruleGroups, type Aspect, type RuleGroups } from "./aspects.js";
import type { Analysis } from "./analysis.js";
import { DRAFT_JSON, DRAFT_MD, PART_BASE, REVIEW_APPENDIX_HTML, REVIEW_HTML, REVIEW_MD, ruleFilePath, REVIEW_DIR } from "./constants.js";
import { composeDraft, draftJson, draftMarkdown, qaInputFrom, withReview, type Draft, type ItemCites } from "./draft.js";
import { htmlPagesFrom, parseReportDoc } from "./html.js";
import { partCommands, readParts, recordedNecessityJson, recordedQa, recordedRecord, recordedReport, type Written } from "./parts.js";
import { ROUNDS_SKIP_NOTE } from "./necessity.js";
import { effectivePacks } from "./packs.js";
import { registryFromEvidence } from "./prior.js";
import type { Profile } from "./profile.js";
import type { PullRequest } from "./request.js";
import { aspectRecordId, parseAspectRecord, type AspectRecord } from "./review.js";
import { parseScopeRecord, SCOPE_RECORD_ID, type ScopeRecord } from "./reviewscope.js";
import { parseRound1Record, round1Record, round1Skipped, ROUND1_DIR, ROUND1_RECORD_ID, type Round1Record } from "./round1.js";

const RECORD_DIR = "review";

export type Recorded<T> = { state: "none" } | { state: "failed"; reason: string; refs: string[] } | { state: "read"; value: T; refs: string[] };

function decoded<T>(w: Written<string>, what: string, parse: (json: string) => T | undefined): Recorded<T> {
  if (w.state === "none") return { state: "none" };
  if (w.state === "failed") return w;
  const value = parse(w.value);
  return value === undefined ? { state: "failed", reason: `${what} is not a record of this review`, refs: w.refs } : { state: "read", value, refs: w.refs };
}

/** The scope and base-session record, as the evidence holds it. */
export const recordedScope = (evidence: readonly EvidenceRecord[]): Recorded<ScopeRecord> => decoded(recordedRecord(evidence, SCOPE_RECORD_ID, RECORD_DIR), "review-scope", parseScopeRecord);

/** The round-1 record (design §9.4): the issues of the report and the Q&A, as the evidence holds them. */
export const recordedRound1 = (evidence: readonly EvidenceRecord[]): Recorded<Round1Record> => decoded(recordedRecord(evidence, ROUND1_RECORD_ID, ROUND1_DIR), ROUND1_RECORD_ID, parseRound1Record);

/** The round-1 issues recomputed from the recorded `necessity.json` and `qa.json` and the report's cites: what the record must hold. */
export function round1Computed(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, profile: Pick<Profile, "symbols" | "rounds">): { state: "ready"; record: Round1Record } | { state: "pending"; reason: string } {
  const qa = recordedQa(evidence);
  if (qa.state !== "read") return { state: "pending", reason: "qa.json was not written" };
  const report = recordedReport(evidence);
  if (report.state !== "read") return { state: "pending", reason: "report.json was not written" };
  // `rounds: review-only` (design §3.2): round 1 is skipped by the operator's choice, so it records no issue and round 2 runs in this run.
  if (profile.rounds === "review-only") return { state: "ready", record: round1Skipped(pr.head) };
  const necessity = recordedNecessityJson(evidence);
  if (necessity.state === "failed") return { state: "pending", reason: `necessity.json does not read back: ${necessity.reason}` };
  const record = round1Record({ head: pr.head, necessity: necessity.state === "read" ? necessity.value : undefined, qa: qa.value.json, files: analysis.snapshot.files, itemCites: itemCitesOf(report.value.json), packs: effectivePacks(profile), prior: registryFromEvidence(evidence).items });
  return record === undefined ? { state: "pending", reason: "qa.json is not a Q&A file" } : { state: "ready", record };
}

/** An aspect's record. */
export const recordedAspect = (evidence: readonly EvidenceRecord[], aspect: Aspect): Recorded<AspectRecord> => decoded(recordedRecord(evidence, aspectRecordId(aspect), RECORD_DIR), aspectRecordId(aspect), (j) => parseAspectRecord(j, aspect));

export const rulesBase = (aspect: Aspect): string => `${PART_BASE.reviewRules}-${aspect}`;

/** The commands that write an aspect's effective rule file. */
export const ruleCommands = (aspect: Aspect, overrides: Parameters<typeof ruleFileText>[1]): EnvironmentCommand[] => partCommands(rulesBase(aspect), ruleFilePath(aspect), ruleFileText(aspect, overrides));

/** The rule file as written, and the groups it gives the files of the scope. */
export function recordedRules(evidence: readonly EvidenceRecord[], aspect: Aspect, files: readonly string[]): { state: "none" } | { state: "failed"; reason: string } | { state: "read"; text: string; groups: Extract<RuleGroups, { state: "ok" }>["groups"] } {
  const w = readParts(evidence, rulesBase(aspect), ruleFilePath(aspect));
  if (w.state === "none") return { state: "none" };
  if (w.state === "failed") return { state: "failed", reason: w.reason };
  const groups = ruleGroups(w.value, files);
  return groups.state === "ok" ? { state: "read", text: w.value, groups: groups.groups } : { state: "failed", reason: `${aspect}: ${groups.problems.join("; ")}` };
}

// ---- the draft and the final report files ----

export interface DraftWrites {
  draft: Draft;
  /** The commands that write draft.json, draft.md and the report files with the Review section. */
  commands: EnvironmentCommand[];
  texts: { draftJson: string; draftMd: string; markdown: string; html: string; appendix: string };
}

/** The first head cite of each change item of the report, which anchors a question that names no symbol. */
export function itemCitesOf(reportJson: string): ItemCites {
  const doc = parseReportDoc(reportJson);
  const out: ItemCites = {};
  for (const s of doc?.sections ?? []) {
    for (const item of s.items) {
      const c = item.cites.find((x) => x.side === "head" && x.start > 0);
      if (c !== undefined) out[item.id] = { path: c.path, start: c.start, end: c.end };
    }
  }
  return out;
}

/** The sections of the report whose files a reviewer reads first (design §8.1): schema, interfaces, config and removed. */
const PRIORITY_SECTIONS = new Set(["schema", "interfaces", "config", "removed"]);

/**
 * The scope in reading order: files cited by the report's schema, interfaces, config and removed sections, and files of the
 * symbols that have needs-author questions, first; then the rest, in the snapshot's order.
 */
export function readingOrder(evidence: readonly EvidenceRecord[], files: readonly string[]): string[] {
  const first = new Set<string>();
  const report = recordedReport(evidence);
  const doc = report.state === "read" ? parseReportDoc(report.value.json) : undefined;
  for (const sec of doc?.sections ?? []) if (PRIORITY_SECTIONS.has(sec.id)) for (const item of sec.items) for (const c of item.cites) first.add(c.path);
  const qa = recordedQa(evidence);
  const input = qa.state === "read" ? qaInputFrom(qa.value.json) : undefined;
  for (const q of input?.questions ?? []) {
    if (q.answer?.status !== "needs author") continue;
    const sym = q.symbol !== undefined ? input!.symbols.find((x) => x.id === q.symbol) : undefined;
    if (sym !== undefined) first.add(sym.path);
    else if (q.functionPath !== undefined) first.add(q.functionPath);
  }
  return [...files.filter((f) => first.has(f)), ...files.filter((f) => !first.has(f))];
}

export type DraftState = { state: "ready"; writes: DraftWrites } | { state: "pending"; reason: string } | { state: "failed"; reason: string; refs: string[] };

/** The draft and what the Draft stage writes, recomputed from the recorded review, the Q&A and the report. */
export function draftWrites(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, base: string | undefined): DraftState {
  const scope = recordedScope(evidence);
  if (scope.state === "none") return { state: "pending", reason: "the review's scope was not recorded" };
  if (scope.state === "failed") return { state: "failed", reason: scope.reason, refs: scope.refs };
  const records: AspectRecord[] = [];
  for (const a of ASPECTS) {
    const r = recordedAspect(evidence, a);
    if (r.state === "none") return { state: "pending", reason: `the ${a} review was not recorded` };
    if (r.state === "failed") return { state: "failed", reason: r.reason, refs: r.refs };
    records.push(r.value);
  }
  const report = recordedReport(evidence);
  if (report.state !== "read") return { state: "pending", reason: "report.json was not written" };
  const qa = recordedQa(evidence);
  if (qa.state !== "read") return { state: "pending", reason: "qa.json was not written" };
  const qaInput = qaInputFrom(qa.value.json);
  const necessity = recordedNecessityJson(evidence);
  let n1: string | undefined;
  try {
    const parsed = JSON.parse(qa.value.json) as { necessity?: { conclusion?: string }; roundsSkipped?: { note?: string } };
    if (parsed.necessity?.conclusion !== undefined) n1 = `N1, the necessity question, concluded ${parsed.necessity.conclusion}.`;
    else if (parsed.roundsSkipped !== undefined) n1 = ROUNDS_SKIP_NOTE;
  } catch {
    n1 = undefined;
  }
  const draft = composeDraft({
    pull: { owner: pr.owner, repo: pr.repo, number: pr.number },
    head: pr.head,
    ...(base !== undefined ? { base } : {}),
    files: analysis.snapshot.files,
    scope: scope.value,
    records,
    qa: qaInput,
    itemCites: itemCitesOf(report.value.json),
    necessity: n1,
  });
  const dj = draftJson(draft);
  const dm = draftMarkdown(draft);
  const markdown = withReview(qa.value.markdown, draft);
  const pages = htmlPagesFrom(report.value.json, qa.value.json, necessity.state === "read" ? necessity.value : undefined, dj);
  if (pages === undefined) return { state: "failed", reason: "review.html cannot be rendered: report.json is not a change report", refs: [] };
  const commands = [
    ...partCommands(PART_BASE.draftJson, DRAFT_JSON, dj),
    ...partCommands(PART_BASE.draftMd, DRAFT_MD, dm),
    ...partCommands(PART_BASE.finalMd, REVIEW_MD, markdown),
    ...partCommands(PART_BASE.finalHtml, REVIEW_HTML, pages.review),
    ...partCommands(PART_BASE.finalAppendix, REVIEW_APPENDIX_HTML, pages.appendix),
  ];
  return { state: "ready", writes: { draft, commands, texts: { draftJson: dj, draftMd: dm, markdown, html: pages.review, appendix: pages.appendix } } };
}

/** The five written artifacts, read back from their part sets. */
export function writtenDraftFiles(evidence: readonly EvidenceRecord[]): { [K in keyof DraftWrites["texts"]]: Written<string> } {
  return {
    draftJson: readParts(evidence, PART_BASE.draftJson, DRAFT_JSON),
    draftMd: readParts(evidence, PART_BASE.draftMd, DRAFT_MD),
    markdown: readParts(evidence, PART_BASE.finalMd, REVIEW_MD),
    html: readParts(evidence, PART_BASE.finalHtml, REVIEW_HTML),
    appendix: readParts(evidence, PART_BASE.finalAppendix, REVIEW_APPENDIX_HTML),
  };
}

export { REVIEW_DIR };
