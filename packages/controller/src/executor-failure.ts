// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, ExecutorPin } from "@graphloom/sdk";
import { newEvidenceRef, type EvidenceProducer } from "./admit.js";
import type { DurableRunState } from "./state.js";

/** Longest wait an executor may request; larger requests are clamped so the retry time is a valid date. */
export const MAX_RETRY_AFTER_MS = 30 * 24 * 60 * 60_000;

export function boundedRetryAfter(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(Math.ceil(ms), MAX_RETRY_AFTER_MS);
}

export interface ExecutorFailure {
  producer: EvidenceProducer;
  stageId: string;
  attempt: number;
  executor: ExecutorPin | undefined;
  status: string;
  summary: string;
  retryAfterMs: number | undefined;
  /** The executor's own failure category, when it named one. */
  failureKind?: string | undefined;
  /** With `failureKind: "quota"`: when the allowance renews. */
  resetAt?: string | undefined;
}

/**
 * Record what the controller observed about a failed executor job. Built-in
 * and custom executors, called from the graph or as an agent's tool, fail
 * through the same result envelope, so recovery sees the same record for all
 * of them. A requested wait gates the next run of that executor.
 */
export function recordExecutorFailure(state: DurableRunState, failure: ExecutorFailure): DurableRunState {
  const retryAfterMs = boundedRetryAfter(failure.retryAfterMs);
  const retryAt = retryAfterMs !== undefined ? new Date(Date.now() + retryAfterMs).toISOString() : undefined;
  const record: EvidenceRecord = {
    ref: newEvidenceRef(state),
    kind: "other",
    generation: state.generation,
    payload: {
      executorFailure: {
        operationId: failure.producer.operationId,
        stageId: failure.stageId,
        attempt: failure.attempt,
        executor: failure.executor ?? null,
        status: failure.status,
        summary: failure.summary,
        ...(retryAt !== undefined ? { retryAfterMs, retryAt } : {}),
        ...(failure.failureKind !== undefined ? { failureKind: failure.failureKind } : {}),
        ...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
      },
      producer: failure.producer,
    },
  };
  const executorId = failure.executor?.id;
  return {
    ...state,
    evidence: [...state.evidence, record],
    ...(retryAt !== undefined && executorId !== undefined
      ? { executorRetryAt: { ...state.executorRetryAt, [executorId]: retryAt } }
      : {}),
    stateRevision: state.stateRevision + 1,
  };
}
