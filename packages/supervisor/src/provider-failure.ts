// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import { API_FAILURES, failurePatternsFor, GENERIC_FAILURES, matchesFailure, type FailurePatterns } from "./provider-profiles.js";

/**
 * Why a supervisor turn produced no usable decision, read from the provider's
 * own last assistant message rather than inferred from missing JSON.
 *
 * Provider-neutral: Pi reports every provider's HTTP failure the same way
 * (`<status> <message>`, `<status>: <body>`, or `<Provider> (<status>): ...`),
 * and names the model's `api` and `provider` on the message. The message is
 * matched against generic HTTP semantics, then its API family's error
 * vocabulary (OpenAI-style, Anthropic messages, Google, Bedrock), then its
 * provider's own overrides (provider-profiles.ts), so any provider Pi speaks
 * to, built-in or a models.json custom one, is classified the same way.
 *
 * - `quota`: rate limit or usage cap (HTTP 429, "insufficient balance" such as
 *   DeepSeek's 402, and provider equivalents).
 * - `overflow`: the request exceeded the model's context window.
 * - `auth`: the provider refused the credentials (HTTP 401/403 and equivalents).
 * - `transient`: the provider failed on its side and asked for a retry (HTTP
 *   408, 5xx including 529 and gateway 520-524, Anthropic-style
 *   `api_error`/`overloaded_error`, "internal server error", "overloaded",
 *   "please retry", a dropped connection, and equivalents).
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

/**
 * The HTTP status a provider error message carries, in the forms Pi's
 * adapters write: a leading status (`429 Rate limit...`, `429: {...}`), a
 * parenthesized one after a provider name (`DeepSeek (503): ...`), or a
 * `status`/`status code` field. Only 4xx/5xx codes count, so MiniMax's
 * four-digit `(2056)` codes and token counts are never read as one.
 */
export function httpStatusOf(message: string): string | undefined {
  const patterns = [
    /^\s*(?:error:?\s*)?([45]\d\d)\b/i,
    /\(([45]\d\d)\)/,
    /\bstatus(?:[ _]?code)?["']?\s*[:=]?\s*["']?([45]\d\d)\b/i,
    /\bHTTP\/?\d?(?:\.\d)?\s+([45]\d\d)\b/i,
  ];
  for (const pattern of patterns) {
    const status = pattern.exec(message)?.[1];
    if (status !== undefined) return status;
  }
  return undefined;
}

/**
 * The HTTP response a failed provider request returned, as the session saw it
 * (Pi's error message does not carry its headers): its status and the retry
 * headers an OpenAI-compatible provider sends with a 429 or 503.
 */
export interface ProviderResponseHint {
  status: number;
  /** `retry-after` (seconds or an HTTP date), `retry-after-ms`, and similar headers, lower-cased. */
  headers: Record<string, string>;
  /** When the response arrived (ms since epoch); relative headers count from here. */
  at?: number;
}

/** The retry time a response's headers state, if any (`retry-after-ms`, then `retry-after`). */
export function retryAtFromHeaders(headers: Record<string, string>, now: number): string | undefined {
  const ms = headers["retry-after-ms"]?.trim();
  if (ms !== undefined && ms !== "") {
    const value = Number.parseFloat(ms);
    if (Number.isFinite(value) && value >= 0) return new Date(now + Math.ceil(value)).toISOString();
  }
  const after = headers["retry-after"]?.trim();
  if (after !== undefined && after !== "") {
    if (/^\d+(?:\.\d+)?$/.test(after)) return new Date(now + Math.ceil(Number.parseFloat(after) * 1_000)).toISOString();
    const at = Date.parse(after);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return undefined;
}

/**
 * Classify the last assistant message of a turn. Returns undefined for a
 * reply that carries a tool call or text, or one the caller aborted (the
 * caller already knows why it aborted).
 */
export function classifyAssistantMessage(
  message: Pick<AssistantMessage, "stopReason" | "errorMessage" | "content"> & Partial<AssistantMessage>,
  options: {
    contextWindow?: number;
    now?: number;
    /** The failed HTTP response, when the session saw one (its retry headers). */
    response?: ProviderResponseHint;
    /** The model's Pi api and provider; default the message's own `api` and `provider`. */
    model?: { api?: string; provider?: string };
  } = {},
): ProviderFailure | undefined {
  if (message.stopReason === "aborted") return undefined;
  if (message.stopReason === "error") {
    const raw = message.errorMessage ?? "";
    const model = options.model ?? { ...(message.api !== undefined ? { api: message.api } : {}), ...(message.provider !== undefined ? { provider: message.provider } : {}) };
    // Without a known api, every API family's vocabulary applies.
    const layers: FailurePatterns[] = model.api !== undefined ? failurePatternsFor(model) : [GENERIC_FAILURES, ...Object.values(API_FAILURES), ...failurePatternsFor(model).slice(2)];
    const is = (errorClass: Parameters<typeof matchesFailure>[1]) => matchesFailure(layers, errorClass, raw, status);
    const text = bound(raw === "" ? "provider error with no message" : raw);
    const now = options.now ?? Date.now();
    const response = options.response !== undefined && options.response.status >= 400 ? options.response : undefined;
    const status: string | undefined = httpStatusOf(raw) ?? (response !== undefined ? String(response.status) : undefined);
    // The message's own reset time first; else the failed response's retry headers.
    const retryAtOf = () =>
      retryAtFromMessage(raw, now) ?? (response !== undefined ? retryAtFromHeaders(response.headers, response.at ?? now) : undefined);
    if (is("quota")) {
      const retryAt = retryAtOf();
      return { failureClass: "quota", message: text, ...(retryAt !== undefined ? { retryAt } : {}) };
    }
    if (isContextOverflow(message as AssistantMessage, options.contextWindow) || is("overflow")) {
      return { failureClass: "overflow", message: text };
    }
    if (is("auth")) {
      return { failureClass: "auth", message: text };
    }
    if (is("transient")) {
      const retryAt = retryAtOf();
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
  // Google's RetryInfo detail: "retryDelay": "30s".
  { pattern: /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i, bareUnit: "s" },
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
