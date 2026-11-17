// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { ANSWERED, scenarioWith, simulate } from "./support.js";

/** The default scenario with an answerer that returns no answer `times` times in a row, then its own answers. */
const noAnswers = (times: number) =>
  scenarioWith("report", (sc) => {
    const good = sc.results["answers-v1"]!;
    sc.results["answers-v1"] = [...Array.from({ length: times }, () => ({ output: { answers: [] } })), ...good];
  });

describe("a reentry to fetch that left the candidate unchanged, after the answer checker ran", () => {
  // N1's answer checker is the latest review evidence of the candidate, so the report's validators no longer see the claim checks;
  // the graph's record of them puts them back, and the Report stage is accepted again without a second report.
  it("accepts Report again from the recorded claim checks: no second checkout, report or claim check", () => {
    const sim = simulate({ scenario: noAnswers(3), reentries: [{ stageId: "fetch" }, { stageId: "answers" }], maxSteps: 800 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    // Every escalation is the answerer's (the second is the same attempt, which the reentry to fetch did not restart): none is the report's.
    const reasons = sim.decisions.flatMap((d) => (d.action.type === "supervise" ? [d.action.supervise.reason] : []));
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r).toMatch(/^the answers still fail deterministic validation/);
    expect(sim.jobs.filter((j) => j.stageId === "fetch" && j.purpose === "work")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "change-report-v1")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "claim-check-v1")).toHaveLength(1);
    expect(sim.receipts.filter((r) => r.stageId === "report" && r.valid).map((r) => r.requirementId).sort()).toEqual(["change-report", "claims-checked", "measurements"]);
  });
});
