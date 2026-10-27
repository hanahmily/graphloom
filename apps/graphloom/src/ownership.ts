// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Run ownership in the CLI (docs/design-release.md §5.1): which GraphLoom this
 * process is, the `runs/<runId>.json` index that `self prune` and `upgrade`
 * read in sh, and dispatch of run-scoped commands to the version that owns
 * the run.
 *
 * - An **installed** CLI is a release tree at `$GRAPHLOOM_HOME/versions/<v>`
 *   whose `release.json` names `<v>`. It records itself as the owner of the
 *   runs it creates, writes their ownership records, and dispatches a run
 *   another installed version owns to that version's `bin/graphloom`.
 * - A **clone** (no `release.json`, or a tree outside `versions/`) records
 *   `<v>-dev[+<sha>]` and its checkout in the run state but writes no
 *   ownership record. It still dispatches a run an installed version owns, to
 *   that version (found by the recorded root, or under `$GRAPHLOOM_HOME`).
 * - A run with no owner, or one a clone owns, runs in whichever CLI was
 *   invoked; its executor pins decide whether it can resume there
 *   (`executor pin mismatch` until `--update-executors` or `--upgrade`).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isReleaseVersion, resolveStateDir, type InstallRecord } from "@graphloom/controller";
import { installRoot, versionInfo } from "./version.js";

/** Set on a dispatched child to the version it was sent to, so a version that does not own the run cannot bounce it again. */
export const DISPATCHED_ENV = "GRAPHLOOM_DISPATCHED";

/** The run-scoped commands that run on the owning version (§5.1). */
export const RUN_SCOPED_COMMANDS: ReadonlySet<string> = new Set(["resume", "stop", "wait", "inspect", "stats", "replay", "switch-model", "delete"]);

export interface SelfInstall {
  /** What this CLI records as a run's owner. */
  record: InstallRecord;
  /** The install home, when this CLI is an installed version. */
  home?: string;
}

/** This process's own GraphLoom: an installed version under `<home>/versions/<v>`, or a clone. */
export function selfInstall(root: string = installRoot()): SelfInstall {
  const info = versionInfo(root);
  const installed = info.release !== undefined && isReleaseVersion(info.version) && path.basename(root) === info.version && path.basename(path.dirname(root)) === "versions";
  return { record: { version: info.version, root }, ...(installed ? { home: path.dirname(path.dirname(root)) } : {}) };
}

/** Where installed versions live: this CLI's own home, else `$GRAPHLOOM_HOME`, else the default (§4.1). */
export function installHome(self: SelfInstall, env: NodeJS.ProcessEnv = process.env): string {
  if (self.home !== undefined) return self.home;
  if (env.GRAPHLOOM_HOME !== undefined && env.GRAPHLOOM_HOME !== "") return path.resolve(env.GRAPHLOOM_HOME);
  const data = env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : path.join(env.HOME ?? os.homedir(), ".local", "share");
  return path.join(data, "graphloom");
}

export interface OwnershipRecord {
  version: string;
  stateDir: string;
  /** The run's bundle path as the task named it, its link included. */
  plugin?: string;
}

/**
 * Writes `<home>/runs/<runId>.json` atomically, as the flat record install.sh
 * reads (`{ "version", "stateDir", "plugin"? }`, string values only).
 */
export async function writeOwnershipRecord(home: string, runId: string, record: OwnershipRecord): Promise<void> {
  const dir = path.join(home, "runs");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const body: OwnershipRecord = { version: record.version, stateDir: path.resolve(record.stateDir), ...(record.plugin !== undefined ? { plugin: record.plugin } : {}) };
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

export async function readOwnershipRecord(home: string, runId: string): Promise<OwnershipRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(home, "runs", `${runId}.json`), "utf8")) as Partial<OwnershipRecord>;
    return typeof value.version === "string" && typeof value.stateDir === "string" ? (value as OwnershipRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the run's record when it names this state directory. */
export async function removeOwnershipRecord(home: string, runId: string, stateDir: string): Promise<void> {
  const record = await readOwnershipRecord(home, runId);
  if (record !== undefined && path.resolve(record.stateDir) === path.resolve(stateDir)) {
    await rm(path.join(home, "runs", `${runId}.json`), { force: true });
  }
}

/**
 * Records this installed CLI as the run's owner in the index. A clone writes
 * nothing. Best effort: the run state is authoritative, and a later
 * run-scoped command on the owner rewrites a missing record.
 */
export async function recordOwnership(self: SelfInstall, run: { runId: string; stateDir: string; plugin?: string }): Promise<void> {
  if (self.home === undefined) return;
  try {
    await writeOwnershipRecord(self.home, run.runId, { version: self.record.version, stateDir: run.stateDir, ...(run.plugin !== undefined ? { plugin: run.plugin } : {}) });
  } catch (err) {
    console.error(`graphloom: could not record ownership of run ${run.runId} in ${self.home}/runs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export type DispatchPlan =
  | { kind: "here" }
  | { kind: "exec"; bin: string; version: string }
  | { kind: "refuse"; message: string };

/** The `bin/graphloom` of an installed version `<version>`: under the recorded root, else under `home`. */
function installedBin(owner: InstallRecord, home: string): string | undefined {
  for (const root of [owner.root, path.join(home, "versions", owner.version)]) {
    const bin = path.join(root, "bin", "graphloom");
    if (!existsSync(bin)) continue;
    try {
      const release = JSON.parse(readFileSync(path.join(root, "release.json"), "utf8")) as { version?: unknown };
      if (release.version === owner.version) return bin;
    } catch {
      // not a release tree
    }
  }
  return undefined;
}

/** Where a run-scoped command on a run `owner` owns runs (§5.1). Pure apart from reading the candidate trees. */
export function planDispatch(
  self: SelfInstall,
  owner: InstallRecord | undefined,
  run: { runId: string; ref: string },
  options: { upgrade?: boolean; home: string; env?: NodeJS.ProcessEnv },
): DispatchPlan {
  // No owner (a run from before R3), or a clone's run: the pins decide.
  if (owner === undefined || !isReleaseVersion(owner.version)) return { kind: "here" };
  // `resume --upgrade` moves the run to this CLI instead.
  if (options.upgrade === true) return { kind: "here" };
  if (owner.version === self.record.version && (self.home !== undefined || owner.root === self.record.root)) return { kind: "here" };
  const bin = installedBin(owner, options.home);
  if (bin === undefined) {
    return {
      kind: "refuse",
      message: `run ${run.runId} belongs to GraphLoom ${owner.version}, which is not installed; reinstall it with graphloom upgrade ${owner.version} --no-switch, or move the run here with graphloom resume ${run.ref} --upgrade`,
    };
  }
  if ((options.env ?? process.env)[DISPATCHED_ENV] === self.record.version) {
    return { kind: "refuse", message: `run ${run.runId} was dispatched to GraphLoom ${self.record.version}, but it belongs to ${owner.version}; not dispatching again` };
  }
  return { kind: "exec", bin, version: owner.version };
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

/**
 * For a run-scoped command, runs it on the owning version when that is another
 * one, and returns its exit status; returns undefined when this CLI handles
 * the command itself. Prints one line to stderr when it dispatches.
 */
export async function dispatchToOwner(cmd: string, args: readonly string[], self: SelfInstall = selfInstall()): Promise<number | undefined> {
  if (!RUN_SCOPED_COMMANDS.has(cmd)) return undefined;
  const ref = args[1];
  if (ref === undefined || ref.startsWith("--")) return undefined;
  const runRef = ref.startsWith("/") || ref.includes("/") ? path.resolve(ref) : ref;
  const stateRoot = flag(args, "--state-root");
  let stateDir: string;
  let raw: { runId?: string; install?: InstallRecord; intake?: { bundle?: { bundlePath?: string } } };
  try {
    stateDir = await resolveStateDir(runRef, stateRoot !== undefined ? path.resolve(stateRoot) : undefined);
    raw = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")) as typeof raw;
  } catch {
    // No readable run here: the command reports that itself.
    return undefined;
  }
  const runId = raw.runId ?? path.basename(stateDir);
  const home = installHome(self);
  const plan = planDispatch(self, raw.install, { runId, ref }, { upgrade: cmd === "resume" && args.includes("--upgrade"), home });
  if (plan.kind === "refuse") {
    console.error(`graphloom: ${plan.message}`);
    return 1;
  }
  if (plan.kind === "here") {
    // Heal the index for a run this installed version owns (a crash between the state and the record).
    if (self.home !== undefined && raw.install?.version === self.record.version && cmd !== "delete") {
      const record = await readOwnershipRecord(self.home, runId);
      if (record === undefined || record.version !== self.record.version || path.resolve(record.stateDir) !== stateDir) {
        const plugin = raw.intake?.bundle?.bundlePath;
        await recordOwnership(self, { runId, stateDir, ...(plugin !== undefined ? { plugin } : {}) });
      }
    }
    return undefined;
  }
  console.error(`graphloom: run ${runId} belongs to GraphLoom ${plan.version}; running ${cmd} there (${plan.bin})`);
  return runChild(plan.bin, args, { ...process.env, [DISPATCHED_ENV]: plan.version });
}

/** Runs `bin args` with this process's stdio, forwarding termination signals; resolves with its exit status. */
function runChild(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, [...args], { stdio: "inherit", env });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, forward(s)] as const);
    for (const [s, h] of handlers) process.on(s, h);
    const done = (status: number) => {
      for (const [s, h] of handlers) process.off(s, h);
      resolve(status);
    };
    child.on("error", (err) => {
      console.error(`graphloom: cannot run ${bin}: ${err.message}`);
      done(1);
    });
    child.on("exit", (code, signal) => done(code ?? (signal !== null ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
  });
}
