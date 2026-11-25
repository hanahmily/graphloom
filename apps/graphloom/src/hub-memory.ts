// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The hub's memory containment as an operator sees it (docs/design-run-hub.md
 * §6.2, §9.1): the service's own limits and use, each launch's, the warnings
 * `hub status` and `hub doctor` show, and the `hub service --limits` drop-in.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatBytes, launchCgroupPath, parseCgroupLimit, parseMemoryEvents, systemdSize } from "@graphloom/hub";
import type { HubMemorySummary, HubSubmission } from "@graphloom/sdk";
import type { DoctorCheck } from "./doctor.js";
import type { HubServiceConfig } from "./hub-config.js";

/** What the service needs beyond its launches: the hub process, its observe and doctor children. */
export const SERVICE_MEMORY_HEADROOM = 1024 * 1024 * 1024;

type Limits = Pick<HubServiceConfig, "launchMemoryHigh" | "launchMemoryMax" | "serviceMemoryHigh" | "serviceMemoryMax" | "maxConcurrentRuns">;

/**
 * The service's MemoryHigh/MemoryMax `hub service --limits` writes: hub.json's
 * `serviceMemoryHigh`/`serviceMemoryMax`, else each launch limit times the
 * concurrency limit (at least one) plus 1 GiB for the hub itself. A launch limit
 * of `max` derives `infinity`.
 */
export function serviceMemoryLimits(config: Limits): { high: number | null; max: number | null; derived: { high: boolean; max: boolean } } {
  const slots = Math.max(1, config.maxConcurrentRuns);
  const derive = (launch: number | null | undefined) => launch === null || launch === undefined ? null : launch * slots + SERVICE_MEMORY_HEADROOM;
  const high = config.serviceMemoryHigh !== undefined ? config.serviceMemoryHigh : derive(config.launchMemoryHigh);
  let max = config.serviceMemoryMax !== undefined ? config.serviceMemoryMax : derive(config.launchMemoryMax);
  // A derived max is never below the high it pairs with.
  if (config.serviceMemoryMax === undefined && max !== null && high !== null && high > max) max = high;
  return { high, max, derived: { high: config.serviceMemoryHigh === undefined, max: config.serviceMemoryMax === undefined } };
}

/** The drop-in `graphloom-hub.service.d/10-limits.conf`: the service's memory limits. */
export function limitsDropIn(config: Limits, at: Date = new Date()): string {
  const limits = serviceMemoryLimits(config);
  const how = (derived: boolean, field: string) => derived ? `derived: launch ${field === "MemoryHigh" ? "launchMemoryHigh" : "launchMemoryMax"} x maxConcurrentRuns ${Math.max(1, config.maxConcurrentRuns)} + ${formatBytes(SERVICE_MEMORY_HEADROOM)}` : `hub.json ${field === "MemoryHigh" ? "serviceMemoryHigh" : "serviceMemoryMax"}`;
  return [
    `# Written by graphloom hub service --limits on ${at.toISOString()}.`,
    `# MemoryHigh (${how(limits.derived.high, "MemoryHigh")}); MemoryMax (${how(limits.derived.max, "MemoryMax")}).`,
    "# Named 10-... so a value set with systemctl --user set-property (a 50-Memory*.conf drop-in under",
    "# ~/.config/systemd/user.control/) sorts later and takes precedence over this file.",
    "[Service]",
    "MemoryAccounting=yes",
    `MemoryHigh=${systemdSize(limits.high)}`,
    `MemoryMax=${systemdSize(limits.max)}`,
    "",
  ].join("\n");
}

async function readLimit(file: string): Promise<number | null | undefined> {
  try { return parseCgroupLimit(await readFile(file, "utf8")); } catch { return undefined; }
}

/** The service's and each live launch's memory, read from the hub's cgroups, with what is wrong with them. */
export async function summarizeHubMemory(config: Pick<HubServiceConfig, "cgroupRoot" | "launchMemoryHigh" | "launchMemoryMax">, maxConcurrentRuns: number, submissions: readonly HubSubmission[]): Promise<HubMemorySummary> {
  const root = config.cgroupRoot;
  const service: HubMemorySummary["service"] = { cgroup: root };
  const [high, max, current, peak] = await Promise.all(["memory.high", "memory.max", "memory.current", "memory.peak"].map((name) => readLimit(path.join(root, name))));
  if (high !== undefined) service.high = high;
  if (max !== undefined) service.max = max;
  if (current !== undefined && current !== null) service.current = current;
  if (peak !== undefined && peak !== null) service.peak = peak;
  if (max === undefined) service.error = `the service's memory controller files are not readable under ${root}`;
  const launches: HubMemorySummary["launches"] = [];
  for (const submission of submissions) {
    const launch = submission.launch;
    if (!launch) continue;
    let directory: string;
    try { directory = launchCgroupPath(root, launch.id); } catch { continue; }
    const [launchMax, launchCurrent, launchPeak] = await Promise.all(["memory.max", "memory.current", "memory.peak"].map((name) => readLimit(path.join(directory, name))));
    let oomKills: number | undefined;
    try { oomKills = parseMemoryEvents(await readFile(path.join(directory, "memory.events"), "utf8")).oomKill; } catch { oomKills = undefined; }
    launches.push({
      submissionId: submission.id, launchId: launch.id,
      ...(launchCurrent != null ? { current: launchCurrent } : {}), ...(launchPeak != null ? { peak: launchPeak } : {}),
      ...(launchMax !== undefined ? { max: launchMax } : {}), ...(oomKills !== undefined ? { oomKills } : {}),
    });
  }
  const summary: HubMemorySummary = { service, launch: { high: config.launchMemoryHigh ?? null, max: config.launchMemoryMax ?? null }, maxConcurrentRuns, launches, warnings: [] };
  summary.warnings = memoryWarnings(summary);
  return summary;
}

/** Unset or infinite limits, and launch limits the service limit cannot hold all at once. */
export function memoryWarnings(summary: Omit<HubMemorySummary, "warnings">): string[] {
  const warnings: string[] = [];
  const { service, launch } = summary;
  const slots = summary.maxConcurrentRuns;
  if (launch.max === null) warnings.push("launchMemoryMax is max: a launch has no memory limit and can take the host's memory (set launchMemoryMax in hub.json and restart the hub)");
  if (service.max === null) warnings.push("the hub service has no MemoryMax (infinity): its launches together are bounded only by the host (graphloom hub service --limits --write, or systemctl --user set-property graphloom-hub.service MemoryHigh=... MemoryMax=...)");
  else if (service.high === null) warnings.push(`the hub service has a MemoryMax (${formatBytes(service.max)}) but no MemoryHigh: it is killed at the limit without being throttled first (graphloom hub service --limits --write)`);
  if (launch.max !== null && service.max !== null && service.max !== undefined) {
    if (launch.max > service.max) warnings.push(`launchMemoryMax (${formatBytes(launch.max)}) is above the service's MemoryMax (${formatBytes(service.max)}): a launch never reaches its own limit; the service's is hit first`);
    else if (slots > 1 && launch.max * slots > service.max) warnings.push(`launchMemoryMax (${formatBytes(launch.max)}) x the concurrency limit (${slots}) = ${formatBytes(launch.max * slots)} exceeds the service's MemoryMax (${formatBytes(service.max)}): launches together can reach the service's limit, where the kernel kills one that is under its own (lower launchMemoryMax, graphloom hub limit ${Math.max(1, Math.floor(service.max / launch.max))}, or raise MemoryMax)`);
  }
  for (const item of summary.launches) if (item.oomKills) warnings.push(`launch ${item.launchId} of ${item.submissionId} has had ${item.oomKills} process${item.oomKills === 1 ? "" : "es"} OOM-killed`);
  return warnings;
}

/** `hub status`'s memory lines. */
export function memoryLines(summary: HubMemorySummary): string[] {
  const { service, launch } = summary;
  const value = (bytes: number | null | undefined) => bytes === undefined ? "unreadable" : formatBytes(bytes);
  return [
    `Memory: service MemoryHigh ${value(service.high)} · MemoryMax ${value(service.max)} · now ${value(service.current)}${service.peak !== undefined ? ` · peak ${formatBytes(service.peak)}` : ""}`,
    `Launch limits: memory.high ${formatBytes(launch.high)} · memory.max ${formatBytes(launch.max)} · concurrency ${summary.maxConcurrentRuns}`,
    ...summary.launches.map((item) => `  ${item.submissionId} ${item.launchId}: now ${value(item.current)} · peak ${value(item.peak)} of ${value(item.max)}${item.oomKills ? ` · ${item.oomKills} OOM-killed` : ""}`),
    ...(service.error ? [`Memory error: ${service.error}`] : []),
    ...summary.warnings.map((warning) => `Warning: ${warning}`),
  ];
}

/** `hub doctor`'s memory checks: each warning a warn, else one pass naming the limits. */
export function memoryChecks(summary: HubMemorySummary): DoctorCheck[] {
  const fix = "graphloom hub service --limits --write, or set launchMemoryHigh/launchMemoryMax in hub.json; then restart the hub";
  if (summary.service.error) return [{ section: "host", name: "hub memory", status: "warn", detail: summary.service.error, fix }];
  const checks: DoctorCheck[] = summary.warnings.map((warning) => ({ section: "host", name: "hub memory", status: "warn", detail: warning, fix }));
  if (checks.length === 0) {
    checks.push({ section: "host", name: "hub memory", status: "pass", detail: `service MemoryMax ${formatBytes(summary.service.max)}; each launch memory.max ${formatBytes(summary.launch.max)} (memory.high ${formatBytes(summary.launch.high)}) x ${summary.maxConcurrentRuns}` });
  }
  return checks;
}

/** A doctor report's checks with the memory checks after its host checks. */
export function withMemoryChecks(checks: DoctorCheck[], memory: DoctorCheck[]): DoctorCheck[] {
  const last = checks.map((check) => check.section).lastIndexOf("host");
  return last < 0 ? [...memory, ...checks] : [...checks.slice(0, last + 1), ...memory, ...checks.slice(last + 1)];
}
