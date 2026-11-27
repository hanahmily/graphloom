// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireFileLock, type FileLock } from "./lock.js";
import { DAY, INSTANT, realDay, validInstant } from "./instant.js";

export const LOOP_STATE_SCHEMA = "graphloom-loop-v1";

export interface LoopSubmissionRecord {
  subject: string;
  key: string;
  generation: number;
  /** UTC instant the intent was written (the caller's clock). */
  intentAt: string;
  runId?: string;
}

export interface LoopState {
  schema: typeof LOOP_STATE_SCHEMA;
  /** Current generation per subject; absent means 0. */
  generations: Record<string, number>;
  /** By run key. */
  submissions: Record<string, LoopSubmissionRecord>;
}

export class LoopStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopStoreError";
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Write temp, fsync, rename, fsync the parent. */
export async function atomicWrite(file: string, bytes: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  try {
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function requireInstant(now: string, what: string): void {
  if (!validInstant(now)) {
    throw new LoopStoreError(`${what} must be a UTC instant ending in Z, such as 2026-03-04T05:06:07Z`);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Data {
  generations: Map<string, number>;
  submissions: Map<string, LoopSubmissionRecord>;
}

function emptyData(): Data {
  return { generations: new Map(), submissions: new Map() };
}

function cloneData(data: Data): Data {
  return {
    generations: new Map(data.generations),
    submissions: new Map([...data.submissions].map(([k, v]) => [k, { ...v }])),
  };
}

function parse(text: string): Data {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new LoopStoreError("state.json is not valid JSON"); }
  const schema = plainObject(value) ? value.schema : undefined;
  if (schema !== LOOP_STATE_SCHEMA) {
    const newer = typeof schema === "string" && /^graphloom-loop-v([2-9]|[1-9][0-9]+)$/.test(schema);
    throw new LoopStoreError(newer ? `state.json has schema ${schema}, newer than this graphloom understands (${LOOP_STATE_SCHEMA}); upgrade graphloom` : `state.json has an unknown schema ${JSON.stringify(schema)}`);
  }
  const { generations, submissions } = value as Record<string, unknown>;
  if (!plainObject(generations) || !plainObject(submissions)) throw new LoopStoreError("state.json is malformed");
  const data = emptyData();
  for (const [subject, generation] of Object.entries(generations)) {
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      throw new LoopStoreError(`state.json is malformed: generation of ${JSON.stringify(subject)} must be a non-negative integer`);
    }
    data.generations.set(subject, generation);
  }
  for (const [key, record] of Object.entries(submissions)) {
    const bad = (rule: string): never => { throw new LoopStoreError(`state.json is malformed: submission ${JSON.stringify(key)} ${rule}`); };
    if (!plainObject(record)) bad("must be an object");
    const r = record as Record<string, unknown>;
    if (typeof r.subject !== "string") bad("needs a string subject");
    if (typeof r.key !== "string" || r.key !== key) bad("needs a string key equal to its entry name");
    if (typeof r.generation !== "number" || !Number.isSafeInteger(r.generation) || r.generation < 0) bad("needs a non-negative integer generation");
    if (!validInstant(r.intentAt)) bad("needs an intentAt that is a UTC instant ending in Z");
    if (r.runId !== undefined && typeof r.runId !== "string") bad("has a runId that is not a string");
    data.submissions.set(key, {
      subject: r.subject as string,
      key,
      generation: r.generation as number,
      intentAt: r.intentAt as string,
      ...(r.runId === undefined ? {} : { runId: r.runId as string }),
    });
  }
  return data;
}

function serialise(data: Data): string {
  // Null-prototype objects keep a "__proto__" subject an ordinary own key.
  const generations: Record<string, number> = Object.create(null);
  for (const [k, v] of data.generations) generations[k] = v;
  const submissions: Record<string, LoopSubmissionRecord> = Object.create(null);
  for (const [k, v] of data.submissions) submissions[k] = { ...v };
  return `${JSON.stringify({ schema: LOOP_STATE_SCHEMA, generations, submissions }, null, 2)}\n`;
}

/**
 * The durable state of one loop. One kernel lock (flock, see lock.ts) is held for the
 * store's lifetime; every mutation runs in one promise chain against the current state
 * and is applied to memory only after it is durable.
 */
export class LoopStore {
  private chain: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;
  private broken: Error | undefined;

  private constructor(private readonly file: string, private readonly lock: FileLock, private data: Data, private readonly health: { lost: boolean }) {}

  static async open(directory: string): Promise<LoopStore> {
    const health = { lost: false };
    const lock = await acquireFileLock(directory, "state.lock", () => { health.lost = true; });
    try {
      const file = path.join(lock.directory, "state.json");
      const text = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      return new LoopStore(file, lock, text === undefined ? emptyData() : parse(text), health);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /**
   * Release the lock this instance holds, after the mutations already queued have been written.
   * Idempotent; mutations requested after close() was called are refused.
   */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.chain.catch(() => undefined);
      await this.lock.release();
    })();
    return this.closing;
  }

  snapshot(): LoopState {
    const generations: Record<string, number> = Object.create(null);
    for (const [k, v] of this.data.generations) generations[k] = v;
    const submissions: Record<string, LoopSubmissionRecord> = Object.create(null);
    for (const [k, v] of this.data.submissions) submissions[k] = { ...v };
    return { schema: LOOP_STATE_SCHEMA, generations, submissions };
  }

  generation(subject: string): number {
    return this.data.generations.get(subject) ?? 0;
  }

  /**
   * Run one mutation in the chain: `change` edits a copy of the current state and returns
   * the result; the copy replaces memory only after it is durable. If the write fails the
   * file is re-read, so memory equals what is durable (the rename may have landed before a
   * directory fsync failed); if that read fails too the store refuses all further use.
   */
  private mutate<T>(change: (next: Data) => T | "unchanged"): Promise<T | undefined> {
    if (this.closing) return Promise.reject(new LoopStoreError("loop store is closed"));
    const run = async (): Promise<T | undefined> => {
      if (this.health.lost) throw new LoopStoreError("loop store lock was lost: the lock helper exited, so another process may hold the store; reopen it");
      if (this.broken) throw new LoopStoreError(`loop store is unusable after a failed write: ${this.broken.message}`);
      const next = cloneData(this.data);
      const result = change(next);
      if (result === "unchanged") return undefined;
      try {
        await atomicWrite(this.file, serialise(next));
      } catch (error) {
        try {
          const text = await readFile(this.file, "utf8").catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return undefined; // nothing was ever durable
            throw e;
          });
          this.data = text === undefined ? emptyData() : parse(text);
        } catch {
          this.broken = error as Error;
        }
        throw error;
      }
      this.data = next;
      return result;
    };
    const promise = this.chain.then(run, run);
    this.chain = promise.catch(() => undefined);
    return promise;
  }

  /** Write-ahead: record that `key` is about to be submitted. Idempotent for the same key. */
  async intent(subject: string, key: string, now: string): Promise<void> {
    requireInstant(now, "now");
    await this.mutate((next) => {
      if (next.submissions.has(key)) return "unchanged";
      next.submissions.set(key, { subject, key, generation: next.generations.get(subject) ?? 0, intentAt: now });
      return true;
    });
  }

  /** Record that the submit for `key` landed as `runId`. */
  async started(key: string, runId: string): Promise<void> {
    await this.mutate((next) => {
      const record = next.submissions.get(key);
      if (!record) throw new LoopStoreError(`no intent recorded for ${key}`);
      if (record.runId === runId) return "unchanged";
      if (record.runId !== undefined) throw new LoopStoreError(`${key} already started as ${record.runId}`);
      record.runId = runId;
      return true;
    });
  }

  /** Intents with no `started`: the caller asks the hub by key whether each submit landed. */
  recover(): LoopSubmissionRecord[] {
    return [...this.data.submissions.values()].filter((r) => r.runId === undefined).map((r) => ({ ...r }));
  }

  /**
   * Bump the subject's generation so its next run key is new; returns the new generation.
   * Refuses while the subject has an intent with no runId (an unfinished submit the caller
   * must recover first). The store has no hub state: the caller (the CLI or hub path) must
   * also unpark only a subject whose current key is blocked, failed or refused.
   */
  async unpark(subject: string): Promise<number> {
    return (await this.mutate((next) => {
      for (const r of next.submissions.values()) {
        if (r.subject === subject && r.runId === undefined) {
          throw new LoopStoreError(`cannot unpark ${JSON.stringify(subject)}: ${r.key} has an intent with no run id; recover it first`);
        }
      }
      const generation = (next.generations.get(subject) ?? 0) + 1;
      next.generations.set(subject, generation);
      return generation;
    }))!;
  }

  /** Submissions whose intent was written on the given UTC day ("YYYY-MM-DD", or a UTC instant ending in Z). */
  startsOn(day: string): number {
    if (typeof day === "string" && INSTANT.test(day)) requireInstant(day, "now");
    else if (typeof day !== "string" || !DAY.test(day) || !realDay(day)) throw new LoopStoreError("startsOn needs a UTC day (YYYY-MM-DD) or a UTC instant ending in Z");
    const prefix = day.slice(0, 10);
    return [...this.data.submissions.values()].filter((r) => r.intentAt.startsWith(prefix)).length;
  }
}
