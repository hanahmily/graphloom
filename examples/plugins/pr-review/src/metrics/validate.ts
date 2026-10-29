// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Deterministic recomputation of a graphloom-metrics-v1 document
// (design-code-quality-metrics.md §5). A record that does not recompute is
// rejected, never corrected: this module only reports errors.

import { crapRounded } from "./crap.js";
import { isGeneratedSource } from "./generated.js";
import { changedLines } from "./hunks.js";
import {
  GO_DECISION_KINDS,
  GO_NESTING_KINDS,
  SCHEMA,
  TS_DECISION_KINDS,
  TS_NESTING_KINDS,
  isTestPath,
  languageOf,
  type FileIndex,
  type FunctionIndexEntry,
  type Hunks,
  type Language,
  type MetricsDocument,
  type MetricsRecord,
  type Step,
} from "./record.js";
import { classifyFunction, isOwnLine } from "./scope.js";

export interface ValidateOptions {
  /** The head file's text, or undefined when the path is not in the head. */
  readFile: (path: string) => string | undefined;
  /** Head-side changed lines of the diff, by path. */
  hunks: Hunks;
  /** The profile's `generated` globs. */
  generated?: readonly string[];
  /**
   * An independent function index of a head file (for example from a second
   * run of the tool). When given, the document's index must equal it, so an
   * omitted function cannot hide from scope recomputation.
   */
  reindex?: (path: string, language: Language, text: string) => FunctionIndexEntry[] | undefined;
  /** Reject records that carry no coverage and crap (later phases). Default false. */
  requireCoverage?: boolean;
}

export interface ValidationError {
  path?: string;
  function?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const CRAP_TOLERANCE = 0.0051;

/** Regex for one decision or control keyword on a source line. */
function kindPattern(kind: string): RegExp {
  switch (kind) {
    case "&&":
    case "||":
    case "??":
      return new RegExp(kind.replace(/[|?&]/g, "\\$&"), "g");
    case "?:":
      return /(?<!\?)\?(?!\?|\.(?!\d))/g;
    default:
      return new RegExp(`\\b${kind}\\b`, "g");
  }
}

function countKind(text: string, kind: string): number {
  return (text.match(kindPattern(kind)) ?? []).length;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isStep(v: unknown): v is Step {
  return typeof v === "object" && v !== null && isInt((v as Step).line) && typeof (v as Step).kind === "string";
}

/** A description of the first structural problem in the document, if any. */
function shapeErrors(d: MetricsDocument): string | undefined {
  const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  for (const [i, s] of d.skipped.entries()) {
    if (!obj(s) || typeof s.path !== "string" || typeof s.reason !== "string") return `skipped[${i}]`;
  }
  for (const [i, f] of d.files.entries()) {
    if (!obj(f) || typeof f.path !== "string" || typeof f.language !== "string" || typeof f.test !== "boolean") {
      return `files[${i}]`;
    }
    if (!Array.isArray(f.functions)) return `files[${i}].functions`;
    for (const [j, e] of f.functions.entries()) {
      if (!Array.isArray(e) || e.length !== 3) return `files[${i}].functions[${j}]`;
    }
  }
  for (const [i, r] of d.records.entries()) {
    if (
      !obj(r) ||
      typeof r.path !== "string" ||
      typeof r.function !== "string" ||
      typeof r.startLine !== "number" ||
      typeof r.endLine !== "number" ||
      typeof r.complexity !== "number" ||
      typeof r.nesting !== "number" ||
      typeof r.test !== "boolean" ||
      (r.change !== "added" && r.change !== "modified")
    ) {
      return `records[${i}]`;
    }
  }
  return undefined;
}

/** The declaring line of a function must show a function-like token. */
function declaresFunction(language: Language, line: string, name: string): boolean {
  if (language === "go") return /\bfunc\b/.test(line);
  const last = name.slice(name.lastIndexOf(".") + 1).replace(/^(get|set) /, "");
  return /\bfunction\b|=>|\(|\bconstructor\b|\b(?:export|default|declare|async|static|abstract|public|private|protected|override)\b|^\s*@/.test(line) || (last !== "" && line.includes(last));
}

export function validateMetricsDocument(doc: unknown, options: ValidateOptions): ValidationResult {
  const errors: ValidationError[] = [];
  const fail = (message: string, path?: string, fn?: string): void => {
    errors.push({ message, ...(path === undefined ? {} : { path }), ...(fn === undefined ? {} : { function: fn }) });
  };

  const d = doc as Partial<MetricsDocument> | null;
  if (typeof d !== "object" || d === null) {
    fail("document is not an object");
    return { ok: false, errors };
  }
  if (d.schema !== SCHEMA) fail(`schema must be ${SCHEMA}`);
  if (!Array.isArray(d.records) || !Array.isArray(d.files) || !Array.isArray(d.skipped)) {
    fail("records, files and skipped must be arrays");
    return { ok: false, errors };
  }
  const shape = shapeErrors(d as MetricsDocument);
  if (shape !== undefined) {
    fail(`malformed document: ${shape}`);
    return { ok: false, errors };
  }
  // Each tool measures its own language and skips the other's files.
  const toolLanguage: Language | undefined =
    d.tool === "gometrics" ? "go" : d.tool === "tsmetrics" ? "typescript" : undefined;

  const globs = options.generated ?? [];
  const accounted = new Set<string>();
  const indexByPath = new Map<string, FileIndex>();

  for (const skip of d.skipped) {
    accounted.add(skip.path);
    const language = languageOf(skip.path);
    if (skip.reason === "unsupported-language") {
      if (language !== undefined && (toolLanguage === undefined || language === toolLanguage)) {
        fail("skipped as unsupported but the tool supports its language", skip.path);
      }
    } else if (skip.reason === "not-in-head") {
      if (options.readFile(skip.path) !== undefined) fail("skipped as not in head but the file exists", skip.path);
    } else if (skip.reason === "generated") {
      const text = options.readFile(skip.path);
      if (language === undefined || text === undefined || !isGeneratedSource(skip.path, language, text, globs)) {
        fail("skipped as generated but no profile glob or generated header says so", skip.path);
      }
    } else {
      fail(`unknown skip reason ${String(skip.reason)}`, skip.path);
    }
  }

  for (const file of d.files) {
    accounted.add(file.path);
    const language = languageOf(file.path);
    const text = options.readFile(file.path);
    if (language === undefined || language !== file.language) {
      fail("index language does not match the path", file.path);
      continue;
    }
    if (toolLanguage !== undefined && language !== toolLanguage) {
      fail(`${String(d.tool)} measures ${toolLanguage} files, not ${language}`, file.path);
      continue;
    }
    if (text === undefined) {
      fail("indexed file is not in the head", file.path);
      continue;
    }
    if (isGeneratedSource(file.path, language, text, globs)) fail("generated file is indexed as measured", file.path);
    if (file.test !== isTestPath(file.path)) fail("test flag does not match the path", file.path);
    const lines = text.split("\n");
    // Only well-formed entries take part in scope recomputation.
    const sane: FunctionIndexEntry[] = [];
    for (const entry of file.functions) {
      const [name, start, end] = entry;
      if (typeof name !== "string" || !isInt(start) || !isInt(end) || end < start || end > lines.length) {
        fail(`bad index entry ${JSON.stringify(entry)}`, file.path);
        continue;
      }
      sane.push(entry);
      if (!declaresFunction(language, lines[start - 1] ?? "", name)) {
        fail(`indexed range starts on line ${start}, which does not declare a function`, file.path, name);
      }
    }
    // The index must list every function. Go declarations start in column 0.
    if (language === "go") {
      const starts = new Set(sane.map((e) => e[1]));
      lines.forEach((line, i) => {
        if (/^func\b/.test(line) && !starts.has(i + 1)) {
          fail(`line ${i + 1} declares a function that is not indexed`, file.path);
        }
      });
    }
    const independent = options.reindex?.(file.path, language, text);
    if (independent !== undefined && JSON.stringify(independent) !== JSON.stringify(file.functions)) {
      fail("function index differs from an independent index of the head file", file.path);
    }
    indexByPath.set(file.path, { ...file, functions: sane });
  }

  for (const path of options.hunks.keys()) {
    if (!accounted.has(path)) fail("changed file is neither measured nor skipped", path);
  }

  // Scope: the measured set equals the changed functions of the index.
  const key = (path: string, e: FunctionIndexEntry): string => `${path}\u0000${e[0]}\u0000${e[1]}\u0000${e[2]}`;
  const expected = new Map<string, "added" | "modified">();
  for (const file of indexByPath.values()) {
    const changed = changedLines(options.hunks.get(file.path));
    for (const entry of file.functions) {
      const change = classifyFunction(entry, file.functions, changed);
      if (change !== undefined) expected.set(key(file.path, entry), change);
    }
  }
  const seen = new Set<string>();

  for (const rec of d.records) {
    const where = (m: string): void => fail(m, rec.path, rec.function);
    const file = indexByPath.get(rec.path);
    if (file === undefined) {
      where("record is for a file that is not indexed");
      continue;
    }
    const entry = file.functions.find((e) => e[0] === rec.function && e[1] === rec.startLine && e[2] === rec.endLine);
    if (entry === undefined) {
      where("record does not match an indexed function and range");
      continue;
    }
    const k = key(rec.path, entry);
    if (seen.has(k)) where("function is recorded twice");
    seen.add(k);
    const want = expected.get(k);
    if (want === undefined) where("function is not changed by the diff");
    else if (want !== rec.change) where(`change is ${rec.change} but the diff makes it ${want}`);
    validateRecord(rec, entry, file, options, where);
  }

  for (const [k, change] of expected) {
    if (!seen.has(k)) {
      const [path, name] = k.split("\u0000") as [string, string];
      fail(`changed (${change}) function has no record`, path, name);
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateRecord(
  rec: MetricsRecord,
  entry: FunctionIndexEntry,
  file: FileIndex,
  options: ValidateOptions,
  where: (message: string) => void,
): void {
  const language = file.language;
  const text = options.readFile(rec.path) ?? "";
  const lines = text.split("\n");
  const decisionKinds: readonly string[] = language === "go" ? GO_DECISION_KINDS : TS_DECISION_KINDS;
  const nestingKinds: readonly string[] = language === "go" ? GO_NESTING_KINDS : TS_NESTING_KINDS;

  if (rec.test !== file.test) where("record test flag differs from its file");
  if (!Array.isArray(rec.decisions) || !rec.decisions.every(isStep)) {
    where("decisions must be a list of {line, kind}");
    return;
  }
  if (!Array.isArray(rec.nestingPath) || !rec.nestingPath.every(isStep)) {
    where("nestingPath must be a list of {line, kind}");
    return;
  }

  // Complexity is 1 plus the listed decisions; each holds its keyword.
  if (rec.complexity !== 1 + rec.decisions.length) {
    where(`complexity ${rec.complexity} is not 1 + ${rec.decisions.length} decisions`);
  }
  const perLine = new Map<string, number>();
  for (const dec of rec.decisions) {
    if (!decisionKinds.includes(dec.kind)) {
      where(`decision kind "${dec.kind}" is not a ${language} decision point`);
      continue;
    }
    if (!isOwnLine(entry, file.functions, dec.line)) {
      where(`decision at line ${dec.line} is not in the function's own code`);
      continue;
    }
    const id = `${dec.line}\u0000${dec.kind}`;
    perLine.set(id, (perLine.get(id) ?? 0) + 1);
  }
  for (const [id, n] of perLine) {
    const [line, kind] = id.split("\u0000") as [string, string];
    const have = countKind(lines[Number(line) - 1] ?? "", kind);
    if (have < n) where(`line ${line} lists ${n} "${kind}" decision(s) but holds ${have}`);
  }

  // Nesting is the path length; steps are ordered, own, and hold their keyword.
  if (rec.nesting !== rec.nestingPath.length) {
    where(`nesting ${rec.nesting} is not the nestingPath length ${rec.nestingPath.length}`);
  }
  let previous = 0;
  for (const step of rec.nestingPath) {
    if (!nestingKinds.includes(step.kind)) {
      where(`nesting kind "${step.kind}" is not a ${language} control block`);
      continue;
    }
    if (step.line < previous) where(`nestingPath line ${step.line} comes before line ${previous}`);
    previous = step.line;
    if (!isOwnLine(entry, file.functions, step.line)) {
      where(`nesting step at line ${step.line} is not in the function's own code`);
      continue;
    }
    if (countKind(lines[step.line - 1] ?? "", step.kind) === 0) {
      where(`line ${step.line} does not hold "${step.kind}"`);
    }
    if (["if", "for", "while", "do"].includes(step.kind)) {
      if (!rec.decisions.some((dec) => dec.line === step.line && dec.kind === step.kind)) {
        where(`nesting step "${step.kind}" at line ${step.line} has no matching decision`);
      }
    }
  }

  // Coverage and CRAP: never on test files, together elsewhere, recomputed.
  if (rec.test) {
    if (rec.coverage !== undefined || rec.crap !== undefined || rec.mutation !== undefined) {
      where("test files carry no coverage, CRAP or mutation");
    }
    return;
  }
  if (rec.coverage === undefined && rec.crap === undefined) {
    if (options.requireCoverage) where("coverage and crap are required");
    return;
  }
  if (rec.coverage === undefined || rec.crap === undefined) {
    where("coverage and crap must come together");
    return;
  }
  const cov = rec.coverage;
  if (typeof cov !== "object" || cov === null) {
    where("coverage must be an object");
    return;
  }
  if (cov.source === "measured") {
    if (!Number.isInteger(cov.covered) || !Number.isInteger(cov.total) || cov.covered < 0 || cov.covered > cov.total) {
      where("measured coverage needs integers with 0 <= covered <= total");
      return;
    }
  } else if (cov.source !== "unknown" || typeof cov.reason !== "string" || cov.reason === "") {
    where("unknown coverage needs a reason");
    return;
  }
  if (typeof rec.crap !== "number" || Math.abs(rec.crap - crapRounded(rec.complexity, cov)) > CRAP_TOLERANCE) {
    where(`crap ${String(rec.crap)} does not recompute to ${crapRounded(rec.complexity, cov)}`);
  }
}
