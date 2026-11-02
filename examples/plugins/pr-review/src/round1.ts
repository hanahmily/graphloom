// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Round 1 (design §9.4): the report and the Q&A, the architecture and design level. Its issues are computed by plugin code from
 * `necessity.json` and `qa.json`, with no model and no human: the conclusion of N1 when it is not `necessary`, every question
 * that needs the author or is only partially answered, every answer that found an existing equivalent, a reusable library
 * or common logic, and every missing-test question whose answer finds no covering test, even when it is fully answered. Any
 * issue blocks round 2, so the run publishes round 1 and ends; none lets the same run continue into the review layer.
 * The computation is a pure function over the two artifacts, recorded once as `round1.json`; the validator recomputes it.
 */
import { isTestPath } from "./answers.js";
import { anchored, scrub, type ItemCites } from "./draft.js";
import type { FullPack } from "./packs.js";
import { effectiveConclusion, brokenNote, parseNecessityRecord, NECESSITY_ID } from "./necessity.js";
import type { PullFile } from "./snapshot.js";

export const ROUND1_SCHEMA = "pr-review-round1-v1";
export const ROUND1_RECORD_ID = "round1";
export const ROUND1_DIR = "round1";

export type Round1Kind = "necessity" | "needs-author" | "partial" | "existing" | "missing-test";

/** What each kind of issue says to the author, the first words of its comment. */
export const ROUND1_LABEL: Record<Round1Kind, string> = {
  necessity: "necessity",
  "needs-author": "needs the author",
  partial: "partially answered",
  existing: "something equivalent already exists",
  "missing-test": "no covering test",
};

export interface Round1Issue {
  /** `N1` or the question's id (`Q3`): the id the posted comment's marker carries. */
  id: string;
  kinds: Round1Kind[];
  /** The Q&A status of the answer behind it (N1's follows its conclusion). */
  status: string;
  /** The comment text, without its marker. */
  body: string;
  path?: string;
  line?: number;
  /** The place lies inside a hunk of the file's patch at the head; otherwise the issue goes in the review body. */
  anchored: boolean;
}

export interface Round1Record {
  schema: typeof ROUND1_SCHEMA;
  head: string;
  /** N1's conclusion as the Q&A shows it. */
  necessity: string;
  issues: Round1Issue[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface QaQuestion {
  id: string;
  type: string;
  item: string;
  symbol?: string;
  functionPath?: string;
  text: string;
  answer?: { answer: string; status: string; none_found: boolean; citations: Array<{ path: string; start: number; end: number; tree: string }> };
}

function qaOf(json: string): { questions: QaQuestion[]; symbols: Array<{ id: string; path: string; startLine: number }> } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isObj(v) || !Array.isArray(v.questions)) return undefined;
  const questions = v.questions.filter(isObj).map((q): QaQuestion => {
    const a = isObj(q.answer) ? q.answer : undefined;
    return {
      id: str(q.id),
      type: str(q.type),
      item: str(q.item),
      ...(typeof q.symbol === "string" ? { symbol: q.symbol } : {}),
      ...(typeof q.functionPath === "string" ? { functionPath: q.functionPath } : {}),
      text: str(q.text),
      ...(a !== undefined && typeof a.status === "string"
        ? { answer: { answer: str(a.answer), status: a.status, none_found: a.none_found === true, citations: (Array.isArray(a.citations) ? a.citations.filter(isObj) : []).map((c) => ({ path: str(c.path), start: Number(c.start) || 0, end: Number(c.end) || 0, tree: str(c.tree) })) } }
        : {}),
    };
  });
  const symbols = (Array.isArray(v.symbols) ? v.symbols.filter(isObj) : []).map((s) => ({ id: str(s.id), path: str(s.path), startLine: Number(s.startLine) || 1 }));
  return { questions, symbols };
}

export interface Round1Input {
  head: string;
  /** `necessity.json` as written, when the run has one. */
  necessity: string | undefined;
  /** `qa.json` as written. */
  qa: string;
  files: readonly PullFile[];
  /** The first head cite of each change item of the report, which anchors a question that names no symbol. */
  itemCites: ItemCites;
  /** The effective language packs: a cited path is a test by their `testFiles` convention, as answer validation judges it. */
  packs: readonly FullPack[];
}

/**
 * The issues of round 1 from the artifacts, in question order (N1 first). Undefined when `qa.json` is not a Q&A file. An
 * answer can match several kinds at once; it is one issue with all of them, and its status is the answer's own.
 */
export function round1Record(i: Round1Input): Round1Record | undefined {
  const qa = qaOf(i.qa);
  if (qa === undefined) return undefined;
  const record = i.necessity !== undefined ? parseNecessityRecord(i.necessity) : undefined;
  const conclusion = record !== undefined ? effectiveConclusion(record.final) : "needs author";
  const issues: Round1Issue[] = [];
  const place = (path: string, line: number): { path: string; line: number; anchored: boolean } => ({ path, line, anchored: anchored(i.files.find((f) => f.path === path), "RIGHT", line, line) });
  if (conclusion !== "necessary") {
    const n = record?.final.necessity;
    const changed = n?.design.changed.find((c) => c.tree === "head");
    const note = record !== undefined ? brokenNote(record.final) : "";
    issues.push({
      id: NECESSITY_ID,
      kinds: ["necessity"],
      status: record?.final.status ?? "needs author",
      body: scrub([`**Necessity: ${conclusion}.** ${clip(oneLine(n?.rationale ?? "N1 has no recorded answer."), 700)}`, ...(note !== "" ? [note] : []), `Please say why this change is needed, or what in the system's design it follows.`].join("\n\n")),
      ...(changed !== undefined ? place(changed.path, changed.start) : { anchored: false }),
    });
  }
  for (const q of qa.questions) {
    if (q.type === "necessity" || q.answer === undefined) continue;
    const a = q.answer;
    const kinds: Round1Kind[] = [];
    if (a.status === "needs author") kinds.push("needs-author");
    if (a.status === "partially answered") kinds.push("partial");
    if (q.type === "existing-reuse-common" && !a.none_found) kinds.push("existing");
    if (q.type === "missing-test" && (a.none_found || !a.citations.some((c) => c.tree !== "dependency" && isTestPath(i.packs, c.path)))) kinds.push("missing-test");
    if (kinds.length === 0) continue;
    const sym = q.symbol !== undefined ? qa.symbols.find((s) => s.id === q.symbol) : undefined;
    const cite = i.itemCites[q.item];
    const at = sym !== undefined ? { path: sym.path, line: sym.startLine } : q.functionPath !== undefined ? { path: q.functionPath, line: 1 } : cite !== undefined ? { path: cite.path, line: cite.start } : undefined;
    const cited = a.citations.filter((c) => c.path !== "").slice(0, 3).map((c) => `\`${c.path}${c.start > 0 ? `:${c.start}` : ""}\``);
    issues.push({
      id: q.id,
      kinds,
      status: a.status,
      body: scrub(`**${kinds.map((k) => ROUND1_LABEL[k]).join("; ")}** (${q.id}). ${oneLine(q.text)}\n\n${a.status === "needs author" ? "What was checked" : `Answer (${a.status})`}: ${clip(oneLine(a.answer), 600)}${cited.length > 0 && (kinds.includes("existing") || kinds.includes("missing-test")) ? `\n\nSee ${cited.join(", ")}.` : ""}`),
      ...(at !== undefined ? place(at.path, at.line) : { anchored: false }),
    });
  }
  return { schema: ROUND1_SCHEMA, head: i.head, necessity: conclusion, issues };
}

export const round1Json = (r: Round1Record): string => JSON.stringify(r);

export function parseRound1Record(json: string): Round1Record | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObj(v) || v.schema !== ROUND1_SCHEMA || typeof v.head !== "string" || typeof v.necessity !== "string" || !Array.isArray(v.issues)) return undefined;
    return v as unknown as Round1Record;
  } catch {
    return undefined;
  }
}
