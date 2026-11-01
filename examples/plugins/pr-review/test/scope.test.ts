// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { MetricsRecord } from "../src/metrics/record.js";
import { hotspots, hotspotText, isDocFile, isTestFile, needAuthor, openQuestions, scopeKindOf, scopeOf, scopeText } from "../src/scope.js";

const GENERATED = { excludeRoots: ["**/*.pb.go", "api/gen"], globs: ["**/zz_generated*.go"] };

describe("the scope that matters: lines by kind of file (design 6.1)", () => {
  it("knows a test by the plugin's own rules: _test.go, .test.ts and .spec.ts, a test, tests or __tests__ directory", () => {
    for (const p of ["pkg/a_test.go", "src/a.test.ts", "src/a.spec.tsx", "test/support.ts", "pkg/tests/x.go", "ui/src/__tests__/a.ts", "banyand/test/e2e/run.sh"]) expect(isTestFile(p), p).toBe(true);
    for (const p of ["pkg/a.go", "src/testing.ts", "pkg/contest/a.go", "src/latest.ts", "docs/test.md"]) expect(isTestFile(p), p).toBe(false);
  });

  it("knows a doc by docs/ or Markdown", () => {
    for (const p of ["docs/design.md", "docs/img/a.png", "README.md", "pkg/CHANGES.md", "x/readme.MD"]) expect(isDocFile(p), p).toBe(true);
    expect(isDocFile("pkg/docs.go")).toBe(false);
  });

  it("puts a generated file (the profile's excludeRoots or generated globs) first, then docs, then tests, then production code", () => {
    expect(scopeKindOf("api/proto/x.pb.go", GENERATED)).toBe("generated");
    expect(scopeKindOf("api/gen/deep/x.go", GENERATED)).toBe("generated");
    expect(scopeKindOf("pkg/zz_generated.deepcopy.go", GENERATED)).toBe("generated");
    expect(scopeKindOf("pkg/x_test.go", { excludeRoots: ["pkg"], globs: [] })).toBe("generated");
    expect(scopeKindOf("docs/a.md", GENERATED)).toBe("docs");
    expect(scopeKindOf("test/README.md", GENERATED)).toBe("docs");
    expect(scopeKindOf("pkg/a_test.go", GENERATED)).toBe("tests");
    expect(scopeKindOf("pkg/a.go", GENERATED)).toBe("production");
    expect(scopeKindOf("Makefile", GENERATED)).toBe("production");
  });

  it("counts files, lines added and lines deleted for each kind from the file list alone", () => {
    const files = [
      { path: "pkg/a.go", additions: 100, deletions: 10 },
      { path: "pkg/b.go", additions: 20, deletions: 0 },
      { path: "pkg/a_test.go", additions: 60, deletions: 5 },
      { path: "docs/x.md", additions: 7, deletions: 1 },
      { path: "api/proto/x.pb.go", additions: 900, deletions: 300 },
    ];
    const s = scopeOf(files, GENERATED);
    expect(s).toEqual({ production: { files: 2, added: 120, deleted: 10 }, tests: { files: 1, added: 60, deleted: 5 }, docs: { files: 1, added: 7, deleted: 1 }, generated: { files: 1, added: 900, deleted: 300 } });
    expect(scopeText(s.production)).toBe("2 files, +120 −10");
    expect(scopeText(s.docs)).toBe("1 file, +7 −1");
    expect(scopeOf([], GENERATED).production).toEqual({ files: 0, added: 0, deleted: 0 });
  });
});

describe("the hotspots: the five functions with the highest CRAP, then complexity (design 6.1)", () => {
  const rec = (name: string, crap: number | undefined, complexity: number, over: Partial<MetricsRecord> = {}): MetricsRecord => ({
    path: "pkg/a.go", function: name, startLine: 3, endLine: 30, change: "added", test: false, complexity, decisions: [], nesting: 2, nestingPath: [], ...(crap !== undefined ? { crap } : {}), ...over,
  });

  it("ranks by CRAP, then complexity, then nesting, then name, and keeps five", () => {
    const records = [rec("c", 10, 5), rec("a", 50, 9), rec("b", 50, 12), rec("d", 10, 5, { nesting: 4 }), rec("e", 10, 5), rec("f", 3, 99), rec("g", 1, 1)];
    expect(hotspots(records).map((h) => h.function)).toEqual(["b", "a", "d", "c", "e"]);
    expect(hotspots(records, 2).map((h) => h.function)).toEqual(["b", "a"]);
  });

  it("leaves out a test function, which has no CRAP, and any function with no CRAP ranks after one with it", () => {
    const records = [rec("t", undefined, 40, { test: true }), rec("u", undefined, 30), rec("p", 4, 2), rec("q", 6, 1, { path: "pkg/a_test.go" })];
    expect(hotspots(records).map((h) => h.function)).toEqual(["p", "u"]);
  });

  it("says base → head where a modified function got worse, and only there", () => {
    const base = (complexity: number, nesting: number) => ({ complexity, nesting, startLine: 1, endLine: 9, path: "pkg/a.go" });
    const worse = hotspots([rec("w", 40, 12, { change: "modified", nesting: 4, base: base(7, 3) })])[0]!;
    expect(worse.worse).toEqual([{ metric: "complexity", base: 7, head: 12 }, { metric: "nesting", base: 3, head: 4 }]);
    expect(hotspotText(worse)).toBe("w — CRAP 40 (upper bound, coverage unknown), complexity 7 → 12, nesting 3 → 4 (modified)");
    const same = hotspots([rec("s", 40, 12, { change: "modified", base: base(12, 2) })])[0]!;
    expect(hotspotText(same)).toBe("s — CRAP 40 (upper bound, coverage unknown), complexity 12, nesting 2 (modified)");
    const better = hotspots([rec("b", 40, 5, { change: "modified", base: base(12, 5) })])[0]!;
    expect(better.worse).toEqual([]);
    const unknown = hotspots([rec("n", 40, 12, { change: "modified", base: { unavailable: "no base" } as never })])[0]!;
    expect(unknown.worse).toEqual([]);
    expect(hotspotText(hotspots([rec("x", 12, 3, { coverage: { source: "measured", covered: 3, total: 4 } as never })])[0]!)).toBe("x — CRAP 12, complexity 3, nesting 2 (added)");
  });
});

describe("the open questions: the ones that need a person", () => {
  const q = (id: string, status: string | undefined) => ({ id, type: "purpose", text: `${id}?`, answer: status === undefined ? undefined : { status, answer: "a" } });

  it("keeps needs author, partially answered and not answered, and counts the answered", () => {
    const all = [q("Q1", "answered"), q("Q2", "needs author"), q("Q3", "partially answered"), q("Q4", undefined), q("Q5", "answered")];
    const r = openQuestions(all, { id: "N1", conclusion: undefined });
    expect(r.open.map((x) => x.id)).toEqual(["Q2", "Q3", "Q4"]);
    expect(r.answered).toBe(2);
    expect(r.total).toBe(5);
    expect(needAuthor(all)).toBe(1);
  });

  it("includes N1 when its conclusion is questionable or unnecessary, whatever its answer's status, and not when it is necessary", () => {
    const all = [q("N1", "answered"), q("Q1", "answered")];
    for (const c of ["questionable", "unnecessary"]) expect(openQuestions(all, { id: "N1", conclusion: c }).open.map((x) => x.id)).toEqual(["N1"]);
    for (const c of ["necessary", undefined]) expect(openQuestions(all, { id: "N1", conclusion: c }).open).toEqual([]);
    expect(openQuestions([q("N1", "needs author")], { id: "N1", conclusion: "needs author" }).open.map((x) => x.id)).toEqual(["N1"]);
  });
});
