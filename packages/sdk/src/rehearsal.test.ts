// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { assignmentNamesField, checkAssignmentFidelity, continueRehearsalScenario, matchRehearsalAnswer, mutateAdversarially, synthesizeFromSchema, type RehearsalScenario } from "./rehearsal.js";
import { assertGraphRehearsal } from "./validate.js";

describe("synthesizeFromSchema", () => {
  it("builds the smallest object satisfying required properties, enums, and nested arrays/objects", () => {
    const schema = {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approved", "request_changes"] },
        summary: { type: "string" },
        findings: {
          type: "array",
          items: { type: "object", properties: { detail: { type: "string" } }, required: ["detail"] },
        },
        unrequired: { type: "string" },
      },
      required: ["verdict", "summary", "findings"],
    };
    expect(synthesizeFromSchema(schema)).toEqual({
      verdict: "approved",
      summary: "summary",
      findings: [],
    });
  });

  it("falls back to the property name for an unschematized leaf", () => {
    expect(synthesizeFromSchema({ type: "object", properties: { finding: {} }, required: ["finding"] })).toEqual({
      finding: "finding",
    });
  });

  it("synthesizes primitives directly", () => {
    expect(synthesizeFromSchema({ type: "integer" })).toBe(0);
    expect(synthesizeFromSchema({ type: "boolean" })).toBe(false);
    expect(synthesizeFromSchema({ type: "null" })).toBe(null);
  });
});

describe("assignmentNamesField", () => {
  it("matches a whole word, case-insensitively", () => {
    expect(assignmentNamesField("Return verdict and Summary of the change.", "summary")).toBe(true);
    expect(assignmentNamesField("Return a verdict.", "summary")).toBe(false);
  });

  it("does not match a substring inside a longer word", () => {
    expect(assignmentNamesField("Please provide a summarized overview.", "summary")).toBe(false);
  });

  it("escapes regex-special characters in the field name", () => {
    expect(assignmentNamesField("Name it a.b in the result.", "a.b")).toBe(true);
    expect(assignmentNamesField("Name it aXb in the result.", "a.b")).toBe(false);
  });
});

describe("checkAssignmentFidelity", () => {
  it("returns no problems when every field is named", () => {
    const assignment = "Return verdict and summary.";
    expect(checkAssignmentFidelity(assignment, { verdict: "approved", summary: "ok" })).toEqual([]);
  });

  it("names the field the assignment never asked for", () => {
    const assignment = "Return a verdict.";
    expect(checkAssignmentFidelity(assignment, { verdict: "approved", summary: "ok" })).toEqual(["summary"]);
  });

  it("excuses a field declared harnessSupplied", () => {
    const assignment = "Return a verdict.";
    expect(checkAssignmentFidelity(assignment, { verdict: "approved", summary: "ok" }, ["summary"])).toEqual([]);
  });

  it("is a no-op for a non-object output", () => {
    expect(checkAssignmentFidelity("anything", "a string result")).toEqual([]);
    expect(checkAssignmentFidelity("anything", undefined)).toEqual([]);
  });
});

describe("mutateAdversarially (§4.4)", () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" }, summary: { type: "string" } },
    required: ["verdict", "summary"],
  };

  it("drops the first required property when there is nothing else to corrupt", () => {
    const result = mutateAdversarially({ output: { verdict: "approved", summary: "ok" } }, { schema });
    expect(result).toEqual({ mutation: "dropped-property", reply: { output: { summary: "ok" } } });
  });

  it("appends an effect outside the job's write scope when the reply has any effect at all, ahead of every other strategy", () => {
    const result = mutateAdversarially(
      { output: { verdict: "approved", summary: "ok" }, effects: [{ path: "NOTES.md", bytes: "noted\n" }] },
      { schema },
    );
    expect(result?.mutation).toBe("scope-violation");
    expect(result?.reply.effects).toEqual([
      { path: "NOTES.md", bytes: "noted\n" },
      { path: ".graphloom-adversarial-stray-write", bytes: "adversarial: write outside scope\n" },
    ]);
  });

  it("replaces a reference leaf with its own shown description when the contract declares references", () => {
    const contract = {
      schema: { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] },
      references: ["findings[].finding"],
      knownReferences: { "findings[].finding": { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } },
    };
    const result = mutateAdversarially({ output: { findings: [{ finding: "P1" }] } }, contract);
    expect(result).toEqual({
      mutation: "reference-description",
      reply: { output: { findings: [{ finding: "metric counts running actions" }] } },
    });
  });

  it("falls back to dropping a required property when the reference array is empty", () => {
    const contract = {
      schema,
      references: ["findings[].finding"],
      knownReferences: { "findings[].finding": { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } },
    };
    const result = mutateAdversarially({ output: { verdict: "approved", summary: "ok", findings: [] } }, contract);
    expect(result?.mutation).toBe("dropped-property");
  });

  it("returns undefined when the reply has nothing to corrupt", () => {
    expect(mutateAdversarially({ fail: { kind: "no-result" } }, { schema })).toBeUndefined();
    expect(mutateAdversarially({ output: { verdict: "approved", summary: "ok" } }, { schema: { type: "object" } })).toBeUndefined();
  });
});

describe("a scenario's expect.path (docs/design-graph-topology.md §9)", () => {
  const rehearsal = (path: unknown) => ({ scenarios: { happy: { results: {}, expect: { status: "succeeded", path } } } });

  it("is accepted as a list of node ids, and refused as anything else", () => {
    expect(assertGraphRehearsal(rehearsal(["fix", "review"])).scenarios.happy?.expect.path).toEqual(["fix", "review"]);
    expect(() => assertGraphRehearsal(rehearsal("fix"))).toThrow(/path/);
    expect(() => assertGraphRehearsal(rehearsal(["fix", 3]))).toThrow(/expect\.path must list node ids/);
  });
});

describe("a scenario's operator answers (§4.4)", () => {
  const back = { action: { type: "return" as const, return: { summary: "back" } }, reason: "return" };
  const enter = { action: { type: "enter" as const, enter: { stageId: "arbitrate", reason: "rule" } }, reason: "enter" };
  const leave = (to: string) => ({ action: { type: "reenter" as const, reenter: { stageId: to, reason: `leave to ${to}` } }, reason: `leave to ${to}` });
  const scenario: RehearsalScenario = {
    results: { work: [{ output: "a" }, { output: "b" }], review: [{ output: "r" }] },
    supervisor: [enter, back],
    expect: { status: "stopped" },
    answers: [
      { approval: "ruling", decision: "approve", inputs: { ruling: "review-stands" }, supervisor: [leave("fix"), back], results: { work: [{ output: "fixed" }] }, expect: { status: "succeeded", path: ["fix", "review"] } },
      { approval: "ruling", decision: "approve", inputs: { ruling: "implementation-stands" }, supervisor: [leave("review"), back], expect: { status: "succeeded" } },
      { approval: "ruling", decision: "decline", supervisor: [leave("review"), back], expect: { status: "succeeded" } },
    ],
  };

  it("matches the first answer whose approval, decision and named inputs agree", () => {
    expect(matchRehearsalAnswer(scenario, { approvalId: "ruling", decision: "approve", inputs: { finding: "F1", ruling: "review-stands" } })).toBe(scenario.answers![0]);
    expect(matchRehearsalAnswer(scenario, { approvalId: "ruling", decision: "approve", inputs: { ruling: "implementation-stands" } })).toBe(scenario.answers![1]);
    expect(matchRehearsalAnswer(scenario, { approvalId: "ruling", decision: "decline" })).toBe(scenario.answers![2]);
    expect(matchRehearsalAnswer(scenario, { approvalId: "ruling", decision: "approve", inputs: { ruling: "neither" } })).toBeUndefined();
    expect(matchRehearsalAnswer(scenario, { approvalId: "other", decision: "decline" })).toBeUndefined();
  });

  it("continues with the consumed decisions, then the answer's, its replies and its expectation", () => {
    const continued = continueRehearsalScenario(scenario, scenario.answers![0]!, 2);
    expect(continued.supervisor).toEqual([enter, back, leave("fix"), back]);
    expect(continued.results).toEqual({ work: [{ output: "fixed" }], review: [{ output: "r" }] });
    expect(continued.expect).toEqual({ status: "succeeded", path: ["fix", "review"] });
    // Answers stay: a run the answer stopped again can be answered again.
    expect(continued.answers).toBe(scenario.answers);
  });

  it("is validated on the wire like the scenario's own data", () => {
    expect(assertGraphRehearsal({ scenarios: { operator: scenario } }).scenarios.operator?.answers).toHaveLength(3);
    const bad = (answer: object) => ({ scenarios: { operator: { ...scenario, answers: [answer] } } });
    expect(() => assertGraphRehearsal(bad({ approval: "ruling", decision: "maybe", expect: { status: "succeeded" } }))).toThrow(/decision must be approve or decline/);
    expect(() => assertGraphRehearsal(bad({ approval: "ruling", decision: "approve", inputs: { ruling: 3 }, expect: { status: "succeeded" } }))).toThrow(/inputs must map/);
    expect(() => assertGraphRehearsal(bad({ approval: "ruling", decision: "approve" }))).toThrow(/expect/);
  });
});
