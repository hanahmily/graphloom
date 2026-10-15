import { describe, expect, it } from "vitest";
import { reconcilePendingDispatch } from "./reconcile.js";
import type { DurableRunState } from "./state.js";

function stateWith(job: Record<string, unknown>): DurableRunState {
  return {
    worktreePath: "/nonexistent",
    outstanding: [{ operationId: "op-1" }],
    pendingDispatch: { operationId: "op-1", status: "pending", job },
  } as unknown as DurableRunState;
}

describe("reconcilePendingDispatch", () => {
  it("clears an interrupted read-only job so it is retried", async () => {
    const r = await reconcilePendingDispatch(stateWith({ stageId: "review", kind: "agent", purpose: "review", readOnly: true }));
    expect(r.settled).toBe(true);
    expect(r.state.pendingDispatch).toBeUndefined();
    expect(r.state.outstanding).toEqual([]);
  });

  it("still requires an operator for a non-read-only job without a write scope", async () => {
    const r = await reconcilePendingDispatch(stateWith({ stageId: "review", kind: "agent", purpose: "review" }));
    expect(r.settled).toBe(false);
    expect(r.state.pendingDispatch).toBeDefined();
  });
});
