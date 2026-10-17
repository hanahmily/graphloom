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
  piSupervisorRestore,
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

  it("accepts an object models entry naming its own thinkingLevel, alongside plain strings", () => {
    const config = parseSupervisorConfig({
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      models: [{ provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" }, "deepseek/deepseek-chat"],
    });
    expect(config.models).toEqual([
      { provider: "minimax-cn", modelId: "MiniMax-M3" },
      { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" },
      { provider: "deepseek", modelId: "deepseek-chat" },
    ]);
  });

  it("applies a top-level thinkingLevel to the initial provider/modelId entry", () => {
    const config = parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" });
    expect(config.thinkingLevel).toBe("low");
    expect(config.models).toEqual([{ provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview", thinkingLevel: "low" }]);
  });

  it("rejects an unknown thinkingLevel value", () => {
    expect(() => parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", thinkingLevel: "extreme" })).toThrow(
      /thinkingLevel must be one of/,
    );
  });

  it("reads an optional rawStreamCapture flag and rejects a non-boolean one", () => {
    expect(parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3" }).rawStreamCapture).toBeUndefined();
    expect(parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", rawStreamCapture: true }).rawStreamCapture).toBe(true);
    expect(() => parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", rawStreamCapture: "yes" })).toThrow(/rawStreamCapture must be a boolean/);
  });

  it("reads an optional quotaRetryMs fallback and rejects a non-positive one", () => {
    expect(parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3" }).quotaRetryMs).toBeUndefined();
    expect(parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", quotaRetryMs: 300_000 }).quotaRetryMs).toBe(300_000);
    for (const bad of [0, -1, "60s"]) {
      expect(() => parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", quotaRetryMs: bad })).toThrow(
        /quotaRetryMs must be a positive number/,
      );
    }
  });

  it("reads the prompt's inactivity limit and an optional total cap, rejecting non-positive ones", () => {
    const config = parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", promptTimeoutMs: 180_000, promptTotalTimeoutMs: 1_200_000 });
    expect(config).toMatchObject({ promptTimeoutMs: 180_000, promptTotalTimeoutMs: 1_200_000 });
    expect(parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3" }).promptTotalTimeoutMs).toBeUndefined();
    for (const bad of [0, -1, "15m", Number.POSITIVE_INFINITY]) {
      expect(() => parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", promptTotalTimeoutMs: bad })).toThrow(
        /promptTotalTimeoutMs must be a positive number/,
      );
    }
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

describe("operator supervisor restore", () => {
  it("restores the logical supervisor with a fresh session, never reopening the earlier transcript", async () => {
    const dir = await tempDir();
    process.env.MINIMAX_CN_API_KEY = "test-key-not-used";
    const stateDir = path.join(dir, "state", "run-1");
    // A pre-#120 binding: the run-long transcript it names is never read.
    const oldFile = path.join(stateDir, "supervisor", "old-run-long-session.jsonl");
    const restore = piSupervisorRestore(
      parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3", agentDir: path.join(dir, "agent") }),
    );
    const supervisor = (await restore(
      { sessionId: "logical-1", sessionFile: oldFile, provider: "minimax-cn", modelId: "MiniMax-M3", switchJournal: [] },
      { runId: "run-1", stateDir },
    )) as PiSupervisor;
    try {
      expect(supervisor.sessionId).toBe("logical-1");
      expect(supervisor.binding.sessionId).toBe("logical-1");
      expect(supervisor.binding.sessionFile).not.toBe(oldFile);
      expect(supervisor.binding.sessionFile).toMatch(new RegExp(`^${path.join(stateDir, "supervisor")}`));
    } finally {
      await supervisor.close?.();
    }
  });
});
