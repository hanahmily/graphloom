// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The hub's memory containment as the operator sees it (docs/design-run-hub.md
 * §6.2, §9.1): the service limits `hub service --limits` writes, and the limits,
 * use and warnings `hub status` and `hub doctor` show, read from a cgroup
 * fixture directory. A temporary HOME; never the real hub, its socket or its
 * cgroups, and never the real ~/.config/systemd.
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubHealth, HubLaunch, HubLaunchMemoryRecord, HubSubmission, MonitorSnapshot } from "@graphloom/sdk";
import type { DoctorCheck } from "../src/doctor.js";
import { formatHubStatus } from "../src/hub-cli.js";
import { addProcessMetrics } from "../src/hub-runtime.js";
import { limitsDropIn, memoryChecks, memoryLines, memoryWarnings, recordedMemory, recordedMemoryText, serviceMemoryLimits, summarizeHubMemory, withMemoryChecks, withRecordedMemory } from "../src/hub-memory.js";
import { repoRoot } from "./cli-env.js";

const GiB = 1024 ** 3;
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix)); folders.push(dir); return dir;
}
const LAUNCH = "l-11111111-2222-3333-4444-555555555555";
const submission = { id: "s-11111111-2222-3333-4444-555555555555", runId: "run-1", launch: { id: LAUNCH } } as unknown as HubSubmission;

/** A delegated service cgroup with one launch cgroup, as files. */
async function cgroupFixture(service: { high: string; max: string }) {
  const root = await temp("gl-hub-memory-cgroup-");
  await writeFile(path.join(root, "memory.high"), `${service.high}\n`);
  await writeFile(path.join(root, "memory.max"), `${service.max}\n`);
  await writeFile(path.join(root, "memory.current"), `${3 * GiB}\n`);
  await writeFile(path.join(root, "memory.peak"), `${7 * GiB}\n`);
  const launch = path.join(root, LAUNCH);
  await mkdir(launch);
  await writeFile(path.join(launch, "memory.max"), `${6 * GiB}\n`);
  await writeFile(path.join(launch, "memory.current"), `${2 * GiB}\n`);
  await writeFile(path.join(launch, "memory.peak"), `${5 * GiB}\n`);
  await writeFile(path.join(launch, "memory.events"), "low 0\nhigh 4\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n");
  return root;
}

describe("service memory limits: hub service --limits", () => {
  it("derives MemoryHigh/MemoryMax from the launch limits x concurrency + 1 GiB, unless hub.json gives them", () => {
    expect(serviceMemoryLimits({ launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB, maxConcurrentRuns: 2 })).toEqual({ high: 9 * GiB, max: 13 * GiB, derived: { high: true, max: true } });
    expect(serviceMemoryLimits({ launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB, maxConcurrentRuns: 0 })).toMatchObject({ high: 5 * GiB, max: 7 * GiB });
    expect(serviceMemoryLimits({ launchMemoryHigh: null, launchMemoryMax: null, maxConcurrentRuns: 2 })).toMatchObject({ high: null, max: null });
    expect(serviceMemoryLimits({ launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB, maxConcurrentRuns: 2, serviceMemoryHigh: 6 * GiB, serviceMemoryMax: 8 * GiB })).toEqual({ high: 6 * GiB, max: 8 * GiB, derived: { high: false, max: false } });
    // A derived high never exceeds an explicit max: three quarters of it.
    expect(serviceMemoryLimits({ launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB, maxConcurrentRuns: 2, serviceMemoryMax: 8 * GiB })).toMatchObject({ high: 6 * GiB, max: 8 * GiB });
    expect(serviceMemoryLimits({ launchMemoryHigh: null, launchMemoryMax: null, maxConcurrentRuns: 2, serviceMemoryMax: 8 * GiB })).toMatchObject({ high: 6 * GiB, max: 8 * GiB });
    const text = limitsDropIn({ launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB, maxConcurrentRuns: 2 }, new Date("2026-11-25T00:00:00Z"));
    expect(text).toContain("[Service]\nMemoryAccounting=yes\nMemoryHigh=9G\nMemoryMax=13G\n");
    expect(text).toContain("systemctl --user set-property");
    expect(text).toContain("takes precedence over this file");
  });

  it("prints 10-limits.conf, and writes it beside the unit with --write", async () => {
    const home = await temp("gl-hub-limits-");
    const config = path.join(home, ".config");
    await mkdir(path.join(config, "graphloom"), { recursive: true });
    await writeFile(path.join(config, "graphloom", "hub.json"), JSON.stringify({ cgroupRoot: home, maxConcurrentRuns: 3, launchMemoryMax: "4G", serviceMemoryMax: "14G" }));
    const env = { HOME: home, XDG_CONFIG_HOME: config, PATH: process.env.PATH, GRAPHLOOM_DISABLE_AUTOUPDATE: "1" };
    const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [path.join(repoRoot, "apps", "graphloom", "dist", "main.js"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
    const file = path.join(config, "systemd", "user", "graphloom-hub.service.d", "10-limits.conf");
    const printed = await run(["hub", "service", "--limits"]);
    expect(printed.code, printed.stderr).toBe(0);
    // High: 4 GiB x 2/3 per launch x 3 + 1 GiB; max: hub.json's own.
    expect(printed.stdout).toContain(`MemoryHigh=${Math.floor(4 * GiB * 2 / 3) * 3 + GiB}\nMemoryMax=14G\n`);
    expect(printed.stderr).toContain("takes precedence over 10-limits.conf");
    expect(() => statSync(file)).toThrow();
    const written = await run(["hub", "service", "--limits", "--write"]);
    expect(written.code, written.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("MemoryMax=14G\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(written.stderr).toContain(`wrote ${file}`);
  }, 60_000);
});

describe("hub status and hub doctor: limits, use and warnings", () => {
  it("reads the service's and each launch's limits and use, and says nothing is wrong when they fit", async () => {
    const root = await cgroupFixture({ high: String(9 * GiB), max: String(13 * GiB) });
    const summary = await summarizeHubMemory({ cgroupRoot: root, launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB }, 2, [submission]);
    expect(summary).toEqual({
      service: { cgroup: root, high: 9 * GiB, max: 13 * GiB, current: 3 * GiB, peak: 7 * GiB },
      launch: { high: 4 * GiB, max: 6 * GiB }, maxConcurrentRuns: 2,
      launches: [{ submissionId: submission.id, launchId: LAUNCH, current: 2 * GiB, peak: 5 * GiB, max: 6 * GiB, oomKills: 0 }],
      warnings: [],
    });
    const text = formatHubStatus({ hubId: "h", maxConcurrentRuns: 2, occupiedSlots: 1, submissions: [], counts: {}, memory: summary } as HubHealth, "/sock");
    expect(text).toContain("Memory: service MemoryHigh 9 GiB · MemoryMax 13 GiB · now 3 GiB · peak 7 GiB");
    expect(text).toContain("Launch limits: memory.high 4 GiB · memory.max 6 GiB · concurrency 2");
    expect(text).toContain(`  ${submission.id} ${LAUNCH}: now 2 GiB · peak 5 GiB of 6 GiB`);
    expect(memoryChecks(summary)).toEqual([{ section: "host", name: "hub memory", status: "pass", detail: "service MemoryMax 13 GiB; each launch memory.max 6 GiB (memory.high 4 GiB) x 2" }]);
  });

  it("warns when the service has no limit, a launch has none, or launches together exceed the service's", async () => {
    const root = await cgroupFixture({ high: "max", max: "max" });
    const unset = await summarizeHubMemory({ cgroupRoot: root, launchMemoryHigh: null, launchMemoryMax: null }, 2, []);
    expect(unset.warnings).toEqual([
      expect.stringMatching(/^launchMemoryMax is max: a launch has no memory limit/),
      expect.stringMatching(/^the hub service has no MemoryMax \(infinity\).*graphloom hub service --limits --write/),
    ]);
    // The operator's set-property values: MemoryHigh=6G MemoryMax=8G, against 6 GiB launches x 2.
    const over = memoryWarnings({ service: { cgroup: root, high: 6 * GiB, max: 8 * GiB }, launch: { high: 4 * GiB, max: 6 * GiB }, maxConcurrentRuns: 2, launches: [] });
    expect(over).toEqual(["launchMemoryMax (6 GiB) x the concurrency limit (2) = 12 GiB exceeds the service's MemoryMax (8 GiB): launches together can reach the service's limit, where the kernel kills one that is under its own (lower launchMemoryMax, graphloom hub limit 1, or raise MemoryMax)"]);
    expect(memoryWarnings({ service: { cgroup: root, high: 4 * GiB, max: 4 * GiB }, launch: { high: 4 * GiB, max: 6 * GiB }, maxConcurrentRuns: 1, launches: [] })[0]).toMatch(/above the service's MemoryMax/);
    expect(memoryWarnings({ service: { cgroup: root, high: null, max: 20 * GiB }, launch: { high: 4 * GiB, max: 6 * GiB }, maxConcurrentRuns: 2, launches: [{ submissionId: "s", launchId: "l", oomKills: 2 }] }))
      .toEqual([expect.stringContaining("no MemoryHigh"), "launch l of s has had 2 processes OOM-killed"]);
    const checks = memoryChecks({ service: { cgroup: root, high: 6 * GiB, max: 8 * GiB }, launch: { high: 4 * GiB, max: 6 * GiB }, maxConcurrentRuns: 2, launches: [], warnings: over });
    expect(checks).toEqual([expect.objectContaining({ section: "host", name: "hub memory", status: "warn", fix: expect.stringContaining("graphloom hub service --limits --write") })]);
  });

  it("reports unreadable cgroup files as unreadable, and puts the memory checks after the doctor's host checks", async () => {
    const summary = await summarizeHubMemory({ cgroupRoot: path.join(os.tmpdir(), "gl-no-such-cgroup"), launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB }, 2, []);
    expect(summary.service.error).toMatch(/not readable/);
    expect(memoryChecks(summary)).toEqual([expect.objectContaining({ status: "warn", detail: expect.stringMatching(/not readable/) })]);
    const check = (section: DoctorCheck["section"], name: string): DoctorCheck => ({ section, name, status: "pass", detail: "" });
    expect(withMemoryChecks([check("host", "node"), check("host", "git"), check("agents", "claude")], [check("host", "hub memory")]).map((c) => c.name)).toEqual(["node", "git", "hub memory", "claude"]);
  });
});

describe("hub inspect's usage panel: the launch's peak against its limit", () => {
  it("adds the peak, the limit and OOM kills from the launch cgroup", async () => {
    const root = await cgroupFixture({ high: "max", max: "max" });
    await writeFile(path.join(root, LAUNCH, "memory.high"), `${4 * GiB}\n`);
    await writeFile(path.join(root, LAUNCH, "cpu.stat"), "usage_usec 100\n");
    await writeFile(path.join(root, LAUNCH, "memory.events"), "oom 1\noom_kill 2\noom_group_kill 1\n");
    const frame: MonitorSnapshot = { schemaVersion: 1, frameId: LAUNCH, observedAt: new Date(0).toISOString(), run: { id: "run-1", status: "unknown" }, sources: [] };
    await addProcessMetrics(frame, { id: LAUNCH } as HubLaunch, new Map(), root);
    const metrics = Object.fromEntries(frame.usage!.metrics.map((metric) => [metric.id, metric]));
    expect(metrics.rss).toMatchObject({ value: 2 * GiB });
    expect(metrics["memory-peak"]).toMatchObject({ label: "Launch memory peak (limit 6 GiB, throttled above 4 GiB)", value: 5 * GiB, unit: "bytes" });
    expect(metrics["memory-limit"]).toMatchObject({ value: 6 * GiB });
    expect(metrics["memory-oom-kills"]).toMatchObject({ value: 2 });
    expect(frame.usage!.coverage).toBe("launch cgroup memory 2 GiB now, peak 5 GiB of 6 GiB; external Docker containers are excluded (each has its own --memory)");
  });
});

describe("recorded launch memory: the peaks to tune launchMemoryMax by", () => {
  const at = "2026-11-26T10:00:00.000Z";
  const record = (launchId: string, peak: number | undefined, oomKills = 0): HubLaunchMemoryRecord => ({ launchId, recordedAt: at, ...(peak !== undefined ? { peak } : {}), max: 6 * GiB, high: 4 * GiB, oom: oomKills > 0 ? 1 : 0, oomKills });
  it("aggregates each submission's latest record, live and archived, against the current launchMemoryMax", async () => {
    const items = [
      { id: "s-a", lastLaunchMemory: record("l-a", 5 * GiB) },
      { id: "s-b", lastLaunchMemory: record("l-b", 6 * GiB, 2) },
      { id: "s-c", lastLaunchMemory: record("l-c", 2 * GiB) },
      { id: "s-d", lastLaunchMemory: record("l-d", undefined) },
      { id: "s-e" },
    ];
    expect(recordedMemory(items, 6 * GiB)).toEqual({ launches: 4, withPeak: 3, highest: { submissionId: "s-b", launchId: "l-b", recordedAt: at, peak: 6 * GiB, max: 6 * GiB }, nearMax: 2, oomKilled: 1 });
    // Against a raised limit fewer come near it; with no limit there is nothing to come near.
    expect(recordedMemory(items, 8 * GiB)?.nearMax).toBe(0);
    expect(recordedMemory(items, null)).not.toHaveProperty("nearMax");
    expect(recordedMemory([{ id: "s-e" }], 6 * GiB)).toBeUndefined();
    const root = await temp("gl-hub-memory-none-");
    const summary = await summarizeHubMemory({ cgroupRoot: root, launchMemoryHigh: 4 * GiB, launchMemoryMax: 6 * GiB }, 2, [items[0] as unknown as HubSubmission], [items[1]!]);
    expect(summary.recorded).toMatchObject({ launches: 2, nearMax: 2, oomKilled: 1, highest: { submissionId: "s-b" } });
    expect(memoryLines(summary)).toContain(`Recorded launch peaks: highest 6 GiB of 6 GiB (s-b l-b, ${at}) over the latest finished launch of 2 submissions (live and archived) · 2 within 80% of launchMemoryMax 6 GiB · 1 OOM-killed`);
    expect(memoryLines({ ...summary, recorded: { launches: 1, withPeak: 0, oomKilled: 0, nearMax: 0 } }).join("\n")).toContain("Recorded launch peaks: none readable over the latest finished launch of 1 submission (live and archived) (no memory.peak on this kernel) · 0 within 80%");
  });

  it("phrases a record, and adds it to the usage panel without changing the cached snapshot", () => {
    expect(recordedMemoryText(record("l-a", 5 * GiB))).toBe("peak 5 GiB of 6 GiB (throttled above 4 GiB), no OOM kill");
    expect(recordedMemoryText({ launchId: "l", recordedAt: at, oom: 0, oomKills: 1, max: null })).toBe("peak unknown (no memory.peak on this kernel) (no memory.max), 1 process OOM-killed");
    const usage: MonitorSnapshot["usage"] = { metrics: [{ id: "model-calls", label: "Recorded model calls", value: 3, unit: "calls", source: "ledger" }], coverage: "Controller budget ledger" };
    const idle = withRecordedMemory(usage, { lastLaunchMemory: record("l-a", 5 * GiB) })!;
    expect(idle.metrics.map((metric) => metric.id)).toEqual(["recorded-memory-peak", "recorded-memory-limit", "recorded-memory-high", "recorded-memory-oom-kills", "model-calls"]);
    expect(idle.coverage).toBe(`Controller budget ledger; no launch is running; recorded at the end of launch l-a (${at}): peak 5 GiB of 6 GiB (throttled above 4 GiB), no OOM kill`);
    expect(usage.metrics).toHaveLength(1); expect(usage.coverage).toBe("Controller budget ledger");
    const running = withRecordedMemory(usage, { launch: { id: "l-b" } as HubLaunch, lastLaunchMemory: record("l-a", 5 * GiB) })!;
    expect(running.metrics.map((metric) => metric.id)).toEqual(["previous-launch-memory-peak", "model-calls"]);
    expect(running.coverage).toBe("Controller budget ledger");
    expect(withRecordedMemory(usage, {})).toBe(usage);
    expect(withRecordedMemory(undefined, { lastLaunchMemory: record("l-a", 5 * GiB) })?.coverage).toMatch(/^no launch is running/);
  });
});
