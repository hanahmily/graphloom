// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The finished report as the Questions and Answers stages read it: the
 * `report.json` the Report stage wrote, taken from the evidence of its write
 * command (the Report stage's validators already recomputed it from the claim
 * check, which a later review's evidence supersedes, so it is the one place
 * the final items and the measurement records stay readable).
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { isObject } from "./evidence.js";
import type { MetricsRecord } from "./metrics/record.js";
import type { Cite } from "./report.js";
import { recordedReport } from "./parts.js";

/** The report sections whose items are change items (design §7.1). */
export const CHANGE_SECTIONS: readonly string[] = ["schema", "background", "features", "external", "config", "interfaces", "removed"];

export interface ViewItem {
  id: string;
  section: string;
  text: string;
  cites: Cite[];
  facts: string[];
}

export interface ReportView {
  items: ViewItem[];
  records: MetricsRecord[];
  /** Why there are no records, when the measurements say none were taken. */
  measurementsNone?: string;
}

/** The report the latest successful write recorded, or undefined when none was written. */
export function reportView(evidence: readonly EvidenceRecord[]): ReportView | undefined {
  // `report.json` as the write recorded it: its single command, or the part set it was written as (design §6.6).
  const written = recordedReport(evidence);
  if (written.state !== "read") return undefined;
  let json: unknown;
  try {
    json = JSON.parse(written.value.json);
  } catch {
    return undefined;
  }
  if (!isObject(json) || !Array.isArray(json.sections)) return undefined;
  const items: ViewItem[] = [];
  for (const s of json.sections) {
    if (!isObject(s) || typeof s.id !== "string" || !Array.isArray(s.items)) continue;
    for (const i of s.items) {
      if (isObject(i) && typeof i.id === "string" && typeof i.text === "string" && Array.isArray(i.cites)) {
        items.push({ id: i.id, section: s.id, text: i.text, cites: i.cites as Cite[], facts: Array.isArray(i.facts) ? (i.facts as string[]) : [] });
      }
    }
  }
  const m = isObject(json.measurements) ? json.measurements : {};
  return { items, records: Array.isArray(m.records) ? (m.records as MetricsRecord[]) : [], ...(typeof m.none === "string" ? { measurementsNone: m.none } : {}) };
}

/** The change items: report items in the sections the questions are about. */
export const changeItems = (view: ReportView): ViewItem[] => view.items.filter((i) => CHANGE_SECTIONS.includes(i.section));
