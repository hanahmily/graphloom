// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Why a supervisor turn produced no usable decision, read from the provider's
 * own last assistant message rather than inferred from missing JSON.
 *
 * - `quota`: rate limit or usage cap (HTTP 429 and provider equivalents).
 * - `overflow`: the request exceeded the model's context window.
 * - `auth`: the provider refused the credentials (HTTP 401/403 and equivalents).
 * - `transient`: the provider failed on its side and asked for a retry (HTTP
 *   500/502/503/504/529, Anthropic-style `api_error`/`overloaded_error`,
 *   "internal server error", "overloaded", "please retry" and equivalents).
 * - `interrupted`: the reply ended normally with no tool call and no text, but
 *   the provider billed output beyond its thinking that never arrived: the
 *   server dropped what the model generated (MiniMax drops tool calls this way).
 * - `empty`: the reply had no tool call and no text (including thinking-only
 *   replies with no undelivered output).
 * - `malformed`: the reply had text, but it was not a GraphDecision.
 * - `timeout`: the prompt produced no output for the inactivity limit, or no
 *   complete reply within its total cap (raised by the session, not read from a message).
 * - `unknown`: any other provider error.
 */
export type ProviderFailureClass =
  | "quota"
  | "overflow"
  | "auth"
  | "transient"
  | "interrupted"
  | "empty"
  | "malformed"
  | "timeout"
  | "unknown";

/**
 * Billed non-thinking output tokens above which a reply with no tool call and
 * no text counts as `interrupted`. Small enough to catch a dropped tool call
 * (live MiniMax failures billed ~576 such tokens; successful tool calls spend
 * 220-780), large enough to ignore a few tokens of framing or rounding.
 */
export const INTERRUPTED_OUTPUT_THRESHOLD = 32;

export interface ProviderFailure {
  failureClass: ProviderFailureClass;
  /** The provider's own message (bounded), or a description of what the reply lacked. */
  message: string;
  /** Interrupted only: output tokens billed beyond thinking that the reply did not carry. */
  undeliveredTokens?: number;
  /** Quota or transient: when the provider said to retry, if it said so. */
  retryAt?: string;
}

const MAX_MESSAGE_CHARS = 500;

/**
 * A supervisor turn that failed for a classified reason. `unremedied` says why
 * the host's deterministic remedy did not apply (no reset time, wait budget,
 * already retried once), so a stop can name it.
 */
export class SupervisorProviderError extends Error {
  readonly failureClass: ProviderFailureClass;
  readonly providerMessage: string;
  readonly retryAt: string | undefined;
  readonly unremedied: string | undefined;

  constructor(failure: ProviderFailure, unremedied?: string) {
    super(`supervisor provider ${failure.failureClass}: ${failure.message}`);
    this.name = "SupervisorProviderError";
    this.failureClass = failure.failureClass;
    this.providerMessage = failure.message;
    this.retryAt = failure.retryAt;
    this.unremedied = unremedied;
  }

  /** The same failure, annotated with why its remedy did not apply. */
  withUnremedied(reason: string): SupervisorProviderError {
    return new SupervisorProviderError(
      {
        failureClass: this.failureClass,
        message: this.providerMessage,
        ...(this.retryAt !== undefined ? { retryAt: this.retryAt } : {}),
      },
      reason,
    );
  }
}

/** Duck-typed so a host or controller can recognize the error across package instances. */
export function isSupervisorProviderError(value: unknown): value is SupervisorProviderError {
  if (!(value instanceof Error)) return false;
  const v = value as unknown as Record<string, unknown>;
  return typeof v.failureClass === "string" && typeof v.providerMessage === "string";
}

const QUOTA = /rate.?limit|too many requests|quota|usage limit|insufficient.?(?:balance|credit)|resource.?exhausted|throttl|用量上限|限流/i;
const TRANSIENT_STATUS = new Set(["500", "502", "503", "504", "529"]);
const TRANSIENT =
  /internal server error|overloaded|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|please retry|"type"\s*:\s*"(?:api_error|overloaded_error)"/i;
const AUTH = /unauthori[sz]ed|forbidden|invalid.{0,20}api.?key|api.?key.{0,20}invalid|authentication|permission denied|access denied/i;

/**
 * Classify the last assistant message of a turn. Returns undefined for a
 * reply that carries a tool call or text, or one the caller aborted (the
 * caller already knows why it aborted).
 */
export function classifyAssistantMessage(
  message: Pick<AssistantMessage, "stopReason" | "errorMessage" | "content"> & Partial<AssistantMessage>,
  options: { contextWindow?: number; now?: number } = {},
): ProviderFailure | undefined {
  if (message.stopReason === "aborted") return undefined;
  if (message.stopReason === "error") {
    const raw = message.errorMessage ?? "";
    const text = bound(raw === "" ? "provider error with no message" : raw);
    const status = /^\s*(\d{3})\b/.exec(raw)?.[1];
    if (status === "429" || QUOTA.test(raw)) {
      const retryAt = retryAtFromMessage(raw, options.now ?? Date.now());
      return { failureClass: "quota", message: text, ...(retryAt !== undefined ? { retryAt } : {}) };
    }
    if (isContextOverflow(message as AssistantMessage, options.contextWindow)) {
      return { failureClass: "overflow", message: text };
    }
    if (status === "401" || status === "403" || AUTH.test(raw)) {
      return { failureClass: "auth", message: text };
    }
    if ((status !== undefined && TRANSIENT_STATUS.has(status)) || TRANSIENT.test(raw)) {
      const retryAt = retryAtFromMessage(raw, options.now ?? Date.now());
      return { failureClass: "transient", message: text, ...(retryAt !== undefined ? { retryAt } : {}) };
    }
    return { failureClass: "unknown", message: text };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const hasToolCall = content.some((c) => c.type === "toolCall");
  const hasText = content.some((c) => c.type === "text" && c.text.trim() !== "");
  if (hasToolCall || hasText) return undefined;
  const thinkingOnly = content.some((c) => c.type === "thinking");
  const undelivered = undeliveredOutput(message);
  if (message.stopReason === "stop" && undelivered !== undefined && undelivered > INTERRUPTED_OUTPUT_THRESHOLD) {
    return {
      failureClass: "interrupted",
      message: `the reply ended (stopReason stop) with ${thinkingOnly ? "only thinking" : "no content"}, but the provider billed ${undelivered} output tokens beyond thinking that never arrived`,
      undeliveredTokens: undelivered,
    };
  }
  return {
    failureClass: "empty",
    message: thinkingOnly
      ? `the reply had only thinking, no tool call or text (stopReason ${message.stopReason})`
      : `the reply had no tool call or text (stopReason ${message.stopReason})`,
  };
}

/**
 * Output tokens billed beyond reasoning, when the provider reports both
 * (Pi's `usage.reasoning` is a subset of `usage.output`); undefined otherwise.
 */
function undeliveredOutput(message: Partial<AssistantMessage>): number | undefined {
  const usage = message.usage;
  if (usage === undefined || typeof usage.output !== "number" || typeof usage.reasoning !== "number") return undefined;
  return usage.output - usage.reasoning;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

/**
 * One `<number><unit>` part of a duration. Longer unit names come first so
 * `ms` is not read as minutes, and a unit only needs no letter after it, so
 * compact forms such as `1m30s` split into parts.
 */
const UNIT = String.raw`(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])`;
const PART = String.raw`\d+(?:\.\d+)?\s*${UNIT}`;
/** A whole duration: parts joined by nothing, spaces, commas, or "and" (`1h2m3s`, `2 hours and 5 minutes`). */
const DURATION = String.raw`${PART}(?:\s*(?:,\s*)?(?:and\s+)?${PART})*`;
const PART_GLOBAL = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*${UNIT}`, "gi");

/** Milliseconds a duration such as `1m30s` or `1 minute 30 seconds` adds up to. */
export function durationMs(text: string): number | undefined {
  let total = 0;
  let parts = 0;
  for (const m of text.matchAll(PART_GLOBAL)) {
    const factor = UNIT_MS[m[2]!.toLowerCase()];
    if (factor === undefined) return undefined;
    total += Number.parseFloat(m[1]!) * factor;
    parts += 1;
  }
  return parts > 0 && Number.isFinite(total) ? total : undefined;
}

/** Relative waits: each pattern's group 1 is a whole duration, or a bare number in the given unit. */
const RELATIVE: Array<{ pattern: RegExp; bareUnit?: string }> = [
  { pattern: /server requested (\d+(?:\.\d+)?)s\b/i, bareUnit: "s" },
  { pattern: /retry[- _]?after[- _]?ms["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)(?![\d.])/i, bareUnit: "ms" },
  { pattern: new RegExp(String.raw`retry[- _]?after["']?\s*[:=]?\s*["']?(${DURATION})`, "i") },
  // A bare number after "retry-after" is seconds, as in the HTTP header.
  { pattern: /retry[- _]?after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)(?![\d.:a-z-])/i, bareUnit: "s" },
  { pattern: new RegExp(String.raw`(?:try again|retry|resets?|available again)\s+in\s+(${DURATION})`, "i") },
];
const KEYWORD = String.raw`(?:resets?|reset_at|x-ratelimit-reset|retry[- _]?after|retry|available again)`;
const ABSOLUTE = new RegExp(
  String.raw`${KEYWORD}\s*(?:at|on|after|time)?["']?\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)`,
  "i",
);
const HTTP_DATE = new RegExp(
  String.raw`${KEYWORD}\s*(?:at|on)?["']?\s*[:=]?\s*["']?((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)`,
  "i",
);
const EPOCH = new RegExp(String.raw`${KEYWORD}\s*(?:at|on)?["']?\s*[:=]?\s*["']?(\d{10}(?:\d{3})?)(?![\d.])`, "i");

/**
 * The reset time a quota message states, if any: an ISO or HTTP date, a Unix
 * epoch (10 or 13 digits), or a relative wait ("retry after 30s", "try again
 * in 2 minutes"). Absolute forms are matched first, so a timestamp is never
 * read as a count of seconds. Another bare number after "retry-after" is
 * seconds, as in the HTTP header.
 */
export function retryAtFromMessage(message: string, now: number): string | undefined {
  for (const pattern of [ABSOLUTE, HTTP_DATE]) {
    const stamp = pattern.exec(message)?.[1];
    if (stamp === undefined) continue;
    const at = Date.parse(stamp);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  const epoch = EPOCH.exec(message)?.[1];
  if (epoch !== undefined) {
    const value = Number(epoch);
    const at = epoch.length > 10 ? value : value * 1_000;
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  for (const { pattern, bareUnit } of RELATIVE) {
    const captured = pattern.exec(message)?.[1];
    if (captured === undefined) continue;
    const ms = bareUnit !== undefined ? Number.parseFloat(captured) * UNIT_MS[bareUnit]! : durationMs(captured);
    if (ms !== undefined && Number.isFinite(ms) && ms >= 0) return new Date(now + Math.ceil(ms)).toISOString();
  }
  return undefined;
}

function bound(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_MESSAGE_CHARS ? flat : `${flat.slice(0, MAX_MESSAGE_CHARS)}…`;
}
