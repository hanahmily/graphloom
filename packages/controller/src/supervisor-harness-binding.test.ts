// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The supervisor binding names its harness (design-supervisor-harnesses.md
 * §4.3): a run recorded before harnesses, whose binding has no `harness`,
 * resumes as Pi through the composition root's restore, and the controller
 * has no Pi restore of its own.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch, observe, returnToNormal, stop, supervise, validate, type GraphDefinition, type RunView, type Validator } from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { bindingHarness, createPiHarness, createPiSupervisor, type HarnessSession, type PiSupervisorSessionPort } from "@graphloom/supervisor";
import { createController, loadRunState } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";

/** The hello bundle's pinned definition (as in pi-supervisor.test.ts). */
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
const plugin = {
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
};

const reviewRunner = () =>
  createScriptedRunner({
    jobs: [
      async () => ({
        status: "ok" as const,
        summary: "approved",
        evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
      }),
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-harness-binding-"));
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

/** A session answering with JSON replies, then failing once they run out. */
function session(replies: string[], id: string): PiSupervisorSessionPort {
  let i = 0;
  return {
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

/** A run stopped in recovery whose recorded binding is rewritten without `harness`, as one recorded before S2. */
async function pausedLegacyRun(runId: string) {
  const env = await makeEnv();
  const controller = createController();
  const paused = await controller.run({
    taskPath: env.taskPath,
    plugin,
    validators,
    supervisor: createPiSupervisor({
      session: session(
        [JSON.stringify(dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write it", writeScope: [GREETING_PATH] }, "repair"))],
        "sess-legacy",
      ),
      requireCitedEvidence: false,
    }),
    runner: createScriptedRunner({
      jobs: [
        async (_job, ctx) => {
          await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
          return { status: "ok", summary: "wrote" };
        },
      ],
    }),
    stateRoot: env.stateRoot,
    runId,
  });
  expect(paused.status).toBe("stopped");
  const file = path.join(paused.stateDir, "state.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as { supervisorBinding?: { harness?: string; sessionId: string } };
  // The binding written now names its harness; drop it to stand in for a pre-harness state file.
  expect(raw.supervisorBinding?.harness).toBe("pi");
  delete raw.supervisorBinding!.harness;
  await writeFile(file, JSON.stringify(raw, null, 2), "utf8");
  return { controller, paused };
}

describe("supervisor binding harness", () => {
  it("resumes a run recorded without binding.harness as a Pi supervisor, and pins pi from then on", async () => {
    const { controller, paused } = await pausedLegacyRun("legacy-pi-1");
    const seen: Array<{ harness: string | undefined; resolved: string; sessionId: string }> = [];
    const resumed = await controller.resume({
      runRef: paused.stateDir,
      runner: reviewRunner(),
      validators,
      plugin,
      restoreSupervisor: async (binding) => {
        seen.push({ harness: binding.harness, resolved: bindingHarness(binding), sessionId: binding.sessionId });
        const replies = [
          JSON.stringify(observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "obs")),
          JSON.stringify(validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "val")),
          JSON.stringify(returnToNormal({ summary: "written" }, "return")),
        ];
        const harness = createPiHarness({
          runId: "legacy-pi-1",
          sessionDir: "/nonexistent",
          sessionOpener: async (): Promise<HarnessSession> => session(replies, "sess-restored"),
        });
        return harness.restore({ ...binding, sessionFile: binding.sessionFile });
      },
    });
    expect(seen).toEqual([{ harness: undefined, resolved: "pi", sessionId: "sess-legacy" }]);
    expect(resumed.status).toBe("succeeded");
    const state = await loadRunState(resumed.stateDir);
    expect(state.supervisorBinding).toMatchObject({ sessionId: "sess-legacy", harness: "pi" });
  });

  it("has no restore of its own: a binding with no restoreSupervisor refuses to resume", async () => {
    const { controller, paused } = await pausedLegacyRun("legacy-pi-2");
    await expect(
      controller.resume({ runRef: paused.stateDir, runner: reviewRunner(), validators, plugin }),
    ).rejects.toThrow(/has a pi supervisor binding \(session sess-legacy\) but no restoreSupervisor was given/);
    // Refused before the run was claimed: it is still stopped, and resumable with a restore.
    expect((await loadRunState(paused.stateDir)).status).toBe("stopped");
  });
});
