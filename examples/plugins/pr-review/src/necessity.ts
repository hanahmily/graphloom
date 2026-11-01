// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The necessity question N1 (design §7.5). It is the first question of every
 * run, asked before every other: did the pull request fix a real thing? Its
 * answer has three parts, each with evidence: the problem it claims is real on
 * the base (a trace through the base code), the change fits the system's design
 * (a cited design statement and the changed lines), and no simpler or existing
 * way does it. It concludes (`necessary`, `questionable`, `unnecessary` or
 * `needs author`) in one line, which is the one answer allowed to conclude.
 * The checker verifies every cited statement, trace step and the conclusion,
 * and an `unnecessary` conclusion that the checker supports ends the questions.
 * When the profile names a design principles file, part 2 also gives one verdict per applicable
 * principle, and a break the checker supports makes `necessary` `questionable` (design §7.5.1).
 *
 * The result contract is its own (`necessity-v1`); plugin code turns it into
 * an ordinary `Answer` so the citations are verified, the checker judges it and
 * the Q&A holds it like every other answer.
 */
import type { Answer, Citation, FinalAnswer, Search } from "./answers.js";
import type { PinnedText, Question } from "./questions.js";
import { quoteInPinned } from "./questions.js";
import type { PrinciplesRecord } from "./principles.js";
import { SEARCH_SCHEMA } from "./searches.js";

export const NECESSITY_SCHEMA_NAME = "necessity-v1";
/** The same shape, asked again after the answer check found part of it unsupported. */
export const NECESSITY_REVISION_SCHEMA_NAME = "necessity-revision-v1";
export const NECESSITY_ID = "N1";
export const NECESSITY_KEY = "necessity";
export const NECESSITY_TEXT =
  "Is this change necessary? Does the problem it claims to fix exist on the base, does the fix fit the system's design, and is there a simpler or existing way?";
/** What review.md says in place of the questions a confirmed `unnecessary` conclusion skipped. */
export const SKIPPED_NOTE = "Remaining questions skipped: the change was judged unnecessary (see N1).";
export const NECESSITY_JSON_SCHEMA = "pr-necessity-v1";
/** The contract's reference path of the principle ids. */
export const NECESSITY_REFERENCES = ["principles[].id"];

export const CONCLUSIONS = ["necessary", "questionable", "unnecessary", "needs author"] as const;
export type Conclusion = (typeof CONCLUSIONS)[number];
export const CAN_HAPPEN = ["yes", "no", "unclear"] as const;
export const DESIGN_EFFECTS = ["preserves", "breaks", "unrelated", "not stated"] as const;
/** The verdict on one of the project's design principles (design §7.5.1). */
export const PRINCIPLE_VERDICTS = ["preserves", "breaks", "not-applicable"] as const;

const MAX_RATIONALE = 300;
const MAX_TEXT = 800;
const MAX_STEPS = 8;
const MAX_CITES = 6;
const MAX_SEARCHES = 12;
const MAX_PATH_CHARS = 500;

const CITATION = {
  type: "object",
  additionalProperties: false,
  required: ["path", "tree", "start", "end", "quote"],
  properties: { path: { type: "string" }, tree: { type: "string", enum: ["base", "head"] }, start: { type: "integer" }, end: { type: "integer" }, quote: { type: "string" } },
} as const;

export const NECESSITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["conclusion", "rationale", "problem", "reproduction", "design", "principles", "alternatives", "searches"],
  properties: {
    conclusion: { type: "string", enum: CONCLUSIONS },
    rationale: { type: "string" },
    problem: {
      type: "object",
      additionalProperties: false,
      required: ["claim", "quotes", "trace", "canHappen", "explanation"],
      properties: {
        claim: { type: "string" },
        quotes: { type: "array", items: { type: "object", additionalProperties: false, required: ["source", "quote"], properties: { source: { type: "string", enum: ["title", "body", "commit"] }, quote: { type: "string" } } } },
        trace: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["step", "path", "tree", "start", "end", "quote"],
            properties: { step: { type: "string" }, path: { type: "string" }, tree: { type: "string", enum: ["base", "head"] }, start: { type: "integer" }, end: { type: "integer" }, quote: { type: "string" } },
          },
        },
        canHappen: { type: "string", enum: CAN_HAPPEN },
        explanation: { type: "string" },
      },
    },
    reproduction: { type: "string" },
    design: {
      type: "object",
      additionalProperties: false,
      required: ["statements", "changed", "effect", "explanation", "searches"],
      properties: {
        statements: { type: "array", items: CITATION },
        changed: { type: "array", items: CITATION },
        effect: { type: "string", enum: DESIGN_EFFECTS },
        explanation: { type: "string" },
        searches: { type: "array", items: SEARCH_SCHEMA },
      },
    },
    // One entry per principle that applies to the change; the job constrains `id` to those ids (references "principles[].id").
    principles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "explanation", "citations"],
        properties: { id: { type: "string" }, verdict: { type: "string", enum: PRINCIPLE_VERDICTS }, explanation: { type: "string" }, citations: { type: "array", items: CITATION } },
      },
    },
    alternatives: {
      type: "object",
      additionalProperties: false,
      required: ["exists", "explanation", "citations"],
      properties: { exists: { type: "boolean" }, explanation: { type: "string" }, citations: { type: "array", items: CITATION } },
    },
    searches: { type: "array", items: SEARCH_SCHEMA },
  },
} as const;

type Cite = { path: string; tree: "base" | "head"; start: number; end: number; quote: string };

export interface PrincipleVerdict {
  id: string;
  verdict: (typeof PRINCIPLE_VERDICTS)[number];
  explanation: string;
  citations: Cite[];
}

/** The checker's judgment of one principle verdict: `supported` holds it, anything else does not. */
export interface PrincipleCheck {
  id: string;
  verdict: "supported" | "partial" | "unsupported";
  note: string;
}

/** The answerer's necessity result (`necessity-v1`). */
export interface Necessity {
  conclusion: Conclusion;
  rationale: string;
  problem: {
    claim: string;
    quotes: Array<{ source: PinnedText["source"]; quote: string }>;
    trace: Array<Cite & { step: string }>;
    canHappen: (typeof CAN_HAPPEN)[number];
    explanation: string;
  };
  /** What was run to reproduce the claim on the base, or why nothing was. */
  reproduction: string;
  design: { statements: Cite[]; changed: Cite[]; effect: (typeof DESIGN_EFFECTS)[number]; explanation: string; searches: Search[] };
  /** One verdict per design principle that applies to the change (empty when the project names none, or none applies). */
  principles: PrincipleVerdict[];
  alternatives: { exists: boolean; explanation: string; citations: Cite[] };
  searches: Search[];
}

const isRelative = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "") && !/[\n\u0000|]/.test(p);

/** The status the necessity answer carries in the Q&A: the conclusion settles, doubts it, or asks the author. */
export function statusOf(conclusion: Conclusion): Answer["status"] {
  return conclusion === "needs author" ? "needs author" : conclusion === "questionable" ? "partially answered" : "answered";
}

/** Every citation of the necessity answer, in the order the Q&A shows them: the trace, the design statements, the changed lines, the principles', the alternatives. */
export function necessityCitations(n: Necessity): Citation[] {
  const cite = (c: Cite): Citation => ({ path: c.path, tree: c.tree, start: c.start, end: c.end, quote: c.quote });
  return [...n.problem.trace.map(cite), ...n.design.statements.map(cite), ...n.design.changed.map(cite), ...n.principles.flatMap((p) => p.citations.map(cite)), ...n.alternatives.citations.map(cite)];
}

/** The necessity result as an ordinary answer: the verifier, the checker and the Q&A treat N1 like any other. */
export function necessityAnswer(n: Necessity, question = NECESSITY_ID): Answer {
  return {
    question,
    answer: `${n.conclusion}: ${n.rationale.trim()}`,
    status: statusOf(n.conclusion),
    none_found: false,
    citations: necessityCitations(n),
    searches: [...n.design.searches, ...n.searches],
    inventory: [],
    metrics: [],
    proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" },
    necessity: n,
  };
}

/** Why an `unnecessary` conclusion stands: the grounds the answer cites. Empty when it has none. */
export function unnecessaryGrounds(n: Necessity): string[] {
  const grounds: string[] = [];
  if (n.problem.canHappen === "no" && n.problem.trace.length > 0) grounds.push("the claimed failure cannot happen on the base (traced)");
  if (n.design.effect === "breaks" && n.design.statements.length > 0 && n.design.changed.length > 0) grounds.push("the change breaks a cited design statement");
  if (n.alternatives.exists && n.alternatives.citations.length > 0) grounds.push("an existing way already does it (cited)");
  return grounds;
}

function citeProblems(list: readonly Cite[], at: string, trees: readonly string[], max: number): string[] {
  const out: string[] = [];
  if (list.length > max) out.push(`${at}: more than ${max} citations (cite the ones that settle it)`);
  list.forEach((c, i) => {
    const where = `${at} ${i + 1} (${c.path})`;
    if (c.start < 1 || c.end < c.start) out.push(`${where}: the lines ${c.start}-${c.end} are not a range`);
    if (!isRelative(c.path)) out.push(`${where}: a repository-relative path`);
    if (c.path.length > MAX_PATH_CHARS) out.push(`${where}: the path is longer than ${MAX_PATH_CHARS} characters`);
    if (!trees.includes(c.tree)) out.push(`${where}: the tree is ${c.tree}; it must be ${trees.join(" or ")}`);
    if (c.quote.trim() === "") out.push(`${where}: no quote`);
    if (c.quote.length > 400) out.push(`${where}: the quote is longer than 400 characters`);
  });
  return out;
}

/** The deterministic rules of the principle verdicts: each applicable id answered exactly once, none other, a citation behind every preserves or breaks. */
function principleProblems(list: readonly PrincipleVerdict[], applicable: readonly { id: string }[]): string[] {
  const out: string[] = [];
  const at = `${NECESSITY_ID} principle`;
  const ids = new Set(applicable.map((p) => p.id));
  const counts = new Map<string, number>();
  for (const p of list) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (!ids.has(id)) out.push(`${at} ${JSON.stringify(id)}: not a principle that applies to this change${ids.size > 0 ? ` (answer exactly: ${[...ids].join(", ")})` : " (none applies: leave principles empty)"}`);
    else if (n > 1) out.push(`${at} ${id}: answered ${n} times; answer each applicable principle exactly once`);
  }
  for (const id of ids) if (!counts.has(id)) out.push(`${at} ${id}: no verdict; answer each applicable principle (preserves, breaks or not-applicable)`);
  for (const p of list) {
    if (p.explanation.trim() === "") out.push(`${at} ${p.id}: the explanation is empty`);
    if (p.explanation.length > MAX_TEXT) out.push(`${at} ${p.id}: the explanation is ${p.explanation.length} characters, more than ${MAX_TEXT}`);
    out.push(...citeProblems(p.citations, `${at} ${p.id} citation`, ["base", "head"], MAX_CITES));
    if ((p.verdict === "preserves" || p.verdict === "breaks") && p.citations.length === 0) out.push(`${at} ${p.id}: "${p.verdict}" cites the code it is about (path:line with a quote, in the base or the head)`);
  }
  return out;
}

/** Every deterministic problem with a necessity result (design §7.5); empty when it passes. */
export function necessityProblems(n: Necessity, pinned: readonly PinnedText[], applicable: readonly { id: string }[] = []): string[] {
  const out: string[] = [];
  const at = NECESSITY_ID;
  if (n.rationale.trim() === "" || /\n/.test(n.rationale.trim())) out.push(`${at}: the rationale is one line`);
  if (n.rationale.length > MAX_RATIONALE) out.push(`${at}: the rationale is ${n.rationale.length} characters, more than ${MAX_RATIONALE}`);
  const p = n.problem;
  if (p.claim.trim() === "") out.push(`${at} problem: quote or state the claimed problem`);
  for (const [i, q] of p.quotes.entries()) {
    if (!quoteInPinned(q.quote, q.source, pinned)) out.push(`${at} problem quote ${i + 1}: the quote is not in the pull request's ${q.source} (copy it exactly; at least 12 characters)`);
  }
  if (p.quotes.length > MAX_CITES) out.push(`${at} problem: more than ${MAX_CITES} quotes`);
  out.push(...citeProblems(p.trace, `${at} trace step`, ["base"], MAX_STEPS));
  for (const [i, s] of p.trace.entries()) if (s.step.trim() === "") out.push(`${at} trace step ${i + 1}: say what the step shows`);
  if (p.canHappen !== "unclear" && p.trace.length === 0) out.push(`${at} problem: ${p.canHappen === "yes" ? "that the failure can happen" : "that it cannot"} needs a trace through the base code (steps with path:line citations in the base tree)`);
  for (const [name, text] of [["problem explanation", p.explanation], ["reproduction", n.reproduction], ["design explanation", n.design.explanation], ["alternatives explanation", n.alternatives.explanation]] as const) {
    if (text.trim() === "") out.push(`${at}: the ${name} is empty`);
    if (text.length > MAX_TEXT) out.push(`${at}: the ${name} is ${text.length} characters, more than ${MAX_TEXT}`);
  }
  const d = n.design;
  out.push(...citeProblems(d.statements, `${at} design statement`, ["base", "head"], MAX_CITES));
  out.push(...citeProblems(d.changed, `${at} changed lines`, ["head", "base"], MAX_CITES));
  if (d.searches.length === 0) out.push(`${at} design: list the searches of the design and architecture documents (and code comments) you ran, with their hit counts`);
  if (d.searches.length + n.searches.length > MAX_SEARCHES) out.push(`${at}: more than ${MAX_SEARCHES} searches`);
  if ((d.effect === "preserves" || d.effect === "breaks") && (d.statements.length === 0 || d.changed.length === 0)) out.push(`${at} design: "${d.effect}" cites the design statement and the changed lines it is about`);
  if (d.effect === "not stated" && d.statements.length > 0) out.push(`${at} design: the effect is "not stated" but design statements are cited`);
  out.push(...principleProblems(n.principles, applicable));
  out.push(...citeProblems(n.alternatives.citations, `${at} alternative`, ["base", "head"], MAX_CITES));
  if (n.alternatives.exists && n.alternatives.citations.length === 0) out.push(`${at}: an existing or simpler way is cited (path:line in the base)`);
  if (p.quotes.length === 0 && (n.conclusion === "necessary" || n.conclusion === "unnecessary")) {
    out.push(`${at}: the pull request's text states no problem to judge, so the conclusion is "questionable" or "needs author", not "${n.conclusion}"`);
  }
  if (n.conclusion === "unnecessary" && unnecessaryGrounds(n).length === 0) {
    out.push(`${at}: "unnecessary" rests on a ground with evidence: the claimed failure cannot happen (canHappen "no", traced), the change breaks a cited design statement (effect "breaks", with the statement and the changed lines), or an existing way is cited`);
  }
  if (n.conclusion === "necessary" && (p.canHappen !== "yes" || d.effect === "breaks" || n.alternatives.exists)) {
    out.push(`${at}: "necessary" needs the failure shown possible (canHappen "yes", traced), no design statement broken and no existing way`);
  }
  return out;
}

type Judged = { necessity?: Pick<Necessity, "conclusion"> & { principles?: readonly PrincipleVerdict[] }; check: { verdict: string; principles?: readonly PrincipleCheck[] } };

/** The principles the answerer says the change breaks and the checker supports (its verdict on that principle is `supported`). */
export function supportedBreaks(a: Judged): string[] {
  const checked = new Set((a.check.principles ?? []).filter((c) => c.verdict === "supported").map((c) => c.id));
  return (a.necessity?.principles ?? []).filter((p) => p.verdict === "breaks" && checked.has(p.id)).map((p) => p.id);
}

/**
 * The conclusion as the Q&A shows it: the answerer's, unless its answer stayed unsupported after the correction, which makes
 * it `questionable`; and a design principle the checker supports as broken makes `necessary` `questionable` (design §7.5.1).
 * `questionable`, `unnecessary` and `needs author` stay as they are.
 */
export function effectiveConclusion(a: Judged): Conclusion {
  const stated = a.necessity?.conclusion ?? "needs author";
  const settled = a.check.verdict === "downgraded" && stated !== "needs author" ? "questionable" : stated;
  return settled === "necessary" && supportedBreaks(a).length > 0 ? "questionable" : settled;
}

/** The sentence that names the principles a supported break rests on, or empty. */
export function brokenNote(a: Judged): string {
  const ids = supportedBreaks(a);
  return ids.length === 0 ? "" : `Design principle${ids.length > 1 ? "s" : ""} broken (the checker supports it): ${ids.join(", ")}.`;
}

export type NecessityDecision =
  | { action: "skip"; reason: string }
  | { action: "ask-all"; reason: string; override?: true };

/** What N1's checked answer decides: a confirmed `unnecessary` skips the other questions, unless the operator asked for every question. A principle break never skips. */
export function necessityDecision(a: Judged, askAll: boolean): NecessityDecision {
  const conclusion = effectiveConclusion(a);
  if (conclusion === "unnecessary" && a.check.verdict === "supported") {
    if (askAll) return { action: "ask-all", reason: "N1 concluded unnecessary and the checker supports it; the operator asked for every question anyway", override: true };
    return { action: "skip", reason: "N1 concluded unnecessary and the answer checker supports it" };
  }
  const broken = supportedBreaks(a);
  const why = a.check.verdict === "downgraded" ? "the evidence for N1 stayed unsupported after one correction, so its conclusion is questionable" : conclusion === "unnecessary" ? `the checker's verdict on N1 is ${a.check.verdict}, not supported` : `N1 concluded ${conclusion}${broken.length > 0 ? ` (design principle${broken.length > 1 ? "s" : ""} broken: ${broken.join(", ")})` : ""}`;
  return { action: "ask-all", reason: `${why}; every question is asked` };
}

/** N1 as a question: first of every run, the plugin's own wording, never the questioner's. */
export const necessityQuestion = (): Question => ({ id: NECESSITY_ID, type: "necessity", item: "", text: NECESSITY_TEXT, origin: "required", key: NECESSITY_KEY });

/** N1's checked answer and the decision it led to: what `necessity.json` records. */
export interface NecessityRecord {
  final: FinalAnswer;
  decision: NecessityDecision;
  /** The design principles file read for this run (design §7.5.1), when the profile names one. */
  principles?: PrinciplesRecord;
}

/** `necessity.json` (`pr-necessity-v1`). */
export function necessityJson(r: NecessityRecord): string {
  return JSON.stringify({ schema: NECESSITY_JSON_SCHEMA, question: { id: NECESSITY_ID, text: NECESSITY_TEXT }, conclusion: effectiveConclusion(r.final), ...(brokenNote(r.final) !== "" ? { conclusionNote: brokenNote(r.final) } : {}), decision: r.decision, ...(r.principles !== undefined ? { principles: { ...r.principles, verdicts: r.final.necessity?.principles ?? [], checks: r.final.check.principles ?? [], broken: supportedBreaks(r.final) } } : {}), answer: r.final });
}

/** The record a `necessity.json` text holds, or undefined when it is not one. */
export function parseNecessityRecord(json: string): NecessityRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const o = value as { schema?: unknown; decision?: { action?: unknown; reason?: unknown; override?: unknown }; principles?: Record<string, unknown>; answer?: Partial<FinalAnswer> } | null;
  if (o === null || typeof o !== "object" || o.schema !== NECESSITY_JSON_SCHEMA) return undefined;
  const a = o.answer;
  if (a === undefined || a === null || typeof a !== "object" || a.question !== NECESSITY_ID || typeof a.necessity !== "object" || a.necessity === null || typeof a.check !== "object" || a.check === null) return undefined;
  const d = o.decision;
  if (d === undefined || d === null || (d.action !== "skip" && d.action !== "ask-all") || typeof d.reason !== "string") return undefined;
  const { verdicts: _v, checks: _c, broken: _b, ...recorded } = o.principles ?? {};
  return { final: a as FinalAnswer, decision: d as NecessityDecision, ...(o.principles !== undefined ? { principles: recorded as unknown as PrinciplesRecord } : {}) };
}

/**
 * Whether a recorded decision is one N1's checked answer allows: the rule's own, or, where the rule skips, the
 * operator's override to ask every question anyway (more questions never weaken a requirement).
 */
export function admissibleDecision(final: FinalAnswer, decision: NecessityDecision): boolean {
  const same = (a: NecessityDecision, b: NecessityDecision): boolean => JSON.stringify(a) === JSON.stringify(b);
  const rule = necessityDecision(final, false);
  return same(decision, rule) || (rule.action === "skip" && same(decision, necessityDecision(final, true)));
}
