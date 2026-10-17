import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateRepair,
  createScriptedGraph,
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
import { createScriptedRunner } from "@graphloom/runner";
import { createPiSupervisor, createScriptedSupervisor, type PiSupervisorSessionPort } from "@graphloom/supervisor";
import { createController, loadRunState, type RepairDeps } from "./index.js";

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

  it("still accepts a probe cited after a resume, and counts every probe started toward the episode's cap", async () => {
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
        // A fresh process: the earlier probe failed to run, so its id cannot be cited ...
        expect(await call(tools, "stop", stopArgs(["probe-1"]))).toMatch(/^Rejected: .*unknown evidence/);
        // ... a probe run now can, and the cap keeps counting from the attempt before the restart.
        probeId = (JSON.parse(await call(tools, "check_validate", { stageId: "write" })) as { probeId: string }).probeId;
        expect(probeId).toBe("probe-2");
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
    expect((await loadRunState(resumed.stateDir)).probeLog).toMatchObject({ ids: ["probe-2"], attempts: 2 });
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

  it("spends an explicit probes budget across a resume, refusing at zero while earlier probes stay citable", async () => {
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

    const second = toolCallingSession("sup-119-budget-2", [
      async (_prompt, tools) => {
        expect(await call(tools, "check_validate", { stageId: "write" })).toBe("Error: probe refused: the run's probes budget is exhausted");
        return call(tools, "stop", stopArgs(["probe-2"]));
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
    expect(resumed.stopEvidenceRefs).toEqual(["probe-2"]);
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
});
