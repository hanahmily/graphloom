// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { HubArchiveEntry } from "@graphloom/sdk";
import { durableWrite } from "./store.js";

/** Retention of the archive index (docs/design-run-hub.md §4.1): the newest entries within both bounds. */
export const ARCHIVE_INDEX_ENTRIES = 5000;
export const ARCHIVE_INDEX_BYTES = 8 * 1024 * 1024;
export const ARCHIVE_ENTRY_BYTES = 16 * 1024;
export const ARCHIVE_FIRST_LINE_CHARS = 200;
export const ARCHIVE_BLOCKER_CHARS = 512;
export const ARCHIVE_INDEX_FILE = "archive-index.json";

interface ArchiveIndexFile { schemaVersion: 1; hubId: string; entries: HubArchiveEntry[]; }
export interface ArchiveIndexBounds { entries: number; bytes: number; }

/**
 * Bounded history of archived submissions, oldest first. A separate file from
 * scheduler.json: it is history, never authority, so a damaged index is set aside
 * and reported instead of faulting admission. A hub store without the file starts
 * with an empty index.
 */
export class HubArchiveIndex {
  private constructor(private readonly file: string, private readonly hubId: string, private entries: HubArchiveEntry[], readonly loadError: string | undefined, private readonly bounds: ArchiveIndexBounds) {}

  static async open(directory: string, hubId: string, bounds: ArchiveIndexBounds = { entries: ARCHIVE_INDEX_ENTRIES, bytes: ARCHIVE_INDEX_BYTES }): Promise<HubArchiveIndex> {
    const file = path.join(directory, ARCHIVE_INDEX_FILE);
    try {
      if ((await stat(file)).size > bounds.bytes + 1024 * 1024) throw new Error("archive index exceeds its size bound");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!isIndex(value) || value.hubId !== hubId) throw new Error("invalid or foreign archive index");
      return new HubArchiveIndex(file, hubId, value.entries, undefined, bounds);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new HubArchiveIndex(file, hubId, [], undefined, bounds);
      // Keep the damaged bytes for the operator; never overwrite them with a fresh index.
      const aside = `${file}.damaged-${Date.now()}`;
      await rename(file, aside).catch(() => undefined);
      return new HubArchiveIndex(file, hubId, [], `archive index unreadable (${error instanceof Error ? error.message : String(error)}); set aside as ${path.basename(aside)}, starting empty`, bounds);
    }
  }

  list(): HubArchiveEntry[] { return structuredClone(this.entries); }
  get(id: string): HubArchiveEntry | undefined { const entry = this.entries.find((item) => item.id === id); return entry && structuredClone(entry); }
  get size(): number { return this.entries.length; }

  /** Adds or replaces `entry` (by submission id), evicts the oldest past the bounds, and syncs. */
  async add(entry: HubArchiveEntry): Promise<void> {
    const bounded = boundEntry(entry);
    const next = [...this.entries.filter((item) => item.id !== bounded.id), bounded];
    while (next.length > this.bounds.entries) next.shift();
    let bytes = Buffer.byteLength(serialize(this.hubId, next));
    while (bytes > this.bounds.bytes && next.length > 1) {
      bytes -= Buffer.byteLength(JSON.stringify(next.shift())) + 1;
    }
    await durableWrite(this.file, serialize(this.hubId, next));
    this.entries = next;
  }

  /** Records that the entry's run files were purged, in place (its position and other fields kept); false when no entry has `id`. */
  async markPurged(id: string, purgedAt: string): Promise<boolean> {
    const index = this.entries.findIndex((item) => item.id === id);
    if (index < 0) return false;
    if (this.entries[index]!.purgedAt !== undefined) return true;
    const next = this.entries.map((item, at) => at === index ? { ...item, purgedAt } : item);
    await durableWrite(this.file, serialize(this.hubId, next));
    this.entries = next;
    return true;
  }
}

function serialize(hubId: string, entries: HubArchiveEntry[]): string {
  return `${JSON.stringify({ schemaVersion: 1, hubId, entries } satisfies ArchiveIndexFile)}\n`;
}

function clip(text: string, chars: number): string { return text.length > chars ? `${text.slice(0, chars - 1)}…` : text; }

/** Free-text fields are clipped; an entry that still exceeds its bound keeps only identity and times. */
export function boundEntry(entry: HubArchiveEntry): HubArchiveEntry {
  const out: HubArchiveEntry = structuredClone(entry);
  if (out.request) out.request.firstLine = clip(out.request.firstLine, ARCHIVE_FIRST_LINE_CHARS);
  if (out.blocker !== undefined) out.blocker = clip(out.blocker.replace(/\s+/g, " ").trim(), ARCHIVE_BLOCKER_CHARS);
  if (Buffer.byteLength(JSON.stringify(out)) <= ARCHIVE_ENTRY_BYTES) return out;
  const { archived, id, runId, requestDigest, acceptedAt, settledAt, archivedAt, state, purgedAt } = out;
  return { archived, id, runId, requestDigest, acceptedAt, settledAt, archivedAt, state, repoPath: clip(out.repoPath, 1024), taskPath: clip(out.taskPath, 1024), ...(purgedAt !== undefined ? { purgedAt } : {}) };
}

function isIndex(value: unknown): value is ArchiveIndexFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Partial<ArchiveIndexFile>;
  return file.schemaVersion === 1 && typeof file.hubId === "string" && Array.isArray(file.entries) && file.entries.every((entry) =>
    typeof entry === "object" && entry !== null && entry.archived === true && typeof entry.id === "string" && typeof entry.runId === "string"
    && typeof entry.acceptedAt === "string" && typeof entry.archivedAt === "string" && typeof entry.state === "string"
    && typeof entry.repoPath === "string" && typeof entry.taskPath === "string");
}
