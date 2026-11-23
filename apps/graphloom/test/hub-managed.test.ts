// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { openHub } from "@graphloom/hub";
import type { Hub, HubDriver, HubGrantMessage } from "@graphloom/hub";
import type { HubLaunch, HubSubmission } from "@graphloom/sdk";
import { digestExecutorSource } from "@graphloom/runner";
import { runtimeDigest } from "../src/hub-input.js";
import { selfInstall } from "../src/ownership.js";
import { parseRemedy, remedyArgs } from "../src/hub-managed.js";
import { observeInitialization } from "../src/hub-initialization.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const exec = promisify(execFile);
const folders: string[] = [];
const children: ChildProcess[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const hub of hubs.splice(0)) await hub.close({ graceMs: 0 }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function fixture(mode: HubLaunch["mode"] = "initial", actualRun = false, actualMain = false, failInitialStateWrite = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "graphloom-bootstrap-")); folders.push(directory);
  const repo = path.join(directory, "repo"); await mkdir(repo);
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"], ["config", "commit.gpgsign", "false"]]) await exec("git", args, { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "fixture\n"); await exec("git", ["add", "."], { cwd: repo }); await exec("git", ["commit", "-qm", "initial"], { cwd: repo });
  const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], { cwd: repo });
  const runtime = selfInstall().record;
  const driver: HubDriver = {
    async probe() {}, async prepare() { return { bootId: "fixture", pid: 1234, startTime: "1" }; }, async grant() {},
    async inspect() { return { execution: "live", ownerGone: false, externalStopped: false }; }, async stop() {}, async kill() {},
  };
  const hubDirectory = path.join(directory, "hub");
  const hub = await openHub({ directory: hubDirectory, driver, autoPoll: false, config: { maxConcurrentRuns: 1, shutdownGraceMs: 0, ...(failInitialStateWrite ? { retry: { baseDelayMs: 0, maxDelayMs: 0 } } : {}) } }); hubs.push(hub);
  const bundle = actualMain ? path.join(directory, "noop") : path.join(root, "examples/plugins/hello");
  if (actualMain) {
    await mkdir(bundle);
    await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify({ graphId: "noop", version: "1.0.0", sdkProtocol: 1, repairContract: "opaque", entryPoints: { createGraph: "./index.mjs" } }));
    await writeFile(path.join(bundle, "index.mjs"), `export function createGraph() { return { describe() { return { graphId: 'noop', version: '1.0.0', stages: [{id:'done', name:'Done', requirementIds:[]}], requirements: [], defaultValidators: [] }; }, advance() { return {action:{type:'stop',stop:{reason:'complete',blocker:'none'}},reason:'No work required'}; } }; }`);
  }
  const runnerFile = path.join(directory, "runner.json");
  const runnerBytes = JSON.stringify({ harness: "claude-code", allowUnrestricted: true, claude: { command: process.execPath } });
  await writeFile(runnerFile, runnerBytes);
  const task = `graph: ${actualMain ? "noop" : "hello"}\nrepo: ./repo\nrequest: Create GREETING.txt.\n`;
  const result = await hub.submit({ requestDigest: "a".repeat(64), input: {
    task, taskDigest: createHash("sha256").update(task).digest("hex"), taskPath: path.join(directory, "task.yaml"), repoPath: repo, baseCommit: head.trim(),
    bundlePath: bundle, bundleDigest: await digestExecutorSource(bundle),
    runtimePath: path.join(runtime.root, "apps/graphloom/dist/main.js"), runtimeRoot: runtime.root, runtimeVersion: runtime.version, runtimeDigest: await runtimeDigest(runtime.root), runtimeNode: process.execPath, runtimeConfig: { runner: { path: runnerFile, digest: createHash("sha256").update(runnerBytes).digest("hex") } },
  } });
  if ("archived" in result) throw new Error("unexpected archived submission");
  await hub.tick();
  const submission = hub.inspect(result.id);
  const snapshotFile = path.join(hubDirectory, "scheduler.json");
  const snapshot = JSON.parse(await readFile(snapshotFile, "utf8")); snapshot.submissions[submission.id].launch.mode = mode; await writeFile(snapshotFile, JSON.stringify(snapshot));
  const marker = path.join(directory, "callback.json"); const active = path.join(directory, "active");
  const script = path.join(directory, "bootstrap.mjs");
  await writeFile(script, `import { writeFile } from 'node:fs/promises';\nimport { managedMain } from ${JSON.stringify(pathToFileURL(path.join(root, "apps/graphloom/dist/hub-managed.js")).href)};\nimport { createController } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/controller/dist/index.js")).href)};\nimport { createScriptedRunner } from ${JSON.stringify(pathToFileURL(path.join(root, "packages/runner/dist/index.js")).href)};\nprocess.stdout.write('ready\\n');\ntry { await managedMain(${JSON.stringify([hubDirectory, submission.id])}, async (argv, context) => {\nawait writeFile(${JSON.stringify(marker)}, JSON.stringify({argv, grant:context.grant}));\n${actualRun ? `const runner = {...createScriptedRunner({jobs:[async (_job, ctx) => { await writeFile(${JSON.stringify(active)}, 'active'); await new Promise(resolve => { if(ctx.signal?.aborted) resolve(); else ctx.signal?.addEventListener('abort',()=>resolve(),{once:true}); }); return {status:'failed',summary:'fixture interrupted'}; }]}), managed:{async check(){},async drain(){return {drained:true,resources:[]};}}};\nawait createController().run({taskPath:argv[1],stateRoot:${JSON.stringify(path.join(hubDirectory, "runs"))},runId:context.grant.runId,managed:context.grant,onRunCreated:context.created,runner});` : "await context.grant.verify();"}\n}); } catch(error) { process.stderr.write(error.message+'\\n'); process.exitCode=1; }`);
  const argv = actualMain ? [path.join(root, "apps/graphloom/dist/main.js"), "__hub-managed", hubDirectory, submission.id] : [script];
  const failpoint = path.join(directory, "fail-initial-state.mjs");
  if (failInitialStateWrite) await writeFile(failpoint, String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const original = fs.promises.open;
fs.promises.open = (file, ...args) => /^state\.\d+\.[a-f0-9-]{36}\.tmp$/.test(path.basename(String(file)))
  ? Promise.reject(new Error('fixture initial state persistence failure')) : original(file, ...args);
syncBuiltinESMExports();
`);
  const env = { ...process.env, HOME: directory };
  const processFixture = await startBootstrap(failInitialStateWrite ? ["--import", failpoint, ...argv] : argv, env, actualMain);
  const grant: HubGrantMessage = { protocolVersion: 1, type: "grant", hubId: submission.hubId, submissionId: submission.id, runId: submission.runId, launchId: submission.launch!.id, generation: submission.generation, automatic: false };
  return { ...processFixture, driver, directory, grant, marker, active, hub, hubDirectory, submission, snapshotFile, startAgain: () => startBootstrap(argv, env, actualMain) };
}
async function startBootstrap(argv: string[], env: NodeJS.ProcessEnv, actualMain: boolean) {
  const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe", "pipe"], env }); children.push(child);
  let stdout = ""; let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const control = child.stdio[3] as Duplex; control.on("error", () => undefined); control.resume();
  const done = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once("close", (code) => resolve({ code, stderr })));
  if (actualMain) await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  else await eventually(async () => expect(stdout, stderr).toContain("ready"));
  return { child, control, done, send: (value: unknown) => control.write(`${JSON.stringify(value)}\n`) };
}
async function eventually(fn: () => Promise<void>): Promise<void> {
  let failure: unknown;
  for (let i = 0; i < 200; i++) { try { await fn(); return; } catch (error) { failure = error; await new Promise((resolve) => setTimeout(resolve, 10)); } }
  throw failure;
}
describe("managed CLI fd3 bootstrap", () => {
  it("waits for its durable grant before materializing a task or invoking graph execution", async () => {
    const f = await fixture();
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(path.dirname(f.submission.input.taskFile), "launch-task.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
    f.send(f.grant); const result = await f.done; expect(result.code, result.stderr).toBe(0);
    const called = JSON.parse(await readFile(f.marker, "utf8"));
    expect(called.argv[0]).toBe("run"); expect(called.argv[1]).toMatch(/launch-task.yaml$/);
    expect(called.grant).toMatchObject({ launchId: f.grant.launchId, runId: f.grant.runId, generation: 1 });
  });
  it("runs the compiled main entry through managed intake with a zero-agent graph", async () => {
    const f = await fixture("initial", false, true);
    await expect(readFile(path.join(f.hubDirectory, "runs", f.submission.runId, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    f.send(f.grant);
    const result = await f.done; expect(result.code, result.stderr).toBe(0);
    const state = JSON.parse(await readFile(path.join(f.hubDirectory, "runs", f.submission.runId, "state.json"), "utf8"));
    expect(state).toMatchObject({ runId: f.submission.runId, status: "succeeded", definition: { graphId: "noop" } });
    expect(state.receipts).toEqual([]);
    const binding = JSON.parse(await readFile(path.join(f.hubDirectory, "runs", f.submission.runId, "managed-run.json"), "utf8"));
    expect(binding).toMatchObject({ submissionId: f.submission.id, runId: f.submission.runId, generation: f.submission.generation });
  });
  it("retries a failed initial state write through compiled main while retaining the run and worktree", async () => {
    const f = await fixture("initial", false, true, true); f.send(f.grant);
    const first = await f.done; expect(first).toMatchObject({ code: 1, stderr: expect.stringContaining("fixture initial state persistence failure") });
    const stateDir = path.join(f.hubDirectory, "runs", f.submission.runId);
    await expect(readFile(path.join(stateDir, "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const worktree = path.join(f.submission.input.repoPath, "graphloom", f.submission.runId);
    const before = await lstat(worktree);
    const observed = await observeInitialization(stateDir, f.submission, f.submission.launch!);
    expect(observed).toMatchObject({ continuation: { kind: "automatic", cause: "initialization-failed" } });
    f.driver.inspect = async () => ({ execution: "drained", ownerGone: true, externalStopped: true, observation: observed });
    await f.hub.tick();
    const next = f.hub.inspect(f.submission.id);
    expect(next).toMatchObject({ runId: f.submission.runId, automaticResumes: 1, launch: { mode: "initial", generation: 2, automatic: true } });
    const child = await f.startAgain(); child.send({ ...f.grant, launchId: next.launch!.id, generation: next.generation, automatic: true });
    const second = await child.done; expect(second.code, second.stderr).toBe(0);
    const state = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"));
    expect(state).toMatchObject({ runId: f.submission.runId, status: "succeeded", worktreePath: worktree });
    expect((await lstat(worktree)).ino).toBe(before.ino);
    expect(JSON.parse(await readFile(path.join(stateDir, "managed-run.json"), "utf8"))).toMatchObject({ generation: 2, launchId: next.launch!.id });
    await expect(readFile(path.join(stateDir, "managed-execution-started.json"))).resolves.toBeDefined();
    f.driver.inspect = async () => ({ execution: "drained", ownerGone: true, externalStopped: true, observation: { protocolVersion: 1, observedAt: new Date().toISOString(), stateRevision: state.stateRevision, progressRevision: 0, status: "succeeded", continuation: { kind: "complete" } } });
    await f.hub.tick(); expect(f.hub.inspect(next.id).state).toBe("succeeded");
  });
  it("rejects a mismatched generation without invoking execution", async () => {
    const f = await fixture(); f.send({ ...f.grant, generation: 2 });
    expect(await f.done).toMatchObject({ code: 1, stderr: expect.stringMatching(/does not match/) });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses a matching wire grant whose durable reservation is withdrawn", async () => {
    const f = await fixture(); await f.hub.pause(f.submission.id); f.send(f.grant);
    expect(await f.done).toMatchObject({ code: 1, stderr: expect.stringMatching(/withdrawn/) });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("exits on EOF or SIGTERM before grant without work", async () => {
    for (const kind of ["eof", "signal"]) {
      const f = await fixture(); if (kind === "eof") f.control.end(); else f.child.kill("SIGTERM");
      expect(await f.done).toMatchObject({ code: 1, stderr: expect.stringMatching(/before start grant/) });
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("refuses duplicate and oversized control grants before work", async () => {
    for (const oversized of [false, true]) {
      const f = await fixture();
      if (oversized) f.control.write("x".repeat(20000)); else f.control.write(`${JSON.stringify(f.grant)}\n${JSON.stringify(f.grant)}\n`);
      expect((await f.done).code).toBe(1);
      await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("maps a reconciliation reservation to the reconciliation-only CLI path", async () => {
    const f = await fixture("reconcile"); f.send(f.grant); const result = await f.done;
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(f.marker, "utf8")).argv).toEqual(["__hub-reconcile", path.join(f.hubDirectory, "runs", f.submission.runId)]);
  });
  it("refuses any operator remedy attached to an automatic continuation", async () => {
    const f = await fixture("resume"); const snapshot = JSON.parse(await readFile(f.snapshotFile, "utf8"));
    snapshot.submissions[f.submission.id].launch.automatic = true;
    snapshot.submissions[f.submission.id].launch.command = { id: "unsafe", kind: "resume", acceptedAt: new Date().toISOString(), remedy: { reconciled: true } };
    await writeFile(f.snapshotFile, JSON.stringify(snapshot)); f.send({ ...f.grant, automatic: true });
    expect(await f.done).toMatchObject({ code: 1, stderr: expect.stringMatching(/operator remedies/) });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("preserves a planned interruption when the control channel closes or SIGTERM is delivered", async () => {
    for (const kind of ["eof", "signal"]) {
      const f = await fixture("initial", true); f.send(f.grant);
      await eventually(async () => expect(await readFile(f.active, "utf8")).toBe("active"));
      await f.hub.close({ graceMs: 0 });
      const stored = JSON.parse(await readFile(f.snapshotFile, "utf8")) as { submissions: Record<string, HubSubmission> };
      const stopId = stored.submissions[f.submission.id]!.launch!.stopCommandId;
      if (kind === "eof") f.control.end(); else f.child.kill("SIGTERM");
      const result = await f.done; expect(result.code, result.stderr).toBe(0);
      const state = JSON.parse(await readFile(path.join(f.hubDirectory, "runs", f.submission.runId, "state.json"), "utf8"));
      expect(state.managedContinuation).toMatchObject({ cause: "service-interruption", interruptionCommandId: stopId });
      expect(state.status).toBe("stopped");
    }
  });
});

describe("managed operator remedy argv", () => {
  it("roundtrips explicit values without shell interpretation", () => {
    const remedy = { approve: "decision", inputs: { command: "$(literal) `text`" } };
    expect(parseRemedy(["resume", "run", ...remedyArgs(remedy)])).toEqual(remedy);
    expect(remedyArgs(undefined)).toEqual([]);
  });
});
