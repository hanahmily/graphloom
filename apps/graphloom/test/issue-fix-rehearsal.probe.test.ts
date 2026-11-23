// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The issue-fix rehearsal under a live recoveryReserve, and the L3 probe (full tier; test/tiers.ts).

import { describe, expect, it } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import type { JobResult } from "@graphloom/runner";
import { check, probe, rehearse } from "../src/rehearsal.js";
import { GO, stubReviewResult, useRehearsal } from "./issue-fix-rehearsal.js";

const rehearsal = useRehearsal();

describe.skipIf(GO === undefined)("rehearsal under a profile that declares a live recoveryReserve (#151 review)", () => {
  // A live run's reserve (90 of 1,800) does not fit a rehearsal's 24 calls:
  // the generated task names a reserve of its own.
  const LIVE = { agentInvocations: 1800, recoveryReserve: 90 };

  it("checks, rehearses and probes successfully", async () => {
    const env = await rehearsal.ready(LIVE);
    const checked = await check(env.taskPath);
    expect(checked.ok, JSON.stringify(checked.problems)).toBe(true);
    const report = await rehearse(env.taskPath, { commands: "run" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    const fakeRunner = {
      async runJob(): Promise<JobResult> {
        return stubReviewResult();
      },
    };
    const probed = await probe(env.taskPath, { contract: "code-review-v2", commands: "run" }, fakeRunner);
    expect(probed.status).toBe("ok");
  }, 240_000);
});

describe.skipIf(GO === undefined)("graphloom probe (L3) on issue-fix with the banyandb profile", () => {
  it("dispatches code-review-v2 to the codex harness the graph actually uses, not the runner's default", async () => {
    const env = await rehearsal.ready();
    const jobs: JobSpec[] = [];
    const fakeRunner = {
      async runJob(job: JobSpec): Promise<JobResult> {
        jobs.push(job);
        return stubReviewResult();
      },
    };
    // Note: the runner's own default harness is "claude-code" (~/.config/graphloom/runner.json
    // is irrelevant here anyway, since this test supplies its own fake), so a probe that silently
    // fell back to a default instead of reading the real dispatch's harness would still "succeed"
    // here with the wrong harness recorded — the assertion below is what actually catches that.
    // Full mode: probe's own internal rehearsal must reach the Review stage, which
    // needs Fix's RED/GREEN checks to behave for real (see the happy rehearse test).
    const report = await probe(env.taskPath, { contract: "code-review-v2", commands: "run" }, fakeRunner);
    expect(report.status).toBe("ok");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.input).toMatchObject({ harness: "codex" });
  }, 120_000);
});
