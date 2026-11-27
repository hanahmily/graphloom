// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, type EvaluateOptions, type ReadOutcome } from "@graphloom/loop";
import { GITHUB_EXECUTOR_IDS } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createLoopReadHost, type LoopReadHost } from "../src/loop-read-host.js";

const READ_TOKEN = "ghp_read_only_token_value";
const WRITE_TOKEN = "ghp_write_token_value";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(issueCount = 3): Promise<FakeGitHub> {
  const server = await startFakeGitHub({
    issues: Array.from({ length: issueCount }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, state: "open" as const, labels: [] })),
  });
  cleanups.push(() => server.close());
  return server;
}

async function host(
  server: FakeGitHub,
  over: { github?: { tokenEnv?: string; writeTokenEnv?: string }; env?: NodeJS.ProcessEnv; scratchRoot?: string } = {},
): Promise<LoopReadHost> {
  const h = await createLoopReadHost({
    config: { github: { tokenEnv: "READ_TOKEN", baseUrl: server.baseUrl, ...over.github } },
    env: over.env ?? { READ_TOKEN: READ_TOKEN },
    loopName: "triage",
    tickId: "t1",
    ...(over.scratchRoot !== undefined ? { scratchRoot: over.scratchRoot } : {}),
  });
  cleanups.push(() => h.close());
  return h;
}

const live = new AbortController().signal;
const list = (id: string, input: Record<string, unknown> = {}) => ({ id, executor: "graphloom.github/list-issues", input: { owner: "acme", repo: "app", ...input } });

describe("loop read host: construction", () => {
  const server = { baseUrl: "http://127.0.0.1:1" } as FakeGitHub;
  const make = (config: Parameters<typeof createLoopReadHost>[0]["config"], env: NodeJS.ProcessEnv) =>
    createLoopReadHost({ config, env, loopName: "l", tickId: "t" });

  it("rejects a config with no github section, no tokenEnv, or an empty variable", async () => {
    await expect(make({}, { READ_TOKEN })).rejects.toThrow(/github section/);
    await expect(make({ github: { baseUrl: server.baseUrl } }, { READ_TOKEN })).rejects.toThrow(/github\.tokenEnv/);
    await expect(make({ github: { tokenEnv: "MY_TOKEN" } }, {})).rejects.toThrow(/MY_TOKEN/);
    await expect(make({ github: { tokenEnv: "MY_TOKEN" } }, { MY_TOKEN: "" })).rejects.toThrow(/MY_TOKEN/);
  });

  it("never names the token's value in a rejection", async () => {
    const err = await make({ github: { tokenEnv: "MY_TOKEN" } }, { OTHER: READ_TOKEN }).catch((e: Error) => e);
    expect(String(err)).not.toContain(READ_TOKEN);
  });
});

describe("loop read host: never write-capable", () => {
  it("sends only the read token even when writeTokenEnv is set and present", async () => {
    const s = await fake();
    const h = await host(s, { github: { writeTokenEnv: "WRITE_TOKEN" }, env: { READ_TOKEN, WRITE_TOKEN } });
    const outcome = await h.read(list("a"), live);
    expect(outcome.status).toBe("ok");
    expect(s.requests.length).toBeGreaterThan(0);
    expect(new Set(s.requests.map((r) => r.authorization))).toEqual(new Set([`Bearer ${READ_TOKEN}`]));
    expect(JSON.stringify(s.requests)).not.toContain(WRITE_TOKEN);
  });

  it.each(["create-pull-review", "create-issue-comment", "add-labels", "remove-labels", "create-pull", "update-issue"])(
    "refuses write executor %s before any request",
    async (name) => {
      const s = await fake();
      const h = await host(s, { github: { writeTokenEnv: "WRITE_TOKEN" }, env: { READ_TOKEN, WRITE_TOKEN } });
      const outcome = await h.read({ id: "w", executor: `graphloom.github/${name}`, input: { owner: "acme", repo: "app" } }, live);
      expect(outcome.status).toBe("failed");
      expect(outcome.summary).toMatch(/effect write/);
      expect(s.requests).toHaveLength(0);
    },
  );

  it("refuses executors it does not serve and allows every declared read", async () => {
    const s = await fake();
    const h = await host(s);
    for (const id of ["graphloom.command/run", "nonsense"]) {
      const outcome = await h.read({ id: "x", executor: id, input: {} }, live);
      expect(outcome).toMatchObject({ status: "failed" });
      expect(outcome.summary).toMatch(/not a read executor/);
    }
    expect(s.requests).toHaveLength(0);
    // The allowed set comes from the definitions: every package id is either a read this host runs or refused as a write.
    for (const id of GITHUB_EXECUTOR_IDS) {
      const outcome = await h.read({ id: "y", executor: id, input: { __probe: true } }, live);
      const refusedAsWrite = /loop reads may use read executors only/.test(outcome.summary);
      expect(refusedAsWrite).toBe(/create|add-|remove-|update-/.test(id));
    }
  });
});

describe("loop read host: outcomes", () => {
  it("maps a successful read with the github evidence payload and run identity", async () => {
    const s = await fake(2);
    const h = await host(s);
    const outcome = await h.read(list("a", { state: "open" }), live);
    expect(outcome.status).toBe("ok");
    const github = (outcome.evidence![0]!.payload as { github: { items: Array<{ number: number }> } }).github;
    expect(github.items.map((i) => i.number).sort()).toEqual([1, 2]);
    expect(outcome.retryAfterMs).toBeUndefined();
  });

  it("an input the executor rejects is a failed outcome, not a throw, and sends no request", async () => {
    const s = await fake();
    const h = await host(s);
    const outcome = await h.read(list("a", { repo: "../etc" }), live);
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toMatch(/schema validation/);
    expect(s.requests).toHaveLength(0);
  });

  it("keeps retryAfterMs on a rate-limited read", async () => {
    const s = await fake();
    const h = await host(s);
    s.rateLimitNext(1, 120);
    const outcome = await h.read(list("a"), live);
    expect(outcome.status).toBe("failed");
    expect(outcome.retryAfterMs).toBeGreaterThan(60_000);
    expect(outcome.retryAfterMs).toBeLessThanOrEqual(121_000);
  });

  it("never carries the token in an outcome (success, 401 echoing it, rate limit)", async () => {
    const s = await fake();
    const h = await host(s);
    const ok = await h.read(list("a"), live);
    const unauthorized = await h.read({ id: "u", executor: "graphloom.github/get-issue", input: { owner: "acme", repo: "app", number: 401 } }, live);
    s.rateLimitNext(1, 60);
    const limited = await h.read(list("b"), live);
    expect(unauthorized.status).toBe("failed");
    expect(s.requests.some((r) => r.path.includes("/issues/401"))).toBe(true);
    for (const outcome of [ok, unauthorized, limited]) expect(JSON.stringify(outcome)).not.toContain(READ_TOKEN);
  });

  it("resolves a failed outcome promptly on abort and stays usable", async () => {
    const s = await fake();
    const h = await host(s);
    const pre = new AbortController();
    pre.abort();
    expect(await h.read(list("a"), pre.signal)).toMatchObject({ status: "failed", summary: "read aborted" });
    const during = new AbortController();
    const pending = h.read(list("b"), during.signal);
    during.abort();
    expect(await pending).toMatchObject({ status: "failed", summary: "read aborted" });
    expect((await h.read(list("c"), live)).status).toBe("ok");
  });
});

describe("loop read host: scratch directory", () => {
  it("makes one empty scratch directory under scratchRoot and removes it on close, twice safely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "loop-scratch-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const s = await fake();
    const h = await host(s, { scratchRoot: root });
    const [dir, ...more] = await readdir(root);
    expect(more).toEqual([]);
    expect(await readdir(path.join(root, dir!))).toEqual([]);
    await h.read(list("a"), live);
    await h.read(list("b"), live);
    expect(await readdir(path.join(root, dir!))).toEqual([]);
    await h.close();
    await expect(access(path.join(root, dir!))).rejects.toThrow();
    await h.close();
    expect(await h.read(list("c"), live)).toMatchObject({ status: "failed", summary: "read host is closed" });
  });
});

describe("loop read host under the real evaluator", () => {
  const options = (over: Partial<EvaluateOptions> = {}): EvaluateOptions => ({
    protocol: 1,
    profile: { owner: "acme", repo: "app" },
    now: "2026-11-27T00:00:00.000Z",
    allowedReads: ["graphloom.github/list-issues"],
    ...over,
  });
  type Page = { github: { items: Array<{ number: number }>; page: { nextCursor: string | null } } };

  it("paginates over two rounds into candidates with a transcript", async () => {
    const s = await fake(5);
    const h = await host(s);
    const hook = async (input: { round: number; results: Array<{ ok: boolean; output?: unknown }> }) => {
      if (input.round === 0) return { reads: [list("p1", { perPage: 3, maxPages: 1 })] };
      const first = (input.results[0]!.output as Page).github;
      if (input.round === 1) return { reads: [list("p2", { perPage: 3, maxPages: 1, cursor: first.page.nextCursor })] };
      return { candidates: first.items.map((i) => ({ key: `issue:${i.number}`, taskArgs: [`#${i.number}`] })) };
    };
    const out = await evaluate({ hook, read: (r, sig) => h.read(r, sig) }, options());
    expect(out.kind).toBe("candidates");
    if (out.kind !== "candidates") return;
    expect(out.transcript.rounds.map((r) => [r.reads.length, r.results.map((x) => x.ok)])).toEqual([[1, [true]], [1, [true]], [0, []]]);
    const second = (out.transcript.rounds[1]!.results[0]!.output as Page).github.items.map((i) => i.number);
    expect(second).toHaveLength(2);
    expect(out.candidates.map((c) => c.key)).toEqual(second.map((n) => `issue:${n}`));
    expect(JSON.stringify(out.transcript)).not.toContain(READ_TOKEN);
  });

  it("a rate-limited read defers the tick with no further reads", async () => {
    const s = await fake();
    const h = await host(s);
    s.rateLimitNext(5, 90);
    let hookCalls = 0;
    const hook = async () => { hookCalls += 1; return { reads: [list("p1")] }; };
    const out = await evaluate({ hook, read: (r, sig) => h.read(r, sig) }, options());
    expect(out.kind).toBe("deferred");
    if (out.kind !== "deferred") return;
    const wait = Date.parse(out.until) - Date.parse("2026-11-27T00:00:00.000Z");
    expect(wait).toBeGreaterThan(60_000);
    expect(wait).toBeLessThanOrEqual(91_000);
    expect(hookCalls).toBe(1);
    expect(JSON.stringify(out)).not.toContain(READ_TOKEN);
  });
});

describe("loop read host: sandbox and scratch mount (experiment)", () => {
  it("a read succeeds with a scratch directory that was never created inside the sandbox", async () => {
    const s = await fake();
    const root = await mkdtemp(path.join(os.tmpdir(), "loop-scratch-root-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const h = await host(s, { scratchRoot: root });
    // Remove the directory the job's context names: if the sandbox needed it mounted, the read would fail.
    for (const d of await readdir(root)) await rm(path.join(root, d), { recursive: true, force: true });
    const outcome: ReadOutcome = await h.read(list("a"), live);
    expect(outcome.status).toBe("ok");
  });
});

describe("loop read host: abort", () => {
  it("stops the read's executor process: an aborted read sends no request", async () => {
    const server = await fake();
    const h = await host(server);
    const controller = new AbortController();
    const pending = h.read(list("a"), controller.signal);
    controller.abort();
    expect((await pending).summary).toBe("read aborted");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(server.requests).toHaveLength(0);
    // the host stays usable after an abort
    expect((await h.read(list("b"), live)).status).toBe("ok");
  });
});
