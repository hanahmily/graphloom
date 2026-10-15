import { describe, expect, it } from "vitest";
import { classifyAssistantMessage, retryAtFromMessage } from "./provider-failure.js";

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
    expect(classifyAssistantMessage(error("503 service unavailable"))?.failureClass).toBe("unknown");
    expect(classifyAssistantMessage(error("ThrottlingException: Too many tokens, please wait"))?.failureClass).toBe("quota");
    expect(classifyAssistantMessage(error(""))).toMatchObject({ failureClass: "unknown", message: "provider error with no message" });
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
