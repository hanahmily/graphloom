// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RunView } from "@graphloom/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { wrapPiAgentSession } from "./pi-session.js";
import { createPiSupervisor, type PiSupervisor } from "./pi-supervisor.js";
import { isSupervisorProviderError, type SupervisorProviderError } from "./provider-failure.js";
import type { SupervisorInput } from "./types.js";

type Step = unknown;
interface Faux {
  provider: unknown;
  state: { callCount: number };
  setResponses(responses: Step[]): void;
  getModel(): unknown;
}
interface FauxModule {
  fauxProvider(options?: { provider?: string; models?: Array<{ id: string }> }): Faux;
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string; errorMessage?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
  fauxThinking(text: string): unknown;
}

function findPackageDir(fromFile: string, pkg: string): string {
  for (const dir of createRequire(fromFile).resolve.paths(pkg) ?? []) {
    const candidate = path.join(dir, pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${pkg} not found from ${fromFile}`);
}

/** Pi's own pi-ai instance, wherever npm placed it. */
async function loadPiAi(): Promise<FauxModule> {
  const piDir = findPackageDir(import.meta.filename, "@earendil-works/pi-coding-agent");
  const aiDir = findPackageDir(path.join(piDir, "package.json"), "@earendil-works/pi-ai");
  return (await import(pathToFileURL(path.join(aiDir, "dist", "index.js")).href)) as FauxModule;
}

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface World {
  ai: FauxModule;
  faux: Faux;
  supervisor: PiSupervisor;
  /** Plain prompts to build history (compaction needs something to summarize). */
  warmUp(turns: number): Promise<void>;
  session: import("@earendil-works/pi-coding-agent").AgentSession;
  wrapped: ReturnType<typeof wrapPiAgentSession>;
}

async function world(
  options: { quotaRetryMs?: number; promptTimeoutMs?: number; transientRetryBaseMs?: number } = {},
): Promise<World> {
  const ai = await loadPiAi();
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-fail-"));
  temps.push(dir);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
  const faux = ai.fauxProvider({ provider: "faux-fail", models: [{ id: "faux" }] });
  modelRuntime.registerNativeProvider(faux.provider as never);
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel() as never,
    thinkingLevel: "off",
    modelRuntime,
    noTools: "all",
    tools: [],
    sessionManager: SessionManager.inMemory(dir),
    // Pi's own overflow recovery is off so the host's remedy is what runs.
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
      retry: { enabled: false },
    }),
  });
  const wrapped = wrapPiAgentSession({
    session,
    modelRuntime,
    runId: "run-fail",
    provider: "faux-fail",
    modelId: "faux",
    agentDir: dir,
    credentialSource: "pi-stored",
    promptTimeoutMs: options.promptTimeoutMs ?? 10_000,
  });
  const supervisor = createPiSupervisor({
    session: wrapped,
    ...(options.quotaRetryMs !== undefined ? { quotaRetryMs: options.quotaRetryMs } : {}),
    ...(options.transientRetryBaseMs !== undefined ? { transientRetryBaseMs: options.transientRetryBaseMs } : {}),
  });
  return {
    ai,
    faux,
    supervisor,
    session,
    wrapped,
    async warmUp(turns) {
      for (let i = 0; i < turns; i += 1) await wrapped.prompt(`history ${i} ${"x".repeat(200)}`);
      wrapped.drainTurnCount!();
    },
  };
}

function input(extra: Partial<SupervisorInput> = {}): SupervisorInput {
  const view: RunView = {
    runId: "run-fail",
    task: { request: "write hello", repo: "/repo" },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 20, jobs: 8, decisions: 8, corrections: 2 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 1,
    activeVersion: "hello@1",
  };
  return { runId: "run-fail", episodeId: "ep-1", trigger: { code: "supervise", message: "stuck" }, view, maxProviderCalls: 20, ...extra };
}

const stopCall = { reason: "nothing left", stop: { reason: "no remedy", blocker: "none" } };
const QUOTA_NO_RESET =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}';
const OVERFLOW =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"invalid params, context window exceeds limit (2013)"}}';

/** The error that stopped live run cbef664d-c46. */
const LIVE_500 = '{"type":"error","error":{"type":"api_error","message":"Internal server error. Please retry your request. (500)"}}';

function errorTurn(w: World, errorMessage: string): Step {
  return w.ai.fauxAssistantMessage([], { stopReason: "error", errorMessage });
}
function stopTurn(w: World): Step {
  return w.ai.fauxAssistantMessage(w.ai.fauxToolCall("stop", stopCall), { stopReason: "toolUse" });
}

/**
 * Provider steps for decision requests (the recovery prompt is the last
 * message), answering compaction's summarization requests with a summary.
 */
function decisionsAmongSummaries(w: World, decisions: Step[]): Step[] {
  const queue = [...decisions];
  const step = (context: { messages: Array<{ content?: unknown }> }) => {
    const last = JSON.stringify(context.messages.at(-1)?.content ?? "");
    if (last.includes("Episode: ep-1")) return queue.shift();
    return w.ai.fauxAssistantMessage("summary of earlier recovery turns");
  };
  return Array.from({ length: 8 }, () => step);
}

async function failure(promise: Promise<unknown>): Promise<SupervisorProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isSupervisorProviderError(err)) throw new Error(`expected a SupervisorProviderError, got ${String(err)}`);
  return err;
}

describe("Pi supervisor provider failures (faux provider)", () => {
  it("waits out a quota reset the provider states, retries the turn, and reports the wait", async () => {
    const w = await world();
    w.faux.setResponses([errorTurn(w, "429 Too Many Requests: rate limit reached, retry after 1s"), stopTurn(w)]);
    const started = Date.now();
    const proposal = await w.supervisor.decide(input({ maxWaitMs: 60_000 }));
    expect(proposal).toMatchObject({ action: { type: "stop" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(w.faux.state.callCount).toBe(2);
    expect(w.supervisor.drainProviderCalls()).toBe(2);
    const [remedy, ...more] = w.supervisor.drainRemedies();
    expect(more).toEqual([]);
    expect(remedy).toMatchObject({ failureClass: "quota", remedy: "wait_and_retry" });
    expect(remedy!.waitedMs).toBeGreaterThanOrEqual(900);
  });

  it("names quota and the provider message when no reset time is given", async () => {
    const w = await world();
    w.faux.setResponses([errorTurn(w, QUOTA_NO_RESET), stopTurn(w)]);
    const err = await failure(w.supervisor.decide(input({ maxWaitMs: 60_000 })));
    expect(err.failureClass).toBe("quota");
    expect(err.message).toMatch(/^supervisor provider quota: 429 .*\(2056\)/);
    expect(err.unremedied).toMatch(/no reset time/);
    expect(w.faux.state.callCount).toBe(1);
    expect(w.supervisor.drainRemedies()).toEqual([]);
  });

  it("does not wait past the run's wait budget", async () => {
    const w = await world();
    w.faux.setResponses([errorTurn(w, "429 rate limit exceeded; try again in 10 minutes"), stopTurn(w)]);
    const err = await failure(w.supervisor.decide(input({ maxWaitMs: 1_000 })));
    expect(err.failureClass).toBe("quota");
    expect(err.retryAt).toBeDefined();
    expect(err.unremedied).toMatch(/wait budget/);
    expect(w.faux.state.callCount).toBe(1);
  });

  it("compacts and retries once after a context overflow, charging the compaction", async () => {
    const w = await world();
    w.faux.setResponses(Array.from({ length: 3 }, (_, i) => w.ai.fauxAssistantMessage(`reply ${i}`)));
    await w.warmUp(3);
    w.supervisor.drainProviderCalls();
    const before = w.faux.state.callCount;
    w.faux.setResponses(decisionsAmongSummaries(w, [errorTurn(w, OVERFLOW), stopTurn(w)]));
    const proposal = await w.supervisor.decide(input());
    expect(proposal).toMatchObject({ action: { type: "stop" } });
    // overflowed turn + compaction (charged as its 2-call upper bound) + retried turn
    expect(w.supervisor.drainProviderCalls()).toBe(4);
    expect(w.faux.state.callCount - before).toBeGreaterThanOrEqual(3);
    expect(w.supervisor.drainRemedies()).toMatchObject([{ failureClass: "overflow", remedy: "compact_and_retry" }]);
  });

  it("stops naming overflow when the retried turn overflows again", async () => {
    const w = await world();
    w.faux.setResponses(Array.from({ length: 3 }, (_, i) => w.ai.fauxAssistantMessage(`reply ${i}`)));
    await w.warmUp(3);
    w.faux.setResponses(decisionsAmongSummaries(w, [errorTurn(w, OVERFLOW), errorTurn(w, OVERFLOW), stopTurn(w)]));
    const err = await failure(w.supervisor.decide(input()));
    expect(err.failureClass).toBe("overflow");
    expect(err.message).toMatch(/^supervisor provider overflow: 400 .*context window exceeds limit \(2013\)/);
    expect(err.unremedied).toMatch(/already compacted/);
  });

  it("re-asks once after a thinking-only reply", async () => {
    const w = await world();
    w.faux.setResponses([w.ai.fauxAssistantMessage([w.ai.fauxThinking("let me think about it")]), stopTurn(w)]);
    const proposal = await w.supervisor.decide(input());
    expect(proposal).toMatchObject({ action: { type: "stop" } });
    expect(w.faux.state.callCount).toBe(2);
    expect(w.supervisor.drainProviderCalls()).toBe(2);
    expect(w.supervisor.drainRemedies()).toMatchObject([{ failureClass: "empty", remedy: "reask", message: expect.stringMatching(/only thinking/) }]);
  });

  it("stops naming empty after the re-ask is empty too", async () => {
    const w = await world();
    w.faux.setResponses([w.ai.fauxAssistantMessage([]), w.ai.fauxAssistantMessage([]), stopTurn(w)]);
    const err = await failure(w.supervisor.decide(input()));
    expect(err.failureClass).toBe("empty");
    expect(err.unremedied).toMatch(/already re-asked/);
    expect(w.faux.state.callCount).toBe(2);
  });

  it("re-asks a malformed reply once (the single re-ask shared with empty replies), then names malformed", async () => {
    const fixed = await world();
    fixed.faux.setResponses([fixed.ai.fauxAssistantMessage("I think we should retry."), stopTurn(fixed)]);
    expect(await fixed.supervisor.decide(input())).toMatchObject({ action: { type: "stop" } });
    expect(fixed.faux.state.callCount).toBe(2);
    expect(fixed.supervisor.drainRemedies()).toMatchObject([{ failureClass: "malformed", remedy: "reask" }]);

    // An empty reply followed by a malformed one is not re-asked twice.
    const w = await world();
    w.faux.setResponses([w.ai.fauxAssistantMessage([]), w.ai.fauxAssistantMessage("still prose"), stopTurn(w)]);
    const err = await failure(w.supervisor.decide(input()));
    expect(err.failureClass).toBe("malformed");
    expect(err.message.startsWith("supervisor provider malformed: ")).toBe(true);
    expect(err.unremedied).toMatch(/already re-asked once/);
    expect(w.faux.state.callCount).toBe(2);
  });

  it("names auth and unknown failures without retrying them, and does not count them as inadmissible", async () => {
    const cases: Array<[string, Step[] | ((w: World) => Step[])]> = [
      ["auth", (w) => [errorTurn(w, "401 Unauthorized: invalid api key"), stopTurn(w)]],
      ["unknown", (w) => [errorTurn(w, "418 I am a teapot"), stopTurn(w)]],
    ];
    for (const [cls, steps] of cases) {
      const w = await world();
      w.faux.setResponses(typeof steps === "function" ? steps(w) : steps);
      let judged = 0;
      const admission: NonNullable<SupervisorInput["admission"]> = {
        facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
        check: async () => {
          judged += 1;
          return undefined;
        },
        refuse: async (action, reason) => {
          judged += 1;
          return { action, reason, remaining: 2 };
        },
      };
      const err = await failure(w.supervisor.decide(input({ maxWaitMs: 60_000, admission })));
      expect(err.failureClass).toBe(cls);
      expect(err.message.startsWith(`supervisor provider ${cls}: `)).toBe(true);
      expect(w.faux.state.callCount).toBe(1);
      expect(judged).toBe(0);
    }
  });

  it("charges a quota retry and a rejection re-ask to the same provider-call allowance", async () => {
    const w = await world();
    const reenterCall = { reason: "retry write", reenter: { stageId: "write", reason: "again" } };
    w.faux.setResponses([
      errorTurn(w, "429 rate limit; retry after 50ms"),
      w.ai.fauxAssistantMessage(w.ai.fauxToolCall("reenter", reenterCall), { stopReason: "toolUse" }),
      stopTurn(w),
    ]);
    let rejected = false;
    const admission: NonNullable<SupervisorInput["admission"]> = {
      facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
      check: async (decision) => {
        if (decision.action.type !== "reenter" || rejected) return undefined;
        rejected = true;
        return { action: "reenter", reason: "stage write is not open", remaining: 2 };
      },
      refuse: async (action, reason) => ({ action, reason, remaining: 2 }),
    };
    // Three calls are needed: the 429, the rejected reenter, and the admitted stop.
    // With two allowed, the retried prompt gets the one call left, and the
    // turn after the rejection is refused before its request.
    await expect(w.supervisor.decide(input({ maxWaitMs: 60_000, admission, maxProviderCalls: 2 }))).rejects.toThrow(
      /exceeded its 1-turn allowance/,
    );
    expect(w.supervisor.drainProviderCalls()).toBe(2);
    expect(w.faux.state.callCount).toBe(2);

    const ok = await world();
    ok.faux.setResponses([
      errorTurn(ok, "429 rate limit; retry after 50ms"),
      ok.ai.fauxAssistantMessage(ok.ai.fauxToolCall("reenter", reenterCall), { stopReason: "toolUse" }),
      stopTurn(ok),
    ]);
    rejected = false;
    const proposal = await ok.supervisor.decide(input({ maxWaitMs: 60_000, admission, maxProviderCalls: 3 }));
    expect(proposal).toMatchObject({ action: { type: "stop" } });
    expect(ok.supervisor.drainProviderCalls()).toBe(3);
    expect(ok.supervisor.drainRemedies()).toMatchObject([{ failureClass: "quota", remedy: "wait_and_retry" }]);
  });

  it("does not retry past the run's provider-call allowance", async () => {
    const w = await world();
    w.faux.setResponses([w.ai.fauxAssistantMessage([]), stopTurn(w)]);
    const err = await failure(w.supervisor.decide(input({ maxProviderCalls: 1 })));
    expect(err.failureClass).toBe("empty");
    expect(err.unremedied).toMatch(/no provider calls left/);
    expect(w.faux.state.callCount).toBe(1);
  });

  it("waits the operator's quotaRetryMs for a quota error with no reset time, and records it", async () => {
    const w = await world({ quotaRetryMs: 300 });
    w.faux.setResponses([errorTurn(w, QUOTA_NO_RESET), stopTurn(w)]);
    const started = Date.now();
    const proposal = await w.supervisor.decide(input({ maxWaitMs: 60_000 }));
    expect(proposal).toMatchObject({ action: { type: "stop" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(w.faux.state.callCount).toBe(2);
    const [remedy] = w.supervisor.drainRemedies();
    expect(remedy).toMatchObject({ failureClass: "quota", remedy: "wait_and_retry", waitBasis: "operator" });
    expect(remedy!.waitedMs).toBeGreaterThanOrEqual(250);
  });

  it("bounds the quotaRetryMs fallback by the wait budget and the per-turn wait limit", async () => {
    const overBudget = await world({ quotaRetryMs: 5_000 });
    overBudget.faux.setResponses([errorTurn(overBudget, QUOTA_NO_RESET), stopTurn(overBudget)]);
    const err = await failure(overBudget.supervisor.decide(input({ maxWaitMs: 1_000 })));
    expect(err.unremedied).toMatch(/quotaRetryMs wait is 5s; 1s of the run's wait budget remain/);
    expect(overBudget.faux.state.callCount).toBe(1);

    const persistent = await world({ quotaRetryMs: 10 });
    persistent.faux.setResponses(Array.from({ length: 5 }, () => errorTurn(persistent, QUOTA_NO_RESET)));
    const again = await failure(persistent.supervisor.decide(input({ maxWaitMs: 60_000 })));
    expect(again.unremedied).toMatch(/still over quota after 3 waits/);
    expect(persistent.faux.state.callCount).toBe(4);
  });

  it("aborts a compaction that never settles when the run stops, and when the prompt timeout passes", async () => {
    for (const how of ["stop", "timeout"] as const) {
      const w = await world({ promptTimeoutMs: how === "timeout" ? 200 : 10_000 });
      let aborted = 0;
      const pi = w.session as unknown as { compact: () => Promise<unknown>; abortCompaction: () => void };
      pi.compact = () => new Promise(() => undefined);
      pi.abortCompaction = () => {
        aborted += 1;
      };
      const stop = new AbortController();
      const pending = w.wrapped.compact!(how === "stop" ? { signal: stop.signal } : undefined);
      if (how === "stop") setTimeout(() => stop.abort(), 50);
      await expect(pending).rejects.toThrow(how === "stop" ? /compaction aborted/ : /compaction timed out after 200ms/);
      expect(aborted).toBe(1);
      expect(w.wrapped.drainTurnCount!()).toBe(2);
    }
  });

  it("backs off 2s and retries the turn after the 500 that stopped run cbef664d-c46", async () => {
    const w = await world();
    w.faux.setResponses([errorTurn(w, LIVE_500), stopTurn(w)]);
    const started = Date.now();
    const proposal = await w.supervisor.decide(input({ maxWaitMs: 60_000 }));
    expect(proposal).toMatchObject({ action: { type: "stop" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(w.faux.state.callCount).toBe(2);
    expect(w.supervisor.drainProviderCalls()).toBe(2);
    const [remedy, ...more] = w.supervisor.drainRemedies();
    expect(more).toEqual([]);
    expect(remedy).toMatchObject({ failureClass: "transient", remedy: "backoff_and_retry", waitBasis: "backoff", message: LIVE_500 });
    expect(remedy!.waitedMs).toBeGreaterThanOrEqual(1_900);
  });

  it("stops naming transient after three retries with exponential backoff", async () => {
    const w = await world({ transientRetryBaseMs: 20 });
    w.faux.setResponses(Array.from({ length: 5 }, () => errorTurn(w, LIVE_500)));
    const err = await failure(w.supervisor.decide(input({ maxWaitMs: 60_000 })));
    expect(err.failureClass).toBe("transient");
    expect(err.message).toBe(`supervisor provider transient: ${LIVE_500}`);
    expect(err.unremedied).toBe("still failing after 3 retries in this turn");
    expect(w.faux.state.callCount).toBe(4);
    expect(w.supervisor.drainProviderCalls()).toBe(4);
    const remedies = w.supervisor.drainRemedies();
    expect(remedies.map((r) => r.remedy)).toEqual(["backoff_and_retry", "backoff_and_retry", "backoff_and_retry"]);
    const waits = remedies.map((r) => r.waitedMs!);
    expect(waits[0]).toBeGreaterThanOrEqual(20);
    expect(waits[1]).toBeGreaterThanOrEqual(40);
    expect(waits[2]).toBeGreaterThanOrEqual(80);
  });

  it("honours a retry time the transient error states, and bounds backoff by the wait budget and call allowance", async () => {
    const stated = await world({ transientRetryBaseMs: 10 });
    stated.faux.setResponses([errorTurn(stated, "503 service unavailable; retry after 1s"), stopTurn(stated)]);
    const started = Date.now();
    await expect(stated.supervisor.decide(input({ maxWaitMs: 60_000 }))).resolves.toMatchObject({ action: { type: "stop" } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    const [remedy] = stated.supervisor.drainRemedies();
    expect(remedy).toMatchObject({ failureClass: "transient", remedy: "backoff_and_retry", waitBasis: "provider" });
    expect(remedy!.waitedMs).toBeGreaterThanOrEqual(900);

    const overBudget = await world({ transientRetryBaseMs: 5_000 });
    overBudget.faux.setResponses([errorTurn(overBudget, LIVE_500), stopTurn(overBudget)]);
    const err = await failure(overBudget.supervisor.decide(input({ maxWaitMs: 1_000 })));
    expect(err.unremedied).toBe("retry 1 needs a 5s backoff; 1s of the run's wait budget remain");
    expect(overBudget.faux.state.callCount).toBe(1);

    const noCalls = await world({ transientRetryBaseMs: 10 });
    noCalls.faux.setResponses([errorTurn(noCalls, LIVE_500), stopTurn(noCalls)]);
    const spent = await failure(noCalls.supervisor.decide(input({ maxWaitMs: 60_000, maxProviderCalls: 1 })));
    expect(spent.unremedied).toMatch(/no provider calls left/);
    expect(noCalls.faux.state.callCount).toBe(1);
  });

  it("lets the stop signal interrupt a transient backoff", async () => {
    const w = await world({ transientRetryBaseMs: 30_000 });
    w.faux.setResponses([errorTurn(w, LIVE_500), stopTurn(w)]);
    const stop = new AbortController();
    const started = Date.now();
    const pending = w.supervisor.decide(input({ maxWaitMs: 60_000, signal: stop.signal }));
    setTimeout(() => stop.abort(), 100);
    await expect(pending).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(w.faux.state.callCount).toBe(1);
    const [remedy] = w.supervisor.drainRemedies();
    expect(remedy).toMatchObject({ failureClass: "transient", remedy: "backoff_and_retry" });
    expect(remedy!.waitedMs).toBeLessThan(5_000);
  });

  it("keeps a 429 that says please retry as quota", async () => {
    const w = await world({ transientRetryBaseMs: 10 });
    w.faux.setResponses([errorTurn(w, "429 Too Many Requests. Please retry your request."), stopTurn(w)]);
    const err = await failure(w.supervisor.decide(input({ maxWaitMs: 60_000 })));
    expect(err.failureClass).toBe("quota");
    expect(err.unremedied).toMatch(/no reset time/);
    expect(w.faux.state.callCount).toBe(1);
    expect(w.supervisor.drainRemedies()).toEqual([]);
  });

  it("passes the run's stop signal to overflow compaction in decide", async () => {
    const w = await world();
    const pi = w.session as unknown as { compact: () => Promise<unknown>; abortCompaction: () => void };
    pi.compact = () => new Promise(() => undefined);
    pi.abortCompaction = () => undefined;
    w.faux.setResponses([errorTurn(w, OVERFLOW), stopTurn(w)]);
    const stop = new AbortController();
    const pending = w.supervisor.decide(input({ signal: stop.signal }));
    setTimeout(() => stop.abort(), 100);
    const err = await failure(pending);
    expect(err.failureClass).toBe("overflow");
    expect(err.unremedied).toMatch(/compaction failed: supervisor compaction aborted/);
  });
});
