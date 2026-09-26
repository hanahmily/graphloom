import { describe, expect, it } from "vitest";
import { assertGraphDecision, returnToNormal, stop } from "@graphloom/sdk";
import { createScriptedSupervisor, isModelSwitchRequest } from "./types.js";

describe("createScriptedSupervisor", () => {
  it("returns canned decisions in order", async () => {
    const supervisor = createScriptedSupervisor({
      decisions: [
        returnToNormal({ summary: "first" }, "return"),
        stop({ reason: "done", blocker: "none" }, "stop"),
      ],
    });
    const input = {
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
        budgets: { agentInvocations: 1, jobs: 1, decisions: 1, corrections: 1 },
        validatorBindings: [],
        generation: 1,
        stateRevision: 0,
        activeVersion: "hello@0.1.0",
      },
    };
    const first = assertGraphDecision(await supervisor.decide(input));
    expect(first.action.type).toBe("return");
    const second = assertGraphDecision(await supervisor.decide(input));
    expect(second.action.type).toBe("stop");
    await expect(supervisor.decide(input)).rejects.toThrow(/exhausted/);
  });
});

describe("isModelSwitchRequest", () => {
  it("requires provider, modelId, and reason as strings", () => {
    expect(isModelSwitchRequest({ type: "switch_model", provider: "deepseek", modelId: "deepseek-chat", reason: "r" })).toBe(
      true,
    );
    expect(isModelSwitchRequest({ type: "switch_model" })).toBe(false);
    expect(isModelSwitchRequest({ type: "switch_model", provider: "deepseek", modelId: 7, reason: "r" })).toBe(false);
    expect(isModelSwitchRequest({ type: "switch_model", provider: "deepseek", modelId: "m" })).toBe(false);
  });
});
