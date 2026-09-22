import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  assertGraphAction,
  assertWireRequest,
  createScriptedGraph,
  dispatch,
  parseJsonBounded,
  stop,
  supervise,
  validate,
  WireValidationError,
  type GraphDefinition,
  type RunView,
} from "./index.js";

const helloDefinition: GraphDefinition = {
  graphId: "hello",
  version: "0.0.1",
  stages: [
    { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
    { id: "review", name: "Review", requirementIds: ["independent-review"] },
  ],
  requirements: [
    {
      id: "greeting-bytes",
      statement: 'GREETING.txt contains exactly "Hello, GraphLoom!\\n" and is the only change.',
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: "independent-review",
      statement: "An independent read-only reviewer approves the current revision.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    {
      requirementId: "greeting-bytes",
      validatorId: "exact-greeting",
      version: "1",
    },
    {
      requirementId: "independent-review",
      validatorId: "reviewer",
      version: "1",
      independence: "separate-reviewer",
    },
  ],
};

function emptyView(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    task: { request: "Create GREETING.txt" },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 64, jobs: 128, decisions: 512, corrections: 8 },
    validatorBindings: helloDefinition.defaultValidators,
    generation: 1,
    stateRevision: 1,
    activeVersion: "hello@0.0.1",
    ...overrides,
  };
}

describe("operations", () => {
  it("builds typed decisions without Accept", () => {
    const d = dispatch(
      {
        stageId: "write",
        kind: "agent",
        purpose: "work",
        instruction: "write greeting",
        resultSchema: "writer-v1",
      },
      "need writer",
    );
    expect(d.action.type).toBe("dispatch");
    expect(d.reason).toBe("need writer");

    const v = validate({ stageId: "write" }, "candidate ready");
    expect(v.action.type).toBe("validate");

    const s = supervise({ reason: "unfamiliar failure" }, "escalate");
    expect(s.action.type).toBe("supervise");

    expect(() =>
      assertGraphAction({ type: "accept", stageId: "write" }),
    ).toThrow(WireValidationError);
  });
});

describe("createScriptedGraph", () => {
  it("returns canned describe and sequenced advances", () => {
    const graph = createScriptedGraph({
      definition: helloDefinition,
      advances: [
        dispatch(
          {
            stageId: "write",
            kind: "agent",
            purpose: "work",
            instruction: "write",
          },
          "start write",
        ),
        (view) =>
          validate(
            { stageId: view.current.stageId },
            "validate after observe",
            JSON.stringify({ seen: view.evidence.length }),
          ),
        stop({ reason: "done scripting", blocker: "test end" }, "stop"),
      ],
    });

    expect(graph.describe().graphId).toBe("hello");
    expect(graph.describe()).not.toBe(helloDefinition);

    const d1 = graph.advance(emptyView());
    expect(d1.action.type).toBe("dispatch");

    const d2 = graph.advance(
      emptyView({ evidence: [{ ref: "e1", kind: "file" }] }),
    );
    expect(d2.action.type).toBe("validate");
    expect(d2.privateState).toBe(JSON.stringify({ seen: 1 }));

    const d3 = graph.advance(emptyView());
    expect(d3.action.type).toBe("stop");

    expect(() => graph.advance(emptyView())).toThrow(/exhausted/);
  });
});

describe("wire validation", () => {
  it("accepts a describe request and rejects bad protocol", () => {
    const ok = assertWireRequest({
      protocolVersion: PROTOCOL_VERSION,
      runId: "r1",
      operationId: "op1",
      generation: 1,
      expectedStateRevision: 0,
      activeVersion: "v1",
      kind: "describe",
    });
    expect(ok.kind).toBe("describe");

    expect(() =>
      assertWireRequest({
        protocolVersion: 99,
        runId: "r1",
        operationId: "op1",
        generation: 1,
        expectedStateRevision: 0,
        activeVersion: "v1",
        kind: "describe",
      }),
    ).toThrow(/protocolVersion/);
  });

  it("rejects oversized payloads", () => {
    const huge = `"${"x".repeat(1_000_001)}"`;
    expect(() => parseJsonBounded(huge, 1000)).toThrow(WireValidationError);
  });
});
