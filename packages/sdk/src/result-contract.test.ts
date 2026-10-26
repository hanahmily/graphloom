// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { checkContract, checkReferences } from "./result-contract.js";

const schema = { type: "object", properties: { finding: { type: "string" } }, required: ["finding"] };

describe("checkContract", () => {
  it("is valid when the value satisfies the schema and no references are declared", () => {
    expect(checkContract({ finding: "P1" }, { schema })).toEqual({ status: "valid", problems: [], value: { finding: "P1" } });
  });

  it("is invalid when the value fails the schema, before any reference check runs", () => {
    const result = checkContract({}, { schema, references: ["finding"] }, { finding: { ids: ["P1"] } });
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toContain("required");
  });

  it("is invalid when a reference value is outside the known set", () => {
    const result = checkContract({ finding: "made up" }, { schema, references: ["finding"] }, { finding: { ids: ["", "P1"] } });
    expect(result.status).toBe("invalid");
    expect(result.problems[0]).toContain("made up");
  });

  it("is repaired when a reference value matches a shown description", () => {
    const known = { finding: { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } };
    const result = checkContract({ finding: "metric counts running actions" }, { schema, references: ["finding"] }, known);
    expect(result).toMatchObject({ status: "repaired", problems: [], value: { finding: "P1" } });
    expect(result.repairs?.[0]).toContain("P1");
  });

  it("is valid without checking references when no known id sets are supplied", () => {
    const result = checkContract({ finding: "anything" }, { schema, references: ["finding"] });
    expect(result.status).toBe("valid");
  });
});

describe("checkReferences", () => {
  // Regression: an array-wrapped path (the former banyandb-fix graph's "findings[].finding",
  // "prior[].finding") checked head.array against the path's own PARENT
  // object before ever navigating to the array it actually names, so
  // Array.isArray(node) was always false and every array-wrapped path was
  // silently skipped — neither flagged as a problem nor ever repaired.
  const known = { "findings[].finding": { ids: ["", "P1"], descriptions: { P1: "metric counts running actions" } } };

  it("reconciles a reference inside an array element that matches a shown description", () => {
    const value = { findings: [{ finding: "metric counts running actions" }] };
    const result = checkReferences(value, ["findings[].finding"], known);
    expect(result).toEqual({
      problems: [],
      repairs: [expect.stringContaining("P1")],
      value: { findings: [{ finding: "P1" }] },
    });
  });

  it("reports a problem for an array element's unreconcilable reference", () => {
    const value = { findings: [{ finding: "made up" }] };
    const result = checkReferences(value, ["findings[].finding"], known);
    expect(result.problems[0]).toContain("made up");
    expect(result.repairs).toEqual([]);
  });

  it("checks every array element independently", () => {
    const value = { findings: [{ finding: "P1" }, { finding: "metric counts running actions" }, { finding: "nope" }] };
    const result = checkReferences(value, ["findings[].finding"], known);
    expect(result.problems).toHaveLength(1);
    expect(result.repairs).toHaveLength(1);
    expect(result.value).toEqual({ findings: [{ finding: "P1" }, { finding: "P1" }, { finding: "nope" }] });
  });

  it("is a no-op when the array is empty", () => {
    const result = checkReferences({ findings: [] }, ["findings[].finding"], known);
    expect(result).toEqual({ problems: [], repairs: [], value: { findings: [] } });
  });
});
