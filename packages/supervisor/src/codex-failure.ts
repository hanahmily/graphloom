// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { classifyQuota, classifyTransient } from "@graphloom/agent-harness/classify";
import type { ProviderFailure } from "./provider-failure.js";

const HARNESS = "codex";
const MAX_MESSAGE_CHARS = 500;

/** The request outgrew the model's context window. */
const OVERFLOW = /context[_ ]length[_ ]exceeded|context window|maximum context length|ran out of room in the model'?s context|input (?:is too long|exceeds)/i;
/** Codex has no usable login. Codex 0.162 without one reports `401 Unauthorized: Missing bearer or basic authentication`. */
const AUTH =
  /not logged in|\b401\b|unauthorized|missing bearer|invalid[_ ]api[_ ]key|incorrect api key|(?:access|refresh|id) token (?:has )?(?:expired|been revoked|is invalid)|token_expired|please (?:log|sign) in|codex login/i;

function bound(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_MESSAGE_CHARS ? flat : `${flat.slice(0, MAX_MESSAGE_CHARS)}…`;
}

/**
 * A failed Codex turn's summary (`runCodexProcess`'s failure text) as the
 * host's provider failure (design-supervisor-harnesses.md §6.4), with the
 * shared classifiers: a usage limit is `quota` with its stated reset, an
 * oversized context is `overflow`, a missing or expired login is `auth`
 * (naming `codex login`), a provider-side error is `transient`, and
 * anything else `unknown`.
 */
export function classifyCodexFailure(summary: string, now: Date = new Date()): ProviderFailure {
  const message = bound(summary);
  const quota = classifyQuota(HARNESS, summary, now);
  if (quota !== undefined) return { failureClass: "quota", message, ...(quota.resetAt !== undefined ? { retryAt: quota.resetAt } : {}) };
  if (OVERFLOW.test(summary)) return { failureClass: "overflow", message };
  if (AUTH.test(summary)) return { failureClass: "auth", message: `${message} (log Codex in with \`codex login\`, then resume)` };
  const transient = classifyTransient(HARNESS, summary);
  if (transient !== undefined) {
    return {
      failureClass: "transient",
      message,
      ...(transient.retryAfterMs !== undefined ? { retryAt: new Date(now.getTime() + transient.retryAfterMs).toISOString() } : {}),
    };
  }
  return { failureClass: "unknown", message };
}
