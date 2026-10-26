// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REHEARSAL_ADVERSARIAL_ENV, REHEARSAL_SYNTHESIZED_ENV, type ExecutorContext, type RehearsalScenario } from "@graphloom/sdk";
import { createClaudeCodeHarness } from "../claude.js";
import { createCodingAgentExecutor } from "../index.js";
import { REHEARSAL_HOME_ENV, REHEARSAL_SCENARIO_ENV, resetRehearsalScenarioCache } from "./scenario.js";

// The real, unmodified Claude Code harness spawns this compiled stand-in
// exactly as it would spawn a real `claude` binary; `npm test`'s own script
// builds and chmods it first (executors/coding-agent/package.json).
const claudeStandIn = fileURLToPath(new URL("../../dist/rehearsal/claude-standin.js", import.meta.url));

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  resetRehearsalScenarioCache();
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

function payload(result: unknown) {
  return (result as { evidence: [{ payload: { codingAgent: Record<string, unknown> } }] }).evidence[0].payload.codingAgent;
}

const contract = {
  name: "review-verdict-v1",
  schema: {
    type: "object",
    properties: { verdict: { type: "string", enum: ["approved", "request_changes"] }, summary: { type: "string" } },
    required: ["verdict", "summary"],
  },
};

describe("Claude Code rehearsal stand-in", () => {
  async function ready(scenario: RehearsalScenario) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-claude-rehearsal-"));
    temps.push(dir);
    const worktree = path.join(dir, "worktree");
    const home = path.join(dir, "home");
    const configDir = path.join(dir, "claude-config");
    await mkdir(worktree, { recursive: true });
    const scenarioPath = path.join(dir, "scenario.json");
    await writeFile(scenarioPath, JSON.stringify(scenario), "utf8");
    vi.stubEnv(REHEARSAL_SCENARIO_ENV, scenarioPath);
    vi.stubEnv(REHEARSAL_HOME_ENV, home);
    // minimalEnv strips everything but the basics from the spawned stand-in's
    // own environment; passEnv is what actually carries these two across,
    // exactly as a real rehearsal's RunnerConfig does (apps/graphloom/src/rehearsal.ts).
    const executor = createCodingAgentExecutor(
      createClaudeCodeHarness({
        command: claudeStandIn,
        configDir,
        killGraceMs: 500,
        interruptGraceMs: 200,
        passEnv: [REHEARSAL_SCENARIO_ENV, REHEARSAL_HOME_ENV, REHEARSAL_SYNTHESIZED_ENV, REHEARSAL_ADVERSARIAL_ENV],
      }),
    );
    const ctx = (over: Partial<ExecutorContext> = {}): ExecutorContext => ({
      runId: "r1",
      operationId: "op1",
      generation: 1,
      worktreePath: worktree,
      artifactDir: dir,
      readOnly: false,
      usage: { reserveModelCall: async () => true },
      ...over,
    });
    return { executor, ctx, worktree };
  }

  it("refuses to run without a scenario (the seam guard)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-claude-rehearsal-"));
    temps.push(dir);
    const worktree = path.join(dir, "worktree");
    await mkdir(worktree, { recursive: true });
    const executor = createCodingAgentExecutor(
      createClaudeCodeHarness({ command: claudeStandIn, configDir: path.join(dir, "claude-config"), killGraceMs: 500 }),
    );
    const ctx: ExecutorContext = {
      runId: "r1",
      operationId: "op1",
      generation: 1,
      worktreePath: worktree,
      artifactDir: dir,
      readOnly: false,
      usage: { reserveModelCall: async () => true },
    };
    const result = await executor.execute({ assignment: "review" }, ctx);
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("refuses to impersonate") });
  });

  it("drives the real Claude Code harness end to end from a scripted reply", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "looks right" } }] },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "looks right" } });
  });

  it("refuses to emit a field the assignment never asked for", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "looks right" } }] },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("summary") });
  });

  it("passes a field declared harnessSupplied without it being named", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "looks right" }, harnessSupplied: ["summary"] }] },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
  });

  it("writes a reply's effects into the worktree before submitting", async () => {
    const { executor, ctx, worktree } = await ready({
      results: {
        "review-verdict-v1": [
          { output: { verdict: "approved", summary: "looks right" }, effects: [{ path: "NOTES.md", bytes: "reviewed\n" }] },
        ],
      },
      expect: { status: "succeeded" },
    });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract, writeScope: ["."] }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(await readFile(path.join(worktree, "NOTES.md"), "utf8")).toBe("reviewed\n");
  });

  it("synthesizes a minimal reply when the scenario names no reply for the contract", async () => {
    const { executor, ctx } = await ready({ results: {}, expect: { status: "succeeded" } });
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "summary" } });
  });

  it("--synthesized ignores a scripted reply and synthesizes instead", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "request_changes", summary: "scripted" } }] },
      expect: { status: "succeeded" },
    });
    vi.stubEnv(REHEARSAL_SYNTHESIZED_ENV, "1");
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "ok" });
    expect(payload(result)).toMatchObject({ output: { verdict: "approved", summary: "summary" } });
  });

  it("--adversarial drops a required property; Claude has no further turn to correct it, so the job fails as a contract violation", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ output: { verdict: "approved", summary: "scripted" } }] },
      expect: { status: "stopped" },
    });
    vi.stubEnv(REHEARSAL_ADVERSARIAL_ENV, "1");
    const result = await executor.execute(
      { assignment: "Review the change and return a verdict and a summary." },
      ctx({ resultContract: contract }),
    );
    expect(result).toMatchObject({ status: "failed", failureKind: "contract_violation" });
  });

  it("fails the job without submitting when the reply scripts no-result", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ fail: { kind: "no-result" } }] },
      expect: { status: "stopped" },
    });
    const result = await executor.execute({ assignment: "Review the change." }, ctx({ resultContract: contract }));
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("without submitting") });
  });

  it("fails the job with the scripted summary when the reply scripts exit", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ fail: { kind: "exit", summary: "simulated provider outage" } }] },
      expect: { status: "stopped" },
    });
    const result = await executor.execute({ assignment: "Review the change." }, ctx({ resultContract: contract }));
    expect(result).toMatchObject({ status: "failed", summary: expect.stringContaining("simulated provider outage") });
  });

  it("aborts a hang reply when the job's own signal aborts first", async () => {
    const { executor, ctx } = await ready({
      results: { "review-verdict-v1": [{ fail: { kind: "hang", ms: 60_000 } }] },
      expect: { status: "stopped" },
    });
    const controller = new AbortController();
    const resultPromise = executor.execute(
      { assignment: "Review the change." },
      ctx({ resultContract: contract, signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 50);
    const result = await resultPromise;
    expect(result).toMatchObject({ status: "failed", summary: "agent session aborted" });
  }, 10_000);
});
