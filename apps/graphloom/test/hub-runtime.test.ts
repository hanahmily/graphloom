// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestExecutorSource } from "@graphloom/runner";
import type { HubSubmission } from "@graphloom/sdk";
import { runtimeDigest } from "../src/hub-input.js";
import { createExecutionObservationReader, verifyHubExecutionInput } from "../src/hub-runtime.js";
import { selfInstall } from "../src/ownership.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

async function environment() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gl-hub-runtime-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = async (version: string, home = directory) => {
    const root = path.join(home, "versions", version);
    for (const part of ["packages", "executors", "apps/graphloom/dist", "bin"]) await mkdir(path.join(root, part), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version, type: "module" }));
    await writeFile(path.join(root, "package-lock.json"), "{}");
    await writeFile(path.join(root, "release.json"), JSON.stringify({ product: "graphloom", version }));
    await writeFile(path.join(root, "apps/graphloom/dist/main.js"), "// immutable runtime\n");
    await writeFile(path.join(root, "bin/graphloom"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return selfInstall(root);
  };
  const original = await runtime("1.0.0"); const next = await runtime("2.0.0");
  const hub = path.join(directory, "hub"); const taskFile = path.join(hub, "submissions", "s-test", "task.yaml");
  const stateDir = path.join(hub, "runs", "run-test"); const bundle = path.join(directory, "plugin");
  await mkdir(path.dirname(taskFile), { recursive: true }); await mkdir(stateDir, { recursive: true }); await mkdir(bundle);
  const task = "graph: hello\nrepo: ./repo\nrequest: Test upgrade.\n";
  await writeFile(taskFile, task); await writeFile(path.join(bundle, "index.js"), "export default {};\n");
  const runnerConfig = path.join(directory, "runner.json"); await writeFile(runnerConfig, "{}");
  const submission: HubSubmission = {
    id: "s-test", runId: "run-test", hubId: "hub-test", acceptedAt: "2026-11-20T12:00:00Z", updatedAt: "2026-11-20T12:00:00Z",
    requestDigest: "request", contentDigest: "content", desiredAction: "execute", state: "paused", queueSequence: 1,
    generation: 1, automaticResumes: 0, failureRepeats: 0, progressRevision: 0, journalBytes: 0,
    retry: { automatic: true, maxAutomaticResumes: 2, maxElapsedMs: 60000, baseDelayMs: 1000, maxDelayMs: 10000 },
    input: { taskFile, taskDigest: digest(task), taskPath: "/original/task.yaml", repoPath: "/repo", baseCommit: "a".repeat(40), bundlePath: bundle,
      bundleDigest: await digestExecutorSource(bundle), runtimeRoot: original.record.root, runtimeVersion: original.record.version,
      runtimeNode: process.execPath, runtimePath: path.join(original.record.root, "apps/graphloom/dist/main.js"), runtimeDigest: await runtimeDigest(original.record.root),
      runtimeConfig: { runner: { path: runnerConfig, digest: digest("{}") } } },
  };
  const owner = async (install = original.record, runId = submission.runId) => writeFile(path.join(stateDir, "state.json"), JSON.stringify({ runId, install }));
  await owner();
  return { directory, original, next, runtime, submission, runnerConfig, owner };
}

describe("managed runtime selection across upgrades", () => {
  it("requires original immutable runtime bytes for initial and ordinary original-owner resumes", async () => {
    const f = await environment();
    const selected = await verifyHubExecutionInput(f.submission, { initial: false }, f.next);
    expect(selected.root).toBe(f.original.record.root);
    await writeFile(f.submission.input.runtimePath, "// changed original runtime\n");
    await expect(verifyHubExecutionInput(f.submission, { initial: false }, f.next)).rejects.toThrow("pinned runtime changed");
    await expect(verifyHubExecutionInput(f.submission, { initial: true }, f.next)).rejects.toThrow("pinned runtime changed");
  });

  it("allows an explicit upgrade with the original installation removed but keeps task/config pins", async () => {
    const f = await environment(); await rm(f.original.record.root, { recursive: true });
    const options = { initial: false, upgrade: true, requireCurrent: true };
    expect(await verifyHubExecutionInput(f.submission, options, f.next)).toMatchObject({ root: f.next.record.root, version: "2.0.0" });
    await writeFile(f.runnerConfig, '{"changed":true}');
    await expect(verifyHubExecutionInput(f.submission, options, f.next)).rejects.toThrow("runtime configuration changed");
    await writeFile(f.runnerConfig, "{}"); await writeFile(f.submission.input.taskFile, "changed task");
    await expect(verifyHubExecutionInput(f.submission, options, f.next)).rejects.toThrow("captured task does not match");
  });

  it("dispatches later resumes to the recorded upgraded owner even when the original was pruned", async () => {
    const f = await environment(); const daemon = await f.runtime("3.0.0");
    await f.owner(f.next.record); await rm(f.original.record.root, { recursive: true });
    expect(await verifyHubExecutionInput(f.submission, { initial: false }, daemon)).toMatchObject({
      executable: path.join(f.next.record.root, "bin/graphloom"), args: [], root: f.next.record.root, version: "2.0.0",
    });
    await expect(verifyHubExecutionInput(f.submission, { initial: false, requireCurrent: true }, daemon)).rejects.toThrow("not the selected owning runtime");
    await expect(verifyHubExecutionInput(f.submission, { initial: false, requireCurrent: true }, f.next)).resolves.toMatchObject({ root: f.next.record.root });
  });

  it("rejects a replaced owner version and a same-version alternative installation without upgrade", async () => {
    const f = await environment(); await f.owner(f.next.record);
    await writeFile(path.join(f.next.record.root, "release.json"), JSON.stringify({ product: "graphloom", version: "9.0.0" }));
    await expect(verifyHubExecutionInput(f.submission, { initial: false }, f.original)).rejects.toThrow("owning runtime identity changed");
    await rm(f.next.record.root, { recursive: true });
    const replacement = await f.runtime("2.0.0", path.join(f.directory, "replacement"));
    await expect(verifyHubExecutionInput(f.submission, { initial: false }, replacement)).rejects.toThrow();
    await expect(verifyHubExecutionInput(f.submission, { initial: false, upgrade: true }, replacement)).resolves.toMatchObject({ root: replacement.record.root });
  });

  it("rejects swapped run identities and incompatible captured executable locations", async () => {
    const f = await environment(); await f.owner(f.original.record, "another-run");
    await expect(verifyHubExecutionInput(f.submission, { initial: false, upgrade: true }, f.next)).rejects.toThrow("run identity");
    await f.owner(); f.submission.input.runtimePath = path.join(f.original.record.root, "other.js");
    await expect(verifyHubExecutionInput(f.submission, { initial: true }, f.original)).rejects.toThrow("executable does not match");
  });
});


describe("execution observation polling", () => {
  it("reads each unchanged state once, refreshes changes, and never caches failures", async () => {
    const f = await environment();
    const observation = { protocolVersion: 1 as const, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 0, status: "running", continuation: { kind: "complete" as const } };
    const read = vi.fn(async () => observation);
    const observe = createExecutionObservationReader(read);
    for (let i = 0; i < 20; i++) expect(await observe(f.submission)).toEqual(observation);
    expect(read).toHaveBeenCalledTimes(1);
    await f.owner(f.next.record);
    read.mockRejectedValueOnce(new Error("temporarily unreadable"));
    await expect(observe(f.submission)).rejects.toThrow("temporarily unreadable");
    expect(await observe(f.submission)).toEqual(observation);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not cache a state changed while the owning runtime was observing it", async () => {
    const f = await environment();
    const read = vi.fn(async () => {
      await f.owner(f.next.record);
      return { protocolVersion: 1 as const, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 0, status: "running", continuation: { kind: "complete" as const } };
    });
    const observe = createExecutionObservationReader(read);
    await observe(f.submission); await observe(f.submission);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
