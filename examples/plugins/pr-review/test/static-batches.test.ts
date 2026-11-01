// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { COMMAND } from "../src/constants.js";
import { BATCH_FILES, batchesOf, measurable, measurementState, renderMeasurements, splitBatch, staticCommand, type Batch } from "../src/measurements.js";
import { parseHunkFile } from "../src/metrics/hunks.js";
import { pullFile } from "../src/snapshot.js";
import { BANYANDB, profileOf, root } from "./support.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const profile = profileOf({ metrics: { ...((BANYANDB as { metrics: object }).metrics), coverage: false } });
const paths = Array.from({ length: 5 }, (_, i) => `pkg/f${i + 1}.go`);
const files = paths.map((p) => pullFile({ path: p, status: "added", patch: "@@ -0,0 +1,2 @@\n+package pkg\n+" })!);
const hunks = parseHunkFile(paths.map((p) => `${p}:1-2\n`).join(""));

let n = 0;
const ref = (): string => `ev-${++n}`;
const fileEvidence = (p: string): EvidenceRecord => ({ ref: ref(), kind: "file", payload: { path: p, bytes: "package pkg\n\n" } }) as EvidenceRecord;
const diffEvidence = (): EvidenceRecord =>
  ({ ref: ref(), kind: "command", payload: { command: { id: COMMAND.metricsDiff, argv: [], exitCode: 0, stdoutTail: "", stderrTail: "", report: { text: paths.map((p) => `+++ b/${p}\n@@ -0,0 +1,2 @@\n`).join(""), truncated: false } } } }) as EvidenceRecord;
const emptyDoc = (b: Batch): string => JSON.stringify({ schema: "graphloom-metrics-v1", tool: "gometrics", records: [], files: b.paths.map((p) => ({ path: p, language: "go", test: false, functions: [] })), skipped: [] });
/** A static run of `b`: its report whole, or cut. */
const runEvidence = (b: Batch, report: "whole" | "cut"): EvidenceRecord => {
  const command = staticCommand(b, hunks, root, [], process.execPath);
  return { ref: ref(), kind: "command", payload: { command: { id: b.id, argv: command.argv, exitCode: 0, stdoutTail: "", stderrTail: "", report: { text: report === "whole" ? emptyDoc(b) : emptyDoc(b).slice(0, 40), truncated: report === "cut" } } } } as EvidenceRecord;
};
const base = (): EvidenceRecord[] => [...paths.map(fileEvidence), diffEvidence()];

describe("the static batches", () => {
  const first = batchesOf(measurable(files, profile));

  it("start at most BATCH_FILES files wide, with the ids they always had", () => {
    expect(BATCH_FILES).toBe(8);
    expect(first).toEqual([{ id: "static-go-1", language: "go", paths }]);
  });

  it("split in two halves in path order, with ids derived from the parent's", () => {
    const [a, b] = splitBatch(first[0]!);
    expect(a).toEqual({ id: "static-go-1a", language: "go", paths: paths.slice(0, 3) });
    expect(b).toEqual({ id: "static-go-1b", language: "go", paths: paths.slice(3) });
    expect(splitBatch(a).map((x) => x.id)).toEqual(["static-go-1aa", "static-go-1ab"]);
  });

  it("run as planned until a run's report is cut", () => {
    expect(measurementState(base(), files, profile)).toMatchObject({ state: "tools", batches: [{ id: "static-go-1" }] });
  });

  it("replace a batch whose report was cut by its two halves, and plan both halves' runs", () => {
    const state = measurementState([...base(), runEvidence(first[0]!, "cut")], files, profile);
    expect(state.state).toBe("tools");
    if (state.state !== "tools") return;
    expect(state.batches.map((b) => [b.id, b.paths])).toEqual([
      ["static-go-1a", paths.slice(0, 3)],
      ["static-go-1b", paths.slice(3)],
    ]);
  });

  it("plan only the halves that have no run yet, splitting a half again when its report is cut too", () => {
    const [a, b] = splitBatch(first[0]!);
    const state = measurementState([...base(), runEvidence(first[0]!, "cut"), runEvidence(a, "cut"), runEvidence(b, "whole")], files, profile);
    expect(state.state).toBe("tools");
    if (state.state !== "tools") return;
    expect(state.batches.map((x) => [x.id, x.paths])).toEqual([
      ["static-go-1aa", paths.slice(0, 2)],
      ["static-go-1ab", paths.slice(2, 3)],
    ]);
  });

  it("finish when every leaf's report fits, the same from the evidence alone", () => {
    const [a, b] = splitBatch(first[0]!);
    const evidence = [...base(), runEvidence(first[0]!, "cut"), runEvidence(a, "whole"), runEvidence(b, "whole")];
    const state = measurementState(evidence, files, profile);
    expect(state.state, JSON.stringify(state)).toBe("ready");
    expect(measurementState(evidence, files, profile)).toEqual(state);
  });

  it("report a single file whose output still does not fit as not measured, and complete rather than fail", () => {
    const [only] = batchesOf(measurable(files.slice(0, 1), profile));
    const state = measurementState([fileEvidence(paths[0]!), diffEvidence(), runEvidence(only!, "cut")], files.slice(0, 1), profile);
    expect(state.state, JSON.stringify(state)).toBe("ready");
    if (state.state !== "ready") return;
    const reason = `the static tool's output for ${paths[0]} did not fit one command report`;
    expect(state.excluded).toEqual([{ path: paths[0], reason }]);
    expect(renderMeasurements(state, profile)).toContain(`Not measured: ${paths[0]} (${reason}).`);
  });

  it("split down to a single file that does not fit, while the others are measured", () => {
    const [a, b] = splitBatch(first[0]!);
    const [aa, ab] = splitBatch(a);
    const evidence = [...base(), runEvidence(first[0]!, "cut"), runEvidence(a, "cut"), runEvidence(aa, "whole"), runEvidence(ab, "cut"), runEvidence(b, "whole")];
    expect(ab.paths).toEqual([paths[2]]);
    const state = measurementState(evidence, files, profile);
    expect(state.state, JSON.stringify(state)).toBe("ready");
    if (state.state !== "ready") return;
    expect(state.excluded.map((e) => e.path)).toEqual([paths[2]]);
  });
});

describe("the tools print compact JSON", () => {
  const goOk = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
  const dir = (): string => {
    const d = mkdtempSync(path.join(os.tmpdir(), "gl-pr-compact-"));
    dirs.push(d);
    return d;
  };
  const run = (argv: string[], cwd: string): string => {
    const reportFile = path.join(cwd, ".report-out");
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, GRAPHLOOM_REPORT_FILE: reportFile }, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(reportFile, "utf8");
  };

  it.skipIf(!goOk)("gometrics prints one line and fits a command report for a batch of ~120 small functions", () => {
    const d = dir();
    const body = Array.from({ length: 120 }, (_, i) => `func f${i}(x int) int {\n\tif x > ${i} {\n\t\treturn x\n\t}\n\treturn ${i}\n}\n`).join("\n");
    mkdirSync(path.join(d, "pkg"), { recursive: true });
    writeFileSync(path.join(d, "pkg/many.go"), `package pkg\n\n${body}`);
    const b: Batch = { id: "static-go-1", language: "go", paths: ["pkg/many.go"] };
    const text = run(staticCommand(b, parseHunkFile(`pkg/many.go:1-${body.split("\n").length + 2}\n`), root, [], process.execPath).argv, d);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.trimEnd()).not.toContain("\n");
    expect(text).not.toContain("  ");
    expect((JSON.parse(text) as { records: unknown[] }).records).toHaveLength(120);
    expect(Buffer.byteLength(text)).toBeLessThan(64 * 1024);
  }, 120_000);

  it("tsmetrics prints one line", () => {
    const d = dir();
    mkdirSync(path.join(d, "src"), { recursive: true });
    writeFileSync(path.join(d, "src/a.ts"), "export function f(x: number) {\n  if (x > 1) {\n    return 1;\n  }\n  return 0;\n}\n");
    const b: Batch = { id: "static-typescript-1", language: "typescript", paths: ["src/a.ts"] };
    const text = run(staticCommand(b, parseHunkFile("src/a.ts:1-6\n"), root, [], process.execPath).argv, d);
    expect(text.trimEnd()).not.toContain("\n");
    expect(text).not.toContain("  ");
    expect((JSON.parse(text) as { records: unknown[] }).records).toHaveLength(1);
  });
});
