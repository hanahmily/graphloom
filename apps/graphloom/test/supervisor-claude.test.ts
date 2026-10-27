// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { reenter, type GraphDecision } from "@graphloom/sdk";
import { confinementUnsupported } from "@graphloom/runner";
import type { SupervisorHost, SupervisorInput } from "@graphloom/supervisor";
import { claudeRepairReviewer } from "../src/repair-config.js";
import { claudeConfinement, claudeHarnessFor, parseClaudeSupervisorConfig } from "../src/supervisor-claude.js";
import {
  parseSupervisorConfig,
  selectSupervisorHarness,
  supervisorFactoryFor,
  supervisorRestore,
  type SupervisorConfig,
} from "../src/supervisor-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../../../packages/supervisor/test/fake-claude.mjs");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("supervisor.json per-harness form (design-supervisor-harnesses.md §7.2)", () => {
  it("keeps the flat Pi form as it was, enabling Pi only", () => {
    const flat = parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(flat.harnesses).toBeUndefined();
    expect(flat.claude).toBeUndefined();
  });

  it("enables the configured sections in the built-in order unless harnesses lists them", () => {
    const both = parseSupervisorConfig({
      claude: { models: ["opus", "claude-code/sonnet", { modelId: "haiku", thinkingLevel: "low" }], configDir: "~/.claude" },
      pi: { provider: "minimax-cn", modelId: "MiniMax-M3" },
      promptTimeoutMs: 60_000,
    });
    expect(both.harnesses).toEqual(["pi", "claude-code"]);
    expect(both.promptTimeoutMs).toBe(60_000);
    expect(both.claude).toEqual({
      models: [
        { provider: "claude-code", modelId: "opus" },
        { provider: "claude-code", modelId: "sonnet" },
        { provider: "claude-code", modelId: "haiku", thinkingLevel: "low" },
      ],
      configDir: path.join(os.homedir(), ".claude"),
    });
    const ordered = parseSupervisorConfig({ harnesses: ["claude-code", "pi"], select: "claude-code", claude: {}, pi: { provider: "p", modelId: "m" } });
    expect(ordered.harnesses).toEqual(["claude-code", "pi"]);
    expect(ordered.select).toBe("claude-code");
    expect(ordered.claude?.models).toEqual([{ provider: "claude-code", modelId: "default" }]);
    // A claude-only config enables only Claude Code.
    expect(parseSupervisorConfig({ claude: { models: ["opus"] } }).harnesses).toEqual(["claude-code"]);
    // A codex section enables Codex (S4).
    expect(parseSupervisorConfig({ claude: {}, codex: { command: "codex" } }).harnesses).toEqual(["claude-code", "codex"]);
  });

  it("refuses secrets, unknown harnesses, and a select that is not enabled", () => {
    expect(() => parseSupervisorConfig({ claude: { apiKey: "sk" } })).toThrow(/own Claude Code login/);
    expect(() => parseSupervisorConfig({ claude: { passEnv: ["ANTHROPIC_API_KEY"] } })).toThrow(/cannot include ANTHROPIC_API_KEY/);
    expect(() => parseSupervisorConfig({ apiKey: "sk", claude: {} })).toThrow(/apiKey is not accepted/);
    expect(() => parseSupervisorConfig({ harnesses: ["gemini"], claude: {} })).toThrow(/is not one of pi, claude-code, codex/);
    expect(() => parseSupervisorConfig({ harnesses: ["pi"], select: "claude-code", pi: { provider: "p", modelId: "m" } })).toThrow(/select must be one of the enabled harnesses/);
    expect(() => parseClaudeSupervisorConfig({ models: [] }, "x")).toThrow(/non-empty array/);
  });
});

describe("supervisor harness selection (§7.3)", () => {
  const config = parseSupervisorConfig({ pi: { provider: "minimax-cn", modelId: "MiniMax-M3" }, claude: { models: ["opus"] } });
  const probe = (available: Record<string, boolean>) => async (h: string) =>
    available[h] === true ? ({ ok: true } as const) : ({ ok: false, reason: `${h} is missing` } as const);

  it("takes --supervisor, then select, each only when enabled and available", async () => {
    expect(await selectSupervisorHarness(config, { flag: "claude-code", probe: probe({ "claude-code": true }) })).toMatchObject({ harness: "claude-code", source: "flag" });
    await expect(selectSupervisorHarness(config, { flag: "claude-code", probe: probe({}) })).rejects.toThrow(/--supervisor claude-code is not available: claude-code is missing/);
    await expect(selectSupervisorHarness(config, { flag: "codex", probe: probe({ codex: true }) })).rejects.toThrow(/not enabled .*enabled: pi, claude-code/);
    const selected: SupervisorConfig = { ...config, select: "claude-code" };
    expect(await selectSupervisorHarness(selected, { probe: probe({ pi: true, "claude-code": true }) })).toMatchObject({ harness: "claude-code", source: "operator" });
    await expect(selectSupervisorHarness(selected, { probe: probe({ pi: true }) })).rejects.toThrow(/select claude-code is not available/);
  });

  it("otherwise takes the first enabled harness that is available, and none when none is", async () => {
    expect(await selectSupervisorHarness(config, { probe: probe({ pi: true, "claude-code": true }) })).toMatchObject({ harness: "pi", source: "fallback" });
    expect(await selectSupervisorHarness(config, { probe: probe({ "claude-code": true }) })).toMatchObject({
      harness: "claude-code",
      reason: expect.stringMatching(/pi: pi is missing/),
    });
    expect(await selectSupervisorHarness(config, { probe: probe({}) })).toBeUndefined();
    // The flat Pi form keeps Pi, unprobed, as before harnesses.
    let probed = false;
    const flat = parseSupervisorConfig({ provider: "minimax-cn", modelId: "MiniMax-M3" });
    expect(await selectSupervisorHarness(flat, { probe: async () => ((probed = true), { ok: false, reason: "x" }) })).toMatchObject({ harness: "pi" });
    expect(probed).toBe(false);
  });
});

describe("the Claude Code supervisor's launch", () => {
  it("reads the whole filesystem: no private /tmp, writable only where the scope says, no status fd", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-claude-launch-"));
    temps.push(dir);
    const scratch = path.join(dir, "scratch");
    const own = path.join(dir, "own");
    mkdirSync(own);
    const launched = claudeConfinement(scratch).launch("claude", ["-p"], { PATH: "/usr/bin" }, os.homedir(), { writable: [], trustedWritable: [own], readPaths: [os.homedir()] });
    expect(launched.command).toBe("bwrap");
    expect(launched.args).not.toContain("--tmpfs");
    expect(launched.args).not.toContain("--json-status-fd");
    expect(launched.args.join(" ")).toContain(`--bind ${own} ${own}`);
    expect(launched.args.slice(-3)).toEqual(["--", "claude", "-p"]);
    expect(launched.env.TMPDIR).toBe(path.join(scratch, "tmp"));
  });
});

const bwrapUnsupported = await confinementUnsupported();

/** A Claude Code stand-in on PATH-less exec: a wrapper that runs the fake with its queue and log inside the config dir. */
function fakeInstall(steps: unknown[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-claude-confined-"));
  temps.push(dir);
  const configDir = path.join(dir, "claude-config");
  mkdirSync(configDir, { recursive: true });
  // A login on disk, as `claude /login` leaves it; nothing reads its contents.
  writeFileSync(path.join(configDir, ".credentials.json"), "{}");
  const queue = path.join(configDir, "queue.json");
  const log = path.join(configDir, "log.jsonl");
  writeFileSync(queue, JSON.stringify(steps));
  writeFileSync(log, "");
  const bin = path.join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\nFAKE_CLAUDE_QUEUE='${queue}' FAKE_CLAUDE_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(bin, 0o755);
  const stateDir = path.join(dir, "state", "run-1");
  const worktree = path.join(dir, "worktree");
  const install = path.join(dir, "plugins", "hello");
  const candidate = path.join(stateDir, "repairs", "a1", "candidate");
  for (const d of [stateDir, worktree, install, candidate]) mkdirSync(d, { recursive: true });
  const config = parseSupervisorConfig({ claude: { command: bin, configDir, models: ["opus"] }, promptTimeoutMs: 20_000 });
  const invocations = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { cwd: string; prompt: string; resumed: boolean; apiKey: string | null });
  return { dir, configDir, stateDir, worktree, install, candidate, config, invocations };
}

function decision(d: GraphDecision): string {
  return `\`\`\`json\n${JSON.stringify(d)}\n\`\`\``;
}

function turn(stateDir: string): SupervisorInput {
  return {
    runId: "run-1",
    episodeId: "ep-1",
    trigger: { code: "executor_failed", message: "the fix job failed" },
    view: {
      runId: "run-1",
      task: { request: "fix it", repo: "." },
      current: { stageId: "fix", attempt: 1 },
      receipts: [],
      evidence: [],
      outstanding: [],
      budgets: { agentInvocations: 40, jobs: 10, decisions: 10, corrections: 4 },
      validatorBindings: [],
      generation: 1,
      stateRevision: 3,
      activeVersion: "hello@0.1.0",
    },
    maxWaitMs: 0,
    signal: AbortSignal.timeout(60_000),
    ...(stateDir === "" ? {} : {}),
  };
}

const attempt = (label: string, target: string) => ({ tool: "Bash", input: { command: `touch ${target}` }, ask: true, run: `echo ${label} > '${target}'` });

describe.skipIf(bwrapUnsupported !== undefined)("the Claude Code supervisor under bwrap (§6.1)", () => {
  it("can write only its scratch dir and its own config dir while deciding, and the candidate only while a patch is granted", async () => {
    const f = fakeInstall([]);
    const scratch = path.join(f.stateDir, "supervisor", "claude-code", "scratch");
    const stateFile = path.join(f.stateDir, "state.json");
    const REENTER = reenter({ stageId: "fix", reason: "flaky", evidenceRefs: ["ev-1"] }, "retry");
    writeFileSync(
      path.join(f.configDir, "queue.json"),
      JSON.stringify([
        {
          observe: [
            attempt("worktree", path.join(f.worktree, "w.txt")),
            attempt("install", path.join(f.install, "i.txt")),
            attempt("state", stateFile),
            attempt("candidate", path.join(f.candidate, "early.txt")),
            attempt("scratch", path.join(scratch, "s.txt")),
            attempt("own-state", path.join(f.configDir, "own.txt")),
          ],
          text: decision(REENTER),
        },
        { observe: [attempt("patch", path.join(f.candidate, "fix.txt")), attempt("worktree", path.join(f.worktree, "w2.txt"))], text: "Fixed it." },
        { observe: [attempt("late", path.join(f.candidate, "late.txt"))], text: decision(REENTER) },
      ]),
    );
    const harness = await claudeHarnessFor(f.config.claude, f.config, "run-1", f.stateDir);
    expect(await harness.probe()).toEqual({ ok: true });
    const host = await harness.start();
    try {
      await host.decide(turn(f.stateDir));
      const steps = host.drainInvestigation();
      // The shell's own exit status for a write the mount refuses (2 for dash's redirection).
      const refused = expect.not.objectContaining({ exitCode: 0 });
      expect(steps.map((s) => s.tool)).toEqual(["Bash", "Bash", "Bash", "Bash", "Bash", "Bash"]);
      expect(steps.slice(0, 4)).toEqual([refused, refused, refused, refused]);
      expect(steps.slice(4).map((s) => s.exitCode)).toEqual([0, 0]);
      expect(String(steps[0]!.output)).toMatch(/Read-only file system/i);
      for (const p of [path.join(f.worktree, "w.txt"), path.join(f.install, "i.txt"), stateFile, path.join(f.candidate, "early.txt")]) expect(existsSync(p)).toBe(false);
      expect(readFileSync(path.join(scratch, "s.txt"), "utf8")).toBe("scratch\n");

      await host.grantCandidateCoding(f.candidate);
      const patched = await host.patchCandidate!({ candidateRoot: f.candidate, target: "plugin", reason: "fix" });
      expect(patched.summary).toBe("Fixed it.");
      expect(readFileSync(path.join(f.candidate, "fix.txt"), "utf8")).toBe("patch\n");
      expect(existsSync(path.join(f.worktree, "w2.txt"))).toBe(false);
      expect(f.invocations()[1]).toMatchObject({ cwd: f.candidate, resumed: true });

      await host.revokeCandidateCoding();
      await host.decide({ ...turn(f.stateDir), rejection: { action: "reenter", reason: "again", remaining: 2 } });
      expect(existsSync(path.join(f.candidate, "late.txt"))).toBe(false);
      expect(f.invocations().every((i) => i.apiKey === null)).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("runs the repair reviewer on the same harness, read-only, in its own session", async () => {
    const f = fakeInstall([]);
    const repairsDir = path.join(f.stateDir, "repairs");
    // The controller's own record of the snapshot it issued.
    writeFileSync(path.join(repairsDir, "a1", "snapshot.json"), "{}");
    writeFileSync(path.join(f.candidate, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(f.install, "a.ts"), "export const a = 0;\n");
    writeFileSync(
      path.join(f.configDir, "queue.json"),
      JSON.stringify([{ observe: [attempt("reviewer", path.join(f.candidate, "a.ts"))], text: "VERDICT: approved\nThe patch fixes the constant." }]),
    );
    const reviewer = claudeRepairReviewer(f.config);
    const verdict = await reviewer.review({
      candidateRoot: path.join(repairsDir, "a1", "candidate"),
      baseRoot: f.install,
      baseDigest: "b",
      candidateDigest: "c",
      target: "plugin",
      reason: "wrong constant",
      task: "fix it",
      evidence: [],
      maxProviderCalls: 5,
    });
    expect(verdict).toEqual({ approved: true, reason: "The patch fixes the constant." });
    expect(readFileSync(path.join(f.candidate, "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(f.invocations()[0]!.cwd).toBe(f.candidate);
    expect(f.invocations()[0]!.prompt).toContain("Diff from the installed version to this candidate");
    expect(reviewer.drainProviderCalls!()).toBe(2);
    expect(existsSync(path.join(f.stateDir, "supervisor", "claude-code", "review"))).toBe(true);
    expect(await reviewer.review({ candidateRoot: f.candidate, baseRoot: f.install, baseDigest: "b", candidateDigest: "c", target: "plugin", reason: "x", task: "x", evidence: [] })).toMatchObject({ approved: false });
  });

  it("starts a run's supervisor on Claude Code and restores its binding on resume", async () => {
    const REENTER = reenter({ stageId: "fix", reason: "flaky", evidenceRefs: ["ev-1"] }, "retry");
    const f = fakeInstall([{ text: decision(REENTER) }, { text: decision(REENTER) }]);
    const started = (await supervisorFactoryFor(f.config, "claude-code")({ runId: "run-1", stateDir: f.stateDir })) as SupervisorHost;
    await started.decide(turn(f.stateDir));
    const { sessionFile, ...rest } = started.binding;
    const binding = { ...rest, ...(sessionFile !== undefined ? { sessionFile } : {}) };
    await started.close();
    expect(binding).toMatchObject({ harness: "claude-code", provider: "claude-code", modelId: "opus" });

    const restored = (await supervisorRestore(f.config)(binding, { runId: "run-1", stateDir: f.stateDir })) as SupervisorHost;
    try {
      expect(restored.sessionId).toBe(binding.sessionId);
      expect(restored.binding).toMatchObject({ harness: "claude-code", modelId: "opus" });
      await restored.decide(turn(f.stateDir));
      // A fresh Claude Code session; the old transcript is never reopened.
      const [first, second] = f.invocations();
      expect(second!.resumed).toBe(false);
      expect(second!.prompt).toContain("You are the GraphLoom run supervisor in recovery.");
      expect(first!.resumed).toBe(false);
    } finally {
      await restored.close();
    }
    // Pinned: a config that no longer enables Claude Code stops the resume.
    const piOnly = parseSupervisorConfig({ harnesses: ["pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } });
    await expect(supervisorRestore(piOnly)(binding, { runId: "run-1", stateDir: f.stateDir })).rejects.toThrow(/pin mismatch/);
    // And an unavailable Claude Code stops it too, rather than falling back.
    rmSync(path.join(f.configDir, ".credentials.json"));
    await expect(supervisorRestore(f.config)(binding, { runId: "run-1", stateDir: f.stateDir })).rejects.toThrow(/pin mismatch: .*not available here: .*claude \/login/);
  });
});
