// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The issue-fix rehearsal's Arbitrate scenarios (full tier; test/tiers.ts).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rehearse, resumeRehearsal } from "../src/rehearsal.js";
import { GO, useRehearsal } from "./issue-fix-rehearsal.js";

const rehearsal = useRehearsal();

/**
 * issue-fix 0.17.0's Arbitrate (docs/design-issue-fix-graph.md, "Rehearsal
 * and qualification"): the graph hands a design conflict to the scripted
 * supervisor, which enters the supervisor-only node, and leaves it along the
 * out-edge the ruling fits, through the real controller, plugin host and
 * harness stand-ins, the proof test run by `go test` in a checkout with the
 * test added.
 */
describe.skipIf(GO === undefined)("graphloom rehearse (L1) of issue-fix's Arbitrate scenarios", () => {
  for (const scenario of ["arbitrate-review", "arbitrate-fixer", "arbitrate-fixer-stands"]) {
    it(`reaches ready for ${scenario}, ending on the live path fix → review with Arbitrate's receipt`, async () => {
      const env = await rehearsal.ready();
      const report = await rehearse(env.taskPath, { commands: "run", scenario });
      expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
      expect(report.convergence.actual.path).toEqual(["fix", "review"]);
      expect(report.convergence.actual.receipts.sort()).toEqual(["arbitrate", "fix", "review"]);
      // B7: the recovery entries were the scenario's own, the hand-over and the settle, and nothing else.
      expect(report.boundaries.B7.status, JSON.stringify(report.boundaries.B7)).toBe("passed");
    }, 300_000);
  }

  it("stops arbitrate-operator for the operator's design ruling, and the operator's approval lets the run finish", async () => {
    const env = await rehearsal.ready();
    let stateDir: string | undefined;
    const report = await rehearse(env.taskPath, { commands: "run", scenario: "arbitrate-operator", keep: true, onRunCreated: ({ stateDir: dir }: { stateDir: string }) => void (stateDir = dir) } as Parameters<typeof rehearse>[1]);
    // The run waits inside Arbitrate as the scenario expects: a final stop for the declared design-ruling approval.
    // B5 lists the review passes and the arbiter's result as pending on the operator, not stuck, so the verdict is ready.
    expect(report.convergence.met, JSON.stringify(report.convergence)).toBe(true);
    expect(report.convergence.actual).toMatchObject({ status: "stopped", stopReason: "design ruling needs the operator", path: ["fix", "review"] });
    expect(report.boundaries.B5).toEqual({
      status: "passed",
      notes: [
        "stage review: a contract-valid result awaits the operator's approval design-ruling (the run waits in arbitrate)",
        "stage arbitrate: a contract-valid result awaits the operator's approval design-ruling (the run waits in arbitrate)",
      ],
    });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    expect(stateDir).toBeDefined();
    const episodesOf = async () =>
      ((JSON.parse(await readFile(path.join(stateDir!, "state.json"), "utf8")) as { supervisorEpisodes?: Array<{ proposal?: { action: { type: string } }; admission: { outcome: string } }> }).supervisorEpisodes ?? []);
    const before = await episodesOf();
    const resumed = await resumeRehearsal(stateDir!, { approval: { approvalId: "design-ruling", decision: "approve", inputs: { finding: "F1", ruling: "implementation-stands", note: "The thread asks only that a running backup be reported as running." }, operator: "maintainer" } });
    expect(resumed.status, JSON.stringify(resumed)).toBe("succeeded");
    expect(resumed.receipts.some((r) => r.stageId === "arbitrate" && r.requirementId === "design-ruling")).toBe(true);
    // A clean resume: the scripted supervisor continued at its leave, never replaying its enter, and nothing was rejected.
    expect(before.map((r) => r.proposal?.action.type)).toEqual(["enter", "return"]);
    const after = await episodesOf();
    expect(after.slice(before.length).map((r) => r.proposal?.action.type)).toEqual(["reenter", "return"]);
    expect(after.map((r) => r.admission.outcome)).not.toContain("inadmissible");
    // The operator's ruling reaches the pull request body the delivery wrote.
    const delivered = resumed.evidence.find((e) => (e.payload as { command?: { id?: string } } | undefined)?.command?.id === "deliver");
    const body = (delivered?.payload as { command: { report?: { text: string } } } | undefined)?.command.report?.text ?? "";
    expect(body).toContain("## Design rulings");
    expect(body).toContain("**R1** on I1: `implementation-stands`, decided by the operator (maintainer)");
  }, 300_000);
});
