// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Everything provider-specific the Pi supervisor knows, in one place.
 *
 * GraphLoom treats a supervisor model as `<provider>/<modelId>` resolved
 * through Pi's model registry and Pi's auth (the provider's environment
 * variable, `auth.json`, or a models.json `apiKey`), with no provider branch
 * in its code paths. What remains is data, layered most general first:
 *
 * 1. generic HTTP/transport failure patterns (every provider);
 * 2. failure patterns of each Pi `api` family (OpenAI-style, Anthropic
 *    messages, Google, Bedrock, Mistral), which every provider speaking that
 *    API shares, built-in or a custom models.json provider;
 * 3. per-provider overrides on top (MiniMax's `(2056)` usage cap, DeepSeek's
 *    402 insufficient balance, Moonshot's quota error type), plus the two
 *    MiniMax behaviors kept for existing configs: its historical key
 *    variables and its empty thinking signatures.
 */
import type { ProviderFailureClass } from "./provider-failure.js";

/** The failure classes a provider error message can be mapped to. */
export type ErrorClass = Extract<ProviderFailureClass, "quota" | "overflow" | "auth" | "transient">;

/** Patterns and HTTP statuses that mark one class of provider error. */
export type FailurePatterns = Partial<Record<ErrorClass, { patterns?: readonly RegExp[]; statuses?: readonly string[] }>>;

/** Every provider: HTTP semantics and the wording OpenAI-compatible gateways share. */
export const GENERIC_FAILURES: FailurePatterns = {
  quota: {
    statuses: ["429"],
    patterns: [
      /rate.?limit/i,
      /too many requests/i,
      /quota/i,
      /usage limit/i,
      /insufficient.?(?:balance|credit|quota)/i,
      /resource.?exhausted/i,
      /throttl/i,
      /billing/i,
      /限流/,
      /余额不足/,
    ],
  },
  auth: {
    statuses: ["401", "403"],
    patterns: [
      /unauthori[sz]ed/i,
      /forbidden/i,
      /invalid.{0,20}api.?key/i,
      /api.?key.{0,20}(?:invalid|not valid)/i,
      /incorrect api key/i,
      /authentication/i,
      /permission denied/i,
      /access denied/i,
    ],
  },
  transient: {
    statuses: ["408", "500", "502", "503", "504", "520", "521", "522", "523", "524", "529"],
    patterns: [
      /internal server error/i,
      /overloaded/i,
      /service unavailable/i,
      /bad gateway/i,
      /gateway time-?out/i,
      /temporarily unavailable/i,
      /please retry/i,
      /try again later/i,
      /connection error/i,
      /socket hang up/i,
      /\bECONN(?:RESET|REFUSED)\b/,
      /\bETIMEDOUT\b/,
      /\bEAI_AGAIN\b/,
      /fetch failed/i,
      /network error/i,
    ],
  },
};

/** Pi `api` types grouped by the error vocabulary their providers share. */
export type ApiFamily = "openai" | "anthropic" | "google" | "bedrock" | "mistral" | "other";

export function apiFamily(api: string | undefined): ApiFamily {
  if (api === undefined) return "other";
  if (api.startsWith("openai-") || api === "azure-openai-responses") return "openai";
  if (api === "anthropic-messages") return "anthropic";
  if (api === "google-generative-ai" || api === "google-vertex") return "google";
  if (api === "bedrock-converse-stream") return "bedrock";
  if (api === "mistral-conversations") return "mistral";
  return "other";
}

/** Error vocabulary of each API family (error `type`/`code`/`status` fields as the APIs document them). */
export const API_FAILURES: Readonly<Record<ApiFamily, FailurePatterns>> = {
  // OpenAI Chat Completions / Responses and every OpenAI-compatible endpoint.
  openai: {
    quota: { patterns: [/insufficient_quota/, /rate_limit_exceeded/, /"code"\s*:\s*"?rate_limit/i] },
    auth: { patterns: [/invalid_api_key/, /"code"\s*:\s*"?invalid_api_key/i] },
    transient: { patterns: [/"type"\s*:\s*"server_error"/, /\bserver_error\b/] },
    overflow: { patterns: [/context_length_exceeded/] },
  },
  // Anthropic Messages (Claude API, MiniMax, Kimi For Coding, gateways).
  anthropic: {
    quota: { patterns: [/rate_limit_error/] },
    auth: { patterns: [/authentication_error/, /permission_error/] },
    transient: { patterns: [/"type"\s*:\s*"(?:api_error|overloaded_error)"/, /overloaded_error/] },
    overflow: { patterns: [/prompt is too long/i, /request_too_large/] },
  },
  // Gemini API and Vertex AI (google.rpc status names).
  google: {
    quota: { patterns: [/RESOURCE_EXHAUSTED/] },
    auth: { patterns: [/UNAUTHENTICATED/, /PERMISSION_DENIED/, /API_KEY_INVALID/] },
    transient: { patterns: [/"status"\s*:\s*"(?:UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED)"/, /\b(?:UNAVAILABLE|DEADLINE_EXCEEDED)\b/] },
  },
  // Amazon Bedrock Converse (AWS exception names).
  bedrock: {
    quota: { patterns: [/ThrottlingException/, /ServiceQuotaExceededException/] },
    auth: { patterns: [/AccessDeniedException/, /UnrecognizedClientException/, /ExpiredToken/] },
    transient: { patterns: [/ServiceUnavailableException/, /InternalServerException/, /ModelNotReadyException/] },
  },
  mistral: {},
  other: {},
};

/** Overrides for one provider's own wording, on top of its API family's. */
export const PROVIDER_FAILURES: Readonly<Record<string, FailurePatterns>> = {
  // MiniMax: 429 `(2056)` usage cap with no reset time; `(2013)` context window exceeded.
  minimax: { quota: { patterns: [/\(2056\)/, /用量上限/] }, overflow: { patterns: [/\(2013\)/] } },
  "minimax-cn": { quota: { patterns: [/\(2056\)/, /用量上限/] }, overflow: { patterns: [/\(2013\)/] } },
  // DeepSeek: 402 Insufficient Balance.
  deepseek: { quota: { statuses: ["402"] } },
  // Moonshot (Kimi): exceeded_current_quota_error / engine_overloaded_error.
  moonshotai: { quota: { patterns: [/exceeded_current_quota_error/] }, transient: { patterns: [/engine_overloaded_error/] } },
  "moonshotai-cn": { quota: { patterns: [/exceeded_current_quota_error/] }, transient: { patterns: [/engine_overloaded_error/] } },
};

/** The patterns that apply to a model: generic, then its API family's, then its provider's. */
export function failurePatternsFor(model: { api?: string; provider?: string }): FailurePatterns[] {
  const layers: FailurePatterns[] = [GENERIC_FAILURES, API_FAILURES[apiFamily(model.api)]];
  const own = model.provider !== undefined ? PROVIDER_FAILURES[model.provider] : undefined;
  if (own !== undefined) layers.push(own);
  return layers;
}

/** Whether any layer marks `message` (or its HTTP `status`) as `errorClass`. */
export function matchesFailure(layers: readonly FailurePatterns[], errorClass: ErrorClass, message: string, status: string | undefined): boolean {
  return layers.some((layer) => {
    const entry = layer[errorClass];
    if (entry === undefined) return false;
    if (status !== undefined && entry.statuses?.includes(status) === true) return true;
    return entry.patterns?.some((p) => p.test(message)) === true;
  });
}

/**
 * Environment variables GraphLoom reads itself, ahead of Pi's own resolution:
 * kept so existing MiniMax setups resolve exactly as before (`MINIMAX_CN_API_KEY`
 * first, then `MINIMAX_API_KEY`, for either MiniMax id, overriding auth.json).
 * Every other provider's variables are Pi's own.
 */
export const ENV_KEY_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  "minimax-cn": ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"],
  minimax: ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"],
};

/**
 * Model compat flags the supervisor needs for a provider on an API, applied to
 * a copy of the registry's model. MiniMax's Anthropic-messages endpoint emits
 * thinking blocks with an empty signature and accepts them back; without
 * `allowEmptySignature`, Pi replays such a block as plain text of the
 * assistant turn, so the model reads its own private reasoning as something
 * it said.
 */
export const SESSION_MODEL_COMPAT: ReadonlyArray<{ api: string; providers: readonly string[]; compat: Readonly<Record<string, unknown>> }> = [
  { api: "anthropic-messages", providers: ["minimax", "minimax-cn"], compat: { allowEmptySignature: true } },
];

/** The compat flags `SESSION_MODEL_COMPAT` adds for a model, if any. */
export function sessionModelCompat(model: { api?: string; provider?: string }): Readonly<Record<string, unknown>> | undefined {
  const entry = SESSION_MODEL_COMPAT.find((e) => e.api === model.api && model.provider !== undefined && e.providers.includes(model.provider));
  return entry?.compat;
}
