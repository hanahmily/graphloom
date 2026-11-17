// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Token-shingle Jaccard similarity (design §7.2 item 2), with shingles of k = 5 tokens. */
import { maskCode } from "./symbols.js";

export const SHINGLE = 5;

/** The tokens of source text: identifiers, numbers and single punctuation marks, comments gone and each string one token. */
export function tokensOf(source: string): string[] {
  const masked = maskCode(source);
  // A blanked string is one placeholder token, so its contents never count and two different strings do not differ.
  const text = masked.replace(/(["'`])\s*\1/g, " STR ");
  return text.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? [];
}

export function shingles(tokens: readonly string[], k: number = SHINGLE): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length <= k) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + k <= tokens.length; i += 1) out.add(tokens.slice(i, i + k).join(" "));
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let both = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) both += 1;
  return both / (a.size + b.size - both);
}

/** The similarity of two source bodies, to two decimals. */
export function similarity(a: string, b: string): number {
  return Math.round(jaccard(shingles(tokensOf(a)), shingles(tokensOf(b))) * 100) / 100;
}
