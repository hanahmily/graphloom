// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A real hub service on a temporary directory and socket, never the operator's, whose driver starts the compiled
 * CLI's managed bootstrap (`__hub-managed`) as a plain child: the Linux driver's protocol without its cgroups. The
 * hub queues, reserves, launches, observes and continues submissions exactly as the service does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach } from "vitest";
import type { HubDriver, HubExecutionObservation, HubGrantMessage } from "@graphloom/hub";
import type { HubLaunch, HubRehearsalVerdict, HubSubmission } from "@graphloom/sdk";
import type { HubServiceConfig } from "../src/hub-config.js";
import { hubRequest } from "../src/hub-client.js";
import { observeOwnedRun } from "../src/hub-observe.js";
import { serveHub, type HubService } from "../src/hub-server.js";
import { repoRoot } from "./cli-env.js";

const main = path.join(repoRoot, "apps/graphloom/dist/main.js");

/** The child environment: the test's own without GraphLoom or Claude settings, on a temporary HOME. */
export function childEnvironment(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GRAPHLOOM_") && !name.startsWith("CLAUDE_")));
  return { ...inherited, HOME: home, TMPDIR: home, ...extra };
}

/** A submission as `GET /v1/submissions/<id>` answers it. */
export type ObservedSubmission = HubSubmission & { rehearsalVerdict?: HubRehearsalVerdict };

export interface TestHub {
  directory: string;
  socket: string;
  driver: ManagedChildDriver;
}

/**
 * A hub driver that starts the compiled CLI's real managed bootstrap as a plain child, grants it over fd 3, and
 * reads the run's observation once it exits.
 */
export class ManagedChildDriver implements HubDriver {
  readonly logs = new Map<string, string>();
  private readonly launches = new Map<string, { child: ChildProcess; control: Duplex; exited: boolean }>();
  constructor(private readonly directory: string, private readonly env: NodeJS.ProcessEnv, private readonly children: ChildProcess[]) {}
  async probe(): Promise<void> {}
  async prepare(launch: HubLaunch, submission: HubSubmission) {
    const child = spawn(process.execPath, [main, "__hub-managed", this.directory, submission.id], { cwd: this.directory, env: this.env, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    this.children.push(child);
    const control = child.stdio[3] as Duplex;
    control.on("error", () => undefined); control.resume();
    const entry = { child, control, exited: false };
    this.launches.set(launch.id, entry);
    this.logs.set(launch.id, "");
    child.stdout!.resume();
    child.stderr!.on("data", (chunk: Buffer) => { this.logs.set(launch.id, `${this.logs.get(launch.id)}${chunk.toString()}`); });
    child.once("close", () => { entry.exited = true; });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    return { bootId: "test-boot", pid: child.pid!, startTime: "1" };
  }
  async grant(launch: HubLaunch, submission: HubSubmission): Promise<void> {
    const message: HubGrantMessage = { protocolVersion: 1, type: "grant", hubId: submission.hubId, submissionId: submission.id, runId: submission.runId, launchId: launch.id, generation: launch.generation, automatic: launch.automatic };
    this.launches.get(launch.id)!.control.write(`${JSON.stringify(message)}\n`);
  }
  async inspect(launch: HubLaunch, submission: HubSubmission): Promise<HubExecutionObservation> {
    const entry = this.launches.get(launch.id);
    if (entry !== undefined && !entry.exited) return { execution: "live", ownerGone: false, externalStopped: false };
    try {
      const { observation } = await observeOwnedRun(path.join(this.directory, "runs", submission.runId), true);
      return { execution: "drained", ownerGone: true, externalStopped: true, observation };
    } catch { return { execution: "drained", ownerGone: true, externalStopped: true }; }
  }
  async stop(launch: HubLaunch, _submission: HubSubmission, reason: "pause" | "cancel" | "service-interruption", commandId: string): Promise<void> {
    this.launches.get(launch.id)?.control.write(`${JSON.stringify({ protocolVersion: 1, type: "stop", reason, commandId })}\n`);
  }
  async kill(launch: HubLaunch): Promise<void> { this.launches.get(launch.id)?.child.kill("SIGKILL"); }
  log(): string { return [...this.logs.values()].join("\n---\n"); }
}

/** Registers the cleanup of every hub, launch and directory a test makes in the calling file, and returns the hub's helpers. */
export function useTestHubs(): {
  /** A hub capturing tasks with the real intake and `runnerConfig`; its launches run in `env` (by default the child environment on the hub's directory). */
  startHub(runnerConfig: string, options?: { env?: NodeJS.ProcessEnv; maxConcurrentRuns?: number }): Promise<TestHub>;
  /** Waits until the submission is in one of `states` with no launch. */
  waitForState(hub: TestHub, id: string, states: string[], timeoutMs?: number): Promise<ObservedSubmission>;
} {
  const children: ChildProcess[] = [];
  const services: HubService[] = [];
  const folders: string[] = [];
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const service of services.splice(0)) await service.close().catch(() => undefined);
    await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
  });
  return {
    async startHub(runnerConfig, options = {}) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "gl-hub-rh-")); folders.push(directory);
      const config: HubServiceConfig = {
        directory, socket: path.join(directory, "hub.sock"), cgroupRoot: "/not-used", maxConcurrentRuns: options.maxConcurrentRuns ?? 2, runnerConfig,
        retry: { automatic: true, maxAutomaticResumes: 2, maxElapsedMs: 600_000, baseDelayMs: 1000, maxDelayMs: 2000 }, pollIntervalMs: 250, shutdownGraceMs: 0,
      };
      const driver = new ManagedChildDriver(directory, options.env ?? childEnvironment(directory), children);
      const service = await serveHub({ config, driver, environment: { HOME: directory, PATH: process.env.PATH } });
      services.push(service);
      return { directory, socket: service.socket, driver };
    },
    async waitForState(hub, id, states, timeoutMs = 150_000) {
      const until = Date.now() + timeoutMs;
      let last: ObservedSubmission | undefined;
      while (Date.now() < until) {
        last = await hubRequest<ObservedSubmission>("GET", `/v1/submissions/${id}`, undefined, hub.socket);
        if (states.includes(last.state) && last.launch === undefined) return last;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`submission ${id} did not reach ${states.join("/")}: ${JSON.stringify(last)}\n${hub.driver.log()}`);
    },
  };
}
