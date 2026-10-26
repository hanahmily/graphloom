// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { writeScopeAllows } from "@graphloom/sdk";
import { enforcedProtectedPaths, isTestPath, regeneratedExceptions, type Profile } from "./profile.js";

export type Tier = "implementation" | "behaviour" | "product";

export interface Decision {
  point: string;
  tier: Tier;
  options: string[];
  chosen?: string;
  basis: string;
}

export interface RegressionTest {
  /** Where the test lives, as the profile's runner reads it: a Go package (`./pkg/timestamp`) or a test file. */
  package: string;
  /** The test the runner selects: a Go TestXxx function, or a vitest test's full name. */
  name: string;
  /** Ginkgo spec text to focus on inside the suite (go-test runner only). */
  focus?: string;
  expectedValueSource: string;
}

/** The plan and implementer's result (`decision-record-v2`). */
export interface DecisionRecord {
  status: "ready" | "blocked" | "cannot_reproduce";
  /** This round's report to the graph: the root cause and fix when planning, what the pass did when implementing. Never delivered. */
  summary: string;
  /**
   * The change as a whole against the base, written for a reviewer and kept
   * current every round. It is what the commit message and the pull request's
   * summary say. Absent in v1 records, which delivery reads around.
   */
  change?: string;
  title?: string;
  test?: RegressionTest;
  productionCaller?: string;
  decisions: Decision[];
  openQuestions: string[];
  followUps?: string[];
  scopeExceptions?: Array<{ path: string; reason: string }>;
  needsE2E?: boolean;
  draftComment?: string;
  /**
   * A unified diff (as `git diff` produces) undoing just this round's
   * behavioral change in the production code, supplied only when RED's
   * plain base-commit checkout could not even build the named test alone
   * (it depends on something this round's change added). Must not touch the
   * test file itself.
   */
  revertPatch?: string;
  /** What the implementer ran itself before returning ready, as "command: result" lines; the graph does not trust it. */
  selfChecks?: string[];
  /**
   * The planner's list of what the issue asks for: one item per acceptance
   * criterion checkbox and per oracle line (a planner may group lines one
   * change covers together). Absent in records from before issue-fix 0.10.0,
   * which get no coverage check.
   */
  acceptance?: AcceptanceItem[];
  /** The implementer's map from each acceptance item to the code and tests that satisfy it. */
  coverage?: CoverageEntry[];
}

export interface AcceptanceItem {
  id: string;
  text: string;
}

/** A test that covers an item: the test file, and the test's own title as written in that file (an `it("...")` string, a Go `TestXxx` name). */
export interface CoveredTest {
  file: string;
  name: string;
}

export interface CoverageEntry {
  id: string;
  /** The production files that implement the item, relative to the repository root. */
  files: string[];
  tests: CoveredTest[];
}

const strings = { type: "array", items: { type: "string" } };

/** Inline JSON schema passed to the agent harness as `resultSchema`. */
export const DECISION_RECORD_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "blocked", "cannot_reproduce"] },
    summary: { type: "string" },
    change: { type: "string" },
    title: { type: "string" },
    test: {
      type: "object",
      properties: {
        package: { type: "string" },
        name: { type: "string" },
        focus: { type: "string" },
        expectedValueSource: { type: "string" },
      },
      required: ["package", "name", "expectedValueSource"],
    },
    productionCaller: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          point: { type: "string" },
          tier: { type: "string", enum: ["implementation", "behaviour", "product"] },
          options: strings,
          chosen: { type: "string" },
          basis: { type: "string" },
        },
        required: ["point", "tier", "options", "basis"],
      },
    },
    openQuestions: strings,
    followUps: strings,
    scopeExceptions: {
      type: "array",
      items: { type: "object", properties: { path: { type: "string" }, reason: { type: "string" } }, required: ["path", "reason"] },
    },
    needsE2E: { type: "boolean" },
    draftComment: { type: "string" },
    revertPatch: { type: "string" },
    selfChecks: strings,
    acceptance: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"] },
    },
    coverage: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          files: strings,
          tests: { type: "array", items: { type: "object", properties: { file: { type: "string" }, name: { type: "string" } }, required: ["file", "name"] } },
        },
        required: ["id", "files", "tests"],
      },
    },
  },
  required: ["status", "summary", "change", "decisions", "openQuestions"],
});

/** The record, or why the value is not one. */
export function parseDecisionRecord(value: unknown): { record: DecisionRecord } | { problem: string } {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return { problem: "the result is not JSON" };
    }
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return { problem: "the result is not an object" };
  const o = v as Record<string, unknown>;
  if (o.status !== "ready" && o.status !== "blocked" && o.status !== "cannot_reproduce") return { problem: "status must be ready, blocked or cannot_reproduce" };
  if (typeof o.summary !== "string") return { problem: "summary is missing" };
  if (!Array.isArray(o.decisions)) return { problem: "decisions must be a list" };
  if (!Array.isArray(o.openQuestions) || !o.openQuestions.every((q) => typeof q === "string")) return { problem: "openQuestions must be a list of strings" };
  return { record: o as unknown as DecisionRecord };
}

/**
 * What keeps a ready record from satisfying `decisions-recorded`: every unclear
 * point has a tier and a basis, behaviour points take an option, no product
 * point is decided, and the test (as the profile's runner can run it) and the
 * caller are named.
 */
export function decisionProblems(record: DecisionRecord, profile: Profile): string[] {
  const problems: string[] = [];
  if (record.status !== "ready") problems.push(`the record is ${record.status}, not ready`);
  const test = record.test;
  if (test === undefined) problems.push("no regression test is named");
  else {
    problems.push(...profile.runner.testProblems(test, (p) => isTestPath(profile, p)));
    if (typeof test.expectedValueSource !== "string" || test.expectedValueSource.trim() === "") problems.push("the test's expected value has no source");
  }
  if (typeof record.productionCaller !== "string" || record.productionCaller.trim() === "") problems.push("no production caller is named");
  if (record.revertPatch !== undefined && (typeof record.revertPatch !== "string" || record.revertPatch.trim() === "")) {
    problems.push("revertPatch, when given, must be a non-empty unified diff");
  }
  record.decisions.forEach((d, i) => {
    const label = `decision ${i + 1}${typeof d?.point === "string" ? ` (${d.point})` : ""}`;
    if (d === null || typeof d !== "object") {
      problems.push(`${label} is not an object`);
      return;
    }
    if (d.tier !== "implementation" && d.tier !== "behaviour" && d.tier !== "product") problems.push(`${label} has no tier`);
    if (typeof d.basis !== "string" || d.basis.trim() === "") problems.push(`${label} has no basis`);
    const chosen = typeof d.chosen === "string" && d.chosen.trim() !== "";
    if (d.tier === "product" && chosen) problems.push(`${label} is a product decision, which an agent must not make`);
    if (d.tier === "behaviour" && !chosen) problems.push(`${label} is a behaviour point without a chosen option`);
  });
  for (const e of record.scopeExceptions ?? []) {
    if (!profile.protectedPaths.includes(e.path)) {
      problems.push(
        profile.protectedPaths.length > 0
          ? `scope exception ${JSON.stringify(e.path)} is not one of ${profile.protectedPaths.join(", ")}`
          : `scope exception ${JSON.stringify(e.path)} names no protected path; this repository protects none`,
      );
    }
    if (typeof e.reason !== "string" || e.reason.trim() === "") problems.push(`scope exception ${JSON.stringify(e.path)} has no reason`);
  }
  return problems;
}

/** The implementer's write scope: the repository except protected paths the record does not justify. */
export function writeScopeFor(record: DecisionRecord | undefined, profile: Profile): string[] {
  const allowed = new Set((record?.scopeExceptions ?? []).filter((e) => typeof e.reason === "string" && e.reason.trim() !== "").map((e) => e.path));
  return [".", ...enforcedProtectedPaths(profile).filter((p) => !allowed.has(p)).map((p) => `!${p}`), ...regeneratedExceptions(profile)];
}

export function outOfScope(paths: string[], record: DecisionRecord | undefined, profile: Profile): string[] {
  const scope = writeScopeFor(record, profile);
  return paths.filter((p) => !writeScopeAllows(p, scope));
}
