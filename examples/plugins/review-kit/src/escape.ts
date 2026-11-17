// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Escaping for the HTML report (design §6.11): every text that came from a model or the pull request goes through
 * `esc`, which is safe in element content and in a double-quoted attribute value (`<`, `>`, `&`, `"` and `'`).
 */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * `text` cut to at most `n` characters at a sentence end (when one lies in the last two thirds of the cut) or else at a
 * word boundary, never inside a word; a word longer than `n` is the one case cut hard. `cut` says whether anything was lost
 * and whether the cut is at a sentence end (`sentence`).
 */
export function cutAt(text: string, n: number): { text: string; cut: boolean; sentence: boolean } {
  if (text.length <= n) return { text, cut: false, sentence: false };
  const room = Math.max(0, n);
  const head = text.slice(0, room);
  // A boundary only counts when the character after it is a space (or the cut falls exactly there).
  const fits = text.slice(0, room + 1);
  let sentence = -1;
  for (const m of fits.matchAll(/[.!?](?=\s|$)/g)) sentence = m.index! + 1;
  if (sentence >= Math.ceil(room / 3) && sentence > 0) return { text: text.slice(0, sentence).trimEnd(), cut: true, sentence: true };
  const space = /\s/.test(text.charAt(room)) ? room : head.search(/\s\S*$/);
  if (space > 0) return { text: head.slice(0, space).trimEnd(), cut: true, sentence: false };
  return { text: head, cut: true, sentence: false };
}

/** Text on one line, cut to `n` characters (ellipsis included) at a sentence end or a word boundary, never mid-word. */
export function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= n) return one;
  const c = cutAt(one, Math.max(0, n - 1));
  return `${c.text}…`;
}

/** The fenced code blocks of a text as `[start, end)` offsets (a block left open runs to the end), by lines that begin with three backticks. */
export function fencedBlocks(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open: number | undefined;
  let at = 0;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      if (open === undefined) open = at;
      else {
        out.push([open, at + line.length]);
        open = undefined;
      }
    }
    at += line.length + 1;
  }
  if (open !== undefined) out.push([open, text.length]);
  return out;
}

/** The text with every fenced block removed (whole, never cut), and whether any was. */
export function withoutFences(text: string): { text: string; dropped: boolean } {
  const blocks = fencedBlocks(text);
  if (blocks.length === 0) return { text, dropped: false };
  let out = "";
  let from = 0;
  for (const [s, e] of blocks) {
    out += text.slice(from, s);
    from = e;
  }
  out += text.slice(from);
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), dropped: true };
}

/**
 * Like `clip`, but the text keeps its own line breaks: for posted text that is already structured. A fenced code block is
 * atomic: a cut that would fall inside one drops the block whole (and what follows it), so no fence is left open.
 */
export function clipKeep(text: string, n: number): string {
  if (text.length <= n) return text;
  const beforeBlock = (s: number): string => {
    const before = text.slice(0, s).trimEnd();
    return before.length <= n - 1 ? (before === "" ? "…" : `${before}…`) : clipKeep(before, n);
  };
  const blocks = fencedBlocks(text);
  const inside = blocks.find(([s, e]) => s < n && e > n - 1);
  if (inside !== undefined) return beforeBlock(inside[0]);
  const c = cutAt(text, Math.max(0, n - 1));
  // cutAt may retreat to a boundary inside an earlier block: check where the cut actually falls.
  const at = c.text.length;
  const back = blocks.find(([s, e]) => s < at && e > at);
  if (back !== undefined) return beforeBlock(back[0]);
  return c.sentence ? c.text : `${c.text}…`;
}

/** Lines of at most `width` characters, broken at spaces (a word longer than the width is broken), at most `maxLines`, the last clipped. */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter((w) => w !== "");
  const lines: string[] = [];
  let cur = "";
  const push = (): void => {
    if (cur !== "") lines.push(cur);
    cur = "";
  };
  for (let word of words) {
    while (word.length > width) {
      if (cur !== "") push();
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (cur === "") cur = word;
    else if (cur.length + 1 + word.length <= width) cur += ` ${word}`;
    else {
      push();
      cur = word;
    }
  }
  push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = clip(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(" ")}`, width);
  return kept;
}
