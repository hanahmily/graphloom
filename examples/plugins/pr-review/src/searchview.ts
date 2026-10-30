// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** How a search reads in the Q&A (design §7.4): the plugin's measured count is the fact, the agent's own is flagged. */
import { searchKey, searchWhere, type MeasuredSearch, type Search } from "./searches.js";

const flat = (s: string, n: number): string => {
  const one = s.replace(/\s*\n\s*/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

const hits = (n: number): string => `${n} hit${n === 1 ? "" : "s"}`;

/**
 * A search as the Q&A shows it. The measured count stands alone when the agent's own agrees; otherwise both are
 * shown ("measured 54 in 9 files (reported 0: mismatch)"); with nothing measured the agent's is marked as such.
 */
export function searchLine(s: MeasuredSearch, width: number): string {
  const head = `\`${flat(s.pattern, width)}\` (${searchWhere(s)})`;
  if (s.measured === undefined) return `${head} → reported ${hits(s.hits)}, not measured${s.note !== undefined ? ` (${flat(s.note, 160)})` : ""}`;
  if (s.measured === s.hits) return `${head} → ${hits(s.measured)} (measured)`;
  return `${head} → measured ${hits(s.measured)} in ${s.files ?? 0} file${s.files === 1 ? "" : "s"} (reported ${s.hits}: mismatch)`;
}

/** `s` with its measurement, when `measured` holds this search (the same pattern, tree, paths and case flag). */
export const withMeasure = (s: Search, measured: readonly MeasuredSearch[]): MeasuredSearch => measured.find((m) => searchKey(m) === searchKey(s)) ?? s;
