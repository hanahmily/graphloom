// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Repair qualification and activation over the graph
 * (docs/design-graph-topology.md §7.3, §12 item 10): the structural match of
 * a candidate's describe() and of its `graphloom.stages.json` pin covers the
 * topology (nodes, each node's entry and visit cap, edges, start, terminal),
 * and activation restarts the live path at the start node, closing an open
 * side visit. Pure cases over the checks, and runs of the real controller
 * with a scripted supervisor that qualifies and activates a plugin repair.
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateRepair,
  createScriptedGraph,
  dispatch,
  enter,
  qualifyRepair,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type JobSpec,
  type Receipt,
  type RunView,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createInProcessPluginHost } from "@graphloom/plugin-host";
import { createScriptedSupervisor, type SupervisorInput } from "@graphloom/supervisor";
import { createController, loadRunState, type RepairDeps } from "./index.js";
import { assertCandidateDefinitionCompatible, stagesPin, writeStagesPin } from "./repair-lifecycle.js";
import { assertCandidateStepsUnchanged } from "./repair.js";
import type { DurableRunState } from "./state.js";
import { enterNode } from "./supervisor-node.js";
import { livePath, moveTo, reenterPath, restartAtStart, startPath, topologyChanges } from "./traversal.js";

const execFileAsync = promisify(execFile);

/** Fix ⇄ Review with a supervisor-only Arbitrate that leaves to either. */
function topology(): GraphDefinition {
  const nodes = ["fix", "review", "arb"];
  return {
    graphId: "topo",
    version: "1.0.0",
    stages: [
      { id: "fix", name: "Fix", requirementIds: ["req-fix"] },
      { id: "review", name: "Review", requirementIds: ["req-review"] },
      { id: "arb", name: "Arbitrate", requirementIds: ["req-arb"], entry: "supervisor", maxVisits: 2 },
    ],
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arb", to: "fix" },
      { from: "arb", to: "review" },
    ],
    start: "fix",
    terminal: ["review"],
    requirements: nodes.map((id) => ({ id: `req-${id}`, statement: `${id} is done`, evidenceSchema: "node-v1" })),
    defaultValidators: nodes.map((id) => ({ requirementId: `req-${id}`, validatorId: "node", version: "1" })),
  };
}

/** The same graph nodes as a chain: no topology declared. */
function chain(): GraphDefinition {
  const declared = topology();
  return {
    graphId: declared.graphId,
    version: declared.version,
    stages: declared.stages.slice(0, 2),
    requirements: declared.requirements.slice(0, 2),
    defaultValidators: declared.defaultValidators.slice(0, 2),
  };
}

const withStage = (definition: GraphDefinition, id: string, patch: Partial<GraphDefinition["stages"][number]>): GraphDefinition => ({
  ...definition,
  stages: definition.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)),
});

const withoutLeaveToReview = (d: GraphDefinition): GraphDefinition => ({ ...d, edges: d.edges!.filter((e) => !(e.from === "arb" && e.to === "review")) });

/** Each way a candidate may change the topology, and what the rejection names: [change, candidate from the base, named, base]. */
const CHANGES: Array<[string, (d: GraphDefinition) => GraphDefinition, string, GraphDefinition?]> = [
  ["adds an edge", (d) => ({ ...d, edges: topology().edges! }), "edge arb → review added", withoutLeaveToReview(topology())],
  ["removes an edge", withoutLeaveToReview, "edge arb → review removed"],
  ["reorders the edges", (d) => ({ ...d, edges: [...d.edges!].reverse() }), "edges reordered"],
  ["changes start", (d) => ({ ...d, start: "review" }), "start fix → review"],
  ["changes terminal", (d) => ({ ...d, terminal: ["fix", "review"] }), "terminal review → fix, review"],
  ["changes a node's entry", (d) => withStage(d, "review", { entry: "graph" }), "node review entry (none) → graph"],
  ["changes a node's visit cap", (d) => withStage(d, "arb", { maxVisits: 6 }), "node arb maxVisits 2 → 6"],
];

describe("the structural match covers the topology (§7.3)", () => {
  it.each(CHANGES)("rejects a candidate whose describe() %s, naming what changed", (_change, alter, named, base = topology()) => {
    expect(() => assertCandidateDefinitionCompatible(alter(base), base)).toThrow(`candidate describe() alters pinned topology: ${named}`);
  });

  it("names a change of the node set as the stages'", () => {
    const added: GraphDefinition = { ...topology(), stages: [...topology().stages, { id: "ship", name: "Ship", requirementIds: [] }], edges: [...topology().edges!, { from: "review", to: "ship" }] };
    expect(() => assertCandidateDefinitionCompatible(added, topology())).toThrow("candidate describe() alters pinned stages: node ship added");
  });

  it("rejects a candidate that turns a chain into a declared topology, or a topology back into a chain", () => {
    expect(() => assertCandidateDefinitionCompatible({ ...chain(), edges: [{ from: "fix", to: "review" }] }, chain())).toThrow(
      "candidate describe() alters pinned topology: edges declared (the run walks an implicit chain)",
    );
    const { edges: _edges, ...undeclared } = topology();
    void _edges;
    expect(() => assertCandidateDefinitionCompatible(undeclared, topology())).toThrow("edges removed (the run walks a declared topology)");
  });

  it("accepts a candidate that declares the same topology, and compares what each declares", () => {
    expect(() => assertCandidateDefinitionCompatible(topology(), topology())).not.toThrow();
    expect(() => assertCandidateDefinitionCompatible(chain(), chain())).not.toThrow();
    // A chain reordered is another topology: its edges follow the order.
    expect(topologyChanges({ stages: [...chain().stages].reverse() }, chain())).toEqual(["nodes reordered"]);
  });
});

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

describe("the stages pin covers the topology (§7.3)", () => {
  it("pins each node's entry and visit cap and the declared edges, start and terminal; a chain's pin declares none", async () => {
    const root = await tempDir("gl-stages-pin-");
    await writeStagesPin(root, topology());
    const pinned = JSON.parse(await readFile(path.join(root, "graphloom.stages.json"), "utf8")) as Record<string, unknown>;
    expect(pinned).toEqual({
      stages: [
        { id: "fix", name: "Fix", requirementIds: ["req-fix"] },
        { id: "review", name: "Review", requirementIds: ["req-review"] },
        { id: "arb", name: "Arbitrate", requirementIds: ["req-arb"], entry: "supervisor", maxVisits: 2 },
      ],
      edges: topology().edges,
      start: "fix",
      terminal: ["review"],
    });
    await expect(assertCandidateStepsUnchanged({ base: stagesPin(topology()), candidateRoot: root })).resolves.toBeUndefined();
    expect(Object.keys(stagesPin(chain()))).toEqual(["stages"]);
  });

  it.each(CHANGES)("rejects a candidate whose pin %s", async (_change, alter, named, base = topology()) => {
    const root = await tempDir("gl-stages-pin-");
    await writeFile(path.join(root, "graphloom.stages.json"), JSON.stringify(stagesPin(alter(base))), "utf8");
    await expect(assertCandidateStepsUnchanged({ base: stagesPin(base), candidateRoot: root })).rejects.toThrow(`candidate alters pinned topology: ${named}`);
  });

  it("rejects a pin that declares edges for a chain run, and one that drops a topology's", async () => {
    const root = await tempDir("gl-stages-pin-");
    await writeFile(path.join(root, "graphloom.stages.json"), JSON.stringify({ ...stagesPin(chain()), edges: [{ from: "fix", to: "review" }] }), "utf8");
    await expect(assertCandidateStepsUnchanged({ base: stagesPin(chain()), candidateRoot: root })).rejects.toThrow("edges declared (the run walks an implicit chain)");
    // What a pin of stages alone (an older controller's) says of a declared topology.
    await writeFile(path.join(root, "graphloom.stages.json"), JSON.stringify({ stages: stagesPin(topology()).stages }), "utf8");
    await expect(assertCandidateStepsUnchanged({ base: stagesPin(topology()), candidateRoot: root })).rejects.toThrow("edges removed");
  });
});

// ---------------------------------------------------------------------------
// Activation restarts the live path at the start node (§7.3).

function receipt(stageId: string, seq: number): Receipt {
  return {
    id: `rcpt-${seq}`,
    stageId,
    requirementId: `req-${stageId}`,
    validatorBinding: { requirementId: `req-${stageId}`, validatorId: "node", version: "1" },
    candidateFingerprint: "fp",
    evidenceRefs: [],
    valid: true,
    acceptedIdentity: {},
  };
}

it("restarts a run after laps of a cycle at the start node: every graph-entered node's receipts invalid, on the path or off it", () => {
  const definition = topology();
  let state = {
    definition,
    current: { stageId: "fix", attempt: 1 },
    receipts: [receipt("fix", 1), receipt("review", 2), receipt("arb", 3)],
    generation: 1,
    stateRevision: 0,
    mode: "recovery",
    ...startPath(definition, 1),
  } as unknown as DurableRunState;
  const moved = moveTo(state, "review", 1, "dispatch");
  if ("refusal" in moved) throw new Error(moved.refusal.detail);
  // A lap back to Fix leaves Review off the live path with its receipt.
  state = { ...reenterPath(moved.state, "fix", 2, "reenter"), current: { stageId: "fix", attempt: 2 } };
  expect(livePath(state).map((v) => `${v.stageId}#${v.attempt}`)).toEqual(["fix#2"]);
  const restarted = restartAtStart(enterNode(state, "arb", 1), "activate_repair");
  expect(livePath(restarted).map((v) => [v.stageId, v.attempt, v.entered, v.operation])).toEqual([["fix", 1, "start", "activate_repair"]]);
  expect(restarted.current).toEqual({ stageId: "fix", attempt: 1 });
  expect(restarted.receipts.map((r) => [r.stageId, r.valid])).toEqual([["fix", false], ["review", false], ["arb", true]]);
  expect(restarted.sideVisit).toBeUndefined();
  expect(restarted.visits.filter((v) => v.ended !== undefined).map((v) => [v.stageId, v.ended])).toEqual([
    ["fix", "replaced by reentry of fix"],
    ["review", "replaced by reentry of fix"],
    ["fix", "closed by activation"],
    ["arb", "closed by activation"],
  ]);
});

// ---------------------------------------------------------------------------
// Runs of the real controller: a plugin repair qualified and activated inside a side visit.

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

/** A task with a one-commit repository, the sourceRepair grant, and a source-repairable `topo` bundle at sdkProtocol 2. */
async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await tempDir("gl-topology-repair-");
  const repoPath = path.join(taskDir, "repo");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, "init", "-q");
  await git(repoPath, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-q", "-m", "init");
  const bundle = path.join(taskDir, "plugins", "topo");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  await writeFile(
    path.join(bundle, "graphloom.manifest.json"),
    JSON.stringify({ graphId: "topo", version: "1.0.0", sdkProtocol: 2, repairContract: "source-repairable", entryPoints: { createGraph: "./dist/index.js" } }),
    "utf8",
  );
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: |\n  Walk the graph.\ngrants:\n  sourceRepair: true\n  validatorSubstitution: false\n", "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

const validators: Record<string, Validator> = {
  node: {
    evaluate(input) {
      const node = input.requirementId.replace(/^req-/, "");
      const seen = input.evidence.some((e) => (e.payload as { node?: string } | undefined)?.node === node);
      return seen ? { status: "passed", reason: `${node} ok` } : { status: "inconclusive", reason: `no record of ${node}` };
    },
  },
};
const runner = () =>
  createScriptedRunner({
    jobs: Array.from({ length: 32 }, () => async (job: JobSpec) => ({ status: "ok" as const, summary: job.instruction, evidence: [{ kind: "other" as const, payload: { node: job.stageId } }] })),
  });

/** A repair whose patch author edits the candidate with `onPatch` and whose reviewer approves. */
function approvingRepair(sessionId: string, onPatch?: (root: string) => Promise<void>): RepairDeps {
  return {
    patchAuthor: {
      sessionId,
      async patch({ candidateRoot }) {
        await onPatch?.(candidateRoot);
        await writeFile(path.join(candidateRoot, "p.txt"), "patched\n", "utf8");
        return { summary: "patched" };
      },
    },
    reviewer: { sessionId: `${sessionId}-reviewer`, review: async () => ({ approved: true, reason: "ok" }) },
    preflight: async () => ({ ok: true, summary: "ok" }),
  };
}

const work = (stageId: string): GraphDecision =>
  dispatch({ stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `work ${stageId}` }, `work ${stageId}`);
const check = (stageId: string): GraphDecision => validate({ stageId }, `validate ${stageId}`);
const activateFirstQualified = (input: SupervisorInput) => {
  const qualified = input.view.repairCandidates?.find((c) => c.status === "qualified");
  if (qualified === undefined) throw new Error(`no qualified candidate: ${JSON.stringify(input.view.repairCandidates)}`);
  return activateRepair({ qualifiedArtifactId: qualified.artifactId, reason: "act" }, "activate");
};
const pathOf = (state: DurableRunState) => livePath(state).map((v) => `${v.stageId}#${v.attempt}`);

describe("a plugin repair over a declared topology", () => {
  it("activates inside a side visit: the live path restarts at start, the side visit closes, and the run completes on the repaired version", async () => {
    const env = await makeEnv();
    let afterActivation: RunView | undefined;
    const graph = (advances: GraphDecision[]) => createScriptedGraph({ definition: topology(), advances });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([work("fix"), check("fix"), work("review"), check("review"), supervise({ reason: "a point the graph cannot settle" }, "hand over")]),
      recreateHost: async (ctx) =>
        createInProcessPluginHost(graph([work("fix"), check("fix"), work("review"), check("review"), stop({ reason: "complete", blocker: "none" }, "done")]), {
          activeVersion: ctx.activeVersion,
          generation: ctx.generation,
        }),
      validators,
      runner: runner(),
      supervisor: createScriptedSupervisor({
        sessionId: "sup-topo",
        decisions: [
          enter({ stageId: "arb", reason: "arbitrate" }, "enter arbitrate"),
          qualifyRepair({ target: "plugin", reason: "the plugin mishandles the point" }, "qualify"),
          activateFirstQualified,
          (input) => ((afterActivation = input.view), returnToNormal({ summary: "repaired" }, "return")),
        ],
      }),
      repair: approvingRepair("sup-topo"),
      stateRoot: env.stateRoot,
      runId: "topo-repair",
    });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(afterActivation?.topology?.path).toEqual([{ stageId: "fix", attempt: 1 }]);
    expect(afterActivation?.topology?.sideVisit).toBeUndefined();
    expect(afterActivation?.current).toEqual({ stageId: "fix", attempt: 1 });
    expect(afterActivation?.receipts.filter((r) => r.valid)).toEqual([]);
    const state = await loadRunState(report.stateDir);
    expect(state.activeVersion).toMatch(/^topo@repair-/);
    expect(state.visits!.find((v) => v.stageId === "arb")).toMatchObject({ entered: "enter", ended: "closed by activation" });
    expect(state.visits!.find((v) => v.operation === "activate_repair")).toMatchObject({ stageId: "fix", attempt: 1, entered: "start" });
    expect(pathOf(state)).toEqual(["fix#1", "review#1"]);
    expect(state.definition.edges).toEqual(topology().edges);
  });

  it("rejects a candidate whose stages pin drops an edge, at qualification, and keeps the run's version", async () => {
    const env = await makeEnv();
    let rejection: string | undefined;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: topology(), advances: [work("fix"), supervise({ reason: "repair" }, "hand over")] }),
      validators,
      runner: runner(),
      supervisor: createScriptedSupervisor({
        sessionId: "sup-pin",
        decisions: [
          qualifyRepair({ target: "plugin", reason: "try" }, "qualify"),
          (input) => ((rejection = input.view.repairCandidates?.[0]?.rejectionReason), stop({ reason: "pause", blocker: "operator review" }, "stop")),
        ],
      }),
      repair: approvingRepair("sup-pin", async (root) => {
        const pinPath = path.join(root, "graphloom.stages.json");
        const pin = JSON.parse(await readFile(pinPath, "utf8")) as { edges: Array<{ from: string; to: string }> };
        await writeFile(pinPath, JSON.stringify({ ...pin, edges: pin.edges.filter((e) => e.from !== "arb" || e.to !== "review") }), "utf8");
      }),
      stateRoot: env.stateRoot,
      runId: "topo-pin",
    });
    expect(report.stopReason).toBe("pause");
    expect(rejection).toContain("candidate alters pinned topology: edge arb → review removed");
    const state = await loadRunState(report.stateDir);
    expect(state.activeVersion).toBe("topo@1.0.0");
  });

  it("rejects a candidate whose describe() changes the topology, at qualification, and keeps the run where it was", async () => {
    const env = await makeEnv();
    let afterRejection: RunView | undefined;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: topology(), advances: [work("fix"), check("fix"), supervise({ reason: "repair" }, "hand over")] }),
      recreateHost: async (ctx) =>
        createInProcessPluginHost(createScriptedGraph({ definition: { ...topology(), terminal: ["fix", "review"] }, advances: [] }), {
          activeVersion: ctx.activeVersion,
          generation: ctx.generation,
        }),
      validators,
      runner: runner(),
      supervisor: createScriptedSupervisor({
        sessionId: "sup-describe",
        decisions: [
          qualifyRepair({ target: "plugin", reason: "try" }, "qualify"),
          (input) => ((afterRejection = input.view), stop({ reason: "pause", blocker: "operator review" }, "stop")),
        ],
      }),
      repair: approvingRepair("sup-describe"),
      stateRoot: env.stateRoot,
      runId: "topo-describe",
    });
    expect(report.stopReason).toBe("pause");
    expect(afterRejection?.repairCandidates?.[0]).toMatchObject({ status: "rejected", rejectionReason: expect.stringContaining("candidate describe() alters pinned topology: terminal review → fix, review") });
    const state = await loadRunState(report.stateDir);
    expect(state.activeVersion).toBe("topo@1.0.0");
    expect(pathOf(state)).toEqual(["fix#1"]);
    expect(state.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["fix"]);
  });
});
