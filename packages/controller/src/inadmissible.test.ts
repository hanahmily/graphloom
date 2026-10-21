import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateRepair,
  createScriptedGraph,
  defineExecutor,
  dispatch,
  observe,
  reenter,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDecision,
  type GraphDefinition,
  type Validator,
} from "@graphloom/sdk";
import { createBuiltinExecutorRunner, createScriptedRunner, createTrustedInProcessRunner } from "@graphloom/runner";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { createPiSupervisor, createScriptedSupervisor, type PiSupervisorSessionPort } from "@graphloom/supervisor";
import { createController, loadRunState, type RepairDeps } from "./index.js";
import { readOwnerClaim } from "./owner.js";

/**
 * #117: an inadmissible supervisor proposal never stops the run by itself.
 * It goes back to the supervisor within the same decide() turn, and after
 * three in one turn the controller applies the trigger's safe default.
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
const defectiveGreeting: Validator = {
  evaluate() {
    return { status: "failed" as const, reason: "defective gate always fails" };
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
const goodValidators = { "exact-greeting": goodGreeting, "independent-reviewer": independentReview };

/** The graph's own work after a Return: write, check, review, finish. */
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

async function makeEnv(taskExtra = ""): Promise<{ taskPath: string; stateRoot: string }> {
  // Rebuilding rewrites dist/ under test files that run in parallel; `npm test` builds it first.
  if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
    await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-inadmissible-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  // Copy (do not symlink) so repair snapshots never touch the repo's hello tree.
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
grants:
  sourceRepair: true
  validatorSubstitution: true
${taskExtra}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

interface Tool {
  name: string;
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[]; terminate?: boolean }>;
}

/**
 * A Pi session stand-in that acts like a tool-calling model: each prompt
 * runs one scripted turn against the tools offered for it.
 */
function toolCallingSession(
  sessionId: string,
  turns: Array<(prompt: string, tools: Tool[]) => Promise<string>>,
): PiSupervisorSessionPort & { prompts: string[]; offered: string[][] } {
  let i = 0;
  const prompts: string[] = [];
  const offered: string[][] = [];
  return {
    runId: "inadmissible",
    provider: "minimax-cn",
    modelId: "MiniMax-M3",
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    credentialSource: "options",
    prompts,
    offered,
    async prompt(text, options) {
      const tools = (options?.tools ?? []) as unknown as Tool[];
      prompts.push(text);
      offered.push(tools.map((t) => t.name));
      const turn = turns[i++];
      if (turn === undefined) throw new Error(`fake model has no turn ${i}`);
      return turn(text, tools);
    },
    async setModel() {
      /* */
    },
    async grantCandidateCoding() {
      /* */
    },
    async revokeCandidateCoding() {
      /* */
    },
    async close() {
      /* */
    },
  };
}

async function call(tools: Tool[], name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`tool ${name} was not offered`);
  return (await tool.execute(`call-${name}`, params)).content[0]!.text;
}

function approvingRepair(sessionId: string): RepairDeps {
  return {
    patchAuthor: {
      sessionId,
      async patch({ candidateRoot }) {
        await writeFile(path.join(candidateRoot, "REPAIR_MARKER.txt"), "fixed\n", "utf8");
        return { summary: "fixed the write gate" };
      },
    },
    reviewer: {
      sessionId: `${sessionId}-reviewer`,
      async review() {
        return { approved: true, reason: "gate now matches requirement" };
      },
    },
    async preflight() {
      return { ok: true, summary: "ok" };
    },
    materializeValidators: () => goodValidators,
  };
}

describe("inadmissible supervisor proposals (#117)", () => {
  it("returns activate_repair for an already-active candidate in-turn; the supervisor returns and the run completes", async () => {
    const env = await makeEnv();
    let artifactId: string | undefined;
    const submitted: string[] = [];
    const session = toolCallingSession("sup-117", [
      // Turn 1: no qualified candidate yet, so activate_repair is not offered.
      async (_prompt, tools) => {
        // Blaming the validator needs a probe that shows it: the write gate refuses a valid greeting.
        const probe = JSON.parse(await call(tools, "check_validate", { stageId: "write" })) as { probeId: string; accepted: boolean };
        expect(probe.accepted).toBe(false);
        submitted.push(
          await call(tools, "qualify_repair", {
            reason: "defective gate",
            qualify: { target: "validator", reason: "write gate always fails" },
            evidence: [probe.probeId],
          }),
        );
        return "";
      },
      // Turn 2: activate the qualified candidate.
      async (prompt, tools) => {
        artifactId = /"artifactId": "(repair-[^"]+)"/.exec(prompt)?.[1];
        submitted.push(await call(tools, "activate_repair", { reason: "activate", activate: { qualifiedArtifactId: artifactId, reason: "fixed gate" } }));
        return "";
      },
      // Turn 3 (the 9bfa446d-4ea mistake): activate the same, now-active, candidate again.
      // With no qualified candidate the tool is not offered, so it replies in JSON.
      async () => JSON.stringify(activateRepair({ qualifiedArtifactId: artifactId!, reason: "activate again" }, "activate again")),
      // Same decide(): the rejection names the current status; the supervisor hands back.
      async (_prompt, tools) => {
        submitted.push(await call(tools, "return", { reason: "repair already active", return: { summary: "the repair is active" } }));
        return "";
      },
    ]);

    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
          supervise({ reason: "write validator defective" }, "escalate"),
          // After Return, with the repaired gate active:
          ...finish,
        ],
      }),
      validators: { "exact-greeting": defectiveGreeting, "independent-reviewer": independentReview },
      supervisor: createPiSupervisor({ session }),
      repair: approvingRepair("sup-117"),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-117",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    expect(artifactId).toMatch(/^repair-/);
    expect(submitted.every((text) => text.startsWith("Submitted"))).toBe(true);
    expect(session.offered[0]).not.toContain("activate_repair");
    expect(session.offered[1]).toContain("activate_repair");
    expect(session.offered[2]).not.toContain("activate_repair");
    expect(session.prompts[2]).toContain("Propose exactly one action by calling one GraphLoom tool: dispatch, observe, validate, reenter, qualify_repair, return, or stop.");
    expect(session.prompts).toHaveLength(4);
    expect(session.prompts[3]).toContain(
      `activate_repair missing qualified artifact: ${artifactId} is \`activated\`, not \`qualified\`; qualified candidates: none; active version is hello@repair-${artifactId}`,
    );
    expect(session.prompts[3]).toContain("2 more inadmissible proposals allowed this turn");
    const state = await loadRunState(report.stateDir);
    expect(state.activeVersion).toBe(`hello@repair-${artifactId}`);
    expect(state.repairCandidates?.map((c) => c.status)).toEqual(["activated"]);
    expect(state.supervisorOutcomes).toBeUndefined();
  });

  it("applies the safe default after three inadmissible proposals in one turn: return, and the graph finishes", async () => {
    const env = await makeEnv();
    const rejections: Array<string | undefined> = [];
    const bad = (decision: GraphDecision) => (input: { rejection?: { reason: string } }) => {
      rejections.push(input.rejection?.reason);
      return decision;
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          bad(validate({ stageId: "nope" }, "validate a stage that is not declared")),
          bad(activateRepair({ qualifiedArtifactId: "repair-missing", reason: "activate" }, "activate")),
          bad(dispatch({ stageId: "invented", kind: "agent", purpose: "diagnostic", instruction: "x", readOnly: true }, "dispatch")),
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "safe-default-return",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    // Each re-ask carries the previous rejection, within the same turn.
    expect(rejections[0]).toBeUndefined();
    expect(rejections[1]).toMatch(/^undeclared stage: stageId nope is not in the pinned graph definition/);
    expect(rejections[2]).toBe("activate_repair requires repair hooks: this controller has no repair hooks configured");
    const inspected = await createController().inspect(report.stateDir);
    expect(inspected.supervisorOutcomes).toMatchObject([
      { outcome: "supervisor_inadmissible", triggerCode: "supervise", applied: "return" },
    ]);
    expect(inspected.supervisorOutcomes[0]!.rejections).toHaveLength(3);
    expect(inspected.supervisorOutcomes[0]!.rejections[2]).toMatch(/^dispatch: undeclared stage: stageId invented/);
  });

  it("records one bounded episode per decide() call with its tool calls, proposal and admission outcome", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          async (input) => {
            await input.inspect!.checkValidate({ stageId: "write" });
            return validate({ stageId: "nope" }, "validate a stage that is not declared");
          },
          returnToNormal({ summary: "done" }, "return"),
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "episode-records",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    const episodes = state.supervisorEpisodes ?? [];
    expect(episodes.map((e) => [e.turn, e.proposal && "action" in e.proposal ? e.proposal.action.type : undefined, e.admission.outcome])).toEqual([
      [1, "validate", "inadmissible"],
      [2, "return", "admitted"],
    ]);
    expect(episodes[0]!.episodeId).toBe(episodes[1]!.episodeId);
    expect(episodes[0]!.toolCalls.map((c) => c.name)).toEqual(["check_validate"]);
    expect(episodes[0]!.admission.rejections[0]).toMatch(/^validate: undeclared stage/);
    expect(episodes[0]!.input.trigger).toMatchObject({ code: "supervise" });
    expect(JSON.stringify(episodes[0]).length).toBeLessThanOrEqual(65_536);
  });

  it("records a failed decide() with its error and tool calls, and stops the run on it", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          async (input) => {
            await input.inspect!.checkValidate({ stageId: "write" });
            throw new Error("provider exploded");
          },
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "episode-error",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("supervisor decide failed");
    const episodes = (await loadRunState(report.stateDir)).supervisorEpisodes ?? [];
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ turn: 1, error: "provider exploded", admission: { outcome: "error", rejections: [] } });
    expect(episodes[0]!.proposal).toBeUndefined();
    expect(episodes[0]!.toolCalls.map((c) => c.name)).toEqual(["check_validate"]);
    expect(episodes[0]!.toolCalls[0]!.pending).toBeUndefined();
  });

  it("settles a decide() cancelled by the operator's stop as aborted, keeps its tool calls and releases the run", async () => {
    const env = await makeEnv();
    const controller = createController();
    const stateDir = path.join(env.stateRoot, "episode-aborted");
    let stopping: Promise<unknown> | undefined;
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          async (input) => {
            await input.inspect!.checkValidate({ stageId: "write" });
            stopping = controller.stop(stateDir);
            await new Promise<void>((resolve) => {
              if (input.signal!.aborted) resolve();
              input.signal!.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("supervisor prompt aborted");
          },
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "episode-aborted",
    });
    await stopping;
    expect(report.status).toBe("stopped");
    const episodes = (await loadRunState(stateDir)).supervisorEpisodes ?? [];
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ error: "supervisor prompt aborted", admission: { outcome: "aborted" } });
    expect(episodes[0]!.toolCalls.map((c) => c.name)).toEqual(["check_validate"]);
    expect(await readOwnerClaim(stateDir)).toBeUndefined();
  });

  it("counts tool-detected rejections (invalid write scope) toward the same allowance and applies the safe default", async () => {
    const env = await makeEnv();
    const replies: string[] = [];
    const session = toolCallingSession("sup-117-scope", [
      // One prompt: the model keeps submitting a work dispatch with no writeScope.
      async (_prompt, tools) => {
        const job = { stageId: "write", kind: "agent", purpose: "work", instruction: "write" };
        for (let i = 0; i < 4; i += 1) replies.push(await call(tools, "dispatch", { reason: "retry", job }));
        return "";
      },
    ]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "safe-default-scope",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    expect(session.prompts).toHaveLength(1);
    expect(replies[0]).toContain("2 more inadmissible proposals allowed this turn");
    expect(replies[2]).toMatch(/last inadmissible proposal allowed this turn/);
    // The turn already ended: a further call is refused as a duplicate, not counted.
    expect(replies[3]).toMatch(/a proposal was already submitted this turn/);
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorOutcomes).toMatchObject([
      { outcome: "supervisor_inadmissible", triggerCode: "supervise", applied: "return" },
    ]);
    expect(state.supervisorOutcomes?.[0]?.rejections).toHaveLength(3);
    expect(state.supervisorOutcomes?.[0]?.rejections[0]).toMatch(/^dispatch: a work job needs a non-empty writeScope/);
  });

  it("rejects in-turn a supervisor dispatch whose input fails the pinned executor's schema, and admits a valid one", async () => {
    // Run 4c70ff66-dd9: the supervisor composed graphloom.coding-agent/run jobs
    // without an assignment; they were admitted and failed inside the executor
    // as executor_failed instead of being refused within the turn.
    const env = await makeEnv("budgets:\n  decisions: 20\n");
    const inputs: unknown[] = [];
    const agentRun = defineExecutor({
      id: "acme.agent/run",
      effect: "write",
      inputSchema: (v): v is { assignment: string } => typeof v === "object" && v !== null && typeof (v as { assignment?: unknown }).assignment === "string",
      async execute(input) {
        inputs.push(input);
        return { status: "ok" as const, summary: "ran" };
      },
    });
    const rejections: Array<string | undefined> = [];
    const work = (input: Record<string, unknown>) =>
      dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH], executor: { id: "acme.agent/run" }, input }, "redo the write");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input: { rejection?: { reason: string } }) => {
            rejections.push(input.rejection?.reason);
            return work({ harness: "claude-code" });
          },
          (input: { rejection?: { reason: string } }) => {
            rejections.push(input.rejection?.reason);
            return work({ assignment: "Write GREETING.txt." });
          },
          returnToNormal({ summary: "the write ran" }, "hand back"),
        ],
      }),
      runner: createTrustedInProcessRunner({ executors: [agentRun], fallback: runner() }),
      stateRoot: env.stateRoot,
      runId: "executor-input-rejected",
    });

    expect(report.status, report.blocker).toBe("succeeded");
    // The second ask, in the same turn, carries the rejection naming the executor and its schema.
    expect(rejections[0]).toBeUndefined();
    expect(rejections[1]).toBe(
      "executor input rejected: executor acme.agent/run: input failed schema validation; the job was not run: compose its input as acme.agent/run requires",
    );
    // Only the valid dispatch reached the executor.
    expect(inputs).toEqual([{ assignment: "Write GREETING.txt." }]);
    const state = await loadRunState(report.stateDir);
    expect(state.evidence.some((e) => JSON.stringify(e.payload).includes("executorFailure"))).toBe(false);
    expect(state.supervisorOutcomes).toBeUndefined();
    // 20 - 1 (the graph's supervise) - 1 (the rejection) - 2 (the admitted dispatch and return) - 6 (finish): the rejection is charged.
    expect(state.budgets.decisions).toBe(10);
  });

  it("charges each rejection to the decisions budget: two rejections and an admitted stop spend three", async () => {
    const env = await makeEnv("budgets:\n  decisions: 10\n");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          validate({ stageId: "nope" }, "undeclared stage"),
          activateRepair({ qualifiedArtifactId: "repair-missing", reason: "activate" }, "activate"),
          stop({ reason: "blocked", blocker: "giving up" }, "stop"),
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "decisions-charged",
    });
    expect(report.stopReason).toBe("blocked");
    // 10 - 1 (the graph's supervise) - 2 (rejections) - 1 (the admitted stop).
    expect((await loadRunState(report.stateDir)).budgets.decisions).toBe(6);
  });

  it("stops on the decisions budget when a rejection spends the last decision, without another re-ask", async () => {
    const env = await makeEnv("budgets:\n  decisions: 2\n");
    let asked = 0;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          () => {
            asked += 1;
            return validate({ stageId: "nope" }, "undeclared stage");
          },
          () => {
            asked += 1;
            return stop({ reason: "blocked", blocker: "should not be asked" }, "stop");
          },
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "decisions-exhausted",
    });
    expect(asked).toBe(1);
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("decisions budget exhausted");
    expect(report.blocker).toMatch(/^supervisor proposal rejected with no decisions left: validate: undeclared stage: stageId nope/);
    const state = await loadRunState(report.stateDir);
    expect(state.budgets.decisions).toBe(0);
    expect(state.supervisorOutcomes).toBeUndefined();
  });

  it("does not ask the supervisor when its turn starts with no decisions left", async () => {
    const env = await makeEnv("budgets:\n  decisions: 1\n");
    let asked = 0;
    const report = await createController().run({
      taskPath: env.taskPath,
      // The graph's supervise spends the only decision.
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          () => {
            asked += 1;
            return stop({ reason: "blocked", blocker: "should not be asked" }, "stop");
          },
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "decisions-zero-supervisor",
    });
    expect(asked).toBe(0);
    expect(report.stopReason).toBe("decisions budget exhausted");
    expect(report.blocker).toBe("supervisor decision for the supervise trigger at stage write");
    expect((await loadRunState(report.stateDir)).budgets.decisions).toBe(0);
  });

  it("does not ask the graph for a decision once the decisions budget is spent", async () => {
    const env = await makeEnv("budgets:\n  decisions: 1\n");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: finish }),
      validators: goodValidators,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "decisions-zero-graph",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("decisions budget exhausted");
    expect(report.blocker).toBe("graph decision at stage write");
    const state = await loadRunState(report.stateDir);
    expect(state.budgets.decisions).toBe(0);
    // Only the first decision (the write dispatch) was applied.
    expect(state.evidence.some((e) => e.kind === "file")).toBe(false);
  });

  it("still stops on a blocking condition: an exhausted corrections budget", async () => {
    const env = await makeEnv("budgets:\n  corrections: 1\n");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          reenter({ stageId: "write", reason: "retry" }, "reenter"),
          reenter({ stageId: "write", reason: "retry again" }, "reenter again"),
        ],
      }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "blocking-budget",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("corrections budget exhausted");
    expect((await loadRunState(report.stateDir)).supervisorOutcomes).toBeUndefined();
  });
});

describe("supervisor evidence and probes", () => {
  it("returns an uncited stop in-turn, then admits it after check_validate shows the stage would validate with state unchanged", async () => {
    const env = await makeEnv();
    const probe = (text: string) => JSON.parse(text) as { probeId: string; accepted: boolean; evaluated: boolean; reason: string; stateRevision: number };
    const replies: string[] = [];
    const probes: Array<ReturnType<typeof probe>> = [];
    const session = toolCallingSession("sup-119", [
      async (_prompt, tools) => {
        // The Fix stage would validate: the supervisor checks it twice, then stops.
        probes.push(probe(await call(tools, "check_validate", { stageId: "write" })));
        probes.push(probe(await call(tools, "check_validate", { stageId: "write" })));
        const stopArgs = { reason: "blocked", stop: { reason: "blocked", blocker: "cannot proceed" } };
        replies.push(await call(tools, "stop", stopArgs));
        replies.push(await call(tools, "stop", { ...stopArgs, evidence: [probes[0]!.probeId] }));
        return "";
      },
    ]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
          supervise({ reason: "unfamiliar" }, "escalate"),
        ],
      }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119",
    });

    // The probe saw what a real validate would do, and changed nothing.
    expect(probes[0]).toMatchObject({ accepted: true, evaluated: true });
    expect(probes[0]!.probeId).not.toBe(probes[1]!.probeId);
    expect(probes[1]!.stateRevision).toBe(probes[0]!.stateRevision);
    expect((await loadRunState(report.stateDir)).receipts).toEqual([]);
    // A stop with no cited evidence came back in-turn; the cited one was admitted.
    expect(replies[0]).toMatch(/^Rejected: .*stop.*evidence/);
    expect(replies[1]).toMatch(/^Submitted/);
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("blocked");
    expect(session.prompts).toHaveLength(1);
  });
  const wroteGreeting = () => [
    dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
    observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
  ];
  const stopArgs = (evidence?: unknown[]) => ({
    reason: "blocked",
    stop: { reason: "blocked", blocker: "none" },
    ...(evidence !== undefined ? { evidence } : {}),
  });

  it("accepts a probe cited on a later turn of the same episode, and keeps what justified the stop", async () => {
    const env = await makeEnv();
    let probeId = "";
    const session = toolCallingSession("sup-119-later", [
      async (_prompt, tools) => {
        probeId = (JSON.parse(await call(tools, "check_validate", { stageId: "write" })) as { probeId: string }).probeId;
        await call(tools, "observe", { reason: "look", observe: { paths: [GREETING_PATH] } });
        return "";
      },
      // The probe ran on the previous turn of this same episode.
      async (_prompt, tools) => call(tools, "stop", stopArgs([probeId])),
    ]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-later",
    });
    expect(session.prompts).toHaveLength(2);
    expect(report.stopReason).toBe("blocked");
    expect((await loadRunState(report.stateDir)).supervisorOutcomes).toBeUndefined();
    // The citation that admitted the stop is what the report shows.
    expect(report.stopEvidenceRefs).toEqual([probeId]);
  });

  // A resume in recovery returns the run to its graph (#128), so recovery after
  // it is a new episode: probes from before the resume ran on evidence the
  // operator's change overtook and are not citable; the new episode's are.
  it("counts every probe started toward the episode's cap, and after a resume accepts only the new episode's probes", async () => {
    const env = await makeEnv();
    let probeId = "";
    const failing: Validator = {
      evaluate() {
        throw new Error("validator crashed");
      },
    };
    const first = toolCallingSession("sup-119-resume-1", [
      async (_prompt, tools) => {
        // A probe whose validator throws is still a probe started.
        expect(await call(tools, "check_validate", { stageId: "write" })).toMatch(/^Error: validator crashed/);
        throw new Error("the model session died");
      },
    ]);
    const plugin = () => createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] });
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: plugin(),
      validators: { ...goodValidators, "exact-greeting": failing },
      supervisor: createPiSupervisor({ session: first }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-resume",
    });
    expect(paused.status).toBe("stopped");
    const saved = await loadRunState(paused.stateDir);
    expect(saved.probeLog).toMatchObject({ ids: [], attempts: 1 });
    expect(saved.mode).toBe("recovery");

    const second = toolCallingSession("sup-119-resume-2", [
      async (_prompt, tools) => {
        // A new episode: nothing probed before the resume can be cited ...
        expect(await call(tools, "stop", stopArgs(["probe-1"]))).toMatch(/^Rejected: .*unknown evidence/);
        // ... a probe run now can, counted against this episode's own cap.
        probeId = (JSON.parse(await call(tools, "check_validate", { stageId: "write" })) as { probeId: string }).probeId;
        expect(probeId).toBe("probe-1");
        return call(tools, "stop", stopArgs([probeId]));
      },
    ]);
    const resumed = await createController().resume({
      runRef: paused.stateDir,
      plugin: plugin(),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session: second }),
      runner: runner(),
    });
    expect(resumed.stopReason).toBe("blocked");
    expect(resumed.stopEvidenceRefs).toEqual([probeId]);
    const after = await loadRunState(resumed.stateDir);
    expect(after.probeLog).toMatchObject({ ids: ["probe-1"], attempts: 1 });
    expect(after.probeLog!.episodeId).not.toBe(saved.probeLog!.episodeId);
  });

  it("returns an uncited reenter, an uncited executor repair, an unresolved citation and a malformed one in-turn", async () => {
    const env = await makeEnv();
    const replies: string[] = [];
    const session = toolCallingSession("sup-119-grounding", [
      async (_prompt, tools) => {
        replies.push(await call(tools, "reenter", { reason: "retry", reenter: { stageId: "write", reason: "retry" } }));
        replies.push(
          await call(tools, "qualify_repair", {
            reason: "executor is wrong",
            qualify: { target: "executor", executorId: "graphloom.agent/run", reason: "it fails" },
          }),
        );
        replies.push(await call(tools, "observe", { reason: "look", observe: { paths: [GREETING_PATH] }, evidence: ["ev-nope"] }));
        return "";
      },
      async (_prompt, tools) => {
        replies.push(await call(tools, "reenter", { reason: "retry", reenter: { stageId: "write", reason: "retry", evidenceRefs: 42 } }));
        replies.push(await call(tools, "stop", stopArgs(["probe-1"])));
        return "";
      },
    ]);
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate"), supervise({ reason: "again" }, "escalate again"), ...finish.slice(-1)],
      }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      repair: approvingRepair("sup-119-grounding"),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-grounding",
    });
    expect(replies[0]).toMatch(/^Rejected: .*reenter requires cited evidence/);
    expect(replies[1]).toMatch(/^Rejected: .*qualify_repair requires cited evidence/);
    expect(replies[2]).toMatch(/^Rejected: .*observe cites unknown evidence: ev-nope/);
    // A malformed citation is a correction, not a failed turn.
    expect(replies[3]).toMatch(/^Rejected: .*reenter cites malformed evidence/);
    expect(replies[4]).toMatch(/^Rejected: .*stop cites unknown evidence: probe-1/);
  });

  it("checks a base checkout's paths against the candidate's real changes, as a checkout would", async () => {
    const env = await makeEnv();
    const probes: Array<{ accepted: boolean; reason: string }> = [];
    const session = toolCallingSession("sup-119-checkout", [
      async (_prompt, tools) => {
        const addsGreeting = `diff --git a/${GREETING_PATH} b/${GREETING_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${GREETING_PATH}\n@@ -0,0 +1 @@\n+Hello, GraphLoom!\n`;
        for (const spec of [
          { from: "base", paths: [GREETING_PATH] },
          { from: "base", paths: ["README.md"] },
          { from: "candidate" },
          // The change this patch undoes is in the candidate, so it applies in reverse ...
          { from: "candidate", revertPatch: addsGreeting },
          // ... one that undoes a change the candidate does not have does not ...
          { from: "candidate", revertPatch: addsGreeting.replace("+Hello, GraphLoom!", "+Goodbye") },
          // ... and a large malformed one, which git may stop reading early, is an answer, not a crash.
          { from: "candidate", revertPatch: "x".repeat(1024 * 1024) },
        ]) {
          probes.push(JSON.parse(await call(tools, "check_checkout", { spec })));
        }
        return call(tools, "stop", stopArgs(["probe-1"]));
      },
    ]);
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-checkout",
    });
    expect(probes[0]).toMatchObject({ accepted: true });
    expect(probes[1]).toMatchObject({ accepted: false });
    expect(probes[1]!.reason).toMatch(/base checkout paths are not part of the workspace change: README\.md/);
    expect(probes[2]).toMatchObject({ accepted: true });
    expect(probes[3]).toMatchObject({ accepted: true });
    expect(probes[4]).toMatchObject({ accepted: false });
    expect(probes[4]!.reason).toMatch(/^revertPatch does not apply in reverse to the candidate/);
    expect(probes[5]).toMatchObject({ accepted: false });
    expect(probes[5]!.reason).toMatch(/^revertPatch could not be read/);
  });

  it("spends an explicit probes budget across a resume, refusing at zero; the probes before the resume are not citable after it", async () => {
    const env = await makeEnv("budgets:\n  probes: 2\n");
    const plugin = () => createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] });
    const first = toolCallingSession("sup-119-budget-1", [
      async (_prompt, tools) => {
        await call(tools, "check_validate", { stageId: "write" });
        await call(tools, "check_validate", { stageId: "write" });
        expect(await call(tools, "check_validate", { stageId: "write" })).toBe("Error: probe refused: the run's probes budget is exhausted");
        throw new Error("the model session died");
      },
    ]);
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: plugin(),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session: first }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-budget",
    });
    const saved = await loadRunState(paused.stateDir);
    expect(saved.budgets.probes).toBe(0);
    expect(saved.budgets.agentInvocations).toBeGreaterThan(0);
    expect(saved.probeLog).toMatchObject({ ids: ["probe-1", "probe-2"], attempts: 2 });

    let evidenceRef = "";
    const second = toolCallingSession("sup-119-budget-2", [
      async (_prompt, tools) => {
        expect(await call(tools, "check_validate", { stageId: "write" })).toBe("Error: probe refused: the run's probes budget is exhausted");
        // The resume opened a new episode: the earlier episode's probe is not current evidence.
        expect(await call(tools, "stop", stopArgs(["probe-2"]))).toMatch(/^Rejected: .*unknown evidence: probe-2/);
        // Recorded evidence of the retried work still grounds the stop.
        const listed = JSON.parse(await call(tools, "list_evidence", {})) as { records: Array<{ ref: string }> };
        evidenceRef = listed.records.at(-1)!.ref;
        return call(tools, "stop", stopArgs([evidenceRef]));
      },
    ]);
    const resumed = await createController().resume({
      runRef: paused.stateDir,
      plugin: plugin(),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session: second }),
      runner: runner(),
    });
    expect(resumed.stopReason).toBe("blocked");
    expect(resumed.stopEvidenceRefs).toEqual([evidenceRef]);
    expect((await loadRunState(resumed.stateDir)).budgets.probes).toBe(0);
  });

  it("probes an activation against the real candidate status: unknown, qualified, then activated", async () => {
    const env = await makeEnv();
    const answers: Array<{ accepted: boolean; reason: string }> = [];
    let artifactId = "";
    const probe = async (tools: Tool[], id: string) => answers.push(JSON.parse(await call(tools, "check_activation", { artifactId: id })));
    const session = toolCallingSession("sup-119-activation", [
      async (_prompt, tools) => {
        const failing = JSON.parse(await call(tools, "check_validate", { stageId: "write" })) as { probeId: string };
        await call(tools, "qualify_repair", {
          reason: "defective gate",
          qualify: { target: "validator", reason: "write gate always fails" },
          evidence: [failing.probeId],
        });
        return "";
      },
      async (prompt, tools) => {
        artifactId = /"artifactId": "(repair-[^"]+)"/.exec(prompt)![1]!;
        await probe(tools, "repair-missing");
        await probe(tools, artifactId);
        await call(tools, "activate_repair", { reason: "activate", activate: { qualifiedArtifactId: artifactId, reason: "fixed gate" } });
        return "";
      },
      async (_prompt, tools) => {
        await probe(tools, artifactId);
        return call(tools, "return", { reason: "repair active", return: { summary: "active" } });
      },
    ]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [...wroteGreeting(), validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"), supervise({ reason: "gate defective" }, "escalate"), ...finish],
      }),
      validators: { "exact-greeting": defectiveGreeting, "independent-reviewer": independentReview },
      supervisor: createPiSupervisor({ session }),
      repair: approvingRepair("sup-119-activation"),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-activation",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(answers[0]).toMatchObject({ accepted: false });
    expect(answers[0]!.reason).toMatch(/^activate_repair missing qualified artifact: no repair candidate repair-missing/);
    expect(answers[1]).toMatchObject({ accepted: true });
    expect(answers[2]).toMatchObject({ accepted: false });
    expect(answers[2]!.reason).toMatch(/is `activated`, not `qualified`/);
  });

  it("keeps every reservation when probes run concurrently, on disk as well as in memory", async () => {
    const env = await makeEnv("budgets:\n  probes: 3\n");
    const session = toolCallingSession("sup-119-concurrent", [
      async (_prompt, tools) => {
        const answers = await Promise.all([1, 2, 3].map(() => call(tools, "check_validate", { stageId: "write" })));
        expect(new Set(answers.map((a) => (JSON.parse(a) as { probeId: string }).probeId)).size).toBe(3);
        throw new Error("the model session died");
      },
    ]);
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-concurrent",
    });
    const saved = await loadRunState(paused.stateDir);
    expect(saved.budgets.probes).toBe(0);
    expect(saved.probeLog?.attempts).toBe(3);
    expect([...(saved.probeLog?.ids ?? [])].sort()).toEqual(["probe-1", "probe-2", "probe-3"]);
  });

  it("hands the independent reviewer the evidence a repair cites at the top level of the proposal", async () => {
    const env = await makeEnv();
    let reviewed: Array<{ ref: string }> = [];
    let cited = "";
    const session = toolCallingSession("sup-119-reviewer", [
      async (_prompt, tools) => {
        const listed = JSON.parse(await call(tools, "list_evidence", {})) as { records: Array<{ ref: string }> };
        cited = listed.records[0]!.ref;
        // Cited in `evidence` only; the repair spec itself names none.
        await call(tools, "qualify_repair", {
          reason: "defective gate",
          qualify: { target: "validator", reason: "write gate always fails" },
          evidence: [cited],
        });
        return "";
      },
      async () => JSON.stringify(returnToNormal({ summary: "done" }, "return")),
    ]);
    const repair = approvingRepair("sup-119-reviewer");
    const reviewer = {
      sessionId: "sup-119-reviewer-independent",
      async review(args: { evidence: Array<{ ref: string }> }) {
        reviewed = args.evidence;
        return { approved: false, reason: "reviewed" };
      },
    };
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [...wroteGreeting(), validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"), supervise({ reason: "gate defective" }, "escalate"), ...finish.slice(-1)],
      }),
      validators: { "exact-greeting": defectiveGreeting, "independent-reviewer": independentReview },
      supervisor: createPiSupervisor({ session }),
      repair: { ...repair, reviewer } as RepairDeps,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-reviewer",
    });
    expect(cited).not.toBe("");
    expect(reviewed.map((e) => e.ref)).toEqual([cited]);
  });

  it("hands the independent reviewer the result of a probe a repair cites as its only evidence", async () => {
    const env = await makeEnv();
    let reviewed: Array<{ ref: string; kind: string; payload?: unknown }> = [];
    let probe: { probeId: string; accepted: boolean; reason: string } | undefined;
    const session = toolCallingSession("sup-119-probe-review", [
      async (_prompt, tools) => {
        probe = JSON.parse(await call(tools, "check_validate", { stageId: "write", requirementIds: ["greeting-bytes"] }));
        // Cited only by probe id: no recorded evidence ref anywhere on the proposal.
        expect(
          await call(tools, "qualify_repair", {
            reason: "defective gate",
            qualify: { target: "validator", reason: "write gate always fails" },
            evidence: [probe!.probeId],
          }),
        ).toMatch(/^Submitted/);
        return "";
      },
      async () => JSON.stringify(returnToNormal({ summary: "done" }, "return")),
    ]);
    const repair = approvingRepair("sup-119-probe-review");
    const reviewer = {
      sessionId: "sup-119-probe-review-independent",
      async review(args: { evidence: Array<{ ref: string; kind: string; payload?: unknown }> }) {
        reviewed = args.evidence;
        return { approved: false, reason: "reviewed" };
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [...wroteGreeting(), validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"), supervise({ reason: "gate defective" }, "escalate"), ...finish.slice(-1)],
      }),
      validators: { "exact-greeting": defectiveGreeting, "independent-reviewer": independentReview },
      supervisor: createPiSupervisor({ session }),
      repair: { ...repair, reviewer } as RepairDeps,
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-probe-review",
    });
    expect(probe).toMatchObject({ accepted: false });
    // The reviewer got the probe's own result, not an empty evidence list.
    expect(reviewed).toEqual([
      {
        ref: probe!.probeId,
        kind: "other",
        payload: { probe: expect.objectContaining({ check: "check_validate", accepted: false, reason: probe!.reason }) },
      },
    ]);
    // The result is kept durably with the probe log.
    const state = await loadRunState(report.stateDir);
    expect(state.probeLog?.results?.[probe!.probeId]).toMatchObject({ check: "check_validate", accepted: false });
  });

  it("keeps probe reservations when a finding and a rejection are saved at the same time", async () => {
    const env = await makeEnv("budgets:\n  probes: 3\n");
    const session = toolCallingSession("sup-119-writers", [
      async (_prompt, tools) => {
        await Promise.all([
          call(tools, "check_validate", { stageId: "write" }),
          call(tools, "record_finding", { kind: "open", text: "is the gate right?" }),
          call(tools, "validate", { reason: "undeclared", validate: { stageId: "nope" } }),
          call(tools, "check_validate", { stageId: "write" }),
          call(tools, "check_validate", { stageId: "write" }),
        ]);
        throw new Error("the model session died");
      },
    ]);
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: runner(),
      stateRoot: env.stateRoot,
      runId: "issue-119-writers",
    });
    const saved = await loadRunState(paused.stateDir);
    expect(saved.budgets.probes).toBe(0);
    expect(saved.probeLog?.attempts).toBe(3);
    expect(saved.probeLog?.ids).toHaveLength(3);
    expect(saved.caseFile?.open.map((q) => q.text)).toEqual(["is the gate right?"]);
    // The rejection was charged too, as one decision beyond the graph's own.
    expect(saved.budgets.decisions).toBeLessThan(512 - 1);
  });

  it("charges an executor-input refusal and an uncited stop the same way in one turn, and never counts a probe as a provider call", async () => {
    const env = await makeEnv("budgets:\n  decisions: 20\n  agentInvocations: 10\n  probes: 5\n");
    const agentRun = defineExecutor({
      id: "acme.agent/run",
      effect: "write",
      inputSchema: (v): v is { assignment: string } => typeof v === "object" && v !== null && typeof (v as { assignment?: unknown }).assignment === "string",
      async execute() {
        return { status: "ok" as const, summary: "ran" };
      },
    });
    const replies: string[] = [];
    let modelTurns = 0;
    const base = toolCallingSession("sup-119-compose", [
      async (_prompt, tools) => {
        // Three model requests in this prompt, whatever the tools do between them.
        modelTurns = 3;
        replies.push(
          await call(tools, "dispatch", {
            reason: "redo",
            job: { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH], executor: { id: "acme.agent/run" }, input: { harness: "x" } },
          }),
        );
        replies.push(await call(tools, "stop", stopArgs()));
        const probe = JSON.parse(await call(tools, "check_validate", { stageId: "write" })) as { probeId: string };
        await call(tools, "check_validate", { stageId: "write" });
        replies.push(await call(tools, "stop", stopArgs([probe.probeId])));
        return "";
      },
    ]);
    const session = {
      ...base,
      drainTurnCount() {
        const n = modelTurns;
        modelTurns = 0;
        return n;
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...wroteGreeting(), supervise({ reason: "unfamiliar" }, "escalate")] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: createTrustedInProcessRunner({ executors: [agentRun], fallback: runner() }),
      stateRoot: env.stateRoot,
      runId: "issue-119-compose",
    });
    expect(replies[0]).toMatch(/^Rejected: .*executor input rejected: executor acme\.agent\/run/);
    expect(replies[1]).toMatch(/^Rejected: .*stop requires cited evidence/);
    expect(replies[2]).toMatch(/^Submitted/);
    expect(report.stopReason).toBe("blocked");
    const state = await loadRunState(report.stateDir);
    // Both refusals were charged to the decisions budget, like the admitted stop:
    // 20 - 3 (the graph's write, observe and supervise) - 2 (the refusals) - 1 (the stop).
    expect(state.budgets.decisions).toBe(14);
    // The probes spent their own budget, not the provider allowance: 10 - 1 (the
    // graph's agent write) - 3 (the supervisor's model requests).
    expect(state.budgets.probes).toBe(3);
    expect(state.budgets.agentInvocations).toBe(6);
  });
});

describe("executor input shape (#152)", () => {
  // Run 0011bbe9-01b: the supervisor's command-job input was refused three times with
  // only "input failed schema validation". These are its three proposals.
  const BAD_INPUTS: Array<[string, Record<string, unknown>]> = [
    ["command with argv.item", { command: { id: "go-env", argv: { item: ["go", "env"] } } }],
    ["top-level argv.item", { argv: { item: ["go", "env"] } }],
    ["nested item.item", { command: { argv: { item: { item: ["go", "env"] } } } }],
  ];
  const GOOD_INPUT = { commands: [{ id: "go-env", argv: ["true"] }] };
  const commandJob = (input: Record<string, unknown>) => ({
    stageId: "write",
    kind: "command" as const,
    purpose: "diagnostic" as const,
    instruction: "show the go environment",
    readOnly: true,
    executor: { id: "graphloom.command/run" },
    input,
  });
  const commandRunner = () =>
    createBuiltinExecutorRunner({ packages: [{ manifest: commandExecutorPackage, ...commandBinding() }], fallback: runner() });

  it.each(BAD_INPUTS)("refuses %s naming the failing field and the declared shape, then admits the documented shape", async (_name, bad) => {
    const env = await makeEnv("budgets:\n  decisions: 20\n");
    const rejections: Array<string | undefined> = [];
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        decisions: [
          (input: { rejection?: { reason: string } }) => {
            rejections.push(input.rejection?.reason);
            return dispatch(commandJob(bad), "show env");
          },
          (input: { rejection?: { reason: string } }) => {
            rejections.push(input.rejection?.reason);
            return dispatch(commandJob(GOOD_INPUT), "show env");
          },
          returnToNormal({ summary: "checked" }, "hand back"),
        ],
      }),
      runner: commandRunner(),
      stateRoot: env.stateRoot,
      runId: "executor-input-shape",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    const refusal = rejections[1]!;
    expect(refusal).toMatch(/^executor input rejected: executor graphloom\.command\/run: input failed schema validation: commands: required/);
    // The failing field, and the shape and example the executor declares.
    expect(refusal).toContain("Declared input shape: ");
    expect(refusal).toContain('"required":["id","argv"]');
    expect(refusal).toContain('{"commands":[{"id":"go-env","argv":["go","env","GOCACHE"]}]}');
    expect(refusal.length).toBeLessThan(3_000);
    // The documented shape was admitted and ran.
    const state = await loadRunState(report.stateDir);
    const ran = state.evidence.find((e) => e.kind === "command" && JSON.stringify(e.payload).includes('"go-env"'));
    expect(ran).toBeDefined();
  });

  it("names the failing path inside an otherwise well-formed command", async () => {
    const refused = await commandRunner().checkJob!(commandJob({ commands: [{ id: "go-env", argv: "go env" }] }) as never);
    expect(refused).toBe(
      'executor graphloom.command/run: input failed schema validation: commands[0].argv: must be an array of strings, e.g. ["go","env"] (got string)',
    );
  });

  it("shows the supervisor each executor's declared input shape before it proposes, and lets it correct a refusal in the same turn", async () => {
    const env = await makeEnv("budgets:\n  decisions: 20\n");
    const replies: string[] = [];
    const session = toolCallingSession("sup-152-shape", [
      async (_prompt, tools) => {
        // The model's real mistake: the array wrapped as {item: [...]}.
        replies.push(await call(tools, "dispatch", { reason: "show env", job: commandJob({ argv: { item: ["go", "env"] } }) }));
        // Corrected from the declared shape the refusal carried.
        replies.push(await call(tools, "dispatch", { reason: "show env", job: commandJob(GOOD_INPUT) }));
        return "";
      },
      async () => JSON.stringify(returnToNormal({ summary: "checked" }, "return")),
    ]);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      runner: commandRunner(),
      stateRoot: env.stateRoot,
      runId: "executor-input-shape-pi",
    });
    expect(report.status, report.blocker).toBe("succeeded");
    // Before proposing, the prompt already listed the command executor's schema and example.
    const prompt = session.prompts[0]!;
    expect(prompt).toContain('"executors"');
    expect(prompt).toContain("graphloom.command/run");
    expect(prompt).toContain('"go-env"');
    expect(replies[0]).toMatch(/^Rejected: .*commands: required, .*\(got only: argv\).*Declared input shape: /s);
    expect(replies[1]).toMatch(/^Submitted/);
    const state = await loadRunState(report.stateDir);
    expect(state.supervisorOutcomes).toBeUndefined();
    expect(state.evidence.some((e) => e.kind === "command" && JSON.stringify(e.payload).includes('"go-env"'))).toBe(true);
  });
});

describe("supervisor jobs stay inside the run's scope (#165)", () => {
  // Run 0011bbe9-01b: the supervisor proposed `rm -rf` on a user cache and `go env -w` on the
  // operator's Go configuration. A job the supervisor originates may write only the run's
  // worktree and run-scoped directories, unless the operator granted `hostRepair`.
  const writeFileJob = (file: string, text: string) => ({
    stageId: "write",
    kind: "command" as const,
    purpose: "work" as const,
    instruction: "write a file",
    writeScope: ["inside.txt"],
    executor: { id: "graphloom.command/run" },
    // Plain node, so the static pre-check cannot see the path: only the confinement stops it.
    input: { commands: [{ id: "write", argv: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)})`] }] },
  });
  // Writes inside the worktree, prints what it wrote, and leaves nothing behind for the graph's own checks.
  const insideJob = () => ({
    ...writeFileJob("unused", ""),
    input: {
      commands: [
        { id: "inside", argv: ["sh", "-c", 'echo inside > inside.txt && cat inside.txt && rm inside.txt && echo "$TMPDIR" && echo scratch > "$TMPDIR/t.txt"'] },
      ],
    },
  });
  const commandRunner = () =>
    createBuiltinExecutorRunner({ packages: [{ manifest: commandExecutorPackage, ...commandBinding() }], fallback: runner() });
  const hostDir = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-host-"));
    temps.push(dir);
    return dir;
  };
  const supervised = async (taskExtra: string, jobs: unknown[], runId: string) => {
    const env = await makeEnv(`${taskExtra}budgets:\n  decisions: 20\n`);
    const rejections: Array<string | undefined> = [];
    const decisions = jobs.map((job) => (input: { rejection?: { reason: string } }) => {
      rejections.push(input.rejection?.reason);
      return dispatch(job as never, "supervisor job");
    });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [supervise({ reason: "unfamiliar" }, "escalate"), ...finish] }),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({ decisions: [...decisions, returnToNormal({ summary: "checked" }, "hand back")] }),
      runner: commandRunner(),
      stateRoot: env.stateRoot,
      runId,
    });
    return { report, rejections, state: await loadRunState(report.stateDir) };
  };
  const outcomeOf = (state: Awaited<ReturnType<typeof loadRunState>>) =>
    state.evidence.flatMap((e) => (e.kind === "command" ? [(e.payload as { command: { exitCode: number | null; stdoutTail: string } }).command] : []));

  it("refuses a supervisor command that visibly changes the host in-turn, naming the blocker route, and leaves the target alone", async () => {
    const host = await hostDir();
    const victim = path.join(host, "cache");
    await mkdir(victim);
    const rm = { ...writeFileJob(victim, ""), input: { commands: [{ id: "rm", argv: ["rm", "-rf", victim] }] } };
    const { report, rejections, state } = await supervised("", [rm, insideJob()], "host-scope-refused");
    expect(report.status, report.blocker).toBe("succeeded");
    expect(rejections[1]).toMatch(/^host change needs the operator: .*`rm` changes .*outside the run's worktree and run-scoped directories; the job was not run/);
    expect(rejections[1]).toContain("Report this as a blocker");
    expect(existsSync(victim)).toBe(true);
    expect(state.hostChanges).toBeUndefined();
  });

  it("confines a supervisor command that writes outside the worktree: it fails and the target is unchanged", async () => {
    const host = await hostDir();
    const target = path.join(host, "escaped.txt");
    const { report, state } = await supervised("", [writeFileJob(target, "escaped")], "host-scope-enforced");
    expect(report.status, report.blocker).toBe("succeeded");
    expect(existsSync(target)).toBe(false);
    expect(outcomeOf(state)[0]?.exitCode).not.toBe(0);
  });

  it("lets a supervisor command write inside the worktree", async () => {
    const { report, state } = await supervised("", [insideJob()], "host-scope-inside");
    expect(report.status, report.blocker).toBe("succeeded");
    const [outcome] = outcomeOf(state);
    expect(outcome?.exitCode).toBe(0);
    expect(outcome?.stdoutTail).toContain("inside\n");
    // The run-scoped temp dir is writable too.
    const scratchTmp = outcome!.stdoutTail.split("\n")[1]!;
    expect(scratchTmp.startsWith(path.join(report.stateDir, "scratch"))).toBe(true);
    expect(await readFile(path.join(scratchTmp, "t.txt"), "utf8")).toBe("scratch\n");
    expect(state.hostChanges).toBeUndefined();
  });

  it("redirects a supervisor command's user-level state into the run, so a write to GOENV cannot touch the operator's go env file", async () => {
    const host = await hostDir();
    const operatorGoEnv = path.join(host, "go-env");
    await writeFile(operatorGoEnv, "GOPROXY=https://operator.example\n", "utf8");
    const previous = process.env.GOENV;
    process.env.GOENV = operatorGoEnv;
    try {
      const probe = {
        ...writeFileJob("unused", ""),
        input: {
          commands: [
            {
              id: "env",
              argv: [
                "sh",
                "-c",
                // What `go env -w` does: append to the file GOENV names. Also record where state points.
                'echo GOFLAGS=-x >> "$GOENV"; echo "$GOENV|$GOCACHE|$GOTMPDIR|$TMPDIR|$npm_config_cache|$XDG_CONFIG_HOME"',
              ],
            },
          ],
        },
      };
      const { report, state } = await supervised("", [probe], "host-scope-goenv");
      expect(report.status, report.blocker).toBe("succeeded");
      expect(await readFile(operatorGoEnv, "utf8")).toBe("GOPROXY=https://operator.example\n");
      const scratch = path.join(report.stateDir, "scratch");
      const [goenv, ...others] = outcomeOf(state)[0]!.stdoutTail.trim().split("|");
      for (const value of [goenv, ...others]) expect(value!.startsWith(`${scratch}${path.sep}`), value).toBe(true);
      // The operator's setting carried over once; the write landed in the run.
      const scoped = await readFile(goenv!, "utf8");
      expect(scoped).toContain("GOPROXY=https://operator.example");
      expect(scoped).toContain("GOFLAGS=-x");
    } finally {
      if (previous === undefined) delete process.env.GOENV;
      else process.env.GOENV = previous;
    }
  });

  it("refuses `go env -w` from a supervisor job in-turn and leaves the operator's go env file untouched", async () => {
    const host = await hostDir();
    const operatorGoEnv = path.join(host, "go-env");
    await writeFile(operatorGoEnv, "GOPROXY=https://operator.example\n", "utf8");
    const previous = process.env.GOENV;
    process.env.GOENV = operatorGoEnv;
    try {
      const goEnvW = { ...writeFileJob("unused", ""), input: { commands: [{ id: "go-env", argv: ["go", "env", "-w", "GOCACHE=/mnt/d/graphloom-go/cache"] }] } };
      const { rejections, state } = await supervised("", [goEnvW, insideJob()], "host-scope-go-env-w");
      expect(rejections[1]).toMatch(/^host change needs the operator: .*rewrites the operator's global Go configuration/);
      expect(await readFile(operatorGoEnv, "utf8")).toBe("GOPROXY=https://operator.example\n");
      expect(state.hostChanges).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GOENV;
      else process.env.GOENV = previous;
    }
  });

  it("admits a host-changing job when the operator granted hostRepair, runs it unconfined, and records it", async () => {
    const host = await hostDir();
    const target = path.join(host, "changed-under-grant.txt");
    const { report, state } = await supervised("  hostRepair: true\n", [writeFileJob(target, "granted")], "host-scope-granted");
    expect(report.status, report.blocker).toBe("succeeded");
    expect(await readFile(target, "utf8")).toBe("granted");
    expect(state.intake.grants.hostRepair).toBe(true);
    expect(state.hostChanges).toHaveLength(1);
    expect(state.hostChanges?.[0]).toMatchObject({ stageId: "write", executorId: "graphloom.command/run" });
    expect(state.evidence.some((e) => e.kind === "other" && JSON.stringify(e.payload).includes('"hostChange"'))).toBe(true);
    const inspected = await createController().inspect(report.stateDir);
    expect(inspected.hostChanges).toHaveLength(1);
  });
});
