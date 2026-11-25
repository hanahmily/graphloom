// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, constants } from "node:fs";
import { access, appendFile, mkdir, open, readFile, realpath, rename, rmdir, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Duplex, Readable } from "node:stream";
import type { HubLaunch, HubProcessIdentity, HubSubmission } from "@graphloom/sdk";
import type { HubDriver, HubExecutionObservation } from "./types.js";
import { formatBytes, readLaunchMemory, validLaunchMemory, type HubLaunchMemory, type HubMemoryLimits } from "./memory.js";

export interface HubCommandSpec { executable: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; }
export interface HubGrantMessage {
  protocolVersion: 1;
  type: "grant";
  hubId: string;
  submissionId: string;
  runId: string;
  launchId: string;
  generation: number;
  automatic: boolean;
  continuationFingerprint?: string;
  command?: HubLaunch["command"];
}
export interface HubStopMessage { protocolVersion: 1; type: "stop"; reason: "pause" | "cancel" | "service-interruption"; commandId: string; }
type RuntimeObservation = Omit<HubExecutionObservation, "execution">;
export interface LinuxHubDriverOptions {
  /** A delegated cgroup v2 subtree, owned exclusively by this hub deployment. */
  cgroupRoot: string;
  directory: string;
  command(launch: HubLaunch, submission: HubSubmission): Promise<HubCommandSpec>;
  observe(launch: HubLaunch, submission: HubSubmission): Promise<RuntimeObservation>;
  /** Verify run-labelled containers/external executors, not merely a controller PID. */
  cleanup(launch: HubLaunch, submission: HubSubmission, observed?: RuntimeObservation): Promise<RuntimeObservation>;
  maxLogBytes?: number;
  onWake?(): void;
  /**
   * Each launch cgroup's `memory.high` and `memory.max` (docs/design-run-hub.md §6.2),
   * written before the launch starts, with `memory.oom.group` set so an OOM kills the
   * launch's whole group. A limit needs the delegated memory controller: the probe
   * refuses to start without it. Absent or both null: no limit is written.
   */
  memory?: HubMemoryLimits;
  /** See HubDriver.settleInput. */
  settleInput?: NonNullable<HubDriver["settleInput"]>;
}
interface Child { process: ChildProcess; control: Duplex; error?: string; }
const CONTROL_LIMIT = 16 * 1024;
const CGROUP2_SUPER_MAGIC = 0x63677270;

/** A direct child starts behind fd 3's grant gate. Cgroup emptiness is mandatory. */
export function createLinuxHubDriver(options: LinuxHubDriverOptions): HubDriver {
  const children = new Map<string, Child>();
  const root = path.resolve(options.cgroupRoot);
  const maximum = options.maxLogBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 16 * 1024 * 1024) throw new Error("maxLogBytes must be 1 KiB–16 MiB per stream");
  const cgroup = (launch: HubLaunch): string => launchCgroupPath(root, launch.id);
  const limits = options.memory ?? { high: null, max: null };
  const limited = limits.high !== null || limits.max !== null;
  if (limits.high !== null && limits.max !== null && limits.high > limits.max) throw new Error("launch memory.high must not exceed memory.max");
  /** Whether launch cgroups get the memory controller's files: known once the probe enabled it. */
  let memoryController = false;
  async function probe(context?: { lockPid: number }): Promise<void> {
    if (process.platform !== "linux") throw new Error("managed hub execution requires Linux cgroup v2");
    if (await realpath(root) !== root || Number((await statfs(root)).type) !== CGROUP2_SUPER_MAGIC) throw new Error("hub cgroupRoot must be a real delegated cgroup v2 directory");
    await access(path.join(root, "cgroup.procs"), constants.W_OK);
    const available = (await readFile(path.join(root, "cgroup.controllers"), "utf8")).trim().split(/\s+/);
    const leaf = path.join(root, "hub");
    await mkdir(leaf).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    await writeFile(path.join(leaf, "cgroup.procs"), String(process.pid));
    // The lifetime lock helper was born before delegation setup and belongs in the same leaf.
    if (context?.lockPid) await writeFile(path.join(leaf, "cgroup.procs"), String(context.lockPid));
    if (limited && !available.includes("memory")) {
      throw new Error(`launch memory limits are configured (launchMemoryHigh ${formatBytes(limits.high)}, launchMemoryMax ${formatBytes(limits.max)} in hub.json) but the memory controller is not delegated to ${root} (its cgroup.controllers: ${available.join(" ") || "none"}); run the hub as its systemd user service with Delegate=yes (graphloom hub service), or set both to "max" to run launches without a memory limit`);
    }
    const enable = ["cpu", "memory"].filter((controller) => available.includes(controller));
    if (enable.length) {
      try { await writeFile(path.join(root, "cgroup.subtree_control"), enable.map((controller) => `+${controller}`).join(" ")); }
      catch (error) { throw new Error(`cannot enable delegated cgroup ${enable.join("/")} controllers; the hub needs its own empty delegated subtree: ${String(error)}`); }
    }
    const enabled = (await readFile(path.join(root, "cgroup.subtree_control"), "utf8").catch(() => "")).trim().split(/\s+/).map((name) => name.replace(/^\+/, ""));
    memoryController = enabled.includes("memory");
    if (limited && !memoryController) throw new Error(`launch memory limits are configured but the memory controller could not be enabled for ${root}'s children (its cgroup.subtree_control: ${enabled.join(" ") || "none"})`);
    const test = path.join(root, `probe-${process.pid}`);
    await mkdir(test);
    try {
      await access(path.join(test, "cgroup.procs"), constants.W_OK);
      await access(path.join(test, "cgroup.kill"), constants.W_OK);
      if (limited) for (const file of ["memory.high", "memory.max", "memory.oom.group"]) await access(path.join(test, file), constants.W_OK);
      if (!/^populated 0$/m.test(await readFile(path.join(test, "cgroup.events"), "utf8"))) throw new Error("unexpected populated cgroup capability probe");
    } finally { await rmdir(test); }
  }
  async function populated(launch: HubLaunch): Promise<boolean> {
    try {
      const value = await readFile(path.join(cgroup(launch), "cgroup.events"), "utf8");
      const match = /^populated ([01])$/m.exec(value);
      if (!match) throw new Error("cgroup populated state is unavailable");
      return match[1] === "1";
    } catch (error) {
      // The kernel refuses rmdir of a populated cgroup; after reboot it is absent.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function inspect(launch: HubLaunch, submission: HubSubmission): Promise<HubExecutionObservation> {
    try {
      let active = await populated(launch);
      const local = children.get(launch.id)?.process;
      const identityAlive = launch.identity ? await sameProcess(launch.identity) : Boolean(local?.pid && local.exitCode === null && local.signalCode === null);
      if (launch.phase !== "granted") {
        // A durable grant is the only permission for graph or external execution. Earlier
        // generations were fully drained before reservation; this gated attempt adds none.
        if (active || identityAlive) return { execution: "live", ownerGone: false, externalStopped: true };
        await rmdir(cgroup(launch)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        children.delete(launch.id);
        return { execution: "drained", ownerGone: true, externalStopped: true };
      }
      let state = await options.observe(launch, submission);
      if (active && state.ownerGone && !identityAlive && launch.phase === "granted") {
        await writeFile(path.join(cgroup(launch), "cgroup.kill"), "1");
        active = await populated(launch);
      }
      if (!active && state.ownerGone) state = await options.cleanup(launch, submission, state);
      const error = children.get(launch.id)?.error;
      if (error && (active || identityAlive)) return { ...state, execution: "uncertain", reason: error };
      if (active || identityAlive) return { ...state, execution: "live" };
      if (!state.ownerGone || !state.externalStopped) return { ...state, execution: "uncertain", reason: state.reason ?? "controller owner or external execution remains unverified" };
      // What the cgroup recorded about memory goes with it: read it before it is removed (§6.2).
      // Kept durably beside the launch's report first: a hub that stops before this launch settles
      // finds the cgroup gone on restart, and reads the record instead.
      const record = path.join(options.directory, "submissions", submission.id, "launches", `${launch.id}.memory.json`);
      let memory = await readLaunchMemory(cgroup(launch));
      if (memory !== undefined) await writeDurably(record, JSON.stringify(memory));
      else memory = await readMemoryRecord(record);
      await rmdir(cgroup(launch)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      children.delete(launch.id);
      return { ...state, execution: "drained", ...(memory !== undefined ? { memory } : {}) };
    } catch (error) { return { execution: "uncertain", ownerGone: false, externalStopped: false, reason: String(error instanceof Error ? error.message : error).slice(0, 1024) }; }
  }
  return {
    probe,
    ...(options.settleInput ? { settleInput: options.settleInput } : {}),
    async prepare(launch, submission) {
      const directory = cgroup(launch);
      await mkdir(directory); // An existing generation is never reused for a second child.
      // Limits are in place before anything of the launch runs (§6.2).
      if (memoryController || limited) await applyMemoryLimits(directory, limits, limited);
      const command = await options.command(launch, submission);
      if (!path.isAbsolute(command.executable) || command.args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) throw new Error("managed launch requires a fixed absolute executable and valid argv");
      const logDirectory = path.join(options.directory, "submissions", submission.id, "logs");
      await mkdir(logDirectory, { recursive: true, mode: 0o700 });
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        detached: false,
      });
      const control = child.stdio[3] as Duplex;
      const entry: Child = { process: child, control };
      children.set(launch.id, entry);
      child.once("close", () => options.onWake?.());
      // A malformed worker cannot create an unbounded control buffer or release a reservation.
      let pending = "";
      control.setEncoding("utf8");
      control.on("data", (chunk: string) => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          if (Buffer.byteLength(pending.slice(0, newline)) > CONTROL_LIMIT) { entry.error = "oversized managed child control message"; control.destroy(); return; }
          try {
            const frame: unknown = JSON.parse(pending.slice(0, newline));
            if (typeof frame !== "object" || frame === null || (frame as { protocolVersion?: number }).protocolVersion !== 1) throw new Error("invalid managed message");
          } catch { entry.error = "invalid managed child control message"; control.destroy(); return; }
          // Observations are reread through the owning runtime, never trusted from log/control text.
          pending = pending.slice(newline + 1);
          options.onWake?.();
        }
        if (Buffer.byteLength(pending) > CONTROL_LIMIT) { entry.error = "oversized managed child control message"; control.destroy(); }
      });
      control.on("error", () => { /* EOF/loss makes the bootstrap stop; inspect verifies drainage. */ });
      boundedLog(child.stdout!, path.join(logDirectory, `${launch.id}.stdout.log`), maximum, () => { entry.error = "managed stdout log write failed"; control.destroy(); });
      boundedLog(child.stderr!, path.join(logDirectory, `${launch.id}.stderr.log`), maximum, () => { entry.error = "managed stderr log write failed"; control.destroy(); });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      if (!child.pid) throw new Error("managed bootstrap has no PID");
      try {
        const identity = await processIdentity(child.pid);
        await writeFile(path.join(directory, "cgroup.procs"), String(child.pid));
        const members = (await readFile(path.join(directory, "cgroup.procs"), "utf8")).trim().split(/\s+/);
        if (!members.includes(String(child.pid))) throw new Error("bootstrap did not enter launch cgroup");
        if (!await sameProcess(identity)) throw new Error("bootstrap exited before containment was verified");
        return identity;
      } catch (error) { control.destroy(); throw error; }
    },
    async grant(launch, submission) {
      const child = children.get(launch.id);
      if (!child || child.control.destroyed || child.process.exitCode !== null) throw new Error("bootstrap unavailable for durable start grant");
      if (launch.phase !== "granted" || !launch.identity || !await sameProcess(launch.identity)) throw new Error("bootstrap identity or durable grant is not current");
      const frame: HubGrantMessage = {
        protocolVersion: 1, type: "grant", hubId: submission.hubId, submissionId: submission.id, runId: submission.runId,
        launchId: launch.id, generation: launch.generation, automatic: launch.automatic,
        ...(launch.continuationFingerprint ? { continuationFingerprint: launch.continuationFingerprint } : {}),
        ...(launch.command ? { command: launch.command } : {}),
      };
      await send(child.control, frame);
    },
    inspect,
    async stop(launch, _submission, reason, commandId) {
      const child = children.get(launch.id);
      if (child && !child.control.destroyed && child.process.exitCode === null) {
        await send(child.control, { protocolVersion: 1, type: "stop", reason, commandId });
      } else if (launch.identity && await sameProcess(launch.identity)) {
        // Recovered bootstrap reads the durable stop reason; no signal is sent to a reused PID.
        process.kill(launch.identity.pid, "SIGTERM");
      }
    },
    async kill(launch, submission) {
      if (await populated(launch)) await writeFile(path.join(cgroup(launch), "cgroup.kill"), "1");
      await options.cleanup(launch, submission);
    },
    async appendLog(launch, submission, line) {
      const file = path.join(options.directory, "submissions", submission.id, "logs", `${path.basename(cgroup(launch))}.stderr.log`);
      await appendFile(file, `${line.replace(/[\r\n]+/g, " ").slice(0, 2048)}\n`, { mode: 0o600 });
    },
    async close() {
      for (const child of children.values()) child.control.destroy();
      children.clear();
    },
  };
}
/**
 * Writes a launch cgroup's memory limits and `memory.oom.group=1`: an OOM inside the launch
 * (at its own limit, or a global one choosing one of its processes) kills its whole group,
 * never one process of it. Without configured limits a missing memory controller is fine.
 */
async function applyMemoryLimits(directory: string, limits: HubMemoryLimits, required: boolean): Promise<void> {
  const write = async (file: string, value: string) => {
    try { await writeFile(path.join(directory, file), value); }
    catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`cannot set the launch cgroup's ${file} to ${value}: ${String(error instanceof Error ? error.message : error)}`);
    }
  };
  await write("memory.max", limits.max === null ? "max" : String(limits.max));
  await write("memory.high", limits.high === null ? "max" : String(limits.high));
  await write("memory.oom.group", "1");
}
async function writeDurably(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  const directory = await open(path.dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function readMemoryRecord(file: string): Promise<HubLaunchMemory | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return validLaunchMemory(value) ? value : undefined;
  } catch { return undefined; }
}
async function send(control: Duplex, frame: HubGrantMessage | HubStopMessage): Promise<void> {
  const bytes = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(bytes) > CONTROL_LIMIT) throw new Error("managed control message exceeds 16 KiB");
  await new Promise<void>((resolve, reject) => { control.write(bytes, (error) => error ? reject(error) : resolve()); });
}
async function processIdentity(pid: number): Promise<HubProcessIdentity> {
  const [bootId, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
  // comm may contain spaces and parentheses; fields after the last ')' start at field 3.
  const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  if (!startTime || !/^\d+$/.test(startTime)) throw new Error("Linux process start identity unavailable");
  return { bootId: bootId.trim(), pid, startTime };
}
async function sameProcess(identity: HubProcessIdentity): Promise<boolean> {
  try { const current = await processIdentity(identity.pid); return current.bootId === identity.bootId && current.startTime === identity.startTime; }
  catch (error) { if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
}
function boundedLog(stream: Readable, file: string, maximum: number, failed: () => void): void {
  const output = createWriteStream(file, { flags: "wx", mode: 0o600 });
  let bytes = 0;
  output.on("error", failed);
  stream.on("data", (chunk: Buffer) => {
    if (bytes >= maximum) return;
    const remaining = chunk.subarray(0, maximum - bytes);
    bytes += remaining.length;
    output.write(remaining);
  });
  stream.on("end", () => output.end());
  stream.on("error", () => output.end());
}

export function launchCgroupPath(cgroupRoot: string, launchId: string): string {
  if (!/^l-[a-f0-9-]{36}$/.test(launchId)) throw new Error("invalid launch cgroup identity");
  return path.join(path.resolve(cgroupRoot), launchId);
}
