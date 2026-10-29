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

/** What maps `sym` to a test in the pull request's own test files; empty when nothing does. */
export function mapTests(sym: SymbolDef, symbols: readonly SymbolDef[], files: readonly PullFile[], packs: readonly FullPack[]): TestEvidence[] {
  const out: TestEvidence[] = [];
  const tests = files.filter((f) => !isDeleted(f) && isTestFile(packOf(packs, f.path), f.path));
  const named = new RegExp(`(?<![\\w$])${escapeRe(sym.name)}(?![\\w$])`);
  // Exported symbols of the diff whose bodies call this one: a test of the caller exercises it.
  const callers = symbols.filter((s) => s.id !== sym.id && s.exported && s.language === sym.language && !isTestFile(packOf(packs, s.path), s.path) && named.test(maskCode(s.body)));
  const words = caseWords(sym.name);
  for (const f of tests) {
    if (inDirectory(f.path, sym)) out.push({ kind: "test-file", path: f.path, text: `${f.path} is added or changed in ${sym.dir === "." ? "the repository root" : sym.dir}` });
    for (const l of f.parsed.lines) {
      if (l.kind !== "add") continue;
      const masked = maskCode(l.text);
      if (named.test(masked)) out.push({ kind: "reference", path: f.path, line: l.line, text: l.text.trim().slice(0, 160) });
      else if (callers.some((c) => new RegExp(`(?<![\\w$])${escapeRe(c.name)}(?![\\w$])`).test(masked))) out.push({ kind: "caller-reference", path: f.path, line: l.line, text: l.text.trim().slice(0, 160) });
      if (words.length > 0) {
        for (const lit of l.text.matchAll(/"([^"\n]{2,80})"|`([^`\n]{2,80})`|'([^'\n]{2,80})'/g)) {
          const text = (lit[1] ?? lit[2] ?? lit[3])!.toLowerCase().replace(/[^a-z0-9]+/g, " ");
          if (words.every((w) => text.includes(w))) out.push({ kind: "case-name", path: f.path, line: l.line, text: (lit[1] ?? lit[2] ?? lit[3])! });
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
