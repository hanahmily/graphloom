// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { COMMAND } from "../src/kit/constants.js";
import { GIT_ENV } from "../src/kit/commands.js";
import { DIFF_HEADERS_AWK, diffGroupCommand, MAX_DIFF_BYTES, MEASURED_PATHSPECS, measurementState, metricsDiffCommand, renderMeasurements, splitDiffGroup, staticCommand, type Batch } from "../src/kit/measurements.js";
import { hunksFromUnifiedDiff } from "../src/kit/metrics/hunks.js";
import type { Hunks } from "../src/kit/metrics/record.js";
import { pullFile, type PullFile } from "../src/kit/snapshot.js";
import { BANYANDB, profileOf, root } from "./support.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const profile = profileOf({ metrics: { ...((BANYANDB as { metrics: object }).metrics), coverage: false } });

let n = 0;
const ref = (): string => `ev-${++n}`;
const fileEvidence = (p: string): EvidenceRecord => ({ ref: ref(), kind: "file", payload: { path: p, bytes: "package pkg\n\n" } }) as EvidenceRecord;

/** A recorded run of a command, as the controller keeps it: a report over its limit is cut and flagged. */
const commandEvidence = (command: EnvironmentCommand, report: string, exitCode = 0): EvidenceRecord => {
  const cut = Buffer.byteLength(report, "utf8") > 64 * 1024;
  return { ref: ref(), kind: "command", payload: { command: { id: command.id, argv: command.argv, exitCode, stdoutTail: "", stderrTail: exitCode === 0 ? "" : "fatal: bad object", report: { text: cut ? report.slice(-64 * 1024) : report, truncated: cut } } } } as EvidenceRecord;
};

/** A file's hunk headers as the diff command prints them: `hunks` one-line hunks at lines 1, 3, 5, … */
const headersOf = (p: string, hunks: number): string => `+++ b/${p}\n${Array.from({ length: hunks }, (_, i) => `@@ -${2 * i + 1},0 +${2 * i + 1} @@\n`).join("")}`;
const diffText = (paths: readonly string[], hunksOf: (p: string) => number): string => paths.map((p) => headersOf(p, hunksOf(p))).join("");

const emptyDoc = (b: Batch): string => JSON.stringify({ schema: "graphloom-metrics-v1", tool: "gometrics", records: [], files: b.paths.map((p) => ({ path: p, language: "go", test: false, functions: [] })), skipped: [] });
const toolEvidence = (b: Batch, hunks: Hunks): EvidenceRecord => commandEvidence(staticCommand(b, hunks, root, [], process.execPath), emptyDoc(b));

/** Answers every diff command the state asks for from `text`, until the measurement moves on; returns the evidence and the ids that ran. */
function answerDiffs(evidence: EvidenceRecord[], files: readonly PullFile[], text: (paths: readonly string[]) => string): string[] {
  const ran: string[] = [];
  for (let s = measurementState(evidence, files, profile); s.state === "diff"; s = measurementState(evidence, files, profile)) {
    for (const c of s.commands) {
      ran.push(c.id);
      // The paths a group names are its argv after the id (no renames here).
      const named = c.id === COMMAND.metricsDiff ? files.map((f) => f.path) : c.argv.slice(4);
      evidence.push(commandEvidence(c, text(named)));
    }
  }
  return ran;
}

describe("the changed lines of a large pull request (design §6.8)", () => {
  // 120 files, about 1 KB of hunk headers each: over MAX_DIFF_BYTES together, each half of a half under it.
  const paths = Array.from({ length: 120 }, (_, i) => `pkg/f${String(i + 1).padStart(3, "0")}.go`);
  const files = paths.map((p) => pullFile({ path: p, status: "added", patch: "@@ -0,0 +1,2 @@\n+package pkg\n+" })!);
  const hunksOf = (): number => 50;

  it("still read one command's report for every file when it fits, with the argv it always had", () => {
    const small = files.slice(0, 3);
    const evidence = small.map((f) => fileEvidence(f.path));
    const s = measurementState(evidence, small, profile);
    expect(s).toEqual({ state: "diff", commands: [metricsDiffCommand()] });
    expect(metricsDiffCommand()).toEqual({
      id: "metrics-diff",
      argv: ["sh", "-c", `set -eu; rc=$( { { git -c core.hooksPath=/dev/null diff -U0 -w --no-color --no-ext-diff --no-textconv HEAD -- "$@" && s=0 || s=$?; echo "$s" >&3; } | awk '${DIFF_HEADERS_AWK}' > "$GRAPHLOOM_REPORT_FILE"; } 3>&1 ); [ "$rc" = 0 ] || { echo "git diff exited $rc" >&2; exit 1; }`, "metrics-diff", ...MEASURED_PATHSPECS],
    });
    const ran = answerDiffs(evidence, small, (p) => diffText(p, hunksOf));
    expect(ran).toEqual(["metrics-diff"]);
    expect(measurementState(evidence, small, profile)).toMatchObject({ state: "tools", batches: [{ id: "static-go-1" }] });
  });

  it("reads the hunk headers in groups that each fit, measures every file, and recomputes from the evidence alone", () => {
    expect(Buffer.byteLength(diffText(paths, hunksOf))).toBeGreaterThan(MAX_DIFF_BYTES);
    const evidence = paths.map(fileEvidence);
    const ran = answerDiffs(evidence, files, (p) => diffText(p, hunksOf));
    expect(ran).toEqual(["metrics-diff", "metrics-diff-a", "metrics-diff-b"]);
    const s = measurementState(evidence, files, profile);
    expect(s.state).toBe("tools");
    if (s.state !== "tools") return;
    expect([...s.hunks.keys()]).toEqual(paths);
    expect(s.hunks.get(paths[119]!)).toHaveLength(50);
    for (const b of s.batches) evidence.push(toolEvidence(b, s.hunks));
    const ready = measurementState(evidence, files, profile);
    expect(ready.state, JSON.stringify(ready).slice(0, 400)).toBe("ready");
    if (ready.state !== "ready") return;
    expect(ready.excluded).toEqual([]);
    // Every diff run is cited: the root that did not fit, then the two groups.
    const diffRefs = evidence.filter((e) => (e.payload as { command?: { id: string } }).command?.id.startsWith("metrics-diff") === true).map((e) => e.ref);
    expect(ready.refs.slice(0, 3)).toEqual(diffRefs);
    // A validator (no retry, no tool root) recomputes the same groups and records.
    expect(measurementState(evidence, files, profile)).toEqual(ready);
  });

  it("splits a group again when its half still does not fit, in the measured files' order, with literal pathspecs", () => {
    const evidence = paths.map(fileEvidence);
    // The first 60 files are ten times as dense: the first half does not fit, its halves do.
    const dense = (p: string): number => (paths.indexOf(p) < 60 ? 100 : 5);
    const ran = answerDiffs(evidence, files, (p) => diffText(p, dense));
    expect(ran).toEqual(["metrics-diff", "metrics-diff-a", "metrics-diff-b", "metrics-diff-aa", "metrics-diff-ab"]);
    const [a] = splitDiffGroup({ id: COMMAND.metricsDiff, paths });
    const [aa] = splitDiffGroup(a);
    expect(aa).toEqual({ id: "metrics-diff-aa", paths: paths.slice(0, 30) });
    const command = diffGroupCommand(aa, files);
    expect(command.argv.slice(4)).toEqual(paths.slice(0, 30));
    expect(command.argv[2]).toContain("git --literal-pathspecs -c core.hooksPath=/dev/null diff -U0 -w");
    const s = measurementState(evidence, files, profile);
    expect(s.state).toBe("tools");
    if (s.state === "tools") expect([...s.hunks.keys()].sort()).toEqual(paths);
  });

  it("lists a single file whose own hunk headers do not fit as not measured, never a failed stage", () => {
    const evidence = paths.map(fileEvidence);
    const huge = paths[7]!;
    const over = (p: string): number => (p === huge ? 4000 : 50);
    expect(Buffer.byteLength(headersOf(huge, 4000))).toBeGreaterThan(MAX_DIFF_BYTES);
    const ran = answerDiffs(evidence, files, (p) => diffText(p, over));
    // 120 files halve to 60, 30, 15, 8, 4, 2 and finally the eighth file alone.
    expect(ran).toContain("metrics-diff-aaaabbb");
    const s = measurementState(evidence, files, profile);
    expect(s.state).toBe("tools");
    if (s.state !== "tools") return;
    expect(s.hunks.has(huge)).toBe(false);
    expect(s.batches.flatMap((b) => b.paths)).not.toContain(huge);
    expect(s.hunks.size).toBe(119);
    for (const b of s.batches) evidence.push(toolEvidence(b, s.hunks));
    const ready = measurementState(evidence, files, profile);
    expect(ready.state, JSON.stringify(ready).slice(0, 400)).toBe("ready");
    if (ready.state !== "ready") return;
    const reason = `its changed lines' hunk headers (git diff -U0) are over ${MAX_DIFF_BYTES} bytes, more than one command report holds whole`;
    expect(ready.excluded).toEqual([{ path: huge, reason }]);
    expect(renderMeasurements(ready, profile)).toContain(`Not measured: ${huge} (${reason}).`);
    expect(measurementState(evidence, files, profile)).toEqual(ready);
  });

  it("lists a single measured file again by name when the root over every file of its language does not fit", () => {
    const one = files.slice(0, 1);
    const evidence = [fileEvidence(paths[0]!)];
    // The root diff covers every *.go file, measured or not (a generated tree, a file outside the profile's globs): it does not fit.
    evidence.push(commandEvidence(metricsDiffCommand(), diffText(paths, hunksOf)));
    const s = measurementState(evidence, one, profile);
    const named = diffGroupCommand({ id: "metrics-diff-a", paths: [paths[0]!] }, one);
    expect(s).toEqual({ state: "diff", commands: [named] });
    evidence.push(commandEvidence(named, diffText([paths[0]!], hunksOf)));
    const next = measurementState(evidence, one, profile);
    expect(next.state).toBe("tools");
    if (next.state === "tools") expect([...next.hunks.keys()]).toEqual([paths[0]]);
  });

  it("does not count a group's run from before its parent's, nor a foreign command under a group's id", () => {
    const evidence = paths.map(fileEvidence);
    const [a, b] = splitDiffGroup({ id: COMMAND.metricsDiff, paths }).map((g) => diffGroupCommand(g, files));
    // A run of a group recorded before the root's: stale.
    evidence.push(commandEvidence(a!, diffText(paths.slice(0, 60), hunksOf)));
    evidence.push(commandEvidence(metricsDiffCommand(), diffText(paths, hunksOf)));
    evidence.push(commandEvidence({ id: b!.id, argv: ["sh", "-c", "echo diagnostic"] }, ""));
    const s = measurementState(evidence, files, profile);
    expect(s).toEqual({ state: "diff", commands: [a, b] });
  });

  it("hands a failed group to the supervisor, and runs it again after the operator's resume", () => {
    const evidence = paths.map(fileEvidence);
    evidence.push(commandEvidence(metricsDiffCommand(), diffText(paths, hunksOf)));
    const [a, b] = splitDiffGroup({ id: COMMAND.metricsDiff, paths }).map((g) => diffGroupCommand(g, files));
    evidence.push(commandEvidence(a!, diffText(paths.slice(0, 60), hunksOf)));
    const failed = commandEvidence(b!, "", 128);
    evidence.push(failed);
    const s = measurementState(evidence, files, profile);
    expect(s).toMatchObject({ state: "failed", refs: [expect.any(String), failed.ref], retry: [] });
    expect(measurementState(evidence, files, profile, (r) => r.record.ref === failed.ref)).toEqual({ state: "diff", commands: [b] });
  });
});

describe("a diff group's command", () => {
  it("lists only its own files' hunk headers, with the hunks the whole diff gives them, a renamed file paired with its base path", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-diffgroup-"));
    dirs.push(dir);
    const write = (p: string, text: string): void => {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), text);
    };
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
    const body = (name: string, n: number): string => `package a\n\n${Array.from({ length: n }, (_, i) => `func ${name}${i}() {}\n`).join("")}`;
    write("a/one.go", body("One", 20));
    write("a/old.go", body("Old", 20));
    write("a/three.go", body("Three", 5));
    git("init", "-q", "-b", "main");
    git("-c", "user.email=a@b.c", "-c", "user.name=n", "add", ".");
    git("-c", "user.email=a@b.c", "-c", "user.name=n", "commit", "-q", "-m", "base");
    write("a/one.go", body("One", 20).replace("func One3() {}", "func One3() { println(3) }"));
    git("mv", "a/old.go", "a/new.go");
    write("a/new.go", body("Old", 20).replace("func Old7() {}", "func Old7() { println(7) }"));
    write("a/three.go", `${body("Three", 5)}func Three9() {}\n`);
    const files = [
      pullFile({ path: "a/one.go", status: "modified", patch: "@@ -5 +5 @@\n-x\n+y" })!,
      pullFile({ path: "a/new.go", status: "renamed", previousPath: "a/old.go", patch: "@@ -9 +9 @@\n-x\n+y" })!,
      pullFile({ path: "a/three.go", status: "modified", patch: "@@ -7,0 +8 @@\n+y" })!,
    ];
    expect(files[1]!.previousPath).toBe("a/old.go");
    const run = (c: EnvironmentCommand): string => {
      const report = path.join(dir, `.report-${c.id}`);
      const out = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV, GRAPHLOOM_REPORT_FILE: report } });
      expect(out.status, out.stderr).toBe(0);
      return readFileSync(report, "utf8");
    };
    const whole = hunksFromUnifiedDiff(run(metricsDiffCommand()), { headersOnly: true });
    const [first, second] = splitDiffGroup({ id: COMMAND.metricsDiff, paths: files.map((f) => f.path) });
    const firstCommand = diffGroupCommand(first, files);
    expect(firstCommand.argv.slice(4)).toEqual(["a/one.go", "a/old.go", "a/new.go"]);
    const a = hunksFromUnifiedDiff(run(firstCommand), { headersOnly: true });
    const b = hunksFromUnifiedDiff(run(diffGroupCommand(second, files)), { headersOnly: true });
    expect([...a.keys()].sort()).toEqual(["a/new.go", "a/one.go"]);
    expect([...b.keys()]).toEqual(["a/three.go"]);
    expect(new Map([...a, ...b])).toEqual(whole);
    // The renamed file is diffed against its base path, not read as wholly added.
    expect(a.get("a/new.go")).toEqual(whole.get("a/new.go"));
    expect(a.get("a/new.go")!.length).toBe(1);
  });
});
