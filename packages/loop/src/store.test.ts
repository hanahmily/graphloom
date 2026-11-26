// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWrite, LOOP_STATE_SCHEMA, LoopStore, LoopStoreError } from "./index.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "loop-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const NOW = "2026-03-04T05:06:07Z";

describe("LoopStore", () => {
  it("starts empty and writes state.json with the schema, leaving no temp files", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "loop:L:a:0", NOW);
    await s.close();
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    expect(state.schema).toBe(LOOP_STATE_SCHEMA);
    expect(state.submissions["loop:L:a:0"]).toMatchObject({ subject: "a", generation: 0, intentAt: NOW });
    expect((await readdir(dir)).sort()).toEqual(["state.json", "state.lock"]); // no .tmp leftovers; the lock file persists
  });

  it("recovers an intent without started, across a crash, without duplicating", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "loop:L:a:0", NOW);
    await s.intent("b", "loop:L:b:0", NOW);
    await s.started("loop:L:b:0", "run-b");
    await s.close();
    const r = await LoopStore.open(dir);
    expect(r.recover().map((x) => x.key)).toEqual(["loop:L:a:0"]);
    await r.intent("a", "loop:L:a:0", "2030-01-01T00:00:00Z"); // replayed intent is a no-op
    expect(Object.keys(r.snapshot().submissions)).toHaveLength(2);
    expect(r.snapshot().submissions["loop:L:a:0"]!.intentAt).toBe(NOW);
    await r.started("loop:L:a:0", "run-a");
    expect(r.recover()).toEqual([]);
    await r.close();
  });

  it("started refuses an unknown key and a different run id", async () => {
    const s = await LoopStore.open(dir);
    await expect(s.started("nope", "r")).rejects.toThrow(/no intent/);
    await s.intent("a", "k", NOW);
    await s.started("k", "r1");
    await s.started("k", "r1");
    await expect(s.started("k", "r2")).rejects.toThrow(/already started/);
    await s.close();
  });

  it("unpark bumps the generation, durably", async () => {
    const s = await LoopStore.open(dir);
    expect(s.generation("a")).toBe(0);
    expect(await s.unpark("a")).toBe(1);
    expect(await s.unpark("a")).toBe(2);
    await s.intent("a", "loop:L:a:2", NOW);
    await s.close();
    const r = await LoopStore.open(dir);
    expect(r.generation("a")).toBe(2);
    expect(r.generation("b")).toBe(0);
    expect(r.snapshot().submissions["loop:L:a:2"]!.generation).toBe(2);
    await r.close();
  });

  it("counts starts by UTC day", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "k1", "2026-03-04T23:59:59Z");
    await s.intent("b", "k2", "2026-03-05T00:00:01Z");
    expect(s.startsOn("2026-03-04")).toBe(1);
    expect(s.startsOn("2026-03-05")).toBe(1);
    await s.close();
  });

  it("holds a single writer: a second open fails until close", async () => {
    const s = await LoopStore.open(dir);
    await expect(LoopStore.open(dir)).rejects.toThrow(/locked by another process/);
    await s.close();
    await (await LoopStore.open(dir)).close();
  });

  it("refuses a newer or unknown schema and releases the lock", async () => {
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ schema: "graphloom-loop-v2", generations: {}, submissions: {} }));
    await expect(LoopStore.open(dir)).rejects.toThrow(/newer than this graphloom/);
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ schema: "other" }));
    await expect(LoopStore.open(dir)).rejects.toThrow(LoopStoreError);
    await writeFile(path.join(dir, "state.json"), "{nope");
    await expect(LoopStore.open(dir)).rejects.toThrow(/not valid JSON/);
    await (await LoopStore.open(dir).catch(() => undefined))?.close();
    await rm(path.join(dir, "state.json"));
    await (await LoopStore.open(dir)).close(); // the lock was released by every failed open
  });

  it("close releases only this instance's lock, is idempotent, and refuses later writes", async () => {
    const s = await LoopStore.open(dir);
    await s.close();
    const other = await LoopStore.open(dir);
    await s.close(); // a closed store must not release the lock another holder took
    await expect(LoopStore.open(dir)).rejects.toThrow(/locked/);
    await expect(s.intent("a", "k", NOW)).rejects.toThrow(/closed/);
    await expect(s.started("k", "r")).rejects.toThrow(/closed/);
    await expect(s.unpark("a")).rejects.toThrow(/closed/);
    await other.close();
    await other.close();
  });

  it("serialises concurrent mutations: nothing is lost in memory or on disk", async () => {
    const s = await LoopStore.open(dir);
    const calls: Array<Promise<unknown>> = [];
    for (let i = 0; i < 20; i++) {
      calls.push(s.intent(`s${i}`, `k${i}`, NOW));
      calls.push(s.unpark(`u${i}`));
    }
    await Promise.all(calls);
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.started(`k${i}`, `r${i}`)));
    const check = (state: ReturnType<LoopStore["snapshot"]>) => {
      expect(Object.keys(state.submissions)).toHaveLength(20);
      expect(Object.values(state.submissions).every((r) => r.runId === `r${r.key.slice(1)}`)).toBe(true);
      expect(Object.keys(state.generations)).toHaveLength(20);
    };
    check(s.snapshot());
    await s.close();
    check(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")));
  });

  it("two concurrent unparks of one subject both count", async () => {
    const s = await LoopStore.open(dir);
    const r = await Promise.all([s.unpark("a"), s.unpark("a")]);
    expect(r.sort()).toEqual([1, 2]);
    await s.close();
  });

  it("a failed write leaves memory equal to what is durable and later writes still work", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "k1", NOW);
    await chmod(dir, 0o500);
    try {
      await expect(s.intent("b", "k2", NOW)).rejects.toThrow();
    } finally { await chmod(dir, 0o700); }
    expect(Object.keys(s.snapshot().submissions)).toEqual(["k1"]);
    await s.intent("b", "k2", NOW);
    await s.close();
    expect(Object.keys(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).submissions)).toEqual(["k1", "k2"]);
  });

  describe.each(["__proto__", "constructor", "toString", "hasOwnProperty"])("subject and key %s", (name) => {
    it("works through every write path, in memory and on disk, and on reload", async () => {
      const s = await LoopStore.open(dir);
      expect(s.generation(name)).toBe(0);
      expect(await s.intent(name, name, NOW)).toBeUndefined();
      expect(s.recover().map((r) => r.key)).toEqual([name]);
      await s.started(name, "run-1");
      expect(s.recover()).toEqual([]);
      expect(await s.unpark(name)).toBe(1);
      expect(s.generation(name)).toBe(1);
      expect(await s.unpark(name)).toBe(2);
      expect(Object.keys(s.snapshot().generations)).toEqual([name]);
      expect(({} as Record<string, unknown>)["runId"]).toBeUndefined();
      expect(Object.keys(Object.prototype)).toEqual([]);
      await s.close();
      const disk = await readFile(path.join(dir, "state.json"), "utf8");
      expect(Object.keys(JSON.parse(disk).generations)).toEqual([name]);
      const r = await LoopStore.open(dir);
      expect(r.generation(name)).toBe(2);
      expect(r.snapshot().submissions[name]).toMatchObject({ subject: name, key: name, runId: "run-1" });
      await r.close();
    });

    it("loads an own key of that name from disk without polluting", async () => {
      await writeFile(path.join(dir, "state.json"), `{"schema":"${LOOP_STATE_SCHEMA}","generations":{${JSON.stringify(name)}:4},"submissions":{${JSON.stringify(name)}:{"subject":${JSON.stringify(name)},"key":${JSON.stringify(name)},"generation":4,"intentAt":"${NOW}"}}}`);
      const s = await LoopStore.open(dir);
      expect(s.generation(name)).toBe(4);
      expect(s.recover().map((r) => r.key)).toEqual([name]);
      expect(s.generation("other")).toBe(0);
      expect(({} as Record<string, unknown>)["generation"]).toBeUndefined();
      await s.close();
    });
  });

  it("unpark refuses a subject with an unfinished submit, naming it", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "k", NOW);
    await expect(s.unpark("a")).rejects.toThrow(LoopStoreError);
    await expect(s.unpark("a")).rejects.toThrow(/"a".*recover it first/);
    expect(s.generation("a")).toBe(0);
    await s.unpark("b");
    await s.started("k", "r");
    expect(await s.unpark("a")).toBe(1);
    await s.close();
  });

  it.each(["2026-03-04T05:06:07", "2026-03-04T05:06:07+01:00", "2026-03-04 05:06:07Z", "2026-13-04T05:06:07Z", "", "yesterday"])("intent refuses now %j", async (now) => {
    const s = await LoopStore.open(dir);
    await expect(s.intent("a", "k", now)).rejects.toThrow(LoopStoreError);
    await expect(s.intent("a", "k", now)).rejects.toThrow(/UTC instant ending in Z/);
    expect(s.snapshot().submissions).toEqual({});
    await s.close();
  });

  it("startsOn needs a UTC day or instant", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "k", "2026-03-04T05:06:07.5Z");
    expect(s.startsOn("2026-03-04T23:00:00Z")).toBe(1);
    expect(() => s.startsOn("2026-03-04T23:00:00")).toThrow(LoopStoreError);
    expect(() => s.startsOn("2026-3-4")).toThrow(LoopStoreError);
    await s.close();
  });

  const malformed: Array<[string, unknown]> = [
    ["generations not an object", { generations: [], submissions: {} }],
    ["negative generation", { generations: { a: -1 }, submissions: {} }],
    ["fractional generation", { generations: { a: 1.5 }, submissions: {} }],
    ["string generation", { generations: { a: "1" }, submissions: {} }],
    ["submission not an object", { generations: {}, submissions: { k: 3 } }],
    ["submission without subject", { generations: {}, submissions: { k: { key: "k", generation: 0, intentAt: NOW } } }],
    ["submission key mismatch", { generations: {}, submissions: { k: { subject: "a", key: "z", generation: 0, intentAt: NOW } } }],
    ["submission fractional generation", { generations: {}, submissions: { k: { subject: "a", key: "k", generation: 0.5, intentAt: NOW } } }],
    ["submission without intentAt", { generations: {}, submissions: { k: { subject: "a", key: "k", generation: 0 } } }],
    ["submission numeric runId", { generations: {}, submissions: { k: { subject: "a", key: "k", generation: 0, intentAt: NOW, runId: 7 } } }],
  ];
  it.each(malformed)("refuses a malformed state: %s, releasing the lock", async (_n, body) => {
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ schema: LOOP_STATE_SCHEMA, ...(body as object) }));
    await expect(LoopStore.open(dir)).rejects.toThrow(LoopStoreError);
    await expect(LoopStore.open(dir)).rejects.toThrow(/malformed/);
  });
});

describe("LoopStore review fixes", () => {
  it("close() drains mutations already queued; only later calls are refused", async () => {
    const s = await LoopStore.open(dir);
    const queued = [s.intent("a", "k1", NOW), s.intent("b", "k2", NOW), s.started("k1", "r1")];
    const closing = s.close();
    await expect(Promise.all([...queued, closing])).resolves.toBeDefined();
    const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
    expect(Object.keys(state.submissions)).toEqual(["k1", "k2"]);
    expect(state.submissions.k1.runId).toBe("r1");
    await expect(s.intent("c", "k3", NOW)).rejects.toThrow(/closed/);
    await s.close(); // idempotent
  });

  it("a call made after close() was called is refused even while the chain drains", async () => {
    const s = await LoopStore.open(dir);
    const first = s.intent("a", "k1", NOW);
    const closing = s.close();
    await expect(s.intent("b", "k2", NOW)).rejects.toThrow(/closed/);
    await first;
    await closing;
    expect(Object.keys(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")).submissions)).toEqual(["k1"]);
  });

  it.each(["2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2025-02-29T00:00:00Z", "2026-03-04T24:00:00Z", "2026-03-04T05:60:00Z", "2026-03-04T05:06:60Z"])("intent refuses the impossible instant %s", async (now) => {
    const s = await LoopStore.open(dir);
    await expect(s.intent("a", "k", now)).rejects.toThrow(/UTC instant ending in Z/);
    await s.close();
  });

  it("accepts a real leap day", async () => {
    const s = await LoopStore.open(dir);
    await s.intent("a", "k", "2028-02-29T23:59:59Z");
    expect(s.startsOn("2028-02-29")).toBe(1);
    await s.close();
  });

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2026-02-30T00:00:00Z"])("startsOn refuses the impossible day %s", async (day) => {
    const s = await LoopStore.open(dir);
    expect(() => s.startsOn(day)).toThrow(LoopStoreError);
    await s.close();
  });

  it.each(["not a time", "2026-02-30T00:00:00Z", "2026-03-04T05:06:07+01:00", "2026-03-04", ""])("refuses a state.json whose intentAt is %j", async (intentAt) => {
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ schema: LOOP_STATE_SCHEMA, generations: {}, submissions: { k: { subject: "a", key: "k", generation: 0, intentAt } } }));
    await expect(LoopStore.open(dir)).rejects.toThrow(/malformed.*intentAt/);
  });

  it("atomicWrite removes its temp file when the write itself fails", async () => {
    const file = path.join(dir, "x.json");
    await expect(atomicWrite(file, 123 as unknown as string)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("uses one resolved directory for the lock and for state.json", async () => {
    const real = path.join(dir, "real");
    const other = path.join(dir, "other");
    await mkdir(real, { mode: 0o700 });
    await mkdir(other, { mode: 0o700 });
    const link = path.join(dir, "link");
    await symlink(real, link);
    const s = await LoopStore.open(link);
    await rm(link);
    await symlink(other, link); // the given path now points elsewhere
    await s.intent("a", "k", NOW);
    await s.close();
    expect((await readdir(real)).sort()).toEqual(["state.json", "state.lock"]);
    expect(await readdir(other)).toEqual([]);
  });

  it("creates a missing directory with mode 0700", async () => {
    const made = path.join(dir, "nested", "loop");
    await (await LoopStore.open(made)).close();
    expect((await stat(made)).mode & 0o777).toBe(0o700);
  });

  it.each([0o750, 0o705, 0o777])("refuses a directory with mode %o", async (mode) => {
    await chmod(dir, mode);
    try { await expect(LoopStore.open(dir)).rejects.toThrow(/mode 0700/); } finally { await chmod(dir, 0o700); }
  });
});
