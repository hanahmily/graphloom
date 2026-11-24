// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { HubCommand, HubInput, HubSubmission } from "@graphloom/sdk";

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const hubKey = (directory: string) => createHash("sha256").update(path.resolve(directory)).digest("hex");

/** The version is encoded in the path: unreadable record contents cannot protect unrelated versions. */
export function hubRetentionFile(home: string, hubDirectory: string, version: string): string {
  if (!versionPattern.test(version)) throw new Error("invalid retained installation version");
  return path.join(home, "hub-retention", version, `${hubKey(hubDirectory)}.json`);
}

type References = Map<string, Map<string, string[]>>;
async function installedReferences(references: readonly string[]): Promise<References> {
  const homes: References = new Map();
  for (const reference of [...new Set(references)]) {
    const resolved = await realpath(reference);
    let cursor = resolved;
    for (;;) {
      const parent = path.dirname(cursor);
      if (path.basename(parent) === "versions" && versionPattern.test(path.basename(cursor))) {
        const home = path.dirname(parent);
        const versions = homes.get(home) ?? new Map<string, string[]>();
        const version = path.basename(cursor);
        versions.set(version, [...(versions.get(version) ?? []), resolved]);
        homes.set(home, versions);
        break;
      }
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return homes;
}

/** Adds pins before acceptance; does not release another outstanding submission's pins. */
export async function retainHubInstallations(hubDirectory: string, referencedPaths: readonly string[]): Promise<string[]> {
  const homes = await installedReferences(referencedPaths);
  for (const home of [...homes.keys()].sort()) await updateRegistration(home, hubDirectory, homes.get(home)!, false);
  return [...homes.keys()].sort();
}

/** Replaces this hub's pins in one home, under the installer's short-lived lock. */
export async function registerHubRetention(home: string, hubDirectory: string, references: readonly string[] = []): Promise<void> {
  const canonicalHome = await realpath(home);
  const homes = await installedReferences(references);
  if ([...homes.keys()].some((entry) => entry !== canonicalHome)) throw new Error("retention references belong to a different install home");
  await updateRegistration(canonicalHome, hubDirectory, homes.get(canonicalHome) ?? new Map(), true);
}

/**
 * Serializes acceptance against release. The caller reads the authoritative queue
 * inside refresh, so a captured-but-not-yet-accepted input can never lose its pin.
 * A failed state read releases nothing; stale pins affect only known versions.
 */
export class HubInstallationRetention {
  private pending: Promise<unknown> = Promise.resolve();
  private homes = new Set<string>();
  private running = true;
  private synchronized: string | undefined;
  private readonly owners = new Map<string, { identity: string; references: string[] }>();
  private readonly homesFile: string;
  private constructor(private readonly directory: string, private readonly daemonPaths: readonly string[], private readonly submissions: () => readonly HubSubmission[] | undefined) {
    this.homesFile = path.join(directory, "retention-homes.json");
  }

  static async open(directory: string, daemonPaths: readonly string[], submissions: () => readonly HubSubmission[] | undefined): Promise<HubInstallationRetention> {
    const retention = new HubInstallationRetention(directory, daemonPaths, submissions);
    try {
      const saved: unknown = JSON.parse(await limitedText(retention.homesFile, 64 * 1024));
      if (!Array.isArray(saved) || saved.length > 1024 || saved.some((item) => typeof item !== "string" || !path.isAbsolute(item))) throw new Error("invalid hub retention homes registry");
      retention.homes = new Set(saved as string[]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await retention.add(daemonPaths);
    return retention;
  }

  protect<T>(references: readonly string[], accept: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      if (!this.running) throw new Error("hub retention is shutting down");
      await this.add(references);
      return await accept();
    });
  }

  refresh(): Promise<void> { return this.serialize(() => this.reconcile()); }
  close(): Promise<void> {
    return this.serialize(async () => { this.running = false; await this.reconcile(); });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => undefined);
    return result;
  }
  private async remember(homes: Iterable<string>): Promise<void> {
    const next = new Set([...this.homes, ...homes]);
    if (next.size !== this.homes.size) {
      if (next.size > 1024 || Buffer.byteLength(JSON.stringify([...next])) > 64 * 1024) throw new Error("hub references too many install homes");
      // Persist discovery before adding markers, so a crash cannot orphan their home.
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await atomicRecord(this.homesFile, [...next].sort());
      await syncDirectory(this.directory);
      this.homes = next;
    }
  }
  private async add(paths: readonly string[]): Promise<void> {
    this.synchronized = undefined;
    const homes = await installedReferences(paths);
    await this.remember(homes.keys());
    for (const home of [...homes.keys()].sort()) await updateRegistration(home, this.directory, homes.get(home)!, false);
  }
  private async reconcile(): Promise<void> {
    const submissions = this.submissions();
    if (!submissions) throw new Error("hub state unavailable; retaining installation pins");
    const references = this.running ? [...this.daemonPaths] : [];
    const retainedRuns = new Set(submissions.filter((s) => s.launch || (s.state !== "succeeded" && s.state !== "canceled")).map((s) => s.runId));
    for (const runId of this.owners.keys()) if (!retainedRuns.has(runId)) this.owners.delete(runId);
    for (const submission of submissions) {
      // Failure, pause and blocked states are resumable. A launch remains retained
      // even with a terminal label until its process and external work are drained.
      if (!submission.launch && (submission.state === "succeeded" || submission.state === "canceled")) continue;
      references.push(...inputReferences(submission));
      if (submission.generation > 0) references.push(...await ownerReferences(this.directory, submission, this.owners));
    }
    const homes = await installedReferences(references);
    await this.remember(homes.keys());
    const signature = JSON.stringify([...homes].map(([home, versions]) => [home, [...versions.keys()].sort()]).sort());
    if (signature === this.synchronized) return;
    // Install every new reference before dropping any old one, also across homes.
    for (const home of [...homes.keys()].sort()) await updateRegistration(home, this.directory, homes.get(home)!, false);
    for (const home of [...this.homes].sort()) {
      try { await updateRegistration(home, this.directory, homes.get(home) ?? new Map(), true); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || homes.has(home)) throw error; }
    }
    this.synchronized = signature;
  }
}

/** Captured input, plus the plugin an accepted `--update-plugin` moves to until its launch settles. */
export function inputReferences(submission: { input: Pick<HubInput, "runtimePath" | "bundlePath" | "runtimeNode" | "runtimeRoot">; pendingCommand?: HubCommand; launch?: { command?: HubCommand } }): string[] {
  const { input } = submission;
  const plugins = [submission.pendingCommand, submission.launch?.command].flatMap((command) => command?.remedy?.plugin ? [command.remedy.plugin.bundlePath] : []);
  return [input.runtimePath, input.bundlePath, ...plugins, ...(input.runtimeNode ? [input.runtimeNode] : []), ...(input.runtimeRoot ? [input.runtimeRoot] : [])];
}

/**
 * Include current ownership after explicit upgrades and installed executor/plugin pins.
 * A launch that failed before its first state save leaves neither state.json nor the
 * execution marker the controller syncs before any upgrade or graph effect: only the
 * captured input can be referenced. Missing state after that marker fails conservatively.
 */
async function ownerReferences(directory: string, submission: HubSubmission, cache: Map<string, { identity: string; references: string[] }>): Promise<string[]> {
  const runDirectory = path.join(directory, "runs", submission.runId);
  let handle;
  try { handle = await open(path.join(runDirectory, "state.json"), "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const started = await access(path.join(runDirectory, "managed-execution-started.json")).then(() => true, (marker: NodeJS.ErrnoException) => { if (marker.code === "ENOENT") return false; throw marker; });
    if (started) throw new Error("managed execution started but run state is missing; retaining installation pins");
    cache.delete(submission.runId);
    return inputReferences(submission);
  }
  let identity: string;
  let state: unknown;
  try {
    const stat = await handle.stat();
    identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = cache.get(submission.runId);
    if (cached?.identity === identity) return cached.references;
    if (stat.size > 64 * 1024 * 1024) throw new Error("hub retention input exceeds size limit");
    state = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!isObject(state) || state.runId !== submission.runId || !isObject(state.install) || typeof state.install.root !== "string" || !path.isAbsolute(state.install.root)
    || !isObject(state.intake) || !isObject(state.intake.bundle) || typeof state.intake.bundle.bundlePath !== "string" || !path.isAbsolute(state.intake.bundle.bundlePath)) throw new Error("run ownership unavailable; retaining installation pins");
  const references = [state.install.root, state.intake.bundle.bundlePath];
  if (state.executorCatalog !== undefined) {
    if (!Array.isArray(state.executorCatalog)) throw new Error("invalid run executor pins; retaining installation pins");
    for (const executor of state.executorCatalog) {
      if (!isObject(executor) || typeof executor.source !== "string") throw new Error("invalid run executor pin; retaining installation pins");
      if (path.isAbsolute(executor.source)) references.push(executor.source);
      else if (executor.source !== "in-process") throw new Error("invalid run executor path; retaining installation pins");
    }
  }
  cache.set(submission.runId, { identity, references });
  return references;
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function updateRegistration(home: string, hubDirectory: string, versions: Map<string, string[]>, replace: boolean): Promise<void> {
  await access(home);
  await withInstallLock(home, async () => {
    // Prune may have won the lock after capture. Refuse acceptance if an input vanished.
    for (const references of versions.values()) for (const reference of references) await access(reference);
    const directory = path.join(home, "hub-retention");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const version of versions.keys()) {
      const destination = hubRetentionFile(home, hubDirectory, version);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const record = { protocolVersion: 2, hubDirectory: path.resolve(hubDirectory), version };
      let unchanged = false;
      try { unchanged = await limitedText(destination, 16 * 1024) === JSON.stringify(record); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!unchanged) { await atomicRecord(destination, record); await syncDirectory(path.dirname(destination)); }
    }
    await syncDirectory(directory);
    await syncDirectory(home);
    if (!replace) return;
    for (const entry of await readdir(directory)) {
      if (!versionPattern.test(entry) || versions.has(entry)) continue;
      const file = hubRetentionFile(home, hubDirectory, entry);
      const versionDirectory = path.dirname(file);
      for (const entry of await readdir(versionDirectory)) {
        if (entry !== path.basename(file) && !(entry.startsWith(`${path.basename(file)}.`) && entry.endsWith(".tmp"))) continue;
        await unlink(path.join(versionDirectory, entry));
      }
      await syncDirectory(versionDirectory);
      try { await rmdir(path.dirname(file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
    }
    await syncDirectory(directory);
  });
}

async function atomicRecord(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch(() => undefined); }
}
async function limitedText(file: string, maximum: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    if ((await handle.stat()).size > maximum) throw new Error("hub retention input exceeds size limit");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function withInstallLock<T>(home: string, work: () => Promise<T>): Promise<T> {
  const child = spawn("flock", ["--exclusive", "--timeout", "30", "--no-fork", path.join(home, "install.lock"), "sh", "-c", "printf 'locked\\n'; read -r release || :"], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`cannot retain hub installation: flock exited ${code}: ${stderr}`)));
      child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("locked\n")) resolve(); });
    });
    return await work();
  } finally { child.stdin.end(); await closed; }
}
