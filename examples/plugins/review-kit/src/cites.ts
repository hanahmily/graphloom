// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A citation of the report (design §6.5): a place in the diff, on one side, that a claim rests on, its contract
 * fragment and its deterministic check. Shared by the items, the lifecycle entries and the briefing fields.
 */
import { sideLines, type Side } from "./patch.js";
import type { PullFile } from "./snapshot.js";

export interface Cite {
  path: string;
  side: Side;
  /** First and last line on `side`; 0 and 0 cite the file as a whole, which only a file with no patch text may do. */
  start: number;
  end: number;
  /** A symbol that appears in the file's patch; empty when none. */
  symbol: string;
}

export const CITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "side", "start", "end", "symbol"],
  properties: {
    path: { type: "string" },
    side: { type: "string", enum: ["head", "base"] },
    start: { type: "integer" },
    end: { type: "integer" },
    symbol: { type: "string" },
  },
};

export function findFile(files: readonly PullFile[], path: string): PullFile | undefined {
  return files.find((f) => f.path === path || f.previousPath === path);
}

const isRelativePath = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.startsWith("-") && !p.split("/").some((s) => s === "..") && !/[\n\0\\]/.test(p);

/**
 * The problems with one citation. A citation names a file of the pull request and lines inside its hunks on the side it
 * names. With `tree` (the briefing fields of a large report, whose claims are verified against the trees) the lines need
 * not lie in a hunk, and a file the pull request does not change may be cited too, by a repository-relative path and a
 * range of lines that a command checks in the tree.
 */
export function citeProblem(c: Cite, files: readonly PullFile[], at: string, problems: string[], rangeRequired: boolean, tree = false): void {
  const file = findFile(files, c.path);
  if (file === undefined) {
    if (tree && isRelativePath(c.path) && Number.isInteger(c.start) && Number.isInteger(c.end) && c.start >= 1 && c.end >= c.start) return;
    problems.push(`${at}: cites ${c.path}, which is not a file of the pull request${tree ? " (a file it does not change is cited by its repository-relative path and a range of lines, from 1)" : ""}`);
    return;
  }
  const where = `${at}: ${c.path}`;
  const hasPatch = file.parsed.lines.length > 0;
  if (c.start === 0 && c.end === 0) {
    if (hasPatch && rangeRequired) problems.push(`${where}: the file has patch text, so cite the lines (start and end on the ${c.side} side, inside a hunk), not 0 and 0 or a symbol alone; 0 and 0 is only for a file with no patch text`);
  } else if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 1 || c.end < c.start) {
    problems.push(`${where}: the lines ${c.start}-${c.end} are not a range (use 0 and 0 to cite a file with no patch text as a whole)`);
  } else if (!hasPatch) {
    problems.push(`${where}: the file has no patch text, so no lines of it can be cited; cite it as a whole`);
  } else if (!tree) {
    const lines = sideLines(file.parsed, c.side);
    const missing = [];
    for (let l = c.start; l <= c.end && missing.length < 3; l += 1) if (!lines.has(l)) missing.push(l);
    if (missing.length > 0) problems.push(`${where}: line(s) ${missing.join(", ")} on the ${c.side} side are outside the file's hunks`);
  }
  if (c.symbol !== "") {
    if (!hasPatch) problems.push(`${where}: the symbol ${JSON.stringify(c.symbol)} cannot be found: the file has no patch text`);
    else if (!file.parsed.lines.some((l) => l.text.includes(c.symbol))) problems.push(`${where}: the symbol ${JSON.stringify(c.symbol)} does not appear in the file's patch`);
  }
}
