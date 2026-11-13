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

/** Like `clip`, but the text keeps its own line breaks: for posted text that is already structured. */
export function clipKeep(text: string, n: number): string {
  if (text.length <= n) return text;
  const c = cutAt(text, Math.max(0, n - 1));
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
