// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { checkPiModelsFile, piDefaultModelId, piProviderEnvVars, providerCredentialEnvVars, resolveProviderCredential } from "./credentials.js";
import { ensureProviderCredentials } from "./pi-session.js";

const temps: string[] = [];
const saved: Record<string, string | undefined> = {};

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("resolveProviderCredential", () => {
  it("prefers an explicit apiKey, for any provider", () => {
    for (const provider of ["minimax-cn", "deepseek", "openai", "my-endpoint"]) {
      expect(resolveProviderCredential({ provider, apiKey: " sk-explicit ", env: { MINIMAX_CN_API_KEY: "sk-cn", DEEPSEEK_API_KEY: "sk-ds" } })).toEqual({
        apiKey: "sk-explicit",
        source: "options",
      });
    }
  });

  it("keeps MiniMax's historical order: MINIMAX_CN_API_KEY, then MINIMAX_API_KEY, then Pi", () => {
    for (const provider of ["minimax-cn", "minimax"]) {
      expect(resolveProviderCredential({ provider, env: { MINIMAX_CN_API_KEY: "sk-cn", MINIMAX_API_KEY: "sk-general" } })).toEqual({ apiKey: "sk-cn", source: "env:MINIMAX_CN_API_KEY" });
      expect(resolveProviderCredential({ provider, env: { MINIMAX_API_KEY: "sk-general" } })).toEqual({ apiKey: "sk-general", source: "env:MINIMAX_API_KEY" });
      expect(resolveProviderCredential({ provider, env: {} })).toEqual({});
    }
  });

  it("leaves every other provider's credential to Pi, never borrowing MiniMax's variables", () => {
    expect(resolveProviderCredential({ provider: "deepseek", env: { DEEPSEEK_API_KEY: "sk-ds", MINIMAX_CN_API_KEY: "sk-cn" } })).toEqual({});
    expect(resolveProviderCredential({ provider: "openai", env: { MINIMAX_API_KEY: "sk-general" } })).toEqual({});
  });
});

describe("provider key variables", () => {
  it("come from Pi's own provider table", () => {
    expect(piProviderEnvVars("deepseek")).toEqual(["DEEPSEEK_API_KEY"]);
    expect(piProviderEnvVars("openai")).toEqual(["OPENAI_API_KEY"]);
    expect(piProviderEnvVars("google")).toEqual(["GEMINI_API_KEY"]);
    expect(piProviderEnvVars("moonshotai")).toEqual(["MOONSHOT_API_KEY"]);
    expect(piProviderEnvVars("anthropic")).toContain("ANTHROPIC_API_KEY");
    expect(piProviderEnvVars("my-endpoint")).toEqual([]);
    expect(providerCredentialEnvVars("minimax-cn")).toEqual(["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"]);
  });
});

describe("ensureProviderCredentials with an unchanged MiniMax configuration", () => {
  async function agentDir(auth: Record<string, unknown> = {}): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-cred-minimax-"));
    temps.push(dir);
    await writeFile(path.join(dir, "auth.json"), JSON.stringify(auth));
    await writeFile(path.join(dir, "models.json"), "{}");
    return dir;
  }
  const runtime = (dir: string) => ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json") });

  it("resolves minimax-cn as before: env first (overriding the auth store), else Pi's auth store", async () => {
    setEnv("MINIMAX_CN_API_KEY", undefined);
    setEnv("MINIMAX_API_KEY", "fake-general");
    const stored = await agentDir({ "minimax-cn": { type: "api_key", key: "fake-stored" } });
    const rt = await runtime(stored);
    expect(await ensureProviderCredentials({ modelRuntime: rt, provider: "minimax-cn", agentDir: stored })).toBe("env:MINIMAX_API_KEY");
    expect((await rt.getAuth("minimax-cn"))?.auth.apiKey).toBe("fake-general");
    setEnv("MINIMAX_API_KEY", undefined);
    const rt2 = await runtime(stored);
    expect(await ensureProviderCredentials({ modelRuntime: rt2, provider: "minimax-cn", agentDir: stored })).toBe("pi-stored");
    expect((await rt2.getAuth("minimax-cn"))?.auth.apiKey).toBe("fake-stored");
  });
});

describe("Pi's own model defaults and models.json checks", () => {
  it("recommends Pi's default model for a provider when listed, else the first", async () => {
    expect(await piDefaultModelId("openai", ["gpt-4", "gpt-5.5"])).toBe("gpt-5.5");
    expect(await piDefaultModelId("deepseek", ["deepseek-flash", "deepseek-v4-pro"])).toBe("deepseek-v4-pro");
    expect(await piDefaultModelId("my-endpoint", ["a", "b"])).toBe("a");
    expect(await piDefaultModelId("openai", [])).toBeUndefined();
  });

  it("checks a candidate models.json with Pi's registry, resolving no credential", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-cred-models-"));
    temps.push(dir);
    const modelsPath = path.join(dir, "candidate.json");
    await writeFile(modelsPath, JSON.stringify({ providers: { mine: { baseUrl: "http://127.0.0.1:9", api: "openai-completions", apiKey: "$GL_UNSET_VAR", models: [{ id: "m" }] } } }));
    const authPath = path.join(dir, "auth.json");
    expect(await checkPiModelsFile({ authPath, modelsPath, provider: "mine", modelId: "m" })).toEqual({ ok: true });
    expect(await checkPiModelsFile({ authPath, modelsPath, provider: "mine", modelId: "other" })).toMatchObject({ ok: false });
  });
});
