// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Test mapping (design §7.2 item 4). For a new or modified symbol it finds,
 * in the pull request's own test files:
 *
 * - test files the PR adds or changes in the symbol's directory (or a
 *   directory below it, or, for TypeScript, a test named for the file);
 * - added test lines that reference the symbol, or its exported caller in
 *   the diff;
 * - table-driven case names, string literals on added test lines that
 *   contain every word of the symbol's name.
 *
 * A symbol with none of these has no covering test the plugin can show, and
 * `missing-test` is asked. Base tests that already name a modified symbol
 * are context only; the answerer finds integration tests by search.
 */
import { nameWords } from "./queries.js";
import { isTestFile, maskCode, packOf, type SymbolDef } from "./symbols.js";
import type { FullPack } from "./packs.js";
import { isDeleted, type PullFile } from "./snapshot.js";

export interface TestEvidence {
  kind: "test-file" | "reference" | "caller-reference" | "case-name";
  path: string;
  /** The head line, for a line match. */
  line?: number;
  text: string;
}

const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const stemOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1).replace(/(\.(test|spec))?\.[cm]?[jt]sx?$/, "").replace(/_test\.go$|\.go$/, "");

function inDirectory(test: string, sym: Pick<SymbolDef, "path" | "dir" | "language">): boolean {
  const d = dirOf(test);
  if (d === sym.dir || d.startsWith(`${sym.dir}/`)) return true;
  return sym.language === "typescript" && stemOf(test) === stemOf(sym.path);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The words of `name`, lower case, for matching a case name: all must appear. */
function caseWords(name: string): string[] {
  return nameWords(name).map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
}

/** Masked text with its identifier tokens, so a name is looked up in a set instead of scanned for. */
interface Masked {
  text: string;
  tokens: Set<string>;
}

/** A name made only of the characters the word boundaries below are cut at: it is a whole word exactly when it is a token. */
const IDENT = /^[\w$]+$/;
const masking = (source: string): Masked => {
  const text = maskCode(source);
  return { text, tokens: new Set(text.match(/[\w$]+/g) ?? []) };
};

interface TestLine {
  line: number;
  text: string;
  masked: Masked;
  /** The quoted literals of the line as written, and in lower case with runs of other characters as one space. */
  literals: { raw: string; norm: string }[];
}

interface TestFile {
  path: string;
  lines: TestLine[];
  /** Token to the ascending indexes of the lines that hold it. */
  byToken: Map<string, number[]>;
  /** The indexes of the lines that hold a quoted literal. */
  withLiterals: number[];
}

/**
 * What every `mapTests` call of one groundwork shares: the pull request's test
 * files with each added line masked, tokenised and its literals cut once, and
 * each diff symbol's masked body. Without it each symbol masks and scans every
 * body and every added test line again, quadratic in the symbols of a large
 * pull request. Built for one snapshot, symbol set and pack list; never kept
 * past the groundwork.
 */
export interface TestMapContext {
  symbols: readonly SymbolDef[];
  packs: readonly FullPack[];
  tests: TestFile[];
  maskedBody: Map<string, Masked>;
  inTestFile: Map<string, boolean>;
  wordRx: Map<string, RegExp>;
  ident: Map<string, boolean>;
  /** Token to the exported non-test symbols whose masked bodies hold it, in symbol order; built on first use. */
  bodyTokens?: Map<string, SymbolDef[]>;
}

export function testMapContext(symbols: readonly SymbolDef[], files: readonly PullFile[], packs: readonly FullPack[]): TestMapContext {
  const tests = files
    .filter((f) => !isDeleted(f) && isTestFile(packOf(packs, f.path), f.path))
    .map((f): TestFile => {
      const lines = f.parsed.lines
        .filter((l) => l.kind === "add")
        .map((l): TestLine => ({
          line: l.line,
          text: l.text,
          masked: masking(l.text),
          literals: [...l.text.matchAll(/"([^"\n]{2,80})"|`([^`\n]{2,80})`|'([^'\n]{2,80})'/g)].map((lit) => {
            const raw = (lit[1] ?? lit[2] ?? lit[3])!;
            return { raw, norm: raw.toLowerCase().replace(/[^a-z0-9]+/g, " ") };
          }),
        }));
      const byToken = new Map<string, number[]>();
      const withLiterals: number[] = [];
      lines.forEach((l, i) => {
        for (const t of l.masked.tokens) {
          const at = byToken.get(t);
          if (at === undefined) byToken.set(t, [i]);
          else at.push(i);
        }
        if (l.literals.length > 0) withLiterals.push(i);
      });
      return { path: f.path, lines, byToken, withLiterals };
    });
  return { symbols, packs, tests, maskedBody: new Map(), inTestFile: new Map(), wordRx: new Map(), ident: new Map() };
}

/**
 * What maps `sym` to a test in the pull request's own test files; empty when nothing does.
 * `ctx` is the shared work of one groundwork (`testMapContext`); a call without one builds its own.
 */
export function mapTests(sym: SymbolDef, symbols: readonly SymbolDef[], files: readonly PullFile[], packs: readonly FullPack[], ctx?: TestMapContext): TestEvidence[] {
  const out: TestEvidence[] = [];
  const c = ctx ?? testMapContext(symbols, files, packs);
  const wordRx = (name: string): RegExp => {
    let rx = c.wordRx.get(name);
    if (rx === undefined) c.wordRx.set(name, (rx = new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`)));
    return rx;
  };
  const isIdent = (name: string): boolean => {
    let v = c.ident.get(name);
    if (v === undefined) c.ident.set(name, (v = IDENT.test(name)));
    return v;
  };
  const testFile = (s: SymbolDef): boolean => {
    let v = c.inTestFile.get(s.id);
    if (v === undefined) c.inTestFile.set(s.id, (v = isTestFile(packOf(c.packs, s.path), s.path)));
    return v;
  };
  const masked = (s: SymbolDef): Masked => {
    let v = c.maskedBody.get(s.id);
    if (v === undefined) c.maskedBody.set(s.id, (v = masking(s.body)));
    return v;
  };
  // `name` as a whole word of masked text.
  const mentions = (m: Masked, name: string): boolean => (isIdent(name) ? m.tokens.has(name) : m.text.includes(name) && wordRx(name).test(m.text));
  /** The indexes of the lines of `f` that mention `name`, from the token index when the name is a plain word. */
  const linesMentioning = (f: TestFile, name: string): number[] => {
    if (isIdent(name)) return f.byToken.get(name) ?? [];
    const at: number[] = [];
    f.lines.forEach((l, i) => {
      if (mentions(l.masked, name)) at.push(i);
    });
    return at;
  };
  // Exported symbols of the diff whose bodies call this one: a test of the caller exercises it.
  const callable = (s: SymbolDef): boolean => s.id !== sym.id && s.exported && s.language === sym.language && !testFile(s);
  let callerSymbols: SymbolDef[];
  if (isIdent(sym.name)) {
    if (c.bodyTokens === undefined) {
      const index = new Map<string, SymbolDef[]>();
      for (const s of c.symbols) {
        if (!s.exported || testFile(s)) continue;
        for (const t of masked(s).tokens) {
          const at = index.get(t);
          if (at === undefined) index.set(t, [s]);
          else at.push(s);
        }
      }
      c.bodyTokens = index;
    }
    callerSymbols = (c.bodyTokens.get(sym.name) ?? []).filter(callable);
  } else {
    callerSymbols = c.symbols.filter((s) => callable(s) && mentions(masked(s), sym.name));
  }
  const callers = callerSymbols.map((s) => s.name);
  const words = caseWords(sym.name);
  for (const f of c.tests) {
    if (inDirectory(f.path, sym)) out.push({ kind: "test-file", path: f.path, text: `${f.path} is added or changed in ${sym.dir === "." ? "the repository root" : sym.dir}` });
    const referenced = new Set(linesMentioning(f, sym.name));
    const called = new Set<number>();
    for (const n of new Set(callers)) for (const i of linesMentioning(f, n)) called.add(i);
    // Only a line that mentions the symbol or a caller, or holds a literal when there are words to match, can add evidence.
    const candidates = new Set<number>([...referenced, ...called]);
    if (words.length > 0) for (const i of f.withLiterals) candidates.add(i);
    for (const i of [...candidates].sort((x, y) => x - y)) {
      const l = f.lines[i]!;
      if (referenced.has(i)) out.push({ kind: "reference", path: f.path, line: l.line, text: l.text.trim().slice(0, 160) });
      else if (called.has(i)) out.push({ kind: "caller-reference", path: f.path, line: l.line, text: l.text.trim().slice(0, 160) });
      if (words.length > 0) {
        for (const lit of l.literals) {
          if (words.every((w) => lit.norm.includes(w))) out.push({ kind: "case-name", path: f.path, line: l.line, text: lit.raw });
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.kind}|${e.path}|${e.line ?? 0}|${e.text}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
