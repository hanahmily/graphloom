// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { Architecture } from "../src/architecture.js";
import { LARGE_LIMITS } from "../src/rehearsal.js";
import { assignmentOf, scenarioWith, simulate } from "./support.js";

const LARGE = { limits: LARGE_LIMITS };
type Change = Parameters<typeof scenarioWith>[1];
const run = (change?: Change) => simulate({ scenario: scenarioWith("large-pull-request", change ?? (() => undefined), LARGE), config: LARGE, maxSteps: 300 });

describe("the architecture diagram in large mode (design 6.9, 6.10)", () => {
  const sim = run();

  it("is the one reporter's: it is told to draw the diagram of the whole pull request", () => {
    const reporters = sim.jobs.filter((j) => j.resultSchema === "change-report-v1");
    expect(reporters).toHaveLength(1);
    expect(assignmentOf(reporters[0]!)).toContain('"architecture" of your result is a diagram');
    expect(assignmentOf(reporters[0]!)).not.toContain('leave "architecture" empty');
    expect(assignmentOf(reporters[0]!)).toContain("at most 30");
    expect(assignmentOf(reporters[0]!)).toContain("at most 60");
  });

  it("is checked against the trees after the reporter and before the claim check, which judges its nodes and edges", () => {
    const order = sim.jobs.map((j) => (j.kind === "agent" ? `${j.resultSchema}` : j.instruction.startsWith("Check the architecture") ? "arch" : "")).filter((x) => x !== "");
    const at = order.indexOf("change-report-v1");
    expect(order.slice(at, at + 3)).toEqual(["change-report-v1", "arch", "claim-check-v1"]);
    const checker = sim.jobs.filter((j) => j.resultSchema === "claim-check-v1").at(-1)!;
    for (const id of ["A.alpha", "A.beta", "A.e1"]) expect(assignmentOf(checker)).toContain(id);
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
  });

  it("is in report.json and review.md, and the import between the two packages is as the head's import block says", () => {
    const json = JSON.parse(sim.written!.json) as { architecture: Architecture };
    expect(json.architecture.nodes.map((n) => n.id)).toEqual(["alpha", "beta"]);
    expect(json.architecture.edges).toHaveLength(1);
    expect(sim.written!.markdown).toContain("## Architecture\n```mermaid");
    const checker = sim.jobs.filter((j) => j.resultSchema === "claim-check-v1").at(-1)!;
    expect(assignmentOf(checker)).not.toContain("Plugin note");
  });

  it("tells the checker when the import is missing", () => {
    const missing = run((s) => {
      for (const [id, out] of Object.entries(s.commands ?? {})) {
        if (id.startsWith("arch-check-") && out.stdout?.includes("import example.com/lib/pkg/alpha")) out.stdout = out.stdout.replace("import example.com/lib/pkg/alpha", "import example.com/lib/pkg/other");
      }
    });
    const checker = missing.jobs.filter((j) => j.resultSchema === "claim-check-v1").at(-1)!;
    expect(assignmentOf(checker)).toContain("Plugin note: import missing");
    expect(missing.receipts.every((r) => r.valid)).toBe(true);
  });

  it("drops an edge the checker does not support after the revision, keeps the nodes, and records it under 'Removed by the claim check'", () => {
    const dropped = run((s) => {
      const report = s.results["change-report-v1"]![0]!;
      s.results["change-report-revision-v1"] = [report];
      const checks = s.results["claim-check-v1"]!;
      const last = checks.at(-1)!.output as { verdicts: Array<{ item: string; verdict: string; note: string }> };
      for (const v of last.verdicts) if (v.item === "A.e1") Object.assign(v, { verdict: "unsupported", note: "beta does not import alpha" });
      // The quote check covers one claim fewer: the edge's.
      const n = Number(/checked (\d+)/.exec(s.commands!["arch-quote-1"]!.stdout ?? "")![1]) - 1;
      s.commands!["arch-quote-1"] = { exitCode: 0, stdout: `${Array.from({ length: n }, (_x, i) => `${i + 1} ok`).join("\n")}\nchecked ${n}\n` };
    });
    expect(dropped.receipts.every((r) => r.valid)).toBe(true);
    const json = JSON.parse(dropped.written!.json) as { architecture: Architecture; removedParts: Array<{ id: string; kind: string; reason: string }> };
    expect(json.architecture.nodes.map((n) => n.id)).toEqual(["alpha", "beta"]);
    expect(json.architecture.edges).toEqual([]);
    expect(json.removedParts.find((p) => p.id === "A.e1")).toMatchObject({ kind: "edge", reason: "unsupported: beta does not import alpha" });
    expect(dropped.written!.markdown).toContain("## Removed by the claim check\n- Architecture connection `A.e1`");
  });

  it("sends the reporter back when a cite of the diagram does not resolve in its tree", () => {
    const bad = run((s) => {
      for (const [id, out] of Object.entries(s.commands ?? {})) if (id.startsWith("arch-check-")) out.stdout = out.stdout!.replace(/^1 ok$/m, "1 missing");
    });
    const reporters = bad.jobs.filter((j) => j.resultSchema === "change-report-v1");
    expect(reporters.length).toBeGreaterThan(1);
    expect(assignmentOf(reporters[1]!)).toContain("names no such file in the");
    expect(bad.final.action).toMatchObject({ type: "supervise" });
  });
});
