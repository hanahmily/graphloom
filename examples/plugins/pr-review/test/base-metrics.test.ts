// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { GIT_ENV } from "../src/commands.js";
import { baseFileCommand, baseTargets, MAX_BASE_FILE_BYTES, renderMeasurements, staticBaseCommand, wholeFile, type BaseBatch } from "../src/measurements.js";
import { LIMITS, originOf, originText } from "../src/metrics/crap.js";
import type { MetricsRecord } from "../src/metrics/record.js";
import { formatHunkFile } from "../src/metrics/hunks.js";
import { DOCS } from "../src/rehearsal-docs.js";
import { BASE_FILES, STREAM_PATH } from "../src/rehearsal-fixtures.js";
import { requiredQuestions } from "../src/questions.js";
import { pullFile } from "../src/snapshot.js";
import { validatorById } from "../src/validators.js";
import { BANYANDB, candidateEvidence, profileOf, root, scenarioWith, simulate } from "./support.js";

const go = spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const record = (over: Partial<MetricsRecord> = {}): MetricsRecord => ({
  path: "banyand/stream/write_standalone.go",
  function: "stream.(*writeCallback).Rev",
  startLine: 6,
  endLine: 49,
  change: "modified",
  test: false,
  complexity: 25,
  decisions: [],
  nesting: 4,
  nestingPath: [],
  coverage: { source: "unknown", reason: "not run" },
  crap: 650,
  ...over,
});
const withBase = (complexity: number, nesting: number, over: Partial<MetricsRecord> = {}): MetricsRecord => record({ ...over, base: { complexity, nesting, startLine: 6, endLine: 40, path: "banyand/stream/write_standalone.go" } });

const table = (records: MetricsRecord[]): string =>
  renderMeasurements({ state: "ready", records, refs: [], excluded: [], coverage: { enabled: false, runs: [] } } as never, profileOf());

describe("the base files of the modified functions", () => {
  const files = [
    pullFile({ path: "a.go", status: "modified", patch: "@@ -1 +1 @@\n+x" })!,
    pullFile({ path: "pkg/new.go", previousPath: "pkg/old.go", status: "renamed", patch: "@@ -1 +1 @@\n+x" })!,
    pullFile({ path: "a_test.go", status: "modified", patch: "@@ -1 +1 @@\n+x" })!,
    pullFile({ path: "b.go", status: "added", patch: "@@ -0,0 +1 @@\n+x" })!,
  ];

  it("are the files of the modified non-test functions, named as they were at the base (a renamed file by its old path), once each", () => {
    const records = [record({ path: "a.go", function: "p.A" }), record({ path: "a.go", function: "p.B" }), record({ path: "pkg/new.go", function: "p.C" }), record({ path: "a_test.go", function: "p.T", test: true }), record({ path: "b.go", function: "p.D", change: "added" })];
    expect(baseTargets(records, files)).toEqual([
      { index: 1, path: "a.go", language: "go" },
      { index: 2, path: "pkg/old.go", language: "go" },
    ]);
  });

  it("are read with git show at the pinned base into the command's report file, and carry the base and the path in the argv", () => {
    const c = baseFileCommand({ index: 3, path: "pkg/x.go", language: "go" }, "b".repeat(40));
    expect(c.id).toBe("base-file-3");
    expect(c.argv.slice(3)).toEqual(["base-file-3", "b".repeat(40), "pkg/x.go"]);
    expect(c.argv[2]).toMatch(/git -c core\.hooksPath=\/dev\/null show "\$1:\$2" > "\$GRAPHLOOM_REPORT_FILE"/);
    expect(MAX_BASE_FILE_BYTES).toBeLessThan(65_536);
  });
});

describe("where an over-limit value comes from (design 6.8)", () => {
  it("is the pull request's own for a new function, introduced when the base was within the limit, inherited or made worse when it was not", () => {
    expect(originOf(record({ change: "added" }), "complexity").origin).toBe("new");
    expect(originOf(withBase(7, 2, { complexity: 12 }), "complexity")).toMatchObject({ origin: "introduced", base: 7, head: 12 });
    expect(originOf(withBase(21, 2), "complexity")).toMatchObject({ origin: "worse", base: 21, head: 25 });
    expect(originOf(withBase(25, 2), "complexity").origin).toBe("inherited");
    expect(originOf(withBase(30, 2), "complexity").origin).toBe("inherited");
    expect(originOf(withBase(3, 2, { complexity: 5 }), "complexity").origin).toBe("within");
    expect(originOf(record({ base: { unavailable: "x" } }), "complexity").origin).toBe("unknown");
    expect(originOf(record(), "complexity").origin).toBe("unknown");
  });

  it("is said in the sentence a question uses", () => {
    expect(originText(withBase(21, 2), "complexity")).toBe("inherited and made worse: complexity was already over the limit of < 10 at the base (21), and the pull request raised it to 25");
    expect(originText(withBase(7, 2, { complexity: 12 }), "complexity")).toBe("the pull request introduced it: complexity was 7 at the base, within the limit of < 10");
    expect(originText(withBase(25, 2), "complexity")).toMatch(/^inherited: complexity was already 25 at the base, over the limit of < 10, and the pull request did not raise it$/);
    expect(originText(record({ base: { unavailable: "the file cannot be read at the base" } }), "nesting")).toBe("the base value is not known (the file cannot be read at the base)");
  });
});

describe("the Measurements table shows base → head for a modified function", () => {
  it("shows 21 → 25 with 'over the limit at the base; made worse' for a legacy function the change made worse", () => {
    const md = table([withBase(21, 4)]);
    expect(md).toContain(`| \`stream.(*writeCallback).Rev\` banyand/stream/write_standalone.go:6 | modified | 21 → 25 (over the limit of ${LIMITS.complexity} at the base; made worse) | 4 → 4 (over the limit of ${LIMITS.nesting} at the base; not raised) |`);
  });

  it("marks an inherited value that the change did not raise, and one it introduced", () => {
    expect(table([withBase(25, 2)])).toContain("25 → 25 (over the limit of 10 at the base; not raised)");
    expect(table([withBase(7, 2, { complexity: 12, nesting: 4 })])).toContain("7 → 12 (over the limit of 10: introduced by the pull request)");
    expect(table([withBase(7, 2, { complexity: 12, nesting: 4 })])).toContain("2 → 4 (over the limit of 3: introduced by the pull request)");
  });

  it("shows a within-limit change as a plain arrow, and a function the base cannot show with the head value and why", () => {
    expect(table([withBase(4, 1, { complexity: 6, nesting: 2 })])).toContain("| modified | 4 → 6 | 1 → 2 |");
    expect(table([record({ base: { unavailable: "the file cannot be read at the base" } })])).toContain("25 (over the limit of 10) (base not measured: the file cannot be read at the base)");
  });

  it("keeps a new function's head value alone, over the limit stated as before", () => {
    expect(table([record({ change: "added", complexity: 12, nesting: 4 })])).toContain("| added | 12 (over the limit of 10) | 4 (over the limit of 3) |");
    expect(table([record({ change: "added", complexity: 3, nesting: 1 })])).toContain("| added | 3 | 1 |");
  });
});

describe("the split-function question says whether the excess is inherited or introduced", () => {
  const view = (r: MetricsRecord) => ({ items: [{ id: "R1", section: "features", text: "x", cites: [{ path: r.path, side: "head" as const, start: 10, end: 12, symbol: "" }], facts: [] }], records: [r] });
  const groundwork = { symbols: [], testMap: new Map() } as never;
  const text = (r: MetricsRecord) => requiredQuestions({ view: view(r), groundwork }, new Map()).find((q) => q.type === "split-function")!.text;

  it("says made worse, introduced, inherited, or that the base is not known", () => {
    expect(text(withBase(21, 4))).toContain("complexity: inherited and made worse");
    expect(text(withBase(7, 2, { complexity: 12, nesting: 4 }))).toContain("complexity: the pull request introduced it");
    expect(text(withBase(7, 2, { complexity: 12, nesting: 4 }))).toContain("nesting: the pull request introduced it");
    expect(text(withBase(25, 4))).toContain("complexity: inherited: complexity was already 25 at the base");
    expect(text(record({ base: { unavailable: "no function of this name at the base" } }))).toContain("the base value is not known (no function of this name at the base)");
    expect(text(record({ change: "added" }))).toContain("a new function, so the complexity is the pull request's own");
  });

  it("puts the base value in the complexity-coverage question too", () => {
    const q = requiredQuestions({ view: view(withBase(21, 4)), groundwork }, new Map()).find((x) => x.type === "complexity-coverage")!;
    expect(q.text).toContain("Complexity 25 (21 at the base: inherited and made worse");
  });
});

describe("state-lifecycle: the modified Rev function, measured at the base and at the head", () => {
  const sim = simulate({ scenarioName: "state-lifecycle" });
  const json = JSON.parse(sim.written!.json) as { measurements: { records: MetricsRecord[] } };

  it("reads the base file and measures it after the head's tools, with no network and no repository code", () => {
    const order = sim.jobs.filter((j) => j.stageId === "report").map((j) => j.instruction.split(" ").slice(0, 3).join(" "));
    expect(order.slice(order.indexOf("Measure the changed"), order.indexOf("Measure the changed") + 3)).toEqual(["Measure the changed", "Read the base", "Measure the modified"]);
    const read = sim.jobs.find((j) => j.instruction.startsWith("Read the base versions"))!;
    expect(read).toMatchObject({ readOnly: true, purpose: "diagnostic" });
    expect((read.input as { env: unknown }).env).toEqual({ ...GIT_ENV });
    const tools = sim.jobs.find((j) => j.instruction.startsWith("Measure the modified functions at the base"))!;
    expect(tools.confinement).toMatchObject({ kind: "bwrap", network: false });
    const commands = (tools.input as { commands: Array<{ id: string; argv: string[] }> }).commands;
    expect(commands.map((c) => c.id)).toEqual(["static-base-go-1"]);
    expect(commands[0]!.argv.slice(-2)).toEqual([expect.stringMatching(/^[0-9a-f]{40}$/), STREAM_PATH]);
  });

  it("records the base values with the head's in report.json and shows base → head in the table", () => {
    const rev = json.measurements.records.find((r) => r.function === "stream.(*writeCallback).Rev")!;
    expect(rev.base).toMatchObject({ complexity: 7, nesting: 3, path: STREAM_PATH });
    expect(sim.qa!.markdown).toContain("| 7 → 12 (over the limit of 10: introduced by the pull request) | 3 → 4 (over the limit of 3: introduced by the pull request) |");
  });

  it("asks the split-function question with where the excess comes from", () => {
    const q = JSON.parse(sim.qa!.json) as { questions: Array<{ type: string; text: string }> };
    expect(q.questions.find((x) => x.type === "split-function")!.text).toContain("complexity: the pull request introduced it: complexity was 7 at the base, within the limit of < 10");
  });

  it("hands the answerer the record's base value", () => {
    const text = (sim.jobs.find((j) => j.resultSchema === "answers-v1")!.input as { assignment: string }).assignment;
    expect(text).toContain("[at the base: complexity 7, nesting 3]");
  });

  it("recomputes the base values from the base file's recorded text: a base document that does not recompute leaves the base unknown, and the written report no longer matches", () => {
    const tampered = scenarioWith("state-lifecycle", (s) => {
      const doc = JSON.parse(s.commands!["static-base-go-1"]!.stdout!) as { records: Array<{ complexity: number }> };
      doc.records[0]!.complexity = 2;
      s.commands!["static-base-go-1"] = { exitCode: 0, stdout: JSON.stringify(doc) };
    });
    const s2 = simulate({ scenario: tampered });
    const rev = (JSON.parse(s2.written!.json) as { measurements: { records: MetricsRecord[] } }).measurements.records.find((r) => r.function === "stream.(*writeCallback).Rev")!;
    expect(rev.base).toEqual({ unavailable: expect.stringMatching(/^the base measurement does not recompute: .*complexity 2 is not 1 \+ 6 decisions/) });
    // The validators judge the report against what the evidence recomputes: the original report fails against the tampered evidence.
    const evidence: EvidenceRecord[] = sim.evidence.map((e) => {
      const c = (e.payload as { command?: { id: string; stdoutTail: string } }).command;
      if (c?.id !== "static-base-go-1") return e;
      const doc = JSON.parse(c.stdoutTail) as { records: Array<{ complexity: number }> };
      doc.records[0]!.complexity = 2;
      return { ...e, payload: { ...(e.payload as object), command: { ...c, stdoutTail: JSON.stringify(doc) } } } as EvidenceRecord;
    });
    const atReport = evidence.slice(0, evidence.findIndex((e) => e.resultSchema === "necessity-v1"));
    const r = validatorById("change-report")!.evaluate({ requirementId: "change-report", statement: "", evidence: candidateEvidence(atReport, "d1"), candidateDigest: "d1", config: BANYANDB });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/not the report the evidence recomputes/) });
  });

  it("reports on, with the head value alone and why, when the base file cannot be read", () => {
    const unreadable = scenarioWith("state-lifecycle", (s) => {
      s.commands!["base-file-1"] = { exitCode: 128, stderr: "fatal: path does not exist in the base" };
    });
    const s2 = simulate({ scenario: unreadable });
    expect(s2.final.action.type).toBe("stop");
    expect(s2.jobs.some((j) => j.instruction.startsWith("Measure the modified functions at the base"))).toBe(false);
    expect(s2.qa!.markdown).toContain("12 (over the limit of 10) (base not measured: the file cannot be read at the base)");
    expect(s2.receipts.every((r) => r.valid)).toBe(true);
  });

  it("measures no base for an added function, and none when the base cannot be pinned", () => {
    const added = simulate({ scenarioName: "complex-function" });
    expect(added.jobs.some((j) => j.instruction.startsWith("Read the base versions"))).toBe(false);
    expect(added.qa!.markdown).toContain("| added | 12 (over the limit of 10) | 4 (over the limit of 3) |");
  });
});

describe.skipIf(!go)("the base measurement, run for real over a throwaway repository", () => {
  const sh = (cwd: string, argv: string[], env: Record<string, string> = {}) => {
    const report = path.join(cwd, ".report-out");
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", env: { ...process.env, ...env, GRAPHLOOM_REPORT_FILE: report } });
    let out = "";
    try {
      out = readFileSync(report, "utf8");
    } catch {
      /* none */
    }
    return { code: r.status, stderr: r.stderr, report: out };
  };

  it("reads the base file with git show, not the worktree's, and measures it with the same tool: the recorded document is the fixture's", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-basemetrics-"));
    dirs.push(dir);
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...GIT_ENV, GIT_AUTHOR_NAME: "n", GIT_AUTHOR_EMAIL: "a@b.c", GIT_COMMITTER_NAME: "n", GIT_COMMITTER_EMAIL: "a@b.c" } });
    git("init", "-q", "-b", "main");
    mkdirSync(path.dirname(path.join(dir, STREAM_PATH)), { recursive: true });
    writeFileSync(path.join(dir, STREAM_PATH), BASE_FILES[STREAM_PATH]!);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    // The worktree holds the head, which differs.
    writeFileSync(path.join(dir, STREAM_PATH), `${BASE_FILES[STREAM_PATH]}// head\n`);
    const target = { index: 1, path: STREAM_PATH, language: "go" as const };
    const read = sh(dir, baseFileCommand(target, sha).argv, GIT_ENV);
    expect(read.code, read.stderr).toBe(0);
    expect(read.report).toBe(BASE_FILES[STREAM_PATH]);
    const batch: BaseBatch = { id: "static-base-go-1", language: "go", path: STREAM_PATH, text: read.report };
    const goRoot = spawnSync("go", ["env", "GOROOT"], { encoding: "utf8" }).stdout.trim();
    const measured = sh(dir, staticBaseCommand(batch, sha, root, [], process.execPath, path.join(goRoot, "bin", "go")).argv, GIT_ENV);
    expect(measured.stderr).toBe("");
    expect(measured.code).toBe(0);
    expect(JSON.parse(measured.report)).toEqual(DOCS[`base:${STREAM_PATH}`]);
    // The hunks the tool measured are every line of the base file; the worktree is untouched and nothing is left in it.
    expect(formatHunkFile(wholeFile(STREAM_PATH, read.report))).toBe(`${STREAM_PATH}:1-${read.report.split("\n").length}\n`);
    expect(readFileSync(path.join(dir, STREAM_PATH), "utf8").endsWith("// head\n")).toBe(true);
    expect(git("status", "--porcelain").stdout.split("\n").filter((l) => l !== "" && !l.includes(".report-out"))).toEqual([" M banyand/stream/write_standalone.go"]);
  }, 120_000);

  it("fails, writing nothing, when the base has no such file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-pr-basemetrics-"));
    dirs.push(dir);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    spawnSync("git", ["add", "."], { cwd: dir });
    spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", "commit", "-q", "-m", "base"], { cwd: dir, env: { ...process.env, ...GIT_ENV } });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const r = sh(dir, baseFileCommand({ index: 1, path: "nope.go", language: "go" }, sha).argv, GIT_ENV);
    expect(r.code).not.toBe(0);
  });
});
