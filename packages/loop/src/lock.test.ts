// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopStore } from "./index.js";

// The worker imports the built package (npm run build -w @graphloom/loop first).
const worker = fileURLToPath(new URL("../test/lock-worker.mjs", import.meta.url));

let dir: string;
const children: ChildProcessWithoutNullStreams[] = [];
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "loop-lock-")); });
afterEach(async () => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

interface Worker { child: ChildProcessWithoutNullStreams; outcome: Promise<string> }
function start(): Worker {
  const child = spawn(process.execPath, [worker, dir], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const outcome = new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); if (out.includes("\n")) resolve(out.trim()); });
    child.once("error", reject);
    child.once("close", () => resolve(out.trim() || "died"));
  });
  return { child, outcome };
}

describe("the store lock across processes", () => {
  it("lets exactly one of many concurrent openers hold the store", async () => {
    for (let round = 0; round < 3; round++) {
      const workers = Array.from({ length: 12 }, start);
      const outcomes = await Promise.all(workers.map((w) => w.outcome));
      expect(outcomes.filter((o) => o === "held")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "refused")).toHaveLength(11);
      const holder = workers[outcomes.indexOf("held")]!;
      await expect(LoopStore.open(dir)).rejects.toThrow(/locked/);
      holder.child.kill("SIGKILL");
      await new Promise((resolve) => holder.child.once("close", resolve));
      // a crashed holder never leaves the store locked
      const next = await LoopStore.open(dir);
      await next.intent("a", `k${round}`, "2026-03-04T05:06:07Z");
      await next.close();
    }
  });

  it("a fresh opener's partial state cannot be taken over, and a rival finds the lock free after a clean close", async () => {
    const w = start();
    expect(await w.outcome).toBe("held");
    const rivals = await Promise.all(Array.from({ length: 8 }, () => LoopStore.open(dir).then(() => "held", () => "refused")));
    expect(rivals).toEqual(Array(8).fill("refused"));
    w.child.stdin.end();
    await new Promise((resolve) => w.child.once("close", resolve));
    await (await LoopStore.open(dir)).close();
  });
});

describe("losing the lock helper", () => {
  it("a killed flock helper makes the store refuse every later mutation", async (ctx) => {
    const pids = (() => {
      try { return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; // no pgrep on this host
        return [];
      }
    })();
    if (pids === undefined) { console.warn("pgrep is unavailable; skipping the lost-lock test"); ctx.skip(); return; }
    expect(pids).toEqual([]);
    const store = await LoopStore.open(dir);
    const helpers = execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
    expect(helpers).toHaveLength(1);
    await store.intent("a", "k1", "2026-03-04T05:06:07Z");
    process.kill(helpers[0]!, "SIGKILL");
    const deadline = Date.now() + 5000;
    let refused: unknown;
    while (Date.now() < deadline && refused === undefined) {
      await store.intent("a", `k${Math.random()}`, "2026-03-04T05:06:07Z").catch((e: unknown) => { refused = e; });
      if (refused === undefined) await new Promise((r) => setTimeout(r, 20));
    }
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/lock was lost/);
    await expect(store.started("k1", "r")).rejects.toThrow(/lock was lost/);
    await store.close();
  });
});
