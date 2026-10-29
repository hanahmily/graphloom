// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The claim check (design §6.4): the checker's result contract
 * `claim-check-v1`, and the deterministic reading of it. The checker judges
 * claims only, never tone: a verdict is `supported` only with one to three
 * quotes that match the cited diff text after whitespace is collapsed.
 */
import { validateResultShape } from "@graphloom/sdk";
import type { ReportItem } from "./report.js";
import type { PullFile } from "./snapshot.js";

export const CLAIM_CHECK_SCHEMA_NAME = "claim-check-v1";
export const MAX_QUOTES = 3;
/** Shorter quotes match too easily to support anything. */
const MIN_QUOTE_CHARS = 8;
/** How far a quote may sit from the line it cites. */
const QUOTE_WINDOW = 3;

export const VERDICTS = ["supported", "partial", "unsupported"] as const;
export type ClaimVerdict = (typeof VERDICTS)[number];

export interface Quote {
  path: string;
  line: number;
  text: string;
}

export const CLAIM_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "verdict", "note", "quotes"],
        properties: {
          item: { type: "string" },
          verdict: { type: "string", enum: VERDICTS },
          note: { type: "string" },
          quotes: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["path", "line", "text"], properties: { path: { type: "string" }, line: { type: "integer" }, text: { type: "string" } } },
          },
        },
      },
    },
  },
} as const;

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The quote's text, whitespace collapsed, is on a line of the file's patch within three of the one it cites, on either side. */
export function quoteMatches(q: Quote, file: PullFile): boolean {
  const text = collapse(q.text);
  if (text.length < MIN_QUOTE_CHARS || q.line < 1) return false;
  return file.parsed.lines.some((l) => {
    const numbers = l.kind === "ctx" ? [l.line, l.baseLine ?? l.line] : [l.line];
    return numbers.some((n) => Math.abs(n - q.line) <= QUOTE_WINDOW) && collapse(l.text).includes(text);
  });
}

export interface ClaimReading {
  /** Items the check did not judge at all. */
  unchecked: string[];
  /** Items that stand: `supported` with matching quotes. */
  supported: Set<string>;
  /** Items that do not, with why. */
  weak: Map<string, string>;
}

/**
 * Reads a checker result against the items it was asked about. An item with
 * no verdict is `unchecked`. A `supported` verdict whose quotes do not match
 * is as weak as `unsupported`; an item that cites only files without patch
 * text (a binary file, a pure rename) can have no quote and stands on the
 * checker's word.
 */
export function readClaimCheck(
  output: unknown,
  items: ReadonlyArray<{ id: string; item: ReportItem }>,
  files: readonly PullFile[],
): ClaimReading | { problems: string[] } {
  const shape = validateResultShape(output, CLAIM_CHECK_SCHEMA as unknown as Record<string, unknown>);
  if (shape.length > 0) return { problems: shape.slice(0, 10) };
  const list = (output as { verdicts: Array<{ item: string; verdict: ClaimVerdict; note: string; quotes: Quote[] }> }).verdicts;
  const byItem = new Map<string, (typeof list)[number]>();
  for (const v of list) {
    const id = v.item.trim();
    const earlier = byItem.get(id);
    // Two verdicts for one item: the weaker stands.
    if (earlier === undefined || VERDICTS.indexOf(v.verdict) > VERDICTS.indexOf(earlier.verdict)) byItem.set(id, v);
  }
  const reading: ClaimReading = { unchecked: [], supported: new Set(), weak: new Map() };
  for (const { id, item } of items) {
    const v = byItem.get(id);
    if (v === undefined) {
      reading.unchecked.push(id);
      continue;
    }
    if (v.verdict !== "supported") {
      reading.weak.set(id, `${v.verdict}${v.note.trim() !== "" ? `: ${v.note.trim()}` : ""}`);
      continue;
    }
    const cited = item.cites.map((c) => files.find((f) => f.path === c.path || f.previousPath === c.path)).filter((f): f is PullFile => f !== undefined);
    const textual = cited.some((f) => f.parsed.lines.length > 0);
    const quotes = v.quotes.slice(0, MAX_QUOTES);
    if (!textual) {
      reading.supported.add(id);
      continue;
    }
    const matched = quotes.filter((q) => {
      const file = files.find((f) => f.path === q.path || f.previousPath === q.path);
      return file !== undefined && cited.includes(file) && quoteMatches(q, file);
    });
    if (quotes.length === 0) reading.weak.set(id, "supported without a quote");
    else if (matched.length < quotes.length) reading.weak.set(id, `supported, but ${quotes.length - matched.length} of its ${quotes.length} quote(s) do not match the cited diff text`);
    else reading.supported.add(id);
  }
  return reading;
}
