// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HubDriver, HubExecutionObservation } from "@graphloom/hub";
import type { HubInput, HubLaunch, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import type { HubServiceConfig } from "../src/hub-config.js";
import { serveHub } from "../src/hub-server.js";
import type { HubDelivery } from "../src/hub-subscriptions.js";

export class SocketTestDriver implements HubDriver {
  executions = new Map<string, HubExecutionObservation>();
  grants: string[] = [];
  peak = 0;
  async probe(): Promise<void> {}
  async prepare(launch: HubLaunch) {
    this.executions.set(launch.id, { execution: "live", ownerGone: false, externalStopped: false });
    this.peak = Math.max(this.peak, [...this.executions.values()].filter(item => item.execution === "live").length);
    return { bootId: "test-boot", pid: 123, startTime: "456" };
  }
  async grant(launch: HubLaunch): Promise<void> { this.grants.push(launch.id); }
  async inspect(launch: HubLaunch): Promise<HubExecutionObservation> {
    return this.executions.get(launch.id) ?? { execution: "drained", ownerGone: true, externalStopped: true };
  }
  async stop(launch: HubLaunch): Promise<void> { this.executions.set(launch.id, { execution: "drained", ownerGone: true, externalStopped: true }); }
  async kill(launch: HubLaunch): Promise<void> { await this.stop(launch); }
  complete(submission: HubSubmission): void {
    if (!submission.launch) throw new Error("No fake execution to complete");
    this.executions.set(submission.launch.id, { execution: "drained", ownerGone: true, externalStopped: true,
      observation: { protocolVersion: 1, observedAt: new Date().toISOString(), stateRevision: 1, progressRevision: 1, status: "succeeded", continuation: { kind: "complete" } } });
  }
}
export function fakeInput(file = "/tasks/task.yaml"): HubInput {
  const task = "graph: hello\nrepo: ./repo\nrequest: Test one graph.\n";
  return { task, taskDigest: createHash("sha256").update(task).digest("hex"), taskPath: file, repoPath: "/repo", baseCommit: "a".repeat(40), bundlePath: "/bundle", bundleDigest: "b".repeat(64), runtimePath: "/runtime/main.js", runtimeDigest: "c".repeat(64) };
}
export async function socketEnvironment(cleanups: Array<() => Promise<void>>, limit = 3, setup?: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gl-hub-http-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config: HubServiceConfig = { directory, socket: path.join(directory, "hub.sock"), cgroupRoot: "/not-used", maxConcurrentRuns: limit,
    retry: { automatic: true, maxAutomaticResumes: 5, maxElapsedMs: 60000, baseDelayMs: 1000, maxDelayMs: 10000 }, pollIntervalMs: 1000, shutdownGraceMs: 0 };
  const driver = new SocketTestDriver();
  const deliveries: HubDelivery[] = [];
  await setup?.(directory);
  const service = await serveHub({ config, driver, deliver: async delivery => { deliveries.push(delivery); return { state: "accepted" }; }, captureInput: async file => fakeInput(file), observe: async submission => ({
    schemaVersion: 1, frameId: `${submission.runId}:fixture`, observedAt: "2026-11-20T12:00:00Z",
    run: { id: submission.runId, status: "running", graph: "hello", currentStage: "Write", currentAttempt: 1 },
    sources: [{ id: "fixture-controller", status: "available", observedAt: "2026-11-20T12:00:00Z" }],
    usage: { metrics: [{ id: "tokens", label: "Output", value: null, unit: "tokens", source: "not reported" }] },
  } satisfies MonitorSnapshot) });
  cleanups.push(() => service.close());
  return { service, driver, config, directory, deliveries, socket: service.socket };
}
