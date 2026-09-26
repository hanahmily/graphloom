import { describe, expect, it } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import { continuationRefusal, continuedOperations, dispatchKey, earlierToolCallRefusal } from "./agent-sessions.js";
import type { AgentSessionRecord, ChildOperationRecord, DurableRunState } from "./state.js";

const job = (over: Partial<JobSpec> = {}): JobSpec => ({
  stageId: "write",
  kind: "agent",
  purpose: "work",
  instruction: "x",
  executor: { id: "acme.agent/code" },
  ...over,
});

const session = (over: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  operationId: "op-1",
  stageId: "write",
  attempt: 1,
  generation: 1,
  dispatchKey: "work:acme.agent/code",
  executorId: "acme.agent/code",
  status: "failed",
  sessionRef: "s1",
  sessionDir: "/state/agent-sessions/op-1",
  settledAt: "2026-01-01T00:00:00Z",
  ...over,
});

const state = (over: Partial<DurableRunState> = {}) =>
  ({ runId: "r1", generation: 2, outstanding: [], agentSessions: [session()], ...over }) as DurableRunState;

describe("continuation admission", () => {
  it("keys dispatches by jobId, or by purpose and executor", () => {
    expect(dispatchKey(job())).toBe("work:acme.agent/code");
    expect(dispatchKey(job({ jobId: "implement" }))).toBe("implement");
  });

  it("admits a settled session of the same stage and key, or no continuation at all", () => {
    expect(continuationRefusal(state(), job({ continueFrom: "op-1" }))).toBeUndefined();
    expect(continuationRefusal(state({ agentSessions: [] }), job())).toBeUndefined();
  });

  it("refuses sessions this run did not record, has not settled, or that belong elsewhere", () => {
    const from = { continueFrom: "op-1" };
    expect(continuationRefusal(state({ agentSessions: [] }), job(from))).toBe(
      "no agent session was recorded for operation op-1 in run r1",
    );
    expect(
      continuationRefusal(
        state({ agentSessions: [], outstanding: [{ operationId: "op-1", kind: "dispatch" }] }),
        job(from),
      ),
    ).toBe("operation op-1 has not settled");
    expect(continuationRefusal(state(), job({ ...from, stageId: "review" }))).toBe(
      "operation op-1 ran stage write, not review",
    );
    expect(continuationRefusal(state(), job({ ...from, purpose: "diagnostic" }))).toBe(
      "operation op-1 has dispatch key work:acme.agent/code, not diagnostic:acme.agent/code",
    );
    expect(continuationRefusal(state(), job({ ...from, executor: { id: "acme.other/agent" } }))).toMatch(
      /not work:acme\.other\/agent$/,
    );
    expect(continuationRefusal(state({ agentSessions: [session({ generation: 3 })] }), job(from))).toBe(
      "operation op-1 was recorded by a later generation (3 > 2)",
    );
    expect(
      continuationRefusal(
        state({ agentSessions: [session(), session({ operationId: "op-2", continuedFrom: "op-1" })] }),
        job(from),
      ),
    ).toBe("operation op-1 was already continued by op-2; continue from that one");
  });

  it("follows a continued session back through everything it continued", () => {
    const s = state({
      agentSessions: [session(), session({ operationId: "op-2", continuedFrom: "op-1" })],
    });
    expect([...continuedOperations(s, "op-2")]).toEqual(["op-2", "op-1"]);
    expect(continuedOperations(s, undefined).size).toBe(0);
  });
});

describe("tool calls in a continued session", () => {
  const child = (over: Partial<ChildOperationRecord>): ChildOperationRecord => ({
    childOperationId: "child-1",
    parentOperationId: "op-1",
    toolCallId: "w1",
    tool: "post_comment",
    stageId: "write",
    attempt: 1,
    generation: 1,
    executor: { id: "acme.github/post-comment" },
    effect: "write",
    input: { body: "a" },
    status: "ok",
    admittedAt: "2026-01-01T00:00:00Z",
    ...over,
  });
  const canonical = (v: unknown) => JSON.stringify(v);
  const call = (toolCallId: string, input: unknown = { body: "a" }) => ({
    toolCallId,
    tool: "post_comment",
    inputKey: canonical(input),
  });
  const lineage = new Set(["op-1"]);

  it("asks for a new call instead of repeating an earlier turn's call", () => {
    expect(earlierToolCallRefusal([child({})], lineage, call("w1"), canonical)).toBe(
      "tool call w1 belongs to an earlier attempt; make a new call",
    );
    expect(earlierToolCallRefusal([child({})], lineage, call("w2"), canonical)).toBeUndefined();
  });

  it("blocks the same write while an earlier one has an unreconciled outcome", () => {
    const ambiguous = [child({ status: "ambiguous" })];
    const blocked = "repeats post_comment call w1 from an earlier attempt, whose outcome is unreconciled";
    expect(earlierToolCallRefusal(ambiguous, lineage, call("w1"), canonical)).toBe(`tool call w1 ${blocked}`);
    expect(earlierToolCallRefusal(ambiguous, lineage, call("w2"), canonical)).toBe(`tool call w2 ${blocked}`);
    expect(earlierToolCallRefusal(ambiguous, lineage, call("w3", { body: "b" }), canonical)).toBeUndefined();
  });

  it("does not constrain a fresh session or calls of unrelated operations", () => {
    expect(earlierToolCallRefusal([child({ status: "ambiguous" })], new Set(), call("w1"), canonical)).toBeUndefined();
    expect(earlierToolCallRefusal([child({ parentOperationId: "op-9" })], lineage, call("w1"), canonical)).toBeUndefined();
  });
});
