// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { trackFailedResponses } from "./provider-response.js";

type Options = { fetch?: typeof fetch };

/** A stand-in for Pi's agent: its stream function makes one request through the fetch it is given. */
function fakeSession(response: () => Response): { session: AgentSession; calls: Array<{ api: string; hadFetch: boolean }> } {
  const calls: Array<{ api: string; hadFetch: boolean }> = [];
  const agent = {
    streamFunction: async (model: { api: string }, _context: unknown, options?: Options) => {
      calls.push({ api: model.api, hadFetch: options?.fetch !== undefined });
      return options?.fetch !== undefined ? options.fetch("http://127.0.0.1:9/v1/chat") : undefined;
    },
  };
  return { session: { agent } as unknown as AgentSession, calls };
}

describe("trackFailedResponses", () => {
  it("keeps the status and retry headers of a failed response, passing the response through", async () => {
    const original = new Response("{}", { status: 429, headers: { "retry-after": "20", "x-secret": "never-kept" } });
    const { session } = fakeSession(() => original);
    const inner: typeof fetch = async () => original;
    const tracker = trackFailedResponses(session, () => 1_000);
    const agent = (session as unknown as { agent: { streamFunction: (m: unknown, c: unknown, o?: Options) => Promise<Response> } }).agent;
    const returned = await agent.streamFunction({ api: "openai-completions" }, {}, { fetch: inner });
    expect(returned).toBe(original);
    expect(tracker.last()).toEqual({ status: 429, headers: { "retry-after": "20" }, at: 1_000 });
    tracker.reset();
    expect(tracker.last()).toBeUndefined();
  });

  it("ignores successful responses and leaves APIs that do not use fetch untouched", async () => {
    const { session, calls } = fakeSession(() => new Response("{}"));
    const tracker = trackFailedResponses(session);
    const agent = (session as unknown as { agent: { streamFunction: (m: unknown, c: unknown, o?: Options) => Promise<unknown> } }).agent;
    await agent.streamFunction({ api: "anthropic-messages" }, {}, { fetch: async () => new Response("{}", { status: 200 }) });
    expect(tracker.last()).toBeUndefined();
    await agent.streamFunction({ api: "google-generative-ai" }, {}, {});
    expect(calls.at(-1)).toEqual({ api: "google-generative-ai", hadFetch: false });
  });

  it("tracks nothing on a Pi version without the wrapped stream function", () => {
    const tracker = trackFailedResponses({} as AgentSession);
    expect(tracker.last()).toBeUndefined();
  });
});
