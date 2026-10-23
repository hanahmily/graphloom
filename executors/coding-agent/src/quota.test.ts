import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "@graphloom/sdk";
import { createClaudeCodeHarness } from "./claude.js";
import { classifyQuota, parseResetAt } from "./quota.js";
import { createCodingAgentExecutor } from "./run.js";
import { classifyTransient } from "./transient.js";

const fakeClaude = fileURLToPath(new URL("../test/fake-claude.mjs", import.meta.url));
const at = (iso: string) => new Date(iso);

describe("parseResetAt", () => {
  it("reads a 12-hour clock time in the stated zone, later today", () => {
    expect(parseResetAt("You've hit your session limit · resets 12:20pm (UTC)", at("2026-10-23T11:07:00Z"))?.toISOString()).toBe("2026-10-23T12:20:00.000Z");
    expect(parseResetAt("resets 9am (America/New_York)", at("2026-10-23T08:00:00Z"))?.toISOString()).toBe("2026-10-23T13:00:00.000Z");
  });

  it("rolls a clock time already past over to tomorrow, in the stated zone's calendar", () => {
    expect(parseResetAt("resets 12:20pm (UTC)", at("2026-10-23T12:21:00Z"))?.toISOString()).toBe("2026-10-24T12:20:00.000Z");
    // 12am is midnight, not noon.
    expect(parseResetAt("resets 12am (UTC)", at("2026-10-23T12:00:00Z"))?.toISOString()).toBe("2026-10-24T00:00:00.000Z");
    // 9:30 pm in Tokyo is already tomorrow in UTC.
    expect(parseResetAt("resets 9:30pm (Asia/Tokyo)", at("2026-10-23T13:00:00Z"))?.toISOString()).toBe("2026-10-24T12:30:00.000Z");
  });

  it("reads a dated reset, a relative wait, an ISO time and an epoch", () => {
    expect(parseResetAt("limit reached, resets Oct 28, 9am (UTC)", at("2026-10-23T00:00:00Z"))?.toISOString()).toBe("2026-10-28T09:00:00.000Z");
    expect(parseResetAt("resets Jan 2 at 3pm (UTC)", at("2026-10-23T00:00:00Z"))?.toISOString()).toBe("2027-01-02T15:00:00.000Z");
    expect(parseResetAt("try again in 3 days 4 hours 5 minutes.", at("2026-10-23T00:00:00Z"))?.toISOString()).toBe("2026-10-26T04:05:00.000Z");
    expect(parseResetAt("quota will reset after 30s", at("2026-10-23T00:00:00Z"))?.toISOString()).toBe("2026-10-23T00:00:30.000Z");
    expect(parseResetAt("quota resets at 2026-10-23T05:00:00Z", at("2026-10-23T00:00:00Z"))?.toISOString()).toBe("2026-10-23T05:00:00.000Z");
    expect(parseResetAt("Claude AI usage limit reached|1792000000", at("2026-10-23T00:00:00Z"))?.getTime()).toBe(1_792_000_000_000);
  });

  it("reads compact and compound durations without losing a component", () => {
    const base = at("2026-10-23T00:00:00Z");
    const after = (text: string) => (parseResetAt(text, base)!.getTime() - base.getTime()) / 60_000;
    expect(after("try again in 1h30m")).toBe(90);
    expect(after("try again in 2d3h")).toBe(2 * 1440 + 180);
    expect(after("try again in 1h 30m")).toBe(90);
    expect(after("try again in 90m")).toBe(90);
    expect(after("try again in 45s")).toBe(0.75);
  });

  it("gives no time for text that states none or names an unknown zone", () => {
    expect(parseResetAt("You've hit your session limit", at("2026-10-23T00:00:00Z"))).toBeUndefined();
    expect(parseResetAt("resets 3pm (Mars/Olympus)", at("2026-10-23T00:00:00Z"))).toBeUndefined();
  });
});

describe("classifyQuota", () => {
  const now = at("2026-10-23T11:07:00Z");
  it("recognizes each harness's usage-limit text", () => {
    expect(classifyQuota("claude-code", "Claude Code run failed (success): You've hit your session limit · resets 12:20pm (UTC)", now)).toEqual({
      reason: "usage limit",
      resetAt: "2026-10-23T12:20:00.000Z",
    });
    expect(classifyQuota("claude-code", "Claude Code run failed (success): 5-hour limit reached ∙ resets 3pm", now)?.reason).toBe("usage limit");
    expect(classifyQuota("codex", "Codex run failed: You've hit your usage limit. Upgrade to Pro, or try again in 2 hours 13 minutes.", now)).toEqual({
      reason: "usage limit",
      resetAt: "2026-10-23T13:20:00.000Z",
    });
    expect(classifyQuota("pi", "agent request failed: 429 You exceeded your current quota. Quota will reset after 90s", now)).toEqual({
      reason: "provider quota",
      resetAt: "2026-10-23T11:08:30.000Z",
    });
  });

  it("reports a usage limit without a stated reset as such, and leaves other failures alone", () => {
    expect(classifyQuota("claude-code", "Claude Code run failed (success): You've hit your session limit", now)).toEqual({ reason: "usage limit" });
    expect(classifyQuota("codex", "Codex run failed: Selected model is at capacity", now)).toBeUndefined();
    expect(classifyQuota("claude-code", "Claude Code run failed (error_during_execution): API Error: 429 rate limit", now)).toBeUndefined();
    // Not a provider failure shape: a contract failure that quotes the words is not a quota.
    expect(classifyQuota("claude-code", "agent finished without submitting a usage limit result", now)).toBeUndefined();
    expect(classifyQuota("unknown-harness", "Codex run failed: usage limit reached", now)).toBeUndefined();
  });

  it("leaves a short-window 429 to the transient backoff, and takes billing or plan quota as a usage allowance", () => {
    const rpm = "agent request failed: 429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'requests per minute'";
    expect(classifyQuota("pi", rpm, now)).toBeUndefined();
    expect(classifyTransient("pi", rpm)).toMatchObject({ reason: "rate limited (429)" });
    expect(classifyQuota("pi", "agent request failed: 429 RESOURCE_EXHAUSTED", now)).toBeUndefined();
    expect(classifyTransient("pi", "agent request failed: 429 RESOURCE_EXHAUSTED")).toMatchObject({ reason: "rate limited (429)" });
    expect(classifyQuota("pi", "agent request failed: 429 insufficient_quota", now)).toEqual({ reason: "provider quota" });
    expect(classifyQuota("pi", "agent request failed: You exceeded your current quota, please check your plan and billing", now)).toEqual({ reason: "provider quota" });
    expect(classifyQuota("claude-code", "Claude Code run failed (success): You've hit your session limit", now)).toEqual({ reason: "usage limit" });
    // A bare quota failure is an allowance only when it names a reset far beyond a backoff.
    expect(classifyQuota("pi", "agent request failed: RESOURCE_EXHAUSTED quota will reset after 30s", now)).toBeUndefined();
    expect(classifyQuota("pi", "agent request failed: RESOURCE_EXHAUSTED quota will reset after 2 hours", now)).toEqual({
      reason: "provider quota",
      resetAt: "2026-10-23T13:07:00.000Z",
    });
  });

  it("is never a transient failure to retry, even when it says to try again", () => {
    expect(classifyTransient("codex", "Codex run failed: You've hit your usage limit. Please try again later.")).toBeUndefined();
  });
});

describe("coding-agent executor on a usage limit (fake Claude Code)", () => {
  const temps: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
  });

  async function run(message: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-quota-"));
    temps.push(dir);
    const worktree = path.join(dir, "worktree");
    await mkdir(worktree);
    const scriptFile = path.join(dir, "script.json");
    const logFile = path.join(dir, "log.jsonl");
    const bin = path.join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nexport FAKE_CLAUDE_SCRIPT="${scriptFile}" FAKE_CLAUDE_LOG="${logFile}"\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, "utf8");
    await chmod(bin, 0o755);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "claude-config"));
    await writeFile(scriptFile, JSON.stringify({ start: [{ limit: message }], resume: [] }), "utf8");
    const sleeps: number[] = [];
    const executor = createCodingAgentExecutor(createClaudeCodeHarness({ command: bin, killGraceMs: 500 }), {
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      sleep: async (ms) => (sleeps.push(ms), true),
    });
    const ctx: ExecutorContext = {
      runId: "r1",
      operationId: "op1",
      generation: 1,
      worktreePath: worktree,
      artifactDir: dir,
      usage: { reserveModelCall: async () => true },
    };
    const result = await executor.execute({ assignment: "work" }, ctx);
    const calls = existsSync(logFile) ? (await readFile(logFile, "utf8")).split("\n").filter(Boolean).length : 0;
    return { result, sleeps, calls };
  }

  it("reports failureKind quota with the parsed reset, without retrying in the executor", async () => {
    const reset = new Date(Date.now() + 10 * 60_000);
    reset.setUTCSeconds(0, 0);
    const hour = reset.getUTCHours() % 12 || 12;
    const clock = `${hour}:${String(reset.getUTCMinutes()).padStart(2, "0")}${reset.getUTCHours() >= 12 ? "pm" : "am"}`;
    const { result, sleeps, calls } = await run(`You've hit your session limit · resets ${clock} (UTC)`);
    expect(result).toMatchObject({ status: "failed", failureKind: "quota", resetAt: reset.toISOString() });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("reports failureKind quota without resetAt when the message states no reset", async () => {
    const { result } = await run("You've hit your session limit");
    expect(result).toMatchObject({ status: "failed", failureKind: "quota" });
    expect(result).not.toHaveProperty("resetAt");
  });
});
