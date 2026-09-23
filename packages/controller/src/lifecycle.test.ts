import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createController } from "./index.js";
import { createScriptedRunner } from "@graphloom/runner";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
  }
});

describe("public controller: hello child host + stop/resume/inspect", () => {
  it("runs Write→Review via hello child process with scripted agents", async () => {
    const env = await makeEnv();
    const controller = createController();
    const report = await controller.run({
      taskPath: env.taskPath,
      // No plugin/host → child loads pinned hello bundle.
      runner: helloScriptedRunner(),
      stateRoot: env.stateRoot,
      runId: "child1",
    });

    expect(report.status).toBe("succeeded");
    expect(report.bundlePath).toBe(path.resolve(env.taskDir, "plugins/hello"));
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId).sort()).toEqual([
      "review",
      "write",
    ]);

    const inspected = await controller.inspect(report.stateDir);
    expect(inspected.mode).toBe("normal");
    expect(inspected.stages.map((s) => s.id)).toEqual(["write", "review"]);
    expect(inspected.stages.every((s) => s.complete)).toBe(true);
    expect(inspected.evidenceRefs.length).toBeGreaterThan(0);
    expect(inspected.budgets.agentInvocations).toBeLessThan(32);
    expect(inspected.versionHistory.length).toBeGreaterThanOrEqual(1);
    expect(inspected.versionHistory[0]?.reason).toBe("intake");
    expect(inspected.activeVersion).toContain("hello@");
  });

  it("stop reaps the child and leaves a resumable stopped run", async () => {
    const env = await makeEnv();
    const controller = createController();

    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const runPromise = controller.run({
      taskPath: env.taskPath,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writerGate;
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "stop1",
    });

    const stateDir = path.join(env.stateRoot, "stop1");
    await waitForState(stateDir);

    const stopped = await controller.stop(stateDir);
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toMatch(/operator stop|plugin host/);
    expect(stopped.generation).toBeGreaterThanOrEqual(1);
    expect(stopped.versionHistory.length).toBeGreaterThanOrEqual(1);

    releaseWriter();
    await runPromise;

    const inspect = await controller.inspect(stateDir);
    expect(inspect.status).toBe("stopped");
    expect(inspect.stages.some((s) => s.id === "write")).toBe(true);
  });

  it("rejects late job results from an old generation", async () => {
    const env = await makeEnv();
    const controller = createController();
    const report = await controller.run({
      taskPath: env.taskPath,
      runner: {
        async runJob(_job, ctx) {
          return {
            status: "ok",
            summary: "forged",
            runId: ctx.runId,
            operationId: ctx.operationId,
            generation: 0,
          };
        },
      },
      stateRoot: env.stateRoot,
      runId: "forge1",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toMatch(/stale job result/);
  });

  it("resume after a clean graph pause continues via child host", async () => {
    const env = await makeEnv();
    const controller = createController();
    const { createScriptedGraph, dispatch, observe, stop, validate } = await import(
      "@graphloom/sdk"
    );

    const definition = {
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
          independence: "separate-reviewer" as const,
        },
      ],
    };

    // Pause after Write acceptance with no in-flight job.
    const paused = await controller.run({
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
            "dispatch writer",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
          stop({ reason: "paused", blocker: "test pause before review" }, "pause"),
        ],
      }),
      runner: adaptiveScriptedRunner(2),
      stateRoot: env.stateRoot,
      runId: "resume1",
    });
    expect(paused.status).toBe("stopped");
    expect(paused.stopReason).toBe("paused");

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      // Child hello takes over for Review → complete.
      runner: adaptiveScriptedRunner(4),
    });
    expect(resumed.status).toBe("succeeded");
    const inspect = await controller.inspect(paused.stateDir);
    expect(inspect.stages.every((s) => s.complete)).toBe(true);
    expect(inspect.versionHistory.some((v) => v.reason === "resume")).toBe(true);
  });
});

function helloScriptedRunner() {
  return adaptiveScriptedRunner(2);
}

/** Purpose-aware scripted jobs so Write/Review order stays flexible. */
function adaptiveScriptedRunner(count = 8) {
  const job = async (
    jobSpec: { purpose?: string; readOnly?: boolean },
    ctx: { worktreePath: string },
  ) => {
    if (jobSpec.purpose === "review" || jobSpec.readOnly) {
      return {
        status: "ok" as const,
        summary: "approved",
        evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
      };
    }
    await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
    return { status: "ok" as const, summary: "wrote greeting" };
  };
  return createScriptedRunner({
    jobs: Array.from({ length: count }, () => job),
  });
}

async function waitForState(stateDir: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      await readFile(path.join(stateDir, "state.json"), "utf8");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`state not created: ${stateDir}`);
}

async function makeEnv(): Promise<{
  taskDir: string;
  taskPath: string;
  repoPath: string;
  stateRoot: string;
}> {
  // Ensure hello dist exists for child import.
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], {
    cwd: repoRoot,
  });

  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-life-"));
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

  return { taskDir, taskPath, repoPath, stateRoot: path.join(taskDir, "state") };
}
