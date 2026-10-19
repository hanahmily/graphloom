/**
 * What a run has spent of each budget, kept apart from what it has left.
 *
 * `state.budgets` holds what remains; an operator raises a budget by editing
 * that remaining value while the run is stopped. The intake copy
 * (`state.intake.budgets`) is what the run started with and never changes, so
 * neither one alone says how much the run has used or been given in total.
 *
 * The ledger is maintained in one place, `saveRunState`, rather than at every
 * charge: a save books any change in a remaining budget since the state was
 * loaded (or created) as the controller's own spending — a decrease is a
 * charge, an increase a refund, such as an unused repair allowance or wait
 * returned. A load books any difference between the saved remaining budgets
 * and the ledger's copy of them as the operator's edit: it changes what the
 * run has been given, not what it used. So
 *
 *   granted (the run's budget) = used + remaining
 *
 * at every point, with operator raises included and intake's copy left alone.
 */
import type { DurableRunState } from "./state.js";

/** The budgets the controller charges; `recoveryReserve` is a floor, not spending. */
export const METERED_BUDGET_KEYS = ["agentInvocations", "jobs", "decisions", "corrections", "waitMs", "activeMs", "probes"] as const;
export type MeteredBudgetKey = (typeof METERED_BUDGET_KEYS)[number];
export type BudgetAmounts = Partial<Record<MeteredBudgetKey, number>>;

export interface BudgetUsage {
  /** What the run has spent of each budget so far (as of `saved`). */
  used: BudgetAmounts;
  /** The remaining budgets `used` was booked against: the last saved, or loaded, values. */
  saved: BudgetAmounts;
  /**
   * `"intake"`: booked since the run began, so `used` is exact. Otherwise
   * when a run saved before this ledger existed started keeping it (its last
   * recorded version transition); what it used before then is estimated from
   * its intake budgets and records.
   */
  since: string;
  /**
   * Set when `agentInvocationsByStage` has counted every call a stage job
   * made since intake (reserved per request, or charged at settlement), so
   * what the run used beyond it is the supervisor's, reviewer's and repairs'.
   * Absent in runs whose stage counts missed settlement-charged calls.
   */
  stageCallsComplete?: true;
}

type Budgets = DurableRunState["budgets"];
/** The parts of a run the ledger reads; `versionHistory` may be absent in a hand-built view. */
type UsageView = Pick<DurableRunState, "budgets" | "intake" | "agentInvocationsByStage" | "budgetUsage"> & Partial<Pick<DurableRunState, "versionHistory">>;

function amounts(budgets: Budgets): BudgetAmounts {
  const out: BudgetAmounts = {};
  for (const key of METERED_BUDGET_KEYS) {
    const v = budgets[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** A new run's ledger: nothing spent, booked against its starting budgets. */
export function freshBudgetUsage(budgets: Budgets): BudgetUsage {
  return { used: {}, saved: amounts(budgets), since: "intake", stageCallsComplete: true };
}

/**
 * For a run saved before the ledger existed: what it used, estimated as its
 * intake budgets less what remains (exact unless an operator edited budgets),
 * and for agent invocations at least what its stages recorded reserving.
 */
export function legacyBudgetUsage(state: Omit<UsageView, "budgetUsage">, now = new Date()): BudgetUsage {
  const used: BudgetAmounts = {};
  const start = (state.intake?.budgets ?? {}) as Budgets;
  for (const key of METERED_BUDGET_KEYS) {
    const initial = start[key];
    const left = state.budgets[key];
    if (typeof initial === "number" && typeof left === "number") used[key] = Math.max(0, initial - left);
  }
  const byStage = Object.values(state.agentInvocationsByStage ?? {}).reduce((a, b) => a + b, 0);
  used.agentInvocations = Math.max(used.agentInvocations ?? 0, byStage);
  // Booked from the run's last recorded transition on: what it used up to there is the estimate.
  const last = state.versionHistory?.at(-1)?.at;
  return { used, saved: amounts(state.budgets), since: last !== undefined && Number.isFinite(Date.parse(last)) ? last : now.toISOString() };
}

/** The ledger `state` carries, or an estimated one for a run saved before it existed. */
function ledgerOf(state: UsageView): BudgetUsage {
  return state.budgetUsage ?? legacyBudgetUsage(state);
}

/**
 * What the run has spent of each budget up to `state`: the ledger's booked
 * use plus the controller's own charges (less refunds) since it was booked.
 */
export function budgetsUsed(state: UsageView): BudgetAmounts {
  const ledger = ledgerOf(state);
  const out: BudgetAmounts = {};
  for (const key of METERED_BUDGET_KEYS) {
    const left = state.budgets[key];
    const booked = ledger.used[key];
    const saved = ledger.saved[key];
    if (typeof left !== "number") {
      if (booked !== undefined) out[key] = booked;
      continue;
    }
    out[key] = Math.max(0, (booked ?? 0) + (saved !== undefined ? saved - left : 0));
  }
  return out;
}

/**
 * The run's budget for `key` as it stands: what it has used plus what it has
 * left. An operator's raise counts; the intake copy is only where it started.
 */
export function budgetGranted(state: UsageView, key: MeteredBudgetKey): number | undefined {
  const left = state.budgets[key];
  if (typeof left !== "number") return undefined;
  return (budgetsUsed(state)[key] ?? 0) + left;
}

/** The state as saveRunState writes it: the ledger booked up to its current budgets. */
export function bookBudgetUsage(state: DurableRunState): DurableRunState {
  if (state.budgets === null || typeof state.budgets !== "object") return state;
  const ledger = state.budgetUsage ?? legacyBudgetUsage(state);
  return { ...state, budgetUsage: { ...ledger, used: budgetsUsed(state), saved: amounts(state.budgets) } };
}

/**
 * The state as loadRunState returns it: any difference between the remaining
 * budgets on disk and the ledger's copy is an operator's edit (the controller
 * books its own charges when it saves), so the ledger is re-based on them and
 * `used` is left alone. A run saved before the ledger existed gets an
 * estimated one.
 */
export function rebaseBudgetUsage(state: DurableRunState): DurableRunState {
  // A partial or foreign state file (no budgets) loads exactly as written.
  if (state === null || typeof state !== "object" || state.budgets === null || typeof state.budgets !== "object") return state;
  const ledger = state.budgetUsage ?? legacyBudgetUsage(state);
  return { ...state, budgetUsage: { ...ledger, saved: amounts(state.budgets) } };
}
