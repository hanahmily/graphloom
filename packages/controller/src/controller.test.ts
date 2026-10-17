import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type RunView,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type Runner } from "@graphloom/runner";
import {
  createController,
  IntakeError,
  loadRunState,
  parseTaskYaml,
  resolveUnderBase,
  tryAdmit,
} from "./index.js";
import { intakeTask, manifestRepairContract } from "./intake.js";
import { readWorktreeFile, workspaceChangeManifest } from "./worktree.js";

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

  it("takes operator budgets from the task and rejects unbounded or unknown ones", async () => {
    const task = parseTaskYaml(`graph: hello
repo: ./test-repo
budgets:
  agentInvocations: 600
  activeMs: 28800000
grants:
  sourceRepair: true
request: fix it
`);
    expect(task.budgets).toEqual({ agentInvocations: 600, activeMs: 28800000 });
    expect(task.grants?.sourceRepair).toBe(true);
    for (const [value, message] of [
      ["0", /budgets agentInvocations must be a positive integer, got "0"/],
      ["-1", /must be a positive integer/],
      ["1e9", /must be a positive integer/],
      ["99999999999999999999", /must be a positive integer/],
    ] as const) {
      expect(() => parseTaskYaml(`graph: hello\nrepo: ./r\nrequest: x\nbudgets:\n  agentInvocations: ${value}\n`)).toThrow(message);
    }
    expect(() => parseTaskYaml("graph: hello\nrepo: ./r\nrequest: x\nbudgets:\n  tokens: 5\n")).toThrow(/unknown budgets key: tokens/);

    const env = await makeEnv();
    await writeFile(env.taskPath, `${await readFile(env.taskPath, "utf8")}budgets:\n  agentInvocations: 600\n`);
    const intake = await intakeTask(env.taskPath);
    expect(intake.budgets).toMatchObject({ agentInvocations: 600, jobs: 128, decisions: 512, corrections: 8 });
  });

  it("treats a bundle without a declared repair contract as opaque", () => {
    expect(manifestRepairContract(JSON.stringify({ graphId: "hello" }))).toBe("opaque");
    expect(manifestRepairContract(JSON.stringify({ repairContract: "opaque" }))).toBe("opaque");
    expect(manifestRepairContract(JSON.stringify({ repairContract: "source-repairable" }))).toBe(
      "source-repairable",
    );
    expect(() => manifestRepairContract(JSON.stringify({ repairContract: "patchable" }))).toThrow(
      /repairContract must be "source-repairable" or "opaque", got "patchable"/,
    );
  });

  it("rejects path traversal", () => {
    expect(() => resolveUnderBase("/tmp/task", "../etc/passwd", "repo")).toThrow(IntakeError);
    expect(() => resolveUnderBase("/tmp/task", "/etc/passwd", "repo")).toThrow(IntakeError);
  });

  it("rejects graph ids with separators", () => {
    expect(() =>
      parseTaskYaml(`graph: ../outside
repo: ./test-repo
request: hello
`),
    ).toThrow(/invalid graph id/);
  });
});

describe("worktree observe boundaries", () => {
  it("rejects escaped observe paths before treating them as missing", async () => {
    const env = await makeEnv();
    await expect(readWorktreeFile(env.repoPath, "../missing")).rejects.toThrow(/escapes/);
  });

  it("includes ignored paths in the change manifest", async () => {
    const env = await makeEnv();
    await writeFile(path.join(env.repoPath, ".gitignore"), "secret.bin\n", "utf8");
    await writeFile(path.join(env.repoPath, "secret.bin"), "x", "utf8");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: env.repoPath });
    await execFileAsync("git", ["commit", "-m", "ignore"], { cwd: env.repoPath });
    const paths = await workspaceChangeManifest(env.repoPath);
    expect(paths).toContain("secret.bin");
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

  // A restart bumps generation unconditionally as a crash-recovery fence; it
  // is no longer the freshness boundary (docs/design-run-convergence.md §4.1).
  // Only an actual candidate change invalidates evidence now.
  function observeOnlyToPause() {
    return createScriptedGraph({
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
  }

  it("admits evidence across a generation bump alone, since nothing about the candidate changed", async () => {
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

    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: observeOnlyToPause(),
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
    // Simulate crash restart: bump generation with the worktree untouched.
    state = { ...state, status: "running", generation: state.generation + 1 };
    const admit = await tryAdmit(state, "write", validators);
    expect(admit.accepted).toBe(true);

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

  it("rejects stale evidence after a generation bump plus a real edit", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: observeOnlyToPause(),
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
      runId: "stale2",
    });
    expect(paused.status).toBe("stopped");

    // Simulate crash restart plus an out-of-band edit: the observed evidence
    // no longer describes the live candidate.
    await writeFile(path.join(paused.worktreePath, GREETING_PATH), "tampered\n", "utf8");
    let state = await loadRunState(paused.stateDir);
    state = { ...state, status: "running", generation: state.generation + 1 };
    const admit = await tryAdmit(state, "write", validators);
    expect(admit.accepted).toBe(false);
    expect(admit.reason).toMatch(/no fresh evidence/);
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

describe("release scenarios (#60)", () => {
  const writeJob = dispatch(
    { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] },
    "dispatch writer",
  );
  const writeGreeting = async (_job: unknown, ctx: { worktreePath: string }) => {
    await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
    return { status: "ok" as const, summary: "wrote" };
  };

  async function pausedRun(env: Awaited<ReturnType<typeof makeEnv>>, runId: string) {
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [writeJob, stop({ reason: "paused", blocker: "test pause" }, "pause")],
      }),
      runner: createScriptedRunner({ jobs: [writeGreeting] }),
      validators,
      stateRoot: env.stateRoot,
      runId,
    });
    expect(paused.status).toBe("stopped");
    return paused;
  }

  it("stops resume when the run's worktree is gone", async () => {
    const env = await makeEnv();
    const paused = await pausedRun(env, "lost-worktree");
    await rm(paused.worktreePath, { recursive: true, force: true });

    const resumed = await createController().resume({
      runRef: paused.stateDir,
      plugin: scriptedHappyPath(),
      runner: createScriptedRunner({ jobs: [] }),
      validators,
    });
    expect(resumed.status).toBe("stopped");
    expect(resumed.stopReason).toBe("worktree mismatch");
    expect(resumed.blocker).toMatch(/worktree missing/);
  });

  it("stops resume when the pinned bundle is gone", async () => {
    const env = await makeEnv();
    const paused = await pausedRun(env, "lost-bundle");
    // Removes the task's link to the bundle, not the bundle it points at.
    await rm(path.join(env.taskDir, "plugins", "hello"));

    const resumed = await createController().resume({
      runRef: paused.stateDir,
      plugin: scriptedHappyPath(),
      runner: createScriptedRunner({ jobs: [] }),
      validators,
    });
    expect(resumed.status).toBe("stopped");
    expect(resumed.stopReason).toBe("pin mismatch");
    expect(await readFile(path.join(helloBundle, "graphloom.manifest.json"), "utf8")).toContain("hello");
  });

  it("resumes on an updated plugin only when the operator asks and the graph's contract is unchanged", async () => {
    const env = await makeEnv();
    const bundle = path.join(env.taskDir, "hello-bundle");
    await execFileAsync("cp", ["-r", helloBundle, bundle]);
    await rm(path.join(env.taskDir, "plugins", "hello"));
    await symlink(bundle, path.join(env.taskDir, "plugins", "hello"));
    const paused = await pausedRun(env, "updated-plugin");
    const pinned = (await loadRunState(paused.stateDir)).intake.bundle;

    const manifestPath = path.join(bundle, "graphloom.manifest.json");
    const entry = path.join(bundle, "dist", "index.js");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n// a fix to the graph's routing\n`, "utf8");
    await writeFile(manifestPath, `${await readFile(manifestPath, "utf8")}\n`, "utf8");
    const resumed = (plugin: GraphPlugin, updatePlugin?: boolean) =>
      createController().resume({
        runRef: paused.stateDir,
        plugin,
        runner: createScriptedRunner({ jobs: [] }),
        validators,
        ...(updatePlugin !== undefined ? { updatePlugin } : {}),
      });
    const resumedStop = () => createScriptedGraph({ definition, advances: [stop({ reason: "resumed", blocker: "none" }, "stop")] });

    expect(await resumed(resumedStop())).toMatchObject({ status: "stopped", stopReason: "pin mismatch" });

    const bumped = { ...definition, defaultValidators: definition.defaultValidators.map((b) => ({ ...b, version: "2" })) };
    expect(await resumed(createScriptedGraph({ definition: bumped, advances: [] }), true)).toMatchObject({
      status: "stopped",
      stopReason: "pin mismatch",
      blocker: "plugin defaultValidators changed since run start",
    });
    expect((await loadRunState(paused.stateDir)).intake.bundle.manifestDigest).toBe(pinned.manifestDigest);

    expect(await resumed(resumedStop(), true)).toMatchObject({ status: "stopped", stopReason: "resumed" });
    const state = await loadRunState(paused.stateDir);
    expect(state.intake.bundle.manifestDigest).not.toBe(pinned.manifestDigest);
    expect(state.intake.bundle.entryDigest).not.toBe(pinned.entryDigest);
    expect(state.versionHistory!.map((v) => v.reason)).toContain(
      `operator plugin update: manifest ${pinned.manifestDigest.slice(0, 12)} -> ${state.intake.bundle.manifestDigest.slice(0, 12)}`,
    );
    expect(await resumed(resumedStop())).toMatchObject({ status: "stopped", stopReason: "resumed" });
  });

  describe("an operator plugin update after Write was accepted", () => {
    async function acceptedWrite(runId: string) {
      const env = await makeEnv();
      const bundle = path.join(env.taskDir, "hello-bundle");
      await execFileAsync("cp", ["-r", helloBundle, bundle]);
      await rm(path.join(env.taskDir, "plugins", "hello"));
      await symlink(bundle, path.join(env.taskDir, "plugins", "hello"));
      const paused = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({
          definition,
          advances: [
            writeJob,
            observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
            validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
            stop({ reason: "paused", blocker: "test pause" }, "pause"),
          ],
        }),
        runner: createScriptedRunner({ jobs: [writeGreeting] }),
        validators,
        stateRoot: env.stateRoot,
        runId,
      });
      expect(paused.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["write"]);
      const entry = path.join(bundle, "dist", "index.js");
      await writeFile(entry, `${await readFile(entry, "utf8")}\n// updated\n`, "utf8");
      return paused;
    }
    const resumedStop = (environment?: GraphDefinition["environment"]) =>
      createScriptedGraph({
        definition: environment !== undefined ? { ...definition, environment } : definition,
        advances: [stop({ reason: "resumed", blocker: "none" }, "stop")],
      });

    it("keeps a receipt the updated validator still accepts on the same evidence", async () => {
      const paused = await acceptedWrite("update-keeps");
      const resumed = await createController().resume({
        runRef: paused.stateDir,
        plugin: resumedStop(),
        runner: createScriptedRunner({ jobs: [] }),
        validators,
        updatePlugin: true,
      });
      expect(resumed.stopReason).toBe("resumed");
      expect(resumed.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["write"]);
    });

    it("invalidates a receipt the updated validator no longer accepts and returns to its stage", async () => {
      const paused = await acceptedWrite("update-invalidates");
      const stricter = { evaluate: () => ({ status: "failed" as const, reason: "stricter now" }) };
      const resumed = await createController().resume({
        runRef: paused.stateDir,
        plugin: resumedStop(),
        runner: createScriptedRunner({ jobs: [] }),
        validators: { ...validators, "exact-greeting": stricter },
        updatePlugin: true,
      });
      expect(resumed.stopReason).toBe("resumed");
      expect(resumed.receipts.some((r) => r.valid)).toBe(false);
      const state = await loadRunState(paused.stateDir);
      expect(state.current.stageId).toBe("write");
      expect(state.versionHistory!.at(-1)!.reason).toMatch(/invalidated from write: greeting-bytes failed: stricter now$/);
    });

    it("checks the environment the updated plugin declares", async () => {
      const paused = await acceptedWrite("update-environment");
      const environment = { checks: [{ id: "new-tool", argv: ["graphloom-missing-new-tool"] }] };
      const missingTool: Runner = {
        async runJob(job, ctx) {
          const commands = (job.input as { commands: Array<{ id: string; argv: string[] }> }).commands;
          return {
            status: "ok",
            summary: "ran",
            runId: ctx.runId,
            operationId: ctx.operationId,
            generation: ctx.generation,
            evidence: commands.map((c) => ({
              kind: "command" as const,
              payload: { command: { id: c.id, argv: c.argv, exitCode: null, signal: null, timedOut: false, aborted: false, durationMs: 0, stdoutTail: "", stderrTail: "", spawnError: "spawn ENOENT" } },
            })),
          };
        },
      };
      const resumed = await createController().resume({
        runRef: paused.stateDir,
        plugin: resumedStop(environment),
        runner: missingTool,
        validators,
        updatePlugin: true,
      });
      expect(resumed).toMatchObject({ status: "stopped", stopReason: "environment check failed" });
      expect(resumed.blocker).toMatch(/^new-tool: /);
      expect((await loadRunState(paused.stateDir)).definition.environment).toEqual(environment);
    });
  });

  it("refuses Review evidence the writer produced", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          writeJob,
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "self-review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async (job, ctx) => ({
            ...(await writeGreeting(job, ctx)),
            evidence: [{ kind: "review", payload: { verdict: "approved", summary: "my own work is fine" } }],
          }),
        ],
      }),
      validators,
      stateRoot: env.stateRoot,
      runId: "self-review",
    });
    expect(report.status).toBe("stopped");
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["write"]);
    expect(report.evidence.filter((e) => e.kind === "review")).toEqual([]);
    expect(report.evidence.find((e) => e.kind === "other")?.payload).toMatchObject({ selfReported: "review" });
  });

  it("gives a stage re-entered from a later stage its next attempt number", async () => {
    const env = await makeEnv();
    const seen: Array<{ stageId: string; attempt: number }> = [];
    const record = (decision: GraphDecision) => (view: RunView) => {
      seen.push({ ...view.current });
      return decision;
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          record(dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write")),
          record(observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe")),
          record(validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write")),
          record(dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review")),
          // Review found a problem: send the run back to Write.
          record(reenter({ stageId: "write", reason: "review asked for changes" }, "back to write")),
          record(stop({ reason: "paused", blocker: "test pause" }, "pause")),
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok" as const, summary: "wrote" };
          },
          async () => ({ status: "ok" as const, summary: "changes requested", evidence: [{ kind: "review" as const, payload: { verdict: "changes_requested", summary: "no" } }] }),
        ],
      }),
      validators,
      stateRoot: env.stateRoot,
      runId: "reenter-attempt",
    });
    expect(report.status).toBe("stopped");
    // Write ran as attempt 1; arriving back from Review it is attempt 2, not 1 again.
    expect(seen.at(-1)).toEqual({ stageId: "write", attempt: 2 });
    expect((await loadRunState(report.stateDir)).stageAttempts?.write).toBe(2);
  });

  it.each([
    ["a dispatch", dispatch({ stageId: "deploy", kind: "agent", purpose: "work", instruction: "ship", writeScope: ["x"] }, "d")],
    ["a reentry", reenter({ stageId: "deploy", reason: "again" }, "r")],
    ["a validation", validate({ stageId: "deploy" }, "v")],
  ])("stops when %s names an undeclared step", async (_route, decision) => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [decision] }),
      runner: createScriptedRunner({ jobs: [] }),
      validators,
      stateRoot: env.stateRoot,
      runId: "undeclared",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("undeclared stage");
    expect(report.blocker).toMatch(/deploy/);
    const state = await loadRunState(report.stateDir);
    expect(state.definition.stages.map((s) => s.id)).toEqual(["write", "review"]);
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

describe("nextStageAttempt", () => {
  const base = { current: { stageId: "review", attempt: 1 } } as unknown as import("./state.js").DurableRunState;
  it("falls back to the attempts a stage's agent sessions recorded, for runs saved before stageAttempts", async () => {
    const { nextStageAttempt } = await import("./state.js");
    const old = { ...base, agentSessions: [{ operationId: "op-1", stageId: "fix", attempt: 1 }, { operationId: "op-2", stageId: "review", attempt: 1 }] } as unknown as import("./state.js").DurableRunState;
    expect(nextStageAttempt(old, "fix")).toBe(2);
    expect(nextStageAttempt(old, "review")).toBe(2);
    expect(nextStageAttempt(base, "fix")).toBe(1);
    expect(nextStageAttempt({ ...old, stageAttempts: { fix: 3 } }, "fix")).toBe(4);
  });
});
