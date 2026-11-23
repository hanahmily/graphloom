// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The pr-design-review rehearsal's clean design review, through Publish to the run's end (full tier; test/tiers.ts).

import { describe, expect, it } from "vitest";
import { loadRunState } from "@graphloom/controller";
import { rehearseStopAt, resumeRehearsal } from "../src/rehearsal.js";
import { commandIds, GO, SUITE, useRehearsal } from "./pr-design-review-rehearsal.js";

const rehearsal = useRehearsal();

describe.skipIf(GO === undefined)(SUITE, () => {
  it("converges for a clean design review: Publish posts nothing, needs no GitHub write, and the run ends complete naming the PR review", async () => {
    const env = await rehearsal.ready();
    const stopped = await rehearseStopAt(env.taskPath, "publish", { scenario: "design-clean", offline: true, commands: "stub" });
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    const state = await loadRunState(stopped.stateDir);
    expect([...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))].sort()).toEqual(["answers", "fetch", "publish", "questions", "report", "round1"]);
    // Every stage is accepted: the graph's own last call ends the run complete, with the line that names the next command.
    const ended = await resumeRehearsal(stopped.stateDir);
    expect(ended.stopReason).toBe("complete");
    expect(ended.blocker).toBe("design review clean at 0123456; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#7 --profile banyandb");
    const ids = await commandIds(stopped.stateDir);
    expect(ids).toContain("ledger-published");
    expect(ids.filter((id) => id.startsWith("sandbox-") || id.startsWith("cover-"))).toEqual([]);
    expect(rehearsal.github().requests).toEqual([]);
  }, 180_000);
});
