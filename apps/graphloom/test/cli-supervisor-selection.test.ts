// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The built CLI's supervisor selection (design-supervisor-harnesses.md §7.3,
 * §7.4): `run` pins the harness at intake and says why, `inspect` shows the
 * pin and its transitions, a refusal refuses before the run exists, and
 * `resume --supervisor` and `switch-model` keep to the operator's harnesses
 * and the run's pin.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeCliEnv, type CliEnv } from "./cli-env.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const writer = [{ bash: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" }, { structured: { summary: "Wrote GREETING.txt." } }];
const reviewer = [{ bash: "cat GREETING.txt" }, { structured: { verdict: "approved", summary: "Reviewed: approved." } }];

/** A hello run on fake Claude Code with a flat Pi supervisor whose provider has a (stand-in) credential; no model call is made. */
async function env(): Promise<CliEnv> {
  const e = await makeCliEnv(cleanups);
  await e.fakeClaude({ byPrompt: [{ match: "independent read-only reviewer", steps: reviewer }, { match: "GREETING.txt", steps: writer }] });
  const agentDir = path.join(e.dir, "pi-agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(e.dir, "supervisor.json"), JSON.stringify({ provider: "minimax-cn", modelId: "MiniMax-M3", agentDir }));
  e.env.GRAPHLOOM_SUPERVISOR_CONFIG = path.join(e.dir, "supervisor.json");
  e.env.MINIMAX_CN_API_KEY = "stand-in-not-a-key";
  return e;
}

describe("graphloom run and resume: the supervisor pin", () => {
  it("run pins the selected harness at intake and inspect shows it; resume --supervisor and switch-model refuse what the pin and config do not allow", async () => {
    const e = await env();
    const run = await e.graphloom("run", "task.yaml");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toContain("supervisor: pi (operator: the operator's Pi supervisor config)");
    const { runId, stateDir } = JSON.parse(run.stdout) as { runId: string; stateDir: string };

    const inspected = JSON.parse((await e.graphloom("inspect", stateDir)).stdout) as { supervisorSelection?: Record<string, unknown>; supervisorTransitions: unknown[] };
    expect(inspected.supervisorSelection).toMatchObject({ harness: "pi", source: "operator", reason: "the operator's Pi supervisor config", generation: 1 });
    expect(inspected.supervisorSelection?.preference).toBeUndefined();
    expect(inspected.supervisorTransitions).toEqual([]);

    // The flat Pi form enables Pi alone: another harness is refused before the run is touched.
    const moved = await e.graphloom("resume", stateDir, "--supervisor", "claude-code");
    expect(moved.code).toBe(1);
    expect(moved.stderr).toContain("supervisor: --supervisor claude-code is not enabled in the operator's supervisor config (enabled: pi)");

    // switch-model takes a model of the pinned harness only.
    const cross = await e.graphloom("switch-model", stateDir, "claude-code/opus", "--reason", "try Claude");
    expect(cross.code).toBe(1);
    expect(cross.stderr).toContain(`claude-code/opus is a claude-code model, but run ${runId}'s supervisor is pinned to pi`);
    expect(cross.stderr).toContain(`graphloom resume ${runId} --supervisor claude-code`);
    const unknown = await e.graphloom("switch-model", stateDir, "deepseek/deepseek-v4-pro", "--reason", "x");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("deepseek/deepseek-v4-pro is not among the operator's pi supervisor models (minimax-cn/MiniMax-M3)");
  }, 120_000);

  it("run --supervisor with a harness the operator does not enable refuses before any run state exists", async () => {
    const e = await env();
    const run = await e.graphloom("run", "task.yaml", "--supervisor", "codex", "--state-root", e.stateRoot);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("supervisor: --supervisor codex is not enabled in the operator's supervisor config (enabled: pi)");
    expect(existsSync(e.stateRoot)).toBe(false);
    const bare = await e.graphloom("run", "task.yaml", "--supervisor");
    expect(bare.code).toBe(1);
    expect(bare.stderr).toContain("--supervisor needs a harness");
  }, 120_000);
});
