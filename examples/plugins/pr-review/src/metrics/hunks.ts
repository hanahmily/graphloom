// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { Hunks } from "./record.js";

/**
 * Parses the tools' hunk file: one `path:start-end` (or `path:line`) per
 * line, head side, 1-based, inclusive. Blank lines and `#` lines are ignored.
 */
export function parseHunkFile(text: string): Hunks {
  const hunks: Hunks = new Map();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(line);
    if (!m) throw new Error(`hunks line ${i + 1}: want path:start-end, got "${line}"`);
    const start = Number(m[2]);
    const end = m[3] === undefined ? start : Number(m[3]);
    if (start < 1 || end < start) throw new Error(`hunks line ${i + 1}: bad range "${line}"`);
    const list = hunks.get(m[1] as string) ?? [];
    list.push({ start, end });
    hunks.set(m[1] as string, list);
  });
  return hunks;
}

export function formatHunkFile(hunks: Hunks): string {
  const lines: string[] = [];
  for (const path of [...hunks.keys()].sort()) {
    for (const r of hunks.get(path) ?? []) lines.push(`${path}:${r.start}-${r.end}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/**
 * Head-side added or changed line ranges from a unified diff made with `-U0`
 * (for example `git diff -U0 -w base head`). With `-w` a whitespace-only
 * change is not a hunk, so it does not make a function "modified". Pure
 * deletions have no head lines and yield no range.
 */
export function hunksFromUnifiedDiff(diff: string): Hunks {
  const hunks: Hunks = new Map();
  let path: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const name = line.slice(4).split("\t")[0] as string;
      path = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m || path === undefined) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count === 0) continue;
    const list = hunks.get(path) ?? [];
    list.push({ start, end: start + count - 1 });
    hunks.set(path, list);
  }
  return hunks;
}

export function changedLines(ranges: readonly { start: number; end: number }[] | undefined): Set<number> {
  const set = new Set<number>();
  for (const r of ranges ?? []) for (let l = r.start; l <= r.end; l++) set.add(l);
  return set;
}
