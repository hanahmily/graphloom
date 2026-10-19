/**
 * A resume retries what failed (docs/design-typescript-core.md §8, "Writing
 * plugins: resume"). An operator resumes because something changed (code,
 * config, environment, grants), so a failure recorded before the resume is
 * not by itself a reason to stop again. A decision that ends the run because
 * something failed only uses failures from after the latest resume; a
 * failure that recurs after it still stops the run, so a failing step
 * cannot loop.
 */
import type { EvidenceRecord, RunView } from "./types.js";

/** The failure the controller records when a job fails (`EvidenceRecord.payload.executorFailure`). */
export interface ExecutorFailureEvidence {
  operationId: string;
  stageId: string;
  attempt: number;
  status: string;
  summary: string;
  /** The failed job's purpose (`JobSpec.purpose`), when the controller recorded it. */
  purpose?: string;
}

/** The job failure a record holds, when it is one the controller recorded. */
export function executorFailureOf(record: EvidenceRecord): ExecutorFailureEvidence | undefined {
  const payload = record.payload;
  if (payload === null || typeof payload !== "object") return undefined;
  const failure = (payload as { executorFailure?: unknown }).executorFailure;
  if (failure === null || typeof failure !== "object") return undefined;
  const f = failure as Record<string, unknown>;
  if (typeof f.stageId !== "string" || typeof f.status !== "string") return undefined;
  const purpose = (payload as { producer?: { purpose?: unknown } }).producer?.purpose;
  return { ...(failure as ExecutorFailureEvidence), ...(typeof purpose === "string" ? { purpose } : {}) };
}

/**
 * Whether `record` predates the operator's latest resume, so a failure it
 * shows is stale: retry what failed instead of stopping on it. Nothing is
 * stale in a run never resumed. A record without a generation counts as the
 * oldest.
 */
export function isStaleFailure(record: Pick<EvidenceRecord, "generation">, view: Pick<RunView, "resume">): boolean {
  if (view.resume === undefined) return false;
  return (record.generation ?? 0) < view.resume.generation;
}

/**
 * Failures recorded since the operator's latest resume (all of them in a run
 * never resumed), oldest first. By default the job failures the controller
 * records; pass `isFailure` for a failure the plugin reads from its own
 * evidence, such as a command that ran but exited non-zero.
 */
export function failuresSinceResume(
  evidence: readonly EvidenceRecord[],
  view: Pick<RunView, "resume">,
  isFailure: (record: EvidenceRecord) => boolean = (record) => executorFailureOf(record) !== undefined,
): EvidenceRecord[] {
  return evidence.filter((record) => isFailure(record) && !isStaleFailure(record, view));
}
