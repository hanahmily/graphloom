// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The shipped plugins on the traversal engine (docs/design-graph-topology.md
 * §2, §3.3, §12 item 2): each plugin's reliances, as named cases. They
 * declare no edges and keep `sdkProtocol: 1`; the engine runs them as
 * implicit chains. issue-fix 0.17.0 is the exception: it declares its
 * topology (Fix ⇄ Review and the supervisor-only Arbitrate) at `sdkProtocol: 2`.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertGraphDefinition,
  createScriptedGraph,
  dispatch,
  normalizeTopology,
  reenter,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type JobSpec,
  type Receipt,
  type RunView,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";
import type { DurableRunState } from "./state.js";
import { livePath, moveTo, reentryRefusal, startPath, UNDECLARED_EDGE } from "./traversal.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const pluginsRoot = path.join(repoRoot, "examples/plugins");

/**
 * Each shipped plugin's stage ids, in order: hello's and release's from their
 * manifests; issue-fix, pr-review and pr-design-review describe theirs per
 * profile (`definitionFor`), with these ids (issue-fix/src/constants.ts,
 * review-kit/src/constants.ts).
 */
const SHIPPED: Record<string, string[]> = {
  hello: manifestStages("hello"),
  release: manifestStages("release"),
  "pr-review": ["fetch", "report", "review", "draft", "publish"],
  "pr-design-review": ["fetch", "report", "questions", "answers", "round1", "publish"],
};

/**
 * issue-fix 0.17.0 declares its topology (§3.1): Fix ⇄ Review as two edges,
 * and the supervisor-only Arbitrate leaving to either. Its stages and
 * requirements come from a profile, so its manifest pins none; this is the
 * shape `definitionFor` returns, on this test's node requirements.
 */
function issueFixTopology(): GraphDefinition {
  const base = chain(["fix", "review", "arbitrate"], "issue-fix");
  return {
    ...base,
    stages: base.stages.map((s) => (s.id === "arbitrate" ? { ...s, entry: "supervisor" as const, maxVisits: 6 } : s)),
    edges: [
      { from: "fix", to: "review" },
      { from: "review", to: "fix" },
      { from: "arbitrate", to: "fix" },
      { from: "arbitrate", to: "review" },
    ],
    start: "fix",
    terminal: ["review"],
  };
}

function manifestStages(plugin: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(pluginsRoot, plugin, "graphloom.manifest.json"), "utf8")) as { stages?: Array<{ id: string }> };
  return (manifest.stages ?? []).map((s) => s.id);
}

function chain(ids: string[], graphId = "topo"): GraphDefinition {
  return {
    graphId,
    version: "1.0.0",
    stages: ids.map((id) => ({ id, name: id, requirementIds: [`req-${id}`] })),
    requirements: ids.map((id) => ({ id: `req-${id}`, statement: `${id} is done`, evidenceSchema: "node-v1" })),
    defaultValidators: ids.map((id) => ({ requirementId: `req-${id}`, validatorId: "node", version: "1" })),
  };
}

const receipt = (stageId: string, i: number): Receipt => ({
  id: `rcpt-${i}`,
  stageId,
  requirementId: `req-${stageId}`,
  validatorBinding: { requirementId: `req-${stageId}`, validatorId: "node", version: "1" },
  candidateFingerprint: "fp",
  evidenceRefs: [],
  valid: true,
  acceptedIdentity: {},
});

/** A normal-mode state whose live path holds every stage of `ids`, each accepted. */
function throughAll(ids: string[], definition: GraphDefinition = chain(ids)): DurableRunState {
  let state = {
    definition,
    current: { stageId: ids[0]!, attempt: 1 },
    receipts: ids.map(receipt),
    generation: 1,
    stateRevision: 0,
    mode: "normal",
    ...startPath(definition, 1),
  } as unknown as DurableRunState;
  for (const id of ids.slice(1)) {
    const moved = moveTo(state, id, 1, "dispatch");
    if ("refusal" in moved) throw new Error(moved.refusal.detail);
    state = moved.state;
  }
  return state;
}

describe("the shipped plugins are implicit chains", () => {
  for (const plugin of Object.keys(SHIPPED)) {
    it(`${plugin} states sdkProtocol 1 and declares no topology`, () => {
      const manifest = JSON.parse(readFileSync(path.join(pluginsRoot, plugin, "graphloom.manifest.json"), "utf8")) as { sdkProtocol?: number; stages?: Array<Record<string, unknown>> };
      expect(manifest.sdkProtocol).toBe(1);
      for (const stage of manifest.stages ?? []) expect(Object.keys(stage).sort()).toEqual(["id", "name", "requirementIds"]);
      const topology = normalizeTopology(chain(SHIPPED[plugin]!));
      expect(topology).toMatchObject({ implicit: true, start: SHIPPED[plugin]![0], terminal: [SHIPPED[plugin]!.at(-1)] });
    });
  }

  it("issue-fix 0.17.0 states sdkProtocol 2 and declares its topology, which the definition rules accept", () => {
    const manifest = JSON.parse(readFileSync(path.join(pluginsRoot, "issue-fix", "graphloom.manifest.json"), "utf8")) as { sdkProtocol?: number };
    expect(manifest.sdkProtocol).toBe(2);
    expect(() => assertGraphDefinition(issueFixTopology())).not.toThrow();
    expect(normalizeTopology(issueFixTopology())).toMatchObject({ implicit: false, start: "fix", terminal: ["review"] });
  });
});

describe("reentries the shipped graphs make, along implicit back edges (§2)", () => {
  const cases: Array<[string, string, string, string]> = [
    ["hello", "Review → Write", "review", "write"], // examples/plugins/hello/src/graph.ts:325
    ["release", "Review → Changelog", "review", "changelog"], // examples/plugins/release/src/graph.ts:212
  ];
  for (const [plugin, name, from, to] of cases) {
    it(`${plugin}: ${name} is admitted from the graph`, () => {
      const state = throughAll(SHIPPED[plugin]!);
      expect(livePath(state).at(-1)!.stageId).toBe(from);
      expect(reentryRefusal(state, to)).toBeUndefined();
    });
  }

  // issue-fix 0.17.0 reenters Fix after a failed review and after failed final checks along its declared edge review → fix.
  it("issue-fix: Review → Fix is admitted from the graph along the declared edge", () => {
    const state = throughAll(["fix", "review"], issueFixTopology());
    expect(livePath(state).at(-1)!.stageId).toBe("review");
    expect(reentryRefusal(state, "fix")).toBeUndefined();
  });

  it("a reentry of a stage ahead of the live path is refused", () => {
    const ids = SHIPPED["release"]!;
    const state = { ...throughAll(ids.slice(0, 1).concat()), definition: chain(ids) } as DurableRunState;
    expect(reentryRefusal(state, "review")?.precondition).toBe(UNDECLARED_EDGE);
  });
});

// ---------------------------------------------------------------------------
// Runs of the real controller.

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop()!;
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeRepo(taskDir: string): Promise<void> {
  const repoPath = path.join(taskDir, "repo");
  await mkdir(repoPath, { recursive: true });
  const git = (...args: string[]) =>
    execFileAsync("git", args, { cwd: repoPath, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });
  await git("init", "-q");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "init");
}

describe("hello on the engine", () => {
  const GREETING = "Hello, GraphLoom!\n";

  it("reenters Write from Review along the implicit back edge and completes (examples/plugins/hello/src/graph.ts:325)", async () => {
    if (!existsSync(path.join(pluginsRoot, "hello/dist/index.js"))) {
      await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
    }
    const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-topo-hello-")));
    temps.push(taskDir);
    await makeRepo(taskDir);
    await mkdir(path.join(taskDir, "plugins"), { recursive: true });
    await symlink(path.join(pluginsRoot, "hello"), path.join(taskDir, "plugins", "hello"));
    const taskPath = path.join(taskDir, "task.yaml");
    await writeFile(taskPath, 'graph: hello\nrepo: ./repo\nrequest: |\n  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by\n  one newline. Do not modify other files.\n', "utf8");
    let reviews = 0;
    const report = await createController().run({
      taskPath,
      runner: createScriptedRunner({
        jobs: Array.from({ length: 8 }, () => async (job: JobSpec, ctx: { worktreePath: string }) => {
          if (job.purpose === "review" || job.readOnly === true) {
            reviews += 1;
            const verdict = reviews === 1 ? "request_changes" : "approved";
            return { status: "ok" as const, summary: verdict, evidence: [{ kind: "review" as const, payload: { verdict, summary: verdict } }] };
          }
          await writeFile(path.join(ctx.worktreePath, "GREETING.txt"), GREETING, "utf8");
          return { status: "ok" as const, summary: "wrote" };
        }),
      }),
      stateRoot: path.join(taskDir, "state"),
      runId: "hello-engine",
    });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const reentry = state.visits?.find((v) => v.entered === "reenter");
    expect(reentry).toMatchObject({ stageId: "write", operation: "reenter" });
    expect(state.visits?.find((v) => v.seq === reentry!.from)?.stageId).toBe("review");
    expect(livePath(state).map((v) => v.stageId)).toEqual(["write", "review"]);
  });
});

/**
 * A graph that acts like the shipped "first incomplete or open stage"
 * selection (issue-fix/src/graph.ts:332-338, pr-review/src/graph.ts:312,
 * pr-design-review/src/graph.ts:307): work, then validate, the first stage
 * whose receipts are missing or whose attempt a reentry opened; `complete`
 * when there is none.
 */
function firstIncomplete(definition: GraphDefinition, worked: Set<string>, hold?: string): (view: RunView) => GraphDecision {
  return (view: RunView): GraphDecision => {
    const stage = definition.stages.find(
      (s) => !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) || view.openAttempt?.[s.id] === true,
    );
    const at = stage?.id ?? "end";
    if (at === hold && !worked.has(`${at}:held`)) {
      worked.add(`${at}:held`);
      return supervise({ reason: `${at} needs the supervisor` }, "hand over");
    }
    if (stage === undefined) return stop({ reason: "complete", blocker: "none" }, "every stage has valid receipts");
    const key = `${stage.id}#${view.current.stageId === stage.id ? view.current.attempt : 0}`;
    if (!worked.has(key) && view.openAttempt?.[stage.id] !== true) {
      worked.add(key);
      return dispatch({ stageId: stage.id, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `work ${stage.id}` }, `work ${stage.id}`);
    }
    return validate({ stageId: stage.id }, `validate ${stage.id}`);
  };
}

async function runChain(ids: string[], options: { hold?: string; supervisorTo?: string; runId: string }) {
  const definition = chain(ids);
  const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-topo-chain-")));
  temps.push(taskDir);
  await makeRepo(taskDir);
  const bundle = path.join(taskDir, "plugins", "topo");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify({ graphId: "topo", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./dist/index.js" } }), "utf8");
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: |\n  Walk the chain.\n", "utf8");
  const worked = new Set<string>();
  const step = firstIncomplete(definition, worked, options.hold);
  const validators: Record<string, Validator> = {
    node: {
      evaluate(input) {
        const node = input.requirementId.replace(/^req-/, "");
        return input.evidence.some((e) => (e.payload as { node?: string } | undefined)?.node === node) ? { status: "passed", reason: "ok" } : { status: "inconclusive", reason: "no record" };
      },
    },
  };
  const views: RunView[] = [];
  const report = await createController().run({
    taskPath,
    plugin: createScriptedGraph({
      definition,
      advances: Array.from({ length: 60 }, () => (view: RunView) => {
        views.push(view);
        return step(view);
      }),
    }),
    validators,
    runner: createScriptedRunner({
      jobs: Array.from({ length: 60 }, () => async (job: JobSpec) => ({ status: "ok" as const, summary: job.instruction, evidence: [{ kind: "other" as const, payload: { node: job.stageId } }] })),
    }),
    ...(options.supervisorTo !== undefined
      ? {
          supervisor: createScriptedSupervisor({
            decisions: [
              (input) => reenter({ stageId: options.supervisorTo!, reason: "redo it", evidenceRefs: [input.view.evidence.at(-1)!.ref] }, "reenter the first stage"),
              () => returnToNormal({ summary: "reentered" }, "back to the graph"),
            ],
          }),
        }
      : {}),
    stateRoot: path.join(taskDir, "state"),
    runId: options.runId,
  });
  return { report, state: await loadRunState(report.stateDir), views };
}

describe("five-stage chains after a supervisor reentry of the first stage (pr-review's stages)", () => {
  const ids = SHIPPED["pr-review"]!;

  it("the graph's dispatch for the first incomplete stage is a forward move with carried visits", async () => {
    // Fetch to Draft accepted; the graph hands over at Publish; the supervisor reenters Fetch.
    const { report, state, views } = await runChain(ids, { hold: "publish", supervisorTo: "fetch", runId: "carry-dispatch" });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    const reentry = state.visits!.find((v) => v.entered === "reenter")!;
    expect(reentry.stageId).toBe("fetch");
    const after = state.visits!.filter((v) => v.seq > reentry.seq);
    expect(after.map((v) => [v.stageId, v.entered, v.operation])).toEqual([
      ["report", "carried", "dispatch"],
      ["review", "carried", "dispatch"],
      ["draft", "carried", "dispatch"],
      ["publish", "edge", "dispatch"],
    ]);
    expect(livePath(state).map((v) => v.stageId)).toEqual(ids);
    // `current` keeps following every dispatch and validation, as plugins read it.
    expect(views.at(-1)!.current.stageId).toBe("publish");
  });

  it("the reentered stage validates again and a `complete` stop carries the accepted later stages and succeeds", async () => {
    // Every stage accepted; the graph hands over before stopping; the supervisor reenters Report, keeping the candidate.
    const { report, state } = await runChain(ids, { hold: "end", supervisorTo: "report", runId: "carry-complete" });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(livePath(state).map((v) => [v.stageId, v.entered])).toEqual([
      ["fetch", "start"],
      ["report", "reenter"],
      ["review", "carried"],
      ["draft", "carried"],
      ["publish", "carried"],
    ]);
    expect(state.openAttempt ?? {}).toEqual({});
    // Report's receipt from before the reentry still stands: the same candidate under the same bindings.
    expect(state.receipts.filter((r) => r.stageId === "report").map((r) => r.valid)).toEqual([true]);
  });
});

describe("current follows a supporting dispatch for an earlier stage", () => {
  it("keeps the live path while `current` moves back to the stage the job names", async () => {
    const ids = ["a", "b", "c"];
    const definition = chain(ids);
    const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-topo-support-")));
    temps.push(taskDir);
    await makeRepo(taskDir);
    const bundle = path.join(taskDir, "plugins", "topo");
    await mkdir(path.join(bundle, "dist"), { recursive: true });
    await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify({ graphId: "topo", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./dist/index.js" } }), "utf8");
    await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
    const taskPath = path.join(taskDir, "task.yaml");
    await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: |\n  Walk.\n", "utf8");
    const job = (stageId: string) => dispatch({ stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `work ${stageId}` }, `work ${stageId}`);
    const views: RunView[] = [];
    const seen = (decision: GraphDecision): ScriptedAdvance => (view) => {
      views.push(view);
      return decision;
    };
    const report = await createController().run({
      taskPath,
      plugin: createScriptedGraph({ definition, advances: [seen(job("a")), seen(job("b")), seen(dispatch({ stageId: "a", kind: "command", purpose: "diagnostic", readOnly: true, instruction: "support a" }, "support a")), seen(stop({ reason: "paused", blocker: "checked" }, "pause"))] }),
      validators: { node: { evaluate: () => ({ status: "passed", reason: "ok" }) } },
      runner: createScriptedRunner({ jobs: Array.from({ length: 4 }, () => async () => ({ status: "ok" as const, summary: "ok" })) }),
      stateRoot: path.join(taskDir, "state"),
      runId: "support",
    });
    expect(report.stopReason).toBe("paused");
    expect(views.at(-1)!.current.stageId).toBe("a");
    expect(views.at(-1)!.topology?.path.map((v) => v.stageId)).toEqual(["a", "b"]);
  });
});
