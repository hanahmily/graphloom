import { writeScopeAllows } from "@graphloom/sdk";
import { PROTECTED_PATHS } from "./constants.js";

export type Tier = "implementation" | "behaviour" | "product";

export interface Decision {
  point: string;
  tier: Tier;
  options: string[];
  chosen?: string;
  basis: string;
}

export interface RegressionTest {
  /** Go package, such as `./pkg/timestamp`. */
  package: string;
  /** The top-level test function `go test -run` selects; for a Ginkgo suite, the suite's. */
  name: string;
  /** Ginkgo spec text to focus on inside the suite. */
  focus?: string;
  expectedValueSource: string;
}

/** The plan and implementer's result (`decision-record-v1`). */
export interface DecisionRecord {
  status: "ready" | "blocked" | "cannot_reproduce";
  summary: string;
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
}

const strings = { type: "array", items: { type: "string" } };

/** Inline JSON schema passed to the agent harness as `resultSchema`. */
export const DECISION_RECORD_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "blocked", "cannot_reproduce"] },
    summary: { type: "string" },
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
  },
  required: ["status", "summary", "decisions", "openQuestions"],
});

const TEST_NAME = /^Test[A-Za-z0-9_]*$/;
const PACKAGE = /^\.\/[A-Za-z0-9_\-./]*$/;

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
 * point is decided, and the test and caller are named.
 */
export function decisionProblems(record: DecisionRecord): string[] {
  const problems: string[] = [];
  if (record.status !== "ready") problems.push(`the record is ${record.status}, not ready`);
  const test = record.test;
  if (test === undefined) problems.push("no regression test is named");
  else {
    if (!PACKAGE.test(test.package) || test.package.split("/").includes("..")) problems.push(`test package ${JSON.stringify(test.package)} is not a ./relative Go package`);
    if (!TEST_NAME.test(test.name)) problems.push(`test name ${JSON.stringify(test.name)} is not a TestXxx function`);
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
    if (!(PROTECTED_PATHS as readonly string[]).includes(e.path)) problems.push(`scope exception ${JSON.stringify(e.path)} is not one of ${PROTECTED_PATHS.join(", ")}`);
    if (typeof e.reason !== "string" || e.reason.trim() === "") problems.push(`scope exception ${JSON.stringify(e.path)} has no reason`);
  }
  return problems;
}

/** The implementer's write scope: the repository except protected paths the record does not justify. */
export function writeScopeFor(record: DecisionRecord | undefined): string[] {
  const allowed = new Set((record?.scopeExceptions ?? []).filter((e) => typeof e.reason === "string" && e.reason.trim() !== "").map((e) => e.path));
  return [".", ...PROTECTED_PATHS.filter((p) => !allowed.has(p)).map((p) => `!${p}`)];
}

export function outOfScope(paths: string[], record: DecisionRecord | undefined): string[] {
  const scope = writeScopeFor(record);
  return paths.filter((p) => !writeScopeAllows(p, scope));
}
