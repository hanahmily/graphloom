// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GO_PACK, TS_PACK, effectivePacks } from "../src/packs.js";
import { parsePatch } from "../src/patch.js";
import { changedSymbols, declarationEnd, extractSymbols, goReceiver, maskCode, parseBaseDefinitions, touches, changedHeadLines } from "../src/symbols.js";

const GO = `package store

import "fmt"

// Doc mentions func Ghost() { and braces }.
type Group struct {
	Name string
}

type Box[T any] struct{ v T }

const MaxGroups = 10

const (
	Alpha = 1
	beta  = 2
	Gamma = 3
)

var defaultTTL = "7d"

func New(name string) *Group {
	s := "}{"
	return &Group{Name: name + s}
}

func (g *Group) Rename(n string) {
	g.Name = n
}

func (g Group) String() string { return fmt.Sprint(g.Name) }

func (b *Box[T]) Set(v T) {
	b.v = v
}

func Map[K comparable, V any](m map[K]V) []K {
	out := make([]K, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func external(a int) int
`;

describe("symbol extraction: Go", () => {
  const syms = extractSymbols("pkg/store/group.go", GO, GO_PACK);
  const byName = (n: string) => syms.find((s) => s.name === n)!;

  it("qualifies functions, methods with value and pointer receivers, generics and types as the metrics tool names them", () => {
    expect(syms.map((s) => s.qualified)).toEqual([
      "store.Group",
      "store.Box",
      "store.MaxGroups",
      "store.Alpha",
      "store.Gamma",
      "store.defaultTTL",
      "store.New",
      "store.(*Group).Rename",
      "store.Group.String",
      "store.(*Box[...]).Set",
      "store.Map[...]",
      "store.external",
    ]);
  });

  it("cuts each body by brace matching, ignoring braces in strings and comments", () => {
    expect([byName("Group").startLine, byName("Group").endLine]).toEqual([6, 8]);
    expect([byName("New").startLine, byName("New").endLine]).toEqual([22, 25]);
    expect(byName("New").body).toContain('s := "}{"');
    expect([byName("String").startLine, byName("String").endLine]).toEqual([31, 31]);
    expect([byName("Map").startLine, byName("Map").endLine]).toEqual([37, 43]);
    expect(byName("Ghost" as never)).toBeUndefined();
  });

  it("ends a declaration with no body at its line, and finds exported constants inside a const block but not the unexported one", () => {
    expect(byName("external").endLine).toBe(byName("external").startLine);
    expect(syms.filter((s) => s.kind === "const").map((s) => s.name)).toEqual(["MaxGroups", "Alpha", "Gamma"]);
  });

  it("marks exported names", () => {
    expect(syms.filter((s) => s.exported).map((s) => s.name)).toEqual(["Group", "Box", "MaxGroups", "Alpha", "Gamma", "New", "Rename", "String", "Set", "Map"]);
    expect(byName("defaultTTL").exported).toBe(false);
    expect(byName("external").exported).toBe(false);
  });

  it("keeps the signature without its body, on one line", () => {
    expect(byName("Map").signature).toBe("func Map[K comparable, V any](m map[K]V) []K");
    expect(byName("Rename").kind).toBe("method");
  });
});

const TS = `import { x } from "./x";

export interface Opts { a: number }

export type Id = string;

export const LIMIT = 5;

export const double = (n: number): number => {
  return n * 2;
};

function helper(a: string): string {
  return \`\${a}}\`;
}

export class Parser {
  private cache = new Map<string, number>();

  constructor(private readonly name: string) {
    this.name = name;
  }

  public parse(input: string): number {
    if (input === "{") {
      return 0;
    }
    return input.length;
  }

  static async load<T>(path: string): Promise<T> {
    return (await import(path)) as T;
  }
}

export default function main() {
  return 1;
}
`;

describe("symbol extraction: TypeScript", () => {
  const syms = extractSymbols("src/parser.ts", TS, TS_PACK);

  it("finds exported declarations, the module's own functions and class members with their classes", () => {
    expect(syms.map((s) => s.qualified)).toEqual([
      "src/parser.Opts",
      "src/parser.Id",
      "src/parser.LIMIT",
      "src/parser.double",
      "src/parser.helper",
      "src/parser.Parser",
      "src/parser.Parser.constructor",
      "src/parser.Parser.parse",
      "src/parser.Parser.load",
      "src/parser.main",
    ]);
    expect(syms.find((s) => s.name === "helper")!.exported).toBe(false);
    expect(syms.find((s) => s.name === "parse")!.exported).toBe(true);
  });

  it("matches braces past a template literal and a brace inside a string", () => {
    const parse = syms.find((s) => s.name === "parse")!;
    expect([parse.startLine, parse.endLine]).toEqual([24, 29]);
    const helper = syms.find((s) => s.name === "helper")!;
    expect([helper.startLine, helper.endLine]).toEqual([13, 15]);
    expect(syms.find((s) => s.name === "Parser")!.endLine).toBe(34);
  });

  it("does not take a property or a control statement for a member", () => {
    expect(syms.some((s) => s.name === "cache" || s.name === "if")).toBe(false);
  });
});

describe("new versus modified", () => {
  const base = GO.replace("func Map[K", "func Gone[K");
  /** The patch of two texts, as `git diff --no-index -U1` prints it (several hunks, with context). */
  const patchOf = (before: string, after: string): ReturnType<typeof parsePatch> => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-sym-"));
    writeFileSync(path.join(dir, "a"), before);
    writeFileSync(path.join(dir, "b"), after);
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "-U1", "a", "b"], { cwd: dir, encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    return parsePatch(r.stdout);
  };

  it("calls a symbol new when the base file does not define its qualified name, and modified when it does and a line inside its body changed", () => {
    const head = GO.replace("	g.Name = n\n", "	g.Name = n\n	g.touched = true\n").replace("func Map[K", "func Collect[K");
    const baseDefs = parseBaseDefinitions(base.split("\n").map((l, n) => `${"a".repeat(40)}:pkg/store/group.go:${n + 1}:${l}`).join("\n"), GO_PACK).byPath.get("pkg/store/group.go")!;
    const found = changedSymbols({ path: "pkg/store/group.go", previousPath: null, status: "modified", parsed: patchOf(base, head), text: head }, GO_PACK, baseDefs);
    expect(found.map((s) => [s.qualified, s.change])).toEqual([
      ["store.(*Group).Rename", "modified"],
      ["store.Collect[...]", "new"],
    ]);
  });

  it("takes every symbol of an added file as new", () => {
    const parsed = parsePatch(["@@ -0,0 +1,3 @@", "+package p", "+", "+func A() {}"].join("\n"));
    const found = changedSymbols({ path: "p/a.go", previousPath: null, status: "added", parsed, text: "package p\n\nfunc A() {}\n" }, GO_PACK, undefined);
    expect(found.map((s) => [s.qualified, s.change])).toEqual([["p.A", "new"]]);
  });

  it("falls back to the patch when the base's declarations are unknown: an added definition line with no deleted twin is new, a changed body is modified", () => {
    const head = GO.replace("	g.Name = n\n", "	g.Name = n\n	g.touched = true\n").replace("func Map[K", "func Collect[K");
    const found = changedSymbols({ path: "pkg/store/group.go", previousPath: null, status: "modified", parsed: patchOf(base, head), text: head }, GO_PACK, undefined);
    expect(found.map((s) => [s.name, s.change])).toEqual([
      ["Rename", "modified"],
      ["Collect", "new"],
    ]);
  });

  it("is touched by an added line in its body and by a deletion between two of its lines, not by one before or after it", () => {
    const sym = { startLine: 10, endLine: 20 };
    const patch = parsePatch(["@@ -10,4 +10,3 @@", " ctx", "-gone", " ctx2", " ctx3"].join("\n"));
    expect(touches(sym, changedHeadLines(patch))).toBe(true);
    const before = parsePatch(["@@ -4,4 +4,3 @@", " a", "-gone", " b", " c"].join("\n"));
    expect(touches(sym, changedHeadLines(before))).toBe(false);
  });
});

describe("helpers", () => {
  it("prints a Go receiver as the metrics tool does", () => {
    expect(goReceiver("g *Group")).toBe("(*Group)");
    expect(goReceiver("Group")).toBe("Group");
    expect(goReceiver("b *Box[T]")).toBe("(*Box[...])");
    expect(goReceiver("m Pair[K, V]")).toBe("Pair[...]");
  });

  it("blanks comments and strings but keeps positions", () => {
    const text = 'a := "x}"; // {\nb /* } */ c';
    const masked = maskCode(text);
    expect(masked.length).toBe(text.length);
    expect(masked).not.toMatch(/[{}]/);
    expect(masked.split("\n")).toHaveLength(2);
  });

  it("finds where a multi-line signature's body ends", () => {
    const lines = maskCode("func f(\n\ta int,\n\tb int,\n) (int, error) {\n\tif a > b {\n\t}\n\treturn 0, nil\n}\n").split("\n");
    expect(declarationEnd(lines, 1)).toBe(8);
  });

  it("lets a profile's pack override fields of the default and add a language whole", () => {
    const packs = effectivePacks({ symbols: [{ language: "go", globs: ["src/**/*.go"], testFiles: ["**/*_spec.go"] }, { language: "rust", globs: ["**/*.rs"], definitions: ["^fn\\s+(?<name>\\w+)"] }] });
    expect(packs.map((p) => p.language)).toEqual(["go", "typescript", "rust"]);
    expect(packs[0]!.globs).toEqual(["src/**/*.go"]);
    expect(packs[0]!.definitions).toEqual(GO_PACK.definitions);
    expect(packs[0]!.testFiles).toEqual(["**/*_spec.go"]);
  });
});
