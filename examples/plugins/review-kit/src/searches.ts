// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The searches an answer or the answer checker reports (design §7.3). An
 * agent's own hit count is a claim, not a fact, so a search is a structured,
 * re-runnable shape: a pattern (an extended regular expression, as
 * `git grep -E` reads it), the tree it ran over (the pinned base commit, the
 * head's working tree, or a dependency's source), the path globs that scope it
 * and whether case was ignored. The plugin validates the shape without
 * running it, re-runs every `base` or `head` search in a read-only command job
 * and records the count it measured.
 */
import type { EnvironmentCommand } from "@graphloom/sdk";

export const SEARCH_TREES = ["base", "head", "dependency"] as const;
export type SearchTree = (typeof SEARCH_TREES)[number];

export const MAX_PATTERN_CHARS = 300;
export const MAX_SEARCH_PATHS = 8;
export const MAX_SEARCH_PATH_CHARS = 200;
/** Searches re-run per verification: the distinct ones of one answer set, or of one checker result. */
export const MAX_RERUN_SEARCHES = 200;
/** Quantifier operands (`{m,n}`) glibc accepts; a larger one is refused rather than left to the tool. */
const MAX_REPEAT = 1000;

export const SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pattern", "tree", "paths", "ignoreCase", "hits"],
  properties: {
    pattern: { type: "string" },
    tree: { type: "string", enum: SEARCH_TREES },
    paths: { type: "array", items: { type: "string" } },
    ignoreCase: { type: "boolean" },
    hits: { type: "integer" },
  },
} as const;

/** One search as an agent reports it. `hits` is the agent's own count of matching lines. */
export interface Search {
  pattern: string;
  tree: SearchTree;
  /** Pathspec globs relative to the tree's root (`*` also matches across `/`); empty is the whole tree. A dependency search names absolute directories of the inventory. */
  paths: string[];
  ignoreCase: boolean;
  hits: number;
}

/** A search with what the plugin measured when it re-ran it, or why it did not. */
export interface MeasuredSearch extends Search {
  /** Matching lines counted by the plugin's own `git grep -E -c`. */
  measured?: number;
  /** Files with a match. */
  files?: number;
  /** Why there is no measured count, or what went wrong. */
  note?: string;
}

/** What identifies a search for the purpose of running it once. */
export const searchKey = (s: Search): string => JSON.stringify([s.tree, s.ignoreCase, s.pattern, s.paths]);

/** Why `pattern` is not an extended regular expression `git grep -E` accepts, or undefined. A static check: the re-run is the final word. */
export function ereProblem(pattern: string): string | undefined {
  if (pattern === "") return "the pattern is empty";
  if (pattern.length > MAX_PATTERN_CHARS) return `the pattern is longer than ${MAX_PATTERN_CHARS} characters`;
  if (/[\u0000\r\n]/.test(pattern)) return "the pattern holds a newline or NUL (one line)";
  let depth = 0;
  // Whether a repetition operator here has nothing to repeat: at the start, after `(`, `|` or `^`.
  let open = true;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      if (i + 1 >= pattern.length) return "the pattern ends in a lone backslash";
      i += 1;
      open = false;
    } else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j += 1;
      if (pattern[j] === "]") j += 1;
      for (; j < pattern.length; j++) {
        const d = pattern[j]!;
        if (d === "[" && (pattern[j + 1] === ":" || pattern[j + 1] === "." || pattern[j + 1] === "=")) {
          const close = pattern.indexOf(`${pattern[j + 1]}]`, j + 2);
          if (close < 0) return "an unterminated [:class:] inside a bracket expression";
          j = close + 1;
        } else if (d === "]") break;
      }
      if (j >= pattern.length) return "an unterminated bracket expression [";
      i = j;
      open = false;
    } else if (c === "(") {
      depth += 1;
      open = true;
    } else if (c === ")") {
      if (depth === 0) return "an unmatched )";
      depth -= 1;
      open = false;
    } else if (c === "|" || c === "^") open = true;
    else if (c === "*" || c === "+" || c === "?") {
      if (open) return `the repetition operator ${c} has nothing to repeat (escape a literal one as \\${c})`;
    } else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m === null) return "a malformed {m,n} interval (escape a literal brace as \\{)";
      if (open) return "an interval with nothing to repeat";
      const lo = Number(m[1]);
      const hi = m[2] === undefined ? lo : m[3] === "" ? Infinity : Number(m[3]);
      if (lo > MAX_REPEAT || (hi !== Infinity && hi > MAX_REPEAT) || hi < lo) return `an interval out of range (at most ${MAX_REPEAT}, and m not above n)`;
      i += m[0].length - 1;
    } else open = false;
  }
  if (depth > 0) return "an unmatched (";
  return undefined;
}

/** Why a path glob is refused: it could leave the tree, or git would read it as something other than a path. */
export function pathProblem(p: string, tree: SearchTree, dirs: readonly string[]): string | undefined {
  if (p === "") return "is empty";
  if (p.length > MAX_SEARCH_PATH_CHARS) return `is longer than ${MAX_SEARCH_PATH_CHARS} characters`;
  if (/[\u0000\r\n|]/.test(p)) return "holds a newline, NUL or |";
  if (p.split("/").includes("..")) return "has a .. segment, which would leave the tree";
  if (tree === "dependency") return p.startsWith("/") && dirs.some((d) => p === d || p.startsWith(`${d}/`)) ? undefined : `must, in a dependency search, be an absolute directory inside one of the inventory's source directories${dirs.length === 0 ? " (none is available here)" : ""}`;
  if (p.startsWith("/")) return "is absolute; a path is relative to the tree's root";
  // One pathspec magic is accepted: exclusion (":!glob", ":^glob" or ":(exclude)glob"), whose glob is checked like any path.
  const excluded = /^:(?:!|\^|\(exclude\))(.*)$/.exec(p);
  if (excluded !== null) {
    const why = excluded[1] === "" ? "is empty" : pathProblem(excluded[1]!, tree, dirs);
    return why === undefined ? undefined : `excludes a path that ${why}`;
  }
  if (p.startsWith(":")) return "begins with :, which git reads as pathspec magic (only an exclusion, \":!<glob>\", is accepted)";
  return undefined;
}

/** Every deterministic problem with a reported search, named at `at`; empty when it can be run as it is. */
export function searchProblems(s: Search, at: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const e = ereProblem(s.pattern);
  if (e !== undefined) out.push(`${at}: the search ${JSON.stringify(s.pattern.slice(0, 80))} is not a valid extended regular expression (git grep -E): ${e}`);
  if (s.paths.length > MAX_SEARCH_PATHS) out.push(`${at}: the search ${JSON.stringify(s.pattern.slice(0, 40))} names ${s.paths.length} paths, more than ${MAX_SEARCH_PATHS}`);
  for (const p of s.paths.slice(0, MAX_SEARCH_PATHS)) {
    const why = pathProblem(p, s.tree, dirs);
    if (why !== undefined) out.push(`${at}: the search ${JSON.stringify(s.pattern.slice(0, 40))} has the path ${JSON.stringify(p.slice(0, 80))}, which ${why}`);
  }
  if (s.hits < 0) out.push(`${at}: the search ${JSON.stringify(s.pattern.slice(0, 40))} reports ${s.hits} hits`);
  return out;
}

/** The search as one line of the Q&A: its tree, paths and case flag. */
export const searchWhere = (s: Search): string => `${s.tree}${s.paths.length > 0 ? ` ${s.paths.join(", ")}` : ""}${s.ignoreCase ? ", -i" : ""}`;

/**
 * Counts matching lines the way `git grep -E -c` does, over the base commit or the head's working tree (tracked
 * and untracked files), and prints `count <lines> <files>`; a pattern or path git refuses prints `error <message>`.
 * It never executes repository code.
 */
const SEARCH_SCRIPT = String.raw`set -u; base="$1"; tree="$2"; icase="$3"; pat="$4"; shift 4
flags="-I -c --no-color -E"; [ "$icase" = 1 ] && flags="$flags -i"
if [ "$tree" = base ]; then
  out=$(git -c core.hooksPath=/dev/null grep $flags -e "$pat" "$base" -- "$@" 2>&1); rc=$?
else
  out=$(git -c core.hooksPath=/dev/null grep $flags --untracked -e "$pat" -- "$@" 2>&1); rc=$?
fi
{ if [ "$rc" -gt 1 ]; then printf 'error %s\n' "$(printf '%s' "$out" | head -c 300 | tr '\n' ' ')"
else printf '%s\n' "$out" | awk -F: 'NF >= 2 && $NF ~ /^[0-9]+$/ { n += $NF; f++ } END { print "count", n + 0, f + 0 }'; fi
echo "checked 1"; } > "$GRAPHLOOM_REPORT_FILE"`;

/** The command that re-runs one `base` or `head` search. */
export function searchCommand(id: string, base: string, s: Search): EnvironmentCommand {
  return { id, argv: ["sh", "-c", SEARCH_SCRIPT, id, base, s.tree, s.ignoreCase ? "1" : "0", s.pattern, ...s.paths] };
}

export type SearchRead = { measured: number; files: number } | { error: string };

/** What a search command's report says: the measured count, or the error git gave. */
export function readSearchReport(text: string): SearchRead | undefined {
  for (const l of text.split("\n")) {
    const c = /^count (\d+) (\d+)$/.exec(l);
    if (c !== null) return { measured: Number(c[1]), files: Number(c[2]) };
    if (l.startsWith("error ")) return { error: l.slice(6).trim() || "git grep failed" };
  }
  return undefined;
}
