// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  formatHunkFile,
  hunksFromUnifiedDiff,
  validateMetricsDocument,
  type Hunks,
  type MetricsDocument,
} from "../src/metrics/index.js";

const toolDir = fileURLToPath(new URL("../tools/gometrics", import.meta.url));
const tsCli = fileURLToPath(new URL("../dist/metrics/tsmetrics-cli.js", import.meta.url));
const hasGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
if (!hasGo) {
  console.warn("gometrics tests skipped: `go` is not on PATH");
}
const goIt = hasGo ? it : it.skip;

let bin: string;
let scratch: string;

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Commits base then head into a repo, returns the repo dir and the -U0 -w diff's head hunks. */
function twoCommits(base: Record<string, string>, head: Record<string, string>): { dir: string; hunks: Hunks } {
  const dir = mkdtempSync(path.join(scratch, "repo-"));
  git(dir, "init", "-q");
  const put = (files: Record<string, string>): void => {
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), body);
    }
  };
  put(base);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  put(head);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "head");
  return { dir, hunks: hunksFromUnifiedDiff(git(dir, "diff", "-U0", "-w", "HEAD~1", "HEAD")) };
}

function runGo(dir: string, hunks: Hunks, generated = ""): MetricsDocument {
  const hunkFile = path.join(scratch, `hunks-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(hunkFile, formatHunkFile(hunks));
  const r = spawnSync(bin, ["--head", dir, "--hunks", hunkFile, "--generated", generated], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gometrics exit ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as MetricsDocument;
}

const validate = (dir: string, doc: MetricsDocument, hunks: Hunks, generated: string[] = []) =>
  validateMetricsDocument(doc, {
    readFile: (p) => {
      try {
        return readFileSync(path.join(dir, p), "utf8");
      } catch {
        return undefined;
      }
    },
    hunks,
    generated,
  });

beforeAll(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "gl-gometrics-"));
  if (!hasGo) return;
  bin = path.join(scratch, "gometrics");
  const r = spawnSync("go", ["build", "-o", bin, "."], { cwd: toolDir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`go build failed: ${r.stderr}`);
}, 120_000);

describe("gometrics", () => {
  goIt("passes its own go tests (gocyclo corpus, nesting and scope fixtures)", () => {
    const r = spawnSync("go", ["test", "-count=1", "./..."], { cwd: toolDir, encoding: "utf8" });
    expect(r.stderr + r.stdout).toMatch(/^ok\s+gometrics/m);
    expect(r.status).toBe(0);
  }, 120_000);

  goIt("has no dependencies beyond the standard library", () => {
    expect(readFileSync(path.join(toolDir, "go.mod"), "utf8")).not.toMatch(/^require|^\s+\S+\s+v\d/m);
  });

  const BASE = [
    "package schema",
    "",
    "type Box[T any] struct{ v T }",
    "",
    "func (b *Box[T]) Get() T {",
    "\treturn b.v",
    "}",
    "",
    "func Keep(a int) int {",
    "\tif a > 0 {",
    "\t\treturn a",
    "\t}",
    "\treturn 0",
    "}",
    "",
  ].join("\n");

  goIt("ignores a whitespace-only change when hunks come from git diff -w", () => {
    const head = BASE.replace("\tif a > 0 {", "    if a > 0 {   ").replace("\t\treturn a", "\t\t\treturn   a");
    const { dir, hunks } = twoCommits({ "schema/s.go": BASE }, { "schema/s.go": head });
    expect(hunks.size).toBe(0);
    const doc = runGo(dir, hunks);
    expect(doc.records).toEqual([]);
  });

  goIt("reports added and modified functions, receivers, generics and closures, and validates", () => {
    const head = [
      BASE.replace("\treturn b.v", "\tif b == nil {\n\t\tvar z T\n\t\treturn z\n\t}\n\treturn b.v"),
      "func Added[K comparable](m map[K]int) int {",
      "\ttotal := 0",
      "\tadd := func(n int) {",
      "\t\tif n > 0 && n < 100 {",
      "\t\t\ttotal += n",
      "\t\t}",
      "\t}",
      "\tfor _, v := range m {",
      "\t\tadd(v)",
      "\t}",
      "\treturn total",
      "}",
      "",
    ].join("\n");
    const { dir, hunks } = twoCommits({ "schema/s.go": BASE }, { "schema/s.go": head });
    const doc = runGo(dir, hunks);
    expect(doc.records.map((r) => [r.function, r.change, r.complexity, r.nesting])).toEqual([
      ["schema.(*Box[...]).Get", "modified", 2, 1],
      ["schema.Added[...]", "added", 2, 1],
      ["schema.Added[...].func1", "added", 3, 1],
    ]);
    expect(doc.files[0]?.functions.map((f) => f[0])).toEqual([
      "schema.(*Box[...]).Get",
      "schema.Keep",
      "schema.Added[...]",
      "schema.Added[...].func1",
    ]);
    expect(validate(dir, doc, hunks)).toEqual({ ok: true, errors: [] });
  });

  goIt("skips generated files by header and by glob, and marks tests", () => {
    const gen = "// Code generated by x. DO NOT EDIT.\n\npackage a\n\nfunc G(x int) int {\n\tif x > 0 {\n\t\treturn 1\n\t}\n\treturn 0\n}\n";
    const files = {
      "a/gen.go": gen,
      "a/api.pb.go": "package a\n\nfunc P(x int) int {\n\tif x > 0 {\n\t\treturn 1\n\t}\n\treturn 0\n}\n",
      "a/a_test.go": "package a\n\nimport \"testing\"\n\nfunc TestX(t *testing.T) {\n\tif 1 > 2 {\n\t\tt.Fatal()\n\t}\n}\n",
    };
    const { dir, hunks } = twoCommits({ "README.md": "x\n" }, { ...files, "README.md": "x\ny\n" });
    const doc = runGo(dir, hunks, "**/*.pb.go");
    expect(doc.skipped).toEqual([
      { path: "README.md", reason: "unsupported-language" },
      { path: "a/api.pb.go", reason: "generated" },
      { path: "a/gen.go", reason: "generated" },
    ]);
    expect(doc.records.map((r) => [r.function, r.test, r.complexity])).toEqual([["a.TestX", true, 2]]);
    expect(validate(dir, doc, hunks, ["**/*.pb.go"])).toEqual({ ok: true, errors: [] });
    // Without the glob the validator sees an unexplained skip.
    expect(validate(dir, doc, hunks).ok).toBe(false);
  });

  goIt("uses physical lines despite //line directives, and emits [] for bodyless declarations", () => {
    const src = [
      "package a",
      "",
      "//line other.go:100",
      "func Moved(x int) int {",
      "\tif x > 0 {",
      "\t\treturn x",
      "\t}",
      "\treturn 0",
      "}",
      "",
      "func external()",
      "",
    ].join("\n");
    const { dir, hunks } = twoCommits({ "a.txt": "x" }, { "a.go": src });
    const doc = runGo(dir, hunks);
    expect(doc.records.map((r) => [r.function, r.startLine, r.endLine, r.complexity])).toEqual([
      ["a.Moved", 4, 9, 2],
      ["a.external", 11, 11, 1],
    ]);
    expect(doc.records[1]?.nestingPath).toEqual([]);
    expect(validate(dir, doc, hunks)).toEqual({ ok: true, errors: [] });
  });

  goIt("fails loudly on a Go file that does not parse", () => {
    const { dir } = twoCommits({ "a.txt": "x" }, { "bad.go": "package a\nfunc {" });
    const hunkFile = path.join(scratch, "bad-hunks.txt");
    writeFileSync(hunkFile, "bad.go:1-2\n");
    const r = spawnSync(bin, ["--head", dir, "--hunks", hunkFile], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/bad\.go/);
  });

  goIt("reads hunks from stdin and refuses bad usage", () => {
    const { dir } = twoCommits({ "a.txt": "x" }, { "a.go": "package a\n\nfunc F() {}\n" });
    const ok = spawnSync(bin, ["--head", dir, "--hunks", "-"], { input: "a.go:1-3\n", encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect((JSON.parse(ok.stdout) as MetricsDocument).records[0]?.function).toBe("a.F");
    expect(spawnSync(bin, [], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(bin, ["--head", dir, "--hunks", "-"], { input: "garbage\n", encoding: "utf8" }).status).toBe(2);
  });
});

describe("tsmetrics CLI", () => {
  it("emits a document the validator accepts, from a real git diff -w", () => {
    const base = "export function keep(a: number) {\n  if (a > 0) {\n    return a;\n  }\n  return 0;\n}\n";
    const head = `${base.replace("  if (a > 0) {", "    if (a > 0) {")}\nexport const added = (xs: number[]) => {\n  for (const x of xs) {\n    if (x ?? 0) return x;\n  }\n  return 0;\n};\n`;
    const { dir, hunks } = twoCommits({ "src/k.ts": base }, { "src/k.ts": head, "src/gen.ts": "// @generated\nexport const g = (a: number) => a && 1;\n" });
    const hunkFile = path.join(scratch, "ts-hunks.txt");
    writeFileSync(hunkFile, formatHunkFile(hunks));
    const r = spawnSync(process.execPath, [tsCli, "--head", dir, "--hunks", hunkFile, "--generated", ""], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as MetricsDocument;
    expect(doc.tool).toBe("tsmetrics");
    expect(doc.records.map((x) => [x.function, x.change, x.complexity, x.nesting])).toEqual([
      ["src/k.added", "added", 4, 2],
    ]);
    expect(doc.skipped).toEqual([{ path: "src/gen.ts", reason: "generated" }]);
    expect(validate(dir, doc, hunks)).toEqual({ ok: true, errors: [] });
  });

  it("refuses bad usage", () => {
    expect(spawnSync(process.execPath, [tsCli], { encoding: "utf8" }).status).toBe(2);
  });
});
