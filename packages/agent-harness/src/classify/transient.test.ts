// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { classifyTransient, retryAfterMs } from "./transient.js";

const CAPACITY = "Selected model is at capacity. Please try a different model.";

describe("classifyTransient", () => {
  it.each([
    ["codex", `Codex run failed: ${CAPACITY}`, "model at capacity"],
    ["codex", "Codex run failed: stream disconnected: ECONNRESET", "connection failure"],
    ["claude-code", "Claude Code run failed (success): API Error: 529 overloaded_error", "model overloaded"],
    ["claude-code", "Claude Code exited with code 1 and no result: API Error: 429 rate limit", "rate limited (429)"],
    ["pi", "agent request failed: 503 Service Unavailable", "provider server error (5xx)"],
    ["pi", "fetch failed: socket hang up", "connection failure"],
  ])("%s: %s", (harness, summary, reason) => {
    expect(classifyTransient(harness, summary)?.reason).toBe(reason);
  });

  it.each([
    ["codex", "Codex run failed: 401 unauthorized"],
    ["claude-code", "Claude Code run failed (error): Invalid API key"],
    ["claude-code", "Claude Code run failed (error): 400 invalid_request_error: overloaded prompt"],
    ["pi", "agent request failed: 403 forbidden"],
    ["codex", "Codex stalled: no activity for 600s"],
    ["codex", "could not start Codex (codex): spawn ENOENT"],
    ["claude-code", "Claude Code could not connect to the GraphLoom tool server"],
    ["pi", "agent session aborted"],
    ["codex", "Codex run failed: write outside the write scope: 503.txt"],
    // A missing structured result named like a provider error is a contract failure, not a rate limit.
    ["claude-code", "Claude Code returned no structured result: rate_limit"],
    // The harness names the executor actually reports; an unknown one is never retried.
    ["claude", "Claude Code run failed (success): API Error: 529 overloaded_error"],
  ])("never retries %s: %s", (harness, summary) => {
    expect(classifyTransient(harness, summary)).toBeUndefined();
  });

  it("parses retry-after forms", () => {
    expect(retryAfterMs("Retry-After: 20")).toBe(20_000);
    expect(retryAfterMs("please try again in 1m30s")).toBe(90_000);
    expect(retryAfterMs("retry after 500ms")).toBe(500);
    expect(retryAfterMs("no hint")).toBeUndefined();
  });
});
