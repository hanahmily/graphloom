// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { assertGraphDecision, returnToNormal, stop } from "@graphloom/sdk";
import { MAX_EPISODE_RECORDS, type SupervisorEpisodeRecord } from "./episode.js";
import { createScriptedSupervisor, isModelSwitchRequest, SCRIPTED_SUPERVISOR_EXHAUSTED, scriptedDecisionsConsumed } from "./types.js";

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

  it("starts at `start`, the decision a resumed run has not consumed yet", async () => {
    const supervisor = createScriptedSupervisor({
      decisions: [returnToNormal({ summary: "first" }, "return"), stop({ reason: "done", blocker: "none" }, "stop")],
      start: 1,
    });
    const decided = assertGraphDecision(await supervisor.decide(scriptedInput));
    expect(decided.action.type).toBe("stop");
    await expect(supervisor.decide(scriptedInput)).rejects.toThrow(SCRIPTED_SUPERVISOR_EXHAUSTED);
  });
});

const scriptedInput = {
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

describe("scriptedDecisionsConsumed", () => {
  const record = (fields: Partial<SupervisorEpisodeRecord>): SupervisorEpisodeRecord =>
    ({ episodeId: "ep1", turn: 1, runId: "r1", at: "2026-01-01T00:00:00.000Z", toolCalls: [], admission: { facts: {}, outcome: "admitted" }, providerCalls: 0, ...fields }) as SupervisorEpisodeRecord;

  it("counts every recorded decide() call, rejected or failed, except one that found the script exhausted", () => {
    expect(scriptedDecisionsConsumed(undefined)).toBe(0);
    expect(
      scriptedDecisionsConsumed([
        record({ proposal: returnToNormal({ summary: "a" }, "return") }),
        record({ turn: 2, proposal: stop({ reason: "x", blocker: "y" }, "stop"), admission: { facts: {}, outcome: "inadmissible" } as SupervisorEpisodeRecord["admission"] }),
        record({ turn: 3, error: "a malformed scripted proposal" }),
        record({ turn: 4, error: `${SCRIPTED_SUPERVISOR_EXHAUSTED}: decide called 4 times, only 3 scripted` }),
      ]),
    ).toBe(3);
  });

  it("refuses to guess once the records reached their cap, since older calls may have been dropped", () => {
    const full = Array.from({ length: MAX_EPISODE_RECORDS }, (_, i) => record({ turn: i + 1, proposal: returnToNormal({ summary: "a" }, "return") }));
    expect(() => scriptedDecisionsConsumed(full)).toThrow(/cannot be derived/);
    expect(scriptedDecisionsConsumed(full.slice(1))).toBe(MAX_EPISODE_RECORDS - 1);
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
