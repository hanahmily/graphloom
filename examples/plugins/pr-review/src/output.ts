// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { Fact } from "./detectors.js";
import { renderMeasurements, notRunReasons, type MeasurementState } from "./measurements.js";
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
}

/** `report.json` (`pr-change-report-v1`): the machine-readable report the validators and later stages read. */
export function reportJson(i: OutputInput): string {
  const m = i.measurements;
  const reasons = notRunReasons(i.profile);
  return JSON.stringify({
    schema: REPORT_FILE_SCHEMA,
    pull: { owner: i.pr.owner, repo: i.pr.repo, number: i.pr.number, head: i.pr.head, ...(i.base !== undefined ? { base: i.base } : {}), title: i.snapshot.pull.title, url: i.snapshot.pull.url },
    files: i.snapshot.files.map((f) => ({ path: f.path, previousPath: f.previousPath, status: f.status, additions: f.additions, deletions: f.deletions })),
    commits: i.snapshot.commits.length,
    checks: i.snapshot.checks,
    facts: i.facts,
    sections: i.final.sections,
    notes: i.final.notes,
    removed: i.final.removed,
    measurements:
      m.state === "ready"
        ? { tools: "static", coverage: reasons.coverage, mutation: reasons.mutation, records: m.records }
        : { tools: "static", coverage: reasons.coverage, mutation: reasons.mutation, records: [], none: m.state === "none" ? m.reason : "not measured" },
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
    "",
    renderReport(i.final, header),
    renderMeasurements(i.measurements, i.profile),
    QA_PENDING,
  ].join("\n");
}

/** What the Q&A part says until the Answers stage replaces it. */
export const QA_PENDING = ["# Q&A", "Pending: the Questions and Answers stages follow the report.", ""].join("\n");

/** The whole `review.md`: the report's own, with its pending Q&A part replaced by the rendered one (a report cut short keeps its cut note, then the Q&A). */
export function withQa(reportMarkdown: string, qaMarkdown: string): string {
  const base = reportMarkdown.endsWith(QA_PENDING) ? reportMarkdown.slice(0, reportMarkdown.length - QA_PENDING.length) : `${reportMarkdown}\n`;
  return `${base}${qaMarkdown}`;
}
