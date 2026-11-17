// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The deterministic trigger for the report's state lifecycles (design §6.4):
 * pieces of state the pull request introduces, found in the added lines of
 * the pinned patches. Two shapes count.
 *
 * - An accumulator: a local variable declared in an added line (`x := …`,
 *   `var x …`, `let x …`) and changed by a later added line of the same file
 *   (`x++`, `x += …`, `x = …`, `append(x, …)`, `x[k] = …`).
 * - A field: an added Go struct field or TypeScript class property.
 *
 * Like the detectors, this aids recall and does not parse code: a candidate
 * that is not real state costs the reporter one lifecycle entry the checker
 * can reject, and the item that cites the file names it.
 */
import type { PatchLine } from "./patch.js";
import type { PullFile } from "./snapshot.js";

export interface StateCandidate {
  path: string;
  /** The identifier the item's lifecycle entry must name. */
  name: string;
  /** Head-side line of the declaration. */
  line: number;
  kind: "accumulator" | "field";
  /** Head-side line of the first mutation, for an accumulator. */
  mutatedAt?: number;
}

const MAX_CANDIDATES = 12;
/** Names that are never reported state: the blank identifier, the error and ok idioms, and one-letter loop variables. */
const IGNORED = new Set(["_", "err", "ok", "ctx"]);

const isTestPath = (p: string): boolean => /(?:_test\.go|\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$|(?:^|\/)(?:test|tests|__tests__)\//.test(p);
const language = (p: string): "go" | "ts" | undefined => (p.endsWith(".go") ? "go" : /\.[cm]?[jt]sx?$/.test(p) ? "ts" : undefined);

const GO_DECLS = [/^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/, /^\s*var\s+([A-Za-z_]\w*)\b/];
const TS_DECLS = [/^\s*(?:let|var)\s+([A-Za-z_$][\w$]*)\b/];
const GO_FIELD = /^\t+([A-Za-z_]\w*)\s+[*[\]\w.]+(?:\s+`[^`]*`)?\s*(?:\/\/.*)?$/;
const TS_FIELD = /^\s+(?:(?:private|protected|public|readonly|static)\s+)+([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=;]/;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` changes the variable `name` (not a declaration of it, not a comparison). */
function mutates(text: string, name: string): boolean {
  const n = escape(name);
  return new RegExp(`(?:^|[^\\w.$])${n}\\s*(?:\\+\\+|--|[-+*/%|&^]=|=(?!=))|(?:\\+\\+|--)${n}\\b|append\\(\\s*${n}\\b|(?:^|[^\\w.$])${n}\\s*\\[[^\\]]*\\]\\s*=(?!=)`).test(text) && !new RegExp(`(?:^|[^\\w.$])${n}\\s*:=`).test(text);
}

/** Whether the added line `index` lies in a Go struct body, by scanning back through the patch for its opening line. */
function inGoStruct(lines: readonly PatchLine[], index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const t = lines[i]!;
    if (t.kind === "del") continue;
    if (/^type\s+\w+\s+struct\s*\{/.test(t.text) || /\bstruct\s*\{\s*$/.test(t.text)) return true;
    if (/^\}/.test(t.text) || /^func\b/.test(t.text)) return false;
  }
  return false;
}

function inTsClass(lines: readonly PatchLine[], index: number): boolean {
  for (let i = index - 1; i >= 0; i -= 1) {
    const t = lines[i]!;
    if (t.kind === "del") continue;
    if (/^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/.test(t.text)) return true;
    if (/^\}/.test(t.text)) return false;
  }
  return false;
}

/** The state the pinned patches introduce, in file and line order, at most twelve. */
export function detectStateCandidates(files: readonly PullFile[]): StateCandidate[] {
  const out: StateCandidate[] = [];
  for (const file of files) {
    const lang = language(file.path);
    if (lang === undefined || isTestPath(file.path) || file.status === "removed") continue;
    const lines = file.parsed.lines;
    const seen = new Set<string>();
    lines.forEach((l, index) => {
      if (l.kind !== "add") return;
      const text = l.text;
      if (/^\s*(?:for|if|switch|select|while)\b/.test(text) || /^\s*\/\//.test(text)) return;
      const field = lang === "go" ? GO_FIELD.exec(text) : TS_FIELD.exec(text);
      if (field !== null && (lang === "go" ? inGoStruct(lines, index) : inTsClass(lines, index))) {
        const name = field[1]!;
        if (!seen.has(name)) {
          seen.add(name);
          out.push({ path: file.path, name, line: l.line, kind: "field" });
        }
        return;
      }
      for (const re of lang === "go" ? GO_DECLS : TS_DECLS) {
        const m = re.exec(text);
        if (m === null) continue;
        for (const name of m[1]!.split(",").map((s) => s.trim())) {
          if (name.length < 2 || IGNORED.has(name) || seen.has(name)) continue;
          const later = lines.slice(index + 1).find((x) => x.kind === "add" && mutates(x.text, name));
          if (later === undefined) continue;
          seen.add(name);
          out.push({ path: file.path, name, line: l.line, kind: "accumulator", mutatedAt: later.line });
        }
        break;
      }
    });
  }
  return out.slice(0, MAX_CANDIDATES);
}

/** Whether a lifecycle entry's `name` stands for the candidate: its identifier appears among the name's words. */
export function nameCovers(entryName: string, candidate: string): boolean {
  return entryName.split(/[^\w$]+/).includes(candidate);
}
