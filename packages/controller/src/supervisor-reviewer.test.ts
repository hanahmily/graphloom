// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

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
  qualifyRepair,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createScriptedSupervisor, type Supervisor, type SupervisorInput } from "@graphloom/supervisor";
import { HostObservationError } from "./host-validators.js";
import {
  createController,
  loadRunState,
  needsReview,
  type ProposalReviewer,
  type ProposalReviewRequest,
  type RepairDeps,
} from "./index.js";

/**
 * #121: a `stop` (and a `qualify_repair` that blames a validator or executor)
 * is reviewed by a fresh, independent session before admission. A refute goes
 * back to the supervisor in the same turn; an unavailable reviewer blocks.
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

const escalated = (steps: GraphDecision[]) =>
  createScriptedGraph({
    definition,
    advances: [
      dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
      supervise({ reason: "needs a decision" }, "escalate"),
      ...steps,
    ],
  });

const observed = (steps: GraphDecision[]) =>
  createScriptedGraph({
    definition,
    advances: [
      dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
      observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
      supervise({ reason: "needs a decision" }, "escalate"),
      ...steps,
    ],
  });

describe("supervisor reviewer for high-impact decisions", () => {
  it("refutes a stop in-turn with the reviewer reason, admits a confirmed stop, and blocks when the reviewer is unavailable", async () => {
    // 1. Refuted: the proposal comes back within the same turn, with the reviewer's reason.
    {
      const env = await makeEnv();
      const reviewed: ProposalReviewRequest[] = [];
      const reviewer: ProposalReviewer = {
        sessionId: "reviewer-session",
        async review(request) {
          reviewed.push(request);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { verdict: "refute", reason: "REFUTED: the write stage never ran its validator", evidenceRefs: [] };
        },
      };
      let rejection: SupervisorInput["rejection"];
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: escalated([
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
          dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ]),
        validators,
        supervisor: createScriptedSupervisor({
          sessionId: "supervisor-session",
          decisions: [
            stop({ reason: "validator is wrong", blocker: "validator" }, "give up"),
            (input) => {
              rejection = input.rejection;
              return returnToNormal({ summary: "carry on" }, "return after refute");
            },
          ],
        }),
        proposalReviewer: reviewer,
        runner: runner(),
        stateRoot: env.stateRoot,
        runId: "issue-121-refute",
      });
      expect(report.status, report.blocker).toBe("succeeded");
      expect(reviewed).toHaveLength(1);
      expect(reviewed[0]?.decision.action.type).toBe("stop");
      expect(rejection?.action).toBe("stop");
      expect(rejection?.reason).toContain("REFUTED: the write stage never ran its validator");
    }

    // 2. Confirmed: the stop is admitted.
    {
      const env = await makeEnv();
      let calls = 0;
      const reviewer: ProposalReviewer = {
        sessionId: "reviewer-session",
        async review() {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { verdict: "confirm", reason: "the blocker is real" };
        },
      };
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: escalated(finish),
        validators,
        supervisor: createScriptedSupervisor({
          sessionId: "supervisor-session",
          decisions: [stop({ reason: "external outage", blocker: "external" }, "stop")],
        }),
        proposalReviewer: reviewer,
        runner: runner(),
        stateRoot: env.stateRoot,
        runId: "issue-121-confirm",
      });
      expect(calls).toBe(1);
      expect(report.status).toBe("stopped");
      expect((await loadRunState(report.stateDir)).stopReason).toBe("external outage");
    }

    // 3. Unavailable: an explicit blocker, never an approval.
    {
      const env = await makeEnv();
      const reviewer: ProposalReviewer = {
        sessionId: "reviewer-session",
        async review() {
          throw new Error("reviewer provider is down");
        },
      };
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: escalated(finish),
        validators,
        supervisor: createScriptedSupervisor({
          sessionId: "supervisor-session",
          decisions: [stop({ reason: "external outage", blocker: "external" }, "stop")],
        }),
        proposalReviewer: reviewer,
        runner: runner(),
        stateRoot: env.stateRoot,
        runId: "issue-121-unavailable",
      });
      expect(report.status).toBe("stopped");
      const state = await loadRunState(report.stateDir);
      expect(state.stopReason).toBe("reviewer_unavailable");
      expect(state.blocker).toContain("reviewer provider is down");
    }
  });
  /** A run that escalates once, where the supervisor proposes `decisions` in turn. */
  async function runEscalated(
    runId: string,
    reviewer: ProposalReviewer,
    decisions: Parameters<typeof createScriptedSupervisor>[0]["decisions"],
    options: { grants?: string; plugin?: GraphDecision[]; repair?: RepairDeps; supervisor?: Supervisor } = {},
  ) {
    const env = await makeEnv(options.grants);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalated(options.plugin ?? finish),
      validators,
      supervisor: options.supervisor ?? createScriptedSupervisor({ sessionId: "supervisor-session", decisions }),
      proposalReviewer: reviewer,
      ...(options.repair !== undefined ? { repair: options.repair } : {}),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId,
    });
    return { report, env, state: await loadRunState(report.stateDir) };
  }

  const stopOnOutage = [stop({ reason: "external outage", blocker: "external" }, "stop")];

  it("reviews qualify_repair that blames a validator or an executor, and no other action", async () => {
    const reviewed: string[] = [];
    let rejection: SupervisorInput["rejection"];
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      async review(request) {
        reviewed.push(request.decision.action.type);
        return { verdict: "refute", reason: "REFUTED: the gate is right" };
      },
    };
    const repair: RepairDeps = {
      patchAuthor: { sessionId: "supervisor-session", async patch() { return { summary: "unused" }; } },
      reviewer: { sessionId: "repair-reviewer", async review() { return { approved: true, reason: "unused" }; } },
      async preflight() { return { ok: true, summary: "ok" }; },
      materializeValidators: () => validators,
    };
    const { report } = await runEscalated(
      "issue-121-qualify",
      reviewer,
      [
        qualifyRepair({ target: "validator", reason: "write gate is defective" }, "blame the gate"),
        (input) => {
          rejection = input.rejection;
          return returnToNormal({ summary: "carry on" }, "return");
        },
      ],
      {
        grants: "grants:\n  validatorSubstitution: true\n",
        repair,
        plugin: [
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
          dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      },
    );
    expect(report.status, report.blocker).toBe("succeeded");
    expect(reviewed).toEqual(["qualify_repair"]);
    expect(rejection?.action).toBe("qualify_repair");
    expect(rejection?.reason).toContain("REFUTED: the gate is right");

    const decision = (action: GraphDecision["action"]): GraphDecision => ({ action, reason: "r" });
    expect(needsReview(qualifyRepair({ target: "validator", reason: "r" }, "r"))).toBe(true);
    expect(needsReview(qualifyRepair({ target: "executor", executorId: "x", reason: "r" }, "r"))).toBe(true);
    expect(needsReview(qualifyRepair({ target: "plugin", reason: "r" }, "r"))).toBe(false);
    expect(needsReview(stop({ reason: "r", blocker: "external" }, "r"))).toBe(true);
    expect(needsReview(returnToNormal({ summary: "s" }, "r"))).toBe(false);
    expect(needsReview(decision({ type: "observe", observe: { paths: [] } }))).toBe(false);
  });

  it("reviews a corrected stop again instead of replaying the cached refutation", async () => {
    const reasons: string[] = [];
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      async review(request) {
        reasons.push(request.decision.reason);
        return reasons.length === 1
          ? { verdict: "refute", reason: "REFUTED: no evidence given" }
          : { verdict: "confirm", reason: "the corrected rationale holds" };
      },
    };
    const { report, state } = await runEscalated("issue-121-retry", reviewer, [
      stop({ reason: "external outage", blocker: "external" }, "give up"),
      stop({ reason: "external outage", blocker: "external" }, "the provider status page shows the outage"),
    ]);
    expect(report.status).toBe("stopped");
    expect(reasons).toEqual(["give up", "the provider status page shows the outage"]);
    expect(state.stopReason).toBe("external outage");
  });

  it("gives the reviewer the results of the probes the proposal cites", async () => {
    let seen: ProposalReviewRequest | undefined;
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      async review(request) {
        seen = request;
        return { verdict: "confirm", reason: "ok" };
      },
    };
    const { report } = await runEscalated("issue-121-probe", reviewer, [
      async (input) => {
        const probe = await input.inspect!.checkValidate({ stageId: "write" });
        return { ...stop({ reason: "external outage", blocker: "external" }, "stop"), evidence: [probe.probeId] };
      },
    ]);
    expect(report.status).toBe("stopped");
    expect(seen?.evidence.map((e) => e.ref)).toEqual(["probe-1"]);
    expect(seen?.evidence[0]?.payload).toMatchObject({ probe: { accepted: expect.any(Boolean) } });
  });

  it("charges a metered reviewer's provider calls to agentInvocations", async () => {
    const make = (spend: number | undefined): ProposalReviewer => {
      let pending = 0;
      return {
        sessionId: "reviewer-session",
        ...(spend !== undefined ? { drainProviderCalls: () => { const n = pending; pending = 0; return n; } } : {}),
        async review(request) {
          if (spend !== undefined) {
            expect(request.maxProviderCalls).toBeGreaterThanOrEqual(spend);
            pending = spend;
          }
          return { verdict: "confirm", reason: "ok" };
        },
      };
    };
    const free = await runEscalated("issue-121-free", make(undefined), stopOnOutage);
    const metered = await runEscalated("issue-121-metered", make(3), stopOnOutage);
    expect(free.state.budgets.agentInvocations - metered.state.budgets.agentInvocations).toBe(3);
  });

  it("blocks when the reviewer never answers, answers without a verdict, or is not independent", async () => {
    const hung = await runEscalated(
      "issue-121-timeout",
      { sessionId: "reviewer-session", timeoutMs: 30, review: () => new Promise(() => undefined) },
      stopOnOutage,
    );
    expect(hung.state.stopReason).toBe("reviewer_unavailable");
    expect(hung.state.blocker).toContain("no verdict within 30 ms");

    const malformed = await runEscalated(
      "issue-121-malformed",
      { sessionId: "reviewer-session", review: async () => ({ verdict: "maybe", reason: "unsure" }) as never },
      stopOnOutage,
    );
    expect(malformed.state.stopReason).toBe("reviewer_unavailable");
    expect(malformed.state.blocker).toContain("no verdict");

    const empty = await runEscalated(
      "issue-121-no-reason",
      { sessionId: "reviewer-session", review: async () => ({ verdict: "confirm", reason: " " }) },
      stopOnOutage,
    );
    expect(empty.state.stopReason).toBe("reviewer_unavailable");

    let called = false;
    const shared = await runEscalated(
      "issue-121-shared",
      {
        sessionId: "supervisor-session",
        async review() {
          called = true;
          return { verdict: "confirm", reason: "ok" };
        },
      },
      stopOnOutage,
    );
    expect(called).toBe(false);
    expect(shared.state.stopReason).toBe("reviewer_unavailable");
    expect(shared.state.blocker).toContain("not independent");
  });

  it("cancels a review in flight when the operator stops the run", async () => {
    const controller = createController();
    const env = await makeEnv();
    let entered: () => void = () => undefined;
    const inReview = new Promise<void>((resolve) => (entered = resolve));
    let sawAbort = false;
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: escalated(finish),
      validators,
      supervisor: createScriptedSupervisor({ sessionId: "supervisor-session", decisions: stopOnOutage }),
      proposalReviewer: {
        sessionId: "reviewer-session",
        review: (request) =>
          new Promise((_, reject) => {
            request.signal.addEventListener("abort", () => {
              sawAbort = true;
              reject(new Error("cancelled"));
            });
            entered();
          }),
      },
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-121-cancel",
    });
    await inReview;
    await controller.stop("issue-121-cancel", { stateRoot: env.stateRoot });
    const report = await running;
    expect(report.status).toBe("stopped");
    expect(sawAbort).toBe(true);
    expect((await loadRunState(report.stateDir)).stopReason).not.toBe("reviewer_unavailable");
  });
  const afterEscalation: GraphDecision[] = finish.slice(1);
  const dummyRepair = (): RepairDeps => ({
    patchAuthor: { sessionId: "supervisor-session", async patch() { return { summary: "unused" }; } },
    reviewer: { sessionId: "repair-reviewer", async review() { return { approved: true, reason: "unused" }; } },
    async preflight() { return { ok: true, summary: "ok" }; },
    materializeValidators: () => validators,
  });

  it("reviews an executor qualify_repair and returns the refutation in-turn", async () => {
    const reviewed: string[] = [];
    let rejection: SupervisorInput["rejection"];
    const { report } = await runEscalated(
      "issue-121-executor",
      {
        sessionId: "reviewer-session",
        async review(request) {
          reviewed.push(request.decision.action.type);
          return { verdict: "refute", reason: "REFUTED: the executor did what it was told" };
        },
      },
      [
        qualifyRepair({ target: "executor", executorId: "agent", reason: "executor wrote nothing" }, "blame the executor"),
        (input) => {
          rejection = input.rejection;
          return returnToNormal({ summary: "carry on" }, "return");
        },
      ],
      { grants: "grants:\n  executorRepair: true\n", repair: dummyRepair(), plugin: afterEscalation },
    );
    expect(report.status, report.blocker).toBe("succeeded");
    expect(reviewed).toEqual(["qualify_repair"]);
    expect(rejection?.reason).toContain("REFUTED: the executor did what it was told");
  });

  it("reviews a proposal the supervisor checks itself through admission.check", async () => {
    let first: SupervisorInput["rejection"];
    const { report } = await runEscalated(
      "issue-121-tool-check",
      {
        sessionId: "reviewer-session",
        async review() {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { verdict: "refute", reason: "REFUTED: via the supervisor's own check" };
        },
      },
      [
        async (input) => {
          first = await input.admission!.check(stop({ reason: "external outage", blocker: "external" }, "stop"));
          return returnToNormal({ summary: "carry on" }, "return");
        },
      ],
      { plugin: afterEscalation },
    );
    expect(report.status, report.blocker).toBe("succeeded");
    expect(first?.action).toBe("stop");
    expect(first?.reason).toContain("REFUTED: via the supervisor's own check");
    expect(first?.remaining).toBe(2);
  });

  it("lets the reviewer inspect and probe after the supervisor's turn has ended", async () => {
    let probed: string | undefined;
    const { report, state } = await runEscalated(
      "issue-121-inspect",
      {
        sessionId: "reviewer-session",
        async review(request) {
          const probe = await request.inspect.checkValidate({ stageId: "write" });
          probed = probe.probeId;
          return { verdict: "confirm", reason: "probed it myself" };
        },
      },
      stopOnOutage,
    );
    expect(probed).toBe("probe-1");
    expect(report.status).toBe("stopped");
    expect(state.stopReason).toBe("external outage");
  });

  it("grants the reviewer only what the supervisor has not already spent", async () => {
    const supervisorFor = (spend: number): Supervisor => {
      const inner = createScriptedSupervisor({
        sessionId: "supervisor-session",
        decisions: [
          () => {
            spent += spend;
            return stop({ reason: "external outage", blocker: "external" }, "stop");
          },
        ],
      });
      let spent = 0;
      return {
        ...inner,
        decide: (input) => inner.decide(input),
        drainProviderCalls() {
          const n = spent;
          spent = 0;
          return n;
        },
      };
    };
    const grants: number[] = [];
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      drainProviderCalls: () => 0,
      async review(request) {
        grants.push(request.maxProviderCalls!);
        return { verdict: "confirm", reason: "ok" };
      },
    };
    await runEscalated("issue-121-spend-0", reviewer, [], { supervisor: supervisorFor(0) });
    await runEscalated("issue-121-spend-2", reviewer, [], { supervisor: supervisorFor(2) });
    expect(grants[0]! - grants[1]!).toBe(2);
  });

  it.each([
    ["resume", "resume"],
    ["continueAfterRestart", "continueAfterRestart"],
  ] as const)("keeps reviewing after the run is stopped and continued through %s", async (_name, how) => {
    const controller = createController();
    const env = await makeEnv();
    const runId = `issue-121-${how}`;
    let stopped: Promise<unknown> = Promise.resolve();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: escalated(afterEscalation),
      validators,
      supervisor: createScriptedSupervisor({
        sessionId: "supervisor-session",
        decisions: [
          async (input) => {
            const aborted = new Promise<never>((_, reject) => input.signal?.addEventListener("abort", () => reject(new Error("stopped"))));
            aborted.catch(() => undefined);
            // stop() waits for the run's lock, which this turn holds: awaited once the run has ended.
            stopped = controller.stop(runId, { stateRoot: env.stateRoot });
            stopped.catch(() => undefined);
            return aborted;
          },
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId,
    });
    await stopped;
    expect(first.status).toBe("stopped");

    let reviewed = 0;
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      async review() {
        reviewed += 1;
        return { verdict: "refute", reason: "REFUTED: after restart" };
      },
    };
    let rejection: SupervisorInput["rejection"];
    const supervisor = createScriptedSupervisor({
      sessionId: "supervisor-session",
      decisions: [
        stop({ reason: "external outage", blocker: "external" }, "stop"),
        (input) => {
          rejection = input.rejection;
          return returnToNormal({ summary: "carry on" }, "return");
        },
      ],
    });
    // The stopped episode is not resumed; the graph escalates again, so the reviewer gets a fresh proposal.
    const plugin = createScriptedGraph({ definition, advances: [supervise({ reason: "needs a decision again" }, "escalate"), ...afterEscalation] });
    const resumed =
      how === "resume"
        ? await controller.resume({ runRef: first.stateDir, plugin, validators, runner: runner(), supervisor, proposalReviewer: reviewer })
        : await controller.continueAfterRestart(first.stateDir, { plugin, validators, runner: runner(), supervisor, proposalReviewer: reviewer });
    expect(resumed.status, resumed.blocker).toBe("succeeded");
    expect(reviewed).toBe(1);
    expect(rejection?.reason).toContain("REFUTED: after restart");
  });

  it("replaces a crashed plugin host for a reviewer probing in the fallback window", async () => {
    let crash = false;
    const crashing = {
      ...validators,
      "exact-greeting": {
        evaluate(input: Parameters<Validator["evaluate"]>[0]): ReturnType<Validator["evaluate"]> {
          if (crash) throw new HostObservationError("crash", "validator gate host error: crash");
          return goodGreeting.evaluate(input);
        },
      },
    };
    let reason: string | undefined;
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: observed(finish.slice(2)),
      validators: crashing,
      // The proposal is only checked after decide() has returned, so the supervisor's turn is over.
      supervisor: createScriptedSupervisor({ sessionId: "supervisor-session", decisions: stopOnOutage }),
      proposalReviewer: {
        sessionId: "reviewer-session",
        async review(request) {
          crash = true;
          const probe = await request.inspect.checkValidate({ stageId: "write" });
          reason = probe.reason;
          return { verdict: "confirm", reason: "ok" };
        },
      },
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-121-fallback-crash",
    });
    expect(report.status, report.blocker).toBe("stopped");
    expect(reason).toContain("the plugin host was replaced");
    expect(reason).not.toContain("turn is over");
  });

  it("leaves no persisted probe from a review that timed out with a probe in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started: () => void = () => undefined;
    const probing = new Promise<void>((resolve) => (started = resolve));
    const slow = {
      ...validators,
      "exact-greeting": {
        async evaluate(input: Parameters<Validator["evaluate"]>[0]) {
          started();
          await gate;
          return goodGreeting.evaluate(input);
        },
      },
    };
    let probe: Promise<unknown> | undefined;
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: observed(finish.slice(2)),
      validators: slow,
      supervisor: createScriptedSupervisor({ sessionId: "supervisor-session", decisions: stopOnOutage }),
      proposalReviewer: {
        sessionId: "reviewer-session",
        timeoutMs: 50,
        review(request) {
          probe = request.inspect.checkValidate({ stageId: "write" }).catch(() => undefined);
          return new Promise(() => undefined);
        },
      },
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-121-timeout-probe",
    });
    // Under load the review can time out before the validator starts; then there is nothing in flight to release.
    await Promise.race([probing, new Promise((resolve) => setTimeout(resolve, 200))]);
    release();
    await probe;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await loadRunState(report.stateDir)).blocker).toContain("no verdict within 50 ms");
    const state = await loadRunState(report.stateDir);
    expect(state.stopReason).toBe("reviewer_unavailable");
    // The probe was reserved, but its result was never recorded after the review ended.
    expect(state.probeLog?.attempts).toBe(1);
    expect(state.probeLog?.ids ?? []).toEqual([]);
  });

  it("never lets the supervisor and the reviewer each spend the last agent invocation", async () => {
    let spent = 0;
    let pending = 0;
    let active = false;
    const inner = createScriptedSupervisor({
      sessionId: "supervisor-session",
      decisions: [
        async (input) => {
          // The prompt's call is only settled once the prompt ends.
          pending = 1;
          await input.admission!.check(stop({ reason: "external outage", blocker: "external" }, "stop"));
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
        spent += n;
        return n;
      },
    };
    let reviewerPending = 0;
    const reviewer: ProposalReviewer = {
      sessionId: "reviewer-session",
      drainProviderCalls() {
        const n = reviewerPending;
        reviewerPending = 0;
        spent += n;
        return n;
      },
      async review(request) {
        reviewerPending = request.maxProviderCalls ?? 0;
        return { verdict: "confirm", reason: "ok" };
      },
    };
    const env = await makeEnv("budgets:\n  agentInvocations: 2\n  recoveryReserve: 1\n");
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [
          // One of the two invocations goes to this job; one is left for the supervisor.
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
      runId: "issue-121-last-invocation",
    });
    expect(spent).toBeLessThanOrEqual(1);
  });

  it("never lets the supervisor and the reviewer spend more than the run budget with two calls outstanding", async () => {
    let spent = 0;
    const grants: number[] = [];
    let pending = 0;
    let active = false;
    const inner = createScriptedSupervisor({
      sessionId: "supervisor-session",
      decisions: [
        async (input) => {
          // The prompt's call is only settled once the prompt ends.
          pending = 2;
          await input.admission!.check(stop({ reason: "external outage", blocker: "external" }, "stop"));
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
        spent += n;
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
        spent += n;
        return n;
      },
      async review(request) {
        reviewerPending = request.maxProviderCalls ?? 0;
        grants.push(request.maxProviderCalls ?? 0);
        return { verdict: "confirm", reason: "ok" };
      },
    };
    const env = await makeEnv("budgets:\n  agentInvocations: 2\n  recoveryReserve: 1\n");
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [
          // One of the two invocations goes to this job; one is left for the supervisor.
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
      runId: "issue-i4-two-outstanding",
    });
    expect(spent).toBeLessThanOrEqual(2);
    expect(grants.every((g) => g === 0)).toBe(true);
  });
});
