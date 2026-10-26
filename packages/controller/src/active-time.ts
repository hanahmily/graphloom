// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { DEFAULT_ACTIVE_BUDGET_MS } from "./intake.js";
import type { DurableRunState } from "./state.js";

export interface ActiveClock {
  /** Milliseconds left; never increases. */
  remaining(): number;
  /**
   * Stop counting down while the run only waits on the clock (a harness quota
   * reset, a retry's backoff): those waits are charged to `waitMs`, not here.
   * Returns the function that starts counting again; calling it twice is harmless.
   */
  pause(): () => void;
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
// The global clock, so a test can fake it with the timers.
export async function startActiveClock(state: DurableRunState): Promise<ActiveClock> {
  const allowance = state.budgets.activeMs ?? DEFAULT_ACTIVE_BUDGET_MS;
  const startedAt = performance.now();
  let pausedFor = 0;
  let pausedAt: number | undefined;
  const remaining = () => {
    const now = performance.now();
    const paused = pausedFor + (pausedAt !== undefined ? now - pausedAt : 0);
    return Math.max(0, Math.floor(allowance - (now - startedAt - paused)));
  };
  return {
    remaining,
    pause() {
      if (pausedAt !== undefined) return () => undefined;
      const at = performance.now();
      pausedAt = at;
      return () => {
        if (pausedAt !== at) return;
        pausedFor += performance.now() - at;
        pausedAt = undefined;
      };
    },
    async close() {
      /* no-op: the loop's own finally block records elapsed time on every exit it can reach. */
    },
  };
}
