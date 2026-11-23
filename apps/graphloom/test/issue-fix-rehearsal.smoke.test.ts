// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The issue-fix rehearsal's smoke set, run on every pull request: the happy scenario, and the L0 check (no rehearsal
// scenario). The other scenarios are in issue-fix-rehearsal.<group>.test.ts, the full tier (test/tiers.ts).

import { describe, expect, it } from "vitest";
import { check, rehearse } from "../src/rehearsal.js";
import { GO, useRehearsal } from "./issue-fix-rehearsal.js";

const rehearsal = useRehearsal();

describe.skipIf(GO === undefined)("graphloom rehearse (L1) on issue-fix with the banyandb profile", () => {
  // Full mode (--commands run): Fix's RED/GREEN validators need the same
  // command id ("regression") to behave differently per checkout (fail on
  // the base commit, pass on the candidate) — quick mode's one stubbed
  // result per command id (docs/design-graph-rehearsal.md §3.2) cannot
  // represent that, so this plugin's own Fix stage is not quick-mode
  // rehearsable yet.
  it("reaches ready for the happy scenario, across all three coding harnesses", async () => {
    const env = await rehearsal.ready();
    const report = await rehearse(env.taskPath, { commands: "run" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    expect(report.convergence.actual.receipts.sort()).toEqual(["fix", "review"]);
    // The rehearsal run pinned the harness issue-fix's preference picks among stand-ins for all three (S5).
    expect(report.supervisorSelection).toEqual({
      harness: "pi",
      source: "plugin",
      reason: "the plugin's preference (pi, claude-code, codex): pi; a scripted stand-in answers for it",
    });
  }, 120_000);

  it("walks the banyandb profile's recorded replies through its real validators at L0, finding nothing a real dispatch would not", async () => {
    const env = await rehearsal.ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    // The selection run would make: issue-fix prefers pi, which the flat Pi config enables.
    expect(report.supervisor).toEqual({ status: "selected", harness: "pi", source: "plugin", reason: "the plugin's preference (pi, claude-code, codex): pi", warnings: [] });
  }, 30_000);
});
