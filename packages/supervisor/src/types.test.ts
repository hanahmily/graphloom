import { describe, expect, it } from "vitest";
import { returnToNormal, stop } from "@graphloom/sdk";
import { createScriptedSupervisor } from "./types.js";

describe("createScriptedSupervisor", () => {
  it("returns canned decisions in order", async () => {
    const supervisor = createScriptedSupervisor({
      decisions: [
        returnToNormal({ summary: "first" }, "return"),
        stop({ reason: "done" }, "stop"),
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
    const first = await supervisor.decide(input);
    expect(first.action.type).toBe("return");
    const second = await supervisor.decide(input);
    expect(second.action.type).toBe("stop");
    await expect(supervisor.decide(input)).rejects.toThrow(/exhausted/);
  });
});
