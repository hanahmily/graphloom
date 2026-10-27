// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom wait --until progress` (docs/design-agent-skills.md §2): each
 * event kind from durable state, the cursor and `--since`, the timeout, the
 * stop; and an end-to-end scripted hello run watched with it.
 */
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunState, type DurableRunState } from "@graphloom/controller";
import { decodeCursor, encodeCursor, markOf, progressSince, progressSummary, type ProgressEvent, type ProgressResult } from "../src/progress.js";
import { makeCliEnv, type CliEnv } from "./cli-env.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/stats/395ec998-6e4");

/** The recorded issue-fix run, as if it were still running in normal mode. */
async function running(): Promise<DurableRunState> {
  const s = await loadRunState(fixture);
  const { recoveryEpisodeId: _e, recoveryTrigger: _t, quotaHold: _q, ...rest } = s;
  return { ...rest, status: "running", mode: "normal", supervisorEpisodes: [], remedies: [] } as DurableRunState;
}

const kinds = (events: ProgressEvent[]) => events.map((e) => e.kind);

describe("progress events from durable state", () => {
  it("reports nothing against its own mark", async () => {
    const s = await running();
    expect(progressSince(markOf(s), s).events).toEqual([]);
  });

  it("stage_entered: the current stage or attempt changed", async () => {
    const s = await running();
    const { events } = progressSince(markOf(s), { ...s, current: { stageId: "review", attempt: 5 } });
    expect(events).toEqual([expect.objectContaining({ kind: "stage_entered", stage: "review", attempt: 5, detail: "stage review, attempt 5" })]);
  });

  it("receipt_accepted: new valid receipts per stage, saying whether the stage is complete; receipts_invalidated: more invalid ones", async () => {
    const s = await running();
    const template = s.receipts.find((r) => r.stageId === "review")!;
    const next = { ...s, receipts: [...s.receipts, { ...template, id: "rcpt-22", requirementId: "code-review", valid: true }] };
    const accepted = progressSince(markOf(s), next);
    expect(accepted.events).toEqual([
      expect.objectContaining({ kind: "receipt_accepted", stage: "review", requirements: ["code-review"], stageComplete: true, detail: "review: accepted code-review (stage complete)" }),
    ]);
    // Seen once: the next look from its mark reports nothing more.
    expect(progressSince(accepted.mark, next).events).toEqual([]);

    const invalidated = { ...next, receipts: next.receipts.map((r) => (r.id === "rcpt-22" ? { ...r, valid: false } : r)) };
    const second = progressSince(accepted.mark, invalidated);
    expect(second.events).toEqual([expect.objectContaining({ kind: "receipts_invalidated", count: 1, stages: ["review"] })]);
    // An older receipt invalidated after a newer one: its own stage, by id, not by order.
    const older = invalidated.receipts.find((r) => r.valid && r.stageId === "fix")!;
    const third = { ...invalidated, receipts: invalidated.receipts.map((r) => (r.id === older.id ? { ...r, valid: false } : r)) };
    expect(progressSince(second.mark, third).events).toEqual([expect.objectContaining({ kind: "receipts_invalidated", count: 1, stages: ["fix"] })]);
  });

  it("episode_started and episode_ended: the open episode, its trigger, and its one-line outcome", async () => {
    const s = await running();
    const opened = { ...s, mode: "recovery" as const, recoveryEpisodeId: "ep-a", recoveryTrigger: { code: "stalled", message: "no progress\nsince the last receipt" } };
    const started = progressSince(markOf(s), opened);
    expect(started.events).toEqual([expect.objectContaining({ kind: "episode_started", episodeId: "ep-a", detail: "supervisor episode ep-a started: stalled: no progress since the last receipt" })]);
    expect(started.mark.ep).toBe("ep-a");

    const record = {
      episodeId: "ep-a",
      turn: 1,
      runId: s.runId,
      at: "2026-10-27T10:00:00.000Z",
      input: { trigger: { code: "stalled", message: "no progress" } },
      toolCalls: [],
      proposal: { action: { type: "reenter" }, reason: "the RED test ran on a stale build;\nretry Fix" },
      admission: { rejections: [], outcome: "admitted" },
      providerCalls: 4,
    };
    // Its record appears while it is still open: no second start.
    const deciding = { ...opened, supervisorEpisodes: [record] } as unknown as DurableRunState;
    const mid = progressSince(started.mark, deciding);
    expect(mid.events).toEqual([]);
    const closed = { ...deciding, mode: "normal" as const };
    expect(progressSince(mid.mark, closed).events).toEqual([
      expect.objectContaining({ kind: "episode_ended", episodeId: "ep-a", detail: "supervisor episode ep-a ended: reenter: the RED test ran on a stale build; retry Fix" }),
    ]);

    // An episode that opened and closed between two looks reports both.
    const later = {
      ...closed,
      supervisorEpisodes: [record, { ...record, episodeId: "ep-b", at: "2026-10-27T11:00:00.000Z", proposal: undefined, error: "provider refused", admission: { rejections: [], outcome: "error" } }],
    } as unknown as DurableRunState;
    expect(progressSince(markOf(closed), later).events).toEqual([
      expect.objectContaining({ kind: "episode_started", episodeId: "ep-b", detail: "supervisor episode ep-b started: stalled: no progress" }),
      expect.objectContaining({ kind: "episode_ended", episodeId: "ep-b", detail: "supervisor episode ep-b ended: error: provider refused" }),
    ]);
  });

  it("quota_pause: a quota or usage-limit remedy, with resetAt; other remedies are not events", async () => {
    const s = await running();
    const until = "2026-10-27T14:05:30.000Z";
    const held = {
      ...s,
      quotaHold: { until },
      remedies: [
        { at: "2026-10-27T13:00:00.000Z", condition: "executor graphloom.agent/run failed (declared retryable)", remedy: "ran it again" },
        { at: "2026-10-27T13:00:01.000Z", condition: "harness quota (executor graphloom.coding-agent/run)", remedy: "waiting 3600s until the harness quota resets at 2026-10-27T14:05:00.000Z, then running the job again, without a model call", waitedMs: 3_600_000 },
      ],
    };
    const { events, mark } = progressSince(markOf(s), held);
    expect(events).toEqual([expect.objectContaining({ kind: "quota_pause", resetAt: until, condition: "harness quota (executor graphloom.coding-agent/run)" })]);
    expect(progressSince(mark, held).events).toEqual([]);
    expect(progressSummary(held).waiting).toEqual({ kind: "quota", until });
    // An ordinary retry backoff is not a quota wait; one after a quota remedy is.
    const later = new Date(Date.now() + 60_000).toISOString();
    const backoff = { ...s, executorRetryAt: { "acme/x": later }, remedies: [held.remedies[0]!] };
    expect(progressSummary(backoff).waiting).toEqual({ kind: "retry", until: later });
    expect(progressSummary({ ...backoff, remedies: held.remedies }).waiting).toEqual({ kind: "quota", until: later });
    // Without a hold, the reset time in the remedy's own text.
    const { quotaHold: _h, ...free } = held;
    expect(progressSince(markOf(s), free as DurableRunState).events[0]).toMatchObject({ resetAt: "2026-10-27T14:05:00.000Z" });
  });

  it("budget_threshold: a budget reaching 80% of the run's budget, again only after a raise took it below", async () => {
    const s = await running();
    const spent = { ...s, budgets: { ...s.budgets, jobs: 100_000 } };
    const first = progressSince(markOf(s), spent);
    expect(first.events).toEqual([expect.objectContaining({ kind: "budget_threshold", budget: "jobs", percent: 90, used: 900_000, granted: 1_000_000 })]);
    expect(progressSince(first.mark, { ...spent, budgets: { ...spent.budgets, jobs: 50_000 } }).events).toEqual([]);
    const raised = progressSince(first.mark, s);
    expect(raised.events).toEqual([]);
    expect(raised.mark.hot).toEqual([]);
    expect(kinds(progressSince(raised.mark, spent).events)).toEqual(["budget_threshold"]);
  });

  it("run_stopped with its reason and class, once; run_resumed when it runs again", async () => {
    const s = await running();
    const stopped = { ...s, status: "stopped" as const, stopReason: "operator stop", stateRevision: s.stateRevision + 1 };
    const stop = progressSince(markOf(s), stopped);
    expect(stop.events).toEqual([expect.objectContaining({ kind: "run_stopped", status: "stopped", stopReason: "operator stop", retryable: false, detail: "run stopped: operator stop (final)" })]);
    expect(progressSince(stop.mark, stopped).events).toEqual([]);
    expect(progressSummary(stopped)).toMatchObject({ status: "stopped", stopReason: "operator stop", stopRetryable: false, stages: 2, stagesComplete: 2 });
    const resumed = { ...s, generation: s.generation + 1, stateRevision: s.stateRevision + 2 };
    expect(progressSince(stop.mark, resumed).events).toEqual([expect.objectContaining({ kind: "run_resumed" })]);
    // A second stop of the same reason is a new stop.
    const again = { ...stopped, stateRevision: s.stateRevision + 3 };
    expect(kinds(progressSince(progressSince(stop.mark, resumed).mark, again).events)).toEqual(["run_stopped"]);
  });

  it("encodes the mark as an opaque cursor, refusing a malformed one or another run's", async () => {
    const s = await running();
    const mark = markOf(s);
    const cursor = encodeCursor(mark);
    expect(cursor).toMatch(/^p1\.[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(mark);
    expect(() => decodeCursor("p2.abc")).toThrow(/not a graphloom wait cursor \(unknown format\)/);
    expect(() => decodeCursor("p1.!!!")).toThrow(/not a graphloom wait cursor/);
    expect(() => decodeCursor(`p1.${Buffer.from(JSON.stringify({ v: 1, run: "x" })).toString("base64url")}`)).toThrow(/malformed/);
    expect(() => progressSince({ ...mark, run: "someone-else" }, s)).toThrow(/the cursor is for run someone-else/);
  });
});

// ---------------------------------------------------------------- the CLI, end to end

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function eventually<T>(read: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

async function runningStateDir(env: CliEnv): Promise<string> {
  return eventually(async () => {
    for (const name of await readdir(env.stateRoot).catch(() => [] as string[])) {
      const candidate = path.join(env.stateRoot, name);
      if ((await loadRunState(candidate).catch(() => undefined))?.status === "running") return candidate;
    }
    return undefined;
  });
}

/** A bash step that blocks until `file` exists. */
const gate = (file: string) => ({ bash: `while [ ! -f ${JSON.stringify(file)} ]; do sleep 0.1; done` });

describe("graphloom wait --until progress on a scripted hello run", () => {
  it("reports each delta once across --since, times out with the cursor unchanged, and ends with the stop", async () => {
    const env = await makeCliEnv(cleanups);
    const go = path.join(env.dir, "go");
    await env.fakeClaude({
      byPrompt: [
        { match: "independent read-only reviewer", steps: [{ think: 300 }, { bash: "cat GREETING.txt" }, { structured: { verdict: "approved", summary: "Reviewed: approved." } }] },
        { match: "GREETING.txt", steps: [gate(go), { bash: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" }, { structured: { summary: "Wrote GREETING.txt." } }] },
      ],
    });
    const run = env.graphloom("run", "task.yaml");
    const stateDir = await runningStateDir(env);
    const wait = async (...args: string[]) => {
      const r = await env.graphloom("wait", stateDir, "--until", "progress", "--json", ...args);
      return { code: r.code, stderr: r.stderr, out: JSON.parse(r.stdout) as ProgressResult };
    };

    // Blocked in Write: nothing to report before the timeout; the cursor is what it was.
    const first = await wait("--timeout", "2s");
    expect(first.code).toBe(2);
    expect(first.out).toMatchObject({ outcome: "timeout", events: [], summary: { status: "running", stage: "write", stages: 2, stagesComplete: 0 } });
    const again = await wait("--timeout", "1s", "--since", first.out.cursor);
    expect(again.code).toBe(2);
    expect(again.out.cursor).toBe(first.out.cursor);

    await writeFile(go, "");
    const events: ProgressEvent[] = [];
    let cursor = first.out.cursor;
    let last: ProgressResult | undefined;
    for (let i = 0; i < 20; i++) {
      const next = await wait("--since", cursor, "--timeout", "60s");
      expect(next.code).toBe(0);
      events.push(...next.out.events);
      cursor = next.out.cursor;
      last = next.out;
      if (next.out.summary.status !== "running") break;
    }
    expect(JSON.parse((await run).stdout).status).toBe("succeeded");
    expect(last!.outcome).toBe("stopped");
    expect(last!.summary).toMatchObject({ status: "succeeded", stagesComplete: 2, stages: 2 });

    const accepted = events.filter((e) => e.kind === "receipt_accepted");
    expect(accepted.map((e) => [e.stage, e.stageComplete])).toEqual([["write", true], ["review", true]]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "stage_entered", stage: "review" }));
    expect(events.filter((e) => e.kind === "run_stopped")).toEqual([expect.objectContaining({ status: "succeeded" })]);
    // Every delta once: no event repeats across the waits.
    expect(new Set(events.map((e) => JSON.stringify(e))).size).toBe(events.length);

    // After the stop: its own cursor returns at once with nothing new; no cursor reports the stop.
    const after = await wait("--since", cursor);
    expect(after.code).toBe(0);
    expect(after.out).toMatchObject({ outcome: "stopped", events: [] });
    const fresh = await wait();
    expect(fresh.out.events).toEqual([expect.objectContaining({ kind: "run_stopped", status: "succeeded" })]);
    // The text form names the events and the run.
    const text = await env.graphloom("wait", stateDir, "--until", "progress");
    expect(text.stdout).toMatch(/^run_stopped\s+run succeeded/m);

    // Refusals: another run's cursor, --since without --until progress, a bad --until.
    const foreign = encodeCursor({ ...decodeCursor(cursor), run: "not-this-run" });
    const refused = await env.graphloom("wait", stateDir, "--until", "progress", "--since", foreign);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the cursor is for run not-this-run");
    expect((await env.graphloom("wait", stateDir, "--since", cursor)).stderr).toContain("--since needs --until progress");
    expect((await env.graphloom("wait", stateDir, "--until", "soon")).stderr).toContain('--until must be "stop" or "progress"');
    // An empty cursor is none (a watcher's first wait).
    expect((await env.graphloom("wait", stateDir, "--until", "progress", "--since", "", "--json")).code).toBe(0);
    expect(existsSync(stateDir)).toBe(true);
  }, 180_000);

  it("--until stop keeps its behaviour, and the run prints its id and state directory when it starts", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({ byPrompt: [{ match: "GREETING.txt", steps: [{ hang: true }] }] });
    const run = env.graphloom("run", "task.yaml");
    const stateDir = await runningStateDir(env);
    const timedOut = await env.graphloom("wait", stateDir, "--until", "stop", "--timeout", "1s");
    expect(timedOut.code).toBe(2);
    expect(timedOut.stdout).toBe("");
    // A progress wait returns as soon as the stop lands.
    const waiting = env.graphloom("wait", stateDir, "--until", "progress", "--json", "--timeout", "60s");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await env.graphloom("stop", stateDir);
    const done = await run;
    const waited = await waiting;
    expect(waited.code).toBe(0);
    expect((JSON.parse(waited.stdout) as ProgressResult).events).toContainEqual(expect.objectContaining({ kind: "run_stopped", stopReason: "operator stop", retryable: false }));
    expect(done.stderr).toContain(`graphloom: run ${path.basename(stateDir)} started; state ${stateDir}`);
  }, 120_000);
});
