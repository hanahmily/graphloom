// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, GraphDecision } from "@graphloom/sdk";
import type { SupervisorInspection } from "@graphloom/supervisor";

/** How long a review may take before the reviewer counts as unavailable. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 5 * 60_000;

/** What the reviewer is given: the proposal, what it cites, and the read-only probe tools. */
export interface ProposalReviewRequest {
  runId: string;
  episodeId: string;
  triggerCode: string;
  /** The supervisor's proposal under review. */
  decision: GraphDecision;
  /** The recorded evidence the proposal cites, and the results of the episode's probes it cites (ref = probe id). */
  evidence: EvidenceRecord[];
  /** Provider calls this review may spend, present only when the reviewer implements `drainProviderCalls`. */
  maxProviderCalls?: number;
  /** The same evidence and probe surface the supervisor has; never a write tool. */
  inspect: SupervisorInspection;
  /** Ends with the run's stop, the turn, or the review timeout. */
  signal: AbortSignal;
}

export type ProposalVerdict =
  | { verdict: "confirm"; reason: string; evidenceRefs?: string[]; model?: string }
  | { verdict: "refute"; reason: string; evidenceRefs?: string[]; model?: string };

/**
 * An independent reviewer of a high-impact supervisor proposal. It runs in
 * its own session with no shared chat; the controller never learns what
 * model or provider is behind it.
 */
export interface ProposalReviewer {
  /** Must differ from the supervisor's session id. */
  sessionId: string;
  /** Wait bound for one review (default 5 minutes). A review that exceeds it is unavailable. */
  timeoutMs?: number;
  review(request: ProposalReviewRequest): Promise<ProposalVerdict>;
  /**
   * Provider calls the reviews since the last drain spent. Implementing it opts into
   * metering: the controller refuses a review when no `agentInvocations` are left, passes
   * the remainder as `maxProviderCalls`, and charges what this reports.
   */
  drainProviderCalls?(): number;
}

/**
 * The proposals worth a second opinion: a `stop`, and a `qualify_repair`
 * that says the validator or an executor is wrong. Routine actions are not reviewed.
 */
export function needsReview(decision: GraphDecision): boolean {
  const { action } = decision;
  if (action.type === "stop") return true;
  return action.type === "qualify_repair" && (action.qualify.target === "validator" || action.qualify.target === "executor");
}

export function citedRefs(decision: GraphDecision): string[] {
  const { action } = decision;
  const own =
    action.type === "stop"
      ? action.stop.evidenceRefs
      : action.type === "qualify_repair"
        ? action.qualify.evidenceRefs
        : undefined;
  return [...(decision.evidence ?? []), ...(own ?? [])];
}

/**
 * The reviewer's tools, opened per review with the signal that bounds them (the run's stop,
 * the review timeout, the review's end). `drain` settles whatever the tools had in flight.
 */
export type OpenReviewInspection = (signal: AbortSignal) => { inspect: SupervisorInspection; drain(): Promise<void> };

export type ReviewOutcome =
  | { kind: "confirmed"; reason: string; model?: string }
  | { kind: "refuted"; reason: string; evidenceRefs: string[]; model?: string }
  | { kind: "unavailable"; reason: string };

/** Run the review; any error, malformed verdict, or timeout is `unavailable`, never an approval. */
export async function runReview(
  reviewer: ProposalReviewer,
  request: Omit<ProposalReviewRequest, "signal" | "inspect"> & { openInspection: OpenReviewInspection },
  turnSignal: AbortSignal | undefined,
  supervisorSessionId: string | undefined,
): Promise<ReviewOutcome> {
  if (supervisorSessionId !== undefined && reviewer.sessionId === supervisorSessionId) {
    return { kind: "unavailable", reason: "the reviewer shares the supervisor's session, so it is not independent" };
  }
  const timeoutMs = reviewer.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  const signal = turnSignal === undefined ? timeout.signal : AbortSignal.any([turnSignal, timeout.signal]);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(timeout.signal.aborted ? `no verdict within ${timeoutMs} ms` : "the review was cancelled"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  // The tools end with the run's stop, the timeout, and the review itself: a probe still
  // running when the review is over must not persist anything afterwards.
  const ended = new AbortController();
  const { openInspection, ...rest } = request;
  const tools = openInspection(AbortSignal.any([signal, ended.signal]));
  try {
    const verdict = await Promise.race([reviewer.review({ ...rest, inspect: tools.inspect, signal }), aborted]);
    const reason = typeof verdict?.reason === "string" ? verdict.reason.trim() : "";
    if ((verdict?.verdict !== "confirm" && verdict?.verdict !== "refute") || reason === "") {
      return { kind: "unavailable", reason: "the reviewer returned no verdict with a reason" };
    }
    const model = typeof verdict.model === "string" ? { model: verdict.model } : {};
    return verdict.verdict === "confirm"
      ? { kind: "confirmed", reason, ...model }
      : {
          kind: "refuted",
          reason,
          evidenceRefs: Array.isArray(verdict.evidenceRefs) ? verdict.evidenceRefs.filter((r) => typeof r === "string") : [],
          ...model,
        };
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    ended.abort();
    await tools.drain();
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
