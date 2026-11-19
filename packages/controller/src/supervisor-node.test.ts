// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Supervisor-only nodes (docs/design-graph-topology.md §5, §12 items 8 and 9):
 * `enter`, the side visit and the graph's restrictions while it is open, the
 * settle check and its `supervisor_node_settled` episode, leaving along an
 * out-edge (a reentry or a forward move), leaving without a receipt,
 * `maxVisits`, and the receipts and admitted bindings every validator call
 * carries. Pure cases over the functions, and runs of the real controller on
 * a scripted graph with a scripted supervisor.
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
  type Receipt,
  type ScriptedAdvance,
  type ValidationInput,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type Runner } from "@graphloom/runner";
import { createScriptedSupervisor, type SupervisorInput, type SupervisorProposal } from "@graphloom/supervisor";
import type { PluginHost } from "@graphloom/plugin-host";
import { createController, loadRunState } from "./index.js";
import { validationContext } from "./admit.js";
import { createHostValidators } from "./host-validators.js";
import { safeDefault } from "./inadmissible.js";
import { classifyStop } from "./stop-class.js";
import type { DurableRunState } from "./state.js";
import { closeSideVisit, ENTER_IS_SUPERVISORS, enterNode, enterRefusal, leaveRefusal, SUPERVISOR_NODE_SETTLED, sideVisitRefusal } from "./supervisor-node.js";
import { forwardRefusal, livePath, moveTo, reenterPath, restartAtStart, startPath, SUPERVISOR_ONLY_NODE, UNDECLARED_EDGE } from "./traversal.js";

const execFileAsync = promisify(execFile);

/** Fix ⇄ Review with a supervisor-only Arbitrate that leaves to either. */
function topology(maxVisits = 2): GraphDefinition {
  const nodes = ["fix", "review", "arb"];
  return {
    graphId: "topo",
    version: "1.0.0",
    stages: [
      { id: "fix", name: "Fix", requirementIds: ["req-fix"] },
      { id: "review", name: "Review", requirementIds: ["req-review"] },
      { id: "arb", name: "Arbitrate", requirementIds: ["req-arb"], entry: "supervisor", maxVisits },
    ],
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arb", to: "fix" },
      { from: "arb", to: "review" },
    ],
    start: "fix",
    terminal: ["review"],
    requirements: nodes.map((id) => ({
      id: `req-${id}`,
      statement: `${id} is done`,
      evidenceSchema: "node-v1",
      ...(id === "review" ? { prerequisiteRequirementIds: ["req-arb"] } : {}),
    })),
    defaultValidators: nodes.map((id) => ({ requirementId: `req-${id}`, validatorId: "node", version: "1" })),
    approvals: [{ id: "ruling", stageId: "arb", description: "Rule on the point" }],
  };
}

// ---------------------------------------------------------------------------
// Pure cases.

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

/** A state whose live path is `pathIds` (each node accepted), in `mode`. */
function at(pathIds: string[], mode: "normal" | "recovery" = "recovery", definition = topology()): DurableRunState {
  let state = {
    definition,
    current: { stageId: pathIds[0]!, attempt: 1 },
    receipts: pathIds.map((id, i) => receipt(id, i + 1)),
    generation: 1,
    stateRevision: 0,
    mode,
    budgets: { corrections: 4 },
    ...startPath(definition, 1),
  } as unknown as DurableRunState;
  for (const id of pathIds.slice(1)) {
    const moved = moveTo(state, id, 1, "test");
    if ("refusal" in moved) throw new Error(moved.refusal.detail);
    state = moved.state;
  }
  return { ...state, current: { stageId: pathIds.at(-1)!, attempt: 1 } };
}

describe("enter (§5.2, §5.5)", () => {
  it("opens a side visit from the tail: current is the node, its attempt open, no correction or generation bump", () => {
    const state = at(["fix", "review"]);
    expect(enterRefusal(state, "arb")).toBeUndefined();
    const entered = enterNode(state, "arb", 1);
    expect(entered.sideVisit).toBe(3);
    expect(entered.visits!.at(-1)).toMatchObject({ seq: 3, stageId: "arb", attempt: 1, entered: "enter", from: 2, operation: "enter" });
    expect(entered.current).toEqual({ stageId: "arb", attempt: 1 });
    expect(entered.openAttempt).toEqual({ arb: true });
    expect(entered.generation).toBe(state.generation);
    expect(livePath(entered).map((v) => v.stageId)).toEqual(["fix", "review"]);
  });

  it("is the supervisor's: refused in normal mode (a graph decision, or a supervisor outside recovery)", () => {
    expect(enterRefusal(at(["fix"], "normal"), "arb")).toMatchObject({ precondition: ENTER_IS_SUPERVISORS });
  });

  it("is refused for a graph-entered node, an undeclared node, past maxVisits and with a side visit open", () => {
    const state = at(["fix"]);
    expect(enterRefusal(state, "review")).toMatchObject({ precondition: SUPERVISOR_ONLY_NODE });
    expect(enterRefusal(state, "review")?.detail).toContain("review is graph-entered");
    expect(enterRefusal(state, "nope")).toMatchObject({ precondition: "undeclared stage" });
    const open = enterNode(state, "arb", 1);
    expect(enterRefusal(open, "arb")?.detail).toContain("the side visit of arb is open");
    const once = at(["fix"], "recovery", topology(1));
    const used = closeSideVisit(enterNode(once, "arb", 1), "left without receipt");
    expect(enterRefusal(used, "arb")?.detail).toContain("arb has used 1 of its 1 visits (maxVisits 1)");
  });
});

describe("while a side visit is open (§5.2)", () => {
  const open = (mode: "normal" | "recovery") => ({ ...enterNode(at(["fix", "review"]), "arb", 1), mode });

  it("admits actions for the node and refuses any other node, on the path or ahead, in both modes", () => {
    for (const mode of ["normal", "recovery"] as const) {
      expect(forwardRefusal(open(mode), "arb")).toBeUndefined();
      expect(forwardRefusal(open(mode), "fix")).toMatchObject({ precondition: SUPERVISOR_ONLY_NODE });
    }
    const moved = moveTo(open("normal"), "arb", 1, "dispatch");
    expect("state" in moved && moved.state.path).toEqual([1, 2]);
  });

  it("refuses the graph's reenter and `complete` stop, and admits its other stops", () => {
    const state = open("normal");
    expect(sideVisitRefusal(state, reenter({ stageId: "review", reason: "r" }, "r").action)).toMatchObject({ precondition: SUPERVISOR_ONLY_NODE });
    expect(sideVisitRefusal(state, stop({ reason: "complete", blocker: "none" }, "done").action)).toMatchObject({ precondition: SUPERVISOR_ONLY_NODE });
    expect(sideVisitRefusal(state, stop({ reason: "waiting", blocker: "operator", retryable: false }, "wait").action)).toBeUndefined();
    expect(sideVisitRefusal(state, supervise({ reason: "help" }, "help").action)).toBeUndefined();
  });

  it("lets the supervisor leave only along the node's out-edges, and forward only where a route reaches", () => {
    const fromReview = open("recovery");
    expect(leaveRefusal(fromReview, "fix")).toBeUndefined();
    expect(leaveRefusal(fromReview, "review")).toBeUndefined();
    const noEdge = { ...topology(), edges: [{ from: "fix", to: "review" }, { from: "review", to: "fix" }, { from: "arb", to: "fix" }] };
    const narrow = { ...enterNode(at(["fix", "review"], "recovery", noEdge), "arb", 1) };
    expect(leaveRefusal(narrow, "review")).toMatchObject({ precondition: UNDECLARED_EDGE });
    expect(leaveRefusal(narrow, "review")?.detail).toContain("out-edges of arb: arb → fix");
    // Entered from a Fix that holds no receipt: a direct edge fix → review crosses no node, so the tail's own acceptance is not a condition (§4.3).
    const fromFix = enterNode({ ...at(["fix"]), receipts: [] }, "arb", 1);
    expect(leaveRefusal(fromFix, "review")).toBeUndefined();
  });
});

it("closes an open side visit when a resume's truncation removes the visit it was entered from (§7.1), and only then", () => {
  const fromReview = enterNode(at(["fix", "review"]), "arb", 1);
  const sentBack = reenterPath(fromReview, "fix", 2, "resume");
  expect(sentBack.sideVisit).toBeUndefined();
  expect(sentBack.visits.find((v) => v.stageId === "arb")?.ended).toBe("closed by reentry of fix");
  expect(sentBack.openAttempt?.["arb"]).toBeUndefined();
  const fromFix = enterNode(at(["fix", "review"]), "arb", 1);
  const kept = reenterPath({ ...fromFix, visits: fromFix.visits!.map((v) => (v.stageId === "arb" ? { ...v, from: 1 } : v)) }, "review", 2, "resume");
  expect(kept.sideVisit).toBe(fromFix.sideVisit);
});

it("closes an open side visit on activation and keeps the supervisor-only node's receipts (§7.3)", () => {
  const open = enterNode({ ...at(["fix", "review"]), receipts: [receipt("fix", 1), receipt("arb", 2)] }, "arb", 1);
  const restarted = restartAtStart(open, "activate_repair");
  expect(restarted.sideVisit).toBeUndefined();
  expect(restarted.visits!.find((v) => v.stageId === "arb")?.ended).toBe("closed by activation");
  expect(restarted.receipts.map((r) => [r.stageId, r.valid])).toEqual([["fix", false], ["arb", true]]);
});

it("stops, not returns, as the settle trigger's safe default: a return opens it again", () => {
  const state = { ...at(["fix"]), budgets: { jobs: 4, decisions: 4, corrections: 4 } } as unknown as DurableRunState;
  expect(safeDefault(state, SUPERVISOR_NODE_SETTLED)).toBe("stop");
  expect(safeDefault(state, "supervise")).toBe("return");
});

describe("ValidationInput.receipts and validatorBindings (§5.4, §12 item 9)", () => {
  /** A reading validator's rule: honour an S receipt only under the currently admitted binding. */
  function honours(input: ValidationInput, requirementId: string): boolean {
    const admitted = input.validatorBindings?.find((b) => b.requirementId === requirementId);
    return (input.receipts ?? []).some(
      (r) => r.requirementId === requirementId && admitted !== undefined && r.validatorBinding.validatorId === admitted.validatorId && r.validatorBinding.version === admitted.version,
    );
  }

  it("carries every receipt and the currently admitted bindings, so a receipt under a since-replaced binding is not honoured", () => {
    const state = {
      intake: { task: { request: "do it" } },
      receipts: [receipt("arb", 1)],
      validatorBindings: [{ requirementId: "req-arb", validatorId: "node", version: "1" }],
    } as unknown as DurableRunState;
    const current = validationContext(state);
    expect(current).toEqual({ request: "do it", receipts: [receipt("arb", 1)], validatorBindings: [{ requirementId: "req-arb", validatorId: "node", version: "1" }] });
    expect(honours({ requirementId: "req-review", statement: "s", evidence: [], ...current }, "req-arb")).toBe(true);
    const replaced = validationContext({ ...state, validatorBindings: [{ requirementId: "req-arb", validatorId: "node", version: "2" }] });
    expect(honours({ requirementId: "req-review", statement: "s", evidence: [], ...replaced }, "req-arb")).toBe(false);
  });

  it("reaches a host validator unchanged", async () => {
    const seen: ValidationInput[] = [];
    const host = {
      evaluate: async (_ctx: unknown, _id: string, input: ValidationInput) => {
        seen.push(input);
        return { ok: true as const, value: { status: "passed" as const, reason: "ok" } };
      },
      hydratesEvidence: true,
    } as unknown as PluginHost;
    const validators = createHostValidators(() => host, ["node"], { runId: "r", stateDir: "/nowhere", getStateRevision: () => 0 });
    const context = validationContext({ intake: { task: { request: "x" } }, receipts: [receipt("arb", 1)], validatorBindings: [] } as unknown as DurableRunState);
    await validators["node"]!.evaluate({ requirementId: "req-review", statement: "s", evidence: [], ...context });
    expect(seen[0]).toMatchObject({ receipts: [{ id: "rcpt-1", stageId: "arb" }], validatorBindings: [] });
  });
});

// ---------------------------------------------------------------------------
// Runs of the real controller.

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

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-side-visit-")));
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
  await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify({ graphId: "topo", version: "1.0.0", sdkProtocol: 2, entryPoints: { createGraph: "./dist/index.js" } }), "utf8");
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: |\n  Walk the graph.\n", "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

/** Each node's job records its node; the node validator passes on a record of its node and keeps every input. */
function world() {
  const inputs: ValidationInput[] = [];
  const validators: Record<string, Validator> = {
    node: {
      evaluate(input) {
        inputs.push(input);
        const node = input.requirementId.replace(/^req-/, "");
        const seen = input.evidence.some((e) => (e.payload as { node?: string } | undefined)?.node === node);
        return seen ? { status: "passed", reason: `${node} ok: the record holds` } : { status: "inconclusive", reason: `no record of ${node}` };
      },
    },
  };
  const runner: Runner = createScriptedRunner({
    jobs: Array.from({ length: 64 }, () => async (job: JobSpec) => ({ status: "ok" as const, summary: job.instruction, evidence: [{ kind: "other" as const, payload: { node: job.stageId } }] })),
  });
  return { inputs, validators, runner };
}

const work = (stageId: string): GraphDecision =>
  dispatch({ stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `work ${stageId}` }, `work ${stageId}`);
const check = (stageId: string): GraphDecision => validate({ stageId }, `validate ${stageId}`);
const done = stop({ reason: "complete", blocker: "none" }, "done");
const handOver = supervise({ reason: "a point the graph cannot settle" }, "hand over");
const enterArb = enter({ stageId: "arb", reason: "arbitrate the point" }, "enter arbitrate");
const back = returnToNormal({ summary: "back to the graph" }, "return");
const leave = (stageId: string) => reenter({ stageId, reason: `leave to ${stageId}` }, `leave to ${stageId}`);

type Step = SupervisorProposal | ((input: SupervisorInput, index: number) => SupervisorProposal | Promise<SupervisorProposal>);

async function runGraph(advances: ScriptedAdvance[], decisions: Step[], options: { definition?: GraphDefinition; world?: ReturnType<typeof world>; runId?: string; env?: Awaited<ReturnType<typeof makeEnv>> } = {}) {
  const env = options.env ?? (await makeEnv());
  const w = options.world ?? world();
  const report = await createController().run({
    taskPath: env.taskPath,
    plugin: createScriptedGraph({ definition: options.definition ?? topology(), advances }),
    validators: w.validators,
    runner: w.runner,
    stateRoot: env.stateRoot,
    runId: options.runId ?? "side-run",
    supervisor: createScriptedSupervisor({ decisions }),
  });
  return { report, state: await loadRunState(report.stateDir), env, world: w };
}

const pathOf = (state: DurableRunState) => livePath(state).map((v) => `${v.stageId}#${v.attempt}`);
const sideOf = (state: DurableRunState) => state.visits!.filter((v) => v.entered === "enter").map((v) => ({ attempt: v.attempt, from: v.from, ended: v.ended }));

describe("a supervisor-only node in a run", () => {
  it("completes without ever visiting a supervisor-only node", async () => {
    const { report, state } = await runGraph([work("fix"), check("fix"), work("review"), check("review"), done], []);
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(pathOf(state)).toEqual(["fix#1", "review#1"]);
    expect(state.visits!.some((v) => v.stageId === "arb")).toBe(false);
  });

  it("stops a graph that decides `enter`: the supervisor's, a final plugin-defect stop", async () => {
    const { report, state } = await runGraph([work("fix"), enterArb], []);
    expect(report).toMatchObject({ status: "stopped", stopReason: ENTER_IS_SUPERVISORS });
    expect(classifyStop(state)).toMatchObject({ retryable: false, kind: "plugin defect" });
    expect(state.sideVisit).toBeUndefined();
  });

  it("entered from the last node, settles, opens supervisor_node_settled with the receipts and reasons, and leaves to a live-path node for one correction", async () => {
    const triggers: SupervisorInput["trigger"][] = [];
    const { report, state } = await runGraph(
      [work("fix"), check("fix"), work("review"), handOver, work("arb"), check("arb"), check("fix"), work("review"), check("review"), done],
      [
        enterArb,
        back,
        (input) => (triggers.push(input.trigger), leave("fix")),
        back,
      ],
    );
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(triggers).toHaveLength(1);
    const arbReceipt = state.receipts.find((r) => r.stageId === "arb")!;
    expect(triggers[0]!.code).toBe(SUPERVISOR_NODE_SETTLED);
    expect(triggers[0]!.message).toContain(`${arbReceipt.id} (req-arb, validator node v1): arb ok: the record holds`);
    expect(triggers[0]!.message).toContain("arb → fix, arb → review");
    expect(triggers[0]!.evidenceRefs).toEqual(expect.arrayContaining(arbReceipt.evidenceRefs.slice(-1)));
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections - 1);
    expect(pathOf(state)).toEqual(["fix#2", "review#2"]);
    const visits = state.visits!;
    const arb = visits.find((v) => v.stageId === "arb")!;
    expect(arb).toMatchObject({ entered: "enter", from: 2, ended: "routed to fix", settlement: { receipts: [arbReceipt.id], reasons: [{ requirementId: "req-arb", reason: "arb ok: the record holds" }] } });
    expect(visits.find((v) => v.stageId === "fix" && v.entered === "reenter")).toMatchObject({ from: arb.seq, operation: "reenter" });
    expect(visits.filter((v) => v.ended === "replaced by reentry of fix").map((v) => v.stageId)).toEqual(["fix", "review"]);
    expect(state.sideVisit).toBeUndefined();
    expect(state.openAttempt?.["arb"]).toBeUndefined();
  });

  it("entered from the first node, leaves forward along a route from the tail with no correction and no generation bump", async () => {
    let generationAtLeave = 0;
    const { report, state } = await runGraph(
      [work("fix"), check("fix"), handOver, work("arb"), check("arb"), work("review"), check("review"), done],
      [enterArb, back, (input) => ((generationAtLeave = input.view.generation), leave("review")), back],
    );
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections);
    expect(state.generation).toBe(generationAtLeave);
    expect(pathOf(state)).toEqual(["fix#1", "review#1"]);
    expect(livePath(state).map((v) => [v.stageId, v.entered, v.operation])).toEqual([
      ["fix", "start", "intake"],
      ["review", "edge", "reenter"],
    ]);
    expect(sideOf(state)).toEqual([{ attempt: 1, from: 1, ended: "routed to review" }]);
  });

  it("leaves without a receipt when the node's work did not settle", async () => {
    const { report, state } = await runGraph(
      [work("fix"), check("fix"), work("review"), handOver, handOver, check("fix"), work("review"), check("review"), done],
      [enterArb, back, leave("fix"), back],
    );
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(sideOf(state)).toEqual([{ attempt: 1, from: 2, ended: "left without receipt" }]);
    expect(state.receipts.some((r) => r.stageId === "arb")).toBe(false);
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections - 1);
  });

  it("lets the supervisor do the node's work itself in recovery; its validation opens a new settled episode", async () => {
    const triggers: string[] = [];
    const { report, state } = await runGraph(
      [work("fix"), check("fix"), handOver, check("fix"), work("review"), check("review"), done],
      [enterArb, work("arb"), check("arb"), (input) => (triggers.push(input.trigger.code), leave("fix")), back],
    );
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(triggers).toEqual([SUPERVISOR_NODE_SETTLED]);
    expect(sideOf(state)).toEqual([{ attempt: 1, from: 1, ended: "routed to fix" }]);
  });

  it("judges a second visit afresh: its validation mints a receipt that replaces the first visit's, and settles again", async () => {
    const triggers: string[] = [];
    const settled = (to: string) => (input: SupervisorInput) => (triggers.push(input.trigger.code), leave(to));
    const { report, state } = await runGraph(
      [work("fix"), check("fix"), handOver, work("arb"), check("arb"), check("fix"), handOver, check("arb"), work("review"), check("review"), done],
      [enterArb, back, settled("fix"), back, enterArb, back, settled("review"), back],
    );
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(triggers).toEqual([SUPERVISOR_NODE_SETTLED, SUPERVISOR_NODE_SETTLED]);
    expect(state.receipts.filter((r) => r.stageId === "arb").map((r) => r.valid)).toEqual([false, true]);
    expect(sideOf(state).map((v) => [v.attempt, v.ended])).toEqual([
      [1, "routed to fix"],
      [2, "routed to review"],
    ]);
  });

  it("refuses an `enter` past maxVisits in-turn, naming the node and its visits", async () => {
    const rejections: string[] = [];
    const { report, state } = await runGraph(
      [work("fix"), check("fix"), handOver, handOver],
      [enterArb, back, leave("fix"), enterArb, (input) => (rejections.push(input.rejection?.reason ?? ""), stop({ reason: "no visits left", blocker: "arb" }, "stop"))],
      { definition: topology(1) },
    );
    expect(report).toMatchObject({ status: "stopped", stopReason: "no visits left" });
    expect(rejections).toEqual([expect.stringContaining("arb has used 1 of its 1 visits (maxVisits 1)")]);
    expect(sideOf(state)).toHaveLength(1);
  });

  it("refuses the supervisor's `enter` with a side visit open and its leave along an undeclared edge, in-turn", async () => {
    const rejections: string[] = [];
    const record = (next: SupervisorProposal) => (input: SupervisorInput) => (rejections.push(input.rejection?.reason ?? ""), next);
    const { report } = await runGraph(
      [work("fix"), check("fix"), handOver],
      [enterArb, enterArb, record(reenter({ stageId: "nope", reason: "x" }, "x")), record(stop({ reason: "gave up", blocker: "test" }, "stop"))],
    );
    expect(report).toMatchObject({ status: "stopped", stopReason: "gave up" });
    expect(rejections[0]).toContain("the side visit of arb is open");
    expect(rejections[1]).toContain("undeclared stage");
  });

  describe("the graph inside an open side visit", () => {
    const inside = (graphStep: GraphDecision) => runGraph([work("fix"), check("fix"), handOver, graphStep], [enterArb, back]);

    for (const [what, step] of [
      ["dispatches for a live-path node", work("fix")],
      ["validates a node ahead", check("review")],
      ["reenters", reenter({ stageId: "fix", reason: "again" }, "again")],
      ["stops complete", done],
    ] as const) {
      it(`is stopped when it ${what}: supervisor-only node, a final plugin defect`, async () => {
        const { report, state } = await inside(step);
        expect(report).toMatchObject({ status: "stopped", stopReason: SUPERVISOR_ONLY_NODE });
        expect(classifyStop(state)).toMatchObject({ retryable: false, kind: "plugin defect" });
        expect(state.sideVisit).toBeDefined();
      });
    }

    it("may observe, hand over and stop otherwise", async () => {
      const { report, state } = await runGraph(
        [work("fix"), check("fix"), handOver, observe({ includeWorkspaceManifest: true }, "look"), handOver, stop({ reason: "waiting", blocker: "operator" }, "wait")],
        [enterArb, back, back],
      );
      expect(report).toMatchObject({ status: "stopped", stopReason: "waiting" });
      expect(state.sideVisit).toBeDefined();
    });
  });

  it("opens supervisor_node_settled again after a resume, before the graph is asked", async () => {
    const env = await makeEnv();
    const first = await runGraph([work("fix"), check("fix"), handOver, work("arb"), check("arb")], [enterArb, back, stop({ reason: "paused", blocker: "test" }, "pause")], { env });
    expect(first.report).toMatchObject({ status: "stopped", stopReason: "paused" });
    expect(first.state.sideVisit).toBeDefined();
    const triggers: string[] = [];
    const w = world();
    const resumed = await createController().resume({
      runRef: first.report.stateDir,
      plugin: createScriptedGraph({ definition: topology(), advances: [work("review"), check("review"), done] }),
      validators: w.validators,
      runner: w.runner,
      supervisor: createScriptedSupervisor({ decisions: [(input) => (triggers.push(input.trigger.code), leave("review")), back] }),
    });
    expect(resumed.status, `${resumed.stopReason}: ${resumed.blocker}`).toBe("succeeded");
    expect(triggers).toEqual([SUPERVISOR_NODE_SETTLED]);
    // Review's validator, on resume, read Arbitrate's receipt under the admitted binding.
    const reviewInput = w.inputs.find((i) => i.requirementId === "req-review")!;
    const arbReceipt = reviewInput.receipts!.find((r) => r.stageId === "arb")!;
    expect(arbReceipt).toMatchObject({ valid: true, validatorBinding: { validatorId: "node", version: "1" } });
    expect(reviewInput.validatorBindings).toContainEqual({ requirementId: "req-arb", validatorId: "node", version: "1" });
  });

  it("gives every validator on run the run's receipts and admitted bindings", async () => {
    const { report, world: w, state } = await runGraph(
      [work("fix"), check("fix"), handOver, work("arb"), check("arb"), work("review"), check("review"), done],
      [enterArb, back, leave("review"), back],
    );
    expect(report.status).toBe("succeeded");
    const byRequirement = Object.fromEntries(w.inputs.map((i) => [i.requirementId, i]));
    expect(byRequirement["req-fix"]!.receipts).toEqual([]);
    expect(byRequirement["req-arb"]!.receipts!.map((r) => r.stageId)).toEqual(["fix"]);
    expect(byRequirement["req-review"]!.receipts!.map((r) => r.stageId)).toEqual(["fix", "arb"]);
    expect(byRequirement["req-review"]!.validatorBindings).toEqual(state.validatorBindings);
  });

  it("waits inside the node on a final stop the operator's approval lifts", async () => {
    const env = await makeEnv();
    const first = await runGraph(
      [work("fix"), check("fix"), handOver, stop({ reason: "ruling needs the operator", blocker: "approve ruling", retryable: false }, "wait for the operator")],
      [enterArb, back],
      { env },
    );
    expect(classifyStop(first.state)).toMatchObject({ retryable: false });
    const triggers: string[] = [];
    const w = world();
    const resumed = await createController().resume({
      runRef: first.report.stateDir,
      plugin: createScriptedGraph({ definition: topology(), advances: [work("arb"), check("arb"), work("review"), check("review"), done] }),
      validators: w.validators,
      runner: w.runner,
      approval: { approvalId: "ruling", decision: "approve" },
      supervisor: createScriptedSupervisor({ decisions: [(input) => (triggers.push(input.trigger.code), leave("review")), back] }),
    });
    expect(resumed.status, `${resumed.stopReason}: ${resumed.blocker}`).toBe("succeeded");
    expect(triggers).toEqual([SUPERVISOR_NODE_SETTLED]);
    expect(resumed.evidence.some((e) => (e.payload as { approvalId?: string } | undefined)?.approvalId === "ruling")).toBe(true);
  });
});
