// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { classifyQuota } from "./quota.js";

export interface TransientFailure {
  /** Short name of the cause, e.g. "model at capacity". */
  reason: string;
  /** Provider-reported wait, when the failure text carries one. */
  retryAfterMs?: number;
}

/** Failures a retry cannot fix, checked first so a transient-looking word in them never wins. */
const PERMANENT =
  /\b(?:401|403|400|unauthori[sz]ed|forbidden|authentication|invalid[ _-]?(?:api[ _-]?key|x-api-key|request|request_error)|permission[ _-]denied|not[ _-]logged[ _-]in|invalid_request_error|bad request|context[ _-]length|insufficient[ _-](?:quota|credit)|billing|credit balance|write[ -]scope|outside (?:the )?(?:write )?scope|aborted|budget exhausted|could not start|stalled)\b/i;

const TRANSIENT: Array<[RegExp, string]> = [
  [/\bat capacity\b/i, "model at capacity"],
  [/\boverloaded(?:_error)?\b/i, "model overloaded"],
  [/\b429\b|too many requests|rate[ _-]?limit(?:ed)?/i, "rate limited (429)"],
  [/\b(?:500|502|503|504|529)\b|internal server error|bad gateway|service unavailable|gateway time-?out/i, "provider server error (5xx)"],
  [
    /\bECONNRESET\b|connection reset|socket hang up|\bEPIPE\b|\bETIMEDOUT\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|connection (?:closed|error|lost)|network error|fetch failed/i,
    "connection failure",
  ],
  [/temporarily unavailable|try again later/i, "provider temporarily unavailable"],
];

/** Where each harness puts a provider failure in its summary; start-up, stall and protocol failures fall outside these shapes and are never transient. */
export const FAILURE_SHAPE: Record<string, RegExp> = {
  codex: /^Codex run failed:/,
  "claude-code": /^Claude Code (?:run failed|exited with code)/,
  // Pi reports a provider error as `agent request failed:`, and a request that throws as the bare message.
  pi: /^(?:agent request failed:|(?!agent |could not|Pi ))/,
};

/** Parses "retry-after: 20", "retry after 20 seconds", "try again in 1m30s", "in 500ms". */
export function retryAfterMs(text: string): number | undefined {
  const m =
    /(?:retry[ _-]?after|try again in|retry in)[:= ]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s|minutes?|mins?|m)?(?:\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s))?/i.exec(text);
  if (m === null) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  let ms = unit.startsWith("ms") || unit.startsWith("milli") ? n : unit.startsWith("m") ? n * 60_000 : n * 1_000;
  if (m[3] !== undefined) ms += Number(m[3]) * 1_000;
  return Math.round(ms);
}

/** Classifies a failed run's summary; undefined means the failure is not worth retrying. */
export function classifyTransient(harness: string, summary: string): TransientFailure | undefined {
  // A harness without a known failure shape is never retried: its summaries cannot be told apart from contract failures.
  const shape = FAILURE_SHAPE[harness];
  if (shape === undefined || !shape.test(summary)) return undefined;
  // A usage limit renews at a reset time; a backoff retry only burns tries (see quota.ts).
  if (classifyQuota(harness, summary) !== undefined) return undefined;
  if (PERMANENT.test(summary)) return undefined;
  for (const [pattern, reason] of TRANSIENT) {
    if (pattern.test(summary)) {
      const wait = retryAfterMs(summary);
      return wait !== undefined ? { reason, retryAfterMs: wait } : { reason };
    }
  }
  return undefined;
}
