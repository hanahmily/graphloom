import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceRecord, GraphDefinition, JobSpec, RunView } from "@graphloom/sdk";
import {
  advanceFix,
  candidateCommands,
  codeReviewInstruction,
  commitMessage,
  createGraph,
  decisionProblems,
  definitionFor,
  implementInstruction,
  parseProfile,
  planInstruction,
  ProfileError,
  pullRequestDescription,
  redCommands,
  reviewBackground,
  shippedProfile,
  validatorById,
  validatorsFor,
  verificationInstruction,
  vitestArgv,
  vitestOutcome,
  vitestOutput,
  vitestSummary,
  writeScopeFor,
  type DecisionRecord,
} from "../src/index.js";
import { rehearsal } from "../src/rehearsal.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const BANYANDB = shippedProfile("banyandb");
const GRAPHLOOM = shippedProfile("graphloom");
const banyandb = parseProfile(BANYANDB);
const graphloom = parseProfile(GRAPHLOOM);

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
const ISSUE = { number: 14111, title: "Scheduler reports long actions as timed out", state: "open", url: "u", labels: ["bug"], body: "Backups longer than five minutes are reported as timed out." };

const banyandbFixDist = path.join(repoRoot, "examples/plugins/banyandb-fix/dist");
const load = async (module: string) => (await import(pathToFileURL(path.join(banyandbFixDist, module)).href)) as Record<string, (...args: never[]) => unknown>;

describe.skipIf(!existsSync(path.join(banyandbFixDist, "index.js")))("the banyandb profile reproduces banyandb-fix", () => {
  it("describes the same stages, requirements, validators, contracts and environment", async () => {
    const theirs = ((await load("index.js")).createGraph as () => { describe(): GraphDefinition })().describe();
    const ours = createGraph().describe(BANYANDB);
    const strip = ({ graphId: _g, version: _v, privateStateSchema: _p, ...rest }: GraphDefinition) => rest;
    expect(strip(ours)).toEqual(strip(theirs));
    expect(ours).toMatchObject({ graphId: "issue-fix", version: "0.4.1", privateStateSchema: "issue-fix-private-v1" });
  });

  it("gives the agents and the checks the same instructions and commands", async () => {
    const prompts = await load("prompts.js");
    const ocr = await load("ocr.js");
    const findings = await load("findings.js");
    const decisions = await load("decision-record.js");
    const call = <T>(f: unknown, ...args: unknown[]) => (f as (...a: unknown[]) => T)(...args);
    const snapshot = "# apache/skywalking#14111: Scheduler\n\nBody.";
    expect(planInstruction(banyandb, { issue: 14111, request: "Fix apache/skywalking#14111.", snapshot })).toBe(
      call(prompts.planInstruction, { issue: 14111, request: "Fix apache/skywalking#14111.", snapshot }),
    );
    for (const feedback of [undefined, ["passes: make test-ci failed"]]) {
      const args = { issue: 14111, plan: GO_PLAN, ...(feedback !== undefined ? { feedback } : {}) };
      expect(implementInstruction(banyandb, args)).toBe(call(prompts.implementInstruction, args));
    }
    expect(candidateCommands(banyandb, GO_PLAN.test!)).toEqual(call(prompts.candidateCommands, GO_PLAN.test));
    expect(redCommands(banyandb, GO_PLAN.test!)).toEqual(call(prompts.redCommands, GO_PLAN.test));
    expect(commitMessage(banyandb, { issue: 14111, issueTitle: ISSUE.title, record: GO_PLAN })).toBe(call(prompts.commitMessage, { issue: 14111, issueTitle: ISSUE.title, record: GO_PLAN }));
    const pr = { issue: 14111, issueTitle: ISSUE.title, record: GO_PLAN, base: "0123456789abcdef", review: "Reviewed by Codex: no comments.", dismissed: ["F1 refuted"] };
    expect(pullRequestDescription(banyandb, pr)).toBe(call(prompts.pullRequestDescription, pr));
    const background = reviewBackground(banyandb, ISSUE, GO_PLAN);
    expect(background).toBe(call(ocr.reviewBackground, ISSUE, GO_PLAN));
    const review = { ocr: "/opt/ocr", base: "abc", background, known: { open: [{ id: "F1", state: "confirmed", description: "x" }], settled: [] }, sweep: true };
    expect(codeReviewInstruction(banyandb, review)).toBe(call(ocr.codeReviewInstruction, review));
    expect(verificationInstruction(banyandb, { findings: [], background, changed: ["a.go"] })).toBe(call(findings.verificationInstruction, { findings: [], background, changed: ["a.go"] }));
    const record = { ...GO_PLAN, scopeExceptions: [{ path: "go.mod", reason: "a new dependency" }, { path: "Makefile", reason: "x" }] };
    expect(decisionProblems(record, banyandb)).toEqual(call(decisions.decisionProblems, record));
    expect(writeScopeFor(record, banyandb)).toEqual(call(decisions.writeScopeFor, record));
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
    expect(statement("in-scope")).toBe("Every changed path is inside the repository and outside package-lock.json, .github and legacy, except those the decision record names with a reason.");
    expect(statement("reproduces")).toContain("vitest reports it failed with an assertion error in its own body, its file loaded, and no hook, suite or file around it failed");
    expect(definition.environment!.checks!.map((c) => c.id)).toEqual(["node", "npm", "flock", "git", "ocr", "codex", "claude"]);
    expect(definition.environment!.prepare!.map((c) => c.argv.join(" "))).toEqual(["npm ci --include=dev", "npm run build"]);
    expect(graphloom.commands.find((c) => c.id === "test")!.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it("names hanahmily/graphloom issues and tells the planner how vitest names a test", () => {
    const plan = planInstruction(graphloom, { issue: 7, request: "Fix hanahmily/graphloom#7.", snapshot: "snap" });
    expect(plan).toContain("Plan a fix for hanahmily/graphloom#7 in this repository (hanahmily/graphloom).");
    expect(plan).toContain("package is the test file, relative to the repository root");
    expect(plan).toContain("scopeExceptions: only when the fix must change package-lock.json, .github, legacy");
    // Enhancement issues: the new test is the RED test, and the issue's own surface is not a product decision.
    expect(plan).toContain("About hanahmily/graphloom:");
    expect(plan).toContain("Issues here are often enhancements rather than bug reports.");
    expect(plan).toContain("is what was asked for, not an open product decision");
    expect(planInstruction(banyandb, { issue: 7, request: "r", snapshot: "s" })).not.toContain("About ");
    const implement = implementInstruction(graphloom, { issue: 7, plan: TS_PLAN });
    expect(implement).toContain("keeps the new names and signatures the test imports but restores the old behaviour");
    expect(implement).not.toContain("CHANGES");
    expect(implement).toContain("Do not change package-lock.json, .github, legacy.");
    expect(implement).toContain("the full change must pass the test and `npm run typecheck`, `npm run build` and `npm test`");
    const review = codeReviewInstruction(graphloom, { ocr: "ocr", base: "b", background: "" });
    expect(review).toContain("TypeScript test files (`*.test.ts`) and test fixtures are reviewable too");
    expect(review).toContain("Extra rule for TypeScript files:");
    const body = pullRequestDescription(graphloom, { issue: 7, issueTitle: "t", record: TS_PLAN, base: "abc", review: "Reviewed." });
    expect(body).toContain("### Fix hanahmily/graphloom#7: t");
    expect(body).toContain("- `npm run typecheck`, `npm run build` and `npm test` pass.");
    expect(body).toContain("The live-provider tests were not run");
    expect(body.endsWith("Fixes hanahmily/graphloom#7.")).toBe(true);
    expect(body).not.toContain("CHANGES");
  });

  it("protects the lockfile, .github and legacy unless the record gives a reason", () => {
    expect(writeScopeFor(TS_PLAN, graphloom)).toEqual([".", "!package-lock.json", "!.github", "!legacy"]);
    expect(writeScopeFor({ ...TS_PLAN, scopeExceptions: [{ path: "package-lock.json", reason: "a new dependency" }] }, graphloom)).toEqual([".", "!.github", "!legacy"]);
    expect(decisionProblems({ ...TS_PLAN, scopeExceptions: [{ path: "go.mod", reason: "x" }] }, graphloom)).toEqual([
      'scope exception "go.mod" is not one of package-lock.json, .github, legacy',
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
    expect(Object.keys(rehearsal(BANYANDB).scenarios)).toEqual(["happy"]);
    const record = rehearsal(GRAPHLOOM).scenarios.happy!.results["decision-record-v1"]![0]!.output as DecisionRecord;
    expect(decisionProblems(record, graphloom)).toEqual([]);
    const goRecord = rehearsal(BANYANDB).scenarios.happy!.results["decision-record-v1"]!.at(-1)!.output as DecisionRecord;
    expect(decisionProblems(goRecord, banyandb)).toEqual([]);
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

async function runRegression(root: string, file: string, name: string) {
  const report = path.join(root, `report-${Math.random().toString(36).slice(2)}`);
  const [cmd, ...args] = vitestArgv({ package: file, name });
  const exit = await execFileAsync(cmd!, args, { cwd: root, env: { ...process.env, GRAPHLOOM_REPORT_FILE: report } }).then(
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
