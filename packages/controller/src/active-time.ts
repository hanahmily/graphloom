import { performance } from "node:perf_hooks";
import { DEFAULT_ACTIVE_BUDGET_MS } from "./intake.js";
import type { DurableRunState } from "./state.js";

export interface ActiveClock {
  /** Milliseconds left; never increases. */
  remaining(): number;
  close(): Promise<void>;
}

/**
 * Run down the run's active-time budget while this controller runs it.
 * Elapsed time is monotonic, so clock adjustments neither add nor remove
 * time. The clock starts from the saved budget alone, so time the run spent
 * stopped is never charged. Nothing is checkpointed mid-run: a clean stop or
 * a thrown exception records elapsed time through the loop's own save (see
 * recordActiveTime in loop.ts), but a hard kill (SIGKILL, OOM, power loss)
 * gives back whatever time was in flight when it struck. activeMs is a soft
 * cost control, not a safety boundary, so that loss is an accepted tradeoff
 * for not persisting a second, separately-checkpointed copy of this budget.
 */
export async function startActiveClock(state: DurableRunState): Promise<ActiveClock> {
  const allowance = state.budgets.activeMs ?? DEFAULT_ACTIVE_BUDGET_MS;
  const startedAt = performance.now();
  const remaining = () => Math.max(0, Math.floor(allowance - (performance.now() - startedAt)));
  return {
    remaining,
    async close() {
      /* no-op: the loop's own finally block records elapsed time on every exit it can reach. */
    },
  };
}
