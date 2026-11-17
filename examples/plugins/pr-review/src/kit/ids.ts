// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Reading the ids an agent writes back (design §7.3). The contracts constrain
 * every id field to an enum of the exact ids the assignment lists, so a
 * well-behaved harness cannot write anything else. This is the second line of
 * defence for one that does anyway (a verdict keyed `Q1 [split-function]`, or
 * by the whole question text): an id that is not exactly a listed one is
 * accepted only when it begins with exactly one listed id token followed by a
 * non-alphanumeric character. Anything else, an unknown or an ambiguous id,
 * stays unjudged. Every normalization is reported, so it is recorded in the
 * Q&A, never silent.
 */

/** The id token an agent's text may begin with: `Q1`, `N1`, `R3`, `R3.s1.t2`, or a claim's `purpose` / `overview`. */
const TOKEN = /^(?:purpose|overview|[NQR]\d+(?:\.[sbtr]\d+)*)(?![A-Za-z0-9]|\.[A-Za-z0-9])/;
/** What follows the leading token when the text names more than one id: `, Q2`, `/Q2`, ` and Q2`, `-Q3`. */
const JOINED = /^\s*(?:,|;|\/|&|\+|-|–|—|and\b|or\b|vs\.?|to\b)\s*[NQR]\d+/i;

export type IdResolution = { id: string; note?: string } | { id: undefined; why: "unknown" | "ambiguous" };

const shown = (s: string): string => JSON.stringify(s.length > 60 ? `${s.slice(0, 59)}…` : s);

/** The listed id `raw` names, or why it names none. An exact id is returned without a note. */
export function resolveId(raw: string, listed: ReadonlySet<string>): IdResolution {
  if (listed.has(raw)) return { id: raw };
  const text = raw.trim();
  if (listed.has(text)) return { id: text, note: `id ${shown(raw)} had surrounding whitespace; read as ${text}` };
  const token = TOKEN.exec(text)?.[0];
  if (token === undefined || !listed.has(token)) return { id: undefined, why: "unknown" };
  if (JOINED.test(text.slice(token.length))) return { id: undefined, why: "ambiguous" };
  return { id: token, note: `id ${shown(text)} is not a bare id; read as ${token}` };
}

/**
 * Resolves the ids of a list of keyed entries. `unresolved` names the keys that matched no listed id and why;
 * `notes` records each normalization.
 */
export function resolveIds<T>(entries: readonly T[], keyOf: (e: T) => string, listed: ReadonlySet<string>): { entries: Array<{ entry: T; id: string | undefined }>; notes: string[]; unresolved: string[] } {
  const notes: string[] = [];
  const unresolved: string[] = [];
  const out = entries.map((entry) => {
    const raw = keyOf(entry);
    const r = resolveId(raw, listed);
    if (r.id === undefined) {
      unresolved.push(`${shown(raw)} (${r.why})`);
      return { entry, id: undefined };
    }
    if (r.note !== undefined) notes.push(r.note);
    return { entry, id: r.id };
  });
  return { entries: out, notes, unresolved };
}
