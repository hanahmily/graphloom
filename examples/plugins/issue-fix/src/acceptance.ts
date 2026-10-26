// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { AcceptanceItem, CoverageEntry, DecisionRecord } from "./decision-record.js";
import { clip, observablePath } from "./review-common.js";

/**
 * The acceptance-coverage check between the implementer and code review: the
 * planner lists what the issue asks for, the implementer says where each item
 * is implemented and tested, and the graph checks, without a model, that the
 * map is complete and its names are real. Code review is expensive; a skipped
 * requirement it finds costs a Fix and Review round trip (run c44b4ae7-5d1:
 * about 9 of round 1's 14 findings).
 *
 * A plan without an `acceptance` list (a record from before issue-fix 0.10.0,
 * or an issue that states no criteria) gets no check, as before.
 */

/** Distinct files one coverage map may name; each is observed into the evidence. */
export const MAX_COVERAGE_FILES = 40;

const object = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const text = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** The plan's acceptance items, ignoring malformed ones; empty when the plan lists none. */
export function acceptanceItems(plan: DecisionRecord | undefined): AcceptanceItem[] {
  const list = Array.isArray(plan?.acceptance) ? plan.acceptance : [];
  const seen = new Set<string>();
  const items: AcceptanceItem[] = [];
  for (const raw of list as unknown[]) {
    const i = object(raw);
    if (i === undefined || !text(i.id) || !text(i.text) || seen.has(i.id.trim())) continue;
    seen.add(i.id.trim());
    items.push({ id: i.id.trim(), text: i.text.trim() });
  }
  return items;
}

/** The coverage entries a record gives, ignoring malformed ones. A later entry for an id replaces an earlier one. */
export function coverageEntries(record: DecisionRecord | undefined): CoverageEntry[] {
  const list = Array.isArray(record?.coverage) ? record.coverage : [];
  const byId = new Map<string, CoverageEntry>();
  for (const raw of list as unknown[]) {
    const e = object(raw);
    if (e === undefined || !text(e.id)) continue;
    const files = (Array.isArray(e.files) ? e.files : []).filter(text).map((f) => f.trim());
    const tests = (Array.isArray(e.tests) ? e.tests : []).flatMap((t) => {
      const o = object(t);
      return o !== undefined && text(o.file) ? [{ file: o.file.trim(), name: typeof o.name === "string" ? o.name.trim() : "" }] : [];
    });
    byId.set(e.id.trim(), { id: e.id.trim(), files, tests });
  }
  return [...byId.values()];
}

/** Every distinct file the map names, in order. */
export function coverageFiles(entries: CoverageEntry[]): string[] {
  return [...new Set(entries.flatMap((e) => [...e.files, ...e.tests.map((t) => t.file)]))];
}

/** The named files the controller can observe: the rest cannot be read, and are judged against the change's own paths. */
export const observableCoverageFiles = (entries: CoverageEntry[]): string[] => coverageFiles(entries).filter(observablePath);

/** What the graph knows about a file in the candidate: absent, or its bytes. */
export type CandidateFile = { exists: false } | { exists: true; bytes: string };

/**
 * Why the implementer's coverage map does not show every acceptance item
 * done: an item without an entry, an entry naming nothing, a named file that
 * is not in the candidate, a test file without the test's name. `read` gives
 * the observed file, or undefined for one that was never observed; `changed`
 * is the candidate's changed paths, the only evidence for a file the
 * controller cannot observe.
 */
export function coverageProblems(items: AcceptanceItem[], entries: CoverageEntry[], read: (path: string) => CandidateFile | undefined, changed: readonly string[]): string[] {
  const problems: string[] = [];
  const entry = new Map(entries.map((e) => [e.id, e]));
  const file = (path: string): CandidateFile => {
    if (observablePath(path)) return read(path) ?? { exists: false };
    // Not a path the controller can observe: only a changed file is known to exist.
    return changed.includes(path) ? { exists: true, bytes: "" } : { exists: false };
  };
  if (coverageFiles(entries).length > MAX_COVERAGE_FILES) {
    return [`the coverage map names ${coverageFiles(entries).length} files; name at most ${MAX_COVERAGE_FILES}, the ones that matter most for each item`];
  }
  for (const item of items) {
    const label = `${item.id} (${clip(item.text, 140)})`;
    const e = entry.get(item.id);
    if (e === undefined) {
      problems.push(`${label} has no entry in the record's coverage`);
      continue;
    }
    if (e.files.length === 0 && e.tests.length === 0) {
      problems.push(`${label} names no file and no test`);
      continue;
    }
    for (const path of e.files) {
      if (!file(path).exists) problems.push(`${label}: file ${path} does not exist in the change`);
    }
    for (const t of e.tests) {
      const found = file(t.file);
      if (!found.exists) problems.push(`${label}: test file ${t.file} does not exist in the change`);
      else if (t.name === "") problems.push(`${label}: the test in ${t.file} is named without its title`);
      else if (observablePath(t.file) && !found.bytes.includes(t.name)) problems.push(`${label}: test "${clip(t.name, 100)}" does not appear in ${t.file}`);
    }
  }
  return problems;
}

/** The correction the implementer gets for coverage problems. */
export function coverageFeedback(problems: string[]): string {
  return (
    `acceptance-coverage: the controller checks, before code review, that the record's coverage shows every acceptance item done: ${problems.join("; ")}. ` +
    "Finish any item that is not implemented or tested, then return the record again with one coverage entry per acceptance item, naming only files that exist and tests whose title appears in their file."
  );
}

/** The reviewer's block: the acceptance list and where the implementer says each item is done. */
export function coverageBlock(items: AcceptanceItem[], entries: CoverageEntry[]): string[] {
  if (items.length === 0) return [];
  const entry = new Map(entries.map((e) => [e.id, e]));
  return [
    "",
    "The issue's acceptance items, and where the implementer says each is implemented and tested. The graph checked that every named file exists and every named test title appears in its file; you verify that the code does what each item says and that the tests really cover it:",
    ...items.map((i) => {
      const e = entry.get(i.id);
      const files = e?.files.length ? e.files.join(", ") : "none";
      const tests = e?.tests.length ? e.tests.map((t) => `${t.file}: ${t.name}`).join("; ") : "none";
      return `- ${i.id}: ${clip(i.text, 400)} (files: ${files}; tests: ${tests})`;
    }),
  ];
}
