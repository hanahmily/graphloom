// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  reenter,
  stop,
  validate,
  type GraphDefinition,
  type JobSpec,
  type RunView,
  type ScriptedAdvance,
  type ToolBinding,
  type Validator,
} from "@graphloom/sdk";
import { createBuiltinExecutorRunner, createScriptedRunner, type Runner } from "@graphloom/runner";
import { createController, loadRunState, TIMEOUT_CONTINUATION_NOTE } from "@graphloom/controller";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import {
  CONTINUATION_NOTICE,
  claudeCodeHarnessModule,
  codingAgentBinding,
  codingAgentExecutorPackage,
  type ClaudeCodeBindingOptions,
} from "@graphloom/executor-coding-agent";
import { scriptedHarnessModule, type ScriptedStep } from "@graphloom/executor-coding-agent/testing";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const GREETING = "Hello, GraphLoom!\n";
const TOKEN = "ghp_coding_agent_e2e_secret";

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
      statement:
        "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    {
      requirementId: "independent-review",
      validatorId: "independent-reviewer",
      version: "1",
      independence: "separate-reviewer",
    },
  ],
};

function latest(evidence: readonly { kind: string; payload?: unknown }[], kind: string): unknown {
  return [...evidence].reverse().find((e) => e.kind === kind)?.payload;
}

const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate(input) {
      const file = latest(input.evidence, "file") as { path?: string; bytes?: string } | undefined;
      return file?.path === "GREETING.txt" && file.bytes === GREETING
        ? { status: "passed", reason: "ok" }
        : { status: "inconclusive", reason: "missing" };
    },
  },
  "independent-reviewer": {
    evaluate(input) {
      const review = latest(input.evidence, "review") as { verdict?: string } | undefined;
      return review?.verdict === "approved"
        ? { status: "passed", reason: "approved" }
        : { status: "inconclusive", reason: "missing" };
    },
  },
};

const tools: ToolBinding[] = [
  { name: "read_comments", effect: "read", executor: { id: "graphloom.github/list-issue-comments", version: "1" } },
  { name: "comment", effect: "write", executor: { id: "graphloom.github/create-issue-comment", version: "1" } },
];

const repo = { owner: "acme", repo: "app" };
const readComments = (id: string): ScriptedStep => ({ tool: "read_comments", id, input: { ...repo, number: 1 } });
const comment = (id: string): ScriptedStep => ({
  tool: "comment",
  id,
  input: { ...repo, issueNumber: 1, body: "Working on it.", idempotencyKey: "status" },
});
const writeGreeting: ScriptedStep = { write: { path: "GREETING.txt", content: GREETING } };

function graph(steps: ScriptedStep[]) {
  return createScriptedGraph({
    definition,
    advances: [
      dispatch(
        {
          stageId: "write",
          kind: "agent",
          purpose: "work",
          instruction: "implement issue #1",
          writeScope: ["GREETING.txt"],
          executor: { id: "graphloom.coding-agent/run", version: "1" },
          tools,
          input: { assignment: "Implement issue #1 and post a status comment.", harnessOptions: { steps } },
        },
        "implement",
      ),
      observe({ paths: ["GREETING.txt"], includeWorkspaceManifest: true }, "observe"),
      validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
      dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
      validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
      stop({ reason: "complete", blocker: "none" }, "done"),
    ],
  });
}

/** The operator's host: the coding agent runs unrestricted, GitHub sandboxed with writes granted. */
function hostRunner(server: FakeGitHub, coding = codingAgentBinding({ harness: scriptedHarnessModule }), timeoutMs?: number, stopGraceMs?: number) {
  return createBuiltinExecutorRunner({
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(stopGraceMs !== undefined ? { stopGraceMs } : {}),
    packages: [
      { manifest: githubExecutorPackage, ...githubBinding({ token: TOKEN, baseUrl: server.baseUrl, allowWrites: true }) },
      { manifest: codingAgentExecutorPackage, ...coding },
    ],
    fallback: createScriptedRunner({
      jobs: Array.from({ length: 2 }, () => async () => ({
        status: "ok" as const,
        summary: "approved",
        evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }],
      })),
    }),
  });
}

const posts = (server: FakeGitHub) => server.requests.filter((r) => r.method === "POST");

const retry = reenter({ stageId: "write", reason: "no greeting yet" }, "retry");
const rest = [
  observe({ paths: ["GREETING.txt"], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];

type RunState = Awaited<ReturnType<typeof loadRunState>>;
/**
 * Run `advances` to a pause, so the saved agent sessions can be inspected
 * before the finished run wipes them, then resume through `rest`.
 */
async function pauseToInspectSessions(
  run: { taskPath: string; stateRoot: string; runId: string; runner: Runner },
  advances: ScriptedAdvance[],
  inspect: (state: RunState) => Promise<void>,
) {
  const controller = createController();
  const paused = await controller.run({
    taskPath: run.taskPath,
    plugin: createScriptedGraph({ definition, advances: [...advances, stop({ reason: "pause", blocker: "inspect sessions" }, "pause")] }),
    validators,
    runner: run.runner,
    stateRoot: run.stateRoot,
    runId: run.runId,
  });
  expect(paused.status, paused.blocker).toBe("stopped");
  await inspect(await loadRunState(paused.stateDir));
  const report = await controller.resume({ runRef: paused.stateDir, plugin: createScriptedGraph({ definition, advances: rest }), validators, runner: run.runner });
  expect(report.status, report.blocker).toBe("succeeded");
  expect(existsSync(path.join(report.stateDir, "agent-sessions"))).toBe(false);
  return report;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(): Promise<FakeGitHub> {
  const server = await startFakeGitHub({ issues: [{ number: 1, title: "Add a greeting", state: "open", labels: [] }] });
  cleanups.push(() => server.close());
  return server;
}

async function readTree(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) parts.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
  }
  return parts.join("\n");
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached");
}

describe("graph → coding agent → GitHub child executor", () => {
  it("lets the coding agent call the built-in GitHub executor through admitted tools", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([readComments("c1"), comment("c2"), readComments("c3"), writeGreeting]),
      validators,
      runner: hostRunner(server),
      stateRoot: env.stateRoot,
      runId: "agent-gh",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    expect(posts(server)).toHaveLength(1);
    expect(server.comments.get(1)?.[0]?.body).toContain("Working on it.");

    const state = await loadRunState(report.stateDir);
    expect(state.childOperations?.map((c) => [c.toolCallId, c.executor.id, c.status])).toEqual([
      ["c1", "graphloom.github/list-issue-comments", "ok"],
      ["c2", "graphloom.github/create-issue-comment", "ok"],
      ["c3", "graphloom.github/list-issue-comments", "ok"],
    ]);
    const agent = state.evidence
      .map((e) => e.payload as { codingAgent?: { toolCalls: unknown[]; output: { toolResults: { result: { evidence?: unknown[] } }[] } } })
      .find((p) => p.codingAgent)!.codingAgent!;
    expect(agent.toolCalls).toHaveLength(3);
    // The second read sees the comment the agent posted in between.
    const lastRead = agent.output.toolResults[2]!.result.evidence?.[0] as { payload: { github: { items: unknown[] } } };
    expect(lastRead.payload.github.items).toHaveLength(1);
    expect(state.budgets.jobs).toBe(128 - 1 - 3 - 1);
    expect(await readTree(report.stateDir)).not.toContain(TOKEN);
  });

  it("records a rate-limited tool call like a graph dispatch and holds further calls until the retry time", async () => {
    const server = await fake();
    server.rateLimitNext(1, 60);
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([readComments("c1"), readComments("c2"), writeGreeting]),
      validators,
      runner: hostRunner(server),
      stateRoot: env.stateRoot,
      runId: "agent-rate-limit",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    expect(server.requests).toHaveLength(1);
    const state = await loadRunState(report.stateDir);
    expect(state.childOperations?.map((c) => [c.toolCallId, c.status])).toEqual([["c1", "failed"]]);
    const agent = state.evidence
      .map((e) => e.payload as { codingAgent?: { output: { toolResults: { result: { summary: string; retryAfterMs?: number } }[] } } })
      .find((p) => p.codingAgent)!.codingAgent!;
    const [limited, held] = agent.output.toolResults.map((t) => t.result);
    expect(limited!.retryAfterMs).toBeGreaterThan(0);
    expect(held!.summary).toMatch(/^executor graphloom\.github\/list-issue-comments asked not to be called before /);
    expect(held!.retryAfterMs).toBeGreaterThan(0);
    const failure = state.evidence
      .map((e) => e.payload as { executorFailure?: Record<string, unknown>; producer?: { toolCallId?: string } })
      .find((p) => p.executorFailure);
    expect(failure?.producer?.toolCallId).toBe("c1");
    expect(failure?.executorFailure).toMatchObject({
      stageId: "write",
      status: "failed",
      executor: { id: "graphloom.github/list-issue-comments" },
      retryAfterMs: limited!.retryAfterMs,
    });
    expect(state.executorRetryAt?.["graphloom.github/list-issue-comments"]).toBeDefined();
  });

  it("stop mid-write kills both processes and a retried agent cannot repeat the write", async () => {
    const server = await fake();
    server.hangAfterNextWrite();
    const env = await makeEnv();
    const controller = createController();
    const stateDir = path.join(env.stateRoot, "agent-stop");
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: graph([comment("c1"), writeGreeting]),
      validators,
      runner: hostRunner(server),
      stateRoot: env.stateRoot,
      runId: "agent-stop",
    });
    await waitFor(async () => posts(server).length === 1);
    const stoppedAt = Date.now();
    await controller.stop(stateDir);
    const stopped = await running;
    expect(stopped.status).toBe("stopped");
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect((await loadRunState(stateDir)).childOperations?.map((c) => c.status)).toEqual(["ambiguous"]);

    const resumed = await controller.resume({
      runRef: stateDir,
      plugin: graph([comment("c1"), writeGreeting]),
      validators,
      runner: hostRunner(server),
    });
    expect(resumed.status, resumed.blocker).toBe("succeeded");
    expect(posts(server)).toHaveLength(1);
    const retried = resumed.evidence
      .map((e) => e.payload as { codingAgent?: { output: { toolResults: { result: { summary: string } }[] } } })
      .filter((p) => p.codingAgent)
      .at(-1)!.codingAgent!;
    expect(retried.output.toolResults[0]!.result.summary).toBe("tool call c1 has an unreconciled outcome");
  });
});

describe("the coding agent's job timeout", () => {
  it("outlasts the runner's default job timeout unless the binding sets its own", async () => {
    const server = await fake();
    const env = await makeEnv();
    const slow = graph([{ sleep: 1_500 }, writeGreeting]);
    const finished = await createController().run({
      taskPath: env.taskPath,
      plugin: slow,
      validators,
      runner: hostRunner(server, codingAgentBinding({ harness: scriptedHarnessModule }), 500),
      stateRoot: env.stateRoot,
      runId: "slow-default",
    });
    expect(finished.status, finished.blocker).toBe("succeeded");

    const limited = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([{ sleep: 1_500 }, writeGreeting]),
      validators,
      runner: hostRunner(server, codingAgentBinding({ harness: scriptedHarnessModule, timeoutMs: 500 })),
      stateRoot: env.stateRoot,
      runId: "slow-limited",
    });
    expect(limited).toMatchObject({ status: "stopped", stopReason: expect.stringMatching(/^job failed: executor child timed out after 500ms\b/) });
    const { worktreePath } = await loadRunState(limited.stateDir);
    expect(await readFile(path.join(worktreePath, "GREETING.txt"), "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("runs a job for the wall clock it asks for, and continues its session when it runs out after changing the worktree", async () => {
    const server = await fake();
    const env = await makeEnv();
    const job: JobSpec = {
      stageId: "write",
      kind: "agent",
      purpose: "work",
      instruction: "implement issue #1",
      writeScope: ["GREETING.txt"],
      executor: { id: "graphloom.coding-agent/run", version: "1" },
      input: {
        assignment: "Write the greeting.",
        harnessOptions: {
          // The first turn writes half the greeting and is still working when its time runs out; the continued turn finishes.
          steps: [{ write: { path: "GREETING.txt", content: "Hello" } }, { wait: "abort" }],
          continuedSteps: [writeGreeting],
        },
      },
      // Longer than the operator's default and clamped to the ceiling.
      timeoutMs: 60_000,
      timeoutContinuations: 1,
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(job, "implement"), ...rest] }),
      validators,
      runner: hostRunner(server, codingAgentBinding({ harness: scriptedHarnessModule, timeoutMs: 500, maxTimeoutMs: 1_500 })),
      stateRoot: env.stateRoot,
      runId: "timeout-continued",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const [first, second] = state.agentSessions!;
    expect(first).toMatchObject({ status: "failed", timedOut: true });
    expect(second).toMatchObject({ status: "ok", continuedFrom: first!.operationId, sessionRef: first!.sessionRef });
    const failure = state.evidence
      .map((e) => (e.payload as { executorFailure?: { summary: string } }).executorFailure)
      .find((f) => f !== undefined);
    expect(failure?.summary).toMatch(/^executor child timed out after 1500ms \(the job asked for 60000ms; the operator allows at most 1500ms\)/);
    const turns = state.evidence
      .map((e) => (e.payload as { codingAgent?: { output: { assignment: string; timeoutMs?: number } | null } }).codingAgent)
      .filter((a) => a !== undefined && a.output !== null);
    expect(turns.at(-1)!.output!.assignment).toBe(`${TIMEOUT_CONTINUATION_NOTE}\n\nWrite the greeting.`);
    expect(turns.map((t) => t!.output!.timeoutMs)).toEqual([1_500, 1_500]);
    expect(state.remedies?.map((r) => r.remedy)).toEqual(["continuing its agent session (1 of 1) instead of opening a recovery episode"]);
  });

  it("continues the session the agent saved mid-turn when it never answers within the stop grace and is killed", async () => {
    const server = await fake();
    const env = await makeEnv();
    const job: JobSpec = {
      stageId: "write",
      kind: "agent",
      purpose: "work",
      instruction: "implement issue #1",
      writeScope: ["GREETING.txt"],
      executor: { id: "graphloom.coding-agent/run", version: "1" },
      input: {
        assignment: "Write the greeting.",
        harnessOptions: {
          // The first turn writes half the greeting and then hangs, ignoring the stop: only its process kill ends it.
          steps: [{ write: { path: "GREETING.txt", content: "Hello" } }, { hang: true }],
          continuedSteps: [writeGreeting],
        },
      },
      timeoutContinuations: 1,
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(job, "implement"), ...rest] }),
      validators,
      runner: hostRunner(server, codingAgentBinding({ harness: scriptedHarnessModule, timeoutMs: 1_000 }), undefined, 300),
      stateRoot: env.stateRoot,
      runId: "timeout-killed",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const [first, second] = state.agentSessions!;
    // The executor never reported a result: the session it saved as the turn began is what the host kept.
    expect(first).toMatchObject({ status: "failed", timedOut: true, sessionRef: expect.stringMatching(/^scripted-/) });
    expect(second).toMatchObject({ status: "ok", continuedFrom: first!.operationId, sessionRef: first!.sessionRef });
    const failure = state.evidence
      .map((e) => (e.payload as { executorFailure?: { summary: string; failureKind?: string } }).executorFailure)
      .find((f) => f !== undefined);
    expect(failure).toMatchObject({ summary: "executor child timed out after 1000ms", failureKind: "timeout" });
    // No evidence claims the killed turn succeeded: the only coding-agent record is the continued turn's.
    const turns = state.evidence
      .map((e) => (e.payload as { codingAgent?: { status: string; output: { assignment: string } | null } }).codingAgent)
      .filter((a) => a !== undefined);
    expect(turns.map((t) => t!.status)).toEqual(["completed"]);
    expect(turns[0]!.output!.assignment).toBe(`${TIMEOUT_CONTINUATION_NOTE}\n\nWrite the greeting.`);
    expect(await readFile(path.join(state.worktreePath, "GREETING.txt"), "utf8")).toBe(GREETING);
  });
});

describe("continuing the coding agent's session on reentry", () => {
  const ASSIGNMENT = "Implement issue #1 and post a status comment.";
  const agentJob = (steps: ScriptedStep[], continueFrom?: string): JobSpec => ({
    stageId: "write",
    kind: "agent",
    purpose: "work",
    instruction: "implement issue #1",
    writeScope: ["GREETING.txt"],
    executor: { id: "graphloom.coding-agent/run", version: "1" },
    tools,
    input: { assignment: continueFrom === undefined ? ASSIGNMENT : "Finish issue #1.", harnessOptions: { steps } },
    ...(continueFrom !== undefined ? { continueFrom } : {}),
  });
  const continueFirst = (steps: ScriptedStep[]) => (view: RunView) =>
    dispatch(agentJob(steps, view.agentSessions![0]!.operationId), "continue");
  type Agent = { sessionRef: string | null; continued: boolean; output: { assignment: string; priorAssignments: string[]; toolResults: { result: { status: string; summary: string } }[] } };
  const agents = (evidence: readonly { payload?: unknown }[]) =>
    evidence.map((e) => (e.payload as { codingAgent?: Agent }).codingAgent).filter((a): a is Agent => a !== undefined);

  it("restores the harness session from the run's state directory in a new executor process", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await pauseToInspectSessions(
      { ...env, runId: "agent-continue", runner: hostRunner(server) },
      [dispatch(agentJob([readComments("c1")]), "first try"), retry, continueFirst([readComments("c1"), readComments("c2"), writeGreeting])],
      async (state) => {
        const [recorded] = state.agentSessions!;
        const transcript = JSON.parse(await readFile(path.join(recorded!.sessionDir, `${recorded!.sessionRef}.json`), "utf8"));
        expect(recorded!.sessionDir.startsWith(path.join(state.stateDir, "agent-sessions"))).toBe(true);
        expect(transcript.turns).toHaveLength(2);
        expect(await readTree(state.stateDir)).not.toContain(TOKEN);
      },
    );

    const [first, continued] = agents(report.evidence);
    expect(first).toMatchObject({ continued: false, output: { priorAssignments: [] } });
    expect(continued).toMatchObject({ continued: true, sessionRef: first!.sessionRef });
    expect(continued!.output.priorAssignments).toEqual([ASSIGNMENT]);
    expect(continued!.output.assignment).toBe(`${CONTINUATION_NOTICE}\n\nFinish issue #1.`);
    expect(continued!.output.toolResults.map((t) => t.result.summary)).toEqual([
      "tool call c1 belongs to an earlier attempt; make a new call",
      expect.stringMatching(/comment/),
    ]);
    expect(server.requests).toHaveLength(2);
  });

  it("stops with the restore failure instead of starting a fresh session", async () => {
    const server = await fake();
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [dispatch(agentJob([]), "first try"), stop({ reason: "pause", blocker: "operator" }, "pause")],
      }),
      validators,
      runner: hostRunner(server),
      stateRoot: env.stateRoot,
      runId: "agent-lost-session",
    });
    const [recorded] = (await loadRunState(paused.stateDir)).agentSessions!;
    await rm(recorded!.sessionDir, { recursive: true });

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [retry, continueFirst([writeGreeting]), ...rest] }),
      validators,
      runner: hostRunner(server),
    });
    expect(resumed).toMatchObject({
      status: "stopped",
      stopReason: `job failed: agent session ${recorded!.sessionRef} could not be restored: no transcript for ${recorded!.sessionRef}`,
    });
    const { worktreePath } = await loadRunState(paused.stateDir);
    expect(await readFile(path.join(worktreePath, "GREETING.txt"), "utf8").catch(() => undefined)).toBeUndefined();
  });
});

describe("the Pi harness in the coding-agent executor process", () => {
  const piHarnessFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/pi-faux-harness.mjs");
  const PI_KEY = "sk-pi-e2e-secret-7731";
  type FauxStep = { tool: string; args?: Record<string, unknown> } | { text: string };
  const piJob = (faux: FauxStep[], continueFrom?: string): JobSpec => ({
    stageId: "write",
    kind: "agent",
    purpose: "work",
    instruction: "implement issue #1",
    writeScope: ["GREETING.txt"],
    executor: { id: "graphloom.coding-agent/run", version: "1" },
    tools,
    input: {
      assignment: continueFrom === undefined ? "Implement issue #1 and post a status comment." : "Finish issue #1.",
      harnessOptions: { faux },
    },
    ...(continueFrom !== undefined ? { continueFrom } : {}),
  });
  const writeGreetingCall: FauxStep = { tool: "bash", args: { command: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" } };
  const piRunner = async (server: FakeGitHub) => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-agent-"));
    cleanups.push(() => rm(agentDir, { recursive: true, force: true }));
    return hostRunner(server, codingAgentBinding({ harness: piHarnessFixture, pi: { agentDir, apiKey: PI_KEY } }));
  };
  type PiAgent = { harness: string; modelCalls: number; sessionRef: string | null; continued: boolean; toolCalls: { toolCallId: string }[] };
  const piAgents = (evidence: readonly { payload?: unknown }[]) =>
    evidence.map((e) => (e.payload as { codingAgent?: PiAgent }).codingAgent).filter((a): a is PiAgent => a !== undefined);

  it("records the Pi agent's tool calls as child operations and completes the run", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await pauseToInspectSessions(
      { ...env, runId: "pi-agent", runner: await piRunner(server) },
      [
        dispatch(
          piJob([
            { tool: "read_comments", args: { ...repo, number: 1 } },
            { tool: "comment", args: { ...repo, issueNumber: 1, body: "Working on it.", idempotencyKey: "status" } },
            writeGreetingCall,
            { text: "Wrote GREETING.txt and posted a status comment." },
          ]),
          "implement",
        ),
      ],
      async (state) => {
        const [recorded] = state.agentSessions!;
        expect((await readdir(recorded!.sessionDir)).sort()).toEqual([`${recorded!.sessionRef}.json`, `${recorded!.sessionRef}.jsonl`]);
        const tree = await readTree(state.stateDir);
        expect(tree).not.toContain(TOKEN);
        expect(tree).not.toContain(PI_KEY);
      },
    );

    expect(posts(server)).toHaveLength(1);
    expect(server.comments.get(1)?.[0]?.body).toContain("Working on it.");
    const state = await loadRunState(report.stateDir);
    expect(state.childOperations?.map((c) => [c.executor.id, c.status])).toEqual([
      ["graphloom.github/list-issue-comments", "ok"],
      ["graphloom.github/create-issue-comment", "ok"],
    ]);
    for (const child of state.childOperations!) expect(child.toolCallId).toMatch(/^pi-[0-9a-f]{8}-/);
    const [agent] = piAgents(report.evidence);
    expect(agent).toMatchObject({ harness: "pi", modelCalls: 4, continued: false });
    expect(agent!.sessionRef).toMatch(/^pi-[0-9a-f]{12}$/);
    expect(state.agentSessions![0]!.sessionRef).toBe(agent!.sessionRef);
    const tree = await readTree(report.stateDir);
    expect(tree).not.toContain(TOKEN);
    expect(tree).not.toContain(PI_KEY);
  });

  it("continues the saved Pi session in a new executor process", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await pauseToInspectSessions(
      { ...env, runId: "pi-continue", runner: await piRunner(server) },
      [
        dispatch(piJob([{ text: "Not done yet." }]), "first try"),
        retry,
        (view: RunView) => dispatch(piJob([writeGreetingCall, { text: "Done." }], view.agentSessions![0]!.operationId), "continue"),
      ],
      async (state) => {
        const [recorded] = state.agentSessions!;
        const transcript = await readFile(path.join(recorded!.sessionDir, `${recorded!.sessionRef}.jsonl`), "utf8");
        expect(transcript).toContain("Implement issue #1 and post a status comment.");
        expect(transcript).toContain("Not done yet.");
        expect(transcript).toContain(CONTINUATION_NOTICE.slice(0, 40));
        expect(transcript).toContain("Finish issue #1.");
        expect(transcript).not.toContain(PI_KEY);
      },
    );

    const [first, continued] = piAgents(report.evidence);
    expect(continued).toMatchObject({ continued: true, sessionRef: first!.sessionRef });
  });
});

describe("the Claude Code harness in the coding-agent executor process", () => {
  const fakeClaude = path.join(repoRoot, "executors/coding-agent/test/fake-claude.mjs");
  const API_KEY = "sk-ant-e2e-secret-5190";
  type Step = Record<string, unknown>;
  const claudeJob = (continueFrom?: string): JobSpec => ({
    stageId: "write",
    kind: "agent",
    purpose: "work",
    instruction: "implement issue #1",
    writeScope: ["GREETING.txt"],
    executor: { id: "graphloom.coding-agent/run", version: "1" },
    tools,
    input: { assignment: continueFrom === undefined ? "Implement issue #1 and post a status comment." : "Finish issue #1." },
    ...(continueFrom !== undefined ? { continueFrom } : {}),
  });
  const writeGreetingBash: Step = { bash: "printf 'Hello, GraphLoom!\\n' > GREETING.txt" };
  /** The fake CLI's script and log reach it through the executor's environment and the binding's `passEnv`. */
  async function claudeRunner(
    server: FakeGitHub,
    start: Step[],
    resume: Step[] = [],
    binding: { timeoutMs?: number; claude?: ClaudeCodeBindingOptions } = {},
  ) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-claude-e2e-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const bin = path.join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { mode: 0o755 });
    await writeFile(path.join(dir, "script.json"), JSON.stringify({ start, resume }), "utf8");
    const saved = { ...process.env };
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, "config");
    process.env.FAKE_CLAUDE_SCRIPT = path.join(dir, "script.json");
    process.env.FAKE_CLAUDE_LOG = path.join(dir, "log.jsonl");
    cleanups.push(async () => {
      for (const name of ["CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_SCRIPT", "FAKE_CLAUDE_LOG"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });
    const runner = hostRunner(
      server,
      codingAgentBinding({
        harness: claudeCodeHarnessModule,
        ...(binding.timeoutMs !== undefined ? { timeoutMs: binding.timeoutMs } : {}),
        claude: { command: bin, apiKey: API_KEY, passEnv: ["FAKE_CLAUDE_SCRIPT", "FAKE_CLAUDE_LOG"], ...binding.claude },
      }),
    );
    type Call = { argv: string[]; apiKey: string | null; env: Record<string, string>; history: string[] };
    const log = async () => (await readFile(path.join(dir, "log.jsonl"), "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
    return { runner, log, dir, configDir: path.join(dir, "config") };
  }
  type ClaudeAgent = { harness: string; modelCalls: number; sessionRef: string | null; continued: boolean; usage: unknown };
  const claudeAgents = (evidence: readonly { payload?: unknown }[]) =>
    evidence.map((e) => (e.payload as { codingAgent?: ClaudeAgent }).codingAgent).filter((a): a is ClaudeAgent => a !== undefined);

  it("runs Claude Code with its own tools and records its graph tool calls as child operations", async () => {
    const server = await fake();
    const env = await makeEnv();
    const claude = await claudeRunner(server, [
      { tool: "read_comments", args: { ...repo, number: 1 } },
      { tool: "comment", args: { ...repo, issueNumber: 1, body: "Working on it.", idempotencyKey: "status" } },
      writeGreetingBash,
      { text: "Wrote GREETING.txt and posted a status comment." },
    ]);
    const report = await pauseToInspectSessions(
      { ...env, runId: "claude-agent", runner: claude.runner },
      [dispatch(claudeJob(), "implement")],
      async (state) => {
        const [recorded] = state.agentSessions!;
        expect((await readdir(recorded!.sessionDir)).sort()).toEqual([`${recorded!.sessionRef}.json`, `${recorded!.sessionRef}.jsonl`]);
        const tree = await readTree(state.stateDir);
        expect(tree).not.toContain(TOKEN);
        expect(tree).not.toContain(API_KEY);
      },
    );

    expect(posts(server)).toHaveLength(1);
    const state = await loadRunState(report.stateDir);
    expect(state.childOperations?.map((c) => [c.executor.id, c.status])).toEqual([
      ["graphloom.github/list-issue-comments", "ok"],
      ["graphloom.github/create-issue-comment", "ok"],
    ]);
    for (const child of state.childOperations!) expect(child.toolCallId).toMatch(/^claude-[0-9a-f]{8}-\d+$/);
    const [agent] = claudeAgents(report.evidence);
    expect(agent).toMatchObject({
      harness: "claude-code",
      modelCalls: 4,
      continued: false,
      usage: { inputTokens: 40, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.0125 },
    });
    expect(state.agentSessions![0]!.sessionRef).toBe(agent!.sessionRef);
    const [call] = await claude.log();
    expect(call!.apiKey).toBe(API_KEY);
    expect(call!.env).not.toHaveProperty("GRAPHLOOM_CODING_HARNESS");
    expect(JSON.stringify(call!.env)).not.toContain(TOKEN);
    const tree = await readTree(report.stateDir);
    expect(tree).not.toContain(TOKEN);
    expect(tree).not.toContain(API_KEY);
  });

  /** A step that records Claude Code's pid and its tool's pid, then hangs in the tool. */
  const hangInTool = (dir: string): Step => ({
    bash: `echo $PPID > ${dir}/claude.pid; echo $$ > ${dir}/tool.pid; exec sleep 60`,
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function hungPids(dir: string): Promise<number[]> {
    await waitFor(async () => (await readFile(path.join(dir, "tool.pid"), "utf8").catch(() => "")).trim() !== "");
    return Promise.all(["claude.pid", "tool.pid"].map(async (f) => Number((await readFile(path.join(dir, f), "utf8")).trim())));
  }

  it("kills Claude Code and its tools when the job times out", async () => {
    const server = await fake();
    const env = await makeEnv();
    const claude = await claudeRunner(server, [], [], {
      timeoutMs: 1_500,
      claude: { startupTimeoutMs: 0, responseTimeoutMs: 0 },
    });
    await writeFile(path.join(claude.dir, "script.json"), JSON.stringify({ start: [hangInTool(claude.dir)], resume: [] }));
    const running = createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(claudeJob(), "implement"), ...rest] }),
      validators,
      runner: claude.runner,
      stateRoot: env.stateRoot,
      runId: "claude-timeout",
    });
    const pids = await hungPids(claude.dir);
    const report = await running;

    expect(report).toMatchObject({ status: "stopped", stopReason: expect.stringMatching(/^job failed: executor child timed out after 1500ms\b/) });
    expect(pids.filter(alive)).toEqual([]);
  });

  it("kills Claude Code and its tools when the operator stops the run", async () => {
    const server = await fake();
    const env = await makeEnv();
    const claude = await claudeRunner(server, []);
    await writeFile(path.join(claude.dir, "script.json"), JSON.stringify({ start: [hangInTool(claude.dir)], resume: [] }));
    const controller = createController();
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(claudeJob(), "implement"), ...rest] }),
      validators,
      runner: claude.runner,
      stateRoot: env.stateRoot,
      runId: "claude-stop",
    });
    const pids = await hungPids(claude.dir);
    await controller.stop(path.join(env.stateRoot, "claude-stop"));
    const report = await running;

    expect(report.status).toBe("stopped");
    expect(pids.filter(alive)).toEqual([]);
  });

  it("resumes the saved Claude Code session in a new executor process", async () => {
    const server = await fake();
    const env = await makeEnv();
    const claude = await claudeRunner(server, [{ text: "Not done yet." }], [writeGreetingBash, { text: "Done." }]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(claudeJob(), "first try"),
          retry,
          (view: RunView) => dispatch(claudeJob(view.agentSessions![0]!.operationId), "continue"),
          ...rest,
        ],
      }),
      validators,
      runner: claude.runner,
      stateRoot: env.stateRoot,
      runId: "claude-continue",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    const [first, continued] = claudeAgents(report.evidence);
    expect(continued).toMatchObject({ continued: true, sessionRef: first!.sessionRef });
    const [, resumed] = await claude.log();
    expect(resumed!.argv).toContain("--resume");
    expect(resumed!.history).toEqual([expect.stringContaining("Implement issue #1"), "Not done yet."]);
  });

  it("runs each binding's Claude Code on the config dir (account) it names", async () => {
    const server = await fake();
    const accounts = await mkdtemp(path.join(os.tmpdir(), "gl-claude-accounts-"));
    cleanups.push(() => rm(accounts, { recursive: true, force: true }));
    for (const account of ["gateway", "first-party"]) {
      const configDir = path.join(accounts, account);
      const env = await makeEnv();
      const claude = await claudeRunner(server, [{ text: "Not done yet." }], [writeGreetingBash, { text: "Done." }], { claude: { configDir } });
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({
          definition,
          advances: [
            dispatch(claudeJob(), "first try"),
            retry,
            (view: RunView) => dispatch(claudeJob(view.agentSessions![0]!.operationId), "continue"),
            ...rest,
          ],
        }),
        validators,
        runner: claude.runner,
        stateRoot: env.stateRoot,
        runId: `claude-${account}`,
      });

      expect(report.status, report.blocker).toBe("succeeded");
      expect((await claude.log()).map((call) => call.env.CLAUDE_CONFIG_DIR)).toEqual([configDir, configDir]);
      const sessionId = claudeAgents(report.evidence)[0]!.sessionRef!.slice("claude-".length);
      const [project] = await readdir(path.join(configDir, "projects"));
      expect(await readFile(path.join(configDir, "projects", project!, `${sessionId}.jsonl`), "utf8")).toContain("Done.");
      expect(existsSync(claude.configDir)).toBe(false);
    }
  });
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  // Rebuilding rewrites dist/ under test files that run in parallel; `npm test` builds it first.
  if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
    await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-agent-e2e-"));
  cleanups.push(async () => {
    await execFileAsync("git", ["worktree", "prune"], { cwd: taskDir }).catch(() => undefined);
    await rm(taskDir, { recursive: true, force: true });
  });
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
`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}
