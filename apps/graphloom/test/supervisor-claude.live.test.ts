// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Opt-in live episode on the user's own Claude Code subscription
 * (design-supervisor-harnesses.md §9 "Live"): GRAPHLOOM_SUPERVISOR_LIVE=claude-code.
 * Runs the real `claude` under bwrap with the user's login and no API key: one
 * recovery episode (an executor_failed the agent investigates and resolves
 * without stopping), a resume across a restart from the binding, and one
 * independent repair review. GRAPHLOOM_SUPERVISOR_LIVE_MODEL picks the model
 * (default haiku, the cheapest).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { GraphDecision } from "@graphloom/sdk";
import type { SupervisorHost, SupervisorInput } from "@graphloom/supervisor";
import { claudeRepairReviewer } from "../src/repair-config.js";
import { claudeHarnessFor } from "../src/supervisor-claude.js";
import { parseSupervisorConfig } from "../src/supervisor-config.js";

const live = process.env.GRAPHLOOM_SUPERVISOR_LIVE === "claude-code";
const model = process.env.GRAPHLOOM_SUPERVISOR_LIVE_MODEL || "haiku";
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function layout() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gl-claude-live-"));
  temps.push(dir);
  const stateDir = path.join(dir, "state", "run-live");
  const worktree = path.join(dir, "worktree");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, "greet.sh"), "#!/bin/sh\nech 'Hello, GraphLoom!'\n");
  return { dir, stateDir, worktree };
}

function turn(episodeId: string, worktree: string, checked: GraphDecision[]): SupervisorInput {
  const evidence = {
    ref: "ev-1",
    kind: "command",
    stageId: "write",
    generation: 1,
    payload: { exitCode: 127, command: `sh ${path.join(worktree, "greet.sh")}`, stderr: "greet.sh: 2: ech: not found", summary: "the greeting script failed" },
  };
  return {
    runId: "run-live",
    episodeId,
    trigger: { code: "executor_failed", message: `the write stage's command job failed: sh ${path.join(worktree, "greet.sh")} exited 127 (ech: not found)`, evidenceRefs: ["ev-1"] },
    view: {
      runId: "run-live",
      task: { request: "make greet.sh print the greeting", repo: worktree },
      current: { stageId: "write", attempt: 1 },
      receipts: [],
      evidence: [evidence as never],
      outstanding: [],
      budgets: { agentInvocations: 30, jobs: 10, decisions: 10, corrections: 4 },
      validatorBindings: [],
      generation: 1,
      stateRevision: 3,
      activeVersion: "hello@0.1.0",
    },
    maxProviderCalls: 12,
    maxWaitMs: 0,
    admission: {
      facts: { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] },
      async check(decision) {
        checked.push(decision);
        // The run has budget and authority left: a stop is not the remedy here.
        return decision.action.type === "stop" ? { action: "stop", reason: "budgets and authority remain; retry the stage", remaining: 2 } : undefined;
      },
      async refuse(action, reason) {
        return { action, reason, remaining: 2 };
      },
    },
  };
}

describe.skipIf(!live)("Claude Code supervisor (live, your Claude Code login)", () => {
  it("investigates an executor failure, decides without stopping, and resumes from its binding", async () => {
    const { stateDir, worktree } = layout();
    const config = parseSupervisorConfig({ claude: { models: [model] } });
    const harness = await claudeHarnessFor(config.claude, config, "run-live", stateDir);
    expect(await harness.probe()).toEqual({ ok: true });
    const checked: GraphDecision[] = [];
    let host: SupervisorHost = await harness.start();
    let binding: SupervisorHost["binding"] | undefined;
    try {
      const proposal = await host.decide({ ...turn("ep-1", worktree, checked) });
      expect("action" in proposal && proposal.action.type).not.toBe("stop");
      const steps = host.drainInvestigation();
      console.log(`live: ${JSON.stringify(proposal)}\nsteps: ${steps.map((s) => `${s.id} ${s.tool}`).join(", ")}\nremedies: ${JSON.stringify(host.drainRemedies())}`);
      binding = host.binding;
      expect(binding).toMatchObject({ harness: "claude-code", provider: "claude-code", modelId: model });
    } finally {
      await host.close();
    }
    // A controller restart: the binding restores the logical supervisor in a fresh session.
    host = await harness.restore(binding!);
    try {
      expect(host.sessionId).toBe(binding!.sessionId);
      const again = await host.decide(turn("ep-2", worktree, checked));
      expect("action" in again && again.action.type).not.toBe("stop");
    } finally {
      await host.close();
    }
  }, 600_000);

  it("reviews a repair candidate independently and rejects one that admits it breaks the contract", async () => {
    const { dir } = layout();
    const repairsDir = path.join(dir, "state", "run-live", "repairs");
    const root = path.join(repairsDir, "repair-1", "candidate");
    const base = path.join(dir, "base");
    mkdirSync(root, { recursive: true });
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(repairsDir, "repair-1", "snapshot.json"), "{}");
    writeFileSync(path.join(base, "validator.js"), "export function evaluate(input) {\n  return { status: input === '' ? 'failed' : 'passed' };\n}\n");
    writeFileSync(
      path.join(root, "validator.js"),
      "// KNOWN DEFECT: this patch makes evaluate() always return `passed`, even for empty input.\nexport function evaluate(input) {\n  return { status: 'passed' };\n}\n",
    );
    const reviewer = claudeRepairReviewer(parseSupervisorConfig({ claude: { models: [model] } }));
    const verdict = await reviewer.review({
      candidateRoot: root,
      baseRoot: base,
      baseDigest: "base",
      candidateDigest: "candidate",
      target: "validator",
      reason: "the validator lets an empty input through, contrary to the requirement",
      task: "Fix evaluate() to reject empty input.",
      requirement: "evaluate() must return `failed` when the input is empty",
      evidence: [],
      maxProviderCalls: 8,
    });
    console.log(`live review: ${JSON.stringify(verdict)}; calls ${reviewer.drainProviderCalls!()}`);
    expect(verdict.approved).toBe(false);
  }, 600_000);
});
