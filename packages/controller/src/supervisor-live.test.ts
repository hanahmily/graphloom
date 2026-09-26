import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedGraph, supervise, type GraphDefinition, type Validator } from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createPiSupervisor, type PiSupervisorSessionPort } from "@graphloom/supervisor";
import { createController, loadRunState, saveRunState } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
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
      independence: "separate-reviewer" as const,
    },
  ],
};

const passing: Validator = { evaluate: () => ({ status: "passed" as const, reason: "ok" }) };
const validators: Record<string, Validator> = { "exact-greeting": passing, "independent-reviewer": passing };

const DEEPSEEK = { provider: "deepseek", modelId: "deepseek-chat" };
const MINIMAX = { provider: "minimax-cn", modelId: "MiniMax-M3" };
const OPENAI = { provider: "openai", modelId: "gpt-5" };

const temps: string[] = [];
let built: Promise<unknown> | undefined;

afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  built ??= run("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  await built;

  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-sup-live-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await run("git", ["init"], { cwd: repoPath });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await run("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: repoPath });
  await run("git", ["commit", "-m", "init"], { cwd: repoPath });
  const pluginsDir = path.join(taskDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await symlink(helloBundle, path.join(pluginsDir, "hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: hello\nrepo: ./test-repo\nrequest: write the greeting\n", "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

type PromptOptions = Parameters<PiSupervisorSessionPort["prompt"]>[1];
/** One model turn: may call a GraphLoom tool, returns the final text. */
type Turn = (text: string, options: PromptOptions) => string | Promise<string>;

interface ScriptedSession extends PiSupervisorSessionPort {
  prompts: string[];
  options: PromptOptions[];
}

/** A Pi session port whose "model" calls the admission tools it is given. */
function scriptedSession(
  turns: Turn[],
  model = DEEPSEEK,
  refuse: (ref: { provider: string; modelId: string }) => string | undefined | Promise<string | undefined> = () =>
    undefined,
): ScriptedSession {
  let i = 0;
  let current = { ...model };
  const session: ScriptedSession = {
    prompts: [],
    options: [],
    runId: "run",
    get provider() {
      return current.provider;
    },
    get modelId() {
      return current.modelId;
    },
    sessionId: "sess-live-1",
    sessionFile: "/nonexistent/graphloom-sess-live-1.jsonl",
    credentialSource: "pi-stored",
    async prompt(text, options) {
      session.prompts.push(text);
      session.options.push(options);
      const turn = turns[i++];
      if (turn === undefined) throw new Error("script exhausted");
      return turn(text, options);
    },
    async setModel(ref) {
      const refusal = await refuse(ref);
      if (refusal !== undefined) throw new Error(refusal);
      current = { ...ref };
    },
    async close() {},
  };
  return session;
}

async function callTool(options: PromptOptions, name: string, args: Record<string, unknown>): Promise<void> {
  const tool = options?.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not offered`);
  const execute = tool.execute as unknown as (id: string, params: unknown) => Promise<unknown>;
  await execute(`call-${name}`, args);
}

const tool =
  (name: string, args: Record<string, unknown>): Turn =>
  async (_text, options) => {
    await callTool(options, name, args);
    return "";
  };

const stopTool = tool("stop", { reason: "done", stop: { reason: "operator review", blocker: "none" } });

const escalate = () => createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate")] });

describe("live supervisor recovery through the controller (#43)", () => {
  it("aborts a supervisor prompt when the operator stops the run", async () => {
    const env = await makeEnv();
    const controller = createController();
    let prompting!: () => void;
    const started = new Promise<void>((resolve) => {
      prompting = resolve;
    });
    const session = scriptedSession([
      (_text, options) =>
        new Promise<string>((_resolve, reject) => {
          prompting();
          options?.signal?.addEventListener("abort", () => reject(new Error("supervisor prompt aborted")));
        }),
    ]);
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "stop-mid-prompt",
    });
    await started;
    const stopped = await controller.stop("stop-mid-prompt", { stateRoot: env.stateRoot });
    const report = await running;

    expect(stopped.status).toBe("stopped");
    expect(report).toMatchObject({ status: "stopped", stopReason: "operator stop", blocker: "stop requested" });
    expect(session.options[0]?.signal?.aborted).toBe(true);
  });

  it("opens each prompt with the controller's settlement of the previous proposal", async () => {
    const env = await makeEnv();
    const controller = createController();
    const session = scriptedSession([
      tool("dispatch", {
        reason: "rewrite greeting",
        job: { stageId: "write", kind: "agent", purpose: "work", instruction: "write it", writeScope: [GREETING_PATH] },
      }),
      tool("observe", { reason: "look", observe: { paths: [GREETING_PATH], includeWorkspaceManifest: true } }),
      tool("validate", { reason: "check", validate: { stageId: "write", requirementIds: ["greeting-bytes"] } }),
      stopTool,
    ]);
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session }),
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), "hi\n", "utf8");
            return { status: "failed", summary: "agent gave up halfway" };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "settlement",
    });

    expect(report.status).toBe("stopped");
    expect(session.prompts[0]).not.toContain("Since the last proposal");
    expect(session.prompts[1]).toContain("Since the last proposal (dispatch: rewrite greeting), the controller settled:");
    expect(session.prompts[1]).toMatch(/executor failure at stage write .*: failed: agent gave up halfway/);
    expect(session.prompts[2]).toMatch(/Since the last proposal \(observe: look\)[\s\S]*file evidence/);
    expect(session.prompts[3]).toMatch(/receipt \S+ for greeting-bytes at stage write: valid/);
    // Every decide is capped at the invocations still unspent.
    expect(session.options.map((o) => o?.maxTurns)).toEqual([32, 30, 29, 28]);
  });

  it("stops before prompting a metered supervisor with no agent invocations left", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session: scriptedSession([stopTool]) }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "no-budget",
    });
    const state = await loadRunState(first.stateDir);
    await saveRunState({ ...state, budgets: { ...state.budgets, agentInvocations: 0 } });

    const resumed = scriptedSession([stopTool]);
    const report = await controller.resume({
      runRef: first.stateDir,
      runner: createScriptedRunner({ jobs: [] }),
      validators,
      plugin: escalate(),
      restoreSupervisor: async () => createPiSupervisor({ session: resumed }),
    });

    expect(report).toMatchObject({
      status: "stopped",
      stopReason: "agentInvocations budget exhausted",
      blocker: "supervisor decide",
    });
    expect(resumed.prompts).toHaveLength(0);
  });

  it("applies the supervisor's switch_model, journals a refused switch, and continues on the current model", async () => {
    const env = await makeEnv();
    const controller = createController();
    let durableAtSwitch: unknown;
    const session = scriptedSession(
      [
        tool("switch_model", { ...MINIMAX, reason: "cheaper for triage" }),
        tool("switch_model", { ...OPENAI, reason: "stronger model" }),
        stopTool,
      ],
      DEEPSEEK,
      async (ref) => {
        if (ref.provider === "openai") return "credential unavailable for provider openai";
        durableAtSwitch = (await loadRunState(path.join(env.stateRoot, "switches"))).supervisorBinding?.switchJournal.at(-1);
        return undefined;
      },
    );
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session, configuredModels: [DEEPSEEK, MINIMAX, OPENAI] }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "switches",
    });

    expect(report.status).toBe("stopped");
    // The intent is durable before the model changes, so a crash here is reconcilable.
    expect(durableAtSwitch).toMatchObject({ from: DEEPSEEK, to: MINIMAX, status: "intent" });
    expect(session.prompts[1]).toContain("Your model is minimax-cn/MiniMax-M3");
    expect(session.prompts[1]).toContain("supervisor switched the supervisor model to minimax-cn/MiniMax-M3");
    expect(session.prompts[2]).toContain(
      "supervisor model switch to openai/gpt-5 failed: credential unavailable for provider openai; continuing on minimax-cn/MiniMax-M3",
    );
    expect(session.prompts[2]).toContain("Your model is minimax-cn/MiniMax-M3");
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorBinding).toMatchObject({
      ...MINIMAX,
      configuredModels: [DEEPSEEK, MINIMAX, OPENAI],
      switchJournal: [
        { from: DEEPSEEK, to: MINIMAX, status: "committed" },
        { from: MINIMAX, to: OPENAI, status: "failed", error: "credential unavailable for provider openai" },
      ],
    });
  });

  it("applies an operator switch request before the next prompt after resume", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session: scriptedSession([stopTool]), configuredModels: [DEEPSEEK, MINIMAX] }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "operator-switch",
    });
    await controller.switchModel("operator-switch", { ...MINIMAX, reason: "deepseek outage" }, { stateRoot: env.stateRoot });

    let restoredFrom: string | undefined;
    const resumed = scriptedSession([stopTool]);
    const report = await controller.resume({
      runRef: first.stateDir,
      runner: createScriptedRunner({ jobs: [] }),
      validators,
      plugin: escalate(),
      restoreSupervisor: async (binding) => {
        restoredFrom = `${binding.provider}/${binding.modelId}`;
        return createPiSupervisor({
          session: resumed,
          configuredModels: binding.configuredModels!,
          initialSwitchJournal: binding.switchJournal,
        });
      },
    });

    expect(report.status).toBe("stopped");
    expect(restoredFrom).toBe("deepseek/deepseek-chat");
    expect(resumed.prompts[0]).toContain("operator switched the supervisor model to minimax-cn/MiniMax-M3");
    expect(resumed.prompts[0]).toContain("Your model is minimax-cn/MiniMax-M3");
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorBinding).toMatchObject({
      ...MINIMAX,
      switchJournal: [{ from: DEEPSEEK, to: MINIMAX, reason: "deepseek outage", status: "committed" }],
    });
    await expect(access(path.join(report.stateDir, "supervisor-switch.json"))).rejects.toThrow();
  });

  it("journals an operator switch to an unconfigured model as failed and keeps going", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session: scriptedSession([stopTool]), configuredModels: [DEEPSEEK] }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "operator-unconfigured",
    });
    await controller.switchModel("operator-unconfigured", { ...OPENAI, reason: "try" }, { stateRoot: env.stateRoot });
    const resumed = scriptedSession([stopTool]);
    const report = await controller.resume({
      runRef: first.stateDir,
      runner: createScriptedRunner({ jobs: [] }),
      validators,
      plugin: escalate(),
      restoreSupervisor: async (binding) =>
        createPiSupervisor({ session: resumed, configuredModels: binding.configuredModels! }),
    });

    expect(resumed.prompts[0]).toMatch(/operator model switch to openai\/gpt-5 failed: model not configured/);
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorBinding).toMatchObject({
      ...DEEPSEEK,
      switchJournal: [{ to: OPENAI, status: "failed", error: expect.stringMatching(/model not configured/) }],
    });
  });

  it("settles a switch intent left by a crash before restoring the supervisor", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: escalate(),
      validators,
      supervisor: createPiSupervisor({ session: scriptedSession([stopTool]), configuredModels: [DEEPSEEK, MINIMAX] }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "switch-crash",
    });
    const state = await loadRunState(first.stateDir);
    const binding = state.supervisorBinding!;
    await saveRunState({
      ...state,
      supervisorBinding: {
        ...binding,
        switchJournal: [{ at: "2026-09-25T00:00:00.000Z", from: DEEPSEEK, to: MINIMAX, reason: "x", status: "intent" }],
      },
    });

    let restored: typeof binding | undefined;
    await controller.resume({
      runRef: first.stateDir,
      runner: createScriptedRunner({ jobs: [] }),
      validators,
      plugin: escalate(),
      restoreSupervisor: async (b) => {
        restored = b;
        return createPiSupervisor({ session: scriptedSession([stopTool]) });
      },
    });

    // The session file never recorded the change, so the switch failed and the run stays on deepseek.
    expect(restored).toMatchObject({ ...DEEPSEEK, switchJournal: [{ to: MINIMAX, status: "failed" }] });
    expect(restored!.switchJournal[0]!.error).toMatch(/interrupted before commit/);
  });
});
