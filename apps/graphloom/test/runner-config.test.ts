import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeOptions, createCliRunner } from "../src/cli-runner.js";
import { loadRunnerConfig, parseRunnerConfig, requireRunnerConfig } from "../src/runner-config.js";

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
    expect(parseRunnerConfig({ harness: "claude-code", allowUnrestricted: true, claude: { configDir: "~/.claude" } }).claude)
      .toEqual({ configDir: path.join(os.homedir(), ".claude") });
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
    await writeFile(file, '{"harness": "claude-code", "allowUnrestricted": true, "apiKey": sk-ant-FAKE_SECRET}');
    await expect(loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file })).rejects.toThrow(`${file}: invalid JSON in runner config`);
    const err = await loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file }).catch((e: Error) => e);
    expect(String(err)).not.toContain("sk-ant");
  });

  it("binds a Claude Code command given as a relative path to the absolute path it checked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-runner-config-"));
    dirs.push(dir);
    const bin = path.join(dir, "claude");
    await writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    const file = path.join(dir, "runner.json");
    const relative = path.relative(process.cwd(), bin);
    await writeFile(file, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, claude: { command: relative, model: "sonnet" } }));
    expect(await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file })).toEqual({
      harness: "claude-code", allowUnrestricted: true, claude: { command: bin, model: "sonnet" },
    });
    await writeFile(file, JSON.stringify({ harness: "claude-code", allowUnrestricted: true }));
    expect(await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, GRAPHLOOM_CLAUDE_BIN: relative })).toEqual({
      harness: "claude-code", allowUnrestricted: true, claude: { command: bin },
    });
    expect(await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, PATH: dir })).toEqual({ harness: "claude-code", allowUnrestricted: true });
    await expect(requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, PATH: path.join(dir, "empty") })).rejects.toThrow(
      "Claude Code command claude was not found",
    );
    await expect(requireRunnerConfig({ HOME: dir })).rejects.toThrow(/^no agent runner configured/);
  });

  it("reads a Pi model from the config or the environment, and refuses a run without one", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-runner-config-"));
    dirs.push(dir);
    const file = path.join(dir, "runner.json");
    await writeFile(file, JSON.stringify({ harness: "pi", allowUnrestricted: true }));
    await expect(requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, GRAPHLOOM_PI_PROVIDER: "minimax-cn" })).rejects.toThrow(/pi\.modelId/);
    expect(await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, GRAPHLOOM_PI_PROVIDER: "minimax-cn", GRAPHLOOM_PI_MODEL: "MiniMax-M3" }))
      .toEqual({ harness: "pi", allowUnrestricted: true });
    await writeFile(file, JSON.stringify({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } }));
    expect((await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file }))?.pi).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
  });

  it("fits Claude Code's default watchdogs inside a shorter job timeout, and keeps explicit ones", () => {
    const claude = (config: Record<string, unknown>) => claudeOptions(parseRunnerConfig({ harness: "claude-code", allowUnrestricted: true, ...config }));
    expect(claude({})).toEqual({});
    expect(claude({ timeoutMs: 600_000 })).toEqual({ responseTimeoutMs: 300_000 });
    expect(claude({ timeoutMs: 120_000 })).toEqual({ startupTimeoutMs: 60_000, responseTimeoutMs: 60_000 });
    expect(claude({ timeoutMs: 120_000, claude: { startupTimeoutMs: 0, responseTimeoutMs: 90_000 } })).toEqual({ startupTimeoutMs: 0, responseTimeoutMs: 90_000 });
    expect(() => createCliRunner(parseRunnerConfig({ harness: "claude-code", allowUnrestricted: true, timeoutMs: 120_000, claude: { responseTimeoutMs: 120_000 } })))
      .toThrow("claude.responseTimeoutMs (120000 ms) must be shorter than the job timeout (120000 ms)");
  });
});
