// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The language packs (design §7.2): file globs, definition patterns, test-file
 * and test-name patterns, as data. The plugin ships packs for Go and
 * TypeScript; a profile's pack of the same language overrides the fields it
 * names, and a pack of another language is added whole.
 *
 * `definitions` are top-level declaration patterns and `members` are class
 * member patterns, both JavaScript regular expressions run over one line with
 * strings and comments blanked. Named groups: `name` (required), `kw` (the
 * declaration keyword), `exp` (present when exported), `recv` (a Go receiver)
 * and `tp` (present when the declaration has type parameters). `grep` is the
 * POSIX extended expression that selects a file's declaration lines from the
 * base commit, so `git grep` can show what the base file defined.
 */
import type { SymbolPack } from "./profile.js";

const IDENT = String.raw`[A-Za-z_$][\w$]*`;

export type FullPack = Required<SymbolPack>;

export const GO_PACK: FullPack = {
  language: "go",
  globs: ["**/*.go"],
  definitions: [
    String.raw`^(?<kw>func)\s+(?:\((?<recv>[^)]*)\)\s*)?(?<name>[A-Za-z_]\w*)\s*(?<tp>\[)?`,
    String.raw`^(?<kw>type)\s+(?<name>[A-Za-z_]\w*)\b`,
    String.raw`^(?<kw>const|var)\s+(?<name>[A-Za-z_]\w*)\b`,
  ],
  members: [],
  grep: String.raw`^(package|func|type|const|var)[[:space:]]|^[[:space:]]+[A-Z][A-Za-z0-9_]*([[:space:]]|=|$)`,
  testFiles: ["**/*_test.go"],
  testNames: [String.raw`^func\s+(?<name>(?:Test|Benchmark|Fuzz|Example)\w*)\s*\(`],
};

const TS_MODIFIERS = String.raw`(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*`;

export const TS_PACK: FullPack = {
  language: "typescript",
  globs: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
  definitions: [
    String.raw`^(?<exp>export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?<kw>function)\s*\*?\s*(?<name>${IDENT})`,
    String.raw`^(?<exp>export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?<kw>class)\s+(?<name>${IDENT})`,
    String.raw`^(?<exp>export\s+)(?:declare\s+)?(?:const\s+)?(?<kw>interface|type|enum|const|let|var)\s+(?<name>${IDENT})`,
  ],
  members: [String.raw`^\s+${TS_MODIFIERS}(?<name>${IDENT})\s*(?:<[^>]*>)?\s*\(`],
  grep: String.raw`^[[:space:]]*(export|public|private|protected|static|async|abstract|override|readonly|class|function|constructor)[[:space:]]|^[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*(<[^>]*>)?\(`,
  testFiles: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test/**", "**/tests/**"],
  testNames: [String.raw`\b(?:it|test|describe)(?:\.\w+)?\(\s*(?<name>['"\x60][^'"\x60]+['"\x60])`],
};

export const DEFAULT_PACKS: readonly FullPack[] = [GO_PACK, TS_PACK];

/** Names a TypeScript class member pattern may match that are control statements, never members. */
export const NOT_MEMBERS: ReadonlySet<string> = new Set(["if", "for", "while", "switch", "catch", "return", "function", "with", "else", "do", "try", "await", "new", "super", "typeof", "throw"]);

/** The packs a profile's own packs resolve to: the defaults, with a pack of the same language overriding the fields it names. */
export function effectivePacks(profile: { symbols: readonly SymbolPack[] }): FullPack[] {
  const out: FullPack[] = DEFAULT_PACKS.map((p) => structuredClone(p));
  for (const own of profile.symbols) {
    const at = out.findIndex((p) => p.language === own.language);
    if (at < 0) {
      out.push({ language: own.language, globs: own.globs, definitions: own.definitions ?? [], members: own.members ?? [], grep: own.grep ?? "", testFiles: own.testFiles ?? [], testNames: own.testNames ?? [] });
      continue;
    }
    const base = out[at]!;
    out[at] = {
      language: base.language,
      globs: own.globs,
      definitions: own.definitions ?? base.definitions,
      members: own.members ?? base.members,
      grep: own.grep ?? base.grep,
      testFiles: own.testFiles ?? base.testFiles,
      testNames: own.testNames ?? base.testNames,
    };
  }
  return out;
}
