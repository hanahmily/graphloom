// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The shipped agent skills (docs/design-agent-skills.md §1, §4): each is a
 * directory with a SKILL.md whose YAML frontmatter Claude Code and Codex both
 * load (`name` equal to the directory, a `description`), within size bounds,
 * and carrying the hard rules every skill states.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./cli-env.js";

const skillsDir = path.join(repoRoot, "skills");
const names = readdirSync(skillsDir).filter((n) => statSync(path.join(skillsDir, n)).isDirectory()).sort();

/** The frontmatter's top-level `key: value` pairs (the subset of YAML a skill uses), and the body. */
export function parseSkill(text: string): { front: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error("no YAML frontmatter between --- lines at the top");
  const front: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    if (line.trim() === "") continue;
    const kv = /^([a-z][a-z-]*):\s?(.*)$/.exec(line);
    if (kv === null) throw new Error(`frontmatter line is not "key: value": ${JSON.stringify(line)}`);
    if (kv[1]! in front) throw new Error(`frontmatter key ${kv[1]} appears twice`);
    let value = kv[2]!.trim();
    if (/^["']/.test(value)) value = JSON.parse(value.replace(/^'(.*)'$/, '"$1"')) as string;
    // An unquoted plain scalar may not contain ": " or start with a YAML indicator.
    else if (/: |^[>|&*!%@`{[]/.test(value) || / #/.test(value)) throw new Error(`frontmatter ${kv[1]} needs quoting: ${value}`);
    front[kv[1]!] = value;
  }
  return { front, body: m[2]! };
}

describe("shipped agent skills", () => {
  it("are the six the design names", () => {
    expect(names).toEqual(["graphloom-deliver", "graphloom-issue", "graphloom-run", "graphloom-setup", "graphloom-triage", "graphloom-watch"]);
  });

  for (const name of names) {
    describe(name, () => {
      const file = path.join(skillsDir, name, "SKILL.md");
      const text = readFileSync(file, "utf8");
      const { front, body } = parseSkill(text);

      it("has valid frontmatter: name is the directory, a description within bounds, nothing else", () => {
        expect(Object.keys(front).sort()).toEqual(["description", "name"]);
        expect(front.name).toBe(name);
        expect(front.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        expect(front.name!.length).toBeLessThanOrEqual(64);
        expect(front.description!.length).toBeGreaterThanOrEqual(80);
        expect(front.description!.length).toBeLessThanOrEqual(1024);
        expect(front.description).not.toMatch(/[<>]/);
      });

      it("has a body within size bounds, starting with a heading", () => {
        expect(body.trimStart()).toMatch(/^# /);
        expect(body.length).toBeGreaterThan(1_500);
        expect(body.length).toBeLessThan(16_000);
        expect(body.split("\n").length).toBeLessThan(500);
      });

      it("states the hard rules", () => {
        const rules = body.split(/^## Hard rules$/m)[1]?.split(/^## /m)[0];
        expect(rules, "a '## Hard rules' section").toBeDefined();
        expect(rules).toMatch(/Ask before anything outward-facing/i);
        expect(rules).toMatch(/Never print or ask for a token or secret/i);
        expect(rules).toMatch(/never edit `state\.json`/i);
        expect(rules).toMatch(/`graphloom --help`|only commands and flags/i);
      });

      it("holds only Markdown, and no install marker", () => {
        expect(readdirSync(path.join(skillsDir, name))).toEqual(["SKILL.md"]);
      });
    });
  }

  it("never recommend polling the process table for liveness", () => {
    for (const name of names) {
      const body = readFileSync(path.join(skillsDir, name, "SKILL.md"), "utf8");
      // pgrep may only appear in a warning against it.
      for (const line of body.split("\n").filter((l) => /pgrep/.test(l))) expect(line, `${name}: ${line}`).toMatch(/never|not|matches/i);
    }
  });
});
