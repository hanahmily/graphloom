// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { approvalFlags, inputFlags } from "../src/approval-flags.js";

const flags = (...args: string[]) => approvalFlags(args, "tester");

describe("resume --approve / --decline with --input", () => {
  it("reads one --input <name>=<value> for each value, splitting at the first =", () => {
    expect(inputFlags(["--input", "areas=A3,A17", "--input", "note=a=b"])).toEqual({ areas: "A3,A17", note: "a=b" });
    expect(inputFlags(["--approve", "x"])).toBeUndefined();
    expect(flags("--approve", "review-layer", "--input", "areas=A3,A17")).toEqual({ approvalId: "review-layer", decision: "approve", inputs: { areas: "A3,A17" }, operator: "tester" });
    expect(flags("--approve", "review-layer")).toEqual({ approvalId: "review-layer", decision: "approve", operator: "tester" });
    expect(flags("--decline", "review-layer", "--reason", "enough")).toEqual({ approvalId: "review-layer", decision: "decline", reason: "enough", operator: "tester" });
  });

  it("refuses a malformed or repeated --input, and one with no --approve", () => {
    expect(() => flags("--approve", "x", "--input")).toThrow(/--input needs <name>=<value>/);
    expect(() => flags("--approve", "x", "--input", "areas")).toThrow(/--input needs <name>=<value>/);
    expect(() => flags("--approve", "x", "--input", "=A3")).toThrow(/--input needs <name>=<value>/);
    expect(() => flags("--approve", "x", "--input", "--decline")).toThrow(/--input needs <name>=<value>/);
    expect(() => flags("--approve", "x", "--input", "a=1", "--input", "a=2")).toThrow(/--input a is given twice/);
    expect(() => flags("--input", "a=1")).toThrow(/--input gives a value to --approve <id>/);
    expect(() => flags("--supervisor", "pi", "--input", "a=1")).toThrow(/--input gives a value to --approve <id>/);
  });

  it("leaves a decline's refusal of inputs to the controller, which checks it against the declaration", () => {
    expect(flags("--decline", "x", "--input", "a=1")).toMatchObject({ decision: "decline", inputs: { a: "1" } });
  });
});
