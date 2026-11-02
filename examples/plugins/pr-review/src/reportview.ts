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
  /**
   * The high-level changes (design §7.6): one for each capability in the briefing's `whatsNew`, in order (ids `W1`…,
   * the briefing's own numbering), with the bullet's cites as their own. Large mode asks about these, not about `items`.
   */
  changes?: ViewItem[];
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
  // A large report is asked about per high-level change, one for each `whatsNew` bullet (design §7.6).
  const whatsNew = isObject(json.briefing) && Array.isArray(json.briefing.whatsNew) ? json.briefing.whatsNew : [];
  const changes: ViewItem[] = whatsNew.flatMap((w, n) => (isObject(w) && typeof w.text === "string" && Array.isArray(w.cites) ? [{ id: highLevelId(n + 1), section: "highlevel", text: w.text, cites: w.cites as Cite[], facts: [] }] : []));
  const m = isObject(json.measurements) ? json.measurements : {};
  return { items, changes, records: Array.isArray(m.records) ? (m.records as MetricsRecord[]) : [], ...(typeof m.none === "string" ? { measurementsNone: m.none } : {}) };
}

/** The id of the n-th high-level change of a large report (`W1`…), which is also the id of its bullet in the briefing. */
export const highLevelId = (n: number): string => `W${n}`;

/** The change items the questions are about: the report's items in the change sections, or in large mode (design §7.6) its high-level changes (the items again when the briefing has none). */
export const changeItems = (view: ReportView, large = false): ViewItem[] => (large && (view.changes ?? []).length > 0 ? view.changes! : view.items.filter((i) => CHANGE_SECTIONS.includes(i.section)));

/** Every entry a question's item id may name: the report's items and the high-level changes. */
export const questionItems = (view: ReportView): ViewItem[] => [...view.items, ...(view.changes ?? [])];
