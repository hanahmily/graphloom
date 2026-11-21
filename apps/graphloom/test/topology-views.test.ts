// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The operator surfaces over a topology (docs/design-graph-topology.md §8, §9):
 * `wait --until progress` and its summary, `stats` and `inspect` for a chain
 * (unchanged) and for a graph that declares edges with a cycle and a side
 * visit; and `check`'s L0 checks of scripted `enter`/`reenter` and
 * `expect.path`. The end-to-end walk is topology-e2e.test.ts.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedGraph, dispatch, stop, validate, type GraphDecision, type GraphDefinition, type RehearsalScenario } from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createController, loadRunState, type DurableRunState, type VisitRecord } from "@graphloom/controller";
import { decodeCursor, encodeCursor, formatProgress, markOf, progressSince, progressSummary, type ProgressMark } from "../src/progress.js";
import { scenarioTopologyProblems } from "../src/rehearsal.js";
import { formatRunStats, runStats } from "../src/stats.js";
import { execFileAsync, makeCliEnv, repoRoot } from "./cli-env.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/stats/395ec998-6e4");
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** The recorded issue-fix run (a chain: Fix, Review), as if it were still running in normal mode. */
async function chain(): Promise<DurableRunState> {
  const s = await loadRunState(fixture);
  const { recoveryEpisodeId: _e, recoveryTrigger: _t, quotaHold: _q, ...rest } = s;
  return { ...rest, status: "running", mode: "normal", supervisorEpisodes: [], remedies: [] } as DurableRunState;
}

/** The same run's nodes with Fix ⇄ Review edges and a supervisor-only Arbitrate. */
function declared(base: DurableRunState): GraphDefinition {
  return {
    ...base.definition,
    stages: [...base.definition.stages, { id: "arb", name: "Arbitrate", requirementIds: ["ruled"], entry: "supervisor", maxVisits: 2 }],
    requirements: [...base.definition.requirements, { id: "ruled", statement: "ruled", evidenceSchema: "ruling-v1" }],
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arb", to: "fix" },
      { from: "arb", to: "review" },
    ],
    start: "fix",
    terminal: ["review"],
  };
}

const visit = (seq: number, stageId: string, attempt: number, entered: VisitRecord["entered"], extra: Partial<VisitRecord> = {}): VisitRecord => ({
  seq,
  stageId,
  attempt,
  entered,
  generation: 1,
  operation: entered === "enter" ? "enter" : entered === "reenter" ? "reenter" : "dispatch",
  ...(seq > 1 ? { from: seq - 1 } : {}),
  ...extra,
});

/** On the path fix#1 → review#1. */
async function onPath(): Promise<DurableRunState> {
  const base = await chain();
  return { ...base, definition: declared(base), current: { stageId: "review", attempt: 1 }, path: [1, 2], visits: [visit(1, "fix", 1, "start"), visit(2, "review", 1, "edge")] };
}

/** The supervisor entered Arbitrate from review#1. */
function entered(s: DurableRunState): DurableRunState {
  return { ...s, current: { stageId: "arb", attempt: 1 }, sideVisit: 3, visits: [...s.visits!, visit(3, "arb", 1, "enter")] };
}

/** Arbitrate's validation settled the side visit. */
function settled(s: DurableRunState): DurableRunState {
  return {
    ...s,
    visits: s.visits!.map((v) => (v.seq === 3 ? { ...v, settlement: { receipts: ["rcpt-30"], reasons: [{ requirementId: "ruled", reason: "the build stands" }] } } : v)),
  };
}

/** The supervisor left Arbitrate to Fix: a reentry, the path truncated. */
function left(s: DurableRunState): DurableRunState {
  const visits = s.visits!.map((v) => (v.seq === 3 ? { ...v, ended: "routed to fix" } : v.seq <= 2 ? { ...v, ended: "replaced by reentry of fix" } : v));
  const { sideVisit: _s, ...rest } = s;
  return { ...rest, current: { stageId: "fix", attempt: 2 }, path: [4], visits: [...visits, visit(4, "fix", 2, "reenter", { from: 3 })] };
}

describe("progress over a chain: as before", () => {
  it("stage_entered names no entry, and the summary no path, even when the chain records visits", async () => {
    const s = await chain();
    const reentered = { ...s, current: { stageId: "fix", attempt: 5 }, path: [3], visits: [visit(1, "fix", 4, "migrated"), visit(2, "review", 4, "migrated"), visit(3, "fix", 5, "reenter")] };
    const { events } = progressSince(markOf({ ...s, path: [1, 2], visits: reentered.visits.slice(0, 2) }), reentered);
    expect(events).toEqual([{ kind: "stage_entered", stage: "fix", attempt: 5, detail: "stage fix, attempt 5" }]);
    const summary = progressSummary(reentered);
    expect(summary).not.toHaveProperty("path");
    expect(summary).not.toHaveProperty("sideVisit");
    const text = formatProgress({ runId: s.runId, stateDir: "/x", outcome: "progress", events, summary, cursor: "c" });
    expect(text).toContain("stage fix#5  2/2 stages complete  budgets:");
    expect(text).not.toContain("path");
  });
});

describe("progress over a declared topology (§8)", () => {
  it("reports the supervisor's enter, the settle and the leave as moves, and the path in the summary", async () => {
    const s0 = await onPath();
    const s1 = entered(s0);
    const first = progressSince(markOf(s0), s1);
    // The enter is its own move, not a stage_entered.
    expect(first.events).toEqual([
      { kind: "node_entered_by_supervisor", stage: "arb", attempt: 1, from: "review#1", detail: "supervisor entered node arb, attempt 1, from review#1" },
    ]);
    expect(progressSummary(s1)).toMatchObject({ path: ["fix#1", "review#1"], sideVisit: "arb#1" });

    const s2 = settled(s1);
    const second = progressSince(first.mark, s2);
    expect(second.events).toEqual([
      { kind: "node_settled", stage: "arb", attempt: 1, receipts: ["rcpt-30"], detail: "node arb, attempt 1, settled (ruled: the build stands)" },
    ]);
    // Reported once.
    expect(progressSince(second.mark, s2).events).toEqual([]);

    const s3 = left(s2);
    const third = progressSince(second.mark, s3);
    expect(third.events).toEqual([{ kind: "stage_entered", stage: "fix", attempt: 2, entered: "reenter", detail: "stage fix, attempt 2, by reenter" }]);
    const summary = progressSummary(s3);
    expect(summary.path).toEqual(["fix#2"]);
    expect(summary).not.toHaveProperty("sideVisit");
    const text = formatProgress({ runId: s3.runId, stateDir: "/x", outcome: "progress", events: [...first.events, ...second.events, ...third.events], summary, cursor: "c" });
    expect(text).toContain("node_entered_by_supervisor supervisor entered node arb, attempt 1, from review#1");
    expect(text).toContain("node_settled         node arb, attempt 1, settled (ruled: the build stands)");
    expect(text).toContain("stages complete  path fix#2");
    expect(formatProgress({ runId: s1.runId, stateDir: "/x", outcome: "progress", events: [], summary: progressSummary(s1), cursor: "c" })).toContain("path fix#1 → review#1  side visit arb#1");
  });

  it("a cursor from before visits were reported is still read; it reports no visit, and the next mark does", async () => {
    const s0 = await onPath();
    const { vs: _vs, sv: _sv, ...old } = markOf(s0);
    const mark = decodeCursor(encodeCursor(old as ProgressMark));
    expect(mark.vs).toBeUndefined();
    const s1 = settled(entered(s0));
    const { events, mark: next } = progressSince(mark, s1);
    expect(events.map((e) => e.kind)).toEqual(["stage_entered"]);
    expect(events[0]).not.toHaveProperty("entered");
    expect(next).toMatchObject({ vs: 3, sv: [3] });
    expect(() => decodeCursor(encodeCursor({ ...markOf(s0), vs: "3" } as unknown as ProgressMark))).toThrow(/malformed/);
  });
});

describe("stats (§8)", () => {
  it("keeps a chain's table, with each node's visits in the JSON", async () => {
    const stats = runStats(await chain());
    expect(stats.declaresEdges).toBe(false);
    expect(stats.stages.map((s) => [s.stageId, s.visits])).toEqual([
      ["fix", 1],
      ["review", 1],
    ]);
    expect(formatRunStats(stats)).toMatch(/^stage\s+attempts\s+agent calls\s+jobs/m);
  });

  it("adds a visits column for a graph that declares edges and marks a supervisor-only node; totals unchanged", async () => {
    const s = left(settled(entered(await onPath())));
    const stats = runStats(s);
    expect(stats.declaresEdges).toBe(true);
    expect(stats.stages.map((x) => [x.stageId, x.visits, x.supervisorOnly ?? false])).toEqual([
      ["fix", 2, false],
      ["review", 1, false],
      ["arb", 1, true],
    ]);
    const text = formatRunStats(stats);
    expect(text).toMatch(/^stage\s+attempts\s+visits\s+agent calls/m);
    expect(text).toMatch(/^fix\s+4\s+2\s+91\s/m);
    expect(text).toMatch(/^arb \(supervisor-only\)\s+0\s+1\s+0\s/m);
    expect(text).toMatch(/^all stages\s+306\s+49\s/m);
  });
});

describe("inspect over a chain (§8)", () => {
  it("keeps the existing fields and adds the implicit chain, the live path and the visits", async () => {
    const env = await makeCliEnv(cleanups);
    // hello's own stages and requirements (the pinned bundle's), scripted.
    const manifest = JSON.parse(await readFile(path.join(repoRoot, "examples/plugins/hello/graphloom.manifest.json"), "utf8")) as Pick<GraphDefinition, "version" | "stages" | "requirements">;
    const definition: GraphDefinition = {
      graphId: "hello",
      version: manifest.version,
      stages: manifest.stages,
      requirements: manifest.requirements,
      defaultValidators: manifest.requirements.map((r) => ({ requirementId: r.id, validatorId: "ok", version: "1" })),
    };
    const job = (stageId: string): GraphDecision => dispatch({ stageId, kind: "command", purpose: "check", readOnly: true, instruction: stageId }, stageId);
    await writeFile(path.join(env.dir, "task.yaml"), `graph: hello\nrepo: ./test-repo\nrequest: "Write the greeting."\n`);
    const report = await createController().run({
      taskPath: path.join(env.dir, "task.yaml"),
      plugin: createScriptedGraph({ definition, advances: [job("write"), validate({ stageId: "write" }, "w"), job("review"), validate({ stageId: "review" }, "r"), stop({ reason: "complete", blocker: "none" }, "done")] }),
      validators: { ok: { evaluate: () => ({ status: "passed", reason: "ok" }) } },
      runner: createScriptedRunner({ jobs: Array.from({ length: 4 }, () => async () => ({ status: "ok" as const, summary: "ok", evidence: [{ kind: "other" as const, payload: {} }] })) }),
      stateRoot: env.stateRoot,
      runId: "inspect-chain",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    const inspect = JSON.parse((await execFileAsync(process.execPath, [cli, "inspect", report.stateDir])).stdout) as Record<string, unknown> & { stages: Array<Record<string, unknown>> };
    expect(inspect.stages).toEqual([
      { id: "write", name: "Write", requirementIds: ["greeting-bytes"], complete: true, accepted: true, entry: "graph", visits: 1, onPath: true },
      { id: "review", name: "Review", requirementIds: ["independent-review"], complete: true, accepted: true, entry: "graph", visits: 1, onPath: true },
    ]);
    expect(inspect.topology).toEqual({ start: "write", terminal: ["review"], edges: [{ from: "write", to: "review" }, { from: "review", to: "write" }], implicit: true });
    expect(inspect).toMatchObject({ path: ["write#1", "review#1"], tail: "review#1", current: { stageId: "review", attempt: 1 } });
    expect(inspect).not.toHaveProperty("sideVisit");
    expect((inspect.visits as VisitRecord[]).map((v) => [v.stageId, v.entered])).toEqual([
      ["write", "start"],
      ["review", "edge"],
    ]);
  }, 60_000);
});

describe("check's L0 over the topology (§9)", () => {
  const topology: GraphDefinition = {
    graphId: "topo",
    version: "1",
    stages: [
      { id: "fix", name: "Fix", requirementIds: ["f"] },
      { id: "review", name: "Review", requirementIds: ["r"] },
      { id: "arb", name: "Arbitrate", requirementIds: ["a"], entry: "supervisor", maxVisits: 1 },
    ],
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arb", to: "fix" },
    ],
    terminal: ["review"],
    requirements: [],
    defaultValidators: [],
  };
  const { edges: _edges, terminal: _terminal, ...unrouted } = topology;
  const chainDefinition: GraphDefinition = { ...unrouted, stages: topology.stages.slice(0, 2) };
  const enterArb: GraphDecision = { action: { type: "enter", enter: { stageId: "arb", reason: "r" } }, reason: "r" };
  const back: GraphDecision = { action: { type: "return", return: { summary: "s" } }, reason: "r" };
  const reenterTo = (stageId: string): GraphDecision => ({ action: { type: "reenter", reenter: { stageId, reason: "r" } }, reason: "r" });
  const scenario = (supervisor: GraphDecision[], expect: RehearsalScenario["expect"] = { status: "succeeded" }): RehearsalScenario => ({ results: {}, supervisor, expect });

  it("accepts an enter, a leave along an out-edge and an expect.path along the edges to a terminal node", () => {
    expect(
      scenarioTopologyProblems(topology, "happy", scenario([enterArb, back, reenterTo("fix"), back, reenterTo("review")], { status: "succeeded", path: ["fix", "review"], recovery: ["supervisor_node_settled"], receipts: ["arb"] })),
    ).toEqual([]);
    // A chain: a supervisor reentry of any declared stage, and a path along the implicit chain.
    expect(scenarioTopologyProblems(chainDefinition, "happy", scenario([reenterTo("fix")], { status: "succeeded", path: ["fix", "review"] }))).toEqual([]);
  });

  it("refuses an enter of a graph-entered, undeclared or exhausted node, or while a side visit is open", () => {
    expect(scenarioTopologyProblems(topology, "s", scenario([{ action: { type: "enter", enter: { stageId: "review", reason: "r" } }, reason: "r" }]))).toEqual([
      "scenario s: supervisor[0] enters review, which is graph-entered; enter opens only a supervisor-only node (arb)",
    ]);
    expect(scenarioTopologyProblems(chainDefinition, "s", scenario([enterArb]))).toEqual(["scenario s: supervisor[0] enters arb, which the graph does not declare"]);
    expect(scenarioTopologyProblems(topology, "s", scenario([enterArb, enterArb]))).toEqual([
      "scenario s: supervisor[1] enters arb while the side visit of arb is open; leave it with reenter first",
    ]);
    expect(scenarioTopologyProblems(topology, "s", scenario([enterArb, reenterTo("fix"), enterArb]))).toEqual(["scenario s: supervisor[2] enters arb more often than its maxVisits (1) allows"]);
  });

  it("refuses a reenter of a supervisor-only or undeclared node, and a leave without the edge", () => {
    expect(scenarioTopologyProblems(topology, "s", scenario([reenterTo("arb"), reenterTo("ship")]))).toEqual([
      "scenario s: supervisor[0] reenters arb, which is supervisor-only; the supervisor opens it with enter",
      "scenario s: supervisor[1] reenters ship, which the graph does not declare",
    ]);
    expect(scenarioTopologyProblems(topology, "s", scenario([enterArb, back, reenterTo("review")]))).toEqual([
      "scenario s: supervisor[2] leaves arb to review along no declared edge; out-edges of arb: arb → fix",
    ]);
  });

  it("refuses a scenario expecting a settle or a supervisor-only node's receipt without an enter", () => {
    expect(scenarioTopologyProblems(topology, "s", scenario([], { status: "succeeded", recovery: ["supervisor_node_settled"], receipts: ["arb"] }))).toEqual([
      "scenario s: expects supervisor_node_settled but scripts no enter",
      "scenario s: expects a receipt of supervisor-only node arb but scripts no enter of it",
    ]);
  });

  it("refuses an expect.path off the topology", () => {
    const problems = (path: string[], status: "succeeded" | "stopped" = "succeeded") => scenarioTopologyProblems(topology, "s", scenario([], { status, path }));
    expect(problems(["review"])).toEqual(["scenario s: expect.path starts at review, not at the start node fix"]);
    expect(problems(["fix", "arb"])).toEqual([
      "scenario s: expect.path names arb, which is supervisor-only and never on the live path",
      "scenario s: expect.path steps fix → arb along no declared edge",
      "scenario s: expect.path ends at arb, which is not terminal (review); a run succeeds only at a terminal node",
    ]);
    expect(problems(["fix", "review", "fix"])).toContain("scenario s: expect.path names a node twice; the live path never does");
    // A stopped run may end anywhere on the path.
    expect(problems(["fix"], "stopped")).toEqual([]);
  });
});
