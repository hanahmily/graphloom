// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the briefing counts and selects with plugin code alone, never a model (design §6.1): the lines of a pull request
 * by kind of file (production code, tests, docs, generated or other), the hotspots (the five functions with the highest
 * CRAP, then complexity), and the open questions (the ones that need the author, or whose necessity conclusion is in
 * doubt). Pure functions of the file list, the measurement records and the answers, so `review.md` and `review.html` agree.
 */
import { isExcluded } from "./areas.js";
import { matchesGeneratedGlob } from "./metrics/generated.js";
import { isTestPath, type MetricsRecord } from "./metrics/record.js";

export const SCOPE_KINDS = ["production", "tests", "docs", "generated"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const SCOPE_TITLES: Record<ScopeKind, string> = { production: "Production code", tests: "Tests", docs: "Docs", generated: "Generated / other" };

export interface ScopeRow {
  files: number;
  added: number;
  deleted: number;
}

export type Scope = Record<ScopeKind, ScopeRow>;

/** A test file: the plugin's own rule (`_test.go`, `*.test.ts` and `*.spec.ts`, a `test`, `tests` or `__tests__` directory), in any language. */
export function isTestFile(path: string): boolean {
  if (isTestPath(path) || path.endsWith("_test.go")) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) || path.split("/").slice(0, -1).some((seg) => seg === "test" || seg === "tests" || seg === "__tests__");
}

/** A documentation file: under `docs/`, or Markdown. */
export const isDocFile = (path: string): boolean => path.startsWith("docs/") || /\.md$/i.test(path);

/**
 * The kind of a changed file: generated when the profile's `excludeRoots` or its generated globs name it, then docs,
 * then tests, and production code for the rest.
 */
export function scopeKindOf(path: string, generated: { excludeRoots: readonly string[]; globs: readonly string[] }): ScopeKind {
  if (isExcluded(path, generated.excludeRoots) || matchesGeneratedGlob(generated.globs, path)) return "generated";
  if (isDocFile(path)) return "docs";
  if (isTestFile(path)) return "tests";
  return "production";
}

/** The lines added and deleted by kind of file, from the file list alone. */
export function scopeOf(files: ReadonlyArray<{ path: string; additions: number; deletions: number }>, generated: { excludeRoots: readonly string[]; globs: readonly string[] }): Scope {
  const scope: Scope = { production: { files: 0, added: 0, deleted: 0 }, tests: { files: 0, added: 0, deleted: 0 }, docs: { files: 0, added: 0, deleted: 0 }, generated: { files: 0, added: 0, deleted: 0 } };
  for (const f of files) {
    const row = scope[scopeKindOf(f.path, generated)];
    row.files += 1;
    row.added += f.additions;
    row.deleted += f.deletions;
  }
  return scope;
}

export const scopeText = (row: ScopeRow): string => `${row.files} file${row.files === 1 ? "" : "s"}, +${row.added} −${row.deleted}`;

// ---- hotspots ----

export const MAX_HOTSPOTS = 5;

export interface Hotspot {
  function: string;
  path: string;
  startLine: number;
  change: "added" | "modified";
  complexity: number;
  nesting: number;
  crap: number | undefined;
  /** CRAP is an upper bound because coverage was not measured. */
  bound: boolean;
  /** For a modified function that got worse: the metric, its base and head values. */
  worse: Array<{ metric: "complexity" | "nesting"; base: number; head: number }>;
}

/** The records' top functions by CRAP, then complexity, then nesting; test files are not ranked (they have no CRAP). */
export function hotspots(records: readonly MetricsRecord[], n = MAX_HOTSPOTS): Hotspot[] {
  const own = records.filter((r) => !r.test && !isTestPath(r.path));
  const ranked = [...own].sort((a, b) => (b.crap ?? -1) - (a.crap ?? -1) || b.complexity - a.complexity || b.nesting - a.nesting || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || (a.function < b.function ? -1 : a.function > b.function ? 1 : 0));
  return ranked.slice(0, n).map((r) => {
    const base = r.base !== undefined && !("unavailable" in r.base) ? r.base : undefined;
    const worse: Hotspot["worse"] = [];
    if (r.change === "modified" && base !== undefined) {
      if (r.complexity > base.complexity) worse.push({ metric: "complexity", base: base.complexity, head: r.complexity });
      if (r.nesting > base.nesting) worse.push({ metric: "nesting", base: base.nesting, head: r.nesting });
    }
    return { function: r.function, path: r.path, startLine: r.startLine, change: r.change, complexity: r.complexity, nesting: r.nesting, crap: r.crap, bound: r.coverage?.source !== "measured", worse };
  });
}

/** One line for a hotspot: the function, where it is, CRAP, and complexity and nesting, `base → head` where the pull request made them worse. */
export function hotspotText(h: Hotspot): string {
  const value = (metric: "complexity" | "nesting"): string => {
    const w = h.worse.find((x) => x.metric === metric);
    return `${metric} ${w !== undefined ? `${w.base} → ${w.head}` : h[metric]}`;
  };
  const crap = h.crap === undefined ? "CRAP n/a" : `CRAP ${h.crap}${h.bound ? " (upper bound, coverage unknown)" : ""}`;
  return `${h.function} — ${crap}, ${value("complexity")}, ${value("nesting")} (${h.change})`;
}

// ---- open questions ----

export interface QuestionLike {
  id: string;
  type: string;
  text: string;
  answer?: { status: string; answer: string } | undefined;
}

/** N1's conclusions that put it among the open questions, whatever its answer's status. */
export const DOUBTFUL_CONCLUSIONS: readonly string[] = ["questionable", "unnecessary"];

export interface OpenQuestions<T extends QuestionLike> {
  open: T[];
  /** Questions with an answered status that are not shown here. */
  answered: number;
  total: number;
}

/**
 * The questions that need a person: answered "needs author" or "partially answered" (or not answered at all), and N1 when
 * its conclusion is questionable or unnecessary. Every other question is only counted.
 */
export function openQuestions<T extends QuestionLike>(questions: readonly T[], n1: { id: string; conclusion: string | undefined }): OpenQuestions<T> {
  const open = questions.filter((q) => {
    if (q.id === n1.id && n1.conclusion !== undefined && DOUBTFUL_CONCLUSIONS.includes(n1.conclusion)) return true;
    return q.answer === undefined || q.answer.status === "needs author" || q.answer.status === "partially answered";
  });
  return { open, answered: questions.length - open.length, total: questions.length };
}

/** The questions whose answer status is "needs author": what the briefing counts as needing the author. */
export const needAuthor = (questions: readonly QuestionLike[]): number => questions.filter((q) => q.answer?.status === "needs author").length;
