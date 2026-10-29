// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The graphloom-metrics-v1 record and document (docs/design-code-quality-metrics.md §5).
// Dependency-free, so it can be vendored into the issue-fix review kit.

export const SCHEMA = "graphloom-metrics-v1";

export type Language = "go" | "typescript";

/** One line of evidence: a decision point or a control block. */
export interface Step {
  line: number;
  kind: string;
}

export type Coverage =
  | { source: "measured"; covered: number; total: number; unit?: string; provider?: string }
  | { source: "unknown"; reason: string };

/** One measured function. The static tools emit everything but coverage, crap and mutation. */
export interface MetricsRecord {
  path: string;
  /** Qualified name; closures are `<enclosing>.func<n>`. */
  function: string;
  startLine: number;
  endLine: number;
  change: "added" | "modified";
  /** A test file: measured for complexity and nesting only. */
  test: boolean;
  complexity: number;
  decisions: Step[];
  nesting: number;
  nestingPath: Step[];
  coverage?: Coverage;
  crap?: number;
  mutation?: unknown;
}

/** [qualified name, startLine, endLine] */
export type FunctionIndexEntry = [string, number, number];

/** Every function of a changed file, so scope can be checked. */
export interface FileIndex {
  path: string;
  language: Language;
  test: boolean;
  functions: FunctionIndexEntry[];
}

export type SkipReason = "generated" | "unsupported-language" | "not-in-head";

export interface Skipped {
  path: string;
  reason: SkipReason;
}

/** What `gometrics` and `tsmetrics` print. */
export interface MetricsDocument {
  schema: typeof SCHEMA;
  tool: string;
  records: MetricsRecord[];
  files: FileIndex[];
  skipped: Skipped[];
}

export interface LineRange {
  start: number;
  end: number;
}

/** Head-side changed line ranges by path. */
export type Hunks = Map<string, LineRange[]>;

export const GO_DECISION_KINDS = ["if", "for", "case", "&&", "||"] as const;
export const GO_NESTING_KINDS = ["if", "for", "switch", "select"] as const;
export const TS_DECISION_KINDS = ["if", "?:", "for", "while", "do", "case", "&&", "||", "??", "catch"] as const;
export const TS_NESTING_KINDS = ["if", "for", "while", "do", "switch", "try"] as const;

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export function languageOf(path: string): Language | undefined {
  if (path.endsWith(".go")) return "go";
  if (TS_EXTENSIONS.some((ext) => path.endsWith(ext))) return "typescript";
  return undefined;
}

/** Test files are measured for complexity and nesting only (§1). */
export function isTestPath(path: string): boolean {
  if (path.endsWith("_test.go")) return true;
  if (languageOf(path) !== "typescript") return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  return path.split("/").some((seg) => seg === "__tests__" || seg === "test" || seg === "tests");
}
