// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ExecutorPin } from "@graphloom/sdk";
import { GET_PULL, LIST_CHECK_RUNS, LIST_PULL_COMMITS, LIST_PULL_FILES, LIST_PULL_REVIEWS, LIST_PULL_REVIEW_COMMENTS, LIST_REVIEW_THREADS } from "./constants.js";
import { isObject, producer } from "./evidence.js";
import { parsePatch, type ParsedPatch } from "./patch.js";
import type { Limits } from "./profile.js";
import type { PullRequest } from "./request.js";

export interface PullFile {
  path: string;
  status: string | null;
  previousPath: string | null;
  additions: number;
  deletions: number;
  patch: string | null;
  patchOmitted: boolean;
  parsed: ParsedPatch;
}

export interface PullMeta {
  number: number;
  title: string;
  state: string;
  url: string;
  body: string;
  author: string | null;
  labels: string[];
  draft: boolean;
  merged: boolean;
  head: { ref: string | null; sha: string | null };
  base: { ref: string | null; sha: string | null };
}

export interface PullCommit {
  sha: string;
  message: string;
}

export interface Snapshot {
  pull: PullMeta;
  files: PullFile[];
  commits: PullCommit[];
  reviews: unknown[];
  reviewComments: unknown[];
  threads: unknown[];
  checks: Array<{ name: string; status: string | null; conclusion: string | null }>;
  /** Every evidence record the snapshot rests on. */
  refs: string[];
}

/** One paginated read being assembled from the evidence. */
export interface ReadSpec {
  key: "pull" | "files" | "commits" | "reviews" | "reviewComments" | "threads" | "checks";
  pin: ExecutorPin;
  label: string;
  paged: boolean;
}

/**
 * The pull request's metadata is read last. Every list is read at some moment, and the head the metadata then
 * shows must still be the requested one: a push in between would otherwise leave lists of a newer head
 * beside metadata of the old one, and the report would mix revisions.
 */
export const READS: readonly ReadSpec[] = [
  { key: "files", pin: LIST_PULL_FILES, label: "changed files", paged: true },
  { key: "commits", pin: LIST_PULL_COMMITS, label: "commits", paged: true },
  { key: "reviews", pin: LIST_PULL_REVIEWS, label: "reviews", paged: true },
  { key: "reviewComments", pin: LIST_PULL_REVIEW_COMMENTS, label: "review comments", paged: true },
  { key: "threads", pin: LIST_REVIEW_THREADS, label: "review threads", paged: true },
  { key: "checks", pin: LIST_CHECK_RUNS, label: "check runs of the head", paged: true },
  { key: "pull", pin: GET_PULL, label: "pull request metadata", paged: false },
];

export interface ReadResult {
  items: unknown[];
  item?: Record<string, unknown>;
  complete: boolean;
  nextCursor: string | null;
  refs: string[];
}

/**
 * What the evidence holds for one read: a paged list is the chain of results
 * since the latest one that started from the first page, in order; `complete`
 * is the last link's own claim.
 */
export function readResult(evidence: readonly EvidenceRecord[], spec: ReadSpec): ReadResult | undefined {
  let chain: ReadResult | undefined;
  for (const record of evidence) {
    if (producer(record)?.executorId !== spec.pin.id) continue;
    const github = isObject(record.payload) ? record.payload.github : undefined;
    if (!isObject(github)) continue;
    if (!spec.paged) {
      const item = isObject(github.item) ? github.item : undefined;
      if (item !== undefined) chain = { items: [], item, complete: true, nextCursor: null, refs: [record.ref] };
      continue;
    }
    if (!Array.isArray(github.items)) continue;
    const page = isObject(github.page) ? github.page : {};
    const starts = page.startCursor === undefined || page.startCursor === "1" || page.startCursor === "start";
    const items = github.items as unknown[];
    const link = { complete: page.complete === true, nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null };
    chain = starts || chain === undefined ? { items: [...items], ...link, refs: [record.ref] } : { items: [...chain.items, ...items], ...link, refs: [...chain.refs, record.ref] };
  }
  return chain;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function pullFile(raw: unknown): PullFile | undefined {
  if (!isObject(raw) || typeof raw.path !== "string") return undefined;
  const patch = str(raw.patch);
  return {
    path: raw.path,
    status: str(raw.status),
    previousPath: str(raw.previousPath),
    additions: typeof raw.additions === "number" ? raw.additions : 0,
    deletions: typeof raw.deletions === "number" ? raw.deletions : 0,
    patch,
    patchOmitted: raw.patchOmitted === true,
    parsed: parsePatch(patch),
  };
}

export type SnapshotState =
  | { state: "reading"; next: ReadSpec; cursor?: string; why: string }
  | { state: "ready"; snapshot: Snapshot }
  | { state: "incompatible"; problem: string; refs: string[] };

/**
 * The PR snapshot the evidence holds: the next read it still needs, or the
 * whole snapshot, or why this pull request cannot be reported (head moved,
 * past a profile limit, touches `.graphloom/`).
 */
export function snapshotState(evidence: readonly EvidenceRecord[], pr: PullRequest, limits: Limits): SnapshotState {
  const results = new Map<string, ReadResult>();
  for (const spec of READS) {
    const r = readResult(evidence, spec);
    if (r === undefined) return { state: "reading", next: spec, why: `read the ${spec.label} of ${pr.owner}/${pr.repo}#${pr.number}` };
    if (!r.complete) {
      if (r.nextCursor === null) return { state: "incompatible", problem: `the ${spec.label} could not be read whole: the list stopped without a next page`, refs: r.refs };
      return { state: "reading", next: spec, cursor: r.nextCursor, why: `read the next page of the ${spec.label}` };
    }
    results.set(spec.key, r);
  }
  const refs = [...results.values()].flatMap((r) => r.refs);
  const item = results.get("pull")!.item!;
  const head = isObject(item.head) ? item.head : {};
  const base = isObject(item.base) ? item.base : {};
  const pull: PullMeta = {
    number: typeof item.number === "number" ? item.number : pr.number,
    title: str(item.title) ?? "",
    state: str(item.state) ?? "",
    url: str(item.url) ?? "",
    body: str(item.body) ?? "",
    author: str(item.author),
    labels: Array.isArray(item.labels) ? item.labels.filter((l): l is string => typeof l === "string") : [],
    draft: item.draft === true,
    merged: item.merged === true,
    head: { ref: str(head.ref), sha: str(head.sha) },
    base: { ref: str(base.ref), sha: str(base.sha) },
  };
  if (pull.head.sha !== pr.head) {
    return { state: "incompatible", problem: `the pull request's head is ${pull.head.sha ?? "unknown"}, not the requested ${pr.head}: it moved after the task was prepared; prepare it again`, refs };
  }
  const files = results.get("files")!.items.map(pullFile).filter((f): f is PullFile => f !== undefined);
  if (files.length > limits.maxFiles) {
    return { state: "incompatible", problem: `the pull request changes ${files.length} files, past the profile's limits.maxFiles of ${limits.maxFiles}`, refs };
  }
  const bytes = files.reduce((n, f) => n + Buffer.byteLength(f.patch ?? "", "utf8"), 0);
  if (bytes > limits.maxPatchBytes) {
    return { state: "incompatible", problem: `the pull request's patches are ${bytes} bytes, past the profile's limits.maxPatchBytes of ${limits.maxPatchBytes}`, refs };
  }
  const graphloom = files.find((f) => f.path.startsWith(".graphloom/") || f.path === ".graphloom" || f.previousPath?.startsWith(".graphloom/") === true);
  if (graphloom !== undefined) {
    return { state: "incompatible", problem: `the pull request touches ${graphloom.path}: .graphloom/ holds this graph's own files and a pull request may not change it`, refs };
  }
  return {
    state: "ready",
    snapshot: {
      pull,
      files,
      commits: results.get("commits")!.items.flatMap((c) => (isObject(c) && typeof c.sha === "string" ? [{ sha: c.sha, message: str(c.message) ?? "" }] : [])),
      reviews: results.get("reviews")!.items,
      reviewComments: results.get("reviewComments")!.items,
      threads: results.get("threads")!.items,
      checks: results.get("checks")!.items.flatMap((c) => (isObject(c) && typeof c.name === "string" ? [{ name: c.name, status: str(c.status), conclusion: str(c.conclusion) }] : [])),
      refs,
    },
  };
}

/** The job input for a read, bounded and as complete as one call can make it. */
export function readInput(spec: ReadSpec, pr: PullRequest, cursor?: string): Record<string, unknown> {
  const base = { owner: pr.owner, repo: pr.repo };
  if (spec.key === "pull") return { ...base, number: pr.number };
  if (spec.key === "checks") return { ...base, sha: pr.head, perPage: 100, maxPages: 10, ...(cursor !== undefined ? { cursor } : {}) };
  return { ...base, number: pr.number, perPage: 100, maxPages: 10, ...(cursor !== undefined ? { cursor } : {}) };
}

/** A file's names: a rename counts under both. */
export function fileNames(f: PullFile): string[] {
  return f.previousPath !== null && f.previousPath !== f.path ? [f.path, f.previousPath] : [f.path];
}

export const isDeleted = (f: PullFile): boolean => f.status === "removed";
