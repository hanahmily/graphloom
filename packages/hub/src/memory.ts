// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Memory containment of a managed launch (docs/design-run-hub.md §6.2): the
 * limits the hub writes on each launch cgroup, what the cgroup recorded when
 * the launch ended, and how that reads to an operator.
 */
const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/** `launchMemoryHigh`'s default: the kernel throttles and reclaims a launch above it. */
export const DEFAULT_LAUNCH_MEMORY_HIGH = 4 * GiB;
/** `launchMemoryMax`'s default: the kernel OOM-kills the launch (its whole group) at it. */
export const DEFAULT_LAUNCH_MEMORY_MAX = 6 * GiB;
/** The smallest limit the hub accepts: a launch's controller and plugin worker alone need more. */
export const MIN_MEMORY_LIMIT = 256 * MiB;

/** A launch cgroup's limits in bytes; `null` is `max` (no limit). */
export interface HubMemoryLimits { high: number | null; max: number | null; }

/** What a launch cgroup recorded about memory when it was read (its `memory.events` and limits). */
export interface HubLaunchMemory {
  /** `memory.events` `oom`: times the cgroup reached its own `memory.max`. */
  oom: number;
  /** `memory.events` `oom_kill`: its processes any OOM killer killed. */
  oomKill: number;
  /** `memory.events` `oom_group_kill`: whole-group kills (`memory.oom.group`). */
  oomGroupKill: number;
  /** `memory.max`; null when `max`. */
  maxBytes?: number | null;
  /** `memory.peak`, on kernels that have it (5.19 and later). */
  peakBytes?: number;
}

/**
 * A memory size: a whole number of bytes, or a string with a binary unit
 * suffix as systemd takes it (`512M`, `4G`, `1.5G`; `K`, `M`, `G`, `T`, each
 * 1024-based), or `max`/`infinity` for no limit (`null`).
 */
export function parseMemorySize(value: unknown, label: string): number | null {
  let bytes: number;
  if (typeof value === "number") bytes = value;
  else if (typeof value === "string") {
    const text = value.trim();
    if (/^(max|infinity)$/i.test(text)) return null;
    const match = /^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$/i.exec(text);
    if (!match) throw new Error(`${label} must be bytes, a size such as 512M or 4G, or "max"`);
    const unit = { "": 1, K: KiB, M: MiB, G: GiB, T: 1024 * GiB }[match[2]!.toUpperCase() as "" | "K" | "M" | "G" | "T"];
    bytes = Math.floor(Number(match[1]) * unit);
  } else throw new Error(`${label} must be bytes, a size such as 512M or 4G, or "max"`);
  if (!Number.isSafeInteger(bytes) || bytes < MIN_MEMORY_LIMIT) throw new Error(`${label} must be at least ${formatBytes(MIN_MEMORY_LIMIT)}`);
  return bytes;
}

/** Bytes as an operator reads them: `6 GiB`, `1.5 GiB`, `512 MiB`; `null` reads `no limit`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "no limit";
  for (const [unit, size] of [["TiB", 1024 * GiB], ["GiB", GiB], ["MiB", MiB], ["KiB", KiB]] as const) {
    if (bytes >= size) {
      const value = bytes / size;
      return `${Number.isInteger(value) ? value : Number(value.toFixed(1))} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/** A size as systemd takes it (`MemoryMax=8G`): whole units where exact, else bytes; `null` is `infinity`. */
export function systemdSize(bytes: number | null): string {
  if (bytes === null) return "infinity";
  for (const [unit, size] of [["T", 1024 * GiB], ["G", GiB], ["M", MiB], ["K", KiB]] as const) if (bytes % size === 0) return `${bytes / size}${unit}`;
  return String(bytes);
}

/** A cgroup limit file's value: `max` is null. */
export function parseCgroupLimit(text: string): number | null {
  const value = text.trim();
  if (value === "max") return null;
  const bytes = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes)) throw new Error(`unexpected cgroup memory value ${JSON.stringify(value.slice(0, 32))}`);
  return bytes;
}

/** `memory.events`' counters. */
export function parseMemoryEvents(text: string): Pick<HubLaunchMemory, "oom" | "oomKill" | "oomGroupKill"> {
  const counter = (name: string) => Number(new RegExp(`^${name} (\\d+)$`, "m").exec(text)?.[1] ?? 0);
  return { oom: counter("oom"), oomKill: counter("oom_kill"), oomGroupKill: counter("oom_group_kill") };
}

/** What a launch cgroup recorded; undefined when it has no memory controller files (or is gone). */
export async function readLaunchMemory(directory: string): Promise<HubLaunchMemory | undefined> {
  let events: string;
  try { events = await readFile(path.join(directory, "memory.events"), "utf8"); }
  catch { return undefined; }
  const memory: HubLaunchMemory = parseMemoryEvents(events);
  try { memory.maxBytes = parseCgroupLimit(await readFile(path.join(directory, "memory.max"), "utf8")); } catch { /* Unreadable: unknown. */ }
  try {
    const peak = parseCgroupLimit(await readFile(path.join(directory, "memory.peak"), "utf8"));
    if (peak !== null) memory.peakBytes = peak;
  } catch { /* Older kernels have no memory.peak. */ }
  return memory;
}

/** A launch memory record (the driver's, or one read back from disk), checked before it is used. */
export function validLaunchMemory(value: unknown): value is HubLaunchMemory {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  return count(m.oom) && count(m.oomKill) && count(m.oomGroupKill)
    && (m.maxBytes === undefined || m.maxBytes === null || count(m.maxBytes))
    && (m.peakBytes === undefined || count(m.peakBytes));
}

/**
 * How memory ended a launch, or undefined when no OOM killer touched it.
 * `limit`: the launch reached its own `memory.max` (`memory limit reached
 * (<limit>)`); `outside`: an OOM killer outside the launch's own limit (the
 * service's MemoryMax, or the host running out) killed it.
 */
export function launchMemoryEnd(memory: HubLaunchMemory | undefined): { kind: "limit" | "outside"; text: string } | undefined {
  if (memory === undefined || (memory.oomKill === 0 && memory.oomGroupKill === 0)) return undefined;
  const peak = memory.peakBytes !== undefined ? `; peak ${formatBytes(memory.peakBytes)}` : "";
  if (memory.oom > 0) {
    return { kind: "limit", text: `memory limit reached (${formatBytes(memory.maxBytes)}): the kernel killed the launch at its cgroup's memory.max (launchMemoryMax)${peak}` };
  }
  return { kind: "outside", text: `killed by the out-of-memory killer outside the launch's own limit (the hub service's MemoryMax, or the host out of memory)${peak}` };
}
