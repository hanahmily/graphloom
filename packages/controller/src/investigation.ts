// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A CLI supervisor's investigation steps (`inv-<n>`) as citations
 * (design-supervisor-harnesses.md §5.3): the steps the episode's records hold,
 * and the steps the running turn has observed and not yet recorded.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { isInvestigationStepId, type InvestigationStep } from "@graphloom/supervisor";
import type { DurableRunState } from "./state.js";

export interface EpisodeInvestigation {
  /** Every step id citable in the episode. */
  ids: ReadonlySet<string>;
  /** The steps by id, where their content is still kept. */
  steps: ReadonlyMap<string, InvestigationStep>;
  /** How many steps the episode's records have numbered (what a restarted supervisor numbers after). */
  numbered: number;
}

function stepNumber(id: string): number {
  return isInvestigationStepId(id) ? Number(id.slice(4)) : 0;
}

/**
 * The episode's investigation steps: those its records hold, plus `live`
 * (the running supervisor's own, which may not be recorded yet).
 */
export function episodeInvestigation(
  state: DurableRunState,
  episodeId: string,
  live: readonly InvestigationStep[] = [],
): EpisodeInvestigation {
  const steps = new Map<string, InvestigationStep>();
  const ids = new Set<string>();
  let numbered = 0;
  for (const record of state.supervisorEpisodes ?? []) {
    if (record.episodeId !== episodeId) continue;
    let last = 0;
    for (const step of record.investigation ?? []) {
      if (!isInvestigationStepId(step.id)) continue;
      steps.set(step.id, step);
      ids.add(step.id);
      last = Math.max(last, stepNumber(step.id));
    }
    // A record keeps its first steps and counts the ones the size bound dropped after them.
    const dropped = record.droppedInvestigation ?? 0;
    if (last > 0 || dropped > 0) numbered = Math.max(numbered, last + dropped);
    for (let n = last + 1; n <= last + dropped; n += 1) ids.add(`inv-${n}`);
  }
  for (const step of live) {
    if (!isInvestigationStepId(step.id)) continue;
    steps.set(step.id, step);
    ids.add(step.id);
  }
  return { ids, steps, numbered };
}

/** Cited step ids as evidence records for a reviewer (ref = step id), with the step's observed content. */
export function citedInvestigationEvidence(
  investigation: EpisodeInvestigation,
  refs: readonly string[] | undefined,
): EvidenceRecord[] {
  return [...new Set(refs ?? [])]
    .filter((ref) => investigation.ids.has(ref))
    .map((ref) => ({
      ref,
      kind: "other" as const,
      payload: {
        investigation: investigation.steps.get(ref) ?? { id: ref, note: "this step ran in the episode, but its record is no longer kept" },
      },
    }));
}
