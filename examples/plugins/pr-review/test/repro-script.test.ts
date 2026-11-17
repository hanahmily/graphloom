// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { judgeRun, parseReproReport, reproSpec, type Repro, type ReproLanguage } from "../src/repro.js";
import { writeChunks } from "../src/kit/write.js";

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

interface ScriptOptions {
  /** The profile's sandboxed setup, as the plan carries it. */
  setup?: Array<{ id: string; argv: string[] }>;
  setupSeconds?: number;
  buildTags?: string[];
  /** More environment: GRAPHLOOM_SETUP_CACHE, as the confinement gives it. */
  env?: Record<string, string>;
}

function runScript(cwd: string, language: ReproLanguage, finding: string, repro: Repro, workspace: string, options: ScriptOptions = {}): { text: string; tmp: string } {
  const tmp = mkdtempSync(path.join(tmpdir(), "repro-tmp-"));
  scratch.push(tmp);
  const report = path.join(tmp, "report.txt");
  const spec = reproSpec({ finding, language, repro, workspace, timeoutSeconds: 120, ...(options.setup !== undefined ? { setup: options.setup } : {}), ...(options.setupSeconds !== undefined ? { setupSeconds: options.setupSeconds } : {}), ...(options.buildTags !== undefined ? { buildTags: options.buildTags } : {}) });
  const parts = writeChunks(spec);
  const r = spawnSync("sh", [SCRIPT, String(parts.length), ...parts], { cwd, encoding: "utf8", env: { ...process.env, GRAPHLOOM_REPORT_FILE: report, GRAPHLOOM_REPRO_TMP: path.join(tmp, "work"), GOFLAGS: "-mod=mod", GOPROXY: "off", GOTOOLCHAIN: "local", ...options.env }, timeout: 240_000 });
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

describe.skipIf(!hasGo)("repro.sh with Go and the profile's sandboxed setup: a package that needs code only the setup generates (design §8.2)", () => {
  // As BanyanDB's api/proto/... Go code: the repository does not commit it, and the package under review imports it.
  const counter = mkdtempSync(path.join(tmpdir(), "repro-setup-count-"));
  scratch.push(counter);
  const runs = path.join(counter, "runs");
  /** A fresh checkout of the head, as each job gets its own. */
  const checkout = (): string => {
    const mod = mkdtempSync(path.join(tmpdir(), "repro-setup-"));
    scratch.push(mod);
    mkdirSync(path.join(mod, "pkg/ttl"), { recursive: true });
    writeFileSync(path.join(mod, "go.mod"), "module example.com/gen\n\ngo 1.21\n");
    writeFileSync(path.join(mod, "pkg/ttl/ttl.go"), 'package ttl\n\nimport v1 "example.com/gen/api/v1"\n\n// Unit is the unit a week is stored in.\nfunc Unit() string { return v1.Unit }\n');
    return mod;
  };
  const gen = { id: "proto", argv: ["sh", "-c", `echo run >> '${runs}'; mkdir -p api/v1 && printf 'package v1\\n\\nconst Unit = "w"\\n' > api/v1/v1.go`] };
  const repro: Repro = { dir: "pkg/ttl", name: "TestWeekUnit", expect: "assertion", oracle: "the PR text says a week is stored in days", text: 'package ttl\n\nimport "testing"\n\nfunc TestWeekUnit(t *testing.T) {\n\tif got := Unit(); got != "d" {\n\t\tt.Fatalf("Unit() = %q, want d", got)\n\t}\n}\n' };
  const judged = (text: string, finding: string) => judge(text, finding, repro, "go", "pkg/ttl/ttl.go");
  const count = (): number => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter((l) => l !== "").length : 0);

  it("without the setup the package does not build: the generated package is missing, as in the BanyanDB run", () => {
    expect(judged(runScript(checkout(), "go", "F1", repro, ".").text, "F1")).toMatchObject({ state: "unproven", reason: "inconclusive (build failed)" });
  });

  it("with the setup, generates the package first, then builds and runs the test; the test is still never written into the checkout", () => {
    const mod = checkout();
    const { text } = runScript(mod, "go", "F2", repro, ".", { setup: [gen], setupSeconds: 60 });
    expect(parseReproReport(text)).toMatchObject({ setup: ["proto"], setupRestored: false });
    expect(judged(text, "F2")).toMatchObject({ state: "proven", record: { runs: ["failed", "failed"], at: "graphloom_repro_F2_test.go:7", failure: expect.stringContaining('Unit() = "w", want d') } });
    expect(readdirSync(path.join(mod, "pkg/ttl"))).toEqual(["ttl.go"]);
    expect(readdirSync(path.join(mod, "api/v1"))).toEqual(["v1.go"]);
  });

  it("a failing setup step names the step and its first error line, never a build failure, and no test runs", () => {
    const broken = { id: "mocks", argv: ["sh", "-c", "echo 'generating mocks'; echo 'mockgen: error: package example.com/gen/api/v1 not found' >&2; echo 'more noise'; exit 3"] };
    const { text } = runScript(checkout(), "go", "F3", repro, ".", { setup: [gen, broken], setupSeconds: 60 });
    expect(parseReproReport(text)).toMatchObject({ setup: ["proto"], setupStep: { id: "mocks", exit: 3 }, runs: [] });
    expect(judged(text, "F3")).toEqual({ state: "unproven", reason: "the sandbox setup failed (mocks: mockgen: error: package example.com/gen/api/v1 not found)", record: expect.objectContaining({ runs: [] }) });
  });

  it("a setup that outlasts its time is stopped and says so", () => {
    const slow = { id: "slow", argv: ["sh", "-c", "sleep 20"] };
    const { text } = runScript(checkout(), "go", "F4", repro, ".", { setup: [slow], setupSeconds: 1 });
    expect(judged(text, "F4")).toMatchObject({ state: "unproven", reason: "the sandbox setup failed (slow: did not finish within 1s)" });
  });

  it("with the run's setup store, runs the setup once per head: a later job's fresh checkout copies its output, and a failure is reported again without running", () => {
    const store = mkdtempSync(path.join(tmpdir(), "repro-setup-store-"));
    scratch.push(store);
    const env = { GRAPHLOOM_SETUP_CACHE: store };
    const before = count();
    const first = runScript(checkout(), "go", "F5", repro, ".", { setup: [gen], setupSeconds: 60, env }).text;
    expect(parseReproReport(first)).toMatchObject({ setup: ["proto"], setupRestored: false });
    const second = checkout();
    const again = runScript(second, "go", "F6", repro, ".", { setup: [gen], setupSeconds: 60, env }).text;
    expect(parseReproReport(again)).toMatchObject({ setup: ["proto"], setupRestored: true });
    expect(judged(again, "F6")).toMatchObject({ state: "proven" });
    expect(count()).toBe(before + 1);
    expect(readFileSync(path.join(second, "api/v1/v1.go"), "utf8")).toContain('const Unit = "w"');
    // A different head (other files) is another key: its setup runs.
    const other = checkout();
    writeFileSync(path.join(other, "pkg/ttl/doc.go"), "package ttl\n");
    expect(parseReproReport(runScript(other, "go", "F7", repro, ".", { setup: [gen], setupSeconds: 60, env }).text)).toMatchObject({ setupRestored: false });
    expect(count()).toBe(before + 2);
    // A failure is kept too: the next test of the head says the same without running the step again.
    const failing = { id: "mocks", argv: ["sh", "-c", `echo run >> '${runs}'; echo 'boom: error here' >&2; exit 2`] };
    const f8 = runScript(checkout(), "go", "F8", repro, ".", { setup: [failing], setupSeconds: 60, env }).text;
    const f9 = runScript(checkout(), "go", "F9", repro, ".", { setup: [failing], setupSeconds: 60, env }).text;
    expect(judged(f8, "F8")).toMatchObject({ reason: "the sandbox setup failed (mocks: boom: error here)" });
    expect(judged(f9, "F9")).toMatchObject({ reason: "the sandbox setup failed (mocks: boom: error here)" });
    expect(count()).toBe(before + 3);
  });

  it("keeps a file the setup wrote with an old, preserved timestamp, and a file it deleted stays deleted on restore: contents are compared, not mtimes", () => {
    const store = mkdtempSync(path.join(tmpdir(), "repro-setup-store-"));
    scratch.push(store);
    const env = { GRAPHLOOM_SETUP_CACHE: store };
    // As `cp -p` or an archive extraction: the generated file carries a timestamp from long before the steps started.
    const preserved = { id: "proto", argv: ["sh", "-c", `echo run >> '${runs}'; s=$(mktemp); printf 'package v1\\n\\nconst Unit = "w"\\n' > "$s"; touch -t 200001010000 "$s"; mkdir -p api/v1 && cp -p "$s" api/v1/v1.go; rm -f "$s" obsolete.txt`] };
    const withObsolete = (): string => {
      const mod = checkout();
      writeFileSync(path.join(mod, "obsolete.txt"), "removed by the setup\n");
      return mod;
    };
    const before = count();
    expect(parseReproReport(runScript(withObsolete(), "go", "F10", repro, ".", { setup: [preserved], setupSeconds: 60, env }).text)).toMatchObject({ setupRestored: false });
    const second = withObsolete();
    const again = runScript(second, "go", "F11", repro, ".", { setup: [preserved], setupSeconds: 60, env }).text;
    expect(parseReproReport(again)).toMatchObject({ setup: ["proto"], setupRestored: true });
    expect(judged(again, "F11")).toMatchObject({ state: "proven" });
    expect(count()).toBe(before + 1);
    expect(readFileSync(path.join(second, "api/v1/v1.go"), "utf8")).toContain('const Unit = "w"');
    expect(existsSync(path.join(second, "obsolete.txt"))).toBe(false);
  });

  it("keeps a symbolic link the setup made and a mode it changed: the restored checkout has both", () => {
    const store = mkdtempSync(path.join(tmpdir(), "repro-setup-store-"));
    scratch.push(store);
    const env = { GRAPHLOOM_SETUP_CACHE: store };
    // The generated package is a link to a file the setup writes; helper.sh, already in the checkout, is made executable.
    const linking = { id: "proto", argv: ["sh", "-c", `echo run >> '${runs}'; mkdir -p api/v1 gen && printf 'package v1\\n\\nconst Unit = "w"\\n' > gen/target.go.txt && ln -s ../../gen/target.go.txt api/v1/v1.go && chmod +x helper.sh`] };
    const withHelper = (): string => {
      const mod = checkout();
      writeFileSync(path.join(mod, "helper.sh"), "#!/bin/sh\necho helper\n", { mode: 0o644 });
      return mod;
    };
    const before = count();
    expect(parseReproReport(runScript(withHelper(), "go", "F13", repro, ".", { setup: [linking], setupSeconds: 60, env }).text)).toMatchObject({ setupRestored: false });
    const second = withHelper();
    const again = runScript(second, "go", "F14", repro, ".", { setup: [linking], setupSeconds: 60, env }).text;
    expect(parseReproReport(again)).toMatchObject({ setup: ["proto"], setupRestored: true });
    expect(count()).toBe(before + 1);
    expect(judged(again, "F14")).toMatchObject({ state: "proven" });
    expect(lstatSync(path.join(second, "api/v1/v1.go")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(second, "api/v1/v1.go"))).toBe("../../gen/target.go.txt");
    expect(statSync(path.join(second, "helper.sh")).mode & 0o111).not.toBe(0);
  });

  it("keeps directories: a new empty one, a mode it changed, and one it removed", () => {
    const store = mkdtempSync(path.join(tmpdir(), "repro-setup-store-"));
    scratch.push(store);
    const env = { GRAPHLOOM_SETUP_CACHE: store };
    const dirs = { id: "proto", argv: ["sh", "-c", `echo run >> '${runs}'; mkdir -p api/v1 && printf 'package v1\\n\\nconst Unit = "w"\\n' > api/v1/v1.go && mkdir -p fixtures/empty && chmod 700 pkg/ttl && rm -rf old`] };
    const withOld = (): string => {
      const mod = checkout();
      mkdirSync(path.join(mod, "old/inner"), { recursive: true });
      writeFileSync(path.join(mod, "old/inner/stale.txt"), "stale\n");
      return mod;
    };
    const before = count();
    expect(parseReproReport(runScript(withOld(), "go", "F15", repro, ".", { setup: [dirs], setupSeconds: 60, env }).text)).toMatchObject({ setupRestored: false });
    const second = withOld();
    expect(statSync(path.join(second, "pkg/ttl")).mode & 0o777).not.toBe(0o700);
    const again = runScript(second, "go", "F16", repro, ".", { setup: [dirs], setupSeconds: 60, env }).text;
    expect(parseReproReport(again)).toMatchObject({ setup: ["proto"], setupRestored: true });
    expect(count()).toBe(before + 1);
    expect(judged(again, "F16")).toMatchObject({ state: "proven" });
    expect(statSync(path.join(second, "fixtures/empty")).isDirectory()).toBe(true);
    expect(readdirSync(path.join(second, "fixtures/empty"))).toEqual([]);
    expect(statSync(path.join(second, "pkg/ttl")).mode & 0o777).toBe(0o700);
    expect(existsSync(path.join(second, "old"))).toBe(false);
  });

  it("names the first error of the step's whole output, though more than 25 progress lines follow it", () => {
    const noisy = { id: "mocks", argv: ["sh", "-c", "echo 'mockgen: error: cannot load package example.com/gen/api/v1'; i=0; while [ $i -lt 30 ]; do echo \"progress $i\"; i=$((i+1)); done; exit 1"] };
    const { text } = runScript(checkout(), "go", "F12", repro, ".", { setup: [noisy], setupSeconds: 60 });
    expect(judged(text, "F12")).toMatchObject({ state: "unproven", reason: "the sandbox setup failed (mocks: mockgen: error: cannot load package example.com/gen/api/v1)" });
  });
});

describe.skipIf(!hasGo)("repro.sh with Go and the profile's build tags: a package with tag-guarded files builds as coverage's does", () => {
  const mod = mkdtempSync(path.join(tmpdir(), "repro-tags-"));
  scratch.push(mod);
  mkdirSync(path.join(mod, "pkg/q"), { recursive: true });
  writeFileSync(path.join(mod, "go.mod"), "module example.com/q\n\ngo 1.21\n");
  writeFileSync(path.join(mod, "pkg/q/q.go"), "package q\n\n// Count counts what the query saw.\nfunc Count() int { return metric() }\n");
  // Only built with -tags=querymetrics, as BanyanDB's query metrics are.
  writeFileSync(path.join(mod, "pkg/q/metrics.go"), "//go:build querymetrics\n\npackage q\n\nfunc metric() int { return 1 }\n");
  const repro: Repro = { dir: "pkg/q", name: "TestCount", expect: "assertion", oracle: "the PR text", text: 'package q\n\nimport "testing"\n\nfunc TestCount(t *testing.T) {\n\tif Count() != 2 {\n\t\tt.Fatalf("Count() = %d, want 2", Count())\n\t}\n}\n' };

  it("passes -tags to go test: without it the package does not build, with it the test runs and fails at its assertion", () => {
    expect(judge(runScript(mod, "go", "F1", repro, ".").text, "F1", repro, "go", "pkg/q/q.go")).toMatchObject({ state: "unproven", reason: "inconclusive (build failed)" });
    expect(judge(runScript(mod, "go", "F2", repro, ".", { buildTags: ["querymetrics"] }).text, "F2", repro, "go", "pkg/q/q.go")).toMatchObject({ state: "proven", record: { failure: expect.stringContaining("Count() = 1, want 2") } });
  });
});

describe.skipIf(!hasVitest)("repro.sh with TypeScript: a scratch file with the repository's config and a resolveId hook", () => {
  const dir = "examples/plugins/pr-review/src";
  const ts = (name: string, expectation: string): Repro => ({ dir, name, expect: "assertion", oracle: "secrets.ts's documented contract", text: `import { it, expect } from "vitest";\nimport { secretFindings } from "./secrets.js";\n\nit("${name}", () => {\n  ${expectation}\n});\n` });

  it("resolves the scratch file's relative imports as if it lived next to the module, and reports a failing assertion twice", () => {
    const repro = ts("finds a token in plain text", 'expect(secretFindings("no credential here")).toEqual(["line 1: a GitHub token"]);');
    const { text } = runScript(ROOT, "typescript", "F8", repro, "auto");
    expect(judge(text, "F8", repro, "typescript", `${dir}/secrets.ts`)).toMatchObject({ state: "proven", record: { at: "graphloom-repro-F8.test.ts:5", failure: expect.stringContaining("AssertionError") } });
    expect(existsSync(path.join(PLUGIN, "src/graphloom-repro-F8.test.ts"))).toBe(false);
  });

  it("does not reproduce a passing test, and cannot build one whose import does not resolve", () => {
    const passes = ts("finds nothing in plain text", 'expect(secretFindings("no credential here")).toEqual([]);');
    expect(judge(runScript(ROOT, "typescript", "F9", passes, "auto").text, "F9", passes, "typescript", `${dir}/secrets.ts`)).toMatchObject({ state: "unproven", reason: "test does not fail" });
    const missing = { ...passes, text: passes.text.replace("./secrets.js", "./no-such-module.js") };
    expect(judge(runScript(ROOT, "typescript", "F10", missing, "auto").text, "F10", missing, "typescript", `${dir}/secrets.ts`)).toMatchObject({ state: "unproven", reason: "inconclusive (build failed)" });
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
