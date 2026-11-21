// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedRunner, type Runner, type ScriptedJobHandler } from "@graphloom/runner";
import { createController, intakeTask, loadRunState, saveRunState } from "./controller.js";
import { assertAutomaticContinuation, authorizeManagedRun, beginManagedCommand, finishManagedCommand, observeContinuation, readManagedBinding, reconcileManagedRun, releaseManagedRun, type ManagedRunGrant } from "./managed.js";
import { createRunWorktree } from "./worktree.js";
import { withDirectoryLock } from "./lock.js";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function environment() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-managed-"));
  temporary.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"], ["config", "commit.gpgsign", "false"]]) await exec("git", args, { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "test\n");
  await exec("git", ["add", "."], { cwd: repo });
  await exec("git", ["commit", "-qm", "initial"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(root, "examples/plugins/hello"), path.join(dir, "plugins/hello"));
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, "graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\n");
  const stateRoot = path.join(dir, "state");
  const stateDir = path.join(stateRoot, "managed");
  const grant: ManagedRunGrant = { protocolVersion: 1, hubId: "hub", hubStateDir: path.join(dir, "hub"), submissionId: "submission", runId: "managed", generation: 1, launchId: "launch-1", verify: vi.fn(async () => undefined) };
  return { dir, repo, taskPath, stateRoot, stateDir, grant };
}

function runner(jobs: ScriptedJobHandler[]): Runner {
  return { ...createScriptedRunner({ jobs }), managed: { async check() { return undefined; }, async drain() { return { drained: true, resources: [] }; } } };
}
const failure: ScriptedJobHandler = async () => ({ status: "failed", summary: "fixture failure" });

describe("managed controller", () => {
  it("fences direct controls and idempotently reports an existing initial run", async () => {
    const env = await environment();
    const controller = createController();
    const report = await controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([failure]) });
    const before = await readFile(path.join(env.stateDir, "state.json"), "utf8");
    const duplicate = await controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([]) });
    expect(duplicate.runId).toBe(report.runId);
    expect(await readFile(path.join(env.stateDir, "state.json"), "utf8")).toBe(before);
    await expect(controller.resume({ runRef: env.stateDir, runner: runner([]) })).rejects.toThrow("managed");
    await expect(controller.stop(env.stateDir)).rejects.toThrow("managed");
    await expect(controller.delete(env.stateDir, { force: true })).rejects.toThrow("hub-managed");
    await expect(controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: { ...env.grant, submissionId: "other" }, runner: runner([]) })).rejects.toThrow("different hub");
  });

  it("reconciles a matching partial intake without creating a second worktree", async () => {
    const env = await environment();
    const intake = await intakeTask(env.taskPath);
    await withDirectoryLock(env.stateDir, "run.exec.lock", () => authorizeManagedRun(env.stateDir, env.grant, intake));
    await createRunWorktree(env.repo, "managed", intake.pinnedHead, env.stateDir, true);
    const report = await createController().run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: { ...env.grant, generation: 2, launchId: "launch-2" }, runner: runner([failure]) });
    expect(report.status).toBe("stopped");
    expect((await readManagedBinding(env.stateDir))?.generation).toBe(2);
    await expect(withDirectoryLock(env.stateDir, "run.exec.lock", () => authorizeManagedRun(env.stateDir, env.grant, intake))).rejects.toThrow("stale managed");
    expect((await exec("git", ["worktree", "list", "--porcelain"], { cwd: env.repo })).stdout.match(/branch refs\/heads\/graphloom\/managed/g)).toHaveLength(1);
  });

  it("does not adopt a standalone run", async () => {
    const env = await environment();
    const controller = createController();
    await controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", runner: runner([failure]) });
    await expect(controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([]) })).rejects.toThrow("existing standalone");
    expect(await readManagedBinding(env.stateDir)).toBeUndefined();
  });

  it("refuses changed partial intake instead of resetting work", async () => {
    const env = await environment();
    const intake = await intakeTask(env.taskPath);
    await withDirectoryLock(env.stateDir, "run.exec.lock", () => authorizeManagedRun(env.stateDir, env.grant, intake));
    const worktree = await createRunWorktree(env.repo, "managed", intake.pinnedHead, env.stateDir, true);
    await writeFile(path.join(worktree.worktreePath, "operator.txt"), "preserve me");
    await expect(createController().run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([]) })).rejects.toThrow("partial managed intake worktree changed");
    expect(await readFile(path.join(worktree.worktreePath, "operator.txt"), "utf8")).toBe("preserve me");
  });

  it("records planned interruption and reconciles inside a reservation before continuation", async () => {
    const env = await environment();
    const controller = createController();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const execution = controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant,
      runner: runner([async (_job, ctx) => {
        entered();
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted === true) resolve();
          else ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "failed", summary: "interrupted" };
      }]) });
    await started;
    await controller.stop(env.stateDir, { managed: env.grant, interruptionId: "shutdown-1" });
    await execution;
    const stopped = await loadRunState(env.stateDir);
    expect(stopped.managedContinuation).toMatchObject({ cause: "service-interruption", interruptionCommandId: "shutdown-1" });
    expect(observeContinuation(stopped)).toMatchObject({ kind: "operator", cause: "reconciliation" });
    const observed = await reconcileManagedRun(env.stateDir, { ...env.grant, generation: 2, launchId: "reconcile-2" }, runner([]));
    expect(observed.continuation).toMatchObject({ kind: "automatic", cause: "service-interruption", interruptionCommandId: "shutdown-1" });
    expect((await loadRunState(env.stateDir)).pendingDispatch).toBeUndefined();
  });

  it("yields a durable unstarted retry, preserves wait accounting, and resumes only after eligibility", async () => {
    const env = await environment();
    const controller = createController();
    const report = await controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant,
      runner: runner([async () => ({ status: "failed", summary: "temporary", retryAfterMs: 60_000, retryLimit: 2 })]) });
    expect(report.stopReason).toBe("managed scheduling yield");
    const state = await loadRunState(env.stateDir);
    expect(state.pendingDispatch?.status).toBe("waiting");
    expect(state.budgets.waitMs).toBeLessThan(state.intake.budgets.waitMs!);
    const continuation = observeContinuation(state);
    expect(continuation.kind).toBe("automatic");
    expect(() => assertAutomaticContinuation(state, { ...env.grant, automatic: true })).toThrow("notBefore");
    const elapsed = new Date(Date.now() - 1_000).toISOString();
    await saveRunState({ ...state, managedContinuation: { cause: "provider-cooldown", notBefore: elapsed }, pendingDispatch: { ...state.pendingDispatch!, notBefore: elapsed } });
    const resumed = await controller.resume({ runRef: env.stateDir, managed: { ...env.grant, generation: 2, launchId: "launch-2", automatic: true }, runner: runner([failure]) });
    expect(resumed.status).toBe("stopped");
    const after = await loadRunState(env.stateDir);
    expect(after.budgets.waitMs).toBeLessThanOrEqual(state.budgets.waitMs!);
    expect(after.budgets.jobs).toBeLessThan(state.budgets.jobs);
  });

  it("never treats arbitrary retryable stops or ambiguous effects as automatic authorization", async () => {
    const env = await environment();
    await createController().run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([failure]) });
    const state = await loadRunState(env.stateDir);
    expect(observeContinuation({ ...state, stopReason: "some new retryable reason" })).toMatchObject({ kind: "operator", cause: "unknown" });
    const unknownCause = JSON.parse(JSON.stringify({ ...state, stopReason: "managed scheduling yield", managedContinuation: { cause: "new-runtime-cause" } }));
    expect(observeContinuation(unknownCause)).toMatchObject({ kind: "operator", cause: "unknown" });
    expect(observeContinuation({ ...state, stopReason: "managed scheduling yield", managedContinuation: { cause: "provider-cooldown" }, reconciliationRequired: { operationId: "old", stageId: "write", reason: "unknown effect", since: new Date().toISOString() } })).toMatchObject({ kind: "operator", cause: "reconciliation" });
    expect(await releaseManagedRun(createScriptedRunner({ jobs: [] }), "managed", env.stateDir)).toMatchObject({ drained: false });
    await expect(createController().resume({ runRef: env.stateDir, runner: runner([]), managed: { ...env.grant, generation: 2, launchId: "launch-2", automatic: true } })).rejects.toThrow("operator action");
  });

  it("deduplicates committed remedies and refuses interrupted applications", async () => {
    const env = await environment();
    await mkdir(env.stateDir, { recursive: true });
    expect(await beginManagedCommand(env.stateDir, "command-1")).toBe("new");
    await expect(beginManagedCommand(env.stateDir, "command-1")).rejects.toThrow("unsettled");
    await finishManagedCommand(env.stateDir, "command-1");
    expect(await beginManagedCommand(env.stateDir, "command-1")).toBe("applied");
  });
});
