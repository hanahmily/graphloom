import { randomUUID } from "node:crypto";
import { noteOutcome } from "./settlement.js";
import { recordRemedy, STEP_LIMIT_STOP_REASON, type DurableRunState } from "./state.js";

const MAX_DETAIL_CHARS = 500;

/** What a run resumed in recovery records about leaving it, for the operator and the next episode. */
export const RESUME_RETRY_REMEDY = "resumed: returned to normal so the graph retries what failed before the resume";

/**
 * A run resumed while in recovery first gets a fresh graph attempt rather
 * than a supervisor turn on the trigger recorded before the stop. Resume
 * exists because the operator changed something (code, config, environment,
 * grants), so that trigger and its evidence are not current: the graph's own
 * advance() re-dispatches what failed, and if the failure recurs the normal
 * recovery path fires again with a fresh trigger and post-resume evidence.
 * That holds whatever stopped the run, including the supervisor's own stop
 * and a run with no supervisor configured: the operator resuming is the
 * authority. The one exception is the controller's own step-limit pause:
 * nothing failed and no operator action was needed, so the episode simply
 * continues.
 *
 * Only the episode is closed. Budgets, correction trials and handoffs,
 * repeated-proposal tracking, repair candidates, and the case file are kept,
 * and the journals (pending dispatch, repair, model switch) are reconciled by
 * resume before this runs. An environment block is lifted because the
 * environment is checked again before the graph is asked anything; a still
 * changed environment re-enters recovery from that check.
 */
export function returnToGraphOnResume(state: DurableRunState): DurableRunState {
  // A job a usage limit cut off after possible effects is settled by an episode, never by the graph replaying it.
  const owed = state.reconciliationRequired;
  if (owed !== undefined) {
    return state.mode === "recovery" && state.recoveryTrigger !== undefined
      ? state
      : {
          ...state,
          mode: "recovery",
          recoveryEpisodeId: `ep-${randomUUID().slice(0, 8)}`,
          recoveryTrigger: { code: "quota_partial", message: `${owed.reason} (job ${owed.operationId}, stage ${owed.stageId})` },
        };
  }
  if (state.mode !== "recovery" || state.stopReason === STEP_LIMIT_STOP_REASON) return state;
  const trigger = state.recoveryTrigger;
  const {
    recoveryEpisodeId,
    recoveryTrigger: _trigger,
    environmentBlock: _block,
    ...rest
  } = state;
  void _trigger;
  void _block;
  const code = trigger?.code ?? "unhandled";
  let next: DurableRunState = recordRemedy(
    { ...rest, mode: "normal" },
    {
      condition: `resumed in recovery (${code})`,
      remedy: RESUME_RETRY_REMEDY,
      ...(trigger !== undefined ? { detail: bounded(trigger.message) } : {}),
      ...(recoveryEpisodeId !== undefined ? { episodeId: recoveryEpisodeId } : {}),
    },
  );
  // The next episode's settlement opens with this, so the supervisor knows
  // its last proposal was overtaken by the operator's resume.
  next = noteOutcome(
    next,
    `the operator resumed the run; the controller returned it to its graph to retry what failed before the resume (the ${code} trigger)`,
  );
  return next;
}

function bounded(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}…`;
}
