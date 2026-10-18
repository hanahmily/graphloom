import { describe, expect, it } from "vitest";
import { dispatch, reenter, returnToNormal, stop, validate, type GraphDecision, type RunView } from "@graphloom/sdk";
import { buildEpisodeRecord, createEpisodeRecorder, MAX_EPISODE_RECORD_CHARS, type SupervisorEpisodeRecord } from "./episode.js";
import { loadReplayFixtures, replayEpisodes, type EpisodeLabel } from "./episode-replay.js";
import { createScriptedSupervisor, type Supervisor, type SupervisorInspection } from "./types.js";

function view(stageId: string): RunView {
  return {
    runId: "run-1",
    task: { request: "hi", repo: "." },
    current: { stageId, attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    budgets: { agentInvocations: 10, jobs: 10, decisions: 10, corrections: 4 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 2,
    activeVersion: "hello@0.1.0",
  };
}

function episode(id: string, facts = { inRecovery: true, canQualify: true, qualifiedArtifactIds: [] as string[] }): SupervisorEpisodeRecord {
  return {
    episodeId: id,
    turn: 1,
    runId: "run-1",
    at: "2026-10-01T00:00:00.000Z",
    input: { trigger: { code: "supervise", message: "unfamiliar failure" }, view: view("fix") },
    toolCalls: [
      {
        name: "check_validate",
        input: { stageId: "fix" },
        result: { probeId: "probe-1", accepted: true, reason: "passes", stateRevision: 2 },
      },
    ],
    admission: { facts, rejections: [], outcome: "admitted" },
    providerCalls: 1,
  };
}

describe("replayEpisodes", () => {
  it("scores proposals against labeled acceptable actions and reports per-episode probes, tokens and inadmissible proposals", async () => {
    const episodes = [episode("ep-validate"), episode("ep-return"), episode("ep-reenter")];
    const labels: EpisodeLabel[] = [
      { episodeId: "ep-validate", acceptable: [{ type: "validate", stageId: "fix" }] },
      { episodeId: "ep-return", acceptable: [{ type: "return" }] },
      { episodeId: "ep-reenter", acceptable: [{ type: "reenter", stageId: "fix" }, { type: "dispatch", stageId: "fix" }] },
    ];
    const answers: Record<string, (probe: () => Promise<unknown>) => Promise<GraphDecision>> = {
      // Probes once, then the right answer.
      "ep-validate": async (probe) => {
        await probe();
        return validate({ stageId: "fix" }, "fix is complete");
      },
      // Right answer without probing.
      "ep-return": async () => returnToNormal({ summary: "candidate already active" }, "return"),
      // Probes twice, then the wrong answer.
      "ep-reenter": async (probe) => {
        await probe();
        await probe();
        return stop({ reason: "give up", blocker: "x" }, "stop");
      },
    };
    const tokens: Record<string, number> = { "ep-validate": 100, "ep-return": 40, "ep-reenter": 160 };
    const score = await replayEpisodes({
      episodes,
      labels,
      createSupervisor: (e) =>
        createScriptedSupervisor({
          decisions: [
            (input) => answers[e.episodeId]!(() => input.inspect!.checkValidate({ stageId: "fix" })),
          ],
        }),
      tokens: (_s: Supervisor, e) => tokens[e.episodeId]!,
    });
    expect(score.episodes).toBe(3);
    expect(score.correct).toBe(2);
    expect(score.accuracy).toBeCloseTo(2 / 3);
    expect(score.results.map((r) => [r.episodeId, r.correct, r.proposed])).toEqual([
      ["ep-validate", true, "validate"],
      ["ep-return", true, "return"],
      ["ep-reenter", false, "stop"],
    ]);
    expect(score.results.map((r) => r.probes)).toEqual([1, 0, 2]);
    expect(score.probesPerEpisode).toBeCloseTo(1);
    expect(score.results.map((r) => r.tokens)).toEqual([100, 40, 160]);
    expect(score.tokensPerEpisode).toBeCloseTo(100);
    expect(score.results.map((r) => r.inadmissible)).toEqual([0, 0, 0]);
    expect(score.inadmissibleStops).toBe(0);
  });

  it("counts a proposal the recorded admission facts refuse and scores it wrong", async () => {
    const closed = { inRecovery: true, canQualify: false, qualifiedArtifactIds: [] as string[] };
    const score = await replayEpisodes({
      episodes: [episode("ep-1", closed)],
      labels: [{ episodeId: "ep-1", acceptable: [{ type: "qualify_repair" }] }],
      createSupervisor: () =>
        createScriptedSupervisor({
          decisions: [{ action: { type: "qualify_repair", qualify: { target: "plugin", reason: "r" } }, reason: "repair" }],
        }),
    });
    expect(score.results[0]).toMatchObject({ proposed: "qualify_repair", correct: false, inadmissible: 1, inadmissibleStop: true });
    expect(score.inadmissibleStops).toBe(1);
  });

  it("fails an episode whose decide() never settles and aborts its signal", async () => {
    let signal: AbortSignal | undefined;
    const score = await replayEpisodes({
      episodes: [episode("ep-1")],
      labels: [{ episodeId: "ep-1", acceptable: [{ type: "return" }] }],
      timeoutMs: 20,
      cleanupMs: 10,
      createSupervisor: () =>
        createScriptedSupervisor({
          decisions: [
            (input) => {
              signal = input.signal;
              return new Promise<never>(() => undefined);
            },
          ],
        }),
    });
    expect(score.results[0]).toMatchObject({ correct: false });
    expect(score.results[0]?.error).toMatch(/did not settle/);
    expect(signal?.aborted).toBe(true);
  });

  it("replays the committed fixtures of run 9bfa446d-4ea against the scripted baseline with no inadmissible stops", async () => {
    const { episodes, labels } = await loadReplayFixtures();
    expect(episodes.length).toBeGreaterThanOrEqual(10);
    const byId = new Map(labels.map((l) => [l.episodeId, l]));
    for (const e of episodes) expect(byId.has(e.episodeId)).toBe(true);
    // The baseline answers each episode with the first acceptable action of its label.
    const baseline = (e: SupervisorEpisodeRecord): GraphDecision => {
      const first = byId.get(e.episodeId)!.acceptable[0]!;
      const stageId = first.stageId ?? "fix";
      switch (first.type) {
        case "validate":
          return validate({ stageId }, "baseline");
        case "reenter":
          return reenter({ stageId, reason: "baseline" }, "baseline");
        case "dispatch":
          return dispatch({ stageId, kind: "agent", purpose: (first.purpose ?? "work") as "work", instruction: "baseline", writeScope: ["."] }, "baseline");
        case "return":
          return returnToNormal({ summary: "baseline" }, "baseline");
        case "observe":
          return { action: { type: "observe", observe: {} }, reason: "baseline" };
        case "activate_repair":
          return { action: { type: "activate_repair", activate: { qualifiedArtifactId: "cand-3", reason: "baseline" } }, reason: "baseline" };
        case "qualify_repair":
          return { action: { type: "qualify_repair", qualify: { target: "plugin", reason: "baseline" } }, reason: "baseline" };
        default:
          return stop({ reason: "baseline", blocker: "baseline" }, "baseline");
      }
    };
    const score = await replayEpisodes({
      episodes,
      labels,
      createSupervisor: (e) => createScriptedSupervisor({ decisions: [baseline(e)] }),
    });
    expect(score.results).toHaveLength(episodes.length);
    expect(score.inadmissibleStops).toBe(0);
    expect(score.accuracy).toBe(1);
  });

  it("keeps fixtures bounded and free of secrets", async () => {
    const { episodes, labels } = await loadReplayFixtures();
    const text = JSON.stringify({ episodes, labels });
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{10,}|api[_-]?key\s*["']?\s*[:=]\s*["'][^"']+|\/home\/|\/Users\//i);
    for (const e of episodes) expect(JSON.stringify(e).length).toBeLessThanOrEqual(MAX_EPISODE_RECORD_CHARS);
  });
});

describe("createEpisodeRecorder", () => {
  it("records tool calls and results unchanged and bounds an oversized record", async () => {
    const recorder = createEpisodeRecorder();
    const inspection = recorder.inspect({
      checkValidate: async () => ({ probeId: "probe-1", accepted: true, reason: "x".repeat(20_000), stateRevision: 2 }),
      listReceipts: () => [],
    } as unknown as SupervisorInspection);
    const result = await inspection.checkValidate({ stageId: "fix" });
    expect(result.accepted).toBe(true);
    expect(inspection.listReceipts()).toEqual([]);
    const calls = recorder.toolCalls();
    expect(calls.map((c) => c.name)).toEqual(["check_validate", "list_receipts"]);
    expect(JSON.stringify(calls[0]!.result).length).toBeLessThan(9_000);
    const record = buildEpisodeRecord({
      episodeId: "ep-1",
      turn: 1,
      runId: "run-1",
      trigger: { code: "supervise", message: "m" },
      view: view("fix"),
      recorder,
      proposal: returnToNormal({ summary: "s" }, "r"),
      admission: { rejections: [], outcome: "pending" },
      providerCalls: 1,
    });
    expect(record.truncated).toBe(true);
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(MAX_EPISODE_RECORD_CHARS);
  });
});
