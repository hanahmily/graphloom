import { describe, expect, it } from "vitest";
import type { EvidenceRecord, GraphDefinition, GraphDecision, ValidationInput, ValidationResult } from "@graphloom/sdk";
import type { CallContext, HostResult, PluginHost } from "@graphloom/plugin-host";
import { replayRun } from "./replay.js";
import type { DurableRunState } from "./state.js";
import type { IntakePin } from "./intake.js";

const definition: GraphDefinition = {
  graphId: "test",
  version: "0.2.0",
  stages: [{ id: "review", name: "Review", requirementIds: ["req"] }],
  requirements: [{ id: "req", statement: "reviewed", evidenceSchema: "review-verdict-v1" }],
  defaultValidators: [{ requirementId: "req", validatorId: "v", version: "1" }],
  resultContracts: [
    {
      name: "review-verdict-v1",
      schema: { type: "object", properties: { verdict: { type: "string" }, summary: { type: "string" } }, required: ["verdict", "summary"] },
      evidenceKind: "review",
    },
  ],
};

const intake: IntakePin = {
  taskPath: "/t/task.yaml",
  taskDir: "/t",
  task: { graph: "test", repo: "./repo", request: "test" },
  repoPath: "/t/repo",
  pinnedHead: "0".repeat(40),
  bundle: { graphId: "test", version: "0.2.0", bundlePath: "/t/bundle", sdkProtocol: 1, digests: {}, manifestRaw: "{}", manifestDigest: "d", entryDigest: "d" },
  grants: { sourceRepair: false, validatorSubstitution: false },
  budgets: { agentInvocations: 600, jobs: 128, decisions: 512, corrections: 8 },
};

function recordedState(evidence: EvidenceRecord[], receipts: DurableRunState["receipts"] = []): DurableRunState {
  return {
    runId: "live-run",
    status: "stopped",
    stopReason: "agentInvocations budget exhausted",
    generation: 2,
    stateRevision: 0,
    activeVersion: "test@0.1.0",
    mode: "normal",
    current: { stageId: "review", attempt: 1 },
    receipts,
    evidence,
    outstanding: [],
    definition: { ...definition, resultContracts: [] }, // pinned (old) definition: no declared contracts yet
    validatorBindings: definition.defaultValidators,
    budgets: { ...intake.budgets },
    intake,
    worktreePath: "/t/worktree",
    worktreeBranch: "graphloom/live-run",
    artifactDir: "/t/state/live-run/artifacts",
    stateDir: "/t/state/live-run",
    sourceDirtyBefore: [],
    evidenceSeq: evidence.length,
    receiptSeq: receipts.length,
    versionHistory: [{ activeVersion: "test@0.1.0", generation: 1, reason: "intake", at: "2026-01-01T00:00:00.000Z" }],
  };
}

const misclassifiedReview: EvidenceRecord = {
  ref: "ev-1",
  kind: "other",
  generation: 2,
  resultSchema: "review-verdict-v1",
  payload: {
    codingAgent: { harness: "pi", status: "completed", output: { verdict: "approved", summary: "looks right" } },
    producer: { stageId: "review", purpose: "review", executorId: "graphloom.agent/run" },
  },
};

function fakeHost(options: {
  definition: GraphDefinition;
  evaluateImpl?: (input: ValidationInput) => ValidationResult;
  advanceImpl?: (evidence: EvidenceRecord[]) => GraphDecision;
}): PluginHost {
  return {
    activeVersion: "test@0.2.0",
    generation: 1,
    async describe(): Promise<HostResult<GraphDefinition>> {
      return { ok: true, value: options.definition };
    },
    async advance(_ctx: CallContext, view): Promise<HostResult<GraphDecision>> {
      const decision = options.advanceImpl?.(view.evidence) ?? { reason: "no-op", action: { type: "stop", stop: { reason: "replay", blocker: "none" } } };
      return { ok: true, value: decision };
    },
    async evaluate(_ctx: CallContext, _validatorId: string, input: ValidationInput): Promise<HostResult<ValidationResult>> {
      const result = options.evaluateImpl?.(input) ?? { status: "inconclusive", reason: "no evaluateImpl" };
      return { ok: true, value: result };
    },
    async close(): Promise<void> {},
  };
}

describe("replayRun", () => {
  it("reclassifies a record the old contractless definition recorded as 'other' into 'review'", async () => {
    const state = recordedState([misclassifiedReview]);
    const host = fakeHost({ definition });
    const report = await replayRun(state, host);
    expect(report.reclassified).toEqual([
      { ref: "ev-1", before: "other", after: "review", contract: { name: "review-verdict-v1", status: "valid", problems: [] } },
    ]);
    expect(report.contracts).toMatchObject({ valid: 1, invalid: 0 });
  });

  it("keeps the producer on a flattened record, so a stage/purpose-scoped lookup still finds it", async () => {
    const state = recordedState([misclassifiedReview]);
    const host = fakeHost({
      definition,
      evaluateImpl: (input) => {
        const review = input.evidence.find((e) => e.kind === "review");
        const producer = (review?.payload as { producer?: { stageId?: string } } | undefined)?.producer;
        return producer?.stageId === "review" ? { status: "passed", reason: "found by stage" } : { status: "inconclusive", reason: "producer lost" };
      },
    });
    const report = await replayRun(state, host);
    expect(report.requirements).toEqual([{ requirementId: "req", hadReceipt: false, now: { status: "passed", reason: "found by stage" } }]);
  });

  it("leaves a record with an unrecognized or missing contract untouched", async () => {
    const noContract: EvidenceRecord = { ref: "ev-2", kind: "other", generation: 2, payload: { foo: "bar" } };
    const state = recordedState([noContract]);
    const host = fakeHost({ definition });
    const report = await replayRun(state, host);
    expect(report.reclassified).toEqual([]);
  });

  it("flags a now-invalid reclassification with its problems, and keeps the raw wrapper", async () => {
    const badReview: EvidenceRecord = {
      ref: "ev-3",
      kind: "other",
      generation: 2,
      resultSchema: "review-verdict-v1",
      payload: { codingAgent: { harness: "pi", status: "completed", output: { verdict: "approved" } } },
    };
    const state = recordedState([badReview]);
    const host = fakeHost({ definition });
    const report = await replayRun(state, host);
    expect(report.reclassified[0]).toMatchObject({ after: "other", contract: { status: "invalid" } });
    expect(report.contracts.invalid).toBe(1);
  });

  it("re-evaluates each requirement's current validator against the reclassified evidence, naming whether a receipt existed", async () => {
    const state = recordedState([misclassifiedReview], []); // no receipt recorded — the original bug
    const host = fakeHost({
      definition,
      evaluateImpl: (input) => {
        const review = input.evidence.find((e) => e.kind === "review");
        return review !== undefined ? { status: "passed", reason: "approved" } : { status: "inconclusive", reason: "no review yet" };
      },
    });
    const report = await replayRun(state, host);
    expect(report.requirements).toEqual([{ requirementId: "req", hadReceipt: false, now: { status: "passed", reason: "approved" } }]);
  });

  it("asks the current advance() what it would do next, given the reclassified evidence", async () => {
    const state = recordedState([misclassifiedReview]);
    const expectedDecision: GraphDecision = { reason: "review landed", action: { type: "validate", validate: { stageId: "review", requirementIds: ["req"] } } };
    const host = fakeHost({
      definition,
      advanceImpl: (evidence) => (evidence.some((e) => e.kind === "review") ? expectedDecision : { reason: "none", action: { type: "stop", stop: { reason: "x", blocker: "y" } } }),
    });
    const report = await replayRun(state, host);
    expect(report.nextDecision).toEqual({ decision: expectedDecision });
  });

  it("re-checks an already-flattened review record too, not only a raw wrapper", async () => {
    // Regression: a successful live run's review evidence has no codingAgent
    // wrapper (classifyAgentResult already flattened it once, correctly) —
    // reclassify's early return left it untouched, so tightening the current
    // schema could never surface as invalid on replay.
    const flattenedReview: EvidenceRecord = {
      ref: "ev-4",
      kind: "review",
      generation: 2,
      resultSchema: "review-verdict-v1",
      contract: { name: "review-verdict-v1", status: "valid", problems: [] },
      payload: { verdict: "approved", summary: "looks right", producer: { stageId: "review", purpose: "review", executorId: "graphloom.agent/run" } },
    };
    const state = recordedState([flattenedReview]);
    const tightened: GraphDefinition = {
      ...definition,
      resultContracts: [
        {
          name: "review-verdict-v1",
          schema: { type: "object", properties: { verdict: { type: "string" }, summary: { type: "string" }, findings: { type: "array" } }, required: ["verdict", "summary", "findings"] },
          evidenceKind: "review",
        },
      ],
    };
    const host = fakeHost({ definition: tightened });
    const report = await replayRun(state, host);
    expect(report.reclassified).toEqual([
      { ref: "ev-4", before: "review", after: "other", contract: { name: "review-verdict-v1", status: "invalid", problems: ["$.findings is required"] } },
    ]);
    expect(report.contracts).toMatchObject({ invalid: 1, valid: 0 });
  });

  it("keeps an already-flattened review record flattened when it still validates, and preserves its producer", async () => {
    const flattenedReview: EvidenceRecord = {
      ref: "ev-5",
      kind: "review",
      generation: 2,
      resultSchema: "review-verdict-v1",
      contract: { name: "review-verdict-v1", status: "valid", problems: [] },
      payload: { verdict: "approved", summary: "looks right", producer: { stageId: "review", purpose: "review", executorId: "graphloom.agent/run" } },
    };
    const state = recordedState([flattenedReview]);
    const host = fakeHost({
      definition,
      evaluateImpl: (input) => {
        const review = input.evidence.find((e) => e.kind === "review");
        const producer = (review?.payload as { producer?: { stageId?: string } } | undefined)?.producer;
        return producer?.stageId === "review" ? { status: "passed", reason: "found by stage" } : { status: "inconclusive", reason: "producer lost" };
      },
    });
    const report = await replayRun(state, host);
    expect(report.reclassified).toEqual([]); // kind and status both unchanged; nothing to report.
    expect(report.requirements).toEqual([{ requirementId: "req", hadReceipt: false, now: { status: "passed", reason: "found by stage" } }]);
  });

  it("reports describe() failure as an error rather than throwing", async () => {
    const state = recordedState([misclassifiedReview]);
    const host: PluginHost = {
      activeVersion: "test@0.2.0",
      generation: 1,
      async describe() {
        return { ok: false, observation: { kind: "child_observation", code: "crash", message: "boom" } };
      },
      async advance() {
        throw new Error("unreachable");
      },
      async close() {},
    };
    const report = await replayRun(state, host);
    expect(report.nextDecision).toMatchObject({ error: expect.stringContaining("boom") });
    expect(report.requirements).toEqual([]);
  });
});
