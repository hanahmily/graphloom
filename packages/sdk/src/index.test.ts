import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  assertGraphAction,
  assertGraphDefinition,
  assertRunView,
  assertValidationInput,
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

  it("rejects an action without its spec object", () => {
    expect(() => assertGraphAction({ type: "stop", reason: "done", blocker: "none" })).toThrow(
      "stop action needs a stop object",
    );
    expect(() => assertGraphAction({ type: "dispatch", job: "run it" })).toThrow("dispatch action needs a job object");
    expect(assertGraphAction({ type: "stop", stop: { reason: "done", blocker: "none" } }).type).toBe("stop");
  });

  it("lets only agent jobs continue a session", () => {
    const job = { stageId: "write", purpose: "work", instruction: "retry", continueFrom: "op-1" } as const;
    expect(dispatch({ ...job, kind: "agent" }, "continue").action).toMatchObject({ job: { continueFrom: "op-1" } });
    expect(() => dispatch({ ...job, kind: "command" }, "continue")).toThrow(
      "only agent jobs carry sessions; a command job cannot continue op-1",
    );
  });
});

describe("assertRunView agentSessions", () => {
  const session = {
    operationId: "op-1",
    stageId: "write",
    attempt: 1,
    generation: 1,
    dispatchKey: "work:acme.agent/code",
    executorId: "acme.agent/code",
    status: "failed" as const,
  };

  it("accepts well-formed sessions, or none", () => {
    expect(assertRunView(emptyView({ agentSessions: [session, { ...session, operationId: "op-2", continuedFrom: "op-1" }] }))
      .agentSessions).toHaveLength(2);
    expect(assertRunView(emptyView()).agentSessions).toBeUndefined();
  });

  it("rejects malformed sessions", () => {
    const bad = (agentSessions: unknown) => () => assertRunView({ ...emptyView(), agentSessions });
    expect(bad({})).toThrow("agentSessions must be an array");
    expect(bad(["op-1"])).toThrow("agentSessions[0] must be an object");
    expect(bad([{ ...session, operationId: "" }])).toThrow("operationId must be a non-empty string");
    expect(bad([{ ...session, attempt: "1" }])).toThrow("attempt must be a finite number");
    expect(bad([{ ...session, status: "running" }])).toThrow("agentSessions[0].status must be one of ok, failed, conflict");
    expect(bad([{ ...session, continuedFrom: 7 }])).toThrow("continuedFrom must be a non-empty string");
  });
});

describe("assertRunView repairAuthority", () => {
  const authority: NonNullable<RunView["repairAuthority"]> = {
    contract: "opaque",
    grants: { sourceRepair: false, validatorSubstitution: true, executorRepair: false },
  };

  it("accepts a well-formed authority, or none", () => {
    expect(assertRunView(emptyView({ repairAuthority: authority })).repairAuthority).toEqual(authority);
    expect(assertRunView(emptyView()).repairAuthority).toBeUndefined();
  });

  it("rejects a malformed authority", () => {
    const bad = (repairAuthority: unknown) => () => assertRunView({ ...emptyView(), repairAuthority });
    expect(bad("opaque")).toThrow("repairAuthority must be an object");
    expect(bad({ ...authority, contract: "patchable" })).toThrow(
      "repairAuthority.contract must be source-repairable or opaque",
    );
    expect(bad({ ...authority, grants: undefined })).toThrow("repairAuthority.grants must be an object");
    expect(bad({ ...authority, grants: { ...authority.grants, executorRepair: "no" } })).toThrow(
      "repairAuthority.grants.executorRepair must be boolean",
    );
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

  it("checks validation history like evidence", () => {
    const record = { ref: "e1", kind: "review", generation: 1 };
    const input = { requirementId: "r", statement: "s", evidence: [record] };
    expect(assertValidationInput({ ...input, history: [record] }).history).toEqual([record]);
    expect(assertValidationInput(input).history).toBeUndefined();
    expect(() => assertValidationInput({ ...input, history: {} })).toThrow(/history must be an array/);
    expect(() => assertValidationInput({ ...input, history: [{ ref: "e0", kind: "review" }] })).toThrow(/generation/);
  });

  it("rejects oversized payloads", () => {
    const huge = `"${"x".repeat(1_000_001)}"`;
    expect(() => parseJsonBounded(huge, 1000)).toThrow(WireValidationError);
  });

  it("checks a declared environment", () => {
    const sha = "a".repeat(64);
    const withEnv = (environment: unknown) => ({ ...helloDefinition, environment });
    expect(
      assertGraphDefinition(
        withEnv({
          checks: [{ id: "go", argv: ["go", "version"] }],
          prepare: [{ id: "generate", argv: ["make", "generate"], timeoutMs: 600_000 }],
          pinnedFiles: [{ path: "CONTRIBUTING.md", sha256: sha }],
        }),
      ).environment?.checks?.[0]?.id,
    ).toBe("go");
    expect(() => assertGraphDefinition(withEnv({ checks: [{ id: "go", argv: [] }] }))).toThrow(/argv/);
    expect(() =>
      assertGraphDefinition(withEnv({ checks: [{ id: "x", argv: ["a"] }], prepare: [{ id: "x", argv: ["b"] }] })),
    ).toThrow(/unique/);
    expect(() => assertGraphDefinition(withEnv({ pinnedFiles: [{ path: "../x", sha256: sha }] }))).toThrow(/inside/);
    expect(() => assertGraphDefinition(withEnv({ pinnedFiles: [{ path: "x", sha256: "abc" }] }))).toThrow(/SHA-256/);
  });
});
