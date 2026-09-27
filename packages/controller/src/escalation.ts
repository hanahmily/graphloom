import { createHash } from "node:crypto";
import type { EvidenceRecord, GraphDecision } from "@graphloom/sdk";
import { stageRequirementsMet } from "./admit.js";
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
    facts.add(`receipt:${stableJson([r.stageId, r.requirementId, r.validatorBinding, judged])}`);
  }
  return sha256(JSON.stringify([state.activeVersion, [...facts].sort()]));
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
  const key = sha256(stableJson(action));
  const count = (counts[key] ?? 0) + 1;
  const next = { ...state, noProgress: { mark, counts: { ...counts, [key]: count } } };
  if (count < 2) return { state: next };
  return { state: next, stalled: `the graph repeated ${describeAction(decision)} with no progress since it last proposed it` };
}

/** Why a normal-mode correction for `stageId` goes to the supervisor instead, if it does. */
export function correctionHandoff(state: DurableRunState, stageId: string): string | undefined {
  const trials = state.correctionTrials?.[stageId] ?? 0;
  if (trials < MAX_CORRECTION_TRIALS) return undefined;
  return `stage ${stageId} is still unresolved after ${trials} correction trials; the supervisor decides any further trial`;
}

export function countCorrectionTrial(state: DurableRunState, stageId: string): Record<string, number> {
  return { ...state.correctionTrials, [stageId]: (state.correctionTrials?.[stageId] ?? 0) + 1 };
}

/** Drop the trial counts of stages that are now accepted. */
export function clearResolvedTrials(state: DurableRunState): DurableRunState {
  const trials = state.correctionTrials;
  if (trials === undefined) return state;
  const open = Object.entries(trials).filter(([stageId]) => {
    const stage = state.definition.stages.find((s) => s.id === stageId);
    return stage !== undefined && !stageRequirementsMet(state, stage.id, stage.requirementIds);
  });
  if (open.length === Object.keys(trials).length) return state;
  return { ...state, correctionTrials: Object.fromEntries(open) };
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
  return `${e.kind}:${identity}:${sha256(stableJson(payload ?? null))}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
