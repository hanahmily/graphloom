import { describe, expect, it } from "vitest";
import type { GraphDecision, RunView } from "@graphloom/sdk";
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

/** The controller carries a decision's private state into the next view only when there is one. */
function carried(d: GraphDecision): Partial<RunView> {
  return d.privateState !== undefined ? { privateState: d.privateState } : {};
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

    view = baseView(carried(d));
    d = g.advance(view);
    expect(d.action.type).toBe("observe");

    view = baseView({
      ...carried(d),
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
      ...carried(d),
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
      ...carried(d),
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

  it("supervises when correction budget is exhausted", () => {
    const view = baseView({
      budgets: { agentInvocations: 64, jobs: 128, decisions: 512, corrections: 0 },
      privateState: JSON.stringify({
        writeCorrections: 0,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: false,
        reviewEvidenceFromIndex: 0,
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

  it("ignores stale request_changes after Write reentry", () => {
    const staleReview = {
      ref: "rev-old",
      kind: "review" as const,
      payload: { verdict: "request_changes" as const, summary: "old" },
    };
    const evidence = [staleReview];
    const view = baseView({
      current: { stageId: "review", attempt: 2 },
      privateState: JSON.stringify({
        writeCorrections: 0,
        writerDispatched: true,
        observedWrite: true,
        reviewerDispatched: false,
        reviewEvidenceFromIndex: evidence.length,
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
          candidateFingerprint: "fp2",
          evidenceRefs: ["file-2"],
          valid: true,
        },
      ],
      evidence,
    });
    const d = advanceHello(view);
    expect(d.action.type).toBe("dispatch");
    if (d.action.type !== "dispatch") throw new Error("expected dispatch");
    expect(d.action.job.purpose).toBe("review");
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

  it("retries a reviewer that failed before the latest resume, and supervises one that failed since", () => {
    const failed = (generation: number) => ({
      ref: `fail-g${generation}`,
      kind: "other" as const,
      generation,
      payload: { executorFailure: { operationId: "op-r", stageId: "review", attempt: 1, executor: null, status: "failed", summary: "agent finished without a result" } },
    });
    const reviewing = (generation: number, resumedAt?: number) =>
      baseView({
        current: { stageId: "review", attempt: 1 },
        generation,
        privateState: JSON.stringify({ writeCorrections: 0, writerDispatched: true, observedWrite: true, reviewerDispatched: true, reviewEvidenceFromIndex: 0 }),
        receipts: [
          {
            id: "r-write",
            stageId: "write",
            requirementId: "greeting-bytes",
            validatorBinding: { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
            candidateFingerprint: "fp1",
            evidenceRefs: [],
            valid: true,
          },
        ],
        evidence: [failed(2)],
        ...(resumedAt !== undefined ? { resume: { generation: resumedAt, at: "t", pluginUpdated: false, previousStopReason: "executor failed", previousStopRetryable: true } } : {}),
      });
    // Not resumed since the failure: the supervisor gets it.
    expect(advanceHello(reviewing(2)).action.type).toBe("supervise");
    // Resumed after it: the reviewer runs again.
    const retried = advanceHello(reviewing(3, 3)).action;
    expect(retried).toMatchObject({ type: "dispatch", job: { stageId: "review", purpose: "review", readOnly: true } });
    // Failed again since the resume: the supervisor gets it, so a failing reviewer cannot loop.
    const again = reviewing(3, 3);
    expect(advanceHello({ ...again, evidence: [failed(2), failed(3)] }).action.type).toBe("supervise");
  });

  it("marks the stops no retry can clear as final", () => {
    const incompatible = advanceHello(baseView({ task: { request: "Write a poem." } })).action;
    expect(incompatible).toMatchObject({ type: "stop", stop: { reason: "incompatible task", retryable: false } });
    const spent = advanceHello(baseView({ budgets: { agentInvocations: 0, jobs: 1, decisions: 1, corrections: 0 } })).action;
    expect(spent).toMatchObject({ type: "stop", stop: { reason: "budgets exhausted", retryable: false } });
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

  it("returns inconclusive for malformed workspace payloads", () => {
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
          payload: { changedPaths: null },
        },
      ],
    });
    expect(result.status).toBe("inconclusive");
  });

  it("evaluates the newest file evidence", () => {
    const result = exactGreetingValidator.evaluate({
      requirementId: "greeting-bytes",
      statement: "x",
      evidence: [
        {
          ref: "old",
          kind: "file",
          payload: { path: GREETING_PATH, bytes: "stale" },
        },
        {
          ref: "new",
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
