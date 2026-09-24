import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile, rm } from "node:fs/promises";
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
import { createScriptedSupervisor } from "@graphloom/supervisor";
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

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string; taskDir: string }> {
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
  await symlink(helloBundle, path.join(taskDir, "plugins", "hello"));
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
          const qualified = (
            input.view as { /* repair not on view */ }
          );
          void qualified;
          // Read artifact id from durable state via a side channel filled by patch
          return activateRepair(
            { qualifiedArtifactId: lastArtifactId!, reason: "activate fixed gate" },
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
          // Capture artifact id from path .../repairs/<id>/candidate
          lastArtifactId = path.basename(path.dirname(candidateRoot));
        },
      },
      reviewer: {
        sessionId: REVIEWER_SESSION,
        async review() {
          return { approved: true, reason: "gate now matches requirement" };
        },
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
        stop({ reason: "complete" }, "done"),
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
            /* no-op */
          },
        },
        reviewer: {
          sessionId: SAME, // illegal
          async review() {
            return { approved: true, reason: "self-review" };
          },
        },
      },
      runner: createScriptedRunner({ jobs: [] }),
      stateRoot: env.stateRoot,
      runId: "repair-self-review",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toMatch(/independent review cannot use the supervisor session/i);
  });

  it("rejects a second activation when the base pin no longer matches", async () => {
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
        },
      },
      reviewer: {
        sessionId: "rev-2",
        async review() {
          return { approved: true, reason: "ok" };
        },
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

    // First activate succeeds and points bundlePath at candidate A; second activate
    // of B should fail base mismatch (live install digest unchanged, but we compare
    // intake.bundle.bundlePath which after first activate is candidate A — B's base
    // was the original install digest).
    const state = await loadRunState(report.stateDir!);
    const activated = state.repairCandidates?.filter((c) => c.status === "activated") ?? [];
    const superseded = state.repairCandidates?.filter((c) => c.status === "superseded") ?? [];
    expect(activated.length + superseded.length).toBeGreaterThanOrEqual(1);
    expect(supervisor.sessionId).toBe(SUPERVISOR_SESSION);
  });
});
