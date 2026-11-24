// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { livePath, loadRunState, nodeAccepted, type DurableRunState, type VisitRecord } from "@graphloom/controller";
import type { HubStatus, HubSubmission } from "@graphloom/sdk";
import { projectPanels, renderPanels } from "@graphloom/monitor";
import { observeOwnedRun, snapshotOf, withHubSnapshot } from "../src/hub-observe.js";
import { runStats } from "../src/stats.js";

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
function visit(seq: number, stageId: string, attempt: number, entered: VisitRecord["entered"] = "edge"): VisitRecord {
  return { seq, stageId, attempt, entered, generation: 0, operation: "test-fixture" };
}

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

  it("omits panel projection for execution polling even when presentation is invalid", async () => {
    const run = await state(); run.status = "succeeded";
    Object.assign(run.definition, { edges: [{ from: "fix", to: null }] });
    const directory = await mkdtemp(path.join(os.tmpdir(), "gl-execution-observation-"));
    try {
      await writeFile(path.join(directory, "state.json"), JSON.stringify(run));
      const result = await observeOwnedRun(directory, true);
      expect(result.observation.continuation).toEqual({ kind: "complete" });
      expect(Object.keys(result)).toEqual(["observation"]);
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
    // Every job the run recorded, as stats counts them (the usage panel's jobs), command jobs included.
    const counted = runStats(run).stages.reduce((sum, stage) => sum + stage.jobs.total, 0);
    expect(snapshot.jobs).toHaveLength(counted);
    expect(snapshot.jobs!.filter(job => job.label?.startsWith("command"))).toHaveLength(runStats(run).stages.reduce((sum, stage) => sum + stage.jobs.command, 0));
    expect(snapshot.jobs!.filter(job => job.label?.startsWith("command")).length).toBeGreaterThan(0);
    expect(snapshot.jobs!.find(job => job.label?.startsWith("command"))).toMatchObject({ status: "settled", evidence: [expect.any(String)] });
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

  it("labels the owning controller's derived legacy path without inventing recorded visit history", async () => {
    const run = await state();
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology).toMatchObject({ source: "implicit" });
    expect(snapshot.topology?.edges.map(edge => [edge.from, edge.to])).toEqual([["fix", "review"], ["review", "fix"]]);
    expect(snapshot.topology?.path).toEqual(livePath(run).map(({ stageId, attempt }) => ({ stageId, attempt })));
    expect(snapshot.topology?.sideVisit).toBeUndefined();
    expect(snapshot.stages?.every(stage => stage.visits === undefined)).toBe(true);
    expect(snapshot.sources.find(source => source.id === "traversal")).toMatchObject({ status: "available", detail: expect.stringContaining("derived by the owning controller") });
    expect(snapshot.jobs?.every(job => job.sessions?.every(ref => typeof ref === "string" && ref.length > 0) ?? true)).toBe(true);
  });

  it("projects recorded path/visits without confusing supporting current work with the tail", async () => {
    const run = await state();
    run.definition = { ...run.definition, edges: [{ from: "fix", to: "review" }, { from: "review", to: "fix" }], start: "fix", terminal: ["review"] };
    run.current = { stageId: "fix", attempt: 4 };
    run.visits = [{ ...visit(1, "fix", 3, "start"), ended: "replaced by reentry of fix" }, { ...visit(2, "review", 3), ended: "replaced by reentry of fix" }, visit(3, "fix", 4, "reenter"), visit(4, "review", 4)];
    run.path = [3, 4];
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology).toMatchObject({ source: "declared", current: "fix", path: [{ stageId: "fix", visit: 3, attempt: 4 }, { stageId: "review", visit: 4, attempt: 4 }], sideVisit: null });
    expect(snapshot.stages?.find(stage => stage.id === "fix")).toMatchObject({ visits: 2, path: "on-path" });
    expect(snapshot.stages?.find(stage => stage.id === "review")).toMatchObject({ accepted: true, path: "on-path" });
  });

  it("matches path acceptance after reentry and keeps supervisor side visits separate from graph branches", async () => {
    const run = await state();
    const requirement = run.definition.requirements[0]!;
    run.definition = { ...run.definition,
      stages: [...run.definition.stages, { id: "branch", name: "Unused branch", requirementIds: ["branch-check"] }, { id: "repair", name: "Repair", entry: "supervisor", maxVisits: 3, requirementIds: ["repair-check"] }],
      requirements: [...run.definition.requirements, { ...requirement, id: "branch-check" }, { ...requirement, id: "repair-check" }],
      edges: [{ from: "fix", to: "review" }, { from: "fix", to: "branch" }, { from: "branch", to: "review" }, { from: "review", to: "fix" }, { from: "repair", to: "fix" }],
      start: "fix", terminal: ["review"],
    };
    const receipt = run.receipts.find(item => item.valid)!;
    run.receipts.push({ ...receipt, id: "branch-receipt", stageId: "branch", requirementId: "branch-check" }, { ...receipt, id: "repair-receipt", stageId: "repair", requirementId: "repair-check" });
    run.status = "running";
    run.current = { stageId: "repair", attempt: 1 };
    run.visits = [{ ...visit(1, "fix", 1, "start"), ended: "replaced by reentry of fix" }, { ...visit(2, "review", 1), ended: "replaced by reentry of fix" }, visit(3, "fix", 2, "reenter"), { ...visit(4, "repair", 1, "enter"), from: 3 }];
    run.path = [3]; run.sideVisit = 4; run.openAttempt = { fix: true };
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology).toMatchObject({ source: "declared", path: [{ stageId: "fix", visit: 3, attempt: 2 }], sideVisit: { stageId: "repair", visit: 4 }, current: "repair" });
    expect(snapshot.topology?.edges.map(edge => ({ from: edge.from, to: edge.to }))).toEqual(run.definition.edges);
    expect(snapshot.topology?.edges.some(edge => edge.to === "repair")).toBe(false);
    expect(snapshot.stages?.find(stage => stage.id === "fix")).toMatchObject({ accepted: false, status: "unaccepted", path: "on-path", visits: 2 });
    expect(nodeAccepted(run, "branch")).toBe(true);
    expect(snapshot.stages?.find(stage => stage.id === "branch")).toMatchObject({ accepted: false, status: "off-path", path: "off-path", visits: 0 });
    expect(snapshot.stages?.find(stage => stage.id === "review")).toMatchObject({ accepted: false, status: "off-path", path: "off-path" });
    expect(snapshot.stages?.find(stage => stage.id === "repair")).toMatchObject({ accepted: false, status: "running", path: "off-path", entry: "supervisor", visits: 1, maxVisits: 3 });
    run.openAttempt = {};
    expect(snapshotOf(run, observedAt).stages?.find(stage => stage.id === "fix")?.accepted).toBe(true);
  });

  it("leaves malformed newer traversal unknown instead of filtering away missing visits", async () => {
    const run = await state();
    run.path = [1, 99]; run.visits = [visit(1, "fix", 1, "start")];
    const snapshot = snapshotOf(run, observedAt);
    expect(snapshot.topology?.path).toBeUndefined();
    expect(snapshot.stages?.every(stage => stage.path === "unknown" && stage.accepted === null)).toBe(true);
    expect(snapshot.sources.find(source => source.id === "traversal")?.status).toBe("unavailable");
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

  const launch = (mode: "initial" | "resume") => ({ id: "l-1", generation: 1, mode, phase: "granted" as const, reservedAt: hubAt, automatic: false });

  it("says a just-launched run is starting, not unknown, before its first state save", async () => {
    const item = submission(); item.generation = 1; item.state = "running"; item.launch = launch("initial");
    const enoent = "Command failed: node main.js __hub-observe /hub/runs/run-1\nError: ENOENT: no such file or directory, open '/hub/runs/run-1/state.json'\n    at async open (node:internal/fs/promises:639:25)";
    const snapshot = withHubSnapshot(undefined, item, hub(item), hubAt, enoent);
    expect(snapshot.run.status).toBe("starting");
    expect(snapshot.sources.find(source => source.id === "controller")).toMatchObject({ status: "unavailable", detail: "starting: run state not written yet" });
    const report = await renderPanels(projectPanels(snapshot, { kinds: ["overview"] }), { format: "text", width: 120, noColor: true });
    expect(report.output).toContain("Status: starting");
    expect(report.output).toContain("starting: run state not written yet");
    expect(report.output).not.toContain("ENOENT");
    // For another failure during a launch, the honest answer stays unknown.
    expect(withHubSnapshot(undefined, item, hub(item), hubAt, "owning runtime timed out").run.status).toBe("unknown");
    // With no launch active nothing runs: the hub's state is the status, and the graph is the captured task's.
    item.state = "blocked"; delete item.launch;
    expect(withHubSnapshot(undefined, item, hub(item), hubAt, enoent, { graph: "hello" }).run).toMatchObject({ status: "blocked", graph: "hello" });
  });

  it("never says running with nothing running: a killed controller's record yields to the hub's state", async () => {
    const run = await state(); run.status = "running"; delete run.blocker; delete run.stopReason;
    const owned = snapshotOf(run, observedAt);
    const item = submission(); item.runId = run.runId; item.generation = 2;
    for (const hubState of ["waiting", "paused", "blocked", "queued"] as const) {
      item.state = hubState;
      if (hubState === "blocked") item.blocker = "automatic retry stopped: the same failure repeated 3 times without accepted progress; last cause: controller-crash";
      else delete item.blocker;
      const merged = withHubSnapshot(owned, item, hub(item), hubAt);
      expect(merged.run.status).toBe(hubState);
      expect(merged.run.blocker).toBe(item.blocker ?? null);
      const report = await renderPanels(projectPanels(merged, { kinds: ["overview"] }), { format: "text", width: 160, noColor: true });
      expect(report.output).toContain(`Status: ${hubState}`);
      expect(report.output).not.toContain("Status: running");
    }
  });

  it("prefers the hub's state while a launch is active over the controller's record from before it", async () => {
    const run = await state(); run.status = "stopped"; run.blocker = "the earlier stop";
    const owned = snapshotOf(run, observedAt);
    const item = submission(); item.runId = run.runId; item.generation = 2; item.state = "running"; item.launch = launch("resume");
    const merged = withHubSnapshot(owned, item, hub(item), hubAt);
    expect(merged.run).toMatchObject({ status: "running", blocker: null });
    expect(merged.sources.find(source => source.id === "controller")?.detail).toContain("last recorded stopped; the hub's launch is running");
    // Once the launch is over, the hub's state is the status, and the run's blocker is shown again.
    item.state = "blocked"; delete item.launch;
    const idle = withHubSnapshot(owned, item, hub(item), hubAt);
    expect(idle.run).toMatchObject({ status: "blocked", blocker: "the earlier stop" });
    expect(idle.sources.find(source => source.id === "controller")?.detail).toContain("last recorded stopped; no launch is active; the hub's submission is blocked");
    // A running controller needs no reconciliation.
    run.status = "running"; item.state = "running"; item.launch = launch("resume");
    expect(withHubSnapshot(snapshotOf(run, observedAt), item, hub(item), hubAt).sources.find(source => source.id === "controller")?.detail ?? "").not.toContain("last recorded");
  });
});
