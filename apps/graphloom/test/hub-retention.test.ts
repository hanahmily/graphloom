// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubSubmission } from "@graphloom/sdk";
import { HubInstallationRetention, hubRetentionFile, inputReferences, registerHubRetention, retainHubInstallations } from "../src/hub-retention.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gl-hub-retention-"));
  roots.push(root);
  return root;
}
async function input(home: string, version: string): Promise<string> {
  const directory = path.join(home, "versions", version, "bundle");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "entry.js");
  await writeFile(file, "export {};");
  return file;
}
function submission(reference: string, state: HubSubmission["state"] = "queued"): HubSubmission {
  return { id: "submission", runId: "run", hubId: "hub", acceptedAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    requestDigest: "request", contentDigest: "content", input: { taskFile: "/unused/task.yaml", taskPath: "/unused/task.yaml", repoPath: "/unused/repo",
      baseCommit: "base", bundlePath: reference, bundleDigest: "bundle", runtimePath: reference, runtimeDigest: "runtime" },
    desiredAction: "execute", state, queueSequence: 1, generation: 0, automaticResumes: 0, retry: { automatic: false, maxAutomaticResumes: 1, maxElapsedMs: 1000, baseDelayMs: 1, maxDelayMs: 10 },
    failureRepeats: 0, progressRevision: 0, journalBytes: 0 };
}
async function owner(hub: string, run: HubSubmission, runtime: string, bundle = runtime, executor = runtime): Promise<string> {
  const directory = path.join(hub, "runs", run.runId);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "state.json");
  await writeFile(file, JSON.stringify({ runId: run.runId, install: { root: runtime }, intake: { bundle: { bundlePath: bundle } }, executorCatalog: [{ source: executor }] }));
  return file;
}
async function holdInstallLock(home: string): Promise<() => Promise<void>> {
  const child = spawn("flock", ["--exclusive", "--no-fork", path.join(home, "install.lock"), "sh", "-c", "printf 'locked\\n'; read -r release || :"], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited ${code}`)));
    child.stdout.once("data", () => resolve());
  });
  return async () => { child.stdin.end(); await closed; };
}
const absent = async (file: string) => expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });

describe("hub installation retention", () => {
  it("pins individual installed versions behind runtime and plugin symlinks without reading hub state", async () => {
    const root = await temporary();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const runtime = await input(first, "1.0.0");
    const bundle = await input(first, "1.1.0");
    const other = await input(second, "2.0.0-rc.1");
    const link = path.join(root, "linked-plugin");
    await symlink(bundle, link);
    const source = path.join(root, "source.ts");
    await writeFile(source, "source checkout");
    const hub = path.join(root, "absent-hub");
    expect(await retainHubInstallations(hub, [runtime, link, other, source])).toEqual([first, second]);
    for (const [home, version] of [[first, "1.0.0"], [first, "1.1.0"], [second, "2.0.0-rc.1"]] as const) {
      expect(JSON.parse(await readFile(hubRetentionFile(home, hub, version), "utf8"))).toEqual({ protocolVersion: 2, hubDirectory: hub, version });
    }
    expect(await retainHubInstallations(hub, [source])).toEqual([]);
    await access(hubRetentionFile(first, hub, "1.0.0"));
  });

  it("shares the installer lock and refuses acceptance when prune removed a captured input", async () => {
    const root = await temporary();
    const home = path.join(root, "install");
    const reference = await input(home, "1.0.0");
    const release = await holdInstallLock(home);
    const hub = path.join(root, "hub");
    let settled = false;
    const registration = registerHubRetention(home, hub, [reference]).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await absent(hubRetentionFile(home, hub, "1.0.0"));
      await rm(path.join(home, "versions", "1.0.0"), { recursive: true });
    } finally { await release(); }
    expect(await registration).toMatchObject({ code: "ENOENT" });
    await absent(hubRetentionFile(home, hub, "1.0.0"));
  });

  it("does not release another hub's version and cleans interrupted writes after reconciliation", async () => {
    const root = await temporary();
    const reference = await input(root, "1.0.0");
    const first = path.join(root, "first-hub");
    const second = path.join(root, "second-hub");
    await registerHubRetention(root, first, [reference]);
    await registerHubRetention(root, second, [reference]);
    const marker = hubRetentionFile(root, first, "1.0.0");
    await writeFile(`${marker}.interrupted.tmp`, "partial");
    await registerHubRetention(root, first, []);
    await absent(marker);
    await absent(`${marker}.interrupted.tmp`);
    await access(hubRetentionFile(root, second, "1.0.0"));
    const release = await holdInstallLock(root);
    await release();
  });

  it("releases an idle daemon's own installation on shutdown", async () => {
    const root = await temporary();
    const daemon = await input(root, "1.0.0");
    const hub = path.join(root, "hub");
    const retention = await HubInstallationRetention.open(hub, [daemon], () => []);
    await access(hubRetentionFile(root, hub, "1.0.0"));
    await retention.close();
    await absent(hubRetentionFile(root, hub, "1.0.0"));
  });

  it.each(["queued", "waiting", "paused", "blocked", "failed"] as const)("keeps %s submissions across daemon shutdown and releases them after archive", async (state) => {
    const root = await temporary();
    const daemon = await input(root, "1.0.0");
    const queued = await input(root, "1.1.0");
    const hub = path.join(root, "hub");
    const run = submission(queued, state);
    let submissions = [run];
    const retention = await HubInstallationRetention.open(hub, [daemon], () => submissions);
    await retention.protect(inputReferences(run), async () => undefined);
    await retention.close();
    await absent(hubRetentionFile(root, hub, "1.0.0"));
    await access(hubRetentionFile(root, hub, "1.1.0"));
    // A restart rediscovers homes even when the last submission has been archived.
    submissions = [];
    const restarted = await HubInstallationRetention.open(hub, [], () => submissions);
    await restarted.refresh();
    await absent(hubRetentionFile(root, hub, "1.1.0"));
  });

  it("keeps live and upgraded owner/plugin/executor versions, then releases only after terminal drainage", async () => {
    const root = await temporary();
    const paths = await Promise.all(["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((v) => input(root, v)));
    const hub = path.join(root, "hub");
    const run = submission(paths[0]!, "running");
    run.generation = 1;
    run.launch = { id: "launch", generation: 1, mode: "resume", phase: "granted", reservedAt: run.acceptedAt, automatic: false };
    await owner(hub, run, paths[1]!, paths[2]!, paths[3]!);
    const retention = await HubInstallationRetention.open(hub, [], () => [run]);
    await retention.refresh();
    run.state = "succeeded";
    await retention.close();
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) await access(hubRetentionFile(root, hub, version));
    delete run.launch;
    await retention.refresh();
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) await absent(hubRetentionFile(root, hub, version));
  });

  it("preserves only previously known pins when run state is missing or corrupt", async () => {
    const root = await temporary();
    const first = await input(root, "1.0.0");
    const next = await input(root, "1.1.0");
    await input(root, "1.2.0");
    const hub = path.join(root, "hub");
    const run = submission(first, "paused");
    run.generation = 1;
    const stateFile = await owner(hub, run, next);
    const retention = await HubInstallationRetention.open(hub, [], () => [run]);
    await retention.refresh();
    await writeFile(stateFile, "corrupt");
    await expect(retention.refresh()).rejects.toThrow();
    // State the controller saved once is missing after its execution marker: nothing is released.
    await writeFile(path.join(path.dirname(stateFile), "managed-execution-started.json"), "{}");
    await rm(stateFile);
    await expect(retention.close()).rejects.toThrow("run state is missing");
    await access(hubRetentionFile(root, hub, "1.0.0"));
    await access(hubRetentionFile(root, hub, "1.1.0"));
    await absent(hubRetentionFile(root, hub, "1.2.0"));
  });

  it("references only the captured input of a launch that failed before its first state save", async () => {
    const root = await temporary();
    const daemon = await input(root, "1.0.0");
    const captured = await input(root, "1.1.0");
    const released = await input(root, "1.2.0");
    const hub = path.join(root, "hub");
    const failed = submission(captured, "failed");
    failed.generation = 1;
    // A failed launch may leave its run directory behind, without state.json or the execution marker.
    await mkdir(path.join(hub, "runs", failed.runId), { recursive: true });
    const other = { ...submission(released, "succeeded"), id: "other", runId: "other" };
    const retention = await HubInstallationRetention.open(hub, [daemon], () => [failed, other]);
    await retention.protect(inputReferences(other), async () => undefined);
    await access(hubRetentionFile(root, hub, "1.2.0"));
    await retention.refresh();
    await absent(hubRetentionFile(root, hub, "1.2.0"));
    await access(hubRetentionFile(root, hub, "1.1.0"));
    await retention.close();
    await absent(hubRetentionFile(root, hub, "1.0.0"));
    await absent(hubRetentionFile(root, hub, "1.2.0"));
    await access(hubRetentionFile(root, hub, "1.1.0"));
  });

  it("refreshes upgraded ownership after state replacement and releases the obsolete owner", async () => {
    const root = await temporary();
    const original = await input(root, "1.0.0");
    const firstOwner = await input(root, "1.1.0");
    const nextOwner = await input(root, "1.2.0");
    const hub = path.join(root, "hub");
    const run = submission(original, "paused");
    run.generation = 1;
    await owner(hub, run, firstOwner);
    const retention = await HubInstallationRetention.open(hub, [], () => [run]);
    await retention.refresh();
    await retention.refresh();
    await access(hubRetentionFile(root, hub, "1.1.0"));
    await owner(hub, run, nextOwner);
    await retention.refresh();
    await absent(hubRetentionFile(root, hub, "1.1.0"));
    await access(hubRetentionFile(root, hub, "1.0.0"));
    await access(hubRetentionFile(root, hub, "1.2.0"));
  });

  it("never reconciles away a pin between capture and durable submission acceptance", async () => {
    const root = await temporary();
    const reference = await input(root, "1.0.0");
    const hub = path.join(root, "hub");
    const run = submission(reference);
    const submissions: HubSubmission[] = [];
    const retention = await HubInstallationRetention.open(hub, [], () => submissions);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const accepting = new Promise<void>((resolve) => { started = resolve; });
    const accepted = retention.protect(inputReferences(run), async () => { started(); await held; submissions.push(run); });
    await accepting;
    const refreshing = retention.refresh();
    await access(hubRetentionFile(root, hub, "1.0.0"));
    release();
    await Promise.all([accepted, refreshing]);
    await access(hubRetentionFile(root, hub, "1.0.0"));
    submissions.length = 0;
    await retention.close();
    await absent(hubRetentionFile(root, hub, "1.0.0"));
  });
});
