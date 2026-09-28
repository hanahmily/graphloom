import type { JobSpec } from "@graphloom/sdk";
import type { DurableRunState, PendingDispatch } from "./state.js";
import { readWorktreeFile } from "./worktree.js";

/**
 * Settle a pending dispatch after stop/crash.
 * - If write-scope files exist, treat the effect as done (do not re-dispatch).
 * - If no effect is visible, clear the intent and reset advisory writer flags
 *   so the graph can retry.
 * - Otherwise keep the intent and stop for operator reconcile.
 */
export async function reconcilePendingDispatch(
  state: DurableRunState,
): Promise<{ state: DurableRunState; settled: boolean; reason: string }> {
  const pending = state.pendingDispatch;
  if (pending?.status === "waiting") {
    return {
      state: dropWaitingDispatch(state, pending),
      settled: true,
      reason: `pending ${pending.operationId} never started; retry allowed`,
    };
  }
  if (!pending || pending.status !== "pending") {
    return { state, settled: true, reason: "no pending dispatch" };
  }

  const job = pending.job;
  const opId = pending.operationId;

  if (job.writeScope && job.writeScope.length > 0) {
    const present: string[] = [];
    for (const rel of job.writeScope) {
      const bytes = await readWorktreeFile(state.worktreePath, rel);
      if (bytes !== undefined && bytes.length > 0) {
        present.push(rel);
      }
    }
    if (present.length > 0) {
      const { pendingDispatch: _p, ...rest } = state;
      void _p;
      return {
        state: {
          ...rest,
          outstanding: state.outstanding.filter((o) => o.operationId !== opId),
          // Settlement establishes the writer's identity, not acceptance of
          // its output. Observe/Validate still verify the candidate, and a
          // separate reviewer must be distinct from this reconciled job.
          ...(job.purpose === "work" ? { lastWorkOperationId: opId } : {}),
        },
        settled: true,
        reason: `pending ${opId} settled: observed writes ${present.join(",")}`,
      };
    }
    // No visible effect — clear intent and allow retry.
    const { pendingDispatch: _p, privateState: _ps, ...rest } = state;
    void _p;
    void _ps;
    const clearedPrivate = resetWriterFlags(state.privateState);
    return {
      state: {
        ...rest,
        outstanding: state.outstanding.filter((o) => o.operationId !== opId),
        ...(clearedPrivate !== undefined ? { privateState: clearedPrivate } : {}),
      },
      settled: true,
      reason: `pending ${opId} cleared: no write effect; retry allowed`,
    };
  }

  // Non-write jobs (e.g. review): cannot safely infer completion from worktree.
  return {
    state,
    settled: false,
    reason: `pending ${opId} (${job.purpose}/${job.kind}) needs operator reconcile`,
  };
}

export function isUnsettled(pending: PendingDispatch): boolean {
  return pending.status === "pending" || pending.status === "waiting";
}

/**
 * A waiting dispatch never reached the runner. Drop it, keep any executor
 * retry time, and refund the wait not yet spent, so the next dispatch charges
 * only what remains.
 */
function dropWaitingDispatch(state: DurableRunState, pending: PendingDispatch): DurableRunState {
  const { pendingDispatch: _p, ...rest } = state;
  void _p;
  const unspent = pending.notBefore !== undefined ? Math.max(0, Date.parse(pending.notBefore) - Date.now()) : 0;
  const executorId = pending.executor?.id;
  return {
    ...rest,
    outstanding: state.outstanding.filter((o) => o.operationId !== pending.operationId),
    budgets: { ...state.budgets, waitMs: (state.budgets.waitMs ?? 0) + unspent },
    ...(executorId !== undefined && pending.notBefore !== undefined
      ? { executorRetryAt: { ...state.executorRetryAt, [executorId]: pending.notBefore } }
      : {}),
  };
}

function resetWriterFlags(privateState: string | undefined): string | undefined {
  if (!privateState) {
    return privateState;
  }
  try {
    const parsed = JSON.parse(privateState) as Record<string, unknown>;
    if ("writerDispatched" in parsed) {
      parsed.writerDispatched = false;
    }
    if ("observedWrite" in parsed) {
      parsed.observedWrite = false;
    }
    return JSON.stringify(parsed);
  } catch {
    return privateState;
  }
}

export type { JobSpec };
