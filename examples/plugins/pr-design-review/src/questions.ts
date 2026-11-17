// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The questions of the design review (design-pr-review-split §3.2, §3.3): one table for both modes. N1 comes first; then, for
 * every high-level change (a capability of the briefing's `whatsNew`, or, when the claim check kept none, one of the report's
 * coarsest change items standing in for it), `purpose` when the pull request's text does not state it and `existing-feature`
 * always; then at most five design-level `other` questions the questioner adds. Nothing is asked per symbol, per function or
 * from a measurement or a test map: those detail questions are `pr-review`'s leads now. The questioner phrases the required
 * questions and cannot drop one: a required question it left out is added with the plugin's own wording. A purpose the pull
 * request's text states is recorded with the quote that shows it instead of asked, and the quote must match the pinned text.
 * Questions carry no severity or verdict.
 */
import { validateResultShape } from "@graphloom/sdk";
import type { EvidenceRecord } from "@graphloom/sdk";
import { agentRuns, type AgentRun } from "./kit/evidence.js";
import type { Groundwork } from "./kit/groundwork.js";
import { questionItems, type ReportView, type ViewItem } from "./kit/reportview.js";
import type { SymbolDef } from "./kit/symbols.js";
import { quoteInPinned, type PinnedText } from "./kit/pinned.js";

export { pinnedTexts, quoteInPinned, type PinnedText } from "./kit/pinned.js";

export const QUESTIONS_SCHEMA_NAME = "questions-v1";
export const MAX_QUESTION_CHARS = 500;
/** The most design-level `other` questions the questioner adds (design-pr-review-split §3.3). */
export const MAX_ADDED_QUESTIONS = 5;
export const MAX_QUESTION_CORRECTIONS = 2;

export const QUESTION_TYPES = ["necessity", "purpose", "existing-feature", "other"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
/**
 * The feature-level question every high-level change is asked (design-pr-review-split §3.2): does the codebase already have this
 * feature or mechanism, or does a declared library do it? One question, one answer; it never asks per symbol, and it no longer
 * asks whether there is common logic to share.
 */
export const FEATURE_TYPE = "existing-feature";

/** The only type the questioner may add (design-pr-review-split §3.3). */
export const ADDED_TYPE = "other";

/** The report sections whose change items an added `other` question may be about, beside a high-level change (§3.3). */
export const DESIGN_SECTIONS: readonly string[] = ["schema", "interfaces", "config", "external", "removed"];

/** The id fields of the questioner's contract: each is constrained, per job, to the ids a question may name. */
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

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

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
  /** Never set by the design review's rules; kept so the Q&A records keep their shape. */
  symbol?: string;
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
  /** The stable key the ledger keeps (design §9.4): the question's type and subject, set once the run's questions are known. */
  stable?: string;
  /** Set when a later head carried the earlier answer instead of asking it again: only N1 is ever carried (design-pr-review-split §3.5). */
  carried?: string;
}

export interface QuestionInputs {
  view: ReportView;
  groundwork: Groundwork;
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
 * The high-level changes of a report (design-pr-review-split §3.2), the unit every question but N1 is about, in both modes: the
 * capabilities of the briefing's `whatsNew` (`W1`…`W5`), or, when the claim check kept none, the report's coarsest change items
 * standing in for them (`reportView` computes both).
 */
export const highLevelChanges = (view: ReportView): ViewItem[] => view.changes ?? [];

/** What names a high-level change in a question: its id, its text and the places its bullet cites. */
function describeChange(change: ViewItem): string {
  const where = change.cites.slice(0, 4).map((c) => (c.start > 0 ? `${c.path}:${c.start}${c.end > c.start ? `-${c.end}` : ""}` : c.path)).join(", ");
  return `${change.id} "${short(change.text, 140)}" (${where})`;
}

/** The required questions (design-pr-review-split §3.2), in the order the Q&A shows them: by high-level change, then type. */
export function requiredQuestions(inp: QuestionInputs, stated: ReadonlyMap<string, PurposeRecord>): RequiredQuestion[] {
  const out: RequiredQuestion[] = [];
  for (const change of highLevelChanges(inp.view)) {
    const what = describeChange(change);
    if (stated.get(change.id)?.status !== "stated") {
      out.push({ key: `purpose:${change.id}`, type: "purpose", item: change.id, text: `What is the purpose of this change, ${what}? Nothing in the pull request's text, commit messages or linked issue states it.` });
    }
    out.push({
      key: `${FEATURE_TYPE}:${change.id}`,
      type: FEATURE_TYPE,
      item: change.id,
      text: `Does the codebase already have the feature or mechanism this change adds, ${what}, or does an already-declared third-party library do it? Answer in one statement.`,
    });
  }
  return out;
}

/** The purposes the questioner recorded as stated, each kept only when its quote lies in the pinned text. */
export function statedPurposes(output: QuestionerOutput | undefined, view: ReportView, pinned: readonly PinnedText[]): { stated: Map<string, PurposeRecord>; rejected: string[] } {
  const stated = new Map<string, PurposeRecord>();
  const rejected: string[] = [];
  const known = new Set(highLevelChanges(view).map((i) => i.id));
  for (const p of output?.purposes ?? []) {
    if (!known.has(p.item)) {
      rejected.push(`${p.item} is not a high-level change`);
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

/** The ids an added `other` question may be about (§3.3): a high-level change, or a change item of a design-level section. */
export function otherItems(view: ReportView): ViewItem[] {
  return [...highLevelChanges(view), ...view.items.filter((i) => DESIGN_SECTIONS.includes(i.section))];
}

/**
 * Every deterministic problem with a questioner result; empty when it passes. An added question (empty key) is checked by the
 * rules of design-pr-review-split §3.3: its type is `other`, its symbol is empty, its item is a high-level change or a change
 * item of the schema, interfaces, config, external or removed sections, and at most five are added. No word list is applied.
 */
export function questionerProblems(output: QuestionerOutput, view: ReportView, required: readonly RequiredQuestion[]): string[] {
  const problems: string[] = [];
  const items = new Set(questionItems(view).map((i) => i.id));
  const others = new Set(otherItems(view).map((i) => i.id));
  const keys = new Set(required.map((r) => r.key));
  const seen = new Set<string>();
  let added = 0;
  output.questions.forEach((q, i) => {
    const at = `question ${i + 1}`;
    if (q.text.trim() === "") problems.push(`${at}: the text is empty`);
    const limit = Math.max(MAX_QUESTION_CHARS, q.key !== "" ? (required.find((r) => r.key === q.key)?.text.length ?? 0) : 0);
    if (q.text.length > limit) problems.push(`${at}: the text is ${q.text.length} characters, more than ${limit}`);
    if (q.key !== "") {
      if (!items.has(q.item)) problems.push(`${at}: ${JSON.stringify(q.item)} is not a report item id`);
      if (!keys.has(q.key)) problems.push(`${at}: the key ${JSON.stringify(q.key)} names no required question (leave key empty for a question you add)`);
      else if (seen.has(q.key)) problems.push(`${at}: the required question ${q.key} appears twice`);
      seen.add(q.key);
      return;
    }
    added += 1;
    if (q.type !== ADDED_TYPE) problems.push(`${at}: an added question is of type ${ADDED_TYPE} (a design-level question); ${q.type} questions are the plugin's own, phrased with their key`);
    if (q.symbol !== "") problems.push(`${at}: an added question names no symbol (symbol ""): it is about the design, not about one function or type`);
    if (!others.has(q.item)) problems.push(`${at}: ${JSON.stringify(q.item)} is not a high-level change (W<n>) or a change item of the ${DESIGN_SECTIONS.join(", ")} sections, which an added question is about`);
  });
  if (added > MAX_ADDED_QUESTIONS) problems.push(`${added} questions added, more than ${MAX_ADDED_QUESTIONS}`);
  const changes = new Set(highLevelChanges(view).map((i) => i.id));
  output.purposes.forEach((p, i) => {
    if (!changes.has(p.item)) problems.push(`purpose ${i + 1}: ${JSON.stringify(p.item)} is not a high-level change id`);
  });
  return problems;
}

/** The questions the Q&A asks: the required ones, phrased by the questioner when it did, then the ones it added; each with its `Q<n>` id. */
export function finalQuestions(required: readonly RequiredQuestion[], output: QuestionerOutput | undefined): Question[] {
  const byKey = new Map((output?.questions ?? []).filter((q) => q.key !== "").map((q) => [q.key, q] as const));
  const out: Omit<Question, "id">[] = required.map((r) => {
    const phrased = byKey.get(r.key)?.text.trim();
    return { type: r.type, item: r.item, text: phrased !== undefined && phrased !== "" ? phrased : r.text, origin: "required" as const, key: r.key };
  });
  let n = 0;
  for (const q of output?.questions ?? []) {
    if (q.key !== "" || n >= MAX_ADDED_QUESTIONS) continue;
    // An addition that repeats a required question's type, item and empty symbol is that question's phrasing, not another (§3.3).
    if (required.some((r) => r.type === q.type && r.item === q.item && q.symbol === "")) continue;
    n += 1;
    out.push({ type: q.type, item: q.item, text: q.text.trim(), origin: "added", key: `added:${n}` });
  }
  return out.map((q, i) => ({ id: `Q${i + 1}`, ...q }));
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
