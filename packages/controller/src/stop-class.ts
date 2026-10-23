/**
 * A resume retries what failed (docs/design-typescript-core.md §8). An
 * operator resumes because something changed, so a failure recorded before
 * the resume is not by itself a reason to stop again. Every stop is either
 * retryable (a resume runs the graph again) or final (a resume surfaces the
 * same blocker until something the stop depends on changes).
 *
 * The controller classifies only its own stop reasons, by the table below.
 * A graph or supervisor stop carries its own class (`StopSpec.retryable`),
 * so the controller never learns a plugin's reason strings.
 */
import type { ResumeView } from "@graphloom/sdk";
import { NO_PROGRESS_STOP_REASON, STEP_LIMIT_STOP_REASON, type DurableRunState, type StopMark } from "./state.js";

export type StopSource = "graph" | "supervisor" | "controller";

export interface StopClassification {
  retryable: boolean;
  by: StopSource;
  /** The class, as the operator reads it. */
  kind: string;
  /** A final stop the resume itself answers: the operator's own stop. */
  liftedByResume?: boolean;
}

interface ControllerStopClass {
  reason: string | RegExp;
  retryable: boolean;
  kind: string;
  liftedByResume?: true;
}

/** The controller's own stop reasons. A reason not listed is retryable: the graph decides again. */
export const CONTROLLER_STOP_CLASSES: readonly ControllerStopClass[] = [
  // Final.
  { reason: "operator stop", retryable: false, kind: "operator stop", liftedByResume: true },
  {
    reason: /^(?:budgets|decisions budget|agentInvocations budget|corrections budget|wait budget|active time budget) exhausted$/,
    retryable: false,
    kind: "budget exhausted",
  },
  { reason: /^unsupported action in /, retryable: false, kind: "plugin defect" },
  // Retryable.
  { reason: /^harness quota exhausted until /, retryable: true, kind: "harness quota" },
  { reason: /^job failed: /, retryable: true, kind: "job/executor failure" },
  { reason: "stale job result identity", retryable: true, kind: "job/executor failure" },
  { reason: /^plugin host(?::| restart failed)/, retryable: true, kind: "plugin host failure" },
  { reason: /^environment (?:check failed|preparation failed|changed)$/, retryable: true, kind: "environment" },
  {
    reason: /^(?:worktree mismatch|pin mismatch|executor pin mismatch|reconcile required|repair rehydration required|delivery changed after acceptance)$/,
    retryable: true,
    kind: "rechecked on resume",
  },
  { reason: /^(?:supervisor provider |supervisor decide failed$|reviewer_unavailable$|supervisor_inadmissible$)/, retryable: true, kind: "provider failure" },
  // Runs saved by an earlier controller can carry this; the controller no longer produces it.
  { reason: STEP_LIMIT_STOP_REASON, retryable: true, kind: "step limit" },
  { reason: NO_PROGRESS_STOP_REASON, retryable: true, kind: "no-progress loop" },
];

/** How a stopped run's stop is classified; undefined for a run that is not stopped. */
export function classifyStop(state: Pick<DurableRunState, "status" | "stopReason" | "stopClass">): StopClassification | undefined {
  if (state.status !== "stopped") return undefined;
  // A class recorded for another reason belongs to an earlier stop: the reason was overwritten since.
  if (state.stopClass !== undefined && (state.stopClass.reason === undefined || state.stopClass.reason === state.stopReason)) {
    const { by, retryable } = state.stopClass;
    return { by, retryable, kind: `${by} stop (${retryable ? "retryable" : "final"})` };
  }
  const reason = state.stopReason ?? "";
  const entry = CONTROLLER_STOP_CLASSES.find((c) => (typeof c.reason === "string" ? c.reason === reason : c.reason.test(reason)));
  if (entry === undefined) return { by: "controller", retryable: true, kind: "other" };
  return { by: "controller", retryable: entry.retryable, kind: entry.kind, ...(entry.liftedByResume === true ? { liftedByResume: true } : {}) };
}

const BUDGET_KEYS = ["agentInvocations", "jobs", "decisions", "corrections", "waitMs", "activeMs", "probes"] as const;

/** What a final stop depends on, as it is now. */
export function stopMarkOf(state: DurableRunState, candidateDigest: string | undefined): StopMark {
  return {
    ...(state.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
    activeVersion: state.activeVersion,
    manifestDigest: state.intake.bundle.manifestDigest,
    entryDigest: state.intake.bundle.entryDigest,
    ...(candidateDigest !== undefined ? { candidateDigest } : {}),
    budgets: { ...state.budgets },
  };
}

/** What changed since `mark` that a final stop depends on, or undefined when nothing did. */
export function changeSinceStop(mark: StopMark, now: { pluginUpdated: boolean; executorsUpdated?: boolean; mark: StopMark }): string | undefined {
  if (now.pluginUpdated) return "the operator updated the plugin";
  if (now.executorsUpdated === true) return "the operator updated the executors";
  if (now.mark.activeVersion !== mark.activeVersion) return `the active version changed from ${mark.activeVersion} to ${now.mark.activeVersion}`;
  if (now.mark.manifestDigest !== mark.manifestDigest || now.mark.entryDigest !== mark.entryDigest) return "the plugin bundle changed";
  if (now.mark.candidateDigest !== mark.candidateDigest) return "the workspace change differs from the one the run stopped on";
  for (const key of BUDGET_KEYS) {
    const before = mark.budgets[key];
    const after = now.mark.budgets[key];
    if (after !== undefined && after > (before ?? 0)) return `the ${key} budget was raised from ${before ?? 0} to ${after}`;
  }
  return undefined;
}

export const FINAL_STOP_HELD_REMEDY =
  "kept stopped on the same blocker: nothing the stop depends on (plugin, executors, active version, workspace change, budgets) changed since";

export type ResumeDecision =
  /** Run again: the stop was retryable, answered by the resume, or something it depends on changed. */
  | { run: true; previous?: StopClassification; lifted?: string }
  /** Surface the same blocker: a final stop with nothing changed. */
  | { run: false; previous: StopClassification };

/**
 * Whether a resume runs the run again. Called on the run as it stopped,
 * after resume reconciled its journals. A final stop without a mark (a run
 * that stopped before marks existed) is retried, as it was before.
 */
export function decideResume(
  state: DurableRunState,
  now: { pluginUpdated: boolean; executorsUpdated?: boolean; mark: StopMark },
): ResumeDecision {
  const previous = classifyStop(state);
  const mark = state.stopMark;
  const markApplies = mark !== undefined && (mark.stopReason === undefined || mark.stopReason === state.stopReason);
  if (previous === undefined || previous.retryable || previous.liftedByResume === true || !markApplies) {
    return { run: true, ...(previous !== undefined ? { previous } : {}) };
  }
  const lifted = changeSinceStop(mark!, now);
  return lifted !== undefined ? { run: true, previous, lifted } : { run: false, previous };
}

/** What the graph is told about this resume (`RunView.resume`). */
export function resumeView(state: DurableRunState, args: { generation: number; pluginUpdated: boolean; previous?: StopClassification }): ResumeView {
  return {
    generation: args.generation,
    at: new Date().toISOString(),
    pluginUpdated: args.pluginUpdated,
    ...(state.status === "stopped" && state.stopReason !== undefined ? { previousStopReason: state.stopReason } : {}),
    ...(args.previous !== undefined ? { previousStopRetryable: args.previous.retryable } : {}),
  };
}
