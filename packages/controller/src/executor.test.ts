// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  type Validator,
} from "@graphloom/sdk";
import { createChildExecutorRunner, createScriptedRunner } from "@graphloom/runner";
import { createController, loadRunState } from "./index.js";
import { HELLO_VERSION } from "./testing/hello-version.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";

const definition: GraphDefinition = {
  graphId: "hello",
  version: HELLO_VERSION,
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

const exactGreeting: Validator = {
  evaluate(input) {
    const file = [...input.evidence].reverse().find((e) => e.kind === "file")?.payload as
      | { path?: string; bytes?: string }
      | undefined;
    const manifest = [...input.evidence]
      .reverse()
      .find((e) => e.kind === "workspace")?.payload as { changedPaths?: string[] } | undefined;
    if (!file || !manifest) {
      return { status: "inconclusive", reason: "missing" };
    }
    if (file.path !== GREETING_PATH || file.bytes !== GREETING) {
      return { status: "failed", reason: "bad bytes" };
    }
    if (
      !manifest.changedPaths?.includes(GREETING_PATH) ||
      manifest.changedPaths.some((p) => p !== GREETING_PATH)
    ) {
      return { status: "failed", reason: "bad scope" };
    }
    return { status: "passed", reason: "ok" };
  },
};

const independentReview: Validator = {
  evaluate(input) {
    const review = [...input.evidence].reverse().find((e) => e.kind === "review")?.payload as
      | { verdict?: string }
      | undefined;
    if (!review) {
      return { status: "inconclusive", reason: "missing" };
    }
    if (review.verdict === "approved") {
      return { status: "passed", reason: "approved" };
    }
    return { status: "failed", reason: "not approved" };
  },
};

const validators = {
  "exact-greeting": exactGreeting,
  "independent-reviewer": independentReview,
};

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
  }
});

describe("executor contract (#38)", () => {
  it("pins legacy agent jobs and records executor identity on evidence", async () => {
    const env = await makeEnv();
    const controller = createController();
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "write",
              writeScope: [GREETING_PATH],
            },
            "write",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
          dispatch(
            {
              stageId: "review",
              kind: "agent",
              purpose: "review",
              instruction: "review",
              readOnly: true,
            },
            "review",
          ),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      validators,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
          async () => ({
            status: "ok" as const,
            summary: "approved",
            evidence: [
              { kind: "review" as const, payload: { verdict: "approved", summary: "ok" } },
            ],
          }),
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "pin1",
    });

    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const reviewEv = [...state.evidence].reverse().find((e) => e.kind === "review");
    const producer = (reviewEv?.payload as { producer?: { executorId?: string } } | undefined)
      ?.producer;
    expect(producer?.executorId).toBe("graphloom.agent/run");
  });

  it("rejects unqualified executor pins at admission", async () => {
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
              executor: { id: "not-qualified" },
            },
            "bad pin",
          ),
        ],
      }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "badpin1",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("executor pin rejected");
    expect(report.blocker).toMatch(/qualified/);
  });

  it("runs a user-authored custom executor in a child process", async () => {
    const env = await makeEnv();
    const fixture = path.resolve(
      here,
      "../../runner/test/fixtures/write-greeting-executor.mjs",
    );

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
              instruction: "custom write",
              writeScope: [GREETING_PATH],
              executor: { id: "acme.hello/write-greeting", version: "1" },
              input: {},
            },
            "custom executor write",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
          dispatch(
            {
              stageId: "review",
              kind: "agent",
              purpose: "review",
              instruction: "review",
              readOnly: true,
            },
            "review",
          ),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      validators,
      runner: createChildExecutorRunner({
        entryModule: fixture,
        executorIds: ["acme.hello/write-greeting"],
        fallback: createScriptedRunner({
          jobs: [
            async () => ({
              status: "ok" as const,
              summary: "approved",
              evidence: [
                { kind: "review" as const, payload: { verdict: "approved", summary: "ok" } },
              ],
            }),
          ],
        }),
      }),
      stateRoot: env.stateRoot,
      runId: "custom1",
    });

    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const customProducer = state.evidence
      .map((e) => (e.payload as { producer?: { executorId?: string } } | undefined)?.producer)
      .find((p) => p?.executorId === "acme.hello/write-greeting");
    expect(customProducer?.executorId).toBe("acme.hello/write-greeting");
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId).sort()).toEqual([
      "review",
      "write",
    ]);
  });

  it("rejects work jobs without writeScope", async () => {
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
            },
            "missing scope",
          ),
        ],
      }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "scope1",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("scope rejected");
    expect(report.blocker).toMatch(/non-empty writeScope/);
  });

  it("stops, recorded, on an observation outside the worktree", async () => {
    const env = await makeEnv();
    const outside = path.dirname(env.taskPath);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [observe({ paths: [outside] }, "look around")] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "observe-escape",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "observe rejected", blocker: `path escapes worktree: ${outside}` });
    const saved = await loadRunState(path.join(env.stateRoot, "observe-escape"));
    expect(saved).toMatchObject({ status: "stopped", stopReason: "observe rejected" });
  });

  it("rejects oversized executor input before durable admission", async () => {
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
              executor: { id: "acme.echo/ping" },
              input: "x".repeat(300_000),
            },
            "huge input",
          ),
        ],
      }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "huge1",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("executor pin rejected");
    expect(report.blocker).toMatch(/exceeds/);
  });
});

async function makeEnv(): Promise<{
  taskDir: string;
  taskPath: string;
  repoPath: string;
  stateRoot: string;
}> {
  // Rebuilding rewrites dist/ under test files that run in parallel; `npm test` builds it first.
  if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
    await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-exec-"));
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
  return { taskDir, taskPath, repoPath, stateRoot: path.join(taskDir, "state") };
}
