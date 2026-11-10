// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { judgeRun, parseReproReport, reproSpec, type Repro, type ReproLanguage } from "../src/repro.js";
import { writeChunks } from "../src/write.js";

/**
 * tools/repro/repro.sh run for real, without Docker (the container only adds confinement): the Go overlay mechanism and the
 * TypeScript scratch-file mechanism (design §8.2). Skipped where the toolchain is not there.
 */
const SCRIPT = fileURLToPath(new URL("../tools/repro/repro.sh", import.meta.url));
const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const ROOT = path.resolve(PLUGIN, "../../..");
const hasGo = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const hasVitest = existsSync(path.join(PLUGIN, "node_modules/.bin/vitest")) || existsSync(path.join(ROOT, "node_modules/.bin/vitest"));
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function runScript(cwd: string, language: ReproLanguage, finding: string, repro: Repro, workspace: string): { text: string; tmp: string } {
  const tmp = mkdtempSync(path.join(tmpdir(), "repro-tmp-"));
  scratch.push(tmp);
  const report = path.join(tmp, "report.txt");
  const spec = reproSpec({ finding, language, repro, workspace, timeoutSeconds: 120 });
  const parts = writeChunks(spec);
  const r = spawnSync("sh", [SCRIPT, String(parts.length), ...parts], { cwd, encoding: "utf8", env: { ...process.env, GRAPHLOOM_REPORT_FILE: report, GRAPHLOOM_REPRO_TMP: path.join(tmp, "work"), GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local" }, timeout: 240_000 });
  expect(r.status, r.stderr).toBe(0);
  return { text: readFileSync(report, "utf8"), tmp };
}

const judge = (text: string, finding: string, repro: Repro, language: ReproLanguage, cited: string) => {
  const planned = "SPEC";
  return judgeRun({ id: finding, path: cited }, repro, language, { record: { ref: "e" } as never, command: { id: `repro-${finding}`, argv: ["sh", "s", "1", planned], exitCode: 0, stdoutTail: text, stderrTail: "" } }, planned, undefined);
};

describe.skipIf(!hasGo)("repro.sh with Go: go test -overlay, the test never written into the checkout", () => {
  const mod = mkdtempSync(path.join(tmpdir(), "repro-go-"));
  scratch.push(mod);
  mkdirSync(path.join(mod, "pkg/schema"), { recursive: true });
  writeFileSync(path.join(mod, "go.mod"), "module example.com/schema\n\ngo 1.21\n");
  writeFileSync(path.join(mod, "pkg/schema/ttl.go"), 'package schema\n\nfunc parse(s string) int {\n\tif s == "7w" {\n\t\treturn 0\n\t}\n\treturn 1\n}\n\nfunc boom(s string) int {\n\tvar m map[string]int\n\tm[s] = 1\n\treturn m[s]\n}\n');
  const test = (name: string, body: string): Repro => ({ dir: "pkg/schema", name, expect: "assertion", oracle: "the PR text", text: `package schema\n\nimport "testing"\n\nfunc ${name}(t *testing.T) {\n${body}\n}\n` });

  it("reports a failing assertion twice, at a line of the test's own file, and the checkout stays as it was", () => {
    const repro = test("TestWeek", '\tif got := parse("7w"); got != 7 {\n\t\tt.Fatalf("parse(7w) = %d, want 7", got)\n\t}');
    const { text } = runScript(mod, "go", "F3", repro, ".");
    const parsed = parseReproReport(text);
    expect("error" in parsed ? parsed.error : parsed.runs.map((r) => r.outcome)).toEqual(["failed", "failed"]);
    expect(judge(text, "F3", repro, "go", "pkg/schema/ttl.go")).toMatchObject({ state: "proven", record: { at: "graphloom_repro_F3_test.go:7", failure: expect.stringContaining("parse(7w) = 0, want 7") } });
    expect(readdirSync(path.join(mod, "pkg/schema"))).toEqual(["ttl.go"]);
  });

  it("takes a failing subtest's location and message, with the outcome from the parent test", () => {
    const repro = test("TestSub", '\tt.Run("seven weeks", func(t *testing.T) {\n\t\tif got := parse("7w"); got != 7 {\n\t\t\tt.Fatalf("sub: parse(7w) = %d, want 7", got)\n\t\t}\n\t})');
    const { text } = runScript(mod, "go", "F11", repro, ".");
    expect(judge(text, "F11", repro, "go", "pkg/schema/ttl.go")).toMatchObject({ state: "proven", record: { runs: ["failed", "failed"], at: "graphloom_repro_F11_test.go:8", failure: expect.stringContaining("sub: parse(7w) = 0, want 7") } });
  });

  it("does not reproduce a test that passes, and calls a test that does not build inconclusive", () => {
    const passes = test("TestOther", '\tif parse("x") != 1 {\n\t\tt.Fatal("no")\n\t}');
    expect(judge(runScript(mod, "go", "F4", passes, ".").text, "F4", passes, "go", "pkg/schema/ttl.go")).toMatchObject({ state: "unproven", reason: "test does not fail" });
    const broken = test("TestBroken", "\tundefinedThing()");
    expect(judge(runScript(mod, "go", "F5", broken, ".").text, "F5", broken, "go", "pkg/schema/ttl.go")).toMatchObject({ state: "unproven", reason: "inconclusive (build failed)" });
  });

  it("proves an expected panic by a frame in the cited file, and refuses one that panics only in the test", () => {
    const inCode = { ...test("TestBoom", '\tboom("x")'), expect: "panic" as const };
    expect(judge(runScript(mod, "go", "F6", inCode, ".").text, "F6", inCode, "go", "pkg/schema/ttl.go")).toMatchObject({ state: "proven" });
    const inTest = { ...test("TestSelf", "\tvar m map[string]int\n\tm[\"a\"] = 1"), expect: "panic" as const };
    expect(judge(runScript(mod, "go", "F7", inTest, ".").text, "F7", inTest, "go", "pkg/schema/ttl.go")).toMatchObject({ state: "unproven", reason: expect.stringContaining("no frame in pkg/schema/ttl.go") });
  });
});

describe.skipIf(!hasVitest)("repro.sh with TypeScript: a scratch file with the repository's config and a resolveId hook", () => {
  const dir = "examples/plugins/pr-review/src";
  const ts = (name: string, expectation: string): Repro => ({ dir, name, expect: "assertion", oracle: "ids.ts's documented contract", text: `import { it, expect } from "vitest";\nimport { resolveId } from "./ids.js";\n\nit("${name}", () => {\n  ${expectation}\n});\n` });

  it("resolves the scratch file's relative imports as if it lived next to the module, and reports a failing assertion twice", () => {
    const repro = ts("resolves an unlisted id", 'expect(resolveId("F99", new Set(["F1"])).id).toBe("F99");');
    const { text } = runScript(ROOT, "typescript", "F8", repro, "auto");
    expect(judge(text, "F8", repro, "typescript", `${dir}/ids.ts`)).toMatchObject({ state: "proven", record: { at: "graphloom-repro-F8.test.ts:5", failure: expect.stringContaining("AssertionError") } });
    expect(existsSync(path.join(PLUGIN, "src/graphloom-repro-F8.test.ts"))).toBe(false);
  });

  it("does not reproduce a passing test, and cannot build one whose import does not resolve", () => {
    const passes = ts("resolves a listed id", 'expect(resolveId("F1", new Set(["F1"])).id).toBe("F1");');
    expect(judge(runScript(ROOT, "typescript", "F9", passes, "auto").text, "F9", passes, "typescript", `${dir}/ids.ts`)).toMatchObject({ state: "unproven", reason: "test does not fail" });
    const missing = { ...passes, text: passes.text.replace("./ids.js", "./no-such-module.js") };
    expect(judge(runScript(ROOT, "typescript", "F10", missing, "auto").text, "F10", missing, "typescript", `${dir}/ids.ts`)).toMatchObject({ state: "unproven", reason: "inconclusive (build failed)" });
  });

  it("runs only the scratch test in a repository whose config defines projects", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "repro-projects-"));
    scratch.push(repo);
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), '{ "name": "multi", "private": true, "devDependencies": { "vitest": "*" } }\n');
    writeFileSync(path.join(repo, "vitest.config.mjs"), 'export default { test: { projects: [{ test: { name: "unit", include: ["src/**/*.test.ts"] } }, { test: { name: "other", include: ["other/**/*.test.ts"] } }] } };\n');
    writeFileSync(path.join(repo, "src/own.test.ts"), 'import { it } from "vitest";\nit("the repo\'s own suite", () => {});\n');
    symlinkSync(path.join(ROOT, "node_modules"), path.join(repo, "node_modules"));
    const repro: Repro = { dir: "src", name: "fails", expect: "assertion", oracle: "the docs", text: 'import { it, expect } from "vitest";\n\nit("fails", () => {\n  expect(1).toBe(2);\n});\n' };
    expect(judge(runScript(repo, "typescript", "F12", repro, "auto").text, "F12", repro, "typescript", "src/mod.ts")).toMatchObject({ state: "proven", record: { runs: ["failed", "failed"] } });
  });
});
