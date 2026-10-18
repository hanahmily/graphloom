import { boundRejections, fitEpisodeRecord, MAX_EPISODE_RECORDS, type EpisodeOutcome, type SupervisorEpisodeRecord } from "@graphloom/supervisor";
import type { DurableRunState } from "./state.js";

/** Append an episode record, keeping the newest MAX_EPISODE_RECORDS. */
export function appendEpisode(state: DurableRunState, record: SupervisorEpisodeRecord): DurableRunState {
  return { ...state, supervisorEpisodes: [...(state.supervisorEpisodes ?? []), record].slice(-MAX_EPISODE_RECORDS) };
}

/**
 * The turn number the next decide() of `episodeId` is: one past the highest turn
 * recorded for it. Counting retained records instead would repeat a number once
 * the cap has dropped the episode's older records.
 */
export function nextEpisodeTurn(state: DurableRunState, episodeId: string): number {
  let last = 0;
  for (const r of state.supervisorEpisodes ?? []) if (r.episodeId === episodeId && r.turn > last) last = r.turn;
  return last + 1;
}

/**
 * Settle the newest record of `episodeId`/`turn` with the controller's outcome,
 * if it is still there; a record the cap already dropped is left alone.
 */
export function settleEpisode(
  state: DurableRunState,
  episodeId: string,
  turn: number,
  outcome: EpisodeOutcome,
  rejections?: string[],
): DurableRunState {
  const records = state.supervisorEpisodes;
  if (records === undefined) return state;
  let at = -1;
  for (let i = records.length - 1; i >= 0 && at < 0; i -= 1) {
    if (records[i]!.episodeId === episodeId && records[i]!.turn === turn) at = i;
  }
  if (at < 0) return state;
  const record = records[at]!;
  // Rewritten records stay inside the same bound as built ones.
  const next: SupervisorEpisodeRecord = fitEpisodeRecord({
    ...record,
    admission: { ...record.admission, outcome, ...(rejections !== undefined ? { rejections: boundRejections(rejections) } : {}) },
  });
  return { ...state, supervisorEpisodes: records.map((r, i) => (i === at ? next : r)) };
}
