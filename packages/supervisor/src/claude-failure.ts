// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { classifyQuota, classifyTransient } from "@graphloom/agent-harness/classify";
import type { ProviderFailure } from "./provider-failure.js";

const HARNESS = "claude-code";
const MAX_MESSAGE_CHARS = 500;

/** The request outgrew the model's context window. */
const OVERFLOW = /prompt is too long|context (?:length|window)(?: exceeded| limit)?|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|input length and `?max_tokens`? exceed/i;
/** Claude Code has no usable login. */
const AUTH =
  /not logged in|please run \/login|\/login to|invalid api key|oauth token (?:has )?(?:expired|revoked)|authentication[_ ](?:error|failed)|\b401\b|credit balance is too low/i;

function bound(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_MESSAGE_CHARS ? flat : `${flat.slice(0, MAX_MESSAGE_CHARS)}…`;
}

/**
 * A failed Claude Code turn's summary (`runClaudeProcess`'s failure text) as
 * the host's provider failure (design-supervisor-harnesses.md §6.4), with the
 * shared classifiers: a usage limit is `quota` with its stated reset, a
 * provider-side error is `transient`, an oversized context is `overflow`, a
 * missing login is `auth` (naming `claude /login`), and anything else
 * `unknown`.
 */
export function classifyClaudeFailure(summary: string, now: Date = new Date()): ProviderFailure {
  const message = bound(summary);
  const quota = classifyQuota(HARNESS, summary, now);
  if (quota !== undefined) return { failureClass: "quota", message, ...(quota.resetAt !== undefined ? { retryAt: quota.resetAt } : {}) };
  if (OVERFLOW.test(summary)) return { failureClass: "overflow", message };
  if (AUTH.test(summary)) return { failureClass: "auth", message: `${message} (log Claude Code in with \`claude /login\`, then resume)` };
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
