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
import { codexRepairReviewer, harnessRepairDeps } from "../src/repair-config.js";
import { codexHarnessFor, parseCodexSupervisorConfig } from "../src/supervisor-codex.js";
import { parseSupervisorConfig, selectSupervisorHarness, supervisorFactoryFor, supervisorRestore } from "../src/supervisor-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.resolve(here, "../../../packages/supervisor/test/fake-codex.mjs");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("supervisor.json codex section (design-supervisor-harnesses.md §7.2)", () => {
  it("enables Codex with its models, home, and command, in the built-in order", () => {
    const config = parseSupervisorConfig({
      codex: { models: ["gpt-5-codex", "codex/gpt-5-codex-mini", { modelId: "o4", thinkingLevel: "high" }], codexHome: "~/.codex-work", command: "/opt/codex" },
      claude: {},
      pi: { provider: "minimax-cn", modelId: "MiniMax-M3" },
    });
    expect(config.harnesses).toEqual(["pi", "claude-code", "codex"]);
    expect(config.codex).toEqual({
      models: [
        { provider: "codex", modelId: "gpt-5-codex" },
        { provider: "codex", modelId: "gpt-5-codex-mini" },
        { provider: "codex", modelId: "o4", thinkingLevel: "high" },
      ],
      codexHome: path.join(os.homedir(), ".codex-work"),
      command: "/opt/codex",
    });
    expect(parseSupervisorConfig({ codex: {} }).codex?.models).toEqual([{ provider: "codex", modelId: "default" }]);
    expect(parseSupervisorConfig({ harnesses: ["codex"], select: "codex", codex: {} })).toMatchObject({ harnesses: ["codex"], select: "codex" });
  });

  it("refuses secrets and API keys: the Codex login only", () => {
    expect(() => parseSupervisorConfig({ codex: { apiKey: "sk" } })).toThrow(/own Codex login.*Pi supervisor's route/);
    expect(() => parseSupervisorConfig({ codex: { passEnv: ["OPENAI_API_KEY"] } })).toThrow(/cannot include OPENAI_API_KEY/);
    expect(() => parseSupervisorConfig({ codex: { passEnv: ["CODEX_API_KEY"] } })).toThrow(/cannot include CODEX_API_KEY/);
    expect(() => parseCodexSupervisorConfig({ models: [] }, "x")).toThrow(/non-empty array/);
    expect(() => parseCodexSupervisorConfig({ models: [{ provider: "openai", modelId: "gpt-5" }] }, "x")).toThrow(/provider must be codex/);
  });

  it("selects codex by --supervisor or select when enabled and available, and falls back past it in order", async () => {
    const config = parseSupervisorConfig({ pi: { provider: "minimax-cn", modelId: "MiniMax-M3" }, codex: {} });
    const probe = (available: Record<string, boolean>) => async (h: string) => (available[h] === true ? ({ ok: true } as const) : ({ ok: false, reason: `${h} is missing` } as const));
    expect(await selectSupervisorHarness(config, { flag: "codex", probe: probe({ codex: true }) })).toMatchObject({ harness: "codex", source: "flag" });
    await expect(selectSupervisorHarness(config, { flag: "codex", probe: probe({}) })).rejects.toThrow(/--supervisor codex is not available: codex is missing/);
    await expect(selectSupervisorHarness(config, { flag: "claude-code", probe: probe({ "claude-code": true }) })).rejects.toThrow(/not enabled .*enabled: pi, codex/);
    expect(await selectSupervisorHarness(config, { probe: probe({ codex: true }) })).toMatchObject({ harness: "codex", source: "fallback", reason: expect.stringMatching(/pi: pi is missing/) });
  });
});

const bwrapUnsupported = await confinementUnsupported();

/** A Codex stand-in on PATH-less exec: a wrapper that runs the fake with its queue and log inside the Codex home. */
function fakeInstall(steps: unknown[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-codex-confined-"));
  temps.push(dir);
  const codexHome = path.join(dir, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  // A login on disk, as `codex login` leaves it; the fake's `login status` looks for it.
  writeFileSync(path.join(codexHome, "auth.json"), "{}");
  const queue = path.join(codexHome, "queue.json");
  const log = path.join(codexHome, "log.jsonl");
  writeFileSync(queue, JSON.stringify(steps));
  writeFileSync(log, "");
  const bin = path.join(dir, "codex");
  writeFileSync(bin, `#!/bin/sh\nFAKE_CODEX_QUEUE='${queue}' FAKE_CODEX_LOG='${log}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(bin, 0o755);
  const stateDir = path.join(dir, "state", "run-1");
  const worktree = path.join(dir, "worktree");
  const install = path.join(dir, "plugins", "hello");
  const candidate = path.join(stateDir, "repairs", "a1", "candidate");
  for (const d of [stateDir, worktree, install, candidate]) mkdirSync(d, { recursive: true });
  const config = parseSupervisorConfig({ codex: { command: bin, codexHome, models: ["gpt-5-codex"] }, promptTimeoutMs: 20_000 });
  const invocations = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { cwd: string; prompt: string; resumed: boolean; apiKey: string | null; argv: string[] });
  const setQueue = (next: unknown[]) => writeFileSync(queue, JSON.stringify(next));
  return { dir, codexHome, stateDir, worktree, install, candidate, config, invocations, setQueue };
}

function decision(d: GraphDecision): string {
  return `\`\`\`json\n${JSON.stringify(d)}\n\`\`\``;
}

function turn(): SupervisorInput {
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
  };
}

const attempt = (label: string, target: string) => ({ type: "command_execution", command: `touch ${target}`, run: `echo ${label} > '${target}'` });
const REENTER = reenter({ stageId: "fix", reason: "flaky", evidenceRefs: ["ev-1"] }, "retry");

describe.skipIf(bwrapUnsupported !== undefined)("the Codex supervisor under bwrap (§6.1)", () => {
  it("can write only its scratch dir and Codex's home while deciding, and the candidate only while a patch is granted", async () => {
    const f = fakeInstall();
    const scratch = path.join(f.stateDir, "supervisor", "codex", "scratch");
    const stateFile = path.join(f.stateDir, "state.json");
    f.setQueue([
      {
        observe: [
          attempt("worktree", path.join(f.worktree, "w.txt")),
          attempt("install", path.join(f.install, "i.txt")),
          attempt("state", stateFile),
          attempt("candidate", path.join(f.candidate, "early.txt")),
          attempt("scratch", path.join(scratch, "s.txt")),
          attempt("own-state", path.join(f.codexHome, "own.txt")),
        ],
        text: decision(REENTER),
      },
      { observe: [attempt("patch", path.join(f.candidate, "fix.txt")), attempt("worktree", path.join(f.worktree, "w2.txt"))], text: "Fixed it." },
      { observe: [attempt("late", path.join(f.candidate, "late.txt"))], text: decision(REENTER) },
    ]);
    const harness = await codexHarnessFor(f.config.codex, f.config, "run-1", f.stateDir);
    expect(await harness.probe()).toEqual({ ok: true });
    const host = await harness.start();
    try {
      await host.decide(turn());
      const steps = host.drainInvestigation();
      expect(steps.map((s) => s.tool)).toEqual(Array(6).fill("command_execution"));
      const refused = expect.not.objectContaining({ exitCode: 0 });
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
      // `exec resume` with --cd at the candidate root, in the same thread.
      expect(f.invocations()[1]).toMatchObject({ cwd: f.candidate, resumed: true });

      await host.revokeCandidateCoding();
      await host.decide({ ...turn(), rejection: { action: "reenter", reason: "again", remaining: 2 } });
      expect(existsSync(path.join(f.candidate, "late.txt"))).toBe(false);
      expect(f.invocations().every((i) => i.apiKey === null && i.argv.includes("danger-full-access"))).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("runs the repair reviewer on the same harness, read-only, in its own session", async () => {
    const f = fakeInstall();
    const repairsDir = path.join(f.stateDir, "repairs");
    writeFileSync(path.join(repairsDir, "a1", "snapshot.json"), "{}");
    writeFileSync(path.join(f.candidate, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(f.install, "a.ts"), "export const a = 0;\n");
    f.setQueue([{ observe: [attempt("reviewer", path.join(f.candidate, "a.ts"))], text: "VERDICT: approved\nThe patch fixes the constant." }]);
    const reviewer = codexRepairReviewer(f.config);
    expect(harnessRepairDeps("codex", f.config, f.install).reviewer).toBeDefined();
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
    expect(existsSync(path.join(f.stateDir, "supervisor", "codex", "review"))).toBe(true);
  });

  it("starts a run's supervisor on Codex and restores its binding on resume, pinned", async () => {
    const f = fakeInstall([{ text: decision(REENTER) }, { text: decision(REENTER) }]);
    const started = (await supervisorFactoryFor(f.config, "codex")({ runId: "run-1", stateDir: f.stateDir })) as SupervisorHost;
    await started.decide(turn());
    const { sessionFile, ...rest } = started.binding;
    const binding = { ...rest, ...(sessionFile !== undefined ? { sessionFile } : {}) };
    await started.close();
    expect(binding).toMatchObject({ harness: "codex", provider: "codex", modelId: "gpt-5-codex" });
    expect(binding.sessionFile).toMatch(/supervisor\/codex\/codex-session-[0-9a-f-]{36}\.json$/);

    const restored = (await supervisorRestore(f.config)(binding, { runId: "run-1", stateDir: f.stateDir })) as SupervisorHost;
    try {
      expect(restored.sessionId).toBe(binding.sessionId);
      await restored.decide(turn());
      const [first, second] = f.invocations();
      expect(second!.resumed).toBe(false);
      expect(second!.prompt).toContain("You are the GraphLoom run supervisor in recovery.");
      expect(first!.resumed).toBe(false);
    } finally {
      await restored.close();
    }
    const piOnly = parseSupervisorConfig({ harnesses: ["pi"], pi: { provider: "minimax-cn", modelId: "MiniMax-M3" } });
    await expect(supervisorRestore(piOnly)(binding, { runId: "run-1", stateDir: f.stateDir })).rejects.toThrow(/pin mismatch/);
    rmSync(path.join(f.codexHome, "auth.json"));
    await expect(supervisorRestore(f.config)(binding, { runId: "run-1", stateDir: f.stateDir })).rejects.toThrow(/pin mismatch: .*not available here: .*codex login/);
  });
});
