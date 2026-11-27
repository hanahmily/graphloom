// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { decide, parseLoopDefinition, runKey, type DecideInput, type KnownKey, type SubmissionState } from "./index.js";

const loop = (limits: object = {}) => parseLoopDefinition({ name: "L", every: "1m", graph: "g", profile: "p", sink: "hub", limits: { maxStartsPerTick: 10, maxLiveRuns: 10, maxStartsPerDay: 10, ...limits } });
const input = (over: Partial<DecideInput> & { limits?: object } = {}): DecideInput => {
  const { limits, ...rest } = over;
  return { loop: loop(limits), now: "2026-01-01T00:00:00Z", candidates: [{ key: "a", taskArgs: ["x"] }], knownKeys: new Map(), liveRunCount: 0, startsToday: 0, ...rest };
};

describe("decide", () => {
  it("starts a new subject at generation 0 with its run key and args", () => {
    expect(decide(input())).toEqual([{ action: "start", subject: "a", key: "loop:L:a:0", generation: 0, taskArgs: ["x"] }]);
  });

  it.each<[SubmissionState, RegExp]>([
    ["queued", /^live/], ["running", /^live/], ["waiting", /^live/],
    ["blocked", /needs the operator/], ["failed", /needs the operator/],
    ["succeeded", /already succeeded/], ["canceled", /already canceled/],
    ["archived", /archived/],
  ])("never restarts a %s key", (state, reason) => {
    const [d] = decide(input({ knownKeys: new Map([["loop:L:a:0", { state, generation: 0 }]]) }));
    expect(d!.action).toBe("skip");
    expect((d as { reason: string }).reason).toMatch(reason);
  });

  it("does not start or count a duplicate subject twice", () => {
    const ds = decide(input({ limits: { maxStartsPerTick: 2 }, candidates: [{ key: "a", taskArgs: [] }, { key: "a", taskArgs: [] }, { key: "b", taskArgs: [] }] }));
    expect(ds.map((d) => d.action)).toEqual(["start", "skip", "start"]);
    expect((ds[1] as { reason: string }).reason).toBe("duplicate subject in this tick");
  });

  it("accepts a plain record for known keys", () => {
    const [d] = decide(input({ knownKeys: { "loop:L:a:0": { state: "failed", generation: 0 } } }));
    expect(d!.action).toBe("skip");
  });

  it("an unparked subject uses the new generation and starts again", () => {
    const known = new Map<string, KnownKey>([["loop:L:a:0", { state: "failed", generation: 0 }]]);
    const [d] = decide(input({ knownKeys: known, generations: new Map([["a", 1]]) }));
    expect(d).toMatchObject({ action: "start", key: "loop:L:a:1", generation: 1 });
    const [e] = decide(input({ knownKeys: new Map([...known, ["loop:L:a:1", { state: "running" as const, generation: 1 }]]), generations: { a: 1 } }));
    expect(e!.action).toBe("skip");
  });

  it("keeps candidate order and stops at maxStartsPerTick", () => {
    const candidates = ["a", "b", "c"].map((key) => ({ key, taskArgs: [] }));
    const out = decide(input({ candidates, limits: { maxStartsPerTick: 2 } }));
    expect(out.map((d) => [d.subject, d.action])).toEqual([["a", "start"], ["b", "start"], ["c", "skip"]]);
    expect((out[2] as { reason: string }).reason).toBe("maxStartsPerTick reached");
  });

  it.each([
    ["maxLiveRuns", { limits: { maxLiveRuns: 3 }, liveRunCount: 2 }, 1],
    ["maxStartsPerDay", { limits: { maxStartsPerDay: 4 }, startsToday: 3 }, 1],
    ["maxLiveRuns", { limits: { maxLiveRuns: 2 }, liveRunCount: 5 }, 0],
    ["maxStartsPerDay", { limits: { maxStartsPerDay: 1 }, startsToday: 1 }, 0],
  ])("caps on %s", (name, over, starts) => {
    const candidates = ["a", "b"].map((key) => ({ key, taskArgs: [] }));
    const out = decide(input({ candidates, ...over } as Partial<DecideInput>));
    expect(out.filter((d) => d.action === "start")).toHaveLength(starts);
    expect(out.filter((d) => d.action === "skip").every((d) => (d as { reason: string }).reason === `${name} reached`)).toBe(true);
  });

  it("an existing key does not consume a slot", () => {
    const candidates = ["a", "b"].map((key) => ({ key, taskArgs: [] }));
    const out = decide(input({ candidates, limits: { maxStartsPerTick: 1 }, knownKeys: new Map([["loop:L:a:0", { state: "succeeded" as const, generation: 0 }]]) }));
    expect(out.map((d) => d.action)).toEqual(["skip", "start"]);
  });

  it("is pure: the input is not mutated and repeats give the same answer", () => {
    const i = input();
    const before = JSON.stringify(i.candidates);
    expect(decide(i)).toEqual(decide(i));
    expect(JSON.stringify(i.candidates)).toBe(before);
  });

  it("runKey format", () => expect(runKey("n", "s:1", 2)).toBe("loop:n:s:1:2"));
});
