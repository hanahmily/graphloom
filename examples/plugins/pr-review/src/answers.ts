// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The answers (design §7.3): the answerer's result contract `answers-v1`,
 * the deterministic checks on it (every question answered with evidence and
 * a status; every citation resolves in the tree it names; every cited number
 * equals its measurement record; every proposal's lines lie inside its
 * function and its names are new to the package), the answer checker's
 * `answer-check-v1`, and the flow that corrects once and then downgrades
 * what is still unsupported to `needs author`, keeping both statements.
 */
import { validateResultShape } from "@graphloom/sdk";
import { createHash } from "node:crypto";
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { agentRuns, commandRuns, reportText, succeeded, type AgentRun } from "./evidence.js";
import type { Groundwork } from "./groundwork.js";
import { sourceDirs } from "./inventory.js";
import { resolveId } from "./ids.js";
import { matchesGeneratedGlob } from "./metrics/generated.js";
import type { FullPack } from "./packs.js";
import type { MetricsRecord } from "./metrics/record.js";
import { crapRounded } from "./metrics/crap.js";
import { NECESSITY_SCHEMA, NECESSITY_REVISION_SCHEMA_NAME, NECESSITY_SCHEMA_NAME, necessityAnswer, necessityProblems, type Necessity } from "./necessity.js";
import type { PinnedText, Question } from "./questions.js";
import type { ReportView } from "./reportview.js";
import { MAX_RERUN_SEARCHES, readSearchReport, searchCommand, searchKey, searchProblems, searchWhere, SEARCH_SCHEMA, type MeasuredSearch, type Search } from "./searches.js";
import { packOf, type SymbolDef } from "./symbols.js";

export type { MeasuredSearch, Search } from "./searches.js";

export const ANSWERS_SCHEMA_NAME = "answers-v1";
/** The same shape, asked again after the answer check, so the evidence itself says which result is the correction. */
export const ANSWERS_REVISION_SCHEMA_NAME = "answers-revision-v1";
export const ANSWER_CHECK_SCHEMA_NAME = "answer-check-v1";
export const MAX_ANSWER_CORRECTIONS = 2;
export const MAX_ANSWER_CHECK_RETRIES = 2;
export const MAX_ANSWER_CHARS = 2_000;
const MAX_LIST = 12;
/** Citations one verification command carries: four arguments each beside five fixed ones, within the executor's 64. */
const CITES_PER_COMMAND = 14;
const MAX_SPLITS = 8;
const MAX_PATH_CHARS = 500;

export const STATUSES = ["answered", "partially answered", "needs author"] as const;
export type AnswerStatus = (typeof STATUSES)[number];
export const VERDICTS = ["supported", "partial", "unsupported"] as const;
export type AnswerVerdict = (typeof VERDICTS)[number];

/** The id fields of the answerer's and the checker's contracts: each is constrained, per job, to the ids the assignment lists. */
export const ANSWERS_REFERENCES = ["answers[].question"];
export const ANSWER_CHECK_REFERENCES = ["verdicts[].question"];

export const ANSWERS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer", "status", "none_found", "citations", "searches", "inventory", "metrics", "proposal"],
        properties: {
          question: { type: "string" },
          answer: { type: "string" },
          status: { type: "string", enum: STATUSES },
          none_found: { type: "boolean" },
          citations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "tree", "start", "end", "quote"],
              properties: { path: { type: "string" }, tree: { type: "string", enum: ["base", "head", "dependency"] }, start: { type: "integer" }, end: { type: "integer" }, quote: { type: "string" } },
            },
          },
          searches: { type: "array", items: SEARCH_SCHEMA },
          inventory: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "version"], properties: { name: { type: "string" }, version: { type: "string" } } } },
          metrics: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["function", "path", "name", "value"], properties: { function: { type: "string" }, path: { type: "string" }, name: { type: "string", enum: ["complexity", "nesting", "crap"] }, value: { type: "number" } } },
          },
          proposal: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "splits", "testFile", "testName", "cases", "assertion"],
            properties: {
              kind: { type: "string", enum: ["none", "split", "test", "assertion"] },
              splits: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "startLine", "endLine", "responsibility"], properties: { name: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" }, responsibility: { type: "string" } } } },
              testFile: { type: "string" },
              testName: { type: "string" },
              cases: { type: "array", items: { type: "object", additionalProperties: false, required: ["input", "branches"], properties: { input: { type: "string" }, branches: { type: "string" } } } },
              assertion: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

export const ANSWER_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "verdict", "note", "searches"],
        properties: { question: { type: "string" }, verdict: { type: "string", enum: VERDICTS }, note: { type: "string" }, searches: { type: "array", items: SEARCH_SCHEMA } },
      },
    },
  },
} as const;

export interface Citation {
  path: string;
  tree: "base" | "head" | "dependency";
  start: number;
  end: number;
  quote: string;
}
export interface Proposal {
  kind: "none" | "split" | "test" | "assertion";
  splits: Array<{ name: string; startLine: number; endLine: number; responsibility: string }>;
  testFile: string;
  testName: string;
  cases: Array<{ input: string; branches: string }>;
  assertion: string;
}
export interface Answer {
  question: string;
  answer: string;
  status: AnswerStatus;
  none_found: boolean;
  citations: Citation[];
  searches: Search[];
  inventory: Array<{ name: string; version: string }>;
  metrics: Array<{ function: string; path: string; name: "complexity" | "nesting" | "crap"; value: number }>;
  proposal: Proposal;
  /** The structured necessity answer, on N1 alone (design §7.5). */
  necessity?: Necessity;
}
export interface AnswersOutput {
  answers: Answer[];
}
export interface CheckVerdict {
  question: string;
  verdict: AnswerVerdict;
  note: string;
  searches: Search[];
}

export interface AnswerContext {
  questions: readonly Question[];
  groundwork: Groundwork;
  view: ReportView;
  packs: readonly FullPack[];
  /** The pull request's own text, which a necessity answer's quotes must match. */
  pinned?: readonly PinnedText[];
}

const isRelative = (p: string): boolean => p !== "" && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "") && !/[\n\u0000|]/.test(p);

/** The function a question is about: its file, language, name, directory and lines. */
export function functionOf(q: Question, ctx: Pick<AnswerContext, "groundwork" | "view">): { path: string; language: string; dir: string; name: string; start: number; end: number; record?: MetricsRecord; symbol?: SymbolDef } | undefined {
  const sym = q.symbol !== undefined ? ctx.groundwork.symbols.find((s) => s.id === q.symbol) : undefined;
  // A symbol's own record: its qualified name, else its own lines (never a closure inside it).
  const record =
    sym !== undefined
      ? (ctx.view.records.find((r) => r.path === sym.path && r.function === sym.qualified) ?? ctx.view.records.find((r) => r.path === sym.path && r.startLine === sym.startLine && r.endLine === sym.endLine))
      : ctx.view.records.find((r) => q.fn !== undefined && r.function === q.fn && (q.fnPath === undefined || r.path === q.fnPath));
  if (sym !== undefined) return { path: sym.path, language: sym.language, dir: sym.dir, name: sym.name, start: sym.startLine, end: sym.endLine, ...(record !== undefined ? { record } : {}), symbol: sym };
  if (record !== undefined) {
    const dir = record.path.includes("/") ? record.path.slice(0, record.path.lastIndexOf("/")) : ".";
    return { path: record.path, language: record.path.endsWith(".go") ? "go" : "typescript", dir, name: record.function.split(".").at(-1) ?? record.function, start: record.startLine, end: record.endLine, record };
  }
  return undefined;
}

const NEEDS_OWN_SEARCH: ReadonlySet<string> = new Set(["missing-test", "complexity-coverage", "weak-test", "necessity"]);
/** Whether the checker must run searches of its own for this answer: every "none found", and every claim about a covering test. */
export const needsOwnSearch = (q: Question, a: Pick<Answer, "none_found">): boolean => a.none_found || NEEDS_OWN_SEARCH.has(q.type);

/** Every deterministic problem with `answers` for the `scope` questions (design §7.3, check 1). Empty when it passes. */
export function answerProblems(answers: readonly Answer[], ctx: AnswerContext, scope?: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const byId = new Map(ctx.questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const dirs = sourceDirs(ctx.groundwork.inventory);
  const declared = new Set(ctx.groundwork.inventory.dependencies.map((d) => `${d.name}@${d.version}`));
  for (const a of answers) {
    const q = byId.get(a.question);
    if (q === undefined) {
      problems.push(`${JSON.stringify(a.question)} is not a question id`);
      continue;
    }
    if (scope !== undefined && !scope.has(a.question)) problems.push(`${a.question} was not asked again; answer only ${[...scope].join(", ")}`);
    if (seen.has(a.question)) problems.push(`${a.question} is answered twice`);
    seen.add(a.question);
    problems.push(...answerProblemsOf(a, q, ctx, dirs, declared));
  }
  for (const q of ctx.questions) {
    if ((scope === undefined || scope.has(q.id)) && !seen.has(q.id)) problems.push(`${q.id} has no answer`);
  }
  return problems;
}

function answerProblemsOf(a: Answer, q: Question, ctx: AnswerContext, dirs: readonly string[], declared: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const at = a.question;
  if (a.answer.trim() === "") out.push(`${at}: the answer is empty`);
  if (a.answer.length > MAX_ANSWER_CHARS) out.push(`${at}: the answer is ${a.answer.length} characters, more than ${MAX_ANSWER_CHARS}`);
  // The necessity answer has its own bounds (necessityProblems): its trace, design statements and changed lines are citations too.
  if (q.type !== "necessity" && (a.citations.length > MAX_LIST || a.searches.length > MAX_LIST || a.inventory.length > MAX_LIST * 4 || a.metrics.length > MAX_LIST)) out.push(`${at}: more than ${MAX_LIST} citations, searches or metrics (cite the ones that settle it)`);
  if (a.citations.length + a.searches.length + a.inventory.length === 0) out.push(`${at}: it has no evidence: cite the code, list the searches run, or name the inventory entries read`);
  for (const s of a.searches) out.push(...searchProblems(s, at, dirs));
  a.citations.forEach((c, i) => {
    const where = `${at} citation ${i + 1} (${c.path})`;
    if (c.start < 1 || c.end < c.start) out.push(`${where}: the lines ${c.start}-${c.end} are not a range`);
    if (c.tree === "dependency") {
      if (!c.path.startsWith("/") || c.path.includes("..") || /[\n\u0000|]/.test(c.path) || !dirs.some((d) => c.path.startsWith(`${d}/`))) out.push(`${where}: a dependency citation must be an absolute path inside one of the inventory's source directories${dirs.length === 0 ? " (none is available here)" : ""}`);
    } else if (!isRelative(c.path)) out.push(`${where}: a ${c.tree} citation is a repository-relative path`);
    if (c.quote.length > 400) out.push(`${where}: the quote is longer than 400 characters`);
    if (c.path.length > MAX_PATH_CHARS) out.push(`${where}: the path is longer than ${MAX_PATH_CHARS} characters`);
  });
  for (const inv of a.inventory) if (!declared.has(`${inv.name}@${inv.version}`)) out.push(`${at}: inventory entry ${inv.name}@${inv.version} is not in the dependency inventory`);
  for (const m of a.metrics) {
    const r = ctx.view.records.find((x) => x.function === m.function && x.path === m.path);
    if (r === undefined) {
      out.push(`${at}: the metric names ${JSON.stringify(m.function)} in ${JSON.stringify(m.path)}, which no measurement record has`);
      continue;
    }
    const truth = m.name === "complexity" ? r.complexity : m.name === "nesting" ? r.nesting : r.crap ?? crapRounded(r.complexity, r.coverage);
    if (truth !== m.value) out.push(`${at}: ${m.function} ${m.name} is ${truth} in its measurement record, not ${m.value}`);
  }
  const testCited = a.citations.some((c) => c.tree !== "dependency" && isTestPath(ctx.packs, c.path));
  const baseSearches = a.searches.filter((s) => s.tree === "base").length;
  const fn = functionOf(q, ctx);
  const mustNeedAuthor = ["missing-test", "complexity-coverage", "weak-test"].includes(q.type) && !testCited;
  switch (q.type) {
    case "necessity":
      if (a.necessity === undefined) out.push(`${at}: the necessity answer is missing`);
      else out.push(...necessityProblems(a.necessity, ctx.pinned ?? []));
      break;
    case "purpose":
      if (a.status === "answered" && a.citations.length === 0) out.push(`${at}: a purpose is answered only from cited code, comments or documents; otherwise it needs the author`);
      break;
    case "existing-equivalent":
    case "common-logic":
    case "reuse-library":
      if (a.none_found) {
        const need = q.type === "reuse-library" ? 1 : 3;
        if (baseSearches < need) out.push(`${at}: a "none found" answer lists the whole-repository searches that found nothing (${need} or more over the base tree: names and variants, signatures, key tokens), not ${baseSearches}`);
        const inv = ctx.groundwork.inventory;
        if (q.type === "reuse-library" && a.status === "answered" && (inv.dependencies.some((d) => d.source === undefined) || inv.truncated.length > 0)) {
          out.push(`${at}: ${inv.truncated.length > 0 ? "the dependency inventory is incomplete" : "some declared dependency has no source available here"}, so a "none found" library answer is "partially answered", not "answered"`);
        }
      } else if (a.citations.length === 0 && a.status !== "needs author") out.push(`${at}: an answer that names an existing equivalent, library or duplicate cites it`);
      break;
    case "split-function":
      if (a.status !== "answered") out.push(`${at}: a split-function answer is "answered" with a split proposal, never "${a.status}"`);
      if (a.proposal.kind !== "split") out.push(`${at}: a split-function answer carries a split proposal`);
      break;
    case "missing-test":
    case "complexity-coverage":
      if (mustNeedAuthor && a.status === "answered") out.push(`${at}: an "answered" ${q.type} answer cites the covering test (a test file); with none found it stays "needs author", with a test outline`);
      if (a.status === "needs author" && a.proposal.kind !== "test") out.push(`${at}: a "needs author" ${q.type} answer carries a test outline (kind "test"): where the test would live and what to cover`);
      break;
    case "weak-test":
      if (mustNeedAuthor && a.status === "answered") out.push(`${at}: an "answered" weak-test answer cites the test that would catch the mutant; with none it stays "needs author", with the assertion`);
      if (a.status === "needs author" && a.proposal.kind !== "assertion") out.push(`${at}: a "needs author" weak-test answer carries the assertion that would kill the mutant (kind "assertion")`);
      break;
    default:
      break;
  }
  const p = a.proposal;
  if (p.kind === "split") {
    if (q.type !== "split-function") out.push(`${at}: a split proposal belongs to a split-function question`);
    else out.push(...splitProblems(p, at, fn, ctx));
  } else if (p.kind === "test") {
    if (q.type !== "missing-test" && q.type !== "complexity-coverage") out.push(`${at}: a test outline belongs to a missing-test or complexity-coverage question`);
    const pack = fn !== undefined ? ctx.packs.find((x) => x.language === fn.language) : undefined;
    if (!isRelative(p.testFile) || (pack !== undefined && !matchesGeneratedGlob(pack.testFiles, p.testFile))) out.push(`${at}: the outline's file ${JSON.stringify(p.testFile)} is not a test file path of the language (${pack?.testFiles.join(", ") ?? "unknown language"})`);
    if (p.testName.trim() === "") out.push(`${at}: the outline names no test`);
    if (p.cases.length === 0 || p.cases.some((c) => c.input.trim() === "" || c.branches.trim() === "")) out.push(`${at}: the outline needs at least one case, each with its inputs and the branches it reaches`);
  } else if (p.kind === "assertion") {
    if (q.type !== "weak-test") out.push(`${at}: an assertion proposal belongs to a weak-test question`);
    if (p.assertion.trim() === "") out.push(`${at}: the assertion is empty`);
  }
  return out;
}

function splitProblems(p: Proposal, at: string, fn: ReturnType<typeof functionOf>, ctx: AnswerContext): string[] {
  const out: string[] = [];
  if (fn === undefined) return [`${at}: the function to split is not known`];
  if (p.splits.length < 2) out.push(`${at}: a split proposal names at least two functions`);
  if (p.splits.length > MAX_SPLITS) out.push(`${at}: a split proposal names at most ${MAX_SPLITS} functions`);
  const names = new Set<string>();
  const existing = new Set(ctx.groundwork.symbols.filter((s) => s.dir === fn.dir && s.language === fn.language).map((s) => s.name));
  for (const s of p.splits) {
    const where = `${at} split ${JSON.stringify(s.name)}`;
    if (!/^[A-Za-z_$][\w$]*$/.test(s.name) || s.name.length > 100) out.push(`${where}: not a function name`);
    if (names.has(s.name)) out.push(`${where}: named twice`);
    names.add(s.name);
    if (s.name === fn.name || existing.has(s.name)) out.push(`${where}: the name already exists in the package ${fn.dir}`);
    if (s.startLine < fn.start || s.endLine > fn.end || s.startLine > s.endLine) out.push(`${where}: lines ${s.startLine}-${s.endLine} are not inside ${fn.name} (${fn.start}-${fn.end})`);
    if (s.responsibility.trim() === "") out.push(`${where}: no single responsibility is stated`);
  }
  return out;
}

function isTestPath(packs: readonly FullPack[], path: string): boolean {
  const pack = packOf(packs, path);
  return pack !== undefined && pack.testFiles.length > 0 && matchesGeneratedGlob(pack.testFiles, path);
}

/** The result as typed data, or what the contract refuses in it. */
export function parseAnswers(output: unknown, listed?: ReadonlySet<string>): ParsedAnswers | { problems: string[] } {
  const shape = validateResultShape(output, ANSWERS_SCHEMA as unknown as Record<string, unknown>);
  if (shape.length > 0) return { problems: shape.slice(0, 20) };
  const notes = new Map<string, string[]>();
  const answers = (output as AnswersOutput).answers.map((a) => {
    if (listed === undefined) return a;
    // The contract's enum should have made the id exact; an id that is not is read only when it begins with one listed id.
    const r = resolveId(a.question, listed);
    if (r.id === undefined || r.id === a.question) return a;
    notes.set(r.id, [...(notes.get(r.id) ?? []), `the answerer's ${r.note ?? `id ${JSON.stringify(a.question)} read as ${r.id}`}`]);
    return { ...a, question: r.id };
  });
  return { answers, notes };
}

/** The necessity result (`necessity-v1`) as the one answer N1, or what the contract refuses in it. */
export function parseNecessity(output: unknown): ParsedAnswers | { problems: string[] } {
  const shape = validateResultShape(output, NECESSITY_SCHEMA as unknown as Record<string, unknown>);
  return shape.length > 0 ? { problems: shape.slice(0, 20) } : { answers: [necessityAnswer(output as Necessity)], notes: new Map() };
}

/** The answers a result holds, and what was normalized in reading their ids (by question id). */
export interface ParsedAnswers {
  answers: Answer[];
  notes: Map<string, string[]>;
}

/** Which answerer the flow follows: the answers to the questions, or the necessity answer that comes before them. */
export interface AnswerKind {
  schema: string;
  revision: string;
  parse: (output: unknown, listed: ReadonlySet<string>) => ParsedAnswers | { problems: string[] };
}
export const ANSWER_KIND: AnswerKind = { schema: ANSWERS_SCHEMA_NAME, revision: ANSWERS_REVISION_SCHEMA_NAME, parse: parseAnswers };
export const NECESSITY_KIND: AnswerKind = { schema: NECESSITY_SCHEMA_NAME, revision: NECESSITY_REVISION_SCHEMA_NAME, parse: parseNecessity };

// ---- the deterministic verification of citations and names (design §7.3, check 1) ----

export interface VerifyEntry {
  question: string;
  label: string;
}
export interface VerifyItem {
  command: EnvironmentCommand;
  kind: "cite" | "names" | "search";
  entries: VerifyEntry[];
  /** A `search` item: the search it re-runs, and what each answer reported of it. */
  search?: Search;
  reported?: Array<{ question: string; hits: number }>;
  /** A search the checker reported: its count is measured and shown, but it corrects nobody. */
  advisory?: true;
}

const CITE_SCRIPT = String.raw`set -u; base="$1"; shift
{ i=0
while [ "$#" -ge 4 ]; do
  tree="$1"; path="$2"; end="$4"; shift 4; i=$((i + 1))
  if [ "$tree" = base ]; then
    if ! git -c core.hooksPath=/dev/null cat-file -e "$base:$path" 2>/dev/null; then echo "$i missing"; continue; fi
    n=$(git -c core.hooksPath=/dev/null show "$base:$path" 2>/dev/null | awk 'END { print NR }')
  else
    if [ ! -f "$path" ]; then echo "$i missing"; continue; fi
    n=$(awk 'END { print NR }' "$path")
  fi
  if [ "$end" -gt "$n" ]; then echo "$i range $n"; else echo "$i ok"; fi
done; echo "checked $i"; } > "$GRAPHLOOM_REPORT_FILE"`;

const NAMES_SCRIPT = String.raw`set -u; base="$1"; dir="$2"; shift 2
{ i=0
for name in "$@"; do
  i=$((i + 1))
  hit=$(git -c core.hooksPath=/dev/null grep -n -I --no-color -E -e "(^|[^A-Za-z0-9_])(func|function|type|const|var|class|interface)[[:space:]]+([(][^)]*[)][[:space:]]*)?$name([^A-Za-z0-9_]|$)" -e "^[[:space:]]*$name[[:space:]]*(:=|=)" -e "^[[:space:]]+([a-z]+[[:space:]]+)*$name[[:space:]]*[(<]" "$base" -- "$dir" 2>/dev/null | head -n 1)
  if [ -n "$hit" ]; then echo "exists $name"; fi
done; echo "checked $i"; } > "$GRAPHLOOM_REPORT_FILE"`;

const dirsOf = (ctx: Pick<AnswerContext, "groundwork">): string[] => (ctx.groundwork.inventory !== undefined ? sourceDirs(ctx.groundwork.inventory) : []);

/**
 * The commands that re-run searches: one per distinct `base` or `head` search, at most MAX_RERUN_SEARCHES, in the
 * order given. A dependency search is not re-run (its source lies outside the repository), nor is an invalid one
 * (it is sent back); the ids are content-addressed, so the same search is run once however many answers report it.
 */
export function searchItems(list: ReadonlyArray<{ question: string; search: Search }>, base: string, idPrefix: string, dirs: readonly string[], advisory = false): VerifyItem[] {
  const byKey = new Map<string, { search: Search; reported: Array<{ question: string; hits: number }> }>();
  for (const { question, search } of list) {
    if (search.tree === "dependency" || searchProblems(search, "", dirs).length > 0) continue;
    const key = searchKey(search);
    const entry = byKey.get(key) ?? { search, reported: [] };
    entry.reported.push({ question, hits: search.hits });
    byKey.set(key, entry);
  }
  return [...byKey].slice(0, MAX_RERUN_SEARCHES).map(([key, e]) => {
    const id = `${idPrefix}-s-${createHash("sha1").update(key).digest("hex").slice(0, 10)}`;
    return { kind: "search" as const, search: e.search, reported: e.reported, ...(advisory ? { advisory: true as const } : {}), entries: e.reported.map((r) => ({ question: r.question, label: e.search.pattern })), command: searchCommand(id, base, e.search) };
  });
}

/** The commands that check a set of answers: each citation against its tree, each split proposal's names against the package, and each search they report, re-run. */
export function verificationPlan(answers: readonly Answer[], ctx: AnswerContext, base: string, idPrefix: string = COMMAND.cite): VerifyItem[] {
  const out: VerifyItem[] = [];
  const cites: Array<{ question: string; c: Citation }> = [];
  for (const a of answers) for (const c of a.citations) cites.push({ question: a.question, c });
  for (let i = 0; i < cites.length; i += CITES_PER_COMMAND) {
    const chunk = cites.slice(i, i + CITES_PER_COMMAND);
    const id = `${idPrefix}-${out.length + 1}`;
    out.push({
      kind: "cite",
      entries: chunk.map(({ question, c }) => ({ question, label: `${c.tree}:${c.path}:${c.start}-${c.end}` })),
      command: { id, argv: ["sh", "-c", CITE_SCRIPT, id, base, ...chunk.flatMap(({ c }) => [c.tree, c.path, String(c.start), String(c.end)])] },
    });
  }
  let n = 0;
  for (const a of answers) {
    if (a.proposal.kind !== "split" || a.proposal.splits.length === 0) continue;
    const q = ctx.questions.find((x) => x.id === a.question);
    const fn = q !== undefined ? functionOf(q, ctx) : undefined;
    if (fn === undefined) continue;
    n += 1;
    const id = `${COMMAND.names}-${n}`;
    const names = a.proposal.splits.map((s) => s.name).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
    out.push({ kind: "names", entries: names.map((name) => ({ question: a.question, label: name })), command: { id, argv: ["sh", "-c", NAMES_SCRIPT, id, base, fn.dir, ...names] } });
  }
  // The searches behind a "none found" answer come first, so they are inside the bound.
  const ordered = [...answers].sort((x, y) => Number(y.none_found) - Number(x.none_found));
  out.push(...searchItems(ordered.flatMap((a) => a.searches.map((search) => ({ question: a.question, search }))), base, idPrefix, dirsOf(ctx)));
  return out;
}

/** The run of a verification command with exactly this argv: its latest. */
function runWith(evidence: readonly EvidenceRecord[], command: EnvironmentCommand): ReturnType<typeof commandRuns>[number] | undefined {
  return commandRuns(evidence, command.id).filter((r) => r.command.argv.length === command.argv.length && r.command.argv.every((a, i) => a === command.argv[i])).at(-1);
}

export type VerifyOutcome = { state: "missing"; commands: EnvironmentCommand[] } | { state: "failed"; reason: string; refs: string[] } | { state: "checked"; problems: string[] };

/** What the evidence says of a plan: commands still to run, a command that failed, or the problems found (none when every citation resolves). */
export function verificationOutcome(evidence: readonly EvidenceRecord[], plan: readonly VerifyItem[], retryable: (r: ReturnType<typeof commandRuns>[number]) => boolean = () => false): VerifyOutcome {
  const missing: EnvironmentCommand[] = [];
  const problems: string[] = [];
  for (const item of plan) {
    const run = runWith(evidence, item.command);
    if (run === undefined || (!succeeded(run.command) && retryable(run))) {
      missing.push(item.command);
      continue;
    }
    if (!succeeded(run.command)) return { state: "failed", reason: `${item.command.id} did not run: exit ${run.command.exitCode ?? "signal"}: ${(run.command.stderrTail || run.command.stdoutTail).slice(-300)}`, refs: [run.record.ref] };
    const lines = reportText(run).text.split("\n");
    const checked = lines.map((l) => /^checked (\d+)$/.exec(l)).find((m) => m !== null);
    const expected = item.kind === "search" ? 1 : item.entries.length;
    if (checked === undefined || Number(checked[1]) !== expected) {
      problems.push(`${item.command.id} checked ${checked?.[1] ?? "none"} of ${expected} entries`);
      continue;
    }
    if (item.kind === "search") {
      if (item.advisory === true) continue;
      const read = readSearchReport(lines.join("\n"));
      const s = item.search!;
      const named = `the search ${JSON.stringify(s.pattern.length > 80 ? `${s.pattern.slice(0, 79)}…` : s.pattern)} (${searchWhere(s)})`;
      if (read === undefined) problems.push(`${item.entries[0]?.question ?? "?"}: ${named} was not measured`);
      else if ("error" in read) problems.push(`${item.entries[0]?.question ?? "?"}: ${named} could not run: ${read.error}`);
      else {
        for (const r of item.reported ?? []) {
          if (r.hits === 0 && read.measured > 0) problems.push(`${r.question}: ${named} is reported as finding nothing (hits 0), but re-running it measured ${read.measured} hit${read.measured === 1 ? "" : "s"} in ${read.files} file${read.files === 1 ? "" : "s"}: an answer cannot rest on it as an absence, and its count is the measured one`);
        }
      }
    } else if (item.kind === "cite") {
      const result = new Map<number, string>();
      for (const l of lines) {
        const m = /^(\d+) (ok|missing|range \d+)$/.exec(l);
        if (m !== null) result.set(Number(m[1]), m[2]!);
      }
      item.entries.forEach((e, i) => {
        const r = result.get(i + 1);
        if (r === undefined) problems.push(`${e.question}: citation ${e.label} was not checked`);
        else if (r === "missing") problems.push(`${e.question}: citation ${e.label} names no such file in that tree`);
        else if (r.startsWith("range")) problems.push(`${e.question}: citation ${e.label} lies past the end of the file (${r.slice(6)} lines)`);
      });
    } else {
      for (const l of lines) {
        const m = /^exists (\S+)$/.exec(l);
        if (m !== null) problems.push(`${item.entries[0]?.question ?? "?"}: the proposed name ${m[1]} already exists in the package`);
      }
    }
  }
  if (missing.length > 0) return { state: "missing", commands: missing };
  return { state: "checked", problems };
}

/** What the plugin measured for a search, or why it did not: the lookup the Q&A's final answers use. */
export type SearchMeasurer = (s: Search) => Pick<MeasuredSearch, "measured" | "files" | "note">;

export function searchMeasurer(evidence: readonly EvidenceRecord[], plan: readonly VerifyItem[], dirs: readonly string[]): SearchMeasurer {
  const byKey = new Map<string, NonNullable<ReturnType<typeof readSearchReport>>>();
  for (const item of plan) {
    if (item.kind !== "search" || item.search === undefined) continue;
    const run = runWith(evidence, item.command);
    const read = run !== undefined && succeeded(run.command) ? readSearchReport(reportText(run).text) : undefined;
    if (read !== undefined) byKey.set(searchKey(item.search), read);
  }
  return (s) => {
    if (s.tree === "dependency") return { note: "not re-run: the dependency's source lies outside the repository, so this count is the agent's own" };
    const invalid = searchProblems(s, "search", dirs)[0];
    if (invalid !== undefined) return { note: `not run: ${invalid}` };
    const read = byKey.get(searchKey(s));
    if (read === undefined) return { note: `not re-run: only the first ${MAX_RERUN_SEARCHES} distinct searches of one result are re-run (those behind none-found answers first), so this count is the agent's own` };
    if ("error" in read) return { note: `could not run: ${read.error}` };
    return { measured: read.measured, files: read.files };
  };
}

// ---- the answer checker ----

export interface AnswerReading {
  /** Questions the check did not judge, or judged without the searches of its own that the answer calls for. */
  unchecked: string[];
  supported: Set<string>;
  partial: Map<string, string>;
  unsupported: Map<string, string>;
  searches: Map<string, Search[]>;
  /** What was normalized in reading the verdicts' ids, by question id. */
  notes: Map<string, string[]>;
  /** Verdict ids that matched no question (unknown or ambiguous), which stay unjudged. */
  ignored: string[];
}

/** Reads a checker result against the answers it was asked about. */
export function readAnswerCheck(output: unknown, questions: readonly Question[], answers: ReadonlyMap<string, Answer>): AnswerReading | { problems: string[] } {
  const shape = validateResultShape(output, ANSWER_CHECK_SCHEMA as unknown as Record<string, unknown>);
  if (shape.length > 0) return { problems: shape.slice(0, 10) };
  const list = (output as { verdicts: CheckVerdict[] }).verdicts;
  const byQuestion = new Map<string, CheckVerdict>();
  const listed = new Set(questions.map((q) => q.id));
  const notes = new Map<string, string[]>();
  const ignored: string[] = [];
  for (const v of list) {
    // The contract's enum should have made the id exact; one that is not is read only when it begins with one listed id.
    const r = resolveId(v.question, listed);
    if (r.id === undefined) {
      ignored.push(`${JSON.stringify(v.question.length > 60 ? `${v.question.slice(0, 59)}…` : v.question)} (${r.why})`);
      continue;
    }
    if (r.note !== undefined) notes.set(r.id, [...(notes.get(r.id) ?? []), `the checker's ${r.note}`]);
    const earlier = byQuestion.get(r.id);
    // Two verdicts for one question: the weaker stands.
    if (earlier === undefined || VERDICTS.indexOf(v.verdict) > VERDICTS.indexOf(earlier.verdict)) byQuestion.set(r.id, v);
  }
  const reading: AnswerReading = { unchecked: [], supported: new Set(), partial: new Map(), unsupported: new Map(), searches: new Map(), notes, ignored };
  for (const q of questions) {
    const a = answers.get(q.id);
    const v = byQuestion.get(q.id);
    if (a === undefined) continue;
    if (v === undefined || (needsOwnSearch(q, a) && v.searches.length === 0)) {
      reading.unchecked.push(q.id);
      continue;
    }
    reading.searches.set(q.id, v.searches);
    if (v.verdict === "supported") reading.supported.add(q.id);
    else if (v.verdict === "partial") reading.partial.set(q.id, v.note.trim());
    else reading.unsupported.set(q.id, v.note.trim());
  }
  return reading;
}

/** One answer as the Q&A holds it: the answerer's, with the checker's verdict, and both statements when it was downgraded. */
export interface FinalAnswer extends Answer {
  /** The searches as the plugin re-ran them: its own count beside the agent's, or why it has none. */
  searches: MeasuredSearch[];
  check: { verdict: AnswerVerdict | "downgraded"; note: string; searches: MeasuredSearch[] };
  /** What was normalized in reading this answer's id and its verdict's, recorded and never silent. */
  notes: string[];
  /** The statements the answerer made, oldest first, when the answer was corrected. */
  history: Array<{ answer: string; status: AnswerStatus }>;
}

export type AnswersFlow =
  | { state: "answerer"; kind: "first" | "correction" | "revision"; feedback: string[]; schema: string; only?: string[] }
  | { state: "verify"; commands: EnvironmentCommand[]; answers: Map<string, Answer> }
  | { state: "checker"; answers: Map<string, Answer>; retry: boolean }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; final: FinalAnswer[]; refs: string[] };

interface Event {
  at: number;
  kind: "answerer" | "checker";
  run: AgentRun;
}

function events(evidence: readonly EvidenceRecord[], kind: AnswerKind): Event[] {
  const index = new Map(evidence.map((e, i) => [e.ref, i]));
  const answerers = [kind.schema, kind.revision].flatMap((schema) => agentRuns(evidence, schema).map((run) => ({ at: index.get(run.record.ref) ?? 0, kind: "answerer" as const, run })));
  const checkers = agentRuns(evidence, ANSWER_CHECK_SCHEMA_NAME).map((run) => ({ at: index.get(run.record.ref) ?? 0, kind: "checker" as const, run }));
  return [...answerers, ...checkers].sort((a, b) => a.at - b.at);
}

/**
 * Where the answers stand, from the evidence alone: the answerer answers;
 * deterministic checks and the citations' verification correct it (at most
 * MAX_ANSWER_CORRECTIONS times, then the supervisor); a checker on another
 * harness judges every answer; an unsupported answer goes back once; what is
 * still unsupported after that is `needs author`, with both statements.
 */
export function answersFlow(evidence: readonly EvidenceRecord[], ctx: AnswerContext, base: string, retryable?: (r: ReturnType<typeof commandRuns>[number]) => boolean, kind: AnswerKind = ANSWER_KIND, idPrefix: string = COMMAND.cite): AnswersFlow {
  let current: Map<string, Answer> | undefined;
  let original: Map<string, Answer> | undefined;
  let revised = false;
  let flagged: string[] = [];
  let reading: AnswerReading | undefined;
  let pending: { problems: string[]; revision: boolean } | undefined;
  let failures = 0;
  let checkTries = 0;
  let ignored: string[] = [];
  let idNotes = new Map<string, string[]>();
  const refs: string[] = [];
  const all = new Set(ctx.questions.map((q) => q.id));
  for (const ev of events(evidence, kind)) {
    refs.push(ev.run.record.ref);
    if (ev.kind === "answerer") {
      const revision = ev.run.record.resultSchema === kind.revision;
      if (ev.run.status !== "completed") continue;
      const parsed = ev.run.contract?.status === "invalid" ? { problems: ev.run.contract.problems.slice(0, 20) } : kind.parse(ev.run.output, all);
      if ("problems" in parsed) {
        failures += 1;
        pending = { problems: parsed.problems, revision };
        continue;
      }
      // A revision answers the questions the checker found unsupported, which the latest review evidence no longer shows
      // (a validator sees only the newest): the questions it answers are the scope, each one checked like any answer.
      const scope = revision ? new Set(parsed.answers.map((a) => a.question)) : all;
      let problems = answerProblems(parsed.answers, ctx, scope);
      if (revision && parsed.answers.length === 0) problems = ["a revision answers the questions the checker did not support; it answered none"];
      const merged = new Map(revision ? current : []);
      for (const a of parsed.answers) merged.set(a.question, a);
      if (problems.length === 0) {
        const v = verificationOutcome(evidence, verificationPlan([...merged.values()], ctx, base, idPrefix));
        if (v.state === "checked") problems = v.problems;
      }
      if (problems.length > 0) {
        failures += 1;
        pending = { problems, revision };
        continue;
      }
      current = merged;
      idNotes = new Map(revision ? idNotes : []);
      for (const [id, n] of parsed.notes) idNotes.set(id, [...(idNotes.get(id) ?? []), ...n]);
      if (!revision) original = new Map(merged);
      if (revision) revised = true;
      pending = undefined;
      reading = undefined;
      checkTries = 0;
      continue;
    }
    if (current === undefined || pending !== undefined || ev.run.status !== "completed") continue;
    const read = ev.run.contract?.status === "invalid" ? { problems: ev.run.contract.problems } : readAnswerCheck(ev.run.output, ctx.questions, current);
    if ("problems" in read || read.unchecked.length > 0) {
      checkTries += 1;
      ignored = "problems" in read ? [] : read.ignored;
      continue;
    }
    reading = read;
    flagged = [...read.unsupported.keys()];
  }
  const tail = refs.slice(-10);
  if (pending !== undefined) {
    if (failures > MAX_ANSWER_CORRECTIONS) return { state: "supervise", reason: `the answers still fail deterministic validation after ${MAX_ANSWER_CORRECTIONS} corrections: ${pending.problems.slice(0, 3).join("; ")}`, refs: tail };
    const only = pending.revision ? flagged : undefined;
    return { state: "answerer", kind: "correction", feedback: pending.problems, schema: pending.revision ? kind.revision : kind.schema, ...(only !== undefined ? { only } : {}) };
  }
  if (current === undefined) return { state: "answerer", kind: "first", feedback: [], schema: kind.schema };
  const outcome = verificationOutcome(evidence, verificationPlan([...current.values()], ctx, base, idPrefix), retryable);
  if (outcome.state === "missing") return { state: "verify", commands: outcome.commands, answers: current };
  if (outcome.state === "failed") return { state: "supervise", reason: outcome.reason, refs: outcome.refs };
  if (reading === undefined) {
    if (checkTries > MAX_ANSWER_CHECK_RETRIES) return { state: "supervise", reason: `the answer checker did not judge every answer after ${checkTries} tries${ignored.length > 0 ? `; verdict ids that matched no question: ${ignored.slice(0, 4).join(", ")}` : ""}`, refs: tail };
    return { state: "checker", answers: current, retry: checkTries > 0 };
  }
  if (reading.unsupported.size > 0 && !revised) {
    const feedback = [...reading.unsupported].map(([id, note]) => `${id}: the answer checker found it unsupported: ${note === "" ? "(no note)" : note}`);
    return { state: "answerer", kind: "revision", feedback, schema: kind.revision, only: [...reading.unsupported.keys()] };
  }
  // The searches the checker reported are re-run too, so the Q&A shows measured counts beside its own.
  const dirs = dirsOf(ctx);
  const checkerPlan = searchItems([...reading.searches].flatMap(([question, list]) => list.map((search) => ({ question, search }))), base, idPrefix, dirs, true);
  const measured = verificationOutcome(evidence, checkerPlan, retryable);
  if (measured.state === "missing") return { state: "verify", commands: measured.commands, answers: current };
  if (measured.state === "failed") return { state: "supervise", reason: measured.reason, refs: measured.refs };
  const measure = searchMeasurer(evidence, [...verificationPlan([...current.values()], ctx, base, idPrefix), ...checkerPlan], dirs);
  return { state: "done", final: assemble(ctx.questions, current, original ?? current, reading, revised, measure, idNotes), refs: tail };
}

/** The answers as the Q&A holds them: what the checker did not support, after the one correction, is `needs author` with both statements. */
export function assemble(questions: readonly Question[], current: ReadonlyMap<string, Answer>, original: ReadonlyMap<string, Answer>, reading: AnswerReading, revised: boolean, measure: SearchMeasurer = () => ({}), idNotes: ReadonlyMap<string, string[]> = new Map()): FinalAnswer[] {
  const out: FinalAnswer[] = [];
  const measured = (list: readonly Search[]): MeasuredSearch[] => list.map((s) => ({ ...s, ...measure(s) }));
  for (const q of questions) {
    const a = current.get(q.id);
    if (a === undefined) continue;
    const first = original.get(q.id);
    const history = revised && first !== undefined && first !== a ? [{ answer: first.answer, status: first.status }, { answer: a.answer, status: a.status }] : [];
    const searches = measured(reading.searches.get(q.id) ?? []);
    const notes = [...(idNotes.get(q.id) ?? []), ...(reading.notes.get(q.id) ?? [])];
    const mine = { ...a, searches: measured(a.searches), notes };
    if (reading.unsupported.has(q.id)) {
      out.push({ ...mine, status: "needs author", check: { verdict: "downgraded", note: reading.unsupported.get(q.id) ?? "", searches }, history: history.length > 0 ? history : [{ answer: a.answer, status: a.status }] });
    } else if (reading.partial.has(q.id)) out.push({ ...mine, check: { verdict: "partial", note: reading.partial.get(q.id) ?? "", searches }, history });
    else out.push({ ...mine, check: { verdict: "supported", note: "", searches }, history });
  }
  return out;
}

