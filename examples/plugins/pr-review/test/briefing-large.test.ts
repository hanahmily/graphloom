// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { FinalBriefing } from "../src/briefing.js";
import { LARGE_LIMITS } from "../src/rehearsal.js";
import { assignmentOf, scenarioWith, simulate } from "./support.js";

const LARGE = { limits: LARGE_LIMITS };
type Change = Parameters<typeof scenarioWith>[1];
const run = (change?: Change) => simulate({ scenario: scenarioWith("large-pull-request", change ?? (() => undefined), LARGE), config: LARGE, maxSteps: 300 });

describe("the briefing in large mode (design 6.1, 6.9, 6.10)", () => {
  const sim = run();

  it("is the one reporter's: it is told what the briefing is for, and to label each area id", () => {
    const reporters = sim.jobs.filter((j) => j.resultSchema === "change-report-v1");
    expect(reporters).toHaveLength(1);
    const a = assignmentOf(reporters[0]!);
    expect(a).toContain("The first fields of your result are a briefing");
    expect(a).toContain('"whatsNew" (3 to 5 bullets');
    expect(a).toContain('"features" (at most 3');
    expect(a).toContain('"check" (five lists');
    expect(a).toContain('"areas": one entry for each area id in the digest');
    expect(a).toContain("may name any file of the head or of the base");
    expect(a).not.toContain("architecture");
  });

  it("is judged by the claim check, claim by claim, and its quotes are verified against the trees after it", () => {
    const checker = sim.jobs.filter((j) => j.resultSchema === "claim-check-v1").at(-1)!;
    for (const id of ["W1", "F1 ", "F1.s1", "F1.s2", "F1.f1"]) expect(assignmentOf(checker)).toContain(`\n${id}`);
    const order = sim.jobs.map((j) => (j.kind === "agent" ? `${j.resultSchema}` : j.instruction.startsWith("Check the claims' quotes") ? "quotes" : "")).filter((x) => x !== "");
    const at = order.indexOf("change-report-v1");
    expect(order.slice(at, at + 3)).toEqual(["change-report-v1", "claim-check-v1", "quotes"]);
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
  });

  it("is in report.json, with a label for each area, and review.md mirrors it as text", () => {
    const json = JSON.parse(sim.written!.json) as { briefing: FinalBriefing; areas: Array<{ id: string }>; scope: Record<string, { files: number }>; architecture?: unknown };
    expect(json.architecture).toBeUndefined();
    expect(json.briefing.whatsNew.length).toBeGreaterThan(0);
    expect(json.briefing.features.map((f) => [f.id, f.name, f.stages.map((s) => s.id)])).toEqual([["F1", "Alpha rules applied by beta", ["alpha", "beta"]]]);
    expect(json.briefing.areas.map((a) => a.id)).toEqual(json.areas.map((a) => a.id));
    expect(json.scope.generated!.files).toBeGreaterThan(0);
    const md = sim.written!.markdown;
    expect(md).toContain("## Data flow per new feature\n### F1. Alpha rules applied by beta");
    expect(md).toContain("- pkg/alpha rules (source) — pkg/alpha/alpha.go:");
    expect(md).toMatch(/\| A2 \| changes under pkg\/alpha \| 1 \| \+\d+ −0 \|/);
    expect(md).toContain("generated code (generated)");
    expect(md).not.toContain("```mermaid");
  });

  it("drops a flow the checker does not support after the revision, and the feature with it when no flow is left, and records both", () => {
    const dropped = run((s) => {
      const report = s.results["change-report-v1"]![0]!;
      s.results["change-report-revision-v1"] = [report];
      const checks = s.results["claim-check-v1"]!;
      const last = checks.at(-1)!.output as { verdicts: Array<{ item: string; verdict: string; note: string }> };
      for (const v of last.verdicts) if (v.item === "F1.f1") Object.assign(v, { verdict: "unsupported", note: "beta does not apply alpha" });
      // The quote check covers one claim fewer: the flow's.
      const n = Number(/checked (\d+)/.exec(s.commands!["tree-quote-1"]!.stdout ?? "")![1]) - 1;
      s.commands!["tree-quote-1"] = { exitCode: 0, stdout: `${Array.from({ length: n }, (_x, i) => `${i + 1} ok`).join("\n")}\nchecked ${n}\n` };
    });
    expect(dropped.receipts.every((r) => r.valid)).toBe(true);
    const json = JSON.parse(dropped.written!.json) as { briefing: FinalBriefing; removedParts: Array<{ id: string; kind: string; reason: string }> };
    expect(json.briefing.features).toEqual([]);
    expect(json.removedParts.find((p) => p.id === "F1.f1")).toMatchObject({ kind: "flow", reason: "unsupported: beta does not apply alpha" });
    expect(json.removedParts.find((p) => p.id === "F1")).toMatchObject({ kind: "feature" });
    expect(dropped.written!.markdown).toContain("## Removed by the claim check\n- Feature flow `F1.f1`");
  });

  it("sends the reporter back when its quotes are not in the tree", () => {
    const bad = run((s) => {
      for (const [id, out] of Object.entries(s.commands ?? {})) if (id.startsWith("tree-quote-")) out.stdout = out.stdout!.replace(/^1 ok$/m, "1 nomatch");
    });
    const reporters = bad.jobs.filter((j) => j.resultSchema === "change-report-v1" || j.resultSchema === "change-report-revision-v1");
    expect(reporters.length).toBeGreaterThan(1);
  });
});
