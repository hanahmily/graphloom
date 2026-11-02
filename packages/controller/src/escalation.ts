// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { ACTION_SPEC_KEYS, stableHash } from "@graphloom/sdk";
import type { CorrectionHandoff, EvidenceRecord, GraphAction, GraphDecision, SupervisorRepeatEntry } from "@graphloom/sdk";
import type { DurableRunState } from "./state.js";

/** Failed correction trials at one unresolved stage before the supervisor decides any further trial. */
export const MAX_CORRECTION_TRIALS = 2;

/**
 * What the run has established so far: the active plugin version, the
 * content of every observation and result (by kind, path, and bytes), and
 * every acceptance (by stage, requirement, validator, and the content it
 * judged). It changes only when something new is established. New operation
 * IDs, evidence refs, generation fences, and invalidation alone do not change it.
 */
export function progressMark(state: DurableRunState): string {
  const keyByRef = new Map(state.evidence.map((e) => [e.ref, evidenceKey(e)]));
  const facts = new Set(keyByRef.values());
  for (const r of state.receipts) {
    const judged = r.evidenceRefs.map((ref) => keyByRef.get(ref) ?? ref).sort();
    facts.add(`receipt:${stableHash([r.stageId, r.requirementId, r.validatorBinding, judged])}`);
  }
  return stableHash([state.activeVersion, [...facts].sort()]);
}

/**
 * Record a normal-mode graph decision. Returns why the run is stalled when
 * the graph proposes a decision it already made since the run last
 * progressed. Counts survive recovery and Return until progress clears them.
 */
export function noteGraphDecision(
  state: DurableRunState,
  decision: GraphDecision,
): { state: DurableRunState; stalled?: string } {
  const { action } = decision;
  const mark = progressMark(state);
  const counts = state.noProgress?.mark === mark ? state.noProgress.counts : {};
  const key = stableHash(action);
  const count = (counts[key] ?? 0) + 1;
  const next = { ...state, noProgress: { mark, counts: { ...counts, [key]: count } } };
  if (count < 2) return { state: next };
  return { state: next, stalled: `the graph repeated ${describeAction(decision)} with no progress since it last proposed it` };
}

/**
 * Settle a stage's correction streak against this validate's outcome.
 * `evaluated` is false for a structural admission rejection (wrong stage,
 * stale evidence, workspace drift, missing predecessor receipts) where no
 * validator ran — a botched admission attempt is not a failed fix, and must
 * not move the counter. Counting is per validate call, not per settled
 * dispatch: two settled work dispatches with no intervening validate count
 * as at most one trial, since only a validate can tell "unresolved" from
 * "resolved."
 */
export function settleCorrectionTrial(
  state: DurableRunState,
  stageId: string,
  validation: { evaluated: boolean; accepted: boolean },
): DurableRunState {
  if (!validation.evaluated) return state;
  const pendingTrial = state.correctionPendingTrial?.[stageId] === true;
  let next = clearCorrectionPendingTrial(state, stageId);
  if (validation.accepted) return clearCorrectionStreak(next, stageId);
  if (pendingTrial) {
    const trials = (next.correctionTrials?.[stageId] ?? 0) + 1;
    next = { ...next, correctionTrials: { ...next.correctionTrials, [stageId]: trials } };
    if (trials >= MAX_CORRECTION_TRIALS) {
      const handoff: CorrectionHandoff = {
        since: new Date().toISOString(),
        reason: `stage ${stageId} is still unresolved after ${trials} correction trials; the supervisor decides any further trial`,
        trials,
      };
      next = { ...next, handoff: { ...next.handoff, [stageId]: handoff } };
    }
    return next;
  }
  const hasOpenStreak = state.correctionTrials?.[stageId] !== undefined;
  if (!hasOpenStreak && state.workDispatched?.[stageId] === true) {
    // The stage's first substantive validate failure after work has actually
    // been dispatched for it: open the streak, not yet a counted trial.
    return { ...next, correctionTrials: { ...next.correctionTrials, [stageId]: 0 } };
  }
  return next;
}

/** A supervisor work dispatch for `stageId` settled: it clears the streak regardless of outcome. */
export function settleSupervisorCorrection(state: DurableRunState, stageId: string): DurableRunState {
  return clearCorrectionStreak(state, stageId);
}

function clearCorrectionStreak(state: DurableRunState, stageId: string): DurableRunState {
  if (state.correctionTrials?.[stageId] === undefined && state.handoff?.[stageId] === undefined) return state;
  const { [stageId]: _t, ...trials } = state.correctionTrials ?? {};
  const { [stageId]: _h, ...handoff } = state.handoff ?? {};
  // A supervisor settling the stage's correction streak is as much a
  // deliberate fresh start as a receipt: the §4.6 dispatch-without-receipt
  // clock restarts with it, so the graph's next cap is judged on what
  // happens from here, not on dispatches the handoff already resolved.
  const { [stageId]: _d, ...dispatchesSinceReceipt } = state.dispatchesSinceReceipt ?? {};
  return { ...state, correctionTrials: trials, handoff, dispatchesSinceReceipt };
}

function clearCorrectionPendingTrial(state: DurableRunState, stageId: string): DurableRunState {
  if (state.correctionPendingTrial?.[stageId] === undefined) return state;
  const { [stageId]: _p, ...rest } = state.correctionPendingTrial;
  return { ...state, correctionPendingTrial: rest };
}

/** The stage an action concerns, for keys and repeat-detection; `undefined` for a stage-less action type. */
function stageForAction(action: GraphAction): string | undefined {
  switch (action.type) {
    case "dispatch":
      return action.job.stageId;
    case "validate":
      return action.validate.stageId;
    case "reenter":
      return action.reenter.stageId;
    default:
      return undefined;
  }
}

/** The action's own spec, with its free text (`reason`, and a dispatch's `instruction`) stripped before hashing. */
function specForHash(action: GraphAction): unknown {
  const key = ACTION_SPEC_KEYS[action.type]!;
  const spec = (action as unknown as Record<string, unknown>)[key];
  if (spec === null || typeof spec !== "object") return spec;
  const { reason: _reason, instruction: _instruction, ...rest } = spec as Record<string, unknown>;
  return rest;
}

/** Stable key for a supervisor proposal: (trigger code, stage, action type, action spec hash), free text excluded. */
export function supervisorProposalKey(triggerCode: string, action: GraphAction): string {
  return stableHash([triggerCode, stageForAction(action) ?? null, action.type, specForHash(action)]);
}

/**
 * Record an admitted supervisor proposal. Returns the repeat count (by the
 * key above) since the progress mark last changed — exactly as graph
 * decisions are counted, but scoped to `repeatedProposals`, not `noProgress`,
 * since the two must clear independently on resume.
 */
export function noteSupervisorProposal(
  state: DurableRunState,
  triggerCode: string,
  decision: GraphDecision,
): { state: DurableRunState; count: number } {
  const mark = progressMark(state);
  const entries = state.repeatedProposals?.mark === mark ? state.repeatedProposals.entries : {};
  const key = supervisorProposalKey(triggerCode, decision.action);
  const count = (entries[key]?.count ?? 0) + 1;
  const stageId = stageForAction(decision.action);
  const entry: SupervisorRepeatEntry = { triggerCode, actionType: decision.action.type, count, ...(stageId !== undefined ? { stageId } : {}) };
  return { state: { ...state, repeatedProposals: { mark, entries: { ...entries, [key]: entry } } }, count };
}

function describeAction(decision: GraphDecision): string {
  const { action } = decision;
  switch (action.type) {
    case "dispatch":
      return `dispatch of ${action.job.purpose} for ${action.job.stageId}`;
    case "validate":
      return `validate of ${action.validate.stageId}`;
    case "reenter":
      return `reenter of ${action.reenter.stageId}`;
    default:
      return action.type;
  }
}

function evidenceKey(e: EvidenceRecord): string {
  const record = e.payload !== null && typeof e.payload === "object" && !Array.isArray(e.payload) ? (e.payload as Record<string, unknown>) : undefined;
  const identity = typeof record?.path === "string" ? record.path : "";
  if (e.fingerprint !== undefined) return `${e.kind}:${identity}:${e.fingerprint}`;
  const payload = record !== undefined ? Object.fromEntries(Object.entries(record).filter(([k]) => k !== "producer")) : e.payload;
  // The externalized parts' digests stand in for their content; an inline record keys as it always did.
  return `${e.kind}:${identity}:${stableHash(e.externalized !== undefined ? [payload ?? null, e.externalized] : (payload ?? null))}`;
}
