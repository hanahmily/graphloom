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
 * Decodes Git's C-style path quoting (`"caf\303\251.go"`), which Git applies
 * to names with non-ASCII or special characters unless `core.quotePath` is off.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(parseInt(oct[0], 8));
      i += oct[0].length;
    } else {
      bytes.push(simple[body.charAt(i + 1)] ?? body.charCodeAt(i + 1));
      i++;
    }
  }
  return new TextDecoder().decode(Uint8Array.from(bytes));
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
  // Lines left in the current hunk's body. An added line such as `++ x` looks
  // like a `+++ ` file header, so headers are only read outside a hunk.
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("-")) oldLeft--;
      else if (line.startsWith("+")) newLeft--;
      else if (line.startsWith(" ")) {
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const name = unquoteGitPath(line.slice(4).split("\t")[0] as string);
      path = name === "/dev/null" ? undefined : name.replace(/^b\//, "");
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    oldLeft = m[1] === undefined ? 1 : Number(m[1]);
    const start = Number(m[2]);
    const count = m[3] === undefined ? 1 : Number(m[3]);
    newLeft = count;
    if (path === undefined || count === 0) continue;
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
