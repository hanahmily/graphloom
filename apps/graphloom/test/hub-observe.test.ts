// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadRunState, type DurableRunState } from "@graphloom/controller";
import type { HubStatus, HubSubmission } from "@graphloom/sdk";
import { observeOwnedRun, snapshotOf, withHubSnapshot } from "../src/hub-observe.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/stats/395ec998-6e4");
const observedAt = "2026-11-20T12:00:00.000Z";
const hubAt = "2026-11-20T12:00:05.000Z";
async function state(): Promise<DurableRunState> { return loadRunState(fixture); }
function submission(): HubSubmission {
  return {
    id: "submission-1", runId: "run-1", hubId: "hub-1", acceptedAt: observedAt, updatedAt: hubAt,
    requestDigest: "request", contentDigest: "content", desiredAction: "execute", state: "queued", queueSequence: 1,
    generation: 0, automaticResumes: 0, failureRepeats: 0, progressRevision: 0, journalBytes: 0,
    retry: { automatic: true, maxAutomaticResumes: 2, maxElapsedMs: 60000, baseDelayMs: 1000, maxDelayMs: 10000 },
    input: { taskPath: "/task.yaml", taskFile: "/hub/task.yaml", repoPath: "/repo", baseCommit: "base", bundlePath: "/bundle", bundleDigest: "bundle", runtimePath: "/runtime", runtimeDigest: "runtime" },
  };
}
function hub(item: HubSubmission): HubStatus { return { hubId: "hub-1", maxConcurrentRuns: 3, occupiedSlots: 2, submissions: [item] }; }

describe("owning-runtime monitoring projection", () => {
  it("keeps a terminal execution observation when newer topology presentation cannot be projected", async () => {
    const run = await state(); run.status = "succeeded";
    Object.assign(run.definition, { edges: [{ from: "fix", to: null }] });
    const directory = await mkdtemp(path.join(os.tmpdir(), "gl-observation-"));
    try {
      await writeFile(path.join(directory, "state.json"), JSON.stringify(run));
      const result = await observeOwnedRun(directory);
      expect(result.observation).toMatchObject({ protocolVersion: 1, status: "succeeded", continuation: { kind: "complete" } });
      expect(result.snapshot).toBeUndefined(); expect(result.monitoringError).toMatch(/topology/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("keeps authoritative completion below the child transport cap for a large settled job history", async () => {
    const run = await state(); run.status = "succeeded";
    const session = run.agentSessions![0]!;
    run.agentSessions = Array.from({ length: 16_000 }, (_, i) => ({ ...session, operationId: `operation-${i}`, summary: "x".repeat(200) }));
    const directory = await mkdtemp(path.join(os.tmpdir(), "gl-observation-"));
    try {
      await writeFile(path.join(directory, "state.json"), JSON.stringify(run));
      const result = await observeOwnedRun(directory);
      expect(result.observation).toMatchObject({ status: "succeeded", continuation: { kind: "complete" } });
      expect(result.snapshot).toBeUndefined(); expect(result.monitoringError).toContain("transport budget");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("separates accepted receipts from running work and preserves recorded operation attempts", async () => {
    const run = await state();
    run.status = "running";
    run.current = { stageId: "review", attempt: 9 };
    const before = structuredClone(run);
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.stages?.find(stage => stage.id === "review")).toMatchObject({ status: "running", accepted: true, attempt: 9 });
    expect(snapshot.jobs).toHaveLength(run.agentSessions!.length);
    for (const session of run.agentSessions!) expect(snapshot.jobs?.find(job => job.id === session.operationId)).toMatchObject({ stageId: session.stageId, attempt: session.attempt, status: session.status });
    expect(snapshot.jobs?.some(job => job.attempt === 9)).toBe(false);
    expect(run).toEqual(before);
    run.receipts = run.receipts.map(receipt => ({ ...receipt, valid: receipt.stageId !== "review" && receipt.valid }));
    expect(snapshotOf(run, observedAt).stages?.find(stage => stage.id === "review")).toMatchObject({ status: "running", accepted: false });
  });

  it("labels supervisor settlement counters without inventing all-job totals, rates or context", async () => {
    const run = await state();
    run.supervisorEpisodes = [{
      episodeId: "ep-recorded", turn: 1, runId: run.runId, at: "2026-11-20T11:59:00.000Z",
      input: { trigger: { code: "stalled", message: "retry requested" }, view: { runId: run.runId, task: { request: "fixture" }, current: run.current, receipts: [], evidence: [], outstanding: [], budgets: run.budgets, validatorBindings: [], generation: run.generation, stateRevision: run.stateRevision, activeVersion: run.activeVersion } },
      toolCalls: [], admission: { rejections: [], outcome: "admitted" }, providerCalls: 1, harness: "codex",
      usage: { inputTokens: 40, outputTokens: 20, costUsd: 0.000001 },
    }];
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.usage?.metrics.find(metric => metric.id === "tokens")).toMatchObject({ value: null, label: "All-job token usage" });
    expect(snapshot.usage?.metrics.find(metric => metric.id === "supervisor:codex:outputTokens")).toMatchObject({ value: 20, unit: "tokens", exactness: "settled", source: "settled supervisor episode records" });
    expect(snapshot.usage?.metrics.find(metric => metric.id === "supervisor:codex:costUsd")).toMatchObject({ value: 0.000001, unit: "USD", exactness: "settled" });
    expect(snapshot.usage?.series).toBeUndefined();
    expect(snapshot.usage?.context).toBeUndefined();
    expect(snapshot.sources).toContainEqual(expect.objectContaining({ id: "live-output", status: "unavailable", observedAt: null }));
  });

  it("keeps old topology traversal unknown and unavailable legacy session references absent", async () => {
    const run = await state();
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology).toMatchObject({ source: "legacy" });
    expect(snapshot.topology?.path).toBeUndefined();
    expect(snapshot.topology?.sideVisit).toBeUndefined();
    expect(snapshot.stages?.every(stage => stage.path === "unknown")).toBe(true);
    expect(snapshot.jobs?.every(job => job.sessions?.every(ref => typeof ref === "string" && ref.length > 0) ?? true)).toBe(true);
  });

  it("projects newer structural path/visits without confusing supporting current work with the tail", async () => {
    const run = await state();
    Object.assign(run.definition, { edges: [{ from: "fix", to: "review" }, { from: "review", to: "fix" }], start: "fix", terminal: ["review"] });
    Object.assign(run, {
      current: { stageId: "fix", attempt: 4 },
      visits: [{ seq: 1, stageId: "fix", attempt: 3 }, { seq: 2, stageId: "review", attempt: 3 }, { seq: 3, stageId: "fix", attempt: 4 }, { seq: 4, stageId: "review", attempt: 4 }],
      path: [3, 4],
    });
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology).toMatchObject({ source: "declared", current: "fix", path: [{ stageId: "fix", visit: 3, attempt: 4 }, { stageId: "review", visit: 4, attempt: 4 }], sideVisit: null });
    expect(snapshot.stages?.find(stage => stage.id === "fix")).toMatchObject({ visits: 2, path: "on-path" });
    Object.assign(run, { path: [3], sideVisit: 4 });
    const side = snapshotOf(run, observedAt);
    expect(side.topology?.path).toEqual([{ stageId: "fix", visit: 3, attempt: 4 }]);
    expect(side.topology?.sideVisit).toMatchObject({ stageId: "review", visit: 4 });
    expect(side.stages?.find(stage => stage.id === "review")?.path).toBe("off-path");
  });

  it("leaves malformed newer traversal unknown instead of filtering away missing visits", async () => {
    const run = await state();
    Object.assign(run, { path: [1, 99], visits: [{ seq: 1, stageId: "fix", attempt: 1 }] });
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology?.path).toBeUndefined();
    expect(snapshot.stages?.every(stage => stage.path === "unknown")).toBe(true);
  });
});

describe("hub/frame composition", () => {
  it("retains each source timestamp and marks cached controller values stale on an observation failure", async () => {
    const run = await state(); const owned = snapshotOf(run, observedAt); const item = submission(); item.runId = run.runId;
    const merged = withHubSnapshot(owned, item, hub(item), hubAt, "owning runtime unavailable");
    expect(merged.observedAt).toBe(hubAt);
    expect(merged.sources.find(source => source.id === "controller")).toMatchObject({ status: "stale", observedAt, detail: "owning runtime unavailable", revision: String(run.stateRevision) });
    expect(merged.sources.find(source => source.id === "live-output")).toMatchObject({ status: "unavailable", observedAt: null });
    expect(merged.sources.find(source => source.id === "hub")).toMatchObject({ status: "available", observedAt: hubAt });
    expect(merged.hub).toMatchObject({ occupied: 2, limit: 3, queued: 1, state: "queued" });
    expect(owned.sources.find(source => source.id === "controller")?.status).toBe("available");
  });

  it("does not fabricate graph execution or usage for a never-launched queued submission", () => {
    const item = submission();
    const snapshot = withHubSnapshot(undefined, item, hub(item), hubAt);
    expect(snapshot.run).toMatchObject({ id: "run-1", status: "not-created", submissionId: "submission-1" });
    expect(snapshot.sources.find(source => source.id === "controller")).toMatchObject({ status: "unavailable", observedAt: null });
    expect(snapshot.jobs).toBeUndefined();
    expect(snapshot.topology).toBeUndefined();
    expect(snapshot.usage).toBeUndefined();
  });

  it("calls a previously-launched run unknown when observations are missing", () => {
    const item = submission(); item.generation = 1; item.state = "running";
    expect(withHubSnapshot(undefined, item, hub(item), hubAt, "observation unavailable").run.status).toBe("unknown");
  });
});
