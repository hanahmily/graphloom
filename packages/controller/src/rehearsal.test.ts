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
    const report = evaluateRehearsal(state, scenario);
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

  it("always lists what no rehearsal checks, alongside what the caller substituted", () => {
    const state = baseState({ status: "succeeded" });
    const report = evaluateRehearsal(state, scenario, {}, { substituted: ["pi: rehearsal stand-in"] });
    expect(report.substituted).toEqual(["pi: rehearsal stand-in"]);
    expect(report.notCovered.join(" ")).toContain("model behaviour");
  });
});
