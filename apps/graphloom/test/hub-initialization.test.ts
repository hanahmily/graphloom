// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubLaunch, HubSubmission } from "@graphloom/sdk";
import { observeInitialization } from "../src/hub-initialization.js";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "graphloom-initialization-")); folders.push(directory);
  const launch: HubLaunch = { id: "l-00000000-0000-0000-0000-000000000001", generation: 1, phase: "granted", mode: "initial", reservedAt: new Date(0).toISOString(), automatic: false };
  const id = "s-00000000-0000-0000-0000-000000000002";
  const submission: HubSubmission = {
    id, hubId: "h-fixture", runId: "hub-fixture", acceptedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    requestDigest: "a".repeat(64), contentDigest: "b".repeat(64), desiredAction: "execute", state: "running", queueSequence: 1, generation: 1,
    automaticResumes: 0, retry: { automatic: true, maxAutomaticResumes: 3, maxElapsedMs: 1000, baseDelayMs: 1, maxDelayMs: 10 }, failureRepeats: 0, progressRevision: 0, journalBytes: 0, launch,
    input: { taskFile: path.join(directory, "submissions", id, "task.yaml"), taskPath: "/task.yaml", repoPath: path.join(directory, "repo"), baseCommit: "c".repeat(40), bundlePath: "/bundle", bundleDigest: "d".repeat(64), runtimePath: "/runtime/main.js", runtimeDigest: "e".repeat(64) },
  };
  const stateDir = path.join(directory, "runs", submission.runId);
  const binding = { protocolVersion: 1, initializationProtocol: 1, hubStateDir: directory, hubId: submission.hubId, submissionId: id, runId: submission.runId, generation: 1, launchId: launch.id, intakeDigest: "f".repeat(64) };
  const bind = async (value = binding) => { await mkdir(stateDir, { recursive: true }); await writeFile(path.join(stateDir, "managed-run.json"), JSON.stringify(value)); };
  return { directory, stateDir, submission, launch, binding, bind };
}

describe("incomplete managed initialization observations", () => {
  it("authorizes bounded initial replay only for a matching protocol-bound intake before execution", async () => {
    const f = await fixture(); await f.bind(); await mkdir(path.join(f.stateDir, "artifacts"));
    const result = await observeInitialization(f.stateDir, f.submission, f.launch);
    expect(result).toMatchObject({ status: "initialization-failed", stateRevision: 0, progressRevision: 0, continuation: { kind: "automatic", cause: "initialization-failed", stateRevision: 0 } });
    expect(result.continuation).toHaveProperty("fingerprint");
  });
  it("refuses missing state once execution may have started", async () => {
    const f = await fixture(); await f.bind(); await writeFile(path.join(f.stateDir, "managed-execution-started.json"), "{}");
    expect(await observeInitialization(f.stateDir, f.submission, f.launch)).toMatchObject({ continuation: { kind: "terminal", cause: "initialization-failed" }, blocker: expect.stringMatching(/execution/) });
  });
  it("refuses legacy and mismatched bindings or unexpected artifacts", async () => {
    for (const variant of ["legacy", "other-submission", "future-generation", "artifact"]) {
      const f = await fixture();
      const binding = { ...f.binding } as Record<string, unknown>;
      if (variant === "legacy") delete binding.initializationProtocol;
      if (variant === "other-submission") binding.submissionId = "someone-else";
      if (variant === "future-generation") binding.generation = 2;
      await mkdir(f.stateDir, { recursive: true }); await writeFile(path.join(f.stateDir, "managed-run.json"), JSON.stringify(binding));
      if (variant === "artifact") await writeFile(path.join(f.stateDir, "child-operations.json"), "{}");
      expect(await observeInitialization(f.stateDir, f.submission, f.launch), variant).toMatchObject({ continuation: { kind: "terminal", cause: "initialization-failed" } });
    }
  });
  it("permits a pre-intake empty directory but never adopts unrelated files or worktrees", async () => {
    const f = await fixture();
    expect(await observeInitialization(f.stateDir, f.submission, f.launch)).toMatchObject({ continuation: { kind: "automatic", cause: "initialization-failed" } });
    await mkdir(f.stateDir, { recursive: true }); await writeFile(path.join(f.stateDir, "unknown.json"), "{}");
    expect(await observeInitialization(f.stateDir, f.submission, f.launch)).toMatchObject({ continuation: { kind: "terminal" } });
    await rm(path.join(f.stateDir, "unknown.json"));
    await mkdir(path.join(f.submission.input.repoPath, "graphloom", f.submission.runId), { recursive: true });
    expect(await observeInitialization(f.stateDir, f.submission, f.launch)).toMatchObject({ continuation: { kind: "terminal" } });
  });
  it("treats the private repository's half-made sibling as the leftover of a crash the replay clears, for a task with no repo only", async () => {
    const withTask = async (text: string) => {
      const f = await fixture(); await f.bind();
      await mkdir(path.dirname(f.submission.input.taskFile), { recursive: true }); await writeFile(f.submission.input.taskFile, text);
      await mkdir(path.join(f.stateDir, "repository.creating", ".git"), { recursive: true });
      return f;
    };
    const none = await withTask("graph: tidy\nrequest: x\n");
    expect(await observeInitialization(none.stateDir, none.submission, none.launch)).toMatchObject({ continuation: { kind: "automatic", cause: "initialization-failed" } });
    // A task that names a repository never makes one in the state directory.
    const named = await withTask("graph: tidy\nrepo: ./repo\nrequest: x\n");
    expect(await observeInitialization(named.stateDir, named.submission, named.launch)).toMatchObject({ continuation: { kind: "terminal", cause: "initialization-failed" }, blocker: expect.stringContaining("repository.creating") });
    // Only that exact name, and only a directory.
    const other = await withTask("graph: tidy\nrequest: x\n");
    await writeFile(path.join(other.stateDir, "repository.creating.old"), "x");
    expect(await observeInitialization(other.stateDir, other.submission, other.launch)).toMatchObject({ continuation: { kind: "terminal" } });
  });
});
