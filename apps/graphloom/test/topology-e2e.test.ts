// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A graph with a cycle and a supervisor-only node, end to end through the
 * built CLI (docs/design-graph-topology.md §12): `check` passes its scripted
 * `enter`/`reenter` and `expect.path`; `rehearse --stop-at` stops on the live
 * path and refuses a supervisor-only node; `resume --rehearsal` walks the
 * forward move, the back-edge reentry, the supervisor's enter, the settle and
 * the leave to completion; `inspect`, `stats` and `wait --until progress`
 * show the topology; a full `rehearse` is ready with `expect.path` met; a
 * rehearsal that waits inside Arbitrate for the operator's approval is ready,
 * and its `resume --rehearsal --approve` continues the scripted supervisor at
 * its next decision.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScope, createTopologyFixture, TOPOLOGY_APPROVAL, TOPOLOGY_APPROVAL_STOP, type TestScope } from "@graphloom/testkit";
import { execFileAsync, repoRoot } from "./cli-env.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");
let scope: TestScope;
afterEach(async () => {
  await scope?.dispose();
});

async function setUp() {
  scope = createScope();
  const fixture = await createTopologyFixture(scope);
  const agents = await writeFakeCodingAgents(fixture.dir);
  const runnerConfig = path.join(fixture.dir, "runner.json");
  await writeFile(runnerConfig, JSON.stringify(fakeRunnerConfig(agents)));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GRAPHLOOM_") && !name.startsWith("CLAUDE_")));
  // A rehearsal's scratch directory is made under TMPDIR, so a kept one is found under the fixture.
  const env: NodeJS.ProcessEnv = { ...inherited, HOME: fixture.dir, TMPDIR: fixture.dir, GRAPHLOOM_RUNNER_CONFIG: runnerConfig };
  const graphloom = (...args: string[]) =>
    execFileAsync(process.execPath, [cli, ...args], { cwd: fixture.dir, env, maxBuffer: 16 * 1024 * 1024 }).then(
      ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
      (err: { stdout?: string; stderr?: string; code?: number }) => ({ stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: typeof err.code === "number" ? err.code : 1 }),
    );
  return { fixture, graphloom };
}

interface Inspect {
  status: string;
  topology: { start: string; terminal: string[]; edges: Array<{ from: string; to: string }>; implicit: boolean };
  path: string[];
  tail: string;
  sideVisit?: string;
  stages: Array<{ id: string; complete: boolean; accepted: boolean; entry: string; maxVisits?: number; visits: number; onPath: boolean }>;
  visits: Array<{ seq: number; stageId: string; attempt: number; entered: string; from?: number; ended?: string; settlement?: { receipts: string[] } }>;
}

describe("a graph with a cycle and a supervisor-only node, through the CLI", () => {
  it("checks, stops on the live path, resumes through reentry, enter, settle and leave to completion, and shows it", { timeout: 180_000 }, async () => {
    const { fixture, graphloom } = await setUp();

    // L0: the scripted enter/reenter and expect.path agree with the declared topology.
    const checked = await graphloom("check", fixture.taskPath);
    expect(JSON.parse(checked.stdout), checked.stderr).toMatchObject({ ok: true, problems: [] });

    // A supervisor-only node is never on the live path: not a stop point.
    const refused = await graphloom("rehearse", fixture.taskPath, "--stop-at", "arbitrate");
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("stage arbitrate is supervisor-only");

    // Stops once Build is accepted on the live path, before the forward move.
    const stopped = await graphloom("rehearse", fixture.taskPath, "--stop-at", "Build");
    const stop = JSON.parse(stopped.stdout) as { ok: boolean; path: string[]; status: string; stateDir: string };
    expect(stop, stopped.stderr).toMatchObject({ ok: true, stoppedAt: "Build", path: ["build"], status: "stopped" });
    const at = await graphloom("wait", stop.stateDir, "--until", "progress", "--json");
    const cursor = (JSON.parse(at.stdout) as { cursor: string }).cursor;

    // Resumed on the stand-ins: the whole walk to completion.
    const resumed = await graphloom("resume", stop.stateDir, "--rehearsal");
    expect(JSON.parse(resumed.stdout), resumed.stderr).toMatchObject({ status: "succeeded" });

    const inspect = JSON.parse((await graphloom("inspect", stop.stateDir)).stdout) as Inspect;
    expect(inspect.topology).toEqual({
      start: "build",
      terminal: ["check"],
      edges: [
        { from: "build", to: "check" },
        { from: "check", to: "build" },
        { from: "arbitrate", to: "build" },
        { from: "arbitrate", to: "check" },
      ],
      implicit: false,
    });
    expect(inspect.path).toEqual(["build#2", "check#3"]);
    expect(inspect.tail).toBe("check#3");
    expect(inspect.sideVisit).toBeUndefined();
    expect(inspect.stages.map((s) => [s.id, s.entry, s.visits, s.onPath, s.accepted])).toEqual([
      ["build", "graph", 2, true, true],
      ["check", "graph", 3, true, true],
      ["arbitrate", "supervisor", 1, false, false],
    ]);
    expect(inspect.stages[2]).toMatchObject({ maxVisits: 2, complete: true });
    expect(inspect.visits.map((v) => [v.stageId, v.attempt, v.entered, v.ended ?? ""])).toEqual([
      ["build", 1, "start", "replaced by reentry of build"],
      ["check", 1, "edge", "replaced by reentry of build"],
      ["build", 2, "reenter", ""],
      ["check", 2, "edge", "replaced by reentry of check"],
      ["arbitrate", 1, "enter", "routed to check"],
      ["check", 3, "reenter", ""],
    ]);
    const arbitrate = inspect.visits[4]!;
    expect(arbitrate.from).toBe(inspect.visits[3]!.seq);
    expect(arbitrate.settlement?.receipts).toHaveLength(1);
    expect(inspect.visits[5]!.from).toBe(arbitrate.seq);

    const stats = JSON.parse((await graphloom("stats", stop.stateDir, "--json")).stdout) as { stages: Array<{ stageId: string; visits: number; supervisorOnly?: boolean }> };
    expect(stats.stages.map((s) => [s.stageId, s.visits, s.supervisorOnly ?? false])).toEqual([
      ["build", 2, false],
      ["check", 3, false],
      ["arbitrate", 1, true],
    ]);
    const table = (await graphloom("stats", stop.stateDir)).stdout;
    expect(table).toMatch(/^stage\s+attempts\s+visits\s+agent calls/m);
    expect(table).toMatch(/^arbitrate \(supervisor-only\)\s+1\s+1\s/m);

    // Everything since the stop, from the cursor taken there.
    const since = await graphloom("wait", stop.stateDir, "--until", "progress", "--since", cursor, "--json");
    const progress = JSON.parse(since.stdout) as { events: Array<{ kind: string; stage?: string; attempt?: number; from?: string; entered?: string }>; summary: { path?: string[] } };
    const kinds = progress.events.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["stage_entered", "node_entered_by_supervisor", "node_settled", "episode_started", "run_stopped"]));
    expect(progress.events.find((e) => e.kind === "node_entered_by_supervisor")).toMatchObject({ stage: "arbitrate", attempt: 1, from: "check#2" });
    expect(progress.events.find((e) => e.kind === "node_settled")).toMatchObject({ stage: "arbitrate", attempt: 1 });
    expect(progress.events.find((e) => e.kind === "stage_entered")).toMatchObject({ stage: "check", attempt: 3, entered: "reenter" });
    expect(progress.summary.path).toEqual(["build#2", "check#3"]);
    const text = (await graphloom("wait", stop.stateDir, "--until", "progress", "--since", cursor)).stdout;
    expect(text).toContain("node_entered_by_supervisor supervisor entered node arbitrate, attempt 1, from check#2");
    expect(text).toContain("path build#2 → check#3");
  });

  it("rehearses the whole walk to ready, with expect.path met", { timeout: 180_000 }, async () => {
    const { fixture, graphloom } = await setUp();
    const rehearsed = await graphloom("rehearse", fixture.taskPath);
    const report = JSON.parse(rehearsed.stdout) as { verdict: string; convergence: { met: boolean; actual: { path: string[]; receipts: string[] } }; blocker?: unknown };
    expect(report.verdict, JSON.stringify(report.blocker ?? report.convergence)).toBe("ready");
    expect(report.convergence).toMatchObject({ met: true, actual: { path: ["build", "check"] } });
    expect([...report.convergence.actual.receipts].sort()).toEqual(["arbitrate", "build", "check"]);
  });

  it("waits inside Arbitrate for the operator's approval as a ready rehearsal, and resumes with the script's next decision", { timeout: 180_000 }, async () => {
    const { fixture, graphloom } = await setUp();
    const rehearsed = await graphloom("rehearse", fixture.taskPath, "--scenario", "operator", "--keep");
    const report = JSON.parse(rehearsed.stdout) as {
      verdict: string;
      blocker?: unknown;
      boundaries: Record<string, { status: string; notes: string[] }>;
      convergence: { met: boolean; actual: { status: string; stopReason?: string; path: string[]; receipts: string[] } };
    };
    // A final stop that waits for a declared approval is a legitimate outcome: the results it holds back are pending, not stuck (B5).
    expect(report.verdict, JSON.stringify(report.blocker ?? report.convergence)).toBe("ready");
    expect(report.convergence).toMatchObject({ met: true, actual: { status: "stopped", stopReason: TOPOLOGY_APPROVAL_STOP, path: ["build", "check"], receipts: ["build"] } });
    expect(report.boundaries.B5).toEqual({
      status: "passed",
      notes: [
        `stage check: a contract-valid result awaits the operator's approval ${TOPOLOGY_APPROVAL} (the run waits in arbitrate)`,
        `stage arbitrate: a contract-valid result awaits the operator's approval ${TOPOLOGY_APPROVAL} (the run waits in arbitrate)`,
      ],
    });

    const scratch = (await readdir(fixture.dir)).filter((name) => name.startsWith("graphloom-rehearsal-"));
    expect(scratch).toHaveLength(1);
    const stateRoot = path.join(fixture.dir, scratch[0]!, "state");
    const runs = (await readdir(stateRoot)).filter((name) => name.startsWith("rehearsal-"));
    expect(runs).toHaveLength(1);
    const stateDir = path.join(stateRoot, runs[0]!);
    type Episodes = { supervisorEpisodes?: Array<{ proposal?: { action: { type: string } }; admission: { outcome: string } }>; supervisorOutcomes?: unknown[] };
    const episodes = async () => (JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")) as Episodes);
    const before = (await episodes()).supervisorEpisodes ?? [];
    expect(before.map((r) => r.proposal?.action.type)).toEqual(["enter", "return"]);

    const resumed = await graphloom("resume", stateDir, "--rehearsal", "--approve", TOPOLOGY_APPROVAL, "--input", "ruling=the build stands");
    expect(JSON.parse(resumed.stdout), resumed.stderr).toMatchObject({ status: "succeeded" });
    // The script continued at its third decision, the leave, not from its first: no replayed enter, nothing rejected.
    const after = await episodes();
    const resumedEpisodes = (after.supervisorEpisodes ?? []).slice(before.length);
    expect(resumedEpisodes.map((r) => r.proposal?.action.type)).toEqual(["reenter", "return"]);
    expect((after.supervisorEpisodes ?? []).map((r) => r.admission.outcome)).not.toContain("inadmissible");
    expect(after.supervisorOutcomes ?? []).toEqual([]);

    const inspect = JSON.parse((await graphloom("inspect", stateDir)).stdout) as Inspect;
    expect(inspect.path).toEqual(["build#2", "check#3"]);
    expect(inspect.visits.map((v) => [v.stageId, v.attempt, v.entered, v.ended ?? ""])).toContainEqual(["arbitrate", 1, "enter", "routed to check"]);
  });
});
