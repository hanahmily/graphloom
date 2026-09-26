import { execFile } from "node:child_process";
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
  type ToolBinding,
  type Validator,
} from "@graphloom/sdk";
import { createBuiltinExecutorRunner, createScriptedRunner } from "@graphloom/runner";
import { createController, loadRunState } from "@graphloom/controller";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import {
  CONTINUATION_NOTICE,
  codingAgentBinding,
  codingAgentExecutorPackage,
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
function hostRunner(server: FakeGitHub, coding = codingAgentBinding({ harness: scriptedHarnessModule })) {
  return createBuiltinExecutorRunner({
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
    expect(state.budgets.jobs).toBe(64 - 1 - 3 - 1);
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
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(agentJob([readComments("c1")]), "first try"),
          retry,
          continueFirst([readComments("c1"), readComments("c2"), writeGreeting]),
          ...rest,
        ],
      }),
      validators,
      runner: hostRunner(server),
      stateRoot: env.stateRoot,
      runId: "agent-continue",
    });
    expect(report.status, report.blocker).toBe("succeeded");

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

    const state = await loadRunState(report.stateDir);
    const [recorded] = state.agentSessions!;
    const transcript = JSON.parse(await readFile(path.join(recorded!.sessionDir, `${recorded!.sessionRef}.json`), "utf8"));
    expect(recorded!.sessionDir.startsWith(path.join(report.stateDir, "agent-sessions"))).toBe(true);
    expect(transcript.turns).toHaveLength(2);
    expect(await readTree(report.stateDir)).not.toContain(TOKEN);
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
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(
            piJob([
              { tool: "read_comments", args: { ...repo, number: 1 } },
              { tool: "comment", args: { ...repo, issueNumber: 1, body: "Working on it.", idempotencyKey: "status" } },
              writeGreetingCall,
              { text: "Wrote GREETING.txt and posted a status comment." },
            ]),
            "implement",
          ),
          ...rest,
        ],
      }),
      validators,
      runner: await piRunner(server),
      stateRoot: env.stateRoot,
      runId: "pi-agent",
    });

    expect(report.status, report.blocker).toBe("succeeded");
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
    const [recorded] = state.agentSessions!;
    expect(await readdir(recorded!.sessionDir)).toEqual([`${agent!.sessionRef}.jsonl`]);
    const tree = await readTree(report.stateDir);
    expect(tree).not.toContain(TOKEN);
    expect(tree).not.toContain(PI_KEY);
  });

  it("continues the saved Pi session in a new executor process", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(piJob([{ text: "Not done yet." }]), "first try"),
          retry,
          (view: RunView) =>
            dispatch(piJob([writeGreetingCall, { text: "Done." }], view.agentSessions![0]!.operationId), "continue"),
          ...rest,
        ],
      }),
      validators,
      runner: await piRunner(server),
      stateRoot: env.stateRoot,
      runId: "pi-continue",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    const [first, continued] = piAgents(report.evidence);
    expect(continued).toMatchObject({ continued: true, sessionRef: first!.sessionRef });
    const [recorded] = (await loadRunState(report.stateDir)).agentSessions!;
    const transcript = await readFile(path.join(recorded!.sessionDir, `${first!.sessionRef}.jsonl`), "utf8");
    expect(transcript).toContain("Implement issue #1 and post a status comment.");
    expect(transcript).toContain("Not done yet.");
    expect(transcript).toContain(CONTINUATION_NOTICE.slice(0, 40));
    expect(transcript).toContain("Finish issue #1.");
    expect(transcript).not.toContain(PI_KEY);
  });
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
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
