import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  qualifyRepair,
  returnToNormal,
  stop,
  supervise,
  validate,
  type GraphDefinition,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createInProcessPluginHost } from "@graphloom/plugin-host";
import {
  assertAdmittedCandidateRoot,
  createPiSupervisor,
  createScriptedSupervisor,
  type PiSupervisorSessionPort,
  type Supervisor,
} from "@graphloom/supervisor";
import {
  createController,
  loadRunState,
  type RepairDeps,
} from "./index.js";

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

function latest(
  evidence: { kind: string; payload?: unknown }[],
  kind: string,
): unknown {
  for (let i = evidence.length - 1; i >= 0; i--) {
    if (evidence[i]?.kind === kind) return evidence[i]?.payload;
  }
  return undefined;
}

/** Defective Write gate: always fails even with correct greeting. */
const defectiveGreeting: Validator = {
  evaluate() {
    return { status: "failed" as const, reason: "defective gate always fails" };
  },
};

const goodGreeting: Validator = {
  evaluate(input) {
    const file = latest(input.evidence, "file") as { path?: string; bytes?: string } | undefined;
    const manifest = latest(input.evidence, "workspace") as { changedPaths?: string[] } | undefined;
    if (!file || !manifest) return { status: "inconclusive" as const, reason: "missing" };
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
    if (review?.verdict === "approved") {
      return { status: "passed" as const, reason: "approved" };
    }
    return { status: "failed" as const, reason: "not approved" };
  },
};

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

async function makeEnv(
  opts: { grants?: boolean; linkBundle?: boolean } = {},
): Promise<{ taskPath: string; stateRoot: string; taskDir: string }> {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], {
    cwd: repoRoot,
  });
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-repair-e2e-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  if (opts.linkBundle) {
    // A child host must resolve the bundle's dependencies from the repo install.
    await symlink(helloBundle, path.join(taskDir, "plugins", "hello"));
  } else {
    // Copy (do not symlink) so repair snapshots never risk the repo hello tree.
    const { cp } = await import("node:fs/promises");
    await cp(helloBundle, path.join(taskDir, "plugins", "hello"), {
      recursive: true,
      dereference: true,
      filter: (src) => path.basename(src) !== "node_modules",
    });
  }
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(
    taskPath,
    `graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
${
  opts.grants === false
    ? ""
    : `grants:
  sourceRepair: true
  validatorSubstitution: true
`
}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state"), taskDir };
}

describe("qualified repair + same-run activation (#29)", () => {
  it("repairs a defective Write validator via the same supervisor session and activates", async () => {
    const env = await makeEnv();
    const controller = createController();
    const SUPERVISOR_SESSION = "sup-session-run-1";
    const REVIEWER_SESSION = "reviewer-session-independent";
    const codingRoots: string[] = [];
    const patchSessionIds: string[] = [];

    const supervisor = createScriptedSupervisor({
      sessionId: SUPERVISOR_SESSION,
      decisions: [
        // Round 1 after defective validate fails → graph Supervises
        qualifyRepair({ target: "validator", reason: "defective write gate" }, "qualify"),
        (input) => {
          const qualified = input.view.repairCandidates?.find((c) => c.status === "qualified");
          if (!qualified) {
            throw new Error("expected qualified repair candidate on RunView");
          }
          return activateRepair(
            { qualifiedArtifactId: qualified.artifactId, reason: "activate fixed gate" },
            "activate",
          );
        },
        returnToNormal({ summary: "validator repaired" }, "return"),
      ],
    });

    let lastArtifactId: string | undefined;
    const originalGrant = supervisor.grantCandidateCoding!.bind(supervisor);
    supervisor.grantCandidateCoding = async (root) => {
      codingRoots.push(root);
      expect(supervisor.sessionId).toBe(SUPERVISOR_SESSION);
      await originalGrant(root);
    };

    const repair: RepairDeps = {
      patchAuthor: {
        sessionId: SUPERVISOR_SESSION,
        async patch({ candidateRoot }) {
          patchSessionIds.push(SUPERVISOR_SESSION);
          // Mark the candidate as patched; do not touch the live install.
          await writeFile(
            path.join(candidateRoot, "REPAIR_MARKER.txt"),
            "fixed-exact-greeting\n",
            "utf8",
          );
          lastArtifactId = path.basename(path.dirname(candidateRoot));
          void lastArtifactId;
          return { summary: "marked the candidate repaired" };
        },
      },
      reviewer: {
        sessionId: REVIEWER_SESSION,
        async review() {
          return { approved: true, reason: "gate now matches requirement" };
        },
      },
      async preflight() {
        return { ok: true, summary: "scripted preflight ok" };
      },
      materializeValidators: (candidateRoot) => {
        expect(existsSync(path.join(candidateRoot, "REPAIR_MARKER.txt"))).toBe(true);
        expect(existsSync(path.join(helloBundle, "REPAIR_MARKER.txt"))).toBe(false);
        return {
          "exact-greeting": goodGreeting,
          "independent-reviewer": independentReview,
        };
      },
    };

    let writes = 0;
    const plugin = createScriptedGraph({
      definition,
      advances: [
        dispatch(
          {
            stageId: "write",
            kind: "agent",
            purpose: "work",
            instruction: "write greeting",
            writeScope: [GREETING_PATH],
          },
          "write",
        ),
        observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
        validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
        // Defective gate fails → escalate
        supervise({ reason: "write validator defective" }, "escalate"),
        // After Return with fixed validator:
        dispatch(
          {
            stageId: "write",
            kind: "agent",
            purpose: "work",
            instruction: "rewrite after repair",
            writeScope: [GREETING_PATH],
          },
          "rewrite",
        ),
        observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs2"),
        validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write2"),
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
      validators: {
        "exact-greeting": defectiveGreeting,
        "independent-reviewer": independentReview,
      },
      supervisor,
      repair,
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
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
          return { status: "ok" as const, summary: `write-${writes}` };
        }),
      }),
      stateRoot: env.stateRoot,
      runId: "repair1",
    });

    expect(report.status).toBe("succeeded");
    expect(patchSessionIds).toEqual([SUPERVISOR_SESSION]);
    expect(codingRoots.length).toBe(1);
    expect(supervisor.sessionId).toBe(SUPERVISOR_SESSION);

    const state = await loadRunState(report.stateDir);
    expect(state.repairCandidates?.some((c) => c.status === "activated")).toBe(true);
    expect(state.activationIntent?.status).toBe("committed");
    // Live install marker must not exist under the original hello symlink path.
    await expect(
      readFile(path.join(helloBundle, "REPAIR_MARKER.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects independent review authored by the supervisor session", async () => {
    const env = await makeEnv();
    const controller = createController();
    const SAME = "same-session";
    const supervisor = createScriptedSupervisor({
      sessionId: SAME,
      decisions: [
        qualifyRepair({ target: "validator", reason: "try" }, "qualify"),
        stop({ reason: "blocked", blocker: "review" }, "stop"),
      ],
    });

    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [supervise({ reason: "need repair" }, "esc")],
      }),
      validators: {
        "exact-greeting": defectiveGreeting,
        "independent-reviewer": independentReview,
      },
      supervisor,
      repair: {
        patchAuthor: {
          sessionId: SAME,
          async patch() {
            return { summary: "no-op" };
          },
        },
        reviewer: {
          sessionId: SAME, // illegal
          async review() {
            return { approved: true, reason: "self-review" };
          },
        },
        async preflight() {
          return { ok: true, summary: "unused" };
        },
      },
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-self-review",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toMatch(/independent review cannot use the supervisor session/i);
  });

  it("supersedes qualified peers when one candidate activates", async () => {
    const env = await makeEnv();
    // Direct unit-style: snapshot twice, activate first by mutating live digest via second activate path
    // Covered by applyActivateRepair base check — exercise through two qualify then mutate install.
    const controller = createController();
    const SUPERVISOR_SESSION = "sup-2";
    let artifactA: string | undefined;
    let round = 0;

    const supervisor = createScriptedSupervisor({
      sessionId: SUPERVISOR_SESSION,
      decisions: [
        qualifyRepair({ target: "plugin", reason: "first" }, "q1"),
        qualifyRepair({ target: "plugin", reason: "second" }, "q2"),
        (input) => {
          void input;
          const id = round === 0 ? artifactA! : artifactB!;
          round += 1;
          return activateRepair({ qualifiedArtifactId: id, reason: "act" }, "a");
        },
        (input) => {
          void input;
          return activateRepair({ qualifiedArtifactId: artifactB!, reason: "act2" }, "a2");
        },
        stop({ reason: "done", blocker: "check" }, "stop"),
      ],
    });

    let artifactB: string | undefined;
    const repair: RepairDeps = {
      patchAuthor: {
        sessionId: SUPERVISOR_SESSION,
        async patch({ candidateRoot }) {
          const id = path.basename(path.dirname(candidateRoot));
          if (!artifactA) artifactA = id;
          else artifactB = id;
          await writeFile(path.join(candidateRoot, "p.txt"), id, "utf8");
          return { summary: `patched ${id}` };
        },
      },
      reviewer: {
        sessionId: "rev-2",
        async review() {
          return { approved: true, reason: "ok" };
        },
      },
      async preflight() {
        return { ok: true, summary: "ok" };
      },
    };

    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [supervise({ reason: "r" }, "e")],
      }),
      validators: {
        "exact-greeting": goodGreeting,
        "independent-reviewer": independentReview,
      },
      supervisor,
      repair,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-concurrent",
    });

    // Activating A supersedes the qualified peer B, so the second activation
    // finds no qualified artifact and the run stops without switching again.
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("activate_repair missing qualified artifact");
    expect(report.blocker).toBe(artifactB);
    const state = await loadRunState(report.stateDir!);
    const byId = new Map(state.repairCandidates?.map((c) => [c.artifactId, c.status]));
    expect(byId.get(artifactA!)).toBe("activated");
    expect(byId.get(artifactB!)).toBe("superseded");
    expect(state.activeVersion).toBe(`hello@repair-${artifactA}`);
    expect(supervisor.sessionId).toBe(SUPERVISOR_SESSION);
  });

  function approvingRepair(sessionId: string, onPatch?: (root: string) => Promise<void>): RepairDeps {
    return {
      patchAuthor: {
        sessionId,
        async patch({ candidateRoot }) {
          await onPatch?.(candidateRoot);
          await writeFile(path.join(candidateRoot, "p.txt"), "patched\n", "utf8");
          return { summary: "patched" };
        },
      },
      reviewer: {
        sessionId: `${sessionId}-reviewer`,
        async review() {
          return { approved: true, reason: "ok" };
        },
      },
      async preflight() {
        return { ok: true, summary: "ok" };
      },
    };
  }

  function activateFirstQualified() {
    return (input: { view: { repairCandidates?: { artifactId: string; status: string }[] } }) => {
      const qualified = input.view.repairCandidates?.find((c) => c.status === "qualified");
      if (!qualified) throw new Error("no qualified candidate on RunView");
      return activateRepair({ qualifiedArtifactId: qualified.artifactId, reason: "act" }, "act");
    };
  }

  const escalatingPlugin = () =>
    createScriptedGraph({ definition, advances: [supervise({ reason: "r" }, "e")] });
  const goodValidators = {
    "exact-greeting": goodGreeting,
    "independent-reviewer": independentReview,
  };

  it("rejects qualify_repair when the operator grant is not pinned", async () => {
    const env = await makeEnv({ grants: false });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        sessionId: "sup-g",
        decisions: [qualifyRepair({ target: "validator", reason: "try" }, "q")],
      }),
      repair: approvingRepair("sup-g"),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-no-grant",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("qualify_repair missing operator grant");
    expect(report.blocker).toMatch(/validatorSubstitution/);
    const state = await loadRunState(report.stateDir);
    expect(state.repairCandidates ?? []).toHaveLength(0);
  });

  it("spends the correction and rejects the candidate when the patch throws", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        sessionId: "sup-t",
        decisions: [
          qualifyRepair({ target: "plugin", reason: "try" }, "q"),
          stop({ reason: "gave up", blocker: "patch failed" }, "s"),
        ],
      }),
      repair: approvingRepair("sup-t", async () => {
        throw new Error("patch tool crashed");
      }),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-patch-throws",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("gave up");
    const state = await loadRunState(report.stateDir);
    expect(state.repairCandidates).toHaveLength(1);
    expect(state.repairCandidates?.[0]?.status).toBe("rejected");
    expect(state.repairCandidates?.[0]?.rejectionReason).toBe("patch tool crashed");
    expect(state.budgets.corrections).toBe(7);
  });

  it("aborts the repair patch when the operator stops the run", async () => {
    const env = await makeEnv();
    let patching!: () => void;
    const started = new Promise<void>((resolve) => {
      patching = resolve;
    });
    const repair: RepairDeps = {
      ...approvingRepair("sup-stop"),
      patchAuthor: {
        sessionId: "sup-stop",
        patch: ({ signal }) =>
          new Promise((_resolve, reject) => {
            patching();
            signal?.addEventListener("abort", () => reject(new Error("patch aborted")));
          }),
      },
    };
    const running = createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        sessionId: "sup-stop",
        decisions: [qualifyRepair({ target: "plugin", reason: "try" }, "q")],
      }),
      repair,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-stop",
    });
    await started;
    await createController().stop("repair-stop", { stateRoot: env.stateRoot });
    const report = await running;

    expect(report).toMatchObject({ status: "stopped", stopReason: "operator stop" });
    const state = await loadRunState(report.stateDir);
    expect(state.repairCandidates?.[0]).toMatchObject({ status: "rejected", rejectionReason: "patch aborted" });
  });

  it("bounds every patch summary and keeps it when a post-patch step throws", async () => {
    const env = await makeEnv();
    const repair: RepairDeps = {
      ...approvingRepair("sup-sum"),
      patchAuthor: {
        sessionId: "sup-sum",
        async patch() {
          return { summary: `  ${"y".repeat(5000)}  ` };
        },
      },
      async preflight() {
        throw new Error("preflight crashed");
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        sessionId: "sup-sum",
        decisions: [
          qualifyRepair({ target: "plugin", reason: "try" }, "q"),
          stop({ reason: "gave up", blocker: "preflight" }, "s"),
        ],
      }),
      repair,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-summary-bound",
    });
    expect(report.stopReason).toBe("gave up");
    const artifact = (await loadRunState(report.stateDir)).repairCandidates?.[0];
    expect(artifact?.status).toBe("rejected");
    expect(artifact?.rejectionReason).toBe("preflight crashed");
    expect(artifact?.patchSummary).toBe("y".repeat(2000));
  });

  it("refuses the supervisor patch fallback without grant and revoke hooks", async () => {
    const scripted = createScriptedSupervisor({
      sessionId: "sup-h",
      decisions: [qualifyRepair({ target: "plugin", reason: "try" }, "q")],
      patch: async () => ({ summary: "unscoped" }),
    });
    const {
      grantCandidateCoding: _grant,
      revokeCandidateCoding: _revoke,
      ...ungated
    } = scripted;
    void _grant;
    void _revoke;
    const { patchAuthor: _omit, ...noAuthor } = approvingRepair("sup-h");
    void _omit;
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: ungated as Supervisor,
      repair: noAuthor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-ungated",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("qualify_repair requires a patch author");
    expect(report.blocker).toMatch(/grant\/revoke/);
    const state = await loadRunState(report.stateDir);
    expect(state.budgets.corrections).toBe(8);
    expect(state.repairCandidates ?? []).toHaveLength(0);
  });

  it("spends the whole reservation when a supervisor patch hits its turn cap", async () => {
    const env = await makeEnv();
    let pendingTurns = 0;
    let decides = 0;
    const session: PiSupervisorSessionPort = {
      runId: "repair-cap",
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      sessionId: "pi-sup-cap",
      sessionFile: "/tmp/pi-sup-cap.jsonl",
      credentialSource: "options",
      async prompt(text, options) {
        if (text.includes("now authoring the qualified repair")) {
          // Pi aborts the turn past the cap; every allowed turn was a provider call.
          pendingTurns += options?.maxTurns ?? 0;
          throw new Error(`supervisor prompt exceeded its ${options?.maxTurns}-turn allowance`);
        }
        pendingTurns += 1;
        decides += 1;
        return JSON.stringify(
          decides === 1
            ? qualifyRepair({ target: "plugin", reason: "try" }, "q")
            : stop({ reason: "gave up", blocker: "cap" }, "s"),
        );
      },
      drainTurnCount() {
        const n = pendingTurns;
        pendingTurns = 0;
        return n;
      },
      async grantCandidateCoding() {
        /* admitted by the controller */
      },
      async revokeCandidateCoding() {
        /* no-op */
      },
      async setModel() {
        /* no-op */
      },
      async close() {
        /* no-op */
      },
    };
    const { patchAuthor: _omit, ...noAuthor } = approvingRepair("pi-sup-cap");
    void _omit;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createPiSupervisor({ session }),
      repair: noAuthor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-cap",
    });
    const state = await loadRunState(report.stateDir);
    const artifact = state.repairCandidates?.[0];
    expect(artifact?.status).toBe("rejected");
    expect(artifact?.rejectionReason).toBe("supervisor prompt exceeded its 31-turn allowance");
    expect(artifact?.patchSummary).toBeUndefined();
    expect(state.budgets.corrections).toBe(7);
    expect(state.budgets.agentInvocations).toBe(0);
    expect(report.status).toBe("stopped");
  });

  it("rejects activation when the live install changed after qualification", async () => {
    const env = await makeEnv();
    const liveEntry = path.join(env.taskDir, "plugins", "hello", "TAMPER.txt");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        sessionId: "sup-b",
        decisions: [
          qualifyRepair({ target: "plugin", reason: "try" }, "q"),
          async (input) => {
            await writeFile(liveEntry, "tampered\n", "utf8");
            return activateFirstQualified()(input);
          },
        ],
      }),
      repair: approvingRepair("sup-b"),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-base-mismatch",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("activate_repair base mismatch");
    const state = await loadRunState(report.stateDir);
    expect(state.repairCandidates?.[0]?.status).toBe("superseded");
    expect(state.activeVersion).toBe("hello@0.1.0");
    expect(Object.keys(goodValidators)).toEqual(["exact-greeting", "independent-reviewer"]);
  });

  it.each([
    ["stages", { ...definition, stages: [...definition.stages].reverse() }, /alters pinned stages/],
    [
      "requirements",
      {
        ...definition,
        requirements: definition.requirements.map((r) =>
          r.id === "greeting-bytes" ? { ...r, evidenceSchema: "workspace-bytes-v2" } : r,
        ),
      },
      /alters pinned requirements: greeting-bytes evidenceSchema/,
    ],
  ] as const)("rejects activation when the loaded candidate alters the pinned %s", async (_field, altered, reason) => {
    const env = await makeEnv();
    // Qualification loads a compatible candidate; only the activation load differs.
    let loads = 0;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      recreateHost: async (ctx) =>
        createInProcessPluginHost(
          createScriptedGraph({ definition: loads++ === 0 ? definition : altered, advances: [] }),
          { activeVersion: ctx.activeVersion, generation: ctx.generation },
        ),
      supervisor: createScriptedSupervisor({
        sessionId: "sup-c",
        decisions: [
          qualifyRepair({ target: "plugin", reason: "try" }, "q"),
          activateFirstQualified(),
        ],
      }),
      repair: approvingRepair("sup-c"),
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-contract",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("activate_repair candidate rejected");
    expect(report.blocker).toMatch(reason);
    expect(loads).toBe(2);
    const state = await loadRunState(report.stateDir);
    expect(state.activationIntent?.status).toBe("aborted");
    expect(state.repairCandidates?.[0]?.status).toBe("rejected");
    expect(state.activeVersion).toBe("hello@0.1.0");
    expect(state.definition).toEqual(definition);
  });

  it("refuses to resume an activated validator repair it cannot rehydrate", async () => {
    const env = await makeEnv();
    const controller = createController();
    const repair: RepairDeps = {
      ...approvingRepair("sup-r"),
      materializeValidators: () => goodValidators,
    };
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: { ...goodValidators, "exact-greeting": defectiveGreeting },
      supervisor: createScriptedSupervisor({
        sessionId: "sup-r",
        decisions: [
          qualifyRepair({ target: "validator", reason: "defective gate" }, "q"),
          activateFirstQualified(),
          stop({ reason: "pause", blocker: "operator pause" }, "s"),
        ],
      }),
      repair,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-resume",
    });
    expect(first.status).toBe("stopped");
    expect((await loadRunState(first.stateDir)).activationIntent?.status).toBe("committed");

    const { materializeValidators: _drop, ...withoutMaterialize } = repair;
    void _drop;
    const resumed = await controller.resume({
      runRef: first.stateDir,
      plugin: escalatingPlugin(),
      validators: { ...goodValidators, "exact-greeting": defectiveGreeting },
      repair: withoutMaterialize,
      runner: createScriptedRunner({ jobs: [] }),
    });
    expect(resumed.status).toBe("stopped");
    expect(resumed.stopReason).toBe("repair rehydration required");
  });

  it("patches the candidate through the live Pi supervisor session when no patchAuthor is supplied", async () => {
    const env = await makeEnv();
    const runId = "repair-pi";
    const repairsDir = path.join(env.stateRoot, runId, "repairs");
    const prompts: string[] = [];
    const grants: string[] = [];
    let granted: string | undefined;
    let pendingTurns = 0;
    let patchMaxTurns: number | undefined;
    let durableDuringPatch: { agentInvocations: number; status?: string } | undefined;

    const decision = (d: unknown) => JSON.stringify(d);
    const session: PiSupervisorSessionPort = {
      runId,
      provider: "minimax-cn",
      modelId: "MiniMax-M3",
      sessionId: "pi-sup-live",
      sessionFile: "/tmp/pi-sup-live.jsonl",
      credentialSource: "options",
      async prompt(text, options) {
        prompts.push(text);
        if (text.includes("now authoring the qualified repair")) {
          // Stands in for Pi's read/edit/write tool turns on the granted candidate.
          const root = /Candidate root: (.+)/.exec(text)?.[1];
          if (!root || root !== granted) throw new Error("patch prompt outside grant");
          patchMaxTurns = options?.maxTurns;
          const durable = await loadRunState(path.join(env.stateRoot, runId));
          durableDuringPatch = {
            agentInvocations: durable.budgets.agentInvocations,
            ...(durable.repairCandidates?.[0]?.status !== undefined
              ? { status: durable.repairCandidates[0].status }
              : {}),
          };
          await writeFile(path.join(root, "REPAIR_MARKER.txt"), "fixed-exact-greeting\n", "utf8");
          pendingTurns += 3;
          return "Fixed exact-greeting to accept the pinned bytes.";
        }
        pendingTurns += 1;
        if (!text.includes('"repairCandidates": [\n')) {
          return decision(qualifyRepair({ target: "validator", reason: "defective write gate" }, "q"));
        }
        const id = /"artifactId": "(repair-[^"]+)",\s*"status": "qualified"/.exec(text)?.[1];
        if (id) {
          return decision(activateRepair({ qualifiedArtifactId: id, reason: "activate" }, "a"));
        }
        return decision(returnToNormal({ summary: "validator repaired" }, "r"));
      },
      drainTurnCount() {
        const n = pendingTurns;
        pendingTurns = 0;
        return n;
      },
      async grantCandidateCoding(root) {
        granted = await assertAdmittedCandidateRoot(repairsDir, root);
        grants.push(granted);
      },
      async revokeCandidateCoding() {
        granted = undefined;
      },
      async setModel() {
        /* no-op */
      },
      async close() {
        /* no-op */
      },
    };
    const supervisor = createPiSupervisor({ session });

    const repair: RepairDeps = {
      reviewer: {
        sessionId: "reviewer-independent",
        async review() {
          return { approved: true, reason: "gate matches requirement" };
        },
      },
      async preflight({ candidateRoot }) {
        const marker = await readFile(path.join(candidateRoot, "REPAIR_MARKER.txt"), "utf8");
        return { ok: marker === "fixed-exact-greeting\n", summary: "marker present" };
      },
      materializeValidators: () => goodValidators,
    };

    const plugin = createScriptedGraph({
      definition,
      advances: [
        dispatch(
          { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] },
          "write",
        ),
        observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
        validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
        supervise({ reason: "write validator defective" }, "escalate"),
        dispatch(
          { stageId: "write", kind: "agent", purpose: "work", instruction: "rewrite", writeScope: [GREETING_PATH] },
          "rewrite",
        ),
        observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs2"),
        validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write2"),
        dispatch(
          { stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true },
          "review",
        ),
        validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
        stop({ reason: "complete", blocker: "none" }, "done"),
      ],
    });

    const report = await createController().run({
      taskPath: env.taskPath,
      plugin,
      validators: { ...goodValidators, "exact-greeting": defectiveGreeting },
      supervisor,
      repair,
      runner: createScriptedRunner({
        jobs: Array.from({ length: 4 }, () => async (
          job: { purpose?: string; readOnly?: boolean },
          ctx: { worktreePath: string },
        ) => {
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
      }),
      stateRoot: env.stateRoot,
      runId,
    });

    expect(report.status).toBe("succeeded");
    expect(grants).toHaveLength(1);
    expect(granted).toBeUndefined();
    const patchPrompts = prompts.filter((t) => t.includes("now authoring the qualified repair"));
    expect(patchPrompts).toHaveLength(1);

    const state = await loadRunState(report.stateDir);
    const artifact = state.repairCandidates?.[0];
    expect(artifact?.status).toBe("activated");
    expect(artifact?.patchAuthorSessionId).toBe("pi-sup-live");
    expect(artifact?.patchSummary).toBe("Fixed exact-greeting to accept the pinned bytes.");
    expect(existsSync(path.join(artifact!.candidateRoot, "REPAIR_MARKER.txt"))).toBe(true);
    expect(existsSync(path.join(env.taskDir, "plugins", "hello", "REPAIR_MARKER.txt"))).toBe(false);
    // The whole remaining allowance (32 - write job - qualify decide) is reserved
    // durably before the patch runs and becomes its turn cap.
    expect(patchMaxTurns).toBe(30);
    expect(durableDuringPatch).toEqual({ agentInvocations: 0, status: "qualifying" });
    // 3 decide prompts + 3 patch tool turns + 3 agent jobs (write, rewrite, review).
    expect(state.budgets.agentInvocations).toBe(32 - 9);
  });

  it("stops qualify_repair when neither the supervisor nor repair deps can author a patch", async () => {
    const env = await makeEnv();
    const { patchAuthor: _omit, ...noAuthor } = approvingRepair("sup-n");
    void _omit;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: escalatingPlugin(),
      validators: goodValidators,
      supervisor: createScriptedSupervisor({
        sessionId: "sup-n",
        decisions: [qualifyRepair({ target: "plugin", reason: "try" }, "q")],
      }),
      repair: noAuthor,
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-no-author",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("qualify_repair requires a patch author");
    const state = await loadRunState(report.stateDir);
    expect(state.budgets.corrections).toBe(8);
  });

  describe("incompatible candidates (#58)", () => {
    const completingPlugin = () =>
      createScriptedGraph({
        definition,
        advances: [
          supervise({ reason: "r" }, "e"),
          dispatch(
            { stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] },
            "write",
          ),
          observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs"),
          validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val write"),
          dispatch(
            { stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true },
            "review",
          ),
          validate({ stageId: "review", requirementIds: ["independent-review"] }, "val review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      });
    const greetingRunner = () =>
      createScriptedRunner({
        jobs: [
          async (_job, ctx) => {
            await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
            return { status: "ok" as const, summary: "wrote" };
          },
          async () => ({
            status: "ok" as const,
            summary: "approved",
            evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
          }),
        ],
      });
    const countingReviews = (repair: RepairDeps): { repair: RepairDeps; reviews: () => number } => {
      let n = 0;
      return {
        repair: {
          ...repair,
          reviewer: {
            sessionId: repair.reviewer.sessionId,
            async review() {
              n += 1;
              return { approved: true, reason: "ok" };
            },
          },
        },
        reviews: () => n,
      };
    };
    const withRequirement = (patch: Partial<GraphDefinition["requirements"][number]>): GraphDefinition => ({
      ...definition,
      requirements: definition.requirements.map((r) => (r.id === "greeting-bytes" ? { ...r, ...patch } : r)),
    });

    it.each([
      [
        "a requirement statement",
        withRequirement({ statement: "GREETING.txt exists." }),
        /alters pinned requirements: greeting-bytes statement/,
      ],
      [
        "an evidence schema",
        withRequirement({ evidenceSchema: "workspace-bytes-v2" }),
        /alters pinned requirements: greeting-bytes evidenceSchema/,
      ],
      [
        "a default validator binding",
        {
          ...definition,
          defaultValidators: definition.defaultValidators.map((b) =>
            b.requirementId === "greeting-bytes" ? { ...b, version: "2" } : b,
          ),
        },
        /alters pinned defaultValidators: greeting-bytes/,
      ],
    ] as const)(
      "rejects a candidate whose describe() changes %s at qualification and completes on the old version",
      async (_change, altered, reason) => {
        const env = await makeEnv();
        const { repair, reviews } = countingReviews(approvingRepair("sup-58"));
        let seen: { status: string; rejectionReason?: string } | undefined;
        const report = await createController().run({
          taskPath: env.taskPath,
          plugin: completingPlugin(),
          validators: goodValidators,
          recreateHost: async (ctx) =>
            createInProcessPluginHost(createScriptedGraph({ definition: altered, advances: [] }), {
              activeVersion: ctx.activeVersion,
              generation: ctx.generation,
            }),
          supervisor: createScriptedSupervisor({
            sessionId: "sup-58",
            decisions: [
              qualifyRepair({ target: "plugin", reason: "try" }, "q"),
              (input) => {
                seen = input.view.repairCandidates?.[0];
                return returnToNormal({ summary: "keep the pinned graph" }, "r");
              },
            ],
          }),
          repair,
          runner: greetingRunner(),
          stateRoot: env.stateRoot,
          runId: "repair-incompatible",
        });

        expect(seen?.status).toBe("rejected");
        expect(seen?.rejectionReason).toMatch(reason);
        expect(reviews()).toBe(0);
        expect(report.status).toBe("succeeded");
        expect(report.receipts.filter((r) => r.valid).map((r) => r.requirementId)).toEqual([
          "greeting-bytes",
          "independent-review",
        ]);
        const state = await loadRunState(report.stateDir);
        expect(state.activeVersion).toBe("hello@0.1.0");
        expect(state.definition).toEqual(definition);
        expect(state.intake.bundle.bundlePath).toBe(path.join(env.taskDir, "plugins", "hello"));
        expect(state.budgets.corrections).toBe(7);
      },
    );

    it("rejects a candidate whose manifest changes a pinned requirement", async () => {
      const env = await makeEnv();
      const liveManifest = path.join(env.taskDir, "plugins", "hello", "graphloom.manifest.json");
      const before = await readFile(liveManifest, "utf8");
      const { repair, reviews } = countingReviews(
        approvingRepair("sup-58m", async (root) => {
          const manifestPath = path.join(root, "graphloom.manifest.json");
          const raw = await readFile(manifestPath, "utf8");
          await writeFile(manifestPath, raw.replace('"workspace-bytes-v1"', '"workspace-bytes-v2"'), "utf8");
        }),
      );
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: escalatingPlugin(),
        validators: goodValidators,
        supervisor: createScriptedSupervisor({
          sessionId: "sup-58m",
          decisions: [
            qualifyRepair({ target: "plugin", reason: "try" }, "q"),
            stop({ reason: "pause", blocker: "operator review" }, "s"),
          ],
        }),
        repair,
        runner: createScriptedRunner({ jobs: [] }),
        stateRoot: env.stateRoot,
        runId: "repair-manifest",
      });
      const state = await loadRunState(report.stateDir);
      expect(state.repairCandidates?.[0]?.status).toBe("rejected");
      expect(state.repairCandidates?.[0]?.rejectionReason).toMatch(
        /candidate manifest alters pinned requirements: greeting-bytes evidenceSchema/,
      );
      expect(reviews()).toBe(0);
      expect(state.activeVersion).toBe("hello@0.1.0");
      expect(await readFile(liveManifest, "utf8")).toBe(before);
    });

    it("describes a controller-owned candidate bundle in its own child host", async () => {
      const env = await makeEnv({ linkBundle: true });
      const liveGraph = path.join(helloBundle, "dist", "graph.js");
      const before = await readFile(liveGraph, "utf8");
      const { repair, reviews } = countingReviews(
        approvingRepair("sup-58c", async (root) => {
          const graphPath = path.join(root, "dist", "graph.js");
          const raw = await readFile(graphPath, "utf8");
          await writeFile(graphPath, raw.replace('"workspace-bytes-v1"', '"workspace-bytes-v2"'), "utf8");
        }),
      );
      const wrongBytes = async (_job: unknown, ctx: { worktreePath: string }) => {
        await writeFile(path.join(ctx.worktreePath, GREETING_PATH), "wrong\n", "utf8");
        return { status: "ok" as const, summary: "wrote" };
      };
      const report = await createController().run({
        taskPath: env.taskPath,
        supervisor: createScriptedSupervisor({
          sessionId: "sup-58c",
          decisions: [
            qualifyRepair({ target: "plugin", reason: "try" }, "q"),
            stop({ reason: "pause", blocker: "operator review" }, "s"),
          ],
        }),
        repair,
        runner: createScriptedRunner({ jobs: [wrongBytes, wrongBytes, wrongBytes] }),
        stateRoot: env.stateRoot,
        runId: "repair-child",
      });
      const state = await loadRunState(report.stateDir);
      expect(state.repairCandidates?.[0]?.status).toBe("rejected");
      expect(state.repairCandidates?.[0]?.rejectionReason).toMatch(
        /candidate describe\(\) alters pinned requirements: greeting-bytes evidenceSchema/,
      );
      expect(reviews()).toBe(0);
      expect(report.stopReason).toBe("pause");
      expect(state.activeVersion).toBe("hello@0.1.0");
      expect(state.definition.requirements[0]?.evidenceSchema).toBe("workspace-bytes-v1");
      expect(await readFile(liveGraph, "utf8")).toBe(before);
    });
  });
});
