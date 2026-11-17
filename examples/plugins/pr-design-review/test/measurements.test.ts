// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { MetricsRecord } from "../src/kit/metrics/record.js";
import { measurements } from "../src/validators.js";
import { hotspots, hotspotText } from "../src/kit/scope.js";
import { BANYANDB, candidateEvidence, simulate } from "./support.js";

const rec = (fn: string, complexity: number, nesting: number, extra: Partial<MetricsRecord> = {}): MetricsRecord => ({ function: fn, path: `pkg/${fn}.go`, startLine: 1, endLine: 9, change: "added", complexity, nesting, test: false, ...extra }) as MetricsRecord;

describe("measurements in round 1 (design-pr-review-split §3.4)", () => {
  it("rank the hotspots by complexity, then nesting, with no CRAP, and show a modified function that got worse as base → head", () => {
    const records = [rec("a", 4, 5, { crap: 900 }), rec("b", 12, 1), rec("c", 12, 3), rec("d", 7, 2, { change: "modified", base: { complexity: 3, nesting: 2, startLine: 1, endLine: 5, path: "pkg/d.go" } })];
    const top = hotspots(records, undefined, true);
    expect(top.map((h) => h.function)).toEqual(["c", "b", "d", "a"]);
    expect(top.map(hotspotText)).toEqual(["c — complexity 12, nesting 3 (added)", "b — complexity 12, nesting 1 (added)", "d — complexity 3 → 7, nesting 2 (modified)", "a — complexity 4, nesting 5 (added)"]);
    // pr-review's ranking is unchanged: CRAP first.
    expect(hotspots(records)[0]!.function).toBe("a");
  });

  it("the measurements validator accepts no coverage or mutation record", () => {
    const sim = simulate({ scenarioName: "design-clean", maxSteps: 400 });
    const judge = (evidence: typeof sim.evidence) => measurements.evaluate({ requirementId: "measurements", statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
    expect(judge(sim.evidence)).toMatchObject({ status: "passed", reason: expect.stringContaining("no coverage, CRAP or mutation was taken") });
  });
});
