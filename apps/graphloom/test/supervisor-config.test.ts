import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiSupervisor } from "@graphloom/supervisor";
import {
  loadSupervisorConfig,
  parseModelRef,
  parseSupervisorConfig,
  piSupervisorFactory,
} from "../src/supervisor-config.js";

const temps: string[] = [];
const saved = process.env.MINIMAX_CN_API_KEY;

afterEach(async () => {
  if (saved === undefined) delete process.env.MINIMAX_CN_API_KEY;
  else process.env.MINIMAX_CN_API_KEY = saved;
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-sup-config-"));
  temps.push(dir);
  return dir;
}

describe("operator supervisor config", () => {
  it("lists the initial model first and keeps slashes inside model ids", () => {
    const config = parseSupervisorConfig({
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      models: ["deepseek/deepseek-chat", "openrouter/openai/gpt-5", "minimax-cn/MiniMax-M3"],
    });
    expect(config.models).toEqual([
      { provider: "minimax-cn", modelId: "MiniMax-M3" },
      { provider: "deepseek", modelId: "deepseek-chat" },
      { provider: "openrouter", modelId: "openai/gpt-5" },
    ]);
    expect(() => parseModelRef("deepseek")).toThrow(/provider\/model/);
  });

  it("refuses credentials in the config file", () => {
    expect(() => parseSupervisorConfig({ provider: "deepseek", modelId: "x", apiKey: "sk-test" })).toThrow(
      /apiKey is not accepted/,
    );
  });

  it("has no supervisor without a default config, but an explicit missing path is an error", async () => {
    const home = await tempDir();
    expect(await loadSupervisorConfig({ HOME: home })).toBeUndefined();
    await expect(
      loadSupervisorConfig({ HOME: home, GRAPHLOOM_SUPERVISOR_CONFIG: path.join(home, "missing.json") }),
    ).rejects.toThrow(/cannot read supervisor config/);
    const file = path.join(home, "supervisor.json");
    await writeFile(file, JSON.stringify({ provider: "deepseek", modelId: "deepseek-chat" }), "utf8");
    expect(await loadSupervisorConfig({ GRAPHLOOM_SUPERVISOR_CONFIG: file })).toMatchObject({
      provider: "deepseek",
      models: [{ provider: "deepseek", modelId: "deepseek-chat" }],
    });
  });

  it("keeps the run's supervisor transcript in its state directory", async () => {
    const dir = await tempDir();
    process.env.MINIMAX_CN_API_KEY = "test-key-not-used";
    const factory = piSupervisorFactory(
      parseSupervisorConfig({
        provider: "minimax-cn",
        modelId: "MiniMax-M3",
        models: ["deepseek/deepseek-chat"],
        agentDir: path.join(dir, "agent"),
      }),
    );
    const stateDir = path.join(dir, "state", "run-1");
    const supervisor = (await factory({ runId: "run-1", stateDir })) as PiSupervisor;
    try {
      expect(supervisor.binding.sessionFile).toMatch(new RegExp(`^${path.join(stateDir, "supervisor")}`));
      expect(supervisor.binding.configuredModels).toEqual([
        { provider: "minimax-cn", modelId: "MiniMax-M3" },
        { provider: "deepseek", modelId: "deepseek-chat" },
      ]);
    } finally {
      await supervisor.close?.();
    }
  });
});
