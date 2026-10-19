import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { stop, type GraphPlugin, type JobSpec, type Validator } from "@graphloom/sdk";
import { createBuiltinExecutorRunner } from "@graphloom/runner";
import { createController, intakeTask, loadRunState, resolveBundleEntry, taskConfigValue } from "@graphloom/controller";
import { createChildPluginHost } from "@graphloom/plugin-host";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import {
  ISSUE_FIX_FIXED as FIXED,
  ISSUE_FIX_ISSUE as ISSUE,
  ISSUE_FIX_PLAN as PLAN,
  createIssueFixFixture,
  createScope,
  exampleBundle,
  execFileAsync,
  goVersion,
  prependPath,
  repoRoot,
  type IssueFixFixture,
} from "@graphloom/testkit";
import { commandOptions } from "../dist/cli-runner.js";
import type { RunnerConfig } from "../src/runner-config.js";

const bundle = exampleBundle("issue-fix");
const GO = goVersion();

interface FixPlugin {
  createGraph(): GraphPlugin;
  validatorsFor(config: unknown): Record<string, Validator>;
}
let plugin: FixPlugin;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-issue-fix"], { cwd: repoRoot });
  plugin = (await import(pathToFileURL(path.join(bundle, "dist", "index.js")).href)) as FixPlugin;
}, 120_000);

const scope = createScope();
afterEach(() => scope.dispose());

/**
 * The testkit's issue-fix fixture (a Go module shaped like BanyanDB where it
 * matters to the graph, with the #14111 defect; a fake GitHub with the issue;
 * stand-ins for open-code-review, Claude Code and Codex), the stand-ins
 * first on PATH.
 */
async function makeEnv(): Promise<IssueFixFixture> {
  const env = await createIssueFixFixture(scope);
  prependPath(scope, env.binDir);
  return env;
}

/**
 * The real graph, stopped cleanly in normal mode the instant it is about to
 * dispatch the implementer — everything up to there (environment, issue
 * fetch, the plan, its review) is the graph's own real decision, not a
 * script. A budget cut small enough to force the same pause instead would
 * stop inside a recovery episode (no supervisor to settle it), not normal
 * mode, so the resume that follows would just re-report that episode rather
 * than exercising the graph's own next decision.
 */
function pauseBeforeWork(): GraphPlugin {
  const graph = plugin.createGraph();
  return {
    describe: (config?: unknown) => graph.describe(config),
    advance: (view) => {
      const decision = graph.advance(view);
      return decision.action.type === "dispatch" && decision.action.job.purpose === "work"
        ? stop({ reason: "paused", blocker: "before implementing" }, "pause before work")
        : decision;
    },
  };
}

/**
 * Real command and GitHub executors, as the CLI composes them, with the
 * fixture's scripted Claude Code and Codex agents: the plan, an
 * implementation that writes the fix, test and changelog entry, and a code
 * review that runs the ocr its assignment names in the worktree.
 */
function fixRunner(env: IssueFixFixture) {
  const agents = env.agents();
  const runner = createBuiltinExecutorRunner({
    packages: [
      { manifest: commandExecutorPackage, ...commandBinding(commandOptions(env.agentConfig as RunnerConfig)) },
      { manifest: githubExecutorPackage, ...githubBinding({ baseUrl: env.github.baseUrl, token: "fake" }) },
    ],
    fallback: agents,
  });
  return { runner, agentJobs: agents.jobs as JobSpec[] };
}

describe.skipIf(GO === undefined)("issue-fix with the banyandb profile on a Go repository", () => {
  it("checks the environment, plans and fixes the issue with RED and GREEN proof, reviews the code, and delivers a local branch", async () => {
    const env = await makeEnv();
    const { runner, agentJobs } = fixRunner(env);
    // No plugin or validators: the controller loads the bundle in its own
    // child host, which hands the pinned profile to every call.
    const report = await createController().run({
      taskPath: env.taskPath,
      runner,
      stateRoot: env.stateRoot,
      runId: "bydb-14111",
    });

    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    // The run pinned the profile it was given; its definition came from it.
    expect(state.intake.config).toMatchObject({ path: "banyandb-fixture.json", sha256: createHash("sha256").update(await readFile(env.configPath!)).digest("hex") });
    expect(state.definition.environment!.pinnedFiles).toEqual([{ path: "CONTRIBUTING.md", sha256: env.contributingSha256 }]);
    expect(state.receipts.filter((r) => r.valid).map((r) => `${r.stageId}/${r.requirementId}`)).toEqual([
      "fix/decisions-recorded",
      "fix/reproduces",
      "fix/passes",
      "fix/builds",
      "fix/in-scope",
      "fix/changelog-entry",
      "review/code-review",
    ]);
    expect(new Set(state.receipts.map((r) => r.candidateDigest))).toEqual(new Set([state.candidateDigest]));
    // The preflight checked the agents runner.json names, in the login directories it names.
    expect([...new Set((await readFile(env.agentCalls, "utf8")).trim().split("\n"))]).toEqual([
      `codex --version CODEX_HOME=${env.agentConfig.codex.codexHome}`,
      `codex login status CODEX_HOME=${env.agentConfig.codex.codexHome}`,
      `claude --version CLAUDE_CONFIG_DIR=${env.agentConfig.claude.configDir}`,
      `claude auth status CLAUDE_CONFIG_DIR=${env.agentConfig.claude.configDir}`,
    ]);

    // The plan saw the issue and its comments; the implementer continued the plan's session.
    const [plan, implement] = agentJobs;
    expect((plan!.input as { assignment: string }).assignment).toContain("A running backup is not an error");
    expect(implement!.continueFrom).toBeDefined();
    expect(agentJobs).toHaveLength(4);

    // Claude Code verified the high comment read-only in a fresh session; the controller observed the lines it quoted, and they matched.
    expect(agentJobs[3]).toMatchObject({ stageId: "review", kind: "agent", purpose: "diagnostic", readOnly: true, resultSchema: "finding-verification-v1", input: { harness: "claude-code" } });
    expect(agentJobs[3]!.continueFrom).toBeUndefined();
    const observed = state.evidence.find((e) => e.kind === "file" && (e.payload as { path: string }).path === "pkg/timestamp/scheduler.go")!;
    expect(observed).toMatchObject({ candidateDigest: state.candidateDigest, payload: { bytes: FIXED } });

    // Codex reviewed read-only, running the ocr the preflight found, in the worktree holding the uncommitted change.
    expect(agentJobs[2]).toMatchObject({ stageId: "review", kind: "agent", purpose: "review", readOnly: true, input: { harness: "codex" } });
    const calls = (await readFile(env.ocrCalls, "utf8")).trim().split("\n");
    expect(calls).toEqual([
      `cwd=${await realpath(report.worktreePath)}`,
      "args=delegate preview --format json",
      "changed=CHANGES.md pkg/timestamp/scheduler.go pkg/timestamp/status_test.go",
    ]);

    // RED failed by assertion on the base with only the test; GREEN passed on the committed change.
    const command = (id: string) =>
      state.evidence.filter((e) => e.kind === "command" && (e.payload as { command?: { id?: string } }).command?.id === id && (e.payload as { checkout?: { phase?: string } }).checkout?.phase === "run");
    const [red] = command("regression").filter((e) => (e.payload as { checkout: { from: string } }).checkout.from === "base");
    expect(red!.payload).toMatchObject({ command: { exitCode: 1 }, checkout: { paths: ["pkg/timestamp/status_test.go"], prepared: true, mutations: [] } });
    expect((red!.payload as { command: { report: { text: string } } }).command.report.text).toContain('Status = \\"timed out\\", want running');
    for (const id of ["test-ci", "license-check", "build", "lint", "check"]) {
      expect(command(id).at(-1)!.payload, id).toMatchObject({ command: { exitCode: 0 }, checkout: { from: "candidate", mutations: [] } });
    }

    // Delivery: a local branch with the whole change and a short message, the PR body in the evidence, and the worktree untouched.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: env.repo.path, encoding: "utf8" });
    expect(git("show", `fix/${ISSUE}:pkg/timestamp/scheduler.go`)).toBe(FIXED);
    expect(git("ls-tree", "-r", "--name-only", `fix/${ISSUE}`).split("\n")).not.toContain("pkg/timestamp/mock_limit.go");
    expect(git("log", "-1", "--format=%an <%ae>", `fix/${ISSUE}`).trim()).toBe("Maintainer <maintainer@example.com>");
    const message = git("log", "-1", "--format=%B", `fix/${ISSUE}`).trim();
    expect(message).toBe(`${PLAN.title}\n\n${PLAN.summary}\n\nFixes apache/skywalking#${ISSUE}`);
    const deliver = state.evidence.find((e) => (e.payload as { command?: { id?: string } }).command?.id === "deliver")!;
    const body = (deliver.payload as { command: { report: { text: string } } }).command.report.text;
    expect(body).toContain(`### Fix apache/skywalking#${ISSUE}: Scheduler reports long actions as timed out`);
    expect(body).toContain("- Should the timeout metric keep counting running actions?");
    expect(body).toContain(
      "Reviewed by Codex in open-code-review's delegation mode (reviewed 3 of 3 file(s)): no critical or high finding left open (1 refuted by an independent verifier, listed below); 1 lower-severity comment(s) left for the reviewer.",
    );
    expect(body).toContain("  - I1 pkg/timestamp/scheduler.go:10-12 (high, bug): A running action past the limit is still reported as timed out. Verifier: Status returns running before it checks the limit.");
    // The plugin's issues file: written in the worktree by a read-only command job, ignored by Git, left out of the commit.
    expect(body).toContain("| I1 | P1 (high) | dismissed | `pkg/timestamp/scheduler.go:10-12` |");
    const issues = JSON.parse(await readFile(path.join(report.worktreePath, ".graphloom/issues.json"), "utf8")) as { issues: Array<{ id: string; status: string }> };
    expect(issues.issues.map((i) => `${i.id}:${i.status}`)).toEqual(["I1:dismissed"]);
    expect(git("ls-tree", "-r", "--name-only", `fix/${ISSUE}`)).not.toContain(".graphloom");
    expect(execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: report.worktreePath, encoding: "utf8" })).not.toContain(".graphloom");
    expect(body).not.toMatch(/rcpt|receipt/);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: report.worktreePath, encoding: "utf8" })).toContain("M pkg/timestamp/scheduler.go");
    expect(await readFile(path.join(report.worktreePath, "pkg/timestamp/mock_limit.go"), "utf8")).toContain("generatedLimit");
    expect(env.github.requests.every((r) => r.method === "GET")).toBe(true);
  }, 600_000);

  // This is the real-world shape of the bug a run-convergence investigation
  // this design is named for: a live run (a23b53b8-5df, fixing
  // apache/skywalking#14075) issued zero receipts across 45 generations
  // because every resume forced Fix to redraft its already-approved plan —
  // the plan-lookup and the plan-reviewed validator both fenced on exact
  // generation equality, and `resume()` bumping generation (§4.6) looked
  // identical to a genuine reentry to both. Through the real controller, the
  // real graph and the real validator, not a hand-rolled simulation.
  it("goes straight to implementing an already-approved plan after a resume, instead of redrafting it", async () => {
    const env = await makeEnv();
    // In-process this time, so the graph can be paused: the in-process host
    // passes the pinned config to describe and advance, and validatorsFor
    // binds it for the validators the controller calls directly.
    const validators = plugin.validatorsFor(env.profile);
    const first = fixRunner(env);

    // The real graph's own plan, paused in normal mode the instant it is
    // about to implement — the plan already on record and zero Fix
    // receipts yet, the gap no existing resume test covered.
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: pauseBeforeWork(),
      validators,
      runner: first.runner,
      stateRoot: env.stateRoot,
      runId: "issue-fix-resume",
    });
    expect(paused, `${paused.stopReason}: ${paused.blocker}`).toMatchObject({ status: "stopped", stopReason: "paused", blocker: "before implementing" });
    expect(first.agentJobs.map((j) => j.purpose)).toEqual(["diagnostic"]);
    expect(paused.receipts.filter((r) => r.valid)).toEqual([]);

    const second = fixRunner(env);
    const resumed = await createController().resume({
      runRef: paused.stateDir,
      plugin: plugin.createGraph(),
      validators,
      runner: second.runner,
    });

    expect(resumed.status, `${resumed.stopReason}: ${resumed.blocker}`).toBe("succeeded");
    // Straight to implementing the plan already on record: no second
    // diagnostic/review pair redrafting it from scratch.
    expect(second.agentJobs[0]).toMatchObject({ stageId: "fix", purpose: "work" });
    expect(second.agentJobs.filter((j) => j.stageId === "fix" && j.purpose === "diagnostic")).toEqual([]);
    expect(second.agentJobs.filter((j) => j.stageId === "fix" && j.purpose === "review")).toEqual([]);
  }, 60_000);
});

describe("the shipped issue-fix example tasks", () => {
  it.each([
    ["issue-fix-banyandb-task.yaml", "banyandb.json", ["decisions-recorded", "reproduces", "passes", "builds", "in-scope", "changelog-entry"]],
    ["issue-fix-graphloom-task.yaml", "graphloom.json", ["decisions-recorded", "reproduces", "passes", "builds", "in-scope"]],
  ])("%s pins its profile and describes the graph in a child host", async (task, profile, fix) => {
    const intake = await intakeTask(path.join(repoRoot, "examples", task));
    expect(intake.config?.path).toBe(`plugins/issue-fix/profiles/${profile}`);
    expect(intake.config?.text).toBe(await readFile(path.join(bundle, "profiles", profile), "utf8"));
    const host = await createChildPluginHost({
      entryModule: resolveBundleEntry(intake),
      activeVersion: "issue-fix@0.1.0",
      generation: 1,
      cwd: bundle,
      config: taskConfigValue(intake),
    });
    try {
      const described = await host.describe({ runId: "example", operationId: "describe", expectedStateRevision: 0 });
      expect(described.ok && described.value.stages[0]!.requirementIds).toEqual(fix);
    } finally {
      await host.close();
    }
  });
});
