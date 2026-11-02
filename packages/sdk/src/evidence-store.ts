// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Externalized evidence payloads (docs/design-typescript-core.md, "Evidence storage").
 *
 * The controller moves every large part of an evidence payload into a
 * content-addressed, immutable blob file and records the move on the record
 * (`EvidenceRecord.externalized`). The externalized form is canonical in
 * memory, in `state.json` and on the wire. A plugin worker installs lazy
 * getters at the recorded paths, so plugin code reads
 * `record.payload.command.argv` exactly as before and the bytes are read only
 * when something touches them.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import type { EvidenceRecord, ExternalizedPart } from "./types.js";

/** The environment variable that tells a plugin worker where the run's evidence blobs live. */
export const EVIDENCE_STORE_ENV = "GRAPHLOOM_EVIDENCE_STORE";

/** A payload part whose JSON serialization is larger than this many bytes is externalized. */
export const DEFAULT_EXTERNALIZE_THRESHOLD = 8 * 1024;

/** A blob is missing or does not match the digest the record names. */
export class EvidenceUnavailableError extends Error {
  readonly code = "evidence_unavailable" as const;
  readonly sha256: string;

  constructor(sha256: string, detail: string) {
    super(`evidence ${sha256} is unavailable: ${detail}`);
    this.name = "EvidenceUnavailableError";
    this.sha256 = sha256;
  }
}

/** True for an EvidenceUnavailableError, also across duplicate copies of this module and `cause` chains. */
export function isEvidenceUnavailable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e !== null && typeof e === "object" && depth < 5; depth += 1) {
    if ((e as { code?: unknown }).code === "evidence_unavailable") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Reads one externalized part's value; throws EvidenceUnavailableError when it cannot. */
export type EvidencePartReader = (part: ExternalizedPart) => unknown;

export interface EvidenceBlob {
  sha256: string;
  /** The part's JSON text, exactly the bytes whose digest `sha256` is. */
  text: string;
}

export interface ExternalizedPayload {
  payload: unknown;
  externalized: ExternalizedPart[];
  blobs: EvidenceBlob[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const NULL_SIZE = 4;
/** A member smaller than this is not stored on its own; it stays with its container. */
const MIN_PART_BYTES = 512;

/** `<storeDir>/sha256/<hex>.json`. */
export function evidenceBlobPath(storeDir: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new EvidenceUnavailableError(sha256, "not a sha256 digest");
  return path.join(storeDir, "sha256", `${sha256}.json`);
}

/** The blob's path relative to the state directory that holds `evidence/`. */
export function evidenceBlobName(sha256: string): string {
  return `evidence/sha256/${sha256}.json`;
}

/** Verifies `text` against the digest and parses it. */
export function parseEvidenceBlob(part: Pick<ExternalizedPart, "sha256">, text: string): unknown {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  if (digest !== part.sha256) throw new EvidenceUnavailableError(part.sha256, `content digest is ${digest}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EvidenceUnavailableError(part.sha256, "content is not valid JSON");
  }
}

/** Reads, verifies and parses one blob of the store at `storeDir`. */
export function readEvidencePart(storeDir: string, part: Pick<ExternalizedPart, "sha256">): unknown {
  const file = evidenceBlobPath(storeDir, part.sha256);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new EvidenceUnavailableError(
      part.sha256,
      (err as NodeJS.ErrnoException).code === "ENOENT" ? "blob file is missing" : `cannot read blob: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseEvidenceBlob(part, text);
}

/** A reader over the store at `storeDir`. */
export function evidenceStoreReader(storeDir: string): EvidencePartReader {
  return (part) => readEvidencePart(storeDir, part);
}

/** The file system calls `writeEvidenceBlobs` makes, so a test can watch the order of them. */
export interface EvidenceFs {
  existsSync(file: string): boolean;
  statSync(file: string): { size: number };
  mkdirSync(dir: string, options: { recursive: true }): unknown;
  openSync(file: string, flags: string): number;
  writeSync(fd: number, text: string, position: null, encoding: "utf8"): unknown;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
}

const nodeFs: EvidenceFs = { existsSync, statSync, mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync };

/** fsync of a directory makes the entries created or renamed in it durable; a file system that cannot is skipped. */
function syncDirectory(fs: EvidenceFs, dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EPERM" && code !== "EACCES") throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Writes blobs durably: each is fsynced under a temporary name and renamed into place, and then its directory is
 * fsynced so the rename itself survives a crash. Directories this call creates (the store, `sha256`, parents) are
 * made durable too, each by an fsync of its parent. One already present with the right size is left alone (content
 * addressing makes a rewrite pointless). Call before the state save that references them; a crash in between
 * leaves an orphan blob, never a dangling reference.
 */
export function writeEvidenceBlobs(storeDir: string, blobs: readonly EvidenceBlob[], fs: EvidenceFs = nodeFs): void {
  for (const blob of blobs) {
    const file = evidenceBlobPath(storeDir, blob.sha256);
    const bytes = Buffer.byteLength(blob.text, "utf8");
    if (fs.existsSync(file) && fs.statSync(file).size === bytes) continue;
    const dir = path.dirname(file);
    // Each directory that does not exist yet, outermost first.
    const created: string[] = [];
    for (let d = dir; !fs.existsSync(d); d = path.dirname(d)) {
      created.unshift(d);
      if (path.dirname(d) === d) break;
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, blob.text, null, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    syncDirectory(fs, dir);
    for (const made of created) syncDirectory(fs, path.dirname(made));
  }
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

/** JSON `undefined` semantics: an object member that serializes to nothing is absent. */
function isAbsent(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

interface Child {
  key: string | number;
  value: unknown;
  /** The member as it was handed in, before anything was shed from inside it. */
  original: unknown;
  size: number;
  /** Object members cost `"key":` plus the value; array elements just the value. */
  overhead: number;
  descended: boolean;
  externalized: boolean;
  /** An immutable member (the root's `producer`). */
  fixed: boolean;
}

/**
 * Moves every part of `payload` whose JSON serialization exceeds `threshold` bytes out of it, largest first,
 * leaving `null` in its place. The root is never externalized; neither is the root member `producer`. A part is
 * externalized at the deepest level that leaves the enclosing object within the threshold, so small identifying
 * fields (`command.id`, `exitCode`, `path`) stay inline. Deterministic: the same payload and threshold always
 * give the same result.
 */
export function externalizePayload(payload: unknown, threshold: number = DEFAULT_EXTERNALIZE_THRESHOLD): ExternalizedPayload {
  const parts: ExternalizedPart[] = [];
  const blobs = new Map<string, EvidenceBlob>();
  const sizes = new Map<object, number>();

  const sizeOf = (value: unknown): number => {
    if (isAbsent(value)) return 0;
    if (!isContainer(value)) return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
    const known = sizes.get(value);
    if (known !== undefined) return known;
    let total = 2;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        total += (i > 0 ? 1 : 0) + (isAbsent(item) ? NULL_SIZE : sizeOf(item));
      });
    } else {
      let first = true;
      for (const [key, item] of Object.entries(value)) {
        if (isAbsent(item)) continue;
        total += (first ? 0 : 1) + Buffer.byteLength(JSON.stringify(key), "utf8") + 1 + sizeOf(item);
        first = false;
      }
    }
    sizes.set(value, total);
    return total;
  };

  const externalize = (value: unknown, at: Array<string | number>): void => {
    const text = JSON.stringify(value);
    const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
    blobs.set(sha256, { sha256, text });
    parts.push({ path: at, sha256, bytes: Buffer.byteLength(text, "utf8") });
  };

  const children = (value: Record<string, unknown> | unknown[], root: boolean): Child[] => {
    if (Array.isArray(value)) {
      return value.map((item, key) => ({
        key,
        value: item,
        original: item,
        size: isAbsent(item) ? NULL_SIZE : sizeOf(item),
        overhead: 0,
        descended: false,
        externalized: false,
        fixed: false,
      }));
    }
    const out: Child[] = [];
    for (const [key, item] of Object.entries(value)) {
      if (isAbsent(item)) continue;
      out.push({
        key,
        value: item,
        original: item,
        size: sizeOf(item),
        overhead: Buffer.byteLength(JSON.stringify(key), "utf8") + 1,
        descended: false,
        externalized: false,
        fixed: root && key === "producer",
      });
    }
    return out;
  };

  /** Drops the parts recorded under `at`: the part at `at` itself replaces them. */
  const forget = (at: ReadonlyArray<string | number>): void => {
    for (let n = parts.length - 1; n >= 0; n -= 1) {
      const p = parts[n]!;
      if (p.path.length > at.length && at.every((key, d) => p.path[d] === key)) parts.splice(n, 1);
    }
  };

  /** Returns `value` with its large parts replaced, and its new size. */
  const reduce = (value: unknown, at: Array<string | number>, root: boolean): { value: unknown; size: number } => {
    const size = sizeOf(value);
    if (size <= threshold) return { value, size };
    if (!isContainer(value)) {
      if (root) return { value, size };
      externalize(value, at);
      return { value: null, size: NULL_SIZE };
    }
    const kids = children(value, root);
    // Members worth a blob of their own; many tiny ones are not shed one by one, their container is stored whole.
    const worthy = (k: Child): boolean => !k.fixed && k.size >= MIN_PART_BYTES;
    const floor = size - kids.filter(worthy).reduce((n, k) => n + k.size - NULL_SIZE, 0);
    if (!root && floor > threshold) {
      externalize(value, at);
      return { value: null, size: NULL_SIZE };
    }
    let total = size;
    while (total > threshold) {
      // The largest member still reducible; ties go to the earliest.
      let pick: Child | undefined;
      for (const k of kids) {
        if (k.fixed || k.externalized || k.size <= NULL_SIZE || !(worthy(k) || k.descended)) continue;
        if (pick === undefined || k.size > pick.size) pick = k;
      }
      // The root cannot be externalized, so it only sheds members that are themselves over the threshold.
      if (pick === undefined || (root && !(pick.size > threshold && !pick.descended))) break;
      const childPath = [...at, pick.key];
      if (pick.size > threshold && !pick.descended) {
        const reduced = reduce(pick.value, childPath, false);
        total += reduced.size - pick.size;
        pick.descended = true;
        pick.value = reduced.value;
        pick.size = reduced.size;
        if (reduced.value === null && reduced.size === NULL_SIZE) pick.externalized = true;
      } else {
        // Stored whole: whatever was shed from inside it is part of it again.
        if (pick.descended) forget(childPath);
        externalize(pick.original, childPath);
        total += NULL_SIZE - pick.size;
        pick.value = null;
        pick.size = NULL_SIZE;
        pick.externalized = true;
      }
    }
    if (Array.isArray(value)) return { value: kids.map((k) => k.value), size: total };
    const next: Record<string, unknown> = {};
    for (const k of kids) next[k.key as string] = k.value;
    return { value: next, size: total };
  };

  const reduced = reduce(payload, [], true);
  const referenced = new Set(parts.map((p) => p.sha256));
  return { payload: reduced.value, externalized: parts, blobs: [...blobs.values()].filter((b) => referenced.has(b.sha256)) };
}

/** `node` with `part` set at `at`, copying only the containers along the path. */
function withPartAt(node: unknown, at: ReadonlyArray<string | number>, depth: number, part: unknown): unknown {
  if (depth === at.length) return part;
  if (!isContainer(node)) throw new EvidenceUnavailableError("", `externalized path ${JSON.stringify(at)} does not exist in the payload`);
  const key = at[depth]!;
  const copy = (Array.isArray(node) ? [...node] : { ...node }) as Record<string | number, unknown>;
  copy[key] = withPartAt(copy[key], at, depth + 1, part);
  return copy;
}

/** True when `a` is a proper prefix of `b`, or equal to it. */
function isPathPrefix(a: ReadonlyArray<string | number>, b: ReadonlyArray<string | number>): boolean {
  return a.length <= b.length && a.every((key, i) => b[i] === key);
}

/** The first pair of externalized parts one of which lies inside (or is) the other, or undefined when the paths are disjoint. */
export function overlappingParts(parts: readonly ExternalizedPart[]): [ExternalizedPart, ExternalizedPart] | undefined {
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      if (isPathPrefix(parts[i]!.path, parts[j]!.path) || isPathPrefix(parts[j]!.path, parts[i]!.path)) return [parts[i]!, parts[j]!];
    }
  }
  return undefined;
}

/** Throws when two externalized paths overlap: a part stored with a descendant still null would hydrate wrongly. */
export function assertDisjointParts(parts: readonly ExternalizedPart[]): void {
  const clash = overlappingParts(parts);
  if (clash !== undefined) throw new Error(`externalized parts overlap: ${JSON.stringify(clash[0].path)} and ${JSON.stringify(clash[1].path)}`);
}

/** The record with every externalized part read back in and `externalized` dropped; the same record when it has none. */
export function hydrateRecord<T extends EvidenceRecord>(record: T, read: EvidencePartReader): T {
  if (record.externalized === undefined) return record;
  assertDisjointParts(record.externalized);
  let payload: unknown = record.payload;
  for (const part of record.externalized) payload = withPartAt(payload, part.path, 0, read(part));
  const { externalized: _done, ...rest } = record;
  void _done;
  return (record.externalized.length === 0 ? rest : { ...rest, payload }) as T;
}

/**
 * Installs an enumerable lazy getter at each externalized path of `record.payload`, in place. The first read of a
 * part loads it through `read` (cached in `cache`, which a caller shares across the records of one call), then
 * the getter replaces itself with the value. A failing read throws EvidenceUnavailableError at the access.
 */
export function installLazyPayload(record: EvidenceRecord, read: EvidencePartReader, cache: Map<string, unknown> = new Map()): void {
  if (record.externalized === undefined) return;
  assertDisjointParts(record.externalized);
  for (const part of record.externalized) {
    let parent: unknown = record.payload;
    for (let i = 0; i < part.path.length - 1 && isContainer(parent); i += 1) parent = (parent as Record<string | number, unknown>)[part.path[i]!];
    const key = part.path[part.path.length - 1];
    if (!isContainer(parent) || key === undefined) continue;
    const holder = parent as Record<string | number, unknown>;
    const settle = (value: unknown): void => {
      Object.defineProperty(holder, key, { value, enumerable: true, writable: true, configurable: true });
    };
    Object.defineProperty(holder, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        let value = cache.get(part.sha256);
        if (value === undefined) {
          value = read(part);
          cache.set(part.sha256, value);
        }
        settle(value);
        return value;
      },
      set: settle,
    });
  }
}
