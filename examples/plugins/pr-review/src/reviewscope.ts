// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the Review stage reviews and where its reviewers start (design §8.1): the files in scope, and the fact that every
 * reviewer starts a fresh session seeded with review.md only (no human talks to the answerer in this graph, so no
 * conversation reaches a reviewer). All of it is recorded once, in the `review-scope` record, so a stop and a resume keep it.
 */
import { createHash } from "node:crypto";
import type { Area, Partition } from "./areas.js";
import type { Bullet } from "./briefing.js";
import { isObject } from "./evidence.js";
import type { ReviewMode } from "./mode.js";
import type { PullFile } from "./snapshot.js";

export const SCOPE_SCHEMA = "pr-review-scope-v1";
export const SCOPE_RECORD_ID = "review-scope";
/** How every reviewer starts (design §8.1): a fresh session seeded with review.md only; nothing of a conversation reaches it. */
export const FRESH_START_REASON = "every reviewer starts a fresh session seeded with review.md only";

// ---- the files in scope ----

export interface ScopeAreas {
  id: string;
  name: string;
  files: number;
}

export interface ScopeChoice {
  mode: "standard" | "large";
  /** How the scope was decided: the whole pull request, the areas the briefing cites, or (when it cites none) every readable area. */
  source: "whole" | "default" | "all-areas";
  areas: ScopeAreas[];
  /** Repository-relative paths, in the snapshot's order. */
  files: string[];
}

/**
 * The files the reviewers review (design §8.1). A standard pull request is reviewed whole. In large mode the reviewers review
 * the files of the areas the briefing's "What you need to check" entries for risks, behavior and compatibility cite (their
 * cites name files, and each file is in one area). A briefing that cites no area leaves nothing to narrow the scope by, so every readable area is reviewed (the generated
 * files never are); the scope's source says so.
 */
export function chooseScope(i: { mode: ReviewMode; files: readonly PullFile[]; partition?: Partition | undefined; check: Record<"risks" | "behavior" | "compatibility", readonly Bullet[]> }): ScopeChoice {
  if (i.mode.mode !== "large" || i.partition === undefined) return { mode: "standard", source: "whole", areas: [], files: i.files.map((f) => f.path) };
  const readable = i.partition.areas.filter((a): a is Area => a.kind === "read");
  const cited = new Set([...i.check.risks, ...i.check.behavior, ...i.check.compatibility].flatMap((b) => b.cites.map((c) => c.path)));
  const named = readable.filter((a) => a.paths.some((p) => cited.has(p)));
  const picked = named.length > 0 ? named : readable;
  const paths = new Set(picked.flatMap((a) => a.paths));
  return { mode: "large", source: named.length > 0 ? "default" : "all-areas", areas: picked.map((a) => ({ id: a.id, name: a.name, files: a.paths.length })), files: i.files.map((f) => f.path).filter((p) => paths.has(p)) };
}

// ---- the scope record ----

/** What the Review stage's first command records: the scope and how the reviewers start, which a stop and a resume keep. */
export interface ScopeRecord {
  schema: typeof SCOPE_SCHEMA;
  mode: "standard" | "large";
  source: ScopeChoice["source"];
  areas: ScopeAreas[];
  files: string[];
  context: { kind: "seeded"; reason: string };
  /** The harness each aspect's reviewer and verifier run on. */
  harnesses: Record<string, { reviewer: string; verifier: string }>;
}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const scopeRecordJson = (r: ScopeRecord): string => JSON.stringify(r);

export function parseScopeRecord(json: string): ScopeRecord | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObject(v) || v.schema !== SCOPE_SCHEMA || !Array.isArray(v.files) || !Array.isArray(v.areas) || !isObject(v.context) || !isObject(v.harnesses)) return undefined;
    return v as unknown as ScopeRecord;
  } catch {
    return undefined;
  }
}
