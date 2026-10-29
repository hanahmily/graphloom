// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { analyzeTypeScript, type MeasuredFunction } from "../src/metrics/index.js";

function measure(source: string, file = "src/m.ts"): Map<string, MeasuredFunction> {
  return new Map(analyzeTypeScript(file, source).map((f) => [f.name, f]));
}

const comp = (f: MeasuredFunction | undefined): number => 1 + (f?.decisions.length ?? NaN);
const kinds = (f: MeasuredFunction | undefined): string[] => (f?.decisions ?? []).map((d) => d.kind);

describe("tsmetrics decision kinds (§2.1)", () => {
  const one = (body: string): MeasuredFunction => {
    const f = measure(`export function f(a: number, b?: number, xs: number[] = []) {\n${body}\n}\n`).get("src/m.f");
    if (f === undefined) throw new Error("no f");
    return f;
  };

  it("counts if and else if", () => {
    expect(kinds(one("if (a) { a++; } else if (b) { a--; } else { a = 0; }"))).toEqual(["if", "if"]);
  });
  it("counts the conditional expression", () => {
    expect(kinds(one("return a ? 1 : 2;"))).toEqual(["?:"]);
  });
  it("counts every loop form", () => {
    const f = one(
      "for (let i = 0; i < 3; i++) {}\nfor (const k in xs) {}\nfor (const v of xs) {}\nwhile (a > 5) a--;\ndo { a++; } while (a < 2);",
    );
    expect(kinds(f)).toEqual(["for", "for", "for", "while", "do"]);
  });
  it("counts case with a test, not default", () => {
    const f = one("switch (a) { case 1: break; case 2: case 3: break; default: break; }");
    expect(kinds(f)).toEqual(["case", "case", "case"]);
  });
  it("counts &&, || and ??", () => {
    expect(kinds(one("return a && b || (b ?? 0);"))).toEqual(["||", "&&", "??"]);
  });
  it("counts catch, not try or finally", () => {
    expect(kinds(one("try { a++; } catch (e) { a--; } finally { a = 0; }"))).toEqual(["catch"]);
  });
  it("counts nothing for optional chaining, assignment operators or default", () => {
    const f = one("const c = xs?.length; a += 1; a ||= 2; switch (a) { default: break; } return c;");
    expect(kinds(f)).toEqual([]);
    expect(comp(f)).toBe(1);
  });
  it("counts default parameter values as the function's own", () => {
    const f = measure("export function g(a = 1 ?? 2) { return a; }").get("src/m.g");
    expect(kinds(f)).toEqual(["??"]);
  });
  it("sums to the §2.1 total on one function", () => {
    const f = one(
      [
        "let n = 0;",
        "if (a > 0) { n++; } else if (a < 0) { n--; }",
        "n += a ? 1 : 2;",
        "for (const x of xs) { n += x; }",
        "while (n > 5) n--;",
        "switch (a) { case 1: break; default: break; }",
        "try { n++; } catch { n--; }",
        "return n && a || (b ?? 0);",
      ].join("\n"),
    );
    expect(comp(f)).toBe(1 + 2 + 1 + 1 + 1 + 1 + 1 + 3);
  });
  it("records the line of each keyword or operator", () => {
    const f = one("if (a) {\n  a++;\n}\nreturn a &&\n  b;");
    // The wrapper puts the body from line 2.
    expect(f.decisions).toEqual([
      { line: 2, kind: "if" },
      { line: 5, kind: "&&" },
    ]);
  });
});

describe("tsmetrics nesting (§2.2)", () => {
  const nest = (body: string): string[] =>
    (measure(`export function f(a: number, xs: number[]) {\n${body}\n}\n`).get("src/m.f")?.nestingPath ?? []).map(
      (s) => s.kind,
    );

  it("is zero without control blocks", () => {
    expect(nest("return a;")).toEqual([]);
  });
  it("keeps else if and else at the if's level", () => {
    expect(nest("if (a) {} else if (a > 1) {} else if (a > 2) {} else {}")).toEqual(["if"]);
  });
  it("adds a level for an if inside an else block", () => {
    expect(nest("if (a) {} else { if (a > 1) {} }")).toEqual(["if", "if"]);
  });
  it("does not add a level for case clauses", () => {
    expect(nest("switch (a) { case 1: break; case 2: break; }")).toEqual(["switch"]);
  });
  it("adds levels for loops, switch and try", () => {
    expect(nest("for (const x of xs) { while (x) { switch (x) { case 1: try { a++; } catch {} } } }")).toEqual([
      "for",
      "while",
      "switch",
      "try",
    ]);
  });
  it("does not nest catch or finally deeper than their try", () => {
    expect(nest("try { a++; } catch { if (a) {} } finally { a = 0; }")).toEqual(["try", "if"]);
  });
  it("does not count conditional expressions or bare blocks", () => {
    expect(nest("{ { const b = a ? 1 : 2; return b; } }")).toEqual([]);
  });
  it("records increasing lines for the deepest path", () => {
    const f = measure("export function f(xs: number[]) {\n  for (const x of xs) {\n    if (x) {\n    }\n  }\n}\n").get(
      "src/m.f",
    );
    expect(f?.nestingPath).toEqual([
      { line: 2, kind: "for" },
      { line: 3, kind: "if" },
    ]);
  });
  it("picks the deepest of several paths", () => {
    expect(nest("if (a) {} for (const x of xs) { if (x) { if (a) {} } }")).toEqual(["for", "if", "if"]);
  });
});

describe("tsmetrics functions, closures and names (§1)", () => {
  it("measures closures separately from the enclosing function", () => {
    const fns = measure(
      [
        "export function outer(xs: number[]) {",
        "  const g = (x: number) => {",
        "    if (x > 0 && x < 9) { return x; }",
        "    return 0;",
        "  };",
        "  return xs.map((x) => (x ? g(x) : 0)).filter(function (y) { return y > 1; });",
        "}",
      ].join("\n"),
    );
    expect([...fns.keys()]).toEqual(["src/m.outer", "src/m.outer.func1", "src/m.outer.func2", "src/m.outer.func3"]);
    expect(comp(fns.get("src/m.outer"))).toBe(1);
    expect(comp(fns.get("src/m.outer.func1"))).toBe(3);
    expect(fns.get("src/m.outer.func1")?.nestingPath).toHaveLength(1);
    expect(comp(fns.get("src/m.outer.func2"))).toBe(2);
    expect(comp(fns.get("src/m.outer.func3"))).toBe(1);
    expect(fns.get("src/m.outer")?.nestingPath).toEqual([]);
  });

  it("names nested closures <enclosing>.func<n>", () => {
    const fns = measure("export const f = () => { return () => { return () => 1; }; };\n");
    expect([...fns.keys()]).toEqual(["src/m.f", "src/m.f.func1", "src/m.f.func1.func1"]);
  });

  it("names classes, accessors, constructors and object methods", () => {
    const fns = measure(
      [
        "export class Box<T> {",
        "  value = () => 1;",
        "  constructor(private v: T) {}",
        "  get size() { return 1; }",
        "  set size(n: number) {}",
        "  static make<U>(u: U) { return new Box(u); }",
        "  async run() { return 1; }",
        "}",
        "export const api = {",
        "  get(id: string) { return id; },",
        "  put: (id: string) => id,",
        "};",
        "export default function () {}",
        "setup(() => {});",
        "module.exports = function () {};",
      ].join("\n"),
    );
    expect([...fns.keys()]).toEqual([
      "src/m.Box.value",
      "src/m.Box.constructor",
      "src/m.Box.get size",
      "src/m.Box.set size",
      "src/m.Box.make",
      "src/m.Box.run",
      "src/m.api.get",
      "src/m.api.put",
      "src/m.default",
      "src/m.glob.func1",
      "src/m.module.exports",
    ]);
  });

  it("skips overload signatures and declarations without a body", () => {
    const fns = measure("export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: any) { return a; }\ndeclare function g(): void;\n");
    expect([...fns.keys()]).toEqual(["src/m.f"]);
  });

  it("keeps each function's range from its declaration line to its closing line", () => {
    const f = measure("// doc\n@dec()\nexport class A {\n  @on()\n  m() {\n    return 1;\n  }\n}\n").get("src/m.A.m");
    expect([f?.start, f?.end]).toEqual([5, 7]);
  });

  it("attributes decorator expressions to the enclosing scope, not the method", () => {
    const fns = measure("export class A {\n  @dec(flag ? 1 : 2)\n  m() {\n    return 1;\n  }\n}\n");
    expect(kinds(fns.get("src/m.A.m"))).toEqual([]);
    expect(fns.get("src/m.A.m")?.start).toBe(3);
  });

  it("measures JavaScript and TSX files", () => {
    expect(measure("export function f(a) { return a || 1; }", "lib/x.js").get("lib/x.f")?.decisions).toHaveLength(1);
    expect(measure("export const C = () => <div>{1 && 2}</div>;", "ui/c.tsx").get("ui/c.C")?.decisions).toHaveLength(1);
  });
});
