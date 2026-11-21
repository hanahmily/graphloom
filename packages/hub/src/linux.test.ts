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

const cgroups = vi.hoisted(() => ({ root: "", enabled: true, members: new Map<string, Set<number>>(), killed: [] as string[] }));
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
      }
      return value;
    },
    rmdir: async (file: string) => file.startsWith(`${cgroups.root}/`) ? actual.rm(file, { recursive: true }) : actual.rmdir(file),
    writeFile: async (file: string, data: string, options?: Parameters<typeof writeFile>[2]) => {
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
  cgroups.members.clear(); cgroups.killed = []; cgroups.enabled = true; cgroups.root = "";
});
async function fixture(script?: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "graphloom-cgroup-fixture-")); folders.push(directory);
  cgroups.root = path.join(directory, "delegated");
  await mkdir(cgroups.root);
  await Promise.all(["cgroup.controllers", "cgroup.procs"].map((name) => writeFile(path.join(cgroups.root, name), name === "cgroup.controllers" ? "cpu memory\n" : "")));
  const marker = path.join(directory, "executed");
  const bootstrap = path.join(directory, "bootstrap.cjs");
  await writeFile(bootstrap, script ?? `const fs=require('node:fs'); const net=require('node:net'); const control=new net.Socket({fd:3}); let pending=''; control.on('data',chunk=>{pending+=chunk; const n=pending.indexOf('\\n');if(n<0)return;const message=JSON.parse(pending.slice(0,n));pending=pending.slice(n+1);if(message.type==='grant'){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(message));process.stdout.write('x'.repeat(3000));}if(message.type==='stop')process.exit(0);});control.on('end',()=>process.exit(0));`);
  let ownerGone = false;
  let externalStopped = true;
  const driver = createLinuxHubDriver({ cgroupRoot: cgroups.root, directory, maxLogBytes: 1024, command: async () => ({ executable: process.execPath, args: [bootstrap] }), observe: async () => ({ ownerGone, externalStopped }), cleanup: async () => ({ ownerGone, externalStopped }) });
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
