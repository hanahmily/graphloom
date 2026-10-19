import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
import { createScope, createTaskWorkspace, HELLO_REQUEST } from "@graphloom/testkit";
import { githubRunner as hostGitHubRunner } from "./github-runner.js";

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
          stop({ reason: "complete", blocker: "none" }, "done"),
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
    expect(state.budgets.jobs).toBe(127);
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

/** A scratch repository with a hello task beside it and the hello bundle installed. */
async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const scope = createScope();
  cleanups.push(() => scope.dispose());
  return createTaskWorkspace(scope, { graph: "hello", request: HELLO_REQUEST });
}
