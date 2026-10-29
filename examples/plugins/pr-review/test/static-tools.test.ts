// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GIT_ENV } from "../src/commands.js";
import { measurementState, staticCommand, metricsDiffCommand, type Batch } from "../src/measurements.js";
import { FLAGS_DOC, FLAGS_GO, REHEARSAL_HEAD_FILES, TTL_DOC, TTL_GO } from "../src/rehearsal.js";
import { pullFile } from "../src/snapshot.js";
import { parseHunkFile } from "../src/metrics/hunks.js";
import { validateMetricsDocument } from "../src/metrics/validate.js";
import { profileOf, root } from "./support.js";

const go = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function head(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-static-"));
  dirs.push(dir);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    writeFileSync(path.join(dir, p), text);
  }
  return dir;
}

/** Runs a static command as the command executor would: in the head directory, with a report file. */
function run(argv: string[], cwd: string): { code: number | null; report: string; stderr: string } {
  const reportFile = path.join(cwd, ".report-out");
  const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, GRAPHLOOM_REPORT_FILE: reportFile }, encoding: "utf8" });
  let report = "";
  try {
    report = readFileSync(reportFile, "utf8");
  } catch {
    /* the command wrote none */
  }
  return { code: r.status, report, stderr: r.stderr };
}

const batch = (language: "go" | "typescript", paths: string[]): Batch => ({ id: `static-${language}-1`, language, paths });

describe("the recorded gometrics documents", () => {
  it("recompute from the head bytes and the hunks of the fixture pull requests", () => {
    const flags = validateMetricsDocument(FLAGS_DOC, { readFile: (p) => REHEARSAL_HEAD_FILES[p], hunks: parseHunkFile("banyand/cmd/server/flags.go:14-17\n"), generated: [] });
    expect(flags).toEqual({ ok: true, errors: [] });
    const ttl = validateMetricsDocument(TTL_DOC, { readFile: (p) => REHEARSAL_HEAD_FILES[p], hunks: parseHunkFile("pkg/schema/ttl.go:1-35\n"), generated: [] });
    expect(ttl).toEqual({ ok: true, errors: [] });
  });
});

describe.skipIf(!go)("the confined static command, run for real (without the sandbox)", () => {
  it("measures a Go head with gometrics through the command the graph builds, and the document matches the recorded one", () => {
    const dir = head({ ...REHEARSAL_HEAD_FILES });
    const hunks = parseHunkFile("banyand/cmd/server/flags.go:14-17\n");
    const command = staticCommand(batch("go", ["banyand/cmd/server/flags.go"]), hunks, root, [], process.execPath);
    const result = run(command.argv, dir);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.report)).toEqual(FLAGS_DOC);
  }, 120_000);

  it("runs the resolved Go toolchain, not the first go on PATH (which a hidden home can hide)", () => {
    const dir = head({ ...REHEARSAL_HEAD_FILES });
    const hunks = parseHunkFile("banyand/cmd/server/flags.go:14-17\n");
    const goRoot = spawnSync("go", ["env", "GOROOT"], { encoding: "utf8" }).stdout.trim();
    const command = staticCommand(batch("go", ["banyand/cmd/server/flags.go"]), hunks, root, [], process.execPath, path.join(goRoot, "bin", "go"));
    expect(command.argv.at(-1)).toBe(path.join(goRoot, "bin", "go"));
    // No go anywhere on PATH: only the toolchain the command names can run.
    const pathWithoutGo = (process.env.PATH ?? "").split(path.delimiter).filter((d) => !existsSync(path.join(d, "go"))).join(path.delimiter);
    const reportFile = path.join(dir, ".report-out");
    const r = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: dir, env: { ...process.env, PATH: pathWithoutGo, GRAPHLOOM_REPORT_FILE: reportFile }, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(reportFile, "utf8"))).toEqual(FLAGS_DOC);
  }, 120_000);

  it("measures a TypeScript head with tsmetrics", () => {
    const dir = head({ "src/a.ts": "export function f(x: number) {\n  if (x > 1 && x < 5) {\n    return 1;\n  }\n  return 0;\n}\n" });
    const command = staticCommand(batch("typescript", ["src/a.ts"]), parseHunkFile("src/a.ts:1-6\n"), root, [], process.execPath);
    const result = run(command.argv, dir);
    expect(result.code, result.stderr).toBe(0);
    const doc = JSON.parse(result.report) as { tool: string; records: Array<{ function: string; complexity: number; change: string }> };
    expect(doc.tool).toBe("tsmetrics");
    expect(doc.records.map((r) => [r.function, r.complexity, r.change])).toEqual([["src/a.f", 3, "added"]]);
  });
});

describe("the diff command", () => {
  it("lists head-side changed lines of the worktree against the pinned base, with no global configuration", () => {
    const dir = head({ "a.go": "package a\n\nfunc A() {}\n" });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=a@b.c", "-c", "user.name=n", "add", ".");
    git("-c", "user.email=a@b.c", "-c", "user.name=n", "commit", "-q", "-m", "base");
    writeFileSync(path.join(dir, "a.go"), "package a\n\nfunc A() {\n\tprintln(1)\n}\n");
    writeFileSync(path.join(dir, "notes.md"), "not a measured file\n");
    git("-c", "user.email=a@b.c", "-c", "user.name=n", "add", "-N", "notes.md");
    const argv = metricsDiffCommand().argv;
    const report = path.join(dir, ".report-out");
    const out = spawnSync(argv[0]!, argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV, GRAPHLOOM_REPORT_FILE: report } });
    expect(out.status, out.stderr).toBe(0);
    // The diff goes to the report file, where a cut is flagged, and only files of a measured language are in it.
    expect(out.stdout).toBe("");
    const text = readFileSync(report, "utf8");
    expect(text).toContain("+++ b/a.go");
    expect(text).not.toContain("notes.md");
    expect(text).toMatch(/@@ -3(?:,\d+)? \+3(?:,\d+)? @@/);
    // The static state machine reads the same text.
    const state = measurementState([], [pullFile({ path: "a.go", status: "modified", patch: "@@ -3 +3,3 @@\n+x" })!], profileOf());
    expect(state.state).toBe("observe");
  });
});

describe("the TS fixture", () => {
  it("is a real Go file (the constants stay in step with the recorded documents)", () => {
    expect(FLAGS_GO.split("\n")[11]).toContain("func registerFlags");
    expect(TTL_GO.split("\n")[5]).toContain("func ParseTTL");
  });
});
