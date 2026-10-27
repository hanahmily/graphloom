// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Skills name only real CLI (docs/design-agent-skills.md §1, §4): every
 * `graphloom <command> [<sub>] [--flags]` in a skill's code spans and blocks
 * must be a command, and use flags, that the built CLI's own `--help` lists.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execFileAsync, repoRoot } from "./cli-env.js";

const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");
const skillsDir = path.join(repoRoot, "skills");
/** Commands whose second word is a subcommand. */
const WITH_SUB = new Set(["self", "skills"]);

export interface Invocation {
  key: string;
  flags: string[];
  text: string;
}

/** Command key (`wait`, `skills install`, `self uninstall`) to the flags `--help` lists for it. */
export function helpIndex(help: string): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  const add = (key: string, text: string) => {
    const set = index.get(key) ?? new Set<string>();
    for (const m of text.matchAll(/--[a-z][a-z-]*/g)) set.add(m[0]);
    index.set(key, set);
  };
  for (const line of help.split("\n")) {
    const m = /^ {2}graphloom ([a-z][a-z-]*)(.*)$/.exec(line);
    if (m === null) continue;
    const [, cmd, rest] = m as unknown as [string, string, string];
    if (!WITH_SUB.has(cmd)) {
      add(cmd, rest);
      continue;
    }
    // `self list | use <version> | rollback | ...` and `skills install [...]`.
    for (const alt of rest.split(" | ")) {
      const sub = /^\s*([a-z][a-z-]*)(.*)$/.exec(alt);
      if (sub !== null) add(`${cmd} ${sub[1]}`, sub[2]!);
    }
  }
  return index;
}

/** Code snippets of a Markdown text: fenced blocks (continuations joined) and inline spans. */
export function codeSnippets(markdown: string): string[] {
  const out: string[] = [];
  const rest = markdown.replace(/^```[^\n]*\n([\s\S]*?)^```$/gm, (_all, body: string) => {
    out.push(...body.replace(/\\\n/g, " ").split("\n"));
    return "";
  });
  for (const m of rest.matchAll(/`([^`]+)`/g)) out.push(m[1]!.replace(/\s+/g, " "));
  return out;
}

/** Every `graphloom` invocation in a snippet, including those inside `$(...)`; quoted text is not parsed. */
export function invocations(snippet: string): Invocation[] {
  const parts: string[] = [];
  let s = snippet.replace(/<[A-Za-z][^<>\s]*>/g, "ARG");
  for (;;) {
    const inner = /\$\(([^()]*)\)/.exec(s);
    if (inner === null) break;
    parts.push(inner[1]!);
    s = s.slice(0, inner.index) + " ARG " + s.slice(inner.index + inner[0].length);
  }
  parts.push(s);
  const found: Invocation[] = [];
  for (const part of parts) {
    const unquoted = part.replace(/'[^']*'/g, " ARG ").replace(/"[^"]*"/g, " ARG ");
    for (const segment of unquoted.split(/\|\||&&|[|;()<>]|\d?>/)) {
      const tokens = segment.trim().split(/\s+/);
      const at = tokens.indexOf("graphloom");
      if (at < 0) continue;
      const cmd = tokens[at + 1];
      if (cmd === undefined || cmd.startsWith("-")) continue;
      const sub = WITH_SUB.has(cmd) ? tokens[at + 2] : undefined;
      const flags = tokens.slice(at + (sub !== undefined ? 3 : 2)).filter((t) => /^--[a-z]/.test(t)).map((t) => t.split("=")[0]!);
      found.push({ key: sub !== undefined ? `${cmd} ${sub}` : cmd, flags, text: segment.trim() });
    }
  }
  return found;
}

/** Problems with `found` against the help index. */
export function drift(index: Map<string, Set<string>>, found: readonly Invocation[]): string[] {
  const problems: string[] = [];
  for (const inv of found) {
    const flags = index.get(inv.key);
    if (flags === undefined) {
      problems.push(`unknown command graphloom ${inv.key} (in: ${inv.text})`);
      continue;
    }
    for (const f of inv.flags) if (!flags.has(f)) problems.push(`graphloom ${inv.key} has no ${f} (in: ${inv.text})`);
  }
  return problems;
}

describe("skills reference only real CLI commands and flags", () => {
  it("parses the help and the snippets the way the skills write them", () => {
    const index = helpIndex(
      "Usage:\n  graphloom wait <stateDir|runId> [--until stop|progress] [--json]\n  graphloom self list | prune [--dry-run] | uninstall [--purge-config]\n  graphloom skills install [<name>...] [--force]\n",
    );
    expect([...index.keys()].sort()).toEqual(["self list", "self prune", "self uninstall", "skills install", "wait"]);
    const found = [
      ...codeSnippets("Run `graphloom wait <run> --until progress\n --json` then\n```sh\ngraphloom skills install \\\n  --force > log 2>&1\nln -s \"$(graphloom version --root)/x\" p\n```\n"),
    ].flatMap(invocations);
    expect(found.map((f) => [f.key, f.flags])).toEqual([
      ["skills install", ["--force"]],
      ["version", ["--root"]],
      ["wait", ["--until", "--json"]],
    ]);
    expect(drift(index, found)).toEqual(["unknown command graphloom version (in: graphloom version --root)"]);
    expect(drift(index, invocations("graphloom wait r --bogus 'graphloom --not-parsed'"))).toEqual(["graphloom wait has no --bogus (in: graphloom wait r --bogus  ARG)"]);
    expect(drift(index, invocations("graphloom self uninstall --purge-config; graphloom self prune --force"))).toEqual([
      "graphloom self prune has no --force (in: graphloom self prune --force)",
    ]);
  });

  it("finds every invocation in the shipped skills in the built CLI's --help", async () => {
    const help = (await execFileAsync(process.execPath, [cli, "--help"])).stdout;
    const index = helpIndex(help);
    expect(index.get("wait")).toEqual(new Set(["--state-root", "--until", "--since", "--timeout", "--json"]));
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const name of readdirSync(skillsDir).filter((n) => statSync(path.join(skillsDir, n)).isDirectory())) {
      const found = codeSnippets(readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8")).flatMap(invocations);
      for (const f of found) seen.add(f.key);
      problems.push(...drift(index, found).map((p) => `${name}: ${p}`));
    }
    expect(problems).toEqual([]);
    // The skills drive the commands this design is about.
    for (const key of ["doctor", "setup", "check", "run", "wait", "stats", "inspect", "resume", "skills install"]) expect(seen, key).toContain(key);
  });
});
