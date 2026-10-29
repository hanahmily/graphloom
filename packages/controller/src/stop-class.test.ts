// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  stop,
  validate,
  type EvidenceRecord,
  type GraphDefinition,
  type JobSpec,
  type RunView,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type JobContext } from "@graphloom/runner";
import { createController, loadRunState, saveRunState } from "./index.js";
import { changeSinceStop, classifyStop, decideResume, FINAL_STOP_HELD_REMEDY, type StopClassification } from "./stop-class.js";
import { NO_PROGRESS_STOP_REASON, STEP_LIMIT_STOP_REASON, type DurableRunState, type StopMark } from "./state.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const stopped = (stopReason: string, extra: Partial<DurableRunState> = {}) =>
  ({ status: "stopped", stopReason, ...extra }) as Pick<DurableRunState, "status" | "stopReason" | "stopClass">;
const classOf = (stopReason: string, extra: Partial<DurableRunState> = {}): StopClassification => classifyStop(stopped(stopReason, extra))!;

describe("stop classification (§8)", () => {
  it("classifies the controller's own reasons as retryable or final", () => {
    for (const reason of [
      "job failed: agent finished without a result",
      "stale job result identity",
      "plugin host: crash",
      "plugin host restart failed",
      "environment check failed",
      "environment preparation failed",
      "environment changed",
      "pin mismatch",
      "worktree mismatch",
      "reconcile required",
      "supervisor provider quota: 429 rate limited",
      "supervisor decide failed",
      "reviewer_unavailable",
      STEP_LIMIT_STOP_REASON,
      NO_PROGRESS_STOP_REASON,
      // A recovery trigger's own message, when no supervisor was configured.
      "executor graphloom.agent/run failed: agent finished without a result",
    ]) {
      expect(classOf(reason), reason).toMatchObject({ by: "controller", retryable: true });
    }
    for (const reason of [
      "budgets exhausted",
      "decisions budget exhausted",
      "agentInvocations budget exhausted",
      "corrections budget exhausted",
      "wait budget exhausted",
      "active time budget exhausted",
      "unsupported action in normal mode: accept",
    ]) {
      expect(classOf(reason), reason).toMatchObject({ by: "controller", retryable: false });
    }
    // The operator's own stop is final, and the resume answers it.
    expect(classOf("operator stop")).toMatchObject({ retryable: false, liftedByResume: true });
  });

  it("takes a graph's or supervisor's own class over any reason text, and classifies nothing for a run that is not stopped", () => {
    expect(classOf("operator stop", { stopClass: { by: "graph", retryable: true } })).toMatchObject({ by: "graph", retryable: true });
    expect(classOf("job failed: x", { stopClass: { by: "supervisor", retryable: false } })).toMatchObject({ by: "supervisor", retryable: false });
    expect(classifyStop({ status: "running", stopReason: "operator stop" })).toBeUndefined();
  });

  it("names what changed since a final stop: the plugin, the version, the workspace change, or a raised budget", () => {
    const mark: StopMark = { activeVersion: "g@1", manifestDigest: "m", entryDigest: "e", candidateDigest: "c", budgets: { agentInvocations: 0, jobs: 3, decisions: 4, corrections: 0, activeMs: 1_000 } };
    const now = (patch: Partial<StopMark> = {}, pluginUpdated = false) => ({ pluginUpdated, mark: { ...mark, ...patch, budgets: { ...mark.budgets, ...patch.budgets } } });
    expect(changeSinceStop(mark, now())).toBeUndefined();
    // Time the run spent after the mark is not a change.
    expect(changeSinceStop(mark, now({ budgets: { ...mark.budgets, activeMs: 900 } }))).toBeUndefined();
    expect(changeSinceStop(mark, now({}, true))).toMatch(/updated the plugin/);
    expect(changeSinceStop(mark, now({ activeVersion: "g@1+r1" }))).toMatch(/active version/);
    expect(changeSinceStop(mark, now({ entryDigest: "e2" }))).toMatch(/bundle changed/);
    expect(changeSinceStop(mark, now({ candidateDigest: "c2" }))).toMatch(/workspace change/);
    expect(changeSinceStop(mark, now({ budgets: { ...mark.budgets, agentInvocations: 5 } }))).toBe("the agentInvocations budget was raised from 0 to 5");
  });

  it("counts a different GraphLoom build as a change, so a fix to GraphLoom itself lifts a final stop", () => {
    const mark: StopMark = { activeVersion: "g@1", manifestDigest: "m", entryDigest: "e", budgets: { jobs: 3 }, hostBuild: "0.0.0-dev+967231e" };
    const now = (hostBuild?: string) => ({ pluginUpdated: false, mark: { ...mark, ...(hostBuild !== undefined ? { hostBuild } : { hostBuild: undefined }) } });
    expect(changeSinceStop(mark, now("0.0.0-dev+967231e"))).toBeUndefined();
    expect(changeSinceStop(mark, now("0.0.0-dev+76dddd7"))).toBe("GraphLoom changed from 0.0.0-dev+967231e to 0.0.0-dev+76dddd7");
    // A caller that does not know its build changes nothing.
    expect(changeSinceStop(mark, now())).toBeUndefined();
    // A mark recorded before builds were: the first build-aware resume may run again.
    const { hostBuild: _b, ...older } = mark;
    void _b;
    expect(changeSinceStop(older, { pluginUpdated: false, mark: { ...older, hostBuild: "0.1.0" } })).toBe("GraphLoom changed from an unrecorded build to 0.1.0");
    const stopped = { status: "stopped", stopReason: "x", stopClass: { by: "supervisor", retryable: false }, stopMark: { ...mark, stopReason: "x" } } as unknown as DurableRunState;
    expect(decideResume(stopped, { pluginUpdated: false, mark: { ...mark, stopReason: "x" } })).toMatchObject({ run: false });
    expect(decideResume(stopped, { pluginUpdated: false, mark: { ...mark, stopReason: "x", hostBuild: "0.0.0-dev+76dddd7" } })).toMatchObject({ run: true, lifted: expect.stringMatching(/GraphLoom changed/) });
  });

  it("retries a final stop recorded before stop marks existed", () => {
    const old = { status: "stopped", stopReason: "budgets exhausted" } as DurableRunState;
    expect(decideResume(old, { pluginUpdated: false, mark: {} as StopMark })).toMatchObject({ run: true, previous: { retryable: false } });
  });
});

// The hello bundle's definition, routed by scripted decisions in process.
const definition: GraphDefinition = {
  graphId: "hello",
  version: "0.1.0",
  stages: [
    { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
    { id: "review", name: "Review", requirementIds: ["independent-review"] },
  ],
  requirements: [
    {
      id: "greeting-bytes",
      statement:
        "GREETING.txt contains exactly the UTF-8 bytes Hello, GraphLoom!\\n and is the only changed path in the workspace (excluding Git metadata).",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: "independent-review",
      statement: "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    { requirementId: "independent-review", validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" },
  ],
};
const latest = (evidence: EvidenceRecord[], kind: string) => [...evidence].reverse().find((e) => e.kind === kind)?.payload as Record<string, unknown> | undefined;
const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate: ({ evidence }) => (latest(evidence, "file")?.bytes === "Hello, GraphLoom!\n" ? { status: "passed", reason: "ok" } : { status: "inconclusive", reason: "missing" }),
  },
  "independent-reviewer": {
    evaluate: ({ evidence }) => (latest(evidence, "review")?.verdict === "approved" ? { status: "passed", reason: "ok" } : { status: "inconclusive", reason: "missing" }),
  },
};

/** A scripted graph that records every view it is shown. */
function graph(advances: ScriptedAdvance[]) {
  const views: RunView[] = [];
  const plugin = createScriptedGraph({
    definition,
    advances: advances.map((step) => (view: RunView, i: number) => {
      views.push(view);
      return typeof step === "function" ? step(view, i) : step;
    }),
  });
  return { plugin, views };
}

/** Writes the greeting, has it reviewed, and completes. */
const completes: ScriptedAdvance[] = [
  dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: ["GREETING.txt"] }, "write"),
  observe({ paths: ["GREETING.txt"], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write" }, "validate write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review" }, "validate review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];
/** The writer writes the greeting and the reviewer approves, whichever is asked. */
const agent = async (job: JobSpec, ctx: JobContext) => {
  if (job.purpose === "review") return { status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }] };
  await writeFile(path.join(ctx.worktreePath, "GREETING.txt"), "Hello, GraphLoom!\n");
  return { status: "ok" as const, summary: "wrote" };
};
const agents = () => createScriptedRunner({ jobs: [agent, agent, agent, agent] });

describe("resume after a stop (§8)", () => {
  it("surfaces the same blocker after a final graph stop until a budget is raised, then tells the graph about the resume", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = graph([stop({ reason: "needs maintainer decision", blocker: "Which metric should count?", retryable: false }, "ask")]);
    const report = await controller.run({ taskPath: env.taskPath, plugin: first.plugin, validators, runner: agents(), stateRoot: env.stateRoot, runId: "final" });
    expect(report).toMatchObject({ status: "stopped", stopReason: "needs maintainer decision", stopRetryable: false });
    const before = await loadRunState(report.stateDir);
    expect(before.stopClass).toEqual({ by: "graph", retryable: false, reason: "needs maintainer decision" });
    expect(before.stopMark).toMatchObject({ activeVersion: before.activeVersion, budgets: before.budgets });

    // Nothing changed: the graph is not asked again.
    const idle = graph([]);
    const held = await controller.resume({ runRef: report.stateDir, plugin: idle.plugin, validators, runner: agents() });
    expect(held).toMatchObject({ status: "stopped", stopReason: "needs maintainer decision", blocker: "Which metric should count?", generation: before.generation });
    expect(idle.views).toEqual([]);
    const afterHold = await loadRunState(report.stateDir);
    expect(afterHold.remedies?.at(-1)).toMatchObject({ condition: "resumed after a final stop (graph stop (final): needs maintainer decision)", remedy: FINAL_STOP_HELD_REMEDY });
    expect(afterHold.lastResume).toBeUndefined();
    // Holding again is just as quiet: no loop.
    expect((await controller.resume({ runRef: report.stateDir, plugin: idle.plugin, validators, runner: agents() })).status).toBe("stopped");
    expect(idle.views).toEqual([]);

    // The operator raises a budget: the graph is asked again and told why it runs.
    await saveRunState({ ...afterHold, budgets: { ...afterHold.budgets, agentInvocations: afterHold.budgets.agentInvocations + 10 } });
    const resumed = graph(completes);
    const done = await controller.resume({ runRef: report.stateDir, plugin: resumed.plugin, validators, runner: agents() });
    expect(done.status, `${done.stopReason}: ${done.blocker}`).toBe("succeeded");
    const view = resumed.views[0]!;
    expect(view.resume).toMatchObject({ generation: view.generation, pluginUpdated: false, previousStopReason: "needs maintainer decision", previousStopRetryable: false });
    const state = await loadRunState(done.stateDir);
    expect(state.remedies?.at(-1)?.remedy).toMatch(/^ran the graph again: the agentInvocations budget was raised/);
    expect(state.stopClass).toBeUndefined();
  }, 60_000);

  it("runs a final stop again when GraphLoom itself changed, and holds it on the same build", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = graph([stop({ reason: "host fault", blocker: "the agent cannot start in its sandbox", retryable: false }, "stop")]);
    const report = await controller.run({ taskPath: env.taskPath, plugin: first.plugin, validators, runner: agents(), stateRoot: env.stateRoot, runId: "host-build", hostBuild: "0.0.0-dev+967231e" });
    expect(report).toMatchObject({ status: "stopped", stopRetryable: false });
    expect((await loadRunState(report.stateDir)).stopMark).toMatchObject({ hostBuild: "0.0.0-dev+967231e" });

    // The same build: held, the graph is not asked.
    const idle = graph([]);
    const held = await controller.resume({ runRef: report.stateDir, plugin: idle.plugin, validators, runner: agents(), hostBuild: "0.0.0-dev+967231e" });
    expect(held.status).toBe("stopped");
    expect(idle.views).toEqual([]);

    // The operator fixed GraphLoom and rebuilt it: the graph runs again, and the run records the new build.
    const resumed = graph(completes);
    const done = await controller.resume({ runRef: report.stateDir, plugin: resumed.plugin, validators, runner: agents(), hostBuild: "0.0.0-dev+76dddd7" });
    expect(done.status, `${done.stopReason}: ${done.blocker}`).toBe("succeeded");
    const state = await loadRunState(done.stateDir);
    expect(state.remedies?.at(-1)?.remedy).toBe("ran the graph again: GraphLoom changed from 0.0.0-dev+967231e to 0.0.0-dev+76dddd7");
    expect(state.hostBuild).toBe("0.0.0-dev+76dddd7");
  }, 60_000);

  it("classifies a preflight failure during a resume on its own, so the next resume retries once it is fixed", async () => {
    const env = await makeEnv({}, { copyBundle: true });
    const controller = createController();
    const first = graph([stop({ reason: "needs maintainer decision", blocker: "Which metric should count?", retryable: false }, "ask")]);
    const report = await controller.run({ taskPath: env.taskPath, plugin: first.plugin, validators, runner: agents(), stateRoot: env.stateRoot, runId: "preflight" });
    expect(report).toMatchObject({ status: "stopped", stopRetryable: false });

    // The operator edits the installed bundle: the resume's pin check stops the run anew.
    const manifest = path.join(env.bundlePath, "graphloom.manifest.json");
    const pinned = await readFile(manifest, "utf8");
    await writeFile(manifest, `${pinned}\n`);
    const idle = graph([]);
    const mismatch = await controller.resume({ runRef: report.stateDir, plugin: idle.plugin, validators, runner: agents() });
    expect(mismatch).toMatchObject({ status: "stopped", stopReason: "pin mismatch", stopRetryable: true });
    const state = await loadRunState(report.stateDir);
    expect(state.stopClass).toBeUndefined();
    expect(state.stopMark).toBeUndefined();

    // Fixed: the next resume retries rather than holding the old, already answered blocker.
    await writeFile(manifest, pinned);
    const resumed = graph(completes);
    const done = await controller.resume({ runRef: report.stateDir, plugin: resumed.plugin, validators, runner: agents() });
    expect(done.status, `${done.stopReason}: ${done.blocker}`).toBe("succeeded");
    expect(resumed.views[0]!.resume).toMatchObject({ previousStopReason: "pin mismatch", previousStopRetryable: true });
  }, 60_000);

  it("ignores a class or mark recorded for a different stop reason", () => {
    const mark = { stopReason: "needs maintainer decision", activeVersion: "g@1", manifestDigest: "m", entryDigest: "e", budgets: { agentInvocations: 1, jobs: 1, decisions: 1, corrections: 1 } } as StopMark;
    const overwritten = { status: "stopped", stopReason: "pin mismatch", stopClass: { by: "graph", retryable: false, reason: "needs maintainer decision" }, stopMark: mark } as DurableRunState;
    expect(classifyStop(overwritten)).toMatchObject({ by: "controller", retryable: true });
    const budget = { status: "stopped", stopReason: "budgets exhausted", stopMark: mark } as DurableRunState;
    expect(decideResume(budget, { pluginUpdated: false, mark })).toMatchObject({ run: true });
  });

  it("asks the graph again after a stop it did not mark final, and says which generation the resume began", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = graph([stop({ reason: "delivery failed", blocker: "branch exists" }, "could not deliver")]);
    const report = await controller.run({ taskPath: env.taskPath, plugin: first.plugin, validators, runner: agents(), stateRoot: env.stateRoot, runId: "retry" });
    expect(report).toMatchObject({ status: "stopped", stopRetryable: true });
    expect(first.views[0]!.resume).toBeUndefined();

    const resumed = graph(completes);
    const done = await controller.resume({ runRef: report.stateDir, plugin: resumed.plugin, validators, runner: agents() });
    expect(done.status, `${done.stopReason}: ${done.blocker}`).toBe("succeeded");
    // Every view after the resume carries it: evidence older than its generation predates it.
    expect(resumed.views.every((v) => v.resume?.generation === resumed.views[0]!.generation)).toBe(true);
    expect(resumed.views[0]!.resume).toMatchObject({ previousStopReason: "delivery failed", previousStopRetryable: true });
    expect((await controller.inspect(done.stateDir)).lastResume?.previousStopReason).toBe("delivery failed");
  }, 60_000);

  it("holds a run stopped on a spent controller budget until the operator raises it", async () => {
    const env = await makeEnv({ decisions: 2 });
    const controller = createController();
    const first = graph(completes);
    const report = await controller.run({ taskPath: env.taskPath, plugin: first.plugin, validators, runner: agents(), stateRoot: env.stateRoot, runId: "budget" });
    expect(report).toMatchObject({ status: "stopped", stopReason: "decisions budget exhausted", stopRetryable: false });

    const idle = graph([]);
    const held = await controller.resume({ runRef: report.stateDir, plugin: idle.plugin, validators, runner: agents() });
    expect(held).toMatchObject({ status: "stopped", stopReason: "decisions budget exhausted", generation: report.generation });
    expect(idle.views).toEqual([]);

    const state = await loadRunState(report.stateDir);
    await saveRunState({ ...state, budgets: { ...state.budgets, decisions: 20 } });
    const rest = graph(completes.slice(2));
    const done = await controller.resume({ runRef: report.stateDir, plugin: rest.plugin, validators, runner: agents() });
    expect(done.status, `${done.stopReason}: ${done.blocker}`).toBe("succeeded");
    expect(rest.views[0]!.resume?.previousStopReason).toBe("decisions budget exhausted");
  }, 60_000);
});

async function makeEnv(budgets: Record<string, number> = {}, options: { copyBundle?: boolean } = {}): Promise<{ taskPath: string; stateRoot: string; bundlePath: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-stopclass-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git("add", "README.md");
  await git("commit", "-q", "-m", "init");
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  const bundlePath = path.join(taskDir, "plugins/hello");
  if (options.copyBundle === true) await cp(helloBundle, bundlePath, { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
  else await symlink(helloBundle, bundlePath);
  const taskPath = path.join(taskDir, "task.yaml");
  const budgetLines = Object.entries(budgets).map(([k, v]) => `  ${k}: ${v}\n`).join("");
  await writeFile(
    taskPath,
    `graph: hello\nrepo: ./test-repo\nrequest: |\n  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by\n  one newline. Do not modify other files.\n${budgetLines.length > 0 ? `budgets:\n${budgetLines}` : ""}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state"), bundlePath };
}
