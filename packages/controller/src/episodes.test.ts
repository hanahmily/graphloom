// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { SupervisorEpisodeRecord } from "@graphloom/supervisor";
import { appendEpisode, nextEpisodeTurn, settleEpisode } from "./episodes.js";
import type { DurableRunState } from "./state.js";

function record(episodeId: string, turn: number): SupervisorEpisodeRecord {
  return {
    episodeId,
    turn,
    runId: "run-1",
    at: "2026-10-01T00:00:00.000Z",
    input: { trigger: { code: "supervise", message: "m" }, view: {} as SupervisorEpisodeRecord["input"]["view"] },
    toolCalls: [],
    admission: { rejections: [], outcome: "pending" },
    providerCalls: 0,
  };
}

describe("supervisor episode records", () => {
  it("keeps numbering turns past the cap and settles the call it names, not an older one", () => {
    let state = { supervisorEpisodes: undefined } as unknown as DurableRunState;
    for (let i = 0; i < 60; i += 1) {
      const turn = nextEpisodeTurn(state, "ep-1");
      expect(turn).toBe(i + 1);
      state = appendEpisode(state, record("ep-1", turn));
    }
    expect(state.supervisorEpisodes).toHaveLength(50);
    expect(state.supervisorEpisodes![0]!.turn).toBe(11);
    // A state loaded after a restart continues from the last recorded turn.
    const reloaded = JSON.parse(JSON.stringify(state)) as DurableRunState;
    expect(nextEpisodeTurn(reloaded, "ep-1")).toBe(61);
    const settled = settleEpisode(reloaded, "ep-1", 60, "admitted");
    expect(settled.supervisorEpisodes!.map((r) => r.admission.outcome).filter((o) => o === "admitted")).toHaveLength(1);
    expect(settled.supervisorEpisodes!.at(-1)!.admission.outcome).toBe("admitted");
    expect(nextEpisodeTurn(reloaded, "ep-other")).toBe(1);
  });

  it("keeps a record inside its size bound when settling it with an oversized rejection", () => {
    const state = appendEpisode({} as DurableRunState, record("ep-1", 1));
    const settled = settleEpisode(state, "ep-1", 1, "inadmissible", ["validate: " + "z".repeat(70_000)]);
    const rewritten = settled.supervisorEpisodes![0]!;
    expect(JSON.stringify(rewritten).length).toBeLessThanOrEqual(65_536);
    expect(rewritten.admission.rejections).toHaveLength(1);
    expect(rewritten.admission.outcome).toBe("inadmissible");
  });
});
