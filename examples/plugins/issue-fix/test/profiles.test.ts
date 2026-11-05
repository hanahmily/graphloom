// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceRecord, JobSpec, RunView } from "@graphloom/sdk";
import {
  advanceFix,
  exampleBenchReport,
  writeTextFileCommand,
  writtenText,
  MAX_BENCH_REPORT_BYTES,
  codeReviewInstruction,
  createGraph,
  decisionProblems,
  definitionFor,
  implementInstruction,
  isTestPath,
  isTiered,
  commandsFor,
  commandsInTier,
  parseProfile,
  planInstruction,
  ProfileError,
  pullRequestDescription,
  shippedProfile,
  validatorById,
  validatorsFor,
  namePattern,
  vitestArgv,
  vitestOutcome,
  vitestOutput,
  vitestSummary,
  writeScopeFor,
  type DecisionRecord,
} from "../src/index.js";
import { outOfScope } from "../src/decision-record.js";
import { regeneratedPaths } from "../src/profile.js";
import { rehearsal } from "../src/rehearsal.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const BANYANDB = shippedProfile("banyandb");
const GRAPHLOOM = shippedProfile("graphloom");
const banyandb = parseProfile(BANYANDB);
const graphloom = parseProfile(GRAPHLOOM);
const CANOPY = shippedProfile("canopy");
const canopy = parseProfile(CANOPY);

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const GO_PLAN: DecisionRecord = {
  status: "ready",
  summary: "Warn at the timeout while the action is still running.",
  title: "Stop reporting long scheduled actions as timed out",
  test: { package: "./pkg/timestamp", name: "TestSchedulerWarnsWhileRunning", expectedValueSource: "the issue" },
  productionCaller: "pkg/timestamp.Scheduler.trigger",
  decisions: [{ point: "What to do at five minutes", tier: "behaviour", options: ["cancel", "warn and wait"], chosen: "warn and wait", basis: "the issue" }],
  openQuestions: ["Should TotalTasksTimeout keep counting actions that are still running?"],
  followUps: ["Look at the lifecycle actions too."],
  needsE2E: true,
};
const TS_TEST = "packages/sdk/src/scope.test.ts";
const TS_PLAN: DecisionRecord = {
  ...GO_PLAN,
  test: { package: TS_TEST, name: "writeScopeAllows forbids a path below an excluded directory", expectedValueSource: "the issue" },
  productionCaller: "packages/sdk/src/scope.ts writeScopeAllows",
};

describe("the banyandb profile", () => {
  it("describes the graph identity and finds the plugin's bundled open-code-review first", () => {
    const ours = createGraph().describe(BANYANDB);
    expect(ours.environment?.checks?.find((c) => c.id === "ocr")?.argv.join(" ")).toContain("scripts/ocr-path.sh");
    expect(ours).toMatchObject({ graphId: "issue-fix", version: "0.16.2", privateStateSchema: "issue-fix-private-v1" });
  });

  it("declares its agent roles from the resolved profile for graphloom doctor --task (0.15.0)", () => {
    expect(createGraph().describe(BANYANDB).agentRoles).toEqual([
      { role: "implementer", harness: "claude-code", access: "write", setting: "harnesses.implementer" },
      { role: "reviewer", harness: "codex", access: "read", setting: "harnesses.reviewer" },
      { role: "verifier", harness: "claude-code", access: "read", distinctFrom: ["reviewer"], setting: "harnesses.verifier" },
    ]);
    const swapped = createGraph().describe({ ...(BANYANDB as object), harnesses: { implementer: "pi", reviewer: "claude-code", verifier: "codex" } });
    expect(swapped.agentRoles?.map((r) => [r.role, r.harness])).toEqual([["implementer", "pi"], ["reviewer", "claude-code"], ["verifier", "codex"]]);
  });

  it("declares its supervisor preference, Pi first, from the profile (0.16.0, design-supervisor-harnesses.md §7.6)", () => {
    for (const name of ["banyandb", "banyandb-ql", "canopy", "graphloom"] as const) {
      expect(createGraph().describe(shippedProfile(name)).supervisor).toEqual({ harnesses: ["pi", "claude-code", "codex"] });
    }
    const { supervisor: _declared, ...undeclared } = BANYANDB as Record<string, unknown>;
    void _declared;
    expect(createGraph().describe(undeclared).supervisor).toEqual({ harnesses: ["pi", "claude-code", "codex"] });
    const preferred = { harnesses: ["claude-code", "codex"], models: { "claude-code": ["opus"] }, required: true };
    expect(createGraph().describe({ ...(BANYANDB as object), supervisor: preferred }).supervisor).toEqual(preferred);
    // Independent of the jobs' own harnesses.
    expect(createGraph().describe({ ...(BANYANDB as object), harnesses: { implementer: "pi", reviewer: "claude-code", verifier: "codex" } }).supervisor?.harnesses).toEqual(["pi", "claude-code", "codex"]);
    const bad = (supervisor: unknown) => () => createGraph().describe({ ...(BANYANDB as object), supervisor });
    expect(bad([])).toThrow(/supervisor must be an object/);
    expect(bad({ harnesses: [] })).toThrow(/supervisor.harnesses must be a non-empty list/);
    expect(bad({ harnesses: ["gemini"] })).toThrow(/"gemini" is not one of pi, claude-code, codex/);
    expect(bad({ harnesses: ["pi", "pi"] })).toThrow(/must not repeat/);
    expect(bad({ harnesses: ["pi"], models: { gemini: ["x"] } })).toThrow(/supervisor.models.gemini/);
    expect(bad({ harnesses: ["pi"], required: "yes" })).toThrow(/supervisor.required/);
    expect(bad({ harnesses: ["pi"], select: "pi" })).toThrow(/supervisor.select is not a supervisor setting/);
  });

  it("splits make generate into separately cached steps with narrow inputs (#174)", () => {
    const step = (id: string) => banyandb.environment.prepare?.find((c) => c.id === id);
    expect(banyandb.environment.prepare?.map((c) => c.id)).toEqual(["generate-proto", "generate-mcp", "generate-directives", "generate-mocks"]);
    expect(step("generate-proto")?.inputs).toEqual(expect.arrayContaining(["api/proto/**/*.proto", "api/Makefile"]));
    expect(step("generate-proto")?.outputs).toEqual(expect.arrayContaining(["api/proto/**/*.pb.go"]));
    expect(step("generate-mcp")?.inputs).toEqual(["mcp/package.json", "mcp/package-lock.json", "mcp/Makefile"]);
    expect(step("generate-mcp")?.outputs).toEqual(["mcp/node_modules/**"]);
    // Mocks depend on the packages their go:generate directives name, not on every Go file, so a candidate's edits elsewhere still hit.
    const mocks = step("generate-mocks");
    expect(mocks?.inputs).toEqual(expect.arrayContaining(["banyand/queue/*.go", "pkg/bus/*.go", "go.mod", "!**/*_test.go"]));
    expect(mocks?.inputs?.some((g) => g === "banyand/**/*.go" || g === "pkg/**/*.go")).toBe(false);
    // The directive guard has no inputs: it always runs.
    expect(step("generate-directives")?.inputs).toBeUndefined();
  });

  it("restores every tool file the full tier reads from bin/ along with the step that installs it (#199)", () => {
    // `make lint` and `make format` (which `make check` runs through check-format) call bin/buf from api/ without
    // a recipe that installs it: lint-api.mk expands $(BUF) before api/Makefile defines it. Only `make generate`
    // installs it, so a generate-proto cache hit must restore it. golangci-lint, revive, ginkgo and license-eye
    // are prerequisites of the targets that use them, and mockgen is only used by the generate steps.
    for (const config of [BANYANDB, shippedProfile("banyandb-ql")]) {
      const profile = parseProfile(config);
      const restoring = (file: string) => profile.environment.prepare?.filter((c) => c.outputs?.includes(file)).map((c) => c.id);
      expect(restoring("bin/buf"), profile.name).toEqual(["generate-proto"]);
    }
  });
});

describe("the graphloom profile", () => {
  it("has no changelog requirement, and checks typecheck, build and the full suite", () => {
    const definition = createGraph().describe(GRAPHLOOM);
    expect(definition.stages).toEqual([
      { id: "fix", name: "Fix", requirementIds: ["decisions-recorded", "reproduces", "passes", "builds", "in-scope"] },
      { id: "review", name: "Review", requirementIds: ["code-review"] },
    ]);
    expect(definition.requirements.map((r) => r.id)).not.toContain("changelog-entry");
    expect(definition.defaultValidators.map((b) => b.validatorId)).not.toContain("changes-entry");
    const statement = (id: string) => definition.requirements.find((r) => r.id === id)!.statement;
    expect(statement("builds")).toBe("In the same checkout of the full change, npm run typecheck, npm run build and npm test all pass and change no file.");
    expect(statement("passes")).toBe("In a prepared checkout of the full change, the named regression test passes, and the checks changed no file.");
    expect(statement("in-scope")).toBe("Every changed path is inside the repository and outside package-lock.json and .github, except those the decision record names with a reason.");
    expect(statement("reproduces")).toContain("vitest reports it failed with an assertion error in its own body, its file loaded, and no hook, suite or file around it failed");
    expect(definition.environment!.checks!.map((c) => c.id)).toEqual(["node", "npm", "flock", "git", "ocr", "codex", "claude"]);
    expect(definition.environment!.prepare!.map((c) => c.argv.join(" "))).toEqual(["npm ci --include=dev", "npm run build"]);
    expect(graphloom.commands.find((c) => c.id === "test")!.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("names hanahmily/graphloom issues and tells the planner how vitest names a test", () => {
    const plan = planInstruction(graphloom, { issue: 7, request: "Fix hanahmily/graphloom#7.", snapshot: "snap" });
    expect(plan).toContain("Plan a fix for hanahmily/graphloom#7 in this repository (hanahmily/graphloom).");
    expect(plan).toContain("package is the test file, relative to the repository root");
    expect(plan).toContain("scopeExceptions: only when the fix must change package-lock.json, .github");
    // Enhancement issues: the new test is the RED test, and the issue's own surface is not a product decision.
    expect(plan).toContain("About hanahmily/graphloom:");
    expect(plan).toContain("Issues here are often enhancements rather than bug reports.");
    expect(plan).toContain("is what was asked for, not an open product decision");
    expect(planInstruction(banyandb, { issue: 7, request: "r", snapshot: "s" })).not.toContain("About ");
    const implement = implementInstruction(graphloom, { issue: 7, plan: TS_PLAN });
    expect(implement).toContain("keeps the new names and signatures the test imports but restores the old behaviour");
    expect(implement).not.toContain("CHANGES");
    expect(implement).toContain("Do not change package-lock.json, .github.");
    expect(implement).toContain("the full change must pass the test and `npm run typecheck`, `npm run build` and `npm test`");
    const review = codeReviewInstruction(graphloom, { ocr: "ocr", base: "b", background: "" });
    expect(review).toContain("the change's TypeScript test files (`*.test.ts`) and test fixtures, other tests, docs, fixtures, generated files");
    expect(review).toContain("Extra rule for TypeScript files:");
    const body = pullRequestDescription(graphloom, { issue: 7, issueTitle: "t", record: TS_PLAN, base: "abc", review: "Reviewed." });
    expect(body).toContain("### Fix hanahmily/graphloom#7: t");
    expect(body).toContain("- `npm run typecheck`, `npm run build` and `npm test` pass.");
    expect(body).toContain("The live-provider tests were not run");
    expect(body.endsWith("Fixes hanahmily/graphloom#7.")).toBe(true);
    expect(body).not.toContain("CHANGES");
  });

  it("protects the lockfile and .github unless the record gives a reason", () => {
    expect(writeScopeFor(TS_PLAN, graphloom)).toEqual([".", "!package-lock.json", "!.github"]);
    expect(writeScopeFor({ ...TS_PLAN, scopeExceptions: [{ path: "package-lock.json", reason: "a new dependency" }] }, graphloom)).toEqual([".", "!.github"]);
    expect(decisionProblems({ ...TS_PLAN, scopeExceptions: [{ path: "go.mod", reason: "x" }] }, graphloom)).toEqual([
      'scope exception "go.mod" is not one of package-lock.json, .github',
    ]);
  });

  it("accepts a vitest test and refuses a Go one", () => {
    expect(decisionProblems(TS_PLAN, graphloom)).toEqual([]);
    expect(decisionProblems(GO_PLAN, graphloom)).toEqual(['test file "./pkg/timestamp" is not a repository-relative test file']);
    expect(decisionProblems(TS_PLAN, banyandb)).toEqual([
      'test package "packages/sdk/src/scope.test.ts" is not a ./relative Go package',
      'test name "writeScopeAllows forbids a path below an excluded directory" is not a TestXxx function',
    ]);
  });

  it("runs GREEN and the build checks, then RED with only the test files, without observing a changelog", () => {
    const config = GRAPHLOOM;
    const producer = (op: string, purpose: string, extra: Record<string, unknown> = {}) => ({ operationId: op, stageId: "fix", purpose, readOnly: purpose !== "work", kind: "agent", executorId: "graphloom.coding-agent/run", ...extra });
    const evidence: EvidenceRecord[] = [
      { ref: "e1", kind: "other", generation: 1, payload: { github: { item: { number: 7, title: "t", state: "open", url: "u", body: "b", labels: [] } }, producer: { ...producer("op1", "diagnostic"), kind: "command", executorId: "graphloom.github/get-issue" } } },
      { ref: "e2", kind: "other", generation: 1, payload: { github: { items: [], page: { complete: true } }, producer: { ...producer("op2", "diagnostic"), kind: "command", executorId: "graphloom.github/list-issue-comments" } } },
      { ref: "e3", kind: "other", generation: 1, payload: { codingAgent: { harness: "claude-code", status: "completed", output: TS_PLAN }, producer: producer("op3", "diagnostic") } },
      { ref: "e4", kind: "other", generation: 1, candidateDigest: "d1", payload: { codingAgent: { harness: "claude-code", status: "completed", output: TS_PLAN }, producer: producer("op4", "work") } },
    ];
    const view = (records: EvidenceRecord[]): RunView => ({
      runId: "r",
      task: { request: "Fix hanahmily/graphloom#7." },
      current: { stageId: "fix", attempt: 1 },
      receipts: [],
      evidence: records,
      outstanding: [],
      budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 4 },
      validatorBindings: [],
      generation: 1,
      stateRevision: 1,
      activeVersion: "issue-fix@0.1.0",
      candidateDigest: "d1",
      config,
    });
    const green = advanceFix(view(evidence));
    expect(green.action.type).toBe("dispatch");
    const job = (green.action as { job: JobSpec }).job;
    expect(job.checkout).toEqual({ from: "candidate" });
    const commands = (job.input as { commands: Array<{ id: string; argv: string[] }> }).commands;
    expect(commands.map((c) => c.id)).toEqual(["regression", "typecheck", "build", "test"]);
    expect(commands[0]!.argv.slice(3, 6)).toEqual(["regression", TS_TEST, TS_PLAN.test!.name]);
    const checkout = { from: "candidate", base: "b", commit: "c1", paths: ["packages/sdk/src/scope.ts", TS_TEST], prepared: true, mutations: [], phase: "run" };
    const ran = commands.map((c, i): EvidenceRecord => ({
      ref: `g${i}`,
      kind: "command",
      generation: 1,
      candidateDigest: "d1",
      payload: { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: "", stderrTail: "" }, checkout, producer: { operationId: "op5", stageId: "fix", purpose: "check", readOnly: true, kind: "command" } },
    }));
    const red = advanceFix(view([...evidence, ...ran]));
    expect((red.action as { job: JobSpec }).job.checkout).toEqual({ from: "base", paths: [TS_TEST] });

    // An enhancement's new test calls an export the base lacks: RED cannot load it, so the graph asks for a revert patch.
    const redArgv = ((red.action as { job: JobSpec }).job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    const unloadable = JSON.stringify({
      GraphLoomVitest: {
        target: { file: TS_TEST, name: TS_PLAN.test!.name },
        files: [{ name: `/w/${TS_TEST}`, status: "failed", message: "" }],
        tests: [{ fullName: TS_PLAN.test!.name, status: "failed", failure: "TypeError: (0 , writeScopeAllows) is not a function" }],
      },
    });
    const baseRun: EvidenceRecord = {
      ref: "r1",
      kind: "command",
      generation: 1,
      candidateDigest: "d1",
      payload: {
        command: { id: "regression", argv: redArgv, exitCode: 1, stdoutTail: "", stderrTail: "", report: { text: unloadable, truncated: false } },
        checkout: { ...checkout, from: "base", commit: "b1", paths: [TS_TEST] },
        producer: { operationId: "op6", stageId: "fix", purpose: "check", readOnly: true, kind: "command" },
      },
    };
    const ask = (advanceFix(view([...evidence, ...ran, baseRun])).action as { job: JobSpec }).job;
    expect(ask).toMatchObject({ purpose: "work", jobId: "implementer" });
    expect((ask.input as { assignment: string }).assignment).toContain('Add a "revertPatch" field to your decision record');

    // A correction renames the test without changing a byte: the old test's GREEN must not stand for the new one.
    const renamed = { ...TS_PLAN, test: { ...TS_PLAN.test!, name: "writeScopeAllows forbids a renamed path" } };
    const correction: EvidenceRecord = { ref: "e9", kind: "other", generation: 1, candidateDigest: "d1", payload: { codingAgent: { harness: "claude-code", status: "completed", output: renamed }, producer: producer("op9", "work") } };
    const again = advanceFix(view([...evidence, ...ran, correction]));
    const rerun = (again.action as { job: JobSpec }).job;
    expect(rerun.checkout).toEqual({ from: "candidate" });
    expect((rerun.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv[5]).toBe(renamed.test.name);
  });
});

describe("profiles", () => {
  it("refuses a run without a profile, or with one the graph cannot use", () => {
    expect(() => createGraph().describe()).toThrow(ProfileError);
    expect(() => createGraph().describe()).toThrow(/names no profile/);
    const broken = (patch: Record<string, unknown>) => () => parseProfile({ ...(GRAPHLOOM as object), ...patch });
    expect(broken({ regression: { runner: "pytest" } })).toThrow(/regression.runner must be one of go-test, vitest/);
    expect(broken({ commands: [{ id: "regression", argv: ["x"], requirement: "builds" }] })).toThrow(/reserved/);
    expect(broken({ environment: { checks: [] } })).toThrow(/"ocr" check/);
    expect(broken({ harnesses: { reviewer: "claude-code" } })).toThrow(/verifier must differ/);
    expect(broken({ changelog: { path: "CHANGES.md", rule: "anywhere" } })).toThrow(/changelog.rule/);
    expect(broken({ budgets: [] })).toThrow(/budgets must be an object/);
    expect(broken({ budgets: { tokens: 10 } })).toThrow(/budgets.tokens is not a budget/);
    expect(broken({ budgets: { jobs: 0 } })).toThrow(/budgets.jobs must be a positive integer/);
  });

  it("reads the coding agents' wall clock and timeout continuations, and refuses unusable ones", () => {
    expect(banyandb.agent).toBeUndefined();
    expect(banyandb.timeoutContinuations).toBe(1);
    expect(parseProfile(shippedProfile("banyandb-ql"))).toMatchObject({ agent: { timeoutMs: 10_800_000 }, timeoutContinuations: 1 });
    for (const config of [GRAPHLOOM, CANOPY, BANYANDB]) expect(parseProfile(config).agent?.timeoutMs).toBeUndefined();
    const agent = (value: unknown) => () => parseProfile({ ...(GRAPHLOOM as object), agent: value });
    expect(agent({ timeoutMs: 7_200_000, timeoutContinuations: 0 })()).toMatchObject({ agent: { timeoutMs: 7_200_000 }, timeoutContinuations: 0 });
    expect(agent({ timeoutContinuations: 3 })().timeoutContinuations).toBe(3);
    expect(agent([])).toThrow(/agent must be an object/);
    expect(agent({ timeout: 1 })).toThrow(/agent.timeout is not an agent setting/);
    expect(agent({ timeoutMs: 0 })).toThrow(/agent.timeoutMs must be a positive integer/);
    expect(agent({ timeoutMs: 25 * 3_600_000 })).toThrow(/agent.timeoutMs must be a positive integer of at most 86400000/);
    expect(agent({ timeoutContinuations: 4 })).toThrow(/agent.timeoutContinuations must be a whole number from 0 to 3/);
    expect(agent({ timeoutContinuations: -1 })).toThrow(/agent.timeoutContinuations/);
  });

  it("checks the context documents a profile declares (#195)", () => {
    const issues = (context: unknown) => () => parseProfile({ ...(GRAPHLOOM as object), issues: { owner: "hanahmily", repo: "graphloom", context } });
    expect(issues([{ path: "docs/a.md" }, { repo: "acme/design", path: "docs/b.md", ref: "main" }])).not.toThrow();
    expect(issues(undefined)).not.toThrow();
    expect(issues("docs/a.md")).toThrow(/issues.context must be a list/);
    expect(issues([{ repo: "acme/design" }])).toThrow(/issues.context\[0\].path is required/);
    expect(issues([{ path: "../secrets" }])).toThrow(/must be repository-relative/);
    expect(issues([{ path: "/etc/passwd" }])).toThrow(/must be repository-relative/);
    expect(issues([{ path: "a//b" }])).toThrow(/must be repository-relative/);
    expect(issues([{ repo: "design", path: "a.md" }])).toThrow(/repo must be "owner\/name"/);
    expect(issues([{ path: "a.md", ref: "main" }])).toThrow(/ref applies only to a document from another repository/);
    expect(issues([{ path: "a.md", url: "x" }])).toThrow(/url is not a context document field/);
    expect(issues([{ path: "a.md" }, { path: "a.md" }])).toThrow(/repeats a.md/);
    // The same path at another ref, or in another repository, is another document.
    expect(issues([{ repo: "acme/design", path: "a.md" }, { repo: "acme/design", path: "a.md", ref: "next" }, { repo: "acme/other", path: "a.md" }])).not.toThrow();
  });

  it("declares the profile's measured budgets as the graph's default budgets (#150)", () => {
    expect(definitionFor(graphloom).defaultBudgets).toEqual({ agentInvocations: 1800, jobs: 250, decisions: 350, corrections: 30, activeMs: 36_000_000, waitMs: 21_600_000 });
    expect(definitionFor(banyandb).defaultBudgets).toEqual({ agentInvocations: 6000, jobs: 250, decisions: 500, corrections: 100, activeMs: 72_000_000, waitMs: 21_600_000 });
    const { budgets: _b, ...unbudgeted } = GRAPHLOOM as Record<string, unknown>;
    void _b;
    expect(definitionFor(parseProfile(unbudgeted)).defaultBudgets).toBeUndefined();
    // Budgets are checked one by one here; how they relate is the controller's
    // check on the run's final budgets, after the task's own override them.
    const tight = parseProfile({ ...(GRAPHLOOM as object), budgets: { agentInvocations: 100, recoveryReserve: 100 } });
    expect(definitionFor(tight).defaultBudgets).toEqual({ agentInvocations: 100, recoveryReserve: 100 });
  });

  it("stops a run whose view carries no usable profile, instead of guessing one", () => {
    const view = { runId: "r", task: { request: "Fix #1." }, current: { stageId: "fix", attempt: 1 }, receipts: [], evidence: [], outstanding: [], budgets: { agentInvocations: 1, jobs: 1, decisions: 1, corrections: 1 }, validatorBindings: [], generation: 1, stateRevision: 0, activeVersion: "v" };
    expect(advanceFix(view).action).toMatchObject({ type: "stop", stop: { reason: "incompatible task" } });
  });

  it("validators read the profile from their input, and validatorsFor binds it in-process", () => {
    const input = { requirementId: "decisions-recorded", statement: "s", evidence: [] };
    expect(validatorById("decisions-recorded")!.evaluate(input)).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/names no profile/) });
    expect(validatorsFor(GRAPHLOOM)["decisions-recorded"]!.evaluate(input)).toMatchObject({ status: "inconclusive", reason: "the implementer has not run" });
  });

  it("every shipped profile describes the same graph identity and fixed stage ids", () => {
    for (const config of [BANYANDB, GRAPHLOOM]) {
      const d = definitionFor(parseProfile(config));
      expect(d.stages.map((s) => s.id)).toEqual(["fix", "review"]);
      expect(createGraph().describe(config)).toEqual(d);
    }
  });

  it("hands the rehearsal the scenario for the profile's runner, and its replies satisfy that profile", () => {
    expect(Object.keys(rehearsal(BANYANDB).scenarios)).toEqual(["happy", "review-reenters"]);
    const record = rehearsal(GRAPHLOOM).scenarios.happy!.results["decision-record-v2"]![0]!.output as DecisionRecord;
    expect(decisionProblems(record, graphloom)).toEqual([]);
    const goRecord = rehearsal(BANYANDB).scenarios.happy!.results["decision-record-v2"]!.at(-1)!.output as DecisionRecord;
    expect(decisionProblems(goRecord, banyandb)).toEqual([]);
  });

  it("hands the banyandb-ql rehearsal a stub benchmark runner that the real validator passes, and one that fails a hard gate (#197)", () => {
    const QL = shippedProfile("banyandb-ql");
    const scenarios = rehearsal(QL).scenarios;
    expect(Object.keys(scenarios)).toEqual(["happy", "bench-gate-fails"]);
    const judge = (stdout: string) =>
      validatorById("bench-gates")!.evaluate({
        requirementId: "bench-gates",
        statement: "s",
        candidateDigest: "d1",
        config: QL,
        evidence: [
          {
            ref: "b1",
            kind: "command",
            candidateDigest: "d1",
            payload: {
              command: { id: "bench-gates", argv: ["sh"], exitCode: 0, stdoutTail: stdout, stderrTail: "" },
              checkout: { from: "candidate", base: "b", commit: "c", paths: [], prepared: true, mutations: [], phase: "run" },
              producer: { operationId: "op", stageId: "review", purpose: "check", readOnly: true, kind: "command" },
            },
          },
        ],
      });
    // What the stub runner (a GNUmakefile the stand-in writes) leaves as build/bench/ql-report.json, in the wrapper's envelope.
    const stubReport = (name: string, pass: number): string => {
      const make = scenarios[name]!.results["decision-record-v2"]![pass]!.effects!.find((e) => e.path === "GNUmakefile")!.bytes;
      expect(make).toContain("include Makefile");
      expect(make).toContain("bench-ql-report:");
      const report = /printf '%s\\n' '(.*)' > build\/bench\/ql-report\.json/.exec(make)![1]!;
      return JSON.stringify({ harness: { image: "golang:1.26.10", cpus: 4, memory: "8g", memorySwap: "8g" }, report: JSON.parse(report) });
    };
    expect(judge(stubReport("happy", 1))).toMatchObject({ status: "passed" });
    // The first candidate's runner fails a hard gate; the corrected one passes.
    expect(judge(stubReport("bench-gate-fails", 1))).toMatchObject({ status: "failed", reason: expect.stringContaining("exact results: 3 of 52224 results differ from the oracle") });
    expect(judge(stubReport("bench-gate-fails", 2))).toMatchObject({ status: "passed" });
    expect(scenarios["bench-gate-fails"]!.expect).toMatchObject({ status: "succeeded", receipts: ["fix", "review"] });
    expect(scenarios["bench-gate-fails"]!.supervisor).toBeUndefined();
    expect(scenarios.happy!.expect).toMatchObject({ status: "succeeded", receipts: ["fix", "review"] });
    // The replies the scenarios give satisfy the profile, as for the other go-test profiles.
    const goRecord = scenarios.happy!.results["decision-record-v2"]!.at(-1)!.output as DecisionRecord;
    expect(decisionProblems(goRecord, parseProfile(QL))).toEqual([]);
  });

  it("ships the banyandb-ql profile in the manifest's pinned files and describes it under the graph's version (#197)", async () => {
    const manifest = JSON.parse(await readFile(path.join(here, "../graphloom.manifest.json"), "utf8")) as { digests: { files: Record<string, string> } };
    expect(Object.keys(manifest.digests.files)).toContain("profiles/banyandb-ql.json");
    expect(createGraph().describe(shippedProfile("banyandb-ql"))).toMatchObject({ graphId: "issue-fix", version: "0.16.2" });
  });
});

/** The installed vitest package this suite runs on, wherever the bundle is installed. */
function vitestPackage(): string {
  // vitest's own package.json is not exported; its CommonJS-visible entry resolves from here.
  let dir = path.dirname(createRequire(import.meta.url).resolve("vitest"));
  while (!existsSync(path.join(dir, "vitest.mjs"))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error("vitest is not installed");
    dir = up;
  }
  return dir;
}

/** A one-package project with vitest installed, as the runner finds it. */
async function vitestProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-fix-vitest-"));
  temps.push(root);
  const vitest = vitestPackage();
  await mkdir(path.join(root, "node_modules/.bin"), { recursive: true });
  await symlink(vitest, path.join(root, "node_modules/vitest"));
  await symlink(path.join(vitest, "vitest.mjs"), path.join(root, "node_modules/.bin/vitest"));
  await mkdir(path.join(root, "packages/lib/src"), { recursive: true });
  await writeFile(path.join(root, "packages/lib/package.json"), JSON.stringify({ name: "lib", type: "module" }));
  await writeFile(path.join(root, "packages/lib/src/scope.ts"), "export const allows = (p: string) => !p.startsWith(\"legacy\");\n");
  await writeFile(
    path.join(root, "packages/lib/src/scope.test.ts"),
    [
      'import { describe, expect, it } from "vitest";',
      'import * as scope from "./scope.js";',
      'describe("allows (scope)", () => {',
      '  it("forbids legacy", () => { expect(scope.allows("legacy/x")).toBe(false); });',
      '  it("allows src", () => { expect(scope.allows("src/x")).toBe(true); });',
      '  it("is wrong", () => { expect(scope.allows("src/x")).toBe(false); });',
      '  it("throws", () => { throw new Error("boom"); });',
      '  it("calls a missing export", () => { (scope as unknown as { missing: () => void }).missing(); });',
      "});",
      "",
    ].join("\n"),
  );
  // Another file whose path ends like the target's, with a same-named test that fails.
  await mkdir(path.join(root, "packages/lib/other/src"), { recursive: true });
  await writeFile(
    path.join(root, "packages/lib/other/src/scope.test.ts"),
    'import { describe, expect, it } from "vitest";\ndescribe("allows (scope)", () => {\n  it("forbids legacy", () => { expect(1).toBe(2); });\n});\n',
  );
  await writeFile(path.join(root, "packages/lib/src/broken.test.ts"), 'import { it } from "vitest";\nimport { gone } from "./gone.js";\nit("loads", () => gone());\n');
  return root;
}

async function runRegression(root: string, file: string, name: string, env: NodeJS.ProcessEnv = {}) {
  const report = path.join(root, `report-${Math.random().toString(36).slice(2)}`);
  const [cmd, ...args] = vitestArgv({ package: file, name });
  const exit = await execFileAsync(cmd!, args, { cwd: root, env: { ...process.env, ...env, GRAPHLOOM_REPORT_FILE: report } }).then(
    () => 0,
    (err: { code: number }) => err.code,
  );
  const text = await readFile(report, "utf8").catch(() => "");
  return { exit, text, outcome: vitestOutcome(text, { package: file, name }) };
}

describe("vitest regression runner", () => {
  it("runs one named test in one file and tells an assertion failure from a crash and a load error", async () => {
    const root = await vitestProject();
    const file = "packages/lib/src/scope.test.ts";
    expect(await runRegression(root, file, "allows (scope) forbids legacy")).toMatchObject({ exit: 0, outcome: "passed" });
    const wrong = await runRegression(root, file, "allows (scope) is wrong");
    expect(wrong).toMatchObject({ outcome: "failed" });
    expect(wrong.exit).not.toBe(0);
    expect(vitestOutput(wrong.text)).toMatch(/allows \(scope\) is wrong: AssertionError: expected true to be false/);
    expect((await runRegression(root, file, "allows (scope) throws")).outcome).toBe("panicked");
    expect((await runRegression(root, file, "allows (scope) calls a missing export")).outcome).toBe("build-failed");
    expect((await runRegression(root, "packages/lib/src/broken.test.ts", "loads")).outcome).toBe("build-failed");
    expect((await runRegression(root, file, "allows (scope) no such test")).outcome).toBe("not-run");
  }, 120_000);

  it("judges only the requested file, not another whose path ends the same way with a same-named test", async () => {
    const root = await vitestProject();
    const target = await runRegression(root, "packages/lib/src/scope.test.ts", "allows (scope) forbids legacy");
    expect(target).toMatchObject({ exit: 0, outcome: "passed" });
    expect(vitestSummary(target.text)?.files?.map((f) => f.name)).toEqual([await realpath(path.join(root, "packages/lib/src/scope.test.ts"))]);
    expect((await runRegression(root, "packages/lib/other/src/scope.test.ts", "allows (scope) forbids legacy")).outcome).toBe("failed");
  }, 120_000);

  it("does not take a test whose hook, suite or file failed around it as RED or as GREEN", async () => {
    const root = await vitestProject();
    const file = "packages/lib/src/hooks.test.ts";
    await writeFile(
      path.join(root, file),
      [
        'import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";',
        'describe("before", () => {',
        "  beforeEach(() => { expect(1).toBe(2); });",
        '  it("passes", () => { expect(1).toBe(1); });',
        "});",
        'describe("after each", () => {',
        "  afterEach(() => { expect(1).toBe(2); });",
        '  it("passes", () => { expect(1).toBe(1); });',
        "});",
        'describe("cleanup", () => {',
        "  afterAll(() => { expect(1).toBe(3); });",
        '  it("passes", () => { expect(1).toBe(1); });',
        "});",
        'describe("clean", () => {',
        '  it("fails", () => { expect(1).toBe(2); });',
        "});",
        "",
      ].join("\n"),
    );
    // A failing beforeEach: vitest reports the test failed by assertion, but its body never ran.
    const before = await runRegression(root, file, "before passes");
    expect(before.outcome).toBe("setup-failed");
    expect(before.exit).not.toBe(0);
    expect(vitestOutput(before.text)).toContain("(in a hook)");
    expect((await runRegression(root, file, "after each passes")).outcome).toBe("setup-failed");
    // A failing afterAll: the test passed, but the run did not clean up.
    const cleanup = await runRegression(root, file, "cleanup passes");
    expect(cleanup.outcome).toBe("setup-failed");
    expect(cleanup.exit).not.toBe(0);
    expect(vitestOutput(cleanup.text)).toMatch(/around the test: AssertionError: expected 1 to be 3/);
    // Nothing around it failed: an assertion in the body is a reproduction.
    expect((await runRegression(root, file, "clean fails")).outcome).toBe("failed");
  }, 120_000);

  it("reads a report as no result for any other test than the one it was run for", async () => {
    const root = await vitestProject();
    const { text } = await runRegression(root, "packages/lib/src/scope.test.ts", "allows (scope) is wrong");
    expect(vitestOutcome(text, { package: "packages/lib/src/scope.test.ts", name: "allows (scope) is wrong" })).toBe("failed");
    expect(vitestOutcome(text, { package: "packages/lib/src/scope.test.ts", name: "allows (scope) forbids legacy" })).toBe("not-run");
    expect(vitestOutcome(text, { package: "packages/lib/other/src/scope.test.ts", name: "allows (scope) is wrong" })).toBe("not-run");
  }, 120_000);

  it("refuses a path outside the repository and reports a missing vitest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "issue-fix-novitest-"));
    temps.push(root);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.test.ts"), "");
    const missing = await runRegression(root, "src/a.test.ts", "a");
    expect(missing).toMatchObject({ exit: 127, outcome: "not-run" });
    expect((await runRegression(root, "../a.test.ts", "a")).exit).toBe(2);
  }, 60_000);
});

/** A canopy-shaped project: a workspace root with hoisted vitest and a test in each workspace, as the runner finds them. */
async function canopyProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-fix-canopy-"));
  temps.push(root);
  const vitest = vitestPackage();
  await mkdir(path.join(root, "canopy/node_modules/.bin"), { recursive: true });
  await symlink(vitest, path.join(root, "canopy/node_modules/vitest"));
  await symlink(path.join(vitest, "vitest.mjs"), path.join(root, "canopy/node_modules/.bin/vitest"));
  await writeFile(path.join(root, "canopy/package.json"), JSON.stringify({ name: "canopy", private: true, workspaces: ["web", "server"] }));
  for (const [ws, dir] of [["server", "test"], ["web", "src/components"]] as const) {
    await mkdir(path.join(root, "canopy", ws, dir), { recursive: true });
    await writeFile(path.join(root, "canopy", ws, "package.json"), JSON.stringify({ name: `canopy-${ws}`, type: "module" }));
    await writeFile(
      path.join(root, "canopy", ws, dir, "env.test.ts"),
      [
        'import { describe, expect, it } from "vitest";',
        `describe("${ws} env", () => {`,
        `  it("runs in the workspace under NODE_ENV=test", () => { expect(process.cwd().endsWith("/canopy/${ws}")).toBe(true); expect(process.env.NODE_ENV).toBe("test"); });`,
        '  it("is wrong", () => { expect(1).toBe(2); });',
        "});",
        "",
      ].join("\n"),
    );
  }
  return root;
}

describe("vitest regression runner in a workspace repository (canopy)", () => {
  it("runs a test of each workspace from that workspace, with the hoisted vitest, whatever NODE_ENV the caller has", async () => {
    const root = await canopyProject();
    for (const file of ["canopy/server/test/env.test.ts", "canopy/web/src/components/env.test.ts"]) {
      const ws = file.includes("/server/") ? "server" : "web";
      const passing = await runRegression(root, file, `${ws} env runs in the workspace under NODE_ENV=test`, { NODE_ENV: "production" });
      expect(passing).toMatchObject({ exit: 0, outcome: "passed" });
      const wrong = await runRegression(root, file, `${ws} env is wrong`, { NODE_ENV: "production" });
      expect(wrong.outcome).toBe("failed");
      expect(vitestSummary(wrong.text)?.target?.file).toBe(file);
    }
  }, 120_000);

  it("matches a name whether vitest joins titles with a space or with ' > '", () => {
    const pattern = new RegExp(namePattern("Pager renders nothing when total <= pageSize (a.b)"));
    expect(pattern.test("Pager renders nothing when total <= pageSize (a.b)")).toBe(true);
    expect(pattern.test("Pager > renders nothing when total <= pageSize (a.b)")).toBe(true);
    expect(pattern.test("Pager > renders > nothing when total <= pageSize (a.b)")).toBe(true);
    expect(pattern.test("Pager renders nothing when total <= pageSize (axb)")).toBe(false);
    expect(pattern.test("Other Pager renders nothing when total <= pageSize (a.b)")).toBe(false);
  });
});

describe("the canopy profile", () => {
  it("targets BanyanDB's repository and issue tracker, selects vitest and checks canopy changes", () => {
    expect(canopy.project).toBe("apache/skywalking-banyandb");
    expect(canopy.issues).toEqual(banyandb.issues);
    expect(canopy.changelog).toEqual(banyandb.changelog);
    expect(canopy.runner.id).toBe("vitest");
    expect(canopy.harnesses).toEqual(banyandb.harnesses);
    for (const p of ["canopy/server/test/bff.test.ts", "canopy/web/src/components/Pager.test.tsx", "canopy/web/src/x.test.ts", "canopy/e2e/tests/auth.spec.ts", "canopy/e2e/fixtures/skywalking/Tracing.proto"]) {
      expect(isTestPath(canopy, p), p).toBe(true);
    }
    for (const p of ["canopy/server/src/config.ts", "canopy/web/src/components/Pager.tsx", "banyand/liaison/grpc/server.go"]) {
      expect(isTestPath(canopy, p), p).toBe(false);
    }
    expect(canopy.protectedPaths).toEqual(expect.arrayContaining(["canopy/package-lock.json", "canopy/licenses", ".github"]));
  });

  it("checks in two tiers: the cheap commands first, then build, the full suite and the license artifacts", () => {
    expect(isTiered(canopy)).toBe(true);
    expect(commandsInTier(canopy, "cheap").map((c) => c.id)).toEqual(["test-changed", "typecheck", "lint"]);
    expect(commandsInTier(canopy, "full").map((c) => c.id)).toEqual(["build", "test", "license-dep"]);
    expect(commandsFor(canopy, "passes").map((c) => c.id)).toEqual(["test-changed", "test"]);
    const statement = (id: string) => createGraph().describe(CANOPY).requirements.find((r) => r.id === id)!.statement;
    expect(statement("passes")).toContain("the tests of the changed canopy workspaces pass");
    expect(statement("passes")).toContain("npm test passes for all canopy workspaces");
    expect(statement("builds")).toContain("make license-dep (with check-license-outputs)");
    for (const c of canopy.commands.filter((c) => c.id !== "license-dep")) expect(c.argv.join(" ")).toMatch(/cd canopy &&/);
    expect(canopy.commands.find((c) => c.id === "test")!.argv.join(" ")).toContain("NODE_ENV=test");
  });

  it("checks Node against canopy's engines.node, the VCS, ocr, codex and claude, and prepares with a cached npm ci", () => {
    expect(canopy.environment.checks!.map((c) => c.id)).toEqual(["node", "git", "license-tools", "ocr", "codex", "claude"]);
    const prepare = canopy.environment.prepare ?? [];
    expect(prepare.map((c) => c.id)).toEqual(["npm-ci"]);
    expect(prepare[0]!.argv.join(" ")).toContain("npm ci --include=dev");
    expect(prepare[0]!.inputs).toEqual(["canopy/package.json", "canopy/package-lock.json", "canopy/web/package.json", "canopy/server/package.json", "canopy/shared/package.json"]);
    expect(prepare[0]!.outputs).toEqual(["canopy/node_modules/**", "canopy/web/node_modules/**", "canopy/server/node_modules/**", "canopy/shared/node_modules/**"]);
    expect(canopy.environment.checks!.find((c) => c.id === "ocr")).toEqual(banyandb.environment.checks!.find((c) => c.id === "ocr"));
  });

  it("lists the typecheck and lint of the changed workspaces as the implementer's self check, and scales budgets down from banyandb's", () => {
    expect(canopy.implementation.selfCheck).toHaveLength(1);
    expect(canopy.implementation.selfCheck![0]).toContain('npm run -w "$w" typecheck');
    expect(canopy.implementation.selfCheck![0]).toContain('npm run -w "$w" lint');
    for (const key of ["agentInvocations", "jobs", "decisions", "corrections", "activeMs"] as const) {
      expect(canopy.budgets![key]!, key).toBeLessThan(banyandb.budgets![key]!);
    }
  });

  async function canopyRepo(engines: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "issue-fix-canopy-cmd-"));
    temps.push(root);
    for (const ws of ["web", "server", "shared"]) await mkdir(path.join(root, "canopy", ws), { recursive: true });
    await writeFile(path.join(root, "canopy/package.json"), JSON.stringify({ name: "canopy", private: true, engines: { node: engines }, workspaces: ["web", "server", "shared"] }));
    for (const ws of ["web", "server"]) {
      await writeFile(path.join(root, "canopy", ws, "package.json"), JSON.stringify({ name: `canopy-${ws}`, scripts: { test: `node -e "console.log('ran ${ws} with ' + process.env.NODE_ENV)"` } }));
    }
    await writeFile(path.join(root, "canopy/shared/package.json"), JSON.stringify({ name: "canopy-shared" }));
    return root;
  }
  const run = (root: string, id: string) => {
    const command = [...canopy.commands, ...canopy.environment.checks!].find((c) => c.id === id)!;
    const [cmd, ...args] = command.argv;
    return execFileAsync(cmd!, args, { cwd: root, env: { ...process.env, NODE_ENV: "production" } }).then(
      (r) => ({ code: 0, out: r.stdout + r.stderr }),
      (err: { code: number; stdout: string; stderr: string }) => ({ code: err.code, out: err.stdout + err.stderr }),
    );
  };
  const vcs = (root: string, ...args: string[]) => execFileAsync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root });

  it("accepts exactly the Node version canopy/package.json pins", async () => {
    const same = await canopyRepo(process.versions.node);
    expect((await run(same, "node")).code).toBe(0);
    const other = await canopyRepo("1.2.3");
    const failed = await run(other, "node");
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("Node.js 1.2.3 required (canopy/package.json engines.node)");
  });

  it("runs the tests of exactly the workspaces the change touches, under NODE_ENV=test", async () => {
    const root = await canopyRepo(process.versions.node);
    await vcs(root, "init", "-q");
    await vcs(root, "add", "-A");
    await vcs(root, "commit", "-q", "-m", "base");
    const commit = async (file: string) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), `${Math.random()}\n`);
      await vcs(root, "add", "-A");
      await vcs(root, "commit", "-q", "-m", file);
    };
    await commit("canopy/web/src/a.ts");
    const web = await run(root, "test-changed");
    expect(web.code).toBe(0);
    expect(web.out).toContain("ran web with test");
    expect(web.out).not.toContain("ran server");
    await commit("canopy/shared/src/a.ts");
    const shared = await run(root, "test-changed");
    expect(shared.out).toContain("ran web with test");
    expect(shared.out).toContain("ran server with test");
    await commit("canopy/e2e/tests/a.spec.ts");
    const none = await run(root, "test-changed");
    expect(none.code).toBe(1);
    expect(none.out).toContain("the change touches no canopy workspace");
  }, 120_000);
});

describe("generated artifacts a check regenerates (issue 181)", () => {
  const anyProfile = [
    ["banyandb", banyandb],
    ["canopy", canopy],
    ["graphloom", graphloom],
  ] as const;
  const sample = (w: string) => (w.endsWith("/**") ? `${w.slice(0, -3)}/deep/sample.txt` : w);

  it.each(anyProfile)("%s: every path a check declares it writes lies inside the implementer's write scope", (_name, profile) => {
    const declared = profile.commands.flatMap((c) => c.writes ?? []);
    for (const w of declared) {
      expect(outOfScope([sample(w)], GO_PLAN, profile), w).toEqual([]);
      expect(outOfScope([sample(w)], undefined, profile), w).toEqual([]);
    }
    expect(regeneratedPaths(profile).length).toBe(new Set(declared.map((w) => w.replace(/\/\*\*$/, ""))).size);
  });

  it("declares the license artifacts that make license-dep regenerates", () => {
    expect(regeneratedPaths(canopy)).toEqual(["canopy/LICENSE", "canopy/licenses"]);
    // banyandb protects none of its license artifacts, so it declares nothing: its scope already allows them.
    expect(regeneratedPaths(banyandb)).toEqual([]);
    expect(canopy.commands.find((c) => c.id === "license-dep")!.writes).toEqual(["canopy/LICENSE", "canopy/licenses/**"]);
  });

  it("replays run c44b4ae7-5d1: adding a dependency and regenerating the license files is not refused for scope", () => {
    const record = { ...GO_PLAN, scopeExceptions: [{ path: "canopy/package-lock.json", reason: "API tokens need a new dependency" }] };
    const changed = ["canopy/server/src/auth.ts", "canopy/package-lock.json", "canopy/LICENSE", "canopy/licenses/argon2-LICENSE.txt"];
    expect(outOfScope(changed, record, canopy)).toEqual([]);
    // The lock file is still protected without its exception, and so is everything else protected.
    expect(outOfScope(changed, undefined, canopy)).toEqual(["canopy/package-lock.json"]);
    expect(outOfScope([".github/workflows/ci.yml", "go.mod"], record, canopy)).toEqual([".github/workflows/ci.yml", "go.mod"]);
    expect(writeScopeFor(undefined, canopy)).not.toContain("!canopy/LICENSE");
    expect(writeScopeFor(undefined, canopy)).not.toContain("!canopy/licenses");
  });

  it("without a declaration a protected path stays out of scope, and a malformed writes list is refused", () => {
    const raw = CANOPY as { commands: Array<{ id: string; writes?: string[] }> };
    const bare = parseProfile({ ...raw, commands: raw.commands.map(({ writes: _w, ...c }) => c) });
    expect(outOfScope(["canopy/LICENSE"], undefined, bare)).toEqual(["canopy/LICENSE"]);
    for (const writes of [[], ["../x"], ["/abs"], [""], ["a//b"]]) {
      const commands = raw.commands.map((c) => (c.id === "license-dep" ? { ...c, writes } : c));
      expect(() => parseProfile({ ...raw, commands }), JSON.stringify(writes)).toThrow(ProfileError);
    }
  });

  it("lets a declared child of a protected directory be written while the rest of the directory stays out of scope", () => {
    const raw = CANOPY as { commands: Array<{ id: string; writes?: string[] }>; protectedPaths: string[] };
    const nested = parseProfile({
      ...raw,
      protectedPaths: ["generated"],
      commands: raw.commands.map((c) => (c.id === "license-dep" ? { ...c, writes: ["generated/licenses/**"] } : c)),
    });
    expect(outOfScope(["generated/licenses/foo.txt", "generated/licenses/deep/bar.txt"], undefined, nested)).toEqual([]);
    expect(outOfScope(["generated/other.txt", "generated/licenses.txt"], undefined, nested)).toEqual(["generated/other.txt", "generated/licenses.txt"]);
    expect(writeScopeFor(undefined, nested)).toEqual([".", "!generated", "+generated/licenses"]);
  });

  it("tells the implementer which generated paths it may write, and how", () => {
    const text = implementInstruction(canopy, { issue: 7, plan: TS_PLAN });
    expect(text).toContain("Do not change canopy/package-lock.json, canopy/e2e/tests/query.spec.ts-snapshots, .github, api/proto, go.mod, go.sum.");
    expect(text).not.toContain("Do not change canopy/LICENSE");
    expect(text).toContain("Do not edit generated files by hand, except what a check regenerates, which you may write by running it:");
    expect(text).toContain("canopy/LICENSE, canopy/licenses/** (regenerate with make license-dep (with check-license-outputs))");
    // A profile that regenerates nothing keeps the blanket prohibition.
    expect(implementInstruction(banyandb, { issue: 7, plan: GO_PLAN })).toContain("Do not commit, push, create branches or edit generated files.");
    // A declared child of a protected directory: the exclusion names the exception.
    const raw = CANOPY as { commands: Array<{ id: string; writes?: string[] }> };
    const nested = parseProfile({ ...raw, protectedPaths: ["generated"], commands: raw.commands.map((c) => (c.id === "license-dep" ? { ...c, writes: ["generated/licenses/**"] } : c)) });
    const child = implementInstruction(nested, { issue: 7, plan: TS_PLAN });
    expect(child).toContain("Do not change generated, except generated/licenses, which a check regenerates.");
    expect(child).toContain("generated/licenses/** (regenerate with make license-dep (with check-license-outputs))");
  });
});

describe("the bench-gates command, run against a fake docker (#197)", () => {
  const QL = parseProfile(shippedProfile("banyandb-ql"));
  const command = QL.commands.find((c) => c.id === "bench-gates")!;
  const REPORT = JSON.stringify(exampleBenchReport());

  /** A git checkout with go.mod, a Makefile with or without the target, a `docker` on PATH that logs its arguments and plays the container, and a module cache. */
  async function setup(o: { target?: boolean; report?: string; rc?: number; shared?: boolean } = {}) {
    const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "issue-fix-bench-")));
    temps.push(dir);
    const repo = path.join(dir, "repo");
    const bin = path.join(dir, "bin");
    const cache = path.join(dir, "modcache");
    const source = path.join(dir, "source");
    await mkdir(bin);
    await mkdir(cache);
    // A real git checkout; with `shared`, a `git clone --shared` of a source repository, as the controller's candidate checkouts are.
    const author = ["-c", "user.email=t@example.com", "-c", "user.name=T"];
    const files = async (at: string) => {
      await writeFile(path.join(at, "go.mod"), "module example.com/x\n\ngo 1.26.10\n");
      await writeFile(path.join(at, "Makefile"), o.target === false ? ".PHONY: other\nother:\n\ttrue\n" : ".PHONY: bench-ql-report\nbench-ql-report:\n\ttrue\n");
    };
    if (o.shared) {
      await mkdir(source);
      await execFileAsync("git", ["init", "-q", source]);
      await files(source);
      await execFileAsync("git", ["-C", source, "add", "."]);
      await execFileAsync("git", ["-C", source, ...author, "commit", "-q", "-m", "init"]);
      await execFileAsync("git", ["clone", "-q", "--shared", source, repo]);
    } else {
      await mkdir(repo);
      await execFileAsync("git", ["init", "-q", repo]);
      await files(repo);
    }
    await writeFile(path.join(dir, "report.json"), o.report ?? REPORT);
    const log = path.join(dir, "docker.log");
    await writeFile(
      path.join(bin, "docker"),
      [
        "#!/bin/sh",
        `echo "$@" >> ${JSON.stringify(log)}`,
        '[ "$1" = info ] && exit 0',
        'for a in "$@"; do prev="$last"; last="$a"; done',
        '[ "$prev $last" = "go version" ] && { echo "go version go1.26.10 linux/amd64"; exit 0; }',
        // The container's `make bench-ql-report`: writes into the checkout it was given as /src.
        'if [ "$last" = bench-ql-report ]; then for a in "$@"; do case "$a" in *:/src) src="${a%:/src}" ;; esac; done; mkdir -p "$src/build/bench"; cp ' + JSON.stringify(path.join(dir, "report.json")) + ' "$src/build/bench/ql-report.json"; exit ' + (o.rc ?? 0) + "; fi",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return { dir, repo, source, bin, cache, log, report: path.join(dir, "report.out") };
  }

  async function exec(env: Awaited<ReturnType<typeof setup>>, extra: Record<string, string> = {}) {
    const [cmd, ...args] = command.argv;
    const environment: NodeJS.ProcessEnv = { ...process.env, PATH: `${env.bin}:${process.env.PATH}`, GRAPHLOOM_REPORT_FILE: env.report, GRAPHLOOM_BENCH_GOMODCACHE: env.cache, ...extra };
    for (const key of Object.keys(extra)) if (extra[key] === "") delete environment[key];
    try {
      const { stdout, stderr } = await execFileAsync(cmd!, args, { cwd: env.repo, env: environment });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it("runs make bench-ql-report in the golang image of go.mod's version with the frozen resources and a read-only module cache, and wraps the report", async () => {
    const env = await setup();
    const result = await exec(env);
    expect(result.code, result.stderr).toBe(0);
    const calls = (await readFile(env.log, "utf8")).trim().split("\n");
    const run = calls.find((l) => l.endsWith("make bench-ql-report"))!;
    expect(run).toContain("run --rm --cpus=4 --memory=8g --memory-swap=8g");
    expect(run).toContain(" golang:1.26.10 make bench-ql-report");
    expect(run).toContain(`-v ${env.repo}:/src`);
    expect(run).toContain(`-v ${env.cache}:/go/pkg/mod:ro`);
    expect(run).toContain("-e GOPROXY=off");
    expect(run).toContain("-w /src");
    const envelope = JSON.parse(await readFile(env.report, "utf8")) as { harness: Record<string, unknown>; report: unknown };
    expect(envelope.harness).toEqual({ image: "golang:1.26.10", imageGo: "go version go1.26.10 linux/amd64", cpus: 4, memory: "8g", memorySwap: "8g" });
    expect(envelope.report).toEqual(JSON.parse(REPORT));
    expect(result.stdout).toContain("golang:1.26.10 (go version go1.26.10 linux/amd64)");
  });

  it("mounts a shared clone's alternate object store read-only at its own path, so the runner can read the base revision", async () => {
    const env = await setup({ shared: true });
    const result = await exec(env);
    expect(result.code, result.stderr).toBe(0);
    const run = (await readFile(env.log, "utf8")).trim().split("\n").find((l) => l.endsWith("make bench-ql-report"))!;
    const objects = path.join(env.source, ".git", "objects");
    expect(run).toContain(`-v ${objects}:${objects}:ro`);
    // The checkout's own .git lies inside the mounted checkout, so it is not mounted again.
    expect(run).not.toContain(`-v ${path.join(env.repo, ".git")}:`);
  });

  it("takes the image and the module cache from the environment, and finds the operator's cache behind a confined job's redirected one", async () => {
    const env = await setup();
    const image = await exec(env, { GRAPHLOOM_BENCH_IMAGE: "golang:1.26.10-bookworm" });
    expect(image.code, image.stderr).toBe(0);
    expect(await readFile(env.log, "utf8")).toContain("golang:1.26.10-bookworm make bench-ql-report");
    // A confined job: its GOMODCACHE is a run-scoped copy, and its first GOPROXY is the operator's cache as a file:// URL.
    const confined = await setup();
    const result = await exec(confined, { GRAPHLOOM_BENCH_GOMODCACHE: "", GOMODCACHE: "/scratch/go/mod", GOPROXY: `${pathToFileURL(path.join(confined.cache, "cache", "download")).href},https://proxy.golang.org,direct` });
    expect(result.code, result.stderr).toBe(0);
    expect(await readFile(confined.log, "utf8")).toContain(`-v ${confined.cache}:/go/pkg/mod:ro`);
  });

  it("fails with an actionable message when the make target does not exist, running no container", async () => {
    const env = await setup({ target: false });
    const result = await exec(env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("this checkout has no make target bench-ql-report");
    expect(result.stderr).toContain("writes build/bench/ql-report.json (schema ql-bench-report/v1");
    expect(result.stderr).toContain("docker run --rm --cpus=4 --memory=8g --memory-swap=8g golang:1.26.10 make bench-ql-report");
    expect((await readFile(env.log, "utf8")).split("\n").filter((l) => l.includes("make bench-ql-report"))).toEqual([]);
    expect(existsSync(env.report)).toBe(false);
  });

  it("fails naming what is missing: no module cache, no report file, an invalid or oversized report", async () => {
    const env = await setup();
    const noCache = await exec(env, { GRAPHLOOM_BENCH_GOMODCACHE: path.join(env.dir, "absent") });
    expect(noCache.code).toBe(1);
    expect(noCache.stderr).toContain("no Go module cache to mount read-only");
    expect(noCache.stderr).toContain("GRAPHLOOM_BENCH_GOMODCACHE");

    const invalid = await setup({ report: "{ not json" });
    const bad = await exec(invalid);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("is not valid JSON");

    const huge = await setup({ report: JSON.stringify({ ...exampleBenchReport(), padding: "x".repeat(MAX_BENCH_REPORT_BYTES) }) });
    const big = await exec(huge);
    expect(big.code).not.toBe(0);
    expect(big.stderr).toContain("keep the report under 60000 bytes");
  });

  it("keeps the runner's own exit status while still reporting what it wrote", async () => {
    const env = await setup({ rc: 7 });
    const result = await exec(env);
    expect(result.code).toBe(7);
    expect(JSON.parse(await readFile(env.report, "utf8")).report.schema).toBe("ql-bench-report/v1");
  });

  it("is a final tier command with a generous timeout, and the environment checks docker and a module cache before any job", () => {
    expect(command).toMatchObject({ tier: "final", requirement: "bench-gates" });
    expect(command.timeoutMs).toBeGreaterThanOrEqual(3 * 60 * 60 * 1000);
    const docker = QL.environment.checks!.find((c) => c.id === "docker")!;
    expect(docker.argv[2]).toContain("docker info");
    expect(docker.argv[2]).toContain("GRAPHLOOM_BENCH_GOMODCACHE");
  });
});

describe("the command that writes a pinned context document as a file (#195)", () => {
  const TEXT = `# Design\n\n"quoted" and \\backslashed and $dollar and \`tick\` and 'single'\n\nunicode: ✓ 日本語 😀\n${"line\n".repeat(3_000)}\n\n`;

  async function repo() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "issue-fix-context-"));
    temps.push(dir);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await writeFile(path.join(dir, "README.md"), "x\n");
    await execFileAsync("git", ["add", "."], { cwd: dir });
    await execFileAsync("git", ["-c", "user.email=a@b", "-c", "user.name=x", "commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
  }
  const run = (dir: string, command: { argv: string[] }) => execFileAsync(command.argv[0]!, command.argv.slice(1), { cwd: dir });

  it("writes the text exactly, read-only, below a directory Git ignores, and again over its own earlier copy", async () => {
    const dir = await repo();
    const command = writeTextFileCommand("context-write-1", ".graphloom/context/01-design.md", TEXT)!;
    expect(command).toBeDefined();
    expect((await run(dir, command)).stdout.trim()).toBe("written");
    const file = path.join(dir, ".graphloom/context/01-design.md");
    expect(await readFile(file, "utf8")).toBe(TEXT);
    expect((await stat(file)).mode & 0o222).toBe(0);
    expect(await readFile(path.join(dir, ".graphloom/.gitignore"), "utf8")).toBe("*\n");
    // Git sees nothing: the delivered commit and the candidate leave the file out.
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: dir })).stdout).toBe("");
    expect((await execFileAsync("git", ["check-ignore", ".graphloom/context/01-design.md"], { cwd: dir })).stdout.trim()).toBe(".graphloom/context/01-design.md");
    // Written again over the read-only copy, from a changed text.
    await run(dir, writeTextFileCommand("context-write-1", ".graphloom/context/01-design.md", "second\n")!);
    expect(await readFile(file, "utf8")).toBe("second\n");
    expect(writtenText(command.argv, "context-write-1")).toEqual({ dest: ".graphloom/context/01-design.md", text: TEXT });
    expect(writtenText(command.argv, "context-write-2")).toBeUndefined();
  });

  it("refuses a text one command cannot carry, by argument count and by serialized size", () => {
    expect(writeTextFileCommand("c", ".graphloom/context/x", "a".repeat(200_000))).toBeDefined();
    expect(writeTextFileCommand("c", ".graphloom/context/x", "a".repeat(240_000))).toBeUndefined();
    expect(writeTextFileCommand("c", ".graphloom/context/x", '"'.repeat(130_000))).toBeUndefined();
  });
});

describe("the ocr environment check", () => {
  const pluginDir = path.resolve(here, "..");
  const names = ["banyandb", "banyandb-ql", "graphloom", "canopy"] as const;
  const ocrCheck = (name: (typeof names)[number]) => parseProfile(shippedProfile(name)).environment.checks!.find((c) => c.id === "ocr")!;
  const sh = ["/bin/sh", "/usr/bin/sh"].find((p) => existsSync(p))!;

  /**
   * A plugin installed below `root/examples/plugins/issue-fix` with its lookup
   * script, as the release and a checkout lay it out (dependencies hoisted to
   * `root/node_modules`), and a PATH directory holding only `sh`.
   */
  async function layout() {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "issue-fix-ocr-")));
    temps.push(root);
    const plugin = path.join(root, "examples/plugins/issue-fix");
    await mkdir(path.join(plugin, "scripts"), { recursive: true });
    await writeFile(path.join(plugin, "scripts/ocr-path.sh"), await readFile(path.join(pluginDir, "scripts/ocr-path.sh")));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await symlink(sh, path.join(bin, "sh"));
    const tool = async (file: string, body: string) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `#!${sh}\n${body}\n`, { mode: 0o755 });
    };
    const delegating = '[ "$1 $2 $3" = "delegate preview --help" ]';
    const ocrPackage = path.join(root, "node_modules/@alibaba-group/open-code-review");
    const bundle = async (platform = "linux-x64", body = delegating) => {
      await mkdir(ocrPackage, { recursive: true });
      await writeFile(path.join(ocrPackage, "package.json"), JSON.stringify({ name: "@alibaba-group/open-code-review", version: "1.13.3" }));
      const binary = path.join(root, `node_modules/@alibaba-group/ocr-${platform}/bin/opencodereview`);
      await tool(binary, body);
      return binary;
    };
    const run = async (env: Record<string, string> = {}, name: (typeof names)[number] = "banyandb") => {
      const [cmd, ...args] = ocrCheck(name).argv;
      return execFileAsync(cmd!, args, { cwd: root, env: { PATH: bin, HOME: root, GRAPHLOOM_PLUGIN_ROOT: plugin, ...env } }).then(
        ({ stdout }) => ({ code: 0, stderr: "", stdout: stdout.trim() }),
        (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr.trim() }),
      );
    };
    return { root, plugin, bin, tool, delegating, bundle, run };
  }

  it("is the same lookup in every profile, run through the plugin's own script", () => {
    const check = ocrCheck("banyandb");
    for (const name of names) expect(ocrCheck(name)).toEqual(check);
    expect(check.argv.join(" ")).toContain('"$r/scripts/ocr-path.sh"');
  });

  it("finds the plugin's bundled ocr with nothing but sh on PATH, before any ocr on PATH", async () => {
    const t = await layout();
    const binary = await t.bundle();
    for (const name of names) expect(await t.run({}, name)).toEqual({ code: 0, stderr: "", stdout: binary });
    await t.tool(path.join(t.bin, "ocr"), t.delegating);
    expect(await t.run()).toEqual({ code: 0, stderr: "", stdout: binary });
  });

  it("finds the bundled ocr from a repair candidate, which links the package from the installed tree", async () => {
    const t = await layout();
    const binary = await t.bundle();
    // A qualified repair's candidate: a copy of the bundle in the run's state, outside the installed tree,
    // with only its declared dependencies linked (by real path), so the platform package is not beside it.
    const state = await realpath(await mkdtemp(path.join(os.tmpdir(), "issue-fix-ocr-state-")));
    temps.push(state);
    const candidate = path.join(state, "repairs/r1/candidate");
    await mkdir(path.join(candidate, "node_modules/@alibaba-group"), { recursive: true });
    await mkdir(path.join(candidate, "scripts"));
    await writeFile(path.join(candidate, "scripts/ocr-path.sh"), await readFile(path.join(t.plugin, "scripts/ocr-path.sh")));
    await symlink(path.join(t.root, "node_modules/@alibaba-group/open-code-review"), path.join(candidate, "node_modules/@alibaba-group/open-code-review"), "dir");
    expect(await t.run({ GRAPHLOOM_PLUGIN_ROOT: candidate })).toEqual({ code: 0, stderr: "", stdout: binary });
  });

  it("skips a bundled binary that does not run (another platform's) for the next one", async () => {
    const t = await layout();
    await t.bundle("aaa-other", "exit 126");
    const binary = await t.bundle("linux-x64");
    expect(await t.run()).toEqual({ code: 0, stderr: "", stdout: binary });
  });

  it("falls back to ocr on PATH when the plugin bundles none, printing its absolute path", async () => {
    const t = await layout();
    await t.tool(path.join(t.bin, "ocr"), t.delegating);
    expect(await t.run()).toEqual({ code: 0, stderr: "", stdout: path.join(t.bin, "ocr") });
    await t.tool(path.join(t.bin, "ocr"), "exit 1");
    expect(await t.run()).toEqual({ code: 1, stderr: `${path.join(t.bin, "ocr")} has no delegation mode; install open-code-review 1.9 or later` });
  });

  it("fails with a clear message when there is neither a bundled ocr nor one on PATH", async () => {
    const t = await layout();
    expect(await t.run()).toEqual({
      code: 127,
      stderr:
        "open-code-review (ocr) is not installed: the plugin's bundled @alibaba-group/open-code-review is missing (run npm ci where the plugin is installed), and there is no ocr on PATH",
    });
    const broken = await t.bundle("linux-x64", "exit 1");
    expect(await t.run()).toEqual({ code: 1, stderr: `the plugin's bundled open-code-review (${broken}) does not run 'delegate preview --help', and there is no ocr on PATH` });
  });

  it("names the missing plugin root rather than guessing", async () => {
    const t = await layout();
    expect(await t.run({ GRAPHLOOM_PLUGIN_ROOT: "" })).toEqual({
      code: 127,
      stderr: "GRAPHLOOM_PLUGIN_ROOT is not set: GraphLoom sets it to the plugin's directory for environment checks",
    });
  });

  it("prefers an explicit path, and never falls back from one", async () => {
    const t = await layout();
    await t.bundle();
    const own = path.join(t.root, "opt/ocr");
    await t.tool(own, t.delegating);
    expect(await t.run({ GRAPHLOOM_OCR_BIN: own })).toEqual({ code: 0, stderr: "", stdout: own });
    // A profile names its own path as the script's argument.
    const explicit = await execFileAsync(sh, [path.join(t.plugin, "scripts/ocr-path.sh"), own], { cwd: t.root, env: { PATH: t.bin } });
    expect(explicit.stdout.trim()).toBe(own);
    expect(await t.run({ GRAPHLOOM_OCR_BIN: path.join(t.root, "missing") })).toEqual({
      code: 127,
      stderr: `open-code-review is not an executable file at ${path.join(t.root, "missing")}`,
    });
  });

  it.skipIf(!(process.platform === "linux" && process.arch === "x64"))("finds the pinned open-code-review this checkout installed, which has delegation mode", async () => {
    const [cmd, ...args] = ocrCheck("graphloom").argv;
    const { stdout } = await execFileAsync(cmd!, args, { cwd: repoRoot, env: { PATH: path.dirname(sh), HOME: os.tmpdir(), GRAPHLOOM_PLUGIN_ROOT: pluginDir } });
    const binary = stdout.trim();
    expect(path.isAbsolute(binary)).toBe(true);
    expect(binary.endsWith("/node_modules/@alibaba-group/ocr-linux-x64/bin/opencodereview")).toBe(true);
    const pinned = (JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@alibaba-group/open-code-review"];
    expect((await execFileAsync(binary, ["version"])).stdout).toContain(`open-code-review v${pinned} `);
  });
});
