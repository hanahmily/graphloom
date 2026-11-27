// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { LoopCandidatesInput, LoopRead } from "@graphloom/sdk";
import { deepEqual, evaluate, replay, type EvaluateDeps, type EvaluateOptions, type ReadOutcome } from "./index.js";

const EXEC = "example.list-items";
const read = (id: string, executor = EXEC): LoopRead => ({ id, executor, input: { page: 1 } });
const cand = (key: string) => ({ key, taskArgs: [key] });
const ok = (payload: unknown): ReadOutcome => ({ status: "ok", summary: "ok", evidence: [{ payload }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Hook = EvaluateDeps["hook"];
type Read = EvaluateDeps["read"];

const opts = (over: Partial<EvaluateOptions> = {}): EvaluateOptions => ({ protocol: 1, profile: { p: 1 }, now: "2026-01-01T00:00:00.000Z", allowedReads: [EXEC], ...over });
const scripted = (...replies: unknown[]): Hook => async (input) => replies[input.round];
const okRead: Read = async () => ok("x");
const run = (hook: Hook, rd: Read = okRead, over: Partial<EvaluateOptions> = {}) => evaluate({ hook, read: rd }, opts(over));

describe("evaluate replies", () => {
  it("single round with no reads (janitor shape)", async () => {
    const out = await run(scripted({ candidates: [cand("day:1")] }));
    expect(out).toMatchObject({ kind: "candidates", candidates: [cand("day:1")] });
    expect(out.transcript).toEqual({ protocol: 1, now: "2026-01-01T00:00:00.000Z", rounds: [{ round: 0, reads: [], results: [], reply: { candidates: [cand("day:1")] } }] });
  });

  it("paginates over two rounds and passes results in order", async () => {
    const seen: LoopCandidatesInput[] = [];
    const hook: Hook = async (input) => { seen.push(input); return input.round === 0 ? { reads: [read("p1")] } : { candidates: [cand("a")] }; };
    const out = await run(hook, async () => ok({ items: [1] }));
    expect(out.kind).toBe("candidates");
    expect(seen.map((s) => [s.round, s.results])).toEqual([[0, []], [1, [{ id: "p1", ok: true, output: { items: [1] } }]]]);
    expect(seen[1]!.profile).toEqual({ p: 1 });
    expect(seen[1]!.now).toBe("2026-01-01T00:00:00.000Z");
  });

  it("passes refused through as given", async () => {
    const out = await run(scripted({ refused: "profile p has no assignee" }));
    expect(out).toMatchObject({ kind: "refused", reason: "profile p has no assignee" });
  });

  it.each<[string, unknown, RegExp]>([
    ["not an object", "nope", /reply must be an object/],
    ["empty object", {}, /one of refused, reads, candidates/],
    ["two kinds", { refused: "x", candidates: [] }, /exactly one/],
    ["bad key", { candidates: [{ key: "a b", taskArgs: [] }] }, /key must be/],
    ["too many reads", { reads: Array.from({ length: 9 }, (_, i) => read(`r${i}`)) }, /more than 8/],
    ["too many candidates", { candidates: Array.from({ length: 501 }, (_, i) => cand(`k${i}`)) }, /more than 500/],
  ])("invalid reply (%s) blocks with the validator message", async (_n, reply, re) => {
    const out = await run(scripted(reply));
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toMatch(re);
    expect(out.transcript.rounds[0]!.reply).toEqual(reply);
  });

  it("a thrown hook error blocks and names the cause", async () => {
    const out = await run(async () => { throw new Error("boom"); });
    expect(out).toMatchObject({ kind: "blocked" });
    expect((out as { reason: string }).reason).toContain("boom");
  });

  it("a hook over its timeout blocks and is aborted", async () => {
    let aborted = false;
    const hook: Hook = (_i, signal) => new Promise((_r, rej) => signal.addEventListener("abort", () => { aborted = true; rej(new Error("x")); }));
    const out = await run(hook, okRead, { limits: { hookTimeoutMs: 20 } });
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toMatch(/timed out after 20 ms/);
    expect(aborted).toBe(true);
  });
});

describe("evaluate reads", () => {
  it("blocks a read whose executor is not allowed, naming it", async () => {
    const out = await run(scripted({ reads: [read("a", "example.write-items")] }));
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toContain("example.write-items");
  });

  it("blocks a read id repeated across rounds", async () => {
    const out = await run(scripted({ reads: [read("a")] }, { reads: [read("a")] }));
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toMatch(/duplicate read id "a"/);
  });

  it("runs a round's reads sequentially in request order", async () => {
    const log: string[] = [];
    const delays: Record<string, number> = { a: 30, b: 1, c: 10 };
    const rd: Read = async (r) => { log.push(`start ${r.id}`); await sleep(delays[r.id]!); log.push(`end ${r.id}`); return ok(r.id); };
    const out = await run(scripted({ reads: [read("a"), read("b"), read("c")] }, { candidates: [] }), rd);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(out.transcript.rounds[0]!.results.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("a read timeout reaches the hook as ok:false and does not block", async () => {
    let got: unknown;
    const hook: Hook = async (i) => { if (i.round === 0) return { reads: [read("a")] }; got = i.results; return { candidates: [cand("k")] }; };
    let readSignal: AbortSignal | undefined;
    const out = await run(hook, (_r, signal) => { readSignal = signal; return new Promise(() => undefined); }, { limits: { readTimeoutMs: 20 } });
    expect(out.kind).toBe("candidates");
    expect(readSignal?.aborted).toBe(true);
    expect(got).toEqual([{ id: "a", ok: false, error: "read timed out" }]);
  });

  it("a failed read without retryAfterMs reaches the hook and the hook may still return candidates", async () => {
    let got: unknown;
    const hook: Hook = async (i) => { if (i.round === 0) return { reads: [read("a")] }; got = i.results; return { candidates: [cand("k")] }; };
    const out = await run(hook, async () => ({ status: "conflict", summary: "stale" }));
    expect(out.kind).toBe("candidates");
    expect(got).toEqual([{ id: "a", ok: false, error: "stale" }]);
  });

  it("an ok read with no evidence has no output", async () => {
    const out = await run(scripted({ reads: [read("a")] }, { candidates: [] }), async () => ({ status: "ok", summary: "s" }));
    expect(out.transcript.rounds[0]!.results).toEqual([{ id: "a", ok: true }]);
  });

  it("a result over the per-result limit becomes ok:false, result too large", async () => {
    const out = await run(scripted({ reads: [read("a")] }, { candidates: [] }), async () => ok("x".repeat(300 * 1024)));
    expect(out.kind).toBe("candidates");
    expect(out.transcript.rounds[0]!.results).toEqual([{ id: "a", ok: false, error: "result too large" }]);
  });

  it("blocks when all kept results together exceed 1 MiB", async () => {
    const reads = Array.from({ length: 6 }, (_, i) => read(`r${i}`));
    const out = await run(scripted({ reads }, { candidates: [] }), async () => ok("x".repeat(200 * 1024)));
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toMatch(/exceed 1048576 bytes/);
  });

  it("retryAfterMs defers at now plus the wait, with no further reads or hook call", async () => {
    let hookCalls = 0;
    const calls: string[] = [];
    const hook: Hook = async () => { hookCalls++; return { reads: [read("a"), read("b")] }; };
    const rd: Read = async (r) => { calls.push(r.id); return { status: "failed", summary: "rate limited", retryAfterMs: 90_000 }; };
    const out = await run(hook, rd);
    expect(out).toMatchObject({ kind: "deferred", until: "2026-01-01T00:01:30.000Z" });
    expect(calls).toEqual(["a"]);
    expect(hookCalls).toBe(1);
    expect(out.transcript.rounds[0]!.results).toEqual([{ id: "a", ok: false, error: "rate limited" }]);
  });

  it("retryAfterMs of 0 still defers", async () => {
    const out = await run(scripted({ reads: [read("a")] }), async () => ({ status: "failed", summary: "s", retryAfterMs: 0 }));
    expect(out).toMatchObject({ kind: "deferred", until: "2026-01-01T00:00:00.000Z" });
  });
});

describe("evaluate limits", () => {
  it("blocks when the hook still asks for reads at round 5", async () => {
    let calls = 0;
    const hook: Hook = async (i) => { calls++; return { reads: [read(`r${i.round}`)] }; };
    const out = await run(hook);
    expect(out).toMatchObject({ kind: "blocked", reason: "no candidates after 5 rounds" });
    expect(calls).toBe(5);
  });

  it("blocks over 20 reads in a tick", async () => {
    const hook: Hook = async (i) => ({ reads: Array.from({ length: 8 }, (_, n) => read(`r${i.round}-${n}`)) });
    const out = await run(hook);
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toMatch(/more than 20 reads/);
    expect(out.transcript.rounds).toHaveLength(3);
  });

  it("blocks when the whole evaluation exceeds its time, by the injected clock", async () => {
    let t = 0;
    const hook: Hook = async (i) => { t += 200_000; return i.round === 0 ? { reads: [read("a")] } : { reads: [read("b")] }; };
    const out = await run(hook, okRead, { clock: () => t });
    expect(out.kind).toBe("blocked");
    expect((out as { reason: string }).reason).toMatch(/evaluation exceeded/);
    expect(out.transcript.rounds.length).toBeGreaterThan(0);
  });

  it("aborts an in-flight call when the whole evaluation times out", async () => {
    let readSignal: AbortSignal | undefined;
    const out = await run(async () => ({ reads: [read("a")] }), (_r, signal) => { readSignal = signal; return new Promise(() => undefined); }, { limits: { totalTimeoutMs: 30 } });
    expect(out.kind).toBe("blocked");
    expect(readSignal?.aborted).toBe(true);
    expect((out as { reason: string }).reason).toMatch(/evaluation exceeded 30 ms/);
  });
});

describe("transcript", () => {
  it.each<[string, Hook, Read]>([
    ["candidates", scripted({ candidates: [] }), okRead],
    ["refused", scripted({ refused: "r" }), okRead],
    ["blocked", scripted({ nope: 1 }), okRead],
    ["deferred", scripted({ reads: [read("a")] }), async () => ({ status: "failed", summary: "s", retryAfterMs: 1 })],
  ])("is returned with a %s outcome", async (kind, hook, rd) => {
    const out = await run(hook, rd);
    expect(out.kind).toBe(kind);
    expect(out.transcript.protocol).toBe(1);
    expect(out.transcript.now).toBe("2026-01-01T00:00:00.000Z");
    expect(out.transcript.rounds.length).toBe(1);
    expect(Object.keys(out.transcript).sort()).toEqual(["now", "protocol", "rounds"]);
  });
});

describe("replay", () => {
  const two: Hook = async (i) => (i.round === 0 ? { reads: [read("p1")] } : { candidates: i.results[0]!.ok ? [cand("a"), cand("b")] : [] });

  it("passes for an unchanged hook, ignoring key order", async () => {
    const out = await run(two, async () => ok({ n: 1 }));
    expect(await replay(out.transcript, two)).toEqual({ ok: true });
    const reordered: Hook = async (i) => (i.round === 0 ? { reads: [{ input: { page: 1 }, executor: EXEC, id: "p1" }] } : { candidates: [{ taskArgs: ["a"], key: "a" }, cand("b")] });
    expect(await replay(out.transcript, reordered)).toEqual({ ok: true });
  });

  it("reports the first differing round for a changed hook, feeding recorded results", async () => {
    const out = await run(two, async () => ok({ n: 1 }));
    const changed: Hook = async (i) => (i.round === 0 ? { reads: [read("p1")] } : { candidates: [cand("a")] });
    expect(await replay(out.transcript, changed)).toMatchObject({ ok: false, round: 1 });
    const changedFirst: Hook = async () => ({ reads: [read("zz")] });
    expect(await replay(out.transcript, changedFirst)).toMatchObject({ ok: false, round: 0 });
  });

  it("reports a throwing hook", async () => {
    const out = await run(two);
    const res = await replay(out.transcript, async () => { throw new Error("gone"); });
    expect(res).toMatchObject({ ok: false, round: 0 });
    expect((res as { reason: string }).reason).toContain("gone");
  });

  it("reports a synchronously throwing hook", async () => {
    const out = await run(two);
    const res = await replay(out.transcript, (() => { throw new Error("sync gone"); }) as Hook);
    expect(res).toMatchObject({ ok: false, round: 0 });
    expect((res as { reason: string }).reason).toContain("sync gone");
  });

  it("reports a cyclic reply as not comparable instead of overflowing the stack", async () => {
    const cyc = (): Record<string, unknown> => { const o: Record<string, unknown> = {}; o.self = o; return o; };
    const transcript = { protocol: 1 as const, now: "2026-01-01T00:00:00.000Z", rounds: [{ round: 0, reads: [], results: [], reply: cyc() }] };
    const res = await replay(transcript, async () => cyc());
    // The hook's cyclic reply has no JSON form, so it is not plain data (not merely not comparable).
    expect(res).toEqual({ ok: false, round: 0, reason: "reply was not plain data" });
  });
});

describe("deepEqual", () => {
  it("treats 0 and -0 as equal", () => {
    expect(deepEqual(0, -0)).toBe(true);
    expect(deepEqual({ a: [0] }, { a: [-0] })).toBe(true);
  });
  it("compares like JSON: undefined keys equal missing keys, [undefined] equals [null]", () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([undefined], [null])).toBe(true);
    expect(deepEqual([1], [2])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("evaluate fail-closed edge cases", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const failing = (retryAfterMs: number): Read => async () => ({ status: "failed", summary: "slow down", retryAfterMs });
  const readsOnce: Hook = async () => ({ reads: [read("a")] });

  it("caps an absurd retryAfterMs at 24 hours", async () => {
    const out = await run(readsOnce, failing(1e17));
    expect(out).toMatchObject({ kind: "deferred", until: "2026-01-02T00:00:00.000Z" });
    expect(Date.parse((out as { until: string }).until) - Date.parse("2026-01-01T00:00:00.000Z")).toBe(DAY);
  });

  it.each([Infinity, NaN, -1])("retryAfterMs %s is no deferral signal: a plain failed result for the hook", async (ms) => {
    let got: unknown;
    const hook: Hook = async (i) => { if (i.round === 0) return { reads: [read("a")] }; got = i.results; return { candidates: [cand("k")] }; };
    const out = await run(hook, failing(ms));
    expect(out.kind).toBe("candidates");
    expect(got).toEqual([{ id: "a", ok: false, error: "slow down" }]);
  });

  it("an invalid now is blocked, not thrown, and the hook is never called", async () => {
    let calls = 0;
    const out = await run(async () => { calls++; return { candidates: [] }; }, okRead, { now: "garbage" });
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringContaining("now must be a UTC instant") });
    expect(out.transcript).toEqual({ protocol: 1, now: "garbage", rounds: [] });
    expect(calls).toBe(0);
  });

  it("a now that is not UTC is blocked", async () => {
    const out = await run(scripted({ candidates: [] }), okRead, { now: "2026-01-01T00:00:00+02:00" });
    expect(out.kind).toBe("blocked");
  });

  it("a now at the edge of the date range still returns an outcome when deferring", async () => {
    const out = await run(readsOnce, failing(1000), { now: "+275760-09-13T00:00:00.000Z" });
    expect(out.kind).toBe("blocked");
  });

  it.each<[string, unknown]>([
    ["refused undefined beside candidates", { refused: undefined, candidates: [cand("a")] }],
    ["candidates undefined beside reads", { candidates: undefined, reads: [read("a")] }],
  ])("%s never yields an undefined payload", async (_n, reply) => {
    const out = await run(scripted(reply, { candidates: [] }));
    if (out.kind === "candidates") expect(Array.isArray(out.candidates)).toBe(true);
    else if (out.kind === "refused") expect(typeof out.reason).toBe("string");
    else expect(["blocked", "deferred"]).toContain(out.kind);
  });

  it("refused undefined beside candidates returns the candidates", async () => {
    const out = await run(scripted({ refused: undefined, candidates: [cand("a")] }));
    expect(out).toMatchObject({ kind: "candidates", candidates: [cand("a")] });
  });

  it("a reply that is not plain data blocks", async () => {
    const cyclic: Record<string, unknown> = { candidates: [] };
    cyclic.self = cyclic;
    const out = await run(scripted(cyclic));
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringContaining("hook reply is not plain data") });
  });

  it("a getter returning different data on each read is judged on one snapshot", async () => {
    let n = 0;
    const reply = { get candidates() { n++; return n === 1 ? [cand("good")] : [{ key: "bad key", taskArgs: [] }]; } };
    const out = await run(scripted(reply));
    expect(out.kind).toBe("candidates");
    expect(out).toMatchObject({ candidates: [cand("good")] });
    expect(out.transcript.rounds[0]!.reply).toEqual({ candidates: [cand("good")] });
  });

  it("caps a huge read error message before the hook and the transcript", async () => {
    let got: LoopCandidatesInput["results"] = [];
    const hook: Hook = async (i) => { if (i.round === 0) return { reads: [read("a")] }; got = i.results; return { candidates: [] }; };
    const out = await run(hook, async () => { throw new Error("e".repeat(5 * 1024 * 1024)); });
    expect(got[0]!.error!.length).toBeLessThanOrEqual(4096);
    expect(out.transcript.rounds[0]!.results[0]!.error!.length).toBeLessThanOrEqual(4096);
  });

  it("caps a huge failed-read summary too", async () => {
    let got: LoopCandidatesInput["results"] = [];
    const hook: Hook = async (i) => { if (i.round === 0) return { reads: [read("a")] }; got = i.results; return { candidates: [] }; };
    await run(hook, async () => ({ status: "failed", summary: "s".repeat(200 * 1024) }));
    expect(got[0]!.error!.length).toBeLessThanOrEqual(4096);
  });

  it("the transcript holds snapshots: later mutation by a read or the hook changes nothing recorded", async () => {
    const payload = { items: [1] };
    const hook: Hook = async (i) => {
      if (i.round === 0) return { reads: [read("a")] };
      (i.results[0]!.output as { items: number[] }).items.push(99);
      i.results.push({ id: "zz", ok: true });
      return { candidates: [cand("k")] };
    };
    const out = await run(hook, async () => ok(payload));
    payload.items.push(7);
    expect(out.transcript.rounds[0]!.results).toEqual([{ id: "a", ok: true, output: { items: [1] } }]);
  });

  it("a read that mutates its request cannot change the recorded reads", async () => {
    const out = await run(scripted({ reads: [read("a")] }, { candidates: [] }), async (r) => { (r.input as { page: number }).page = 42; return ok("x"); });
    expect(out.transcript.rounds[0]!.reads).toEqual([read("a")]);
  });

  it("a result that cannot be cloned becomes ok:false, result not serializable", async () => {
    const out = await run(scripted({ reads: [read("a")] }, { candidates: [] }), async () => ok({ n: 1n }));
    expect(out.transcript.rounds[0]!.results).toEqual([{ id: "a", ok: false, error: "result not serializable" }]);
  });
});

const MALFORMED = "read returned a malformed result";
const readsThenDone: Hook = async (i) => (i.round === 0 ? { reads: [read("a")] } : { candidates: [] });
const throwing = (): never => { throw new Error("hostile"); };
const hostile = (): unknown => new Proxy({}, { get: throwing, has: throwing, getPrototypeOf: throwing, ownKeys: throwing, getOwnPropertyDescriptor: throwing });

describe("evaluate never rejects on hostile read outcomes", () => {
  const cases: Array<[string, () => unknown]> = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["a string", () => "ok"],
    ["an array", () => []],
    ["an unknown status", () => ({ status: "weird", summary: "x" })],
    ["evidence containing null", () => ({ status: "ok", summary: "x", evidence: [null] })],
    ["evidence that is not an array", () => ({ status: "ok", summary: "x", evidence: { 0: { payload: 1 } } })],
    ["a summary that is a number", () => ({ status: "failed", summary: 5 })],
    ["a summary whose toString throws", () => ({ status: "failed", summary: { toString: throwing } })],
    ["a status getter that throws", () => ({ get status() { return throwing(); }, summary: "x" })],
    ["an evidence getter that throws", () => ({ status: "ok", summary: "x", get evidence() { return throwing(); } })],
    ["a retryAfterMs getter that throws", () => ({ status: "failed", summary: "x", get retryAfterMs() { return throwing(); } })],
    ["a retryAfterMs that is a string", () => ({ status: "failed", summary: "x", retryAfterMs: "5" })],
  ];
  it.each(cases)("%s is ok:false, malformed, not a block or a throw", async (_n, make) => {
    const out = await run(readsThenDone, async () => make() as ReadOutcome);
    expect(out.kind).toBe("candidates");
    expect(out.transcript.rounds[0]!.results).toEqual([{ id: "a", ok: false, error: MALFORMED }]);
  });

  it("a Proxy that throws on every access still resolves", async () => {
    const out = await run(readsThenDone, async () => hostile() as ReadOutcome);
    expect(["candidates", "blocked", "deferred", "refused"]).toContain(out.kind);
  });

  it("a read returning a throwing Proxy synchronously still resolves", async () => {
    const out = await run(readsThenDone, (() => hostile()) as unknown as Read);
    expect(["candidates", "blocked", "deferred", "refused"]).toContain(out.kind);
  });
});

describe("result sizes follow the stored JSON form, in bytes", () => {
  const oneRead = (rd: Read, over: Partial<EvaluateOptions> = {}) => run(readsThenDone, rd, over);
  it.each<[string, () => unknown, unknown]>([
    ["a Map", () => new Map([[1, 2]]), {}],
    ["a Set", () => new Set([1, 2]), {}],
    ["a 1 MB ArrayBuffer", () => new ArrayBuffer(1024 * 1024), {}],
    ["a Uint8Array", () => new Uint8Array([1, 2]), { 0: 1, 1: 2 }],
  ])("%s is kept only as its JSON form", async (_n, make, json) => {
    const out = await oneRead(async () => ok(make()));
    const output = out.transcript.rounds[0]!.results[0]!.output;
    expect(output).toEqual(json);
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  it("a Map with 200000 entries cannot smuggle data past the cap", async () => {
    const out = await oneRead(async () => ok(new Map(Array.from({ length: 200000 }, (_, i) => [i, i]))));
    expect(out.transcript.rounds[0]!.results[0]!.output).toEqual({});
  });

  const overhead = JSON.stringify({ id: "a", ok: true, output: "" }).length;
  const LIMIT = 1000;
  it("measures bytes: exactly at the limit is kept, one byte over is too large", async () => {
    const half = (LIMIT - overhead) / 2; // "é" is two bytes, one UTF-16 unit
    const exact = "é".repeat(Math.floor(half)) + (Number.isInteger(half) ? "" : "x");
    expect(Buffer.byteLength(JSON.stringify({ id: "a", ok: true, output: exact }))).toBe(LIMIT);
    const kept = await oneRead(async () => ok(exact), { limits: { maxResultBytes: LIMIT } });
    expect(kept.transcript.rounds[0]!.results[0]).toEqual({ id: "a", ok: true, output: exact });
    const over = exact + "x";
    const big = await oneRead(async () => ok(over), { limits: { maxResultBytes: LIMIT } });
    expect(big.transcript.rounds[0]!.results[0]).toEqual({ id: "a", ok: false, error: "result too large" });
  });

  it("multi-byte text over the limit in bytes but under it in UTF-16 units is too large", async () => {
    const text = "é".repeat(LIMIT - overhead - 10); // units fit, bytes do not
    const big = await oneRead(async () => ok(text), { limits: { maxResultBytes: LIMIT } });
    expect(big.transcript.rounds[0]!.results[0]).toEqual({ id: "a", ok: false, error: "result too large" });
  });

  it("the default 256 KiB limit counts bytes for multi-byte text", async () => {
    const out = await oneRead(async () => ok("é".repeat(200 * 1024)));
    expect(out.transcript.rounds[0]!.results[0]).toEqual({ id: "a", ok: false, error: "result too large" });
  });
});

describe("hook replies are reduced to their JSON form", () => {
  it("a Map inside a reply is not retained", async () => {
    const out = await run(scripted({ candidates: [{ key: "a", taskArgs: ["a"], extra: new Map([[1, 2]]) }] }));
    expect(JSON.stringify(out.transcript.rounds[0]!.reply)).toBe('{"candidates":[{"key":"a","taskArgs":["a"],"extra":{}}]}');
    const extra = ((out.transcript.rounds[0]!.reply as { candidates: Array<{ extra: unknown }> }).candidates[0]!).extra;
    expect(extra instanceof Map).toBe(false);
  });

  it("a reply that JSON cannot represent blocks as not plain data", async () => {
    const out = await run(scripted({ candidates: [], big: 1n }));
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringContaining("hook reply is not plain data") });
  });
});

describe("instants are real calendar instants", () => {
  it.each(["2026-02-30T00:00:00Z", "2026-02-30T00:00:00.000Z", "2026-01-01T24:00:00Z", "2026-02-29T00:00:00Z", "2026-01-01T00:60:00Z"])("blocks now %s", async (now) => {
    let calls = 0;
    const out = await run(async () => { calls++; return { candidates: [] }; }, okRead, { now });
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringContaining("now must be a UTC instant") });
    expect(calls).toBe(0);
  });

  it("accepts milliseconds and a real leap day", async () => {
    expect((await run(scripted({ candidates: [] }), okRead, { now: "2026-03-04T05:06:07.123Z" })).kind).toBe("candidates");
    expect((await run(scripted({ candidates: [] }), okRead, { now: "2028-02-29T00:00:00Z" })).kind).toBe("candidates");
  });
});

describe("messages are capped on code points and after any prefix", () => {
  it("does not split a surrogate pair", async () => {
    const out = await run(readsThenDone, async () => { throw new Error("😀".repeat(5000)); });
    const error = out.transcript.rounds[0]!.results[0]!.error!;
    expect(error.length).toBeLessThanOrEqual(4096);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(error)).toBe(false);
  });

  it("a blocked reason with a long cause never exceeds the limit", async () => {
    const out = await run(async () => { throw new Error("e".repeat(100_000)); });
    expect((out as { reason: string }).reason.length).toBeLessThanOrEqual(4096);
  });

  it("a deferral reason with a long summary never exceeds the limit", async () => {
    const out = await run(readsThenDone, async () => ({ status: "failed", summary: "s".repeat(100_000), retryAfterMs: 5 }));
    expect(out.kind).toBe("deferred");
    expect((out as { reason: string }).reason.length).toBeLessThanOrEqual(4096);
  });
});

describe("a reply that is not plain data", () => {
  it("is recorded as a marker, and replay says so", async () => {
    const out = await run(scripted({ candidates: [], big: 1n }));
    expect(out.transcript.rounds[0]!.reply).toEqual({ $unserialisable: true });
    expect(await replay(out.transcript, async () => ({ candidates: [], big: 1n }))).toEqual({ ok: false, round: 0, reason: "reply was not plain data" });
  });
});

describe("option validation throws synchronously, before any work", () => {
  const bad: Array<[string, Partial<EvaluateOptions>]> = [
    ["zero maxRounds", { limits: { maxRounds: 0 } }],
    ["negative maxCandidates", { limits: { maxCandidates: -1 } }],
    ["fractional maxReadsPerRound", { limits: { maxReadsPerRound: 1.5 } }],
    ["NaN maxResultBytes", { limits: { maxResultBytes: NaN } }],
    ["Infinity maxTotalResultBytes", { limits: { maxTotalResultBytes: Infinity } }],
    ["hookTimeoutMs above 2^31-1", { limits: { hookTimeoutMs: 2 ** 31 } }],
    ["readTimeoutMs above 2^31-1", { limits: { readTimeoutMs: 2 ** 31 } }],
    ["totalTimeoutMs above 2^31-1", { limits: { totalTimeoutMs: 2 ** 31 } }],
    ["a string limit", { limits: { maxRounds: "5" as unknown as number } }],
    ["missing allowedReads", { allowedReads: undefined as unknown as string[] }],
    ["non-array allowedReads", { allowedReads: "x" as unknown as string[] }],
    ["non-string allowedReads entry", { allowedReads: [1] as unknown as string[] }],
  ];
  it.each(bad)("%s", (_n, over) => {
    let calls = 0;
    const hook: Hook = async () => { calls++; return { candidates: [] }; };
    expect(() => evaluate({ hook, read: okRead }, opts(over))).toThrow(TypeError);
    expect(calls).toBe(0);
  });

  it("accepts 2^31-1 and ignores undefined limit values", async () => {
    const out = await run(scripted({ candidates: [] }), okRead, { limits: { hookTimeoutMs: 2 ** 31 - 1, readTimeoutMs: 2 ** 31 - 1, totalTimeoutMs: 2 ** 31 - 1, maxRounds: undefined as unknown as number } });
    expect(out.kind).toBe("candidates");
  });
});

const nest = (d: number): unknown => { let v: unknown = 1; for (let i = 0; i < d; i++) v = [v]; return v; };
const nestO = (d: number): unknown => { let v: unknown = 1; for (let i = 0; i < d; i++) v = { a: v }; return v; };

describe("deep nesting never rejects", () => {
  for (const d of [2000, 3000, 5000, 50000]) {
    it(`read output nested ${d} levels resolves with an outcome`, async () => {
      const out = await run(readsThenDone, async () => ok(nestO(d)));
      expect(["candidates", "blocked"]).toContain(out.kind);
      if (out.kind === "candidates") expect(typeof out.transcript.rounds[0]!.results[0]!.ok).toBe("boolean");
    });
    it(`reads[].input nested ${d} levels resolves with an outcome`, async () => {
      const hook: Hook = async (i) => (i.round === 0 ? { reads: [{ id: "a", executor: EXEC, input: { v: nest(d) } }] } : { candidates: [] });
      const out = await run(hook);
      expect(["candidates", "blocked"]).toContain(out.kind);
    });
    it(`candidates[].observedState nested ${d} levels resolves with an outcome`, async () => {
      const out = await run(scripted({ candidates: [{ key: "k", taskArgs: [], observedState: nestO(d) }] }));
      expect(["candidates", "blocked"]).toContain(out.kind);
    });
    it(`a reply nested ${d} levels in an unknown key resolves with an outcome`, async () => {
      const out = await run(scripted({ candidates: [], z: nest(d) }));
      expect(["candidates", "blocked"]).toContain(out.kind);
    });
  }
});

describe("refused reasons are capped", () => {
  it("a long refusal yields a capped reason", async () => {
    const out = await run(scripted({ refused: "r".repeat(200_000) }));
    expect(out.kind).toBe("refused");
    expect((out as { reason: string }).reason.length).toBeLessThanOrEqual(4096);
  });
  it("a 1,000,000 character refusal is capped or blocked, never passed through", async () => {
    const out = await run(scripted({ refused: "r".repeat(1_000_000) }));
    expect((out as { reason: string }).reason.length).toBeLessThanOrEqual(4096);
  });
});

describe("replay compares the JSON form of the reply", () => {
  const hooks: Array<[string, Hook]> = [
    ["a Date", async () => ({ candidates: [{ key: "k", taskArgs: [], observedState: new Date(0) }] })],
    ["a toJSON on a value", async () => ({ candidates: [{ key: "k", taskArgs: [], observedState: { toJSON: () => "s" } }] })],
    ["a toJSON on the reply", async () => ({ toJSON: () => ({ candidates: [cand("k")] }) })],
    ["a function-valued key", async () => ({ candidates: [cand("k")], f: () => 1 })],
  ];
  it.each(hooks)("an unchanged hook returning %s passes", async (_n, hook) => {
    const out = await run(hook);
    expect(out.kind).toBe("candidates");
    expect(await replay(out.transcript, hook)).toEqual({ ok: true });
  });
  it("a really changed reply is still reported", async () => {
    const hook: Hook = async () => ({ candidates: [{ key: "k", taskArgs: [], observedState: new Date(0) }] });
    const out = await run(hook);
    expect(out.kind).toBe("candidates");
    const changed: Hook = async () => ({ candidates: [{ key: "k", taskArgs: [], observedState: new Date(1000) }] });
    expect(await replay(out.transcript, changed)).toMatchObject({ ok: false, round: 0 });
  });
  it("a reply that cannot be reduced to JSON is not plain data", async () => {
    const out = await run(scripted({ candidates: [] }));
    const cyclic: Hook = async () => { const o: Record<string, unknown> = {}; o.self = o; return o; };
    expect(await replay(out.transcript, cyclic)).toEqual({ ok: false, round: 0, reason: "reply was not plain data" });
  });
});

describe("hook replies are bounded in the transcript", () => {
  it("a reply over 256 KiB blocks the tick", async () => {
    const out = await run(scripted({ candidates: [{ key: "k", taskArgs: ["x".repeat(300 * 1024)] }] }));
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/hook reply too large/) });
  });
  it("replies count toward the 1 MiB tick total", async () => {
    const hook: Hook = async (i) => ({ reads: [{ id: `r${i.round}`, executor: EXEC, input: { s: "x".repeat(200 * 1024) } }] });
    const out = await run(hook, okRead, { limits: { maxRounds: 10, maxReadsPerTick: 100, maxTotalResultBytes: 500 * 1024 } });
    expect(out).toMatchObject({ kind: "blocked" });
    expect((out as { reason: string }).reason).toMatch(/exceed 512000 bytes/);
    expect(out.transcript.rounds.length).toBeLessThanOrEqual(3);
  });
});

describe("caller-supplied clock and now never reject", () => {
  it("a throwing clock blocks", async () => {
    const out = await run(scripted({ candidates: [] }), okRead, { clock: () => { throw new Error("c"); } });
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/clock failed/) });
  });
  it("a clock that starts throwing later blocks", async () => {
    let n = 0;
    const out = await run(readsThenDone, okRead, { clock: () => { if (n++ > 1) throw new Error("c"); return 0; } });
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/clock failed/) });
  });
  it("a now getter that throws blocks", async () => {
    const o = { ...opts() };
    Object.defineProperty(o, "now", { get() { throw new Error("n"); } });
    const out = await evaluate({ hook: scripted({ candidates: [] }), read: okRead }, o);
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/now must be a UTC instant/) });
  });
  it("a non-string now blocks", async () => {
    const out = await run(scripted({ candidates: [] }), okRead, { now: 5 as unknown as string });
    expect(out).toMatchObject({ kind: "blocked", reason: expect.stringMatching(/now must be a UTC instant/) });
  });
});
