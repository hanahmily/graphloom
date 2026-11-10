// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, JobSpec, RehearsalScenario } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { parseDraft } from "../src/draft.js";
import { parseVerification, parsePass, REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME } from "../src/review.js";
import { passReply, reproStub, SANDBOX_GO_READY, verifyReply } from "../src/rehearsal-review.js";
import { judgeRun, parseReproReport, reproProblems, reproSpecOf, sha256, type Repro } from "../src/repro.js";
import { readParts } from "../src/parts.js";
import { recordedAspect } from "../src/reviewdraft.js";
import { findingsProven } from "../src/reviewvalidators.js";
import { BANYANDB, assignmentOf, candidateEvidence, scenarioWith, simulate, type Simulation } from "./support.js";
import { REHEARSAL_REQUEST } from "../src/rehearsal.js";

const REVIEW_REQUEST = REHEARSAL_REQUEST.replace("Report on", "Review on");
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);

const PATH = "pkg/schema/ttl.go";
const GO_TEST = `package schema

import "testing"

func TestParseWeek(t *testing.T) {
	if _, err := ParseTTL("7w"); err != nil {
		t.Fatalf("7w refused: %v", err)
	}
}
`;
const repro = (over: Partial<Repro> = {}): Repro => ({ dir: "pkg/schema", name: "TestParseWeek", text: GO_TEST, expect: "assertion", oracle: "the PR text: ttl accepts d, h and w units", ...over });
const find = (extra: Record<string, unknown> = {}) => ({ path: PATH, start_line: 10, end_line: 12, severity: "P1", content: "7w is refused: the unit switch has no 'w' case.", ...extra });
const demonstrates = (yes = true) => ({ test: { demonstrates: yes, reason: yes ? "the test asserts the documented w unit" : "it checks an unrelated unit" } });
const confirmF1 = (extra: Record<string, unknown> = {}) => verifyReply([{ finding: "F1", verdict: "confirmed", witness: `${PATH}:11`, reason: "the switch has no w case", ...demonstrates(), ...extra }]);

/** A review whose replies are the given passes and verdicts, with the Go sandbox ready and the commands given. */
const scenario = (passes: unknown[], verdicts: unknown[], commands: NonNullable<RehearsalScenario["commands"]> = {}, config: Record<string, unknown> = {}): RehearsalScenario =>
  scenarioWith(
    "review-layer",
    (s) => {
      s.results[REVIEW_SCHEMA_NAME] = passes as never;
      s.results[VERIFY_SCHEMA_NAME] = verdicts as never;
      s.commands = { ...s.commands, ...SANDBOX_GO_READY, ...commands };
    },
    config,
  );
const run = (s: RehearsalScenario, config: Record<string, unknown> = {}): Simulation => simulate({ scenario: s, request: REVIEW_REQUEST, through: "end", maxSteps: 400, config });
const empty = (): unknown[] => [passReply(1, []), passReply(1, []), passReply(1, [])];
const draftOf = (sim: Simulation) => parseDraft((readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json") as { value: string }).value)!;
const findingOf = (sim: Simulation, aspect: "correctness" | "maintainability" | "security", id: string) => {
  const rec = recordedAspect(sim.evidence, aspect);
  if (rec.state !== "read") throw new Error(`${aspect} record ${rec.state}`);
  return rec.value.findings.find((f) => f.id === id)!;
};
const reproJobs = (sim: Simulation): JobSpec[] => sim.jobs.filter((j) => j.kind === "command" && /reviewer's test of F\d+/.test(j.instruction));
const FAILED = [{ outcome: "failed" as const, at: 6, message: "7w refused: unit not supported" }, { outcome: "failed" as const, at: 6, message: "7w refused: unit not supported" }];

describe("the contract of a behavioral comment's test", () => {
  const c = { path: PATH, kind: "behavioral" };
  it("accepts a whole Go test file, a vitest file, and a comment with no test", () => {
    expect(reproProblems(repro(), c, "comments[0]", 16_384)).toEqual([]);
    expect(reproProblems({ dir: "", name: "", text: "", expect: "assertion", oracle: "" }, c, "comments[0]", 16_384)).toEqual([]);
    expect(reproProblems(undefined, c, "comments[0]", 16_384)).toEqual([]);
    const ts = repro({ dir: "ui/src", name: "parses a week", text: `import { it, expect } from "vitest";\nit("parses a week", () => { expect(1).toBe(2); });\n` });
    expect(reproProblems(ts, { path: "ui/src/ttl.ts", kind: "behavioral" }, "comments[0]", 16_384)).toEqual([]);
  });

  it("names a test over the size limit, a malformed one, one without an oracle, and one on a non-behavioral comment", () => {
    const big = reproProblems(repro({ text: `${GO_TEST}// ${"x".repeat(17_000)}\n` }), c, "comments[0]", 16_384);
    expect(big).toEqual([expect.stringMatching(/comments\[0\]\.repro\.text is \d+ bytes, more than the 16384 a test may be/)]);
    expect(reproProblems(repro({ name: "TestOther" }), c, "comments[0]", 16_384)).toEqual([expect.stringContaining("must declare func TestOther(t *testing.T)")]);
    expect(reproProblems(repro({ name: "parse" }), c, "comments[0]", 16_384)).toEqual([expect.stringContaining("one Go test function name")]);
    expect(reproProblems(repro({ text: "func TestParseWeek(t *testing.T) {}\n" }), c, "comments[0]", 16_384)).toEqual([expect.stringContaining("starting with its package clause")]);
    expect(reproProblems(repro({ dir: "../etc" }), c, "comments[0]", 16_384)).toEqual([expect.stringContaining("repository-relative directory")]);
    expect(reproProblems(repro({ oracle: "" }), c, "comments[0]", 16_384)).toEqual([expect.stringContaining("repro.oracle")]);
    expect(reproProblems(repro(), { path: "docs/a.md", kind: "behavioral" }, "comments[0]", 16_384)).toEqual([expect.stringContaining("no way to run a test")]);
    expect(reproProblems(repro(), { path: PATH, kind: "non-behavioral" }, "comments[0]", 16_384)).toEqual([expect.stringContaining("only a behavioral comment carries a test")]);
    expect(reproProblems(repro({ expect: "boom" as never }), c, "comments[0]", 16_384)).toEqual([expect.stringContaining("expect (assertion or panic)")]);
  });

  it("is checked when a pass is read: the problems go back with the pass", () => {
    const scope = new Set([PATH]);
    const comment = { path: PATH, side: "RIGHT", start_line: 3, end_line: 5, aspect: "correctness", kind: "behavioral", severity: "P1", content: "wrong", suggestion: "", finding: "", evidence: "x", distinct: false, principle: "", repro: repro({ text: "x".repeat(300) }) };
    const read = (maxTestBytes: number) => parsePass({ comments: [comment], summary: { total_files: 1, reviewed_files: 1, skipped: [] } }, { aspect: "correctness", scope, known: new Set(), maxTestBytes });
    expect(read(16_384)).toMatchObject({ problems: expect.arrayContaining([expect.stringContaining("starting with its package clause")]) });
    expect(read(100)).toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/300 bytes, more than the 100/)]) });
  });

  it("reads a verdict's test judgment", () => {
    const v = { finding: "F1", verdict: "confirmed", kind: "behavioral", witness: "pkg/a.go:4", quotes: [], reason: "yes", fixes: false, test: { demonstrates: true, reason: "asserts the documented value" } };
    const r = parseVerification({ verdicts: [v] }, new Set(["F1"]));
    expect("verdicts" in r && r.verdicts.get("F1")!.test).toEqual({ demonstrates: true, reason: "asserts the documented value" });
    expect(parseVerification({ verdicts: [{ ...v, test: { demonstrates: "yes" } }] }, new Set(["F1"]))).toMatchObject({ problems: [expect.stringMatching(/\.test must be/)] });
  });
});

describe("what a recorded run means for a finding (design §8.2)", () => {
  const finding = { id: "F1", path: PATH };
  const spec = (text = GO_TEST) => ({ finding: "F1", language: "go" as const, repro: repro({ text }), workspace: ".", timeoutSeconds: 90 });
  const runOf = (stub: { exitCode: number; stdout: string }, planned: string) => ({
    record: { ref: "e1" } as EvidenceRecord,
    command: { id: "repro-F1", argv: ["sh", "tools/repro/repro.sh", "1", planned], exitCode: stub.exitCode, stdoutTail: stub.stdout, stderrTail: "" },
  });
  const judge = (runs: Parameters<typeof reproStub>[3], over: { sha256?: string; file?: string } = {}, r: Repro = repro()) => {
    const planned = "SPEC";
    return judgeRun(finding, r, "go", runOf(reproStub("F1", "go", r.text, runs, over), planned), planned, "golang@sha256:abc");
  };

  it("proves a test that fails in both runs at a line of its own file", () => {
    expect(judge(FAILED)).toMatchObject({ state: "proven", record: { runs: ["failed", "failed"], at: "graphloom_repro_F1_test.go:6", failure: "7w refused: unit not supported", name: "TestParseWeek", sha256: sha256(GO_TEST) } });
  });

  it("proves a test whose assertion failed inside a subtest: the location and message come with the parent's failure", () => {
    expect(judge([{ outcome: "failed", at: 8, message: "sub: parse(7w) = 0, want 7" }, { outcome: "failed", at: 8 }])).toMatchObject({ state: "proven", record: { at: "graphloom_repro_F1_test.go:8", failure: "sub: parse(7w) = 0, want 7" } });
  });

  it("proves an expected panic only when a frame lies in the cited file", () => {
    const panics = [{ outcome: "failed" as const, frames: [PATH + ":30"], message: "panic: index out of range" }, { outcome: "failed" as const, frames: [PATH + ":30"] }];
    expect(judge(panics, {}, repro({ expect: "panic" })).state).toBe("proven");
    expect(judge([{ outcome: "failed", frames: ["pkg/other/x.go:3"] }, { outcome: "failed", frames: ["pkg/other/x.go:3"] }], {}, repro({ expect: "panic" }))).toMatchObject({ state: "unproven", reason: expect.stringContaining("no frame in pkg/schema/ttl.go") });
  });

  it("does not prove a test that passes, fails once, fails elsewhere, does not build, times out or is not the recorded text", () => {
    expect(judge([{ outcome: "passed" }, { outcome: "passed" }])).toMatchObject({ state: "unproven", reason: "test does not fail" });
    expect(judge([{ outcome: "failed", at: 6 }, { outcome: "passed" }])).toMatchObject({ state: "unproven", reason: "flaky" });
    expect(judge([{ outcome: "failed", at: "other_test.go:6" }, { outcome: "failed", at: "other_test.go:6" }])).toMatchObject({ state: "unproven", reason: expect.stringContaining("not an assertion of the test") });
    expect(judge([{ outcome: "failed" }, { outcome: "failed" }])).toMatchObject({ state: "unproven", reason: expect.stringContaining("not an assertion of the test") });
    expect(judge([{ outcome: "build-failed" }, { outcome: "build-failed" }])).toMatchObject({ state: "unproven", reason: "inconclusive (build failed)" });
    expect(judge([{ outcome: "timeout" }, { outcome: "failed", at: 6 }])).toMatchObject({ state: "unproven", reason: "inconclusive (timeout)" });
    expect(judge([{ outcome: "killed" }, { outcome: "killed" }])).toMatchObject({ state: "unproven", reason: "inconclusive (killed)" });
    expect(judge(FAILED, { sha256: "0".repeat(64) })).toMatchObject({ state: "unproven", reason: expect.stringContaining("not of the recorded test") });
    expect(judge([{ outcome: "failed", at: 6 }])).toMatchObject({ state: "unproven", reason: expect.stringContaining("did not run twice") });
  });

  it("does not trust a run of another command, a killed sandbox or a report that is not graphloom-repro-v1", () => {
    const stub = reproStub("F1", "go", GO_TEST, FAILED);
    expect(judgeRun(finding, repro(), "go", runOf(stub, "OTHER"), "SPEC", undefined)).toMatchObject({ reason: expect.stringContaining("not of the recorded test") });
    expect(judgeRun(finding, repro(), "go", { ...runOf(stub, "SPEC"), command: { ...runOf(stub, "SPEC").command, timedOut: true } }, "SPEC", undefined)).toMatchObject({ reason: "inconclusive (timeout)" });
    expect(judgeRun(finding, repro(), "go", runOf({ exitCode: 137, stdout: "" }, "SPEC"), "SPEC", undefined)).toMatchObject({ reason: "inconclusive (killed)" });
    expect(judgeRun(finding, repro(), "go", undefined, "SPEC", undefined)).toMatchObject({ reason: expect.stringContaining("was not run") });
    expect(parseReproReport("ok\n")).toEqual({ error: expect.stringContaining("no graphloom-repro-v1") });
    expect(reproSpecOf(["sh", "s", "2", "ab", "cd", "x"])).toBe("abcd");
    expect(spec().repro.name).toBe("TestParseWeek");
  });

  it("withholds a failure message that looks like a credential", () => {
    const r = parseReproReport(["graphloom-repro-v1 go", "finding F1", "run 1 failed", `message 1 token ghp_${"a".repeat(36)} leaked`].join("\n"));
    expect("error" in r ? "" : r.runs[0]!.message).toContain("looked like a credential");
  });
});

describe("a behavioral finding with a test the graph ran", () => {
  const proven = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1()], { "repro-F1": reproStub("F1", "go", GO_TEST, FAILED) }));

  it("runs the test in the Docker sandbox over a checkout of the head, before the verifier, as the coverage job runs", () => {
    expect(stopOf(proven), JSON.stringify(proven.final).slice(0, 400)).toMatchObject({ reason: "complete" });
    const jobs = reproJobs(proven);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({ kind: "command", readOnly: true, checkout: { from: "candidate" }, confinement: { kind: "docker" } });
    const command = (job.input as { commands: Array<{ id: string; argv: string[] }> }).commands[0]!;
    expect(command.id).toBe("repro-F1");
    expect(command.argv[1]).toMatch(/tools\/repro\/repro\.sh$/);
    // The bytes run are the bytes recorded: the spec in the argv holds the test as base64.
    const spec = reproSpecOf(command.argv)!;
    expect(spec).toContain(`file ${Buffer.from(GO_TEST).toString("base64")}`);
    expect(spec).toContain("lang go");
    expect(spec).toContain("finding F1");
    // No network, a read-only dependency cache, and the plugin's script read-only.
    expect(job.confinement).toMatchObject({ kind: "docker", readOnly: expect.arrayContaining([expect.stringMatching(/pr-review|\//)]) });
    const order = proven.jobs.filter((j) => j.stageId === "review").map((j) => (j.kind === "agent" ? `${j.jobId}` : /reviewer's test/.test(j.instruction) ? "repro" : undefined)).filter((x) => x !== undefined);
    expect(order.slice(0, 3)).toEqual(["reviewer-correctness", "repro", "verifier-correctness"]);
  });

  it("shows the verifier the test, its oracle and the recorded run, and asks for test.demonstrates", () => {
    const verifier = proven.jobs.find((j) => j.kind === "agent" && j.jobId === "verifier-correctness")!;
    const text = assignmentOf(verifier);
    expect(text).toContain("func TestParseWeek(t *testing.T)");
    expect(text).toContain("the PR text: ttl accepts d, h and w units");
    expect(text).toContain("ran twice against the head: failed, failed");
    expect(text).toContain("graphloom_repro_F1_test.go:6");
    expect(text).toContain("demonstrates");
  });

  it("records it as proven and drafts it as a finding with its test and 'proven by a failing test'", () => {
    const f = findingOf(proven, "correctness", "F1");
    expect(f).toMatchObject({ state: "confirmed", kind: "behavioral", proof: { state: "proven", record: { runs: ["failed", "failed"], sha256: sha256(GO_TEST), language: "go" } } });
    const d = draftOf(proven);
    const entry = d.comments.find((c) => c.id === "F1")!;
    expect(entry).toMatchObject({ severity: "P1", proof: { state: "proven" }, test: { name: "TestParseWeek", language: "go", dir: "pkg/schema", text: GO_TEST, runs: ["failed", "failed"], at: "graphloom_repro_F1_test.go:6" } });
    expect(entry.body).toContain("Proven by a failing test the graph ran twice in a sandbox: `TestParseWeek`");
    expect(entry.body).toContain("7w refused: unit not supported");
    expect(d.judgment.map((j) => j.id)).not.toContain("F1");
    expect(d.recommended).toBe("request-changes");
    expect(d.summary).toContain("1 of them proven by a failing test the graph ran");
    const md = readParts(proven.evidence, "draft-md", ".graphloom/review/draft.md") as { value: string };
    expect(md.value).toContain("The test that proves it: TestParseWeek (go, in pkg/schema; expects assertion; runs: failed, failed;");
    expect(md.value).toContain("```go\npackage schema");
  });

  it("posts it as a proven finding: the verdict says changes requested and the comment says how it was proven", () => {
    expect(stopOf(proven)!.blocker).toMatch(/^round 2: changes requested: 1 open/);
    const text = JSON.stringify(proven.github.creates[0]);
    expect(text).toContain("proven by a failing test");
  });

  it("passes the findings-proven validator, and fails it when the recorded run is replaced by one that passed", () => {
    const evidence = candidateEvidence(proven.evidence, "d1");
    const input = (e: EvidenceRecord[]) => ({ requirementId: "findings-proven", statement: "", evidence: e, candidateDigest: "d1", config: BANYANDB });
    expect(findingsProven.evaluate(input(evidence))).toMatchObject({ status: "passed", reason: expect.stringContaining("1 behavioral finding proven by a failing test the graph ran") });
    const swap = (stdout: string): EvidenceRecord[] =>
      evidence.map((e) => {
        const c = (e.payload as { command?: { id: string } } | undefined)?.command;
        return c?.id === "repro-F1" ? { ...e, payload: { ...(e.payload as object), command: { ...c, stdoutTail: stdout, report: undefined } } } : e;
      });
    const passed = reproStub("F1", "go", GO_TEST, [{ outcome: "passed" }, { outcome: "passed" }]).stdout;
    expect(findingsProven.evaluate(input(swap(passed)))).toMatchObject({ status: "failed", reason: expect.stringContaining("F1 is recorded as proven but the recorded run of its test does not recompute as a proof (test does not fail)") });
    const other = reproStub("F1", "go", `${GO_TEST}// another test\n`, FAILED).stdout;
    expect(findingsProven.evaluate(input(swap(other)))).toMatchObject({ status: "failed", reason: expect.stringContaining("not of the recorded test") });
  });
});

describe("a behavioral finding whose test does not prove it", () => {
  const judgment = (sim: Simulation) => draftOf(sim).judgment.find((j) => j.id === "F1")!;

  it("is not reproduced when the test passes at the head: unproven, never P0 or P1, listed for judgment with its test", () => {
    const sim = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1(demonstrates(false))], { "repro-F1": reproStub("F1", "go", GO_TEST, [{ outcome: "passed" }, { outcome: "passed" }]) }));
    expect(findingOf(sim, "correctness", "F1").proof).toMatchObject({ state: "unproven", reason: "test does not fail" });
    const d = draftOf(sim);
    expect(d.comments.filter((c) => c.kind === "finding")).toEqual([]);
    expect(judgment(sim)).toMatchObject({ reason: "unproven: test does not fail", severity: "P2", test: { name: "TestParseWeek", runs: ["passed", "passed"] } });
    expect(d.recommended).not.toBe("request-changes");
    expect(stopOf(sim)!.blocker).toMatch(/changes requested|passed/);
  });

  it("is unproven when the verifier judges the test does not demonstrate the bug, though it fails", () => {
    const sim = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1(demonstrates(false))], { "repro-F1": reproStub("F1", "go", GO_TEST, FAILED) }));
    expect(findingOf(sim, "correctness", "F1").proof).toMatchObject({ state: "unproven", reason: "does not demonstrate", record: { runs: ["failed", "failed"] } });
    expect(judgment(sim)).toMatchObject({ reason: "unproven: does not demonstrate", proof: { state: "unproven" } });
    expect(draftOf(sim).recommended).not.toBe("request-changes");
  });

  it("is inconclusive when the test does not build, and flaky when it fails once", () => {
    const build = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1(demonstrates(false))], { "repro-F1": reproStub("F1", "go", GO_TEST, [{ outcome: "build-failed", message: "undefined: ParseTTL" }, { outcome: "build-failed" }]) }));
    expect(judgment(build)).toMatchObject({ reason: "unproven: inconclusive (build failed)" });
    const flaky = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1(demonstrates(false))], { "repro-F1": reproStub("F1", "go", GO_TEST, [{ outcome: "failed", at: 6 }, { outcome: "passed" }]) }));
    expect(judgment(flaky)).toMatchObject({ reason: "unproven: flaky" });
  });

  it("is unproven with no test when the reviewer wrote none, and no job runs", () => {
    const sim = run(scenario([passReply(1, [find()]), ...empty()], [confirmF1()], {}));
    expect(reproJobs(sim)).toEqual([]);
    expect(findingOf(sim, "correctness", "F1").proof).toMatchObject({ state: "unproven", reason: "no test" });
    expect(judgment(sim)).toMatchObject({ reason: "unproven: no test" });
  });

  it("is unproven (sandbox unavailable) when Docker is not there, and no test runs outside the sandbox", () => {
    const s = scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1()]);
    s.commands!["sandbox-go"] = { exitCode: 0, stdout: "unavailable: docker is not available in a rehearsal\n" };
    const sim = run(s);
    expect(reproJobs(sim)).toEqual([]);
    expect(judgment(sim)).toMatchObject({ reason: expect.stringMatching(/^unproven: sandbox unavailable \(docker unavailable: docker is not available in a rehearsal\)/) });
  });

  it("is unproven (execution disabled by the profile) when review.repro.enabled is false", () => {
    const off = { review: { repro: { enabled: false } } };
    const sim = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1()], {}, off), off);
    expect(reproJobs(sim)).toEqual([]);
    expect(judgment(sim)).toMatchObject({ reason: "unproven: execution disabled by the profile" });
    expect(assignmentOf(sim.jobs.find((j) => j.kind === "agent" && j.jobId === "reviewer-correctness")!)).toContain("Tests are not run in this review");
  });

  it("runs P0 and P1 findings first and leaves the rest unproven (repro budget exhausted) when the time budget is spent", () => {
    const second = repro({ name: "TestParseDays", text: GO_TEST.replace("TestParseWeek", "TestParseDays") });
    const pass = passReply(1, [find({ severity: "P2", start_line: 20, end_line: 21, content: "d is refused too.", repro: second }), find({ severity: "P0", start_line: 10, end_line: 12, repro: repro() })]);
    const budget = { review: { repro: { perFindingMs: 120_000, timeBudgetMs: 120_000 } } };
    const sim = run(
      scenario(
        [pass, passReply(1, []), ...empty()],
        [verifyReply([
          { finding: "F1", verdict: "confirmed", witness: `${PATH}:21`, ...demonstrates() },
          { finding: "F2", verdict: "confirmed", witness: `${PATH}:11`, ...demonstrates() },
        ])],
        { "repro-F2": reproStub("F2", "go", GO_TEST, FAILED), "repro-F1": reproStub("F1", "go", second.text, FAILED) },
        budget,
      ),
      budget,
    );
    expect(reproJobs(sim).map((j) => (j.input as { commands: Array<{ id: string }> }).commands[0]!.id)).toEqual(["repro-F2"]);
    expect(findingOf(sim, "correctness", "F2").proof).toMatchObject({ state: "proven" });
    expect(findingOf(sim, "correctness", "F1").proof).toMatchObject({ state: "unproven", reason: "repro budget exhausted" });
  });
});

describe("a failing test proves nothing unless the verifier validly confirms the finding", () => {
  const stubs = { "repro-F1": reproStub("F1", "go", GO_TEST, FAILED), "rvq-correctness-1-1": { exitCode: 0, stdout: "1 ok\nchecked 1\n" } };
  const quote = [{ path: PATH, line: 7, text: "unit := byte(0)" }];
  const cases: Array<[string, unknown, string, string]> = [
    ["refutes it", verifyReply([{ finding: "F1", verdict: "refuted", quotes: quote, reason: "the case exists", ...demonstrates() }]), "dismissed", "verifier did not confirm (refuted)"],
    ["is uncertain", verifyReply([{ finding: "F1", verdict: "uncertain", reason: "cannot tell", ...demonstrates() }]), "disputed", "verifier did not confirm (uncertain)"],
    ["gives no verdict", verifyReply([]), "disputed", "verifier did not confirm"],
    ["confirms without a witness", confirmF1({ witness: "" }), "disputed", "verifier did not confirm (no valid witness)"],
  ];
  for (const [name, verdict, state, reason] of cases) {
    it(`downgrades the proof when the verifier ${name}, and the Review stage still validates`, () => {
      const sim = run(scenario([passReply(1, [find({ repro: repro() })]), ...empty(), passReply(1, [])], [verdict, verdict], stubs));
      expect(findingOf(sim, "correctness", "F1")).toMatchObject({ state, proof: { state: "unproven", reason, record: { runs: ["failed", "failed"] } } });
      const evidence = candidateEvidence(sim.evidence, "d1");
      expect(findingsProven.evaluate({ requirementId: "findings-proven", statement: "", evidence, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed" });
      expect(sim.receipts.some((r) => r.requirementId === "findings-proven" && r.valid)).toBe(true);
    });
  }
});

describe("the time budget holds across the passes of one aspect", () => {
  it("runs one test with a budget of one, though a later pass of the same aspect raises another", () => {
    const second = repro({ name: "TestParseDays", text: GO_TEST.replace("TestParseWeek", "TestParseDays") });
    const budget = { review: { repro: { perFindingMs: 120_000, timeBudgetMs: 120_000 } } };
    const sim = run(
      scenario(
        [passReply(1, [find({ repro: repro() })]), passReply(1, [find({ start_line: 20, end_line: 21, repro: second })]), ...empty()],
        [confirmF1(), verifyReply([{ finding: "F2", verdict: "confirmed", witness: `${PATH}:21`, ...demonstrates() }])],
        { "repro-F1": reproStub("F1", "go", GO_TEST, FAILED), "repro-F2": reproStub("F2", "go", second.text, FAILED) },
        budget,
      ),
      budget,
    );
    expect(reproJobs(sim).map((j) => (j.input as { commands: Array<{ id: string }> }).commands[0]!.id)).toEqual(["repro-F1"]);
    expect(findingOf(sim, "correctness", "F1").proof).toMatchObject({ state: "proven" });
    expect(findingOf(sim, "correctness", "F2").proof).toMatchObject({ state: "unproven", reason: "repro budget exhausted" });
  });
});

describe("a comment's test goes back for correction, and a non-behavioral comment the verifier reclassifies needs a test", () => {
  it("sends an over-size test back with the problem, then runs the corrected one", () => {
    const huge = repro({ text: `${GO_TEST}// ${"x".repeat(17_000)}\n` });
    const sim = run(scenario([passReply(1, [find({ repro: huge })]), passReply(1, [find({ repro: repro() })]), ...empty()], [confirmF1()], { "repro-F1": reproStub("F1", "go", GO_TEST, FAILED) }));
    const passes = sim.jobs.filter((j) => j.kind === "agent" && j.resultSchema === REVIEW_SCHEMA_NAME).map(assignmentOf);
    expect(passes[1]).toContain("correct every problem");
    expect(passes[1]).toMatch(/comments\[0\]\.repro\.text is \d+ bytes, more than the 16384 a test may be/);
    expect(findingOf(sim, "correctness", "F1").proof).toMatchObject({ state: "proven" });
  });

  it("sends a malformed test back (a test name the file does not declare)", () => {
    const sim = run(scenario([passReply(1, [find({ repro: repro({ name: "TestNothing" }) })]), passReply(1, [find()]), ...empty()], [confirmF1()], {}));
    expect(sim.jobs.filter((j) => j.kind === "agent" && j.resultSchema === REVIEW_SCHEMA_NAME).map(assignmentOf)[1]).toMatch(/must declare func TestNothing\(t \*testing\.T\)/);
  });

  it("reclassifies a non-behavioral comment that claims wrong behavior: it has no test, so it is unproven (no test)", () => {
    const passes = [passReply(1, []), passReply(1, [find({ aspect: "maintainability", kind: "non-behavioral", content: "dereferences a nil", severity: "P2" })]), passReply(1, []), passReply(1, [])];
    const sim = run(scenario(passes, [verifyReply([{ finding: "F1", verdict: "confirmed", kind: "behavioral", witness: `${PATH}:11`, ...demonstrates(false) }])]));
    const f = findingOf(sim, "maintainability", "F1");
    expect(f).toMatchObject({ kind: "behavioral", proof: { state: "unproven", reason: "no test" }, notes: [expect.stringContaining("reclassified it as behavioral")] });
    expect(draftOf(sim).judgment[0]).toMatchObject({ id: "F1", reason: "unproven: no test" });
    expect(reproJobs(sim)).toEqual([]);
  });

  it("drops the suggestion of a behavioral finding even when proven: its fix run is a later part", () => {
    const sim = run(scenario([passReply(1, [find({ repro: repro(), suggestion: "\tcase 'w':\n\t\tn *= 168\n" })]), ...empty()], [confirmF1({ fixes: true })], { "repro-F1": reproStub("F1", "go", GO_TEST, FAILED) }));
    const entry = draftOf(sim).comments.find((c) => c.id === "F1")!;
    expect(entry.suggestion).toBeUndefined();
    expect(entry.proof?.state).toBe("proven");
  });
});
