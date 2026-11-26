// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { HubContinuation, HubLaunch, HubLaunchReport, HubObservation, HubSubmission } from "@graphloom/sdk";
import { assertHubGrant, openHub, submissionBlocker } from "./hub.js";
import type { Hub } from "./hub.js";
import type { HubDriver, HubExecutionObservation, HubSubmitRequest } from "./types.js";
import type { HubLaunchMemory } from "./memory.js";

const folders: string[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close({ graceMs: 0 }).catch(() => undefined);
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
class FakeDriver implements HubDriver {
  launches: { launch: HubLaunch; submission: HubSubmission }[] = [];
  executions = new Map<string, HubExecutionObservation>();
  stops: string[] = [];
  grants: string[] = [];
  prepareFailure = false;
  unknownCleanup = false;
  settleInput?: NonNullable<HubDriver["settleInput"]>;
  logs: string[] = [];
  async probe(): Promise<void> {}
  async appendLog(_launch: HubLaunch, _submission: HubSubmission, line: string): Promise<void> { this.logs.push(line); }
  async prepare(launch: HubLaunch, submission: HubSubmission) {
    this.launches.push({ launch, submission });
    if (this.prepareFailure) throw new Error("pinned runtime unavailable");
    this.executions.set(launch.id, { execution: "live", ownerGone: false, externalStopped: false });
    return { bootId: "boot", pid: 1234, startTime: "42" };
  }
  async grant(launch: HubLaunch): Promise<void> { this.grants.push(launch.id); }
  async inspect(launch: HubLaunch): Promise<HubExecutionObservation> { return this.executions.get(launch.id) ?? { execution: "drained", ownerGone: true, externalStopped: true }; }
  async stop(launch: HubLaunch): Promise<void> { this.stops.push(launch.id); }
  async kill(launch: HubLaunch): Promise<void> {
    if (!this.unknownCleanup) this.executions.set(launch.id, { execution: "drained", ownerGone: true, externalStopped: true });
  }
  /** The run records a stop while its launch still lives: polling sees it, as the real driver's does. */
  observe(s: HubSubmission, observed: HubObservation): void {
    this.executions.set(s.launch!.id, { execution: "live", ownerGone: false, externalStopped: false, observation: observed });
  }
  finish(s: HubSubmission, continuation: HubContinuation = { kind: "complete" }, progressRevision = 0): void {
    this.executions.set(s.launch!.id, { execution: "drained", ownerGone: true, externalStopped: true, observation: observation(continuation, progressRevision) });
  }
}
function observation(continuation: HubContinuation, progressRevision = 0): HubObservation {
  return { protocolVersion: 1, observedAt: new Date(0).toISOString(), stateRevision: continuation.kind === "automatic" ? continuation.stateRevision : 1, progressRevision, status: continuation.kind === "complete" ? "succeeded" : "stopped", continuation };
}
function request(key?: string): HubSubmitRequest {
  return {
    ...(key === undefined ? {} : { key }), requestDigest: createHash("sha256").update("task").digest("hex"),
    input: { task: "graph: hello\n", config: "{}\n", taskPath: "/tasks/task.yaml", repoPath: "/repos/example", baseCommit: "a".repeat(40), bundlePath: "/plugins/hello", bundleDigest: "b".repeat(64), runtimePath: "/runtime/main.js", runtimeDigest: "c".repeat(64) },
  };
}
async function fixture(limit = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), "graphloom-hub-"));
  folders.push(directory);
  const driver = new FakeDriver();
  let now = 100000;
  let mono = 0;
  const options = { directory, driver, autoPoll: false, now: () => now, monotonic: () => mono, random: () => 0, config: { maxConcurrentRuns: limit, retry: { baseDelayMs: 10, maxDelayMs: 100, maxElapsedMs: 100000 }, shutdownGraceMs: 0 } };
  const hub = await openHub(options);
  hubs.push(hub);
  return { directory, driver, hub, options, advance: (ms: number) => { now += ms; mono += ms; }, wall: (ms: number) => { now += ms; } };
}
async function accepted(hub: Hub, key?: string): Promise<HubSubmission> {
  const result = await hub.submit(request(key));
  if ("archived" in result) throw new Error("unexpected tombstone");
  return result;
}
const retry = (fingerprint = "provider-a"): HubContinuation => ({ kind: "automatic", cause: "transient-provider", fingerprint, stateRevision: 1 });

describe("durable shared run slots", () => {
  it("serializes concurrent submissions, reserves before spawn, and starts only the limit", async () => {
    const { hub, directory, driver } = await fixture(2);
    const original = driver.prepare.bind(driver);
    driver.prepare = async (launch, s) => {
      const snapshot = JSON.parse(await readFile(path.join(directory, "scheduler.json"), "utf8"));
      expect(snapshot.submissions[s.id].launch.id).toBe(launch.id);
      expect(snapshot.submissions[s.id].launch.phase).toBe("reserved");
      expect(Object.values(snapshot.submissions).filter((item) => (item as HubSubmission).launch)).toHaveLength(driver.launches.length + 1);
      return original(launch, s);
    };
    await Promise.all(Array.from({ length: 5 }, () => accepted(hub)));
    await hub.tick();
    expect(hub.list().occupiedSlots).toBe(2);
    expect(driver.grants).toHaveLength(2);
    expect(hub.list().submissions.filter((s) => s.state === "queued")).toHaveLength(3);
  });
  it("never releases a slot for child exit alone, external uncertainty, or owner still alive", async () => {
    const { hub, driver } = await fixture();
    const a = await accepted(hub); const b = await accepted(hub);
    await hub.tick();
    const launch = hub.inspect(a.id).launch!;
    for (const result of [
      { execution: "drained", ownerGone: true, externalStopped: false },
      { execution: "drained", ownerGone: false, externalStopped: true },
      { execution: "uncertain", ownerGone: true, externalStopped: true },
    ] satisfies HubExecutionObservation[]) {
      driver.executions.set(launch.id, result);
      await hub.tick();
      expect(hub.list().occupiedSlots).toBe(1);
      expect(hub.inspect(b.id).launch).toBeUndefined();
    }
    driver.finish(hub.inspect(a.id));
    await hub.tick();
    expect(hub.inspect(a.id).state).toBe("succeeded");
    expect(hub.inspect(b.id).state).toBe("running");
  });
  it("holds running work when reducing the limit, and persists zero admission across restart", async () => {
    const f = await fixture(2);
    const a = await accepted(f.hub); const b = await accepted(f.hub); await accepted(f.hub);
    await f.hub.tick(); await f.hub.setLimit(0);
    expect(f.hub.list()).toMatchObject({ occupiedSlots: 2, maxConcurrentRuns: 0 });
    expect(f.driver.stops).toHaveLength(0);
    f.driver.finish(f.hub.inspect(a.id)); f.driver.finish(f.hub.inspect(b.id));
    await f.hub.tick();
    expect(f.driver.launches).toHaveLength(2);
    await f.hub.close({ graceMs: 0 });
    const reopened = await openHub({ ...f.options, config: { maxConcurrentRuns: 9 } }); hubs.push(reopened);
    expect(reopened.list().maxConcurrentRuns).toBe(0);
    await reopened.setLimit(1); await reopened.tick();
    expect(reopened.list().occupiedSlots).toBe(1);
  });
  it("persists held and cancel intent before signalling and coalesces duplicate resume", async () => {
    const { hub, driver, directory } = await fixture();
    const s = await accepted(hub); await hub.tick();
    driver.stop = async () => {
      const snapshot = JSON.parse(await readFile(path.join(directory, "scheduler.json"), "utf8"));
      expect(snapshot.submissions[s.id].desiredAction).toBe("hold");
    };
    await hub.pause(s.id, { commandId: "hold" });
    expect(hub.inspect(s.id).state).toBe("stopping");
    driver.finish(hub.inspect(s.id), retry()); await hub.tick();
    expect(hub.inspect(s.id).state).toBe("paused");
    await Promise.all([hub.resume(s.id, { commandId: "again" }), hub.resume(s.id, { commandId: "again" })]);
    await hub.tick();
    expect(driver.launches).toHaveLength(2);
    await hub.resume(s.id, { commandId: "another" }); await hub.tick();
    expect(driver.launches).toHaveLength(2);
    driver.stop = async () => undefined;
    await hub.cancel(s.id); driver.finish(hub.inspect(s.id), retry()); await hub.tick();
    expect(hub.inspect(s.id).state).toBe("canceled");
    await expect(hub.resume(s.id)).rejects.toThrow(/canceled/);
  });
  it("coalesces slow observations without delaying pause or limit mutations", async () => {
    const { hub, driver } = await fixture(); const s = await accepted(hub); await hub.tick();
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const inspect = driver.inspect.bind(driver);
    let reads = 0;
    driver.inspect = async (launch) => { reads++; await barrier; return inspect(launch); };
    const ticks = Array.from({ length: 50 }, () => hub.tick());
    await Promise.race([
      Promise.all([hub.pause(s.id), hub.setLimit(0)]),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("slow read blocked mutation writer")), 500)),
    ]);
    expect(reads).toBe(1);
    expect(hub.inspect(s.id).desiredAction).toBe("hold");
    release(); await Promise.all(ticks);
    expect(hub.list().maxConcurrentRuns).toBe(0);
    expect(hub.inspect(s.id).desiredAction).toBe("hold");
  });
  it("fences grants by durable generation, withdrawal, and allowStopping identity", async () => {
    const { hub, directory } = await fixture();
    const s = await accepted(hub); await hub.tick();
    const current = hub.inspect(s.id);
    const grant = { hubId: current.hubId, submissionId: current.id, runId: current.runId, launchId: current.launch!.id, generation: current.generation };
    await assertHubGrant(directory, grant);
    await expect(assertHubGrant(directory, { ...grant, generation: 0 })).rejects.toThrow(/stale/);
    await hub.pause(s.id);
    await expect(assertHubGrant(directory, grant)).rejects.toThrow(/withdrawn/);
    await assertHubGrant(directory, grant, { allowStopping: true });
  });
});

describe("input and command durability", () => {
  it("captures immutable input and deduplicates identical keyed requests, including archives", async () => {
    const { hub, driver } = await fixture();
    const s = await accepted(hub, "ticket-1");
    expect(await readFile(s.input.taskFile, "utf8")).toBe("graph: hello\n");
    expect((await hub.submit(request("ticket-1"))).id).toBe(s.id);
    const changed = request("ticket-1"); changed.input.task = "graph: other\n";
    await expect(hub.submit(changed)).rejects.toThrow(/conflicts/);
    await hub.tick(); driver.finish(hub.inspect(s.id)); await hub.tick();
    await hub.archive(s.id);
    expect(await hub.submit(request("ticket-1"))).toMatchObject({ archived: true, id: s.id, runId: s.runId });
    expect(hub.list().submissions).toHaveLength(0);
  });
  it("updates defaults for future submissions without changing accepted retry policies or the durable limit", async () => {
    const f = await fixture(0); const first = await accepted(f.hub); await f.hub.close({ graceMs: 0 });
    const next = await openHub({ ...f.options, config: { maxConcurrentRuns: 10, retry: { maxAutomaticResumes: 2 } } }); hubs.push(next);
    const second = await accepted(next);
    expect(next.list().maxConcurrentRuns).toBe(0);
    expect(next.inspect(first.id).retry.maxAutomaticResumes).toBe(5);
    expect(second.retry.maxAutomaticResumes).toBe(2);
  });
  it("committed command IDs survive reopening, and uncommitted journal suffixes do not", async () => {
    const f = await fixture(0); const s = await accepted(f.hub);
    await f.hub.pause(s.id, { commandId: "same" });
    await expect(f.hub.resume(s.id, { commandId: "same" })).rejects.toThrow(/conflicts/);
    await f.hub.close({ graceMs: 0 });
    const journal = path.join(f.directory, "submissions", s.id, "commands.ndjson");
    await appendFile(journal, "not committed or valid JSON\n");
    const next = await openHub(f.options); hubs.push(next);
    await next.pause(s.id, { commandId: "same" });
    await next.resume(s.id, { commandId: "new" });
    expect(await readFile(journal, "utf8")).not.toContain("not committed");
  });
  it("refuses a competing daemon and refuses corrupt state rather than creating an empty queue", async () => {
    const f = await fixture();
    await expect(openHub(f.options)).rejects.toThrow(/locked/);
    await f.hub.close({ graceMs: 0 });
    await writeFile(path.join(f.directory, "scheduler.json"), '{"schemaVersion":2}');
    await expect(openHub(f.options)).rejects.toThrow(/schema/);
    expect(await readFile(path.join(f.directory, "scheduler.json"), "utf8")).toBe('{"schemaVersion":2}');
  });
  it("keeps a failed startup reservation until containment is verified then blocks instead of looping", async () => {
    const { hub, driver } = await fixture();
    driver.prepareFailure = true;
    const s = await accepted(hub); await hub.tick();
    expect(hub.inspect(s.id).launch).toBeDefined();
    expect(hub.inspect(s.id).state).toBe("blocked");
    await hub.tick();
    expect(hub.inspect(s.id).launch).toBeUndefined();
    expect(hub.inspect(s.id).state).toBe("blocked");
    expect(driver.launches).toHaveLength(1);
  });
  it("retains a failed preparation through live polling and restart until verified drainage", async () => {
    const f = await fixture();
    const prepare = f.driver.prepare.bind(f.driver);
    f.driver.prepare = async (launch, submission) => {
      await prepare(launch, submission);
      throw new Error("bootstrap containment setup failed");
    };
    const s = await accepted(f.hub); await f.hub.tick();
    const launchId = f.hub.inspect(s.id).launch!.id;
    await f.hub.tick(); await f.hub.tick();
    expect(f.hub.inspect(s.id)).toMatchObject({ state: "blocked", blocker: expect.stringContaining("bootstrap containment setup failed") });
    expect(f.hub.list().occupiedSlots).toBe(1);
    f.driver.unknownCleanup = true;
    await f.hub.close({ graceMs: 0 });
    const next = await openHub(f.options); hubs.push(next);
    expect(next.inspect(s.id).launch?.id).toBe(launchId);
    f.driver.executions.set(launchId, { execution: "drained", ownerGone: true, externalStopped: true });
    await next.tick(); await next.tick();
    expect(next.inspect(s.id)).toMatchObject({ state: "blocked", blocker: expect.stringContaining("bootstrap containment setup failed"), automaticResumes: 0 });
    expect(next.inspect(s.id).launch).toBeUndefined();
    expect(f.driver.launches).toHaveLength(1);
    expect(f.driver.grants).toHaveLength(0);
  });
  it("refuses corrupt durable launch failures instead of treating them as a retryable reservation", async () => {
    const f = await fixture(0); const s = await accepted(f.hub); await f.hub.close({ graceMs: 0 });
    const file = path.join(f.directory, "scheduler.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    snapshot.submissions[s.id].generation = 1;
    snapshot.submissions[s.id].launch = { id: "l-00000000-0000-0000-0000-000000000000", generation: 1, mode: "initial", phase: "reserved", reservedAt: s.acceptedAt, automatic: false, failure: { occurredAt: "invalid", message: "setup failed" } };
    await writeFile(file, JSON.stringify(snapshot));
    await expect(openHub(f.options).then((opened) => { hubs.push(opened); })).rejects.toThrow(/launch failure/);
  });
  it("preserves bounded non-ASCII launch failures across restart without faulting the hub", async () => {
    const f = await fixture(); const prepare = f.driver.prepare.bind(f.driver);
    f.driver.prepare = async (launch, submission) => {
      await prepare(launch, submission);
      throw new Error("启动失败".repeat(1024));
    };
    const s = await accepted(f.hub); await f.hub.tick();
    const reason = f.hub.inspect(s.id).blocker!;
    expect(reason.length).toBe(1024);
    expect(Buffer.byteLength(reason)).toBeGreaterThan(1024);
    expect(f.hub.list().fault).toBeUndefined();
    f.driver.unknownCleanup = true;
    await f.hub.close({ graceMs: 0 });
    const next = await openHub(f.options); hubs.push(next);
    expect(next.inspect(s.id)).toMatchObject({ state: "blocked", blocker: reason });
    expect(next.list().fault).toBeUndefined();
    expect(f.driver.launches).toHaveLength(1);
  });
});

describe("bounded continuation and fairness", () => {
  it("replays verified incomplete initialization after drainage and restart using the same run", async () => {
    const f = await fixture(); const a = await accepted(f.hub); await f.hub.tick();
    const initial = f.hub.inspect(a.id);
    const failedIntake: HubObservation = {
      protocolVersion: 1, observedAt: new Date(0).toISOString(), stateRevision: 0, progressRevision: 0, status: "initialization-failed",
      continuation: { kind: "automatic", cause: "initialization-failed", fingerprint: "verified-incomplete-intake", stateRevision: 0 },
    };
    f.driver.executions.set(initial.launch!.id, { execution: "drained", ownerGone: true, externalStopped: false, observation: failedIntake });
    await f.hub.tick();
    expect(f.hub.list().occupiedSlots).toBe(1);
    expect(f.driver.grants).toHaveLength(1);
    f.driver.executions.set(initial.launch!.id, { execution: "drained", ownerGone: true, externalStopped: true, observation: failedIntake });
    await f.hub.tick();
    expect(f.hub.inspect(a.id)).toMatchObject({ state: "waiting", automaticResumes: 0 });
    await f.hub.close({ graceMs: 0 });
    const next = await openHub(f.options); hubs.push(next);
    expect(next.inspect(a.id).state).toBe("waiting");
    f.advance(10); await next.tick();
    expect(next.inspect(a.id)).toMatchObject({ runId: a.runId, input: a.input, state: "running", automaticResumes: 1, launch: { mode: "initial", automatic: true, generation: 2 } });
    f.driver.finish(next.inspect(a.id)); await next.tick();
    expect(next.inspect(a.id).state).toBe("succeeded");
    expect(f.driver.launches.map((entry) => entry.submission.runId)).toEqual([a.runId, a.runId]);
  });
  it("keeps repeated initialization failures within the automatic retry allowance", async () => {
    const { hub, driver, advance } = await fixture(); const a = await accepted(hub);
    await hub.updatePolicy(a.id, { ...a.retry, maxAutomaticResumes: 1 });
    await hub.tick();
    for (let attempt = 0; attempt < 2; attempt++) {
      driver.executions.set(hub.inspect(a.id).launch!.id, {
        execution: "drained", ownerGone: true, externalStopped: true,
        observation: { protocolVersion: 1, observedAt: new Date(0).toISOString(), stateRevision: 0, progressRevision: 0, status: "initialization-failed", continuation: { kind: "automatic", cause: "initialization-failed", fingerprint: "same-intake-failure", stateRevision: 0 } },
      });
      await hub.tick(); advance(100); await hub.tick();
    }
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", automaticResumes: 1 });
    expect(driver.launches.map((entry) => entry.launch.mode)).toEqual(["initial", "initial"]);
    expect(hub.list().occupiedSlots).toBe(0);
  });
  it("rejects remedies before initialization while allowing a plain manual retry", async () => {
    const { hub, driver } = await fixture(); const a = await accepted(hub); await hub.tick();
    driver.executions.set(hub.inspect(a.id).launch!.id, {
      execution: "drained", ownerGone: true, externalStopped: true,
      observation: { protocolVersion: 1, observedAt: new Date(0).toISOString(), stateRevision: 0, progressRevision: 0, status: "initialization-failed", continuation: { kind: "automatic", cause: "initialization-failed", fingerprint: "intake", stateRevision: 0 } },
    });
    await hub.tick();
    await expect(hub.resume(a.id, { remedy: { reconciled: true } })).rejects.toThrow(/before initialization/);
    await hub.resume(a.id); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", automaticResumes: 0, launch: { mode: "initial", automatic: false } });
  });
  it("carries a plugin update's bundle to the launch and records the driver's settled input", async () => {
    const { hub, driver, directory } = await fixture(); const a = await accepted(hub); await hub.tick();
    driver.finish(hub.inspect(a.id), { kind: "operator", cause: "pin-drift", evidenceRefs: [] });
    await hub.tick();
    const plugin = { bundlePath: "/plugins/hello-2", bundleDigest: "d".repeat(64) };
    await expect(hub.resume(a.id, { remedy: { plugin } })).rejects.toThrow(/needs updatePlugin/);
    await expect(hub.resume(a.id, { remedy: { updatePlugin: true, plugin: { ...plugin, bundlePath: "relative" } } })).rejects.toThrow(/invalid resume remedy plugin/);
    await expect(hub.resume(a.id, { remedy: { updatePlugin: true, plugin: { ...plugin, extra: "x" } as typeof plugin } })).rejects.toThrow(/invalid resume remedy plugin/);
    const settled: string[] = [];
    driver.settleInput = async (launch) => { settled.push(launch.id); return launch.command?.remedy?.plugin; };
    await hub.resume(a.id, { remedy: { updatePlugin: true, plugin } }); await hub.tick();
    const launch = hub.inspect(a.id).launch!;
    expect(launch.command?.remedy).toEqual({ updatePlugin: true, plugin });
    expect(hub.inspect(a.id).input.bundlePath).toBe("/plugins/hello");
    driver.finish(hub.inspect(a.id), { kind: "operator", cause: "pin-drift", evidenceRefs: [] });
    await hub.tick();
    expect(settled).toEqual([launch.id]);
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", input: { bundlePath: plugin.bundlePath, bundleDigest: plugin.bundleDigest } });
    // The recorded bundle survives a restart; a failing reconciliation blocks with its reason.
    await hub.close({ graceMs: 0 });
    const reopened = await openHub({ directory, driver, autoPoll: false, config: { maxConcurrentRuns: 1 } }); hubs.push(reopened);
    expect(reopened.inspect(a.id).input.bundlePath).toBe(plugin.bundlePath);
    driver.settleInput = async () => { throw new Error("link unreadable"); };
    await reopened.resume(a.id); await reopened.tick();
    driver.finish(reopened.inspect(a.id), retry());
    await reopened.tick();
    expect(reopened.inspect(a.id)).toMatchObject({ state: "blocked", blocker: "plugin reconciliation failed: link unreadable", input: { bundlePath: plugin.bundlePath } });
    // A resume accepted while the launch drained does not start another launch past the failure.
    await reopened.resume(a.id); await reopened.tick();
    const launches = driver.launches.length;
    await reopened.pause(a.id); await reopened.resume(a.id);
    expect(reopened.inspect(a.id).pendingCommand?.kind).toBe("resume");
    driver.finish(reopened.inspect(a.id), retry("other"));
    await reopened.tick(); await reopened.tick();
    expect(reopened.inspect(a.id)).toMatchObject({ state: "blocked", blocker: "plugin reconciliation failed: link unreadable" });
    expect(reopened.inspect(a.id).pendingCommand).toBeUndefined();
    expect(driver.launches).toHaveLength(launches);
  });
  it("puts a ready retry behind already queued work without blocking it while waiting", async () => {
    const { hub, driver, advance } = await fixture();
    const a = await accepted(hub); const b = await accepted(hub); const c = await accepted(hub);
    await hub.tick(); driver.finish(hub.inspect(a.id), retry()); await hub.tick();
    expect(hub.inspect(a.id).state).toBe("waiting");
    expect(hub.inspect(b.id).state).toBe("running");
    advance(10); driver.finish(hub.inspect(b.id)); await hub.tick();
    expect(hub.inspect(c.id).state).toBe("running");
    expect(hub.inspect(a.id).state).toBe("queued");
    driver.finish(hub.inspect(c.id)); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", automaticResumes: 1, runId: a.runId });
  });
  it("blocks three unchanged fingerprints, and a manual resume never renews allowance", async () => {
    const { hub, driver, advance } = await fixture();
    const a = await accepted(hub); await hub.tick();
    for (let i = 0; i < 3; i++) {
      driver.finish(hub.inspect(a.id), retry()); await hub.tick(); advance(100); await hub.tick();
    }
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", failureRepeats: 3, automaticResumes: 2 });
    await hub.resume(a.id); await hub.tick();
    driver.finish(hub.inspect(a.id), retry()); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", automaticResumes: 2 });
  });
  it("carries an explicit remedy through a queued retry or an unobserved crash", async () => {
    for (const unknownCrash of [false, true]) {
      const { hub, driver, advance } = await fixture();
      const a = await accepted(hub); await hub.tick(); await hub.setLimit(0);
      if (unknownCrash) driver.executions.set(hub.inspect(a.id).launch!.id, { execution: "drained", ownerGone: true, externalStopped: true });
      else driver.finish(hub.inspect(a.id), retry());
      await hub.tick(); advance(10); await hub.tick();
      expect(hub.inspect(a.id)).toMatchObject({ state: "queued", automaticPending: true });
      await hub.resume(a.id, { commandId: "operator-remedy", remedy: { reconciled: true } });
      await hub.setLimit(1); await hub.tick();
      expect(hub.inspect(a.id)).toMatchObject({
        state: "running", automaticResumes: 0,
        launch: { mode: "resume", automatic: false, command: { id: "operator-remedy", remedy: { reconciled: true } } },
      });
    }
  });
  it("accepted progress clears repeated-fingerprint count but not total allowance or retry epoch", async () => {
    const { hub, driver, advance } = await fixture();
    const a = await accepted(hub); await hub.tick();
    driver.finish(hub.inspect(a.id), retry()); await hub.tick();
    const first = hub.inspect(a.id).retryStartedAt;
    advance(10); await hub.tick();
    driver.finish(hub.inspect(a.id), retry(), 1); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "waiting", failureRepeats: 1, automaticResumes: 1, retryStartedAt: first });
  });
  it("requires both elapsed delay and wall deadline; backward/forward jumps cannot shortcut a retry", async () => {
    const { hub, driver, wall, advance } = await fixture();
    const a = await accepted(hub); await hub.tick(); driver.finish(hub.inspect(a.id), retry()); await hub.tick();
    wall(5000); await hub.tick(); expect(hub.inspect(a.id).state).toBe("waiting");
    wall(-10000); advance(10); await hub.tick(); expect(hub.inspect(a.id).state).toBe("waiting");
    wall(5000); await hub.tick(); expect(hub.inspect(a.id).state).toBe("running");
  });
  it("blocks provider reset outside the retry window and rechecks deadline before admission", async () => {
    const f = await fixture(); const a = await accepted(f.hub); await f.hub.tick();
    f.driver.finish(f.hub.inspect(a.id), { ...retry(), kind: "automatic", cause: "provider-cooldown", fingerprint: "quota", stateRevision: 1, notBefore: new Date(300000).toISOString() });
    await f.hub.tick(); expect(f.hub.inspect(a.id).blocker).toMatch(/retry window/);
    await f.hub.resume(a.id); await f.hub.tick(); f.driver.finish(f.hub.inspect(a.id), retry("new")); await f.hub.tick();
    await f.hub.setLimit(0); f.advance(100001); await f.hub.tick(); await f.hub.setLimit(1); await f.hub.tick();
    expect(f.hub.inspect(a.id).state).toBe("blocked");
  });
  it("unknown or operator continuations never become automatic retries", async () => {
    const { hub, driver, advance } = await fixture();
    const a = await accepted(hub); await hub.tick();
    driver.finish(hub.inspect(a.id), { kind: "operator", cause: "reconciliation", evidenceRefs: ["effect"] });
    await hub.tick(); advance(1000); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", automaticResumes: 0 });
    expect(driver.launches).toHaveLength(1);
  });
  it("holds an invalid observation's reservation, refusing a forged completion", async () => {
    const { hub, driver } = await fixture(); const a = await accepted(hub); await hub.tick();
    const launch = hub.inspect(a.id).launch!;
    driver.executions.set(launch.id, { execution: "drained", ownerGone: true, externalStopped: true, observation: { ...observation({ kind: "complete" }), status: "stopped" } });
    await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked" });
    expect(hub.list().occupiedSlots).toBe(1);
  });
  it("refuses initial replay observations that claim existing controller progress", async () => {
    const { hub, driver } = await fixture(); const a = await accepted(hub); await hub.tick();
    driver.finish(hub.inspect(a.id), { kind: "automatic", cause: "initialization-failed", fingerprint: "contradiction", stateRevision: 1 }, 1);
    await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", blocker: expect.stringContaining("invalid continuation") });
    expect(hub.list().occupiedSlots).toBe(1);
  });
});

describe("restart reconciliation", () => {
  it("retains uncertain slots across shutdown and reconciles all of them before starting new work", async () => {
    const f = await fixture(); const a = await accepted(f.hub); const b = await accepted(f.hub); await f.hub.tick();
    f.driver.unknownCleanup = true;
    await f.hub.close({ graceMs: 0 });
    const next = await openHub(f.options); hubs.push(next);
    expect(next.list().occupiedSlots).toBe(1);
    expect(next.inspect(b.id).state).toBe("queued");
    expect(next.inspect(a.id).launch).toBeDefined();
    expect(f.driver.launches).toHaveLength(1);
    f.driver.unknownCleanup = false;
  });
  it("recovers a drained reserved launch without creating a second run identity", async () => {
    const f = await fixture(0); const a = await accepted(f.hub); await f.hub.close({ graceMs: 0 });
    const file = path.join(f.directory, "scheduler.json");
    const snapshot = JSON.parse(await readFile(file, "utf8"));
    snapshot.config.maxConcurrentRuns = 1;
    snapshot.submissions[a.id].generation = 1;
    snapshot.submissions[a.id].state = "starting";
    snapshot.submissions[a.id].launch = { id: "l-00000000-0000-0000-0000-000000000000", generation: 1, mode: "initial", phase: "reserved", reservedAt: a.acceptedAt, automatic: false };
    await writeFile(file, JSON.stringify(snapshot));
    const next = await openHub(f.options); hubs.push(next);
    expect(next.inspect(a.id)).toMatchObject({ runId: a.runId, generation: 2, state: "running", automaticResumes: 0 });
    expect(f.driver.launches[0]?.launch.mode).toBe("initial");
  });
  it("recognizes a matched planned interruption without spending a failure resume", async () => {
    const f = await fixture(); const a = await accepted(f.hub); await f.hub.tick();
    f.driver.stop = async (launch) => {
      f.driver.finish(f.hub.inspect(a.id), { kind: "automatic", cause: "service-interruption", fingerprint: "planned", stateRevision: 1, interruptionCommandId: launch.stopCommandId! });
    };
    f.driver.kill = async () => undefined;
    await f.hub.close({ graceMs: 0 });
    const next = await openHub(f.options); hubs.push(next);
    const pass = next.inspect(a.id);
    expect(pass).toMatchObject({ state: "running", automaticResumes: 0, launch: { mode: "reconcile", automatic: true, command: { kind: "service-interruption" } } });
    f.driver.finish(pass, { kind: "automatic", cause: "service-interruption", fingerprint: "planned", stateRevision: 1, interruptionCommandId: pass.launch!.command!.id });
    await next.tick();
    expect(next.inspect(a.id)).toMatchObject({ state: "running", automaticResumes: 0, launch: { mode: "resume", automatic: true } });
    f.driver.finish(next.inspect(a.id)); await next.tick();
    expect(next.inspect(a.id).state).toBe("succeeded");
  });
});

describe("archive index", () => {
  async function cancelAndArchive(hub: Hub, key: string): Promise<HubSubmission> {
    const s = await accepted(hub, key);
    await hub.cancel(s.id, { commandId: `cancel-${key}` });
    await hub.archive(s.id);
    return s;
  }
  it("records each archived submission durably, keeps its tombstone, and reloads it", async () => {
    const f = await fixture(0);
    const s = await accepted(f.hub, "ticket-9");
    await f.hub.cancel(s.id, { commandId: "c" });
    await f.hub.archive(s.id);
    await f.hub.archive(s.id);
    const [entry] = f.hub.archived();
    expect(f.hub.archived()).toHaveLength(1);
    expect(entry).toMatchObject({ archived: true, id: s.id, runId: s.runId, key: "ticket-9", repoPath: "/repos/example", taskPath: "/tasks/task.yaml", requestDigest: s.requestDigest, acceptedAt: s.acceptedAt, state: "canceled" });
    expect(Date.parse(entry!.archivedAt)).toBeGreaterThan(0);
    await f.hub.close({ graceMs: 0 });
    const reopened = await openHub(f.options); hubs.push(reopened);
    expect(reopened.archived()).toEqual([entry]);
    expect(await reopened.submit(request("ticket-9"))).toMatchObject({ archived: true, id: s.id });
  });
  it("records what the describe hook reads, and archives without it when the hook fails", async () => {
    const f = await fixture(0); await f.hub.close({ graceMs: 0 });
    let fail = false;
    const hub = await openHub({ ...f.options, describeArchive: async (s) => {
      if (fail) throw new Error("task unreadable");
      return { graph: "hello", request: { graph: "hello", digest: "d".repeat(64), firstLine: "Fix the widgets" }, stateDir: `/hub/runs/${s.runId}` };
    } }); hubs.push(hub);
    const first = await cancelAndArchive(hub, "a");
    fail = true;
    await cancelAndArchive(hub, "b");
    const [a, b] = hub.archived();
    expect(a).toMatchObject({ graph: "hello", request: { firstLine: "Fix the widgets" }, stateDir: `/hub/runs/${first.runId}` });
    expect(b).not.toHaveProperty("graph"); expect(b).not.toHaveProperty("request");
  });
  it("evicts the oldest entries past its count and byte bounds; tombstones keep every key", async () => {
    const f = await fixture(0); await f.hub.close({ graceMs: 0 });
    const hub = await openHub({ ...f.options, archiveIndexBounds: { entries: 3, bytes: 1024 * 1024 } }); hubs.push(hub);
    const ids: string[] = [];
    for (const key of ["k1", "k2", "k3", "k4", "k5"]) ids.push((await cancelAndArchive(hub, key)).id);
    expect(hub.archived().map((entry) => entry.id)).toEqual(ids.slice(2));
    expect(await hub.submit(request("k1"))).toMatchObject({ archived: true, id: ids[0] });
    await hub.close({ graceMs: 0 });
    const small = await openHub({ ...f.options, archiveIndexBounds: { entries: 100, bytes: 1200 } }); hubs.push(small);
    await cancelAndArchive(small, "k6");
    const kept = small.archived();
    expect(kept.length).toBeLessThan(4);
    expect(kept.at(-1)?.key).toBe("k6");
    expect(Buffer.byteLength(await readFile(path.join(f.directory, "archive-index.json"), "utf8"))).toBeLessThanOrEqual(1200 + 1);
  });
  it("starts empty for a store without an index and sets a damaged index aside without faulting", async () => {
    const f = await fixture(0);
    expect(f.hub.archived()).toEqual([]);
    expect(f.hub.archiveIndexError).toBeUndefined();
    await cancelAndArchive(f.hub, "x");
    await f.hub.close({ graceMs: 0 });
    await writeFile(path.join(f.directory, "archive-index.json"), "{not json");
    const hub = await openHub(f.options); hubs.push(hub);
    expect(hub.archived()).toEqual([]);
    expect(hub.archiveIndexError).toMatch(/set aside as archive-index\.json\.damaged-/);
    expect(hub.list().fault).toBeUndefined();
    await cancelAndArchive(hub, "y");
    expect(hub.archived().map((entry) => entry.key)).toEqual(["y"]);
  });
});

describe("rehearsal submissions", () => {
  const rehearsalRequest = (key?: string, rehearsal: Record<string, unknown> = { scenario: "operator" }): HubSubmitRequest => {
    const base = request(key);
    return { ...base, requestDigest: createHash("sha256").update("rehearsal task").digest("hex"), input: { ...base.input, rehearsal } as HubSubmitRequest["input"] };
  };
  it("scopes a rehearsal's key apart from a real submission's, so the same key never collides", async () => {
    const f = await fixture(0);
    const real = await accepted(f.hub, "fix-1");
    const rehearsal = await f.hub.submit(rehearsalRequest("fix-1"));
    if ("archived" in rehearsal) throw new Error("unexpected tombstone");
    expect(rehearsal.id).not.toBe(real.id);
    expect(rehearsal).toMatchObject({ key: "rehearsal:fix-1", input: { rehearsal: { scenario: "operator" } } });
    expect(rehearsal.runId).toMatch(/^rehearsal-hub-[a-f0-9-]{36}$/);
    expect(real.runId).toMatch(/^hub-[a-f0-9-]{36}$/);
    // Each key still answers its own request idempotently.
    expect((await f.hub.submit(rehearsalRequest("fix-1"))).id).toBe(rehearsal.id);
    expect((await f.hub.submit(request("fix-1"))).id).toBe(real.id);
    // The rehearsal scope's prefix is not a real submission's to take.
    await expect(f.hub.submit(request("rehearsal:fix-1"))).rejects.toThrow(/reserved for rehearsal submissions/);
  });
  it("refuses unknown or invalid rehearsal settings", async () => {
    const f = await fixture(0);
    await expect(f.hub.submit(rehearsalRequest(undefined, { scenario: "../x" }))).rejects.toThrow(/invalid rehearsal setting scenario/);
    await expect(f.hub.submit(rehearsalRequest(undefined, { commands: "all" }))).rejects.toThrow(/invalid rehearsal setting commands/);
    await expect(f.hub.submit(rehearsalRequest(undefined, { synthesized: true }))).rejects.toThrow(/invalid rehearsal setting synthesized/);
    await expect(f.hub.submit(rehearsalRequest(undefined, { stopAt: "../round1" }))).rejects.toThrow(/invalid rehearsal setting stopAt/);
    // A stop point names a node by id or name, as `rehearse --stop-at` takes it.
    const stopped = await f.hub.submit(rehearsalRequest("stop", { scenario: "happy", stopAt: "Round 1" }));
    if ("archived" in stopped) throw new Error("unexpected tombstone");
    expect(stopped.input.rehearsal).toEqual({ scenario: "happy", stopAt: "Round 1" });
  });
  it("refuses a supervisor transition for a rehearsal, whose supervisor is its scenario's script, but takes the other remedies", async () => {
    const f = await fixture(1);
    const created = await f.hub.submit(rehearsalRequest());
    if ("archived" in created) throw new Error("unexpected tombstone");
    await f.hub.tick();
    f.driver.finish(f.hub.inspect(created.id), { kind: "operator", cause: "approval", evidenceRefs: [] });
    await f.hub.tick();
    expect(f.hub.inspect(created.id).state).toBe("blocked");
    await expect(f.hub.resume(created.id, { remedy: { supervisor: "codex" } })).rejects.toThrow(/scenario's script/);
    const resumed = await f.hub.resume(created.id, { remedy: { approve: "ruling", inputs: { ruling: "stands" } } });
    expect(resumed).toMatchObject({ state: "queued", pendingCommand: { remedy: { approve: "ruling" } } });
  });
  it("records a rehearsal's settings in its archive entry", async () => {
    const f = await fixture(0);
    const created = await f.hub.submit(rehearsalRequest("arch"));
    if ("archived" in created) throw new Error("unexpected tombstone");
    await f.hub.cancel(created.id);
    await f.hub.archive(created.id);
    expect(f.hub.archived()).toEqual([expect.objectContaining({ key: "rehearsal:arch", rehearsal: { scenario: "operator" } })]);
  });
});

describe("operator commands and launch reports (campaign findings)", () => {
  const approval: HubContinuation = { kind: "operator", cause: "approval", evidenceRefs: [] };
  const waiting = (blocker = "waiting on approval ruling: graphloom resume --approve ruling --input ruling=<text>"): HubObservation => ({ ...observation(approval), blocker });
  /** The launch drains, reporting its end as a managed launch does (or not at all, when killed). */
  const end = (driver: FakeDriver, s: HubSubmission, observed: HubObservation | undefined, report?: Partial<HubLaunchReport>) => {
    const launch = s.launch!;
    driver.executions.set(launch.id, {
      execution: "drained", ownerGone: true, externalStopped: true, ...(observed ? { observation: observed } : {}),
      ...(report ? { report: { protocolVersion: 1, launchId: launch.id, generation: launch.generation, outcome: "completed", endedAt: new Date(0).toISOString(), ...report } as HubLaunchReport } : {}),
    });
  };
  const remedy = { approve: "ruling", inputs: { ruling: "approve it" } };
  async function blockedOnApproval() {
    const f = await fixture(); const a = await accepted(f.hub); await f.hub.tick();
    end(f.driver, f.hub.inspect(a.id), waiting(), { outcome: "completed" }); await f.hub.tick();
    expect(f.hub.inspect(a.id).state).toBe("blocked");
    return { ...f, a };
  }

  it("keeps an approval a pause withdrew before the run applied it: the next plain resume applies it", async () => {
    const { hub, driver, a } = await blockedOnApproval();
    await hub.resume(a.id, { commandId: "X", remedy }); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", launch: { command: { id: "X", remedy } }, lastResume: { commandId: "X", status: "launched" } });
    await hub.pause(a.id);
    expect(hub.inspect(a.id).state).toBe("stopping");
    end(driver, hub.inspect(a.id), waiting(), { outcome: "error", error: "managed execution grant was withdrawn", command: { id: "X", applied: false } });
    await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "paused", pendingCommand: { id: "X", remedy }, lastResume: { commandId: "X", status: "pending" } });
    // The held approval is not answered from the record: retrying it applies it.
    expect(await hub.knownCommand(a.id, "X")).toBe(false);
    await hub.resume(a.id); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", launch: { automatic: false, command: { id: "X", remedy } } });
    end(driver, hub.inspect(a.id), observation({ kind: "complete" }), { command: { id: "X", applied: true } }); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "succeeded", lastResume: { commandId: "X", status: "applied" } });
    // Now a retry is answered from the record and starts nothing.
    const launches = driver.launches.length;
    expect(await hub.knownCommand(a.id, "X")).toBe(true);
    await hub.resume(a.id, { commandId: "X", remedy }); await hub.tick();
    expect(driver.launches).toHaveLength(launches);
  });

  it("takes the plugin bundle resolved again when a held --update-plugin resume is resent", async () => {
    const { hub, a } = await blockedOnApproval();
    const update = (bundlePath: string) => ({ updatePlugin: true, plugin: { bundlePath, bundleDigest: "d".repeat(64) } });
    await hub.resume(a.id, { commandId: "U", remedy: update("/plugins/old") });
    await hub.pause(a.id);
    expect(hub.inspect(a.id)).toMatchObject({ state: "paused", pendingCommand: { id: "U" } });
    await hub.resume(a.id, { commandId: "U", remedy: update("/plugins/new") });
    expect(hub.inspect(a.id).pendingCommand).toMatchObject({ id: "U", remedy: update("/plugins/new") });
  });

  it("keeps an unapplied remedy when a plain resume arrives while its withdrawn launch drains", async () => {
    const { hub, driver, a } = await blockedOnApproval();
    await hub.resume(a.id, { commandId: "X", remedy }); await hub.tick();
    await hub.pause(a.id);
    await hub.resume(a.id, { commandId: "Y" });
    expect(hub.inspect(a.id)).toMatchObject({ state: "stopping", pendingCommand: { id: "Y" }, lastResume: { commandId: "X" } });
    end(driver, hub.inspect(a.id), waiting(), { outcome: "error", error: "managed execution grant was withdrawn", command: { id: "X", applied: false } });
    await hub.tick(); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", launch: { automatic: false, command: { id: "X", remedy } }, lastResume: { commandId: "X", status: "launched" } });
  });

  it("re-applies a held or withdrawn resume when its command ID is resent, never reporting success for nothing", async () => {
    // Held by a pause: resending the same command ID releases the hold and applies it.
    const held = await blockedOnApproval();
    await held.hub.resume(held.a.id, { commandId: "X", remedy }); await held.hub.tick();
    await held.hub.pause(held.a.id);
    end(held.driver, held.hub.inspect(held.a.id), waiting(), { outcome: "error", error: "managed execution grant was withdrawn", command: { id: "X", applied: false } });
    await held.hub.tick();
    await held.hub.resume(held.a.id, { commandId: "X", remedy }); await held.hub.tick();
    expect(held.hub.inspect(held.a.id)).toMatchObject({ state: "running", desiredAction: "execute", launch: { command: { id: "X", remedy } } });
    // Withdrawn by a crash before the run applied it: the record says so, and the retry applies it.
    const crashed = await blockedOnApproval();
    await crashed.hub.resume(crashed.a.id, { commandId: "Y", remedy }); await crashed.hub.tick();
    end(crashed.driver, crashed.hub.inspect(crashed.a.id), undefined);
    await crashed.hub.tick();
    expect(crashed.hub.inspect(crashed.a.id)).toMatchObject({ state: "waiting", lastResume: { commandId: "Y", status: "withdrawn", reason: expect.stringContaining("resend the same command ID") } });
    expect(crashed.hub.inspect(crashed.a.id).pendingCommand).toBeUndefined();
    await crashed.hub.resume(crashed.a.id, { commandId: "Y", remedy }); await crashed.hub.tick();
    expect(crashed.hub.inspect(crashed.a.id)).toMatchObject({ state: "running", launch: { automatic: false, command: { id: "Y", remedy } }, lastResume: { commandId: "Y", status: "launched" } });
    // A different request under the same ID is still a conflict.
    await expect(crashed.hub.resume(crashed.a.id, { commandId: "Y" })).rejects.toThrow(/conflicts/);
  });

  it("blocks with the run's refusal of a remedy, keeps the earlier stop visible, and still takes a corrected one", async () => {
    const { hub, driver, a } = await blockedOnApproval();
    await hub.resume(a.id, { commandId: "wrong", remedy: { approve: "not-an-approval" } }); await hub.tick();
    const reason = 'graph hello declares no approval "not-an-approval"; it declares ruling';
    end(driver, hub.inspect(a.id), waiting(), { outcome: "refused", refusal: { cause: "invalid-remedy", reason }, command: { id: "wrong", applied: false } });
    await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", lastResume: { commandId: "wrong", status: "refused", reason } });
    expect(hub.inspect(a.id).blocker).toBe(`resume refused: ${reason}; the run still stops on: ${waiting().blocker}`);
    // The refusal is the record's answer: resending it starts nothing.
    const launches = driver.launches.length;
    await hub.resume(a.id, { commandId: "wrong", remedy: { approve: "not-an-approval" } }); await hub.tick();
    expect(driver.launches).toHaveLength(launches);
    await hub.resume(a.id, { commandId: "right", remedy }); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", launch: { command: { id: "right", remedy } } });
  });

  it("blocks a launch refused for a deterministic cause at once, with the cause, and never retries it", async () => {
    const { hub, driver, advance } = await fixture(); const a = await accepted(hub); await hub.tick();
    const intake: HubObservation = { protocolVersion: 1, observedAt: new Date(0).toISOString(), stateRevision: 0, progressRevision: 0, status: "initialization-failed", continuation: { kind: "automatic", cause: "initialization-failed", fingerprint: "intake", stateRevision: 0 } };
    end(driver, hub.inspect(a.id), intake, { outcome: "refused", refusal: { cause: "invalid-scenario", reason: 'no scenario named "nope"; this bundle declares: happy' } });
    await hub.tick(); advance(1000); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "blocked", blocker: 'launch refused: no scenario named "nope"; this bundle declares: happy', automaticResumes: 0 });
    expect(driver.launches).toHaveLength(1);
    // Still recoverable: a plain manual retry runs the initial launch again.
    await hub.resume(a.id); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", launch: { mode: "initial", automatic: false } });
  });

  it("names the retry limit reached and the last cause when automatic retries stop", async () => {
    const crash = (stateRevision: number): HubContinuation => ({ kind: "automatic", cause: "controller-crash", fingerprint: "crash", stateRevision });
    const repeated = await fixture(); const a = await accepted(repeated.hub); await repeated.hub.tick();
    for (let i = 0; i < 3; i++) {
      end(repeated.driver, repeated.hub.inspect(a.id), observation(crash(1))); await repeated.hub.tick(); repeated.advance(100); await repeated.hub.tick();
    }
    expect(repeated.hub.inspect(a.id).blocker).toBe("automatic retry stopped: the same failure repeated 3 times without accepted progress; last cause: controller-crash: the launch ended without reporting its end (killed or crashed)");
    const allowance = await fixture(); const b = await accepted(allowance.hub);
    await allowance.hub.updatePolicy(b.id, { ...b.retry, maxAutomaticResumes: 1 }); await allowance.hub.tick();
    for (const fingerprint of ["one", "two"]) {
      end(allowance.driver, allowance.hub.inspect(b.id), observation({ kind: "automatic", cause: "transient-launch", fingerprint, stateRevision: 1 }), { outcome: "error", error: `spawn git ENOENT (${fingerprint})` });
      await allowance.hub.tick(); allowance.advance(100); await allowance.hub.tick();
    }
    expect(allowance.hub.inspect(b.id).blocker).toBe("automatic retry stopped: retry allowance used (1/1 automatic resumes); last cause: transient-launch: spawn git ENOENT (two)");
  });

  it("closes the log of a launch that ended without reporting its end, and only that one", async () => {
    const { hub, driver, a } = await blockedOnApproval();
    expect(driver.logs).toEqual([]);
    await hub.resume(a.id); await hub.tick();
    end(driver, hub.inspect(a.id), observation({ kind: "automatic", cause: "controller-crash", fingerprint: "crash", stateRevision: 2 }));
    await hub.tick();
    expect(driver.logs).toHaveLength(1);
    expect(driver.logs[0]).toMatch(new RegExp(`^graphloom: run ${a.runId} waiting: the launch ended without reporting its end; the hub settled it; next attempt at `));
  });

  it("records no blocker for a succeeded submission, whatever its completion stop said", async () => {
    const { hub, driver } = await fixture(); const a = await accepted(hub); await hub.tick();
    end(driver, hub.inspect(a.id), { ...observation({ kind: "complete" }), blocker: "none" }); await hub.tick();
    const done = hub.inspect(a.id);
    expect(done.state).toBe("succeeded");
    expect(submissionBlocker(done)).toBeUndefined();
    await hub.archive(a.id);
    expect(hub.archived()[0]).not.toHaveProperty("blocker");
  });

  it("keeps the stop a refused plugin update answered visible beside the pin mismatch, and records the update refused", async () => {
    const { hub, driver, a } = await blockedOnApproval();
    await hub.resume(a.id, { commandId: "update", remedy: { updatePlugin: true, plugin: { bundlePath: "/plugins/hello-2", bundleDigest: "d".repeat(64) } } }); await hub.tick();
    const drift: HubObservation = { ...observation({ kind: "operator", cause: "pin-drift", evidenceRefs: [] }), stateRevision: 2, blocker: "plugin stages changed since run start: node extra added" };
    // The run records its pin mismatch before its launch drains, and a poll sees it first:
    // the submission's observation is no longer the approval wait when the launch settles.
    driver.observe(hub.inspect(a.id), drift); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "running", observation: { blocker: drift.blocker }, launch: { priorBlocker: waiting().blocker } });
    end(driver, hub.inspect(a.id), drift, { outcome: "completed", command: { id: "update", applied: true } });
    await hub.tick();
    expect(hub.inspect(a.id).blocker).toBe(`plugin update refused: ${drift.blocker}; the run still stops on: ${waiting().blocker}`);
    expect(hub.inspect(a.id).lastResume).toMatchObject({ commandId: "update", status: "refused", reason: `plugin update refused: ${drift.blocker}` });
  });
});

describe("a launch the OOM killer ended (docs/design-run-hub.md §6.2)", () => {
  const GiB = 1024 ** 3;
  const atLimit: HubLaunchMemory = { oom: 1, oomKill: 3, oomGroupKill: 1, maxBytes: 6 * GiB, peakBytes: 6 * GiB };
  const crashed = (progressRevision = 0) => observation({ kind: "automatic", cause: "controller-crash", fingerprint: "crash", stateRevision: 1 }, progressRevision);
  const killed = (driver: FakeDriver, s: HubSubmission, memory: HubLaunchMemory, observed: HubObservation | null = crashed()) => {
    driver.executions.set(s.launch!.id, { execution: "drained", ownerGone: true, externalStopped: true, memory, ...(observed ? { observation: observed } : {}) });
  };

  it("retries once at the launch's own limit, then blocks naming the limit and what to change", async () => {
    const { hub, driver, advance } = await fixture(); const a = await accepted(hub); await hub.tick();
    killed(driver, hub.inspect(a.id), atLimit); await hub.tick();
    const waiting = hub.inspect(a.id);
    expect(waiting).toMatchObject({ state: "waiting", automaticPending: true, failureFingerprint: `memory-limit:${a.runId}` });
    expect(waiting.lastFailure).toBe("controller-crash: memory limit reached (6 GiB): the kernel killed the launch at its cgroup's memory.max (launchMemoryMax); peak 6 GiB");
    expect(driver.logs[0]).toMatch(new RegExp(`^graphloom: run ${a.runId} waiting: the launch was killed: memory limit reached \\(6 GiB\\)`));
    advance(1000); await hub.tick();
    expect(hub.inspect(a.id).state).toBe("running");
    // The retry reaches the same limit with no accepted progress: the working set does not fit.
    killed(driver, hub.inspect(a.id), atLimit); await hub.tick();
    const blocked = hub.inspect(a.id);
    expect(blocked.state).toBe("blocked");
    expect(blocked.blocker).toBe(`memory limit reached (6 GiB): the kernel killed the launch at its cgroup's memory.max (launchMemoryMax); peak 6 GiB; reached again on its automatic retry with no accepted progress, so the hub does not retry it: raise launchMemoryMax in hub.json and restart the hub (or lower the run's parallel jobs), then graphloom hub resume ${a.id}`);
    expect(blocked.automaticResumes).toBe(1);
    advance(100_000); await hub.tick();
    expect(hub.inspect(a.id).state).toBe("blocked");
    // The operator's resume launches it again.
    await hub.resume(a.id); await hub.tick();
    expect(hub.inspect(a.id).state).toBe("running");
  });

  it("retries again when the run made accepted progress between the kills", async () => {
    const { hub, driver, advance } = await fixture(); const a = await accepted(hub); await hub.tick();
    killed(driver, hub.inspect(a.id), atLimit, crashed(1)); await hub.tick(); advance(1000); await hub.tick();
    killed(driver, hub.inspect(a.id), atLimit, crashed(2)); await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "waiting", automaticResumes: 1 });
  });

  it("treats a kill outside the launch's own limit as a crash under the normal allowance", async () => {
    const { hub, driver, advance } = await fixture(); const a = await accepted(hub); await hub.tick();
    const outside: HubLaunchMemory = { oom: 0, oomKill: 2, oomGroupKill: 1, maxBytes: 6 * GiB };
    killed(driver, hub.inspect(a.id), outside); await hub.tick(); advance(1000); await hub.tick();
    killed(driver, hub.inspect(a.id), outside); await hub.tick();
    const s = hub.inspect(a.id);
    expect(s).toMatchObject({ state: "waiting", failureFingerprint: `memory-outside:${a.runId}`, failureRepeats: 2 });
    expect(s.lastFailure).toContain("killed by the out-of-memory killer outside the launch's own limit");
  });

  it("reconciles an unobserved kill, and keeps an operator stop with the memory cause beside it", async () => {
    const unobserved = await fixture(); const a = await accepted(unobserved.hub); await unobserved.hub.tick();
    killed(unobserved.driver, unobserved.hub.inspect(a.id), atLimit, null); await unobserved.hub.tick();
    expect(unobserved.hub.inspect(a.id)).toMatchObject({ state: "waiting", reconciliationPending: true });
    const stopped = await fixture(); const b = await accepted(stopped.hub); await stopped.hub.tick();
    killed(stopped.driver, stopped.hub.inspect(b.id), atLimit, { ...observation({ kind: "operator", cause: "reconciliation", evidenceRefs: [] }), blocker: "an effect needs reconciling" });
    await stopped.hub.tick();
    expect(stopped.hub.inspect(b.id).blocker).toMatch(/^the launch was killed: memory limit reached \(6 GiB\).*; the run stops on: an effect needs reconciling$/);
  });

  it("keeps the latest finished launch's record with the submission, and in its archive entry", async () => {
    const { hub, driver, advance } = await fixture(); const a = await accepted(hub); await hub.tick();
    const first = hub.inspect(a.id).launch!;
    killed(driver, hub.inspect(a.id), { ...atLimit, highBytes: 4 * GiB }); await hub.tick();
    expect(hub.inspect(a.id).lastLaunchMemory).toEqual({ launchId: first.id, recordedAt: new Date(100000).toISOString(), peak: 6 * GiB, high: 4 * GiB, max: 6 * GiB, oom: 1, oomKills: 3 });
    expect(hub.list().submissions[0]!.lastLaunchMemory?.launchId).toBe(first.id);
    advance(1000); await hub.tick();
    // The retry runs: the record stays the previous launch's until this one ends.
    const second = hub.inspect(a.id).launch!;
    expect(hub.inspect(a.id).lastLaunchMemory?.launchId).toBe(first.id);
    driver.executions.set(second.id, { execution: "drained", ownerGone: true, externalStopped: true, memory: { oom: 0, oomKill: 0, oomGroupKill: 0, maxBytes: 6 * GiB, peakBytes: 2 * GiB }, observation: observation({ kind: "complete" }),
      report: { protocolVersion: 1, launchId: second.id, generation: second.generation, outcome: "completed", endedAt: new Date(0).toISOString() } });
    await hub.tick();
    expect(hub.inspect(a.id)).toMatchObject({ state: "succeeded", lastLaunchMemory: { launchId: second.id, peak: 2 * GiB, max: 6 * GiB, oom: 0, oomKills: 0 } });
    await hub.archive(a.id);
    expect(hub.archived()[0]!.lastLaunchMemory).toMatchObject({ launchId: second.id, peak: 2 * GiB, oomKills: 0 });
  });

  it("reads the newest memory record on disk for a submission settled before the hub kept it", async () => {
    const f = await fixture(); const a = await accepted(f.hub); await f.hub.tick();
    f.driver.finish(f.hub.inspect(a.id)); await f.hub.tick();
    expect(f.hub.inspect(a.id).lastLaunchMemory).toBeUndefined();
    await f.hub.close({ graceMs: 0 });
    const launches = path.join(f.directory, "submissions", a.id, "launches");
    await mkdir(launches, { recursive: true });
    const older = "l-00000000-0000-0000-0000-000000000001"; const newer = "l-00000000-0000-0000-0000-000000000002";
    await writeFile(path.join(launches, `${older}.memory.json`), JSON.stringify({ oom: 0, oomKill: 0, oomGroupKill: 0, maxBytes: 6 * GiB, peakBytes: 5 * GiB }));
    await writeFile(path.join(launches, `${newer}.memory.json`), JSON.stringify({ oom: 1, oomKill: 2, oomGroupKill: 1, maxBytes: 6 * GiB, peakBytes: 6 * GiB }));
    await writeFile(path.join(launches, "l-00000000-0000-0000-0000-000000000003.memory.json"), "not json");
    await utimes(path.join(launches, `${older}.memory.json`), new Date(1000), new Date(1000));
    await utimes(path.join(launches, `${newer}.memory.json`), new Date(2000), new Date(2000));
    await utimes(path.join(launches, "l-00000000-0000-0000-0000-000000000003.memory.json"), new Date(500), new Date(500));
    const reopened = await openHub(f.options); hubs.push(reopened);
    expect(reopened.inspect(a.id).lastLaunchMemory).toEqual({ launchId: newer, recordedAt: new Date(2000).toISOString(), peak: 6 * GiB, max: 6 * GiB, oom: 1, oomKills: 2 });
    expect(JSON.parse(await readFile(path.join(f.directory, "scheduler.json"), "utf8")).submissions[a.id].lastLaunchMemory.launchId).toBe(newer);
  });

  it("ignores the cgroup's OOM record when the launch reported its end, or no OOM killer acted", async () => {
    const { hub, driver } = await fixture(); const a = await accepted(hub); await hub.tick();
    const launch = hub.inspect(a.id).launch!;
    driver.executions.set(launch.id, { execution: "drained", ownerGone: true, externalStopped: true, memory: atLimit, observation: observation({ kind: "complete" }),
      report: { protocolVersion: 1, launchId: launch.id, generation: launch.generation, outcome: "completed", endedAt: new Date(0).toISOString() } });
    await hub.tick();
    expect(hub.inspect(a.id).state).toBe("succeeded");
    const quiet = await fixture(); const b = await accepted(quiet.hub); await quiet.hub.tick();
    killed(quiet.driver, quiet.hub.inspect(b.id), { oom: 0, oomKill: 0, oomGroupKill: 0, maxBytes: 6 * GiB });
    await quiet.hub.tick();
    expect(quiet.hub.inspect(b.id).lastFailure).toBe("controller-crash: the launch ended without reporting its end (killed or crashed)");
  });
});
