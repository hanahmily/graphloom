import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  type ExecutorContext,
  type GraphDefinition,
  type ToolBinding,
  type ToolCallResult,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, createTrustedInProcessRunner, type Runner } from "@graphloom/runner";
import { createController, loadRunState } from "./index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const AGENT = "acme.agent/code";
const READ = "acme.github/list-comments";
const WRITE = "acme.github/post-comment";
const TESTS = "acme.command/run-tests";

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

const exactGreeting: Validator = {
  evaluate({ evidence }) {
    const file = latest(evidence, "file");
    return file?.path === GREETING_PATH && file.bytes === GREETING
      ? { status: "passed", reason: "ok" }
      : { status: "inconclusive", reason: "missing greeting" };
  },
};

/** Requires a passing test run recorded by a command executor, not the agent. */
const greetingWithTests: Validator = {
  evaluate(input) {
    const greeting = exactGreeting.evaluate(input) as { status: string };
    const tests = latest(input.evidence, "command");
    if (greeting.status !== "passed") return { status: "inconclusive", reason: "missing greeting" };
    if (!tests) return { status: "inconclusive", reason: "no recorded test run" };
    return tests.exitCode === 0 ? { status: "passed", reason: "tests pass" } : { status: "failed", reason: "tests fail" };
  },
};

const independentReview: Validator = {
  evaluate({ evidence }) {
    return latest(evidence, "review")?.verdict === "approved"
      ? { status: "passed", reason: "approved" }
      : { status: "inconclusive", reason: "missing review" };
  },
};

const tools: ToolBinding[] = [
  { name: "read_comments", effect: "read", executor: { id: READ, version: "1" } },
  { name: "post_comment", effect: "write", executor: { id: WRITE, version: "1" } },
  { name: "run_tests", effect: "read", executor: { id: TESTS, version: "1" } },
];

type Step =
  | { tool: string; id: string; input?: unknown }
  | { parallel: Array<{ tool: string; id: string }> }
  | { model: number }
  | { toolsUntilRefused: string }
  | { detach: string }
  | { write: true }
  | { claim: Array<{ kind: "command" | "review" | "file"; payload: unknown }> };

interface Hooks {
  /** Runs inside a child executor before it returns. */
  onChild?: (id: string, ctx: ExecutorContext) => Promise<void>;
  /** A detaching agent returns once this resolves. */
  childStarted?: Promise<void>;
}

/** In-process executors standing in for the coding agent and its tools. */
function executors(hooks: Hooks = {}) {
  const counts = { read: 0, write: 0, tests: 0 };
  const child = (id: string, effect: "read" | "write", body: () => ToolCallResult) =>
    defineExecutor({
      id,
      version: "1",
      effect,
      async execute(_input, ctx) {
        await hooks.onChild?.(id, ctx);
        return body();
      },
    });
  const agent = defineExecutor<{ steps: Step[] }, unknown>({
    id: AGENT,
    version: "1",
    effect: "write",
    async execute(input, ctx) {
      const results: unknown[] = [];
      const claims: unknown[] = [];
      for (const step of input.steps) {
        if ("tool" in step) {
          results.push(await ctx.tools!.call({ toolCallId: step.id, tool: step.tool, input: step.input ?? {} }));
        } else if ("parallel" in step) {
          results.push(
            await Promise.all(step.parallel.map((c) => ctx.tools!.call({ toolCallId: c.id, tool: c.tool, input: {} }))),
          );
        } else if ("model" in step) {
          let granted = 0;
          for (let i = 0; i < step.model; i += 1) if (await ctx.usage!.reserveModelCall()) granted += 1;
          results.push({ granted });
        } else if ("toolsUntilRefused" in step) {
          let ok = 0;
          for (;;) {
            const r = await ctx.tools!.call({ toolCallId: `loop-${ok}`, tool: step.toolsUntilRefused, input: {} });
            if (r.status !== "ok") {
              results.push({ ok, refused: r.summary });
              break;
            }
            ok += 1;
          }
        } else if ("detach" in step) {
          // Starts a call and returns without waiting, as a parent that timed out would.
          void ctx.tools!.call({ toolCallId: "detached", tool: step.detach, input: {} });
          await hooks.childStarted;
        } else if ("write" in step) {
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
        } else {
          claims.push(...step.claim);
        }
      }
      return {
        status: "ok",
        summary: "agent done",
        evidence: [{ kind: "other", payload: { results } }, ...claims],
      };
    },
  });
  const runner = createTrustedInProcessRunner({
    executors: [
      agent,
      child(READ, "read", () => {
        counts.read += 1;
        return { status: "ok", summary: "2 comments", evidence: [{ kind: "other", payload: { comments: ["a", "b"] } }] };
      }),
      child(WRITE, "write", () => {
        counts.write += 1;
        return { status: "ok", summary: "posted" };
      }),
      child(TESTS, "read", () => {
        counts.tests += 1;
        return { status: "ok", summary: "tests passed", evidence: [{ kind: "command", payload: { command: "npm test", exitCode: 0 } }] };
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
  return { runner, counts };
}

function graph(steps: Step[]) {
  return createScriptedGraph({
    definition,
    advances: [
      dispatch(
        {
          stageId: "write",
          kind: "agent",
          purpose: "work",
          instruction: "implement",
          writeScope: [GREETING_PATH],
          executor: { id: AGENT, version: "1" },
          tools,
          input: { steps },
        },
        "implement",
      ),
      observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
      validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
      dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
      validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
      stop({ reason: "complete", blocker: "none" }, "done"),
    ],
  });
}

function agentResults(evidence: EvidenceRecord[]): unknown[] {
  const ev = evidence.find(
    (e) => (e.payload as { producer?: { executorId?: string } }).producer?.executorId === AGENT && e.kind === "other",
  );
  return (ev?.payload as { results: unknown[] }).results;
}

async function waitFor<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached");
}

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
  }
});

describe("agent tool calls as child operations (#40)", () => {
  it("delivers a child executor result to the waiting agent and records it against the parent", async () => {
    const env = await makeEnv();
    const { runner, counts } = executors();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([{ model: 2 }, { tool: "read_comments", id: "c1", input: { issue: 7 } }, { write: true }]),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "child1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(counts.read).toBe(1);

    const state = await loadRunState(report.stateDir);
    const [child] = state.childOperations!;
    expect(child).toMatchObject({
      toolCallId: "c1",
      tool: "read_comments",
      stageId: "write",
      attempt: 1,
      executor: { id: READ, version: "1" },
      effect: "read",
      input: { issue: 7 },
      status: "ok",
    });
    const parentOp = child!.parentOperationId;
    expect(agentResults(state.evidence)).toEqual([
      { granted: 2 },
      { status: "ok", summary: "2 comments", childOperationId: child!.childOperationId, evidence: [{ kind: "other", payload: { comments: ["a", "b"] } }] },
    ]);
    const childEvidence = state.evidence.find(
      (e) => (e.payload as { producer?: { operationId?: string } }).producer?.operationId === child!.childOperationId,
    );
    expect((childEvidence?.payload as { producer: unknown }).producer).toMatchObject({
      executorId: READ,
      parentOperationId: parentOp,
      toolCallId: "c1",
    });
    // Parent + child + reviewer spend jobs; the agent's two model requests replace its flat invocation charge.
    expect(state.budgets.jobs).toBe(128 - 3);
    expect(state.budgets.agentInvocations).toBe(64 - 2 - 1);
    expect(state.outstanding).toEqual([]);
  });

  it("replays a repeated tool call from the journal instead of running it again", async () => {
    const env = await makeEnv();
    const { runner, counts } = executors();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([
        { tool: "post_comment", id: "p1", input: { body: "a", issue: 7 } },
        { tool: "post_comment", id: "p1", input: { issue: 7, body: "a" } },
        { tool: "post_comment", id: "p1", input: { body: "b", issue: 7 } },
        { write: true },
      ]),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "replay1",
    });
    expect(report.status).toBe("succeeded");
    expect(counts.write).toBe(1);
    const [first, second, changed] = agentResults(report.evidence) as ToolCallResult[];
    expect(first).toMatchObject({ status: "ok", summary: "posted" });
    expect(second).toEqual({ ...first, replayed: true });
    expect(changed).toEqual({ status: "failed", summary: "tool call p1 was recorded with different input" });
  });

  it("refuses write tools to a job without write scope", async () => {
    const env = await makeEnv();
    const { runner, counts } = executors();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "check",
              instruction: "inspect",
              readOnly: true,
              executor: { id: AGENT, version: "1" },
              tools,
              input: { steps: [{ tool: "post_comment", id: "w1" }, { tool: "read_comments", id: "r1" }] },
            },
            "inspect",
          ),
          stop({ reason: "inspected", blocker: "none" }, "done"),
        ],
      }),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "readonly1",
    });
    const [write, read] = agentResults(report.evidence) as ToolCallResult[];
    expect(write).toEqual({ status: "failed", summary: "tool post_comment has effect write, but this job has no write scope" });
    expect(read).toMatchObject({ status: "ok", summary: "2 comments" });
    expect(counts).toEqual({ read: 1, write: 0, tests: 0 });
  });

  it("cancels a child still running when the parent returns, and records an interrupted write as ambiguous", async () => {
    const env = await makeEnv();
    let childSawAbort = false;
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => (started = resolve));
    const { runner } = executors({
      childStarted,
      async onChild(id, ctx) {
        if (id !== WRITE) return;
        started();
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
        childSawAbort = true;
      },
    });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([{ detach: "post_comment" }, { write: true }]),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "detach1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(childSawAbort).toBe(true);
    const state = await loadRunState(report.stateDir);
    expect(state.childOperations?.map((c) => [c.toolCallId, c.status])).toEqual([["detached", "ambiguous"]]);
    expect(state.childOperations?.[0]?.result).toBeUndefined();
    expect(state.outstanding).toEqual([]);
    // Only the parent and the reviewer are charged; the cancelled child is not.
    expect(state.budgets.jobs).toBe(128 - 2);
  });

  it("services one tool call at a time while the agent waits, without deadlock", async () => {
    const env = await makeEnv();
    const { runner, counts } = executors();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([
        { parallel: [{ tool: "read_comments", id: "a" }, { tool: "run_tests", id: "b" }] },
        { tool: "run_tests", id: "b" },
        { write: true },
      ]),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "serial1",
    });
    expect(report.status).toBe("succeeded");
    const [parallel, sequential] = agentResults(report.evidence) as [ToolCallResult[], ToolCallResult];
    expect(parallel[0]).toMatchObject({ status: "ok" });
    expect(parallel[1]).toEqual({ status: "failed", summary: "another tool call is in progress; tools run one at a time" });
    expect(sequential).toMatchObject({ status: "ok", summary: "tests passed" });
    expect(counts).toEqual({ read: 1, write: 0, tests: 1 });
  });

  it("stops granting jobs and model requests once the shared run budget is spent", async () => {
    const env = await makeEnv();
    const { runner } = executors();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph([{ model: 80 }, { toolsUntilRefused: "read_comments" }]),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "budget1",
    });
    const state = await loadRunState(report.stateDir);
    // Normal-mode model calls stop 8 short of 0: the default recoveryReserve
    // (max(8, 5%) of the 64 default agentInvocations budget) is never spent
    // outside recovery, so a metered supervisor always has budget to act.
    expect(agentResults(state.evidence)).toEqual([{ granted: 56 }, { ok: 127, refused: "jobs budget exhausted" }]);
    expect(state.budgets.agentInvocations).toBe(8);
    expect(state.budgets.jobs).toBe(0);
  }, 60_000);

  it("stop cancels the agent and its child, and fences the child's late result", async () => {
    const env = await makeEnv();
    let childSawAbort = false;
    const { runner } = executors({
      async onChild(_id, ctx) {
        await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
        childSawAbort = true;
      },
    });
    const controller = createController();
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: graph([{ tool: "read_comments", id: "c1" }, { write: true }]),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner,
      stateRoot: env.stateRoot,
      runId: "stop1",
    });
    const stateDir = path.join(env.stateRoot, "stop1");
    await waitFor(async () => ((await loadRunState(stateDir)).childOperations?.[0]?.status === "pending" ? true : undefined));
    await controller.stop(stateDir);
    const report = await running;

    expect(report.status).toBe("stopped");
    expect(childSawAbort).toBe(true);
    const state = await loadRunState(stateDir);
    expect(state.childOperations?.[0]?.status).toBe("fenced");
    expect(state.evidence.some((e) => (e.payload as { comments?: unknown }).comments !== undefined)).toBe(false);
  });

  it("replays settled tool calls to a retried agent after a crash", async () => {
    const env = await makeEnv();
    const first = executors();
    let crashed = false;
    const crashing: Runner = {
      async runJob(job, ctx) {
        const result = await first.runner.runJob(job, ctx);
        if (job.executor?.id === AGENT && !crashed) {
          crashed = true;
          throw new Error("controller crashed");
        }
        return result;
      },
    };
    const validators = { "exact-greeting": exactGreeting, "independent-reviewer": independentReview };
    await expect(
      createController().run({
        taskPath: env.taskPath,
        plugin: graph([{ tool: "post_comment", id: "p1" }]),
        validators,
        runner: crashing,
        stateRoot: env.stateRoot,
        runId: "crash1",
      }),
    ).rejects.toThrow("controller crashed");
    expect(first.counts.write).toBe(1);

    const second = executors();
    const resumed = await createController().resume({
      runRef: path.join(env.stateRoot, "crash1"),
      plugin: graph([{ tool: "post_comment", id: "p1" }, { write: true }]),
      validators,
      runner: second.runner,
    });
    expect(resumed.status, resumed.blocker).toBe("succeeded");
    expect(second.counts.write).toBe(0);
    expect(agentResults(resumed.evidence.filter((e) => e.generation === 2))[0]).toMatchObject({
      status: "ok",
      summary: "posted",
      replayed: true,
    });
  });

  it("on restart, reruns an interrupted read but stops for reconciliation of an interrupted write", async () => {
    for (const [tool, runId] of [["read_comments", "rread"], ["post_comment", "rwrite"]] as const) {
      const env = await makeEnv();
      const controller = createController();
      const { runner } = executors({
        onChild: (_id, ctx) =>
          new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true })),
      });
      const validators = { "exact-greeting": exactGreeting, "independent-reviewer": independentReview };
      const running = controller.run({
        taskPath: env.taskPath,
        plugin: graph([{ tool, id: "x1" }]),
        validators,
        runner,
        stateRoot: env.stateRoot,
        runId,
      });
      const stateDir = path.join(env.stateRoot, runId);
      const stateFile = path.join(stateDir, "state.json");
      // Durable state as a crash would leave it: child admitted, not settled.
      await waitFor(async () => ((await loadRunState(stateDir)).childOperations?.[0]?.status === "pending" ? true : undefined));
      await copyFile(stateFile, `${stateFile}.crash`);
      await controller.stop(stateDir);
      await running;
      await copyFile(`${stateFile}.crash`, stateFile);

      const retry = executors();
      const resumed = await controller.resume({
        runRef: stateDir,
        plugin: graph([{ tool, id: "x1" }, { write: true }]),
        validators,
        runner: retry.runner,
      });
      const state = await loadRunState(stateDir);
      if (tool === "read_comments") {
        expect(resumed.status, resumed.blocker).toBe("succeeded");
        expect(state.childOperations?.map((c) => c.status)).toEqual(["abandoned", "ok"]);
        expect(retry.counts.read).toBe(1);
      } else {
        expect(resumed).toMatchObject({ status: "stopped", stopReason: "reconcile required" });
        expect(resumed.blocker).toMatch(/may have reached an external service: child-.* \(post_comment, write\)/);
        expect(state.childOperations?.map((c) => c.status)).toEqual(["ambiguous"]);
        expect(retry.counts.write).toBe(0);
      }
    }
  });

  it("accepts test evidence from a command child but not the agent's own claim", async () => {
    const validators = { "exact-greeting": greetingWithTests, "independent-reviewer": independentReview };
    const claimed = await makeEnv();
    const selfReported = await createController().run({
      taskPath: claimed.taskPath,
      plugin: graph([
        { write: true },
        {
          claim: [
            { kind: "command", payload: { command: "npm test", exitCode: 0 } },
            { kind: "review", payload: { verdict: "approved" } },
          ],
        },
      ]),
      validators,
      runner: executors().runner,
      stateRoot: claimed.stateRoot,
      runId: "claim1",
    });
    expect(selfReported.receipts.filter((r) => r.valid && r.stageId === "write")).toEqual([]);
    const claims = selfReported.evidence.filter((e) => (e.payload as { selfReported?: string }).selfReported);
    expect(claims.map((e) => [e.kind, (e.payload as { selfReported: string }).selfReported])).toEqual([
      ["other", "command"],
      ["other", "review"],
    ]);

    const tested = await makeEnv();
    const report = await createController().run({
      taskPath: tested.taskPath,
      plugin: graph([{ write: true }, { tool: "run_tests", id: "t1" }]),
      validators,
      runner: executors().runner,
      stateRoot: tested.stateRoot,
      runId: "tested1",
    });
    expect(report.status, report.blocker).toBe("succeeded");
  });

  it("rejects a tool binding the SDK cannot pin", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "x",
              writeScope: [GREETING_PATH],
              executor: { id: AGENT, version: "1" },
              tools: [{ name: "Read Comments", effect: "read", executor: { id: READ } }],
              input: { steps: [] },
            },
            "bad tool",
          ),
        ],
      }),
      validators: { "exact-greeting": exactGreeting, "independent-reviewer": independentReview },
      runner: executors().runner,
      stateRoot: env.stateRoot,
      runId: "badtool1",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "executor pin rejected" });
    expect(report.blocker).toMatch(/tool name must match/);
  });
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-child-"));
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
