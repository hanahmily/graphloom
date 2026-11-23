// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BUILTIN_COMMAND_EXECUTOR_ID, jsonSchemaProblem, MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord, type JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { COMMAND_ID_PATTERN, commandJobProblem, fitJob, MAX_ARG_CHARS, MAX_ARGV, MAX_JOB_COMMANDS, MAX_PATH_ARG_CHARS } from "../src/kit/bounds.js";
import { COMMAND } from "../src/kit/constants.js";
import { planFits, type CoveragePlan } from "../src/kit/coverage.js";
import { baseDefsCommand } from "../src/kit/groundwork.js";
import { siteCommands, sourceCommands, type Dependency } from "../src/kit/inventory.js";
import { measurementState, metricsDiffCommand, staticCommand, type Batch } from "../src/kit/measurements.js";
import type { FullPack } from "../src/kit/packs.js";
import { MAX_PATTERN_CHARS, MAX_SEARCH_PATH_CHARS, MAX_SEARCH_PATHS, searchCommand } from "../src/kit/searches.js";
import { pullFile, type PullFile } from "../src/kit/snapshot.js";
import { MAX_TREE_QUOTE_CHARS } from "../src/kit/claims.js";
import { treeQuotePlan } from "../src/kit/treequotes.js";
import { BANYANDB, profileOf, root } from "./support.js";

/**
 * The command executor's own validator, from the repository's source: the bounds the kit plans against must be its
 * bounds. A bundle copied alone for repair qualification has no executor source next to it; the parity tests then skip.
 */
const executorSource = path.resolve(root, "../../../executors/command/src/run.ts");
const present = existsSync(executorSource);
interface CommandExecutorModule {
  commandInputProblem(v: unknown): string | undefined;
  COMMAND_INPUT_SHAPE: { schema: { properties: { commands: { maxItems: number; items: { properties: { id: { pattern: string }; argv: { maxItems: number; items: { maxLength: number } } } } } } } };
}
const executor = async (): Promise<CommandExecutorModule> => (await import(pathToFileURL(executorSource).href)) as CommandExecutorModule;

/** Asserts a job of these commands is one the command executor takes, by its own validator and the job input bound. */
async function expectAccepted(commands: readonly EnvironmentCommand[], extra: Record<string, unknown> = {}): Promise<void> {
  expect(commands.length).toBeGreaterThan(0);
  for (const c of commands) expect(c.argv.length, c.id).toBeLessThanOrEqual(MAX_ARGV);
  const input = { commands, continueOnFailure: true, ...extra };
  expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
  expect(commandJobProblem({ stageId: "s", kind: "command", purpose: "diagnostic", readOnly: true, instruction: "i", input } as JobSpec)).toBeUndefined();
  if (present) expect((await executor()).commandInputProblem(input)).toBeUndefined();
}

describe("the command executor's input bounds (design §6.8)", () => {
  it.skipIf(!present)("are the kit's: the executor declares the same numbers and its validator draws the same lines", async () => {
    const { COMMAND_INPUT_SHAPE, commandInputProblem } = await executor();
    const commands = COMMAND_INPUT_SHAPE.schema.properties.commands;
    expect(commands.maxItems).toBe(MAX_JOB_COMMANDS);
    expect(commands.items.properties.argv.maxItems).toBe(MAX_ARGV);
    expect(commands.items.properties.argv.items.maxLength).toBe(MAX_ARG_CHARS);
    expect(commands.items.properties.id.pattern).toBe(COMMAND_ID_PATTERN.source);
    const argv = (n: number): string[] => ["sh", ...Array.from({ length: n - 1 }, () => "x")];
    expect(commandInputProblem({ commands: [{ id: "a", argv: argv(MAX_ARGV) }] })).toBeUndefined();
    expect(commandInputProblem({ commands: [{ id: "a", argv: argv(MAX_ARGV + 1) }] })).toContain("argv");
    expect(commandInputProblem({ commands: [{ id: "a", argv: ["sh", "x".repeat(MAX_ARG_CHARS)] }] })).toBeUndefined();
    expect(commandInputProblem({ commands: [{ id: "a", argv: ["sh", "x".repeat(MAX_ARG_CHARS + 1)] }] })).toContain("argv[1]");
    const many = Array.from({ length: MAX_JOB_COMMANDS + 1 }, (_, i) => ({ id: `c${i}`, argv: ["true"] }));
    expect(commandInputProblem({ commands: many })).toBeDefined();
    expect(commandInputProblem({ commands: many.slice(0, MAX_JOB_COMMANDS) })).toBeUndefined();
  });

  it("are checked before a job is dispatched: a command over one is named, the declared shape is applied too", () => {
    const job = (argv: string[]): JobSpec => ({ stageId: "s", kind: "command", purpose: "diagnostic", readOnly: true, instruction: "i", input: { commands: [{ id: "metrics-diff-a", argv }] } }) as JobSpec;
    const over = ["sh", "-c", "true", "metrics-diff-a", ...Array.from({ length: 74 }, (_, i) => `pkg/f${i}.go`)];
    expect(commandJobProblem(job(over))).toBe(`metrics-diff-a: the argv holds 78 strings; the command executor takes 1-${MAX_ARGV}`);
    expect(commandJobProblem(job(over.slice(0, MAX_ARGV)))).toBeUndefined();
    expect(commandJobProblem(job(["sh", "x".repeat(MAX_ARG_CHARS + 1)]))).toContain("argv[1]");
    // A job for another executor is not this check's.
    expect(commandJobProblem({ ...job(over), executor: { id: "graphloom.github/read" } })).toBeUndefined();
    expect(commandJobProblem({ ...job(["true"]), executor: { id: BUILTIN_COMMAND_EXECUTOR_ID } })).toBeUndefined();
  });

  it("takes every id the executor takes, upper case included (a symbol search is search-S1)", async () => {
    const job = { stageId: "s", kind: "command", purpose: "diagnostic", readOnly: true, instruction: "i", input: { commands: [{ id: "search-S1", argv: ["true"] }, { id: "Tree-Quote-2", argv: ["true"] }] } } as JobSpec;
    expect(commandJobProblem(job)).toBeUndefined();
    if (present) {
      const { commandInputProblem, COMMAND_INPUT_SHAPE } = await executor();
      expect(commandInputProblem(job.input)).toBeUndefined();
      // The declared shape publishes the very pattern the executor applies (since executor-command 0.1.4; before, it lacked
      // the case flag and refused search-S1, which stopped every pr-review rehearsal after Review at the symbol searches).
      expect(jsonSchemaProblem(COMMAND_INPUT_SHAPE.schema as unknown as Record<string, unknown>, job.input)).toBeUndefined();
    }
    expect(commandJobProblem({ ...job, input: { commands: [{ id: "-bad", argv: ["true"] }] } } as JobSpec)).toContain("the id must match");
  });

  it("packs a job's commands within its count and its bytes", () => {
    const big = (i: number): EnvironmentCommand => ({ id: `w-${i}`, argv: ["sh", "-c", "true", `w-${i}`, ...Array.from({ length: 20 }, () => "x".repeat(4_000))] });
    const packed = fitJob(Array.from({ length: 10 }, (_, i) => big(i)));
    expect(packed.length).toBe(3);
    expect(Buffer.byteLength(JSON.stringify({ commands: packed }), "utf8")).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    expect(fitJob(Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, argv: ["true"] })))).toHaveLength(MAX_JOB_COMMANDS);
  });
});

// ---- a 181-file pull request, as apache/skywalking-banyandb#1487 was (hub-f165d2f4)

const profile = profileOf({ metrics: { ...((BANYANDB as { metrics: object }).metrics), coverage: false } });
let n = 0;
const ref = (): string => `ev-${++n}`;
const fileEvidence = (p: string): EvidenceRecord => ({ ref: ref(), kind: "file", payload: { path: p, bytes: "package pkg\n\n" } }) as EvidenceRecord;
const commandEvidence = (command: EnvironmentCommand, report: string): EvidenceRecord => {
  const cut = Buffer.byteLength(report, "utf8") > 64 * 1024;
  return { ref: ref(), kind: "command", payload: { command: { id: command.id, argv: command.argv, exitCode: 0, stdoutTail: "", stderrTail: "", report: { text: cut ? report.slice(-64 * 1024) : report, truncated: cut } } } } as EvidenceRecord;
};
const headersOf = (p: string, hunks: number): string => `+++ b/${p}\n${Array.from({ length: hunks }, (_, i) => `@@ -${2 * i + 1},0 +${2 * i + 1} @@\n`).join("")}`;

/** 181 Go files under long directories, every third one renamed from another directory. */
function largePull(count = 181): PullFile[] {
  return Array.from({ length: count }, (_, i) => {
    const p = `banyand/internal/storage/segment/part${String(i).padStart(3, "0")}/handler_${i}.go`;
    return i % 3 === 0
      ? pullFile({ path: p, status: "renamed", previousPath: `banyand/internal/legacy/part${i}/handler_${i}.go`, patch: "@@ -1 +1 @@\n-x\n+y" })!
      : pullFile({ path: p, status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" })!;
  });
}

/** Answers every diff job the measurement asks for, each as the graph dispatches it, asserting the executor takes it. */
async function answerDiffs(evidence: EvidenceRecord[], files: readonly PullFile[], hunksOf: (p: string) => number): Promise<EnvironmentCommand[]> {
  const measured = new Set(files.map((f) => f.path));
  const ran: EnvironmentCommand[] = [];
  for (let s = measurementState(evidence, files, profile); s.state === "diff"; s = measurementState(evidence, files, profile)) {
    const job = fitJob(s.commands);
    await expectAccepted(job);
    for (const c of job) {
      ran.push(c);
      const named = c.id === COMMAND.metricsDiff ? [...measured] : c.argv.slice(4).filter((p) => measured.has(p));
      evidence.push(commandEvidence(c, named.map((p) => headersOf(p, hunksOf(p))).join("")));
    }
  }
  return ran;
}

describe("a 181-file pull request's measurement commands", () => {
  it("lists the hunk headers in groups the command executor takes, renames counted twice, and the merged hunks cover every file", async () => {
    const files = largePull();
    const evidence: EvidenceRecord[] = files.map((f) => fileEvidence(f.path));
    // About 66 KB of hunk headers together, as in the live run: the root's report does not fit.
    const ran = await answerDiffs(evidence, files, () => 20);
    expect(ran[0]).toEqual(metricsDiffCommand());
    const groups = ran.slice(1);
    expect(groups.length).toBeGreaterThan(2);
    for (const c of groups) expect(c.argv.length).toBeLessThanOrEqual(MAX_ARGV);
    // No named group was dispatched over the bound: the halves of 181 (91 and 90 files, renames two paths each) never ran.
    expect(groups.map((c) => c.id)).not.toContain("metrics-diff-a");
    // Every measured file is named by exactly one group that ran, a renamed one beside its base path.
    const named = groups.flatMap((c) => c.argv.slice(4));
    for (const f of files) {
      expect(named.filter((p) => p === f.path)).toHaveLength(1);
      if (f.previousPath !== null) expect(named[named.indexOf(f.path) - 1]).toBe(f.previousPath);
    }
    const s = measurementState(evidence, files, profile);
    expect(s.state).toBe("tools");
    if (s.state !== "tools") return;
    expect([...s.hunks.keys()].sort()).toEqual(files.map((f) => f.path).sort());
    // The static batches the graph dispatches next are taken too.
    const commands = s.batches.map((b) => staticCommand(b, s.hunks, root, ["*.pb.go"], process.execPath, "/usr/local/go/bin/go"));
    for (let rest = commands; rest.length > 0; ) {
      const job = fitJob(rest);
      await expectAccepted(job);
      rest = rest.slice(job.length);
    }
    // A validator recomputes the same plan from the evidence alone.
    expect(measurementState(evidence, files, profile)).toEqual(s);
  });

  it("splits a static batch whose hunks would be over the argv bound before it runs, and packs batches by the job's bytes", async () => {
    const files = largePull(16);
    const evidence: EvidenceRecord[] = files.map((f) => fileEvidence(f.path));
    // Dense files: eight of them together carry more hunk lines than 64 argv strings hold.
    await answerDiffs(evidence, files, () => 900);
    const s = measurementState(evidence, files, profile);
    expect(s.state).toBe("tools");
    if (s.state !== "tools") return;
    expect(s.batches.map((b) => b.id)).not.toContain("static-go-1");
    expect(s.batches.flatMap((b) => b.paths).sort()).toEqual(files.map((f) => f.path).sort());
    const commands = s.batches.map((b: Batch) => staticCommand(b, s.hunks, root, [], process.execPath));
    let jobs = 0;
    for (let rest = commands; rest.length > 0; jobs++) {
      const job = fitJob(rest);
      await expectAccepted(job);
      rest = rest.slice(job.length);
    }
    expect(jobs).toBeGreaterThan(1);
  });

  it("reports a single file whose hunks cannot be passed in one command as not measured, never dispatching it", () => {
    // A long path and many hunks: its headers fit the diff's report, its hunk lines (the path on each) not one command's argv.
    const huge = `${"deep/".repeat(170)}big.go`;
    const files = [pullFile({ path: "a/small.go", status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" })!, pullFile({ path: huge, status: "modified", patch: "@@ -1 +1 @@\n-x\n+y" })!];
    const evidence: EvidenceRecord[] = files.map((f) => fileEvidence(f.path));
    evidence.push(commandEvidence(metricsDiffCommand(), `${headersOf("a/small.go", 2)}${headersOf(huge, 300)}`));
    const s = measurementState(evidence, files, profile);
    expect(s.state).toBe("tools");
    if (s.state !== "tools") return;
    expect(s.hunks.get(huge)).toHaveLength(300);
    expect(staticCommand({ id: "static-go-1", language: "go", paths: [huge] }, s.hunks, root, [], process.execPath).argv.length).toBeGreaterThan(MAX_ARGV);
    expect(s.batches.map((b) => b.paths)).toEqual([["a/small.go"]]);
    for (const b of s.batches) {
      const doc = JSON.stringify({ schema: "graphloom-metrics-v1", tool: "gometrics", records: [], files: b.paths.map((p) => ({ path: p, language: "go", test: false, functions: [] })), skipped: [] });
      evidence.push(commandEvidence(staticCommand(b, s.hunks, root, [], process.execPath), doc));
    }
    const ready = measurementState(evidence, files, profile);
    expect(ready.state, JSON.stringify(ready).slice(0, 300)).toBe("ready");
    if (ready.state === "ready") expect(ready.excluded).toEqual([{ path: huge, reason: "its changed lines are too many to pass to the static tool in one command" }]);
  });

  it("keeps a path too long for a command argument out of the measurement", () => {
    const long = `${"d/".repeat(MAX_PATH_ARG_CHARS / 2)}x.go`;
    const files = [pullFile({ path: long, status: "added", patch: "@@ -0,0 +1 @@\n+x" })!, pullFile({ path: "a/ok.go", status: "renamed", previousPath: `${"o/".repeat(MAX_PATH_ARG_CHARS / 2)}x.go`, patch: "@@ -1 +1 @@\n-x\n+y" })!];
    const s = measurementState([], files, profile);
    expect(s.state).toBe("none");
  });
});

describe("the other commands that list paths or items in their argv", () => {
  const base = "0".repeat(40);

  it("re-run a search with the most paths and the longest pattern a search may report", async () => {
    const s = { pattern: "x".repeat(MAX_PATTERN_CHARS), tree: "head" as const, paths: Array.from({ length: MAX_SEARCH_PATHS }, (_, i) => `${i}${"p".repeat(MAX_SEARCH_PATH_CHARS - 1)}`), ignoreCase: true, hits: 1 };
    await expectAccepted(Array.from({ length: MAX_JOB_COMMANDS }, (_, i) => searchCommand(`search-${i + 1}`, base, s)));
  });

  it("read the base declarations of a batch of files, the dependency sites and sources of a large manifest", async () => {
    const pack = { grep: "^func " } as FullPack;
    await expectAccepted([baseDefsCommand("base-defs-1", base, pack, Array.from({ length: 8 }, (_, i) => `${i}${"p".repeat(MAX_PATH_ARG_CHARS - 1)}`))]);
    const deps: Dependency[] = Array.from({ length: 400 }, (_, i) => ({ ecosystem: i % 2 === 0 ? "go" : "npm", name: `github.com/example/module-${i}`, version: `v1.${i}.0`, manifest: i % 2 === 0 ? "go.mod" : "ui/package.json", indirect: false }));
    for (const commands of [siteCommands(base, deps), sourceCommands(deps)]) {
      for (let rest = commands; rest.length > 0; ) {
        const job = fitJob(rest);
        await expectAccepted(job);
        rest = rest.slice(job.length);
      }
    }
  });

  it("check the longest quotes of many claims against the trees", async () => {
    const claims = Array.from({ length: 60 }, (_, i) => ({ id: `C${i}`, tree: "either" as const, quotes: [{ path: `pkg/${"p".repeat(200)}/f${i}.go`, line: i + 1, text: "q".repeat(MAX_TREE_QUOTE_CHARS) }] }));
    const plan = treeQuotePlan(claims, base);
    for (let rest = plan.commands; rest.length > 0; ) {
      const job = fitJob(rest);
      await expectAccepted(job);
      rest = rest.slice(job.length);
    }
  });

  it("refuse a coverage plan whose commands would not fit one job", () => {
    const spec = "s".repeat(50 * 4_000);
    const plan = (count: number): CoveragePlan => ({ language: "typescript", sandbox: { wallClockMs: 60_000 }, commands: Array.from({ length: count }, (_, i) => ({ id: `cover-ts-${i + 1}`, script: "ts.sh", spec })), cache: "", mounts: [] }) as unknown as CoveragePlan;
    expect(planFits(plan(1))).toBe(true);
    expect(planFits(plan(2))).toBe(false);
  });
});
