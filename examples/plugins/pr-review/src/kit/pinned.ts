// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** The pull request's pinned text (its title, body and commit messages) and whether a quote lies inside it (design §7.1). */

const MIN_QUOTE_CHARS = 12;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The pull request's own text, which a stated purpose must quote. */
export interface PinnedText {
  source: "title" | "body" | "commit";
  text: string;
}

/** Whether `quote`, with whitespace collapsed, lies inside the pinned text of that source. */
export function quoteInPinned(quote: string, source: PinnedText["source"], pinned: readonly PinnedText[]): boolean {
  const q = collapse(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return pinned.some((p) => p.source === source && collapse(p.text).includes(q));
}

/** The pinned text a stated purpose may quote: the title, the body and each commit message. */
export function pinnedTexts(pull: { title: string; body: string }, commits: ReadonlyArray<{ message: string }>): PinnedText[] {
  return [{ source: "title", text: pull.title }, { source: "body", text: pull.body }, ...commits.map((c): PinnedText => ({ source: "commit", text: c.message }))];
}
