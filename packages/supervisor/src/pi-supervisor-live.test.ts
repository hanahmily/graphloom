import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createAgentSession,
  ModelRuntime,
  parseSessionEntries,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RunView } from "@graphloom/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { wrapPiAgentSession } from "./pi-session.js";
import { createPiSupervisor, type ModelSwitchRecord, type PiSupervisor } from "./pi-supervisor.js";
import { reconcileSupervisorBinding } from "./restore.js";
import type { SupervisorInput } from "./types.js";

type Step = unknown;
interface Faux {
  provider: unknown;
  state: { callCount: number };
  setResponses(responses: Step[]): void;
}
interface FauxModule {
  fauxProvider(options?: { provider?: string; models?: Array<{ id: string }>; tokensPerSecond?: number }): Faux;
  fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
  fauxToolCall(name: string, args: Record<string, unknown>): unknown;
}

function findPackageDir(fromFile: string, pkg: string): string {
  for (const dir of createRequire(fromFile).resolve.paths(pkg) ?? []) {
    const candidate = path.join(dir, pkg);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  throw new Error(`${pkg} not found from ${fromFile}`);
}

async function loadPiAi(): Promise<FauxModule> {
  const piDir = findPackageDir(import.meta.filename, "@earendil-works/pi-coding-agent");
  const aiDir = findPackageDir(path.join(piDir, "package.json"), "@earendil-works/pi-ai");
  return (await import(pathToFileURL(path.join(aiDir, "dist", "index.js")).href)) as FauxModule;
}

const DEEPSEEK = { provider: "deepseek", modelId: "deepseek-chat" };
const MINIMAX = { provider: "minimax-cn", modelId: "MiniMax-M3" };
const OPENAI = { provider: "openai", modelId: "gpt-5" };
/** A real provider with no credentials in the temp agent dir or environment. */
const ANTHROPIC = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const CONFIGURED = [DEEPSEEK, MINIMAX, OPENAI, ANTHROPIC];

const temps: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function unsetEnv(...keys: string[]): void {
  for (const key of keys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

interface World {
  ai: FauxModule;
  dir: string;
  sessionDir: string;
  modelRuntime: ModelRuntime;
  faux: Record<"deepseek" | "minimax-cn" | "openai", Faux>;
}

async function fauxWorld(options: { openaiTokensPerSecond?: number } = {}): Promise<World> {
  const ai = await loadPiAi();
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-live-"));
  temps.push(dir);
  // Faux providers resolve their own auth; keep real MiniMax keys out of the test.
  unsetEnv("MINIMAX_CN_API_KEY", "MINIMAX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN");
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(dir, "auth.json"),
    modelsPath: path.join(dir, "models.json"),
  });
  const faux = {
    deepseek: ai.fauxProvider({ provider: DEEPSEEK.provider, models: [{ id: DEEPSEEK.modelId }] }),
    "minimax-cn": ai.fauxProvider({ provider: MINIMAX.provider, models: [{ id: MINIMAX.modelId }] }),
    openai: ai.fauxProvider({
      provider: OPENAI.provider,
      models: [{ id: OPENAI.modelId }],
      ...(options.openaiTokensPerSecond !== undefined ? { tokensPerSecond: options.openaiTokensPerSecond } : {}),
    }),
  };
  for (const f of Object.values(faux)) modelRuntime.registerNativeProvider(f.provider as never);
  return { ai, dir, sessionDir: path.join(dir, "sessions"), modelRuntime, faux };
}

async function openSupervisor(
  world: World,
  model: { provider: string; modelId: string },
  restore?: { sessionFile: string; switchJournal: ModelSwitchRecord[] },
): Promise<PiSupervisor> {
  const sessionManager =
    restore !== undefined
      ? SessionManager.open(restore.sessionFile, world.sessionDir, world.dir)
      : SessionManager.create(world.dir, world.sessionDir);
  const { session } = await createAgentSession({
    cwd: world.dir,
    agentDir: world.dir,
    model: world.modelRuntime.getModel(model.provider, model.modelId) as never,
    thinkingLevel: "off",
    modelRuntime: world.modelRuntime,
    noTools: "all",
    tools: [],
    sessionManager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  const wrapped = wrapPiAgentSession({
    session,
    modelRuntime: world.modelRuntime,
    runId: "run-live",
    provider: model.provider,
    modelId: model.modelId,
    agentDir: world.dir,
    credentialSource: "pi-stored",
    promptTimeoutMs: 10_000,
  });
  return createPiSupervisor({
    session: wrapped,
    configuredModels: CONFIGURED,
    ...(restore !== undefined ? { initialSwitchJournal: restore.switchJournal } : {}),
  });
}

function input(episodeId: string, extra: Partial<SupervisorInput> = {}): SupervisorInput {
  const view: RunView = {
    runId: "run-live",
    task: { request: "write hello", repo: "/repo" },
    current: { stageId: "write", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 8, jobs: 8, decisions: 8, corrections: 2 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 1,
    activeVersion: "hello@1",
  };
  return { runId: "run-live", episodeId, trigger: { code: "supervise", message: "stuck" }, view, ...extra };
}

function toolTurn(world: World, name: string, args: Record<string, unknown>): unknown {
  return world.ai.fauxAssistantMessage(world.ai.fauxToolCall(name, args), { stopReason: "toolUse" });
}

const stopCall = { reason: "nothing left", stop: { reason: "no remedy", blocker: "none" } };

/** A turn that records the conversation the provider was sent, then stops. */
function recordingStop(world: World, seen: string[]): Step {
  return (context: { messages: unknown[] }) => {
    seen.push(JSON.stringify(context.messages));
    return toolTurn(world, "stop", stopCall);
  };
}

async function sessionFiles(world: World): Promise<string[]> {
  return (await readdir(world.sessionDir)).filter((f) => f.endsWith(".jsonl"));
}

describe("Pi supervisor on a live session (faux providers)", () => {
  it("takes the decision from one admission tool call and ends the turn there", async () => {
    const world = await fauxWorld();
    world.faux.deepseek.setResponses([toolTurn(world, "stop", stopCall), world.ai.fauxAssistantMessage("unused")]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      const proposal = await supervisor.decide(input("ep-1"));
      expect(proposal).toEqual({ reason: "nothing left", action: { type: "stop", stop: stopCall.stop } });
      expect(world.faux.deepseek.state.callCount).toBe(1);
      expect(supervisor.drainProviderCalls()).toBe(1);
    } finally {
      await supervisor.close?.();
    }
  });

  it("returns invalid arguments to the model, which corrects them", async () => {
    const world = await fauxWorld();
    const seen: string[] = [];
    world.faux.deepseek.setResponses([
      toolTurn(world, "reenter", { reason: "retry write", reenter: { reason: "missing stage" } }),
      (context: { messages: unknown[] }) => {
        seen.push(JSON.stringify(context.messages));
        return toolTurn(world, "reenter", { reason: "retry write", reenter: { stageId: "write", reason: "fix" } });
      },
    ]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      const proposal = await supervisor.decide(input("ep-1"));
      expect(proposal).toEqual({ reason: "retry write", action: { type: "reenter", reenter: { stageId: "write", reason: "fix" } } });
      expect(seen[0]).toContain("must have required properties stageId");
      expect(supervisor.drainProviderCalls()).toBe(2);
    } finally {
      await supervisor.close?.();
    }
  });

  it("shows the stage's agent sessions and lets a dispatch continue one", async () => {
    const world = await fauxWorld();
    const seen: string[] = [];
    const job = {
      stageId: "write",
      kind: "agent",
      purpose: "work",
      instruction: "finish the greeting",
      writeScope: ["GREETING.txt"],
      continueFrom: "op-3-abc",
    };
    world.faux.deepseek.setResponses([
      (context: { messages: unknown[] }) => {
        seen.push(JSON.stringify(context.messages));
        return toolTurn(world, "dispatch", { reason: "keep the agent's context", job });
      },
    ]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    const base = input("ep-1");
    const agentSessions = [
      {
        operationId: "op-3-abc",
        stageId: "write",
        attempt: 1,
        generation: 1,
        dispatchKey: "work:graphloom.coding-agent/run",
        executorId: "graphloom.coding-agent/run",
        status: "failed" as const,
      },
    ];
    try {
      const proposal = await supervisor.decide({ ...base, view: { ...base.view, agentSessions } });
      expect(proposal).toEqual({ reason: "keep the agent's context", action: { type: "dispatch", job } });
      expect(seen[0]).toContain("job.continueFrom");
      expect(seen[0]).toContain("work:graphloom.coding-agent/run");
    } finally {
      await supervisor.close?.();
    }
  });

  it("proposes a switch only to configured models and falls back to a JSON reply without tools", async () => {
    const world = await fauxWorld();
    world.faux.deepseek.setResponses([
      toolTurn(world, "switch_model", { provider: "openrouter", modelId: "x", reason: "try" }),
      toolTurn(world, "switch_model", { provider: MINIMAX.provider, modelId: MINIMAX.modelId, reason: "cheaper" }),
      world.ai.fauxAssistantMessage('{"reason":"plain","action":{"type":"stop","stop":{"reason":"r","blocker":"b"}}}'),
    ]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      expect(await supervisor.decide(input("ep-1"))).toEqual({ type: "switch_model", ...MINIMAX, reason: "cheaper" });
      expect(await supervisor.decide(input("ep-1"))).toEqual({
        reason: "plain",
        action: { type: "stop", stop: { reason: "r", blocker: "b" } },
      });
    } finally {
      await supervisor.close?.();
    }
  });

  it("refuses a decide with no provider-call allowance and caps the turns it may take", async () => {
    const world = await fauxWorld();
    const invalid = () => toolTurn(world, "validate", { reason: "check", validate: { requirementIds: [] } });
    world.faux.deepseek.setResponses([invalid(), invalid(), invalid()]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      await expect(supervisor.decide(input("ep-1", { maxProviderCalls: 0 }))).rejects.toThrow(/no provider-call allowance/);
      expect(world.faux.deepseek.state.callCount).toBe(0);
      await expect(supervisor.decide(input("ep-1", { maxProviderCalls: 2 }))).rejects.toThrow(/2-turn allowance/);
      expect(world.faux.deepseek.state.callCount).toBe(2);
      expect(supervisor.drainProviderCalls()).toBe(2);
    } finally {
      await supervisor.close?.();
    }
  });

  it("keeps one session file across episodes and a restart", async () => {
    const world = await fauxWorld();
    const seen: string[] = [];
    world.faux.deepseek.setResponses([recordingStop(world, seen), recordingStop(world, seen), recordingStop(world, seen)]);
    const first = await openSupervisor(world, DEEPSEEK);
    await first.decide(input("ep-first"));
    await first.decide(input("ep-second"));
    const binding = first.binding;
    await first.close?.();

    const restored = await openSupervisor(world, DEEPSEEK, {
      sessionFile: binding.sessionFile!,
      switchJournal: binding.switchJournal,
    });
    try {
      await restored.decide(input("ep-third"));
      expect(restored.binding.sessionId).toBe(binding.sessionId);
      expect(seen[1]).toContain("ep-first");
      expect(seen[2]).toContain("ep-first");
      expect(seen[2]).toContain("ep-second");
      expect(await sessionFiles(world)).toEqual([path.basename(binding.sessionFile!)]);
    } finally {
      await restored.close?.();
    }
  });

  it("switches deepseek to minimax-cn to openai in the same session with history intact", async () => {
    const world = await fauxWorld();
    const seen: string[] = [];
    world.faux.deepseek.setResponses([recordingStop(world, seen)]);
    world.faux["minimax-cn"].setResponses([recordingStop(world, seen)]);
    world.faux.openai.setResponses([recordingStop(world, seen)]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      await supervisor.decide(input("ep-deepseek"));
      await supervisor.switchModel({ ...MINIMAX, reason: "operator" });
      await supervisor.decide(input("ep-minimax"));
      await supervisor.switchModel({ ...OPENAI, reason: "supervisor" });
      await supervisor.decide(input("ep-openai"));

      expect([world.faux.deepseek, world.faux["minimax-cn"], world.faux.openai].map((f) => f.state.callCount)).toEqual([1, 1, 1]);
      expect(seen[1]).toContain("ep-deepseek");
      expect(seen[2]).toContain("ep-deepseek");
      expect(seen[2]).toContain("ep-minimax");

      const binding = supervisor.binding;
      expect(binding).toMatchObject({ ...OPENAI, configuredModels: CONFIGURED });
      expect(binding.switchJournal.map((r) => [r.from.provider, r.to.provider, r.status])).toEqual([
        ["deepseek", "minimax-cn", "committed"],
        ["minimax-cn", "openai", "committed"],
      ]);
      expect(await sessionFiles(world)).toHaveLength(1);
      const entries = parseSessionEntries(await readFile(binding.sessionFile!, "utf8"));
      expect(entries.filter((e) => e.type === "model_change").map((e) => (e as { provider: string }).provider)).toEqual([
        "deepseek",
        "minimax-cn",
        "openai",
      ]);
    } finally {
      await supervisor.close?.();
    }
  });

  it("fails a switch to a provider without credentials and stays on the current model", async () => {
    const world = await fauxWorld();
    world.faux.deepseek.setResponses([toolTurn(world, "stop", stopCall), toolTurn(world, "stop", stopCall)]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      await supervisor.decide(input("ep-1"));
      await expect(supervisor.switchModel({ ...ANTHROPIC, reason: "try" })).rejects.toThrow(
        /credential unavailable for provider anthropic/,
      );
      expect(supervisor.binding).toMatchObject(DEEPSEEK);
      expect(supervisor.binding.switchJournal).toMatchObject([{ to: ANTHROPIC, status: "failed" }]);
      await supervisor.decide(input("ep-2"));
      expect(world.faux.deepseek.state.callCount).toBe(2);
    } finally {
      await supervisor.close?.();
    }
  });

  it("settles an interrupted switch from the session file's last model change", async () => {
    const world = await fauxWorld();
    world.faux.deepseek.setResponses([toolTurn(world, "stop", stopCall)]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    await supervisor.decide(input("ep-1"));
    await supervisor.switchModel({ ...MINIMAX, reason: "operator" });
    const sessionFile = supervisor.binding.sessionFile!;
    await supervisor.close?.();

    const intent = (from: typeof DEEPSEEK, to: typeof DEEPSEEK): ModelSwitchRecord => ({
      at: "2026-09-25T00:00:00.000Z",
      from,
      to,
      reason: "crash",
      status: "intent",
    });
    const base = { sessionId: "s", sessionFile, switchJournal: [] as ModelSwitchRecord[] };

    // Crashed after Pi recorded the change: committed.
    const landed = await reconcileSupervisorBinding({ ...base, ...DEEPSEEK, switchJournal: [intent(DEEPSEEK, MINIMAX)] });
    expect(landed).toMatchObject({ ...MINIMAX, switchJournal: [{ status: "committed" }] });

    // Crashed before Pi recorded the change: failed, stays on `from`.
    const lost = await reconcileSupervisorBinding({ ...base, ...MINIMAX, switchJournal: [intent(MINIMAX, OPENAI)] });
    expect(lost).toMatchObject({ ...MINIMAX, switchJournal: [{ status: "failed" }] });
    expect(lost.switchJournal[0]!.error).toMatch(/interrupted before commit/);
  });

  it("charges nothing for a decide aborted before its first provider request", async () => {
    const world = await fauxWorld();
    world.faux.deepseek.setResponses([toolTurn(world, "stop", stopCall)]);
    const supervisor = await openSupervisor(world, DEEPSEEK);
    try {
      const abort = new AbortController();
      abort.abort();
      await expect(supervisor.decide(input("ep-1", { signal: abort.signal }))).rejects.toThrow(/aborted/);
      expect(world.faux.deepseek.state.callCount).toBe(0);
      expect(supervisor.drainProviderCalls()).toBe(0);
    } finally {
      await supervisor.close?.();
    }
  });

  it("refuses to prompt a session that is still active after abort", async () => {
    let prompted = false;
    const stuck = {
      isIdle: false,
      sessionId: "stuck",
      sessionFile: undefined,
      abort: async () => undefined,
      prompt: async () => {
        prompted = true;
      },
      subscribe: () => () => undefined,
      dispose: () => undefined,
    };
    const wrapped = wrapPiAgentSession({
      session: stuck as never,
      modelRuntime: {} as never,
      runId: "run-stuck",
      provider: DEEPSEEK.provider,
      modelId: DEEPSEEK.modelId,
      agentDir: os.tmpdir(),
      credentialSource: "pi-stored",
      promptTimeoutMs: 1_000,
    });
    await expect(wrapped.prompt("next episode")).rejects.toThrow(/still active after abort; refusing to reuse it/);
    expect(prompted).toBe(false);
  });

  it("aborts a streaming decide on signal and leaves the session usable", async () => {
    const world = await fauxWorld({ openaiTokensPerSecond: 20 });
    world.faux.openai.setResponses([
      world.ai.fauxAssistantMessage("thinking about it ".repeat(200)),
      toolTurn(world, "stop", stopCall),
    ]);
    const supervisor = await openSupervisor(world, OPENAI);
    try {
      const abort = new AbortController();
      const pending = supervisor.decide(input("ep-1", { signal: abort.signal }));
      setTimeout(() => abort.abort(), 150);
      await expect(pending).rejects.toThrow(/aborted/);
      expect(await supervisor.decide(input("ep-2"))).toMatchObject({ action: { type: "stop" } });
    } finally {
      await supervisor.close?.();
    }
  });
});
