// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A custom provider added to Pi's own models.json, of any API type Pi speaks,
 * its key referenced by environment variable name only; and a supervisor on
 * it (or on built-in DeepSeek) that parses and probes with a fake key.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addCustomPiProvider, CUSTOM_PI_APIS, customProviderProblem, type CustomPiProvider } from "../src/pi-models.js";
import { parseSupervisorConfig, probeSupervisorHarness } from "../src/supervisor-config.js";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function agentDir(models?: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-models-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "auth.json"), "{}");
  if (models !== undefined) await writeFile(path.join(dir, "models.json"), JSON.stringify(models));
  return dir;
}

const custom = (patch: Partial<CustomPiProvider> = {}): CustomPiProvider => ({
  id: "my-endpoint",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "my-model",
  envVar: "GL_TEST_MY_ENDPOINT_KEY",
  ...patch,
});

describe("custom Pi providers", () => {
  it.each(CUSTOM_PI_APIS)("adds a %s provider in Pi's format, keeping other entries, its key a $NAME reference", async (api) => {
    const existing = { providers: { "minimax-cn": { models: [{ id: "MiniMax-M3.1-Flash-Preview", api: "anthropic-messages" }] } } };
    const dir = await agentDir(existing);
    const kept = await addCustomPiProvider(dir, custom({ api }), "20261027T000000Z");
    expect(kept).toBe(path.join(dir, "models.json.bak-20261027T000000Z"));
    expect(JSON.parse(readFileSync(kept!, "utf8"))).toEqual(existing);
    const written = JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8")) as { providers: Record<string, unknown> };
    expect(written.providers["minimax-cn"]).toEqual(existing.providers["minimax-cn"]);
    expect(written.providers["my-endpoint"]).toEqual({ baseUrl: "http://127.0.0.1:9/v1", api, apiKey: "$GL_TEST_MY_ENDPOINT_KEY", models: [{ id: "my-model" }] });
    expect(statSync(path.join(dir, "models.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses an id the file defines, a name that looks like a key, and a URL with credentials", async () => {
    const dir = await agentDir({ providers: { "my-endpoint": { baseUrl: "http://x", api: "openai-completions", models: [] } } });
    await expect(addCustomPiProvider(dir, custom(), "s")).rejects.toThrow(/already defines provider my-endpoint/);
    expect(customProviderProblem(custom({ envVar: "sk-live-abc123" }))).toMatch(/not an environment variable name/);
    expect(customProviderProblem(custom({ envVar: "sk-live-abc123" }))).not.toContain("sk-live");
    expect(customProviderProblem(custom({ envVar: "sk_abcDEF" }))).toMatch(/upper case/);
    expect(customProviderProblem(custom({ baseUrl: "https://user:secret@example.com/v1" }))).toBe("baseUrl must not carry credentials");
    expect(customProviderProblem(custom({ id: "deepseek" }), ["deepseek"])).toMatch(/already knows a provider deepseek/);
  });

  it("a supervisor on the custom provider parses and probes: refused without the key, passing with a fake one", async () => {
    const dir = await agentDir();
    await addCustomPiProvider(dir, custom(), "s");
    const config = parseSupervisorConfig({ provider: "my-endpoint", modelId: "my-model", agentDir: dir });
    setEnv("GL_TEST_MY_ENDPOINT_KEY", undefined);
    const missing = await probeSupervisorHarness(config, "pi");
    expect(missing.ok === false && missing.reason).toMatch(/credential unavailable for provider my-endpoint: .*GL_TEST_MY_ENDPOINT_KEY/);
    setEnv("GL_TEST_MY_ENDPOINT_KEY", "fake-key");
    expect(await probeSupervisorHarness(config, "pi")).toEqual({ ok: true });
  });
});

describe("a DeepSeek supervisor", () => {
  it("needs only DEEPSEEK_API_KEY: the documented supervisor.json parses and probes with a fake key", async () => {
    const dir = await agentDir();
    await mkdir(dir, { recursive: true });
    const config = parseSupervisorConfig({ provider: "deepseek", modelId: "deepseek-v4-pro", models: ["deepseek/deepseek-flash"], agentDir: dir });
    expect(config.models).toEqual([{ provider: "deepseek", modelId: "deepseek-v4-pro" }, { provider: "deepseek", modelId: "deepseek-flash" }]);
    setEnv("DEEPSEEK_API_KEY", undefined);
    const missing = await probeSupervisorHarness(config, "pi");
    expect(missing.ok === false && missing.reason).toMatch(/set DEEPSEEK_API_KEY/);
    setEnv("DEEPSEEK_API_KEY", "fake-deepseek-key");
    expect(await probeSupervisorHarness(config, "pi")).toEqual({ ok: true });
  });
});
