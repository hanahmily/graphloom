import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createScriptedSupervisor, type Supervisor, type SupervisorInput } from "@graphloom/supervisor";
import { createController, loadRunState, saveRunState, type ProposalReviewer } from "./index.js";

/**
 * I4: a provider call the proposal reviewer spends during a running supervisor
 * prompt shrinks what that prompt may still spend. A refute that consumes the
 * turn's last call ends the turn; the prompt must not start another.
 */

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
      independence: "separate-reviewer" as const,
    },
  ],
};

function latest(evidence: { kind: string; payload?: unknown }[], kind: string): unknown {
  for (let i = evidence.length - 1; i >= 0; i--) {
    if (evidence[i]?.kind === kind) return evidence[i]?.payload;
  }
  return undefined;
}

const goodGreeting: Validator = {
  evaluate(input) {
    const file = latest(input.evidence, "file") as { path?: string; bytes?: string } | undefined;
    const manifest = latest(input.evidence, "workspace") as { changedPaths?: string[] } | undefined;
    if (!file || !manifest) return { status: "inconclusive" as const, reason: "missing" };
    if (file.path !== GREETING_PATH || file.bytes !== GREETING) return { status: "failed" as const, reason: "bad bytes" };
    if (manifest.changedPaths?.some((p) => p !== GREETING_PATH) !== false) return { status: "failed" as const, reason: "bad scope" };
    return { status: "passed" as const, reason: "ok" };
  },
};
const independentReview: Validator = {
  evaluate(input) {
    const review = latest(input.evidence, "review") as { verdict?: string } | undefined;
    return review?.verdict === "approved"
      ? { status: "passed" as const, reason: "approved" }
      : { status: "failed" as const, reason: "not approved" };
  },
};
const validators = { "exact-greeting": goodGreeting, "independent-reviewer": independentReview };

const finish: GraphDecision[] = [
  dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
  observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
  validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];

const runner = () =>
  createScriptedRunner({
    jobs: Array.from({ length: 8 }, () => async (job: { purpose?: string; readOnly?: boolean }, ctx: { worktreePath: string }) => {
      if (job.purpose === "review" || job.readOnly) {
        return {
          status: "ok" as const,
          summary: "approved",
          evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
        };
      }
      await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
      return { status: "ok" as const, summary: "wrote" };
    }),
  });

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) {
      await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
});

async function makeEnv(grants = ""): Promise<{ taskPath: string; stateRoot: string }> {
  if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
    await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-reviewer-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  await cp(helloBundle, path.join(taskDir, "plugins", "hello"), {
    recursive: true,
    dereference: true,
    filter: (src) => path.basename(src) !== "node_modules",
  });
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(
    taskPath,
    `graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
${grants}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}


describe("reviewer calls reduce the running supervisor prompt's allowance", () => {
  it("ends the turn after a refute spends the last call instead of letting the prompt start another", async () => {
    let supervisorCalls = 0;
    let reviewerCalls = 0;
    let pending = 0;
    let active = false;
    let seen: SupervisorInput["rejection"];
    let thirdCall = false;
    const inner = createScriptedSupervisor({
      sessionId: "supervisor-session",
      decisions: [
        async (input) => {
          // One model call proposes; the tool's check reviews it mid-prompt.
          supervisorCalls += 1;
          pending = 1;
          const rejection = await input.admission!.check(stop({ reason: "give up", blocker: "validator" }, "give up"));
          seen = rejection;
          // A prompt told it may keep going starts another model call, as Pi does.
          if (rejection !== undefined && rejection.remaining > 0) {
            thirdCall = true;
            supervisorCalls += 1;
            pending += 1;
          }
          return returnToNormal({ summary: "carry on" }, "return");
        },
      ],
    });
    const supervisor: Supervisor = {
      ...inner,
      async decide(input) {
        active = true;
        try {
          return await inner.decide(input);
        } finally {
          active = false;
        }
      },
      drainProviderCalls() {
        if (active) return 0;
        const n = pending;
        pending = 0;
        return n;
      },
      outstandingProviderCalls() {
        return active ? pending : 0;
      },
    };
    let reviewerPending = 0;
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      drainProviderCalls() {
        const n = reviewerPending;
        reviewerPending = 0;
        return n;
      },
      async review(request) {
        reviewerCalls += 1;
        reviewerPending = 1;
        expect(request.maxProviderCalls).toBe(1);
        return { verdict: "refute", reason: "REFUTED: not shown", evidenceRefs: [] };
      },
    };
    const env = await makeEnv("budgets:\n  agentInvocations: 3\n  recoveryReserve: 1\n");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
          supervise({ reason: "needs a decision" }, "escalate"),
          ...finish.slice(1),
        ],
      }),
      validators,
      supervisor,
      proposalReviewer: reviewer,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-i4-refute-ends-turn",
    });
    expect(reviewerCalls).toBe(1);
    // The prompt is told the turn is over, so no call beyond the two granted is started.
    expect(seen?.remaining).toBe(0);
    expect(thirdCall).toBe(false);
    expect(supervisorCalls + reviewerCalls).toBeLessThanOrEqual(2);
    expect(report.status).toBe("stopped");
    expect((await loadRunState(report.stateDir)).stopReason).toMatch(/budgets? exhausted/);
  });
});

describe("the loop is bounded by the run's budgets, not by a step count", () => {
  // Observing the workspace charges one decision and nothing else; each step reads a different path.
  const observes = (n: number): GraphDecision[] =>
    Array.from({ length: n }, (_, i) => observe({ paths: [`path-${i}.txt`] }, `observe ${i}`));

  it("completes a run of more than 64 charged steps in one invocation", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...observes(80), ...finish] }),
      validators,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "long-run-past-64-steps",
    });
    const state = await loadRunState(report.stateDir);
    expect(report.blocker).toBe("none");
    expect(state.stopReason).toBe("complete");
    expect(state.budgets.decisions).toBeLessThan(512 - 80);
  });

  it("still stops on the decisions budget, with that reason", async () => {
    const env = await makeEnv("budgets:\n  decisions: 70\n");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...observes(100), ...finish] }),
      validators,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "long-run-decisions-exhausted",
    });
    const state = await loadRunState(report.stateDir);
    expect(state.stopReason).toBe("decisions budget exhausted");
    expect(state.budgets.decisions).toBe(0);
  });

  it("stops a loop that charges nothing, naming the last action", async () => {
    const env = await makeEnv();
    const switches = Array.from({ length: 40 }, (_, i) => ({
      type: "switch_model" as const,
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      reason: `try ${i}`,
    }));
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "needs a decision" }, "escalate")] }),
      validators,
      supervisor: createScriptedSupervisor({ decisions: switches }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "uncharged-loop",
    });
    const state = await loadRunState(report.stateDir);
    expect(state.status).toBe("stopped");
    expect(state.stopReason).toBe("no-progress loop");
    expect(state.blocker).toMatch(/16 consecutive controller steps charged no budget; last action: supervisor switch_model/);
    expect(report.stopRetryable).toBe(true);
  });

  it("lets a resume proceed on a run saved with the retired step limit", async () => {
    const env = await makeEnv();
    const controller = createController();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...observes(2), ...finish] }),
      validators,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "saved-step-limit",
    });
    const saved = await loadRunState(first.stateDir);
    const { stopClass: _class, stopMark: _mark, ...rest } = saved;
    void _class;
    void _mark;
    await saveRunState({ ...rest, status: "stopped", stopReason: "step limit", blocker: "exceeded 64 controller steps" });
    const resumed = await controller.resume({
      runRef: first.stateDir,
      plugin: createScriptedGraph({ definition, advances: finish }),
      validators,
      runner: runner(),
    });
    expect(resumed.stopReason).toBe("complete");
  });
});
