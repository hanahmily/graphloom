// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { FinalAnswer } from "../src/answers.js";
import { commandRuns, reportText } from "../src/evidence.js";
import { commandInputProblem, createCommandExecutor } from "@graphloom/executor-command";
import { baseDeltaCommand, pathList, carryNecessity, carryOf, changedAt, headDeltaCommand, incrementalLine, incrementalReads, mapLine, openIssueIds, parseBaseDelta, parseHeadDelta, parsePriorQa, priorFile, priorFileCommand, priorFileText, type CarryEnv, type HeadDelta, type IncrementalInput, type IncrementalPrior } from "../src/incremental.js";
import { effectiveConclusion, necessityAnswer, necessityJson, type NecessityRecord } from "../src/necessity.js";
import { effectivePacks } from "../src/packs.js";
import { round1Record } from "../src/round1.js";
import { profileOf } from "./support.js";
import type { Question } from "../src/questions.js";
import { EMPTY_REGISTRY, type PriorItem, type PriorRegistry } from "../src/prior.js";
import { defaultNecessity } from "../src/rehearsal-qa.js";

const sh = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const L = "1".repeat(40);
const H = "2".repeat(40);
const LB = "a".repeat(40);
const HB = "b".repeat(40);
const KEY = (type: string, name: string): string => `${type}|sym|pkg/quota/limit.go|${name}`;

const delta = (text: string): HeadDelta => {
  const d = parseHeadDelta(`${text}\ngraphloom-delta-end\n`);
  if ("problem" in d) throw new Error(d.problem);
  return d;
};
const file = (p: string, ...hunks: string[]): string => [`diff --git a/${p} b/${p}`, ...hunks].join("\n");

describe("reading the delta between two heads", () => {
  it("reads files and -U0 hunks, with a missing count meaning one line, and a header with no hunk meaning the whole file", () => {
    const d = delta([file("a.go", "@@ -5,2 +5,3 @@ func x() {", "@@ -20 +21 @@"), file("b.bin"), file("c.go", "@@ -0,0 +1,4 @@")].join("\n"));
    expect(d.get("a.go")).toEqual({ whole: false, hunks: [{ oldStart: 5, oldCount: 2, newStart: 5, newCount: 3 }, { oldStart: 20, oldCount: 1, newStart: 21, newCount: 1 }] });
    expect(d.get("b.bin")).toEqual({ whole: true, hunks: [] });
    expect(d.get("c.go")!.hunks[0]).toEqual({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 4 });
  });

  it("is unusable when the output was cut, or names a path git quoted or a header it cannot read", () => {
    expect(parseHeadDelta(file("a.go", "@@ -1 +1 @@"))).toEqual({ problem: "the delta output was cut before its end" });
    expect(parseHeadDelta('diff --git "a/x\\ty" "b/x\\ty"\ngraphloom-delta-end')).toMatchObject({ problem: expect.stringContaining("quoted") });
    expect(parseHeadDelta("diff --git a/x b/y\ngraphloom-delta-end")).toMatchObject({ problem: expect.stringContaining("cannot read") });
  });

  it("says a range is changed when a hunk touches it on that side, a file the delta does not list is not, and an insertion or deletion at the edge counts", () => {
    const d = delta(file("a.go", "@@ -10,3 +10,5 @@", "@@ -30,0 +32,2 @@", "@@ -50,2 +54,0 @@"));
    expect(changedAt(d, "a.go", 1, 9, "old")).toBe(false);
    expect(changedAt(d, "a.go", 8, 10, "old")).toBe(true);
    expect(changedAt(d, "a.go", 13, 20, "old")).toBe(false);
    // Lines were inserted after old line 30: the lines at that place on either side are touched.
    expect(changedAt(d, "a.go", 28, 30, "old")).toBe(true);
    expect(changedAt(d, "a.go", 31, 31, "old")).toBe(true);
    expect(changedAt(d, "a.go", 32, 33, "old")).toBe(false);
    expect(changedAt(d, "a.go", 32, 33, "new")).toBe(true);
    // Two lines were deleted after new line 54: the new lines on either side of that place are touched.
    expect(changedAt(d, "a.go", 53, 53, "new")).toBe(false);
    expect(changedAt(d, "a.go", 54, 54, "new")).toBe(true);
    expect(changedAt(d, "a.go", 55, 55, "new")).toBe(true);
    expect(changedAt(d, "a.go", 56, 60, "new")).toBe(false);
    expect(changedAt(d, "other.go", 1, 1000, "old")).toBe(false);
    // A file-level citation (no lines) is changed by any hunk in the file.
    expect(changedAt(d, "a.go", 0, 0, "old")).toBe(true);
    expect(changedAt(d, "other.go", 0, 0, "old")).toBe(false);
  });

  it("maps a line at L to its line at H by the hunks wholly before it", () => {
    const d = delta(file("a.go", "@@ -10,3 +10,5 @@", "@@ -30,0 +32,2 @@", "@@ -50,2 +54,0 @@"));
    expect(mapLine(d, "a.go", 5)).toBe(5);
    expect(mapLine(d, "a.go", 20)).toBe(22);
    expect(mapLine(d, "a.go", 31)).toBe(35);
    expect(mapLine(d, "a.go", 60)).toBe(62);
    expect(mapLine(d, "unlisted.go", 7)).toBe(7);
  });

  it("reads which base files differ between the two bases", () => {
    expect([...parseBaseDelta("same pkg/a.go\nchanged pkg/b.go\nnoise\n")]).toEqual([["pkg/a.go", false], ["pkg/b.go", true]]);
  });
});

describe("the delta and prior-file commands, run on a real repository", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const run = async (dir: string, argv: readonly string[], extra: Record<string, string> = {}) => sh(argv[0]!, argv.slice(1), { cwd: dir, env: { ...env, ...extra } });
  const git = async (dir: string, ...args: string[]): Promise<string> => (await sh("git", args, { cwd: dir, env })).stdout.trim();

  it("prints the file and hunk headers between two commits and ends with its marker; a missing earlier commit fails", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-delta-"));
    dirs.push(dir);
    await git(dir, "init", "-q", "-b", "main");
    await writeFile(path.join(dir, "a.go"), "one\ntwo\nthree\nfour\nfive\n");
    await writeFile(path.join(dir, "b.go"), "x\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "first");
    const l = await git(dir, "rev-parse", "HEAD");
    await writeFile(path.join(dir, "a.go"), "one\ntwo\nTHREE\nfour\nfive\nsix\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "second");
    const h = await git(dir, "rev-parse", "HEAD");
    const report = path.join(dir, ".delta-report");
    /** What the command writes to its report file, as the executor reads it. */
    const viaReport = async (argv: readonly string[]): Promise<string> => {
      await run(dir, argv, { GRAPHLOOM_REPORT_FILE: report });
      return readFile(report, "utf8");
    };
    const out = await viaReport(headDeltaCommand(l, h, ["a.go", "b.go"]).argv);
    const d = parseHeadDelta(out);
    expect(d).toBeInstanceOf(Map);
    expect([...(d as HeadDelta)]).toEqual([["a.go", { whole: false, hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }, { oldStart: 5, oldCount: 0, newStart: 6, newCount: 1 }] }]]);
    // No paths asked about: nothing is diffed (git would otherwise diff the whole tree).
    expect(parseHeadDelta(await viaReport(headDeltaCommand(l, h, []).argv))).toEqual(new Map());
    await expect(run(dir, headDeltaCommand("9".repeat(40), h, ["a.go"]).argv, { GRAPHLOOM_REPORT_FILE: report })).rejects.toThrow();
    // Whether a base file differs between two commits.
    const both = await viaReport(baseDeltaCommand(l, h, ["a.go", "b.go"]).argv);
    expect([...parseBaseDelta(both)]).toEqual([["a.go", true], ["b.go", false]]);
    await expect(run(dir, baseDeltaCommand(l, "9".repeat(40), ["a.go"]).argv, { GRAPHLOOM_REPORT_FILE: report })).rejects.toThrow();
  });

  it("keeps every file of a delta whose output is far past the executor's 8,192-byte stdout tail, and passes more than 58 paths, through the real executor", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-wide-"));
    dirs.push(dir);
    await git(dir, "init", "-q", "-b", "main");
    const names = Array.from({ length: 90 }, (_, n) => `pkg/area${String(n).padStart(2, "0")}/file.go`);
    for (const n of names) {
      await mkdir(path.join(dir, path.dirname(n)), { recursive: true });
      await writeFile(path.join(dir, n), Array.from({ length: 30 }, (_, k) => `line ${k}`).join("\n") + "\n");
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "first");
    const l = await git(dir, "rev-parse", "HEAD");
    for (const n of names) await writeFile(path.join(dir, n), Array.from({ length: 30 }, (_, k) => (k % 5 === 0 ? `CHANGED ${k}` : `line ${k}`)).join("\n") + "\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "second");
    const h = await git(dir, "rev-parse", "HEAD");
    const command = headDeltaCommand(l, h, names);
    // More than 58 paths would have made 64+ arguments; as one argument it is valid input.
    expect(command.argv.length).toBeLessThan(10);
    expect(commandInputProblem({ commands: [command], env: {} })).toBeUndefined();
    const executor = createCommandExecutor();
    const result = (await executor.execute({ commands: [command], env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }, { artifactDir: path.join(dir, ".art"), operationId: "op1", worktreePath: dir } as never)) as { evidence: Array<{ payload: { command: Record<string, unknown> } }> };
    const outcome = result.evidence[0]!.payload.command;
    // The stdout tail alone could not hold it: that is what the report file is for.
    expect(String(outcome.stdoutTail).length).toBeLessThanOrEqual(8_192);
    const ev = [{ ref: "e1", kind: "command", payload: { command: outcome } }] as EvidenceRecord[];
    const run1 = commandRuns(ev)[0]!;
    const text = reportText(run1);
    expect(text.truncated).toBe(false);
    expect(text.text.length).toBeGreaterThan(8_192);
    const d = parseHeadDelta(text.text) as HeadDelta;
    expect([...d.keys()].sort()).toEqual([...names].sort());
  });

  it("reads a file of the ledger commit in parts and joins them by their digest; a commit without the file says absent", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-prior-"));
    dirs.push(dir);
    await git(dir, "init", "-q", "-b", "main");
    const big = JSON.stringify({ text: "é".repeat(40_000), more: "x".repeat(40_000) });
    await writeFile(path.join(dir, "qa.json"), big);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "ledger");
    const old = await git(dir, "rev-parse", "HEAD");
    const out = path.join(dir, ".report");
    const records: EvidenceRecord[] = [];
    const read = async (k: number, file: "qa" | "necessity") => {
      const c = priorFileCommand(file, old, process.execPath, k);
      await run(dir, c.argv, { GRAPHLOOM_REPORT_FILE: out });
      const text = await readFile(out, "utf8");
      records.push({ ref: `e${records.length}`, kind: "command", payload: { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: text } } } as EvidenceRecord);
      return text;
    };
    const first = await read(0, "qa");
    const n = Number(/^graphloom-prior 0 (\d+) /.exec(first)![1]);
    expect(n).toBeGreaterThan(1);
    const partial = priorFile(records, "qa", old, process.execPath);
    expect(partial.state).toBe("missing");
    for (let k = 1; k < n; k += 1) await read(k, "qa");
    expect(priorFile(records, "qa", old, process.execPath)).toEqual({ state: "read", text: JSON.stringify(JSON.parse(big)).replace(/[\u007f-￿]/g, (m) => `\\u${m.charCodeAt(0).toString(16).padStart(4, "0")}`) });
    // The ASCII-escaped text is the same JSON.
    const whole = priorFile(records, "qa", old, process.execPath);
    expect(whole.state === "read" && JSON.parse(whole.text)).toEqual(JSON.parse(big));
    // The stand-in a rehearsal uses prints what the command prints.
    expect(priorFileText(big, 0)).toBe(first);
    // A commit that holds no necessity.json says so, and the read is not a failure.
    await read(0, "necessity");
    expect(priorFile(records, "necessity", old, process.execPath)).toEqual({ state: "absent" });
  });
});

// ---- the earlier Q&A, and the carry rule ----

const answer = (id: string, over: Partial<FinalAnswer> = {}): FinalAnswer => ({
  question: id,
  answer: "Answered from the code.",
  status: "answered",
  none_found: false,
  citations: [],
  searches: [],
  inventory: [],
  metrics: [],
  proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" },
  check: { verdict: "supported", note: "", searches: [] },
  notes: [],
  history: [],
  ...over,
});
const question = (id: string, type: string, symbol: string, name: string): Question => ({ id, type: type as Question["type"], item: "R1", symbol, text: `new wording of ${id}`, origin: "required", key: `${type}:${symbol}`, stable: KEY(type, name) });
const priorQ = (id: string, type: string, name: string, a: FinalAnswer | undefined, over: Record<string, unknown> = {}) => ({ id, type, item: "R1", stable: KEY(type, name), text: `recorded wording of ${id}`, origin: "required" as const, ...(a !== undefined ? { answer: a } : {}), ...over });

const necessityRecord = (over: Partial<NecessityRecord> = {}): NecessityRecord => {
  const n = defaultNecessity("Clamp quotas");
  const final = { ...answer("N1", { ...necessityAnswer(n), question: "N1" }), necessity: n } as FinalAnswer;
  return { final, decision: { action: "ask-all", reason: "N1 concluded necessary; every question is asked" } as NecessityRecord["decision"], ...over };
};

function prior(over: Partial<IncrementalPrior> & { questions?: ReturnType<typeof priorQ>[] } = {}): IncrementalPrior {
  const { questions, ...rest } = over;
  return {
    from: L,
    fromBase: LB,
    qa: { head: L, base: LB, mode: "standard", dependencies: ["cobra@1.9.1"], questions: questions ?? [] },
    necessity: necessityRecord(),
    necessityHead: L,
    delta: new Map(),
    baseSame: true,
    baseChanged: new Map(),
    ...rest,
  };
}

const symbols = [
  { id: "S1", path: "pkg/quota/limit.go", startLine: 6, endLine: 11 },
  { id: "S2", path: "pkg/quota/limit.go", startLine: 14, endLine: 16 },
];
const items = [{ id: "R1", cites: [{ path: "pkg/quota/limit.go", side: "head" as const, start: 5, end: 16, symbol: "" }] }];
const carryEnv = (p: IncrementalPrior, over: Partial<CarryEnv> = {}): CarryEnv => ({ prior: p, openIds: new Set(), symbols, items, dependencies: ["cobra@1.9.1"], principles: "null", pinned: [{ source: "title", text: "Clamp quotas" }], ...over });
const carriedAnswer = (r: ReturnType<typeof carryOf>): FinalAnswer => {
  if (!("answer" in r)) throw new Error(`not carried: ${r.why}`);
  return r.answer;
};

describe("which earlier answers a later head carries", () => {
  const cite = (p: string, start: number, end: number, tree: "head" | "base" | "dependency" = "head") => ({ path: p, tree, start, end, quote: "q" });
  const limitTest = answer("Q2", { citations: [cite("pkg/quota/limit_test.go", 3, 9)] });
  const q2 = question("Q2", "missing-test", "S1", "quota.Limit");

  it("carries an answered question whose subject and citations the delta does not touch, with its recorded wording and the head it was answered on", () => {
    const p = prior({ questions: [priorQ("Q2", "missing-test", "quota.Limit", limitTest)], delta: delta(file("docs/x.md", "@@ -1 +1 @@")) });
    const r = carryOf(q2, carryEnv(p));
    expect(r).toMatchObject({ head: L, text: "recorded wording of Q2" });
    expect(carriedAnswer(r)).toMatchObject({ question: "Q2", status: "answered", check: { verdict: "supported" } });
  });

  it("keeps the head an earlier incremental head carried it from, through later heads", () => {
    const p = prior({ questions: [priorQ("Q2", "missing-test", "quota.Limit", limitTest, { carried: "9".repeat(40) })] });
    expect(carryOf(q2, carryEnv(p))).toMatchObject({ head: "9".repeat(40) });
  });

  it("maps a carried head citation to its lines at H, and leaves a base citation alone", () => {
    const a = answer("Q2", { citations: [cite("pkg/quota/limit_test.go", 30, 34), cite("pkg/a.go", 4, 5, "base")] });
    const p = prior({ questions: [priorQ("Q2", "missing-test", "quota.Limit", a)], delta: delta(file("pkg/quota/limit_test.go", "@@ -10,0 +10,6 @@")) });
    expect(carriedAnswer(carryOf(q2, carryEnv(p))).citations).toEqual([cite("pkg/quota/limit_test.go", 36, 40), cite("pkg/a.go", 4, 5, "base")]);
  });

  it("asks it when its symbol's lines changed at H, when a hunk touches a head citation at L, or when the question has no recorded answer", () => {
    const base = { questions: [priorQ("Q2", "missing-test", "quota.Limit", limitTest)] };
    // The symbol's own lines (6-11 at H) are in a hunk's new side.
    expect(carryOf(q2, carryEnv(prior({ ...base, delta: delta(file("pkg/quota/limit.go", "@@ -7,2 +7,3 @@")) })))).toEqual({ why: "its subject is changed" });
    // The other symbol's lines changing leaves this one carried.
    expect(carryOf(q2, carryEnv(prior({ ...base, delta: delta(file("pkg/quota/limit.go", "@@ -14,3 +14,4 @@")) })))).toHaveProperty("answer");
    // The cited test's lines (3-9 at L) are in a hunk's old side.
    expect(carryOf(q2, carryEnv(prior({ ...base, delta: delta(file("pkg/quota/limit_test.go", "@@ -5,1 +5,1 @@")) })))).toEqual({ why: "a citation of its answer is changed" });
    // A new symbol has no recorded answer.
    expect(carryOf(question("Q5", "missing-test", "S3", "quota.New"), carryEnv(prior(base), { symbols: [...symbols, { id: "S3", path: "pkg/quota/limit.go", startLine: 20, endLine: 22 }] }))).toEqual({ why: "no earlier answer" });
  });

  it("judges a base citation by the base delta and a dependency citation by the declared dependencies", () => {
    const a = answer("Q1", { citations: [cite("pkg/timestamp/duration.go", 30, 42, "base")] });
    const q1 = question("Q1", "existing-reuse-common", "S1", "quota.Limit");
    const q = { questions: [priorQ("Q1", "existing-reuse-common", "quota.Limit", a)] };
    expect(carryOf(q1, carryEnv(prior(q)))).toHaveProperty("answer");
    // The base moved and that file differs between the bases (or is not listed, which is read as differing).
    expect(carryOf(q1, carryEnv(prior({ ...q, baseSame: false, baseChanged: new Map([["pkg/timestamp/duration.go", true]]) })))).toEqual({ why: "a citation of its answer is changed" });
    expect(carryOf(q1, carryEnv(prior({ ...q, baseSame: false, baseChanged: new Map() })))).toEqual({ why: "a citation of its answer is changed" });
    expect(carryOf(q1, carryEnv(prior({ ...q, baseSame: false, baseChanged: new Map([["pkg/timestamp/duration.go", false]]) })))).toHaveProperty("answer");
    const dep = { questions: [priorQ("Q1", "existing-reuse-common", "quota.Limit", answer("Q1", { citations: [cite("github.com/spf13/cobra@v1.9.1/cmd.go", 1, 5, "dependency")] }))] };
    expect(carryOf(q1, carryEnv(prior(dep)))).toHaveProperty("answer");
    expect(carryOf(q1, carryEnv(prior(dep), { dependencies: ["cobra@1.10.0"] }))).toEqual({ why: "a citation of its answer is changed" });
  });

  it("always asks an earlier open issue again, a question not fully answered, and a key two questions share", () => {
    const p = prior({ questions: [priorQ("Q2", "missing-test", "quota.Limit", limitTest), priorQ("Q1", "existing-reuse-common", "quota.Limit", answer("Q1", { status: "partially answered" }))] });
    expect(carryOf(q2, carryEnv(p, { openIds: new Set(["Q2"]) }))).toEqual({ why: "an earlier open issue: re-checked" });
    expect(carryOf(question("Q1", "existing-reuse-common", "S1", "quota.Limit"), carryEnv(p))).toEqual({ why: "the earlier answer was not fully answered" });
    expect(carryOf({ ...q2, stable: `${q2.stable}#2` }, carryEnv(p))).toEqual({ why: "its key is not unique" });
    const twice = prior({ questions: [priorQ("Q2", "missing-test", "quota.Limit", limitTest), priorQ("Q9", "missing-test", "quota.Limit", limitTest)] });
    expect(carryOf(q2, carryEnv(twice))).toEqual({ why: "its key is not unique" });
  });

  it("asks a change item's question when any place the item cites is changed, and a measured function's when its file is", () => {
    const item = question("Q7", "purpose", "S1", "quota.Limit");
    const noSymbol: Question = { ...item, symbol: undefined as never, stable: "purpose|item|pkg/quota/limit.go" };
    delete (noSymbol as { symbol?: string }).symbol;
    const rec = { questions: [{ ...priorQ("Q7", "purpose", "x", answer("Q7")), stable: "purpose|item|pkg/quota/limit.go" }] };
    expect(carryOf(noSymbol, carryEnv(prior({ ...rec, delta: delta(file("docs/x.md", "@@ -1 +1 @@")) })))).toHaveProperty("answer");
    expect(carryOf(noSymbol, carryEnv(prior({ ...rec, delta: delta(file("pkg/quota/limit.go", "@@ -8 +8 @@")) })))).toEqual({ why: "its subject is changed" });
    const fn: Question = { ...noSymbol, type: "split-function", fn: "closure", fnPath: "pkg/quota/limit.go", stable: "split-function|fn|pkg/quota/limit.go|closure" };
    const fnRec = { questions: [{ ...priorQ("Q8", "split-function", "x", answer("Q8")), stable: fn.stable! }] };
    expect(carryOf(fn, carryEnv(prior({ ...fnRec, delta: delta(file("pkg/quota/limit.go", "@@ -40 +40 @@")) })))).toEqual({ why: "its subject is changed" });
    expect(carryOf(fn, carryEnv(prior(fnRec)))).toHaveProperty("answer");
  });

  it("recomputes to the same carried set whatever the order questions come in, and openIssueIds takes an issue's covered questions too", () => {
    const item = (id: string, covers?: string[], status: PriorItem["status"] = "open", origin: PriorItem["origin"] = "round1"): PriorItem => ({ id, origin, key: id, status, head: L, history: [], ...(covers !== undefined ? { covers } : {}) });
    expect([...openIssueIds([item("Q1", ["Q4", "Q5"]), item("Q2", undefined, "fixed"), item("F3", undefined, "open", "round2")])].sort()).toEqual(["Q1", "Q4", "Q5"]);
  });
});

describe("whether a later head carries N1", () => {
  const cite = (p: string, start: number, end: number, tree: "head" | "base" = "base") => ({ path: p, tree, start, end, quote: "q", step: "s" });
  const withCites = (head: number, mutate?: (n: ReturnType<typeof defaultNecessity>) => void): NecessityRecord => {
    const n = defaultNecessity("Clamp quotas");
    n.problem.trace = [cite("pkg/timestamp/duration.go", 30, 42)];
    n.design.changed = [cite("pkg/quota/limit.go", head, head + 4, "head")];
    mutate?.(n);
    const final = { ...answer("N1", { ...necessityAnswer(n), question: "N1" }), necessity: n } as FinalAnswer;
    return { final, decision: { action: "ask-all", reason: "ok" } as NecessityRecord["decision"] };
  };

  it("carries a necessary N1 whose cited lines the delta does not touch, with its lines mapped to H and the head it was answered on", () => {
    const p = prior({ necessity: withCites(20), delta: delta(file("pkg/quota/limit.go", "@@ -2,0 +2,3 @@")) });
    const r = carryNecessity(carryEnv(p));
    expect(r).toMatchObject({ head: L });
    const rec = (r as { record: NecessityRecord }).record;
    expect(rec.carried).toEqual({ head: L });
    expect(rec.final.necessity!.design.changed[0]).toMatchObject({ path: "pkg/quota/limit.go", start: 23, end: 27 });
    expect(rec.final.citations.some((c) => c.path === "pkg/quota/limit.go" && c.start === 23)).toBe(true);
    expect(effectiveConclusion(rec.final)).toBe("necessary");
  });

  it("asks N1 again when a cited line changed, the principles file differs, its quote left the pull request's text, or it was an issue or skipped the rest", () => {
    const base = { necessity: withCites(20) };
    expect(carryNecessity(carryEnv(prior({ ...base, delta: delta(file("pkg/quota/limit.go", "@@ -22,1 +22,1 @@")) })))).toEqual({ why: "a citation of its answer is changed" });
    expect(carryNecessity(carryEnv(prior(base), { principles: '{"path":"x"}' }))).toEqual({ why: "the design principles file differs" });
    expect(carryNecessity(carryEnv(prior(base), { pinned: [{ source: "title", text: "Something else entirely" }] }))).toEqual({ why: "the pull request's text no longer holds a quote it used" });
    expect(carryNecessity(carryEnv(prior(base), { openIds: new Set(["N1"]) }))).toEqual({ why: "an earlier open issue: re-checked" });
    expect(carryNecessity(carryEnv(prior({ necessity: { ...withCites(20), decision: { action: "skip", reason: "unnecessary" } as NecessityRecord["decision"] } })))).toEqual({ why: "N1 skipped the other questions" });
    const questionable = withCites(20, (n) => {
      n.conclusion = "questionable";
    });
    expect(carryNecessity(carryEnv(prior({ necessity: questionable })))).toEqual({ why: "N1 was an issue" });
    expect(carryNecessity(carryEnv(prior({ necessity: { ...withCites(20), carried: { head: L } } })))).toHaveProperty("head");
  });
});

describe("reading the earlier Q&A, and when round 1 is a full round 1", () => {
  const qaText = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      schema: "pr-qa-v1",
      mode: "standard",
      pull: { owner: "o", repo: "r", number: 7, head: L, base: LB },
      inventory: { dependencies: [{ name: "cobra", version: "1.9.1" }] },
      questions: [{ id: "Q1", type: "purpose", item: "R1", text: "t", origin: "required", stable: "purpose|item|a.go", answer: answer("Q1") }, { id: "Q2", type: "purpose", item: "R1", text: "t", origin: "required", stable: "purpose|item|b.go" }],
      ...over,
    });
  const necessityText = (): string => JSON.stringify({ schema: "pr-necessity-v1", question: { id: "N1", text: "?" }, conclusion: "necessary", decision: { action: "ask-all", reason: "ok" }, answer: necessityRecord().final });

  it("parses a Q&A of a head, with the answers it recorded, and refuses a skipped one", () => {
    const qa = parsePriorQa(qaText());
    expect(qa).toMatchObject({ head: L, base: LB, mode: "standard", dependencies: ["cobra@1.9.1"] });
    expect(qa!.questions.map((q) => [q.id, q.answer?.status])).toEqual([["Q1", "answered"], ["Q2", undefined]]);
    expect(parsePriorQa(qaText({ roundsSkipped: { reason: "review-only", note: "n" } }))).toBeUndefined();
    expect(parsePriorQa("not json")).toBeUndefined();
    expect(parsePriorQa(JSON.stringify({ schema: "other" }))).toBeUndefined();
  });

  const registry = (heads: string[] = [L]): PriorRegistry => ({ ...EMPTY_REGISTRY, heads });
  const input = (over: Partial<IncrementalInput> = {}): IncrementalInput => ({ ledger: "c".repeat(40), registry: registry(), enabled: true, head: H, files: ["pkg/quota/limit.go"], base: HB, node: process.execPath, ...over });
  /** The evidence of a command that ran with this text as its output. */
  const ran = (c: { id: string; argv: string[] }, stdout: string, exitCode = 0): EvidenceRecord => ({ ref: `e-${c.id}`, kind: "command", payload: { command: { id: c.id, argv: c.argv, exitCode, stdoutTail: stdout } } }) as EvidenceRecord;
  const ledger = "c".repeat(40);
  const reads = (qa: string | undefined, nec: string | undefined, extra: EvidenceRecord[] = []): EvidenceRecord[] => [
    ran(priorFileCommand("qa", ledger, process.execPath, 0), qa === undefined ? "graphloom-prior-absent\n" : priorFileText(qa, 0)),
    ran(priorFileCommand("necessity", ledger, process.execPath, 0), nec === undefined ? "graphloom-prior-absent\n" : priorFileText(nec, 0)),
    ...extra,
  ];
  const deltaRun = (text: string, exitCode = 0, i: IncrementalInput = input()): EvidenceRecord => ran(headDeltaCommand(L, H, [...new Set(i.files)].sort()), text, exitCode);

  it("has nothing to say with no ledger, and reads the earlier Q&A, the necessity record and the delta, in that order, when there is one", () => {
    expect(incrementalReads([], input({ ledger: undefined }))).toEqual({ state: "none" });
    const first = incrementalReads([], input());
    expect(first).toMatchObject({ state: "run", commands: [{ id: "ledger-prior-qa" }] });
    const second = incrementalReads([reads(qaText(), undefined)[0]!], input());
    expect(second).toMatchObject({ state: "run", commands: [{ id: "ledger-prior-nec" }] });
    const third = incrementalReads(reads(qaText(), necessityText()), input());
    expect(third).toMatchObject({ state: "run", commands: [{ id: "ledger-delta" }] });
    expect((third as { commands: Array<{ argv: string[] }> }).commands[0]!.argv.slice(4)).toEqual([L, H, "pkg/quota/limit.go"]);
    // The paths are one argument, so any number of them is within the command executor's 64 arguments.
    expect(commandInputProblem({ commands: [headDeltaCommand(L, H, Array.from({ length: 150 }, (_, n) => `pkg/f${n}.go`))] })).toBeUndefined();
  });

  it("is usable with the delta read, and reads the base delta only when the bases differ", () => {
    const ev = [...reads(qaText(), necessityText()), deltaRun(`${file("pkg/quota/limit.go", "@@ -7 +7 @@")}\ngraphloom-delta-end\n`)];
    const same = incrementalReads(ev, input({ base: LB }));
    expect(same.state).toBe("usable");
    expect(same.state === "usable" && [same.prior.baseSame, same.prior.delta.size, same.prior.from]).toEqual([true, 1, L]);
    // The earlier answers cite a base file, and the bases differ: its status is read first.
    const cited = qaText({ questions: [{ id: "Q1", type: "purpose", item: "R1", text: "t", origin: "required", stable: "purpose|item|a.go", answer: answer("Q1", { citations: [{ path: "pkg/a.go", tree: "base", start: 1, end: 2, quote: "q" }] }) }] });
    const ev2 = [...reads(cited, necessityText()), deltaRun(`graphloom-delta-end\n`)];
    const moved = incrementalReads(ev2, input());
    expect(moved).toMatchObject({ state: "run", commands: [{ id: "ledger-delta-base" }] });
    // The base files the earlier answers and N1 cite, in order.
    const baseRun = ran(baseDeltaCommand(LB, HB, ["pkg/a.go", "pkg/timestamp/duration.go"]), "changed pkg/a.go\nsame pkg/timestamp/duration.go\n");
    const done = incrementalReads([...ev2, baseRun], input());
    expect(done.state === "usable" && [done.prior.baseSame, [...done.prior.baseChanged]]).toEqual([false, [["pkg/a.go", true], ["pkg/timestamp/duration.go", false]]]);
  });

  it("is a full round 1, with its reason, when the profile says so, or a file is missing or not the Q&A of its latest head", () => {
    const full = (ev: EvidenceRecord[], i: IncrementalInput = input()) => {
      const r = incrementalReads(ev, i);
      return r.state === "full" ? r.reason : r.state;
    };
    expect(full([], input({ enabled: false }))).toContain("questions.incremental is false");
    expect(full([], input({ registry: registry([]) }))).toBe("none");
    expect(full(reads(undefined, necessityText()))).toBe("the ledger's latest commit holds no qa.json");
    expect(full(reads(qaText(), undefined))).toContain("holds no necessity.json");
    expect(full(reads(qaText({ roundsSkipped: { reason: "r", note: "n" } }), necessityText()))).toContain("skipped");
    expect(full(reads(qaText(), necessityText()), input({ registry: registry(["d".repeat(40), L, "e".repeat(40)]) }))).toBe("the ledger's qa.json is not of the latest head it lists");
    expect(full(reads(qaText(), "{}"))).toContain("not the necessity record");
  });

  it("is a full round 1 when the delta cannot be read: the earlier commit is gone, the output was cut, or it names a header it cannot read", () => {
    const full = (text: string, exit = 0) => {
      const r = incrementalReads([...reads(qaText(), necessityText()), deltaRun(text, exit)], input({ base: LB }));
      return r.state === "full" ? r.reason : r.state;
    };
    expect(full("", 128)).toContain("not in the review clone");
    expect(full(file("pkg/quota/limit.go", "@@ -1 +1 @@"))).toContain("cut");
    expect(full('diff --git "a/x" "b/x"\ngraphloom-delta-end\n')).toContain("quoted");
    // A path list that cannot be one argument is decided before any command is dispatched, never a failed Fetch.
    const many = Array.from({ length: 400 }, (_, n) => `pkg/some/where/f${n}.go`);
    expect(incrementalReads(reads(qaText(), necessityText()), input({ files: many }))).toMatchObject({ state: "full", reason: expect.stringContaining("do not fit the one argument") });
    expect(pathList(["a\nb"])).toBeUndefined();
  });

  it("is a full round 1 when a report holds only the tail of the delta or of the base check: a cut read is never taken for 'unchanged'", () => {
    const cut = (e: EvidenceRecord): EvidenceRecord => {
      const command = (e.payload as { command: Record<string, unknown> }).command;
      return { ...e, payload: { command: { ...command, report: { text: String(command.stdoutTail).split("\n").slice(-2).join("\n"), truncated: true } } } } as EvidenceRecord;
    };
    const r = incrementalReads([...reads(qaText(), necessityText()), cut(deltaRun(`${file("pkg/quota/limit.go", "@@ -7 +7 @@")}\ngraphloom-delta-end\n`))], input({ base: LB }));
    expect(r).toMatchObject({ state: "full", reason: expect.stringContaining("did not fit") });
    const cited = qaText({ questions: [{ id: "Q1", type: "purpose", item: "R1", text: "t", origin: "required", stable: "purpose|item|a.go", answer: answer("Q1", { citations: [{ path: "pkg/a.go", tree: "base", start: 1, end: 2, quote: "q" }] }) }] });
    const ev = [...reads(cited, necessityText()), deltaRun("graphloom-delta-end\n"), cut(ran(baseDeltaCommand(LB, HB, ["pkg/a.go", "pkg/timestamp/duration.go"]), "changed pkg/a.go\nsame pkg/timestamp/duration.go\n"))];
    expect(incrementalReads(ev, input())).toMatchObject({ state: "full", reason: expect.stringContaining("did not fit") });
  });

  it("says in one line what was asked and carried, or why every question was asked", () => {
    expect(incrementalLine({ from: L, to: H, asked: 3, rechecks: 1, carried: 5 })).toBe(`Since the last review (1111111 → 2222222): 3 asked (new or changed code), 1 of them re-checks of earlier issues, 5 carried from earlier heads.`);
    expect(incrementalLine({ full: "the profile turns incremental review off" })).toBe("Every question was asked: the profile turns incremental review off.");
  });
});

describe("round 1's issues and earlier-issue outcomes over a Q&A that carries answers", () => {
  const qa = (questions: Array<Record<string, unknown>>): string =>
    JSON.stringify({ schema: "pr-qa-v1", symbols: [], questions });
  const q = (id: string, key: string, status: string, over: Record<string, unknown> = {}) => ({ id, type: "purpose", item: "R1", stable: key, text: `question ${id}`, answer: { answer: "an answer", status, none_found: false, citations: [] }, ...over });
  const run = (questions: Array<Record<string, unknown>>, open: string[]) =>
    round1Record({
      head: H,
      necessity: necessityJson(necessityRecord()),
      qa: qa(questions),
      files: [],
      itemCites: {},
      packs: effectivePacks(profileOf()),
      prior: open.map((id): PriorItem => ({ id, origin: "round1", key: `purpose|item|${id}`, status: "open", head: L, history: [] })),
    })!;

  it("keeps an earlier issue open when its question, asked again alone, is still not fully answered, and closes it when it now is", () => {
    const carried = q("Q2", "purpose|item|Q2", "answered", { carried: { head: L } });
    const still = run([q("Q1", "purpose|item|Q1", "partially answered"), carried], ["Q1"]);
    expect(still.issues.map((i) => i.id)).toEqual(["Q1"]);
    expect(still.prior).toEqual([{ id: "Q1", key: "purpose|item|Q1", status: "open", reason: "it is still an issue on this head" }]);
    const fixed = run([q("Q1", "purpose|item|Q1", "answered"), carried], ["Q1"]);
    expect(fixed.issues).toEqual([]);
    expect(fixed.prior).toEqual([{ id: "Q1", key: "purpose|item|Q1", status: "fixed", reason: "its question is now answered, with no blocking category" }]);
  });

  it("raises a new issue from an asked question about new code, and none from a carried answered one", () => {
    const r = run([q("Q2", "purpose|item|Q2", "answered", { carried: { head: L } }), q("Q9", "purpose|item|Q9", "needs author")], []);
    expect(r.issues.map((i) => [i.id, i.kinds])).toEqual([["Q9", ["needs-author"]]]);
    expect(r.prior).toBeUndefined();
  });

  it("closes an earlier issue whose question the head no longer asks (its subject is gone)", () => {
    const r = run([q("Q2", "purpose|item|Q2", "answered", { carried: { head: L } })], ["Q1"]);
    expect(r.prior).toEqual([{ id: "Q1", key: "purpose|item|Q1", status: "fixed", reason: "its subject is no longer in the change" }]);
  });
});
