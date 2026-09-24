import type { JobSpec } from "@graphloom/sdk";
import type { DurableRunState } from "./state.js";
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
