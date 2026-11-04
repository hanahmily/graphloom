// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom watch` (docs/design-agent-skills.md §3): each move, the 60 second
 * batch, the heartbeat, each attention rule, the two modes, the timeout,
 * `--notify`, and the cursor and snapshot persistence, on the recorded issue-fix
 * state with a fake clock; then the built CLI for the exit codes and output.
 */
import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadRunState, saveRunState, type DurableRunState } from "@graphloom/controller";
import { watchRun, type WatchOptions, type WatchReport, type WatchResult } from "../src/watch.js";
import { makeCliEnv, type CliEnv } from "./cli-env.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/stats/395ec998-6e4");
const T0 = Date.parse("2026-10-27T12:00:00.000Z");
const MIN = 60_000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

interface Bed {
  stateDir: string;
  watchDir: string;
  clock: { t: number };
  /** `fn` may return a loosely typed change (a hand-built episode record); it is saved as the state. */
  mutate(fn: (s: DurableRunState) => object): Promise<void>;
  watch(options?: Partial<WatchOptions>, script?: (sinceStart: number) => Promise<void> | void): Promise<WatchResult>;
}

/** The recorded issue-fix run as a live one: running in normal mode, a live owner claim, a fake clock that only `sleep` advances. */
async function bed(): Promise<Bed> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-watch-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  await cp(fixture, stateDir, { recursive: true });
  const s = await loadRunState(stateDir);
  const { recoveryEpisodeId: _e, recoveryTrigger: _t, quotaHold: _q, ...rest } = s;
  await saveRunState({ ...rest, stateDir, status: "running", mode: "normal", supervisorEpisodes: [], remedies: [] } as DurableRunState);
  await claim(stateDir);
  const clock = { t: T0 };
  const watchDir = path.join(dir, "watch");
  return {
    stateDir,
    watchDir,
    clock,
    mutate: async (fn) => saveRunState(fn(await loadRunState(stateDir)) as DurableRunState),
    watch: (options = {}, script) => {
      const base = clock.t;
      return watchRun(
        stateDir,
        { dir: watchDir, until: "report", pollMs: 10_000, ...options },
        {
          now: () => clock.t,
          sleep: async (ms) => {
            clock.t += ms;
            await script?.(clock.t - base);
          },
        },
      );
    },
  };
}

const claim = (stateDir: string) =>
  writeFile(path.join(stateDir, "run.owner.json"), JSON.stringify({ ownerId: "t", controllerPid: process.pid, claimedAt: new Date().toISOString(), expiresAt: Date.now() + 600_000 }));

const only = (r: WatchResult): WatchReport => {
  expect(r.reports).toHaveLength(1);
  return r.reports[0]!;
};
const body = (r: WatchReport): string[] => r.message.split("\n");

describe("moves", () => {
  it("reports a stage entered, with the header line and the relay instruction, after the 60 second window", async () => {
    const b = await bed();
    const r = await b.watch({}, async (at) => {
      if (at === 10_000) await b.mutate((s) => ({ ...s, current: { stageId: "review", attempt: 5 } }));
    });
    const report = only(r);
    expect(r.outcome).toBe("report");
    expect(report.kind).toBe("move");
    expect(body(report)[0]).toBe(`[graphloom watch] move · run ${r.runId} · running · review#5`);
    expect(body(report)).toContain("- entered stage review, attempt 5");
    expect(body(report).at(-1)).toBe("Relay this to the user in one or two lines. Make no tool calls.");
    expect(Buffer.byteLength(report.message)).toBeLessThan(1_024);
    // Seen at 10s, reported when its window closed 60s later.
    expect(Date.parse(report.at) - T0).toBe(70_000);
  });

  it("batches moves within 60 seconds into one report: a stage accepted, an episode, a quota pause and its end, a resume", async () => {
    const b = await bed();
    const until = "2026-10-27T14:05:30.000Z";
    const template = (await loadRunState(b.stateDir)).receipts.find((x) => x.stageId === "review")!;
    const r = await b.watch({}, async (at) => {
      if (at === 10_000) {
        await b.mutate((s) => ({
          ...s,
          receipts: [...s.receipts, { ...template, id: "rcpt-99", requirementId: "code-review", valid: true }],
          mode: "recovery",
          recoveryEpisodeId: "ep-a",
          recoveryTrigger: { code: "stalled", message: "no progress" },
        }));
      }
      if (at === 30_000) {
        await b.mutate((s) => ({
          ...s,
          mode: "normal",
          supervisorEpisodes: [
            { episodeId: "ep-a", turn: 1, runId: s.runId, at: "2026-10-27T12:00:30.000Z", input: { trigger: { code: "stalled", message: "no progress" } }, toolCalls: [], proposal: { action: { type: "reenter" }, reason: "retry Fix" }, admission: { rejections: [], outcome: "admitted" }, providerCalls: 1 },
          ] as unknown as DurableRunState["supervisorEpisodes"],
          quotaHold: { until },
          remedies: [{ at: "2026-10-27T12:00:31.000Z", condition: "harness quota (executor x)", remedy: `waiting until ${until}` }],
        }));
      }
    });
    const lines = body(only(r));
    expect(lines.filter((l) => l.startsWith("- "))).toEqual([
      "- stage review accepted",
      "- supervisor episode ep-a started: stalled: no progress",
      "- supervisor episode ep-a ended: reenter: retry Fix",
      `- quota pause started, resets ${until}`,
    ]);
  });

  it("reports a quota pause ending and a resume as moves", async () => {
    const b = await bed();
    await b.mutate((s) => ({ ...s, quotaHold: { until: "2026-10-27T14:00:00.000Z" } }));
    // The pause is seen first, its end later; a stopped run running again is a resume.
    expect((await b.watch({ timeoutMs: 20_000 })).outcome).toBe("timeout");
    const r = await b.watch({}, async (at) => {
      if (at === 10_000) await b.mutate(({ quotaHold: _h, ...s }) => s as DurableRunState);
    });
    expect(body(only(r)).filter((l) => l.startsWith("- "))).toEqual(["- quota pause ended"]);

    const c = await bed();
    await c.mutate((s) => ({ ...s, status: "stopped", stopReason: "operator stop", stateRevision: s.stateRevision + 1 }));
    expect(only(await c.watch()).kind).toBe("attention");
    await c.mutate((s) => ({ ...s, status: "running", generation: s.generation + 1, stateRevision: s.stateRevision + 2 }));
    const resumed = await c.watch();
    expect(body(only(resumed)).filter((l) => l.startsWith("- "))).toEqual([expect.stringContaining("the run is running again")]);
  });

  it("does not report individual receipts, jobs or a budget moving", async () => {
    const b = await bed();
    const template = (await loadRunState(b.stateDir)).receipts.find((x) => x.stageId === "fix")!;
    const r = await b.watch({ timeoutMs: 2 * MIN, heartbeatMs: 60 * MIN }, async (at) => {
      // The stage does not complete (its own receipt goes invalid), so the new receipt is not a move.
      if (at === 10_000) {
        await b.mutate((s) => ({
          ...s,
          receipts: [...s.receipts.map((x) => (x.stageId === "fix" ? { ...x, valid: false } : x)), { ...template, id: "rcpt-98", requirementId: "extra", valid: true }],
          budgets: { ...s.budgets, jobs: s.budgets.jobs - 1 },
        }));
      }
    });
    expect(r.outcome).toBe("timeout");
    expect(r.reports).toEqual([]);
  });
});

describe("heartbeat", () => {
  it("is reported after 15 minutes of quiet with status, stage, elapsed time, invocations and evidence age", async () => {
    const b = await bed();
    const r = await b.watch({ pollMs: MIN });
    const report = only(r);
    expect(report.kind).toBe("heartbeat");
    expect(Date.parse(report.at) - T0).toBe(15 * MIN);
    const text = body(report);
    expect(text[0]).toMatch(/^\[graphloom watch\] heartbeat · run \S+ · running · \S+#\d+$/);
    expect(text.join("\n")).toMatch(/elapsed .*stages complete/);
    expect(text.join("\n")).toMatch(/agentInvocations \d+\/\d+/);
    expect(text.join("\n")).toMatch(/last evidence 15m 00s ago/);
    expect(text.at(-1)).toBe("Relay this to the user in one or two lines. Make no tool calls.");
  });

  it("is measured from the last report of any kind, and names a budget that moved", async () => {
    const b = await bed();
    const r = await b.watch({ pollMs: MIN, heartbeatMs: 10 * MIN }, async (at) => {
      if (at === 3 * MIN) await b.mutate((s) => ({ ...s, current: { stageId: "review", attempt: 9 } }));
    });
    // The move at 3m is reported at 4m; the quiet is counted from there.
    expect(r.reports.map((x) => x.kind)).toEqual(["move"]);
    await b.mutate((s) => ({ ...s, budgets: { ...s.budgets, jobs: s.budgets.jobs - 1_000 } }));
    const next = await b.watch({ pollMs: MIN, heartbeatMs: 10 * MIN });
    expect(Date.parse(only(next).at) - T0).toBe(14 * MIN);
    expect(only(next).message).toMatch(/budgets moved: jobs/);
  });
});

describe("attention", () => {
  it("a stop: status, reason, final or retryable, the blocker and its question quoted verbatim, then the ask-the-user line", async () => {
    const b = await bed();
    const blocker = 'Which branch should this target?\nReply with "main" or "release".';
    await b.mutate((s) => ({ ...s, status: "stopped", stopReason: "needs a maintainer decision", blocker, stateRevision: s.stateRevision + 1 }));
    const r = await b.watch();
    expect(r.outcome).toBe("stopped");
    const report = only(r);
    expect(report.kind).toBe("attention");
    expect(report.status).toBe("stopped");
    const text = body(report);
    expect(text[0]).toMatch(/^\[graphloom watch\] attention · run \S+ · stopped · /);
    expect(text).toContain("stopped: stopped (needs a maintainer decision) · retryable");
    expect(report.message).toContain(`blocker: "${blocker}"`);
    expect(text.at(-1)).toBe("Report this to the user and ask what to do next. Do not resume, fix, or answer the run's questions.");
    expect(Buffer.byteLength(report.message)).toBeLessThan(1_024);
    // Final when the graph says so.
    const c = await bed();
    await c.mutate((s) => ({ ...s, status: "stopped", stopReason: "nothing to do", stopClass: { by: "graph", retryable: false, reason: "nothing to do" }, stateRevision: s.stateRevision + 1 }));
    expect(only(await c.watch()).message).toContain("· final");
  });

  it("a long blocker is cut so the message stays under 1 KB", async () => {
    const b = await bed();
    await b.mutate((s) => ({ ...s, status: "stopped", stopReason: "x", blocker: "q".repeat(5_000), stateRevision: s.stateRevision + 1 }));
    const report = only(await b.watch());
    expect(Buffer.byteLength(report.message)).toBeLessThan(1_024);
    expect(report.message).toContain("…");
  });

  it("waiting for a human: a reconciliation, once", async () => {
    const b = await bed();
    await b.mutate((s) => ({ ...s, reconciliationRequired: { operationId: "op-1", stageId: "fix", reason: "a usage limit cut off a job with possible effects", since: "2026-10-27T11:00:00.000Z" } }));
    const report = only(await b.watch());
    expect(report.kind).toBe("attention");
    expect(report.message).toContain("waiting for a human: reconcile stage fix (a usage limit cut off a job with possible effects)");
    expect((await b.watch({ timeoutMs: MIN, heartbeatMs: 60 * MIN })).reports).toEqual([]);
  });

  it("a stall: no new evidence for 45 minutes while running, not in a quota wait; evidence resets it", async () => {
    const b = await bed();
    const r = await b.watch({ pollMs: MIN, heartbeatMs: 24 * 60 * MIN });
    const report = only(r);
    expect(report.kind).toBe("attention");
    expect(Date.parse(report.at) - T0).toBe(45 * MIN);
    expect(report.message).toContain("stalled: no new evidence for 45m 00s");

    const resets = await bed();
    const evidence = (await loadRunState(resets.stateDir)).evidence[0]!;
    const quiet = await resets.watch({ pollMs: MIN, heartbeatMs: 24 * 60 * MIN, timeoutMs: 100 * MIN }, async (at) => {
      if (at === 40 * MIN) await resets.mutate((s) => ({ ...s, evidence: [...s.evidence, { ...evidence, ref: "ev-new" as typeof evidence.ref }] }));
    });
    expect(Date.parse(only(quiet).at) - T0).toBe(85 * MIN);

    const quota = await bed();
    await quota.mutate((s) => ({ ...s, quotaHold: { until: "2026-10-27T20:00:00.000Z" } }));
    expect((await quota.watch({ pollMs: MIN, heartbeatMs: 24 * 60 * MIN, timeoutMs: 60 * MIN })).reports.filter((x) => x.kind === "attention")).toEqual([]);
  });

  it("a budget over 80%: which budget, the numbers, which stage spends it; not again until it falls below", async () => {
    const b = await bed();
    await b.mutate((s) => ({ ...s, budgets: { ...s.budgets, jobs: 100_000 } }));
    const report = only(await b.watch());
    expect(report.kind).toBe("attention");
    expect(report.message).toMatch(/budget jobs at 90% \(900000 of 1000000\), spent in stage \S+/);
    expect((await b.watch({ timeoutMs: 2 * MIN, heartbeatMs: 60 * MIN })).reports).toEqual([]);
    await b.mutate((s) => ({ ...s, budgets: { ...s.budgets, jobs: 900_000 } }));
    await b.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN });
    await b.mutate((s) => ({ ...s, budgets: { ...s.budgets, jobs: 50_000 } }));
    expect(only(await b.watch({ timeoutMs: 2 * MIN, heartbeatMs: 60 * MIN })).message).toContain("budget jobs at 95%");
  });

  it("a repeated identical failure: the same stage invalidated again with the same requirements", async () => {
    const b = await bed();
    const invalidate = (id: string) => (s: DurableRunState): DurableRunState => ({
      ...s,
      receipts: [...s.receipts, { ...s.receipts.find((x) => x.stageId === "review")!, id, requirementId: "code-review", valid: false }],
    });
    // The stage is incomplete (its receipts are invalid), as after a failed review.
    await b.mutate((s) => ({ ...s, receipts: s.receipts.map((x) => (x.stageId === "review" ? { ...x, valid: false } : x)) }));
    await b.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN });
    await b.mutate(invalidate("rcpt-91"));
    expect((await b.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN })).reports).toEqual([]);
    await b.mutate(invalidate("rcpt-92"));
    const report = only(await b.watch({ timeoutMs: 2 * MIN, heartbeatMs: 60 * MIN }));
    expect(report.kind).toBe("attention");
    expect(report.message).toContain("repeated failure: stage review invalidated 2 times with the same requirements (code-review)");
    // A different failure is not a repeat.
    const c = await bed();
    await c.mutate((s) => ({ ...s, receipts: s.receipts.map((x) => (x.stageId === "review" ? { ...x, valid: false } : x)) }));
    await c.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN });
    await c.mutate(invalidate("rcpt-91"));
    await c.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN });
    await c.mutate((s) => ({ ...s, receipts: [...s.receipts, { ...s.receipts.find((x) => x.stageId === "review")!, id: "rcpt-93", requirementId: "other", valid: false }] }));
    expect((await c.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN })).reports).toEqual([]);
  });

  it("a repeated identical failure: consecutive supervisor episodes with the same trigger code and message", async () => {
    const b = await bed();
    const record = (id: string, at: string) => ({ episodeId: id, turn: 1, runId: "r", at, input: { trigger: { code: "stalled", message: "no progress" } }, toolCalls: [], proposal: { action: { type: "reenter" }, reason: "retry" }, admission: { rejections: [], outcome: "admitted" }, providerCalls: 1 });
    await b.mutate((s) => ({ ...s, supervisorEpisodes: [record("ep-1", "2026-10-27T10:00:00.000Z")] as unknown as DurableRunState["supervisorEpisodes"] }));
    expect((await b.watch({ timeoutMs: 20_000, heartbeatMs: 60 * MIN })).reports.filter((x) => x.kind === "attention")).toEqual([]);
    await b.mutate((s) => ({ ...s, supervisorEpisodes: [record("ep-1", "2026-10-27T10:00:00.000Z"), record("ep-2", "2026-10-27T11:00:00.000Z")] as unknown as DurableRunState["supervisorEpisodes"] }));
    const r = await b.watch({ timeoutMs: 2 * MIN, heartbeatMs: 60 * MIN });
    const attention = r.reports.find((x) => x.kind === "attention")!;
    expect(attention.message).toContain("repeated failure: supervisor episodes ep-1 and ep-2 had the same trigger (stalled: no progress)");
    // Moves reported in the same look come first.
    expect(r.reports.map((x) => x.kind)).toEqual(["move", "attention"]);
  });

  it("the controller died: reported as attention, outcome orphaned, once", async () => {
    const b = await bed();
    await rm(path.join(b.stateDir, "run.owner.json"));
    const r = await b.watch();
    expect(r.outcome).toBe("orphaned");
    expect(only(r).kind).toBe("attention");
    expect(only(r).message).toContain("controller died: the run is recorded as running but no controller owns it");
    const again = await b.watch();
    expect(again.outcome).toBe("orphaned");
    expect(again.reports).toEqual([]);
  });
});

describe("modes, timeout and persistence", () => {
  it("--until report returns at the first report", async () => {
    const b = await bed();
    const r = await b.watch({ heartbeatMs: 2 * MIN, pollMs: 30_000 });
    expect(only(r).kind).toBe("heartbeat");
    expect(b.clock.t - T0).toBe(2 * MIN);
  });

  it("--until stop keeps reporting and ends after the stop", async () => {
    const b = await bed();
    const seen: string[] = [];
    const r = await b.watch({ until: "stop", heartbeatMs: 10 * MIN, onReport: (x) => void seen.push(x.kind) }, async (at) => {
      if (at === 10_000) await b.mutate((s) => ({ ...s, current: { stageId: "review", attempt: 7 } }));
      if (at === 5 * MIN) await b.mutate((s) => ({ ...s, status: "stopped", stopReason: "operator stop", stateRevision: s.stateRevision + 1 }));
    });
    expect(r.outcome).toBe("stopped");
    expect(seen).toEqual(["move", "attention"]);
    expect(r.reports.map((x) => x.kind)).toEqual(["move", "attention"]);
    expect(b.clock.t - T0).toBe(5 * MIN);
  });

  it("--timeout returns with nothing to report", async () => {
    const b = await bed();
    const r = await b.watch({ timeoutMs: 3 * MIN });
    expect(r.outcome).toBe("timeout");
    expect(r.reports).toEqual([]);
  });

  it("keeps its cursor and snapshot, so nothing is reported twice and a pending move survives an invocation", async () => {
    const b = await bed();
    // A move seen at 10s, the invocation times out at 30s with its window still open.
    const first = await b.watch({ timeoutMs: 30_000 }, async (at) => {
      if (at === 10_000) await b.mutate((s) => ({ ...s, current: { stageId: "review", attempt: 3 } }));
    });
    expect(first.outcome).toBe("timeout");
    expect(existsSync(path.join(b.watchDir, "cursor"))).toBe(true);
    expect(JSON.parse(await readFile(path.join(b.watchDir, "snapshot.json"), "utf8")).pending.lines).toEqual(["entered stage review, attempt 3"]);
    const second = await b.watch();
    expect(body(only(second))).toContain("- entered stage review, attempt 3");
    // The same move is not reported again, nor a stop once reported.
    expect((await b.watch({ timeoutMs: 2 * MIN, heartbeatMs: 60 * MIN })).reports).toEqual([]);
    await b.mutate((s) => ({ ...s, status: "stopped", stopReason: "x", stateRevision: s.stateRevision + 1 }));
    expect(only(await b.watch()).kind).toBe("attention");
    const after = await b.watch();
    expect(after.outcome).toBe("stopped");
    expect(after.reports).toEqual([]);
  });

  it("refuses a watch directory that belongs to another run", async () => {
    const b = await bed();
    await b.watch({ timeoutMs: 1_000 });
    await writeFile(path.join(b.watchDir, "snapshot.json"), JSON.stringify({ ...JSON.parse(await readFile(path.join(b.watchDir, "snapshot.json"), "utf8")), run: "other" }));
    await expect(b.watch()).rejects.toThrow(/holds the watch of run other/);
  });
});

describe("--notify", () => {
  it("runs the command for each report with the message on stdin and the kind, run and status in its environment", async () => {
    const b = await bed();
    const out = path.join(b.watchDir, "..", "notified");
    const r = await b.watch(
      { until: "stop", notify: `cat >> ${JSON.stringify(out)}.msg; printf '%s %s %s\\n' "$GRAPHLOOM_WATCH_KIND" "$GRAPHLOOM_RUN_ID" "$GRAPHLOOM_STATUS" >> ${JSON.stringify(out)}.env` },
      async (at) => {
        if (at === 10_000) await b.mutate((s) => ({ ...s, current: { stageId: "review", attempt: 7 } }));
        if (at === 2 * MIN) await b.mutate((s) => ({ ...s, status: "stopped", stopReason: "operator stop", stateRevision: s.stateRevision + 1 }));
      },
    );
    expect(await readFile(`${out}.env`, "utf8")).toBe(`move ${r.runId} running\nattention ${r.runId} stopped\n`);
    expect(await readFile(`${out}.msg`, "utf8")).toBe(`${r.reports[0]!.message}\n${r.reports[1]!.message}\n`);
  });

  it("logs a failing command to watch.log and keeps watching", async () => {
    const b = await bed();
    const r = await b.watch({ until: "stop", notify: "echo boom >&2; exit 7" }, async (at) => {
      if (at === 10_000) await b.mutate((s) => ({ ...s, current: { stageId: "review", attempt: 7 } }));
      if (at === 2 * MIN) await b.mutate((s) => ({ ...s, status: "stopped", stopReason: "operator stop", stateRevision: s.stateRevision + 1 }));
    });
    expect(r.outcome).toBe("stopped");
    expect(r.reports.map((x) => x.kind)).toEqual(["move", "attention"]);
    const log = (await readFile(path.join(b.watchDir, "watch.log"), "utf8")).trim().split("\n");
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/notify \(move\) exited 7: boom$/);
    expect(log[1]).toMatch(/notify \(attention\) exited 7: boom$/);
  });
});

describe("graphloom watch, the CLI", () => {
  async function cliBed(): Promise<{ env: CliEnv; stateDir: string }> {
    const env = await makeCliEnv(cleanups);
    const stateDir = path.join(env.dir, "state");
    await cp(fixture, stateDir, { recursive: true });
    const s = await loadRunState(stateDir);
    const { recoveryEpisodeId: _e, recoveryTrigger: _t, quotaHold: _q, ...rest } = s;
    await saveRunState({ ...rest, stateDir, status: "running", mode: "normal", supervisorEpisodes: [], remedies: [] } as DurableRunState);
    await claim(stateDir);
    return { env, stateDir };
  }

  it("exit 2 with a one-line message on timeout; --json prints the outcome", async () => {
    const { env, stateDir } = await cliBed();
    const text = await env.graphloom("watch", stateDir, "--timeout", "1s");
    expect(text.code).toBe(2);
    expect(text.stdout.trim()).toBe(`run ${(await loadRunState(stateDir)).runId} still running, nothing to report`);
    const json = await env.graphloom("watch", stateDir, "--timeout", "1s", "--json");
    expect(json.code).toBe(2);
    expect(JSON.parse(json.stdout)).toMatchObject({ outcome: "timeout", reports: [], summary: { status: "running" } });
    expect(existsSync(path.join(env.dir, ".graphloom-watch", "cursor"))).toBe(true);
  }, 60_000);

  it("exit 0 with the report: a heartbeat in the --json shape, and --notify with the message on stdin", async () => {
    const { env, stateDir } = await cliBed();
    const stub = path.join(env.dir, "notify.sh");
    await writeFile(stub, `#!/bin/sh\ncat > "${env.dir}/notified.msg"\nprintf '%s|%s|%s' "$GRAPHLOOM_WATCH_KIND" "$GRAPHLOOM_RUN_ID" "$GRAPHLOOM_STATUS" > "${env.dir}/notified.env"\n`);
    await chmod(stub, 0o755);
    const r = await env.graphloom("watch", stateDir, "--heartbeat", "1s", "--timeout", "30s", "--json", "--dir", "w", "--notify", stub);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { outcome: string; reports: WatchReport[]; summary: { status: string } };
    expect(out.outcome).toBe("report");
    expect(out.summary.status).toBe("running");
    expect(out.reports).toEqual([expect.objectContaining({ kind: "heartbeat", status: "running", runId: expect.any(String), message: expect.stringMatching(/^\[graphloom watch\] heartbeat · run /) })]);
    expect(await readFile(`${env.dir}/notified.msg`, "utf8")).toBe(`${out.reports[0]!.message}\n`);
    expect(await readFile(`${env.dir}/notified.env`, "utf8")).toBe(`heartbeat|${out.reports[0]!.runId}|running`);
    expect(existsSync(path.join(env.dir, "w", "snapshot.json"))).toBe(true);
    // Text form prints the message itself.
    const text = await env.graphloom("watch", stateDir, "--heartbeat", "1s", "--timeout", "30s", "--dir", "w2");
    expect(text.stdout).toMatch(/^\[graphloom watch\] heartbeat · run \S+ · running · \S+#\d+\n/);
  }, 60_000);

  it("--until stop prints each report and exits 0 once the run stopped; a dead controller is exit 3", async () => {
    const { env, stateDir } = await cliBed();
    await saveRunState({ ...(await loadRunState(stateDir)), status: "stopped", stopReason: "operator stop", blocker: "Pick one?" } as DurableRunState);
    const stopped = await env.graphloom("watch", stateDir, "--until", "stop", "--dir", "s");
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toMatch(/^\[graphloom watch\] attention · run \S+ · stopped · /);
    expect(stopped.stdout).toContain('blocker: "Pick one?"');

    const dead = await cliBed();
    await rm(path.join(dead.stateDir, "run.owner.json"));
    const orphan = await dead.env.graphloom("watch", dead.stateDir);
    expect(orphan.code).toBe(3);
    expect(orphan.stdout).toContain("controller died");
  }, 60_000);

  it("refuses a bad --until or an empty --notify", async () => {
    const { env, stateDir } = await cliBed();
    expect((await env.graphloom("watch", stateDir, "--until", "progress")).stderr).toContain('--until must be "report" or "stop"');
    expect((await env.graphloom("watch", stateDir, "--notify", "")).stderr).toContain("--notify needs a shell command");
  }, 60_000);
});
