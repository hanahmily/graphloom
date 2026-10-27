// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The run's supervisor pin (design-supervisor-harnesses.md §7.3, §7.4): the
 * composition root's selection is pinned at intake with the plugin's
 * preference stored as given; `resume` keeps it, records one for a run that
 * has none, and records a `--supervisor` move as a transition (logical
 * session kept, evidence written) that `inspect` shows.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, observe, returnToNormal, stop, supervise, validate, type GraphDefinition, type RunView, type SupervisorPreference, type Validator } from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import {
  createPiHarness,
  createPiSupervisor,
  createSupervisorHost,
  PI_HARNESS_CAPABILITIES,
  type HarnessSession,
  type PiSupervisorSessionPort,
  type SupervisorHarness,
} from "@graphloom/supervisor";
import { createController, loadRunState, saveRunState, type SupervisorFactoryContext } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const PREFERENCE: SupervisorPreference = { harnesses: ["claude-code", "pi"], models: { "claude-code": ["opus"] } };

const baseDefinition: GraphDefinition = {
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
      statement: "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    { requirementId: "independent-review", validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" as const },
  ],
};

function latest(evidence: { kind: string; payload?: unknown }[], kind: string): unknown {
  return [...evidence].reverse().find((e) => e.kind === kind)?.payload;
}

const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate(input) {
      const file = latest(input.evidence, "file") as { path?: string; bytes?: string } | undefined;
      if (file === undefined) return { status: "inconclusive" as const, reason: "missing evidence" };
      return file.path === GREETING_PATH && file.bytes === GREETING ? { status: "passed" as const, reason: "ok" } : { status: "failed" as const, reason: "bad bytes" };
    },
  },
  "independent-reviewer": {
    evaluate(input) {
      const review = latest(input.evidence, "review") as { verdict?: string } | undefined;
      if (review === undefined) return { status: "inconclusive" as const, reason: "missing review" };
      return review.verdict === "approved" ? { status: "passed" as const, reason: "approved" } : { status: "failed" as const, reason: "not approved" };
    },
  },
};

/** Escalates until the write stage has a receipt, then runs the review itself. */
const pluginWith = (definition: GraphDefinition) => ({
  describe: () => definition,
  advance(view: RunView) {
    if (!view.receipts.some((r) => r.stageId === "write" && r.valid)) return supervise({ reason: "need write repair" }, "escalate");
    if (!view.receipts.some((r) => r.stageId === "review" && r.valid)) {
      if (!view.evidence.some((e) => e.kind === "review")) {
        return dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review");
      }
      return validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review");
    }
    return stop({ reason: "complete", blocker: "none" }, "done");
  },
});
const plugin = pluginWith({ ...baseDefinition, supervisor: PREFERENCE });

const reviewRunner = () =>
  createScriptedRunner({
    jobs: [async () => ({ status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }] })],
  });
const writeRunner = () =>
  createScriptedRunner({
    jobs: [
      async (_job, ctx) => {
        await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
        return { status: "ok", summary: "wrote" };
      },
    ],
  });

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true }).catch(() => undefined);
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  if (!existsSync(path.join(helloBundle, "dist/index.js"))) {
    await run("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-supervisor-selection-"));
  temps.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  for (const args of [["init"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) await run("git", args, { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "repo\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: repo });
  await run("git", ["commit", "-m", "init"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"), { recursive: true });
  await symlink(helloBundle, path.join(dir, "plugins", "hello"));
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, "graph: hello\nrepo: ./repo\nrequest: write the greeting\n", "utf8");
  return { taskPath, stateRoot: path.join(dir, "state") };
}

/** A session answering with JSON replies, then failing once they run out. */
function session(replies: string[], id: string): PiSupervisorSessionPort {
  let i = 0;
  return {
    runId: "run",
    provider: "minimax-cn",
    modelId: "MiniMax-M3",
    sessionId: id,
    sessionFile: `/tmp/graphloom-${id}.jsonl`,
    credentialSource: "options",
    async prompt() {
      const reply = replies[i++];
      if (reply === undefined) throw new Error("exhausted");
      return reply;
    },
    async setModel() {},
    async close() {},
  };
}

const WRITE = JSON.stringify(dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write it", writeScope: [GREETING_PATH] }, "repair"));
const FINISH = [
  JSON.stringify(observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs")),
  JSON.stringify(validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val")),
  JSON.stringify(returnToNormal({ summary: "written" }, "return")),
];

/** A supervisor host on a harness named `name`, scripted with `replies`. */
function hostOn(name: string, replies: string[], id: string, options: { logicalSessionId?: string; switchJournal?: Parameters<typeof createSupervisorHost>[0]["initialSwitchJournal"] } = {}) {
  const harness: SupervisorHarness = {
    name,
    capabilities: PI_HARNESS_CAPABILITIES,
    probe: async () => ({ ok: true }),
    restore: async () => {
      throw new Error(`the ${name} harness was restored, not started`);
    },
  };
  return createSupervisorHost({
    harness,
    session: session(replies, id) as unknown as HarnessSession,
    requireCitedEvidence: false,
    ...(options.logicalSessionId !== undefined ? { logicalSessionId: options.logicalSessionId } : {}),
    ...(options.switchJournal !== undefined ? { initialSwitchJournal: options.switchJournal } : {}),
  });
}

/** A run pinned to pi at intake whose Pi supervisor dispatched the write and then ran out of replies. */
async function pausedPiRun(runId: string) {
  const env = await makeEnv();
  const controller = createController();
  const preferences: unknown[] = [];
  const paused = await controller.run({
    taskPath: env.taskPath,
    plugin,
    validators,
    selectSupervisor: async (preference) => {
      preferences.push(preference);
      return {
        selection: { harness: "pi", source: "fallback", reason: "the first enabled harness, pi" },
        supervisorFactory: async () => createPiSupervisor({ session: session([WRITE], "sess-pi"), requireCitedEvidence: false }),
      };
    },
    runner: writeRunner(),
    stateRoot: env.stateRoot,
    runId,
  });
  expect(paused.status).toBe("stopped");
  return { controller, paused, preferences, env };
}

describe("supervisor selection at intake", () => {
  it("hands selectSupervisor the plugin's preference as given and pins the choice before the first job", async () => {
    const env = await makeEnv();
    const controller = createController();
    let atCreation: unknown;
    let factoryCalls = 0;
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      validators,
      selectSupervisor: async (preference) => {
        expect(preference).toEqual(PREFERENCE);
        return {
          selection: { harness: "claude-code", source: "plugin", reason: "the plugin's preference (claude-code, pi): claude-code" },
          supervisorFactory: async () => {
            factoryCalls += 1;
            return hostOn("claude-code", [WRITE, ...FINISH], "sess-cc");
          },
        };
      },
      // Replaced by the choice's factory.
      supervisorFactory: async () => {
        throw new Error("the request's own factory is not used once selectSupervisor chose");
      },
      onRunCreated: async ({ stateDir }) => {
        atCreation = (await loadRunState(stateDir)).supervisorSelection;
      },
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
          async () => ({ status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }] }),
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "sel-intake",
    });
    expect(report.status).toBe("succeeded");
    expect(factoryCalls).toBe(1);
    const pinned = { harness: "claude-code", source: "plugin", reason: "the plugin's preference (claude-code, pi): claude-code", preference: PREFERENCE, generation: 1 };
    // Pinned at intake, before any recovery episode.
    expect(atCreation).toMatchObject(pinned);
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorSelection).toMatchObject(pinned);
    expect(state.supervisorBinding?.harness).toBe("claude-code");
    const inspected = await controller.inspect(report.stateDir);
    expect(inspected.supervisorSelection).toMatchObject(pinned);
    expect(inspected.supervisorTransitions).toEqual([]);
  });

  it("refuses the run when selectSupervisor refuses, before any run state exists", async () => {
    const env = await makeEnv();
    await expect(
      createController().run({
        taskPath: env.taskPath,
        plugin,
        validators,
        selectSupervisor: async () => {
          throw new Error("supervisor: plugin requires one of claude-code, pi; enabled and available: codex");
        },
        runner: writeRunner(),
        stateRoot: env.stateRoot,
        runId: "sel-refused",
      }),
    ).rejects.toThrow(/plugin requires one of claude-code, pi/);
    expect(existsSync(path.join(env.stateRoot, "sel-refused"))).toBe(false);
  });

  it("runs without a supervisor or a selection when selectSupervisor finds no harness", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: pluginWith(baseDefinition),
      validators,
      selectSupervisor: async (preference) => {
        expect(preference).toBeUndefined();
        return undefined;
      },
      runner: writeRunner(),
      stateRoot: env.stateRoot,
      runId: "sel-none",
    });
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorSelection).toBeUndefined();
    expect(state.supervisorBinding).toBeUndefined();
  });
});

describe("supervisor pin on resume", () => {
  it("resume keeps the pin and restores the bound harness", async () => {
    const { controller, paused, preferences } = await pausedPiRun("pin-keep");
    expect(preferences).toEqual([PREFERENCE]);
    const restored: string[] = [];
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      runner: reviewRunner(),
      validators,
      plugin,
      restoreSupervisor: async (binding) => {
        restored.push(binding.harness ?? "pi");
        const harness = createPiHarness({ runId: "pin-keep", sessionDir: "/nonexistent", sessionOpener: async (): Promise<HarnessSession> => session(FINISH, "sess-pi-2") });
        return harness.restore({ ...binding, sessionFile: binding.sessionFile });
      },
      supervisorFactory: async () => {
        throw new Error("a pinned, bound run restores; it does not start afresh");
      },
    });
    expect(resumed.status).toBe("succeeded");
    expect(restored).toEqual(["pi"]);
    const state = await loadRunState(resumed.stateDir);
    expect(state.supervisorSelection).toMatchObject({ harness: "pi", source: "fallback", generation: 1 });
    expect(state.supervisorTransitions).toBeUndefined();
  });

  it("resume --supervisor moves the pin: same logical session and journal on the new harness, a transition and evidence, shown by inspect", async () => {
    const { controller, paused } = await pausedPiRun("pin-move");
    const before = await loadRunState(paused.stateDir);
    expect(before.supervisorBinding).toMatchObject({ harness: "pi", sessionId: "sess-pi" });
    const journal = [{ at: "2026-10-27T00:00:00.000Z", from: { provider: "minimax-cn", modelId: "MiniMax-M3" }, to: { provider: "deepseek", modelId: "deepseek-v4-pro" }, reason: "earlier", status: "failed" as const, error: "x" }];
    await saveRunState({ ...before, supervisorBinding: { ...before.supervisorBinding!, switchJournal: journal } });
    const contexts: SupervisorFactoryContext[] = [];
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      runner: reviewRunner(),
      validators,
      plugin,
      supervisorPin: { transition: { from: "pi", to: "claude-code", reason: "Pi's provider is out of credit" } },
      restoreSupervisor: async () => {
        throw new Error("a moved pin starts the new harness; it does not restore the old one");
      },
      supervisorFactory: async (ctx) => {
        contexts.push(ctx);
        return hostOn("claude-code", FINISH, "sess-cc-episode", {
          ...(ctx.continueSession !== undefined ? { logicalSessionId: ctx.continueSession.sessionId, switchJournal: ctx.continueSession.switchJournal } : {}),
        });
      },
    });
    expect(resumed.status).toBe("succeeded");
    expect(contexts.map((c) => c.continueSession)).toEqual([{ sessionId: "sess-pi", switchJournal: journal }]);
    const state = await loadRunState(resumed.stateDir);
    // The logical session, its journal, and the case file and budgets carry over.
    expect(state.supervisorBinding).toMatchObject({ harness: "claude-code", sessionId: "sess-pi" });
    expect(state.supervisorBinding?.switchJournal[0]).toMatchObject({ reason: "earlier" });
    expect(state.budgets.decisions).toBeLessThan(before.budgets.decisions);
    expect(state.supervisorEpisodes?.length).toBeGreaterThan(before.supervisorEpisodes?.length ?? 0);
    const transition = state.supervisorTransitions?.[0];
    expect(state.supervisorTransitions).toEqual([
      { from: "pi", to: "claude-code", reason: "Pi's provider is out of credit", generation: before.generation, at: expect.any(String), evidenceRef: expect.stringMatching(/^ev-/) },
    ]);
    expect(state.evidence.find((e) => e.ref === transition!.evidenceRef)).toMatchObject({
      kind: "other",
      payload: { supervisorUpdate: { from: "pi", to: "claude-code", reason: "Pi's provider is out of credit" } },
    });
    expect(state.supervisorSelection).toMatchObject({
      harness: "claude-code",
      source: "flag",
      reason: "resume --supervisor claude-code (from pi): Pi's provider is out of credit",
      preference: PREFERENCE,
    });
    const inspected = await controller.inspect(resumed.stateDir);
    expect(inspected.supervisorSelection).toMatchObject({ harness: "claude-code", source: "flag" });
    expect(inspected.supervisorTransitions).toEqual(state.supervisorTransitions);
  });

  it("refuses a transition whose from is not the run's pin, leaving the run as it was", async () => {
    const { controller, paused } = await pausedPiRun("pin-stale");
    await expect(
      controller.resume({
        runRef: paused.stateDir,
        runner: reviewRunner(),
        validators,
        plugin,
        supervisorPin: { transition: { from: "codex", to: "claude-code", reason: "x" } },
        restoreSupervisor: async () => {
          throw new Error("not reached");
        },
      }),
    ).rejects.toThrow(/supervisor transition codex -> claude-code refused: the run's supervisor is pinned to pi/);
    const state = await loadRunState(paused.stateDir);
    expect(state.status).toBe("stopped");
    expect(state.supervisorTransitions).toBeUndefined();
  });

  it("a run pinned the S3 way (binding only, no selection) is pinned to its binding's harness; another harness is refused", async () => {
    const { controller, paused } = await pausedPiRun("pin-legacy-binding");
    const file = path.join(paused.stateDir, "state.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    delete raw.supervisorSelection;
    await writeFile(file, JSON.stringify(raw, null, 2), "utf8");
    await expect(
      controller.resume({
        runRef: paused.stateDir,
        runner: reviewRunner(),
        validators,
        plugin,
        supervisorPin: { selection: { harness: "codex", source: "fallback", reason: "x" } },
        restoreSupervisor: async () => {
          throw new Error("not reached");
        },
      }),
    ).rejects.toThrow(/supervisor selection codex refused: the run's supervisor is pinned to pi/);
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      runner: reviewRunner(),
      validators,
      plugin,
      supervisorPin: { selection: { harness: "pi", source: "binding", reason: "pinned at the run's first recovery episode, pi (a run started before supervisor selection)" } },
      restoreSupervisor: async (binding) =>
        createPiHarness({ runId: "pin-legacy-binding", sessionDir: "/nonexistent", sessionOpener: async (): Promise<HarnessSession> => session(FINISH, "sess-pi-3") }).restore({
          ...binding,
          sessionFile: binding.sessionFile,
        }),
    });
    expect(resumed.status).toBe("succeeded");
    const state = await loadRunState(resumed.stateDir);
    // Recorded with the preference the run was described with, at the resume's generation.
    expect(state.supervisorSelection).toMatchObject({ harness: "pi", source: "binding", preference: PREFERENCE });
  });

  it("a run nothing pinned (no selection, no supervisor session) records the selection its resume makes", async () => {
    const env = await makeEnv();
    const controller = createController();
    // Started with no supervisor at all: the escalation stops the run.
    const paused = await controller.run({ taskPath: env.taskPath, plugin, validators, runner: writeRunner(), stateRoot: env.stateRoot, runId: "pin-never" });
    expect(paused.status).toBe("stopped");
    const before = await loadRunState(paused.stateDir);
    expect(before.supervisorSelection).toBeUndefined();
    expect(before.supervisorBinding).toBeUndefined();
    const contexts: SupervisorFactoryContext[] = [];
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
          async () => ({ status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }] }),
        ],
      }),
      validators,
      plugin,
      supervisorPin: { selection: { harness: "claude-code", source: "plugin", reason: "pinned at resume: the plugin's preference (claude-code, pi): claude-code" } },
      supervisorFactory: async (ctx) => {
        contexts.push(ctx);
        return hostOn("claude-code", [WRITE, ...FINISH], "sess-cc-late");
      },
    });
    expect(resumed.status).toBe("succeeded");
    expect(contexts.map((c) => c.continueSession)).toEqual([undefined]);
    const state = await loadRunState(resumed.stateDir);
    expect(state.supervisorSelection).toMatchObject({ harness: "claude-code", source: "plugin", preference: PREFERENCE, generation: before.generation });
    expect(state.supervisorBinding?.harness).toBe("claude-code");
  });
});
