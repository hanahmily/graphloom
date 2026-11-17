// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Standard and large mode (design §6.9, §7.6). A pull request over one of the profile's `max*` limits is
 * reviewed in large mode instead of refused; only the `hardMax*` caps refuse it. The mode is decided by code.
 */
import type { Limits } from "./profile.js";

export type LimitName = "maxFiles" | "maxPatchBytes" | "maxNewSymbols";

/** Which limit was passed, by how much: the value and the limit. */
export interface ModeReason {
  limit: LimitName;
  value: number;
  max: number;
}

export interface ReviewMode {
  mode: "standard" | "large";
  reasons: ModeReason[];
}

export const STANDARD: ReviewMode = { mode: "standard", reasons: [] };

interface Patched {
  patch: string | null;
}

/** The bytes of the patches, as the limits count them. */
export const patchBytes = (files: readonly Patched[]): number => files.reduce((n, f) => n + Buffer.byteLength(f.patch ?? "", "utf8"), 0);

/** The mode the Report stage runs in: large when the files or the patch bytes are over the profile's limits. */
export function reportMode(files: readonly Patched[], limits: Pick<Limits, "maxFiles" | "maxPatchBytes">): ReviewMode {
  const reasons: ModeReason[] = [];
  if (files.length > limits.maxFiles) reasons.push({ limit: "maxFiles", value: files.length, max: limits.maxFiles });
  const bytes = patchBytes(files);
  if (bytes > limits.maxPatchBytes) reasons.push({ limit: "maxPatchBytes", value: bytes, max: limits.maxPatchBytes });
  return reasons.length > 0 ? { mode: "large", reasons } : STANDARD;
}

/** The mode the Questions and Answers stages run in: the report's, or large when the new symbols are over the limit. */
export function questionsMode(report: ReviewMode, newSymbols: number, limits: Pick<Limits, "maxNewSymbols">): ReviewMode {
  const reasons = [...report.reasons];
  if (newSymbols > limits.maxNewSymbols) reasons.push({ limit: "maxNewSymbols", value: newSymbols, max: limits.maxNewSymbols });
  return reasons.length > 0 ? { mode: "large", reasons } : STANDARD;
}

/** The first hard cap the pull request passes, as the sentence that refuses it, or undefined. */
export function hardCapProblem(files: readonly Patched[], limits: Pick<Limits, "hardMaxFiles" | "hardMaxPatchBytes">): string | undefined {
  if (files.length > limits.hardMaxFiles) return `the pull request changes ${files.length} files, past the profile's limits.hardMaxFiles of ${limits.hardMaxFiles}`;
  const bytes = patchBytes(files);
  if (bytes > limits.hardMaxPatchBytes) return `the pull request's patches are ${bytes} bytes, past the profile's limits.hardMaxPatchBytes of ${limits.hardMaxPatchBytes}`;
  return undefined;
}

/** The reasons as one line: `312 files, over the limit of 150; 1480200 patch bytes, over the limit of 1048576`. */
export function describeReasons(reasons: readonly ModeReason[]): string {
  const names: Record<LimitName, string> = { maxFiles: "files", maxPatchBytes: "patch bytes", maxNewSymbols: "new symbols" };
  return reasons.map((r) => `${r.value} ${names[r.limit]}, over the limit of ${r.max}`).join("; ");
}

export const isLarge = (m: ReviewMode): boolean => m.mode === "large";
