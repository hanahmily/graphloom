// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Resume over the graph (docs/design-graph-topology.md §7.1, §7.3, §11.1,
 * §12 item 10): accepted evidence is reassessed, and on a plugin update
 * rechecked, along the live path; the first node that no longer holds sends
 * the run back to it, truncating the path, while a node off the path is
 * invalidated without moving the run; an open side visit survives a resume,
 * and closes when the truncation removes the visit it was entered from; and
 * `--update-plugin` refuses a change of the topology or of the protocol
 * level. Runs of the real controller on scripted graphs.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  enter,
  observe,
  reenter,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type JobSpec,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type Runner } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";
import type { DurableRunState } from "./state.js";
import { livePath } from "./traversal.js";

const execFileAsync = promisify(execFile);

function graph(stages: Array<string | { id: string; requirementIds: string[] }>, topology: Pick<GraphDefinition, "edges" | "start" | "terminal"> = {}): GraphDefinition {
  const nodes = stages.map((s) => (typeof s === "string" ? { id: s, requirementIds: [`req-${s}`] } : s));
  const requirementIds = nodes.flatMap((n) => n.requirementIds);
  return {
    graphId: "topo",
    version: "1.0.0",
    stages: nodes.map((n) => ({ id: n.id, name: n.id.toUpperCase(), requirementIds: n.requirementIds })),
    ...topology,
    requirements: requirementIds.map((id) => ({ id, statement: `${id} holds`, evidenceSchema: "node-v1" })),
    defaultValidators: requirementIds.map((id) => ({ requirementId: id, validatorId: "node", version: "1" })),
  };
}

/** Fix ⇄ Review with a supervisor-only Arbitrate that leaves to either. */
function fixReview(): GraphDefinition {
  const declared = graph(["fix", "review", "arb"], {
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arb", to: "fix" },
      { from: "arb", to: "review" },
    ],
    start: "fix",
    terminal: ["review"],
  });
  return { ...declared, stages: declared.stages.map((s) => (s.id === "arb" ? { ...s, entry: "supervisor" as const, maxVisits: 2 } : s)) };
}

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

interface Env {
  taskPath: string;
  stateRoot: string;
  manifestPath: string;
}

const manifest = (sdkProtocol: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ graphId: "topo", version: "1.0.0", sdkProtocol, entryPoints: { createGraph: "./dist/index.js" }, ...extra });

/** A task directory with a one-commit repository and a `topo` bundle at `sdkProtocol` whose graph runs in process. */
async function makeEnv(sdkProtocol: number): Promise<Env> {
  const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-topology-resume-")));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "repo");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, "init", "-q");
  await git(repoPath, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-q", "-m", "init");
  const bundle = path.join(taskDir, "plugins", "topo");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  const manifestPath = path.join(bundle, "graphloom.manifest.json");
  await writeFile(manifestPath, manifest(sdkProtocol), "utf8");
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: |\n  Walk the graph.\n", "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state"), manifestPath };
}

/**
 * Each node's work writes `<node>.txt`; its validator passes on an observed
 * record of that file with the node's bytes, unless `verdicts` rejects the
 * node.
 */
function world() {
  const verdicts: Record<string, boolean> = {};
  const validators: Record<string, Validator> = {
    node: {
      evaluate(input) {
        const node = input.requirementId.replace(/^req-/, "");
        const file = [...input.evidence].reverse().find((e) => e.kind === "file" && (e.payload as { path?: string }).path === `${node}.txt`);
        if (file === undefined) return { status: "inconclusive", reason: `no record of ${node}.txt` };
        if ((file.payload as { bytes?: string }).bytes !== `${node}\n`) return { status: "failed", reason: `${node}.txt changed` };
        return verdicts[node] === false ? { status: "failed", reason: `${node} rejected` } : { status: "passed", reason: `${node} ok` };
      },
    },
  };
  const runner: Runner = createScriptedRunner({
    jobs: Array.from({ length: 64 }, () => async (job: JobSpec, ctx: { worktreePath: string }) => {
      await writeFile(path.join(ctx.worktreePath, `${job.stageId}.txt`), `${job.stageId}\n`, "utf8");
      return { status: "ok" as const, summary: job.instruction };
    }),
  });
  return { verdicts, validators, runner };
}

/** A node's work, the observation of its file, and its validation. */
const lap = (stageId: string): GraphDecision[] => [
  dispatch({ stageId, kind: "agent", purpose: "work", instruction: `work ${stageId}`, writeScope: [`${stageId}.txt`] }, `work ${stageId}`),
  observe({ paths: [`${stageId}.txt`] }, `observe ${stageId}`),
  validate({ stageId }, `validate ${stageId}`),
];
const pause = stop({ reason: "paused", blocker: "test pause" }, "pause");
const done = stop({ reason: "complete", blocker: "none" }, "done");

async function runGraph(definition: GraphDefinition, advances: ScriptedAdvance[], options: { w?: ReturnType<typeof world>; supervisor?: ReturnType<typeof createScriptedSupervisor> } = {}) {
  const env = await makeEnv(definition.edges !== undefined ? 2 : 1);
  const w = options.w ?? world();
  const report = await createController().run({
    taskPath: env.taskPath,
    plugin: createScriptedGraph({ definition, advances }),
    validators: w.validators,
    runner: w.runner,
    stateRoot: env.stateRoot,
    runId: "topo-resume",
    ...(options.supervisor !== undefined ? { supervisor: options.supervisor } : {}),
  });
  return { env, report, state: await loadRunState(report.stateDir), w };
}

function resume(stateDir: string, definition: GraphDefinition, advances: ScriptedAdvance[], w: ReturnType<typeof world>, extra: { updatePlugin?: boolean } = {}) {
  return createController().resume({
    runRef: stateDir,
    plugin: createScriptedGraph({ definition, advances }),
    validators: w.validators,
    runner: w.runner,
    ...extra,
  });
}

const pathOf = (state: DurableRunState) => livePath(state).map((v) => `${v.stageId}#${v.attempt}`);
const validNodes = (state: DurableRunState) => state.receipts.filter((r) => r.valid).map((r) => r.stageId);

describe("resume reassesses accepted evidence along the live path (§7.1)", () => {
  it("sends the run back to the first node on the path whose evidence drifted, truncating the path there", async () => {
    const chain = graph(["a", "b", "c"]);
    const { report, state: paused, w } = await runGraph(chain, [...lap("a"), ...lap("b"), ...lap("c"), pause]);
    expect(report.stopReason).toBe("paused");
    expect(pathOf(paused)).toEqual(["a#1", "b#1", "c#1"]);
    await writeFile(path.join(report.worktreePath, "b.txt"), "edited outside the run\n", "utf8");

    const resumed = await resume(report.stateDir, chain, [pause], w);
    expect(resumed.stopReason).toBe("paused");
    const state = await loadRunState(report.stateDir);
    expect(pathOf(state)).toEqual(["a#1", "b#2"]);
    expect(state.current).toEqual({ stageId: "b", attempt: 2 });
    expect(validNodes(state)).toEqual(["a"]);
    expect(livePath(state).at(-1)).toMatchObject({ entered: "reenter", operation: "resume" });
    expect(state.visits!.filter((v) => v.ended !== undefined).map((v) => [v.stageId, v.ended])).toEqual([
      ["b", "replaced by reentry of b"],
      ["c", "replaced by reentry of b"],
    ]);
    // No correction is charged for a resume's truncation.
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections);

    // The graph does the node's work again and completes.
    const finished = await resume(report.stateDir, chain, [...lap("b"), ...lap("c"), done], w);
    expect(finished.status, `${finished.stopReason}: ${finished.blocker}`).toBe("succeeded");
    expect(pathOf(await loadRunState(report.stateDir))).toEqual(["a#1", "b#2", "c#2"]);
  });

  it("invalidates a drifted node off the live path without moving the run", async () => {
    // x (no requirements) ⇄ a: after a lap back to x, a is off the path with its receipt.
    const cycle = graph([{ id: "x", requirementIds: [] }, "a"], { edges: [{ from: "x", to: "a" }, { from: "a", to: "x" }], terminal: ["a"] });
    const { report, state: paused, w } = await runGraph(cycle, [...lap("a"), reenter({ stageId: "x", reason: "again" }, "back to x"), pause]);
    expect(report.stopReason).toBe("paused");
    expect(pathOf(paused)).toEqual(["x#2"]);
    expect(validNodes(paused)).toEqual(["a"]);
    await writeFile(path.join(report.worktreePath, "a.txt"), "edited outside the run\n", "utf8");

    await resume(report.stateDir, cycle, [pause], w);
    const state = await loadRunState(report.stateDir);
    expect(validNodes(state)).toEqual([]);
    expect(pathOf(state)).toEqual(["x#2"]);
    expect(state.current).toEqual(paused.current);
    expect(state.visits).toEqual(paused.visits);
  });

  it("keeps the live path, the visits and an open side visit across a resume", async () => {
    const declared = fixReview();
    const { report, state: paused, w } = await runGraph(
      declared,
      [...lap("fix"), ...lap("review"), supervise({ reason: "a point to arbitrate" }, "hand over"), pause],
      { supervisor: createScriptedSupervisor({ decisions: [enter({ stageId: "arb", reason: "arbitrate" }, "enter"), returnToNormal({ summary: "do the node's work" }, "return")] }) },
    );
    expect(report.stopReason).toBe("paused");
    expect(paused.sideVisit).toBeDefined();

    await resume(report.stateDir, declared, [pause], w);
    const state = await loadRunState(report.stateDir);
    expect(state.sideVisit).toBe(paused.sideVisit);
    expect(state.openAttempt?.["arb"]).toBe(true);
    expect(pathOf(state)).toEqual(["fix#1", "review#1"]);
    expect(state.visits).toEqual(paused.visits);
  });

  it("closes an open side visit when the drift truncates away the visit it was entered from", async () => {
    const declared = fixReview();
    const { report, w } = await runGraph(
      declared,
      [...lap("fix"), ...lap("review"), supervise({ reason: "a point to arbitrate" }, "hand over"), pause],
      { supervisor: createScriptedSupervisor({ decisions: [enter({ stageId: "arb", reason: "arbitrate" }, "enter"), returnToNormal({ summary: "do the node's work" }, "return")] }) },
    );
    await writeFile(path.join(report.worktreePath, "fix.txt"), "edited outside the run\n", "utf8");

    await resume(report.stateDir, declared, [pause], w);
    const state = await loadRunState(report.stateDir);
    expect(pathOf(state)).toEqual(["fix#2"]);
    expect(state.sideVisit).toBeUndefined();
    expect(state.openAttempt?.["arb"]).toBeUndefined();
    expect(state.visits!.find((v) => v.stageId === "arb")?.ended).toBe("closed by reentry of fix");
  });
});

describe("resume --update-plugin over the graph (§7.1, §7.3, §11.1)", () => {
  it("rechecks receipts along the live path: the first that no longer passes sends the run back; one off the path is invalidated in place", async () => {
    const chain = graph(["a", "b", "c"]);
    const { env, report, w } = await runGraph(chain, [...lap("a"), ...lap("b"), ...lap("c"), pause]);
    await writeFile(env.manifestPath, manifest(1, { description: "validators updated" }), "utf8");
    w.verdicts["b"] = false;

    await resume(report.stateDir, chain, [pause], w, { updatePlugin: true });
    const state = await loadRunState(report.stateDir);
    expect(pathOf(state)).toEqual(["a#1", "b#2"]);
    expect(validNodes(state)).toEqual(["a"]);
    expect(state.versionHistory?.at(-1)?.reason).toContain("invalidated from b: req-b failed: b rejected");

    const cycle = graph([{ id: "x", requirementIds: [] }, "a"], { edges: [{ from: "x", to: "a" }, { from: "a", to: "x" }], terminal: ["a"] });
    const off = await runGraph(cycle, [...lap("a"), reenter({ stageId: "x", reason: "again" }, "back to x"), pause]);
    await writeFile(off.env.manifestPath, manifest(2, { description: "validators updated" }), "utf8");
    off.w.verdicts["a"] = false;
    await resume(off.report.stateDir, cycle, [pause], off.w, { updatePlugin: true });
    const offState = await loadRunState(off.report.stateDir);
    expect(pathOf(offState)).toEqual(["x#2"]);
    expect(validNodes(offState)).toEqual([]);
    expect(offState.versionHistory?.at(-1)?.reason).toContain("invalidated a off the live path: req-a failed: a rejected");
  });

  it("refuses an update whose graph changes the topology: an edge, a node's visit cap, or edges for a chain", async () => {
    const declared = fixReview();
    const cases: Array<[GraphDefinition, GraphDefinition, RegExp]> = [
      [declared, { ...declared, edges: declared.edges!.filter((e) => !(e.from === "arb" && e.to === "review")) }, /plugin topology changed since run start: edge arb → review removed/],
      [declared, { ...declared, stages: declared.stages.map((s) => (s.id === "arb" ? { ...s, maxVisits: 6 } : s)) }, /plugin topology changed since run start: node arb maxVisits 2 → 6/],
    ];
    for (const [pinned, updated, refusal] of cases) {
      const { env, report, state: paused, w } = await runGraph(pinned, [...lap("fix"), pause]);
      await writeFile(env.manifestPath, manifest(2, { description: "updated" }), "utf8");
      const resumed = await resume(report.stateDir, updated, [pause], w, { updatePlugin: true });
      expect(resumed).toMatchObject({ status: "stopped", stopReason: "pin mismatch" });
      expect(resumed.blocker).toMatch(refusal);
      const state = await loadRunState(report.stateDir);
      expect(state.intake.bundle).toEqual(paused.intake.bundle);
      expect(state.definition).toEqual(pinned);
    }
  });

  it("refuses an update to a bundle at another protocol level, so a chain run never becomes a topology", async () => {
    const chain = graph(["a", "b"]);
    const { env, report, state: paused, w } = await runGraph(chain, [...lap("a"), pause]);
    await writeFile(env.manifestPath, manifest(2), "utf8");
    const declared: GraphDefinition = { ...chain, edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    const resumed = await resume(report.stateDir, declared, [pause], w, { updatePlugin: true });
    expect(resumed).toMatchObject({ status: "stopped", stopReason: "pin mismatch" });
    expect(resumed.blocker).toBe("the installed bundle states sdkProtocol 2, the run's bundle 1: a plugin update keeps the run's protocol level; a plugin that adopts a topology needs a new run");
    const state = await loadRunState(report.stateDir);
    expect(state.intake.bundle).toEqual(paused.intake.bundle);
    expect(JSON.parse(await readFile(env.manifestPath, "utf8"))).toMatchObject({ sdkProtocol: 2 });
  });
});
