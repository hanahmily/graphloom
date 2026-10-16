import type { EvidenceRecord } from "@graphloom/sdk";
import {
  isModelSwitchRequest,
  type SupervisorProposal,
  type SupervisorSettlement,
} from "@graphloom/supervisor";
import type { DurableRunState, SupervisorMark } from "./state.js";

const MAX_FACTS = 16;
const MAX_TEXT = 300;

/** Record a supervisor proposal before the controller admits it. */
export function markProposal(
  state: DurableRunState,
  proposal: SupervisorProposal,
  repeat?: { count: number; triggerCode: string },
): DurableRunState {
  const mark: SupervisorMark = {
    action: isModelSwitchRequest(proposal) ? "switch_model" : proposal.action.type,
    reason: bounded(proposal.reason),
    ...(state.recoveryEpisodeId !== undefined ? { episodeId: state.recoveryEpisodeId } : {}),
    ...(state.recoveryTrigger !== undefined ? { triggerCode: state.recoveryTrigger.code } : {}),
    stageId: state.current.stageId,
    attempt: state.current.attempt,
    generation: state.generation,
    evidenceRefs: state.evidence.map((e) => e.ref),
    receiptIds: state.receipts.map((r) => r.id),
    candidateDigest: state.candidateDigest ?? null,
    candidates: Object.fromEntries((state.repairCandidates ?? []).map((c) => [c.artifactId, c.status])),
    notes: [],
    ...(repeat !== undefined ? { repeat } : {}),
  };
  return { ...state, supervisorMark: mark };
}

/** Attach an outcome the controller observed directly to the last proposal. */
export function noteOutcome(state: DurableRunState, note: string): DurableRunState {
  if (state.supervisorMark === undefined) return state;
  return {
    ...state,
    supervisorMark: { ...state.supervisorMark, notes: [...state.supervisorMark.notes, bounded(note)] },
  };
}

/**
 * What the controller settled since the last proposal: new evidence and
 * receipts, repair-candidate transitions, and where the run now stands.
 * These are controller observations, not the supervisor's own claims.
 */
export function settleProposal(state: DurableRunState): SupervisorSettlement | undefined {
  const mark = state.supervisorMark;
  if (mark === undefined) return undefined;
  const facts = [...mark.notes];
  if (mark.repeat !== undefined) {
    facts.push(
      `this proposal (${mark.action}) is the ${ordinal(mark.repeat.count)} with no progress since it was last made, under the ${mark.repeat.triggerCode} trigger`,
    );
  }

  const knownEvidence = new Set(mark.evidenceRefs);
  for (const record of state.evidence) {
    if (!knownEvidence.has(record.ref)) facts.push(describeEvidence(record));
  }
  const knownReceipts = new Set(mark.receiptIds);
  for (const receipt of state.receipts) {
    if (!knownReceipts.has(receipt.id)) {
      facts.push(
        `receipt ${receipt.id} for ${receipt.requirementId} at stage ${receipt.stageId}: ${receipt.valid ? "valid" : "invalid"}`,
      );
    }
  }
  for (const candidate of state.repairCandidates ?? []) {
    const before = mark.candidates[candidate.artifactId];
    if (before === candidate.status) continue;
    const why = candidate.rejectionReason ?? candidate.reviewReason;
    facts.push(
      `repair candidate ${candidate.artifactId} (${candidate.target}): ${before ?? "new"} -> ${candidate.status}` +
        (why !== undefined ? `: ${why}` : ""),
    );
  }
  if (state.recoveryEpisodeId !== mark.episodeId) {
    facts.push(
      `the run returned to its graph and re-entered recovery: ${state.recoveryTrigger?.message ?? "recovery"}`,
    );
  }
  if (state.current.stageId !== mark.stageId || state.current.attempt !== mark.attempt) {
    facts.push(`current stage is ${state.current.stageId}, attempt ${state.current.attempt}`);
  }
  if (state.generation !== mark.generation) facts.push(`generation is now ${state.generation}`);
  // Marks from before #120 do not record the candidate.
  if (mark.candidateDigest !== undefined && mark.candidateDigest !== (state.candidateDigest ?? null)) {
    facts.push("the workspace candidate changed");
  }
  if (state.status !== "running") {
    facts.push(`the run ${state.status}${state.stopReason !== undefined ? `: ${state.stopReason}` : ""}`);
  }
  if (facts.length === 0) facts.push("no new evidence, receipts, or repair-candidate changes");

  const shown = facts.slice(0, MAX_FACTS).map(bounded);
  if (facts.length > MAX_FACTS) shown.push(`${facts.length - MAX_FACTS} more changes omitted`);
  return { action: mark.action, reason: mark.reason, facts: shown };
}

function describeEvidence(record: EvidenceRecord): string {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const failure = payload.executorFailure as
    | { stageId?: string; status?: string; summary?: string; retryAt?: string }
    | undefined;
  if (failure !== undefined) {
    return (
      `executor failure at stage ${failure.stageId ?? "?"} (${record.ref}): ${failure.status ?? "failed"}: ${failure.summary ?? ""}` +
      (failure.retryAt !== undefined ? ` (retry after ${failure.retryAt})` : "")
    );
  }
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  const verdict = typeof payload.verdict === "string" ? payload.verdict : undefined;
  const detail = [verdict, summary].filter((s) => s !== undefined).join(": ");
  return `${record.kind} evidence ${record.ref}${detail !== "" ? `: ${detail}` : ""}`;
}

function bounded(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}
