// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { CHANGELOG_PATH, VERSION_PATH } from "./constants.js";

export interface ReviewVerdictPayload {
  verdict: "approved" | "request_changes";
  summary?: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/** Keep a Changelog release heading, with or without its release date. */
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\](?: - \d{4}-\d{2}-\d{2})?$/;

/** VERSION holds one semantic version and a newline, nothing else. */
export const semverFileValidator: Validator = {
  evaluate(input: ValidationInput): ValidationResult {
    const bytes = latestFileBytes(input.evidence, VERSION_PATH);
    if (bytes === undefined) {
      return { status: "inconclusive", reason: `no observation of ${VERSION_PATH}` };
    }
    if (bytes === null) return { status: "failed", reason: `${VERSION_PATH} does not exist` };
    if (!bytes.endsWith("\n") || !SEMVER.test(bytes.slice(0, -1))) {
      return { status: "failed", reason: `${VERSION_PATH} must be MAJOR.MINOR.PATCH and a newline, got ${JSON.stringify(bytes.slice(0, 40))}` };
    }
    return { status: "passed", reason: `${VERSION_PATH} is ${bytes.trim()}` };
  },
};

/** The first release section of CHANGELOG.md names VERSION and lists at least one change. */
export const changelogEntryValidator: Validator = {
  evaluate(input: ValidationInput): ValidationResult {
    const version = latestFileBytes(input.evidence, VERSION_PATH);
    const changelog = latestFileBytes(input.evidence, CHANGELOG_PATH);
    if (version === undefined || changelog === undefined) {
      return { status: "inconclusive", reason: `needs observations of ${VERSION_PATH} and ${CHANGELOG_PATH}` };
    }
    if (version === null || !SEMVER.test(version.trim())) {
      return { status: "failed", reason: `${VERSION_PATH} holds no version to match` };
    }
    if (changelog === null) return { status: "failed", reason: `${CHANGELOG_PATH} does not exist` };
    const section = firstReleaseSection(changelog);
    if (section === undefined) {
      return { status: "failed", reason: `${CHANGELOG_PATH} has no release section below [Unreleased]` };
    }
    const heading = RELEASE_HEADING.exec(section.heading);
    if (!heading) {
      return { status: "failed", reason: `first release heading ${JSON.stringify(section.heading)} is not "## [X.Y.Z]" with an optional " - YYYY-MM-DD"` };
    }
    if (heading[1] !== version.trim()) {
      return { status: "failed", reason: `first release section is ${heading[1]}, but ${VERSION_PATH} is ${version.trim()}` };
    }
    if (!section.body.some((line) => /^- \S/.test(line))) {
      return { status: "failed", reason: `the ${heading[1]} section lists no "- " change` };
    }
    return { status: "passed", reason: `${CHANGELOG_PATH} opens with a ${heading[1]} entry` };
  },
};

/** The release changed VERSION and CHANGELOG.md and nothing else. */
export const releaseScopeValidator: Validator = {
  evaluate(input: ValidationInput): ValidationResult {
    const changed = latestChangedPaths(input.evidence);
    if (changed === undefined) return { status: "inconclusive", reason: "no workspace change manifest" };
    const missing = [VERSION_PATH, CHANGELOG_PATH].filter((p) => !changed.includes(p));
    const extra = changed.filter((p) => p !== VERSION_PATH && p !== CHANGELOG_PATH);
    if (extra.length > 0) return { status: "failed", reason: `unrelated paths changed: ${extra.join(", ")}` };
    if (missing.length > 0) return { status: "failed", reason: `not changed: ${missing.join(", ")}` };
    return { status: "passed", reason: `only ${VERSION_PATH} and ${CHANGELOG_PATH} changed` };
  },
};

/** The independent reviewer's verdict; the writers' own reports never count. */
export const independentReviewValidator: Validator = {
  evaluate(input: ValidationInput): ValidationResult {
    const review = latestReview(input.evidence);
    if (review === undefined) return { status: "inconclusive", reason: "no well-formed review verdict" };
    if (review.verdict === "approved") return { status: "passed", reason: review.summary ?? "reviewer approved" };
    return { status: "failed", reason: review.summary ?? "reviewer requested changes" };
  },
};

export function validatorById(id: string): Validator | undefined {
  switch (id) {
    case "semver-file":
      return semverFileValidator;
    case "changelog-entry":
      return changelogEntryValidator;
    case "release-scope":
      return releaseScopeValidator;
    case "independent-reviewer":
      return independentReviewValidator;
    default:
      return undefined;
  }
}

/** Newest observed bytes of `path`: null when it was observed missing, undefined when never observed. */
export function latestFileBytes(evidence: EvidenceRecord[], path: string): string | null | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    const payload = e.payload as { path?: unknown; bytes?: unknown } | undefined;
    if (e.kind !== "file" || payload?.path !== path) continue;
    if (e.fingerprint === "missing") return null;
    return typeof payload.bytes === "string" ? payload.bytes : undefined;
  }
  return undefined;
}

export function latestChangedPaths(evidence: EvidenceRecord[]): string[] | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    if (e.kind !== "workspace") continue;
    const paths = (e.payload as { changedPaths?: unknown } | undefined)?.changedPaths;
    return Array.isArray(paths) && paths.every((p) => typeof p === "string") ? paths : undefined;
  }
  return undefined;
}

export function latestReview(evidence: EvidenceRecord[]): ReviewVerdictPayload | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    if (e.kind !== "review") continue;
    const payload = e.payload as { verdict?: unknown; summary?: unknown } | undefined;
    if (payload?.verdict !== "approved" && payload?.verdict !== "request_changes") return undefined;
    if (payload.summary !== undefined && typeof payload.summary !== "string") return undefined;
    return { verdict: payload.verdict, ...(payload.summary !== undefined ? { summary: payload.summary } : {}) };
  }
  return undefined;
}

function firstReleaseSection(changelog: string): { heading: string; body: string[] } | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.startsWith("## ") && !/^## \[?Unreleased\]?/i.test(line));
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return { heading: lines[start]!.trimEnd(), body: lines.slice(start + 1, end < 0 ? undefined : end) };
}
