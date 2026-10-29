// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** One line of a patch, with its line number on the side it belongs to. */
export interface PatchLine {
  kind: "add" | "del" | "ctx";
  /** Head-side number for `add` and `ctx`, base-side number for `del`. */
  line: number;
  /** For `ctx`, the base-side number as well. */
  baseLine?: number;
  text: string;
}

export interface ParsedPatch {
  lines: PatchLine[];
  added: number;
  removed: number;
}

export type Side = "head" | "base";

/**
 * Parses the per-file `patch` GitHub returns: unified-diff hunks with no file
 * headers. Hunk headers give the line numbers; a context line counts on both
 * sides, an added line on the head side, a removed line on the base side.
 */
export function parsePatch(patch: string | null | undefined): ParsedPatch {
  const out: ParsedPatch = { lines: [], added: 0, removed: 0 };
  if (patch === null || patch === undefined || patch === "") return out;
  let head = 0;
  let base = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m !== null) {
      base = Number(m[1]);
      head = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const c = raw.charAt(0);
    const text = raw.slice(1);
    if (c === "+") {
      out.lines.push({ kind: "add", line: head, text });
      head += 1;
      out.added += 1;
    } else if (c === "-") {
      out.lines.push({ kind: "del", line: base, text });
      base += 1;
      out.removed += 1;
    } else if (c === " " || raw === "") {
      // An empty line inside a hunk is a context line whose single space was trimmed.
      out.lines.push({ kind: "ctx", line: head, baseLine: base, text });
      head += 1;
      base += 1;
    }
  }
  // A trailing newline after the last hunk line leaves one bogus empty context line.
  const last = out.lines.at(-1);
  if (last !== undefined && last.kind === "ctx" && last.text === "" && patch.endsWith("\n")) out.lines.pop();
  return out;
}

/** The line numbers a side's hunks cover: head is added and context lines, base is removed and context lines. */
export function sideLines(patch: ParsedPatch, side: Side): Set<number> {
  const set = new Set<number>();
  for (const l of patch.lines) {
    if (side === "head" && l.kind !== "del") set.add(l.line);
    else if (side === "base") {
      if (l.kind === "del") set.add(l.line);
      else if (l.kind === "ctx" && l.baseLine !== undefined) set.add(l.baseLine);
    }
  }
  return set;
}

/** The text of the line numbered `line` on `side`, when a hunk shows it. */
export function lineText(patch: ParsedPatch, side: Side, line: number): string | undefined {
  for (const l of patch.lines) {
    if (side === "head" && l.kind !== "del" && l.line === line) return l.text;
    if (side === "base" && ((l.kind === "del" && l.line === line) || (l.kind === "ctx" && l.baseLine === line))) return l.text;
  }
  return undefined;
}

/** Added lines as head-side line ranges (consecutive added lines merge), for the metrics tools. */
export function addedRanges(patch: ParsedPatch): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const l of patch.lines) {
    if (l.kind !== "add") continue;
    const last = ranges.at(-1);
    if (last !== undefined && last.end + 1 === l.line) last.end = l.line;
    else ranges.push({ start: l.line, end: l.line });
  }
  return ranges;
}
