// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { classifyAssistantMessage, httpStatusOf, retryAtFromHeaders, retryAtFromMessage } from "./provider-failure.js";

const error = (errorMessage: string) => ({ stopReason: "error" as const, errorMessage, content: [] });
const NOW = Date.parse("2026-10-15T00:00:00.000Z");

describe("classifyAssistantMessage", () => {
  it("classifies the provider errors seen in run 9bfa446d-4ea", () => {
    expect(
      classifyAssistantMessage(
        error('429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限 (2056)"}}'),
      ),
    ).toMatchObject({ failureClass: "quota", message: expect.stringMatching(/^429 .*\(2056\)/) });
    expect(
      classifyAssistantMessage(
        error('400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"}}'),
      ),
    ).toMatchObject({ failureClass: "overflow", message: expect.stringMatching(/context window exceeds limit \(2013\)/) });
  });

  it("classifies auth and unknown errors, and does not mistake a throttle for an overflow", () => {
    expect(classifyAssistantMessage(error("401 Unauthorized"))?.failureClass).toBe("auth");
    expect(classifyAssistantMessage(error("403 forbidden: invalid API key"))?.failureClass).toBe("auth");
    expect(classifyAssistantMessage(error("418 I'm a teapot"))?.failureClass).toBe("unknown");
    expect(classifyAssistantMessage(error("ThrottlingException: Too many tokens, please wait"))?.failureClass).toBe("quota");
    expect(classifyAssistantMessage(error(""))).toMatchObject({ failureClass: "unknown", message: "provider error with no message" });
  });

  it("classifies the transient provider error that stopped run cbef664d-c46", () => {
    const live = '{"type":"error","error":{"type":"api_error","message":"Internal server error. Please retry your request. (500)"}}';
    expect(classifyAssistantMessage(error(live))).toEqual({ failureClass: "transient", message: live });
  });

  it("classifies 5xx statuses and provider-side failure messages as transient", () => {
    for (const status of ["500", "502", "503", "504", "529"]) {
      expect(classifyAssistantMessage(error(`${status} upstream error`))?.failureClass, status).toBe("transient");
    }
    for (const message of [
      "Internal Server Error",
      "the model is OVERLOADED",
      "Service Unavailable",
      "bad gateway",
      "upstream temporarily unavailable",
      "something went wrong, please retry",
      '{"type":"error","error":{"type":"overloaded_error","message":"busy"}}',
      '{"type": "api_error", "message": "boom"}',
    ]) {
      expect(classifyAssistantMessage(error(message))?.failureClass, message).toBe("transient");
    }
    // 501 is not a retryable status; 429 stays quota and 401 auth even when they say "please retry".
    expect(classifyAssistantMessage(error("501 not implemented"))?.failureClass).toBe("unknown");
    expect(classifyAssistantMessage(error("429 too many requests, please retry"))?.failureClass).toBe("quota");
    expect(classifyAssistantMessage(error("401 Unauthorized, please retry"))?.failureClass).toBe("auth");
  });

  it("exposes the retry time a transient error states", () => {
    expect(classifyAssistantMessage(error("503 service unavailable; retry after 7s"), { now: NOW })).toMatchObject({
      failureClass: "transient",
      retryAt: "2026-10-15T00:00:07.000Z",
    });
    expect(classifyAssistantMessage(error("529 overloaded"), { now: NOW })?.retryAt).toBeUndefined();
  });

  it("classifies empty and thinking-only replies, and accepts replies with a tool call or text", () => {
    expect(classifyAssistantMessage({ stopReason: "stop", content: [] })?.failureClass).toBe("empty");
    expect(
      classifyAssistantMessage({ stopReason: "stop", content: [{ type: "thinking", thinking: "hmm" }] }),
    ).toMatchObject({ failureClass: "empty", message: expect.stringMatching(/only thinking/) });
    expect(classifyAssistantMessage({ stopReason: "stop", content: [{ type: "text", text: "  " }] })?.failureClass).toBe("empty");
    expect(classifyAssistantMessage({ stopReason: "stop", content: [{ type: "text", text: "{}" }] })).toBeUndefined();
    expect(
      classifyAssistantMessage({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "stop", arguments: {} }] }),
    ).toBeUndefined();
    expect(classifyAssistantMessage({ stopReason: "aborted", content: [] })).toBeUndefined();
  });

  it("classifies a thinking-only reply billed for undelivered output as interrupted", () => {
    const thinking = [{ type: "thinking" as const, thinking: "Let me write it." }];
    const usage = (output: number, reasoning?: number) =>
      ({ input: 1, output, cacheRead: 0, cacheWrite: 0, totalTokens: output + 1, ...(reasoning !== undefined ? { reasoning } : {}), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }) as never;
    // Live MiniMax failure: 3694 output tokens billed, 3118 of them thinking.
    expect(classifyAssistantMessage({ stopReason: "stop", content: thinking, usage: usage(3694, 3118) })).toEqual({
      failureClass: "interrupted",
      message: "the reply ended (stopReason stop) with only thinking, but the provider billed 576 output tokens beyond thinking that never arrived",
      undeliveredTokens: 576,
    });
    // No surplus beyond the threshold, no reasoning breakdown, or another stop reason: still empty.
    expect(classifyAssistantMessage({ stopReason: "stop", content: thinking, usage: usage(832, 800) })?.failureClass).toBe("empty");
    expect(classifyAssistantMessage({ stopReason: "stop", content: thinking, usage: usage(3694) })?.failureClass).toBe("empty");
    expect(classifyAssistantMessage({ stopReason: "length", content: thinking, usage: usage(3694, 3118) })?.failureClass).toBe("empty");
  });

  it("exposes the reset time a quota error states", () => {
    expect(classifyAssistantMessage(error("429 rate limit; retry after 30s"), { now: NOW })?.retryAt).toBe(
      "2026-10-15T00:00:30.000Z",
    );
    expect(classifyAssistantMessage(error(QUOTA_NO_RESET), { now: NOW })?.retryAt).toBeUndefined();
  });
});

const QUOTA_NO_RESET = '429 {"error":{"type":"rate_limit_error","message":"usage limit reached (2056)"}}';

describe("retryAtFromMessage", () => {
  it.each([
    ["Retry-After: 12", "2026-10-15T00:00:12.000Z"],
    ['"retry_after_ms": 1500', "2026-10-15T00:00:01.500Z"],
    ["please try again in 2 minutes", "2026-10-15T00:02:00.000Z"],
    ["quota resets in 1 hour", "2026-10-15T01:00:00.000Z"],
    ["Server requested 45s retry delay (max: 60s)", "2026-10-15T00:00:45.000Z"],
    ["limit resets at 2026-10-15T06:00:00Z", "2026-10-15T06:00:00.000Z"],
    ['"reset_at": 1792036800', new Date(1792036800 * 1000).toISOString()],
    // Compound durations are summed whole, compact or spelled out.
    ["Please try again in 1m30s", "2026-10-15T00:01:30.000Z"],
    ["retry after 1h2m3s", "2026-10-15T01:02:03.000Z"],
    ["try again in 1 minute 30 seconds", "2026-10-15T00:01:30.000Z"],
    ["quota resets in 2 hours and 5 minutes", "2026-10-15T02:05:00.000Z"],
    ["retry after 1 min, 15 sec", "2026-10-15T00:01:15.000Z"],
    ["try again in 1.5s", "2026-10-15T00:00:01.500Z"],
    ["retry after 500ms", "2026-10-15T00:00:00.500Z"],
    ["try again in 2m 500ms", "2026-10-15T00:02:00.500Z"],
    // Absolute times after "retry after" are times, not counts of seconds.
    ["429 rate limit; retry after 2026-10-16T00:00:00Z", "2026-10-16T00:00:00.000Z"],
    ["Retry-After: 1792036800", new Date(1792036800 * 1000).toISOString()],
    ["retry after 1792036800123", new Date(1792036800123).toISOString()],
    ["Retry-After: Fri, 16 Oct 2026 07:28:00 GMT", "2026-10-16T07:28:00.000Z"],
  ])("reads %j", (message, expected) => {
    expect(retryAtFromMessage(message, NOW)).toBe(expected);
  });

  it("finds nothing in a message without a reset time", () => {
    expect(retryAtFromMessage("429 Token Plan usage cap reached (2056)", NOW)).toBeUndefined();
  });
});

describe("provider-neutral HTTP failures", () => {
  it("reads the status in every form Pi's adapters write, never a MiniMax code", () => {
    expect(httpStatusOf("429 Rate limit reached for requests")).toBe("429");
    expect(httpStatusOf('503: {"error":"busy"}')).toBe("503");
    expect(httpStatusOf("OpenAI API error (429): slow down")).toBe("429");
    expect(httpStatusOf("429 status code (no body)")).toBe("429");
    expect(httpStatusOf('{"status": 502, "message": "bad"}')).toBe("502");
    expect(httpStatusOf("usage cap reached (2056)")).toBeUndefined();
    expect(httpStatusOf("billed 1500 tokens")).toBeUndefined();
  });

  it.each([
    ["429 status code (no body)", "quota"],
    ["DeepSeek (402): Insufficient Balance", "quota"],
    ["402 Insufficient Balance", "quota"],
    ["408 Request Timeout", "transient"],
    ["522 Connection timed out", "transient"],
    ["Connection error.", "transient"],
    ["fetch failed", "transient"],
    ["401 Authentication Fails, Your api key is invalid", "auth"],
    ["403 status code (no body)", "auth"],
  ])("classifies %j as %s", (message, expected) => {
    expect(classifyAssistantMessage({ ...error(message), api: "openai-completions", provider: "deepseek" })?.failureClass).toBe(expected);
  });

  it("waits as long as a failed response's Retry-After says, when the message states no time", () => {
    const at = NOW;
    expect(classifyAssistantMessage(error("429 status code (no body)"), { now: NOW, response: { status: 429, headers: { "retry-after": "12" }, at } })).toMatchObject({
      failureClass: "quota",
      retryAt: "2026-10-15T00:00:12.000Z",
    });
    expect(classifyAssistantMessage(error("503 overloaded"), { now: NOW, response: { status: 503, headers: { "retry-after-ms": "1500" }, at } })).toMatchObject({
      failureClass: "transient",
      retryAt: "2026-10-15T00:00:01.500Z",
    });
    // Without Retry-After the quota has no reset time (the host's quotaRetryMs, if any, applies).
    expect(classifyAssistantMessage(error("429 Too Many Requests"), { now: NOW, response: { status: 429, headers: {}, at } })?.retryAt).toBeUndefined();
    // The status comes from the response when the message carries none.
    expect(classifyAssistantMessage(error("request failed"), { now: NOW, response: { status: 429, headers: {}, at } })?.failureClass).toBe("quota");
    // The message's own reset time wins.
    expect(classifyAssistantMessage(error("429 retry after 30s"), { now: NOW, response: { status: 429, headers: { "retry-after": "5" }, at } })?.retryAt).toBe(
      "2026-10-15T00:00:30.000Z",
    );
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(retryAtFromHeaders({ "retry-after": "7" }, NOW)).toBe("2026-10-15T00:00:07.000Z");
    expect(retryAtFromHeaders({ "retry-after": "Thu, 15 Oct 2026 00:01:00 GMT" }, NOW)).toBe("2026-10-15T00:01:00.000Z");
    expect(retryAtFromHeaders({}, NOW)).toBeUndefined();
  });

  it("keys provider overrides on the provider: MiniMax's (2056) is a quota only there", () => {
    expect(classifyAssistantMessage({ ...error("usage cap reached (2056)"), api: "anthropic-messages", provider: "minimax-cn" })?.failureClass).toBe("quota");
    expect(classifyAssistantMessage({ ...error("odd failure (2056)"), api: "anthropic-messages", provider: "anthropic" })?.failureClass).toBe("unknown");
  });
});
