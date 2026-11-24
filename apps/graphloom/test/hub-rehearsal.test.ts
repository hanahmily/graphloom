// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Rehearsal submissions through a real hub service (docs/design-run-hub.md §12),
 * each on a temporary hub directory and socket, never the operator's: the hub
 * queues, reserves, launches (the compiled CLI's managed bootstrap over fd 3),
 * observes and continues a rehearsal exactly as it does a real submission, and
 * the launch runs on `graphloom rehearse`'s stand-ins.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { openHub, type Hub, type HubDriver, type HubGrantMessage } from "@graphloom/hub";
import type { HubHealth, HubStatus, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import { REHEARSAL_HOME_ENV, REHEARSAL_SCENARIO_ENV, REHEARSAL_SYNTHESIZED_ENV } from "@graphloom/sdk";
import { digestExecutorSource } from "@graphloom/runner";
import { createScope, createTopologyFixture, TOPOLOGY_APPROVAL, TOPOLOGY_APPROVAL_STOP, type TestScope } from "@graphloom/testkit";
import { hubRequest } from "../src/hub-client.js";
import { formatHubList, formatHubStatus, hubCommand, submitRehearsal } from "../src/hub-cli.js";
import { runtimeDigest } from "../src/hub-input.js";
import { selfInstall } from "../src/ownership.js";
import { execFileAsync, repoRoot } from "./cli-env.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";
import { childEnvironment, useTestHubs } from "./hub-harness.js";

const folders: string[] = [];
const hubs: Hub[] = [];
const children: ChildProcess[] = [];
let scope: TestScope | undefined;
const { startHub, waitForState } = useTestHubs();
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const hub of hubs.splice(0)) await hub.close({ graceMs: 0 }).catch(() => undefined);
  await scope?.dispose(); scope = undefined;
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function helloTask(): Promise<{ dir: string; taskPath: string; runnerConfig: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-hub-rh-task-")); folders.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(repoRoot, "examples/plugins/hello"), path.join(dir, "plugins", "hello"));
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, `graph: hello\nrepo: ./repo\nrequest: "Create GREETING.txt."\n`);
  // B2 probes the operator's agent CLIs: fakes that answer it, never a real login.
  const agents = await writeFakeCodingAgents(dir);
  const runnerConfig = path.join(dir, "runner.json");
  await writeFile(runnerConfig, JSON.stringify(fakeRunnerConfig(agents)));
  return { dir, taskPath, runnerConfig };
}

describe("rehearsal submissions through the hub", () => {
  it("reaches ready for hello's happy scenario, recorded and shown as a rehearsal, apart from a real submission of the same task", { timeout: 200_000 }, async () => {
    const task = await helloTask();
    const hub = await startHub(task.runnerConfig);
    const submitted = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task.taskPath, key: "hello-1", rehearsal: {} }, hub.socket);
    expect(submitted).toMatchObject({ key: "rehearsal:hello-1", input: { rehearsal: {} } });
    expect(submitted.runId).toMatch(/^rehearsal-hub-/);
    // No supervisor config is pinned: the scenario's script is the rehearsal's supervisor.
    expect(submitted.input.runtimeConfig).toEqual({ runner: expect.objectContaining({ path: task.runnerConfig }) });

    const done = await waitForState(hub, submitted.id, ["succeeded", "failed", "blocked"]);
    expect(done.state, hub.driver.log()).toBe("succeeded");
    expect(done.rehearsalVerdict).toMatchObject({ verdict: "ready", convergence: true, runStatus: "succeeded", boundaries: { B1: "passed", B2: "passed", B5: "passed", B7: "passed" } });
    const stateDir = path.join(hub.directory, "runs", submitted.runId);
    expect(JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8"))).toMatchObject({ runId: submitted.runId, status: "succeeded" });
    // The launch ran on the stand-ins, with the scratch kept under the hub beside the run.
    const report = JSON.parse(await readFile(path.join(hub.directory, "rehearsals", submitted.runId, "report.json"), "utf8")) as { verdict: string; substituted: string[] };
    expect(report.verdict).toBe("ready");
    expect(report.substituted.join("\n")).toMatch(/claude-code: rehearsal stand-in/);
    expect(hub.driver.log()).toContain(`graphloom: rehearsal verdict ready`);

    // hub list --json and the overview panel show it as a rehearsal, with its verdict.
    const listed = await hubRequest<HubStatus>("GET", "/v1/submissions", undefined, hub.socket);
    expect(listed.rehearsals?.[submitted.id]).toMatchObject({ verdict: "ready" });
    const snapshot = await hubRequest<MonitorSnapshot>("GET", `/v1/submissions/${submitted.id}/snapshot`, undefined, hub.socket);
    expect(snapshot.hub?.rehearsal).toBe("scenario happy · commands stub · verdict ready");
    const health = await hubRequest<HubHealth>("GET", "/v1/health", undefined, hub.socket);
    expect(health).toMatchObject({ counts: { succeeded: 1 }, rehearsalCounts: { succeeded: 1 } });
    expect(formatHubList(listed)).toContain(`${submitted.id}  succeeded   ${submitted.runId}  [rehearsal happy: ready]`);
    expect(formatHubStatus(health, hub.socket)).toContain("Rehearsals: 1 (succeeded 1)");

    // The same task and key as a real submission is a different submission, on a real run ID.
    await hubRequest("POST", "/v1/limit", { limit: 0 }, hub.socket);
    const real = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task.taskPath, key: "hello-1" }, hub.socket);
    expect(real.id).not.toBe(submitted.id);
    expect(real).toMatchObject({ key: "hello-1", state: "queued" });
    expect(real.runId).toMatch(/^hub-/);
    expect(real.input.rehearsal).toBeUndefined();
    expect(real.requestDigest).not.toBe(submitted.requestDigest);
    // Each key answers its own request again.
    expect((await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: task.taskPath, key: "hello-1", rehearsal: {} }, hub.socket)).id).toBe(submitted.id);
    const counts = await hubRequest<HubHealth>("GET", "/v1/health", undefined, hub.socket);
    expect(counts).toMatchObject({ counts: { succeeded: 1, queued: 1 }, rehearsalCounts: { succeeded: 1 } });
    // The hub's own process never took a stand-in variable.
    for (const name of [REHEARSAL_SCENARIO_ENV, REHEARSAL_HOME_ENV, REHEARSAL_SYNTHESIZED_ENV]) expect(process.env[name]).toBeUndefined();
  });

  it("stops a supervisor-only node waiting on its approval, and hub resume --approve continues the scripted supervisor at its next decision", { timeout: 300_000 }, async () => {
    scope = createScope();
    const fixture = await createTopologyFixture(scope);
    const agents = await writeFakeCodingAgents(fixture.dir);
    const runnerConfig = path.join(fixture.dir, "runner.json");
    await writeFile(runnerConfig, JSON.stringify(fakeRunnerConfig(agents)));
    const hub = await startHub(runnerConfig);
    const submitted = await hubRequest<HubSubmission>("POST", "/v1/submissions", { taskPath: fixture.taskPath, rehearsal: { scenario: "operator" } }, hub.socket);

    const waiting = await waitForState(hub, submitted.id, ["blocked", "succeeded", "failed"]);
    expect(waiting, hub.driver.log()).toMatchObject({ state: "blocked", observation: { status: "stopped", continuation: { kind: "operator" } } });
    // A final stop that waits for the graph's declared approval is the operator scenario's expectation: ready.
    expect(waiting.rehearsalVerdict).toMatchObject({ verdict: "ready", runStatus: "stopped", stopReason: TOPOLOGY_APPROVAL_STOP });
    // The blocker's command is the run's own (RunView.resumeCommand): the hub's, which `graphloom resume` would refuse.
    expect(waiting.observation?.blocker).toContain(`Rule on it: graphloom hub resume ${submitted.id} --approve ${TOPOLOGY_APPROVAL}`);
    const stateFile = path.join(hub.directory, "runs", submitted.runId, "state.json");
    type Episodes = { status: string; supervisorEpisodes?: Array<{ proposal?: { action: { type: string } }; admission: { outcome: string } }> };
    const before = (JSON.parse(await readFile(stateFile, "utf8")) as Episodes).supervisorEpisodes ?? [];
    expect(before.map((r) => r.proposal?.action.type)).toEqual(["enter", "return"]);

    // A rehearsal's supervisor is its script: a transition is refused; the approval is the remedy.
    await expect(hubRequest("POST", `/v1/submissions/${submitted.id}/resume`, { commandId: "c-supervisor", remedy: { supervisor: "codex" } }, hub.socket)).rejects.toThrow(/scenario's script/);
    await hubRequest("POST", `/v1/submissions/${submitted.id}/resume`, { commandId: "c-approve", remedy: { approve: TOPOLOGY_APPROVAL, inputs: { ruling: "the build stands" } } }, hub.socket);
    const finished = await waitForState(hub, submitted.id, ["succeeded", "failed", "blocked"]);
    expect(finished.state, hub.driver.log()).toBe("succeeded");
    expect(finished.runId).toBe(submitted.runId);

    // The script continued at its third decision, the leave: no replayed enter, nothing rejected.
    const after = JSON.parse(await readFile(stateFile, "utf8")) as Episodes;
    expect(after.status).toBe("succeeded");
    expect((after.supervisorEpisodes ?? []).slice(before.length).map((r) => r.proposal?.action.type)).toEqual(["reenter", "return"]);
    expect((after.supervisorEpisodes ?? []).map((r) => r.admission.outcome)).not.toContain("inadmissible");
    // The verdict is the rehearsal's, taken where it stopped on its own; the continuation keeps it.
    expect(finished.rehearsalVerdict).toMatchObject({ verdict: "ready", launchId: waiting.rehearsalVerdict!.launchId });
  });
});

describe("rehearsal settings on the CLI", () => {
  it("makes rehearsal-only flags a rehearsal's, refusing them on a real submission", async () => {
    expect(submitRehearsal({})).toBeUndefined();
    expect(submitRehearsal({ rehearsal: true })).toEqual({});
    expect(submitRehearsal({ rehearsal: true, scenario: "operator", commands: "run", offline: true })).toEqual({ scenario: "operator", commands: "run", offline: true });
    expect(() => submitRehearsal({ scenario: "operator" })).toThrow(/--scenario is a rehearsal setting: add --rehearsal/);
    expect(() => submitRehearsal({ commands: "run", offline: true })).toThrow(/--commands, --offline are rehearsal settings/);
    expect(() => submitRehearsal({ rehearsal: true, commands: "all" })).toThrow(/--commands must be stub or run/);
    expect(submitRehearsal({ rehearsal: true, scenario: "design-clean", "stop-at": "Round 1" })).toEqual({ scenario: "design-clean", stopAt: "Round 1" });
    expect(() => submitRehearsal({ "stop-at": "round1" })).toThrow(/--stop-at is a rehearsal setting: add --rehearsal/);
    expect(() => submitRehearsal({ rehearsal: true, "stop-at": "../x" })).toThrow(/--stop-at must name a stage/);
    // hub submit refuses before it asks any hub; the socket here answers nothing.
    await expect(hubCommand(["submit", "task.yaml", "--offline", "--socket", path.join(os.tmpdir(), "gl-no-hub.sock")])).rejects.toThrow(/--offline is a rehearsal setting/);
    await expect(hubCommand(["resume", "s-x", "--rehearsal", "--socket", path.join(os.tmpdir(), "gl-no-hub.sock")])).rejects.toThrow(/--rehearsal is not valid for hub resume/);
  });
});

describe("stand-in variables in managed launches", () => {
  /** A hub with one submission and a bootstrap that runs the real managedMain, recording the run command and its environment. */
  async function launchEnvironment(rehearsal: boolean): Promise<{ argv: string[]; env: Record<string, string | undefined> }> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "gl-hub-rh-env-")); folders.push(directory);
    const repo = path.join(directory, "repo"); await mkdir(repo);
    await execFileAsync("git", ["init", "-q"], { cwd: repo });
    await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
    const { stdout: head } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repo });
    const driver: HubDriver = {
      async probe() {}, async prepare() { return { bootId: "fixture", pid: 1234, startTime: "1" }; }, async grant() {},
      async inspect() { return { execution: "live", ownerGone: false, externalStopped: false }; }, async stop() {}, async kill() {},
    };
    const hubDirectory = path.join(directory, "hub");
    const hub = await openHub({ directory: hubDirectory, driver, autoPoll: false, config: { maxConcurrentRuns: 1, shutdownGraceMs: 0 } }); hubs.push(hub);
    const runtime = selfInstall().record;
    const bundle = path.join(repoRoot, "examples/plugins/hello");
    const task = "graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\n";
    const result = await hub.submit({ requestDigest: "d".repeat(64), input: {
      task, taskDigest: createHash("sha256").update(task).digest("hex"), taskPath: path.join(directory, "task.yaml"), repoPath: repo, baseCommit: head.trim(),
      bundlePath: bundle, bundleDigest: await digestExecutorSource(bundle),
      runtimePath: path.join(runtime.root, "apps/graphloom/dist/main.js"), runtimeRoot: runtime.root, runtimeVersion: runtime.version, runtimeDigest: await runtimeDigest(runtime.root), runtimeNode: process.execPath,
      ...(rehearsal ? { rehearsal: { scenario: "happy" } } : {}),
    } });
    if ("archived" in result) throw new Error("unexpected archived submission");
    await hub.tick();
    const submission = hub.inspect(result.id);
    const marker = path.join(directory, "launch.json");
    const script = path.join(directory, "bootstrap.mjs");
    await writeFile(script, `import { writeFile } from 'node:fs/promises';\nimport { managedMain } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, "apps/graphloom/dist/hub-managed.js")).href)};\nprocess.stdout.write('ready\\n');\ntry { await managedMain(${JSON.stringify([hubDirectory, submission.id])}, async (argv) => {\nawait writeFile(${JSON.stringify(marker)}, JSON.stringify({ argv, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GRAPHLOOM_REHEARSAL_'))) }));\n}); } catch (error) { process.stderr.write(error.message + '\\n'); process.exitCode = 1; }`);
    // The hub's environment carries planted stand-in variables: the launch must not keep them.
    const env = childEnvironment(directory, { [REHEARSAL_SCENARIO_ENV]: "/planted/scenario.json", [REHEARSAL_HOME_ENV]: "/planted/home", [REHEARSAL_SYNTHESIZED_ENV]: "1" });
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe", "pipe"], env }); children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    const control = child.stdio[3] as Duplex; control.on("error", () => undefined); control.resume();
    const grant: HubGrantMessage = { protocolVersion: 1, type: "grant", hubId: submission.hubId, submissionId: submission.id, runId: submission.runId, launchId: submission.launch!.id, generation: submission.generation, automatic: false };
    control.write(`${JSON.stringify(grant)}\n`);
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    expect(code, stderr).toBe(0);
    return JSON.parse(await readFile(marker, "utf8")) as { argv: string[]; env: Record<string, string | undefined> };
  }

  it("never lets a real launch keep a stand-in variable, and runs only a rehearsal submission as a rehearsal", { timeout: 60_000 }, async () => {
    const real = await launchEnvironment(false);
    expect(real.argv[0]).toBe("run");
    expect(real.env).toEqual({});
    const rehearsal = await launchEnvironment(true);
    // A rehearsal launch sets its own stand-in variables when its run starts (rehearsal.ts), never the hub's planted ones.
    expect(rehearsal.argv).toEqual(["rehearse", expect.stringMatching(/launch-task\.yaml$/), "--state-root", expect.stringMatching(/\/runs$/), "--scenario", "happy"]);
    expect(rehearsal.env).toEqual({});
  });
});
