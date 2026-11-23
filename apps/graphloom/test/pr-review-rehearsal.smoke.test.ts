// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The pr-review rehearsal's smoke set, run on every pull request: the check and the prelude scenario. The other
// scenarios are in pr-review-rehearsal.<group>.test.ts, the full tier (test/tiers.ts).

import { describe, expect, it } from "vitest";
import { check } from "../src/rehearsal.js";
import { contextTest, GO, SUITE, useRehearsal } from "./pr-review-rehearsal.js";

const rehearsal = useRehearsal();

describe.skipIf(GO === undefined)(SUITE, () => {
  it("checks: the stage list, the recorded replies walked through the real validators, and the environment", async () => {
    const env = await rehearsal.ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    expect(report.supervisor).toMatchObject({ status: "selected", harness: "pi", source: "plugin" });
  }, 60_000);

  contextTest(rehearsal, "prelude");
});
