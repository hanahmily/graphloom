// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { returnToNormal } from "@graphloom/sdk";
import {
  createPiSupervisor,
  type PiSupervisorSessionPort,
  type SupervisorModelRef,
} from "./pi-supervisor.js";

function sampleInput() {
  return {
    runId: "r1",
    episodeId: "ep1",
    trigger: { code: "supervise" as const, message: "x" },
    view: {
      runId: "r1",
      task: { request: "hi", repo: "." },
      current: { stageId: "write", attempt: 1 },
      receipts: [],
      evidence: [],
      outstanding: [],
      budgets: { agentInvocations: 5, jobs: 5, decisions: 5, corrections: 2 },
      validatorBindings: [],
      generation: 1,
      stateRevision: 0,
      activeVersion: "hello@0.1.0",
    },
  };
}

describe("createPiSupervisor decide failures still count provider calls", () => {
  it("increments providerCalls for the reply and its one re-ask when both are malformed JSON", async () => {
    const session: PiSupervisorSessionPort = {
      runId: "r1",
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      credentialSource: "options",
      async prompt() {
        return "not json at all";
      },
      async setModel() {
        /* */
      },
      async close() {
        /* */
      },
    };
    const supervisor = createPiSupervisor({ session });
    await expect(supervisor.decide(sampleInput())).rejects.toThrow(
      /^supervisor provider malformed: the reply is neither a tool call nor GraphDecision JSON/,
    );
    // The unreadable reply is asked again once, with the parse error, before the turn fails.
    expect(supervisor.drainProviderCalls()).toBe(2);
    expect(supervisor.drainRemedies()).toMatchObject([{ failureClass: "malformed", remedy: "reask" }]);
  });
});

describe("setModel credential gating (session port contract)", () => {
  it("leaves the active model unchanged when setModel rejects", async () => {
    const configured: SupervisorModelRef[] = [
      { provider: "minimax-cn", modelId: "MiniMax-M3" },
      { provider: "openai", modelId: "gpt-4o" },
    ];
    let provider = "minimax-cn";
    let modelId = "MiniMax-M3";
    const session: PiSupervisorSessionPort = {
      runId: "r1",
      get provider() {
        return provider;
      },
      get modelId() {
        return modelId;
      },
      sessionId: "s1",
      sessionFile: "/tmp/s1.jsonl",
      credentialSource: "options",
      async prompt() {
        return JSON.stringify(returnToNormal({ summary: "ok" }, "ok"));
      },
      async setModel() {
        throw new Error("credential unavailable for provider openai");
      },
      async close() {
        /* */
      },
    };
    const supervisor = createPiSupervisor({ session, configuredModels: configured });
    await expect(
      supervisor.switchModel({
        provider: "openai",
        modelId: "gpt-4o",
        reason: "failover",
      }),
    ).rejects.toThrow(/credential unavailable/);
    expect(supervisor.binding.provider).toBe("minimax-cn");
    expect(supervisor.binding.modelId).toBe("MiniMax-M3");
    expect(supervisor.binding.switchJournal.at(-1)?.status).toBe("failed");
  });
});
