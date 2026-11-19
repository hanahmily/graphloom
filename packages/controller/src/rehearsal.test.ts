// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { EvidenceRecord, GraphDefinition, RehearsalScenario } from "@graphloom/sdk";
import { evaluateRehearsal } from "./rehearsal.js";
import type { DurableRunState } from "./state.js";
import type { IntakePin } from "./intake.js";

const definition: GraphDefinition = {
  graphId: "test",
  version: "0.0.0",
  stages: [{ id: "review", name: "Review", requirementIds: ["req"] }],
  requirements: [{ id: "req", statement: "reviewed", evidenceSchema: "review-verdict-v1" }],
  defaultValidators: [{ requirementId: "req", validatorId: "v", version: "1" }],
};

const intake: IntakePin = {
  taskPath: "/t/task.yaml",
  taskDir: "/t",
  task: { graph: "test", repo: "./repo", request: "test" },
  repoPath: "/t/repo",
  pinnedHead: "0".repeat(40),
  bundle: {
    graphId: "test",
    version: "0.0.0",
    bundlePath: "/t/bundle",
    sdkProtocol: 1,
    digests: {},
    manifestRaw: "{}",
    manifestDigest: "d",
    entryDigest: "d",
  },
  grants: { sourceRepair: false, validatorSubstitution: false },
  budgets: { agentInvocations: 24, jobs: 32, decisions: 64, corrections: 4, recoveryReserve: 4 },
};

function baseState(overrides: Partial<DurableRunState> = {}): DurableRunState {
  return {
    runId: "r1",
    status: "running",
    generation: 1,
    stateRevision: 0,
    activeVersion: "test@0.0.0",
    mode: "normal",
    current: { stageId: "review", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    definition,
    validatorBindings: definition.defaultValidators,
    budgets: { ...intake.budgets },
    intake,
    worktreePath: "/t/worktree",
    worktreeBranch: "graphloom/r1",
    artifactDir: "/t/state/r1/artifacts",
    stateDir: "/t/state/r1",
    sourceDirtyBefore: [],
    evidenceSeq: 0,
    receiptSeq: 0,
    versionHistory: [{ activeVersion: "test@0.0.0", generation: 1, reason: "intake", at: "2026-01-01T00:00:00.000Z" }],
    ...overrides,
  };
}

function reviewEvidence(status: "valid" | "invalid" | "repaired", problems: string[] = []): EvidenceRecord {
  return {
    ref: "ev-1",
    kind: status === "invalid" ? "other" : "review",
    generation: 1,
    resultSchema: "review-verdict-v1",
    contract: { name: "review-verdict-v1", status, problems, ...(status === "repaired" ? { repairs: ["P1 reconciled"] } : {}) },
    payload: { verdict: "approved", summary: "ok", producer: { stageId: "review", purpose: "review", executorId: "graphloom.agent/run" } },
  };
}

const scenario: RehearsalScenario = {
  results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "ok" } }] },
  expect: { status: "succeeded", receipts: ["review"] },
};

describe("evaluateRehearsal", () => {
  it("is ready when a contract-valid result minted its receipt and the scenario's expectation matches", () => {
    const state = baseState({
      status: "succeeded",
      evidence: [reviewEvidence("valid")],
      receipts: [{ id: "rcpt-1", stageId: "review", requirementId: "req", validatorBinding: definition.defaultValidators[0]!, candidateFingerprint: "f", evidenceRefs: ["ev-1"], valid: true }],
    });
    // B2 is this test's own concern elsewhere ("merges a CLI-supplied B2…"
    // below); supplied passed here so an unrelated default (unverified, since
    // no capability probe was given) does not mask what this test checks.
    const report = evaluateRehearsal(state, scenario, { B2: { status: "passed", notes: [] } });
    expect(report.verdict).toBe("ready");
    expect(report.boundaries.B4.status).toBe("passed");
    expect(report.boundaries.B5.status).toBe("passed");
    expect(report.convergence.met).toBe(true);
  });

  it("is not-ready on an invalid contract result, naming B4 and the problems", () => {
    const state = baseState({ status: "stopped", evidence: [reviewEvidence("invalid", ["$.summary is required"])] });
    const report = evaluateRehearsal(state, scenario);
    expect(report.verdict).toBe("not-ready");
    expect(report.blocker?.boundary).toBe("B4");
    expect(report.boundaries.B4.notes[0]).toContain("$.summary is required");
  });

  it("reports B5 when a contract-valid result never minted a receipt", () => {
    const state = baseState({ status: "stopped", evidence: [reviewEvidence("valid")], receipts: [] });
    const report = evaluateRehearsal(state, scenario);
    expect(report.verdict).toBe("not-ready");
    expect(report.blocker?.boundary).toBe("B5");
  });

  it("is inconclusive when a declared contract was never exercised", () => {
    const state = baseState({ status: "succeeded" });
    const noReceiptExpectation: RehearsalScenario = { results: scenario.results, expect: { status: "succeeded" } };
    const report = evaluateRehearsal(state, noReceiptExpectation);
    expect(report.boundaries.B5.status).toBe("unexercised");
    expect(report.verdict).toBe("inconclusive");
  });

  it("is inconclusive, not ready, when a boundary is unverified even though the scenario otherwise converges", () => {
    // Regression: an unreadable/missing configured Claude or Codex binary
    // (B2's capability probe) left B2 "unverified," but nothing in the
    // verdict logic distinguished that from "passed" — a fully exercised
    // scenario could still become "ready" and get cached, with the live run
    // later failing on exactly the capability the gate never checked.
    const state = baseState({
      status: "succeeded",
      evidence: [reviewEvidence("valid")],
      receipts: [{ id: "rcpt-1", stageId: "review", requirementId: "req", validatorBinding: definition.defaultValidators[0]!, candidateFingerprint: "f", evidenceRefs: ["ev-1"], valid: true }],
    });
    const report = evaluateRehearsal(state, scenario); // B2 defaults to unverified: no capability probe supplied.
    expect(report.boundaries.B2.status).toBe("unverified");
    expect(report.verdict).toBe("inconclusive");
  });

  it("accepts a repaired contract result as valid, listing the repair in the notes", () => {
    const state = baseState({
      status: "succeeded",
      evidence: [reviewEvidence("repaired")],
      receipts: [{ id: "rcpt-1", stageId: "review", requirementId: "req", validatorBinding: definition.defaultValidators[0]!, candidateFingerprint: "f", evidenceRefs: ["ev-1"], valid: true }],
    });
    const report = evaluateRehearsal(state, scenario);
    expect(report.boundaries.B4.status).toBe("passed");
    expect(report.boundaries.B4.notes[0]).toContain("repaired");
  });

  it("fails B1 when a dispatch was refused for naming an undeclared contract", () => {
    const state = baseState({ status: "stopped", stopReason: "contract rejected", blocker: "job names x, which the plugin did not declare" });
    const report = evaluateRehearsal(state, scenario);
    expect(report.boundaries.B1.status).toBe("failed");
    expect(report.verdict).toBe("not-ready");
  });

  it("fails B10 when a stage exceeded the scenario's dispatch ceiling", () => {
    const state = baseState({
      status: "stopped",
      dispatchesSinceReceipt: { review: { agent: 5, total: 5, since: "2026-01-01T00:00:00.000Z" } },
    });
    const bounded: RehearsalScenario = { ...scenario, expect: { ...scenario.expect, maxAgentDispatches: 4 } };
    const report = evaluateRehearsal(state, bounded);
    expect(report.boundaries.B10.status).toBe("failed");
    expect(report.boundaries.B10.notes[0]).toContain("exceeds the scenario's ceiling");
  });

  it("passes B7-9 when recovery was entered only for a trigger the scenario named", () => {
    const state = baseState({
      status: "stopped",
      recoveryTrigger: { code: "executor_failed", message: "scripted failure" },
    });
    const scripted: RehearsalScenario = { ...scenario, expect: { ...scenario.expect, status: "stopped", recovery: ["executor_failed"] } };
    const report = evaluateRehearsal(state, scripted);
    expect(report.boundaries.B7.status).toBe("passed");
  });

  it("fails B7-9 when recovery was entered for a trigger the scenario did not name", () => {
    const state = baseState({
      status: "stopped",
      recoveryTrigger: { code: "stalled", message: "unexpected stall" },
    });
    const report = evaluateRehearsal(state, scenario);
    expect(report.boundaries.B7.status).toBe("failed");
    expect(report.verdict).toBe("not-ready");
  });

  it("merges a CLI-supplied B2 capability-probe result instead of recomputing it", () => {
    const state = baseState({ status: "succeeded" });
    const report = evaluateRehearsal(state, scenario, { B2: { status: "failed", notes: ["claude --help is missing --json-schema"] } });
    expect(report.boundaries.B2.status).toBe("failed");
    expect(report.verdict).toBe("not-ready");
    expect(report.blocker?.boundary).toBe("B2");
  });

  it("checks expect.path against the live path's node ids, exactly (docs/design-graph-topology.md §9)", () => {
    const twoNodes: GraphDefinition = {
      ...definition,
      stages: [
        { id: "fix", name: "Fix", requirementIds: [] },
        { id: "review", name: "Review", requirementIds: ["req"] },
      ],
      edges: [
        { from: "fix", to: "review" },
        { from: "review", to: "fix" },
      ],
    };
    const visits = [
      { seq: 1, stageId: "fix", attempt: 2, entered: "reenter" as const, generation: 2, operation: "reenter" },
      { seq: 2, stageId: "review", attempt: 2, entered: "edge" as const, from: 1, generation: 2, operation: "dispatch" },
    ];
    const state = baseState({ status: "succeeded", definition: twoNodes, path: [1, 2], visits });
    const at = (path: string[]) => evaluateRehearsal(state, { ...scenario, expect: { status: "succeeded", path } }, { B2: { status: "passed", notes: [] } }).convergence;
    expect(at(["fix", "review"])).toMatchObject({ met: true, actual: { path: ["fix", "review"] } });
    expect(at(["fix"]).met).toBe(false);
    expect(at(["review", "fix"]).met).toBe(false);
    // Without expect.path, the path is reported and not judged.
    expect(evaluateRehearsal(state, scenario, {}).convergence.actual.path).toEqual(["fix", "review"]);
  });

  describe("B5 for a run that waits for an operator approval (core design §17)", () => {
    // Check ⇄ build with a supervisor-only arbitrate, whose declared approval the run waits for inside the side visit.
    const waitingGraph: GraphDefinition = {
      ...definition,
      stages: [
        { id: "build", name: "Build", requirementIds: [] },
        { id: "review", name: "Review", requirementIds: ["req"] },
        { id: "arbitrate", name: "Arbitrate", requirementIds: ["ruled"], entry: "supervisor", maxVisits: 2 },
      ],
      requirements: [...definition.requirements, { id: "ruled", statement: "ruled", evidenceSchema: "ruling-v1" }],
      defaultValidators: [...definition.defaultValidators, { requirementId: "ruled", validatorId: "ruled", version: "1" }],
      edges: [
        { from: "build", to: "review" },
        { from: "review", to: "build" },
        { from: "arbitrate", to: "review" },
      ],
      approvals: [{ id: "ruling", stageId: "arbitrate", inputs: [{ name: "ruling" }] }],
    };
    const visits = [
      { seq: 1, stageId: "build", attempt: 1, entered: "start" as const, generation: 1, operation: "intake" },
      { seq: 2, stageId: "review", attempt: 1, entered: "edge" as const, from: 1, generation: 1, operation: "dispatch" },
      { seq: 3, stageId: "arbitrate", attempt: 1, entered: "enter" as const, from: 2, generation: 1, operation: "enter" },
    ];
    const rulingEvidence: EvidenceRecord = {
      ref: "ev-2",
      kind: "review",
      generation: 1,
      resultSchema: "ruling-v1",
      contract: { name: "ruling-v1", status: "valid", problems: [] },
      payload: { ruling: "undecidable", producer: { stageId: "arbitrate", purpose: "review", executorId: "graphloom.agent/run" } },
    };
    const waiting = (overrides: Partial<DurableRunState> = {}, omit: Array<keyof DurableRunState> = []) => {
      const state = baseState({
        status: "stopped",
        definition: waitingGraph,
        validatorBindings: waitingGraph.defaultValidators,
        current: { stageId: "arbitrate", attempt: 1 },
        path: [1, 2],
        visits,
        sideVisit: 3,
        evidence: [reviewEvidence("valid"), rulingEvidence],
        receipts: [],
        stopReason: "ruling needs the operator",
        blocker: "The arbiter could not decide.\nRule on it: graphloom resume r1 --approve ruling --input ruling=…",
        stopClass: { by: "graph", retryable: false, reason: "ruling needs the operator" },
        recoveryTrigger: { code: "supervise", message: "disputed" },
        ...overrides,
      });
      for (const key of omit) delete state[key];
      return state;
    };
    const expected: RehearsalScenario = { results: scenario.results, expect: { status: "stopped", stopReason: "ruling needs the operator", path: ["build", "review"], recovery: ["supervise"] } };
    const passedB2 = { B2: { status: "passed" as const, notes: [] } };

    it("counts the waiting node's results, and those of the node its side visit was entered from, as pending, so the scenario is ready", () => {
      const report = evaluateRehearsal(waiting(), expected, passedB2);
      expect(report.boundaries.B5).toEqual({
        status: "passed",
        notes: [
          "stage review: a contract-valid result awaits the operator's approval ruling (the run waits in arbitrate)",
          "stage arbitrate: a contract-valid result awaits the operator's approval ruling (the run waits in arbitrate)",
        ],
      });
      expect(report.convergence.met).toBe(true);
      expect(report.verdict).toBe("ready");
    });

    it("still fails B5 for a result of a node the wait does not hold back", () => {
      const built: EvidenceRecord = { ...rulingEvidence, ref: "ev-3", resultSchema: "review-verdict-v1", contract: { name: "review-verdict-v1", status: "valid", problems: [] }, payload: { verdict: "approved", summary: "ok", producer: { stageId: "build", purpose: "work", executorId: "graphloom.agent/run" } } };
      const report = evaluateRehearsal(waiting({ evidence: [reviewEvidence("valid"), rulingEvidence, built] }), expected, passedB2);
      expect(report.boundaries.B5).toMatchObject({ status: "failed", notes: ["stage build: a contract-valid result never minted a receipt"] });
      expect(report.verdict).toBe("not-ready");
    });

    it("is not a wait when the stop is retryable, names no declared approval, names one for another node, or one that is unavailable", () => {
      const failedB5 = (state: DurableRunState) => evaluateRehearsal(state, expected, passedB2).boundaries.B5.status;
      expect(failedB5(waiting())).toBe("passed");
      expect(failedB5(waiting({ stopClass: { by: "graph", retryable: true, reason: "ruling needs the operator" } }))).toBe("failed");
      expect(failedB5(waiting({}, ["stopClass"]))).toBe("failed");
      // A classification of an earlier stop reason does not classify this one.
      expect(failedB5(waiting({ stopClass: { by: "graph", retryable: false, reason: "an earlier stop" } }))).toBe("failed");
      expect(failedB5(waiting({ stopReason: "stuck", blocker: "the arbiter could not decide; graphloom resume r1 --approve rulings" }))).toBe("failed");
      expect(failedB5(waiting({ definition: { ...waitingGraph, approvals: [{ id: "ruling", stageId: "review" }] } }))).toBe("failed");
      expect(failedB5(waiting({ definition: { ...waitingGraph, approvals: [{ id: "ruling", stageId: "arbitrate", unavailable: "not in this version" }] } }))).toBe("failed");
      expect(failedB5(waiting({ definition: { ...waitingGraph, approvals: [] } }))).toBe("failed");
    });

    it("holds back only the waiting node when it waits on the live path, not in a side visit", () => {
      const onPath = waiting({ current: { stageId: "review", attempt: 1 }, definition: { ...waitingGraph, approvals: [{ id: "ruling", stageId: "review" }] } }, ["sideVisit"]);
      const B5 = evaluateRehearsal(onPath, expected, passedB2).boundaries.B5;
      expect(B5).toMatchObject({ status: "failed", notes: ["stage arbitrate: a contract-valid result never minted a receipt"] });
    });
  });

  it("always lists what no rehearsal checks, alongside what the caller substituted", () => {
    const state = baseState({ status: "succeeded" });
    const report = evaluateRehearsal(state, scenario, {}, { substituted: ["pi: rehearsal stand-in"] });
    expect(report.substituted).toEqual(["pi: rehearsal stand-in"]);
    expect(report.notCovered.join(" ")).toContain("model behaviour");
  });
});
