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
  stop,
  validate,
  type GraphDefinition,
  type ToolBinding,
  type Validator,
} from "@graphloom/sdk";
import { createBuiltinExecutorRunner, createScriptedRunner } from "@graphloom/runner";
import { createController, loadRunState } from "@graphloom/controller";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { codingAgentBinding, codingAgentExecutorPackage } from "@graphloom/executor-coding-agent";
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
function hostRunner(server: FakeGitHub) {
  return createBuiltinExecutorRunner({
    packages: [
      { manifest: githubExecutorPackage, ...githubBinding({ token: TOKEN, baseUrl: server.baseUrl, allowWrites: true }) },
      { manifest: codingAgentExecutorPackage, ...codingAgentBinding({ harness: scriptedHarnessModule }) },
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
