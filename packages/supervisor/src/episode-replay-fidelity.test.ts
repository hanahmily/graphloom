// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import {
  dispatch,
  returnToNormal,
  stop,
  validate,
  type CaseFile,
  type EvidenceRecord,
  type GraphDecision,
  type RunView,
} from "@graphloom/sdk";
import {
  buildEpisodeRecord,
  createEpisodeRecorder,
  MAX_EPISODE_RECORD_CHARS,
  type SupervisorEpisodeRecord,
} from "./episode.js";
import { replayEpisodes, type EpisodeLabel } from "./episode-replay.js";
import { buildRecoveryPrompt } from "./pi-supervisor.js";
import { createScriptedSupervisor, type SupervisorInput, type SupervisorInspection } from "./types.js";

function view(over: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    task: { request: "hi", repo: "." },
    current: { stageId: "fix", attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 4 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 2,
    activeVersion: "hello@0.1.0",
    ...over,
  };
}

function record(over: Partial<SupervisorEpisodeRecord> = {}): SupervisorEpisodeRecord {
  return {
    episodeId: "ep-1",
    turn: 1,
    runId: "run-1",
    at: "2026-10-01T00:00:00.000Z",
    input: { trigger: { code: "supervise", message: "m" }, view: view() },
    toolCalls: [],
    admission: { facts: { inRecovery: true, canQualify: true, qualifiedArtifactIds: ["cand-1"] }, rejections: [], outcome: "admitted" },
    providerCalls: 1,
    ...over,
  };
}

const anyLabel = (acceptable: EpisodeLabel["acceptable"], turn?: number): EpisodeLabel => ({ episodeId: "ep-1", ...(turn !== undefined ? { turn } : {}), acceptable });

async function replayOne(episode: SupervisorEpisodeRecord, label: EpisodeLabel, step: (input: SupervisorInput) => GraphDecision | Promise<GraphDecision>, extra: { cleanupMs?: number; timeoutMs?: number; calls?: () => number } = {}) {
  const score = await replayEpisodes({
    episodes: [episode],
    labels: [label],
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.cleanupMs !== undefined ? { cleanupMs: extra.cleanupMs } : {}),
    createSupervisor: () => {
      const s = createScriptedSupervisor({ decisions: [step] });
      return extra.calls === undefined ? s : { ...s, drainProviderCalls: extra.calls };
    },
  });
  return score.results[0]!;
}

function recorded(build: (inspect: SupervisorInspection) => Promise<unknown>, impl: Partial<SupervisorInspection>) {
  const recorder = createEpisodeRecorder();
  return build(recorder.inspect(impl as SupervisorInspection)).then(() => recorder);
}

describe("episode record bounds", () => {
  it("bounds a record whose size is in its view, trigger, proposal and facts, keeping each shape", () => {
    const huge = "x".repeat(200_000);
    const caseFile: CaseFile = {
      facts: Array.from({ length: 400 }, (_, i) => ({ id: `f${i}`, claim: huge }) as unknown as CaseFile["facts"][number]),
      refuted: [],
      attempts: [],
      open: [],
    };
    const built = buildEpisodeRecord({
      episodeId: "ep-1",
      turn: 1,
      runId: "run-1",
      trigger: { code: "supervise", message: huge },
      view: view({ task: { request: huge, repo: "." } }),
      caseFile,
      recorder: createEpisodeRecorder(),
      proposal: returnToNormal({ summary: huge }, huge),
      admission: { facts: { inRecovery: true, canQualify: true, qualifiedArtifactIds: Array.from({ length: 5_000 }, (_, i) => `cand-${i}`) }, rejections: [], outcome: "pending" },
      providerCalls: 0,
    });
    expect(JSON.stringify(built).length).toBeLessThanOrEqual(MAX_EPISODE_RECORD_CHARS);
    expect(built.truncated).toBe(true);
    expect(Array.isArray(built.input.caseFile?.facts)).toBe(true);
    expect(Array.isArray(built.input.caseFile?.open)).toBe(true);
    expect(typeof built.input.view.task.request).toBe("string");
    expect(Array.isArray(built.admission.facts?.qualifiedArtifactIds)).toBe(true);
  });

  it("keeps an oversized list_evidence result an array of records", async () => {
    const big: EvidenceRecord = { ref: "ev-1", kind: "review", stageId: "fix", payload: { text: "y".repeat(10_000) } } as unknown as EvidenceRecord;
    const recorder = await recorded(async (i) => i.listEvidence({}), { listEvidence: () => [big] });
    const call = recorder.toolCalls()[0]!;
    expect(Array.isArray(call.result)).toBe(true);
    expect(JSON.stringify(call.result).length).toBeLessThanOrEqual(8_000);
    const episode = record({ toolCalls: recorder.toolCalls() });
    let seen: unknown;
    await replayOne(episode, anyLabel([{ type: "return" }]), async (input) => {
      seen = input.inspect!.listEvidence({});
      return returnToNormal({ summary: "s" }, "r");
    });
    expect(Array.isArray(seen)).toBe(true);
  });

  it("keeps small evidence payloads, so the recovery prompt is the same live and replayed", () => {
    const evidence = [
      { ref: "ev-1", kind: "review", stageId: "review", generation: 1, payload: { producer: { stageId: "fix", purpose: "review" }, verdict: "approved" } },
    ] as unknown as EvidenceRecord[];
    const live: SupervisorInput = { runId: "run-1", episodeId: "ep-1", trigger: { code: "supervise", message: "m" }, view: view({ evidence }) };
    const built = buildEpisodeRecord({
      episodeId: "ep-1", turn: 1, runId: "run-1", trigger: live.trigger, view: live.view, recorder: createEpisodeRecorder(),
      admission: { rejections: [], outcome: "pending" }, providerCalls: 0,
    });
    const models = { current: { provider: "p", modelId: "m" }, configured: [{ provider: "p", modelId: "m" }] };
    expect(buildRecoveryPrompt({ ...live, view: built.input.view }, models)).toBe(buildRecoveryPrompt(live, models));
  });
});

describe("recorded tool calls", () => {
  it("replays concurrent identical calls in the order they started, not the order they settled", async () => {
    const results = [
      { probeId: "p1", accepted: true, reason: "slow", stateRevision: 2 },
      { probeId: "p2", accepted: false, reason: "fast", stateRevision: 2 },
    ];
    let n = 0;
    const recorder = await recorded(
      async (i) => Promise.all([i.checkValidate({ stageId: "fix" }), i.checkValidate({ stageId: "fix" })]),
      {
        checkValidate: async () => {
          const mine = results[n++]!;
          if (mine.probeId === "p1") await new Promise((r) => setTimeout(r, 15));
          return mine;
        },
      },
    );
    let replayed: string[] = [];
    await replayOne(record({ toolCalls: recorder.toolCalls() }), anyLabel([{ type: "return" }]), async (input) => {
      const both = await Promise.all([input.inspect!.checkValidate({ stageId: "fix" }), input.inspect!.checkValidate({ stageId: "fix" })]);
      replayed = both.map((r) => r.probeId);
      return returnToNormal({ summary: "s" }, "r");
    });
    expect(replayed).toEqual(["p1", "p2"]);
  });

  it("rejects a replayed call that rejected live, and never answers another input with a recorded result", async () => {
    const recorder = await recorded(
      async (i) => {
        await i.checkValidate({ stageId: "fix" }).catch(() => undefined);
        await i.checkValidate({ stageId: "other" });
      },
      { checkValidate: async (spec) => { if (spec.stageId === "fix") throw new Error("validator failed"); return { probeId: "p2", accepted: true, reason: "ok", stateRevision: 2 }; } },
    );
    const outcomes: string[] = [];
    await replayOne(record({ toolCalls: recorder.toolCalls() }), anyLabel([{ type: "return" }]), async (input) => {
      outcomes.push(await input.inspect!.checkValidate({ stageId: "fix" }).then(() => "resolved", (e: Error) => `rejected: ${e.message}`));
      const missing = await input.inspect!.checkValidate({ stageId: "never-recorded" });
      outcomes.push(`${missing.accepted}:${missing.reason}`);
      outcomes.push(await input.inspect!.readCandidate("a.txt").then(() => "resolved", () => "rejected"));
      return returnToNormal({ summary: "s" }, "r");
    });
    expect(outcomes).toEqual(["rejected: validator failed", "false:not recorded in this episode", "rejected"]);
  });

  it("replays record_finding from the recorded call", async () => {
    const recorder = createEpisodeRecorder();
    const finding = { kind: "fact", claim: "c", evidenceRefs: ["ev-1"] } as never;
    await recorder.recordFinding(async (_f: unknown) => ({ kept: true, id: "f1" }))(finding);
    let outcome: unknown;
    await replayOne(record({ toolCalls: recorder.toolCalls() }), anyLabel([{ type: "return" }]), async (input) => {
      outcome = await input.recordFinding!(finding);
      return returnToNormal({ summary: "s" }, "r");
    });
    expect(outcome).toEqual({ kept: true, id: "f1" });
  });
});

describe("replayed input", () => {
  it("restores the rejection and the provider-call and wait allowances of a retried call", async () => {
    const episode = record({
      turn: 2,
      input: {
        trigger: { code: "supervise", message: "m" },
        view: view(),
        rejection: { action: "validate", reason: "undeclared stage: nope", remaining: 2 },
        maxProviderCalls: 3,
        maxWaitMs: 4_000,
      },
    });
    let seen: SupervisorInput | undefined;
    const result = await replayOne(episode, anyLabel([{ type: "validate", stageId: "fix" }], 2), async (input) => {
      seen = input;
      return input.rejection === undefined ? stop({ reason: "x", blocker: "y" }, "x") : validate({ stageId: "fix" }, "corrected");
    });
    expect(result).toMatchObject({ turn: 2, proposed: "validate", correct: true });
    expect(seen).toMatchObject({ maxProviderCalls: 3, maxWaitMs: 4_000, rejection: { reason: "undeclared stage: nope" } });
  });

  it("keys labels by turn, so one episode can need different actions on successive calls", async () => {
    const episodes = [record({ turn: 1 }), record({ turn: 2 })];
    const labels: EpisodeLabel[] = [anyLabel([{ type: "validate" }], 1), anyLabel([{ type: "return" }], 2)];
    const score = await replayEpisodes({
      episodes,
      labels,
      createSupervisor: (e) => createScriptedSupervisor({ decisions: [e.turn === 1 ? validate({ stageId: "fix" }, "v") : returnToNormal({ summary: "s" }, "r")] }),
    });
    expect(score.results.map((r) => [r.turn, r.correct])).toEqual([[1, true], [2, true]]);
    await expect(
      replayEpisodes({ episodes, labels: [anyLabel([{ type: "return" }]), anyLabel([{ type: "return" }], 1)], createSupervisor: () => createScriptedSupervisor({ decisions: [] }) }),
    ).rejects.toThrow(/duplicate label/);
  });
});

describe("replay scoring", () => {
  it("refuses a proposal whose parameters fail the recorded facts, not only its type", async () => {
    const bad = await replayOne(
      record(),
      anyLabel([{ type: "activate_repair" }]),
      () => ({ action: { type: "activate_repair", activate: { qualifiedArtifactId: "cand-missing", reason: "r" } }, reason: "r" }),
    );
    expect(bad).toMatchObject({ correct: false, inadmissible: 1, inadmissibleStop: true });
    const good = await replayOne(
      record(),
      anyLabel([{ type: "activate_repair" }]),
      () => ({ action: { type: "activate_repair", activate: { qualifiedArtifactId: "cand-1", reason: "r" } }, reason: "r" }),
    );
    expect(good).toMatchObject({ correct: true, inadmissible: 0 });
    const noScope = await replayOne(
      record(),
      anyLabel([{ type: "dispatch" }]),
      () => ({ action: { type: "dispatch", job: { stageId: "fix", kind: "agent", purpose: "work", instruction: "i" } }, reason: "r" }) as GraphDecision,
    );
    expect(noScope).toMatchObject({ correct: false, inadmissible: 1 });
  });

  it("ends the turn once the rejection allowance is spent, even if a later proposal is acceptable", async () => {
    const result = await replayOne(record(), anyLabel([{ type: "return" }]), async (input) => {
      for (let i = 0; i < 3; i += 1) await input.admission!.refuse("validate", "undeclared stage");
      return returnToNormal({ summary: "s" }, "r");
    });
    expect(result).toMatchObject({ proposed: "return", correct: false, inadmissible: 3, inadmissibleStop: true });
  });

  it("scores a review dispatch wrong when the label asks for dispatch(work)", async () => {
    const label = anyLabel([{ type: "dispatch", stageId: "fix", purpose: "work" }]);
    const review = await replayOne(record(), label, () =>
      dispatch({ stageId: "fix", kind: "agent", purpose: "review", instruction: "again", readOnly: true }, "r"),
    );
    expect(review).toMatchObject({ correct: false, inadmissible: 0 });
    const work = await replayOne(record(), label, () =>
      dispatch({ stageId: "fix", kind: "agent", purpose: "work", instruction: "fix", writeScope: ["src"] }, "r"),
    );
    expect(work.correct).toBe(true);
  });

  it("collects usage after an aborted decide() has settled its calls", async () => {
    let calls = 0;
    const result = await replayOne(
      record(),
      anyLabel([{ type: "return" }]),
      (input) =>
        new Promise<GraphDecision>((_, reject) => {
          input.signal!.addEventListener("abort", () => setTimeout(() => { calls += 1; reject(new Error("aborted")); }, 10));
        }),
      { timeoutMs: 20, cleanupMs: 500, calls: () => calls },
    );
    expect(result.correct).toBe(false);
    expect(result.providerCalls).toBe(1);
  });

  it("refuses a dispatch whose write scope is invalid or contradicts readOnly", async () => {
    const send = (job: Record<string, unknown>) =>
      replayOne(record(), anyLabel([{ type: "dispatch" }]), () => ({ action: { type: "dispatch", job: { stageId: "fix", kind: "agent", instruction: "i", ...job } }, reason: "r" }) as GraphDecision);
    expect(await send({ purpose: "work", writeScope: ["../outside"] })).toMatchObject({ correct: false, inadmissible: 1 });
    expect(await send({ purpose: "review", readOnly: true, writeScope: ["src"] })).toMatchObject({ correct: false, inadmissible: 1 });
    expect(await send({ purpose: "work", writeScope: ["src"] })).toMatchObject({ correct: true, inadmissible: 0 });
  });

  it("carries the rejection allowance across a retried call", async () => {
    const episode = record({
      turn: 2,
      input: { trigger: { code: "supervise", message: "m" }, view: view(), rejection: { action: "validate", reason: "r", remaining: 1 } },
    });
    let remaining: number | undefined;
    const result = await replayOne(episode, anyLabel([{ type: "return" }], 2), async (input) => {
      remaining = (await input.admission!.refuse("validate", "again")).remaining;
      return returnToNormal({ summary: "s" }, "r");
    });
    expect(remaining).toBe(0);
    expect(result).toMatchObject({ proposed: "return", correct: false, inadmissible: 1, inadmissibleStop: true });
  });

  it("returns when decide() and close() both never settle, within the cleanup bound", async () => {
    const score = await replayEpisodes({
      episodes: [record()],
      labels: [anyLabel([{ type: "return" }])],
      timeoutMs: 5,
      cleanupMs: 5,
      createSupervisor: () => ({ decide: () => new Promise<never>(() => undefined), close: () => new Promise<void>(() => undefined) }),
    });
    expect(score.results[0]).toMatchObject({ correct: false });
  });

  it("bounds a record whose size is in object keys and in arrays that a limit of zero must empty", () => {
    const wide = Object.fromEntries(Array.from({ length: 8_000 }, (_, i) => [`k${i}`, i]));
    const evidence = [{ ref: "ev-1", kind: "review", stageId: "fix", payload: wide }] as unknown as EvidenceRecord[];
    const built = buildEpisodeRecord({
      episodeId: "ep-1", turn: 1, runId: "run-1", trigger: { code: "supervise", message: "m" }, view: view({ evidence }),
      recorder: createEpisodeRecorder(), admission: { rejections: [], outcome: "pending" }, providerCalls: 0,
    });
    expect(JSON.stringify(built).length).toBeLessThanOrEqual(MAX_EPISODE_RECORD_CHARS);
    expect(built.truncated).toBe(true);
  });

  it("keeps the record's structure when a 70,000-character key and 51 tool calls must be bounded", async () => {
    const recorder = createEpisodeRecorder();
    const inspection = recorder.inspect({ listReceipts: () => [] } as unknown as SupervisorInspection);
    for (let i = 0; i < 51; i += 1) inspection.listReceipts();
    const evidence = [{ ref: "ev-1", kind: "review", stageId: "fix", payload: { ["k".repeat(70_000)]: "v".repeat(70_000), ...Object.fromEntries(Array.from({ length: 3_000 }, (_, i) => [`n${i}`, i])) } }] as unknown as EvidenceRecord[];
    const built = buildEpisodeRecord({
      episodeId: "ep-1", turn: 1, runId: "run-1", trigger: { code: "supervise", message: "m" }, view: view({ evidence }),
      recorder, proposal: returnToNormal({ summary: "s" }, "r"), admission: { facts: { inRecovery: true, canQualify: true, qualifiedArtifactIds: [] }, rejections: [], outcome: "pending" }, providerCalls: 2,
    });
    expect(JSON.stringify(built).length).toBeLessThanOrEqual(MAX_EPISODE_RECORD_CHARS);
    expect(built.droppedToolCalls).toBe(1);
    expect(built.admission.outcome).toBe("pending");
    expect(built.providerCalls).toBe(2);
    for (const key of ["runId", "task", "current", "receipts", "evidence", "outstanding", "budgets", "validatorBindings", "generation", "stateRevision", "activeVersion"]) {
      expect(built.input.view).toHaveProperty(key);
    }
    const result = await replayOne(built, anyLabel([{ type: "return" }]), () => returnToNormal({ summary: "s" }, "r"));
    expect(result).toMatchObject({ correct: true });
  });

  it("refuses a dispatch to a stage other than the recorded current stage", async () => {
    const result = await replayOne(record(), anyLabel([{ type: "dispatch" }]), () =>
      dispatch({ stageId: "other", kind: "agent", purpose: "work", instruction: "i", writeScope: ["src"] }, "r"),
    );
    expect(result).toMatchObject({ correct: false, inadmissible: 1, inadmissibleStop: true });
  });

  it("reads usage after close(), which may settle the aborted decide()'s calls", async () => {
    let calls = 0;
    const score = await replayEpisodes({
      episodes: [record()],
      labels: [anyLabel([{ type: "return" }])],
      timeoutMs: 5,
      cleanupMs: 200,
      createSupervisor: () => ({
        decide: () => new Promise<never>(() => undefined),
        close: async () => {
          await new Promise((r) => setTimeout(r, 20));
          calls += 1;
        },
        drainProviderCalls: () => calls,
      }),
    });
    expect(score.results[0]!.providerCalls).toBe(1);
  });
});
