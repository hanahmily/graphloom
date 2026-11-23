// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedRunner, type Runner, type ScriptedJobHandler } from "@graphloom/runner";
import { createScriptedGraph, stop } from "@graphloom/sdk";
import { createInProcessPluginHost } from "@graphloom/plugin-host";
import { runNormalLoop } from "./loop.js";
import { hasStopRequest, writeStopRequest } from "./stop-request.js";
import { createController, intakeTask, loadRunState, saveRunState } from "./controller.js";
import { assertAutomaticContinuation, authorizeManagedRun, beginManagedCommand, finishManagedCommand, observeContinuation, readManagedBinding, reconcileManagedRun, releaseManagedRun, type ManagedRunGrant } from "./managed.js";
import { createRunWorktree } from "./worktree.js";
import { withDirectoryLock } from "./lock.js";
import { stopMarkOf } from "./stop-class.js";
import * as durableState from "./state.js";

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
  async function stoppedRun() {
    const env = await environment();
    const controller = createController();
    await controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([failure]) });
    const { stopClass: _class, stopMark: _mark, ...state } = await loadRunState(env.stateDir);
    const stopped = { ...state, stopReason: "operator stop", definition: { ...state.definition, approvals: [{ id: "publish" }] } };
    await saveRunState(stopped);
    const plugin = () => createScriptedGraph({ definition: stopped.definition, advances: [stop({ reason: "fixture pause", blocker: "test" }, "pause")] });
    const managed = { ...env.grant, generation: 2, launchId: "resume-2", commandId: "remedy-1" };
    const commandFiles = async () => (await readdir(env.stateDir)).filter((file) => file.startsWith("managed-command-"));
    return { ...env, controller, state: stopped, plugin, managed, commandFiles };
  }

  it("keeps invalid approval preflight retryable under the same command ID", async () => {
    const env = await stoppedRun();
    const request = { runRef: env.stateDir, managed: env.managed, runner: runner([]), approval: { approvalId: "missing", decision: "approve" as const } };
    await expect(env.controller.resume(request)).rejects.toThrow("declares no approval");
    await expect(env.controller.resume(request)).rejects.toThrow("declares no approval");
    expect(await env.commandFiles()).toEqual([]);
  });

  it.each([false, true])("keeps undrained cleanup preflight retryable under the same command ID (upgrade: %s)", async (upgrade) => {
    const env = await stoppedRun();
    const execution = runner([]);
    execution.managed!.drain = async () => ({ drained: false, resources: ["fixture-container"] });
    const request = { runRef: env.stateDir, managed: env.managed, runner: execution, approval: { approvalId: "publish", decision: "approve" as const }, ...(upgrade ? { upgrade: { install: { version: "0.2.0", root: env.dir } } } : {}) };
    await expect(env.controller.resume(request)).rejects.toThrow("external cleanup pending");
    await expect(env.controller.resume(request)).rejects.toThrow("external cleanup pending");
    expect(await env.commandFiles()).toEqual([]);
  });

  it("rechecks a grant revoked during preflight before journaling or applying a remedy", async () => {
    const env = await stoppedRun();
    let revoked = false;
    const managed = { ...env.managed, async verify() { if (revoked) throw new Error("grant stopped during preflight"); } };
    const execution = runner([]);
    execution.managed!.drain = async () => { revoked = true; return { drained: true, resources: [] }; };
    await expect(env.controller.resume({ runRef: env.stateDir, managed, runner: execution, plugin: env.plugin(), validators: {}, approval: { approvalId: "publish", decision: "approve" } })).rejects.toThrow("grant stopped during preflight");
    expect(await env.commandFiles()).toEqual([]);
    expect((await loadRunState(env.stateDir)).generation).toBe(env.state.generation);
    revoked = false;
    await env.controller.resume({ runRef: env.stateDir, managed, runner: runner([]), plugin: env.plugin(), validators: {}, approval: { approvalId: "publish", decision: "approve" } });
    expect(await env.commandFiles()).toHaveLength(1);
  });

  it("does not journal a refused upgrade or an unreadable approval file", async () => {
    const env = await stoppedRun();
    const request = { runRef: env.stateDir, managed: env.managed, runner: runner([]), upgrade: { install: { version: "invalid", root: env.dir } } };
    await expect(env.controller.resume(request)).rejects.toThrow("is not a GraphLoom version");
    await expect(env.controller.resume(request)).rejects.toThrow("is not a GraphLoom version");
    expect(await env.commandFiles()).toEqual([]);

    const unavailable = await stoppedRun();
    await saveRunState({ ...unavailable.state, definition: { ...unavailable.state.definition, approvals: [{ id: "publish", files: ["missing.txt"] }] } });
    const approval = { runRef: unavailable.stateDir, managed: unavailable.managed, runner: runner([]), approval: { approvalId: "publish", decision: "approve" as const } };
    await expect(unavailable.controller.resume(approval)).rejects.toThrow("does not exist");
    await expect(unavailable.controller.resume(approval)).rejects.toThrow("does not exist");
    expect(await unavailable.commandFiles()).toEqual([]);
  });

  it.each(["updatePlugin", "updateExecutors"] as const)("does not journal %s before the host accepts the pinned definition", async (remedy) => {
    const env = await stoppedRun();
    const refusedHost = () => {
      const host = createInProcessPluginHost(env.plugin(), { activeVersion: env.state.activeVersion, generation: env.state.generation + 1 });
      vi.spyOn(host, "describe").mockResolvedValue({ ok: false, observation: { kind: "child_observation", code: "crash", message: "fixture describe refusal" } });
      return host;
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await env.controller.resume({ runRef: env.stateDir, managed: env.managed, runner: runner([]), host: refusedHost(), validators: {}, [remedy]: true });
      expect(report.stopReason).toBe("pin mismatch");
    }
    expect(await env.commandFiles()).toEqual([]);
  });

  it("deduplicates an applied approval and still refuses replay after an ambiguous commit", async () => {
    const env = await stoppedRun();
    const approval = { approvalId: "publish", decision: "approve" as const };
    await env.controller.resume({ runRef: env.stateDir, managed: env.managed, runner: runner([]), plugin: env.plugin(), validators: {}, approval });
    const approvals = async () => (await loadRunState(env.stateDir)).evidence.filter((evidence) => evidence.payload !== null && typeof evidence.payload === "object" && "type" in evidence.payload && evidence.payload.type === "operator-approval");
    expect(await approvals()).toHaveLength(1);
    await env.controller.resume({ runRef: env.stateDir, managed: { ...env.managed, generation: 3, launchId: "resume-3" }, runner: runner([]), plugin: env.plugin(), validators: {}, approval });
    expect(await approvals()).toHaveLength(1);

    const interrupted = await stoppedRun();
    const host = createInProcessPluginHost(interrupted.plugin(), { activeVersion: interrupted.state.activeVersion, generation: interrupted.state.generation + 1 });
    vi.spyOn(host, "describe").mockRejectedValue(new Error("fixture crash after approval commit"));
    await expect(interrupted.controller.resume({ runRef: interrupted.stateDir, managed: interrupted.managed, runner: runner([]), host, approval })).rejects.toThrow("fixture crash");
    await expect(interrupted.controller.resume({ runRef: interrupted.stateDir, managed: interrupted.managed, runner: runner([]), plugin: interrupted.plugin(), validators: {}, approval })).rejects.toThrow("application is unsettled");
  });

  const commandRecords = async (env: { stateDir: string; commandFiles: () => Promise<string[]> }) =>
    Promise.all((await env.commandFiles()).map(async (file) => JSON.parse(await readFile(path.join(env.stateDir, file), "utf8")) as { applied: boolean }));

  it("refuses a wrong approval combined with --upgrade before the move, and a retry under the same command ID applies both", async () => {
    const env = await stoppedRun();
    const upgrade = { install: { version: "0.2.0", root: env.dir } };
    const wrong = { runRef: env.stateDir, managed: env.managed, runner: runner([]), plugin: env.plugin(), validators: {}, upgrade, approval: { approvalId: "missing", decision: "approve" as const } };
    await expect(env.controller.resume(wrong)).rejects.toThrow("declares no approval");
    await expect(env.controller.resume(wrong)).rejects.toThrow("declares no approval");
    expect(await env.commandFiles()).toEqual([]);
    expect((await loadRunState(env.stateDir)).install).toEqual(env.state.install);

    const unreadable = await stoppedRun();
    await saveRunState({ ...unreadable.state, definition: { ...unreadable.state.definition, approvals: [{ id: "publish", files: ["missing.txt"] }] } });
    const missingFile = { runRef: unreadable.stateDir, managed: unreadable.managed, runner: runner([]), upgrade, approval: { approvalId: "publish", decision: "approve" as const } };
    await expect(unreadable.controller.resume(missingFile)).rejects.toThrow("does not exist");
    expect(await unreadable.commandFiles()).toEqual([]);

    await env.controller.resume({ ...wrong, approval: { approvalId: "publish", decision: "approve" } });
    const state = await loadRunState(env.stateDir);
    expect(state.install).toEqual(upgrade.install);
    expect(state.evidence.filter((evidence) => evidence.payload !== null && typeof evidence.payload === "object" && "type" in evidence.payload && evidence.payload.type === "operator-approval")).toHaveLength(1);
    expect(await commandRecords(env)).toEqual([expect.objectContaining({ applied: true })]);
  });

  it("settles a committed upgrade as applied when the resume then stops before running", async () => {
    const env = await stoppedRun();
    await saveRunState({ ...env.state, worktreeBranch: "graphloom/elsewhere" });
    const request = { runRef: env.stateDir, managed: env.managed, runner: runner([]), upgrade: { install: { version: "0.2.0", root: env.dir } } };
    expect((await env.controller.resume(request)).stopReason).toBe("worktree mismatch");
    expect((await loadRunState(env.stateDir)).install).toEqual(request.upgrade.install);
    expect(await commandRecords(env)).toEqual([expect.objectContaining({ applied: true })]);
    // The retry is deduplicated: the move is not replayed, and nothing reports an unsettled command.
    expect((await env.controller.resume(request)).stopReason).toBe("worktree mismatch");
    expect((await loadRunState(env.stateDir)).installHistory).toHaveLength(1);
  });

  it.each(["final stop held", "quota reconciliation"] as const)("settles a supervisor pin saved by an early return (%s) and a retry succeeds", async (path) => {
    const env = await stoppedRun();
    const stopped = path === "final stop held"
      ? { ...env.state, stopReason: "fixture final stop", stopClass: { by: "plugin" as const, retryable: false, reason: "fixture final stop" }, stopMark: stopMarkOf({ ...env.state, stopReason: "fixture final stop" }, env.state.candidateDigest) }
      : { ...env.state, reconciliationRequired: { operationId: "old", stageId: "write", reason: "unknown effect", since: new Date().toISOString() } };
    await saveRunState(stopped as typeof env.state);
    const request = { runRef: env.stateDir, managed: env.managed, runner: runner([]), plugin: env.plugin(), validators: {}, supervisorPin: { selection: { harness: "pi", source: "fallback" as const, reason: "fixture" } } };
    const report = await env.controller.resume(request);
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe(path === "final stop held" ? "fixture final stop" : "harness quota hit after possible effects; reconcile before resuming");
    expect((await loadRunState(env.stateDir)).supervisorSelection).toMatchObject({ harness: "pi" });
    expect(await commandRecords(env)).toEqual([expect.objectContaining({ applied: true })]);
    expect((await env.controller.resume(request)).status).toBe("stopped");
  });

  it("rechecks a cleared quota hold after reloading under the run lock", async () => {
    const env = await stoppedRun();
    const running = { ...env.state, status: "running" as const };
    await saveRunState(running);
    const stale = { ...running, quotaHold: { until: new Date(Date.now() + 60_000).toISOString() } };
    const host = createInProcessPluginHost(env.plugin(), { activeVersion: running.activeVersion, generation: running.generation });
    try {
      const result = await runNormalLoop(stale, { host, runner: runner([]), validators: {}, managed: true });
      expect(result.status).toBe("stopped");
      expect(result.stopReason).toBe("fixture pause");
      expect(result.managedContinuation).toBeUndefined();
    } finally { await host.close(); }
  });

  it("honors a malformed managed stop record as an explicit stop", async () => {
    const env = await stoppedRun();
    const running = { ...env.state, status: "running" as const };
    await saveRunState(running);
    await writeFile(path.join(env.stateDir, "stop.request"), "{truncated");
    const host = createInProcessPluginHost(env.plugin(), { activeVersion: running.activeVersion, generation: running.generation });
    try {
      const result = await runNormalLoop(running, { host, runner: runner([]), validators: {}, managed: true, shouldStop: () => hasStopRequest(env.stateDir) });
      expect(result.stopReason).toBe("operator stop");
      expect(result.managedContinuation).toBeUndefined();
    } finally { await host.close(); }
  });

  it("retains planned interruption over disconnect but keeps explicit operator stop strongest", async () => {
    const env = await environment();
    await mkdir(env.stateDir, { recursive: true });
    const planned = { interruptionCommandId: "service-stop-1" };
    await writeStopRequest(env.stateDir, planned);
    expect(await writeStopRequest(env.stateDir, { managedDisconnect: true })).toEqual(planned);
    expect(JSON.parse(await readFile(path.join(env.stateDir, "stop.request"), "utf8"))).toMatchObject(planned);
    await writeStopRequest(env.stateDir);
    expect(await writeStopRequest(env.stateDir, planned)).toEqual({});
    expect(await writeStopRequest(env.stateDir, { managedDisconnect: true })).toEqual({});
  });

  it("distinguishes failed initialization from missing state after managed execution started", async () => {
    const env = await environment();
    const controller = createController();
    const save = vi.spyOn(durableState, "saveRunState").mockRejectedValueOnce(new Error("fixture first-state save failure"));
    try {
      await expect(controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: env.grant, runner: runner([]) })).rejects.toThrow("fixture first-state save failure");
    } finally { save.mockRestore(); }
    expect(await readManagedBinding(env.stateDir)).toMatchObject({ initializationProtocol: 1 });
    const marker = path.join(env.stateDir, "managed-execution-started.json");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(env.stateDir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    let dispatched = false;
    await controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: { ...env.grant, generation: 2, launchId: "initial-2" },
      async onRunCreated() { await readFile(marker); },
      runner: runner([async () => { await readFile(marker); dispatched = true; return { status: "failed", summary: "fixture" }; }]) });
    expect(dispatched).toBe(true);
    await rm(path.join(env.stateDir, "state.json"));
    await expect(controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: { ...env.grant, generation: 3, launchId: "initial-3" }, runner: runner([]) })).rejects.toThrow("managed execution already started");
  });

  it("marks a saved initialization before resume execution and refuses legacy missing-state replay", async () => {
    const env = await stoppedRun();
    const marker = path.join(env.stateDir, "managed-execution-started.json");
    await rm(marker, { force: true });
    const host = createInProcessPluginHost(env.plugin(), { activeVersion: env.state.activeVersion, generation: env.state.generation + 1 });
    const describe = host.describe.bind(host);
    host.describe = async (context) => { await readFile(marker); return describe(context); };
    await env.controller.resume({ runRef: env.stateDir, managed: env.managed, runner: runner([]), host, validators: {} });
    await rm(marker);
    await rm(path.join(env.stateDir, "state.json"));
    const binding = JSON.parse(await readFile(path.join(env.stateDir, "managed-run.json"), "utf8"));
    delete binding.initializationProtocol;
    await writeFile(path.join(env.stateDir, "managed-run.json"), JSON.stringify(binding));
    await expect(env.controller.run({ taskPath: env.taskPath, stateRoot: env.stateRoot, runId: "managed", managed: { ...env.managed, generation: 3, launchId: "initial-3" }, runner: runner([]) })).rejects.toThrow("initialization provenance");
  });

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
