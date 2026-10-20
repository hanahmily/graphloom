import { describe, expect, it } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import { applyExecutorRepin } from "./executor-catalog.js";
import type { DurableRunState, ExecutorCatalogEntry, PendingDispatch } from "./state.js";

const ID = "acme.mirror/list-comments";
const job = (digest: string): JobSpec => ({
  stageId: "write",
  kind: "command",
  purpose: "check",
  instruction: "read",
  readOnly: true,
  executor: { id: ID, version: "1", digest },
});
const entry: ExecutorCatalogEntry = { id: ID, digest: "new", source: "/x", isolation: "sandbox", builtin: false };
const repin = [{ id: ID, fromDigest: "old", toDigest: "new", fromSource: "/x", toSource: "/x" }];

function stateWith(status: PendingDispatch["status"]): DurableRunState {
  return {
    generation: 3,
    stateRevision: 1,
    evidenceSeq: 0,
    activeVersion: "hello@1",
    evidence: [],
    versionHistory: [],
    pendingDispatch: { operationId: "op", generation: 3, stageId: "write", job: job("old"), status, executor: { id: ID, version: "1", digest: "old" } },
  } as unknown as DurableRunState;
}

describe("applyExecutorRepin", () => {
  it("moves a dispatch that never reached the runner onto the new digest", () => {
    const next = applyExecutorRepin(stateWith("waiting"), [entry], repin);
    expect(next.pendingDispatch?.job.executor?.digest).toBe("new");
    expect(next.pendingDispatch?.executor?.digest).toBe("new");
  });

  it.each(["pending", "completed", "failed"] as const)("keeps the pins a %s dispatch ran under", (status) => {
    const next = applyExecutorRepin(stateWith(status), [entry], repin);
    expect(next.pendingDispatch?.job.executor?.digest).toBe("old");
    expect(next.pendingDispatch?.executor?.digest).toBe("old");
    expect(next.executorTransitions).toMatchObject([{ id: ID, fromDigest: "old", toDigest: "new", generation: 3 }]);
  });
});
