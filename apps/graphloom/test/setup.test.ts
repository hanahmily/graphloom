// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Guided setup (docs/design-release.md §4.5) over constructed discoveries and
 * a scripted prompter: only available choices with their recommendation, the
 * allowUnrestricted consent, `--yes`, a rerun with backups, and files that the
 * parsers `run` uses accept, mode 0600, without secrets.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Discovery } from "../src/discovery.js";
import { loadRunnerConfig } from "../src/runner-config.js";
import { backupStamp, runSetup, type Prompter } from "../src/setup.js";
import { loadSupervisorConfig } from "../src/supervisor-config.js";
import { fakeDiscovery, type FakeDiscoveryOptions } from "./discovery-fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

interface Scripted extends Prompter {
  questions: string[];
  lines: string[];
  transcript(): string;
}

/** Answers in order; the end of the answers is the end of input. */
function scripted(answers: string[]): Scripted {
  const queue = [...answers];
  const questions: string[] = [];
  const lines: string[] = [];
  return {
    questions,
    lines,
    say: (line) => void lines.push(line),
    ask: async (q) => {
      questions.push(q);
      lines.push(q);
      return queue.shift();
    },
    transcript: () => lines.join("\n"),
  };
}

async function home(): Promise<{ dir: string; runnerFile: string; supervisorFile: string; env: NodeJS.ProcessEnv }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-setup-"));
  dirs.push(dir);
  const base = path.join(dir, ".config", "graphloom");
  return { dir, runnerFile: path.join(base, "runner.json"), supervisorFile: path.join(base, "supervisor.json"), env: { HOME: dir } };
}

function discovery(h: { runnerFile: string; supervisorFile: string }, options: FakeDiscoveryOptions = {}): Discovery {
  return fakeDiscovery({ runnerFile: h.runnerFile, supervisorFile: h.supervisorFile, ...options });
}

const json = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const mode = (file: string) => statSync(file).mode & 0o777;
const now = () => new Date("2026-10-27T05:17:00.123Z");

describe("graphloom setup", () => {
  it("offers only available choices, each with its recommendation, and writes 0600 files run accepts", async () => {
    const h = await home();
    const p = scripted(["", "", "", "", "", "y"]);
    const result = await runSetup({ prompter: p, discovery: discovery(h, { available: ["claude-code", "pi"], piProviders: ["minimax-cn", "deepseek"] }), now });
    expect(result).toMatchObject({ exitCode: 0, runner: "written", supervisor: "written" });
    expect(p.questions[0]).toMatch(/Default harness \[claude-code\/pi\] \(recommended: claude-code\)/);
    expect(p.questions.some((q) => /Codex/.test(q))).toBe(false);
    expect(p.questions[1]).toMatch(/Also enable Pi\? \[Y\/n\]/);
    expect(p.questions[2]).toMatch(/Pi provider with a credential \[minimax-cn\/deepseek\] \(recommended: minimax-cn\)/);
    expect(p.questions[3]).toMatch(/minimax-cn model \(recommended: MiniMax-M3;/);
    expect(p.questions[4]).toMatch(/Configure a Pi supervisor on minimax-cn\/MiniMax-M3\? \[Y\/n\]/);
    expect(p.questions.at(-1)).toMatch(/Allow coding agents to run with your user permissions\? \[y\/N\]/);
    expect(p.transcript()).toContain("The repair reviewer uses the same agent");
    expect(p.transcript()).toMatch(/confinement \(bubblewrap\)\s+limits what they write, not everything a shell can do/i);

    expect(json(h.runnerFile)).toEqual({ harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } });
    expect(json(h.supervisorFile)).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(mode(h.runnerFile)).toBe(0o600);
    expect(mode(h.supervisorFile)).toBe(0o600);
    // The same lookups and parsers run uses accept them.
    expect(await loadRunnerConfig(h.env)).toMatchObject({ harness: "claude-code", harnesses: ["claude-code", "pi"] });
    expect(await loadSupervisorConfig(h.env)).toMatchObject({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    // No temporary file is left behind.
    expect(readdirSync(path.dirname(h.runnerFile)).sort()).toEqual(["runner.json", "supervisor.json"]);
  });

  it("takes the operator's other choices: Pi as the default, Codex left out, another Pi model", async () => {
    const h = await home();
    const p = scripted(["pi", "y", "n", "deepseek", "deepseek-v4-pro", "", "y"]);
    const result = await runSetup({ prompter: p, discovery: discovery(h, { piProviders: ["minimax-cn", "deepseek"] }), now });
    expect(result.exitCode).toBe(0);
    expect(json(h.runnerFile)).toEqual({ harness: "pi", allowUnrestricted: true, harnesses: ["pi", "claude-code"], pi: { provider: "deepseek", modelId: "deepseek-v4-pro" } });
    // The supervisor starts from the runner's Pi choice.
    expect(json(h.supervisorFile)).toEqual({ provider: "deepseek", modelId: "deepseek-v4-pro" });
  });

  it("re-asks a choice that is not offered", async () => {
    const h = await home();
    const p = scripted(["codex", "claude-code", "", "", "", "", "y"]);
    await runSetup({ prompter: p, discovery: discovery(h), now });
    expect(p.transcript()).toContain("choose one of claude-code, pi");
    expect(json(h.runnerFile).harness).toBe("claude-code");
  });

  it("refusing allowUnrestricted writes nothing and exits 1", async () => {
    const h = await home();
    const p = scripted(["", "", "", "", "", "n"]);
    const result = await runSetup({ prompter: p, discovery: discovery(h), now });
    expect(result).toMatchObject({ exitCode: 1, runner: "none", supervisor: "none", reason: "allowUnrestricted was declined" });
    expect(existsSync(h.runnerFile)).toBe(false);
    expect(existsSync(h.supervisorFile)).toBe(false);
    // The end of input is no consent either.
    const eof = await runSetup({ prompter: scripted([]), discovery: discovery(h), now });
    expect(eof.exitCode).toBe(1);
    expect(existsSync(h.runnerFile)).toBe(false);
  });

  it("--yes writes the recommendations without prompting and counts as consent", async () => {
    const h = await home();
    const lines: string[] = [];
    const result = await runSetup({ yes: true, say: (l) => void lines.push(l), discovery: discovery(h), now });
    expect(result).toMatchObject({ exitCode: 0, runner: "written", supervisor: "written" });
    expect(json(h.runnerFile)).toEqual({ harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "codex", "pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } });
    expect(json(h.supervisorFile)).toEqual({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(lines.join("\n")).toContain("--yes counts as your consent");
  });

  it("writes the Pi agent dir discovery used into a new supervisor config when it is not the default", async () => {
    const h = await home();
    const d = discovery(h);
    d.pi = { ...d.pi, agentDir: path.join(h.dir, "pi-elsewhere") };
    await runSetup({ yes: true, say: () => undefined, discovery: d, env: h.env, now });
    expect(json(h.supervisorFile)).toEqual({ agentDir: path.join(h.dir, "pi-elsewhere"), provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(await loadSupervisorConfig(h.env)).toMatchObject({ agentDir: path.join(h.dir, "pi-elsewhere") });
  });

  it("without Pi, writes no supervisor and says Claude Code and Codex supervise from later releases", async () => {
    const h = await home();
    const lines: string[] = [];
    await runSetup({ yes: true, say: (l) => void lines.push(l), discovery: discovery(h, { available: ["claude-code", "codex"] }), now });
    expect(json(h.runnerFile)).toEqual({ harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "codex"] });
    expect(existsSync(h.supervisorFile)).toBe(false);
    const text = lines.join("\n");
    expect(text).toContain("Claude Code and Codex supervise from the GraphLoom releases that ship them (phases S3, S4)");
    expect(text).toContain("runs have no automatic recovery");
  });

  it("with no available harness that can write, writes nothing, prints the doctor's fixes, and exits 1", async () => {
    const h = await home();
    const lines: string[] = [];
    const result = await runSetup({ yes: true, say: (l) => void lines.push(l), discovery: discovery(h, { available: ["codex"] }), now });
    expect(result).toMatchObject({ exitCode: 1, reason: "no available harness can write" });
    expect(existsSync(h.runnerFile)).toBe(false);
    expect(lines.join("\n")).toMatch(/Claude Code: claude\n.*Pi: export MINIMAX_CN_API_KEY=<key>/);
  });

  it("a rerun shows the current configuration, changes only confirmed answers, and keeps a .bak- copy", async () => {
    const h = await home();
    await mkdir(path.dirname(h.runnerFile), { recursive: true });
    const old = { harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M2.7", agentDir: "~/.pi/agent" }, timeoutMs: 1234, notify: { onStop: "echo done" } };
    await writeFile(h.runnerFile, JSON.stringify(old));
    // Change the default to Claude Code: yes; enable Codex: no; Pi model to MiniMax-M3: no; replace: yes. Supervisor: decline.
    const p = scripted(["y", "n", "n", "n", "y"]);
    const result = await runSetup({ prompter: p, discovery: discovery(h), now });
    expect(result).toMatchObject({ exitCode: 0, runner: "written", supervisor: "none" });
    const text = p.transcript();
    expect(text).toContain(`Runner config ${h.runnerFile}: harness pi, enabled pi, pi minimax-cn/MiniMax-M2.7`);
    expect(text).toContain("recommended: harness claude-code, enabled claude-code, codex, pi, pi minimax-cn/MiniMax-M3");
    expect(p.questions.some((q) => /Allow coding agents/.test(q))).toBe(false);
    expect(json(h.runnerFile)).toEqual({ ...old, harness: "claude-code", harnesses: ["claude-code", "pi"] });
    const backup = `${h.runnerFile}.bak-${backupStamp(now())}`;
    expect(backupStamp(now())).toBe("20261027T051700Z");
    expect(json(backup)).toEqual(old);
    expect(mode(backup)).toBe(0o600);
  });

  it("a rerun whose answers change nothing writes nothing", async () => {
    const h = await home();
    await mkdir(path.dirname(h.runnerFile), { recursive: true });
    const current = { harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "codex", "pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } };
    await writeFile(h.runnerFile, JSON.stringify(current));
    await writeFile(h.supervisorFile, JSON.stringify({ provider: "minimax-cn", modelId: "MiniMax-M3" }));
    const d = discovery(h);
    d.pi.configured = [{ where: "supervisor config", provider: "minimax-cn", modelId: "MiniMax-M3", resolves: true, credential: true }];
    const p = scripted([]);
    const result = await runSetup({ prompter: p, discovery: d, now });
    expect(result).toMatchObject({ exitCode: 0, runner: "unchanged", supervisor: "unchanged" });
    expect(p.questions).toEqual([]);
    expect(p.transcript()).toContain("matches the recommendation; unchanged");
    expect(readdirSync(path.dirname(h.runnerFile)).sort()).toEqual(["runner.json", "supervisor.json"]);

    // Declining every offered change also writes nothing.
    await writeFile(h.runnerFile, JSON.stringify({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } }));
    const declined = await runSetup({ prompter: scripted(["n", "n", "n"]), discovery: d, now });
    expect(declined.runner).toBe("unchanged");
    expect(readdirSync(path.dirname(h.runnerFile)).some((n) => n.includes(".bak-"))).toBe(false);
  });

  it("repairs a runner config whose Pi model Pi does not know, when Pi is the only writer", async () => {
    const h = await home();
    await mkdir(path.dirname(h.runnerFile), { recursive: true });
    await writeFile(h.runnerFile, JSON.stringify({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "bogus" } }));
    const d = discovery(h, { available: ["pi"] });
    d.pi = { ...d.pi, available: false, reason: "minimax-cn/bogus is not in Pi's model registry", fix: "graphloom setup" };
    const p = scripted(["y", "n", "y"]);
    const result = await runSetup({ prompter: p, discovery: d, now });
    expect(result.exitCode, p.transcript()).toBe(0);
    expect(json(h.runnerFile)).toEqual({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } });
  });

  it("a rerun offers to disable an enabled harness that is no longer available", async () => {
    const h = await home();
    await mkdir(path.dirname(h.runnerFile), { recursive: true });
    await writeFile(h.runnerFile, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, harnesses: ["claude-code", "codex"] }));
    const p = scripted(["y", "y", "n"]);
    await runSetup({ prompter: p, discovery: discovery(h, { available: ["claude-code"] }), now });
    expect(p.questions[0]).toMatch(/Disable Codex, which is not available\?/);
    expect(json(h.runnerFile)).toEqual({ harness: "claude-code", allowUnrestricted: true });
  });

  it("--yes leaves existing files unchanged and prints the differences", async () => {
    const h = await home();
    await mkdir(path.dirname(h.runnerFile), { recursive: true });
    const runner = JSON.stringify({ harness: "pi", allowUnrestricted: true, pi: { provider: "minimax-cn", modelId: "MiniMax-M2.7" } });
    const sup = JSON.stringify({ provider: "deepseek", modelId: "deepseek-flash" });
    await writeFile(h.runnerFile, runner);
    await writeFile(h.supervisorFile, sup);
    const lines: string[] = [];
    const result = await runSetup({ yes: true, say: (l) => void lines.push(l), discovery: discovery(h), now });
    expect(result).toMatchObject({ exitCode: 0, runner: "unchanged", supervisor: "unchanged" });
    expect(readFileSync(h.runnerFile, "utf8")).toBe(runner);
    expect(readFileSync(h.supervisorFile, "utf8")).toBe(sup);
    const text = lines.join("\n");
    expect(text).toContain("harness: pi -> claude-code");
    expect(text).toContain('harnesses: (unset) -> ["claude-code","codex","pi"]');
    expect(text).toContain("pi.modelId: MiniMax-M2.7 -> MiniMax-M3");
    expect(text).toContain("provider: deepseek -> minimax-cn");
    expect(readdirSync(path.dirname(h.runnerFile)).some((n) => n.includes(".bak-"))).toBe(false);
  });

  it("a runner config run would refuse is replaced only on confirmation, keeping the old file", async () => {
    const h = await home();
    await mkdir(path.dirname(h.runnerFile), { recursive: true });
    await writeFile(h.runnerFile, JSON.stringify({ harness: "claude-code" }));
    const kept = await runSetup({ yes: true, say: () => undefined, discovery: discovery(h), now });
    expect(kept.runner).toBe("unchanged");
    const p = scripted(["y", "", "", "", "", "y"]);
    const result = await runSetup({ prompter: p, discovery: discovery(h), now });
    expect(result.runner, p.transcript()).toBe("written");
    expect(p.transcript()).toContain("allowUnrestricted must be true");
    expect(json(`${h.runnerFile}.bak-${backupStamp(now())}`)).toEqual({ harness: "claude-code" });
    expect(json(h.runnerFile).allowUnrestricted).toBe(true);
  });

  it("never asks for or writes a token, and names the variables that remain", async () => {
    const h = await home();
    const d = discovery(h);
    d.codex = { ...d.codex, login: "unverified" };
    const lines: string[] = [];
    await runSetup({ yes: true, say: (l) => void lines.push(l), discovery: d, env: { MINIMAX_CN_API_KEY: "stub-secret-value" }, now });
    const written = readFileSync(h.runnerFile, "utf8") + readFileSync(h.supervisorFile, "utf8");
    expect(written).not.toMatch(/stub-secret-value|apiKey|token/i);
    const text = lines.join("\n");
    expect(text).toContain("codex login");
    expect(text).toContain("GRAPHLOOM_GITHUB_LIVE_TOKEN");
  });
});
