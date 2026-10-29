// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  analyzeTypeScript,
  parseHunkFile,
  runTsMetrics,
  validateMetricsDocument,
  type Hunks,
  type MetricsDocument,
  type MetricsRecord,
} from "../src/metrics/index.js";

const A_TS = [
  "export function small(a: number) {", // 1
  "  if (a > 0 && a < 5) {", // 2
  "    for (const x of [a]) {", // 3
  "      if (x) return x;", // 4
  "    }", // 5
  "  }", // 6
  "  return 0;", // 7
  "}", // 8
  "", // 9
  "export function untouched() {", // 10
  "  return 1;", // 11
  "}", // 12
  "", // 13
  "export function outer() {", // 14
  "  return [1].map((x) => {", // 15
  "    return x > 1 ? 1 : 0;", // 16
  "  });", // 17
  "}", // 18
  "",
].join("\n");

let root: string;
let doc: MetricsDocument;
const hunks: Hunks = parseHunkFile("src/a.ts:1-8\nsrc/a.ts:16\n");
const read = (p: string): string | undefined => {
  try {
    return readFileSync(path.join(root, p), "utf8");
  } catch {
    return undefined;
  }
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "gl-metrics-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "src/a.ts"), A_TS);
  doc = runTsMetrics(root, hunks, []);
});

const clone = (): MetricsDocument => JSON.parse(JSON.stringify(doc)) as MetricsDocument;
const rec = (d: MetricsDocument, name: string): MetricsRecord => {
  const r = d.records.find((x) => x.function === name);
  if (r === undefined) throw new Error(`no record ${name}`);
  return r;
};
const check = (d: unknown, h: Hunks = hunks, generated: string[] = []) =>
  validateMetricsDocument(d, { readFile: read, hunks: h, generated });
const messages = (d: unknown, h?: Hunks): string[] => check(d, h).errors.map((e) => e.message);

describe("validateMetricsDocument accepts what the tool emits", () => {
  it("passes the tsmetrics output", () => {
    expect(doc.records.map((r) => [r.function, r.change, r.complexity, r.nesting])).toEqual([
      ["src/a.small", "added", 5, 3],
      ["src/a.outer.func1", "modified", 2, 0],
    ]);
    expect(check(doc)).toEqual({ ok: true, errors: [] });
  });
});

describe("validateMetricsDocument rejects inconsistent records (never corrects)", () => {
  it("rejects a wrong complexity count", () => {
    const d = clone();
    rec(d, "src/a.small").complexity = 3;
    expect(messages(d).join("\n")).toMatch(/complexity 3 is not 1 \+ 4 decisions/);
  });

  it("rejects a decision on a line without its keyword", () => {
    const d = clone();
    const r = rec(d, "src/a.small");
    r.decisions[0] = { line: 7, kind: "if" };
    expect(messages(d).join("\n")).toMatch(/line 7 lists 1 "if" decision/);
  });

  it("rejects more decisions on a line than the line holds", () => {
    const d = clone();
    const r = rec(d, "src/a.small");
    r.decisions.push({ line: 2, kind: "&&" });
    r.complexity += 1;
    expect(messages(d).join("\n")).toMatch(/line 2 lists 2 "&&" decision\(s\) but holds 1/);
  });

  it("rejects a decision kind of the other language", () => {
    const d = clone();
    rec(d, "src/a.small").decisions[0] = { line: 2, kind: "select" };
    expect(messages(d).join("\n")).toMatch(/"select" is not a typescript decision/);
  });

  it("rejects a decision inside a nested function", () => {
    const d = clone();
    const outer = d.files[0]?.functions.find((f) => f[0] === "src/a.outer");
    expect(outer).toBeDefined();
    d.records.push({
      path: "src/a.ts",
      function: "src/a.outer",
      startLine: 14,
      endLine: 18,
      change: "modified",
      test: false,
      complexity: 2,
      decisions: [{ line: 16, kind: "?:" }],
      nesting: 0,
      nestingPath: [],
    });
    expect(messages(d).join("\n")).toMatch(/line 16 is not in the function's own code/);
  });

  it("rejects a nesting that is not the path length", () => {
    const d = clone();
    rec(d, "src/a.small").nesting = 2;
    expect(messages(d).join("\n")).toMatch(/nesting 2 is not the nestingPath length 3/);
  });

  it("rejects a nesting path out of order", () => {
    const d = clone();
    const r = rec(d, "src/a.small");
    r.nestingPath = [r.nestingPath[1] as never, r.nestingPath[0] as never, r.nestingPath[2] as never];
    expect(messages(d).join("\n")).toMatch(/comes before line/);
  });

  it("rejects a nesting step whose line lacks the keyword", () => {
    const d = clone();
    rec(d, "src/a.small").nestingPath[2] = { line: 5, kind: "if" };
    expect(messages(d).join("\n")).toMatch(/line 5 does not hold "if"/);
  });

  it("rejects a nesting step with no matching decision", () => {
    const d = clone();
    const r = rec(d, "src/a.small");
    r.nestingPath = [{ line: 2, kind: "while" }];
    r.nesting = 1;
    expect(messages(d).join("\n")).toMatch(/does not hold "while"/);
  });

  it("rejects a CRAP that does not recompute", () => {
    const d = clone();
    const r = rec(d, "src/a.small");
    r.coverage = { source: "measured", covered: 7, total: 10 };
    r.crap = 5;
    expect(messages(d).join("\n")).toMatch(/crap 5 does not recompute to 5\.68/);
  });

  it("accepts a recomputed CRAP, measured and unknown", () => {
    const d = clone();
    const r = rec(d, "src/a.small");
    r.coverage = { source: "measured", covered: 7, total: 10 };
    r.crap = 5.68;
    const o = rec(d, "src/a.outer.func1");
    o.coverage = { source: "unknown", reason: "docker unavailable" };
    o.crap = 6;
    expect(check(d)).toEqual({ ok: true, errors: [] });
  });

  it("rejects coverage without crap, covered above total, and an unknown without reason", () => {
    let d = clone();
    rec(d, "src/a.small").coverage = { source: "unknown", reason: "x" };
    expect(messages(d).join("\n")).toMatch(/must come together/);
    d = clone();
    const r = rec(d, "src/a.small");
    r.coverage = { source: "measured", covered: 11, total: 10 };
    r.crap = 5;
    expect(messages(d).join("\n")).toMatch(/0 <= covered <= total/);
    d = clone();
    const o = rec(d, "src/a.small");
    o.coverage = { source: "unknown", reason: "" };
    o.crap = 30;
    expect(messages(d).join("\n")).toMatch(/needs a reason/);
  });

  it("rejects a changed function with no record (scope gap)", () => {
    const d = clone();
    d.records = d.records.filter((r) => r.function !== "src/a.outer.func1");
    expect(messages(d).join("\n")).toMatch(/changed \(modified\) function has no record/);
  });

  it("rejects a hunk line inside an indexed function that has no record", () => {
    const h = parseHunkFile("src/a.ts:1-8\nsrc/a.ts:16\nsrc/a.ts:11\n");
    const errors = check(doc, h).errors;
    expect(errors).toEqual([
      { path: "src/a.ts", function: "src/a.untouched", message: "changed (modified) function has no record" },
    ]);
  });

  it("rejects a record for an unchanged function", () => {
    const d = clone();
    d.records.push({
      path: "src/a.ts",
      function: "src/a.untouched",
      startLine: 10,
      endLine: 12,
      change: "modified",
      test: false,
      complexity: 1,
      decisions: [],
      nesting: 0,
      nestingPath: [],
    });
    expect(messages(d).join("\n")).toMatch(/not changed by the diff/);
  });

  it("rejects a wrong change kind", () => {
    const d = clone();
    rec(d, "src/a.small").change = "modified";
    expect(messages(d).join("\n")).toMatch(/change is modified but the diff makes it added/);
  });

  it("rejects a record that matches no indexed function or range", () => {
    const d = clone();
    rec(d, "src/a.small").endLine = 9;
    expect(messages(d).join("\n")).toMatch(/does not match an indexed function and range/);
  });

  it("rejects an indexed range that does not start on a declaring line", () => {
    const d = clone();
    const entry = d.files[0]?.functions[1];
    if (entry === undefined) throw new Error("no entry");
    entry[1] = 11; // "  return 1;"
    expect(messages(d).join("\n")).toMatch(/line 11, which does not declare a function/);
  });

  it("rejects an index range past the end of the file", () => {
    const d = clone();
    const entry = d.files[0]?.functions[0];
    if (entry === undefined) throw new Error("no entry");
    entry[2] = 999;
    expect(messages(d).join("\n")).toMatch(/bad index entry/);
  });

  it("rejects a changed file that is neither measured nor skipped", () => {
    const h = parseHunkFile("src/a.ts:1-8\nsrc/a.ts:16\nsrc/b.ts:1-3\n");
    expect(messages(doc, h).join("\n")).toMatch(/neither measured nor skipped/);
  });

  it("rejects a generated skip with no glob or header, and a generated file measured", () => {
    const d = clone();
    d.skipped.push({ path: "src/a.ts", reason: "generated" });
    expect(messages(d).join("\n")).toMatch(/skipped as generated but/);
    expect(check(doc, hunks, ["src/*.ts"]).errors.map((e) => e.message).join("\n")).toMatch(/generated file is indexed/);
  });

  it("rejects coverage on a test file and a wrong test flag", () => {
    const root2 = mkdtempSync(path.join(tmpdir(), "gl-metrics-"));
    mkdirSync(path.join(root2, "test"), { recursive: true });
    writeFileSync(path.join(root2, "test/t.test.ts"), "export function t() {\n  return 1;\n}\n");
    const h = parseHunkFile("test/t.test.ts:1-3\n");
    const good = runTsMetrics(root2, h, []);
    const opts = { readFile: (p: string) => readFileSync(path.join(root2, p), "utf8"), hunks: h };
    expect(good.records[0]?.test).toBe(true);
    expect(validateMetricsDocument(good, opts).ok).toBe(true);
    const bad = JSON.parse(JSON.stringify(good)) as MetricsDocument;
    (bad.records[0] as MetricsRecord).coverage = { source: "unknown", reason: "x" };
    (bad.records[0] as MetricsRecord).crap = 2;
    expect(validateMetricsDocument(bad, opts).errors.map((e) => e.message).join("\n")).toMatch(/test files carry no/);
    const flag = JSON.parse(JSON.stringify(good)) as MetricsDocument;
    (flag.records[0] as MetricsRecord).test = false;
    expect(validateMetricsDocument(flag, opts).errors.map((e) => e.message).join("\n")).toMatch(/test flag differs/);
  });

  it("rejects a document of the wrong shape or schema", () => {
    expect(check(null).ok).toBe(false);
    expect(check({ ...doc, schema: "v0" }).ok).toBe(false);
    expect(check({ schema: doc.schema }).ok).toBe(false);
    const d = clone();
    (rec(d, "src/a.small") as unknown as { decisions: unknown }).decisions = "nope";
    expect(messages(d).join("\n")).toMatch(/decisions must be a list/);
  });

  it("rejects malformed nested entries instead of throwing", () => {
    const bad: unknown[] = [
      { ...doc, skipped: [null] },
      { ...doc, files: [{ path: "src/a.ts", language: "typescript", test: false }] },
      { ...doc, files: [{ path: "src/a.ts", language: "typescript", test: false, functions: [["x"]] }] },
      { ...doc, records: [{}] },
      { ...doc, records: [null] },
    ];
    for (const d of bad) {
      const r = check(d);
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.message).toMatch(/malformed document/);
    }
    const d = clone();
    (rec(d, "src/a.small") as unknown as { coverage: unknown }).coverage = null;
    (rec(d, "src/a.small") as unknown as { crap: unknown }).crap = 5;
    expect(messages(d).join("\n")).toMatch(/coverage must be an object/);
  });

  it("accepts each tool's output for a mixed Go and TypeScript change", () => {
    const mixed = parseHunkFile("src/a.ts:1-8\nsrc/a.ts:16\ncmd/x.go:1-3\n");
    const ts = runTsMetrics(root, mixed, []);
    expect(ts.skipped).toEqual([{ path: "cmd/x.go", reason: "unsupported-language" }]);
    expect(check(ts, mixed)).toEqual({ ok: true, errors: [] });
    // The same skip is wrong for a tool that does support the language.
    const wrong = { ...ts, tool: "gometrics" };
    expect(check(wrong, mixed).ok).toBe(false);
  });

  it("measures the inner function of a curried arrow that shares its range", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gl-metrics-"));
    writeFileSync(
      path.join(dir, "c.ts"),
      "export const f = (a: number) => (b: number) => {\n  if (a && b) {\n    return 1;\n  }\n  return 0;\n};\n",
    );
    const inner = parseHunkFile("c.ts:3\n");
    const r = runTsMetrics(dir, inner, []);
    expect(r.records.map((x) => [x.function, x.change])).toEqual([["c.f.func1", "modified"]]);
    const opts = { readFile: (p: string) => readFileSync(path.join(dir, p), "utf8"), hunks: inner };
    expect(validateMetricsDocument(r, opts)).toEqual({ ok: true, errors: [] });
    const all = parseHunkFile("c.ts:1-6\n");
    const added = runTsMetrics(dir, all, []);
    expect(added.records.map((x) => x.function)).toEqual(["c.f", "c.f.func1"]);
    expect(validateMetricsDocument(added, { ...opts, hunks: all })).toEqual({ ok: true, errors: [] });
  });

  it("returns an error, without iterating, for an absurd index range", () => {
    const d = clone();
    const entry = d.files[0]?.functions[1];
    if (entry === undefined) throw new Error("no entry");
    entry[2] = 1e100;
    expect(messages(d).join("\n")).toMatch(/bad index entry/);
  });

  it("detects a function removed from both the index and the records", () => {
    const d = clone();
    const file = d.files[0];
    if (file === undefined) throw new Error("no file");
    file.functions = file.functions.filter((f) => f[0] !== "src/a.small");
    d.records = d.records.filter((r) => r.function !== "src/a.small");
    expect(check(d).ok).toBe(true); // nothing in the document alone shows the omission
    const reindex = (p: string, _l: unknown, text: string) =>
      analyzeTypeScript(p, text).map((f): [string, number, number] => [f.name, f.start, f.end]);
    const r = validateMetricsDocument(d, { readFile: read, hunks, reindex });
    expect(r.errors.map((e) => e.message)).toEqual(["function index differs from an independent index of the head file"]);
  });

  it("detects an omitted Go function by its column-0 declaration", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gl-metrics-"));
    writeFileSync(path.join(dir, "a.go"), "package a\n\nfunc A() {}\n\nfunc B() {\n\tprintln()\n}\n");
    const h = parseHunkFile("a.go:5-7\n");
    const omitted: MetricsDocument = {
      schema: "graphloom-metrics-v1",
      tool: "gometrics",
      records: [],
      files: [{ path: "a.go", language: "go", test: false, functions: [["a.A", 3, 3]] }],
      skipped: [],
    };
    const r = validateMetricsDocument(omitted, { readFile: (p) => readFileSync(path.join(dir, p), "utf8"), hunks: h });
    expect(r.errors.map((e) => e.message)).toEqual(["line 5 declares a function that is not indexed"]);
  });

  it("accepts a declaration whose modifiers sit on their own line", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gl-metrics-"));
    writeFileSync(path.join(dir, "m.ts"), "export\nfunction f() {\n  return 1;\n}\n");
    const h = parseHunkFile("m.ts:1-4\n");
    const r = runTsMetrics(dir, h, []);
    expect(r.records.map((x) => x.startLine)).toEqual([1]);
    expect(validateMetricsDocument(r, { readFile: (p) => readFileSync(path.join(dir, p), "utf8"), hunks: h }).ok).toBe(
      true,
    );
  });

  it("requires coverage when asked", () => {
    const r = validateMetricsDocument(doc, { readFile: read, hunks, requireCoverage: true });
    expect(r.errors.some((e) => /coverage and crap are required/.test(e.message))).toBe(true);
  });
});
