// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { Fact } from "./detectors.js";
import type { DiagramsDoc } from "./diagrams.js";
import { coverageNotes, renderMeasurements, notRunReasons, type MeasurementState } from "./measurements.js";
import { DIVE_COLUMNS, DIVE_COMMAND, DIVE_HEADING, DIVE_TEXT, diveRow } from "./dive.js";
import type { LargeInfo } from "./large.js";
import { describeReasons, type ReviewMode } from "./mode.js";
import type { Profile } from "./profile.js";
import { renderReport, type FinalReport } from "./report.js";
import type { PullRequest } from "./request.js";
import type { Snapshot } from "./snapshot.js";

export const REPORT_FILE_SCHEMA = "pr-change-report-v1";

export interface OutputInput {
  pr: PullRequest;
  snapshot: Snapshot;
  /** The pinned merge base the run reports against, when the checkout recorded it. */
  base: string | undefined;
  final: FinalReport;
  facts: readonly Fact[];
  measurements: MeasurementState;
  profile: Pick<Profile, "metrics">;
  /** Standard or large, with the limits passed (design §6.9). */
  mode: ReviewMode;
  /** Large mode: the areas and the files without a patch. */
  large?: LargeInfo;
  /** The drawings of the architecture and the lifecycle entries (design §6.10): the skill's embedded SVGs, or the plugin's note. */
  diagrams?: DiagramsDoc;
}

/** `report.json` (`pr-change-report-v1`): the machine-readable report the validators and later stages read. */
export function reportJson(i: OutputInput): string {
  const m = i.measurements;
  const reasons = notRunReasons(i.profile);
  return JSON.stringify({
    schema: REPORT_FILE_SCHEMA,
    pull: { owner: i.pr.owner, repo: i.pr.repo, number: i.pr.number, head: i.pr.head, ...(i.base !== undefined ? { base: i.base } : {}), title: i.snapshot.pull.title, url: i.snapshot.pull.url, author: i.snapshot.pull.author },
    files: i.snapshot.files.map((f) => ({ path: f.path, previousPath: f.previousPath, status: f.status, additions: f.additions, deletions: f.deletions })),
    commits: i.snapshot.commits.length,
    checks: i.snapshot.checks,
    mode: i.mode.mode,
    ...(i.mode.mode === "large" ? { modeReasons: i.mode.reasons, ...(i.large !== undefined ? { areas: i.large.areas, omitted: i.large.omitted } : {}) } : {}),
    facts: i.facts,
    summary: i.final.summary,
    sections: i.final.sections,
    notes: i.final.notes,
    removed: i.final.removed,
    removedParts: i.final.removedParts,
    architecture: i.final.architecture,
    ...(i.diagrams !== undefined && (i.diagrams.arch !== undefined || Object.keys(i.diagrams.states).length > 0) ? { diagrams: i.diagrams } : {}),
    measurements:
      m.state === "ready"
        ? { tools: m.coverage.runs.some((r) => r.ran) ? "static+coverage" : "static", coverage: coverageNotes(m.coverage), runs: m.coverage.runs, mutation: reasons.mutation, records: m.records }
        : { tools: "static", coverage: [reasons.coverage], runs: [], mutation: reasons.mutation, records: [], none: m.state === "none" ? m.reason : "not measured" },
  });
}

/** `review.md`: Report, Measurements, then Q&A (design §6.6, §7.4). The Report stage writes it with the Q&A pending; the Answers stage writes it whole. */
export function reviewMarkdown(i: OutputInput): string {
  const head = i.pr.head.slice(0, 12);
  const header = {
    owner: i.pr.owner,
    repo: i.pr.repo,
    number: i.pr.number,
    head: i.pr.head,
    title: i.snapshot.pull.title,
    files: i.snapshot.files,
    commits: i.snapshot.commits.length,
    checks: i.snapshot.checks,
  };
  return [
    `# ${i.pr.owner}/${i.pr.repo}#${i.pr.number} at ${head}${i.base !== undefined ? ` (base ${i.base.slice(0, 12)})` : ""}`,
    "Contents: Report · Measurements · Q&A",
    ...(i.mode.mode === "large" ? [modeLine(i.mode, i.large)] : []),
    "",
    renderReport(i.final, header),
    ...(i.mode.mode === "large" && i.large !== undefined ? [diveMarkdown(i.large)] : []),
    renderMeasurements(i.measurements, i.profile),
    QA_PENDING,
  ].join("\n");
}

/** The header line of a large review: the mode, the limits passed, and how the report was made (design §6.9). */
export function modeLine(mode: ReviewMode, large?: LargeInfo): string {
  const read = large?.areas.filter((a) => a.kind === "read").length;
  const how = read === undefined ? "" : `: reported at a high level from a digest of its ${read} area${read === 1 ? "" : "s"}${large!.areas.some((a) => a.kind === "generated") ? "; generated files are listed in Other, not read" : ""}${large!.omitted.length > 0 ? `; ${large!.omitted.length} file(s) without a patch from GitHub are listed in Other` : ""}`;
  return `Mode: large (${describeReasons(mode.reasons)})${how}.`;
}

const cellText = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim().replace(/\|/g, "\\|");

/** The block that ends the Report of a large review: the areas, and the command that opens the reporter's session (design §6.9). */
export function diveMarkdown(large: LargeInfo): string {
  return [
    `## ${DIVE_HEADING}`,
    DIVE_TEXT,
    "",
    `    ${DIVE_COMMAND}`,
    "",
    `| ${DIVE_COLUMNS.join(" | ")} |`,
    `|${DIVE_COLUMNS.map(() => "---").join("|")}|`,
    ...large.areas.map((a) => `| ${diveRow(a).map(cellText).join(" | ")} |`),
    "",
  ].join("\n");
}

/** What the Q&A part says until the Answers stage replaces it. */
export const QA_PENDING = ["# Q&A", "Pending: the Questions and Answers stages follow the report.", ""].join("\n");

/**
 * The whole `review.md`: the report's own, with its pending Q&A part replaced by the rendered one (a report cut
 * short keeps its cut note, then the Q&A), and the Necessity part (design §7.5) in front of the Report.
 */
export function withQa(reportMarkdown: string, qaMarkdown: string, necessityMarkdown?: string): string {
  const base = reportMarkdown.endsWith(QA_PENDING) ? reportMarkdown.slice(0, reportMarkdown.length - QA_PENDING.length) : `${reportMarkdown}\n`;
  const joined = `${base}${qaMarkdown}`;
  if (necessityMarkdown === undefined) return joined;
  const at = joined.indexOf("\n# Report");
  if (at < 0) return `${necessityMarkdown}\n${joined}`;
  const front = joined.slice(0, at).replace("Contents: Report · Measurements · Q&A", "Contents: Necessity · Report · Measurements · Q&A");
  return `${front}\n${necessityMarkdown}${joined.slice(at)}`;
}
