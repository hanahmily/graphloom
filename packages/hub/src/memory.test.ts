// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatBytes, launchMemoryEnd, launchMemoryRecord, readLaunchMemory, parseCgroupLimit, parseMemoryEvents, parseMemorySize, systemdSize, validLaunchMemory } from "./memory.js";

const GiB = 1024 ** 3;

describe("launch memory sizes and outcomes", () => {
  it("parses bytes and systemd-style binary sizes, and max as no limit", () => {
    expect(parseMemorySize(6 * GiB, "x")).toBe(6 * GiB);
    expect(parseMemorySize("4G", "x")).toBe(4 * GiB);
    expect(parseMemorySize("1.5g", "x")).toBe(1.5 * GiB);
    expect(parseMemorySize("512M", "x")).toBe(512 * 1024 ** 2);
    expect(parseMemorySize("6GiB", "x")).toBe(6 * GiB);
    expect(parseMemorySize("max", "x")).toBeNull();
    expect(parseMemorySize("infinity", "x")).toBeNull();
    for (const bad of ["lots", "-1G", "4 X", true, {}, 1024, "1M"]) expect(() => parseMemorySize(bad, "launchMemoryMax")).toThrow(/launchMemoryMax/);
  });
  it("formats sizes for operators and for systemd", () => {
    expect(formatBytes(6 * GiB)).toBe("6 GiB");
    expect(formatBytes(1.5 * GiB)).toBe("1.5 GiB");
    expect(formatBytes(null)).toBe("no limit");
    expect(systemdSize(13 * GiB)).toBe("13G");
    expect(systemdSize(1536 * 1024 ** 2)).toBe("1536M");
    expect(systemdSize(null)).toBe("infinity");
  });
  it("reads cgroup files", () => {
    expect(parseCgroupLimit("max\n")).toBeNull();
    expect(parseCgroupLimit("6442450944\n")).toBe(6 * GiB);
    expect(() => parseCgroupLimit("nope")).toThrow();
    expect(parseMemoryEvents("low 0\nhigh 3\nmax 9\noom 2\noom_kill 5\noom_group_kill 1\n")).toEqual({ oom: 2, oomKill: 5, oomGroupKill: 1 });
    expect(parseMemoryEvents("low 0\n")).toEqual({ oom: 0, oomKill: 0, oomGroupKill: 0 });
  });
  it("names the cause: the launch's own limit, an OOM killer outside it, or none", () => {
    expect(launchMemoryEnd({ oom: 1, oomKill: 2, oomGroupKill: 1, maxBytes: 6 * GiB })?.text).toBe("memory limit reached (6 GiB): the kernel killed the launch at its cgroup's memory.max (launchMemoryMax)");
    expect(launchMemoryEnd({ oom: 0, oomKill: 0, oomGroupKill: 1, maxBytes: 6 * GiB, peakBytes: GiB })).toMatchObject({ kind: "outside", text: expect.stringContaining("; peak 1 GiB") });
    expect(launchMemoryEnd({ oom: 4, oomKill: 0, oomGroupKill: 0 })).toBeUndefined();
    expect(launchMemoryEnd(undefined)).toBeUndefined();
    expect(validLaunchMemory({ oom: 1, oomKill: 1, oomGroupKill: 0, maxBytes: null })).toBe(true);
    expect(validLaunchMemory({ oom: -1, oomKill: 1, oomGroupKill: 0 })).toBe(false);
    expect(validLaunchMemory({ oom: 0, oomKill: 0, oomGroupKill: 0, highBytes: null })).toBe(true);
    expect(validLaunchMemory({ oom: 0, oomKill: 0, oomGroupKill: 0, highBytes: "4G" })).toBe(false);
  });
  it("reads a launch cgroup's high with its max and peak, and keeps it as the submission's record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "graphloom-memory-"));
    try {
      await writeFile(path.join(directory, "memory.events"), "oom 0\noom_kill 0\noom_group_kill 0\n");
      await writeFile(path.join(directory, "memory.max"), `${6 * GiB}\n`);
      await writeFile(path.join(directory, "memory.high"), `${4 * GiB}\n`);
      await writeFile(path.join(directory, "memory.peak"), `${3 * GiB}\n`);
      const memory = await readLaunchMemory(directory);
      expect(memory).toEqual({ oom: 0, oomKill: 0, oomGroupKill: 0, maxBytes: 6 * GiB, highBytes: 4 * GiB, peakBytes: 3 * GiB });
      expect(launchMemoryRecord("l-1", "2026-11-26T00:00:00.000Z", memory!)).toEqual({ launchId: "l-1", recordedAt: "2026-11-26T00:00:00.000Z", peak: 3 * GiB, high: 4 * GiB, max: 6 * GiB, oom: 0, oomKills: 0 });
      expect(launchMemoryRecord("l-2", "t", { oom: 0, oomKill: 1, oomGroupKill: 0 })).toEqual({ launchId: "l-2", recordedAt: "t", oom: 0, oomKills: 1 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
