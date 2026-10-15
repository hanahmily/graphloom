import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDefinition,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import {
  createPiSupervisor,
  createScriptedSupervisor,
  type PiSupervisorSessionPort,
} from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";

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

function latest(
  evidence: { kind: string; payload?: unknown }[],
  kind: string,
): unknown {
  for (let i = evidence.length - 1; i >= 0; i--) {
    if (evidence[i]?.kind === kind) {
      return evidence[i]?.payload;
    }
  }
  return undefined;
}

const validators: Record<string, Validator> = {
  "exact-greeting": exactGreeting,
  "independent-reviewer": independentReview,
};

const temps: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], {
    cwd: repoRoot,
  });

  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-pi-sup-"));
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
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

function fakeSession(
  replies: string[],
  identity?: {
    sessionId?: string;
    sessionFile?: string;
    provider?: string;
    modelId?: string;
  },
): PiSupervisorSessionPort {
  let i = 0;
  let provider = identity?.provider ?? "minimax-cn";
  let modelId = identity?.modelId ?? "MiniMax-M3";
  return {
    runId: "pi-rec-1",
    get provider() {
      return provider;
    },
    get modelId() {
      return modelId;
    },
    sessionId: identity?.sessionId ?? "sess-durable-1",
    sessionFile: identity?.sessionFile ?? "/tmp/graphloom-sess-durable-1.jsonl",
    credentialSource: "options",
    async prompt() {
      const reply = replies[i++];
      if (reply === undefined) throw new Error("exhausted");
      return reply;
    },
    async setModel(ref) {
      provider = ref.provider;
      modelId = ref.modelId;
    },
    async close() {
      /* */
    },
  };
}

describe("Pi supervisor recovery (controller)", () => {
  it("drives recovery via createPiSupervisor and persists session binding", async () => {
    const env = await makeEnv();
    const controller = createController();

    const replies = [
      JSON.stringify(
        dispatch(
          {
            stageId: "write",
            kind: "agent",
            purpose: "work",
            instruction: "repair",
            writeScope: [GREETING_PATH],
          },
          "pi repair write",
        ),
      ),
      JSON.stringify(observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs")),
      JSON.stringify(validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val")),
      JSON.stringify(returnToNormal({ summary: "repaired" }, "return")),
    ];

    const supervisor = createPiSupervisor({ session: fakeSession(replies) });

    const plugin = createScriptedGraph({
      definition,
      advances: [
        supervise({ reason: "unfamiliar" }, "escalate"),
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
        validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
        stop({ reason: "complete", blocker: "none" }, "done"),
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
      runId: "pi-rec-1",
    });

    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorBinding?.sessionId).toBe("sess-durable-1");
    expect(state.supervisorBinding?.sessionFile).toBe(
      "/tmp/graphloom-sess-durable-1.jsonl",
    );
    expect(state.supervisorBinding?.provider).toBe("minimax-cn");
    expect(state.budgets.agentInvocations).toBeLessThan(64);
  });

  it("settles provider calls when decide returns malformed JSON", async () => {
    const env = await makeEnv();
    const controller = createController();
    const supervisor = createPiSupervisor({
      session: fakeSession(["this is not a decision"]),
    });

    const plugin = createScriptedGraph({
      definition,
      advances: [supervise({ reason: "escalate" }, "escalate")],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      validators,
      supervisor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "pi-malformed-1",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("supervisor decide failed");
    const state = await loadRunState(report.stateDir);
    expect(state.budgets.agentInvocations).toBeLessThan(64);
    expect(state.supervisorBinding?.sessionId).toBe("sess-durable-1");
  });

  it("rejects dispatch to a stageId outside the pinned definition within the same turn", async () => {
    const env = await makeEnv();
    const controller = createController();
    const session = fakeSession([
      JSON.stringify(
        dispatch(
          {
            stageId: "invented-stage",
            kind: "agent",
            purpose: "work",
            instruction: "nope",
            writeScope: [GREETING_PATH],
          },
          "escape hatch",
        ),
      ),
      JSON.stringify(stop({ reason: "no such stage", blocker: "the graph has no invented-stage" }, "stop")),
    ]);
    const prompts: string[] = [];
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, options) => {
      prompts.push(text);
      return prompt(text, options);
    };
    const supervisor = createPiSupervisor({ session });

    const plugin = createScriptedGraph({
      definition,
      advances: [supervise({ reason: "escalate" }, "escalate")],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      plugin,
      validators,
      supervisor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "pi-bad-stage-1",
    });

    // The bad dispatch never reaches admission's stop path: the same decide()
    // re-asks with the failed precondition, and the supervisor decides again.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "undeclared stage: stageId invented-stage is not in the pinned graph definition; stages are write, review",
    );
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("no such stage");
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorMark?.notes).toContain(
      "refused earlier this turn: dispatch: undeclared stage: stageId invented-stage is not in the pinned graph definition; stages are write, review",
    );
  });

  it("gives a resumed run a fresh supervisor when it stopped before its supervisor decided anything", async () => {
    const env = await makeEnv();
    const controller = createController();
    const factoryCalls: string[] = [];
    const supervisorFactory = async (ctx: { runId: string }) => {
      factoryCalls.push(ctx.runId);
      return createPiSupervisor({
        session: fakeSession([JSON.stringify(stop({ reason: "supervisor stopped", blocker: "the implementer keeps failing" }, "stop"))]),
      });
    };
    const work = dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write");

    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [stop({ reason: "paused", blocker: "operator" }, "pause")] }),
      validators,
      supervisorFactory,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "fresh-supervisor",
    });
    expect((await loadRunState(paused.stateDir)).supervisorBinding).toBeUndefined();

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [work] }),
      validators,
      supervisorFactory,
      runner: createScriptedRunner({ jobs: [async () => ({ status: "failed" as const, summary: "agent finished without a result" })] }),
    });

    expect(resumed).toMatchObject({ stopReason: "supervisor stopped", blocker: "the implementer keeps failing" });
    expect(factoryCalls).toEqual(["fresh-supervisor", "fresh-supervisor"]);
  });

  it("tells the supervisor it was resumed only on its first decide() call, not on later turns in the same process", async () => {
    const env = await makeEnv();
    const controller = createController();
    const resumedFlags: Array<boolean | undefined> = [];

    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [stop({ reason: "paused", blocker: "operator" }, "pause")] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "resumed-flag",
    });

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({
        definition,
        advances: [dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write")],
      }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            resumedFlags.push(input.resumed);
            return observe({ paths: [GREETING_PATH] }, "look again");
          },
          (input) => {
            resumedFlags.push(input.resumed);
            return stop({ reason: "done looking", blocker: "test ends here" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [async () => ({ status: "failed" as const, summary: "agent finished without a result" })] }),
    });

    expect(resumed.stopReason).toBe("done looking");
    expect(resumedFlags).toEqual([true, undefined]);
  });

  it("restores supervisor from durable binding on resume via restoreSupervisor", async () => {
    const env = await makeEnv();
    const controller = createController();

    const routingPlugin = {
      describe: () => definition,
      advance(view: import("@graphloom/sdk").RunView) {
        const writeDone = view.receipts.some((r) => r.stageId === "write" && r.valid);
        const reviewDone = view.receipts.some((r) => r.stageId === "review" && r.valid);
        if (!writeDone) {
          return supervise({ reason: "need write repair" }, "escalate");
        }
        if (!reviewDone) {
          const hasReviewEvidence = view.evidence.some((e) => e.kind === "review");
          if (!hasReviewEvidence) {
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
            "val review",
          );
        }
        return stop({ reason: "complete", blocker: "none" }, "done");
      },
    };

    const pauseSupervisor = createPiSupervisor({
      session: fakeSession([
        JSON.stringify(
          dispatch(
            {
              stageId: "write",
              kind: "agent",
              purpose: "work",
              instruction: "repair",
              writeScope: [GREETING_PATH],
            },
            "repair",
          ),
        ),
        JSON.stringify(observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs")),
      ]),
    });

    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: routingPlugin,
      validators,
      supervisor: pauseSupervisor,
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok", summary: "wrote" };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "pi-resume-1",
    });

    expect(paused.status).toBe("stopped");
    const mid = await loadRunState(paused.stateDir);
    expect(mid.mode).toBe("recovery");
    expect(mid.supervisorBinding?.sessionId).toBe("sess-durable-1");

    let restoredSessionId: string | undefined;
    const resumeReplies = [
      JSON.stringify(observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs")),
      JSON.stringify(validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val")),
      JSON.stringify(returnToNormal({ summary: "ok" }, "return")),
    ];
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      runner: createScriptedRunner({
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
      validators,
      plugin: routingPlugin,
      restoreSupervisor: async (binding) => {
        restoredSessionId = binding.sessionId;
        return createPiSupervisor({
          session: fakeSession(resumeReplies, {
            sessionId: binding.sessionId,
            sessionFile: binding.sessionFile ?? "/tmp/x.jsonl",
            provider: binding.provider,
            modelId: binding.modelId,
          }),
          initialSwitchJournal: binding.switchJournal,
        });
      },
    });

    expect(restoredSessionId).toBe("sess-durable-1");
    expect(resumed.status).toBe("succeeded");
    const finalState = await loadRunState(resumed.stateDir);
    expect(finalState.supervisorBinding?.sessionId).toBe("sess-durable-1");
  });
});
