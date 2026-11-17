// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, RunView } from "@graphloom/sdk";
import { isObject, producer } from "./evidence.js";

/**
 * What the graph remembers between calls (the run's private state): for each stage it has seen reentered, the
 * attempt number and the generation at which that attempt began. Everything else is read back from evidence.
 */
export interface AttemptState {
  v: 1;
  stages: Record<string, { attempt: number; generation: number }>;
}

/** The saved state; a run that holds none (a new run, an older version's `{"v":1}`, a resume that discarded it) has none recorded. */
export function readAttempts(saved: string | undefined): AttemptState {
  const blank: AttemptState = { v: 1, stages: {} };
  if (saved === undefined || saved === "") return blank;
  try {
    const parsed = JSON.parse(saved) as { stages?: unknown };
    if (!isObject(parsed.stages)) return blank;
    const stages: AttemptState["stages"] = {};
    for (const [id, entry] of Object.entries(parsed.stages)) {
      if (isObject(entry) && Number.isInteger(entry.attempt) && Number.isInteger(entry.generation)) stages[id] = { attempt: entry.attempt as number, generation: entry.generation as number };
    }
    return { v: 1, stages };
  } catch {
    return blank;
  }
}

/**
 * Notes the current stage's attempt. An attempt number the graph has not seen for the stage began at this call's
 * generation (a reentry bumps the generation and the graph's next call is the first to see it); a resume keeps the
 * attempt, so it keeps the start. A stage's first attempt began before anything was recorded, so nothing predates it.
 */
export function noteAttempt(state: AttemptState, view: Pick<RunView, "current" | "generation">): AttemptState {
  const { stageId, attempt } = view.current;
  const seen = state.stages[stageId];
  if (seen !== undefined && seen.attempt === attempt) return state;
  const generation = seen === undefined && attempt <= 1 ? 0 : view.generation;
  return { v: 1, stages: { ...state.stages, [stageId]: { attempt, generation } } };
}

/** An environment check's record: it describes the machine, not the candidate, so a change to the candidate leaves it standing. */
const isEnvironment = (e: EvidenceRecord): boolean => isObject(e.payload) && isObject(e.payload.environment);

/**
 * The evidence one call of the graph reasons from, which is the evidence a validator would accept, less what an
 * earlier attempt of a stage judged:
 *
 * - Candidate identity: a record made against a workspace other than the live one is out, as it is for the
 *   validators (`candidateEvidence`), so a flow never finds a requirement done on evidence the validator would
 *   not see. Environment checks stay.
 * - Attempt: an agent result (a record that names a result contract) that a stage's job produced before that
 *   stage's current attempt began is out, so a reentered stage dispatches its agents again and counts its
 *   corrections from none. A result with no generation, or a producer that is not a stage's, stays.
 *
 * Commands stand while the candidate does: they are the same function of it however often they run.
 */
export function attemptEvidence(evidence: readonly EvidenceRecord[], digest: string | undefined, state: AttemptState): EvidenceRecord[] {
  return evidence.filter((e) => {
    if (digest !== undefined && e.candidateDigest !== undefined && e.candidateDigest !== digest && !isEnvironment(e)) return false;
    if (e.resultSchema === undefined || e.generation === undefined) return true;
    const stage = producer(e)?.stageId;
    const began = stage !== undefined ? state.stages[stage]?.generation : undefined;
    return began === undefined || e.generation >= began;
  });
}
