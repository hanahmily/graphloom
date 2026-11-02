// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { maxWireBytes, parseJsonBounded, WireValidationError } from "./index.js";

describe("the wire message bound", () => {
  it("is 64 MB by default, so a large run's view of more than 16 MB still passes", () => {
    expect(maxWireBytes({})).toBe(64_000_000);
    const big = JSON.stringify({ evidence: "x".repeat(18_000_000) });
    expect((parseJsonBounded(big) as { evidence: string }).evidence).toHaveLength(18_000_000);
  });

  it("takes GRAPHLOOM_MAX_WIRE_BYTES when it is a positive integer, and ignores anything else", () => {
    expect(maxWireBytes({ GRAPHLOOM_MAX_WIRE_BYTES: "1000" })).toBe(1000);
    for (const bad of ["", "0", "-5", "12.5", "lots"]) expect(maxWireBytes({ GRAPHLOOM_MAX_WIRE_BYTES: bad })).toBe(64_000_000);
  });

  it("still refuses a message over the bound", () => {
    expect(() => parseJsonBounded(JSON.stringify("x".repeat(200)), 100)).toThrow(WireValidationError);
    expect(() => parseJsonBounded(JSON.stringify("x".repeat(200)), 100)).toThrow(/payload exceeds 100 bytes/);
  });
});
