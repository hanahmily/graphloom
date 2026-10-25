import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobResult } from "@graphloom/runner";
import { applyGraphDefaultBudgets, intakeTask, IntakeError, resolveRunBudgets, type DurableRunState } from "@graphloom/controller";
import { check, checkProvenance, probe, recordScenario, rehearsalBudgets, rehearse, removeRehearsalBranches, replay } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * B2's capability probe (§3.1) reads the *operator's own* runner config, not
 * anything the rehearsal itself stands in for — so a verdict's own "ready"
 * must not depend on whether a real, logged-in Claude Code happens to be
 * configured on whatever machine runs this test. Fake binaries make B2
 * genuinely pass, same as the real check they stand in for.
 */
async function fixture(graph: "hello" | "release", request: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-rehearsal-"));
  dirs.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(root, "examples/plugins", graph), path.join(dir, "plugins", graph));
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, `graph: ${graph}\nrepo: ./repo\nrequest: ${JSON.stringify(request)}\n`);

  const agents = await writeFakeCodingAgents(dir);
  const runnerConfigPath = path.join(dir, "runner.json");
  await writeFile(runnerConfigPath, JSON.stringify(fakeRunnerConfig(agents)));
  vi.stubEnv(RUNNER_CONFIG_ENV, runnerConfigPath);

  return { dir, repo, taskPath };
}

describe("graphloom check (L0)", () => {
  it("reports ok for hello: declared contracts, scenario replies, and environment all agree", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const report = await check(f.taskPath);
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(report.rehearsal?.scenarios.happy).toBeDefined();
    expect(report.definition?.resultContracts?.map((c) => c.name).sort()).toEqual(["review-verdict-v1", "writer-result-v1"]);
  });
});

describe("rehearsal budgets (#151 review)", () => {
  it("names a recoveryReserve that fits the rehearsal's own allowance, so a graph's live reserve is not inherited", () => {
    expect(rehearsalBudgets()).toEqual({ agentInvocations: 24, jobs: 64, decisions: 256, corrections: 4, recoveryReserve: 8 });
    // Merged under a graph that declares 1,800 calls with a reserve of 90: valid.
    expect(resolveRunBudgets(rehearsalBudgets(), { agentInvocations: 1800, recoveryReserve: 90 })).toMatchObject({ agentInvocations: 24, recoveryReserve: 8 });
    // Kept below a small allowance; none at all when no call could be left.
    expect(rehearsalBudgets({ agentInvocations: 4 }).recoveryReserve).toBe(3);
    expect(rehearsalBudgets({ agentInvocations: 1 }).recoveryReserve).toBeUndefined();
  });

  it("honours an explicit scenario reserve as is", () => {
    expect(rehearsalBudgets({ agentInvocations: 40, recoveryReserve: 3 })).toMatchObject({ agentInvocations: 40, recoveryReserve: 3 });
    // Even one the final check will refuse: the scenario said so.
    expect(rehearsalBudgets({ recoveryReserve: 30 }).recoveryReserve).toBe(30);
    expect(() => resolveRunBudgets(rehearsalBudgets({ recoveryReserve: 30 }))).toThrow(/recoveryReserve \(30\) must be less than budgets.agentInvocations \(24\)/);
  });
});

describe("intake budgets", () => {
  // Regression: recoveryReserve's own default (at least 8, or 5% of
  // agentInvocations) can meet or exceed a small agentInvocations total —
  // children.ts's own floor (this reserve, outside recovery mode) would then
  // refuse the run's very first normal-mode agent call, with no agent
  // invocation ever possible at all.
  // The cross-budget check runs once on the final budgets, after describe()
  // adds the graph's defaultBudgets (#151): intake alone only checks values.
  it("refuses a budget whose recoveryReserve leaves no room for a normal-mode agent call", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    await writeFile(f.taskPath, `graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\nbudgets:\n  agentInvocations: 4\n`);
    const intake = await intakeTask(f.taskPath);
    expect(() => applyGraphDefaultBudgets(intake, {})).toThrow(IntakeError);
    expect(() => applyGraphDefaultBudgets(intake, {})).toThrow(/recoveryReserve/);
    const report = await check(f.taskPath);
    expect(report.ok).toBe(false);
    expect(report.problems).toContainEqual(expect.stringMatching(/^budgets: budgets.recoveryReserve \(8\) must be less than budgets.agentInvocations \(4\)/));
  });

  it("refuses an explicit recoveryReserve at or above an explicit agentInvocations too", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    await writeFile(
      f.taskPath,
      `graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\nbudgets:\n  agentInvocations: 20\n  recoveryReserve: 20\n`,
    );
    const intake = await intakeTask(f.taskPath);
    expect(() => applyGraphDefaultBudgets(intake, {})).toThrow(IntakeError);
  });

  it("still refuses a value that is not a positive integer at intake", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    await writeFile(f.taskPath, `graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\nbudgets:\n  jobs: 0\n`);
    await expect(intakeTask(f.taskPath)).rejects.toThrow(IntakeError);
  });

  it("accepts a small budget whose explicit recoveryReserve still leaves room", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    await writeFile(
      f.taskPath,
      `graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\nbudgets:\n  agentInvocations: 4\n  recoveryReserve: 1\n`,
    );
    const intake = await intakeTask(f.taskPath);
    expect(applyGraphDefaultBudgets(intake, {}).budgets).toMatchObject({ agentInvocations: 4, recoveryReserve: 1 });
  });
});

describe("graphloom rehearse (L1)", () => {
  it("reaches ready for hello's happy scenario, leaving no worktree behind", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const report = await rehearse(f.taskPath);
    expect(report.verdict).toBe("ready");
    expect(report.convergence.met).toBe(true);
    const worktrees = await execFileAsync("git", ["worktree", "list"], { cwd: f.repo });
    expect(worktrees.stdout.trim().split("\n")).toHaveLength(1); // only the main worktree
  }, 30_000);

  it("reaches ready for release's happy scenario across both write stages", async () => {
    const f = await fixture("release", "Release version 1.0.0: record it in VERSION and add a CHANGELOG.md entry.");
    const report = await rehearse(f.taskPath);
    expect(report.verdict).toBe("ready");
    expect(report.convergence.actual.receipts.sort()).toEqual(["bump", "changelog", "review"]);
  }, 30_000);

  it("keeps the worktree and scratch state when the verdict is not ready", async () => {
    const f = await fixture("hello", "this request never mentions the greeting file");
    const report = await rehearse(f.taskPath);
    expect(report.verdict).toBe("not-ready");
    const worktrees = await execFileAsync("git", ["worktree", "list"], { cwd: f.repo });
    expect(worktrees.stdout.trim().split("\n").length).toBeGreaterThan(1);
  }, 30_000);

  it("--synthesized ignores the scenario's own scripted replies, schema-synthesizing throughout", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const report = await rehearse(f.taskPath, { synthesized: true });
    expect(report.substituted.some((s) => s.includes("--synthesized"))).toBe(true);
    // A synthesized reply never carries the scripted `effects` that write
    // GREETING.txt, so the file requirement's own evidence never converges —
    // this flag asks only whether the contract's own schema and the plugin's
    // parser agree (§4.1), not whether the graph as a whole can finish.
    expect(report.verdict).not.toBe("ready");
  }, 30_000);

  it("--adversarial corrupts the writer's reply with a stray out-of-scope write, which the controller's own diff fails as a scope violation", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const report = await rehearse(f.taskPath, { adversarial: true });
    expect(report.substituted.some((s) => s.includes("--adversarial"))).toBe(true);
    // hello's happy scenario scripts no supervisor decisions, so the
    // unexpected executor_failed recovery this triggers is never resolved —
    // not-ready is the correct, expected verdict, not a bug in the mode.
    expect(report.verdict).toBe("not-ready");
    expect(report.convergence.actual.recovery).toEqual(["executor_failed"]);
  }, 30_000);
});

describe("graphloom replay (L2)", () => {
  it("replays the recorded banyandb-fix run this design was built from, reclassifying its evidence and surfacing the unresolved findings", async () => {
    const stateDir = path.join(root, "examples/skywalking-banyandb/graphloom-state/879ee04f-e57");
    // The recorded run's own intake pins the bundle path of whatever machine
    // recorded it; replay reads the bundle's current code, which is wherever
    // this checkout actually has it installed, not that frozen absolute path.
    const report = await replay(stateDir, { bundlePath: path.join(root, "examples/plugins/banyandb-fix") });
    // Plan review no longer exists in the current plugin: its review-verdict-v1
    // evidence (most of what this run recorded) reclassifies to no contract at
    // all, leaving only the plan's own decision-record-v1 valid.
    expect(report.contracts.valid).toBe(1);
    expect(report.contracts.byName["decision-record-v1"]).toMatchObject({ valid: 1, invalid: 0 });
    expect(report.requirements.some((r) => r.requirementId === "plan-reviewed")).toBe(false);
    // Freed from plan review, the current graph would go straight to
    // implementing the plan — but this run's own recorded budget was already
    // spent on the real plan-review churn before it ever reached that point.
    expect(report.nextDecision).toMatchObject({ decision: { action: { type: "stop", stop: { reason: "budgets exhausted" } } } });
  });
});

describe("graphloom probe (L3)", () => {
  it("reports the contract check for a stubbed real-harness result, spending the recorded assignment but no real tokens", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const fakeRunner = {
      async runJob(): Promise<JobResult> {
        return {
          status: "ok",
          summary: "stubbed",
          runId: "probe",
          operationId: "op",
          generation: 1,
          evidence: [{ kind: "other", payload: { codingAgent: { output: { verdict: "approved", summary: "Checked exact greeting bytes" } } } }],
        };
      },
    };
    const report = await probe(f.taskPath, { contract: "review-verdict-v1" }, fakeRunner);
    expect(report.assignment).toContain("independent read-only reviewer");
    expect(report.status).toBe("ok");
    expect(report.check).toMatchObject({ status: "valid" });
  }, 30_000);

  it("reports an invalid check when the stubbed result violates the contract", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    const fakeRunner = {
      async runJob(): Promise<JobResult> {
        return {
          status: "ok",
          summary: "stubbed",
          runId: "probe",
          operationId: "op",
          generation: 1,
          evidence: [{ kind: "other", payload: { codingAgent: { output: { verdict: "maybe" } } } }],
        };
      },
    };
    const report = await probe(f.taskPath, { contract: "review-verdict-v1" }, fakeRunner);
    expect(report.check?.status).toBe("invalid");
  }, 30_000);

  it("dispatches against a disposable worktree, never the operator's own checkout, and cleans it up", async () => {
    // Regression: probe ran the real model's job directly against
    // intake.repoPath — the operator's real checkout — with no controller-
    // level post-job scope check behind it, and the Pi harness's write/bash
    // tools are not actually gated by job.readOnly (prompt guidance only).
    const f = await fixture("hello", "Create GREETING.txt.");
    let sawWorktreePath: string | undefined;
    const fakeRunner = {
      async runJob(_job: unknown, ctx: { worktreePath: string }): Promise<JobResult> {
        sawWorktreePath = ctx.worktreePath;
        return {
          status: "ok",
          summary: "stubbed",
          runId: "probe",
          operationId: "op",
          generation: 1,
          evidence: [{ kind: "other", payload: { codingAgent: { output: { verdict: "approved", summary: "ok" } } } }],
        };
      },
    };
    await probe(f.taskPath, { contract: "review-verdict-v1" }, fakeRunner);
    expect(sawWorktreePath).toBeDefined();
    expect(sawWorktreePath).not.toBe(f.repo);
    expect((await execFileAsync("git", ["worktree", "list"], { cwd: f.repo })).stdout.trim().split("\n")).toHaveLength(1);
    expect((await execFileAsync("git", ["branch", "--list", "graphloom/probe-*"], { cwd: f.repo })).stdout.trim()).toBe("");
  }, 30_000);

  it("refuses a contract name the plugin did not declare", async () => {
    const f = await fixture("hello", "Create GREETING.txt.");
    await expect(probe(f.taskPath, { contract: "not-a-real-contract" }, {} as never)).rejects.toThrow(/no contract named/);
  });
});

describe("graphloom rehearse --record-from (§4.5)", () => {
  async function recordedStateDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-record-from-"));
    dirs.push(dir);
    const state = {
      runId: "rec-1",
      status: "stopped",
      stopReason: "agentInvocations budget exhausted",
      recoveryTrigger: { code: "executor_failed", message: "executor graphloom.coding-agent/run failed: model request budget exhausted" },
      receipts: [{ stageId: "write", requirementId: "greeting-bytes", valid: true }, { stageId: "write", requirementId: "stale", valid: false }],
      evidence: [
        {
          ref: "ev-1", kind: "other", resultSchema: "writer-result-v1",
          payload: { codingAgent: { status: "completed", output: { summary: "wrote" } }, producer: { operationId: "op-1", stageId: "write" } },
        },
        {
          ref: "ev-2", kind: "other", resultSchema: "review-verdict-v1",
          payload: { codingAgent: { status: "completed", output: { verdict: "request_changes" } }, producer: { operationId: "op-2", stageId: "review" } },
        },
        {
          ref: "ev-3", kind: "other", resultSchema: "review-verdict-v1",
          payload: { codingAgent: { status: "failed", output: null }, producer: { operationId: "op-3", stageId: "review" } },
        },
        {
          ref: "ev-4", kind: "other",
          payload: {
            executorFailure: { operationId: "op-3", stageId: "review", summary: "model request budget exhausted" },
            producer: { operationId: "op-3", stageId: "review" },
          },
        },
        {
          ref: "ev-5", kind: "command",
          payload: {
            command: { id: "git", argv: ["git", "--version"], exitCode: 0, stdoutTail: "git version 2.45\n", stderrTail: "" },
            environment: { phase: "preflight" },
            producer: { operationId: "env-0", stageId: "write" },
          },
        },
        {
          ref: "ev-6", kind: "command",
          payload: {
            command: { id: "build", argv: ["make", "build"], exitCode: 0, stdoutTail: "ok\n", stderrTail: "" },
            producer: { operationId: "op-4", stageId: "write" },
          },
        },
        {
          ref: "ev-7", kind: "other",
          payload: {
            github: { operation: "get-issue", item: { number: 1, title: "fixture issue" } },
            producer: { operationId: "op-5", stageId: "write", executorId: "graphloom.github/get-issue" },
          },
        },
      ],
    };
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
    return dir;
  }

  it("groups agent results by their stamped resultSchema, excludes environment-check commands, and captures reads", async () => {
    const stateDir = await recordedStateDir();
    const recorded = await recordScenario(stateDir);
    expect(recorded.name).toBe("rec-1"); // stopped, not succeeded: named after the run, not "happy"
    expect(recorded.scenario.results["writer-result-v1"]).toEqual([{ output: { summary: "wrote" } }]);
    expect(recorded.scenario.results["review-verdict-v1"]).toEqual([
      { output: { verdict: "request_changes" } },
      { fail: { kind: "exit", summary: "model request budget exhausted" } },
    ]);
    expect(recorded.scenario.commands).toEqual({ build: { exitCode: 0, stdout: "ok\n", stderr: "" } });
    expect(recorded.scenario.reads).toEqual({ "graphloom.github/get-issue": [{ operation: "get-issue", item: { number: 1, title: "fixture issue" } }] });
    expect(recorded.scenario.expect).toEqual({
      status: "stopped",
      receipts: ["write"],
      stopReason: "agentInvocations budget exhausted",
      recovery: ["executor_failed"],
    });
  });

  it("captures a flattened review-kind record's own payload as the reply, with no codingAgent wrapper to read", async () => {
    // Regression: a valid/repaired "review"-kind result flattens to its own
    // validated output (classifyAgentResult, packages/controller/src/loop.ts)
    // — found live, recording a real successful hello run: the write stage's
    // own wrapped evidence came through, but the review stage's own valid
    // verdict silently vanished, since nothing here ever reads a flattened
    // record's own bare payload as a reply.
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-record-from-"));
    dirs.push(dir);
    const state = {
      runId: "rec-2",
      status: "succeeded",
      receipts: [{ stageId: "review", requirementId: "independent-review", valid: true }],
      evidence: [
        {
          ref: "ev-1", kind: "review", resultSchema: "review-verdict-v1",
          payload: { verdict: "approved", summary: "looks right", producer: { operationId: "op-1", stageId: "review" } },
        },
      ],
    };
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
    const recorded = await recordScenario(dir);
    expect(recorded.scenario.results["review-verdict-v1"]).toEqual([{ output: { verdict: "approved", summary: "looks right" } }]);
  });

  it("attaches the file evidence a work dispatch's own effects left behind to that same reply", async () => {
    // Regression: the file-kind evidence a real write leaves behind carries
    // no producer at all, recorded only as a side effect of the workspace
    // diff — found live, the same real hello run: the recorded scenario's
    // writer reply had the model's own reported output but never the actual
    // GREETING.txt bytes, so replaying it answered the right shape without
    // ever writing the file a rehearsal's own requirement checks for.
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-record-from-"));
    dirs.push(dir);
    const state = {
      runId: "rec-3",
      status: "succeeded",
      receipts: [{ stageId: "write", requirementId: "greeting-bytes", valid: true }],
      evidence: [
        {
          ref: "ev-1", kind: "other", resultSchema: "writer-result-v1",
          payload: { codingAgent: { status: "completed", output: { summary: "wrote" } }, producer: { operationId: "op-1", stageId: "write" } },
        },
        { ref: "ev-2", kind: "file", payload: { path: "GREETING.txt", bytes: "Hello, GraphLoom!\n" } },
        { ref: "ev-3", kind: "workspace", payload: { changedPaths: ["GREETING.txt"] } },
      ],
    };
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
    const recorded = await recordScenario(dir);
    expect(recorded.scenario.results["writer-result-v1"]).toEqual([
      { output: { summary: "wrote" }, effects: [{ path: "GREETING.txt", bytes: "Hello, GraphLoom!\n" }] },
    ]);
  });

  it("does not attach a later generation's own file evidence to an earlier generation's stale reply", async () => {
    // Regression: a live run's supervisor used `observe` during recovery to
    // read the files a work dispatch had already written, generations after
    // that dispatch's own review reply — found recording a real successful
    // banyandb-fix run. Nothing reset `activeReply` across the generation gap,
    // so the observe's file evidence landed on the stale review reply instead
    // of nothing, and replaying it would apply the fix's own file bytes only
    // once that reply replayed — long after Fix's own checks needed them.
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-record-from-"));
    dirs.push(dir);
    const state = {
      runId: "rec-3b",
      status: "succeeded",
      receipts: [{ stageId: "review", requirementId: "independent-review", valid: true }],
      evidence: [
        {
          ref: "ev-1", kind: "other", resultSchema: "review-verdict-v1", generation: 1,
          payload: { codingAgent: { status: "completed", output: { verdict: "request_changes" } }, producer: { operationId: "op-1", stageId: "review" } },
        },
        { ref: "ev-2", kind: "file", generation: 3, payload: { path: "pkg/scheduler.go", bytes: "package pkg\n" } },
      ],
    };
    await writeFile(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
    const recorded = await recordScenario(dir);
    expect(recorded.scenario.results["review-verdict-v1"]).toEqual([{ output: { verdict: "request_changes" } }]);
  });

  it("names a succeeded run's scenario \"happy\"", async () => {
    const stateDir = await recordedStateDir();
    const state = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")) as { status: string };
    state.status = "succeeded";
    await writeFile(path.join(stateDir, "state.json"), JSON.stringify(state), "utf8");
    expect((await recordScenario(stateDir)).name).toBe("happy");
  });
});

describe("B3's call-log provenance check (§4.1, §4.7)", () => {
  function evidence(ref: string, resultSchema: string, operationId: string) {
    return { ref, kind: "other" as const, resultSchema, payload: { producer: { operationId } } };
  }

  it("passes when the stand-in's own call log agrees with what the controller recorded", () => {
    const state = { evidence: [evidence("ev-1", "writer-result-v1", "op-1")] } as unknown as DurableRunState;
    const result = checkProvenance(state, [{ contractName: "writer-result-v1", operationId: "op-1" }]);
    expect(result).toEqual({ status: "passed", notes: [] });
  });

  it("fails, naming both contract identities, when a reply landed under a different job than the one that asked", () => {
    const state = { evidence: [evidence("ev-1", "writer-result-v1", "op-1")] } as unknown as DurableRunState;
    // The stand-in's own call log says it answered a different contract for
    // this exact operationId than the one the controller recorded evidence
    // under — a continued session mixing turns, a stale result applied fresh.
    const result = checkProvenance(state, [{ contractName: "review-verdict-v1", operationId: "op-1" }]);
    expect(result.status).toBe("failed");
    expect(result.notes[0]).toContain("op-1");
    expect(result.notes[0]).toContain("writer-result-v1");
    expect(result.notes[0]).toContain("review-verdict-v1");
  });

  it("is a no-op for evidence or calls with nothing to cross-check (replay; an uninstrumented dispatch)", () => {
    const state = { evidence: [evidence("ev-1", "writer-result-v1", "op-1")] } as unknown as DurableRunState;
    expect(checkProvenance(state, [])).toEqual({ status: "passed", notes: [] });
    expect(checkProvenance(state, [{ operationId: "op-2" }])).toEqual({ status: "passed", notes: [] });
  });
});

describe("removeRehearsalBranches (#199)", () => {
  it("removes the branches under the run's own namespace and no others", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-rehearsal-branches-"));
    dirs.push(dir);
    const run = (...args: string[]) => execFileAsync("git", args, { cwd: dir });
    await run("init", "-q");
    await run("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    for (const branch of ["rehearsal/rehearsal-aaaa1111/fix-7", "rehearsal/rehearsal-bbbb2222/fix-7", "fix/7"]) await run("branch", branch);
    await removeRehearsalBranches(dir, "rehearsal-aaaa1111");
    const all = (await run("for-each-ref", "--format=%(refname:short)", "refs/heads/")).stdout.split("\n");
    expect(all.filter((b) => b.startsWith("fix/") || b.startsWith("rehearsal/")).sort()).toEqual(["fix/7", "rehearsal/rehearsal-bbbb2222/fix-7"]);
    // Nothing to remove is fine, and so is a missing repository.
    await removeRehearsalBranches(dir, "rehearsal-aaaa1111");
    await removeRehearsalBranches(path.join(dir, "missing"), "rehearsal-aaaa1111");
  });
});
