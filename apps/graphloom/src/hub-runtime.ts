// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isClaimStale, readOwnerClaim, releaseManagedRun } from "@graphloom/controller";
import { createLinuxHubDriver, formatBytes, launchCgroupPath, parseCgroupLimit, parseMemoryEvents, type HubDriver } from "@graphloom/hub";
import type { HubLaunch, HubSubmission, HubObservation, MonitorSnapshot, MonitorSeries } from "@graphloom/sdk";
import type { HubServiceConfig } from "./hub-config.js";
import { boundedText, verifyHubInput, verifyHubTaskInput } from "./hub-input.js";
import { createCliRunner } from "./cli-runner.js";
import { loadRunnerConfig } from "./runner-config.js";
import type { OwnedMonitorResult } from "./hub-observe.js";
import { observeInitialization } from "./hub-initialization.js";
import { preparePluginLink, settlePluginLink } from "./hub-plugin.js";
import { readLaunchReport } from "./hub-launch-report.js";
import { selfInstall, type SelfInstall } from "./ownership.js";

const exec = promisify(execFile);
export interface HubMonitorCache { snapshot?: MonitorSnapshot; error?: string; refreshedAt?: number; }

/** Disposable observations have a global bound as well as per-frame byte limits. */
export function cacheMonitor(cache: Map<string, HubMonitorCache>, id: string, value: HubMonitorCache): void {
  cache.delete(id); cache.set(id, { ...value, refreshedAt: Date.now() });
  while (cache.size > 64) cache.delete(cache.keys().next().value!);
}

export function createHubRuntime(config: HubServiceConfig, wake: () => void): { driver: HubDriver; cache: Map<string, HubMonitorCache>; monitor(submission: HubSubmission): Promise<OwnedMonitorResult> } {
  const cache = new Map<string, HubMonitorCache>();
  const samples = new Map<string, { launch: string; cpu?: number; at?: number; memory: MonitorSeries["samples"]; cpuSeries: MonitorSeries["samples"] }>();
  const capabilities = new Set<string>();
  const readObservation = createExecutionObservationReader();
  const processFrames = new Map<string, MonitorSnapshot>();
  const stateDir = (submission: HubSubmission) => path.join(config.directory, "runs", submission.runId);
  const observe = async (launch: HubLaunch, submission: HubSubmission) => {
    const directory = stateDir(submission);
    const owner = await readOwnerClaim(directory);
    const ownerGone = owner === undefined || isClaimStale(owner);
    let observation;
    try {
      observation = await readObservation(submission);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { observation = await observeInitialization(directory, submission, launch); }
        catch (failure) { return { ownerGone, externalStopped: false, reason: `initialization observation failed: ${String(failure)}` }; }
      } else return { ownerGone, externalStopped: false, reason: `owning runtime observation failed: ${String(error)}` };
    }
    // Resource samples use tiny cgroup counters; panel projection is only on demand.
    const frame: MonitorSnapshot = { schemaVersion: 1, frameId: launch.id, observedAt: new Date().toISOString(), run: { id: submission.runId, status: "unknown" }, sources: [] };
    await addProcessMetrics(frame, launch, samples, config.cgroupRoot);
    processFrames.set(submission.id, frame);
    // A launch that ended reports how (§6.1); the hub reads it only once the controller is gone.
    const report = ownerGone ? await readLaunchReport(config.directory, submission.id, launch) : undefined;
    return { ownerGone, externalStopped: false, ...(observation !== undefined ? { observation } : {}), ...(report !== undefined ? { report } : {}) };
  };
  const cleanup = async (launch: HubLaunch, submission: HubSubmission, observed?: Awaited<ReturnType<typeof observe>>) => {
    const result = observed ?? await observe(launch, submission);
    if (!result.ownerGone) return result;
    try {
      const cleanupResult = await runtimeJson<{ drained: boolean; resources: string[] }>(submission, "__hub-cleanup", [stateDir(submission), submission.runId, submission.input.runtimeConfig?.runner?.path ?? "", ...(submission.input.rehearsal !== undefined ? ["--rehearsal"] : [])]);
      if (cleanupResult.drained) { samples.delete(submission.runId); processFrames.delete(submission.id); }
      return { ...result, externalStopped: cleanupResult.drained, ...(cleanupResult.drained ? {} : { reason: cleanupResult.resources.join("; ").slice(0, 1024) }) };
    } catch (error) { return { ...result, externalStopped: false, reason: `external cleanup remains unverified: ${String(error).slice(0, 900)}` }; }
  };
  const driver = createLinuxHubDriver({
    directory: config.directory, cgroupRoot: config.cgroupRoot, onWake: wake, observe, cleanup,
    memory: { high: config.launchMemoryHigh ?? null, max: config.launchMemoryMax ?? null },
    settleInput: settlePluginLink,
    async command(launch, submission) {
      const command = await verifyHubExecutionInput(submission, { initial: launch.mode === "initial", upgrade: launch.command?.remedy?.upgrade === true });
      const key = JSON.stringify(command);
      if (!capabilities.has(key)) {
        const { stdout } = await exec(command.executable, [...command.args, "__hub-capabilities"], { timeout: 15_000, maxBuffer: 4096 });
        const value = JSON.parse(stdout) as { managedProtocol?: number; runtime?: { root?: string; version?: string } };
        if (value.managedProtocol !== 1) throw new Error("pinned runtime does not support managed launch protocol 1");
        if (value.runtime?.root !== command.root || value.runtime.version !== command.version) throw new Error("selected executable does not match the run's runtime identity");
        capabilities.add(key);
      }
      // Before the child starts: an accepted --update-plugin moves the run's private plugin link.
      await preparePluginLink(launch, submission);
      return { ...command, args: [...command.args, "__hub-managed", config.directory, submission.id], cwd: config.directory, env: { ...process.env } };
    },
  });
  return { driver, cache, async monitor(submission) {
    const result = await readSubmissionMonitor(submission);
    const frame = processFrames.get(submission.id);
    if (result.snapshot && frame) {
      result.snapshot.sources.push(...frame.sources);
      result.snapshot.usage ??= { metrics: [] };
      result.snapshot.usage.metrics.push(...frame.usage!.metrics);
      if (frame.usage?.series) result.snapshot.usage.series = frame.usage.series;
      if (frame.usage?.coverage) result.snapshot.usage.coverage = frame.usage.coverage;
    }
    return result;
  } };
}

/** A controller save atomically replaces state.json. Cache only an unchanged file
 * identity; owner liveness and containment are still checked on every poll. */
export function createExecutionObservationReader(read: (submission: HubSubmission) => Promise<HubObservation> = readExecutionObservation) {
  const values = new Map<string, { revision: string; observation: HubObservation }>();
  const revision = async (file: string) => {
    const value = await stat(file, { bigint: true });
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");
  };
  return async (submission: HubSubmission): Promise<HubObservation> => {
    const file = path.join(path.dirname(path.dirname(path.dirname(submission.input.taskFile))), "runs", submission.runId, "state.json");
    const before = await revision(file);
    const cached = values.get(file);
    if (cached?.revision === before) return structuredClone(cached.observation);
    values.delete(file);
    const observation = await read(submission);
    if (observation.protocolVersion !== 1) throw new Error("owning runtime returned an incompatible execution observation");
    if (await revision(file) === before) {
      values.set(file, { revision: before, observation });
      while (values.size > 64) values.delete(values.keys().next().value!);
    }
    return structuredClone(observation);
  };
}

const observationCapabilities = new Map<string, boolean>();
async function readExecutionObservation(submission: HubSubmission): Promise<HubObservation> {
  const runtime = await runtimeCommand(submission);
  const key = JSON.stringify(runtime);
  let supported = observationCapabilities.get(key);
  if (supported === undefined) {
    const { stdout } = await exec(runtime.executable, [...runtime.args, "__hub-capabilities"], { timeout: 15000, maxBuffer: 4096 });
    supported = (JSON.parse(stdout) as { executionObservation?: number }).executionObservation === 1;
    observationCapabilities.set(key, supported);
    while (observationCapabilities.size > 64) observationCapabilities.delete(observationCapabilities.keys().next().value!);
  }
  const directory = path.join(path.dirname(path.dirname(path.dirname(submission.input.taskFile))), "runs", submission.runId);
  const { stdout } = await exec(runtime.executable, [...runtime.args, "__hub-observe", directory, ...(supported ? ["--execution-only"] : [])], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  return (JSON.parse(stdout) as OwnedMonitorResult).observation;
}

interface RuntimeCommand { executable: string; args: string[]; root: string; version: string; }

/** The daemon and child use the same selection; an upgrade never depends on the removed original installation. */
export async function verifyHubExecutionInput(submission: HubSubmission, options: { initial: boolean; upgrade?: boolean; requireCurrent?: boolean }, self: SelfInstall = selfInstall()): Promise<RuntimeCommand> {
  if (options.initial && options.upgrade) throw new Error("an initial launch cannot upgrade an existing run");
  const command = await runtimeCommand(submission, options.upgrade === true, self, options.initial);
  const original = command.root === submission.input.runtimeRoot && command.version === submission.input.runtimeVersion;
  if (options.initial || (original && !options.upgrade)) await verifyHubInput(submission.input, options.initial);
  else await verifyHubTaskInput(submission.input, false);
  if (options.requireCurrent && (self.record.root !== command.root || self.record.version !== command.version)) throw new Error("managed child is not the selected owning runtime");
  return command;
}

async function runtimeCommand(submission: HubSubmission, upgrade = false, self: SelfInstall = selfInstall(), initial = false): Promise<RuntimeCommand> {
  const input = submission.input;
  const directory = path.join(path.dirname(path.dirname(path.dirname(input.taskFile))), "runs", submission.runId);
  let owner = { root: input.runtimeRoot, version: input.runtimeVersion };
  if (!initial) {
    let raw: { runId?: unknown; install?: { root?: unknown; version?: unknown } } | undefined;
    try { raw = JSON.parse(await boundedText(path.join(directory, "state.json"), 64 * 1024 * 1024)) as typeof raw; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (raw !== undefined) {
      if (raw.runId !== submission.runId) throw new Error("managed run identity does not match its submission");
      if (raw.install !== undefined) {
        if (typeof raw.install.root !== "string" || !path.isAbsolute(raw.install.root) || typeof raw.install.version !== "string" || raw.install.version.length === 0) throw new Error("managed run has an invalid owning runtime identity");
        owner = { root: raw.install.root, version: raw.install.version };
      }
    }
  }
  if (upgrade) owner = self.record;
  if (!owner.root || !owner.version || !path.isAbsolute(owner.root)) throw new Error("captured runtime has no valid installation identity");
  const selected = selfInstall(owner.root);
  if (selected.record.version !== owner.version || selected.record.root !== owner.root) throw new Error("owning runtime identity changed; restore that exact installation or explicitly resume --upgrade");
  const main = path.join(owner.root, "apps", "graphloom", "dist", "main.js");
  await access(main);
  if (!upgrade && owner.root === input.runtimeRoot && owner.version === input.runtimeVersion) {
    if (!input.runtimeNode || input.runtimePath !== main) throw new Error("captured runtime executable does not match its installation identity");
    return { executable: input.runtimeNode, args: [main], root: owner.root, version: owner.version };
  }
  if (owner.root === self.record.root && owner.version === self.record.version) return { executable: process.execPath, args: [main], root: owner.root, version: owner.version };
  // Managed dispatch deliberately requires the recorded root: another tree of the same version is not an implicit upgrade.
  if (selected.home !== undefined) {
    const executable = path.join(owner.root, "bin", "graphloom");
    await access(executable);
    return { executable, args: [], root: owner.root, version: owner.version };
  }
  return { executable: process.execPath, args: [main], root: owner.root, version: owner.version };
}

async function runtimeJson<T>(submission: HubSubmission, command: string, args: string[]): Promise<T> {
  const runtime = await runtimeCommand(submission);
  const { stdout } = await exec(runtime.executable, [...runtime.args, command, ...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

export async function readSubmissionMonitor(submission: HubSubmission): Promise<OwnedMonitorResult> {
  const directory = path.join(path.dirname(path.dirname(path.dirname(submission.input.taskFile))), "runs", submission.runId);
  const result = await runtimeJson<OwnedMonitorResult>(submission, "__hub-observe", [directory]);
  if (result.observation.protocolVersion !== 1) throw new Error("owning runtime returned an incompatible execution observation");
  if (result.snapshot !== undefined) monitoredSnapshot(result, submission);
  return result;
}

function monitoredSnapshot(result: OwnedMonitorResult, submission: HubSubmission): MonitorSnapshot {
  if (result.snapshot === undefined) throw new Error(result.monitoringError ?? "owning runtime monitoring data is unavailable");
  if (result.snapshot.schemaVersion !== 1 || result.snapshot.run.id !== submission.runId) throw new Error("owning runtime returned an incompatible monitoring response");
  return result.snapshot;
}

/** Separate read-only-runtime command: cleanup never loads graph code or starts a job. */
export async function cleanupOwnedRun(stateDir: string, runId: string, runnerConfigFile: string, rehearsal = false): Promise<{ drained: boolean; resources: string[] }> {
  if (path.basename(stateDir) !== runId) throw new Error("cleanup run identity mismatch");
  const owner = await readOwnerClaim(stateDir);
  if (owner !== undefined && !isClaimStale(owner)) return { drained: false, resources: ["controller still owns the run"] };
  // A rehearsal pins a runner config only when the operator has one (B2 probes it); without one, the
  // cleanup contract of the built-in executors its stand-ins replace is checked on its own.
  const config = rehearsal && !runnerConfigFile
    ? { harness: "pi" as const, allowUnrestricted: true as const }
    : await loadRunnerConfig({ ...process.env, ...(runnerConfigFile ? { GRAPHLOOM_RUNNER_CONFIG: runnerConfigFile } : {}) });
  if (!config) return { drained: false, resources: ["runner configuration unavailable for external cleanup"] };
  return releaseManagedRun(createCliRunner(config), runId, stateDir);
}

/** A launch cgroup's memory limits, peak and OOM kills, each unknown when unreadable. */
async function readLaunchLimits(directory: string): Promise<{ max?: number | null; high?: number | null; peak?: number; oomKill?: number }> {
  const read = async (file: string) => { try { return parseCgroupLimit(await readFile(path.join(directory, file), "utf8")); } catch { return undefined; } };
  const [max, high, peak] = await Promise.all([read("memory.max"), read("memory.high"), read("memory.peak")]);
  let oomKill: number | undefined;
  try { oomKill = parseMemoryEvents(await readFile(path.join(directory, "memory.events"), "utf8")).oomKill; } catch { oomKill = undefined; }
  return { ...(max !== undefined ? { max } : {}), ...(high !== undefined ? { high } : {}), ...(peak !== undefined && peak !== null ? { peak } : {}), ...(oomKill !== undefined ? { oomKill } : {}) };
}

export async function addProcessMetrics(snapshot: MonitorSnapshot, launch: HubLaunch, samples: Map<string, { launch: string; cpu?: number; at?: number; memory: MonitorSeries["samples"]; cpuSeries: MonitorSeries["samples"] }>, root: string): Promise<void> {
  const observedAt = new Date().toISOString();
  const now = Date.now();
  let state = samples.get(snapshot.run.id);
  if (!state || state.launch !== launch.id) state = { launch: launch.id, memory: [], cpuSeries: [] };
  let memory: number | null = null;
  let cpuPercent: number | null = null;
  const limits = await readLaunchLimits(launchCgroupPath(root, launch.id));
  try {
    const [memoryText, cpuText] = await Promise.all([readFile(path.join(launchCgroupPath(root, launch.id), "memory.current"), "utf8"), readFile(path.join(launchCgroupPath(root, launch.id), "cpu.stat"), "utf8")]);
    const bytes = Number(memoryText.trim());
    if (Number.isSafeInteger(bytes) && bytes >= 0) memory = bytes;
    const cpu = Number(/^usage_usec (\d+)$/m.exec(cpuText)?.[1]);
    if (Number.isFinite(cpu) && state.cpu !== undefined && state.at !== undefined && now > state.at && cpu >= state.cpu) cpuPercent = (cpu - state.cpu) / ((now - state.at) * 10);
    if (Number.isFinite(cpu)) state.cpu = cpu;
  } catch { delete state.cpu; }
  state.at = now;
  state.memory = [...state.memory, { at: observedAt, value: memory }].slice(-120);
  state.cpuSeries = [...state.cpuSeries, { at: observedAt, value: cpuPercent }].slice(-120);
  samples.set(snapshot.run.id, state);
  snapshot.sources = snapshot.sources.filter((source) => source.id !== "process");
  snapshot.sources.push({ id: "process", status: memory === null ? "unavailable" : "available", observedAt, detail: "launch cgroup; external Docker containers are excluded" });
  snapshot.usage ??= { metrics: [] };
  snapshot.usage.metrics.push(
    { id: "rss", label: "Launch memory", value: memory, unit: "bytes", source: "cgroup memory.current; external containers excluded", exactness: "reported" },
    { id: "cpu", label: "Launch CPU (100% = one core)", value: cpuPercent, unit: "%", source: "cgroup cpu.stat; external containers excluded", exactness: "reported" },
    // The peak against the limit (docs/design-run-hub.md §6.2): how close the launch came to an OOM kill.
    { id: "memory-peak", label: `Launch memory peak (limit ${formatBytes(limits.max)}${limits.high !== null && limits.high !== undefined ? `, throttled above ${formatBytes(limits.high)}` : ""})`, value: limits.peak ?? null, unit: "bytes", source: "cgroup memory.peak against memory.max", exactness: "reported" },
    { id: "memory-limit", label: "Launch memory limit (memory.max; unknown = no limit)", value: limits.max ?? null, unit: "bytes", source: "cgroup memory.max (hub.json launchMemoryMax)", exactness: "reported" },
    ...(limits.oomKill ? [{ id: "memory-oom-kills", label: "Launch processes OOM-killed", value: limits.oomKill, unit: "processes", source: "cgroup memory.events oom_kill", exactness: "reported" as const }] : []),
  );
  if (memory !== null && limits.max !== undefined) snapshot.usage.coverage = `launch cgroup memory ${formatBytes(memory)} now, peak ${limits.peak !== undefined ? formatBytes(limits.peak) : "unknown"} of ${formatBytes(limits.max)}; external Docker containers are excluded (each has its own --memory)`;
  snapshot.usage.series = [
    { id: "memory", label: "Launch memory", unit: "bytes", source: "cgroup memory.current", samples: state.memory, aggregation: "max", coverage: "external containers excluded" },
    { id: "cpu", label: "Launch CPU", unit: "%", source: "cgroup cpu.stat", samples: state.cpuSeries, aggregation: "time-weighted", coverage: "100% = one CPU core; external containers excluded" },
  ];
}
