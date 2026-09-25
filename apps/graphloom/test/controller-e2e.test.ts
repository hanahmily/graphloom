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
  type JobSpec,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createController, loadRunState } from "@graphloom/controller";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { githubRunner as hostGitHubRunner } from "./github-runner.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const GREETING = "Hello, GraphLoom!\n";
const TOKEN = "ghp_controller_e2e_secret";

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
      const manifest = latest(input.evidence, "workspace") as { changedPaths?: string[] } | undefined;
      if (!file || !manifest) return { status: "inconclusive", reason: "missing" };
      const ok =
        file.path === "GREETING.txt" &&
        file.bytes === GREETING &&
        manifest.changedPaths?.length === 1 &&
        manifest.changedPaths[0] === "GREETING.txt";
      return ok ? { status: "passed", reason: "ok" } : { status: "failed", reason: "bad" };
    },
  },
  "independent-reviewer": {
    evaluate(input) {
      const review = latest(input.evidence, "review") as { verdict?: string } | undefined;
      return review?.verdict === "approved"
        ? { status: "passed", reason: "approved" }
        : { status: "failed", reason: "not approved" };
    },
  },
};

const githubJob = (id: string, input: unknown): JobSpec => ({
  stageId: "write",
  kind: "command",
  purpose: "check",
  instruction: `github ${id}`,
  readOnly: true,
  executor: { id: `graphloom.github/${id}`, version: "1" },
  input,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(): Promise<FakeGitHub> {
  const server = await startFakeGitHub({
    issues: Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      title: `issue ${i + 1}`,
      state: "open" as const,
      labels: ["bug"],
    })),
  });
  cleanups.push(() => server.close());
  return server;
}

function githubRunner(server: FakeGitHub, fallbackJobs: Parameters<typeof createScriptedRunner>[0]["jobs"] = []) {
  return hostGitHubRunner({
    fallback: createScriptedRunner({ jobs: fallbackJobs }),
    baseUrl: server.baseUrl,
    token: TOKEN,
  });
}

async function readTree(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) parts.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
  }
  return parts.join("\n");
}

describe("controller runs graphloom.github through the executor protocol", () => {
  it("records a bounded GitHub page as evidence alongside the hello run", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(githubJob("list-issues", { owner: "acme", repo: "app", labels: ["bug"], perPage: 2 }), "select"),
          dispatch(
            { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: ["GREETING.txt"] },
            "write",
          ),
          observe({ paths: ["GREETING.txt"], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
          dispatch(
            { stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true },
            "review",
          ),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
          stop({ reason: "complete" }, "done"),
        ],
      }),
      validators,
      runner: githubRunner(server, [
        async (_job, ctx) => {
          await writeFile(path.join(ctx.worktreePath, "GREETING.txt"), GREETING, "utf8");
          return { status: "ok", summary: "wrote" };
        },
        async () => ({
          status: "ok" as const,
          summary: "approved",
          evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
        }),
      ]),
      stateRoot: env.stateRoot,
      runId: "gh-select",
    });

    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const page = state.evidence
      .map((e) => e.payload as { github?: Record<string, unknown>; producer?: { executorId?: string } })
      .find((p) => p?.github?.operation === "list-issues");
    expect(page?.producer?.executorId).toBe("graphloom.github/list-issues");
    expect(page?.github?.page).toMatchObject({ nextCursor: "2", complete: false, pagesFetched: 1 });
    expect(page?.github?.query).toMatchObject({ labels: ["bug"], perPage: 2 });
    expect(server.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await readTree(report.stateDir)).not.toContain(TOKEN);
  });

  it("stops with the rate-limit retry timing inside the run's job budget", async () => {
    const server = await fake();
    server.rateLimitNext(1, 300);
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [dispatch(githubJob("list-issues", { owner: "acme", repo: "app" }), "select")],
      }),
      validators,
      runner: githubRunner(server),
      stateRoot: env.stateRoot,
      runId: "gh-rate",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toMatch(/^job failed: GitHub rate limited GET \/repos\/acme\/app\/issues; retry after \d+s/);
    expect(server.requests).toHaveLength(1);
    const state = await loadRunState(report.stateDir);
    expect(state.budgets.jobs).toBe(63);
  });

  it("keeps the bound token out of durable state when GitHub echoes it", async () => {
    const server = await fake();
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [dispatch(githubJob("get-issue", { owner: "acme", repo: "app", number: 401 }), "fetch")],
      }),
      validators,
      runner: githubRunner(server),
      stateRoot: env.stateRoot,
      runId: "gh-redact",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toContain("Bearer [REDACTED]");
    expect(await readTree(report.stateDir)).not.toContain(TOKEN);
  });
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-gh-e2e-"));
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
