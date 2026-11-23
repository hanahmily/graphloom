// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The pr-design-review rehearsal's smoke set, run on every pull request: the check and the happy scenario. The other
// scenarios are in pr-design-review-rehearsal.<group>.test.ts, the full tier (test/tiers.ts); the clean design review
// (pr-design-review-rehearsal.publish.test.ts) takes as long as the happy scenario, so it is not part of the smoke set.

import { describe, expect, it } from "vitest";
import { check } from "../src/rehearsal.js";
import { GO, round1Test, SUITE, useRehearsal } from "./pr-design-review-rehearsal.js";

const rehearsal = useRehearsal();

describe.skipIf(GO === undefined)(SUITE, () => {
  it("checks: the stage list, the recorded replies walked through the real validators, and the environment (no Docker check)", async () => {
    const env = await rehearsal.ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("docker-");
  }, 60_000);

  round1Test(rehearsal, "happy");
});
