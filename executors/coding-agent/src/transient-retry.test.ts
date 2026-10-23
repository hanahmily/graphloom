import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "@graphloom/sdk";
import { createCodexHarness } from "./codex.js";
import type { CodingHarness, CodingRunResult } from "./harness.js";
import { createCodingAgentExecutor } from "./run.js";
import { backoffMs, classifyTransient, resolveRetryPolicy, retryAfterMs, RETRY_MAX_ATTEMPTS_ENV } from "./transient.js";

const fakeCodex = fileURLToPath(new URL("../test/fake-codex.mjs", import.meta.url));
const CAPACITY = "Selected model is at capacity. Please try a different model.";

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const fail = (message: string) => [
  { event: { type: "thread.started", thread_id: "t1" } },
  { event: { type: "turn.failed", error: { message } } },
  { exit: 1 },
];
const success = [
  { event: { type: "thread.started", thread_id: "t1" } },
  { event: { type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } } },
  { last: "done" },
  { event: { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } } },
];

async function setupCodex(sequence: unknown[], retry = { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-transient-"));
  temps.push(dir);
  const worktree = path.join(dir, "worktree");
  await mkdir(worktree);
  const scriptFile = path.join(dir, "script.json");
  const logFile = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "codex");
  await writeFile(scriptFile, JSON.stringify({ sequence }), "utf8");
  await writeFile(bin, `#!/bin/sh\nexport FAKE_CODEX_SCRIPT="${scriptFile}" FAKE_CODEX_LOG="${logFile}"\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`, "utf8");
  await chmod(bin, 0o755);
  const delays: number[] = [];
  const executor = createCodingAgentExecutor(createCodexHarness({ command: bin, killGraceMs: 500 }), {
    retry,
    sleep: async (ms) => (delays.push(ms), true),
  });
  let reservations = 0;
  const ctx: ExecutorContext = {
    runId: "r1",
    operationId: "op1",
    generation: 1,
    worktreePath: worktree,
    artifactDir: dir,
    readOnly: true,
    usage: { reserveModelCall: async () => (reservations++, true) },
  };
  const invocations = async () => (existsSync(logFile) ? (await readFile(logFile, "utf8")).split("\n").filter(Boolean).length : 0);
  return { executor, ctx, delays, invocations, reservations: () => reservations };
}

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, any> } }] }).evidence[0].payload.codingAgent;
}

describe("transient harness failure retry (codex fake binary)", () => {
  it("retries capacity twice then succeeds, recording both retries and counting every attempt's model call", async () => {
    const h = await setupCodex([fail(CAPACITY), fail(CAPACITY), success]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx);
    expect(result).toMatchObject({ status: "ok" });
    expect(await h.invocations()).toBe(3);
    const p = payload(result);
    expect(p.attempts).toBe(3);
    expect(p.retries).toMatchObject([
      { attempt: 1, reason: "model at capacity", delayMs: 5 },
      { attempt: 2, reason: "model at capacity", delayMs: 10 },
    ]);
    expect(p.retries[0].failure).toContain(CAPACITY);
    expect(h.delays).toEqual([5, 10]);
    expect(p.modelCalls).toBe(3);
    expect(h.reservations()).toBe(3);
  });

  it("fails with a summary naming the transient cause once every attempt hit capacity", async () => {
    const h = await setupCodex([fail(CAPACITY)]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx);
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { summary: string }).summary).toMatch(/Transient harness failure \(model at capacity\); retries exhausted after 3 tries.*at capacity/);
    expect(await h.invocations()).toBe(3);
    expect(payload(result).retries).toHaveLength(2);
    expect(payload(result).modelCalls).toBe(3);
  });

  it("does not retry an auth error", async () => {
    const h = await setupCodex([fail("401 Unauthorized: invalid API key"), success]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx);
    expect(result).toMatchObject({ status: "failed" });
    expect(await h.invocations()).toBe(1);
    expect(payload(result).retries).toEqual([]);
    expect((result as { summary: string }).summary).not.toContain("Transient");
  });

  it("honors a reported retry-after, capped at the ceiling", async () => {
    const h = await setupCodex([fail("429 Too Many Requests. Retry after 15 ms"), fail("429 rate limited, retry-after: 90"), success]);
    const result = await h.executor.execute({ assignment: "work" }, h.ctx);
    expect(result).toMatchObject({ status: "ok" });
    expect(h.delays).toEqual([15, 20]);
  });

  it("can be disabled with maxAttempts 1", async () => {
    const h = await setupCodex([fail(CAPACITY), success], { maxAttempts: 1, baseDelayMs: 5, maxDelayMs: 20 });
    const result = await h.executor.execute({ assignment: "work" }, h.ctx);
    expect(result).toMatchObject({ status: "failed" });
    expect(await h.invocations()).toBe(1);
  });
});

function flaky(name: string, outcomes: Array<CodingRunResult | (() => Promise<CodingRunResult>)>, resumable = true): CodingHarness & { runs: () => number } {
  let n = 0;
  return {
    name,
    resumable,
    runs: () => n,
    async createSession() {
      return {
        async run() {
          const o = outcomes[Math.min(n++, outcomes.length - 1)]!;
          return typeof o === "function" ? o() : o;
        },
      };
    },
  };
}
const failed = (summary: string): CodingRunResult => ({ status: "failed", summary });
const ok: CodingRunResult = { status: "completed", summary: "done" };

async function plainCtx(over: Partial<ExecutorContext> = {}): Promise<ExecutorContext> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-transient-ctx-"));
  temps.push(dir);
  return { runId: "r1", operationId: "op1", generation: 1, worktreePath: dir, artifactDir: dir, ...over };
}

describe("transient retry safety and abort", () => {
  it("stops promptly when the job aborts during a backoff wait", async () => {
    const h = flaky("codex", [failed(`Codex run failed: ${CAPACITY}`), ok]);
    const executor = createCodingAgentExecutor(h, { retry: { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 } });
    const controller = new AbortController();
    const started = Date.now();
    const pending = executor.execute({ assignment: "work" }, await plainCtx({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { summary: string }).summary).toContain("aborted while waiting to retry");
    expect(h.runs()).toBe(1);
  });

  it("does not retry a failed continuation whose worktree changed", async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "gl-transient-git-"));
    temps.push(worktree);
    execFileSync("git", ["-C", worktree, "init", "-q"]);
    const h = flaky("claude", [
      async () => {
        await writeFile(path.join(worktree, "partial.txt"), "half done");
        return failed("Claude Code run failed (error_during_execution): API Error: 529 overloaded_error");
      },
      ok,
    ]);
    const executor = createCodingAgentExecutor(h, { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    const result = await executor.execute(
      { assignment: "continue" },
      await plainCtx({ worktreePath: worktree, session: { dir: worktree, resume: "ref-1" } }),
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { summary: string }).summary).toMatch(/Transient harness failure \(model overloaded\); not retried: .*changed the worktree/);
    expect(h.runs()).toBe(1);
  });

  it("retries a failed continuation when the worktree is unchanged", async () => {
    const worktree = await mkdtemp(path.join(os.tmpdir(), "gl-transient-git-"));
    temps.push(worktree);
    execFileSync("git", ["-C", worktree, "init", "-q"]);
    const h = flaky("claude", [failed("Claude Code exited with code 1 and no result: 503 Service Unavailable"), ok]);
    const executor = createCodingAgentExecutor(h, { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    const result = await executor.execute(
      { assignment: "continue" },
      await plainCtx({ worktreePath: worktree, session: { dir: worktree, resume: "ref-1" } }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ attempts: 2, continued: true });
  });

  it("does not retry a continuation when the worktree cannot be fingerprinted", async () => {
    const h = flaky("pi", [failed("agent request failed: 502 Bad Gateway"), ok]);
    const executor = createCodingAgentExecutor(h, { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    const result = await executor.execute({ assignment: "continue" }, await plainCtx({ session: { dir: os.tmpdir(), resume: "ref-1" } }));
    expect(result).toMatchObject({ status: "failed" });
    expect(h.runs()).toBe(1);
  });

  it("does not retry after a write tool call", async () => {
    const h: CodingHarness = {
      name: "codex",
      async createSession(options) {
        return {
          async run() {
            await options.tools[0]!.call("c1", {});
            return failed(`Codex run failed: ${CAPACITY}`);
          },
        };
      },
    };
    const executor = createCodingAgentExecutor(h, { retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 } });
    const result = await executor.execute(
      { assignment: "post" },
      await plainCtx({
        tools: { bindings: [{ name: "post_comment", effect: "write" }], call: async () => ({ status: "ok", summary: "posted" }) },
      }),
    );
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { summary: string }).summary).toContain("not retried");
  });
});

describe("classifyTransient", () => {
  it.each([
    ["codex", `Codex run failed: ${CAPACITY}`, "model at capacity"],
    ["codex", "Codex run failed: stream disconnected: ECONNRESET", "connection failure"],
    ["claude", "Claude Code run failed (success): API Error: 529 overloaded_error", "model overloaded"],
    ["claude", "Claude Code exited with code 1 and no result: API Error: 429 rate limit", "rate limited (429)"],
    ["pi", "agent request failed: 503 Service Unavailable", "provider server error (5xx)"],
    ["pi", "fetch failed: socket hang up", "connection failure"],
  ])("%s: %s", (harness, summary, reason) => {
    expect(classifyTransient(harness, summary)?.reason).toBe(reason);
  });

  it.each([
    ["codex", "Codex run failed: 401 unauthorized"],
    ["claude", "Claude Code run failed (error): Invalid API key"],
    ["claude", "Claude Code run failed (error): 400 invalid_request_error: overloaded prompt"],
    ["pi", "agent request failed: 403 forbidden"],
    ["codex", "Codex stalled: no activity for 600s"],
    ["codex", "could not start Codex (codex): spawn ENOENT"],
    ["claude", "Claude Code could not connect to the GraphLoom tool server"],
    ["pi", "agent session aborted"],
    ["codex", "Codex run failed: write outside the write scope: 503.txt"],
  ])("never retries %s: %s", (harness, summary) => {
    expect(classifyTransient(harness, summary)).toBeUndefined();
  });

  it("parses retry-after forms and computes bounded backoff", () => {
    expect(retryAfterMs("Retry-After: 20")).toBe(20_000);
    expect(retryAfterMs("please try again in 1m30s")).toBe(90_000);
    expect(retryAfterMs("retry after 500ms")).toBe(500);
    expect(retryAfterMs("no hint")).toBeUndefined();
    const p = { maxAttempts: 4, baseDelayMs: 10_000, maxDelayMs: 60_000 };
    expect([1, 2, 3, 4].map((a) => backoffMs(p, a))).toEqual([10_000, 20_000, 40_000, 60_000]);
    expect(backoffMs(p, 1, 30_000)).toBe(30_000);
  });

  it("reads limits from the environment unless options override them", () => {
    vi.stubEnv(RETRY_MAX_ATTEMPTS_ENV, "5");
    expect(resolveRetryPolicy().maxAttempts).toBe(5);
    expect(resolveRetryPolicy({ maxAttempts: 2 }).maxAttempts).toBe(2);
  });
});
