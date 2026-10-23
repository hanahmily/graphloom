import { existsSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as realSleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import {
  createPiSupervisor,
  createScriptedSupervisor,
  type PiSupervisorSessionPort,
  type ProviderFailure,
  SupervisorProviderError,
  type Supervisor,
} from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";
import { classifyStop } from "./stop-class.js";

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

  // Rebuilding rewrites dist/ under test files that run in parallel; `npm test` builds it first.
  if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
    await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }

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
      session: fakeSession(["this is not a decision", "still not a decision"]),
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
    expect(report.stopReason).toMatch(/^supervisor provider malformed: the reply is neither a tool call nor GraphDecision JSON/);
    // Re-asked once with what was wrong (charged like any call), then named; not counted as inadmissible.
    expect(report.blocker).toMatch(/\(not remedied: already re-asked once in this turn; the host cannot open a fresh session\)$/);
    const state = await loadRunState(report.stateDir);
    expect(state.remedies).toMatchObject([{ condition: "supervisor provider malformed", remedy: expect.stringMatching(/re-asked/) }]);
    expect(state.supervisorOutcomes ?? []).toEqual([]);
    // Only the graph's own supervise decision was charged; the unreadable replies were not rejections.
    expect(state.intake.budgets.decisions - state.budgets.decisions).toBe(1);
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
    // A JSON-reply session cannot call the probe tools, so it cannot cite one.
    const supervisor = createPiSupervisor({ session, requireCitedEvidence: false });

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
        requireCitedEvidence: false,
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

  it("carries no resume flag; a resumed run's supervisor sees the case file the earlier process kept", async () => {
    const env = await makeEnv();
    const controller = createController();
    const seen: Array<{ keys: string[]; facts: string[] }> = [];
    const look = (input: Parameters<Supervisor["decide"]>[0]) => {
      seen.push({ keys: Object.keys(input), facts: (input.caseFile?.facts ?? []).map((f) => f.text) });
    };

    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [observe({ paths: ["README.md"] }, "look"), supervise({ reason: "help" }, "escalate")],
      }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          async (input) => {
            look(input);
            const ref = input.view.evidence[0]!.ref;
            await input.recordFinding!({ kind: "fact", text: "README.md is unchanged", evidence: [ref] });
            return stop({ reason: "pause", blocker: "operator" }, "pause");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "case-file-resume",
    });
    expect(paused.stopReason).toBe("pause");

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "help again" }, "escalate")] }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            look(input);
            return stop({ reason: "done looking", blocker: "test ends here" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [] }),
    });

    expect(resumed.stopReason).toBe("done looking");
    expect(seen.map((s) => s.keys.includes("resumed"))).toEqual([false, false]);
    // Nothing changed the candidate or the plugin version across the resume, so the fact is still live.
    expect(seen.map((s) => s.facts)).toEqual([[], ["README.md is unchanged"]]);
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

/** A reply, or a classified failure; `retryInMs` sets the failure's reset time relative to when the turn runs. */
type ScriptedTurn = { reply: string } | { failure: ProviderFailure; retryInMs?: number } | { timeout: string };

/** A session whose turns fail the way a provider would, as the Pi host classifies them. */
function failingSession(turns: ScriptedTurn[]): PiSupervisorSessionPort & { prompts: number; compactions: number } {
  let i = 0;
  let current: ScriptedTurn | undefined;
  let undrained = 0;
  const port = {
    runId: "pi-fail-1",
    provider: "minimax-cn",
    modelId: "MiniMax-M3",
    sessionId: "sess-fail-1",
    sessionFile: "/tmp/graphloom-sess-fail-1.jsonl",
    credentialSource: "options" as const,
    prompts: 0,
    compactions: 0,
    async prompt() {
      current = turns[i++];
      if (current === undefined) throw new Error("scripted session exhausted");
      port.prompts += 1;
      undrained += 1;
      // As the Pi session reports a provider that went silent.
      if ("timeout" in current) throw new SupervisorProviderError({ failureClass: "timeout", message: current.timeout });
      return "reply" in current ? current.reply : "";
    },
    lastReplyFailure() {
      if (current === undefined || !("failure" in current)) return undefined;
      return current.retryInMs !== undefined ? { ...current.failure, retryAt: new Date(Date.now() + current.retryInMs).toISOString() } : current.failure;
    },
    async compact() {
      port.compactions += 1;
      undrained += 2;
    },
    drainTurnCount() {
      const n = undrained;
      undrained = 0;
      return n;
    },
    async setModel() {
      /* */
    },
    async close() {
      /* */
    },
  };
  return port;
}

/** Counts decide() calls the controller makes, delegating everything else. */
function countingDecides(supervisor: Supervisor): { supervisor: Supervisor; decides: () => number } {
  let n = 0;
  const counted = Object.assign(Object.create(supervisor) as Supervisor, {
    decide: (input: Parameters<Supervisor["decide"]>[0]) => {
      n += 1;
      return supervisor.decide(input);
    },
  });
  return { supervisor: counted, decides: () => n };
}

describe("supervisor provider failures and deterministic remedies (controller)", () => {
  const writeWork = dispatch(
    { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] },
    "write",
  );
  const finishingAdvances = [
    writeWork,
    observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
    validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val"),
    dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
    validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
    stop({ reason: "complete", blocker: "none" }, "done"),
  ];
  const writeJob = async (_job: unknown, ctx: { worktreePath: string }) => {
    await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
    return { status: "ok" as const, summary: "wrote" };
  };
  const reviewJob = async () => ({
    status: "ok" as const,
    summary: "approved",
    evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
  });
  const returnReply = { reply: JSON.stringify(returnToNormal({ summary: "carry on" }, "return")) };

  async function runWith(session: PiSupervisorSessionPort, runId: string, options: { transientRetryBaseMs?: number } = {}) {
    const env = await makeEnv();
    const counted = countingDecides(createPiSupervisor({ session, ...options }));
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finishingAdvances],
      }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [writeJob, reviewJob] }),
      stateRoot: env.stateRoot,
      runId,
    });
    const loaded = await loadRunState(report.stateDir);
    return { report, decides: counted.decides(), state: loaded };
  }

  it("waits out a 429 with a reset time, charges waitMs, and completes without a stop or an extra decide", async () => {
    const session = failingSession([
      { failure: { failureClass: "quota", message: "429 rate limit reached (2056)" }, retryInMs: 300 },
      returnReply,
    ]);
    const { report, decides, state } = await runWith(session, "pi-quota-1");
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
    expect(decides).toBe(1);
    expect(session.prompts).toBe(2);
    expect(state.remedies).toMatchObject([
      { condition: "supervisor provider quota", detail: "429 rate limit reached (2056)", remedy: expect.stringMatching(/^waited \d+s/) },
    ]);
    const waited = state.remedies![0]!.waitedMs!;
    expect(waited).toBeGreaterThan(0);
    expect(state.budgets.waitMs).toBeLessThanOrEqual(state.intake.budgets.waitMs! - waited);
    const inspected = await createController().inspect(report.stateDir);
    expect(inspected.remedies.map((r) => r.condition)).toEqual(["supervisor provider quota"]);
  });

  const LIVE_500 = '{"type":"error","error":{"type":"api_error","message":"Internal server error. Please retry your request. (500)"}}';

  it("backs off after a transient 500, charges waitMs, and completes with one decide", async () => {
    const session = failingSession([{ failure: { failureClass: "transient", message: LIVE_500 } }, returnReply]);
    const { report, decides, state } = await runWith(session, "pi-transient-1", { transientRetryBaseMs: 200 });
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
    expect(decides).toBe(1);
    expect(session.prompts).toBe(2);
    expect(state.remedies).toMatchObject([
      {
        condition: "supervisor provider transient",
        detail: LIVE_500,
        remedy: expect.stringMatching(/^backed off \d+s after a transient provider error and retried the turn$/),
      },
    ]);
    const waited = state.remedies![0]!.waitedMs!;
    expect(waited).toBeGreaterThanOrEqual(200);
    expect(state.budgets.waitMs).toBeLessThanOrEqual(state.intake.budgets.waitMs! - waited);
  });

  it("stops naming transient once the turn's retries are spent", async () => {
    const failing = { failure: { failureClass: "transient" as const, message: LIVE_500 } };
    const session = failingSession([failing, failing, failing, failing, returnReply]);
    const { report, decides, state } = await runWith(session, "pi-transient-stop-1", { transientRetryBaseMs: 10 });
    expect(report.status).toBe("stopped");
    expect(decides).toBe(1);
    expect(session.prompts).toBe(4);
    expect(report.stopReason).toBe(`supervisor provider transient: ${LIVE_500}`);
    expect(report.blocker).toBe(
      `supervisor provider transient: ${LIVE_500} (not remedied: still failing after 3 retries in this turn)`,
    );
    expect(state.remedies?.map((r) => r.condition)).toEqual(Array.from({ length: 3 }, () => "supervisor provider transient"));
  });

  it("compacts after an overflow and retries the turn", async () => {
    const session = failingSession([
      { failure: { failureClass: "overflow", message: "400 invalid params, context window exceeds limit (2013)" } },
      returnReply,
    ]);
    const { report, decides, state } = await runWith(session, "pi-overflow-1");
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
    expect(decides).toBe(1);
    expect(session.compactions).toBe(1);
    expect(state.remedies).toMatchObject([{ condition: "supervisor provider overflow", remedy: expect.stringMatching(/compacted/) }]);
    // two prompts plus the compaction's two-call upper bound, before the graph's own two agent jobs
    expect(state.intake.budgets.agentInvocations - state.budgets.agentInvocations).toBe(4 + 2);
  });

  it("re-asks once after an empty reply", async () => {
    const session = failingSession([
      { failure: { failureClass: "empty", message: "the reply had only thinking, no tool call or text (stopReason stop)" } },
      returnReply,
    ]);
    const { report, decides, state } = await runWith(session, "pi-empty-1");
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
    expect(decides).toBe(1);
    expect(session.prompts).toBe(2);
    expect(state.remedies).toMatchObject([{ condition: "supervisor provider empty", remedy: expect.stringMatching(/re-asked/) }]);
  });

  it("names the failure class and provider message when a failure stops the run", async () => {
    const message =
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。 (2056)"}}';
    const session = failingSession([{ failure: { failureClass: "quota", message } }, returnReply]);
    const { report, decides } = await runWith(session, "pi-quota-stop-1");
    expect(report.status).toBe("stopped");
    expect(decides).toBe(1);
    expect(report.stopReason).toBe(`supervisor provider quota: ${message}`);
    expect(report.blocker).toBe(`supervisor provider quota: ${message} (not remedied: the provider gave no reset time to wait for)`);
  });

  it("returns a stalled episode with new evidence since the last episode to normal without a decide call", async () => {
    const env = await makeEnv();
    const readme = observe({ paths: ["README.md"] }, "observe readme");
    let proposals = 0;
    const graph: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance() {
        proposals += 1;
        // supervise, then observe the same unchanged file again and again
        return proposals === 1 ? supervise({ reason: "unfamiliar" }, "escalate") : readme;
      },
    };
    const triggers: string[] = [];
    const counted = countingDecides(
      createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(input.trigger.code);
            return returnToNormal({ summary: "carry on" }, "return");
          },
          (input) => {
            triggers.push(input.trigger.code);
            return stop({ reason: "observing changes nothing", blocker: "no progress" }, "stop");
          },
        ],
      }),
    );
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph,
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "stalled-fresh-1",
    });
    // The first stall comes after README evidence the last episode never
    // saw: it returns without a model call. The next stall has nothing new.
    expect(report).toMatchObject({ status: "stopped", stopReason: "observing changes nothing" });
    expect(triggers).toEqual(["supervise", "stalled"]);
    expect(counted.decides()).toBe(2);
    const state = await loadRunState(report.stateDir);
    expect(state.remedies).toMatchObject([
      { condition: "stalled", remedy: expect.stringMatching(/^returned to normal without a model call/) },
    ]);
  });

  it("retries a failure the executor declares retryable, with its wait charged, without asking the supervisor", async () => {
    const env = await makeEnv();
    const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({
        jobs: [
          async () => ({ status: "failed" as const, summary: "upstream 503", retryLimit: 2, retryAfterMs: 50 }),
          async () => ({ status: "failed" as const, summary: "upstream 503 again", retryLimit: 2 }),
          writeJob,
          reviewJob,
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "executor-retry-1",
    });
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
    expect(counted.decides()).toBe(0);
    const state = await loadRunState(report.stateDir);
    expect(state.remedies?.map((r) => r.remedy)).toEqual([
      expect.stringMatching(/^retry 1 of 2 after/),
      expect.stringMatching(/^retry 2 of 2 after/),
    ]);
    expect(state.budgets.waitMs).toBeLessThan(state.intake.budgets.waitMs!);
    expect(state.executorRetryCounts ?? {}).toEqual({});
  });

  it("hands a retryable failure to recovery once the executor's retry limit is spent", async () => {
    const env = await makeEnv();
    const triggers: string[] = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [writeWork] }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(input.trigger.message);
            return stop({ reason: "upstream down", blocker: "503" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async () => ({ status: "failed" as const, summary: "upstream 503", retryLimit: 1 }),
          async () => ({ status: "failed" as const, summary: "upstream 503", retryLimit: 1 }),
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "executor-retry-2",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "upstream down" });
    expect(triggers).toEqual([expect.stringMatching(/failed \(after 1 retries, the executor's limit\): upstream 503$/)]);
  });

  it("retries a continued agent job from the failed attempt's own session, keeping the session chain", async () => {
    const env = await makeEnv();
    let proposals = 0;
    const graph: GraphPlugin = {
      describe: () => structuredClone(definition),
      advance(view) {
        proposals += 1;
        if (proposals === 1) return writeWork;
        if (proposals === 2) {
          const first = view.agentSessions![0]!.operationId;
          return dispatch(
            { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH], continueFrom: first },
            "continue the writer",
          );
        }
        return stop({ reason: "continued writer settled", blocker: "none" }, "done");
      },
    };
    const seen: Array<{ continueFrom?: string; resume?: string; operationId: string }> = [];
    const job = (reply: Record<string, unknown>) => async (j: { continueFrom?: string }, ctx: { operationId: string; session?: { resume?: string } }) => {
      seen.push({
        operationId: ctx.operationId,
        ...(j.continueFrom !== undefined ? { continueFrom: j.continueFrom } : {}),
        ...(ctx.session?.resume !== undefined ? { resume: ctx.session.resume } : {}),
      });
      return { status: "ok" as const, summary: "ran", ...reply };
    };
    const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph,
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({
        jobs: [
          job({ sessionRef: "s1" }),
          job({ status: "failed", summary: "upstream 503", sessionRef: "s2", retryLimit: 1 }),
          job({ sessionRef: "s3" }),
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "continued-retry-1",
    });
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ stopReason: "continued writer settled" });
    expect(counted.decides()).toBe(0);
    const [first, failed, retried] = seen;
    expect(failed).toMatchObject({ continueFrom: first!.operationId, resume: "s1" });
    // The retry continues the failed attempt, which already continued the first.
    expect(retried).toMatchObject({ continueFrom: failed!.operationId, resume: "s2" });
    const chain = (await loadRunState(report.stateDir)).agentSessions!.map((r) => [r.operationId, r.continuedFrom]);
    expect(chain).toEqual([
      [first!.operationId, undefined],
      [failed!.operationId, first!.operationId],
      [retried!.operationId, failed!.operationId],
    ]);
  });

  it("runs a retry stopped during its backoff on resume, without asking the graph or supervisor", async () => {
    const env = await makeEnv();
    const controller = createController();
    const stateDir = path.join(env.stateRoot, "retry-wait-stop-1");
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
      validators,
      supervisor: createScriptedSupervisor({ decisions: [] }),
      runner: createScriptedRunner({
        jobs: [async () => ({ status: "failed" as const, summary: "upstream 503", retryLimit: 2, retryAfterMs: 3_000 })],
      }),
      stateRoot: env.stateRoot,
      runId: "retry-wait-stop-1",
    });
    for (let i = 0; i < 200; i += 1) {
      const pending = await loadRunState(stateDir).then((s) => s.pendingDispatch).catch(() => undefined);
      if (pending?.status === "waiting" && pending.retry !== undefined) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await controller.stop(stateDir);
    expect((await running).status).toBe("stopped");
    const stopped = await loadRunState(stateDir);
    expect(stopped.executorRetry).toBeUndefined();
    expect(stopped.pendingDispatch).toMatchObject({ status: "waiting", retry: { attempt: 1, limit: 2 } });

    const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
    const resumedJobs: string[] = [];
    const resumed = await controller.resume({
      runRef: stateDir,
      // The graph's first advance (the write dispatch) was already made before the stop.
      plugin: createScriptedGraph({ definition, advances: finishingAdvances.slice(1) }),
      validators,
      runner: createScriptedRunner({
        jobs: [writeJob, reviewJob].map((run) => async (j: JobSpec, ctx: { worktreePath: string }) => {
          resumedJobs.push(`${j.stageId}/${j.purpose}`);
          return run(j, ctx);
        }),
      }),
      supervisor: counted.supervisor,
    });
    expect(resumed, `${resumed.stopReason}: ${resumed.blocker}`).toMatchObject({ status: "succeeded" });
    expect(counted.decides()).toBe(0);
    // The first job after resume is the queued retry of the write, before the graph is asked anything.
    expect(resumedJobs).toEqual(["write/work", "review/review"]);
    const state = await loadRunState(stateDir);
    expect(state.remedies?.map((r) => r.remedy)).toEqual([expect.stringMatching(/^retry 1 of 2 after/)]);
  });

  const quotaFailure = (resetAt?: string) => async () => ({
    status: "failed" as const,
    summary: "executor failed: Claude Code run failed (success): You've hit your session limit",
    failureKind: "quota" as const,
    ...(resetAt !== undefined ? { resetAt } : {}),
  });

  it("waits out a harness quota reset on a fake clock, charges waitMs, and re-dispatches the same job without a supervisor episode", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const env = await makeEnv();
      const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
      const started = Date.now();
      const resetAt = new Date(started + 10 * 60_000).toISOString();
      const ran: number[] = [];
      const timed = (run: (j: JobSpec, c: { worktreePath: string }) => Promise<Record<string, unknown>>) => async (j: JobSpec, c: { worktreePath: string }) => {
        ran.push(Date.now() - started);
        return run(j, c) as never;
      };
      let settled = false;
      const running = createController()
        .run({
          taskPath: env.taskPath,
          plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
          validators,
          supervisor: counted.supervisor,
          runner: createScriptedRunner({ jobs: [timed(quotaFailure(resetAt)), timed(writeJob), timed(reviewJob)] }),
          stateRoot: env.stateRoot,
          runId: "quota-wait-1",
        })
        .finally(() => {
          settled = true;
        });
      // Time moves only once the run is waiting out the reset; real timers pace the polling.
      const real = (ms: number) => new Promise((resolve) => realSleep(ms, undefined, undefined).then(resolve));
      while (ran.length === 0) await real(10);
      for (let i = 0; i < 2_000 && !settled; i += 1) {
        await real(10);
        await vi.advanceTimersByTimeAsync(15_000);
      }
      const report = await running;
      expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
      expect(counted.decides()).toBe(0);
      // The same write job ran again, only once the reset and the margin had passed.
      expect(ran).toHaveLength(3);
      expect(ran[1]!).toBeGreaterThanOrEqual(10 * 60_000 + 30_000);
      const state = await loadRunState(report.stateDir);
      expect(state.supervisorEpisodes ?? []).toEqual([]);
      expect(state.remedies).toMatchObject([
        { condition: "harness quota (executor graphloom.agent/run)", remedy: expect.stringContaining(`resets at ${resetAt}`) },
      ]);
      const waited = state.remedies![0]!.waitedMs!;
      expect(waited).toBeGreaterThan(8 * 60_000); // the fake clock also ran while the first job settled
      // Charged when the retry was admitted, for what was still left to wait by then.
      const charged = state.intake.budgets.waitMs! - state.budgets.waitMs!;
      expect(charged).toBeGreaterThan(0);
      expect(charged).toBeLessThanOrEqual(waited);
      const failure = state.evidence.map((e) => (e.payload as { executorFailure?: Record<string, unknown> }).executorFailure).find((f) => f !== undefined);
      expect(failure).toMatchObject({ failureKind: "quota", resetAt });
      const inspected = await createController().inspect(report.stateDir);
      expect(inspected.remedies.map((r) => r.condition)).toEqual(["harness quota (executor graphloom.agent/run)"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retryable with the reset time when the wait exceeds the remaining waitMs, opening no supervisor episode", async () => {
    const env = await makeEnv();
    const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
    const resetAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [quotaFailure(resetAt)] }),
      stateRoot: env.stateRoot,
      runId: "quota-stop-1",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: `harness quota exhausted until ${resetAt}` });
    expect(counted.decides()).toBe(0);
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorEpisodes ?? []).toEqual([]);
    expect(state.budgets.waitMs).toBe(state.intake.budgets.waitMs);
    expect(state.executorRetry).toBeUndefined();
    expect(classifyStop(state)).toMatchObject({ retryable: true, kind: "harness quota" });
  });

  it("stops retryable with an unknown reset when the message states none, without a supervisor loop", async () => {
    const env = await makeEnv();
    const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [quotaFailure()] }),
      stateRoot: env.stateRoot,
      runId: "quota-unknown-1",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "harness quota exhausted until unknown" });
    expect(counted.decides()).toBe(0);
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorEpisodes ?? []).toEqual([]);
    expect(classifyStop(state)).toMatchObject({ retryable: true, kind: "harness quota" });
  });

  it("never retries a failure the controller found, even when the executor declared it retryable", async () => {
    const env = await makeEnv();
    const triggers: string[] = [];
    let jobs = 0;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [writeWork] }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(`${input.trigger.code}: ${input.trigger.message}`);
            return stop({ reason: "wrote outside its scope", blocker: "scope" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            jobs += 1;
            await writeFile(path.join(ctx.worktreePath, "OTHER.txt"), "nope\n", "utf8");
            return { status: "failed" as const, summary: "upstream 503", retryLimit: 3 };
          },
        ],
      }),
      stateRoot: env.stateRoot,
      runId: "scope-no-retry-1",
    });
    expect(report).toMatchObject({ status: "stopped", stopReason: "wrote outside its scope" });
    expect(jobs).toBe(1);
    expect(triggers).toEqual([expect.stringMatching(/^executor_failed: .*changed paths outside the job's write scope: OTHER\.txt/)]);
    const state = await loadRunState(report.stateDir);
    expect(state.remedies ?? []).toEqual([]);
    expect(state.executorRetry).toBeUndefined();
  });

  it("retries a timed-out supervisor turn once in a fresh session and completes with one decide", async () => {
    const opened: string[] = [];
    const first = failingSession([{ timeout: "no output for 120s" }]);
    const counted = countingDecides(
      createPiSupervisor({
        session: first,
        openSession: async () => {
          opened.push("fresh");
          return failingSession([returnReply]);
        },
      }),
    );
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finishingAdvances] }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [writeJob, reviewJob] }),
      stateRoot: env.stateRoot,
      runId: "pi-timeout-1",
    });
    expect(report, `${report.stopReason}: ${report.blocker}`).toMatchObject({ status: "succeeded" });
    expect(counted.decides()).toBe(1);
    expect(opened).toEqual(["fresh"]);
    const state = await loadRunState(report.stateDir);
    expect(state.remedies).toMatchObject([
      { condition: "supervisor provider timeout", detail: "no output for 120s", remedy: "retried the turn once in a fresh supervisor session" },
    ]);
  });

  it("stops naming the timeout when the retried turn times out too", async () => {
    const counted = countingDecides(
      createPiSupervisor({
        session: failingSession([{ timeout: "no output for 120s" }]),
        openSession: async () => failingSession([{ timeout: "no output for 120s" }]),
      }),
    );
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "pi-timeout-2",
    });
    expect(report.status).toBe("stopped");
    expect(counted.decides()).toBe(1);
    expect(report.stopReason).toBe("supervisor provider timeout: no output for 120s");
    expect(report.blocker).toBe("supervisor provider timeout: no output for 120s (not remedied: already retried once)");
  });
});

describe("resume after a stop in recovery (controller)", () => {
  const writeWork = dispatch(
    { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] },
    "write",
  );
  const finishingAdvances = [
    writeWork,
    observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
    validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val"),
    dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
    validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
    stop({ reason: "complete", blocker: "none" }, "done"),
  ];
  const writeJob = async (_job: unknown, ctx: { worktreePath: string }) => {
    await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
    return { status: "ok" as const, summary: "wrote" };
  };
  const reviewJob = async () => ({
    status: "ok" as const,
    summary: "approved",
    evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
  });
  const brokenCheckout = (summary: string) => async () => ({ status: "failed" as const, summary });

  /** A run whose write job failed (the executor's checkout was broken) and whose supervisor stopped on it, citing the failure. */
  async function stoppedInRecovery(runId: string) {
    const env = await makeEnv();
    const controller = createController();
    const triggers: string[] = [];
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [writeWork] }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(`${input.trigger.code}: ${input.trigger.message}`);
            const refs = input.view.evidence.map((e) => e.ref);
            return stop({ reason: "checkout is broken", blocker: "executor cannot clone the repo", evidenceRefs: refs }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [brokenCheckout("checkout failed: not a git top level")] }),
      stateRoot: env.stateRoot,
      runId,
    });
    expect(paused).toMatchObject({ status: "stopped", stopReason: "checkout is broken" });
    expect(triggers).toEqual([expect.stringMatching(/^executor_failed: .*checkout failed: not a git top level/)]);
    const before = await loadRunState(paused.stateDir);
    expect(before).toMatchObject({ mode: "recovery", recoveryTrigger: { code: "executor_failed" } });
    return { controller, stateDir: paused.stateDir, before };
  }

  it("gives the graph a fresh attempt once the operator fixed the executor, without asking the supervisor", async () => {
    const { controller, stateDir, before } = await stoppedInRecovery("resume-retry-1");
    const counted = countingDecides(createScriptedSupervisor({ decisions: [] }));
    const resumed = await controller.resume({
      runRef: stateDir,
      plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
      validators,
      supervisor: counted.supervisor,
      runner: createScriptedRunner({ jobs: [writeJob, reviewJob] }),
    });
    expect(resumed, `${resumed.stopReason}: ${resumed.blocker}`).toMatchObject({ status: "succeeded" });
    expect(counted.decides()).toBe(0);

    const after = await loadRunState(stateDir);
    expect(after.mode).toBe("normal");
    expect(after.recoveryTrigger).toBeUndefined();
    expect(after.remedies).toMatchObject([
      {
        condition: "resumed in recovery (executor_failed)",
        remedy: "resumed: returned to normal so the graph retries what failed before the resume",
        detail: expect.stringContaining("checkout failed: not a git top level"),
        episodeId: before.recoveryEpisodeId,
      },
    ]);
    // Budgets never reset: everything the run spent before the stop stays spent.
    for (const key of ["agentInvocations", "jobs", "decisions", "corrections"] as const) {
      expect(after.budgets[key]).toBeLessThanOrEqual(before.budgets[key]!);
    }
    expect(after.budgets.jobs).toBeLessThan(before.budgets.jobs);
    expect(after.correctionTrials ?? {}).toEqual(before.correctionTrials ?? {});
  });

  it("enters recovery afresh, on post-resume evidence, when the failure recurs after the resume", async () => {
    const { controller, stateDir, before } = await stoppedInRecovery("resume-retry-2");
    const preResumeRefs = new Set(before.evidence.map((e) => e.ref));
    const seen: Array<Parameters<Supervisor["decide"]>[0]> = [];
    const resumed = await controller.resume({
      runRef: stateDir,
      plugin: createScriptedGraph({ definition, advances: [writeWork] }),
      validators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input) => {
            seen.push(input);
            return stop({ reason: "still broken", blocker: "checkout" }, "stop");
          },
        ],
      }),
      runner: createScriptedRunner({ jobs: [brokenCheckout("checkout failed again after the resume")] }),
    });
    expect(resumed).toMatchObject({ status: "stopped", stopReason: "still broken" });
    expect(seen).toHaveLength(1);
    const input = seen[0]!;
    expect(input.trigger).toMatchObject({ code: "executor_failed", message: expect.stringContaining("checkout failed again after the resume") });
    expect(input.episodeId).not.toBe(before.recoveryEpisodeId);
    // The failure the supervisor is shown was recorded after the resume.
    const fresh = input.view.evidence.filter((e) => !preResumeRefs.has(e.ref));
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((e) => (e.generation ?? 0) > before.generation)).toBe(true);
    expect(JSON.stringify(fresh.map((e) => e.payload))).toContain("checkout failed again after the resume");
    // The last proposal's settlement says the operator's resume overtook it.
    expect(input.lastSettlement?.facts).toEqual(
      expect.arrayContaining([expect.stringMatching(/^the operator resumed the run; the controller returned it to its graph/)]),
    );
    const after = await loadRunState(stateDir);
    expect(after.recoveryEpisodeId).toBe(input.episodeId);
    expect(after.budgets.decisions).toBeLessThan(before.budgets.decisions);
  });

  it("resumes a run that stopped in recovery with no supervisor configured by retrying the graph", async () => {
    const env = await makeEnv();
    const controller = createController();
    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "the checkout looks broken" }, "escalate")] }),
      validators,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "resume-retry-nosup",
    });
    expect(paused).toMatchObject({ status: "stopped", blocker: "no supervisor configured" });
    expect((await loadRunState(paused.stateDir)).mode).toBe("recovery");
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition, advances: finishingAdvances }),
      validators,
      runner: createScriptedRunner({ jobs: [writeJob, reviewJob] }),
    });
    expect(resumed, `${resumed.stopReason}: ${resumed.blocker}`).toMatchObject({ status: "succeeded" });
  });
});
