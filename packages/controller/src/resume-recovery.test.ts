import { describe, expect, it } from "vitest";
import { reconcileRepairJournal } from "./repair-lifecycle.js";
import { RESUME_RETRY_REMEDY, returnToGraphOnResume } from "./resume-recovery.js";
import { STEP_LIMIT_STOP_REASON, type DurableRunState } from "./state.js";

/** Only the fields resume's recovery step reads or must keep; the rest is irrelevant to it. */
function stoppedInRecovery(extra: Partial<DurableRunState> = {}): DurableRunState {
  return {
    runId: "r",
    status: "stopped",
    stopReason: "checkout is broken",
    blocker: "executor cannot clone the repo",
    mode: "recovery",
    generation: 3,
    stateRevision: 10,
    current: { stageId: "write", attempt: 2 },
    budgets: { agentInvocations: 5, jobs: 4, decisions: 3, corrections: 1, waitMs: 1_000 },
    recoveryEpisodeId: "ep-old",
    recoveryTrigger: { code: "executor_failed", message: "executor graphloom.agent/run failed: checkout failed", evidenceRefs: ["ev-g1-15"] },
    correctionTrials: { write: 2 },
    handoff: { write: { trials: 2 } },
    repeatedProposals: { mark: "m", entries: {} },
    supervisorMark: {
      action: "stop",
      reason: "checkout is broken",
      episodeId: "ep-old",
      stageId: "write",
      attempt: 2,
      generation: 3,
      evidenceRefs: [],
      receiptIds: [],
      candidates: {},
      notes: [],
    },
    ...extra,
  } as unknown as DurableRunState;
}

describe("returnToGraphOnResume", () => {
  it("closes the episode and returns to normal, keeping budgets, correction trials and handoffs", () => {
    const before = stoppedInRecovery({ environmentBlock: { activeVersion: "hello@1", reason: "lockfile changed" } });
    const after = returnToGraphOnResume(before);
    expect(after.mode).toBe("normal");
    expect(after.recoveryEpisodeId).toBeUndefined();
    expect(after.recoveryTrigger).toBeUndefined();
    // The environment is checked again before the graph is asked anything.
    expect(after.environmentBlock).toBeUndefined();
    expect(after.budgets).toEqual(before.budgets);
    expect(after.correctionTrials).toEqual({ write: 2 });
    expect(after.handoff).toEqual(before.handoff);
    expect(after.repeatedProposals).toEqual(before.repeatedProposals);
    expect(after.remedies).toEqual([
      expect.objectContaining({
        condition: "resumed in recovery (executor_failed)",
        remedy: RESUME_RETRY_REMEDY,
        detail: "executor graphloom.agent/run failed: checkout failed",
        episodeId: "ep-old",
      }),
    ]);
    expect(after.supervisorMark?.notes).toEqual([expect.stringMatching(/^the operator resumed the run; .* \(the executor_failed trigger\)$/)]);
  });

  it("leaves a run in normal mode untouched", () => {
    const normal = stoppedInRecovery({ mode: "normal" });
    expect(returnToGraphOnResume(normal)).toBe(normal);
  });

  it("continues the episode after the controller's own step-limit pause", () => {
    const paused = stoppedInRecovery({ stopReason: STEP_LIMIT_STOP_REASON });
    expect(returnToGraphOnResume(paused)).toBe(paused);
  });

  it("runs after the repair journal reconciles, so a repair interrupted mid-flight still settles", () => {
    const midRepair = stoppedInRecovery({
      activationIntent: { artifactId: "a1", fromVersion: "hello@1", toVersion: "hello@1+r", generation: 3, at: "t", status: "intent" },
      repairCandidates: [{ artifactId: "a2", status: "qualifying" } as never, { artifactId: "a3", status: "qualified" } as never],
    });
    const after = returnToGraphOnResume(reconcileRepairJournal(midRepair));
    expect(after.mode).toBe("normal");
    expect(after.activationIntent?.status).toBe("aborted");
    expect(after.repairCandidates).toMatchObject([
      { artifactId: "a2", status: "rejected" },
      // A qualified candidate stays available to a later episode if the failure recurs.
      { artifactId: "a3", status: "qualified" },
    ]);
  });
});
