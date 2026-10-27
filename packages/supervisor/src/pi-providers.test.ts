// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * One provider-neutral Pi supervisor across representative providers and Pi
 * API types: built-in OpenAI (openai-responses), Anthropic (anthropic-messages),
 * Google Gemini (google-generative-ai), DeepSeek and Moonshot/Kimi
 * (openai-completions), MiniMax (anthropic-messages), and two models.json
 * custom providers (an OpenAI-compatible and an Anthropic-messages endpoint
 * whose `apiKey` references an environment variable). Every key is fake and
 * no request leaves the process: sessions open without a provider call and
 * episodes run on an already-aborted signal.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { RunView } from "@graphloom/sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { piProviderEnvVars, providerCredentialEnvVars, resolveProviderCredential } from "./credentials.js";
import type { SupervisorModelRef } from "./harness.js";
import { createPiHarness } from "./pi-harness.js";
import { ensureProviderCredentials } from "./pi-session.js";
import { classifyAssistantMessage } from "./provider-failure.js";
import { restorePiSupervisorFromBinding } from "./restore.js";

interface Case {
  name: string;
  provider: string;
  api: string;
  /** The environment variable that holds the key. */
  envVar: string;
  /** Defined in models.json rather than shipped by Pi. */
  custom?: boolean;
}

const CASES: Case[] = [
  { name: "OpenAI", provider: "openai", api: "openai-responses", envVar: "OPENAI_API_KEY" },
  { name: "Anthropic Claude (API key)", provider: "anthropic", api: "anthropic-messages", envVar: "ANTHROPIC_API_KEY" },
  { name: "Google Gemini", provider: "google", api: "google-generative-ai", envVar: "GEMINI_API_KEY" },
  { name: "DeepSeek", provider: "deepseek", api: "openai-completions", envVar: "DEEPSEEK_API_KEY" },
  { name: "Moonshot Kimi", provider: "moonshotai", api: "openai-completions", envVar: "MOONSHOT_API_KEY" },
  { name: "MiniMax", provider: "minimax-cn", api: "anthropic-messages", envVar: "MINIMAX_CN_API_KEY" },
  { name: "custom OpenAI-compatible", provider: "gl-test-openai-compat", api: "openai-completions", envVar: "GL_TEST_OPENAI_COMPAT_KEY", custom: true },
  { name: "custom Anthropic-messages", provider: "gl-test-anthropic-compat", api: "anthropic-messages", envVar: "GL_TEST_ANTHROPIC_COMPAT_KEY", custom: true },
];

/** Every variable any case's provider may read, cleared so the host's real keys never leak in. */
const ALL_VARS = [...new Set(CASES.flatMap((c) => [c.envVar, ...providerCredentialEnvVars(c.provider)]).concat(["MINIMAX_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]))];

const temps: string[] = [];
const saved: Record<string, string | undefined> = {};
let agentDir: string;
const modelOf: Record<string, SupervisorModelRef> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-providers-"));
  temps.push(dir);
  return dir;
}

/** A Pi agent dir with the two custom providers, each referencing its key variable. */
async function writeAgentDir(dir: string, auth: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  const providers = Object.fromEntries(
    CASES.filter((c) => c.custom).map((c) => [
      c.provider,
      { baseUrl: "http://127.0.0.1:9/v1", api: c.api, apiKey: `$${c.envVar}`, models: [{ id: `${c.provider}-model` }] },
    ]),
  );
  await writeFile(path.join(dir, "models.json"), JSON.stringify({ providers }));
}

const runtime = (dir: string) => ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });

beforeAll(async () => {
  for (const name of ALL_VARS) setEnv(name, undefined);
  const dir = await tempDir();
  await writeAgentDir(dir);
  const rt = await runtime(dir);
  for (const c of CASES) {
    const model = rt.getModels(c.provider)[0];
    if (model === undefined) throw new Error(`Pi's registry has no model for ${c.provider}`);
    expect(model.api, c.name).toBe(c.api);
    modelOf[c.provider] = { provider: c.provider, modelId: model.id };
  }
});

beforeEach(async () => {
  for (const name of ALL_VARS) setEnv(name, undefined);
  agentDir = path.join(await tempDir(), "agent");
  await writeAgentDir(agentDir);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const view: RunView = {
  runId: "run-1",
  task: { request: "hi", repo: "." },
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

const episode = (episodeId: string) => ({
  runId: "run-1",
  episodeId,
  trigger: { code: "supervise" as const, message: "help" },
  view,
  // Already stopped: the episode's session opens, and no provider request goes out.
  signal: AbortSignal.abort(),
});

describe.each(CASES)("the Pi supervisor on $name ($provider, $api)", (c) => {
  it("names the provider's key variable from Pi's own table", () => {
    if (c.custom) expect(piProviderEnvVars(c.provider)).toEqual([]);
    else expect(providerCredentialEnvVars(c.provider)).toContain(c.envVar);
    // Only MiniMax keeps GraphLoom-injected fallbacks; every other provider is Pi's to resolve.
    expect(resolveProviderCredential({ provider: c.provider, env: { [c.envVar]: "fake" } })).toEqual(
      c.provider === "minimax-cn" ? { apiKey: "fake", source: `env:${c.envVar}` } : {},
    );
  });

  it("resolves the credential from the environment, the models.json reference, or the auth store", async () => {
    await expect(ensureProviderCredentials({ modelRuntime: await runtime(agentDir), provider: c.provider, agentDir })).rejects.toThrow(
      new RegExp(`credential unavailable for provider ${c.provider}: .*${c.envVar}`),
    );
    setEnv(c.envVar, `fake-${c.provider}-key`);
    expect(await ensureProviderCredentials({ modelRuntime: await runtime(agentDir), provider: c.provider, agentDir })).toBe(`env:${c.envVar}`);
    setEnv(c.envVar, undefined);
    const stored = path.join(await tempDir(), "agent");
    await writeAgentDir(stored, { [c.provider]: { type: "api_key", key: `fake-stored-${c.provider}` } });
    expect(await ensureProviderCredentials({ modelRuntime: await runtime(stored), provider: c.provider, agentDir: stored })).toBe("pi-stored");
    expect(await ensureProviderCredentials({ modelRuntime: await runtime(agentDir), provider: c.provider, agentDir, apiKey: "fake-explicit" })).toBe("options");
  });

  it("probes without a provider call: refused without a key, passing with a fake one", async () => {
    const harness = createPiHarness({ runId: "run-1", sessionDir: path.join(agentDir, "..", "supervisor"), agentDir, configuredModels: [modelOf[c.provider]!] });
    const missing = await harness.probe();
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toMatch(c.envVar);
    setEnv(c.envVar, "fake-key");
    expect(await harness.probe()).toEqual({ ok: true });
  });

  it("classifies its API's quota, transient, auth, and overflow errors", () => {
    const error = (errorMessage: string) => ({ stopReason: "error" as const, errorMessage, content: [], api: c.api, provider: c.provider });
    const classOf = (m: string) => classifyAssistantMessage(error(m))?.failureClass;
    expect(classOf("429 Too Many Requests")).toBe("quota");
    expect(classOf("503 Service Unavailable")).toBe("transient");
    expect(classOf("401 Unauthorized")).toBe("auth");
    const quota = classifyAssistantMessage(error("429 rate limited"), { now: 0, response: { status: 429, headers: { "retry-after": "20" }, at: 0 } });
    expect(quota).toMatchObject({ failureClass: "quota", retryAt: new Date(20_000).toISOString() });
    const vocabulary: Record<string, Array<[string, string]>> = {
      "openai-responses": [
        ['OpenAI API error (429): {"error":{"code":"insufficient_quota"}}', "quota"],
        ['{"error":{"type":"server_error","message":"boom"}}', "transient"],
        ['{"error":{"code":"context_length_exceeded"}}', "overflow"],
      ],
      "openai-completions": [
        ['{"error":{"code":"rate_limit_exceeded"}}', "quota"],
        ["Connection error.", "transient"],
        ["This model's maximum context length is 8192 tokens; context_length_exceeded", "overflow"],
      ],
      "anthropic-messages": [
        ['{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', "quota"],
        ['{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', "transient"],
        ['{"type":"error","error":{"type":"authentication_error","message":"bad key"}}', "auth"],
        ["prompt is too long: 250000 tokens > 200000 maximum", "overflow"],
      ],
      "google-generative-ai": [
        ['{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"30s"}]}}', "quota"],
        ['{"error":{"code":503,"status":"UNAVAILABLE"}}', "transient"],
        ['{"error":{"status":"PERMISSION_DENIED","message":"API key not valid"}}', "auth"],
      ],
    };
    for (const [message, expected] of vocabulary[c.api] ?? []) expect(classOf(message), message).toBe(expected);
    if (c.api === "google-generative-ai") {
      expect(classifyAssistantMessage(error('{"status":"RESOURCE_EXHAUSTED","retryDelay":"30s"}'), { now: 0 })?.retryAt).toBe(new Date(30_000).toISOString());
    }
  });
});

describe("one Pi supervisor across every provider", () => {
  const all = () => CASES.map((c) => modelOf[c.provider]!);

  it("starts, switches through every provider and back, and restores, each episode on its own provider's key", async () => {
    for (const c of CASES) setEnv(c.envVar, `fake-${c.provider}-key`);
    const sessionDir = path.join(agentDir, "..", "supervisor");
    const harness = createPiHarness({ runId: "run-1", sessionDir, agentDir, configuredModels: all() });
    const supervisor = await harness.start();
    try {
      let n = 0;
      for (const target of [...all().slice(1), all()[0]!]) {
        await expect(supervisor.decide(episode(`ep-${n++}`))).rejects.toThrow(/aborted/);
        await supervisor.switchModel({ ...target, reason: "operator" });
        expect(supervisor.binding).toMatchObject(target);
      }
      await expect(supervisor.decide(episode("ep-last"))).rejects.toThrow(/aborted/);
      const restored = await restorePiSupervisorFromBinding({ runId: "run-1", binding: { ...supervisor.binding }, sessionDir, agentDir, configuredModels: all() });
      try {
        await expect(restored.decide(episode("ep-restored"))).rejects.toThrow(/aborted/);
        expect(restored.binding).toMatchObject(all()[0]!);
      } finally {
        await restored.close?.();
      }
    } finally {
      await supervisor.close?.();
    }
  });

  it("applies each explicit key to its own provider only, so a switch never borrows another provider's key", async () => {
    const sessionDir = path.join(agentDir, "..", "supervisor");
    const [first, second, third] = all();
    const apiKeys = { [second!.provider]: "fake-explicit-second" };
    const harness = createPiHarness({ runId: "run-1", sessionDir, agentDir, configuredModels: [first!, second!, third!], apiKey: "fake-explicit-first", apiKeys });
    expect(await harness.probe()).toEqual({ ok: true });
    const supervisor = await harness.start();
    try {
      await expect(supervisor.decide(episode("ep-1"))).rejects.toThrow(/aborted/);
      await supervisor.switchModel({ ...second!, reason: "operator" });
      await expect(supervisor.decide(episode("ep-2"))).rejects.toThrow(/aborted/);
      await supervisor.switchModel({ ...first!, reason: "operator" });
      expect(supervisor.binding).toMatchObject(first!);
      // The third provider has no key of its own; neither explicit key is applied to it.
      await expect(supervisor.switchModel({ ...third!, reason: "operator" })).rejects.toThrow(new RegExp(`credential unavailable for provider ${third!.provider}`));
    } finally {
      await supervisor.close?.();
    }
  });
});
