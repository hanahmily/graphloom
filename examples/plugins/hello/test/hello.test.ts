import { describe, expect, it } from "vitest";
import type { RunView } from "@graphloom/sdk";
import {
  GREETING_BYTES,
  GREETING_PATH,
  advanceHello,
  createGraph,
  exactGreetingValidator,
  independentReviewValidator,
} from "../src/index.js";

const request =
  'Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by one newline.';

function baseView(overrides: Partial<RunView> = {}): RunView {
  const graph = createGraph().describe();
  return {
    runId: "run-hello",
    task: { request },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 64, jobs: 128, decisions: 512, corrections: 8 },
    validatorBindings: graph.defaultValidators,
    generation: 1,
    stateRevision: 1,
    activeVersion: "hello@0.1.0",
    ...overrides,
  };
}

describe("createGraph.describe", () => {
  it("declares Write and Review with readable requirements", () => {
    const def = createGraph().describe();
    expect(def.graphId).toBe("hello");
    expect(def.stages.map((s) => s.id)).toEqual(["write", "review"]);
    expect(def.requirements.every((r) => r.statement.length > 0)).toBe(true);
    expect(def.defaultValidators.some((v) => v.independence === "separate-reviewer")).toBe(
      true,
    );
  });
});

describe("advanceHello happy path", () => {
  it("dispatches writer, observes, validates Write, then reviews", () => {
    const g = createGraph();
    let view = baseView();
    let d = g.advance(view);
    expect(d.action.type).toBe("dispatch");
    if (d.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(d.action.job.writeScope).toEqual([GREETING_PATH]);
    expect(d.action.job.readOnly).toBeUndefined();

    view = baseView({ privateState: d.privateState });
    d = g.advance(view);
    expect(d.action.type).toBe("observe");

    view = baseView({
      privateState: d.privateState,
      evidence: [
        {
          ref: "file-1",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: GREETING_BYTES },
        },
        {
          ref: "ws-1",
          kind: "workspace",
          payload: { changedPaths: [GREETING_PATH] },
        },
      ],
    });
    d = g.advance(view);
    expect(d.action.type).toBe("validate");
    if (d.action.type !== "validate") throw new Error("expected validate");
    expect(d.action.validate.stageId).toBe("write");

    view = baseView({
      privateState: d.privateState,
      current: { stageId: "review", attempt: 1 },
      receipts: [
        {
          id: "r-write",
          stageId: "write",
          requirementId: "greeting-bytes",
          validatorBinding: {
            requirementId: "greeting-bytes",
            validatorId: "exact-greeting",
            version: "1",
          },
          candidateFingerprint: "fp1",
          evidenceRefs: ["file-1", "ws-1"],
          valid: true,
        },
      ],
      evidence: view.evidence,
    });
    d = g.advance(view);
    expect(d.action.type).toBe("dispatch");
    if (d.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(d.action.job.purpose).toBe("review");
    expect(d.action.job.readOnly).toBe(true);

    view = baseView({
      privateState: d.privateState,
      current: { stageId: "review", attempt: 1 },
      receipts: view.receipts,
      evidence: [
        ...view.evidence,
        {
          ref: "rev-1",
          kind: "review",
          payload: { verdict: "approved", summary: "looks good" },
        },
      ],
    });
    d = g.advance(view);
    expect(d.action.type).toBe("validate");
    if (d.action.type !== "validate") throw new Error("expected validate");
    expect(d.action.validate.stageId).toBe("review");
  });
});

describe("known corrections", () => {
  it("dispatches a Write correction for missing newline", () => {
    const view = baseView({
      privateState: JSON.stringify({
        writeCorrections: 0,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: false,
      }),
      evidence: [
        {
          ref: "file-1",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: "Hello, GraphLoom!" },
        },
        {
          ref: "ws-1",
          kind: "workspace",
          payload: { changedPaths: [GREETING_PATH] },
        },
      ],
    });
    const d = advanceHello(view);
    expect(d.action.type).toBe("dispatch");
    if (d.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(d.action.job.purpose).toBe("work");
    expect(d.privateState).toContain('"writeCorrections":1');
  });

  it("dispatches a Write correction for unrelated path changes", () => {
    const view = baseView({
      privateState: JSON.stringify({
        writeCorrections: 0,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: false,
      }),
      evidence: [
        {
          ref: "file-1",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: GREETING_BYTES },
        },
        {
          ref: "ws-1",
          kind: "workspace",
          payload: { changedPaths: [GREETING_PATH, "OTHER.txt"] },
        },
      ],
    });
    const d = advanceHello(view);
    expect(d.action.type).toBe("dispatch");
  });

  it("reenters Write when review requests changes", () => {
    const view = baseView({
      current: { stageId: "review", attempt: 1 },
      privateState: JSON.stringify({
        writeCorrections: 0,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: true,
      }),
      receipts: [
        {
          id: "r-write",
          stageId: "write",
          requirementId: "greeting-bytes",
          validatorBinding: {
            requirementId: "greeting-bytes",
            validatorId: "exact-greeting",
            version: "1",
          },
          candidateFingerprint: "fp1",
          evidenceRefs: ["file-1"],
          valid: true,
        },
      ],
      evidence: [
        {
          ref: "rev-1",
          kind: "review",
          payload: { verdict: "request_changes", summary: "tone" },
        },
      ],
    });
    const d = advanceHello(view);
    expect(d.action.type).toBe("reenter");
    if (d.action.type !== "reenter") throw new Error("expected reenter");
    expect(d.action.reenter.stageId).toBe("write");
  });

  it("supervises after repeated write corrections", () => {
    const view = baseView({
      privateState: JSON.stringify({
        writeCorrections: 2,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: false,
      }),
      evidence: [
        {
          ref: "file-1",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: "wrong" },
        },
        {
          ref: "ws-1",
          kind: "workspace",
          payload: { changedPaths: [GREETING_PATH] },
        },
      ],
    });
    const d = advanceHello(view);
    expect(d.action.type).toBe("supervise");
  });

  it("supervises unfamiliar review-stage gaps", () => {
    const view = baseView({
      current: { stageId: "review", attempt: 1 },
      privateState: JSON.stringify({
        writeCorrections: 0,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: true,
      }),
      receipts: [
        {
          id: "r-write",
          stageId: "write",
          requirementId: "greeting-bytes",
          validatorBinding: {
            requirementId: "greeting-bytes",
            validatorId: "exact-greeting",
            version: "1",
          },
          candidateFingerprint: "fp1",
          evidenceRefs: [],
          valid: true,
        },
      ],
      evidence: [],
    });
    const d = advanceHello(view);
    expect(d.action.type).toBe("supervise");
  });
});

describe("validators", () => {
  it("passes exact bytes and sole path", () => {
    const result = exactGreetingValidator.evaluate({
      requirementId: "greeting-bytes",
      statement: "x",
      evidence: [
        {
          ref: "f",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: GREETING_BYTES },
        },
        {
          ref: "w",
          kind: "workspace",
          payload: { changedPaths: [GREETING_PATH] },
        },
      ],
    });
    expect(result.status).toBe("passed");
  });

  it("fails missing newline", () => {
    const result = exactGreetingValidator.evaluate({
      requirementId: "greeting-bytes",
      statement: "x",
      evidence: [
        {
          ref: "f",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: "Hello, GraphLoom!" },
        },
        {
          ref: "w",
          kind: "workspace",
          payload: { changedPaths: [GREETING_PATH] },
        },
      ],
    });
    expect(result.status).toBe("failed");
  });

  it("passes approved review and fails request_changes", () => {
    expect(
      independentReviewValidator.evaluate({
        requirementId: "independent-review",
        statement: "x",
        evidence: [
          { ref: "r", kind: "review", payload: { verdict: "approved" } },
        ],
      }).status,
    ).toBe("passed");
    expect(
      independentReviewValidator.evaluate({
        requirementId: "independent-review",
        statement: "x",
        evidence: [
          { ref: "r", kind: "review", payload: { verdict: "request_changes" } },
        ],
      }).status,
    ).toBe("failed");
  });
});
