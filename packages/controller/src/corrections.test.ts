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
    expect(inspect.budgets.corrections).toBeLessThan(8);
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
        stop({ reason: "complete" }, "done"),
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
        stop({ reason: "complete" }, "done"),
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
          return stop({ reason: "complete" }, "done");
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
        stop({ reason: "complete" }, "done"),
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
        stop({ reason: "complete" }, "done"),
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
          stop({ reason: "complete" }, "done"),
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
    // Still burned from pre-resume reenter; rewrite may burn another as correction.
    expect(after.budgets.corrections).toBeLessThanOrEqual(before.budgets.corrections);
    expect(after.budgets.corrections).toBeLessThan(8);
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
