// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HubLaunch, HubSubmission } from "@graphloom/sdk";
import { createLinuxHubDriver, launchCgroupPath } from "./linux.js";
import type { HubDriver } from "./types.js";

const cgroups = vi.hoisted(() => ({ root: "", enabled: true, memoryFiles: true, members: new Map<string, Set<number>>(), killed: [] as string[] }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: async (file: string) => file === cgroups.root ? { type: cgroups.enabled ? 0x63677270 : 1 } : actual.statfs(file),
    mkdir: async (file: string, options?: Parameters<typeof mkdir>[1]) => {
      const value = await actual.mkdir(file, options);
      if (file.startsWith(`${cgroups.root}/`) && path.dirname(file) === cgroups.root) {
        cgroups.members.set(file, new Set());
        await Promise.all(["cgroup.procs", "cgroup.kill", "cgroup.events"].map((name) => actual.writeFile(path.join(file, name), name === "cgroup.events" ? "populated 0\n" : "")));
        // The memory controller's files, as the kernel gives a child of a parent with +memory.
        if (cgroups.memoryFiles) {
          await Promise.all([["memory.high", "max\n"], ["memory.max", "max\n"], ["memory.oom.group", "0\n"], ["memory.events", "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n"]].map(([name, value]) => actual.writeFile(path.join(file, name!), value!)));
        }
      }
      return value;
    },
    rmdir: async (file: string) => file.startsWith(`${cgroups.root}/`) ? actual.rm(file, { recursive: true }) : actual.rmdir(file),
    writeFile: async (file: string, data: string, options?: Parameters<typeof writeFile>[2]) => {
      // A cgroup without the memory controller has no memory.* files, and none can be created.
      if (file.startsWith(`${cgroups.root}/`) && path.basename(file).startsWith("memory.") && !cgroups.memoryFiles) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" });
      if (file.startsWith(`${cgroups.root}/`) && path.basename(file) === "cgroup.procs") cgroups.members.get(path.dirname(file))?.add(Number(data));
      if (file.startsWith(`${cgroups.root}/`) && path.basename(file) === "cgroup.kill") {
        cgroups.killed.push(path.dirname(file));
        for (const pid of cgroups.members.get(path.dirname(file)) ?? []) if (pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
      }
      return actual.writeFile(file, data, options);
    },
    readFile: async (file: string, options?: Parameters<typeof readFile>[1]) => {
      if (file.startsWith(`${cgroups.root}/`) && path.basename(file) === "cgroup.events") {
        const alive = [...cgroups.members.get(path.dirname(file)) ?? []].some((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
        return `populated ${alive ? 1 : 0}\n`;
      }
      return actual.readFile(file, options);
    },
  };
});
const folders: string[] = [];
const drivers: HubDriver[] = [];
afterEach(async () => {
  for (const members of cgroups.members.values()) for (const pid of members) if (pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
  for (const driver of drivers.splice(0)) await driver.close?.();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  cgroups.members.clear(); cgroups.killed = []; cgroups.enabled = true; cgroups.memoryFiles = true; cgroups.root = "";
});
async function fixture(script?: string, memory?: { high: number | null; max: number | null }) {
  const directory = await mkdtemp(path.join(tmpdir(), "graphloom-cgroup-fixture-")); folders.push(directory);
  cgroups.root = path.join(directory, "delegated");
  await mkdir(cgroups.root);
  await Promise.all(["cgroup.controllers", "cgroup.procs"].map((name) => writeFile(path.join(cgroups.root, name), name === "cgroup.controllers" ? "cpu memory\n" : "")));
  const marker = path.join(directory, "executed");
  const bootstrap = path.join(directory, "bootstrap.cjs");
  await writeFile(bootstrap, script ?? `const fs=require('node:fs'); const net=require('node:net'); const control=new net.Socket({fd:3}); let pending=''; control.on('data',chunk=>{pending+=chunk; const n=pending.indexOf('\\n');if(n<0)return;const message=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);if(message.type==='grant'){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(message));process.stdout.write('x'.repeat(3000));}if(message.type==='stop')process.exit(0);});control.on('end',()=>process.exit(0));`);
  let ownerGone = false;
  let externalStopped = true;
  const driver = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory, maxLogBytes: 1024, ...(memory ? { memory } : {}), command: async () => ({ executable: process.execPath, args: [bootstrap] }), observe: async () => ({ ownerGone, externalStopped }), cleanup: async () => ({ ownerGone, externalStopped }) });
  drivers.push(driver);
  const launch: HubLaunch = { id: `l-${randomUUID()}`, generation: 1, mode: "initial", phase: "reserved", reservedAt: new Date().toISOString(), automatic: false };
  const submission: HubSubmission = { id: `s-${randomUUID()}`, runId: "run-1", hubId: "hub-1", acceptedAt: launch.reservedAt, updatedAt: launch.reservedAt, requestDigest: "a".repeat(64), contentDigest: "b".repeat(64), input: { taskFile: "/task.yaml", taskPath: "/task.yaml", repoPath: "/repo", baseCommit: "base", bundlePath: "/bundle", bundleDigest: "digest", runtimePath: process.execPath, runtimeDigest: "runtime" }, desiredAction: "execute", state: "starting", queueSequence: 1, generation: 1, automaticResumes: 0, retry: { automatic: true, maxAutomaticResumes: 5, maxElapsedMs: 10000, baseDelayMs: 10, maxDelayMs: 100 }, failureRepeats: 0, progressRevision: 0, journalBytes: 0, launch };
  return { driver, launch, submission, marker, directory, owner: () => { ownerGone = true; }, external: (value: boolean) => { externalStopped = value; } };
}
async function eventually(check: () => Promise<void>): Promise<void> {
  let failure: unknown;
  for (let i = 0; i < 100; i++) { try { await check(); return; } catch (error) { failure = error; await new Promise((resolve) => setTimeout(resolve, 10)); } }
  throw failure;
}
describe("Linux managed launch adapter with an emulated cgroup filesystem", () => {
  it("refuses ordinary filesystems instead of falling back to PID containment", async () => {
    const f = await fixture(); cgroups.enabled = false;
    await expect(f.driver.probe()).rejects.toThrow(/cgroup v2/);
  });
  it("contains a gated bootstrap before grant, forwards identity, and bounds child logs", async () => {
    const f = await fixture(); await f.driver.probe();
    expect(await readFile(path.join(cgroups.root, "cgroup.subtree_control"), "utf8")).toBe("+cpu +memory");
    f.launch.identity = await f.driver.prepare(f.launch, f.submission);
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(cgroups.members.get(launchCgroupPath(cgroups.root, f.launch.id))?.has(f.launch.identity.pid)).toBe(true);
    await expect(f.driver.grant(f.launch, f.submission)).rejects.toThrow(/grant/);
    f.launch.phase = "granted"; await f.driver.grant(f.launch, f.submission);
    await eventually(async () => expect(JSON.parse(await readFile(f.marker, "utf8"))).toMatchObject({ type: "grant", launchId: f.launch.id, runId: f.submission.runId, generation: 1 }));
    const log = path.join(f.directory, "submissions", f.submission.id, "logs", `${f.launch.id}.stdout.log`);
    await eventually(async () => expect((await readFile(log)).length).toBe(1024));
    expect((await f.driver.inspect(f.launch, f.submission)).execution).toBe("live");
    await f.driver.stop(f.launch, f.submission, "pause", "stop-1");
    f.owner();
    await eventually(async () => expect((await f.driver.inspect(f.launch, f.submission)).execution).toBe("drained"));
    await expect(readFile(path.join(launchCgroupPath(cgroups.root, f.launch.id), "cgroup.procs"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("appends the hub's closing line to a launch's stderr log as one line", async () => {
    const f = await fixture();
    const logs = path.join(f.directory, "submissions", f.submission.id, "logs"); await mkdir(logs, { recursive: true });
    const file = path.join(logs, `${f.launch.id}.stderr.log`); await writeFile(file, "graphloom: run run-1 started\n");
    await f.driver.appendLog!(f.launch, f.submission, "graphloom: run run-1 waiting: the launch ended\nwithout reporting its end");
    expect(await readFile(file, "utf8")).toBe("graphloom: run run-1 started\ngraphloom: run run-1 waiting: the launch ended without reporting its end\n");
  });
  it("passes the existing execution observation to cleanup without a second observation", async () => {
    const f = await fixture();
    const observation = { ownerGone: true, externalStopped: false };
    const observe = vi.fn(async () => observation);
    const cleanup = vi.fn(async (_launch: HubLaunch, _submission: HubSubmission, observed?: { ownerGone: boolean; externalStopped: boolean }) => ({ ownerGone: observed?.ownerGone ?? false, externalStopped: true }));
    const driver = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory: f.directory,
      command: async () => { throw new Error("unused"); }, observe, cleanup });
    drivers.push(driver); f.launch.phase = "granted";
    expect(await driver.inspect(f.launch, f.submission)).toMatchObject({ execution: "drained", ownerGone: true, externalStopped: true });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(f.launch, f.submission, observation);
  });
  it("EOF after grant stops the child, while external work keeps drainage uncertain", async () => {
    const f = await fixture(); await f.driver.probe();
    f.launch.identity = await f.driver.prepare(f.launch, f.submission);
    f.launch.phase = "granted"; await f.driver.grant(f.launch, f.submission);
    await eventually(async () => expect(await readFile(f.marker, "utf8")).toContain("grant"));
    await f.driver.close?.(); f.owner(); f.external(false);
    await eventually(async () => expect((await f.driver.inspect(f.launch, f.submission)).execution).toBe("uncertain"));
    f.external(true);
    expect((await f.driver.inspect(f.launch, f.submission)).execution).toBe("drained");
  });
  it("settles an empty never-granted launch even when its pinned runtime is unavailable", async () => {
    const f = await fixture();
    const unavailable = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory: f.directory,
      command: async () => { throw new Error("pinned runtime vanished"); },
      observe: async () => { throw new Error("pinned runtime cannot inspect"); },
      cleanup: async () => { throw new Error("pinned runtime cannot clean up"); },
    });
    drivers.push(unavailable); await unavailable.probe();
    await expect(unavailable.prepare(f.launch, f.submission)).rejects.toThrow(/vanished/);
    expect(await unavailable.inspect(f.launch, f.submission)).toMatchObject({ execution: "drained", ownerGone: true, externalStopped: true });
    f.launch.phase = "granted";
    expect(await unavailable.inspect(f.launch, f.submission)).toMatchObject({ execution: "uncertain", externalStopped: false });
  });
  it("kills the launch cgroup and verifies emptiness rather than trusting the immediate PID", async () => {
    const f = await fixture(); await f.driver.probe();
    f.launch.identity = await f.driver.prepare(f.launch, f.submission); f.launch.phase = "granted";
    await f.driver.grant(f.launch, f.submission);
    await f.driver.kill(f.launch, f.submission); f.owner();
    expect(cgroups.killed).toContain(launchCgroupPath(cgroups.root, f.launch.id));
    await eventually(async () => expect((await f.driver.inspect(f.launch, f.submission)).execution).toBe("drained"));
  });
  it("blocks malformed control streams without allocating an unbounded buffer", async () => {
    const f = await fixture(`const net=require('node:net');const c=new net.Socket({fd:3});c.on('data',()=>c.write('x'.repeat(20000)));c.on('end',()=>process.exit(0));`);
    await f.driver.probe(); f.launch.identity = await f.driver.prepare(f.launch, f.submission); f.launch.phase = "granted";
    await f.driver.grant(f.launch, f.submission);
    await eventually(async () => {
      const state = await f.driver.inspect(f.launch, f.submission);
      expect(state.execution).toBe("uncertain");
    });
    f.owner();
    await eventually(async () => expect((await f.driver.inspect(f.launch, f.submission)).execution).toBe("drained"));
  });
});

describe("launch memory limits (docs/design-run-hub.md §6.2)", () => {
  const GiB = 1024 ** 3;
  it("writes memory.high, memory.max and memory.oom.group on the launch cgroup before the launch starts", async () => {
    const f = await fixture(undefined, { high: 4 * GiB, max: 6 * GiB });
    await f.driver.probe();
    const directory = launchCgroupPath(cgroups.root, f.launch.id);
    // The command is asked for only after the limits are in place: nothing of the launch runs unlimited.
    let seen: Record<string, string> | undefined;
    const driver = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory: f.directory, memory: { high: 4 * GiB, max: 6 * GiB },
      command: async () => {
        seen = Object.fromEntries(await Promise.all(["memory.high", "memory.max", "memory.oom.group"].map(async (name) => [name, await readFile(path.join(directory, name), "utf8")])));
        return { executable: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"] };
      },
      observe: async () => ({ ownerGone: true, externalStopped: true }), cleanup: async () => ({ ownerGone: true, externalStopped: true }) });
    drivers.push(driver); await driver.probe();
    f.launch.identity = await driver.prepare(f.launch, f.submission);
    expect(seen).toEqual({ "memory.high": String(4 * GiB), "memory.max": String(6 * GiB), "memory.oom.group": "1" });
  });
  it("refuses to start when limits are configured and the memory controller is not delegated", async () => {
    const f = await fixture(undefined, { high: 4 * GiB, max: 6 * GiB });
    await writeFile(path.join(cgroups.root, "cgroup.controllers"), "cpu\n");
    await expect(f.driver.probe()).rejects.toThrow(/launch memory limits are configured \(launchMemoryHigh 4 GiB, launchMemoryMax 6 GiB in hub\.json\) but the memory controller is not delegated/);
    // Without limits the same subtree is accepted: nothing needs the controller.
    const open = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory: f.directory, memory: { high: null, max: null },
      command: async () => { throw new Error("unused"); }, observe: async () => ({ ownerGone: true, externalStopped: true }), cleanup: async () => ({ ownerGone: true, externalStopped: true }) });
    drivers.push(open);
    await expect(open.probe()).resolves.toBeUndefined();
  });
  it("refuses a launch whose limits cannot be written, before anything of it runs", async () => {
    const f = await fixture(undefined, { high: null, max: 6 * GiB });
    await f.driver.probe();
    cgroups.memoryFiles = false;
    await expect(f.driver.prepare(f.launch, f.submission)).rejects.toThrow(/cannot set the launch cgroup's memory.max/);
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("reports the cgroup's OOM record and peak when the launch drains, before the cgroup is removed", async () => {
    const f = await fixture(undefined, { high: 4 * GiB, max: 6 * GiB }); await f.driver.probe();
    f.launch.identity = await f.driver.prepare(f.launch, f.submission); f.launch.phase = "granted";
    await f.driver.grant(f.launch, f.submission);
    const directory = launchCgroupPath(cgroups.root, f.launch.id);
    await writeFile(path.join(directory, "memory.events"), "low 0\nhigh 12\nmax 3\noom 1\noom_kill 4\noom_group_kill 1\n");
    await writeFile(path.join(directory, "memory.peak"), `${6 * GiB}\n`);
    await f.driver.kill(f.launch, f.submission); f.owner();
    let drained: Awaited<ReturnType<HubDriver["inspect"]>> | undefined;
    await eventually(async () => { drained = await f.driver.inspect(f.launch, f.submission); expect(drained.execution).toBe("drained"); });
    expect(drained!.memory).toEqual({ oom: 1, oomKill: 4, oomGroupKill: 1, maxBytes: 6 * GiB, peakBytes: 6 * GiB });
    await expect(readFile(path.join(directory, "memory.events"))).rejects.toMatchObject({ code: "ENOENT" });
    // A hub that stopped before settling reads the durable record: the cgroup is gone.
    const restarted = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory: f.directory, memory: { high: 4 * GiB, max: 6 * GiB },
      command: async () => { throw new Error("unused"); }, observe: async () => ({ ownerGone: true, externalStopped: true }), cleanup: async () => ({ ownerGone: true, externalStopped: true }) });
    drivers.push(restarted);
    expect((await restarted.inspect(f.launch, f.submission)).memory).toEqual(drained!.memory);
  });
});
