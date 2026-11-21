// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the review layer recorded and what the Draft stage writes, from the evidence alone (design §8.1, §8.4; design-pr-review-split
 * §4.5): the scope record, the aspects' records, the rule files, and the draft with the report files rewritten with the Review section.
 * The graph writes these and the validators recompute them with the same functions.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { ASPECTS, ruleFileText, ruleGroups, type Aspect, type RuleGroups } from "./kit/aspects.js";
import type { Analysis } from "./kit/analysis.js";
import { DRAFT_JSON, DRAFT_MD, PART_BASE, REVIEW_APPENDIX_HTML, REVIEW_HTML, REVIEW_MD, ruleFilePath, REVIEW_DIR } from "./kit/constants.js";
import { composeDraft, draftJson, draftMarkdown, withReview, type Draft } from "./draft.js";
import { htmlPagesFrom, parseReportDoc } from "./html.js";
import { partCommands, readParts, recordedRecord, recordedReport, type Written } from "./kit/parts.js";
import type { MeasurementState } from "./kit/measurements.js";
import type { Profile } from "./kit/profile.js";
import type { PullRequest } from "./kit/request.js";
import { aspectRecordId, parseAspectRecord, type AspectRecord } from "./review.js";
import { parseScopeRecord, SCOPE_RECORD_ID, type ScopeRecord } from "./reviewscope.js";
import { NO_DESIGN_LINE, type ContextRecord } from "./context.js";
import { contextReport, recordedSeed, round1Of, type Recorded } from "./runcontext.js";

export type { Recorded } from "./runcontext.js";

const RECORD_DIR = "review";

function decoded<T>(w: Written<string>, what: string, parse: (json: string) => T | undefined): Recorded<T> {
  if (w.state === "none") return { state: "none" };
  if (w.state === "failed") return w;
  const value = parse(w.value);
  return value === undefined ? { state: "failed", reason: `${what} is not a record of this review`, refs: w.refs } : { state: "read", value, refs: w.refs };
}

/** The scope and base-session record, as the evidence holds it. */
export const recordedScope = (evidence: readonly EvidenceRecord[]): Recorded<ScopeRecord> => decoded(recordedRecord(evidence, SCOPE_RECORD_ID, RECORD_DIR), "review-scope", parseScopeRecord);

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
  /** The texts written; `html` and `appendix` are absent when there is no report to render (`none`). */
  texts: { draftJson: string; draftMd: string; markdown: string; html?: string; appendix?: string };
}

/** The sections of the report whose files a reviewer reads first (design §8.1): schema, interfaces, config and removed. */
const PRIORITY_SECTIONS = new Set(["schema", "interfaces", "config", "removed"]);

/** The scope in reading order: files cited by the context report's schema, interfaces, config and removed sections first, then the rest. */
export function readingOrder(reportJson: string | undefined, files: readonly string[]): string[] {
  const first = new Set<string>();
  const doc = reportJson === undefined ? undefined : parseReportDoc(reportJson);
  for (const sec of doc?.sections ?? []) if (PRIORITY_SECTIONS.has(sec.id)) for (const item of sec.items) for (const c of item.cites) first.add(c.path);
  return [...files.filter((f) => first.has(f)), ...files.filter((f) => !first.has(f))];
}

/** What the html says of round 1 when the context has no design review: the prelude and `none` (design-pr-review-split §4.1). */
export const NO_DESIGN_HTML = `${NO_DESIGN_LINE} The verdict of the posted review counts round 1's open items when the design review ran on this pull request.`;

/** The pages `review.html` and `review-appendix.html` of a context source, with the draft once there is one; undefined for `none`. */
export function contextPages(json: string | undefined, context: ContextRecord, records: { qaJson: string; necessityJson: string } | undefined, draft?: string): { review: string; appendix: string } | undefined {
  if (json === undefined) return undefined;
  if (context.source === "design-review") return htmlPagesFrom(json, records?.qaJson, records?.necessityJson, draft);
  return htmlPagesFrom(json, undefined, undefined, draft, { noDesign: NO_DESIGN_HTML });
}

export type DraftState = { state: "ready"; writes: DraftWrites } | { state: "pending"; reason: string } | { state: "failed"; reason: string; refs: string[] };

/** The draft and what the Draft stage writes, recomputed from the recorded review, the context and its report. */
export function draftWrites(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, base: string | undefined, context: ContextRecord, m: MeasurementState, profile: Pick<Profile, "metrics">): DraftState {
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
  const report = contextReport(evidence, pr, analysis, context, m, profile);
  if ("pending" in report) return { state: "pending", reason: report.pending };
  // review.md as the Report stage wrote it: the prelude's report, or the seed of the design review's report or of no report.
  const md = context.source === "prelude" ? recordedReport(evidence) : recordedSeed(evidence);
  if (md.state !== "read") return { state: "pending", reason: "review.md was not written" };
  const markdownBefore = typeof md.value === "string" ? md.value : md.value.markdown;
  const draft = composeDraft({
    pull: { owner: pr.owner, repo: pr.repo, number: pr.number },
    head: pr.head,
    ...(base !== undefined ? { base } : {}),
    files: analysis.snapshot.files,
    scope: scope.value,
    records,
    context: { source: context.source, ...(context.head !== undefined ? { head: context.head } : {}) },
    round1: round1Of(evidence, pr, report.records),
  });
  const dj = draftJson(draft);
  const dm = draftMarkdown(draft);
  const markdown = withReview(markdownBefore, draft);
  const pages = contextPages(report.json, context, report.records, dj);
  if (report.json !== undefined && pages === undefined) return { state: "failed", reason: "review.html cannot be rendered: the context's report.json is not a change report", refs: [] };
  const commands = [
    ...partCommands(PART_BASE.draftJson, DRAFT_JSON, dj),
    ...partCommands(PART_BASE.draftMd, DRAFT_MD, dm),
    ...partCommands(PART_BASE.finalMd, REVIEW_MD, markdown),
    ...(pages !== undefined ? [...partCommands(PART_BASE.finalHtml, REVIEW_HTML, pages.review), ...partCommands(PART_BASE.finalAppendix, REVIEW_APPENDIX_HTML, pages.appendix)] : []),
  ];
  return { state: "ready", writes: { draft, commands, texts: { draftJson: dj, draftMd: dm, markdown, ...(pages !== undefined ? { html: pages.review, appendix: pages.appendix } : {}) } } };
}

/** The written artifacts, read back from their part sets. */
export function writtenDraftFiles(evidence: readonly EvidenceRecord[]): { [K in keyof DraftWrites["texts"]]-?: Written<string> } {
  return {
    draftJson: readParts(evidence, PART_BASE.draftJson, DRAFT_JSON),
    draftMd: readParts(evidence, PART_BASE.draftMd, DRAFT_MD),
    markdown: readParts(evidence, PART_BASE.finalMd, REVIEW_MD),
    html: readParts(evidence, PART_BASE.finalHtml, REVIEW_HTML),
    appendix: readParts(evidence, PART_BASE.finalAppendix, REVIEW_APPENDIX_HTML),
  };
}

export { REVIEW_DIR };
