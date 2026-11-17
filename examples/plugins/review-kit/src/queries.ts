// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The whole-repository search (design §7.2 item 2): the queries per new
 * symbol, the read-only command that runs them with `git grep` over the whole
 * base commit, and the reading of what they print. Only the profile's
 * `excludeRoots` are left out; vendored directories are searched.
 */
import type { EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { maskCode, declarationEnd, type FileSymbol } from "./symbols.js";

/** Hits one query keeps in the report, by default. */
export const DEFAULT_MAX_CANDIDATES = 5;
const KEYWORDS: ReadonlySet<string> = new Set([
  "func", "function", "return", "const", "var", "let", "type", "struct", "interface", "class", "import", "package", "export", "default", "async", "await", "string", "int", "int64", "uint64", "bool", "byte", "error", "nil", "null", "undefined", "true", "false", "range", "make", "append", "len", "defer", "chan", "else", "this", "self", "number", "void", "break", "continue", "switch", "case", "while", "throw", "catch", "try", "new", "from", "typeof", "public", "private", "static", "readonly", "extends", "implements",
]);

/** The words of an identifier: `ParseTTL` is `Parse`, `TTL`; `parse_ttl` is `parse`, `ttl`. */
export function nameWords(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [name];
}

/** The camelCase and snake_case variants of a name, never the name itself. */
export function nameVariants(name: string): string[] {
  const words = nameWords(name);
  if (words.length === 0) return [];
  const lower = words.map((w) => w.toLowerCase());
  const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
  const variants = [
    `${lower[0]}${lower.slice(1).map(cap).join("")}`,
    lower.map(cap).join(""),
    lower.join("_"),
    words.join("_"),
    lower.join("-"),
  ];
  return [...new Set(variants)].filter((v) => v !== name && v.length >= 3);
}

/** A function's parameter and result types with the names left out, for the signature query. */
export function signatureTypes(sym: Pick<FileSymbol, "language" | "signature" | "kind">): { params: string[]; results: string[] } | undefined {
  if (sym.kind !== "func" && sym.kind !== "method" && sym.kind !== "function" && sym.kind !== "member") return undefined;
  const text = sym.signature;
  const open = firstParams(text, sym.language);
  if (open === undefined) return undefined;
  const params = typesOf(text.slice(open.start + 1, open.end), sym.language);
  const rest = text.slice(open.end + 1).replace(/^\s*:\s*/, "").trim();
  let results: string[] = [];
  if (rest.startsWith("(")) {
    const close = matching(rest, 0);
    results = typesOf(rest.slice(1, close ?? rest.length), sym.language);
  } else if (rest !== "") results = [rest.replace(/\s*=>.*$/, "")];
  return { params, results };
}

/** The parentheses of the parameter list: past the Go receiver, and past the name's type parameters. */
function firstParams(text: string, language: string): { start: number; end: number } | undefined {
  let from = 0;
  if (language === "go") {
    const recv = /^func\s*\(/.exec(text);
    if (recv !== null) {
      const close = matching(text, recv[0].length - 1);
      if (close === undefined) return undefined;
      from = close + 1;
    }
  }
  const generic = /^[^(]*?\[/.exec(text.slice(from));
  let start = text.indexOf("(", from);
  if (generic !== null) {
    const bracket = from + generic[0].length - 1;
    const closeBracket = matchingBracket(text, bracket);
    if (closeBracket !== undefined) start = text.indexOf("(", closeBracket);
  }
  if (start < 0) return undefined;
  const end = matching(text, start);
  return end === undefined ? undefined : { start, end };
}

function matching(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function matchingBracket(text: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "[") depth += 1;
    else if (text[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of list) {
    if ("([{<".includes(c)) depth += 1;
    else if (")]}>".includes(c)) depth -= 1;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** The types of a parameter or result list: Go's `a, b string` is two strings, TypeScript's `a?: T = 1` is T. */
function typesOf(list: string, language: string): string[] {
  const pieces = splitTop(list);
  if (language !== "go") {
    // A TypeScript parameter without an annotation has no type to match.
    return pieces.map((p) => (p.includes(":") ? p.slice(p.indexOf(":") + 1).replace(/\s*=.*$/, "").trim() : "")).filter((t) => t !== "");
  }
  const named = pieces.some((p) => /^[A-Za-z_]\w*\s+\S/.test(p));
  if (!named) return pieces;
  const out: string[] = [];
  let carried = "";
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const p = pieces[i]!;
    const m = /^[A-Za-z_]\w*\s+(\S.*)$/.exec(p);
    if (m !== null) carried = m[1]!;
    out.unshift(m !== null ? m[1]! : /^[A-Za-z_]\w*$/.test(p) && carried !== "" ? carried : p);
  }
  return out;
}

const ERE_SPECIAL = /[\\^$.|?*+()[\]{}]/g;
const ere = (s: string): string => s.replace(ERE_SPECIAL, (c) => `\\${c}`);

/** An extended regular expression for declarations with these parameter and result types, in order. */
export function signaturePattern(language: string, types: { params: string[]; results: string[] }): string | undefined {
  if (types.params.length + types.results.length === 0) return undefined;
  const params = types.params.map(ere).join(".*");
  const results = types.results.map(ere).join(".*");
  const head = language === "go" ? "^func " : "";
  return `${head}.*\\(.*${params}.*\\)${results === "" ? "" : `.*${results}`}`;
}

/**
 * The body's rarest identifiers and literals: among the tokens of the new
 * bodies, those that occur least often (then the longest, then the earliest),
 * at most `count`. Without a corpus beyond the pull request, rarity is the
 * pull request's own counts.
 */
export function rareTokens(body: string, population: ReadonlyMap<string, number>, count = 3): string[] {
  const masked = maskCode(body);
  const found: Array<{ token: string; at: number }> = [];
  const idents = masked.matchAll(/[A-Za-z_$][\w$]*/g);
  for (const m of idents) if (m[0].length >= 4 && !KEYWORDS.has(m[0].toLowerCase())) found.push({ token: m[0], at: m.index ?? 0 });
  // String literals, from the unmasked text: a literal is as telling as a name.
  for (const m of body.matchAll(/"([^"\\\n]{4,60})"|`([^`\n]{4,60})`/g)) found.push({ token: (m[1] ?? m[2])!, at: m.index ?? 0 });
  const seen = new Set<string>();
  const unique = found.filter((f) => (seen.has(f.token) ? false : (seen.add(f.token), true)));
  unique.sort((a, b) => (population.get(a.token) ?? 1) - (population.get(b.token) ?? 1) || b.token.length - a.token.length || a.at - b.at);
  return unique.slice(0, count).map((f) => f.token);
}

/** How often each identifier and literal occurs across the pull request's new bodies. */
export function tokenPopulation(bodies: readonly string[]): Map<string, number> {
  const pop = new Map<string, number>();
  for (const body of bodies) {
    for (const m of maskCode(body).matchAll(/[A-Za-z_$][\w$]*/g)) pop.set(m[0], (pop.get(m[0]) ?? 0) + 1);
    for (const m of body.matchAll(/"([^"\\\n]{4,60})"|`([^`\n]{4,60})`/g)) pop.set((m[1] ?? m[2])!, (pop.get((m[1] ?? m[2])!) ?? 0) + 1);
  }
  return pop;
}

export interface QueryPlan {
  name: string;
  variants: string[];
  signature: string | undefined;
  tokens: string[];
  /** For a modified symbol: the base tests that already name it, kept as context only. */
  tests: boolean;
}

export function planFor(sym: FileSymbol & { change: "new" | "modified" }, population: ReadonlyMap<string, number>): QueryPlan {
  if (sym.change === "modified") return { name: sym.name, variants: [], signature: undefined, tokens: [], tests: true };
  const types = signatureTypes(sym);
  return {
    name: sym.name,
    variants: nameVariants(sym.name).slice(0, 4),
    signature: types !== undefined ? signaturePattern(sym.language, types) : undefined,
    tokens: rareTokens(sym.body, population),
    tests: false,
  };
}

/** Pathspec elements that leave out the profile's `excludeRoots`; each is a glob or a path prefix. */
export function excludeSpecs(excludeRoots: readonly string[]): string[] {
  return [".", ...excludeRoots.map((r) => (/[*?[]/.test(r) ? `:(exclude,glob)${r}` : `:(exclude)${r}`))];
}

const NL = "\n";

const SEARCH =
  'set -u; base="$1"; cap="$2"; ' +
  'q() { kind="$1"; flags="$2"; pats="$3"; specs="$4"; [ -n "$pats" ] || return 0; set -f; set --; for f in $flags; do set -- "$@" "$f"; done; ' +
  `IFS='${NL}'; for p in $pats; do set -- "$@" -e "$p"; done; set -- "$@" "$base" --; for s in $specs; do set -- "$@" "$s"; done; unset IFS; set +f; ` +
  'out=$(git -c core.hooksPath=/dev/null grep -n -I --no-color "$@" 2>/dev/null); rc=$?; if [ "$rc" -gt 1 ]; then echo "git grep failed for $kind (exit $rc)" >&2; exit "$rc"; fi; ' +
  'n=$(printf \'%s\' "$out" | grep -c . || true); echo "== $kind hits=$n"; if [ -n "$out" ]; then printf \'%s\\n\' "$out" | sed \'s/^[0-9a-f]\\{40\\}://\' | head -n "$cap" | cut -c1-300; fi; }; ' +
  '{ q name "-w -F" "$4" "$3"; q variants "-w -F" "$5" "$3"; q signature "-E" "$6" "$3"; q tokens "-F --all-match" "$7" "$3"; q tests "-w -F" "$8" "$9"; } > "$GRAPHLOOM_REPORT_FILE"';

/** One symbol's queries as one read-only command over the whole base commit (design §7.2). */
export function searchCommand(symbolId: string, plan: QueryPlan, base: string, maxCandidates: number, excludeRoots: readonly string[], testSpecs: readonly string[]): EnvironmentCommand {
  return {
    id: `${COMMAND.search}-${symbolId}`,
    argv: [
      "sh",
      "-c",
      SEARCH,
      `${COMMAND.search}-${symbolId}`,
      base,
      String(maxCandidates),
      excludeSpecs(excludeRoots).join(NL),
      plan.name,
      plan.variants.join(NL),
      plan.signature ?? "",
      plan.tokens.join(NL),
      plan.tests ? plan.name : "",
      plan.tests ? testSpecs.map((g) => `:(glob)${g}`).join(NL) : "",
    ],
  };
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchSection {
  kind: "name" | "variants" | "signature" | "tokens" | "tests";
  hits: number;
  lines: SearchHit[];
}

/** What a search command printed, by query. */
export function parseSearch(text: string): SearchSection[] {
  const out: SearchSection[] = [];
  for (const raw of text.split("\n")) {
    const head = /^== (name|variants|signature|tokens|tests) hits=(\d+)$/.exec(raw);
    if (head !== null) {
      out.push({ kind: head[1] as SearchSection["kind"], hits: Number(head[2]), lines: [] });
      continue;
    }
    const m = /^(.+?):(\d+):(.*)$/.exec(raw);
    if (m !== null && out.length > 0) out.at(-1)!.lines.push({ path: m[1]!, line: Number(m[2]), text: m[3]! });
  }
  return out;
}

/** Lines a candidate fetch reads from the definition on. */
export const CANDIDATE_LINES = 120;

/** `git show <base>:<path>` from the definition's line on, which plugin code cuts into a body. */
export function candidateCommand(index: number, base: string, path: string, line: number): EnvironmentCommand {
  const id = `${COMMAND.candidate}-${index}`;
  return {
    id,
    argv: ["sh", "-c", 'set -eu; git -c core.hooksPath=/dev/null show "$1:$2" | sed -n "$3,$(($3 + $4 - 1))p" > "$GRAPHLOOM_REPORT_FILE"', id, base, path, String(line), String(CANDIDATE_LINES)],
  };
}

/** The declaration a candidate fetch starts with, cut by brace matching; undefined when its end is not in the lines read. */
export function bodyFromSnippet(snippet: string): string | undefined {
  const lines = snippet.split("\n");
  const masked = maskCode(snippet).split("\n");
  const end = declarationEnd(masked, 1);
  return end === undefined ? undefined : lines.slice(0, end).join("\n");
}
