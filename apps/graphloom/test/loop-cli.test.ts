// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe as vitestDescribe, expect, it } from "vitest";
import { createLoopReadHost } from "../src/loop-read-host.js";
import { readProfile } from "../src/task-new.js";
import { confinementUnsupported } from "@graphloom/runner";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { closeOnSignal, LOOP_EXIT, loopCommand, loopEvaluate, parseLoopEvaluateArgs, type LoopEvaluateOptions } from "../src/loop-cli.js";

// The hook runs only confined, so these end-to-end tests need bubblewrap; without it they are skipped (loop-confine.test.ts checks the refusal).
const bwrapUnsupported = await confinementUnsupported();
const describe = Object.assign((name: string, fn: () => void) => vitestDescribe.skipIf(bwrapUnsupported !== undefined)(bwrapUnsupported !== undefined ? `${name} (skipped: ${bwrapUnsupported})` : name, fn), vitestDescribe);

const TOKEN = "ghp_loop_cli_test_token";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

/** Round 0 asks the list executor for the profile's repository; round 1 turns the issues it got into candidates, oldest first. */
const LISTER = `
export function createGraph() {
  return {
    describe() { return { graphId: "lister", version: "1", stages: [], requirements: [], defaultValidators: [] }; },
    advance() { throw new Error("unused"); },
    loopCandidates(input) {
      if (input.round === 0) {
        return { reads: [{ id: "p1", executor: "graphloom.github/list-issues", input: { owner: input.profile.owner, repo: input.profile.repo, state: "open" } }] };
      }
      const r = input.results[0];
      if (!r.ok) return { refused: "read failed: " + r.error };
      const items = r.output.github ? r.output.github.items : r.output.items;
      return { candidates: items.map((i) => ({ key: "item:" + input.profile.owner + "/" + input.profile.repo + "#" + i.number, taskArgs: [String(i.number)] })) };
    },
  };
}
`;

/** No reads: one candidate keyed by the date of \`now\`; the profile steers the failure modes. */
const DAILY = `
export function createGraph() {
  return {
    describe() { return { graphId: "daily", version: "1", stages: [], requirements: [], defaultValidators: [] }; },
    advance() { throw new Error("unused"); },
    async loopCandidates(input) {
      const mode = input.profile && input.profile.mode;
      if (mode === "throw") throw new Error("hook exploded");
      if (mode === "hang") return new Promise(() => {});
      if (mode === "refuse") return { refused: "profile has no loop section" };
      if (mode === "garbage") return { candidates: [{ key: "bad key with spaces", taskArgs: [] }] };
      if (mode === "env") return { candidates: [{ key: "token:" + (Object.values(process.env).some((v) => String(v).includes(${JSON.stringify(TOKEN)})) ? "visible" : "absent"), taskArgs: [] }] };
      if (mode === "read") return { reads: [{ id: "r", executor: "graphloom.github/list-issues", input: {} }] };
      return { candidates: [{ key: "day:" + input.now.slice(0, 10), taskArgs: [] }] };
    },
  };
}
`;

const NO_HOOK = DAILY.replace("async loopCandidates(input) {", "async notLoop(input) {");
const READS = ["graphloom.github/list-issues"];

async function bundle(out: string, graph: string, source: string, loop: unknown | undefined): Promise<string> {
  const dir = path.join(out, "plugins", graph);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.mjs"), source);
  await writeFile(
    path.join(dir, "graphloom.manifest.json"),
    JSON.stringify({ graphId: graph, version: "1", sdkProtocol: 1, entryPoints: { createGraph: "./index.mjs" }, ...(loop !== undefined ? { loop } : {}) }),
  );
  return dir;
}

interface World {
  out: string;
  server: FakeGitHub;
  runnerConfig: string;
  env: NodeJS.ProcessEnv;
}

async function world(issueCount = 3): Promise<World> {
  const out = await mkdtemp(path.join(os.tmpdir(), "graphloom-loop-cli-"));
  cleanups.push(() => rm(out, { recursive: true, force: true }));
  const server = await startFakeGitHub({ issues: Array.from({ length: issueCount }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, state: "open" as const, labels: [] })) });
  cleanups.push(() => server.close());
  const runnerConfig = path.join(out, "runner.json");
  await writeFile(runnerConfig, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, github: { tokenEnv: "LOOP_CLI_TOKEN", baseUrl: server.baseUrl } }));
  await writeFile(path.join(out, "profile.json"), JSON.stringify({ owner: "acme", repo: "app" }));
  await mkdir(path.join(out, "profiles"));
  await writeFile(path.join(out, "profiles", "hook.json"), JSON.stringify({ mode: "throw" }));
  await bundle(out, "lister", LISTER, { protocol: 1, reads: READS });
  await bundle(out, "daily", DAILY, { protocol: 1, reads: [] });
  return { out, server, runnerConfig, env: { PATH: process.env.PATH, LOOP_CLI_TOKEN: TOKEN } };
}

async function evaluateCli(w: World, over: Partial<LoopEvaluateOptions> & { graph: string }) {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await loopEvaluate({ out: w.out, env: w.env, ...over }, (l) => void lines.push(l), (l) => void errors.push(l));
  return { code, text: lines.join("\n"), errText: errors.join("\n") };
}

const NOW = "2026-03-04T05:06:07.000Z";

describe("graphloom loop evaluate: end to end through the plugin host and the read host", () => {
  it("reads from the fake GitHub in round 0 and lists candidates in round 1", async () => {
    const w = await world();
    const r = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), runnerConfig: w.runnerConfig, now: NOW });
    expect(r.code).toBe(LOOP_EXIT.ok);
    expect(r.text).toContain("candidates: 3");
    expect(r.text).toContain("item:acme/app#1");
    expect(r.text).toContain('["2"]');
    expect(w.server.requests.length).toBeGreaterThan(0);
    expect(new Set(w.server.requests.map((q) => q.authorization))).toEqual(new Set([`Bearer ${TOKEN}`]));
  });

  it("--json prints { outcome, transcript } with the recorded rounds", async () => {
    const w = await world(2);
    const r = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), runnerConfig: w.runnerConfig, now: NOW, json: true });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.text) as { outcome: Record<string, unknown>; transcript: { protocol: number; now: string; rounds: Array<{ round: number; reads: unknown[]; results: Array<{ ok: boolean }>; reply: unknown }> } };
    expect(Object.keys(doc).sort()).toEqual(["outcome", "transcript"]);
    expect(doc.outcome).toEqual({ kind: "candidates", candidates: [{ key: "item:acme/app#1", taskArgs: ["1"] }, { key: "item:acme/app#2", taskArgs: ["2"] }] });
    expect(doc.transcript).toMatchObject({ protocol: 1, now: NOW });
    expect(doc.transcript.rounds.map((x) => x.round)).toEqual([0, 1]);
    expect(doc.transcript.rounds[0]!.reads).toHaveLength(1);
    expect(doc.transcript.rounds[0]!.results[0]!.ok).toBe(true);
  });

  it("a bundle that declares a read needs a runner config with the token", async () => {
    const w = await world();
    const base = { graph: "lister", profile: path.join(w.out, "profile.json"), now: NOW };
    const missingFile = await evaluateCli(w, { ...base, runnerConfig: path.join(w.out, "nope.json") });
    expect(missingFile.code).toBe(LOOP_EXIT.failed);
    expect(missingFile.errText).toContain("cannot read runner config");
    const noToken = await evaluateCli({ ...w, env: { PATH: process.env.PATH } }, { ...base, runnerConfig: w.runnerConfig });
    expect(noToken.code).toBe(LOOP_EXIT.failed);
    expect(noToken.errText).toContain("LOOP_CLI_TOKEN");
    expect(noToken.errText).not.toContain(TOKEN);
  });

  it("defers when a read is rate limited, and names the time", async () => {
    const w = await world();
    w.server.rateLimitNext(100, 120);
    const r = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), runnerConfig: w.runnerConfig, now: NOW });
    expect(r.code).toBe(LOOP_EXIT.deferred);
    expect(r.text).toMatch(/^deferred until 2026-03-04T05:\d\d:\d\d\.\d{3}Z/);
  });
});

describe("graphloom loop evaluate: a bundle with no reads", () => {
  it("keys its candidate by the date of --now, and needs no runner config", async () => {
    const w = await world();
    const r = await evaluateCli(w, { graph: "daily", now: NOW });
    expect(r).toMatchObject({ code: 0 });
    expect(r.text).toContain("day:2026-03-04");
  });

  it("evaluates a graph that works without a repository (repository none), the hub janitor's shape", async () => {
    const w = await world();
    await bundle(w.out, "janitor", DAILY.replace('graphId: "daily"', 'graphId: "janitor"'), { protocol: 1, reads: [] });
    const manifest = path.join(w.out, "plugins", "janitor", "graphloom.manifest.json");
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(await readFile(manifest, "utf8")), repository: "none" }));
    const r = await evaluateCli(w, { graph: "janitor", now: NOW });
    expect(r).toMatchObject({ code: 0 });
    expect(r.text).toContain("day:2026-03-04");
  });

  it("uses the current UTC instant without --now", async () => {
    const w = await world();
    const before = new Date().toISOString().slice(0, 10);
    const r = await evaluateCli(w, { graph: "daily" });
    const after = new Date().toISOString().slice(0, 10);
    expect([`day:${before}`, `day:${after}`].some((k) => r.text.includes(k))).toBe(true);
  });

  it("a bad --now is a usage error, found before the runner config and token are required", async () => {
    const w = await world();
    const r = await evaluateCli({ ...w, env: { PATH: process.env.PATH } }, { graph: "lister", profile: path.join(w.out, "profile.json"), now: "yesterday" });
    expect(r.code).toBe(LOOP_EXIT.failed);
    expect(r.errText).toContain("--now must be a UTC instant");
    expect(r.errText).not.toContain("runner config");
    expect(parseLoopEvaluateArgs(["g", "--now", "2026-02-30T00:00:00Z"]).error).toContain("--now must be a UTC instant");
    expect(parseLoopEvaluateArgs(["g", "--now", NOW]).error).toBeUndefined();
  });

  it("gives the plugin child no credentials from the environment", async () => {
    const w = await world();
    await writeFile(path.join(w.out, "env.json"), JSON.stringify({ mode: "env" }));
    const r = await evaluateCli(w, { graph: "daily", profile: path.join(w.out, "env.json"), now: NOW });
    expect(r.text).toContain("token:absent");
  });

  it("a hook error blocks (exit 3) naming the message", async () => {
    const w = await world();
    const r = await evaluateCli(w, { graph: "daily", profile: "hook", now: NOW });
    expect(r.code).toBe(LOOP_EXIT.blocked);
    expect(r.text).toMatch(/^blocked: .*hook exploded/);
  });

  it("a hanging hook blocks on the hook timeout", async () => {
    const w = await world();
    await writeFile(path.join(w.out, "hang.json"), JSON.stringify({ mode: "hang" }));
    const started = Date.now();
    const r = await evaluateCli(w, { graph: "daily", profile: path.join(w.out, "hang.json"), now: NOW, hookTimeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.code).toBe(LOOP_EXIT.blocked);
    expect(r.text).toContain("timed out");
  });

  it("a malformed reply blocks, a refusal exits 2 with the reason", async () => {
    const w = await world();
    await writeFile(path.join(w.out, "garbage.json"), JSON.stringify({ mode: "garbage" }));
    await writeFile(path.join(w.out, "refuse.json"), JSON.stringify({ mode: "refuse" }));
    expect((await evaluateCli(w, { graph: "daily", profile: path.join(w.out, "garbage.json"), now: NOW })).code).toBe(LOOP_EXIT.blocked);
    const refused = await evaluateCli(w, { graph: "daily", profile: path.join(w.out, "refuse.json"), now: NOW });
    expect(refused.code).toBe(LOOP_EXIT.refused);
    expect(refused.text).toBe("refused: profile has no loop section");
  });

  it("refuses a read the manifest does not declare", async () => {
    const w = await world();
    await writeFile(path.join(w.out, "read.json"), JSON.stringify({ mode: "read" }));
    const r = await evaluateCli(w, { graph: "daily", profile: path.join(w.out, "read.json"), now: NOW });
    expect(r.code).toBe(LOOP_EXIT.blocked);
    expect(r.text).toContain("does not declare in loop.reads");
    expect(w.server.requests).toHaveLength(0);
  });
});

describe("graphloom loop evaluate: bundle and usage refusals", () => {
  it("refuses a bundle with no loop key", async () => {
    const w = await world();
    await bundle(w.out, "plain", DAILY, undefined);
    const r = await evaluateCli(w, { graph: "plain", now: NOW });
    expect(r.code).toBe(LOOP_EXIT.failed);
    expect(r.errText).toContain("graph plain does not discover work");
  });

  it("refuses a loop protocol other than 1 and a malformed loop key", async () => {
    const w = await world();
    await bundle(w.out, "future", DAILY, { protocol: 2, reads: [] });
    await bundle(w.out, "extra", DAILY, { protocol: 1, reads: [], more: true });
    await bundle(w.out, "spaced", DAILY, { protocol: 1, reads: ["a b"] });
    expect((await evaluateCli(w, { graph: "future" })).errText).toContain("loop protocol 2");
    expect((await evaluateCli(w, { graph: "extra" })).errText).toContain('unknown property "more"');
    expect((await evaluateCli(w, { graph: "spaced" })).errText).toContain("no whitespace");
  });

  it("a bundle that declares a loop but has no hook blocks with the clear message", async () => {
    const w = await world();
    await bundle(w.out, "hookless", NO_HOOK, { protocol: 1, reads: [] });
    const r = await evaluateCli(w, { graph: "hookless", now: NOW });
    expect(r.code).toBe(LOOP_EXIT.blocked);
    expect(r.text).toContain("graph hookless does not discover work");
  });

  it("resolves the bundle and profile as task new does, and refuses traversal", async () => {
    const w = await world();
    expect((await evaluateCli(w, { graph: "../daily" })).code).toBe(LOOP_EXIT.failed);
    expect((await evaluateCli(w, { graph: "nothere" })).errText).toContain("no graph bundle nothere");
    const badProfile = await evaluateCli(w, { graph: "daily", profile: "..foo/bar" , now: NOW });
    expect(badProfile.code).toBe(LOOP_EXIT.failed);
    expect((await evaluateCli(w, { graph: "daily", profile: "no-such-profile", now: NOW })).errText).toContain("profile no-such-profile was not found");
  });

  it("parses its arguments and reports usage errors", async () => {
    expect(parseLoopEvaluateArgs(["g", "--out", "o", "--profile=p", "--runner-config", "r", "--now", NOW, "--replay", "t.json", "--json"]).options).toEqual({ graph: "g", out: "o", profile: "p", runnerConfig: "r", now: NOW, replay: "t.json", json: true });
    expect(parseLoopEvaluateArgs([]).error).toMatch(/needs a graph id/);
    expect(parseLoopEvaluateArgs(["g", "--now"]).error).toMatch(/--now needs a value/);
    expect(parseLoopEvaluateArgs(["g", "--bogus"]).error).toMatch(/unknown argument/);
    const errors: string[] = [];
    expect(await loopCommand(["nope"], () => undefined, (l) => void errors.push(l))).toBe(LOOP_EXIT.failed);
    expect(errors.join("")).toContain("usage: graphloom loop evaluate");
  });
});

describe("graphloom loop evaluate --replay", () => {
  it("reproduces a recorded transcript with no read host, and names the round that differs", async () => {
    const w = await world();
    const recorded = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), runnerConfig: w.runnerConfig, now: NOW, json: true });
    const file = path.join(w.out, "transcript.json");
    await writeFile(file, recorded.text);
    const requestsBefore = w.server.requests.length;

    // No runner config and no token: a replay never reads.
    const ok = await evaluateCli({ ...w, env: { PATH: process.env.PATH } }, { graph: "lister", profile: path.join(w.out, "profile.json"), replay: file });
    expect(ok).toMatchObject({ code: 0 });
    expect(ok.text).toBe("replay ok: 2 rounds reproduced");
    expect(w.server.requests).toHaveLength(requestsBefore);

    const doc = JSON.parse(await readFile(file, "utf8")) as { transcript: { rounds: Array<{ reply: { candidates?: Array<{ key: string }> } }> } };
    doc.transcript.rounds[1]!.reply.candidates![0]!.key = "item:other#9";
    await writeFile(file, JSON.stringify(doc.transcript));
    const bad = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), replay: file });
    expect(bad.code).toBe(LOOP_EXIT.failed);
    expect(bad.errText).toBe("replay differs at round 1: reply differs from the recorded reply");
  });

  it("refuses a file that is not a transcript", async () => {
    const w = await world();
    await writeFile(path.join(w.out, "t.json"), JSON.stringify({ hello: 1 }));
    const r = await evaluateCli(w, { graph: "daily", replay: path.join(w.out, "t.json") });
    expect(r.code).toBe(LOOP_EXIT.failed);
    expect(r.errText).toContain("is not a loop transcript");
  });
});

describe("graphloom loop evaluate --json and --help", () => {
  it("prints replay verdicts as JSON", async () => {
    const w = await world();
    const recorded = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), runnerConfig: w.runnerConfig, now: NOW, json: true });
    const file = path.join(w.out, "transcript.json");
    await writeFile(file, recorded.text);
    const ok = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), replay: file, json: true });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.text)).toEqual({ replay: { ok: true, rounds: 2 } });
    const doc = JSON.parse(await readFile(file, "utf8")) as { transcript: { rounds: Array<{ reply: { candidates: Array<{ key: string }> } }> } };
    doc.transcript.rounds[1]!.reply.candidates[0]!.key = "item:other#9";
    await writeFile(file, JSON.stringify(doc.transcript));
    const bad = await evaluateCli(w, { graph: "lister", profile: path.join(w.out, "profile.json"), replay: file, json: true });
    expect(bad.code).toBe(LOOP_EXIT.failed);
    expect(JSON.parse(bad.text)).toEqual({ replay: { ok: false, round: 1, reason: "reply differs from the recorded reply" } });
    expect(bad.errText).toContain("replay differs at round 1");
  });

  it("prints a CLI-level failure as { error } on stdout with the same exit code, the human message on stderr", async () => {
    const w = await world();
    const out: string[] = [];
    const errs: string[] = [];
    const code = await loopCommand(["evaluate", "nothere", "--out", w.out, "--json"], (l) => void out.push(l), (l) => void errs.push(l));
    expect(code).toBe(LOOP_EXIT.failed);
    expect(JSON.parse(out.join("\n"))).toEqual({ error: expect.stringContaining("no graph bundle nothere") });
    expect(errs.join("\n")).toContain("no graph bundle nothere");
    const usage: string[] = [];
    expect(await loopCommand(["evaluate", "g", "--bogus", "--json"], (l) => void usage.push(l), () => undefined)).toBe(LOOP_EXIT.failed);
    expect(JSON.parse(usage.join("\n"))).toEqual({ error: expect.stringContaining("unknown argument") });
    const bad = await evaluateCli(w, { graph: "daily", now: "yesterday", json: true });
    expect(bad.code).toBe(LOOP_EXIT.failed);
    expect(JSON.parse(bad.text)).toEqual({ error: expect.stringContaining("--now must be a UTC instant") });
  });

  it("without --json a failure prints nothing on stdout", async () => {
    const w = await world();
    const r = await evaluateCli(w, { graph: "nothere" });
    expect(r.text).toBe("");
  });

  it("loop --help and loop evaluate --help print to stdout and exit 0", async () => {
    for (const argv of [["--help"], ["-h"], ["evaluate", "--help"], ["evaluate", "g", "--help"]]) {
      const out: string[] = [];
      const errs: string[] = [];
      expect(await loopCommand(argv, (l) => void out.push(l), (l) => void errs.push(l))).toBe(0);
      expect(out.join("\n")).toContain("graphloom loop evaluate <graph>");
      expect(errs).toEqual([]);
    }
  });
});

describe("graphloom loop evaluate: bounded reads", () => {
  it("refuses a transcript over 16 MiB before reading it", async () => {
    const w = await world();
    const file = path.join(w.out, "big.json");
    await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    const r = await evaluateCli(w, { graph: "daily", replay: file });
    expect(r.code).toBe(LOOP_EXIT.failed);
    expect(r.errText).toContain("more than 16777216");
  });

  it("refuses a transcript that is not a regular file", async () => {
    const w = await world();
    const r = await evaluateCli(w, { graph: "daily", replay: "/dev/zero" });
    expect(r.code).toBe(LOOP_EXIT.failed);
    expect(r.errText).toContain("not a regular file");
  });

  it("refuses a profile over the task-config limit, with the message task new gives", async () => {
    const w = await world();
    const file = path.join(w.out, "huge-profile.json");
    await writeFile(file, JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }));
    await expect(readProfile(file)).rejects.toThrow(/^profile .* is \d+ bytes, more than \d+$/);
    const r = await evaluateCli(w, { graph: "daily", profile: file });
    expect(r.code).toBe(LOOP_EXIT.failed);
    expect(r.errText).toMatch(/is \d+ bytes, more than \d+/);
  });
});

vitestDescribe("graphloom loop evaluate: stop signals", () => {
  const fakeProcess = () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    return {
      handlers,
      exits,
      source: {
        on: (s: string, h: () => void) => void handlers.set(s, h),
        off: (s: string, h: () => void) => void (handlers.get(s) === h && handlers.delete(s)),
        exit: (c: number) => void exits.push(c),
      },
    };
  };

  it("closes both hosts, removes the read host's scratch directory and exits 128 + the signal", async () => {
    const w = await world();
    const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "graphloom-loop-scratch-"));
    cleanups.push(() => rm(scratchRoot, { recursive: true, force: true }));
    const host = await createLoopReadHost({ config: { github: { tokenEnv: "LOOP_CLI_TOKEN", baseUrl: w.server.baseUrl } }, env: w.env, loopName: "t", tickId: "1", scratchRoot });
    let pluginClosed = false;
    const fake = fakeProcess();
    const stop = closeOnSignal(async () => {
      await host.close();
      pluginClosed = true;
    }, fake.source);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(scratchRoot)).toHaveLength(1);
    fake.handlers.get("SIGTERM")!();
    fake.handlers.get("SIGTERM")?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(pluginClosed).toBe(true);
    expect(await readdir(scratchRoot)).toEqual([]);
    expect(fake.exits).toEqual([143]);
    stop();
    expect(fake.handlers.size).toBe(0);
  });

  it("exits 130 on SIGINT, even when closing fails", async () => {
    const fake = fakeProcess();
    closeOnSignal(async () => { throw new Error("close failed"); }, fake.source);
    fake.handlers.get("SIGINT")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.exits).toEqual([130]);
  });
});
