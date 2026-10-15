import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Why a supervisor turn produced no usable decision, read from the provider's
 * own last assistant message rather than inferred from missing JSON.
 *
 * - `quota`: rate limit or usage cap (HTTP 429 and provider equivalents).
 * - `overflow`: the request exceeded the model's context window.
 * - `auth`: the provider refused the credentials (HTTP 401/403 and equivalents).
 * - `empty`: the reply had no tool call and no text (including thinking-only replies).
 * - `malformed`: the reply had text, but it was not a GraphDecision.
 * - `unknown`: any other provider error.
 */
export type ProviderFailureClass = "quota" | "overflow" | "auth" | "empty" | "malformed" | "unknown";

export interface ProviderFailure {
  failureClass: ProviderFailureClass;
  /** The provider's own message (bounded), or a description of what the reply lacked. */
  message: string;
  /** Quota only: when the provider said the limit resets, if it said so. */
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
    return { failureClass: "unknown", message: text };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const hasToolCall = content.some((c) => c.type === "toolCall");
  const hasText = content.some((c) => c.type === "text" && c.text.trim() !== "");
  if (hasToolCall || hasText) return undefined;
  const thinkingOnly = content.some((c) => c.type === "thinking");
  return {
    failureClass: "empty",
    message: thinkingOnly
      ? `the reply had only thinking, no tool call or text (stopReason ${message.stopReason})`
      : `the reply had no tool call or text (stopReason ${message.stopReason})`,
  };
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

const RELATIVE: Array<RegExp | [RegExp, string]> = [
  /server requested (\d+(?:\.\d+)?)\s*(s)\b/i,
  [/retry[- _]?after[- _]?ms["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/i, "ms"],
  /retry[- _]?after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?\b/i,
  /(?:try again|retry|resets?|available again)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i,
];
const ABSOLUTE = /(?:resets?|reset_at|retry)\s*(?:at|on|after|time)?["']?\s*[:=]?\s*["']?(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i;
const EPOCH = /(?:resets?|reset_at|x-ratelimit-reset)["']?\s*[:=]\s*["']?(\d{10}(?:\d{3})?)\b/i;

/**
 * The reset time a quota message states, if any: a relative wait ("retry
 * after 30s", "try again in 2 minutes"), an ISO timestamp, or a Unix epoch.
 * A bare number after "retry-after" is seconds, as in the HTTP header.
 */
export function retryAtFromMessage(message: string, now: number): string | undefined {
  for (const entry of RELATIVE) {
    const [pattern, fixedUnit] = Array.isArray(entry) ? entry : [entry, undefined];
    const m = pattern.exec(message);
    if (m?.[1] === undefined) continue;
    const unit = (fixedUnit ?? m[2] ?? "s").toLowerCase();
    const ms = Number.parseFloat(m[1]) * (UNIT_MS[unit] ?? 1_000);
    if (Number.isFinite(ms) && ms >= 0) return new Date(now + Math.ceil(ms)).toISOString();
  }
  const absolute = ABSOLUTE.exec(message)?.[1];
  if (absolute !== undefined) {
    const at = Date.parse(absolute);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  const epoch = EPOCH.exec(message)?.[1];
  if (epoch !== undefined) {
    const value = Number(epoch);
    const at = epoch.length > 10 ? value : value * 1_000;
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  return undefined;
}

function bound(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_MESSAGE_CHARS ? flat : `${flat.slice(0, MAX_MESSAGE_CHARS)}…`;
}
