import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { EvidenceRecord, Validator } from "@graphloom/sdk";
import { createController } from "./index.js";
import { createScriptedRunner } from "@graphloom/runner";
import { readOwnerClaim } from "./owner.js";
import { loadRunState } from "./state.js";

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
    expect(inspected.budgets.agentInvocations).toBeLessThan(64);
    expect(inspected.versionHistory.length).toBeGreaterThanOrEqual(1);
    expect(inspected.versionHistory[0]?.reason).toBe("intake");
    expect(inspected.activeVersion).toContain("hello@");
  });

  it("pins a caller-supplied rehearsalGate onto the run's own intake", async () => {
    const env = await makeEnv();
    const controller = createController();
    const rehearsalGate = {
      fingerprint: "sha256:deadbeef",
      verdict: "ready" as const,
      notes: ["L0 check passed", "L1 quick rehearsal passed"],
    };
    const report = await controller.run({
      taskPath: env.taskPath,
      runner: helloScriptedRunner(),
      stateRoot: env.stateRoot,
      runId: "gate1",
      rehearsalGate,
    });

    expect(report.status).toBe("succeeded");
    expect(report.rehearsalGate).toEqual(rehearsalGate);
    const state = await loadRunState(report.stateDir);
    expect(state.intake.rehearsalGate).toEqual(rehearsalGate);
    const inspected = await controller.inspect(report.stateDir);
    expect(inspected.rehearsalGate).toEqual(rehearsalGate);
  });

  it("stop reaps the child and leaves a resumable stopped run", async () => {
    const env = await makeEnv();
    const controller = createController();

    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let startedWriter!: () => void;
    const writerStarted = new Promise<void>((resolve) => { startedWriter = resolve; });

    const runPromise = controller.run({
      taskPath: env.taskPath,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            startedWriter();
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
    await writerStarted;

    const stopped = await controller.stop(stateDir);
    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toMatch(/operator stop|plugin host/);
    expect(stopped.generation).toBeGreaterThanOrEqual(1);
    expect(stopped.versionHistory.length).toBeGreaterThanOrEqual(1);
    expect(await readOwnerClaim(stateDir)).toBeDefined();

    releaseWriter();
    await runPromise;
    expect(await readOwnerClaim(stateDir)).toBeUndefined();

    const inspect = await controller.inspect(stateDir);
    expect(inspect.status).toBe("stopped");
    expect(inspect.stages.some((s) => s.id === "write")).toBe(true);

    // The stopped loop fenced the writer's result. Resume must reconcile its
    // visible output and remember who wrote it before independent review.
    const resumed = await controller.resume({ runRef: stateDir, runner: adaptiveScriptedRunner() });
    expect(resumed.status).toBe("succeeded");
    expect(resumed.receipts.filter((receipt) => receipt.valid).map((receipt) => receipt.stageId)).toEqual(["write", "review"]);
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

  it.each(["unchanged", "changed bytes", "changed bytes after review", "changed manifest"])("resume reassesses accepted evidence: %s", async (change) => {
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
      // Resume hands decisions to the real pinned hello bundle (child host),
      // whose dispatches name the same contracts hello itself declares.
      resultContracts: [
        { name: "writer-result-v1", schema: { type: "object" }, evidenceKind: "other" as const },
        {
          name: "review-verdict-v1",
          schema: { type: "object", properties: { verdict: { type: "string" }, summary: { type: "string" } }, required: ["verdict", "summary"] },
          evidenceKind: "review" as const,
        },
      ],
    };

    const latest = <T,>(evidence: readonly EvidenceRecord[], kind: string) =>
      [...evidence].reverse().find((e) => e.kind === kind)?.payload as T | undefined;
    const scriptedValidators: Record<string, Validator> = {
      "exact-greeting": {
        evaluate(input) {
          const file = latest<{ path?: string; bytes?: string }>(input.evidence, "file");
          const manifest = latest<{ changedPaths?: string[] }>(input.evidence, "workspace");
          if (!file || !manifest) {
            return { status: "inconclusive" as const, reason: "missing evidence" };
          }
          if (file.path !== GREETING_PATH || file.bytes !== GREETING) {
            return { status: "failed" as const, reason: "bad bytes" };
          }
          if (
            !manifest.changedPaths?.includes(GREETING_PATH) ||
            manifest.changedPaths.some((p) => p !== GREETING_PATH)
          ) {
            return { status: "failed" as const, reason: "bad scope" };
          }
          return { status: "passed" as const, reason: "ok" };
        },
      },
      "independent-reviewer": {
        evaluate(input) {
          const review = latest<{ verdict?: string }>(input.evidence, "review");
          if (!review) {
            return { status: "inconclusive" as const, reason: "missing review" };
          }
          if (review.verdict === "approved") {
            return { status: "passed" as const, reason: "approved" };
          }
          return { status: "failed" as const, reason: "not approved" };
        },
      },
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
          ...(change === "changed bytes after review" ? [
            dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
            observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe reviewed bytes"),
            validate({ stageId: "review" }, "validate review"),
          ] : []),
          stop({ reason: "paused", blocker: "test pause before review" }, "pause"),
        ],
      }),
      validators: scriptedValidators,
      runner: adaptiveScriptedRunner(2),
      stateRoot: env.stateRoot,
      runId: "resume1",
    });
    expect(paused.status).toBe("stopped");
    expect(paused.stopReason).toBe("paused");
    const originalReceipt = paused.receipts.find((r) => r.valid)!;
    if (change.startsWith("changed bytes")) {
      await writeFile(path.join(paused.worktreePath, GREETING_PATH), "externally edited\n");
    } else if (change === "changed manifest") {
      await writeFile(path.join(paused.worktreePath, "EXTRA.txt"), "external file\n");
    }

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      // Child hello takes over for Review → complete.
      runner: adaptiveScriptedRunner(4),
    });
    expect(resumed.receipts.find((r) => r.id === originalReceipt.id)?.valid).toBe(change === "unchanged");
    if (change === "changed bytes after review") {
      expect(paused.receipts.filter((r) => r.valid)).toHaveLength(2);
      for (const receipt of paused.receipts) {
        expect(resumed.receipts.find((r) => r.id === receipt.id)?.valid).toBe(false);
      }
    }
    if (change === "changed manifest") {
      // The writer cannot fix an out-of-scope path; stale acceptance must not
      // let Review and completion bypass the now-failing Write requirement.
      expect(resumed.status).toBe("stopped");
      expect(resumed.receipts.some((r) => r.valid)).toBe(false);
      return;
    }
    expect(resumed.status).toBe("succeeded");
    expect(await readFile(path.join(paused.worktreePath, GREETING_PATH), "utf8")).toBe(GREETING);
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
