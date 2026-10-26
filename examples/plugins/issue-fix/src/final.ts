// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The `final` command tier's pull request sections: what each final command
 * reported, shown under the heading its profile entry names. The controller
 * gates on the command's exit status (and, for a requirement with a validator
 * of its own, on that validator); a report's contents are shown as reported.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { benchSectionLines, parseBenchReport } from "./bench.js";
import { commandSummary, finalCommands, type Profile } from "./profile.js";
import { finalRun, finalRunProblem, reportText } from "./validators.js";

export interface FinalSection {
  heading: string;
  lines: string[];
}

/** The report's own summary: a JSON object's `summary`, a line or a list of lines; empty when it has none. */
export function reportSummaryLines(report: string): string[] {
  try {
    const parsed: unknown = JSON.parse(report);
    const summary = parsed !== null && typeof parsed === "object" ? (parsed as { summary?: unknown }).summary : undefined;
    if (typeof summary === "string") return summary.trim() === "" ? [] : [summary.trim()];
    if (Array.isArray(summary)) return summary.filter((l): l is string => typeof l === "string" && l.trim() !== "").map((l) => l.trimEnd());
  } catch {
    // Not JSON: nothing the graph can summarize.
  }
  return [];
}

/**
 * One section for each final command that names a `section` and passed on the
 * candidate `digest`. A command that did not pass has no report worth showing:
 * delivery only happens once every final command passed.
 */
export function finalSections(profile: Profile, evidence: EvidenceRecord[], digest: string | undefined): FinalSection[] {
  const sections: FinalSection[] = [];
  for (const c of finalCommands(profile)) {
    // A benchmark command's section is rendered from its report's own schema, under "Benchmark" unless the profile names it.
    if (c.section === undefined && c.requirement !== "bench-gates") continue;
    const run = finalRun(evidence, c.id, digest);
    if (run === undefined || finalRunProblem(run, c.id) !== undefined) continue;
    if (c.requirement === "bench-gates") {
      const parsed = parseBenchReport(reportText(run));
      if (!("problem" in parsed)) sections.push({ heading: c.section ?? "Benchmark", lines: benchSectionLines(commandSummary(c), parsed) });
      continue;
    }
    const summary = reportSummaryLines(reportText(run));
    sections.push({
      heading: c.section ?? "Final checks",
      lines: [`Reported by ${commandSummary(c)}; the run gated only on its exit status.`, ...(summary.length > 0 ? ["", ...summary] : [])],
    });
  }
  return sections;
}
