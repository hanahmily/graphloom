// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The issue-fix rehearsal's scenarios on the graph's own correction, the stand-ins' variables and --offline (full tier;
// test/tiers.ts).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rehearse } from "../src/rehearsal.js";
import { GO, useRehearsal } from "./issue-fix-rehearsal.js";

const rehearsal = useRehearsal();

describe.skipIf(GO === undefined)("graphloom rehearse (L1) on issue-fix with the banyandb profile", () => {
  // #193: a review that fails once on a confirmed finding is the graph's own
  // known correction. The scenario scripts no supervisor decision, so a
  // supervisor episode would stop the run (or enter recovery, which B7 flags)
  // and the verdict could not be ready.
  it("reenters Fix itself when review confirms a finding once, and reaches delivery with no supervisor episode (#193)", async () => {
    const env = await rehearsal.ready();
    const report = await rehearse(env.taskPath, { commands: "run", scenario: "review-reenters" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    expect(report.boundaries.B7.status).toBe("passed");
    expect(report.convergence.actual.receipts.sort()).toEqual(["fix", "review"]);
  }, 180_000);

  it("never lets a command the graph runs see the variables that configure the stand-ins (#187)", async () => {
    const env = await rehearsal.ready();
    const report = await rehearse(env.taskPath, { commands: "run" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    const seen = await readFile(path.join(env.dir, "ocr-env.txt"), "utf8");
    expect(seen).toMatch(/^PATH=/m); // the check really ran, and with the operator's environment
    expect(seen).not.toMatch(/GRAPHLOOM_REHEARSAL/);
  }, 120_000);

  it("--offline never asks the real (fake) GitHub, and reports the unrecorded read as unverified under B2", async () => {
    const env = await rehearsal.ready();
    // The go-test scenario declares no `reads` at all (§4.5 has not
    // recorded one yet): every dispatched read is unrecorded by construction,
    // which is exactly the gap --offline exists to report rather than hide.
    const report = await rehearse(env.taskPath, { offline: true });
    expect(rehearsal.github().requests).toEqual([]);
    expect(report.substituted.some((s) => s.startsWith("github: rehearsal stand-in"))).toBe(true);
    expect(report.boundaries.B2.status).toBe("unverified");
    expect(report.boundaries.B2.notes.some((n) => n.startsWith("offline: no recorded read for graphloom.github/"))).toBe(true);
  }, 30_000);
});
