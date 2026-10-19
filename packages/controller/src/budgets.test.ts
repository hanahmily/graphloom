import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  returnToNormal,
  stop,
  validate,
  type EvidenceRecord,
  type GraphDefinition,
  type JobSpec,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type JobContext } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { applyGraphDefaultBudgets, CONTROLLER_DEFAULT_BUDGETS, IntakeError, createController, intakeTask, loadRunState, resolveRunBudgets, saveRunState } from "./index.js";
import { budgetGranted, budgetsUsed, legacyBudgetUsage } from "./budget-usage.js";
import type { DurableRunState } from "./state.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

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
const completes: ScriptedAdvance[] = [
  dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: ["GREETING.txt"] }, "write"),
  observe({ paths: ["GREETING.txt"], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write" }, "validate write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review" }, "validate review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];
const agent = async (job: JobSpec, ctx: JobContext) => {
  if (job.purpose === "review") return { status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }] };
  await writeFile(path.join(ctx.worktreePath, "GREETING.txt"), "Hello, GraphLoom!\n");
  return { status: "ok" as const, summary: "wrote" };
};
const agents = () => createScriptedRunner({ jobs: [agent, agent, agent, agent] });

/** Edits state.json the way an operator does: by hand, outside the controller. */
async function editByHand(stateDir: string, edit: (raw: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(stateDir, "state.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  edit(raw);
  await writeFile(file, JSON.stringify(raw, null, 2), "utf8");
}

describe("budget layers (#150)", () => {
  it("applies controller defaults, then the graph's defaultBudgets, then the task's budgets", () => {
    expect(resolveRunBudgets()).toEqual({ ...CONTROLLER_DEFAULT_BUDGETS, recoveryReserve: 8 });
    const graph = { agentInvocations: 1800, jobs: 240, activeMs: 36_000_000 };
    expect(resolveRunBudgets(undefined, graph)).toEqual({ ...CONTROLLER_DEFAULT_BUDGETS, ...graph, recoveryReserve: 90 });
    // The task wins key by key; the reserve follows the resulting total.
    expect(resolveRunBudgets({ agentInvocations: 400, decisions: 99 }, graph)).toMatchObject({ agentInvocations: 400, jobs: 240, decisions: 99, recoveryReserve: 20 });
    expect(resolveRunBudgets({ recoveryReserve: 5 }, { ...graph, recoveryReserve: 50 }).recoveryReserve).toBe(5);
  });

  it("keeps every layer finite and the reserve below the agent budget", () => {
    expect(() => resolveRunBudgets(undefined, { agentInvocations: 10, recoveryReserve: 10 })).toThrow(IntakeError);
    expect(() => resolveRunBudgets({ agentInvocations: 10 }, { recoveryReserve: 12 })).toThrow(/must be less than budgets.agentInvocations/);
    expect(() => resolveRunBudgets(undefined, { jobs: 0 })).toThrow(/graph defaultBudgets jobs must be a positive integer/);
    expect(() => resolveRunBudgets(undefined, { jobs: Number.POSITIVE_INFINITY })).toThrow(/positive integer/);
    expect(() => resolveRunBudgets(undefined, { tokens: 3 } as never)).toThrow(/unknown graph defaultBudgets key: tokens/);
  });

  it("judges a task's recoveryReserve against the graph's agentInvocations, not the controller's (#151 review)", async () => {
    const env = await makeEnv({ recoveryReserve: 100 });
    // Intake alone checks each value; the controller's 64 calls are only provisional.
    const intake = await intakeTask(env.taskPath);
    expect(intake.budgets).toMatchObject({ agentInvocations: 64, recoveryReserve: 100 });
    expect(applyGraphDefaultBudgets(intake, { defaultBudgets: { agentInvocations: 1800 } }).budgets).toMatchObject({ agentInvocations: 1800, recoveryReserve: 100 });
    expect(() => applyGraphDefaultBudgets(intake, { defaultBudgets: { agentInvocations: 50 } })).toThrow(
      "budgets.recoveryReserve (100) must be less than budgets.agentInvocations (50), leaving room for at least one normal-mode agent call",
    );
    // A graph that declares no defaults leaves the controller's, checked the same way.
    expect(() => applyGraphDefaultBudgets(intake, {})).toThrow(/recoveryReserve \(100\) must be less than budgets.agentInvocations \(64\)/);

    // Through a real run: accepted with 1800/100 ...
    const controller = createController();
    const plugin = (agentInvocations: number) =>
      createScriptedGraph({ definition: { ...definition, defaultBudgets: { agentInvocations } }, advances: [stop({ reason: "paused", blocker: "none" }, "pause")] });
    const report = await controller.run({ taskPath: env.taskPath, plugin: plugin(1800), validators, runner: agents(), stateRoot: env.stateRoot, runId: "reserve-ok" });
    expect(report.status).toBe("stopped");
    expect((await loadRunState(report.stateDir)).budgets).toMatchObject({ agentInvocations: 1800, recoveryReserve: 100 });
    // ... and refused, before any state is written, under a graph defaulting to 50.
    await expect(
      controller.run({ taskPath: env.taskPath, plugin: plugin(50), validators, runner: agents(), stateRoot: env.stateRoot, runId: "reserve-refused" }),
    ).rejects.toThrow("budgets.recoveryReserve (100) must be less than budgets.agentInvocations (50)");
    expect(existsSync(path.join(env.stateRoot, "reserve-refused", "state.json"))).toBe(false);
  }, 60_000);

  it("starts a run with the graph's declared defaults under the task's budgets, and resumes it under a plugin that declares others", async () => {
    const env = await makeEnv({ jobs: 40 });
    const controller = createController();
    const declaring = { ...definition, defaultBudgets: { agentInvocations: 300, jobs: 50, activeMs: 36_000_000 } };
    const first = createScriptedGraph({ definition: declaring, advances: [stop({ reason: "paused", blocker: "none" }, "pause")] });
    const report = await controller.run({ taskPath: env.taskPath, plugin: first, validators, runner: agents(), stateRoot: env.stateRoot, runId: "layers" });
    expect(report.status).toBe("stopped");
    const state = await loadRunState(report.stateDir);
    expect(state.intake.graphDefaultBudgets).toEqual(declaring.defaultBudgets);
    expect(state.intake.budgets).toEqual({ ...CONTROLLER_DEFAULT_BUDGETS, agentInvocations: 300, jobs: 40, activeMs: 36_000_000, recoveryReserve: 15 });

    // A plugin that now declares different defaults (or none) still matches the
    // pinned definition, and the run keeps the budgets it was intaken with.
    const later = createScriptedGraph({ definition: { ...definition, defaultBudgets: { agentInvocations: 9000 } }, advances: completes });
    const done = await controller.resume({ runRef: report.stateDir, plugin: later, validators, runner: agents() });
    expect(done.status, `${done.stopReason}: ${done.blocker}`).toBe("succeeded");
    const after = await loadRunState(done.stateDir);
    expect(after.intake.budgets.agentInvocations).toBe(300);
    expect(budgetGranted(after, "agentInvocations")).toBe(300);
  }, 60_000);

  it("loads a run whose pinned definition has no defaultBudgets the same as before", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: completes }),
      validators,
      runner: agents(),
      stateRoot: env.stateRoot,
      runId: "no-defaults",
    });
    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    expect(state.intake.graphDefaultBudgets).toBeUndefined();
    expect(state.intake.budgets).toEqual({ ...CONTROLLER_DEFAULT_BUDGETS, recoveryReserve: 8 });
  }, 60_000);
});

describe("budget usage ledger (#150)", () => {
  it("books the controller's charges and refunds on save, and an operator's hand edit on load as a raise", async () => {
    const env = await makeEnv({ agentInvocations: 40 });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [stop({ reason: "paused", blocker: "none" }, "pause")] }),
      validators,
      runner: agents(),
      stateRoot: env.stateRoot,
      runId: "ledger",
    });
    let state = await loadRunState(report.stateDir);
    expect(state.budgetUsage?.since).toBe("intake");
    const decisionsUsed = budgetsUsed(state).decisions!;
    expect(decisionsUsed).toBeGreaterThan(0);

    // The controller spends 10 and later refunds 3 of them.
    await saveRunState({ ...state, budgets: { ...state.budgets, agentInvocations: 30 } });
    state = await loadRunState(report.stateDir);
    await saveRunState({ ...state, budgets: { ...state.budgets, agentInvocations: 33 } });
    state = await loadRunState(report.stateDir);
    expect(budgetsUsed(state).agentInvocations).toBe(7);
    expect(budgetGranted(state, "agentInvocations")).toBe(40);

    // The operator raises what is left by 100: the run's budget grows, its use does not.
    await editByHand(report.stateDir, (raw) => {
      (raw.budgets as Record<string, number>).agentInvocations = 133;
    });
    state = await loadRunState(report.stateDir);
    expect(budgetsUsed(state).agentInvocations).toBe(7);
    expect(budgetGranted(state, "agentInvocations")).toBe(140);
    expect(state.intake.budgets.agentInvocations).toBe(40);
    // And it stays booked once the controller saves again.
    await saveRunState({ ...state, budgets: { ...state.budgets, agentInvocations: 131 } });
    state = await loadRunState(report.stateDir);
    expect(budgetsUsed(state)).toMatchObject({ agentInvocations: 9, decisions: decisionsUsed });
    expect(budgetGranted(state, "agentInvocations")).toBe(140);
  }, 60_000);

  it("estimates what a run saved before the ledger used, from its intake budgets and stage records", () => {
    const old = {
      budgets: { agentInvocations: 999_781, jobs: 999_973, decisions: 999_966, corrections: 99_997, waitMs: 604_800_000, activeMs: 2_588_346_567 },
      intake: { budgets: { agentInvocations: 1_000_000, jobs: 1_000_000, decisions: 1_000_000, corrections: 100_000, waitMs: 604_800_000, activeMs: 2_592_000_000 } },
      agentInvocationsByStage: { fix: 182, review: 621 },
    } as unknown as DurableRunState;
    const ledger = legacyBudgetUsage(old, new Date("2026-10-19T00:00:00Z"));
    // Edited budgets make the delta (219) smaller than what the stages recorded.
    expect(ledger.used).toMatchObject({ agentInvocations: 803, jobs: 27, decisions: 34, corrections: 3, waitMs: 0, activeMs: 3_653_433 });
    expect(ledger.since).toBe("2026-10-19T00:00:00.000Z");
    expect(budgetGranted(old, "agentInvocations")).toBe(803 + 999_781);
  });
});

describe("stage pacing reads the run's current agent budget (#150)", () => {
  /**
   * The run has spent 12 of a 20-call agent budget in its write stage (over
   * half) and stops; `raise` is what the operator adds to what is left
   * before resuming. Returns the recovery triggers the resumed run raised.
   */
  async function resumeAfterSpending(raise: number): Promise<{ triggers: Array<{ code: string; message: string }>; status: string }> {
    const env = await makeEnv({ agentInvocations: 20, recoveryReserve: 2 });
    const controller = createController();
    const first = createScriptedGraph({ definition, advances: [stop({ reason: "paused", blocker: "none" }, "pause")] });
    const report = await controller.run({ taskPath: env.taskPath, plugin: first, validators, runner: agents(), stateRoot: env.stateRoot, runId: `pacing-${raise}` });
    expect(report.status).toBe("stopped");

    // What the write stage's agent calls cost, as the controller books it.
    const state = await loadRunState(report.stateDir);
    await saveRunState({
      ...state,
      agentInvocationsByStage: { write: 12 },
      budgets: { ...state.budgets, agentInvocations: state.budgets.agentInvocations - 12 },
    });
    if (raise > 0) {
      await editByHand(report.stateDir, (raw) => {
        const budgets = raw.budgets as Record<string, number>;
        budgets.agentInvocations = budgets.agentInvocations! + raise;
      });
    }

    const triggers: Array<{ code: string; message: string }> = [];
    const supervisor = createScriptedSupervisor({
      decisions: Array.from({ length: 4 }, () => (input: { trigger: { code: string; message: string } }) => {
        triggers.push({ code: input.trigger.code, message: input.trigger.message });
        return returnToNormal({ summary: "carry on" }, "return");
      }),
    });
    const resumed = createScriptedGraph({ definition, advances: completes });
    const done = await controller.resume({ runRef: report.stateDir, plugin: resumed, validators, runner: agents(), supervisor });
    return { triggers, status: done.status };
  }

  it("enters stalled recovery when a stage has spent over half of the run's budget", async () => {
    const { triggers } = await resumeAfterSpending(0);
    expect(triggers[0]).toEqual({ code: "stalled", message: "stage write has spent 12 of the run's 20 agent invocations (over 50%) with 0 receipts" });
  }, 60_000);

  it("does not after the operator raises the budget mid-run, even though the intake copy is unchanged", async () => {
    const { triggers, status } = await resumeAfterSpending(40);
    expect(triggers).toEqual([]);
    expect(status).toBe("succeeded");
  }, 60_000);
});

async function makeEnv(budgets: Record<string, number> = {}): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-budgets-"));
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
  await symlink(helloBundle, path.join(taskDir, "plugins/hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  const budgetLines = Object.entries(budgets).map(([k, v]) => `  ${k}: ${v}\n`).join("");
  await writeFile(
    taskPath,
    `graph: hello\nrepo: ./test-repo\nrequest: |\n  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by\n  one newline. Do not modify other files.\n${budgetLines.length > 0 ? `budgets:\n${budgetLines}` : ""}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}
