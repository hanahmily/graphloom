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
  reenter,
  returnToNormal,
  stop,
  validate,
  type EvidenceRecord,
  type ExecutorSession,
  type GraphDefinition,
  type JobSpec,
  type RunView,
  type ScriptedAdvance,
  type ToolBinding,
  type ToolCallResult,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, createTrustedInProcessRunner } from "@graphloom/runner";
import type { Supervisor } from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const AGENT = "acme.agent/code";
const READ = "acme.github/list-comments";
const WRITE = "acme.github/post-comment";

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

const latest = (evidence: EvidenceRecord[], kind: string) =>
  [...evidence].reverse().find((e) => e.kind === kind)?.payload as Record<string, unknown> | undefined;

const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate({ evidence }) {
      const file = latest(evidence, "file");
      return file?.path === GREETING_PATH && file.bytes === GREETING
        ? { status: "passed", reason: "ok" }
        : { status: "inconclusive", reason: "missing greeting" };
    },
  },
  "independent-reviewer": {
    evaluate({ evidence }) {
      return latest(evidence, "review")?.verdict === "approved"
        ? { status: "passed", reason: "approved" }
        : { status: "inconclusive", reason: "missing review" };
    },
  },
};

const tools: ToolBinding[] = [
  { name: "read_comments", effect: "read", executor: { id: READ, version: "1" } },
  { name: "post_comment", effect: "write", executor: { id: WRITE, version: "1" } },
];

type Step = { tool: string; id: string; input?: unknown } | { detach: string; input?: unknown } | { write: true };

interface AgentRun {
  operationId: string;
  session: ExecutorSession | undefined;
  results: ToolCallResult[];
}

/**
 * In-process executors: an agent that reports its session like a resumable
 * harness (a continued session keeps its ref), and its tools.
 */
function executors() {
  const runs: AgentRun[] = [];
  const counts = { read: 0, write: 0 };
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => (writeStarted = resolve));
  const agent = defineExecutor<{ steps: Step[]; noSession?: boolean; fail?: boolean }, unknown>({
    id: AGENT,
    version: "1",
    effect: "write",
    async execute(input, ctx) {
      const run: AgentRun = { operationId: ctx.operationId, session: ctx.session, results: [] };
      runs.push(run);
      for (const step of input.steps) {
        if ("tool" in step) {
          run.results.push(await ctx.tools!.call({ toolCallId: step.id, tool: step.tool, input: step.input ?? {} }));
        } else if ("detach" in step) {
          // Returns with the write still in flight, so the controller cancels it and cannot know its outcome.
          void ctx.tools!.call({ toolCallId: "detached", tool: step.detach, input: step.input ?? {} });
          await started;
        } else {
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
        }
      }
      const sessionRef = input.noSession ? undefined : (ctx.session?.resume ?? `s-${runs.length}`);
      return {
        status: input.fail ? "failed" : "ok",
        summary: input.fail ? "agent gave up" : "agent done",
        ...(sessionRef !== undefined ? { sessionRef } : {}),
      };
    },
  });
  const runner = createTrustedInProcessRunner({
    executors: [
      agent,
      defineExecutor({
        id: READ,
        version: "1",
        effect: "read",
        execute: () => {
          counts.read += 1;
          return { status: "ok", summary: "2 comments" };
        },
      }),
      defineExecutor({
        id: WRITE,
        version: "1",
        effect: "write",
        async execute(input, ctx) {
          counts.write += 1;
          if ((input as { hang?: boolean }).hang === true) {
            writeStarted();
            await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { status: "ok", summary: "posted" };
        },
      }),
    ],
    fallback: createScriptedRunner({
      jobs: Array.from({ length: 4 }, () => async () => ({
        status: "ok" as const,
        summary: "approved",
        evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }],
      })),
    }),
  });
  return { runner, runs, counts };
}

const agentJob = (steps: Step[], over: Partial<JobSpec> = {}): JobSpec => ({
  stageId: "write",
  kind: "agent",
  purpose: "work",
  instruction: "implement",
  writeScope: [GREETING_PATH],
  executor: { id: AGENT, version: "1" },
  tools,
  input: { steps },
  ...over,
});

const firstSession = (view: RunView) => view.agentSessions![0]!.operationId;
const continueFirst = (steps: Step[], over: Partial<JobSpec> = {}): ScriptedAdvance => (view) =>
  dispatch(agentJob(steps, { continueFrom: firstSession(view), ...over }), "continue");

const finish: ScriptedAdvance[] = [
  observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];
const retry = reenter({ stageId: "write", reason: "first attempt wrote nothing" }, "retry");

const graph = (advances: ScriptedAdvance[]) => createScriptedGraph({ definition, advances });

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
  }
});

describe("continuing an agent session on reentry (#53)", () => {
  it("resumes the recorded session when a reentered dispatch names it, and starts fresh otherwise", async () => {
    const env = await makeEnv();
    const { runner, runs, counts } = executors();
    const views: RunView[] = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([
        dispatch(agentJob([{ tool: "read_comments", id: "c1" }]), "first try"),
        retry,
        (view) => {
          views.push(view);
          return dispatch(
            agentJob(
              [
                { tool: "read_comments", id: "c1" },
                { tool: "read_comments", id: "c2" },
                { write: true },
              ],
              { continueFrom: firstSession(view) },
            ),
            "continue",
          );
        },
        ...finish,
      ]),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "cont1",
    });
    expect(report.status, report.blocker).toBe("succeeded");

    const [first, continued] = runs;
    expect(runs).toHaveLength(2);
    const dir = path.join(report.stateDir, "agent-sessions", first!.operationId);
    expect(first!.session).toEqual({ dir });
    expect(continued!.session).toEqual({ dir, resume: "s-1" });

    expect(views[0]!.agentSessions).toEqual([
      {
        operationId: first!.operationId,
        stageId: "write",
        attempt: 1,
        generation: 1,
        dispatchKey: `work:${AGENT}`,
        executorId: AGENT,
        status: "ok",
      },
    ]);
    const state = await loadRunState(report.stateDir);
    expect(state.agentSessions?.map((s) => [s.operationId, s.attempt, s.sessionRef, s.sessionDir, s.continuedFrom])).toEqual([
      [first!.operationId, 1, "s-1", dir, undefined],
      [continued!.operationId, 2, "s-1", dir, first!.operationId],
    ]);
    // The earlier turn's call is not repeated; the new one is admitted and budgeted like any other.
    expect(continued!.results.map((r) => [r.status, r.summary])).toEqual([
      ["failed", "tool call c1 belongs to an earlier attempt; make a new call"],
      ["ok", "2 comments"],
    ]);
    expect(counts.read).toBe(2);
    expect(state.childOperations?.map((c) => [c.toolCallId, c.attempt, c.parentOperationId])).toEqual([
      ["c1", 1, first!.operationId],
      ["c2", 2, continued!.operationId],
    ]);
    // Two agent jobs, two children, one reviewer.
    expect(state.budgets.jobs).toBe(64 - 5);
  });

  it("gives a dispatch without continueFrom a fresh session of its own", async () => {
    const env = await makeEnv();
    const { runner, runs } = executors();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob([]), "first try"), retry, dispatch(agentJob([{ write: true }]), "fresh"), ...finish]),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "fresh1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(runs.map((r) => r.session)).toEqual(
      runs.map((r) => ({ dir: path.join(report.stateDir, "agent-sessions", r.operationId) })),
    );
    const state = await loadRunState(report.stateDir);
    expect(state.agentSessions?.map((s) => s.continuedFrom)).toEqual([undefined, undefined]);
  });

  it("stops before running a job whose continuation the controller cannot admit", async () => {
    const first = dispatch(agentJob([]), "first");
    const cases: Array<{ runId: string; advances: (runs: AgentRun[]) => ScriptedAdvance[]; blocker: RegExp; ran: number }> = [
      {
        runId: "unknown",
        advances: () => [dispatch(agentJob([], { continueFrom: "op-elsewhere" }), "foreign")],
        blocker: /^no agent session was recorded for operation op-elsewhere in run unknown$/,
        ran: 0,
      },
      {
        runId: "unsaved",
        advances: (runs) => [
          dispatch(agentJob([], { input: { steps: [], noSession: true } }), "first"),
          retry,
          () => dispatch(agentJob([], { continueFrom: runs[0]!.operationId }), "continue"),
        ],
        blocker: /^no agent session was recorded for operation op-\S+ in run unsaved$/,
        ran: 1,
      },
      {
        runId: "stage",
        advances: () => [first, continueFirst([], { stageId: "review" })],
        blocker: /^operation op-\S+ ran stage write, not review$/,
        ran: 1,
      },
      {
        runId: "key",
        advances: () => [first, retry, continueFirst([], { jobId: "other" })],
        blocker: /^operation op-\S+ has dispatch key work:acme\.agent\/code, not other$/,
        ran: 1,
      },
      {
        runId: "twice",
        advances: () => [first, retry, continueFirst([]), retry, continueFirst([])],
        blocker: /^operation op-\S+ was already continued by op-\S+; continue from that one$/,
        ran: 2,
      },
    ];
    for (const { runId, advances, blocker, ran } of cases) {
      const env = await makeEnv();
      const { runner, runs } = executors();
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: graph(advances(runs)),
        validators,
        runner,
        stateRoot: env.stateRoot,
        runId,
      });
      expect(report, runId).toMatchObject({ status: "stopped", stopReason: "continuation rejected" });
      expect(report.blocker, runId).toMatch(blocker);
      expect(runs, runId).toHaveLength(ran);
    }
  });

  it("keeps an unreconciled write from the earlier attempt blocking the continued session", async () => {
    const env = await makeEnv();
    const { runner, runs, counts } = executors();
    const body = { body: "status", hang: true };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([
        dispatch(agentJob([{ detach: "post_comment", input: body }]), "first try"),
        retry,
        continueFirst([
          { tool: "post_comment", id: "retry-1", input: body },
          { tool: "post_comment", id: "other-1", input: { body: "different" } },
          { write: true },
        ]),
        ...finish,
      ]),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "ambig1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    const results = runs[1]!.results;
    expect(results[0]).toEqual({
      status: "failed",
      summary: "tool call retry-1 repeats post_comment call detached from an earlier attempt, whose outcome is unreconciled",
    });
    expect(results[1]).toMatchObject({ status: "ok", summary: "posted" });
    // The blocked retry never reached the service; the unrelated write did.
    expect(counts.write).toBe(2);
    const state = await loadRunState(report.stateDir);
    expect(state.childOperations?.map((c) => [c.toolCallId, c.status])).toEqual([
      ["detached", "ambiguous"],
      ["other-1", "ok"],
    ]);
  });

  it("lets the supervisor continue a failed attempt's session in recovery", async () => {
    const env = await makeEnv();
    const { runner, runs } = executors();
    const seen: RunView[] = [];
    const supervisor: Supervisor = {
      async decide(input) {
        seen.push(input.view);
        return seen.length === 1
          ? dispatch(agentJob([{ write: true }], { continueFrom: firstSession(input.view) }), "resume the agent's session")
          : returnToNormal({ summary: "agent finished" }, "done");
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob([], { input: { steps: [], fail: true } }), "first try"), ...finish]),
      validators,
      runner,
      supervisor,
      stateRoot: env.stateRoot,
      runId: "recover1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(seen[0]!.agentSessions).toEqual([expect.objectContaining({ status: "failed", stageId: "write" })]);
    expect(runs[1]!.session).toEqual({ dir: runs[0]!.session!.dir, resume: "s-1" });
  });

  it("continues a session recorded before the controller stopped and resumed", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = executors();
    const stopped = await controller.run({
      taskPath: env.taskPath,
      plugin: graph([dispatch(agentJob([]), "first try"), stop({ reason: "pause", blocker: "operator" }, "pause")]),
      validators,
      runner: first.runner,
      stateRoot: env.stateRoot,
      runId: "resume1",
    });
    expect(stopped.status).toBe("stopped");

    const second = executors();
    const resumed = await controller.resume({
      runRef: stopped.stateDir,
      plugin: graph([retry, continueFirst([{ write: true }]), ...finish]),
      validators,
      runner: second.runner,
    });
    expect(resumed.status, resumed.blocker).toBe("succeeded");
    const dir = path.join(stopped.stateDir, "agent-sessions", first.runs[0]!.operationId);
    expect(second.runs[0]!.session).toEqual({ dir, resume: "s-1" });
  });
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-cont-"));
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
`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}
