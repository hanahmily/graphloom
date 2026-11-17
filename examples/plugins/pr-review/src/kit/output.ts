// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { checkLines, featureLines, whatsNewLines } from "./briefing.js";
import { buildCards } from "./cards.js";
import type { Fact } from "./detectors.js";
import type { DiagramsDoc } from "./diagrams.js";
import { coverageNotes, renderMeasurements, notRunReasons, type MeasurementState } from "./measurements.js";
import { DIVE_COLUMNS, DIVE_COMMAND, DIVE_HEADING, DIVE_LINE, DIVE_TEXT, diveRow } from "./dive.js";
import type { LargeInfo } from "./large.js";
import { describeReasons, type ReviewMode } from "./mode.js";
import type { Profile } from "./profile.js";
import { describeChecks, purposeLine, renderReport, type FinalReport } from "./report.js";
import type { PullRequest } from "./request.js";
import { hotspots, hotspotText, SCOPE_KINDS, SCOPE_TITLES, scopeOf, scopeText, type Scope } from "./scope.js";
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
  profile: Pick<Profile, "metrics"> & { questions?: Pick<Profile["questions"], "excludeRoots"> };
  /** Standard or large, with the limits passed (design §6.9). */
  mode: ReviewMode;
  /** Large mode: the areas and the files without a patch. */
  large?: LargeInfo;
  /** The drawings of the features' data flows and the lifecycle entries (design §6.10): the skill's embedded SVGs, or the plugin's note. */
  diagrams?: DiagramsDoc;
}

/** The lines added and deleted by kind of file (design §6.1), from the file list and the profile's generated files. */
export function scopeFor(i: Pick<OutputInput, "snapshot" | "profile">): Scope {
  return scopeOf(i.snapshot.files, { excludeRoots: i.profile.questions?.excludeRoots ?? [], globs: i.profile.metrics.generated });
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
    scope: scopeFor(i),
    briefing: i.final.briefing,
    cards: buildCards(i.final.briefing, i.snapshot.files, i.final.sections.flatMap((s) => s.items)),
    sections: i.final.sections,
    notes: i.final.notes,
    removed: i.final.removed,
    removedParts: i.final.removedParts,
    ...(i.diagrams !== undefined && (Object.keys(i.diagrams.features).length > 0 || Object.keys(i.diagrams.states).length > 0) ? { diagrams: i.diagrams } : {}),
    measurements:
      m.state === "ready"
        ? { tools: m.coverage.runs.some((r) => r.ran) ? "static+coverage" : "static", coverage: coverageNotes(m.coverage), runs: m.coverage.runs, mutation: reasons.mutation, records: m.records }
        : { tools: "static", coverage: [reasons.coverage], runs: [], mutation: reasons.mutation, records: [], none: m.state === "none" ? m.reason : "not measured" },
  });
}

/** What the Verdict and Open questions of the briefing say until the Answers stage replaces them. */
export const VERDICT_PENDING = "Pending: N1 and the questions are answered after the report; this file is rewritten when they are.";
export const OPEN_PENDING = "Pending: the Questions and Answers stages follow the report.";

/** A block of the appendix, one heading level down, so that the appendix reads as one part of the file. */
export const demote = (markdown: string): string => markdown.replace(/^(#+)(?=\s)/gm, "$1#");

const cellText = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim().replace(/\|/g, "\\|");

/** The Areas part of the briefing: one line per area of a large report; the sections and their item counts for any other (design §6.1). */
function areasMarkdown(final: FinalReport, large: LargeInfo | undefined): string[] {
  const labels = new Map(final.briefing.areas.map((a) => [a.id, a.label] as const));
  if (large !== undefined && large.areas.length > 1) {
    return [
      `## Areas (${DIVE_HEADING.toLowerCase()})`,
      DIVE_TEXT,
      "",
      `    ${DIVE_COMMAND}`,
      "",
      `| ${DIVE_COLUMNS.join(" | ")} |`,
      `|${DIVE_COLUMNS.map(() => "---").join("|")}|`,
      ...large.areas.map((a) => `| ${diveRow(a, labels.get(a.id)).map(cellText).join(" | ")} |`),
      "",
    ];
  }
  const sections = final.sections.filter((s) => s.id !== "measurements" && s.items.length > 0);
  return ["## Areas", ...(sections.length === 0 ? ["- No change item."] : sections.map((s) => `- ${s.title}: ${s.items.length} item${s.items.length === 1 ? "" : "s"}`)), DIVE_LINE, "", `    ${DIVE_COMMAND}`, ""];
}

/** The Hotspots part of the briefing: the top five functions by CRAP, then complexity. */
function hotspotsMarkdown(m: MeasurementState): string[] {
  if (m.state === "none") return ["## Hotspots", `- No function is measured: ${m.reason}.`, ""];
  if (m.state !== "ready") return ["## Hotspots", "- Not measured: the static metrics did not complete.", ""];
  const top = hotspots(m.records);
  return ["## Hotspots", ...(top.length === 0 ? ["- No production function added or modified."] : top.map((h, n) => `${n + 1}. ${hotspotText(h)} — ${h.path}:${h.startLine}`)), ""];
}

/**
 * `review.md`: the briefing (purpose, what is new, scope, verdict, the features' data flow, what to check, hotspots, areas,
 * open questions), then the Appendix (Necessity, the Report's change items, Measurements, Q&A), which an agent or
 * `graphloom session open` reads whole (design §6.6, §7.4). The Report stage writes it with the Q&A pending; the Answers
 * stage writes it whole.
 */
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
  const scope = scopeFor(i);
  const added = i.snapshot.files.reduce((n, f) => n + f.additions, 0);
  const deleted = i.snapshot.files.reduce((n, f) => n + f.deletions, 0);
  const b = i.final.briefing;
  const cards = buildCards(b, i.snapshot.files, i.final.sections.flatMap((s) => s.items));
  return [
    `# ${i.pr.owner}/${i.pr.repo}#${i.pr.number} at ${head}${i.base !== undefined ? ` (base ${i.base.slice(0, 12)})` : ""}`,
    "Contents: Briefing · Appendix (Report · Measurements · Q&A)",
    ...(i.mode.mode === "large" ? [modeLine(i.mode, i.large)] : []),
    "",
    "# Briefing",
    `${header.files.length} files, +${added} −${deleted}. Commits: ${header.commits}. GitHub checks at head: ${describeChecks(header.checks)}.`,
    "",
    purposeLine(i.final.summary, i.final.removedParts),
    "",
    ...whatsNewLines(b, cards),
    "## Scope that matters",
    ...SCOPE_KINDS.map((k) => `- ${SCOPE_TITLES[k]}: ${scopeText(scope[k])}`),
    "",
    "## Necessity and principles",
    VERDICT_PENDING,
    "",
    ...featureLines(b),
    ...checkLines(b),
    ...hotspotsMarkdown(i.measurements),
    ...areasMarkdown(i.final, i.large),
    "## Open questions",
    OPEN_PENDING,
    "",
    "# Appendix",
    "Every change item with its lifecycles and tables, the full measurements, the claim check's removals and the whole Q&A.",
    "",
    demote(renderReport(i.final, header)),
    demote(renderMeasurements(i.measurements, i.profile)),
    QA_PENDING,
  ].join("\n");
}

/** The header line of a large review: the mode, the limits passed, and how the report was made (design §6.9). */
export function modeLine(mode: ReviewMode, large?: LargeInfo): string {
  const read = large?.areas.filter((a) => a.kind === "read").length;
  const how = read === undefined ? "" : `: reported at a high level from a digest of its ${read} area${read === 1 ? "" : "s"}${large!.areas.some((a) => a.kind === "generated") ? "; generated files are listed in Other, not read" : ""}${large!.omitted.length > 0 ? `; ${large!.omitted.length} file(s) without a patch from GitHub are listed in Other` : ""}`;
  return `Mode: large (${describeReasons(mode.reasons)})${how}.`;
}

/** What the Q&A part says until the Answers stage replaces it. */
export const QA_PENDING = ["## Q&A", "Pending: the Questions and Answers stages follow the report.", ""].join("\n");

/**
 * The whole `review.md`: the report's own, with its pending Verdict, Open questions and Q&A replaced by the rendered ones
 * (a report cut short keeps its cut note, then the Q&A), and the Necessity part (design §7.5) in front of the Report in
 * the appendix.
 */
export function withQa(reportMarkdown: string, qa: { markdown: string; verdict: string; open: string }, necessityMarkdown?: string): string {
  const base = reportMarkdown.endsWith(QA_PENDING) ? reportMarkdown.slice(0, reportMarkdown.length - QA_PENDING.length) : `${reportMarkdown}\n`;
  const swapped = base.replace(`${VERDICT_PENDING}\n`, () => qa.verdict).replace(`${OPEN_PENDING}\n`, () => qa.open);
  const joined = `${swapped}${demote(qa.markdown)}`;
  if (necessityMarkdown === undefined) return joined;
  const at = joined.indexOf("\n## Report");
  if (at < 0) return `${demote(necessityMarkdown)}\n${joined}`;
  const front = joined.slice(0, at).replace("Appendix (Report · Measurements · Q&A)", "Appendix (Necessity · Report · Measurements · Q&A)");
  return `${front}\n${demote(necessityMarkdown)}${joined.slice(at)}`;
}
