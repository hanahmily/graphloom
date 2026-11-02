// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The questions (design §7.1). Plugin rules decide which are required; the
 * questioner phrases and groups them and may add more, and cannot drop one: a
 * required question the questioner left out is added with the plugin's own
 * wording. A purpose the pull request's text states is recorded with the
 * quote that shows it instead of asked, and the quote must match the pinned
 * text. Questions carry no severity or verdict.
 */
import { validateResultShape } from "@graphloom/sdk";
import type { EvidenceRecord } from "@graphloom/sdk";
import { agentRuns, type AgentRun } from "./evidence.js";
import type { Groundwork } from "./groundwork.js";
import { checkThresholds, exceeds, LIMITS, originText, type Metric } from "./metrics/crap.js";
import type { MetricsRecord } from "./metrics/record.js";
import { changeItems, questionItems, type ReportView, type ViewItem } from "./reportview.js";
import type { SymbolDef } from "./symbols.js";

export const QUESTIONS_SCHEMA_NAME = "questions-v1";
export const MAX_QUESTION_CHARS = 500;
export const MAX_ADDED_QUESTIONS = 30;
export const MAX_QUESTION_CORRECTIONS = 2;
const MIN_QUOTE_CHARS = 12;

export const QUESTION_TYPES = ["necessity", "purpose", "existing-reuse-common", "missing-test", "split-function", "complexity-coverage", "weak-test", "other"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
/**
 * The one question every new mechanism is asked (design §7.1): does the codebase already have it, can an existing
 * library do it, is there common logic to share. Standard mode asks it for each new symbol, large mode for each
 * high-level change (design §7.6); its answer is one statement with one status that addresses all three.
 */
export const REUSE_TYPE = "existing-reuse-common";

/** The types the questioner may add: a weak-test question exists only for a surviving mutant, which the graph, not the questioner, finds; the necessity question N1 is the plugin's own and comes first. */
const ADDABLE: readonly string[] = QUESTION_TYPES.filter((t) => t !== "weak-test" && t !== "necessity");

/** The id fields of the questioner's contract: each is constrained, per job, to the report's item ids and the groundwork's symbol ids. */
export const QUESTIONS_REFERENCES = ["purposes[].item", "questions[].item", "questions[].symbol"] as const;

export const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["purposes", "questions"],
  properties: {
    purposes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "source", "quote"],
        properties: { item: { type: "string" }, source: { type: "string", enum: ["title", "body", "commit"] }, quote: { type: "string" } },
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "type", "item", "symbol", "text"],
        properties: { key: { type: "string" }, type: { type: "string", enum: QUESTION_TYPES.filter((t) => t !== "necessity") }, item: { type: "string" }, symbol: { type: "string" }, text: { type: "string" } },
      },
    },
  },
} as const;

export interface QuestionerOutput {
  purposes: Array<{ item: string; source: "title" | "body" | "commit"; quote: string }>;
  questions: Array<{ key: string; type: QuestionType; item: string; symbol: string; text: string }>;
}

/** The pull request's own text, which a stated purpose must quote. */
export interface PinnedText {
  source: "title" | "body" | "commit";
  text: string;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Whether `quote`, with whitespace collapsed, lies inside the pinned text of that source. */
export function quoteInPinned(quote: string, source: PinnedText["source"], pinned: readonly PinnedText[]): boolean {
  const q = collapse(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return pinned.some((p) => p.source === source && collapse(p.text).includes(q));
}

export interface PurposeRecord {
  item: string;
  status: "stated" | "asked";
  quote?: string;
  source?: PinnedText["source"];
}

export interface RequiredQuestion {
  key: string;
  type: QuestionType;
  item: string;
  /** The symbol's id, when the question is about one. */
  symbol?: string;
  /** A measured function with no symbol of its own (a closure), by qualified name, and the file it is measured in. */
  fn?: string;
  fnPath?: string;
  text: string;
}

export interface Question {
  id: string;
  type: QuestionType;
  item: string;
  symbol?: string;
  fn?: string;
  fnPath?: string;
  text: string;
  /** `required` when plugin rules demand it, `added` when the questioner raised it. */
  origin: "required" | "added";
  key: string;
}

export interface QuestionInputs {
  view: ReportView;
  groundwork: Groundwork;
  /** Large mode (design §7.6): a high-level review. Per high-level change (`W1`…), a purpose question, the existence/reuse/common-logic question and a missing-test question; nothing per symbol or per function. */
  large?: boolean;
}

const short = (s: string, n = 90): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The report item whose citation covers the symbol: by lines first, then by file; preferring a change item. */
export function itemOfSymbol(sym: Pick<SymbolDef, "path" | "startLine" | "endLine">, items: readonly ViewItem[]): string | undefined {
  const citing = items.filter((i) => i.cites.some((c) => c.path === sym.path));
  const overlap = (i: ViewItem): boolean => i.cites.some((c) => c.path === sym.path && c.side === "head" && c.start > 0 && c.start <= sym.endLine && c.end >= sym.startLine);
  const change = (i: ViewItem): boolean => !["other", "claims", "measurements"].includes(i.section);
  return (citing.find((i) => overlap(i) && change(i)) ?? citing.find(overlap) ?? citing.find(change) ?? citing[0])?.id;
}

/**
 * The symbol a measurement record is about: the same qualified name in the same file, or the same lines. A closure
 * measured inside an extracted function is not that function and keeps its own identity.
 */
export function symbolOfRecord(r: Pick<MetricsRecord, "path" | "function" | "startLine" | "endLine">, symbols: readonly SymbolDef[]): SymbolDef | undefined {
  const same = symbols.filter((s) => s.path === r.path);
  return same.find((s) => s.qualified === r.function) ?? same.find((s) => s.startLine === r.startLine && s.endLine === r.endLine);
}

/** The first mutant a record's mutation result says survived, as `path:line from → to`, when a mutation result exists (it arrives with a later version). */
export function survivors(r: MetricsRecord): Array<{ line: number; from: string; to: string }> {
  const m = r.mutation as { survivors?: unknown } | undefined;
  if (m === undefined || m === null || typeof m !== "object" || !Array.isArray(m.survivors)) return [];
  return m.survivors.flatMap((s) => {
    const o = s as { line?: unknown; from?: unknown; to?: unknown };
    return typeof o.line === "number" && typeof o.from === "string" && typeof o.to === "string" ? [{ line: o.line, from: o.from, to: o.to }] : [];
  });
}

/** The most symbols a change-level question names; the rest are counted. */
const MAX_NAMED = 40;

/** The files a high-level change cites, in order. */
const citedPaths = (change: ViewItem): Set<string> => new Set(change.cites.map((c) => c.path));

/** What names a high-level change in a question: its id, its text and the places its bullet cites. */
function describeChange(change: ViewItem): string {
  const where = change.cites.slice(0, 4).map((c) => (c.start > 0 ? `${c.path}:${c.start}${c.end > c.start ? `-${c.end}` : ""}` : c.path)).join(", ");
  return `${change.id} "${short(change.text, 140)}" (${where})`;
}

/**
 * The questions large mode asks per high-level change (design §7.6), where a change is one capability of the briefing:
 * the existence, reuse and common-logic question (asked for every change, about what the change adds), and the
 * missing-test question, which lists the new or modified functions in the cited files that no test in the pull request
 * covers. The answerer works out which code belongs to the change from its cites and the areas.
 */
function changeQuestions(changes: readonly ViewItem[], groundwork: Groundwork): RequiredQuestion[] {
  const out: RequiredQuestion[] = [];
  const named = (syms: readonly SymbolDef[]): string => `${syms.slice(0, MAX_NAMED).map((s) => `${s.qualified} (${s.path}:${s.startLine})`).join(", ")}${syms.length > MAX_NAMED ? `, and ${syms.length - MAX_NAMED} more` : ""}`;
  for (const change of changes) {
    const what = describeChange(change);
    const paths = citedPaths(change);
    out.push({
      key: `${REUSE_TYPE}:item:${change.id}`,
      type: REUSE_TYPE,
      item: change.id,
      text: `For the new functions and features of this change, ${what}: does the codebase already have the same or an equivalent of what it adds, could an existing internal package or an already-declared third-party library do it, and does it duplicate common logic elsewhere, in the base or in the pull request, that could become shared code? Answer all three in one statement.`,
    });
    const uncovered = groundwork.symbols.filter((s) => paths.has(s.path) && (groundwork.testMap.get(s.id) ?? []).length === 0 && s.kind !== "type" && s.kind !== "interface");
    out.push({ key: `missing-test:item:${change.id}`, type: "missing-test", item: change.id, text: `Which tests cover this change, ${what}?${uncovered.length > 0 ? ` The test map found none in the pull request for: ${named(uncovered)}.` : ""}` });
  }
  return out;
}

/** The required questions (design §7.1), in the order the Q&A shows them: by report item, then symbol, then type. */
export function requiredQuestions(inp: QuestionInputs, stated: ReadonlyMap<string, PurposeRecord>): RequiredQuestion[] {
  const { view, groundwork } = inp;
  const out: RequiredQuestion[] = [];
  const items = view.items;
  for (const item of changeItems(view, inp.large === true)) {
    if (stated.get(item.id)?.status === "stated") continue;
    out.push({ key: `purpose:${item.id}`, type: "purpose", item: item.id, text: `What is the purpose of this change (${short(item.text)})? Nothing in the pull request's text, commit messages or linked issue states it.` });
  }
  const large = inp.large === true;
  for (const sym of groundwork.symbols) {
    const item = itemOfSymbol(sym, items);
    if (item === undefined) continue;
    const q = `${sym.qualified} (${sym.path}:${sym.startLine})`;
    // In large mode nothing is asked per symbol: the high-level change's questions cover its code.
    if (sym.change === "new" && !large) {
      out.push({ key: `${REUSE_TYPE}:${sym.id}`, type: REUSE_TYPE, item, symbol: sym.id, text: `Does the codebase already have the same or an equivalent of ${q}, could an existing internal package or an already-declared third-party library do what it does, and does it duplicate logic elsewhere, in the base or in the pull request, that could become shared code? Answer all three in one statement.` });
    }
    if (!large && (groundwork.testMap.get(sym.id) ?? []).length === 0 && sym.kind !== "type" && sym.kind !== "interface") {
      out.push({ key: `missing-test:${sym.id}`, type: "missing-test", item, symbol: sym.id, text: `Which test covers ${q}? The test map found none in the pull request.` });
    }
  }
  if (large) out.push(...changeQuestions(view.changes ?? [], groundwork));
  // Large mode is a high-level review (design §7.6): the measurements still show every function, but no per-function question is asked.
  for (const r of large ? [] : view.records) {
    if (r.test) continue;
    const sym = symbolOfRecord(r, groundwork.symbols);
    const item = (sym !== undefined ? itemOfSymbol(sym, items) : itemOfSymbol({ path: r.path, startLine: r.startLine, endLine: r.endLine }, items));
    if (item === undefined) continue;
    const ref = sym !== undefined ? { symbol: sym.id } : { fn: r.function, fnPath: r.path };
    const keyOf = (type: string): string => `${type}:${sym?.id ?? `fn:${r.path}:${r.function}`}`;
    const th = checkThresholds(r);
    const where = `${r.function} (${r.path}:${r.startLine})`;
    if (th.complexity.exceeded || th.nesting.exceeded) {
      // Whether the excess is inherited from the base or introduced by the pull request (design §6.8).
      const origins = (["complexity", "nesting"] as Metric[]).filter((m) => exceeds(m, r[m])).map((m) => `${m}: ${originText(r, m)}`);
      out.push({ key: keyOf("split-function"), type: "split-function", item, ...ref, text: `${where} has complexity ${r.complexity} (limit < ${LIMITS.complexity}) and nesting ${r.nesting} (limit ≤ ${LIMITS.nesting}); ${origins.join("; ")}. Could it be split into smaller functions with one intent each?` });
    }
    if (th.crap.triggers) {
      const coverage = r.coverage?.source === "measured" ? `measured coverage ${r.coverage.covered}/${r.coverage.total}` : "unknown coverage";
      const base = r.change === "modified" && r.base !== undefined && !("unavailable" in r.base) ? ` (${r.base.complexity} at the base: ${originText(r, "complexity")})` : "";
      out.push({ key: keyOf("complexity-coverage"), type: "complexity-coverage", item, ...ref, text: `Which tests cover the branches of ${where}? Complexity ${r.complexity}${base}, ${coverage}, CRAP ${th.crap.value}${th.crap.upperBound ? " (upper bound)" : ""}.` });
    }
    for (const s of survivors(r)) {
      out.push({ key: keyOf(`weak-test:${s.line}`), type: "weak-test", item, ...ref, text: `Which assertion would fail when \`${s.from}\` at ${r.path}:${s.line} becomes \`${s.to}\`?` });
    }
  }
  const itemOrder = new Map(items.map((i, n) => [i.id, n] as const));
  const symbolOrder = new Map(groundwork.symbols.map((s, n) => [s.id, n] as const));
  const typeOrder = new Map(QUESTION_TYPES.map((t, n) => [t, n] as const));
  return out
    .map((q, n) => ({ q, n }))
    .sort((a, b) => (itemOrder.get(a.q.item) ?? 0) - (itemOrder.get(b.q.item) ?? 0) || (symbolOrder.get(a.q.symbol ?? "") ?? -1) - (symbolOrder.get(b.q.symbol ?? "") ?? -1) || (typeOrder.get(a.q.type) ?? 0) - (typeOrder.get(b.q.type) ?? 0) || a.n - b.n)
    .map(({ q }) => q);
}

/** The purposes the questioner recorded as stated, each kept only when its quote lies in the pinned text. */
export function statedPurposes(output: QuestionerOutput | undefined, view: ReportView, pinned: readonly PinnedText[], large = false): { stated: Map<string, PurposeRecord>; rejected: string[] } {
  const stated = new Map<string, PurposeRecord>();
  const rejected: string[] = [];
  const known = new Set(changeItems(view, large).map((i) => i.id));
  for (const p of output?.purposes ?? []) {
    if (!known.has(p.item)) {
      rejected.push(`${p.item} is not a change item`);
      continue;
    }
    if (!quoteInPinned(p.quote, p.source, pinned)) {
      rejected.push(`${p.item}: the quote is not in the pull request's ${p.source}`);
      continue;
    }
    if (!stated.has(p.item)) stated.set(p.item, { item: p.item, status: "stated", quote: collapse(p.quote), source: p.source });
  }
  return { stated, rejected };
}

/** Every deterministic problem with a questioner result; empty when it passes. */
export function questionerProblems(output: QuestionerOutput, view: ReportView, groundwork: Groundwork, required: readonly RequiredQuestion[]): string[] {
  const problems: string[] = [];
  const items = new Set(questionItems(view).map((i) => i.id));
  const symbols = new Set(groundwork.symbols.map((s) => s.id));
  const keys = new Set(required.map((r) => r.key));
  const seen = new Set<string>();
  let added = 0;
  output.questions.forEach((q, i) => {
    const at = `question ${i + 1}`;
    if (!items.has(q.item)) problems.push(`${at}: ${JSON.stringify(q.item)} is not a report item id`);
    if (q.symbol !== "" && !symbols.has(q.symbol)) problems.push(`${at}: ${JSON.stringify(q.symbol)} is not a symbol id`);
    if (q.text.trim() === "") problems.push(`${at}: the text is empty`);
    // A required question's own wording may be longer than a question the questioner adds (large mode names the symbols of an item), and its phrasing may be as long.
    const limit = Math.max(MAX_QUESTION_CHARS, q.key !== "" ? (required.find((r) => r.key === q.key)?.text.length ?? 0) : 0);
    if (q.text.length > limit) problems.push(`${at}: the text is ${q.text.length} characters, more than ${limit}`);
    if (q.key !== "") {
      if (!keys.has(q.key)) problems.push(`${at}: the key ${JSON.stringify(q.key)} names no required question (leave key empty for a question you add)`);
      else if (seen.has(q.key)) problems.push(`${at}: the required question ${q.key} appears twice`);
      seen.add(q.key);
    } else {
      added += 1;
      if (!ADDABLE.includes(q.type)) problems.push(`${at}: a question of type ${q.type} cannot be added`);
    }
  });
  if (added > MAX_ADDED_QUESTIONS) problems.push(`${added} questions added, more than ${MAX_ADDED_QUESTIONS}`);
  output.purposes.forEach((p, i) => {
    if (!questionItems(view).some((x) => x.id === p.item)) problems.push(`purpose ${i + 1}: ${JSON.stringify(p.item)} is not a report item id`);
  });
  return problems;
}

/** The questions the Q&A asks: the required ones, phrased by the questioner when it did, then the ones it added; each with its `Q<n>` id. */
export function finalQuestions(required: readonly RequiredQuestion[], output: QuestionerOutput | undefined, groundwork: Pick<Groundwork, "symbols">): Question[] {
  const byKey = new Map((output?.questions ?? []).filter((q) => q.key !== "").map((q) => [q.key, q] as const));
  const out: Omit<Question, "id">[] = required.map((r) => {
    const phrased = byKey.get(r.key)?.text.trim();
    return { type: r.type, item: r.item, ...(r.symbol !== undefined ? { symbol: r.symbol } : {}), ...(r.fn !== undefined ? { fn: r.fn } : {}), ...(r.fnPath !== undefined ? { fnPath: r.fnPath } : {}), text: phrased !== undefined && phrased !== "" ? phrased : r.text, origin: "required" as const, key: r.key };
  });
  const symbols = new Set(groundwork.symbols.map((s) => s.id));
  let n = 0;
  for (const q of output?.questions ?? []) {
    if (q.key !== "") continue;
    // An addition that repeats a required question's type, item and symbol is that question's phrasing, not another.
    if (required.some((r) => r.type === q.type && r.item === q.item && (r.symbol ?? "") === q.symbol)) continue;
    n += 1;
    out.push({ type: q.type, item: q.item, ...(q.symbol !== "" && symbols.has(q.symbol) ? { symbol: q.symbol } : {}), text: q.text.trim(), origin: "added", key: `added:${n}` });
  }
  return out.map((q, i) => ({ id: `Q${i + 1}`, ...q }));
}

/** The pinned text a stated purpose may quote: the title, the body and each commit message. */
export function pinnedTexts(pull: { title: string; body: string }, commits: ReadonlyArray<{ message: string }>): PinnedText[] {
  return [{ source: "title", text: pull.title }, { source: "body", text: pull.body }, ...commits.map((c): PinnedText => ({ source: "commit", text: c.message }))];
}

export type QuestionsFlow =
  | { state: "questioner"; kind: "first" | "correction"; feedback: string[] }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; output: QuestionerOutput; refs: string[] };

const asOutput = (run: AgentRun): { output: QuestionerOutput } | { problems: string[] } | undefined => {
  if (run.status !== "completed") return undefined;
  if (run.contract?.status === "invalid") return { problems: run.contract.problems.slice(0, 20) };
  const shape = validateResultShape(run.output, QUESTIONS_SCHEMA as unknown as Record<string, unknown>);
  return shape.length > 0 ? { problems: shape.slice(0, 20) } : { output: run.output as QuestionerOutput };
};

/** Where the questions stand: the questioner asks, deterministic checks correct (at most MAX_QUESTION_CORRECTIONS times, then the supervisor). */
export function questionsFlow(evidence: readonly EvidenceRecord[], check: (output: QuestionerOutput) => string[]): QuestionsFlow {
  let output: QuestionerOutput | undefined;
  let pending: string[] | undefined;
  let failures = 0;
  const refs: string[] = [];
  for (const run of agentRuns(evidence, QUESTIONS_SCHEMA_NAME)) {
    refs.push(run.record.ref);
    const result = asOutput(run);
    if (result === undefined) continue;
    const problems = "problems" in result ? result.problems : check(result.output);
    if (problems.length > 0) {
      failures += 1;
      pending = problems;
      output = undefined;
      continue;
    }
    output = (result as { output: QuestionerOutput }).output;
    pending = undefined;
  }
  if (output !== undefined) return { state: "done", output, refs: refs.slice(-10) };
  if (pending !== undefined) {
    if (failures > MAX_QUESTION_CORRECTIONS) return { state: "supervise", reason: `the questioner's result still fails deterministic validation after ${MAX_QUESTION_CORRECTIONS} corrections: ${pending.slice(0, 3).join("; ")}`, refs: refs.slice(-10) };
    return { state: "questioner", kind: "correction", feedback: pending };
  }
  return { state: "questioner", kind: "first", feedback: [] };
}
