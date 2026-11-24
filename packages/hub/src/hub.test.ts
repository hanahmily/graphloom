// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { HubContinuation, HubLaunch, HubObservation, HubSubmission } from "@graphloom/sdk";
import { assertHubGrant, openHub } from "./hub.js";
import type { Hub } from "./hub.js";
import type { HubDriver, HubExecutionObservation, HubSubmitRequest } from "./types.js";

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
  async probe(): Promise<void> {}
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
    await f.hub.tick(); expect(f.hub.inspect(a.id).blocker).toMatch(/retry deadline/);
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
