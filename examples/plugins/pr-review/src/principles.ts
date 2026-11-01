// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A project's design principles (design §7.5.1): the repository keeps them as an agent skill
 * (`skills/<name>/SKILL.md`), and N1's "does the fix fit the system's design?" part judges the change
 * against each one that applies. The file is read from the profile's `ref` (default: the pinned base
 * commit), never from the pull request's head, so a pull request cannot change the rules it is judged by.
 * What is recorded is the bytes; the parse recomputes from them.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { COMMAND } from "./constants.js";
import { commandRuns, reportText, succeeded } from "./evidence.js";
import { matchesGeneratedGlob } from "./metrics/generated.js";

export const MAX_PRINCIPLES = 50;
export const MAX_STATEMENT_CHARS = 1_000;
export const MAX_GLOBS = 20;
export const PRINCIPLE_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The profile's `questions.principles`. */
export interface PrinciplesConfig {
  path: string;
  ref?: string;
}

export interface Principle {
  id: string;
  statement: string;
  why?: string;
  /** Globs of the changed files the principle applies to; empty applies to every change. */
  appliesTo: string[];
  source?: string;
}

export interface ParsedPrinciples {
  principles: Principle[];
  /** What the parse cut or ignored, each in a sentence. */
  notes: string[];
}

/** The text without its YAML frontmatter (a leading `---` block). */
function body(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return lines;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return end < 0 ? lines : lines.slice(end + 1);
}

const field = (line: string, label: string): string | undefined => {
  const m = new RegExp(`^[-*]\\s+${label}:\\s*(.*)$`).exec(line);
  return m === null ? undefined : m[1]!.trim();
};

/**
 * Parses a principles file: `## <id>` sections, each a statement (the text before the first bullet or the next
 * heading) and the optional bullets `- Why:`, `- Applies to:` (comma-separated globs) and `- Source:`.
 * Headings whose text is not an id, items past the bounds, and items without a statement are cut, each noted.
 */
export function parsePrinciples(text: string): ParsedPrinciples {
  const principles: Principle[] = [];
  const notes: string[] = [];
  type Section = { id: string | undefined; heading: string; statement: string[]; bullets: string[]; inBullets: boolean };
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of body(text)) {
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading !== null) {
      current = undefined;
      if (heading[1] === "##") {
        const id = heading[2]!;
        current = { id: PRINCIPLE_ID.test(id) ? id : undefined, heading: id, statement: [], bullets: [], inBullets: false };
        sections.push(current);
      }
      continue;
    }
    if (current === undefined) continue;
    if (/^[-*]\s/.test(line)) {
      current.inBullets = true;
      current.bullets.push(line);
    } else if (!current.inBullets) current.statement.push(line);
  }
  const seen = new Set<string>();
  for (const s of sections) {
    if (s.id === undefined) {
      notes.push(`the heading "${s.heading.slice(0, 60)}" is not a principle id (lowercase letters, digits and hyphens); it was ignored`);
      continue;
    }
    if (seen.has(s.id)) {
      notes.push(`the principle ${s.id} appears more than once; the first was kept`);
      continue;
    }
    seen.add(s.id);
    let statement = s.statement.join("\n").trim();
    if (statement === "") {
      notes.push(`the principle ${s.id} has no statement; it was ignored`);
      continue;
    }
    if (principles.length >= MAX_PRINCIPLES) {
      notes.push(`more than ${MAX_PRINCIPLES} principles; ${s.id} and the ones after it were cut`);
      break;
    }
    if (statement.length > MAX_STATEMENT_CHARS) {
      notes.push(`the statement of ${s.id} is ${statement.length} characters; it was cut to ${MAX_STATEMENT_CHARS}`);
      statement = statement.slice(0, MAX_STATEMENT_CHARS);
    }
    const p: Principle = { id: s.id, statement, appliesTo: [] };
    for (const b of s.bullets) {
      const why = field(b, "Why");
      const applyTo = field(b, "Applies to");
      const source = field(b, "Source");
      if (why !== undefined && why !== "" && p.why === undefined) p.why = why;
      if (source !== undefined && source !== "" && p.source === undefined) p.source = source;
      if (applyTo !== undefined && p.appliesTo.length === 0) {
        const globs = applyTo.split(",").map((g) => g.trim()).filter((g) => g !== "");
        if (globs.length > MAX_GLOBS) notes.push(`${s.id} lists ${globs.length} globs; the first ${MAX_GLOBS} were kept`);
        p.appliesTo = globs.slice(0, MAX_GLOBS);
      }
    }
    principles.push(p);
  }
  return { principles, notes };
}

/** Whether a principle applies to a change: it names no globs, or any changed file (a renamed one under both names) matches one. */
export function applies(p: Pick<Principle, "appliesTo">, changed: ReadonlyArray<{ path: string; previousPath?: string | null }>): boolean {
  return p.appliesTo.length === 0 || changed.some((f) => matchesGeneratedGlob(p.appliesTo, f.path) || (f.previousPath != null && matchesGeneratedGlob(p.appliesTo, f.previousPath)));
}

const READ_SCRIPT =
  'set -eu; ref="$1"; path="$2"; ' +
  'if ! sha=$(git -c core.hooksPath=/dev/null rev-parse --verify --quiet "$ref^{commit}"); then echo "the ref $ref names no commit in this clone" >&2; exit 4; fi; ' +
  '{ echo "commit $sha"; if [ "$(git -c core.hooksPath=/dev/null cat-file -t "$sha:$path" 2>/dev/null)" = blob ]; then echo present; git -c core.hooksPath=/dev/null cat-file blob "$sha:$path"; else echo absent; fi; } > "$GRAPHLOOM_REPORT_FILE"';

/** The read-only command that reads the principles file from `ref` (a commit or ref name, resolved once to its SHA). */
export const principlesReadCommand = (cfg: PrinciplesConfig, base: string): EnvironmentCommand => ({
  id: COMMAND.principles,
  argv: ["sh", "-c", READ_SCRIPT, COMMAND.principles, cfg.ref ?? base, cfg.path],
});

/** What a `principles-read` recorded. */
export interface PrinciplesRead {
  path: string;
  /** The profile's ref, when it names one; the base commit otherwise. */
  ref?: string;
  commit: string;
  file: "present" | "absent";
  text: string;
  truncated: boolean;
}

export type PrinciplesReading = { state: "missing" } | { state: "failed"; reason: string; ref: string } | { state: "read"; read: PrinciplesRead; ref: string };

/** The latest `principles-read` for this configuration, from the evidence alone. */
export function principlesReading(evidence: readonly EvidenceRecord[], cfg: PrinciplesConfig, base: string): PrinciplesReading {
  const want = principlesReadCommand(cfg, base).argv;
  const run = commandRuns(evidence, COMMAND.principles).filter((r) => r.command.argv[4] === want[4] && r.command.argv[5] === want[5]).at(-1);
  if (run === undefined) return { state: "missing" };
  const ref = run.record.ref;
  if (!succeeded(run.command)) return { state: "failed", reason: `reading the principles file exited ${run.command.exitCode ?? "on a signal"}: ${(run.command.stderrTail || "").trim().slice(0, 200)}`, ref };
  const out = reportText(run);
  const m = /^commit ([0-9a-f]{40})\n(present|absent)\n?/.exec(out.text);
  if (m === null) return { state: "failed", reason: "the principles read printed no commit and file state", ref };
  return { state: "read", ref, read: { path: cfg.path, ...(cfg.ref !== undefined ? { ref: cfg.ref } : {}), commit: m[1]!, file: m[2] as "present" | "absent", text: out.text.slice(m[0].length), truncated: out.truncated } };
}

/** The principles as N1 judges the change against them. */
export interface PrinciplesContext {
  read: PrinciplesRead;
  parsed: ParsedPrinciples;
  applicable: Principle[];
  inapplicable: Principle[];
  /** The pull request changes the principles file itself. */
  changed: boolean;
}

export function principlesContext(read: PrinciplesRead, files: ReadonlyArray<{ path: string; previousPath?: string | null }>): PrinciplesContext {
  const parsed = read.file === "present" ? parsePrinciples(read.text) : { principles: [], notes: [] };
  if (read.truncated) parsed.notes.push("the file did not fit the command report whole; the principles after the cut are missing");
  return {
    read,
    parsed,
    applicable: parsed.principles.filter((p) => applies(p, files)),
    inapplicable: parsed.principles.filter((p) => !applies(p, files)),
    changed: files.some((f) => f.path === read.path || f.previousPath === read.path),
  };
}

/** Where the file was read from, as a reader sees it: the ref the profile names and the commit it resolved to, or the base commit. */
export const principlesFrom = (r: PrinciplesRead): string => (r.ref !== undefined ? `${r.ref} (${r.commit.slice(0, 12)})` : `the pinned base ${r.commit.slice(0, 12)}`);

/** What `necessity.json` records of the principles: the file, what applied, and the parse's notes (the verdicts are in the answer). */
export interface PrinciplesRecord {
  path: string;
  ref?: string;
  commit: string;
  file: "present" | "absent";
  changedByPullRequest: boolean;
  principles: Array<{ id: string; appliesTo: string[]; applicable: boolean }>;
  notes: string[];
}

export function principlesRecord(c: PrinciplesContext): PrinciplesRecord {
  const ids = new Set(c.applicable.map((p) => p.id));
  return {
    path: c.read.path,
    ...(c.read.ref !== undefined ? { ref: c.read.ref } : {}),
    commit: c.read.commit,
    file: c.read.file,
    changedByPullRequest: c.changed,
    principles: c.parsed.principles.map((p) => ({ id: p.id, appliesTo: p.appliesTo, applicable: ids.has(p.id) })),
    notes: c.parsed.notes,
  };
}
