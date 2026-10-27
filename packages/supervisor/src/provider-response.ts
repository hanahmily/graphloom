// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ProviderResponseHint } from "./provider-failure.js";
import { FETCH_CAPABLE_APIS } from "./raw-stream.js";

/** Response headers that say when to retry; nothing else is kept (no credentials, no body). */
const RETRY_HEADERS = ["retry-after", "retry-after-ms"] as const;

/** APIs whose transport is not plain fetch by default (see raw-stream.ts); left untouched. */
const UNTRACKED_APIS: ReadonlySet<string> = new Set(["openai-codex-responses"]);

type StreamFn = (model: unknown, context: unknown, options?: { fetch?: typeof fetch } & Record<string, unknown>) => unknown;

/** The last failed provider response of a session, for classifying the error Pi reports without headers. */
export interface FailedResponseTracker {
  /** The last 4xx/5xx response since `reset`, if any. */
  last(): ProviderResponseHint | undefined;
  reset(): void;
}

/**
 * Track the HTTP status and retry headers of a session's failed provider
 * responses. Pi's adapters report an HTTP failure as a message only
 * (`429 Rate limit reached ...`), dropping the `Retry-After` header an
 * OpenAI-compatible provider sends with a 429 or 503; this keeps it so a quota
 * or transient failure can wait as long as the provider asked. The response
 * itself is passed through unchanged. A Pi version without the wrapped
 * stream function, or an API that does not use fetch, is simply not tracked.
 */
export function trackFailedResponses(session: AgentSession, now: () => number = Date.now): FailedResponseTracker {
  let last: ProviderResponseHint | undefined;
  const tracker: FailedResponseTracker = {
    last: () => last,
    reset: () => {
      last = undefined;
    },
  };
  // pi-agent-core's Agent keeps the stream function it calls in `streamFunction` (as raw-stream.ts uses).
  const agent = (session as unknown as { agent?: { streamFunction?: StreamFn } }).agent;
  const original = agent?.streamFunction;
  if (agent === undefined || typeof original !== "function") return tracker;
  agent.streamFunction = (model, context, options) => {
    const api = (model as { api?: unknown } | undefined)?.api;
    if (typeof api !== "string" || !FETCH_CAPABLE_APIS.has(api) || UNTRACKED_APIS.has(api)) {
      return original(model, context, options);
    }
    const inner = options?.fetch ?? globalThis.fetch;
    const tracking: typeof fetch = async (input, init) => {
      const response = await inner(input, init);
      if (response.status >= 400) {
        const headers: Record<string, string> = {};
        for (const name of RETRY_HEADERS) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        last = { status: response.status, headers, at: now() };
      }
      return response;
    };
    return original(model, context, { ...options, fetch: tracking });
  };
  return tracker;
}
