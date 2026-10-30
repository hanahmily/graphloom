// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The claim check (design §6.4): the checker's result contract
 * `claim-check-v1`, and the deterministic reading of it. The checker judges
 * claims only, never tone: a verdict is `supported` only with one to three
 * quotes that match the cited diff text after whitespace is collapsed. A
 * claim is the summary's purpose or overview, an item, one state entry of an
 * item's lifecycle (and each of its transitions and reads), or one row of its
 * before/after table.
 */
import { validateResultShape } from "@graphloom/sdk";
import { resolveId } from "./ids.js";
import { behaviorId, numbered, readId, stateId, transitionId, type Cite, type ReportContext, type ReporterOutput } from "./report.js";
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

/** The id field of the claim checker's contract: constrained, per job, to the claim ids the assignment lists. */
export const CLAIM_CHECK_REFERENCES = ["verdicts[].item"] as const;

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

/** One claim the checker judges. */
export interface ClaimTarget {
  /** `purpose`, `overview`, `R3`, `R3.s1`, `R3.s1.t2`, `R3.s1.r1`, `R3.b2`. */
  id: string;
  /** What the checker is told to judge. */
  text: string;
  /** The citations whose files the quotes may come from; undefined for any changed file. */
  cites: Cite[] | undefined;
  /** A stated purpose quotes the pull request's own text, matched deterministically: it needs no diff quote. */
  quotes: "required" | "none";
}

/** Every claim of a report, in the order the checker is shown them: the summary, then each item with its lifecycle entries and behavior rows. */
export function claimTargets(report: ReporterOutput, ctx: Pick<ReportContext, "sections">): ClaimTarget[] {
  const out: ClaimTarget[] = [
    {
      id: "purpose",
      text: `${report.purpose.source === "stated" ? `Purpose, stated (quote: "${collapse(report.purpose.quote)}")` : "Purpose, inferred from the diff"}: ${collapse(report.purpose.text)}`,
      cites: undefined,
      quotes: report.purpose.source === "stated" ? "none" : "required",
    },
    { id: "overview", text: `Overview: ${collapse(report.overview)}`, cites: undefined, quotes: "required" },
  ];
  for (const { id, section, item } of numbered(report, ctx)) {
    out.push({ id, text: `[${section}] ${collapse(item.text)}`, cites: item.cites, quotes: "required" });
    item.state.forEach((e, si) => {
      const steps = [...e.transitions.map((t) => t.cite), ...e.reads.map((r) => r.cite)];
      out.push({ id: stateId(id, si), text: `State ${e.name}, scope ${collapse(e.scope)}, initial value: ${collapse(e.initial)}`, cites: steps.length > 0 ? steps : item.cites, quotes: "required" });
      e.transitions.forEach((t, n) => out.push({ id: transitionId(id, si, n), text: `${e.name} changes when ${collapse(t.when)}: ${collapse(t.effect)}`, cites: [t.cite], quotes: "required" }));
      e.reads.forEach((r, n) => out.push({ id: readId(id, si, n), text: `${e.name} is read ${collapse(r.where)}, where it decides: ${collapse(r.decision)}`, cites: [r.cite], quotes: "required" }));
    });
    item.behavior.forEach((b, bi) => out.push({ id: behaviorId(id, bi), text: `Case "${collapse(b.case)}": before: ${collapse(b.before)}; after: ${collapse(b.after)}`, cites: undefined, quotes: "required" }));
  }
  return out;
}

export interface ClaimReading {
  /** Claims the check did not judge at all. */
  unchecked: string[];
  /** Claims that stand: `supported` with matching quotes. */
  supported: Set<string>;
  /** Claims that do not, with why. */
  weak: Map<string, string>;
  /** What was normalized in reading the verdicts' ids, recorded and never silent. */
  notes: string[];
  /** Verdict ids that matched no claim (unknown or ambiguous); those claims stay unjudged. */
  ignored: string[];
}

/**
 * Reads a checker result against the claims it was asked about. A claim with
 * no verdict is `unchecked`. A `supported` verdict whose quotes do not match
 * is as weak as `unsupported`; a claim that cites only files without patch
 * text (a binary file, a pure rename) can have no quote and stands on the
 * checker's word, as does a stated purpose, whose own quote the
 * deterministic validation matched against the pull request's text.
 */
export function readClaimCheck(output: unknown, targets: readonly ClaimTarget[], files: readonly PullFile[]): ClaimReading | { problems: string[] } {
  const shape = validateResultShape(output, CLAIM_CHECK_SCHEMA as unknown as Record<string, unknown>);
  if (shape.length > 0) return { problems: shape.slice(0, 10) };
  const list = (output as { verdicts: Array<{ item: string; verdict: ClaimVerdict; note: string; quotes: Quote[] }> }).verdicts;
  const byItem = new Map<string, (typeof list)[number]>();
  const listed = new Set(targets.map((t) => t.id));
  const notes: string[] = [];
  const ignored: string[] = [];
  for (const v of list) {
    // The contract's enum should have made the id exact; one that is not is read only when it begins with one listed id.
    const r = resolveId(v.item, listed);
    if (r.id === undefined) {
      ignored.push(`${JSON.stringify(v.item.length > 60 ? `${v.item.slice(0, 59)}…` : v.item)} (${r.why})`);
      continue;
    }
    if (r.note !== undefined) notes.push(`the claim checker's ${r.note}`);
    const id = r.id;
    const earlier = byItem.get(id);
    // Two verdicts for one claim: the weaker stands.
    if (earlier === undefined || VERDICTS.indexOf(v.verdict) > VERDICTS.indexOf(earlier.verdict)) byItem.set(id, v);
  }
  const reading: ClaimReading = { unchecked: [], supported: new Set(), weak: new Map(), notes, ignored };
  const findFile = (path: string): PullFile | undefined => files.find((f) => f.path === path || f.previousPath === path);
  for (const { id, cites, quotes: need } of targets) {
    const v = byItem.get(id);
    if (v === undefined) {
      reading.unchecked.push(id);
      continue;
    }
    if (v.verdict !== "supported") {
      reading.weak.set(id, `${v.verdict}${v.note.trim() !== "" ? `: ${v.note.trim()}` : ""}`);
      continue;
    }
    const cited = cites === undefined ? [...files] : cites.map((c) => findFile(c.path)).filter((f): f is PullFile => f !== undefined);
    const textual = cited.some((f) => f.parsed.lines.length > 0);
    const quotes = v.quotes.slice(0, MAX_QUOTES);
    if (!textual || need === "none") {
      reading.supported.add(id);
      continue;
    }
    const matched = quotes.filter((q) => {
      const file = findFile(q.path);
      return file !== undefined && cited.includes(file) && quoteMatches(q, file);
    });
    if (quotes.length === 0) reading.weak.set(id, "supported without a quote");
    else if (matched.length < quotes.length) reading.weak.set(id, `supported, but ${quotes.length - matched.length} of its ${quotes.length} quote(s) do not match the cited diff text`);
    else reading.supported.add(id);
  }
  return reading;
}
