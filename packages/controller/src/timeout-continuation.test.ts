import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  defineExecutor,
  dispatch,
  observe,
  stop,
  validate,
  type EvidenceRecord,
  type ExecutorSession,
  type GraphDefinition,
  type JobSpec,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, createTrustedInProcessRunner } from "@graphloom/runner";
import type { Supervisor, SupervisorInput } from "@graphloom/supervisor";
import { TIMEOUT_CONTINUATION_NOTE } from "./agent-sessions.js";
import { createController, loadRunState } from "./index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const AGENT = "acme.agent/code";

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

const latest = (evidence: EvidenceRecord[], kind: string) =>
  [...evidence].reverse().find((e) => e.kind === kind)?.payload as Record<string, unknown> | undefined;

const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate({ evidence }) {
      const file = latest(evidence, "file");
      return file?.path === GREETING_PATH && file.bytes === GREETING ? { status: "passed", reason: "ok" } : { status: "inconclusive", reason: "missing greeting" };
    },
  },
  "independent-reviewer": {
    evaluate({ evidence }) {
      return latest(evidence, "review")?.verdict === "approved" ? { status: "passed", reason: "approved" } : { status: "inconclusive", reason: "missing review" };
    },
  },
};

/**
 * One turn of the stand-in agent, by the order the runner sees them:
 * `partial` writes half the greeting and runs out of time, `idle` runs out of
 * time without touching the worktree, `lost` writes but keeps no session,
 * `retryable` fails in a way the executor declares retryable, and `finish`
 * writes the greeting and succeeds.
 */
type Turn = "partial" | "idle" | "lost" | "finish" | "stray" | "retryable";

function agentRunner(turns: Turn[], options: { retryAfterMs?: number; tag?: string } = {}) {
  const runs: Array<{ operationId: string; session: ExecutorSession | undefined }> = [];
  const agent = defineExecutor<unknown, unknown>({
    id: AGENT,
    version: "1",
    effect: "write",
    async execute(_input, ctx) {
      runs.push({ operationId: ctx.operationId, session: ctx.session });
      const turn = turns[runs.length - 1] ?? "finish";
      const sessionRef = turn === "lost" || ctx.session === undefined ? undefined : (ctx.session.resume ?? `s-${runs.length}`);
      if (turn === "stray") await writeFile(path.join(ctx.worktreePath, "OTHER.txt"), "x", "utf8");
      else if (turn !== "idle" && turn !== "retryable") await writeFile(path.join(ctx.worktreePath, GREETING_PATH), turn === "finish" ? GREETING : `${options.tag ?? ""}${"x".repeat(runs.length)}Hello`, "utf8");
      if (turn === "retryable") {
        return { status: "failed", summary: "upstream 503", retryLimit: 2, retryAfterMs: 0, ...(sessionRef !== undefined ? { sessionRef } : {}) };
      }
      // What the runner reports when the job's wall clock runs out and the executor saved its session while stopping.
      return turn === "finish"
        ? { status: "ok", summary: "agent done", ...(sessionRef !== undefined ? { sessionRef } : {}) }
        : {
            status: "failed",
            summary: "executor child timed out after 3600000ms; while stopping, the executor reported: agent session aborted",
            failureKind: "timeout",
            ...(sessionRef !== undefined ? { sessionRef } : {}),
            ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {}),
          };
    },
  });
  const runner = createTrustedInProcessRunner({
    executors: [agent],
    fallback: createScriptedRunner({
      jobs: Array.from({ length: 4 }, () => async () => ({
        status: "ok" as const,
        summary: "approved",
        evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }],
      })),
    }),
  });
  return { runner, runs };
}

const agentJob = (over: Partial<JobSpec> = {}): JobSpec => ({
  stageId: "write",
  kind: "agent",
  purpose: "work",
  instruction: "implement",
  writeScope: [GREETING_PATH],
  executor: { id: AGENT, version: "1" },
  input: {},
  timeoutContinuations: 1,
  ...over,
});

const finish: ScriptedAdvance[] = [
  observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];

const graph = (advances: ScriptedAdvance[]) => createScriptedGraph({ definition, advances });

/** A supervisor that records the episode it was opened for and stops the run. */
function recordingSupervisor() {
  const inputs: SupervisorInput[] = [];
  const supervisor: Supervisor = {
    async decide(input) {
      inputs.push(input);
      return stop({ reason: "recovery", blocker: input.trigger.message, retryable: false }, "stop");
    },
  };
  return { supervisor, inputs };
}

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
  }
});

describe("continuing an agent session that timed out after making progress", () => {
  it("continues the timed-out session instead of opening a recovery episode, charged as a dispatch", async () => {
    const env = await makeEnv();
    const { runner, runs } = agentRunner(["partial", "finish"]);
    const { supervisor, inputs } = recordingSupervisor();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "progress1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(inputs).toEqual([]);
    const [first, continued] = runs;
    expect(runs).toHaveLength(2);
    const dir = path.join(report.stateDir, "agent-sessions", first!.operationId);
    expect(continued!.session).toEqual({ dir, resume: "s-1", note: TIMEOUT_CONTINUATION_NOTE });

    const state = await loadRunState(report.stateDir);
    expect(state.agentSessions?.map((s) => [s.operationId, s.status, s.continuedFrom, s.timedOut])).toEqual([
      [first!.operationId, "failed", undefined, true],
      [continued!.operationId, "ok", first!.operationId, undefined],
    ]);
    // Counted against the attempt: the dispatch the graph made.
    expect(state.timeoutContinuations).toEqual({ [first!.operationId]: 1 });
    expect(state.remedies).toEqual([
      expect.objectContaining({
        condition: `executor ${AGENT} timed out after changing the worktree`,
        remedy: "continuing its agent session (1 of 1) instead of opening a recovery episode",
      }),
    ]);
    // Both agent turns and the reviewer were charged; the continuation was no new correction.
    expect(state.budgets.jobs).toBe(128 - 3);
    expect(state.budgets.corrections).toBe(8);
  });

  it("opens a recovery episode for a timeout that left the worktree unchanged", async () => {
    const env = await makeEnv();
    const { runner, runs } = agentRunner(["idle"]);
    const { supervisor, inputs } = recordingSupervisor();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "idle1",
    });
    expect(report.status).toBe("stopped");
    expect(runs).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.trigger).toMatchObject({
      code: "executor_failed",
      message: expect.stringContaining("its session was not continued: the timed-out try left the worktree unchanged"),
    });
  });

  it("opens a recovery episode once the attempt used its continuations", async () => {
    const env = await makeEnv();
    const { runner, runs } = agentRunner(["partial", "partial", "finish"]);
    const { supervisor, inputs } = recordingSupervisor();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "cap1",
    });
    expect(report.status).toBe("stopped");
    expect(runs).toHaveLength(2);
    expect(runs[1]!.session).toMatchObject({ resume: "s-1", note: TIMEOUT_CONTINUATION_NOTE });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.trigger.message).toContain(
      `its session was not continued: the attempt dispatched as ${runs[0]!.operationId} already continued 1 timed-out session, its limit`,
    );
    expect((await loadRunState(report.stateDir)).timeoutContinuations).toEqual({ [runs[0]!.operationId]: 1 });
  });

  it("continues a second time, from the newest session, when the job allows two", async () => {
    const env = await makeEnv();
    const { runner, runs } = agentRunner(["partial", "partial", "finish"]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob({ timeoutContinuations: 2 }), "implement"), ...finish]),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "twice1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(runs).toHaveLength(3);
    const state = await loadRunState(report.stateDir);
    expect(state.agentSessions?.map((s) => s.continuedFrom)).toEqual([undefined, runs[0]!.operationId, runs[1]!.operationId]);
    expect(state.timeoutContinuations).toEqual({ [runs[0]!.operationId]: 2 });
  });

  it("gives each attempt of a stage its own allowance, so a later attempt in the same generation is continued too", async () => {
    const env = await makeEnv();
    // Attempt 1 times out and is continued to completion; the graph then
    // dispatches the stage again, and attempt 2 times out and is continued too.
    const { runner, runs } = agentRunner(["partial", "finish", "partial", "finish"]);
    const { supervisor, inputs } = recordingSupervisor();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), dispatch(agentJob(), "implement again"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "attempts1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(inputs).toEqual([]);
    expect(runs).toHaveLength(4);
    const state = await loadRunState(report.stateDir);
    expect(state.generation).toBe(1);
    expect(state.agentSessions?.map((s) => s.continuedFrom)).toEqual([undefined, runs[0]!.operationId, undefined, runs[2]!.operationId]);
    expect(state.timeoutContinuations).toEqual({ [runs[0]!.operationId]: 1, [runs[2]!.operationId]: 1 });
    expect(state.remedies?.map((r) => r.remedy)).toEqual([
      "continuing its agent session (1 of 1) instead of opening a recovery episode",
      "continuing its agent session (1 of 1) instead of opening a recovery episode",
    ]);
  });

  it("charges a continuation chained after a declared-retryable failure to the same attempt", async () => {
    const env = await makeEnv();
    // The continuation fails transiently and is retried; the retry times out again: still the first attempt's allowance.
    const { runner, runs } = agentRunner(["partial", "retryable", "partial", "finish"]);
    const { supervisor, inputs } = recordingSupervisor();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "chain1",
    });
    expect(report.status).toBe("stopped");
    expect(runs).toHaveLength(3);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.trigger.message).toContain(`the attempt dispatched as ${runs[0]!.operationId} already continued 1 timed-out session, its limit`);
    expect((await loadRunState(report.stateDir)).timeoutContinuations).toEqual({ [runs[0]!.operationId]: 1 });
  });

  it("keeps an attempt's count across a stop and resume, so a resume cannot reset it", async () => {
    const env = await makeEnv();
    const runId = "resume-cap1";
    const stateDir = path.join(env.stateRoot, runId);
    const controller = createController();
    // The first try asks for a wait before it runs again, so the run can be stopped with its continuation queued.
    const first = agentRunner(["partial"], { retryAfterMs: 3_000 });
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner: first.runner,
      supervisor: recordingSupervisor().supervisor,
      stateRoot: env.stateRoot,
      runId,
    });
    await expect
      .poll(async () => (await loadRunState(stateDir).catch(() => undefined))?.pendingDispatch, { timeout: 10_000, interval: 50 })
      .toMatchObject({ status: "waiting", retry: { timeoutChain: expect.any(String) } });
    await controller.stop(stateDir);
    expect((await running).status).toBe("stopped");
    const paused = await loadRunState(stateDir);
    const root = first.runs[0]!.operationId;
    expect(first.runs).toHaveLength(1);
    expect(paused.timeoutContinuations).toEqual({ [root]: 1 });
    expect(paused.pendingDispatch).toMatchObject({ status: "waiting", job: { continueFrom: root }, retry: { timeoutChain: root } });

    // On resume the queued continuation runs, times out again, and is not continued a second time.
    const second = agentRunner(["partial"], { tag: "resumed:" });
    const { supervisor, inputs } = recordingSupervisor();
    const resumed = await controller.resume({
      runRef: stateDir,
      plugin: graph([...finish]),
      validators,
      runner: second.runner,
      supervisor,
    });
    expect(resumed.status).toBe("stopped");
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]!.session).toMatchObject({ resume: "s-1", note: TIMEOUT_CONTINUATION_NOTE });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.trigger.message).toContain(`the attempt dispatched as ${root} already continued 1 timed-out session, its limit`);
    expect((await loadRunState(stateDir)).timeoutContinuations).toEqual({ [root]: 1 });
  });

  it("goes to recovery as before when the job did not ask for continuations or kept no session", async () => {
    for (const [runId, turns, over, expected] of [
      ["optout1", ["partial"], { timeoutContinuations: undefined }, undefined],
      ["lost1", ["lost"], {}, "its session was not continued: the executor kept no resumable session while it stopped"],
    ] as const) {
      const env = await makeEnv();
      const { runner, runs } = agentRunner([...turns]);
      const { supervisor, inputs } = recordingSupervisor();
      const { timeoutContinuations: _drop, ...plain } = agentJob();
      void _drop;
      const job: JobSpec = over.timeoutContinuations === undefined && "timeoutContinuations" in over ? plain : { ...plain, ...over, timeoutContinuations: 1 };
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: graph([dispatch(job, "implement"), ...finish]),
        validators,
        runner,
        supervisor,
        stateRoot: env.stateRoot,
        runId,
      });
      expect(report.status).toBe("stopped");
      expect(runs).toHaveLength(1);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]!.trigger.code).toBe("executor_failed");
      if (expected === undefined) expect(inputs[0]!.trigger.message).not.toContain("not continued");
      else expect(inputs[0]!.trigger.message).toContain(expected);
    }
  });

  it("does not continue a session that wrote outside its scope before it timed out", async () => {
    const env = await makeEnv();
    const { runner, runs } = agentRunner(["stray", "finish"]);
    const { supervisor, inputs } = recordingSupervisor();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "stray1",
    });
    expect(report.status).toBe("stopped");
    expect(runs).toHaveLength(1);
    expect(inputs[0]!.trigger.message).toContain("changed paths outside the job's write scope: OTHER.txt");
    expect((await loadRunState(report.stateDir)).timeoutContinuations).toBeUndefined();
  });

  it("does not continue past the run's job budget", async () => {
    const env = await makeEnv("budgets:\n  jobs: 1\n");
    const { runner, runs } = agentRunner(["partial", "finish"]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob(), "implement"), ...finish]),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "budget1",
    });
    expect(runs).toHaveLength(1);
    expect(report).toMatchObject({ status: "stopped", stopReason: "budgets exhausted", blocker: "jobs" });
  });
});

async function makeEnv(extra = ""): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-timeout-cont-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  await symlink(helloBundle, path.join(taskDir, "plugins/hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(
    taskPath,
    `graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
${extra}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}
