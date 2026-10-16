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
import { wrapPiAgentSession, type PiSupervisorSession } from "./pi-session.js";
import { createPiSupervisor } from "./pi-supervisor.js";
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
  fauxProvider(options?: {
    provider?: string;
    models?: Array<{ id: string }>;
    tokensPerSecond?: number;
    tokenSize?: { min?: number; max?: number };
  }): Faux;
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string; errorMessage?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
  fauxThinking(text: string): unknown;
  fauxText(text: string): unknown;
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
  /** Open a wrapped Pi session on the faux provider; every one shares its response queue. */
  open(): Promise<PiSupervisorSession>;
  opened: number;
}

async function world(options: {
  inactivityMs: number;
  totalMs?: number;
  tokensPerSecond?: number;
}): Promise<World> {
  const ai = await loadPiAi();
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-timeout-"));
  temps.push(dir);
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
  const faux = ai.fauxProvider({
    provider: "faux-timeout",
    models: [{ id: "faux" }],
    ...(options.tokensPerSecond !== undefined ? { tokensPerSecond: options.tokensPerSecond, tokenSize: { min: 1, max: 1 } } : {}),
  });
  modelRuntime.registerNativeProvider(faux.provider as never);
  const w: World = {
    ai,
    faux,
    opened: 0,
    async open() {
      w.opened += 1;
      const { session } = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: faux.getModel() as never,
        thinkingLevel: "off",
        modelRuntime,
        noTools: "all",
        tools: [],
        sessionManager: SessionManager.inMemory(dir),
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      });
      return wrapPiAgentSession({
        session,
        modelRuntime,
        runId: "run-timeout",
        provider: "faux-timeout",
        modelId: "faux",
        agentDir: dir,
        credentialSource: "pi-stored",
        promptTimeoutMs: options.inactivityMs,
        ...(options.totalMs !== undefined ? { promptTotalTimeoutMs: options.totalMs } : {}),
      });
    },
  };
  return w;
}

/** A provider that accepts the request and then sends nothing until the request is aborted. */
function silent(w: World): Step {
  return (_context: unknown, streamOptions: { signal?: AbortSignal } | undefined) =>
    new Promise((resolve) => {
      const done = () => resolve(w.ai.fauxAssistantMessage([], { stopReason: "aborted" }));
      const signal = streamOptions?.signal;
      if (signal?.aborted) return done();
      signal?.addEventListener("abort", done, { once: true });
      // Never outlive the test, whatever happens to the abort.
      setTimeout(done, 20_000).unref();
    });
}

function stopTurn(w: World): Step {
  return w.ai.fauxAssistantMessage(
    w.ai.fauxToolCall("stop", { reason: "nothing left", stop: { reason: "no remedy", blocker: "none" } }),
    { stopReason: "toolUse" },
  );
}

function input(extra: Partial<SupervisorInput> = {}): SupervisorInput {
  const view: RunView = {
    runId: "run-timeout",
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
  return { runId: "run-timeout", episodeId: "ep-1", trigger: { code: "supervise", message: "stuck" }, view, maxProviderCalls: 20, ...extra };
}

async function failure(promise: Promise<unknown>): Promise<SupervisorProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isSupervisorProviderError(err)) throw new Error(`expected a SupervisorProviderError, got ${String(err)}`);
  return err;
}

describe("Pi supervisor prompt timeouts (faux provider)", () => {
  it("does not cut off a slow reply that keeps streaming past the inactivity limit", async () => {
    // ~1.3s of thinking and text, one small chunk every ~50ms; the limit is 400ms.
    const w = await world({ inactivityMs: 400, tokensPerSecond: 20 });
    const text = "The run is fine; return to the graph and let it finish its write stage.";
    w.faux.setResponses([w.ai.fauxAssistantMessage([w.ai.fauxThinking("Checking the trigger first."), w.ai.fauxText(text)])]);
    const session = await w.open();
    try {
      const started = Date.now();
      expect(await session.prompt("status?")).toBe(text);
      expect(Date.now() - started).toBeGreaterThan(800);
    } finally {
      await session.close();
    }
  });

  it("still caps a reply that streams for longer than the total limit", async () => {
    const w = await world({ inactivityMs: 400, totalMs: 500, tokensPerSecond: 20 });
    w.faux.setResponses([w.ai.fauxAssistantMessage("x ".repeat(200))]);
    const session = await w.open();
    try {
      const err = await failure(session.prompt("status?"));
      expect(err.failureClass).toBe("timeout");
      expect(err.providerMessage).toBe("no complete reply within 500ms");
    } finally {
      await session.close();
    }
  });

  it("retries a silent provider once in a fresh session, then stops naming the timeout", async () => {
    const w = await world({ inactivityMs: 300 });
    w.faux.setResponses([silent(w), silent(w), stopTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: () => w.open() });
    try {
      const err = await failure(supervisor.decide(input()));
      expect(err.failureClass).toBe("timeout");
      expect(err.message).toBe("supervisor provider timeout: no output for 300ms");
      expect(err.unremedied).toBe("already retried once");
      expect(w.faux.state.callCount).toBe(2);
      expect(w.opened).toBe(2);
      expect(supervisor.drainProviderCalls()).toBe(2);
      expect(supervisor.drainRemedies()).toMatchObject([
        { failureClass: "timeout", remedy: "fresh_session_retry", message: "no output for 300ms" },
      ]);
    } finally {
      await supervisor.close!();
    }
  });

  it("completes a silent-then-answered turn in one decide, recording the remedy", async () => {
    const w = await world({ inactivityMs: 300 });
    let retried: string | undefined;
    w.faux.setResponses([
      silent(w),
      (context: { messages: Array<{ content?: unknown }> }) => {
        retried = JSON.stringify(context.messages);
        return stopTurn(w);
      },
    ]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: () => w.open() });
    try {
      const proposal = await supervisor.decide(input());
      expect(proposal).toMatchObject({ action: { type: "stop" } });
      expect(w.faux.state.callCount).toBe(2);
      expect(w.opened).toBe(2);
      // The retry went to the fresh session with the whole recovery prompt, and none of the silent turn.
      expect(retried).toContain("Episode: ep-1");
      expect(supervisor.drainProviderCalls()).toBe(2);
      expect(supervisor.drainRemedies()).toMatchObject([{ failureClass: "timeout", remedy: "fresh_session_retry" }]);
    } finally {
      await supervisor.close!();
    }
  });

  it("does not retry a timeout without a provider call left in the turn's allowance", async () => {
    const w = await world({ inactivityMs: 300 });
    w.faux.setResponses([silent(w), stopTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: () => w.open() });
    try {
      const err = await failure(supervisor.decide(input({ maxProviderCalls: 1 })));
      expect(err.failureClass).toBe("timeout");
      expect(err.unremedied).toBe("no provider calls left in the run's budget to retry");
      expect(w.opened).toBe(1);
    } finally {
      await supervisor.close!();
    }
  });

  it("aborts promptly on Stop while waiting on a silent provider, without a timeout remedy", async () => {
    const w = await world({ inactivityMs: 10_000 });
    w.faux.setResponses([silent(w), stopTurn(w)]);
    const supervisor = createPiSupervisor({ session: await w.open(), openSession: () => w.open() });
    const abort = new AbortController();
    try {
      const started = Date.now();
      setTimeout(() => abort.abort(), 150);
      const err = await supervisor.decide(input({ signal: abort.signal })).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(isSupervisorProviderError(err)).toBe(false);
      expect((err as Error).message).toMatch(/aborted/);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(w.faux.state.callCount).toBe(1);
      expect(w.opened).toBe(1);
      expect(supervisor.drainRemedies()).toEqual([]);
    } finally {
      await supervisor.close!();
    }
  });
});
