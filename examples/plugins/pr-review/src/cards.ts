// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The data behind the change cards of `review.html` (design §6.11): for each high-level change (`W1`…), its core files
 * (the reporter's), its synced-along files (the files its cites and its report items touch beyond the core files) and
 * the bounded code excerpts of its cites, cut from the patches of the snapshot. Plugin code computes all of it when
 * `report.json` is written and stores it there as `cards`, so the renderer needs no patch. Deterministic, no model.
 */
import type { FinalBriefing } from "./briefing.js";
import { findFile, type Cite } from "./cites.js";
import type { PatchLine } from "./patch.js";
import type { FinalItem } from "./report.js";
import type { PullFile } from "./snapshot.js";

/** The most lines shown for one cite, for one card, and the longest line (design §6.11). */
export const MAX_EXCERPT_LINES = 12;
export const MAX_CARD_EXCERPT_LINES = 36;
export const MAX_EXCERPT_LINE_CHARS = 160;
/** The most synced-along files a card lists; the rest are counted. */
export const MAX_SYNCED_LISTED = 30;

/** One line of an excerpt: `line` is the head-side number for `add` and `ctx`, the base-side number for `del`. */
export interface ExcerptLine {
  kind: "add" | "del" | "ctx";
  line: number;
  text: string;
}

/** The patch lines a cite covers, in patch order, with how many more the bounds left out. */
export interface Excerpt {
  cite: Cite;
  lines: ExcerptLine[];
  more: number;
}

export interface ChangeCard {
  /** `W1`…: the change's place in the briefing, which its claim and its questions use. */
  id: string;
  title: string;
  overview: string;
  /** The id of the feature whose diagram belongs to this change; empty when none. */
  feature: string;
  /** The reporter's core files, as the pull request names them. */
  core: string[];
  /** The other files its cites and its items touch, in the file list's order (at most `MAX_SYNCED_LISTED`). */
  synced: string[];
  /** How many more synced-along files there are than listed. */
  syncedMore: number;
  excerpts: Excerpt[];
  /** Lines of cites whose excerpt the card's bound left out whole. */
  excerptsMore: number;
}

const clipLine = (text: string): string => {
  const t = text.replace(/\r/g, "");
  return t.length <= MAX_EXCERPT_LINE_CHARS ? t : `${t.slice(0, MAX_EXCERPT_LINE_CHARS - 1)}…`;
};

/** A line's number on `side`, or undefined when the line is not on it. */
function numberOn(l: PatchLine, side: Cite["side"]): number | undefined {
  if (side === "head") return l.kind === "del" ? undefined : l.line;
  return l.kind === "del" ? l.line : l.baseLine;
}

/**
 * The patch lines a cite covers: from the first to the last line the range names on the cite's side, in patch order, so
 * that the removed lines between the added ones show beside them (and a changed line's counterpart on the other side). Undefined when the cite names no lines or none of them
 * lies in a hunk (a whole-file cite, a file with no patch text, a file the pull request does not change).
 */
export function citedHunk(c: Cite, files: readonly PullFile[]): ExcerptLine[] | undefined {
  const file = findFile(files, c.path);
  if (file === undefined || c.start < 1 || c.end < c.start) return undefined;
  const lines = file.parsed.lines;
  let first = -1;
  let last = -1;
  lines.forEach((l, i) => {
    const n = numberOn(l, c.side);
    if (n !== undefined && n >= c.start && n <= c.end) {
      if (first < 0) first = i;
      last = i;
    }
  });
  if (first < 0) return undefined;
  // A changed line is a removed run then an added run: a head cite that starts on the added run takes the removed lines it replaced, and a base cite that ends on the removed run takes the added lines that replace them.
  if (c.side === "head" && lines[first]!.kind === "add") while (first > 0 && lines[first - 1]!.kind === "del") first -= 1;
  else if (c.side === "base" && lines[last]!.kind === "del") while (last < lines.length - 1 && lines[last + 1]!.kind === "add") last += 1;
  return lines.slice(first, last + 1).map((l) => ({ kind: l.kind, line: l.line, text: clipLine(l.text) }));
}

/**
 * The cards of the final report's high-level changes. A change's synced-along files are the pull request's files its
 * cites name and the files cited by the report items that cite one of its core files, less its core files. Auto items
 * (coverage, facts) are not the reporter's grouping and are left out.
 */
export function buildCards(briefing: Pick<FinalBriefing, "whatsNew">, files: readonly PullFile[], items: readonly Pick<FinalItem, "cites" | "auto">[]): ChangeCard[] {
  const order = new Map(files.map((f, i) => [f.path, i] as const));
  return briefing.whatsNew.map((w, n) => {
    const core = new Set(w.coreFiles.flatMap((p) => findFile(files, p)?.path ?? []));
    const touched = new Set<string>();
    const note = (cites: readonly Cite[]): void => {
      for (const c of cites) {
        const f = findFile(files, c.path);
        if (f !== undefined) touched.add(f.path);
      }
    };
    note(w.cites);
    for (const item of items) {
      if (item.auto === "coverage") continue;
      if (item.cites.some((c) => core.has(findFile(files, c.path)?.path ?? ""))) note(item.cites);
    }
    const synced = [...touched].filter((p) => !core.has(p)).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    let budget = MAX_CARD_EXCERPT_LINES;
    let left = 0;
    const excerpts: Excerpt[] = [];
    for (const cite of w.cites) {
      const hunk = citedHunk(cite, files);
      if (hunk === undefined) continue;
      const take = Math.min(MAX_EXCERPT_LINES, budget, hunk.length);
      if (take <= 0) {
        left += hunk.length;
        continue;
      }
      budget -= take;
      excerpts.push({ cite, lines: hunk.slice(0, take), more: hunk.length - take });
    }
    return {
      id: `W${n + 1}`,
      title: w.title,
      overview: w.overview,
      feature: w.feature,
      core: [...core],
      synced: synced.slice(0, MAX_SYNCED_LISTED),
      syncedMore: Math.max(0, synced.length - MAX_SYNCED_LISTED),
      excerpts,
      excerptsMore: left,
    };
  });
}
