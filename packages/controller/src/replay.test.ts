// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { EvidenceRecord, GraphDefinition, GraphDecision, ValidationInput, ValidationResult } from "@graphloom/sdk";
import type { CallContext, HostResult, PluginHost } from "@graphloom/plugin-host";
import { replayAdmission, replayRun } from "./replay.js";
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

  it("gives each validator the recorded run's receipts and admitted bindings (§5.4)", async () => {
    const recorded: DurableRunState["receipts"][number] = {
      id: "rcpt-1",
      stageId: "review",
      requirementId: "req",
      validatorBinding: { requirementId: "req", validatorId: "v", version: "1" },
      candidateFingerprint: "fp",
      evidenceRefs: ["ev-1"],
      valid: false,
    };
    const seen: ValidationInput[] = [];
    const host = fakeHost({ definition, evaluateImpl: (input) => (seen.push(input), { status: "passed", reason: "ok" }) });
    await replayRun(recordedState([misclassifiedReview], [recorded]), host);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ receipts: [recorded], validatorBindings: definition.defaultValidators });
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

describe("replay over the graph (docs/design-graph-topology.md §7.2, §12 item 10)", () => {
  /** Fix ⇄ Review with a supervisor-only Arbitrate that leaves to either. */
  const topology: GraphDefinition = {
    graphId: "test",
    version: "0.2.0",
    stages: [
      { id: "fix", name: "Fix", requirementIds: ["req-fix"] },
      { id: "review", name: "Review", requirementIds: ["req-review"] },
      { id: "arb", name: "Arbitrate", requirementIds: ["req-arb"], entry: "supervisor", maxVisits: 2 },
    ],
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arb", to: "fix" },
      { from: "arb", to: "review" },
    ],
    start: "fix",
    terminal: ["review"],
    requirements: ["fix", "review", "arb"].map((id) => ({ id: `req-${id}`, statement: `${id} done`, evidenceSchema: "node-v1" })),
    defaultValidators: ["fix", "review", "arb"].map((id) => ({ requirementId: `req-${id}`, validatorId: "v", version: "1" })),
  };
  /** The same two graph nodes as a chain (no edges). */
  const chain: GraphDefinition = {
    graphId: "test",
    version: "0.2.0",
    stages: topology.stages.slice(0, 2).map(({ id, name, requirementIds }) => ({ id, name, requirementIds })),
    requirements: topology.requirements.slice(0, 2),
    defaultValidators: topology.defaultValidators.slice(0, 2),
  };

  const accepted = (stageId: string, n: number): DurableRunState["receipts"][number] => ({
    id: `rcpt-${n}`,
    stageId,
    requirementId: `req-${stageId}`,
    validatorBinding: { requirementId: `req-${stageId}`, validatorId: "v", version: "1" },
    candidateFingerprint: "fp",
    evidenceRefs: [],
    valid: true,
    acceptedIdentity: {},
  });

  /** A recorded run on `pinned` whose live path is Fix → Review (both accepted), with Arbitrate's side visit open when `side`. */
  function onPath(pinned: GraphDefinition, side = false): DurableRunState {
    const visits: NonNullable<DurableRunState["visits"]> = [
      { seq: 1, stageId: "fix", attempt: 1, entered: "start", generation: 1, operation: "intake" },
      { seq: 2, stageId: "review", attempt: 1, entered: "edge", from: 1, generation: 1, operation: "dispatch" },
      ...(side ? [{ seq: 3, stageId: "arb", attempt: 1, entered: "enter" as const, from: 2, generation: 1, operation: "enter" }] : []),
    ];
    return {
      ...recordedState([], [accepted("fix", 1), accepted("review", 2)]),
      definition: pinned,
      current: side ? { stageId: "arb", attempt: 1 } : { stageId: "review", attempt: 1 },
      path: [1, 2],
      visits,
      ...(side ? { sideVisit: 3, openAttempt: { arb: true } } : {}),
    };
  }

  const act = (action: GraphDecision["action"]): GraphDecision => ({ reason: "next", action });
  const dispatchFor = (stageId: string): GraphDecision["action"] => ({ type: "dispatch", job: { stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: "work" } });

  it("refuses a run whose pinned topology differs from the current describe(), naming the change", async () => {
    const added: GraphDefinition = {
      ...topology,
      stages: [...topology.stages, { id: "fix2", name: "Fix 2", requirementIds: [] }],
      edges: [...topology.edges!, { from: "fix", to: "fix2" }],
    };
    let asked = false;
    const report = await replayRun(onPath(topology), fakeHost({ definition: added, advanceImpl: () => ((asked = true), act({ type: "observe", observe: {} })) }));
    expect(report.nextDecision).toEqual({ error: "the run's pinned topology differs from the current plugin's describe(): node fix2 added, edge fix → fix2 added" });
    expect(report.admission).toBeUndefined();
    expect(asked).toBe(false);
    const chained = await replayRun(onPath(chain), fakeHost({ definition: { ...chain, edges: [{ from: "fix", to: "review" }] } }));
    expect(chained.nextDecision).toMatchObject({ error: expect.stringContaining("edges declared (the run walks an implicit chain)") });
  });

  it("judges a next decision from the recorded live path: a path node, a reentry along an edge, a complete stop", async () => {
    const report = await replayRun(onPath(topology), fakeHost({ definition: topology, advanceImpl: () => act(dispatchFor("fix")) }));
    expect(report.admission).toEqual({ admissible: true, move: "path node", detail: "fix is on the live path" });
    expect(replayAdmission(onPath(topology), { type: "reenter", reenter: { stageId: "fix", reason: "again" } })).toMatchObject({
      admissible: true,
      move: "reentry",
      detail: expect.stringContaining("fix from review; one correction"),
    });
    expect(replayAdmission(onPath(topology), { type: "stop", stop: { reason: "complete", blocker: "none" } })).toEqual({ admissible: true, move: "stop", detail: "complete on the live path fix → review" });
    expect(replayAdmission(onPath(topology), { type: "enter", enter: { stageId: "arb", reason: "r" } })).toMatchObject({ admissible: false, precondition: "enter is the supervisor's" });
  });

  it("judges a forward move, and refuses a node no forward move reaches", () => {
    // Only Fix is on the path: Review is a forward move along fix → review.
    const atFix: DurableRunState = { ...onPath(topology), path: [1], visits: onPath(topology).visits!.slice(0, 1), current: { stageId: "fix", attempt: 1 } };
    expect(replayAdmission(atFix, dispatchFor("review"))).toEqual({ admissible: true, move: "forward move", detail: "from fix to review" });
    // A chain of three whose path holds only its first: the third is ahead of an unaccepted second.
    const three: GraphDefinition = { ...chain, stages: [...chain.stages, { id: "ship", name: "Ship", requirementIds: [] }] };
    const early: DurableRunState = { ...atFix, definition: three, receipts: [accepted("fix", 1)] };
    expect(replayAdmission(early, dispatchFor("ship"))).toMatchObject({ admissible: false, precondition: "undeclared edge", detail: expect.stringContaining("tail fix, node ship") });
    expect(replayAdmission({ ...early, receipts: [accepted("fix", 1), accepted("review", 2)] }, dispatchFor("ship"))).toEqual({
      admissible: true,
      move: "forward move",
      detail: "from fix to review → ship, carrying review",
    });
  });

  it("judges an open side visit: the node's own work is admitted; another node, a reentry and a complete stop are not", () => {
    const open = onPath(topology, true);
    expect(replayAdmission(open, dispatchFor("arb"))).toEqual({ admissible: true, move: "side visit", detail: "an action for the open side visit of arb" });
    expect(replayAdmission(open, dispatchFor("fix"))).toMatchObject({ admissible: false, precondition: "supervisor-only node" });
    expect(replayAdmission(open, { type: "reenter", reenter: { stageId: "fix", reason: "back" } })).toMatchObject({ admissible: false, precondition: "supervisor-only node" });
    expect(replayAdmission(open, { type: "stop", stop: { reason: "complete", blocker: "none" } })).toMatchObject({ admissible: false, precondition: "supervisor-only node" });
    expect(replayAdmission(open, { type: "stop", stop: { reason: "waiting for a ruling", blocker: "approval" } })).toEqual({ admissible: true, move: "stop", detail: "stop waiting for a ruling" });
  });
});
