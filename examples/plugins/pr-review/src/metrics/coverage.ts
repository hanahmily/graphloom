// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Coverage as the sandbox's report carries it, and its attribution to functions
// (docs/design-code-quality-metrics.md §2.3, §5). Dependency-free, so the
// attribution can be vendored with the other metrics modules and run in the
// sandbox image (the TypeScript reducer imports `reduceIstanbul` from here).
//
// The report (`graphloom-coverage-v1`) is line-based text a coverage command
// writes to its report file: a header, facts about the run, and the coverage
// facts themselves, filtered to the changed functions' line ranges so that it
// fits a command report:
//
//   graphloom-coverage-v1 go|typescript
//   exit <n>                 the test command's exit status (a failing test is a fact, not a void)
//   test <text>              one line of the test command's package results
//   note <text>              anything else worth reading
//   fail <reason>            the command could not produce coverage at all
//   provider <name@version>  the coverage provider
//   seen <path>              a file the coverage tool knew (so an empty function is not "not run")
//   B <path>:<l>.<c>,<l>.<c> <statements> <count>     one Go coverprofile block (path repository-relative)
//   S <path> <line> <count>                           one Istanbul statement's start line and hit count

import { crapRounded } from "./crap.js";
import type { Coverage, FunctionIndexEntry, Language, MetricsRecord } from "./record.js";

export const COVERAGE_SCHEMA = "graphloom-coverage-v1";

/** One Go coverprofile block. */
export interface GoBlock {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** Statements in the block. */
  stmts: number;
  count: number;
}

/** One Istanbul statement, by the line it starts on. */
export interface TsStatement {
  file: string;
  line: number;
  count: number;
}

export interface CoverageReport {
  language: Language;
  exit: number | undefined;
  tests: string[];
  notes: string[];
  /** The coverage command could not produce coverage at all, and why. */
  fail: string[];
  provider: string | undefined;
  seen: Set<string>;
  blocks: GoBlock[];
  statements: TsStatement[];
}

const BLOCK = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/;

/** One coverprofile line, or undefined for the `mode:` line and anything that is not a block. */
export function parseGoBlock(line: string): GoBlock | undefined {
  const m = BLOCK.exec(line.trim());
  if (m === null) return undefined;
  const [startLine, startCol, endLine, endCol, stmts, count] = [m[2], m[3], m[4], m[5], m[6], m[7]].map(Number) as [number, number, number, number, number, number];
  return { file: m[1]!, startLine, startCol, endLine, endCol, stmts, count };
}

/** Why `text` is not a coverage report, or the report. Unknown lines are ignored, so a later version may add facts. */
export function parseCoverageReport(text: string): CoverageReport | { error: string } {
  const lines = text.split("\n");
  const head = /^graphloom-coverage-v1 (go|typescript)$/.exec((lines[0] ?? "").trim());
  if (head === null) return { error: `the report does not start with "${COVERAGE_SCHEMA} go|typescript"` };
  const report: CoverageReport = { language: head[1] as Language, exit: undefined, tests: [], notes: [], fail: [], provider: undefined, seen: new Set(), blocks: [], statements: [] };
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\r$/, "");
    const sp = line.indexOf(" ");
    const tag = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1);
    switch (tag) {
      case "exit": {
        const n = Number(rest);
        if (Number.isSafeInteger(n)) report.exit = n;
        break;
      }
      case "test":
        report.tests.push(rest);
        break;
      case "note":
        report.notes.push(rest);
        break;
      case "fail":
        report.fail.push(rest);
        break;
      case "provider":
        report.provider = rest;
        break;
      case "seen":
        report.seen.add(rest);
        break;
      case "B": {
        const block = parseGoBlock(rest);
        if (block !== undefined) report.blocks.push(block);
        break;
      }
      case "S": {
        const m = /^(.+) (\d+) (\d+)$/.exec(rest);
        if (m !== null) report.statements.push({ file: m[1]!, line: Number(m[2]), count: Number(m[3]) });
        break;
      }
      default:
        break;
    }
  }
  return report;
}

/**
 * The function a coverage fact (a Go block's start line, an Istanbul statement's line) belongs to: the innermost
 * one whose lines hold it, where a nested function's boundary lines belong to the function that holds it. Go's
 * cover tool starts a nested function's body block on the line of its opening brace, so a Go block on a nested
 * function's first line is the nested function's own (its last line is the enclosing function's again); a
 * line-granular TypeScript statement on either boundary line is the enclosing function's own statement. A
 * nested function on one line owns nothing, since its line cannot be told from the enclosing function's.
 */
export function ownerOf(all: readonly FunctionIndexEntry[], line: number, language: Language): FunctionIndexEntry | undefined {
  let best: FunctionIndexEntry | undefined;
  for (const [i, e] of all.entries()) {
    const nested = all.slice(0, i).some((o) => o[1] <= e[1] && e[2] <= o[2]);
    const [from, to] = !nested ? [e[1], e[2]] : language === "go" ? [e[1], e[2] - 1] : [e[1] + 1, e[2] - 1];
    if (line < from || line > to) continue;
    // Later entries are nested in earlier ones (pre-order), so the last that holds the line is the innermost.
    best = e;
  }
  return best;
}

function tally(owned: ReadonlyArray<{ weight: number; count: number }>): { covered: number; total: number } {
  let covered = 0;
  let total = 0;
  for (const it of owned) {
    total += it.weight;
    if (it.count > 0) covered += it.weight;
  }
  return { covered, total };
}

export type RecordCoverage = Coverage;

/**
 * Why a function whose file produced no coverage facts has none: its package did not build, has no test
 * files, or the tool simply did not know the file.
 */
export function goUnseenReason(report: CoverageReport, path: string): string {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
  const line = (re: RegExp): string | undefined => report.tests.find((t) => re.test(t));
  if (dir !== ".") {
    const at = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (line(new RegExp(`(^|[\\s/])${at} \\[(build|setup) failed\\]`)) !== undefined) return `package ${dir} did not build offline`;
    if (line(new RegExp(`(^|[\\s/])${at} \\[no test files\\]`)) !== undefined) return `package ${dir} has no test files`;
  }
  if (report.fail.length > 0) return report.fail[0]!;
  return `no coverage was recorded for ${path}: its package did not build, or no test ran offline`;
}

/** The coverage of one function from a Go report: its own blocks, by line range, each weighted by its statements. */
export function goFunctionCoverage(report: CoverageReport, path: string, fn: FunctionIndexEntry, all: readonly FunctionIndexEntry[]): Coverage | { reason: string } {
  // A block can occur once per test binary (`go test` appends the profiles): in set mode it is covered when any occurrence is.
  const merged = new Map<string, { weight: number; count: number }>();
  for (const b of report.blocks) {
    if (b.file !== path || ownerOf(all, b.startLine, "go") !== fn) continue;
    const key = `${b.startLine}.${b.startCol},${b.endLine}.${b.endCol}`;
    const seen = merged.get(key);
    merged.set(key, { weight: b.stmts, count: Math.max(b.count, seen?.count ?? 0) });
  }
  const { covered, total } = tally([...merged.values()]);
  if (total === 0 && !report.seen.has(path)) return { reason: goUnseenReason(report, path) };
  return { source: "measured", covered, total, unit: "statement", provider: "go test -coverprofile -covermode=set" };
}

/** The coverage of one function from a TypeScript report: the statements that start in its own lines. */
export function tsFunctionCoverage(report: CoverageReport, path: string, fn: FunctionIndexEntry, all: readonly FunctionIndexEntry[]): Coverage | { reason: string } {
  if (!report.seen.has(path)) return { reason: report.fail[0] ?? `vitest reported no coverage for ${path}` };
  const own = report.statements.filter((s) => s.file === path && ownerOf(all, s.line, "typescript") === fn);
  const { covered, total } = tally(own.map((s) => ({ weight: 1, count: s.count })));
  return { source: "measured", covered, total, unit: "line-statement", ...(report.provider !== undefined ? { provider: report.provider } : {}) };
}

/** A record with `coverage` and the CRAP it implies. */
export function withCoverage(r: MetricsRecord, coverage: Coverage): MetricsRecord {
  return { ...r, coverage, crap: crapRounded(r.complexity, coverage) };
}

// ---------------------------------------------------------------- the TypeScript reducer

interface IstanbulFile {
  statementMap?: Record<string, { start?: { line?: number } }>;
  s?: Record<string, number>;
}

/**
 * Istanbul's `coverage-final.json` reduced to what attribution reads: for each wanted file (a repository-relative
 * path), a `seen` line and one `S` line per statement. `coverage-final.json` keys are absolute paths, so `root`
 * (the checkout's absolute path) turns them into repository-relative ones. Only the wanted files are kept, and
 * only statements inside a wanted range when ranges are given, so the result fits a command report.
 */
export function reduceIstanbul(json: unknown, root: string, wanted: ReadonlyMap<string, ReadonlyArray<{ start: number; end: number }>>): string[] {
  const out: string[] = [];
  if (json === null || typeof json !== "object") return out;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    const rel = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    const ranges = wanted.get(rel);
    if (ranges === undefined) continue;
    const file = value as IstanbulFile;
    out.push(`seen ${rel}`);
    for (const [id, st] of Object.entries(file.statementMap ?? {})) {
      const line = st.start?.line;
      if (typeof line !== "number") continue;
      if (ranges.length > 0 && !ranges.some((r) => line >= r.start && line <= r.end)) continue;
      out.push(`S ${rel} ${line} ${Number(file.s?.[id] ?? 0)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the command's spec

export interface CoverageSpecFunction {
  path: string;
  start: number;
  end: number;
}

/**
 * What a coverage command is asked to measure, as text that travels in its argv (so the recorded bytes are the
 * bytes measured): `pkg <dir>` (Go, a changed file's directory), `ws <dir>` (TypeScript, a workspace),
 * `file <path>` (TypeScript, a changed file) and `fn <path> <start> <end>` (a changed function's range).
 */
export function formatSpec(spec: { packages?: readonly string[]; workspace?: string; files?: readonly string[]; functions: readonly CoverageSpecFunction[] }): string {
  const lines = [
    ...(spec.workspace !== undefined ? [`ws ${spec.workspace}`] : []),
    ...(spec.packages ?? []).map((p) => `pkg ${p}`),
    ...(spec.files ?? []).map((f) => `file ${f}`),
    ...spec.functions.map((f) => `fn ${f.path} ${f.start} ${f.end}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function parseSpec(text: string): { packages: string[]; workspace?: string; files: string[]; functions: CoverageSpecFunction[] } {
  const out: { packages: string[]; workspace?: string; files: string[]; functions: CoverageSpecFunction[] } = { packages: [], files: [], functions: [] };
  for (const line of text.split("\n")) {
    const [tag, a, b, c] = line.split(" ");
    if (tag === "pkg" && a !== undefined) out.packages.push(a);
    else if (tag === "ws" && a !== undefined) out.workspace = a;
    else if (tag === "file" && a !== undefined) out.files.push(a);
    else if (tag === "fn" && a !== undefined && b !== undefined && c !== undefined) out.functions.push({ path: a, start: Number(b), end: Number(c) });
  }
  return out;
}

/** The ranges a spec names, by file. */
export function rangesOf(functions: readonly CoverageSpecFunction[]): Map<string, Array<{ start: number; end: number }>> {
  const out = new Map<string, Array<{ start: number; end: number }>>();
  for (const f of functions) out.set(f.path, [...(out.get(f.path) ?? []), { start: f.start, end: f.end }]);
  return out;
}
