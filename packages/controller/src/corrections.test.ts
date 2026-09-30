import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  reenter,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDefinition,
  type GraphPlugin,
  type RunView,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createInProcessPluginHost, type PluginHost } from "@graphloom/plugin-host";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";
import { saveRunState } from "./state.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const BAD_GREETING = "Hello, GraphLoom!";

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
      independence: "separate-reviewer" as const,
    },
  ],
};

const exactGreeting: Validator = {
  evaluate(input) {
    const file = latest(input.evidence, "file") as { path?: string; bytes?: string } | undefined;
    const manifest = latest(input.evidence, "workspace") as { changedPaths?: string[] } | undefined;
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
};

const independentReview: Validator = {
  evaluate(input) {
    const review = latest(input.evidence, "review") as { verdict?: string } | undefined;
    if (!review) {
      return { status: "inconclusive" as const, reason: "missing review" };
    }
    if (review.verdict === "approved") {
      return { status: "passed" as const, reason: "approved" };
    }
    return { status: "failed" as const, reason: "not approved" };
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

describe("corrections, crash containment, unfamiliar failure (#28)", () => {
  it("repairs missing-newline content via known hello correction route", async () => {
    const env = await makeEnv();
    const controller = createController();
    let writes = 0;

    const report = await controller.run({
      taskPath: env.taskPath,
      runner: createScriptedRunner({
        jobs: Array.from({ length: 8 }, () => async (
          job: { purpose?: string; readOnly?: boolean },
          ctx: { worktreePath: string },
        ) => {
          if (job.purpose === "review" || job.readOnly) {
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [
                { kind: "review" as const, payload: { verdict: "approved", summary: "ok" } },
              ],
            };
          }
          writes += 1;
          const bytes = writes === 1 ? BAD_GREETING : GREETING;
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), bytes, "utf8");
          return { status: "ok" as const, summary: writes === 1 ? "bad" : "fixed" };
        }),
      }),
      stateRoot: env.stateRoot,
      runId: "content1",
    });

    expect(report.status).toBe("succeeded");
    expect(writes).toBe(2);
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId).sort()).toEqual([
      "review",
      "write",
    ]);
    const inspect = await controller.inspect(report.stateDir);
    // The rewrite after Write's own observation is the one correction.
    expect(inspect.budgets.corrections).toBe(7);
  });

  it("fails a job that edits outside its write scope, and a correction may undo the stray edit", async () => {
    const env = await makeEnv();
    const jobs: string[] = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      supervisor: createScriptedSupervisor({
        decisions: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "rewrite GREETING.txt and remove the stray NOTES.txt",
              writeScope: [GREETING_PATH],
            },
            "undo the stray edit",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
          returnToNormal({ summary: "stray edit undone" }, "return"),
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            jobs.push("write with stray edit");
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            await writeFile(path.join(ctx.worktreePath, "NOTES.txt"), "scratch\n", "utf8");
            return { status: "ok" as const, summary: "wrote" };
          },
          async (_job, ctx) => {
            jobs.push("correct");
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            await rm(path.join(ctx.worktreePath, "NOTES.txt"), { force: true });
            return { status: "ok" as const, summary: "corrected" };
          },
          async () => {
            jobs.push("review");
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
            };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "scope1",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    expect(jobs).toEqual(["write with stray edit", "correct", "review"]);
    const failures = report.evidence.flatMap((e) => {
      const failure = (e.payload as { executorFailure?: { summary: string } } | undefined)?.executorFailure;
      return failure ? [failure.summary] : [];
    });
    expect(failures).toEqual(["changed paths outside the job's write scope: NOTES.txt"]);
  });

  it("fails a read-only job that changes the worktree, even when it reports success", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok" as const, summary: "wrote" };
          },
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), "rewritten by the reviewer\n", "utf8");
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
            };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "scope2",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe(`job failed: read-only job changed ${GREETING_PATH}`);
    expect(report.receipts.filter((r) => r.stageId === "review" && r.valid)).toEqual([]);
  });

  it("repairs an unknown launch failure through the supervisor without a duplicate Write", async () => {
    const env = await makeEnv();
    const jobs: string[] = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      supervisor: createScriptedSupervisor({
        decisions: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "write GREETING.txt with the corrected invocation",
              writeScope: [GREETING_PATH],
            },
            "relaunch writer",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
          returnToNormal({ summary: "writer relaunched" }, "return"),
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async () => {
            jobs.push("launch failed");
            return { status: "failed" as const, summary: "spawn writer-cli ENOENT" };
          },
          async (_job, ctx) => {
            jobs.push("write");
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok" as const, summary: "wrote" };
          },
          async (job) => {
            jobs.push(job.stageId);
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
            };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "launch1",
    });

    expect(report.status).toBe("succeeded");
    expect(jobs).toEqual(["launch failed", "write", "review"]);
    const state = await loadRunState(report.stateDir);
    expect(state.recoveryTrigger).toBeUndefined();
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId).sort()).toEqual(["review", "write"]);
  });

  it("reenters Write on review request_changes and requires fresh Review", async () => {
    const env = await makeEnv();
    const controller = createController();
    let reviews = 0;

    const report = await controller.run({
      taskPath: env.taskPath,
      runner: createScriptedRunner({
        jobs: Array.from({ length: 6 }, () => async (
          job: { purpose?: string; readOnly?: boolean },
          ctx: { worktreePath: string },
        ) => {
          if (job.purpose === "review" || job.readOnly) {
            reviews += 1;
            if (reviews === 1) {
              return {
                status: "ok" as const,
                summary: "changes",
                evidence: [
                  {
                    kind: "review" as const,
                    payload: { verdict: "request_changes", summary: "tone" },
                  },
                ],
              };
            }
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [
                { kind: "review" as const, payload: { verdict: "approved", summary: "ok" } },
              ],
            };
          }
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
          return { status: "ok" as const, summary: "wrote" };
        }),
      }),
      stateRoot: env.stateRoot,
      runId: "review1",
    });

    expect(report.status).toBe("succeeded");
    expect(reviews).toBe(2);
    const writeReceipts = report.receipts.filter((r) => r.stageId === "write");
    const reviewReceipts = report.receipts.filter((r) => r.stageId === "review");
    expect(writeReceipts.some((r) => !r.valid)).toBe(true);
    expect(writeReceipts.some((r) => r.valid)).toBe(true);
    expect(reviewReceipts.filter((r) => r.valid)).toHaveLength(1);
    const inspect = await controller.inspect(report.stateDir);
    expect(inspect.budgets.corrections).toBeLessThan(8);
  });

  it("recovers unfamiliar Supervise without skipping Review", async () => {
    const env = await makeEnv();
    const controller = createController();
    const reviewDispatches: string[] = [];
    let seenEpisode: string | undefined;

    const plugin = createScriptedGraph({
      definition,
      advances: [
        supervise({ reason: "unfamiliar launch failure" }, "escalate"),
        dispatch(
          {
            stageId: "review",
            kind: "agent",
            purpose: "review",
            instruction: "review",
            readOnly: true,
          },
          "review after return",
        ),
        validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review"),
        stop({ reason: "complete", blocker: "none" }, "done"),
      ],
    });

    const supervisor = createScriptedSupervisor({
      decisions: [
        (input) => {
          seenEpisode = input.view.recoveryEpisodeId;
          expect(input.view.recoveryEpisodeId).toBe(input.episodeId);
          expect(input.view.recoveryEpisodeId).toBeTruthy();
          return dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "repair write",
              writeScope: [GREETING_PATH],
            },
            "supervisor repair write",
          );
        },
        observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
        validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
        returnToNormal({ summary: "write repaired" }, "return"),
      ],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      validators,
      supervisor,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
          async (job) => {
            reviewDispatches.push(job.stageId);
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [
                { kind: "review" as const, payload: { verdict: "approved", summary: "ok" } },
              ],
            };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "unfamiliar1",
    });

    expect(report.status).toBe("succeeded");
    expect(seenEpisode).toMatch(/^ep-/);
    expect(reviewDispatches).toEqual(["review"]);
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId).sort()).toEqual([
      "review",
      "write",
    ]);
    // Supervisor repair work must consume the shared corrections budget.
    const inspect = await controller.inspect(report.stateDir);
    expect(inspect.budgets.corrections).toBeLessThan(8);
  });

  it("ignores supervisor privateState so graph bookkeeping survives Return", async () => {
    const env = await makeEnv();
    const controller = createController();
    const graphPrivate = JSON.stringify({ writerDispatched: true, marker: "graph-owned" });

    const plugin = createScriptedGraph({
      definition,
      advances: [
        (_view, _i) =>
          supervise(
            { reason: "escalate with private" },
            "escalate",
            graphPrivate,
          ),
        dispatch(
          {
            stageId: "write",
            kind: "agent",
            purpose: "work",
            instruction: "write",
            writeScope: [GREETING_PATH],
          },
          "after return",
        ),
        observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
        validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
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
        validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review"),
        stop({ reason: "complete", blocker: "none" }, "done"),
      ],
    });

    const supervisor = createScriptedSupervisor({
      decisions: [
        returnToNormal(
          { summary: "noop recovery" },
          "return",
          JSON.stringify({ marker: "supervisor-should-not-stick" }),
        ),
      ],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      validators,
      supervisor,
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
      runId: "priv1",
    });

    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    expect(state.privateState).toBe(graphPrivate);
    expect(state.privateState).not.toContain("supervisor-should-not-stick");
  });

  it("stops when a dead child host cannot be restarted", async () => {
    const env = await makeEnv();
    const controller = createController();
    const dead: PluginHost = {
      activeVersion: "hello@0.1.0",
      generation: 1,
      childPid: 424242,
      async describe() {
        return { ok: true, value: structuredClone(definition) };
      },
      async advance() {
        return {
          ok: false,
          observation: {
            kind: "child_observation",
            code: "crash",
            message: "child exited",
          },
        };
      },
      async close() {
        /* no-op */
      },
    };

    const report = await controller.run({
      taskPath: env.taskPath,
      host: dead,
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [returnToNormal({ summary: "unreachable" }, "return")],
      }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "dead1",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toMatch(/crash/);
    expect(report.blocker).toMatch(/host restart unavailable/);
  });

  it("contains validator host crash during Validate without rejecting run()", async () => {
    const env = await makeEnv();
    const controller = createController();
    let writeDispatched = false;
    let reviewDispatched = false;
    let hostSerial = 0;
    let evalCrashes = 0;

    const plugin: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance(view) {
        const writeOk = view.receipts.some((r) => r.stageId === "write" && r.valid);
        const reviewOk = view.receipts.some((r) => r.stageId === "review" && r.valid);
        if (writeOk && reviewOk) {
          return stop({ reason: "complete", blocker: "none" }, "done");
        }
        if (!writeOk) {
          const hasFile = view.evidence.some((e) => e.kind === "file");
          const hasWorkspace = view.evidence.some((e) => e.kind === "workspace");
          if (!writeDispatched) {
            writeDispatched = true;
            return dispatch(
              {
                stageId: "write",
                kind: "agent",
                purpose: "work",
                instruction: "write",
                writeScope: [GREETING_PATH],
              },
              "dispatch writer",
            );
          }
          if (!hasFile || !hasWorkspace) {
            return observe(
              { paths: [GREETING_PATH], includeWorkspaceManifest: true },
              "observe",
            );
          }
          return validate(
            { stageId: "write", requirementIds: ["greeting-bytes"] },
            "validate write",
          );
        }
        if (!reviewDispatched) {
          reviewDispatched = true;
          return dispatch(
            {
              stageId: "review",
              kind: "agent",
              purpose: "review",
              instruction: "review",
              readOnly: true,
            },
            "review",
          );
        }
        return validate(
          { stageId: "review", requirementIds: ["independent-review"] },
          "validate review",
        );
      },
    };

    function makeHost(): PluginHost {
      hostSerial += 1;
      const serial = hostSerial;
      const base = createInProcessPluginHost(plugin, {
        activeVersion: "hello@0.1.0",
        generation: 1,
      });
      return {
        activeVersion: base.activeVersion,
        generation: base.generation,
        childPid: 60_000 + serial,
        describe: (ctx) => base.describe(ctx),
        advance: (ctx, view) => base.advance(ctx, view),
        async evaluate(_ctx, _validatorId, input) {
          if (serial === 1 && evalCrashes === 0) {
            evalCrashes += 1;
            return {
              ok: false,
              observation: {
                kind: "child_observation",
                code: "crash",
                message: "validator child exited",
              },
            };
          }
          const id =
            input.requirementId === "greeting-bytes"
              ? "exact-greeting"
              : "independent-reviewer";
          return { ok: true, value: validators[id]!.evaluate(input) };
        },
        close: () => base.close(),
      };
    }

    const report = await controller.run({
      taskPath: env.taskPath,
      host: makeHost(),
      recreateHost: async (_ctx) => makeHost(),
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            expect(input.trigger.code).toBe("plugin_crash");
            expect(input.trigger.message).toMatch(/validator/);
            return returnToNormal({ summary: "retry validate on fresh host" }, "return");
          },
        ],
      }),
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
      runId: "evalcrash1",
    });

    expect(report.status).toBe("succeeded");
    expect(hostSerial).toBe(2);
    expect(evalCrashes).toBe(1);
    const inspect = await controller.inspect(report.stateDir);
    expect(inspect.status).toBe("succeeded");
    expect(inspect.mode).toBe("normal");
  });

  it("rebinds a replacement host after child crash before Return advances", async () => {
    const env = await makeEnv();
    const controller = createController();
    let hostSerial = 0;

    const inner = createScriptedGraph({
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

    function makeChildLikeHost(): PluginHost {
      hostSerial += 1;
      const serial = hostSerial;
      let advances = 0;
      return {
        activeVersion: "hello@0.1.0",
        generation: 1,
        childPid: 50_000 + serial,
        async describe() {
          return { ok: true, value: structuredClone(definition) };
        },
        async advance(_ctx, view) {
          advances += 1;
          if (serial === 1 && advances === 1) {
            return {
              ok: false,
              observation: {
                kind: "child_observation",
                code: "crash",
                message: "simulated child death",
              },
            };
          }
          return { ok: true, value: inner.advance(view) };
        },
        async close() {
          /* no-op */
        },
      };
    }

    const report = await controller.run({
      taskPath: env.taskPath,
      host: makeChildLikeHost(),
      recreateHost: async (_ctx) => makeChildLikeHost(),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            expect(input.trigger.code).toBe("plugin_crash");
            expect(input.view.recoveryEpisodeId).toBe(input.episodeId);
            return returnToNormal({ summary: "retry on fresh host" }, "return");
          },
        ],
      }),
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
      runId: "rebind1",
    });

    expect(report.status).toBe("succeeded");
    expect(hostSerial).toBe(2);
  });

  it("contains plugin crash with bounded recovery then completion", async () => {
    const env = await makeEnv();
    const controller = createController();
    let advances = 0;

    const inner = createScriptedGraph({
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

    const crashing: GraphPlugin = {
      describe: () => inner.describe(),
      advance(view: RunView) {
        advances += 1;
        if (advances === 1) {
          throw new Error("simulated plugin crash");
        }
        return inner.advance(view);
      },
    };

    const host = createInProcessPluginHost(crashing, {
      activeVersion: "hello@0.1.0",
      generation: 1,
    });

    const supervisor = createScriptedSupervisor({
      decisions: [
        (input) => {
          expect(input.trigger.code).toBe("plugin_crash");
          return returnToNormal({ summary: "retry after crash" }, "return");
        },
      ],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      host,
      validators,
      supervisor,
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
      runId: "crash1",
    });

    expect(report.status).toBe("succeeded");
    expect(advances).toBeGreaterThan(1);
    const inspect = await controller.inspect(report.stateDir);
    expect(inspect.mode).toBe("normal");
    expect(inspect.status).toBe("succeeded");
  });

  it("contains plugin hang/timeout with concrete stop when supervisor stops", async () => {
    const env = await makeEnv();
    const controller = createController();

    const inner = createScriptedGraph({
      definition,
      advances: [
        stop({ reason: "should not reach", blocker: "timeout first" }, "unused"),
      ],
    });
    const baseHost = createInProcessPluginHost(inner, {
      activeVersion: "hello@0.1.0",
      generation: 1,
    });
    let timedOut = false;
    const host: PluginHost = {
      ...baseHost,
      async advance(ctx, view) {
        if (!timedOut) {
          timedOut = true;
          return {
            ok: false,
            observation: {
              kind: "child_observation",
              code: "timeout",
              message: "plugin callback timed out",
            },
          };
        }
        return baseHost.advance(ctx, view);
      },
    };

    const supervisor = createScriptedSupervisor({
      decisions: [
        (input) => {
          expect(input.trigger.code).toBe("plugin_timeout");
          return stop(
            { reason: "plugin hang", blocker: input.trigger.message },
            "bounded stop after hang",
          );
        },
      ],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      host,
      validators,
      supervisor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "hang1",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("plugin hang");
    expect(report.blocker).toMatch(/timed out/);
    const inspect = await controller.inspect(report.stateDir);
    expect(inspect.status).toBe("stopped");
  });

  it("shares durable corrections budget across resume (not replenished)", async () => {
    const env = await makeEnv();
    const controller = createController();

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
          reenter(
            { stageId: "write", reason: "forced correction", evidenceRefs: [] },
            "burn one correction",
          ),
          stop({ reason: "paused", blocker: "budget check" }, "pause"),
        ],
      }),
      validators,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "budget1",
    });

    expect(paused.status).toBe("stopped");
    const before = await controller.inspect(paused.stateDir);
    expect(before.budgets.corrections).toBe(7);

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "rewrite",
              writeScope: [GREETING_PATH],
            },
            "rewrite",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write"),
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
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      validators,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "rewrote" };
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
    });

    expect(resumed.status).toBe("succeeded");
    const after = await controller.inspect(paused.stateDir);
    // The pre-resume reentry stays spent, and the rewrite is Write's second attempt.
    expect(after.budgets.corrections).toBe(6);
  });

  it.each([
    ["the run marks its work dispatches", false],
    ["the run was saved before work dispatches were marked", true],
  ])("charges a rewrite after resume and a fresh observation when %s", async (_case, legacy) => {
    const env = await makeEnv();
    const controller = createController();
    const writeJob = dispatch(
      { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] },
      "dispatch writer",
    );
    const observeWrite = observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe");
    const writeGreeting = async (_job: unknown, ctx: { worktreePath: string }) => {
      await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
      return { status: "ok" as const, summary: "wrote" };
    };
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [writeJob, observeWrite, stop({ reason: "paused", blocker: "upgrade" }, "pause")],
      }),
      validators,
      runner: createScriptedRunner({ jobs: [writeGreeting] }),
      stateRoot: env.stateRoot,
      runId: "resume-rewrite",
    });
    const saved = await loadRunState(paused.stateDir);
    expect(Object.keys(saved.workDispatchEvidence ?? {})).toEqual(["write"]);
    if (legacy) {
      const { workDispatchEvidence: _dropped, ...unmarked } = saved;
      await saveRunState(unmarked);
    }

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({
        definition,
        // The second rewrite follows no observation of the first, so it is not charged again.
        advances: [
          observeWrite,
          writeJob,
          dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write again", writeScope: [GREETING_PATH] }, "rewrite"),
          stop({ reason: "paused", blocker: "checked" }, "pause"),
        ],
      }),
      validators,
      runner: createScriptedRunner({ jobs: [writeGreeting, writeGreeting] }),
    });
    expect(resumed, `${resumed.stopReason}: ${resumed.blocker}`).toMatchObject({ stopReason: "paused", blocker: "checked" });
    expect((await controller.inspect(paused.stateDir)).budgets.corrections).toBe(7);
  });

  it("rejects Accept from stale pre-reentry evidence after Write reentry", async () => {
    const env = await makeEnv();
    const controller = createController();
    let reviews = 0;

    const report = await controller.run({
      taskPath: env.taskPath,
      runner: createScriptedRunner({
        jobs: Array.from({ length: 6 }, () => async (
          job: { purpose?: string; readOnly?: boolean },
          ctx: { worktreePath: string },
        ) => {
          if (job.purpose === "review" || job.readOnly) {
            reviews += 1;
            if (reviews === 1) {
              return {
                status: "ok" as const,
                summary: "request changes",
                evidence: [
                  {
                    kind: "review" as const,
                    payload: { verdict: "request_changes", summary: "old" },
                  },
                ],
              };
            }
            return {
              status: "ok" as const,
              summary: "approved",
              evidence: [
                { kind: "review" as const, payload: { verdict: "approved", summary: "fresh" } },
              ],
            };
          }
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
          return { status: "ok" as const, summary: "wrote" };
        }),
      }),
      stateRoot: env.stateRoot,
      runId: "stale1",
    });

    expect(report.status).toBe("succeeded");
    expect(reviews).toBe(2);
    const invalidWrite = report.receipts.filter((r) => r.stageId === "write" && !r.valid);
    const validWrite = report.receipts.filter((r) => r.stageId === "write" && r.valid);
    expect(invalidWrite.length).toBeGreaterThanOrEqual(1);
    expect(validWrite).toHaveLength(1);
    expect(report.receipts.filter((r) => r.stageId === "review" && r.valid)).toHaveLength(1);
  });
});

describe("controller-started recovery for stalls and repeated corrections", () => {
  const writeJob = (instruction: string) =>
    dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction, writeScope: [GREETING_PATH] }, "dispatch writer");
  const observeWrite = observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe");
  const validateWrite = validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "validate write");
  const writes = (contents: string[]) =>
    createScriptedRunner({
      jobs: contents.map((bytes) => async (_job: unknown, ctx: { worktreePath: string }) => {
        await writeFile(path.join(ctx.worktreePath, GREETING_PATH), bytes, "utf8");
        return { status: "ok" as const, summary: "wrote" };
      }),
    });

  it("starts recovery when the graph repeats a decision without progress, and again after a Return that changed nothing", async () => {
    const env = await makeEnv();
    // Write once, then alternate Observe and Validate: each Observe records new refs for the same bytes.
    let proposals = 0;
    const graph: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance() {
        proposals += 1;
        if (proposals === 1) return writeJob("write");
        return proposals % 2 === 0 ? observeWrite : validateWrite;
      },
    };
    const triggers: { code: string; message: string }[] = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph,
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(input.trigger);
            return returnToNormal({ summary: "try again" }, "return");
          },
          (input) => {
            triggers.push(input.trigger);
            return stop({ reason: "stalled at write", blocker: "the greeting never passes" }, "stop");
          },
        ],
      }),
      runner: writes([BAD_GREETING]),
      stateRoot: env.stateRoot,
      runId: "stalled",
    });

    const stalled = (what: string) => ({ code: "stalled", message: `the graph repeated ${what} with no progress since it last proposed it` });
    // The first repeat is the second Validate; after the Return, the next Observe is a repeat too.
    expect(triggers).toEqual([stalled("validate of write"), stalled("observe")]);
    expect(report).toMatchObject({ status: "stopped", stopReason: "stalled at write" });
    const state = await loadRunState(report.stateDir);
    // dispatch, observe, validate, observe, the refused validate, return, the refused observe, stop
    expect(state.budgets.decisions).toBe(512 - 8);
    expect(state.evidence.filter((e) => e.kind === "file")).toHaveLength(2);
    expect(state.receipts.filter((r) => r.valid)).toEqual([]);
  });

  it("counts observing a second file with the same bytes as progress", async () => {
    const env = await makeEnv();
    const [A, B] = ["A.txt", "B.txt"];
    const bothFiles: Validator = {
      evaluate(input) {
        const seen = input.evidence.flatMap((e) => (e.kind === "file" ? [(e.payload as { path: string }).path] : []));
        return seen.includes(A) && seen.includes(B)
          ? { status: "passed" as const, reason: "both observed" }
          : { status: "inconclusive" as const, reason: "a file is unobserved" };
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write both", writeScope: [A, B] }, "dispatch writer"),
          observe({ paths: [A] }, "observe A"),
          validateWrite,
          observe({ paths: [B] }, "observe B"),
          validateWrite,
          stop({ reason: "paused", blocker: "checked" }, "pause"),
        ],
      }),
      validators: { ...validators, "exact-greeting": bothFiles },
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            for (const file of [A, B]) await writeFile(path.join(ctx.worktreePath, file), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "same-bytes",
    });
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ stopReason: "paused", blocker: "checked" });
    expect(report.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["write"]);
  });

  it("keeps counting across a Supervise and Return that changed nothing", async () => {
    const env = await makeEnv();
    const graph: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance: () => supervise({ reason: "unfamiliar state" }, "escalate"),
    };
    const triggers: string[] = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph,
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(input.trigger.message);
            return returnToNormal({ summary: "carry on" }, "return");
          },
          (input) => {
            triggers.push(input.trigger.message);
            return stop({ reason: "stalled", blocker: "the graph keeps escalating" }, "stop");
          },
        ],
      }),
      runner: writes([]),
      stateRoot: env.stateRoot,
      runId: "supervise-cycle",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "stalled" });
    expect(triggers).toEqual(["unfamiliar state", "the graph repeated supervise with no progress since it last proposed it"]);
  });

  it("starts recovery on a repeated Reenter before it spends the correction budget", async () => {
    const env = await makeEnv();
    let proposals = 0;
    const graph: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance() {
        proposals += 1;
        if (proposals === 1) return writeJob("write");
        if (proposals === 2) return observeWrite;
        if (proposals === 3) return validateWrite;
        return reenter({ stageId: "write", reason: "the greeting is wrong" }, "reenter");
      },
    };
    let trigger: { code: string; message: string } | undefined;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph,
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            trigger = input.trigger;
            return stop({ reason: "reentry stalled", blocker: "nothing changes" }, "stop");
          },
        ],
      }),
      runner: writes([BAD_GREETING]),
      stateRoot: env.stateRoot,
      runId: "reenter-cycle",
    });
    expect(report.stopReason).toBe("reentry stalled");
    expect(trigger).toEqual({ code: "stalled", message: "the graph repeated reenter of write with no progress since it last proposed it" });
    expect(proposals).toBe(5);
    expect((await loadRunState(report.stateDir)).budgets.corrections).toBe(7);
  });

  it("does not count a repeated job's identical result as progress", async () => {
    const env = await makeEnv();
    const reviewJob = dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review");
    const validateReview = validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review");
    const rejects = async () => ({
      status: "ok" as const,
      summary: "changes requested",
      evidence: [{ kind: "review" as const, payload: { verdict: "request_changes", summary: "name the file" } }],
    });
    let trigger: { code: string; message: string } | undefined;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [writeJob("write"), observeWrite, validateWrite, reviewJob, validateReview, reviewJob, validateReview],
      }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            trigger = input.trigger;
            return stop({ reason: "review stalled", blocker: "same verdict" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
          rejects,
          rejects,
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "same-verdict",
    });
    expect(report.stopReason).toBe("review stalled");
    expect(trigger).toEqual({ code: "stalled", message: "the graph repeated validate of review with no progress since it last proposed it" });
  });

  it("counts stage acceptance as progress, so a decision made before it is not a repeat after it", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          writeJob("write"),
          observeWrite,
          validateWrite,
          // Adds no evidence; only the acceptance it follows separates it from the first.
          validateWrite,
          dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review"),
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
          async () => ({ status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved" } }] }),
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "accepted-progress",
    });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
  });

  it("hands a third correction at an unresolved stage to the supervisor without dispatching or charging it, and lets the supervisor try", async () => {
    const env = await makeEnv();
    type Phase = { phase: "dispatch" | "observe" | "validate"; tries: number };
    const graph: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance(view) {
        const s: Phase = view.privateState ? (JSON.parse(view.privateState) as Phase) : { phase: "dispatch", tries: 0 };
        const next = (p: Phase) => JSON.stringify(p);
        if (s.phase === "dispatch") return { ...writeJob(`write, try ${s.tries + 1}`), privateState: next({ phase: "observe", tries: s.tries + 1 }) };
        if (s.phase === "observe") return { ...observeWrite, privateState: next({ ...s, phase: "validate" }) };
        return { ...validateWrite, privateState: next({ ...s, phase: "dispatch" }) };
      },
    };
    let handedOff: { trigger: { code: string; message: string; evidenceRefs?: string[] }; privateState?: string } | undefined;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph,
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            handedOff = { trigger: input.trigger, ...(input.view.privateState !== undefined ? { privateState: input.view.privateState } : {}) };
            return writeJob("write exactly the greeting");
          },
          stop({ reason: "handed off", blocker: "checked the supervisor's own trial" }, "stop"),
        ],
      }),
      runner: writes(["Hello 1", "Hello 2", "Hello 3", GREETING]),
      stateRoot: env.stateRoot,
      runId: "correction-limit",
    });

    expect(report).toMatchObject({ status: "stopped", stopReason: "handed off" });
    expect(handedOff?.trigger).toMatchObject({
      code: "correction_limit",
      message: "stage write is still unresolved after 2 correction trials; the supervisor decides any further trial",
    });
    const state = await loadRunState(report.stateDir);
    const observed = state.evidence.filter((e) => e.kind === "file" || e.kind === "workspace").map((e) => e.ref);
    expect(handedOff?.trigger.evidenceRefs).toEqual(observed.slice(-10));
    // The refused fourth dispatch left the graph's bookkeeping as it was after the third validation.
    expect(JSON.parse(handedOff!.privateState!)).toEqual({ phase: "dispatch", tries: 3 });
    // The supervisor's own trial runs, spends a correction, and is not counted against the graph's limit.
    expect(await readFile(path.join(report.worktreePath, GREETING_PATH), "utf8")).toBe(GREETING);
    expect(state.budgets.corrections).toBe(5);
    expect(state.correctionTrials).toEqual({ write: 2 });
  });

  it("stops at the correction limit when no supervisor is configured", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          writeJob("write"),
          observeWrite,
          validateWrite,
          writeJob("fix 1"),
          observeWrite,
          validateWrite,
          writeJob("fix 2"),
          observeWrite,
          validateWrite,
          writeJob("fix 3"),
        ],
      }),
      validators,
      runner: writes(["Hello 1", "Hello 2", "Hello 3"]),
      stateRoot: env.stateRoot,
      runId: "correction-limit-alone",
    });
    expect(report).toMatchObject({
      status: "stopped",
      stopReason: "stage write is still unresolved after 2 correction trials; the supervisor decides any further trial",
      blocker: "no supervisor configured",
    });
  });

  it("starts counting correction trials again once the stage is accepted", async () => {
    const env = await makeEnv();
    const review = (verdict: string) => async () => ({
      status: "ok" as const,
      summary: verdict,
      evidence: [{ kind: "review" as const, payload: { verdict, summary: verdict } }],
    });
    const write = (bytes: string) => async (_job: unknown, ctx: { worktreePath: string }) => {
      await writeFile(path.join(ctx.worktreePath, GREETING_PATH), bytes, "utf8");
      return { status: "ok" as const, summary: "wrote" };
    };
    const reviewJob = dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review");
    const validateReview = validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review");
    const reenterWrite = reenter({ stageId: "write", reason: "reviewer asked for changes", evidenceRefs: [] }, "reenter");
    // Write passes after two corrections; Review rejects it, and the correction after the rewrite is a first trial again.
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          writeJob("write"), observeWrite, validateWrite,
          writeJob("fix 1"), observeWrite, validateWrite,
          writeJob("fix 2"), observeWrite, validateWrite,
          reviewJob, validateReview, reenterWrite,
          writeJob("rewrite"), observeWrite, validateWrite,
          writeJob("rewrite, fix 1"), observeWrite, validateWrite,
          stop({ reason: "paused", blocker: "checked" }, "pause"),
        ],
      }),
      validators,
      runner: createScriptedRunner({
        jobs: [write("Hello 1"), write("Hello 2"), write(GREETING), review("request_changes"), write("Hello 3"), write("Hello 4")],
      }),
      stateRoot: env.stateRoot,
      runId: "correction-reset",
    });
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ stopReason: "paused", blocker: "checked" });
    expect((await loadRunState(report.stateDir)).correctionTrials).toEqual({ write: 1 });
  });

  it("gives validators earlier generations' evidence as history, apart from the current evidence", async () => {
    const env = await makeEnv();
    const review = (verdict: string) => async () => ({
      status: "ok" as const,
      summary: verdict,
      evidence: [{ kind: "review" as const, payload: { verdict, summary: verdict } }],
    });
    const write = async (_job: unknown, ctx: { worktreePath: string }) => {
      await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
      return { status: "ok" as const, summary: "wrote" };
    };
    const seen: { generation: number | undefined; evidence: string[]; history: string[] }[] = [];
    const reviewJob = dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review");
    const validateReview = validate({ stageId: "review", requirementIds: ["independent-review"] }, "validate review");
    const verdicts = (records: { kind: string; payload?: unknown }[] | undefined) =>
      (records ?? []).filter((e) => e.kind === "review").map((e) => (e.payload as { verdict: string }).verdict);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          writeJob("write"), observeWrite, validateWrite,
          reviewJob, validateReview,
          reenter({ stageId: "write", reason: "reviewer asked for changes", evidenceRefs: [] }, "reenter"),
          writeJob("rewrite"), observeWrite, validateWrite,
          reviewJob, validateReview,
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      validators: {
        ...validators,
        "independent-reviewer": {
          evaluate(input) {
            seen.push({
              generation: input.evidence[0]!.generation,
              evidence: verdicts(input.evidence),
              history: verdicts(input.history),
            });
            return independentReview.evaluate(input);
          },
        },
      },
      runner: createScriptedRunner({ jobs: [write, review("request_changes"), write, review("approved")] }),
      stateRoot: env.stateRoot,
      runId: "validation-history",
    });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(seen).toEqual([
      { generation: 1, evidence: ["request_changes"], history: [] },
      { generation: 2, evidence: ["approved"], history: ["request_changes"] },
    ]);
  });
});

describe("active execution time budget", () => {
  const writeJob = dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "dispatch writer");
  const pause = stop({ reason: "paused", blocker: "checked" }, "pause");
  const write = async (_job: unknown, ctx: { worktreePath: string }) => {
    await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
    return { status: "ok" as const, summary: "wrote" };
  };
  const setActiveMs = async (stateDir: string, activeMs: number) => {
    const state = await loadRunState(stateDir);
    await saveRunState({ ...state, budgets: { ...state.budgets, activeMs } });
  };

  it("starts at four hours and runs down across resume without being replenished", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [writeJob, pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [write] }),
      stateRoot: env.stateRoot,
      runId: "active-down",
    });
    const first = (await controller.inspect(paused.stateDir)).budgets.activeMs!;
    expect(first).toBeLessThan(4 * 60 * 60_000);
    expect(first).toBeGreaterThan(4 * 60 * 60_000 - 60_000);

    let seen: number | undefined;
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({
        definition,
        advances: [
          (view) => {
            seen = view.budgets.activeMs;
            return pause;
          },
        ],
      }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
    });
    expect(resumed.stopReason).toBe("paused");
    // The graph sees the time left as of its turn, not as of the last save.
    expect(seen).toBeLessThan(first);
    expect((await controller.inspect(paused.stateDir)).budgets.activeMs).toBeLessThanOrEqual(seen!);
  });

  it("does not count time while the run is stopped", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "active-idle",
    });
    await setActiveMs(paused.stateDir, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const resumedAt = Date.now();
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [writeJob, pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [write] }),
    });
    const ran = Date.now() - resumedAt;
    expect(resumed.stopReason).toBe("paused");
    const left = (await controller.inspect(paused.stateDir)).budgets.activeMs!;
    expect(left).toBeLessThan(3_000);
    expect(left).toBeGreaterThanOrEqual(3_000 - ran);
  });

  const pausedRun = async (runId: string, activeMs: number) => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId,
    });
    await setActiveMs(paused.stateDir, activeMs);
    return { controller, stateDir: paused.stateDir };
  };

  it("does not admit a dispatch the graph proposed after the time ran out", async () => {
    const { controller, stateDir } = await pausedRun("active-late-dispatch", 1_000);
    let ran = false;
    const report = await controller.resume({
      runRef: stateDir,
      plugin: createScriptedGraph({
        definition,
        advances: [
          () => {
            const until = Date.now() + 1_200;
            while (Date.now() < until) {
              /* a slow advance callback */
            }
            return writeJob;
          },
        ],
      }),
      validators,
      runner: createScriptedRunner({
        jobs: [
          async (job, ctx) => {
            ran = true;
            return write(job, ctx);
          },
        ],
      }),
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "active time budget exhausted" });
    expect(ran).toBe(false);
    expect((await loadRunState(stateDir)).pendingDispatch).toBeUndefined();
  });

  it("measures elapsed time monotonically, so wall-clock jumps neither expire nor replenish it", async () => {
    const { controller, stateDir } = await pausedRun("active-clock-jump", 10_000);
    const wallClock = Date.now.bind(Date);
    const jump = (offset: number) => vi.spyOn(Date, "now").mockImplementation(() => wallClock() + offset);
    const pauseAfter = (offset: number) => () => {
      jump(offset);
      return pause;
    };
    try {
      const forward = await controller.resume({
        runRef: stateDir,
        plugin: createScriptedGraph({ definition, advances: [pauseAfter(60_000)] }),
        validators,
        runner: createScriptedRunner({ jobs: [] }),
      });
      expect(forward.stopReason).toBe("paused");
      vi.restoreAllMocks();
      const afterForward = (await controller.inspect(stateDir)).budgets.activeMs!;
      expect(afterForward).toBeGreaterThan(5_000);

      const back = await controller.resume({
        runRef: stateDir,
        plugin: createScriptedGraph({ definition, advances: [pauseAfter(-60_000)] }),
        validators,
        runner: createScriptedRunner({ jobs: [] }),
      });
      expect(back.stopReason).toBe("paused");
      vi.restoreAllMocks();
      expect((await controller.inspect(stateDir)).budgets.activeMs).toBeLessThanOrEqual(afterForward);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps the time a job used when the runner throws", async () => {
    const { controller, stateDir } = await pausedRun("active-runner-throws", 10_000);
    await expect(
      controller.resume({
        runRef: stateDir,
        plugin: createScriptedGraph({ definition, advances: [writeJob] }),
        validators,
        runner: createScriptedRunner({
          jobs: [
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 1_200));
              throw new Error("runner crashed");
            },
          ],
        }),
      }),
    ).rejects.toThrow("runner crashed");
    expect((await controller.inspect(stateDir)).budgets.activeMs).toBeLessThanOrEqual(10_000 - 1_200);
  });

  it("keeps the time a killed controller spent, to within one checkpoint", async () => {
    const { controller, stateDir } = await pausedRun("active-killed", 10_000);
    const url = (rel: string) => JSON.stringify(new URL(rel, import.meta.url).href);
    // A controller process that is killed outright 2.5 s into a job, with no chance to record anything.
    const script = `
      import { createController } from ${url("../dist/index.js")};
      import { createScriptedGraph, dispatch } from ${url("../../sdk/dist/index.js")};
      import { createScriptedRunner } from ${url("../../runner/dist/index.js")};
      const job = dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [${JSON.stringify(GREETING_PATH)}] }, "dispatch writer");
      await createController().resume({
        runRef: ${JSON.stringify(stateDir)},
        plugin: createScriptedGraph({ definition: ${JSON.stringify(definition)}, advances: [job] }),
        validators: {},
        runner: createScriptedRunner({ jobs: [async () => { await new Promise((r) => setTimeout(r, 2_500)); process.kill(process.pid, "SIGKILL"); }] }),
      });
    `;
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "inherit"] });
      child.once("error", reject);
      child.once("close", (_code, sig) => resolve(sig));
    });
    expect(signal).toBe("SIGKILL");
    expect((await loadRunState(stateDir)).budgets.activeMs).toBeGreaterThan(9_000);

    const report = await controller.resume({
      runRef: stateDir,
      plugin: createScriptedGraph({ definition, advances: [pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
    });
    expect(report.stopReason).toBe("paused");
    expect((await controller.inspect(stateDir)).budgets.activeMs).toBeLessThanOrEqual(10_000 - 1_500);
  });

  it("aborts a job that outlives the budget, stops the run, and stops again at once on resume", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "active-out",
    });
    await setActiveMs(paused.stateDir, 1_500);

    let aborted = false;
    const hang = async (_job: unknown, ctx: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
      aborted = true;
      return { status: "failed" as const, summary: "cancelled" };
    };
    const resumedAt = Date.now();
    const outOfTime = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [writeJob] }),
      validators,
      runner: createScriptedRunner({ jobs: [hang] }),
    });
    expect(Date.now() - resumedAt).toBeGreaterThanOrEqual(1_500);
    expect(Date.now() - resumedAt).toBeLessThan(10_000);
    expect(aborted).toBe(true);
    expect(outOfTime).toMatchObject({
      status: "stopped",
      stopReason: "active time budget exhausted",
      blocker: "no active execution time remains",
    });
    expect((await controller.inspect(paused.stateDir)).budgets.activeMs).toBe(0);

    const again = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [writeJob] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
    });
    expect(again).toMatchObject({ status: "stopped", stopReason: "active time budget exhausted" });
    expect((await controller.inspect(paused.stateDir)).budgets.activeMs).toBe(0);
  });

  it("records the time a job ran when the run is stopped from outside the loop", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "active-external-stop",
    });
    await setActiveMs(paused.stateDir, 60_000);

    const hang = async (_job: unknown, ctx: { signal?: AbortSignal }) => {
      // Another process persists the stop while the job runs; the loop sees it and aborts the job.
      setTimeout(() => {
        void loadRunState(paused.stateDir).then((state) =>
          saveRunState({ ...state, status: "stopped", stopReason: "operator stop", blocker: "stop requested" }),
        );
      }, 1_000);
      await new Promise<void>((resolve) => ctx.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "failed" as const, summary: "cancelled" };
    };
    const report = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [writeJob] }),
      validators,
      runner: createScriptedRunner({ jobs: [hang] }),
    });
    expect(report.stopReason).toBe("operator stop");
    expect((await controller.inspect(paused.stateDir)).budgets.activeMs).toBeLessThanOrEqual(59_000);
  });

  it("aborts a supervisor decision that outlives the budget", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [pause] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "active-supervisor",
    });
    await setActiveMs(paused.stateDir, 1_000);

    let aborted = false;
    const report = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar state" }, "escalate")] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      supervisor: {
        async decide(input) {
          await new Promise<void>((resolve) => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
          aborted = true;
          throw new Error("cancelled");
        },
      },
    });
    expect(aborted).toBe(true);
    expect(report).toMatchObject({ status: "stopped", stopReason: "active time budget exhausted" });
  });
});

function latest(
  evidence: Array<{ kind: string; payload?: unknown }>,
  kind: string,
): unknown {
  return [...evidence].reverse().find((e) => e.kind === kind)?.payload;
}

async function makeEnv(): Promise<{
  taskDir: string;
  taskPath: string;
  repoPath: string;
  stateRoot: string;
}> {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], {
    cwd: repoRoot,
  });

  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-corr-"));
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
