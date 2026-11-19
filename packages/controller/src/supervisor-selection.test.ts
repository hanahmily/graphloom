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
import {
  createScriptedGraph,
  dispatch,
  enter,
  observe,
  reenter,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDefinition,
  type JobSpec,
  type RunView,
  type SupervisorPreference,
  type ValidationInput,
  type Validator,
} from "@graphloom/sdk";
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
import { classifyStop } from "./stop-class.js";
import { HELLO_VERSION } from "./testing/hello-version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const PREFERENCE: SupervisorPreference = { harnesses: ["claude-code", "pi"], models: { "claude-code": ["opus"] } };

const baseDefinition: GraphDefinition = {
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

/** A session answering with JSON replies, then failing once they run out; `usage`, when given, is each prompt's reported usage. */
function session(replies: string[], id: string, usage?: { inputTokens: number; outputTokens: number }): PiSupervisorSessionPort {
  let i = 0;
  return {
    ...(usage !== undefined ? { lastUsage: () => ({ ...usage }) } : {}),
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
function hostOn(
  name: string,
  replies: string[],
  id: string,
  options: { logicalSessionId?: string; switchJournal?: Parameters<typeof createSupervisorHost>[0]["initialSwitchJournal"]; usage?: { inputTokens: number; outputTokens: number } } = {},
) {
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
    session: session(replies, id, options.usage) as unknown as HarnessSession,
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
          usage: { inputTokens: 1000, outputTokens: 50 },
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
    // Each episode record names the harness its decide() call ran on, and the usage it reported (S6, for stats).
    const records = state.supervisorEpisodes ?? [];
    const old = records.slice(0, before.supervisorEpisodes?.length ?? 0);
    const moved = records.slice(before.supervisorEpisodes?.length ?? 0);
    expect(old.map((r) => r.harness)).toEqual(old.map(() => "pi"));
    expect(old.every((r) => r.usage === undefined)).toBe(true);
    expect(moved.map((r) => r.harness)).toEqual(moved.map(() => "claude-code"));
    // One prompt per decide() call here, each reporting its usage.
    expect(moved.map((r) => r.usage)).toEqual(moved.map(() => ({ inputTokens: 1000, outputTokens: 50 })));
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
    // A transition with nothing to start the new harness is refused too, rather than resumed without a supervisor.
    await expect(
      controller.resume({
        runRef: paused.stateDir,
        runner: reviewRunner(),
        validators,
        plugin,
        supervisorPin: { transition: { from: "pi", to: "claude-code", reason: "x" } },
        restoreSupervisor: async () => {
          throw new Error("not reached");
        },
      }),
    ).rejects.toThrow(/supervisor moved from pi to claude-code, but no supervisorFactory was given to start it there/);
    expect((await loadRunState(paused.stateDir)).supervisorTransitions).toBeUndefined();
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

/** Fix ⇄ Review with a supervisor-only Arbitrate that leaves to either (docs/design-graph-topology.md §5). */
const topologyDefinition: GraphDefinition = {
  graphId: "topo",
  version: "1.0.0",
  stages: [
    { id: "fix", name: "Fix", requirementIds: ["req-fix"] },
    { id: "review", name: "Review", requirementIds: ["req-review"] },
    { id: "arb", name: "Arbitrate", requirementIds: ["req-arb"], entry: "supervisor", maxVisits: 2 },
  ],
  edges: [
    { from: "fix", to: "review" },
    { from: "review", to: "fix" },
    { from: "arb", to: "fix" },
    { from: "arb", to: "review" },
  ],
  start: "fix",
  terminal: ["review"],
  requirements: ["fix", "review", "arb"].map((id) => ({ id: `req-${id}`, statement: `${id} is done`, evidenceSchema: "node-v1" })),
  defaultValidators: ["fix", "review", "arb"].map((id) => ({ requirementId: `req-${id}`, validatorId: "node", version: "1" })),
};

/** A repository and an installed level-2 bundle for the topology graph (its code is the in-process plugin). */
async function makeTopologyEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-supervisor-topology-"));
  temps.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo, { recursive: true });
  for (const args of [["init", "-q"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"], ["config", "commit.gpgsign", "false"]]) {
    await run("git", args, { cwd: repo });
  }
  await writeFile(path.join(repo, "README.md"), "repo\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: repo });
  await run("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  const bundle = path.join(dir, "plugins", "topo");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  const manifest = { graphId: "topo", version: "1.0.0", sdkProtocol: 2, entryPoints: { createGraph: "./dist/index.js" } };
  await writeFile(path.join(bundle, "graphloom.manifest.json"), JSON.stringify(manifest), "utf8");
  await writeFile(path.join(bundle, "dist", "index.js"), "export {};\n", "utf8");
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, "graph: topo\nrepo: ./repo\nrequest: walk the graph\n", "utf8");
  return { taskPath, stateRoot: path.join(dir, "state") };
}

describe("a supervisor-only node through a supervisor host (docs/design-graph-topology.md §10)", () => {
  /** A CLI-shaped harness: the JSON reply protocol, as Claude Code and Codex decide. */
  const cli: SupervisorHarness = {
    name: "claude-code",
    capabilities: { toolCalling: false, inSessionModelSwitch: false, compaction: false, exactResend: false, exactProviderCalls: false, rawStreamCapture: false },
    probe: async () => ({ ok: true }),
    restore: async () => {
      throw new Error("restored, not started");
    },
  };
  const work = (stageId: string) =>
    dispatch({ stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `work ${stageId}` }, `work ${stageId}`);
  const check = (stageId: string) => validate({ stageId }, `validate ${stageId}`);
  /** Each node's job records its node; the node validator passes on a record of its node. */
  const nodeValidator: Validator = {
    evaluate(input: ValidationInput) {
      const node = input.requirementId.replace(/^req-/, "");
      return input.evidence.some((e) => (e.payload as { node?: string } | undefined)?.node === node)
        ? { status: "passed" as const, reason: `${node} ok: the record holds` }
        : { status: "inconclusive" as const, reason: `no record of ${node}` };
    },
  };

  it("shows the topology, admits the host's enter, opens supervisor_node_settled with its guidance, returns a refused leave's reason, and admits the leave", async () => {
    const env = await makeTopologyEnv();
    // Fix, then Review hands over; the node's work once the supervisor entered it; then Fix again and Review.
    const advances = [
      work("fix"),
      check("fix"),
      work("review"),
      supervise({ reason: "a point the graph cannot settle" }, "hand over"),
      work("arb"),
      check("arb"),
      check("fix"),
      work("review"),
      check("review"),
      stop({ reason: "complete", blocker: "none" }, "done"),
    ];
    const prompts: string[] = [];
    const replies = [
      JSON.stringify(enter({ stageId: "arb", reason: "the reviewers disagree on the design" }, "arbitrate")),
      JSON.stringify(returnToNormal({ summary: "let the graph run Arbitrate" }, "return")),
      // A leave that is no out-edge of arb: refused in-turn with the controller's reason.
      JSON.stringify(reenter({ stageId: "arb", reason: "again" }, "stay")),
      JSON.stringify(reenter({ stageId: "fix", reason: "the ruling sends it back to Fix" }, "leave along arb → fix")),
      JSON.stringify(returnToNormal({ summary: "fix again" }, "return")),
    ];
    let next = 0;
    const replying = {
      ...session([], "sess-topo"),
      async prompt(text: string) {
        prompts.push(text);
        const reply = replies[next++];
        if (reply === undefined) throw new Error("exhausted");
        return reply;
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: topologyDefinition, advances }),
      validators: { node: nodeValidator },
      runner: createScriptedRunner({
        jobs: Array.from({ length: 16 }, () => async (job: JobSpec) => ({
          status: "ok" as const,
          summary: job.instruction,
          evidence: [{ kind: "other" as const, payload: { node: job.stageId } }],
        })),
      }),
      stateRoot: env.stateRoot,
      runId: "topo-host",
      selectSupervisor: async () => ({
        selection: { harness: "claude-code", source: "fallback", reason: "test" },
        supervisorFactory: async () => createSupervisorHost({ harness: cli, session: replying as unknown as HarnessSession, requireCitedEvidence: false }),
      }),
    });
    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    // The supervise episode: the topology, and enter offered for arb.
    expect(prompts[0]).toContain("- live path: fix#1 → review#1; tail review#1");
    expect(prompts[0]).toContain("- supervisor-only node arb: out-edges arb → fix, arb → review; 2 of 2 visits left");
    expect(prompts[0]).toContain("- no side visit is open; enter admits now: arb");
    expect(prompts[0]).toContain("reenter, enter, return, or stop");
    // The settled episode: its trigger and guidance, the open side visit, and no enter offered.
    const settled = prompts.find((p) => p.includes('"code": "supervisor_node_settled"'));
    expect(settled).toBeDefined();
    expect(settled).toContain("This episode's trigger is supervisor_node_settled");
    expect(settled).toContain("- open side visit: arb#1, entered from the tail. Only you leave it, with reenter along one of its out-edges: arb → fix, arb → review.");
    expect(settled).toContain("1 of 2 visits left");
    expect(settled).not.toContain("reenter, enter");
    // The refused leave came back to the same turn with the controller's reason.
    const refused = prompts.find((p) => p.includes("Rejected: the controller would not admit this reenter: undeclared edge: leave arb to arb"));
    expect(refused).toContain("out-edges of arb: arb → fix, arb → review");
    const state = await loadRunState(report.stateDir);
    expect(state.visits!.find((v) => v.stageId === "arb")).toMatchObject({ entered: "enter", ended: "routed to fix" });
    const episodes = state.supervisorEpisodes ?? [];
    expect(episodes[0]).toMatchObject({
      input: { trigger: { code: "supervise" }, nodes: [{ id: "fix", entry: "graph" }, { id: "review", entry: "graph" }, { id: "arb", entry: "supervisor", maxVisits: 2, visitsLeft: 2 }] },
      admission: { facts: { canEnter: ["arb"] } },
    });
    expect(episodes[0]!.admission.facts?.exits).toBeUndefined();
    const settledRecord = episodes.find((e) => e.input.trigger.code === "supervisor_node_settled");
    expect(settledRecord?.admission.facts).toMatchObject({ canEnter: [], exits: ["fix", "review"] });
  });

  it("stops, retryable and naming the node, when the settled episode's turn ends on inadmissible proposals", async () => {
    const env = await makeTopologyEnv();
    const advances = [work("fix"), check("fix"), supervise({ reason: "a point the graph cannot settle" }, "hand over"), work("arb"), check("arb")];
    const stay = JSON.stringify(reenter({ stageId: "arb", reason: "again" }, "stay"));
    const replies = [JSON.stringify(enter({ stageId: "arb", reason: "rule on it" }, "arbitrate")), JSON.stringify(returnToNormal({ summary: "run it" }, "return")), stay, stay, stay];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: topologyDefinition, advances }),
      validators: { node: nodeValidator },
      runner: createScriptedRunner({
        jobs: Array.from({ length: 4 }, () => async (job: JobSpec) => ({ status: "ok" as const, summary: job.instruction, evidence: [{ kind: "other" as const, payload: { node: job.stageId } }] })),
      }),
      stateRoot: env.stateRoot,
      runId: "topo-unleft",
      selectSupervisor: async () => ({
        selection: { harness: "claude-code", source: "fallback", reason: "test" },
        supervisorFactory: async () => createSupervisorHost({ harness: cli, session: session(replies, "sess-unleft") as unknown as HarnessSession, requireCitedEvidence: false }),
      }),
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "supervisor_inadmissible" });
    expect(report.blocker).toMatch(/^supervisor-only node arb settled and was not left; 3 inadmissible proposals this turn; last: reenter: undeclared edge/);
    expect(classifyStop(await loadRunState(report.stateDir))).toMatchObject({ retryable: true });
  });

  it("gives a chain run no topology facts or nodes", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin,
      validators,
      selectSupervisor: async () => ({
        selection: { harness: "claude-code", source: "plugin", reason: "test" },
        supervisorFactory: async () => hostOn("claude-code", [WRITE, ...FINISH], "sess-chain"),
      }),
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
      runId: "chain-facts",
    });
    expect(report.status).toBe("succeeded");
    const episode = (await loadRunState(report.stateDir)).supervisorEpisodes![0]!;
    expect(episode.input.nodes).toBeUndefined();
    expect(episode.admission.facts).toEqual({ inRecovery: true, canQualify: false, qualifiedArtifactIds: [] });
  });
});
