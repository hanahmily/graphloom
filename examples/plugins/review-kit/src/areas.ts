// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The areas of a large pull request (design §6.9): a deterministic partition of its changed files, a pure
 * function of the files, the profile's limits and `questions.excludeRoots`, so the graph and the validators
 * recompute the same areas from the snapshot.
 */
import { globToRegExp } from "./metrics/generated.js";
import type { Limits } from "./profile.js";
import type { PullFile } from "./snapshot.js";

/** The id of the area of generated files, which no agent reads as patches. */
export const GENERATED_AREA = "generated";

export interface Area {
  /** `A1`, `A2`, ... in path order; `generated` for the generated files. */
  id: string;
  /** What the area is, for people: its common path, `<parent>/(rest)` for merged siblings, `(files 2/3)` for a run of files. */
  name: string;
  /** The changed files' paths, sorted. */
  paths: string[];
  bytes: number;
  /** An agent reads the patches of a `read` area; the `generated` area is only listed with its diffstat. */
  kind: "read" | "generated";
}

export interface Partition {
  areas: Area[];
  /** Files an agent cannot read as patches because GitHub gave none (design §6.9: "patch not provided by GitHub"). */
  omitted: string[];
}

const bytesOf = (f: Pick<PullFile, "patch">): number => Buffer.byteLength(f.patch ?? "", "utf8");

/** A file the profile's `excludeRoots` name: a glob, or a path prefix. */
export function isExcluded(path: string, excludeRoots: readonly string[]): boolean {
  return excludeRoots.some((r) => (/[*?[]/.test(r) ? globToRegExp(r).test(path) : path === r || path.startsWith(r.endsWith("/") ? r : `${r}/`)));
}

/** A file whose patch GitHub did not give although it changed lines. */
export const patchOmitted = (f: Pick<PullFile, "patch" | "patchOmitted">): boolean => f.patchOmitted && f.patch === null;

interface Group {
  /** The path segments every file shares, which names the group. */
  prefix: string[];
  label: string;
  files: PullFile[];
  bytes: number;
}

const sum = (files: readonly PullFile[]): number => files.reduce((n, f) => n + bytesOf(f), 0);
const segments = (f: PullFile): string[] => f.path.split("/");
const byPath = (a: PullFile, b: PullFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const firstPath = (g: Group): string => g.files[0]!.path;
const nameOf = (prefix: string[]): string => (prefix.length === 0 ? "(root)" : prefix.join("/"));

/** Files of one directory sorted by path, in runs under `max` bytes (a file over it is a run of its own). */
function runs(files: PullFile[], prefix: string[], max: number): Group[] {
  const sorted = [...files].sort(byPath);
  const label = nameOf(prefix);
  if (sum(sorted) <= max) return [{ prefix, label: `${label} (files)`, files: sorted, bytes: sum(sorted) }];
  const chunks: PullFile[][] = [];
  let cur: PullFile[] = [];
  let size = 0;
  for (const f of sorted) {
    if (cur.length > 0 && size + bytesOf(f) > max) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(f);
    size += bytesOf(f);
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.map((c, i) => ({ prefix, label: `${label} (files ${i + 1}/${chunks.length})`, files: c, bytes: sum(c) }));
}

/**
 * Splits `files` (all under `prefix`) into groups no larger than `max`, descending one path segment at a time.
 * Files directly in a directory form their own group; a directory that is only files splits into runs by path.
 */
function split(files: PullFile[], prefix: string[], max: number): Group[] {
  const bytes = sum(files);
  if (bytes <= max) return [{ prefix, label: nameOf(prefix), files: [...files].sort(byPath), bytes }];
  const direct: PullFile[] = [];
  const children = new Map<string, PullFile[]>();
  for (const f of files) {
    const segs = segments(f);
    if (segs.length === prefix.length + 1) direct.push(f);
    else {
      const key = segs[prefix.length]!;
      children.set(key, [...(children.get(key) ?? []), f]);
    }
  }
  const out: Group[] = [];
  for (const key of [...children.keys()].sort()) out.push(...split(children.get(key)!, [...prefix, key], max));
  if (direct.length > 0) out.push(...runs(direct, prefix, max));
  return out;
}

/**
 * Merges sibling groups (the same parent directory) under `min` bytes into `<parent>/(rest)`, packing them in path
 * order so a merged area stays under `max`. A bucket of one stays what it was.
 */
function merge(groups: Group[], min: number, max: number): Group[] {
  const byParent = new Map<string, Group[]>();
  const keep: Group[] = [];
  for (const g of groups) {
    if (g.bytes >= min) {
      keep.push(g);
      continue;
    }
    const parent = g.prefix.slice(0, -1).join("/");
    byParent.set(parent, [...(byParent.get(parent) ?? []), g]);
  }
  for (const [parent, list] of byParent) {
    const sorted = [...list].sort((a, b) => (firstPath(a) < firstPath(b) ? -1 : 1));
    const buckets: Group[][] = [];
    let cur: Group[] = [];
    let size = 0;
    for (const g of sorted) {
      if (cur.length > 0 && size + g.bytes > max) {
        buckets.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(g);
      size += g.bytes;
    }
    if (cur.length > 0) buckets.push(cur);
    for (const b of buckets) {
      if (b.length === 1) {
        keep.push(b[0]!);
        continue;
      }
      const files = b.flatMap((g) => g.files).sort(byPath);
      keep.push({ prefix: parent === "" ? [] : parent.split("/"), label: parent === "" ? "(rest)" : `${parent}/(rest)`, files, bytes: sum(files) });
    }
  }
  return keep;
}

/**
 * The partition (design §6.9):
 * 1. group by first path segment;
 * 2. a group over `areaMaxBytes` splits by its next segment, recursively; a directory of files splits into runs by path;
 * 3. sibling groups under `areaMinBytes` merge into `<parent>/(rest)`;
 * 4. files under `excludeRoots` form the `generated` area, which no agent reads as patches;
 * 5. a test file stays in its directory's group, so a package and its tests are read together.
 * Files without a patch from GitHub are listed in `omitted`. Read areas are numbered `A1`... in path order.
 */
export function partitionAreas(files: readonly PullFile[], limits: Pick<Limits, "areaMaxBytes" | "areaMinBytes">, excludeRoots: readonly string[]): Partition {
  const generated = files.filter((f) => isExcluded(f.path, excludeRoots));
  const rest = files.filter((f) => !isExcluded(f.path, excludeRoots));
  const omitted = rest.filter(patchOmitted).map((f) => f.path).sort();
  const readable = rest.filter((f) => !patchOmitted(f));
  const top = new Map<string, PullFile[]>();
  for (const f of readable) {
    const segs = segments(f);
    const key = segs.length === 1 ? "" : segs[0]!;
    top.set(key, [...(top.get(key) ?? []), f]);
  }
  let groups: Group[] = [];
  for (const key of [...top.keys()].sort()) {
    const list = top.get(key)!;
    // Files with no directory form a group of their own, a run of files like any directory's.
    groups.push(...(key === "" ? runs(list, [], limits.areaMaxBytes) : split(list, [key], limits.areaMaxBytes)));
  }
  groups = merge(groups, limits.areaMinBytes, limits.areaMaxBytes);
  groups.sort((a, b) => (firstPath(a) < firstPath(b) ? -1 : firstPath(a) > firstPath(b) ? 1 : 0));
  const areas: Area[] = groups.map((g, i) => ({ id: `A${i + 1}`, name: g.label, paths: g.files.map((f) => f.path).sort(), bytes: g.bytes, kind: "read" }));
  if (generated.length > 0) areas.push({ id: GENERATED_AREA, name: "generated", paths: generated.map((f) => f.path).sort(), bytes: sum(generated), kind: "generated" });
  return { areas, omitted };
}

/** The files of an area, in the order the snapshot lists them. */
export function areaFiles(area: Pick<Area, "paths">, files: readonly PullFile[]): PullFile[] {
  const paths = new Set(area.paths);
  return files.filter((f) => paths.has(f.path));
}
