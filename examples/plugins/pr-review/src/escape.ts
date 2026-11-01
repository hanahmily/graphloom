// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Escaping for the HTML report (design §6.11): every text that came from a model or the pull request goes through
 * `esc`, which is safe in element content and in a double-quoted attribute value (`<`, `>`, `&`, `"` and `'`).
 */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Text cut to `n` characters with an ellipsis, on one line. */
export function clip(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, Math.max(0, n - 1))}…`;
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
