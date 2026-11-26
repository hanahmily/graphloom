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
import type { HubLaunchMemoryRecord, HubMemorySummary, HubRecordedMemory, HubSubmission, MonitorMetric, MonitorSnapshot } from "@graphloom/sdk";
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
  // A derived value never inverts the pair: a derived max is at least its high, and a derived high
  // under an explicit max is three quarters of it (MemoryHigh=6G under MemoryMax=8G).
  if (config.serviceMemoryMax === undefined && max !== null && high !== null && high > max) max = high;
  const bounded = config.serviceMemoryHigh === undefined && max !== null && (high === null || high > max) ? Math.floor(max * 3 / 4) : high;
  return { high: bounded, max, derived: { high: config.serviceMemoryHigh === undefined, max: config.serviceMemoryMax === undefined } };
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
export async function summarizeHubMemory(config: Pick<HubServiceConfig, "cgroupRoot" | "launchMemoryHigh" | "launchMemoryMax">, maxConcurrentRuns: number, submissions: readonly HubSubmission[], archived: ReadonlyArray<{ id: string; lastLaunchMemory?: HubLaunchMemoryRecord }> = []): Promise<HubMemorySummary> {
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
  const launchLimits = { high: config.launchMemoryHigh ?? null, max: config.launchMemoryMax ?? null };
  const recorded = recordedMemory([...submissions, ...archived], launchLimits.max);
  const summary: HubMemorySummary = { service, launch: launchLimits, maxConcurrentRuns, launches, ...(recorded !== undefined ? { recorded } : {}), warnings: [] };
  summary.warnings = memoryWarnings(summary);
  return summary;
}

/** The share of `launchMemoryMax` above which a recorded peak counts as near it. */
export const NEAR_MAX = 0.8;

/**
 * The recorded peaks of finished launches, one per submission (its latest),
 * against the current `launchMemoryMax`: the distribution to tune it by.
 * Undefined when no submission has a record.
 */
export function recordedMemory(items: ReadonlyArray<{ id: string; lastLaunchMemory?: HubLaunchMemoryRecord }>, launchMax: number | null): HubRecordedMemory | undefined {
  const records = items.flatMap((item) => item.lastLaunchMemory !== undefined ? [{ submissionId: item.id, record: item.lastLaunchMemory }] : []);
  if (records.length === 0) return undefined;
  const peaks = records.filter((item) => typeof item.record.peak === "number");
  const top = peaks.reduce<typeof peaks[number] | undefined>((best, item) => best === undefined || item.record.peak! > best.record.peak! ? item : best, undefined);
  return {
    launches: records.length, withPeak: peaks.length,
    ...(top !== undefined ? { highest: { submissionId: top.submissionId, launchId: top.record.launchId, recordedAt: top.record.recordedAt, peak: top.record.peak!, ...(top.record.max !== undefined ? { max: top.record.max } : {}) } } : {}),
    ...(launchMax !== null ? { nearMax: peaks.filter((item) => item.record.peak! >= launchMax * NEAR_MAX).length } : {}),
    oomKilled: records.filter((item) => item.record.oomKills > 0).length,
  };
}

/** A launch's recorded memory in one phrase: `peak 4.2 GiB of 6 GiB (throttled above 4 GiB), 2 OOM-killed`. */
export function recordedMemoryText(record: HubLaunchMemoryRecord): string {
  const limit = record.max === undefined ? "" : record.max === null ? " (no memory.max)" : ` of ${formatBytes(record.max)}`;
  const high = record.high !== undefined && record.high !== null ? ` (throttled above ${formatBytes(record.high)})` : "";
  const peak = record.peak !== undefined ? `peak ${formatBytes(record.peak)}${limit}${high}` : `peak unknown (no memory.peak on this kernel)${limit}${high}`;
  return `${peak}${record.oomKills > 0 ? `, ${record.oomKills} process${record.oomKills === 1 ? "" : "es"} OOM-killed${record.oom > 0 ? " at its memory.max" : ""}` : ", no OOM kill"}`;
}

/**
 * The usage panel's view of a submission's recorded launch memory (§6.2, §8). With
 * no launch running: its latest finished launch's peak, limits and OOM kills, read
 * from the record the hub kept at the launch's end; while one runs (its live cgroup
 * is in the panel already), the previous launch's recorded peak beside it. A new
 * usage object: the cached snapshot is never changed.
 */
export function withRecordedMemory(usage: MonitorSnapshot["usage"], submission: Pick<HubSubmission, "launch" | "lastLaunchMemory">): MonitorSnapshot["usage"] {
  const record = submission.lastLaunchMemory;
  if (record === undefined) return usage;
  const source = "the launch cgroup, recorded by the hub at the launch's end";
  const limits = `${record.max !== undefined ? `limit ${formatBytes(record.max)}` : "limit unknown"}${record.high !== undefined && record.high !== null ? `, throttled above ${formatBytes(record.high)}` : ""}`;
  const which = `launch ${record.launchId}, at its end ${record.recordedAt}`;
  const base = usage ?? { metrics: [] };
  // First, so a long usage page never pages them out.
  if (submission.launch !== undefined) {
    const previous: MonitorMetric = { id: "previous-launch-memory-peak", label: `Previous launch memory peak (${which}; ${limits}${record.oomKills > 0 ? `; ${record.oomKills} OOM-killed` : ""})`, value: record.peak ?? null, unit: "bytes", source, exactness: "settled" };
    return { ...base, metrics: [previous, ...base.metrics] };
  }
  const metrics: MonitorMetric[] = [
    { id: "recorded-memory-peak", label: `Recorded launch memory peak (${which}; ${limits})`, value: record.peak ?? null, unit: "bytes", source, exactness: "settled" },
    { id: "recorded-memory-limit", label: "Recorded launch memory limit (memory.max; unknown = no limit)", value: record.max ?? null, unit: "bytes", source, exactness: "settled" },
    ...(record.high !== undefined ? [{ id: "recorded-memory-high", label: "Recorded launch memory high (memory.high; unknown = no limit)", value: record.high ?? null, unit: "bytes", source, exactness: "settled" as const }] : []),
    { id: "recorded-memory-oom-kills", label: "Recorded launch processes OOM-killed", value: record.oomKills, unit: "processes", source, exactness: "settled" },
  ];
  const coverage = `no launch is running; recorded at the end of launch ${record.launchId} (${record.recordedAt}): ${recordedMemoryText(record)}`;
  return { ...base, metrics: [...metrics, ...base.metrics], coverage: base.coverage ? `${base.coverage}; ${coverage}` : coverage };
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
    ...(summary.recorded !== undefined ? [recordedLine(summary.recorded, launch.max)] : []),
    ...(service.error ? [`Memory error: ${service.error}`] : []),
    ...summary.warnings.map((warning) => `Warning: ${warning}`),
  ];
}

/** `hub status`'s line on the recorded peaks: the highest, and how many came near the current launchMemoryMax. */
function recordedLine(recorded: HubRecordedMemory, launchMax: number | null): string {
  const of = `the latest finished launch of ${recorded.launches} submission${recorded.launches === 1 ? "" : "s"} (live and archived)`;
  const top = recorded.highest;
  return [
    top !== undefined ? `Recorded launch peaks: highest ${formatBytes(top.peak)}${top.max !== undefined ? ` of ${formatBytes(top.max)}` : ""} (${top.submissionId} ${top.launchId}, ${top.recordedAt}) over ${of}` : `Recorded launch peaks: none readable over ${of} (no memory.peak on this kernel)`,
    ...(recorded.nearMax !== undefined && launchMax !== null ? [`${recorded.nearMax} within ${NEAR_MAX * 100}% of launchMemoryMax ${formatBytes(launchMax)}`] : []),
    `${recorded.oomKilled} OOM-killed`,
  ].join(" · ");
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
