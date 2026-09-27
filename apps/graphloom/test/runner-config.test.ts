import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunnerConfig, parseRunnerConfig } from "../src/runner-config.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("operator runner configuration", () => {
  it("requires explicit unrestricted execution consent", () => {
    expect(() => parseRunnerConfig({ harness: "claude-code" })).toThrow(/allowUnrestricted.*true/);
    expect(() => parseRunnerConfig({ harness: "pi", allowUnrestricted: false })).toThrow(/allowUnrestricted.*true/);
    expect(parseRunnerConfig({ harness: "claude-code", allowUnrestricted: true, claude: { command: "/usr/bin/claude", model: "sonnet", configDir: "/operator/claude" } }))
      .toEqual({ harness: "claude-code", allowUnrestricted: true, claude: { command: "/usr/bin/claude", model: "sonnet", configDir: "/operator/claude" } });
  });

  it.each([
    null, [], { harness: "other", allowUnrestricted: true },
    { harness: "pi", allowUnrestricted: true, apiKey: "secret" },
    { harness: "pi", allowUnrestricted: true, pi: { apiKey: "secret" } },
    { harness: "claude-code", allowUnrestricted: true, claude: { passEnv: [123] } },
    { harness: "claude-code", allowUnrestricted: true, timeoutMs: -1 },
    { harness: "claude-code", allowUnrestricted: true, claude: { responseTimeoutMs: Infinity } },
  ])("rejects invalid settings without echoing secrets", (input) => {
    expect(() => parseRunnerConfig(input)).toThrow();
    try { parseRunnerConfig(input); } catch (err) { expect(String(err)).not.toContain("secret"); }
  });

  it("loads the default path, permits its absence, and fails for a missing explicit file or malformed JSON", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-runner-config-"));
    dirs.push(dir);
    expect(await loadRunnerConfig({ HOME: dir })).toBeUndefined();
    await expect(loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: path.join(dir, "missing.json") })).rejects.toThrow(/cannot read runner config/);
    const folder = path.join(dir, ".config", "graphloom");
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, "runner.json");
    await writeFile(file, JSON.stringify({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } }));
    expect((await loadRunnerConfig({ HOME: dir }))?.harness).toBe("pi");
    await writeFile(file, "{ invalid");
    await expect(loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file })).rejects.toThrow(/invalid JSON/);
  });
});
