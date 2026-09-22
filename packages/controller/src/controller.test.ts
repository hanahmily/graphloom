import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
  type GraphPlugin,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import {
  createController,
  IntakeError,
  loadRunState,
  parseTaskYaml,
  resolveUnderBase,
  tryAdmit,
} from "./index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";

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
      statement: "exact greeting bytes and sole path",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: "independent-review",
      statement: "independent reviewer approves",
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
    const file = latest(input.evidence, "file") as { path?: string; bytes?: string } | undefined;
    const manifest = latest(input.evidence, "workspace") as { changedPaths?: string[] } | undefined;
    if (!file || !manifest) {
      return { status: "inconclusive", reason: "missing evidence" };
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
    const review = latest(input.evidence, "review") as { verdict?: string } | undefined;
    if (!review) {
      return { status: "inconclusive", reason: "missing review" };
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
  // Best-effort cleanup of git worktrees created under temp repos.
  for (const dir of temps.splice(0)) {
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
    } catch {
      /* ignore */
    }
  }
});

describe("parseTaskYaml / path safety", () => {
  it("parses multiline request", () => {
    const task = parseTaskYaml(`graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
`);
    expect(task.graph).toBe("hello");
    expect(task.repo).toBe("./test-repo");
    expect(task.request).toContain("GREETING.txt");
  });

  it("rejects path traversal", () => {
    expect(() => resolveUnderBase("/tmp/task", "../etc/passwd", "repo")).toThrow(IntakeError);
    expect(() => resolveUnderBase("/tmp/task", "/etc/passwd", "repo")).toThrow(IntakeError);
  });
});

describe("durable controller Write→Review", () => {
  it("pins hello bundle, isolates worktree, Accepts only via controller", async () => {
    const env = await makeEnv();
    const plugin = scriptedHappyPath();
    const runner = createScriptedRunner({
      jobs: [
        async (job, ctx) => {
          expect(job.stageId).toBe("write");
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
          return { status: "ok", summary: "wrote greeting" };
        },
        async (job) => {
          expect(job.stageId).toBe("review");
          expect(job.readOnly).toBe(true);
          return {
            status: "ok",
            summary: "approved",
            evidence: [
              {
                kind: "review",
                payload: { verdict: "approved", summary: "looks good" },
              },
            ],
          };
        },
      ],
    });

    const dirtyMarker = "DIRTY_SOURCE.txt";
    await writeFile(path.join(env.repoPath, dirtyMarker), "do-not-copy\n", "utf8");

    const controller = createController();
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      runner,
      validators,
      stateRoot: env.stateRoot,
      runId: "happy1",
    });

    expect(report.status).toBe("succeeded");
    expect(report.bundlePath).toBe(path.resolve(env.taskDir, "plugins/hello"));
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId).sort()).toEqual([
      "review",
      "write",
    ]);
    expect(report.evidence.some((e) => e.kind === "file")).toBe(true);
    expect(report.evidence.some((e) => e.kind === "workspace")).toBe(true);
    expect(report.sourceDirtyAfter).toContain(dirtyMarker);

    const worktreeGreeting = await readFile(
      path.join(report.worktreePath, GREETING_PATH),
      "utf8",
    );
    expect(worktreeGreeting).toBe(GREETING);

    // Dirty source file was not copied into the worktree.
    await expect(readFile(path.join(report.worktreePath, dirtyMarker), "utf8")).rejects.toThrow();

    // Plugin cannot mint Accept — receipts come only from controller admission.
    expect(report.receipts.every((r) => r.id.startsWith("rcpt-"))).toBe(true);
  });

  it("rejects stale evidence after generation bump (restart freshness)", async () => {
    const env = await makeEnv();
    const plugin = scriptedHappyPath();
    const runner = createScriptedRunner({
      jobs: [
        async (_job, ctx) => {
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
          return { status: "ok", summary: "wrote" };
        },
        async () => ({
          status: "ok",
          summary: "approved",
          evidence: [{ kind: "review", payload: { verdict: "approved" } }],
        }),
      ],
    });

    // Run only until Write evidence exists: use a plugin that stops after observe.
    const observeOnly = createScriptedGraph({
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
          "dispatch writer",
        ),
        observe(
          { paths: [GREETING_PATH], includeWorkspaceManifest: true },
          "observe",
        ),
        stop({ reason: "paused", blocker: "test pause" }, "pause before validate"),
      ],
    });

    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: observeOnly,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
        ],
      }),
      validators,
      stateRoot: env.stateRoot,
      runId: "stale1",
    });
    expect(paused.status).toBe("stopped");

    let state = await loadRunState(paused.stateDir);
    // Simulate crash restart: bump generation so prior Observe evidence is stale.
    state = { ...state, status: "running", generation: state.generation + 1 };
    const admit = tryAdmit(state, "write", validators);
    expect(admit.accepted).toBe(false);
    expect(admit.reason).toMatch(/no fresh evidence/);

    // Full happy path still works with fresh generation evidence from a new run.
    const ok = await controller.run({
      taskPath: env.taskPath,
      plugin,
      runner,
      validators,
      stateRoot: env.stateRoot,
      runId: "stale1-ok",
    });
    expect(ok.status).toBe("succeeded");
  });

  it("rejects path traversal in task repo", async () => {
    const env = await makeEnv();
    await writeFile(
      env.taskPath,
      `graph: hello
repo: ../outside
request: |
  hello
`,
      "utf8",
    );
    const controller = createController();
    await expect(
      controller.run({
        taskPath: env.taskPath,
        plugin: scriptedHappyPath(),
        runner: createScriptedRunner({ jobs: [] }),
        validators,
        stateRoot: env.stateRoot,
      }),
    ).rejects.toThrow(/traversal|escapes|relative/i);
  });
});

function latest(evidence: { kind: string; payload?: unknown }[], kind: string): unknown {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    if (evidence[i]?.kind === kind) {
      return evidence[i]?.payload;
    }
  }
  return undefined;
}

function scriptedHappyPath(): GraphPlugin {
  return createScriptedGraph({
    definition,
    advances: [
      dispatch(
        {
          stageId: "write",
          kind: "agent",
          purpose: "work",
          instruction: "write greeting",
          writeScope: [GREETING_PATH],
        },
        "dispatch writer",
      ),
      observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe write"),
      validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
      dispatch(
        {
          stageId: "review",
          kind: "agent",
          purpose: "review",
          instruction: "review",
          readOnly: true,
        },
        "dispatch reviewer",
      ),
      validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review"),
      stop({ reason: "complete", blocker: "none" }, "done"),
    ],
  });
}

async function makeEnv(): Promise<{
  taskDir: string;
  taskPath: string;
  repoPath: string;
  stateRoot: string;
}> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-task-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });

  const pluginsDir = path.join(taskDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await symlink(helloBundle, path.join(pluginsDir, "hello"));

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

  const stateRoot = path.join(taskDir, "state");
  return { taskDir, taskPath, repoPath, stateRoot };
}
