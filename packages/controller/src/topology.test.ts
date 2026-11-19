// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The traversal engine (docs/design-graph-topology.md §4, §12 items 3 to 7):
 * forward moves, reentry over edges, admission along the live path,
 * completion with its carry, and receipts on a cycle. Pure cases over the
 * traversal functions, and runs of the real controller on scripted graphs.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  PROTOCOL_VERSION,
  reenter,
  stop,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type JobSpec,
  type Receipt,
  type RunView,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type Runner } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController, intakeTask, loadRunState, SDK_PROTOCOLS, sdkProtocolProblem, TOPOLOGY_SDK_PROTOCOL } from "./index.js";
import { admitValidation } from "./admit.js";
import { classifyStop } from "./stop-class.js";
import type { DurableRunState } from "./state.js";
import {
  carryToTerminal,
  completionProblem,
  forwardRefusal,
  livePath,
  moveTo,
  reenterPath,
  reentryRefusal,
  startPath,
  tailOf,
  UNDECLARED_EDGE,
} from "./traversal.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pure cases: a state built from a definition, a path and accepted nodes.

function graph(stages: string[], topology: Pick<GraphDefinition, "edges" | "start" | "terminal"> = {}): GraphDefinition {
  return {
    graphId: "topo",
    version: "1.0.0",
    stages: stages.map((id) => ({ id, name: id.toUpperCase(), requirementIds: [`req-${id}`] })),
    ...topology,
    requirements: stages.map((id) => ({ id: `req-${id}`, statement: `${id} is done`, evidenceSchema: "node-v1" })),
    defaultValidators: stages.map((id) => ({ requirementId: `req-${id}`, validatorId: "node", version: "1" })),
  };
}

function receipt(stageId: string, seq: number, valid = true): Receipt {
  return {
    id: `rcpt-${seq}`,
    stageId,
    requirementId: `req-${stageId}`,
    validatorBinding: { requirementId: `req-${stageId}`, validatorId: "node", version: "1" },
    candidateFingerprint: "fp",
    evidenceRefs: [],
    valid,
    acceptedIdentity: {},
  };
}

/** A state on `definition` whose live path is `path` (each a fresh visit) and whose `accepted` nodes hold valid receipts. */
function at(definition: GraphDefinition, pathIds: string[], accepted: string[] = [], extra: Partial<DurableRunState> = {}): DurableRunState {
  const start = startPath(definition, 1);
  let state = {
    definition,
    current: { stageId: pathIds[0]!, attempt: 1 },
    receipts: accepted.map((id, i) => receipt(id, i + 1)),
    generation: 1,
    stateRevision: 0,
    mode: "normal",
    ...start,
    ...extra,
  } as unknown as DurableRunState;
  for (const id of pathIds.slice(1)) {
    const route = [...state.path!];
    const moved = moveTo({ ...state, receipts: [...state.receipts, ...pathIds.map((p, i) => receipt(p, 100 + i))] }, id, 1, "test");
    if ("refusal" in moved) throw new Error(moved.refusal.detail);
    state = { ...state, path: moved.state.path!, visits: moved.state.visits! };
    expect(state.path!.length).toBe(route.length + 1);
  }
  return { ...state, current: { stageId: pathIds.at(-1)!, attempt: 1 } };
}

const ids = (state: DurableRunState) => livePath(state).map((v) => v.stageId);

describe("forward moves (§4.3, §12 item 3)", () => {
  const chain = graph(["a", "b", "c", "d"]);

  it("moves along a direct edge whatever the tail's own acceptance", () => {
    const moved = moveTo(at(chain, ["a"]), "b", 1, "dispatch");
    expect("state" in moved && ids(moved.state)).toEqual(["a", "b"]);
    if (!("state" in moved)) return;
    expect(tailOf(moved.state)).toMatchObject({ stageId: "b", entered: "edge", from: 1 });
  });

  it("carries the accepted nodes of a route, each keeping its latest attempt", () => {
    const state = at(chain, ["a"], ["b", "c"], { stageAttempts: { b: 3, c: 2 } });
    const moved = moveTo(state, "d", 4, "dispatch");
    if (!("state" in moved)) throw new Error(moved.refusal.detail);
    expect(livePath(moved.state).map((v) => [v.stageId, v.entered, v.attempt])).toEqual([
      ["a", "start", 1],
      ["b", "carried", 3],
      ["c", "carried", 2],
      ["d", "edge", 4],
    ]);
  });

  it("is refused across a node that is not accepted, naming the tail, the node and the tail's out-edges", () => {
    const state = at(chain, ["a"], ["b"]);
    const refusal = forwardRefusal(state, "d");
    expect(refusal?.precondition).toBe(UNDECLARED_EDGE);
    expect(refusal?.detail).toContain("tail a, node d");
    expect(refusal?.detail).toContain("out-edges of a: a → b");
    expect("refusal" in moveTo(state, "d", 1, "dispatch")).toBe(true);
  });

  it("is refused across a node reopened by a reentry: open is not accepted", () => {
    const state = at(chain, ["a"], ["b", "c"], { openAttempt: { b: true } });
    expect(forwardRefusal(state, "d")?.precondition).toBe(UNDECLARED_EDGE);
  });

  it("is refused where no declared route leads", () => {
    const declared = graph(["a", "b", "c"], { edges: [{ from: "a", to: "b" }, { from: "c", to: "b" }, { from: "a", to: "c" }], terminal: ["b"] });
    const state = at(declared, ["a", "b"], ["a", "b", "c"]);
    expect(forwardRefusal(state, "c")?.detail).toContain("out-edges of b: none");
  });

  it("is refused through a node already on the live path (path A → B, edges B → A and A → C)", () => {
    const declared = graph(["a", "b", "c"], {
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "a", to: "c" }],
      terminal: ["b", "c"],
    });
    const state = at(declared, ["a", "b"], ["a", "b"]);
    expect(forwardRefusal(state, "c")?.precondition).toBe(UNDECLARED_EDGE);
  });

  it("is refused while a side visit is open", () => {
    const state = at(chain, ["a"], [], { sideVisit: 1 });
    expect(forwardRefusal(state, "b")).toMatchObject({ precondition: "supervisor-only node" });
  });

  it("takes a shortest route, choosing among nodes in stages order", () => {
    const edges = [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }];
    const byBC = at(graph(["a", "b", "c", "d"], { edges }), ["a"], ["b", "c"]);
    const viaB = moveTo(byBC, "d", 1, "dispatch");
    expect("state" in viaB && ids(viaB.state)).toEqual(["a", "b", "d"]);
    const byCB = at(graph(["a", "c", "b", "d"], { edges }), ["a"], ["b", "c"]);
    const viaC = moveTo(byCB, "d", 1, "dispatch");
    expect("state" in viaC && ids(viaC.state)).toEqual(["a", "c", "d"]);
  });

  it("leaves the path alone for a node already on it (a supporting action)", () => {
    const state = at(chain, ["a", "b"]);
    const moved = moveTo(state, "a", 1, "dispatch");
    expect("state" in moved && moved.state).toBe(state);
  });
});

describe("reentry over a graph (§4.4, §12 item 4)", () => {
  const cycle = graph(["a", "b", "c"], { edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }], terminal: ["c"] });

  it("admits the graph's reentry of the tail and along a declared edge from the tail, and refuses one without an edge", () => {
    const state = at(cycle, ["a", "b", "c"]);
    expect(reentryRefusal(state, "c")).toBeUndefined();
    expect(reentryRefusal(state, "a")).toBeUndefined();
    const refused = reentryRefusal(state, "b");
    expect(refused?.precondition).toBe(UNDECLARED_EDGE);
    expect(refused?.detail).toContain("out-edges of c: c → a");
  });

  it("admits the supervisor's reentry of any live-path node", () => {
    const state = at(cycle, ["a", "b", "c"], [], { mode: "recovery" });
    for (const node of ["a", "b", "c"]) expect(reentryRefusal(state, node)).toBeUndefined();
  });

  it("refuses a reentry of a node ahead of the live path, for the supervisor too", () => {
    for (const mode of ["normal", "recovery"] as const) {
      expect(reentryRefusal(at(cycle, ["a"], [], { mode }), "b")?.detail).toContain("to go ahead, the run moves forward");
    }
  });

  it("truncates the live path and keeps the removed visits with the reentry that removed them", () => {
    const state = reenterPath(at(cycle, ["a", "b", "c"]), "b", 2, "reenter");
    expect(livePath(state).map((v) => `${v.stageId}#${v.attempt}`)).toEqual(["a#1", "b#2"]);
    expect(state.visits.map((v) => [v.seq, v.stageId, v.entered, v.ended ?? null])).toEqual([
      [1, "a", "start", null],
      [2, "b", "edge", "replaced by reentry of b"],
      [3, "c", "edge", "replaced by reentry of b"],
      [4, "b", "reenter", null],
    ]);
    expect(tailOf(state).from).toBe(3);
  });
});

describe("completion (§4.6, §12 item 6)", () => {
  const chain = graph(["a", "b", "c"]);

  it("holds when the path ends at a terminal node with every node on it accepted", () => {
    expect(completionProblem(at(chain, ["a", "b", "c"], ["a", "b", "c"]))).toBeUndefined();
    expect(completionProblem(at(chain, ["a", "b", "c"], ["a", "b", "c"], { openAttempt: { b: true } }))).toContain("b on the live path is not accepted");
    expect(completionProblem(at(chain, ["a", "b"], ["a", "b"]))).toContain("not a terminal node");
  });

  it("carries accepted nodes from a non-terminal tail to a terminal one", () => {
    const carried = carryToTerminal(at(chain, ["a"], ["a", "b", "c"]));
    expect(livePath(carried).map((v) => [v.stageId, v.entered])).toEqual([["a", "start"], ["b", "carried"], ["c", "carried"]]);
    expect(completionProblem(carried)).toBeUndefined();
  });

  it("carries nothing when no accepted route reaches a terminal node", () => {
    const state = at(chain, ["a"], ["a", "b"]);
    expect(carryToTerminal(state)).toBe(state);
  });

  it("is refused with a side visit open", () => {
    expect(completionProblem({ ...at(chain, ["a", "b", "c"], ["a", "b", "c"]), sideVisit: 4 })).toContain("side visit");
  });
});

describe("admission along the live path (§4.5, §12 item 5)", () => {
  const chain = graph(["a", "b", "c"]);
  const passes: Record<string, Validator> = { node: { evaluate: () => ({ status: "passed", reason: "ok" }) } };
  const admitting = (state: DurableRunState, stageId: string) =>
    admitValidation(
      {
        ...state,
        evidence: [{ ref: "ev-1", kind: "other", generation: 1, payload: { node: stageId } }],
        validatorBindings: [],
        receiptSeq: 10,
        worktreePath: path.join(os.tmpdir(), "gl-topology-no-worktree"),
        stateDir: path.join(os.tmpdir(), "gl-topology-no-state"),
        intake: { task: { request: "r" } },
      } as unknown as DurableRunState,
      { stageId },
      passes,
    );

  it("admits a node whose live-path predecessors are accepted, whatever an off-path node holds", async () => {
    const result = await admitting(at(chain, ["a", "b"], ["a"]), "b");
    expect(result).toMatchObject({ accepted: true });
    // c is off the path and holds nothing: irrelevant to b.
    expect(result.state.receipts.some((r) => r.stageId === "b" && r.valid)).toBe(true);
  });

  it("refuses one whose predecessor is missing receipts or open", async () => {
    expect(await admitting(at(chain, ["a", "b"], []), "b")).toMatchObject({ accepted: false, reason: "missing valid predecessor receipts for a" });
    expect(await admitting(at(chain, ["a", "b"], ["a"], { openAttempt: { a: true } }), "b")).toMatchObject({
      accepted: false,
      reason: expect.stringContaining("predecessor a is open"),
    });
  });

  it("admits a validation of an earlier node on the path, and mints nothing for a node that is already accepted", async () => {
    const partial = at(chain, ["a", "b"], []);
    expect(await admitting(partial, "a")).toMatchObject({ accepted: true });
    const done = await admitting(at(chain, ["a", "b"], ["a"]), "a");
    expect(done).toMatchObject({ accepted: false, evaluated: false, reason: expect.stringContaining("already accepted") });
    expect(done.state.receipts.filter((r) => r.stageId === "a")).toHaveLength(1);
  });

  it("extends the path by a forward move first, and refuses a node no move reaches as inadmissible", async () => {
    const moved = await admitting(at(chain, ["a"], ["a"]), "b");
    expect(moved.accepted).toBe(true);
    expect(ids(moved.state)).toEqual(["a", "b"]);
    const refused = await admitting(at(chain, ["a"], ["a"]), "c");
    expect(refused).toMatchObject({ accepted: false, evaluated: false, refusal: { precondition: UNDECLARED_EDGE } });
  });
});

// ---------------------------------------------------------------------------
// Runs of the real controller on scripted graphs.

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

/** A task directory with a one-commit repository and a `topo` bundle at `sdkProtocol` whose graph runs in process. */
async function makeEnv(sdkProtocol = 1): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-topology-")));
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
  await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify({ graphId: "topo", version: "1.0.0", sdkProtocol, entryPoints: { createGraph: "./dist/index.js" } }), "utf8");
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: |\n  Walk the graph.\n", "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

/** Each node's job reports a record naming its node; its validator passes while `verdicts` says so (default: pass). */
function nodeWorld() {
  const verdicts: Record<string, boolean> = {};
  const validators: Record<string, Validator> = {
    node: {
      evaluate(input) {
        const node = input.requirementId.replace(/^req-/, "");
        const seen = input.evidence.some((e) => (e.payload as { node?: string } | undefined)?.node === node);
        if (!seen) return { status: "inconclusive", reason: `no record of ${node}` };
        return verdicts[node] === false ? { status: "failed", reason: `${node} rejected` } : { status: "passed", reason: `${node} ok` };
      },
    },
  };
  const runner: Runner = createScriptedRunner({
    jobs: Array.from({ length: 64 }, () => async (job: JobSpec) => ({ status: "ok" as const, summary: job.instruction, evidence: [{ kind: "other" as const, payload: { node: job.stageId } }] })),
  });
  return { verdicts, validators, runner };
}

const work = (stageId: string): GraphDecision =>
  dispatch({ stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `work ${stageId}` }, `work ${stageId}`);
const check = (stageId: string): GraphDecision => validate({ stageId }, `validate ${stageId}`);
const done = stop({ reason: "complete", blocker: "none" }, "done");

async function runGraph(definition: GraphDefinition, advances: ScriptedAdvance[], options: { sdkProtocol?: number; runId?: string; supervisor?: ReturnType<typeof createScriptedSupervisor>; budgets?: string; world?: ReturnType<typeof nodeWorld>; runner?: Runner } = {}) {
  const env = await makeEnv(options.sdkProtocol ?? (definition.edges !== undefined ? 2 : 1));
  if (options.budgets !== undefined) await writeFile(env.taskPath, `graph: topo\nrepo: ./repo\nrequest: |\n  Walk the graph.\n${options.budgets}`, "utf8");
  const world = options.world ?? nodeWorld();
  const report = await createController().run({
    taskPath: env.taskPath,
    plugin: createScriptedGraph({ definition, advances }),
    validators: world.validators,
    runner: options.runner ?? world.runner,
    stateRoot: env.stateRoot,
    runId: options.runId ?? "topo-run",
    ...(options.supervisor !== undefined ? { supervisor: options.supervisor } : {}),
  });
  return { report, state: await loadRunState(report.stateDir) };
}

const pathOf = (state: DurableRunState) => livePath(state).map((v) => `${v.stageId}#${v.attempt}`);

describe("the engine in a run", () => {
  const chain = graph(["a", "b", "c"]);

  it("starts at the start node, moves forward on dispatch and completes at the terminal node", async () => {
    const { report, state } = await runGraph(chain, [work("a"), check("a"), work("b"), check("b"), work("c"), check("c"), done]);
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(state.visits?.map((v) => [v.stageId, v.entered, v.operation])).toEqual([
      ["a", "start", "intake"],
      ["b", "edge", "dispatch"],
      ["c", "edge", "dispatch"],
    ]);
  });

  it("stops a graph that acts for a node no forward move reaches: undeclared edge, a final plugin-defect stop", async () => {
    const { report, state } = await runGraph(chain, [work("a"), work("c")]);
    expect(report).toMatchObject({ status: "stopped", stopReason: UNDECLARED_EDGE });
    expect(report.blocker).toContain("tail a, node c");
    expect(classifyStop(state)).toMatchObject({ retryable: false, kind: "plugin defect" });
    expect(pathOf(state)).toEqual(["a#1"]);
  });

  it("stops a graph that validates a node no forward move reaches", async () => {
    const { report } = await runGraph(chain, [work("a"), check("c")]);
    expect(report).toMatchObject({ status: "stopped", stopReason: UNDECLARED_EDGE });
  });

  it("spends one correction per reentry and stops `corrections budget exhausted` on the last", async () => {
    const { report, state } = await runGraph(
      chain,
      [work("a"), check("a"), work("b"), reenter({ stageId: "a", reason: "again" }, "back"), work("b"), reenter({ stageId: "a", reason: "once more" }, "back again")],
      { budgets: "budgets:\n  corrections: 1\n" },
    );
    expect(report).toMatchObject({ status: "stopped", stopReason: "corrections budget exhausted" });
    expect(state.budgets.corrections).toBe(0);
    expect(pathOf(state)).toEqual(["a#2", "b#2"]);
    expect(state.visits?.filter((v) => v.entered === "reenter").map((v) => [v.stageId, v.operation, v.from])).toEqual([["a", "reenter", 2]]);
  });

  it("refuses the graph's reentry of a node off the declared edges", async () => {
    const cycle = graph(["a", "b", "c"], { edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "a" }], terminal: ["c"] });
    const { report, state } = await runGraph(cycle, [work("a"), check("a"), work("b"), check("b"), work("c"), reenter({ stageId: "b", reason: "back" }, "back")]);
    expect(report).toMatchObject({ status: "stopped", stopReason: UNDECLARED_EDGE });
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections);
  });

  it("refuses a `complete` stop with an open node on the path, leaving the path as it was", async () => {
    const { report, state } = await runGraph(chain, [work("a"), check("a"), work("b"), check("b"), work("c"), check("c"), reenter({ stageId: "a", reason: "again" }, "back"), done]);
    expect(report).toMatchObject({ status: "stopped", stopReason: "complete" });
    expect(pathOf(state)).toEqual(["a#2"]);
  });

  it("refuses a `complete` stop when no accepted route reaches a terminal node, leaving the path as it was", async () => {
    const { report, state } = await runGraph(chain, [work("a"), check("a"), work("b"), check("b"), done]);
    expect(report).toMatchObject({ status: "stopped", stopReason: "complete" });
    expect(pathOf(state)).toEqual(["a#1", "b#1"]);
  });

  it("carries accepted nodes from a reentered node to the terminal one on a `complete` stop", async () => {
    const { report, state } = await runGraph(chain, [work("a"), check("a"), work("b"), check("b"), work("c"), check("c"), reenter({ stageId: "a", reason: "again" }, "back"), check("a"), done]);
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(livePath(state).map((v) => [v.stageId, v.entered])).toEqual([["a", "reenter"], ["b", "carried"], ["c", "carried"]]);
  });

  it("reads delivery drift at the tail, not at the last listed node", async () => {
    // Stages a, b, c with edges a → c → b: b is terminal though c is listed last.
    const declared = graph(["a", "b", "c"], { edges: [{ from: "a", to: "c" }, { from: "c", to: "b" }] });
    const world = nodeWorld();
    const writes: Runner = createScriptedRunner({
      jobs: Array.from({ length: 16 }, () => async (job: JobSpec, ctx: { worktreePath: string }) => {
        if (job.purpose === "work") await writeFile(path.join(ctx.worktreePath, "late.txt"), "late\n", "utf8");
        return { status: "ok" as const, summary: job.instruction, evidence: [{ kind: "other" as const, payload: { node: job.stageId } }] };
      }),
    });
    const late = dispatch({ stageId: "a", kind: "agent", purpose: "work", instruction: "late work", writeScope: ["late.txt"] }, "late work");
    const { report } = await runGraph(declared, [work("a"), check("a"), work("c"), check("c"), work("b"), check("b"), late, done], { world, runner: writes });
    expect(report).toMatchObject({ status: "stopped", stopReason: "delivery changed after acceptance" });
    expect(report.blocker).toContain("after b accepted it");
  });
});

describe("receipts on a cycle (§4.7, §12 item 7)", () => {
  const fixReview = graph(["fix", "review"], { edges: [{ from: "fix", to: "review" }, { from: "review", to: "fix" }], start: "fix", terminal: ["review"] });
  /** Fix writes FIX.txt (the candidate); Review records a verdict over it. */
  function cycleWorld(contents: string[]) {
    let writes = 0;
    const validators: Record<string, Validator> = {
      node: {
        evaluate(input) {
          const node = input.requirementId.replace(/^req-/, "");
          if (node === "fix") return input.evidence.some((e) => e.kind === "file") ? { status: "passed", reason: "fixed" } : { status: "inconclusive", reason: "no file" };
          return input.evidence.some((e) => e.kind === "review") ? { status: "passed", reason: "reviewed" } : { status: "inconclusive", reason: "no review" };
        },
      },
    };
    const runner: Runner = createScriptedRunner({
      jobs: Array.from({ length: 16 }, () => async (job: JobSpec, ctx: { worktreePath: string }) => {
        if (job.stageId === "fix") {
          await writeFile(path.join(ctx.worktreePath, "FIX.txt"), contents[Math.min(writes, contents.length - 1)]!, "utf8");
          writes += 1;
          return { status: "ok" as const, summary: "fixed" };
        }
        return { status: "ok" as const, summary: "reviewed", evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }] };
      }),
    });
    return { verdicts: {}, validators, runner };
  }
  const fix: GraphDecision = dispatch({ stageId: "fix", kind: "agent", purpose: "work", instruction: "fix", writeScope: ["FIX.txt"] }, "fix");
  const look: GraphDecision = observe({ paths: ["FIX.txt"], includeWorkspaceManifest: true }, "observe");
  const review: GraphDecision = dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review");
  const back: GraphDecision = reenter({ stageId: "fix", reason: "findings" }, "back to fix");

  it("validates Review again after a lap that changed the candidate", async () => {
    const lap = [fix, look, check("fix"), review, check("review")];
    const { report, state } = await runGraph(fixReview, [...lap, back, ...lap, done], { world: cycleWorld(["one\n", "two\n"]) });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    const reviews = state.receipts.filter((r) => r.stageId === "review");
    expect(reviews.map((r) => r.valid)).toEqual([false, true]);
    expect(pathOf(state)).toEqual(["fix#2", "review#2"]);
    expect(state.visits?.map((v) => `${v.stageId}#${v.attempt}:${v.entered}${v.ended !== undefined ? `:${v.ended}` : ""}`)).toEqual([
      "fix#1:start:replaced by reentry of fix",
      "review#1:edge:replaced by reentry of fix",
      "fix#2:reenter",
      "review#2:edge",
    ]);
  });

  it("counts Review's still-valid receipts when a lap leaves the candidate unchanged", async () => {
    const lap = [fix, look, check("fix")];
    const { report, state } = await runGraph(fixReview, [...lap, review, check("review"), back, ...lap, done], { world: cycleWorld(["same\n"]) });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(state.receipts.filter((r) => r.stageId === "review").map((r) => r.valid)).toEqual([true]);
    expect(livePath(state).map((v) => [v.stageId, v.entered])).toEqual([["fix", "reenter"], ["review", "carried"]]);
  });

  it("records each job's node attempt on its evidence (producer.attempt)", async () => {
    const lap = [fix, look, check("fix"), review, check("review")];
    const { state } = await runGraph(fixReview, [...lap, back, ...lap, done], { world: cycleWorld(["one\n", "two\n"]) });
    const producers = state.evidence
      .map((e) => (e.payload as { producer?: { stageId: string; attempt?: number; purpose: string } } | undefined)?.producer)
      .filter((p) => p !== undefined && p.purpose !== "diagnostic")
      .map((p) => `${p!.stageId}#${p!.attempt}`);
    expect(producers).toEqual(["review#1", "review#2"]);
  });
});

describe("RunView.topology", () => {
  it("shows the plugin the implicit chain and the live path", async () => {
    const chain = graph(["a", "b"]);
    const seen: RunView[] = [];
    const spy = (decision: GraphDecision): ScriptedAdvance => (view) => {
      seen.push(view);
      return decision;
    };
    const { report } = await runGraph(chain, [spy(work("a")), spy(check("a")), spy(work("b")), spy(check("b")), spy(done)]);
    expect(report.status).toBe("succeeded");
    expect(seen[0]!.topology).toEqual({ start: "a", terminal: ["b"], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }], implicit: true, path: [{ stageId: "a", attempt: 1 }] });
    expect(seen.at(-1)!.topology?.path).toEqual([{ stageId: "a", attempt: 1 }, { stageId: "b", attempt: 1 }]);
  });
});

describe("protocol levels (§11.1, §12 item 11)", () => {
  const declared = graph(["a", "b"], { edges: [{ from: "a", to: "b" }] });

  it("intake accepts manifests at levels 1 and 2 and refuses any other", async () => {
    for (const level of [1, 2]) await expect(intakeTask((await makeEnv(level)).taskPath)).resolves.toMatchObject({ bundle: { sdkProtocol: level } });
    await expect(intakeTask((await makeEnv(3)).taskPath)).rejects.toThrow(/manifest sdkProtocol 3 is not one this host accepts \(1, 2\)/);
    expect(sdkProtocolProblem(2)).toBeUndefined();
  });

  it("refuses a level-1 bundle that describes edges", async () => {
    await expect(runGraph(declared, [work("a")], { sdkProtocol: 1 })).rejects.toThrow(/sdkProtocol 1 but describes edges: a topology needs sdkProtocol 2/);
  });

  it("runs a level-2 bundle without edges as an implicit chain", async () => {
    const { report, state } = await runGraph(graph(["a", "b"]), [work("a"), check("a"), work("b"), check("b"), done], { sdkProtocol: 2 });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(state.intake.bundle.sdkProtocol).toBe(2);
    expect(livePath(state).map((v) => v.stageId)).toEqual(["a", "b"]);
  });

  it("runs a level-2 bundle along its declared edges", async () => {
    const { report } = await runGraph(declared, [work("a"), check("a"), work("b"), check("b"), done]);
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
  });

  it("keeps the wire protocol at 1, so a GraphLoom that predates levels refuses a level-2 manifest with its equality check", () => {
    // The check every earlier controller makes at intake: `manifest.sdkProtocol !== PROTOCOL_VERSION`.
    expect(PROTOCOL_VERSION).toBe(1);
    expect(SDK_PROTOCOLS).toEqual([1, 2]);
    expect(TOPOLOGY_SDK_PROTOCOL).not.toBe(PROTOCOL_VERSION);
  });
});
