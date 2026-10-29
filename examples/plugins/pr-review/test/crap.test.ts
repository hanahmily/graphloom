// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { checkThresholds, coverageFraction, crapRounded, crapValue, type Coverage } from "../src/metrics/index.js";

const measured = (covered: number, total: number): Coverage => ({ source: "measured", covered, total });
const unknown: Coverage = { source: "unknown", reason: "docker unavailable" };

describe("CRAP", () => {
  it("is comp^2 * (1 - cov)^3 + comp", () => {
    expect(crapValue(12, measured(21, 30))).toBeCloseTo(144 * 0.3 ** 3 + 12, 10);
    expect(crapRounded(12, measured(21, 30))).toBe(15.89);
    expect(crapRounded(1, measured(1, 1))).toBe(1);
    expect(crapRounded(6, measured(1, 2))).toBe(10.5);
  });
  it("uses cov = 0 for unknown coverage: comp^2 + comp", () => {
    expect(crapRounded(7, unknown)).toBe(56);
    expect(crapRounded(7, undefined)).toBe(56);
    expect(coverageFraction(unknown)).toBe(0);
  });
  it("treats a function with no executable statements as fully covered", () => {
    expect(coverageFraction(measured(0, 0))).toBe(1);
    expect(crapRounded(3, measured(0, 0))).toBe(3);
  });
});

describe("thresholds", () => {
  it("applies complexity < 10 and nesting <= 3", () => {
    expect(checkThresholds({ complexity: 9, nesting: 3, coverage: measured(1, 1) }).complexity.exceeded).toBe(false);
    expect(checkThresholds({ complexity: 10, nesting: 3, coverage: measured(1, 1) }).complexity.exceeded).toBe(true);
    expect(checkThresholds({ complexity: 1, nesting: 3, coverage: measured(1, 1) }).nesting.exceeded).toBe(false);
    expect(checkThresholds({ complexity: 1, nesting: 4, coverage: measured(1, 1) }).nesting.exceeded).toBe(true);
  });
  it("triggers on measured CRAP >= 30", () => {
    const hit = checkThresholds({ complexity: 8, nesting: 1, coverage: measured(0, 10) });
    expect(hit.crap).toMatchObject({ value: 72, upperBound: false, triggers: true });
    const ok = checkThresholds({ complexity: 8, nesting: 1, coverage: measured(9, 10) });
    expect(ok.crap.triggers).toBe(false);
    expect(ok.coverageQuestion).toBe(false);
  });
  it("shows an upper bound of 30 or more with unknown coverage but triggers only at complexity >= 10", () => {
    const low = checkThresholds({ complexity: 7, nesting: 1, coverage: unknown });
    expect(low.crap).toMatchObject({ value: 56, upperBound: true, triggers: false });
    expect(low.coverageQuestion).toBe(false);
    const high = checkThresholds({ complexity: 10, nesting: 1, coverage: unknown });
    expect(high.crap).toMatchObject({ value: 110, upperBound: true, triggers: true });
    expect(high.coverageQuestion).toBe(true);
  });
});
