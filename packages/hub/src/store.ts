// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HubArchivedSubmission, HubConfig, HubLaunch, HubObservation, HubSubmission } from "@graphloom/sdk";

export const SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const LIFECYCLE_RESERVE = 2 * 1024 * 1024;
export const RECORD_RESERVE = 20 * 1024;
export const RECORD_LIMIT = 16 * 1024;
export interface HubSnapshot {
  schemaVersion: 1;
  hubId: string;
  config: HubConfig;
  sequence: number;
  submissions: Record<string, HubSubmission>;
  tombstones: HubArchivedSubmission[];
}
export interface JournalEntry { commandId: string; digest: string; acceptedAt: string; event?: "settled"; launch?: HubLaunch; observation?: HubObservation; }
export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableWrite(file: string, bytes: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
export function assertCapacity(snapshot: HubSnapshot): void {
  const records = Object.values(snapshot.submissions);
  if (records.length > 10_000) throw new Error("hub retained submission limit reached; archive terminal submissions");
  for (const record of records) {
    if (Buffer.byteLength(JSON.stringify(record)) > RECORD_LIMIT) throw new Error("hub operational record exceeds its bounded reservation");
  }
  const globalSize = Buffer.byteLength(JSON.stringify({ ...snapshot, submissions: {} }));
  if (globalSize + records.length * 1024 > LIFECYCLE_RESERVE || globalSize + records.length * RECORD_RESERVE > SNAPSHOT_LIMIT - LIFECYCLE_RESERVE) {
    throw new Error("hub durable capacity reached; archive terminal submissions");
  }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_LIMIT) throw new Error("hub snapshot exceeds 16 MiB");
}
export class HubStore {
  constructor(readonly directory: string) {}
  async load(): Promise<HubSnapshot | undefined> {
    const file = path.join(this.directory, "scheduler.json");
    let bytes: string;
    try {
      if ((await stat(file)).size > SNAPSHOT_LIMIT) throw new Error("hub snapshot exceeds 16 MiB");
      bytes = await readFile(file, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const result: unknown = JSON.parse(bytes);
    validateSnapshot(result);
    assertCapacity(result);
    for (const s of Object.values(result.submissions)) {
      const expected = path.join(this.directory, "submissions", s.id);
      if (s.input.taskFile !== path.join(expected, "task.yaml") || s.input.configFile !== undefined && s.input.configFile !== path.join(expected, "config.json")) throw new Error("hub immutable input path escapes its submission");
    }
    return result;
  }
  async save(snapshot: HubSnapshot): Promise<void> {
    assertCapacity(snapshot);
    await durableWrite(path.join(this.directory, "scheduler.json"), `${JSON.stringify(snapshot)}\n`);
  }
  async journal(submission: HubSubmission, entry: JournalEntry): Promise<number> {
    const file = path.join(this.directory, "submissions", submission.id, "commands.ndjson");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, "a+", 0o600);
    try {
      // A prior failed snapshot may leave an uncommitted suffix. It has no authority.
      if ((await handle.stat()).size < submission.journalBytes) throw new Error("hub command journal shorter than committed cursor");
      await handle.truncate(submission.journalBytes);
      const bytes = `${JSON.stringify(entry)}\n`;
      await handle.writeFile(bytes);
      await handle.sync();
      // Persist a newly created journal's directory entry before its cursor can commit.
      await syncDirectory(path.dirname(file));
      return submission.journalBytes + Buffer.byteLength(bytes);
    } finally { await handle.close(); }
  }
  async command(submission: HubSubmission, commandId: string): Promise<JournalEntry | undefined> {
    if (submission.journalBytes === 0) return;
    const handle = await open(path.join(this.directory, "submissions", submission.id, "commands.ndjson"), "r");
    try {
      let position = 0;
      let pending = "";
      const decoder = new StringDecoder("utf8");
      while (position < submission.journalBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, submission.journalBytes - position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw new Error("hub command journal shorter than committed cursor");
        position += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          const entry = JSON.parse(pending.slice(0, newline)) as JournalEntry;
          pending = pending.slice(newline + 1);
          if (!entry.event && entry.commandId === commandId) return entry;
        }
        if (pending.length > 8192) throw new Error("invalid oversized hub journal entry");
      }
      if (pending) throw new Error("hub journal cursor is not a complete record");
    } finally { await handle.close(); }
    return;
  }
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function validateConfig(value: unknown): asserts value is HubConfig {
  if (!object(value) || !object(value.retry)) throw new Error("invalid hub configuration");
  for (const [key, min, max] of [["maxConcurrentRuns", 0, 10000], ["pollIntervalMs", 10, 3600000], ["shutdownGraceMs", 0, 3600000]] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < min || Number(value[key]) > max) throw new Error(`invalid hub ${key}`);
  }
  if (typeof value.retry.automatic !== "boolean") throw new Error("invalid automatic retry policy");
  for (const key of ["maxAutomaticResumes", "maxElapsedMs", "baseDelayMs", "maxDelayMs"]) {
    if (!Number.isSafeInteger(value.retry[key]) || Number(value.retry[key]) < 0 || Number(value.retry[key]) > 365 * 86400000) throw new Error(`invalid retry ${key}`);
  }
  if (Number(value.retry.baseDelayMs) > Number(value.retry.maxDelayMs)) throw new Error("retry base delay exceeds maximum delay");
}
function validateSnapshot(value: unknown): asserts value is HubSnapshot {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.hubId !== "string" || !object(value.submissions) || !Array.isArray(value.tombstones) || !Number.isSafeInteger(value.sequence)) {
    throw new Error("invalid or unsupported hub snapshot schema");
  }
  validateConfig(value.config);
  const runIds = new Set<string>();
  for (const [key, item] of Object.entries(value.submissions)) {
    if (!object(item) || item.id !== key || !/^s-[a-f0-9-]{36}$/.test(key) || typeof item.runId !== "string" || runIds.has(item.runId) || item.hubId !== value.hubId || !object(item.input)) throw new Error("invalid or duplicate hub submission binding");
    runIds.add(item.runId);
    if (!["execute", "hold", "cancel"].includes(String(item.desiredAction)) || !["queued", "starting", "running", "stopping", "waiting", "paused", "blocked", "succeeded", "failed", "canceled"].includes(String(item.state))) throw new Error("invalid hub submission state");
    for (const key of ["queueSequence", "generation", "automaticResumes", "failureRepeats", "progressRevision", "journalBytes"]) {
      if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) throw new Error(`invalid hub record ${key}`);
    }
    for (const key of ["acceptedAt", "updatedAt"]) if (typeof item[key] !== "string" || !Number.isFinite(Date.parse(String(item[key])))) throw new Error(`invalid hub timestamp ${key}`);
    if (typeof item.requestDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.requestDigest)) throw new Error("invalid hub request digest");
    if (typeof item.contentDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.contentDigest)) throw new Error("invalid hub content digest");
    if (item.key !== undefined && (typeof item.key !== "string" || Buffer.byteLength(item.key) > 256)) throw new Error("invalid idempotency key");
    for (const field of ["eligibleAt", "retryStartedAt"]) if (item[field] !== undefined && (typeof item[field] !== "string" || !Number.isFinite(Date.parse(String(item[field]))))) throw new Error("invalid hub deadline");
    for (const field of ["taskFile", "taskPath", "repoPath", "bundlePath", "runtimePath"]) if (typeof item.input[field] !== "string" || !path.isAbsolute(String(item.input[field]))) throw new Error("invalid hub input path");
    if (item.input.pluginLink !== undefined && (typeof item.input.pluginLink !== "string" || !path.isAbsolute(item.input.pluginLink))) throw new Error("invalid hub input path");
    validateConfig({ ...(value.config as object), retry: item.retry });
    if (item.launch !== undefined) {
      const launch = item.launch;
      if (!object(launch) || typeof launch.id !== "string" || !/^l-[a-f0-9-]{36}$/.test(launch.id) || launch.generation !== item.generation || !["reserved", "prepared", "granted"].includes(String(launch.phase)) || !["initial", "resume", "reconcile"].includes(String(launch.mode))) throw new Error("invalid hub launch reservation");
      if (launch.failure !== undefined && (!object(launch.failure) || typeof launch.failure.occurredAt !== "string" || !Number.isFinite(Date.parse(launch.failure.occurredAt)) || typeof launch.failure.message !== "string" || launch.failure.message.length === 0 || launch.failure.message.length > 1024)) throw new Error("invalid hub launch failure");
    }
  }
  for (const tombstone of value.tombstones) if (!object(tombstone) || tombstone.archived !== true || typeof tombstone.id !== "string" || typeof tombstone.runId !== "string" || typeof tombstone.requestDigest !== "string") throw new Error("invalid hub archive tombstone");
}
