import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliRunner } from "../src/cli-runner.js";
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

  it("accepts the harnesses jobs may choose, GitHub reads by token variable name, and command settings", () => {
    expect(parseRunnerConfig({
      harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "pi", "pi"],
      github: { tokenEnv: "GITHUB_TOKEN" }, command: { timeoutMs: 60_000 },
    })).toEqual({
      harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "pi"],
      github: { tokenEnv: "GITHUB_TOKEN" }, command: { timeoutMs: 60_000 },
    });
  });

  it("checks every harness a job may choose before a run starts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-runner-config-"));
    dirs.push(dir);
    const file = path.join(dir, "runner.json");
    await writeFile(file, JSON.stringify({ harness: "claude-code", harnesses: ["pi"], allowUnrestricted: true }));
    await expect(requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, PATH: dir })).rejects.toThrow(/pi\.provider and pi\.modelId/);
    await writeFile(file, JSON.stringify({ harness: "pi", harnesses: ["claude-code"], allowUnrestricted: true, pi: { provider: "p", modelId: "m" } }));
    await expect(requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, PATH: path.join(dir, "empty") })).rejects.toThrow(
      "Claude Code command claude was not found",
    );
    await writeFile(file, JSON.stringify({ harness: "pi", harnesses: ["codex"], allowUnrestricted: true, pi: { provider: "p", modelId: "m" } }));
    await expect(requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, PATH: path.join(dir, "empty") })).rejects.toThrow(
      "Codex command codex was not found; install Codex or set codex.command in the runner config",
    );
  });

  it("accepts Codex settings and binds its command to the absolute path it checked", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-runner-config-"));
    dirs.push(dir);
    expect(parseRunnerConfig({
      harness: "claude-code", allowUnrestricted: true, harnesses: ["codex"],
      codex: { model: "gpt-6", reasoningEffort: "high", codexHome: "~/.codex", passEnv: ["X"], responseTimeoutMs: 0 },
    }).codex).toEqual({ model: "gpt-6", reasoningEffort: "high", codexHome: path.join(os.homedir(), ".codex"), passEnv: ["X"], responseTimeoutMs: 0 });
    const bin = path.join(dir, "codex");
    await writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
    const file = path.join(dir, "runner.json");
    await writeFile(file, JSON.stringify({ harness: "codex", allowUnrestricted: true, codex: { command: path.relative(process.cwd(), bin) } }));
    expect(await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file })).toEqual({ harness: "codex", allowUnrestricted: true, codex: { command: bin } });
    await writeFile(file, JSON.stringify({ harness: "codex", allowUnrestricted: true }));
    expect(await requireRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: file, PATH: dir })).toEqual({ harness: "codex", allowUnrestricted: true });
  });

  it.each([
    null, [], { harness: "other", allowUnrestricted: true },
    { harness: "claude-code", allowUnrestricted: true, harnesses: [] },
    { harness: "claude-code", allowUnrestricted: true, harnesses: ["gemini"] },
    { harness: "codex", allowUnrestricted: true, codex: { reasoningEffort: "extreme" } },
    { harness: "codex", allowUnrestricted: true, codex: { apiKey: "secret" } },
    { harness: "claude-code", allowUnrestricted: true, github: { token: "secret" } },
    { harness: "claude-code", allowUnrestricted: true, github: { tokenEnv: "not a name" } },
    { harness: "claude-code", allowUnrestricted: true, command: { timeoutMs: 0 } },
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

  it("leaves default watchdogs to each job's own wall clock, and refuses explicit ones the default job would cut off", () => {
    const parse = (config: Record<string, unknown>) => parseRunnerConfig({ harness: "claude-code", allowUnrestricted: true, ...config });
    // A short default job no longer bakes half of it into the watchdogs: a job asking for longer keeps the full ones.
    expect(() => createCliRunner(parse({ timeoutMs: 120_000 }))).not.toThrow();
    expect(() => createCliRunner(parse({ timeoutMs: 120_000, claude: { startupTimeoutMs: 0, responseTimeoutMs: 90_000 } }))).not.toThrow();
    expect(() => createCliRunner(parse({ timeoutMs: 120_000, claude: { responseTimeoutMs: 120_000 } })))
      .toThrow("claude.responseTimeoutMs (120000 ms) must be shorter than the job timeout (120000 ms)");
    expect(() => createCliRunner(parseRunnerConfig({ harness: "codex", allowUnrestricted: true, timeoutMs: 120_000 }))).not.toThrow();
    expect(() => createCliRunner(parseRunnerConfig({ harness: "codex", allowUnrestricted: true, timeoutMs: 120_000, codex: { responseTimeoutMs: 120_000 } })))
      .toThrow("codex.responseTimeoutMs (120000 ms) must be shorter than the job timeout (120000 ms)");
  });

  it("reads the most wall clock a job may ask for, at least the default job's", () => {
    const parse = (config: Record<string, unknown>) => parseRunnerConfig({ harness: "claude-code", allowUnrestricted: true, ...config });
    expect(parse({ maxTimeoutMs: 6 * 3_600_000 }).maxTimeoutMs).toBe(6 * 3_600_000);
    expect(parse({ timeoutMs: 600_000, maxTimeoutMs: 600_000 })).toMatchObject({ timeoutMs: 600_000, maxTimeoutMs: 600_000 });
    expect(() => parse({ maxTimeoutMs: 1_800_000 })).toThrow("maxTimeoutMs must be at least timeoutMs (3600000 ms)");
    expect(() => parse({ timeoutMs: 600_000, maxTimeoutMs: 300_000 })).toThrow("maxTimeoutMs must be at least timeoutMs (600000 ms)");
    expect(() => parse({ maxTimeoutMs: 25 * 3_600_000 })).toThrow("maxTimeoutMs must be at most 86400000");
    expect(() => parse({ maxTimeoutMs: 0 })).toThrow("maxTimeoutMs: expected positive integer milliseconds");
    expect(() => createCliRunner(parse({ maxTimeoutMs: 6 * 3_600_000 }))).not.toThrow();
  });
});
