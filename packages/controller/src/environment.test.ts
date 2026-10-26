// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
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
  validate,
  type EnvironmentDeclaration,
  type EvidenceRecord,
  type GraphDefinition,
  type JobSpec,
  type ScriptedAdvance,
  type Validator,
} from "@graphloom/sdk";
import type { JobContext, JobResult, Runner } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController } from "./index.js";
import { loadRunState } from "./state.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");

const BASE_README = "repo\n";
const CHECK = "test -f generated.txt && test -f probe.test && grep -q fixed README.md";

function definitionWith(environment?: EnvironmentDeclaration): GraphDefinition {
  return {
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
    ...(environment !== undefined ? { environment } : {}),
  };
}

interface CommandPayload {
  command: { id: string; exitCode: number | null; stdoutTail: string; spawnError?: string };
  checkout?: { from: string; commit: string; paths: string[]; prepared: boolean; mutations: string[]; phase: string };
}

function commandRuns(evidence: EvidenceRecord[], id: string): Array<EvidenceRecord & { payload: CommandPayload }> {
  return evidence.filter(
    (e): e is EvidenceRecord & { payload: CommandPayload } =>
      e.kind === "command" && (e.payload as CommandPayload | undefined)?.command?.id === id,
  );
}

/** Passes when the new test fails on the base and passes on the whole change, both for the live change. */
const reproducesAndPasses: Validator = {
  evaluate(input) {
    const red = commandRuns(input.evidence, "red").at(-1);
    const green = commandRuns(input.evidence, "green").at(-1);
    if (red === undefined || green === undefined) return { status: "inconclusive", reason: "missing checks" };
    for (const run of [red, green]) {
      if (run.candidateDigest !== input.candidateDigest) return { status: "failed", reason: `${run.payload.command.id} ran on another candidate` };
      if (run.payload.checkout?.prepared !== true) return { status: "failed", reason: "checkout was not prepared" };
      if (run.payload.checkout.mutations.length > 0) return { status: "failed", reason: `check changed ${run.payload.checkout.mutations.join(", ")}` };
    }
    if (red.payload.checkout?.from !== "base" || red.payload.command.exitCode === 0) return { status: "failed", reason: "does not reproduce" };
    if (green.payload.checkout?.from !== "candidate" || green.payload.command.exitCode !== 0) return { status: "failed", reason: "does not pass" };
    return { status: "passed", reason: "reproduces and passes" };
  },
};

const approved: Validator = {
  evaluate(input) {
    const review = input.evidence.filter((e) => e.kind === "review").at(-1)?.payload as { verdict?: string } | undefined;
    return review?.verdict === "approved" ? { status: "passed", reason: "approved" } : { status: "inconclusive", reason: "no approval" };
  },
};

const validators = { "exact-greeting": reproducesAndPasses, "independent-reviewer": approved };

/**
 * Runs command jobs for real (argv in the job's worktree, one result per
 * command, stopping at the first failure) and hands agent jobs to `agent`.
 */
function testRunner(agent: (job: JobSpec, ctx: JobContext) => Promise<Pick<JobResult, "status" | "summary" | "evidence">>): Runner & { commandJobs: Array<{ job: JobSpec; cwd: string }> } {
  const commandJobs: Array<{ job: JobSpec; cwd: string }> = [];
  return {
    commandJobs,
    async runJob(job, ctx) {
      const identity = { runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation };
      if (job.kind !== "command") return { ...(await agent(job, ctx)), ...identity };
      commandJobs.push({ job, cwd: ctx.worktreePath });
      const evidence: JobResult["evidence"] = [];
      for (const c of (job.input as { commands: Array<{ id: string; argv: string[] }> }).commands) {
        const outcome = await runArgv(c.argv, ctx.worktreePath);
        evidence.push({ kind: "command", payload: { command: { id: c.id, argv: c.argv, ...outcome } } });
        if (outcome.exitCode !== 0) break;
      }
      return { status: "ok", summary: "ran", evidence, ...identity };
    },
  };
}

function runArgv(argv: string[], cwd: string): Promise<{ exitCode: number | null; stdoutTail: string; stderrTail: string; spawnError?: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ exitCode: null, stdoutTail: stdout, stderrTail: stderr, spawnError: err.message }));
    child.on("close", (code) => resolve({ exitCode: code, stdoutTail: stdout, stderrTail: stderr }));
  });
}

const fixAndAddTest = async (_job: JobSpec, ctx: JobContext) => {
  await writeFile(path.join(ctx.worktreePath, "README.md"), "fixed\n", "utf8");
  await writeFile(path.join(ctx.worktreePath, "probe.test"), "probe\n", "utf8");
  return { status: "ok" as const, summary: "fixed" };
};

const review = async () => ({
  status: "ok" as const,
  summary: "approved",
  evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }],
});

const work = dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "fix", writeScope: ["."] }, "implement");
const red = dispatch(
  {
    stageId: "write",
    kind: "command",
    purpose: "check",
    instruction: "red",
    readOnly: true,
    checkout: { from: "base", paths: ["probe.test"] },
    input: { commands: [{ id: "red", argv: ["sh", "-c", CHECK] }] },
  },
  "reproduce on the base",
);
const green = dispatch(
  {
    stageId: "write",
    kind: "command",
    purpose: "check",
    instruction: "green",
    readOnly: true,
    checkout: { from: "candidate" },
    input: {
      commands: [
        { id: "green", argv: ["sh", "-c", CHECK] },
        { id: "clean", argv: ["sh", "-c", "test -z \"$(git status --porcelain)\" && git log -1 --format=%an"] },
      ],
    },
  },
  "pass on the candidate",
);
const reviewJob = dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review");

const PREPARE: EnvironmentDeclaration = {
  checks: [{ id: "sh", argv: ["sh", "-c", "true"] }],
  prepare: [{ id: "generate", argv: ["sh", "-c", "echo generated > generated.txt"] }],
};

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await execFileAsync("git", ["worktree", "prune"], { cwd: dir }).catch(() => undefined);
  }
});

describe("graph-declared environment and disposable checkouts", () => {
  it("prepares fresh checkouts, reproduces on the base, passes on the candidate, and binds receipts to the change", async () => {
    const env = await makeEnv();
    let worktree = "";
    const runner = testRunner(async (job, ctx) => {
      worktree = ctx.worktreePath;
      return job.purpose === "review" ? review() : fixAndAddTest(job, ctx);
    });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith(PREPARE),
        advances: [
          work,
          red,
          green,
          validate({ stageId: "write" }, "accept the fix"),
          reviewJob,
          validate({ stageId: "review" }, "accept the review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "checkouts",
    });

    expect(report.status).toBe("succeeded");
    const state = await loadRunState(report.stateDir);

    // The preflight ran the checks and preparation in the worktree; each checkout
    // checked and prepared again, then ran its commands one at a time.
    const ids = (job: JobSpec) => (job.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    const [preflight, redPrep, redRun, greenPrep, greenRun, cleanRun] = runner.commandJobs;
    expect(preflight!.cwd).toBe(worktree);
    expect(ids(preflight!.job)).toEqual(["sh", "generate"]);
    expect(redPrep!.cwd).not.toBe(worktree);
    expect(ids(redPrep!.job)).toEqual(["sh", "generate"]);
    expect(redRun!.cwd).toBe(redPrep!.cwd);
    expect(ids(greenRun!.job)).toEqual(["green"]);
    expect(ids(cleanRun!.job)).toEqual(["clean"]);
    expect(greenRun!.cwd).toBe(greenPrep!.cwd);
    expect(cleanRun!.cwd).toBe(greenPrep!.cwd);
    expect(greenRun!.cwd).not.toBe(redRun!.cwd);

    const redEvidence = commandRuns(state.evidence, "red").at(-1)!;
    expect(redEvidence.payload.command.exitCode).not.toBe(0);
    expect(redEvidence.payload.checkout).toMatchObject({ from: "base", paths: ["probe.test"], prepared: true, mutations: [], phase: "run" });
    const clean = commandRuns(state.evidence, "clean").at(-1)!;
    expect(clean.payload.command.exitCode).toBe(0);
    expect(clean.payload.command.stdoutTail.trim()).toBe("GraphLoom");
    expect(commandRuns(state.evidence, "generate").filter((e) => (e.payload.checkout?.phase ?? "") === "prepare")).toHaveLength(2);

    const digests = new Set(state.receipts.filter((r) => r.valid).map((r) => r.candidateDigest));
    expect(digests.size).toBe(1);
    expect([...digests][0]).toBe(redEvidence.candidateDigest);
    await expect(readdir(path.join(report.stateDir, "checkouts"))).resolves.toEqual([]);
  });

  it("records files a check changed in its checkout, without touching the worktree", async () => {
    const env = await makeEnv();
    const runner = testRunner(fixAndAddTest);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith(),
        advances: [
          work,
          dispatch(
            {
              stageId: "write",
              kind: "command",
              purpose: "check",
              instruction: "format",
              readOnly: true,
              checkout: { from: "candidate" },
              input: { commands: [{ id: "fmt", argv: ["sh", "-c", "echo reformatted > README.md"] }] },
            },
            "run the formatter check",
          ),
          stop({ reason: "paused", blocker: "inspect" }, "pause"),
        ],
      }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "mutation",
    });

    expect(report.stopReason).toBe("paused");
    const state = await loadRunState(report.stateDir);
    const fmt = commandRuns(state.evidence, "fmt").at(-1)!;
    expect(fmt.payload.checkout).toMatchObject({ from: "candidate", prepared: true, mutations: ["README.md"] });
    await expect(readFile(path.join(state.worktreePath, "README.md"), "utf8")).resolves.toBe("fixed\n");
  });

  it("prepares the untouched base before applying the test files, and the candidate after applying the change", async () => {
    const env = await makeEnv();
    const runner = testRunner(fixAndAddTest);
    const listing: EnvironmentDeclaration = { checks: [{ id: "tool", argv: ["sh", "-c", "true"] }], prepare: [{ id: "list", argv: ["sh", "-c", "ls; git log --format=%s"] }] };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: definitionWith(listing), advances: [work, red, green, stop({ reason: "paused", blocker: "inspect" }, "pause")] }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "prepare-order",
    });
    expect(report.stopReason).toBe("paused");
    const state = await loadRunState(report.stateDir);
    const [, base, candidate] = commandRuns(state.evidence, "list");
    expect(base!.payload.checkout).toMatchObject({ from: "base", phase: "prepare", commit: state.intake.pinnedHead });
    expect(base!.payload.command.stdoutTail).not.toContain("probe.test");
    expect(base!.payload.command.stdoutTail).not.toContain("GraphLoom candidate");
    expect(candidate!.payload.checkout).toMatchObject({ from: "candidate", phase: "prepare" });
    expect(candidate!.payload.command.stdoutTail).toContain("probe.test");
    expect(commandRuns(state.evidence, "tool").map((e) => e.payload.checkout?.from ?? "worktree")).toEqual(["worktree", "base", "candidate"]);
    const redRun = commandRuns(state.evidence, "red").at(-1)!;
    expect(redRun.payload.checkout).toMatchObject({ paths: ["probe.test"], prepared: true, phase: "run" });
    expect(redRun.payload.checkout!.commit).not.toBe(state.intake.pinnedHead);
  });

  it("keeps a file one check changed on record even after a later check restores it", async () => {
    const env = await makeEnv();
    const runner = testRunner(fixAndAddTest);
    const checks = (commands: Array<{ id: string; argv: string[] }>) =>
      dispatch({ stageId: "write", kind: "command", purpose: "check", instruction: "checks", readOnly: true, checkout: { from: "candidate" }, input: { commands } }, "checks");
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith(),
        advances: [
          work,
          checks([
            { id: "dirty", argv: ["sh", "-c", "echo stray >> README.md"] },
            { id: "restore", argv: ["git", "checkout", "--", "README.md"] },
            { id: "commits", argv: ["sh", "-c", "echo more >> probe.test && git -c user.name=x -c user.email=x@x commit -qam hidden"] },
          ]),
          stop({ reason: "paused", blocker: "inspect" }, "pause"),
        ],
      }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "per-check-mutations",
    });
    expect(report.stopReason).toBe("paused");
    const state = await loadRunState(report.stateDir);
    const mutations = (id: string) => commandRuns(state.evidence, id).at(-1)!.payload.checkout!.mutations;
    expect(mutations("dirty")).toEqual(["README.md"]);
    expect(mutations("restore")).toEqual(["README.md"]);
    expect(mutations("commits")).toEqual(["README.md", "probe.test"]);
  });

  it("charges the environment check to the job budget and does not run it when none remain", async () => {
    const env = await makeEnv("budgets:\n  jobs: 1\n");
    let agentJobs = 0;
    const runner = testRunner(async (job, ctx) => {
      agentJobs += 1;
      return fixAndAddTest(job, ctx);
    });
    const plugin = () => createScriptedGraph({ definition: definitionWith({ checks: [{ id: "tool", argv: ["sh", "-c", "true"] }] }), advances: [work] });
    const report = await createController().run({ taskPath: env.taskPath, plugin: plugin(), validators, runner, stateRoot: env.stateRoot, runId: "env-budget" });
    expect(report).toMatchObject({ status: "stopped", stopReason: "budgets exhausted", blocker: "jobs" });
    expect(runner.commandJobs).toHaveLength(1);
    expect(agentJobs).toBe(0);
    expect((await loadRunState(report.stateDir)).budgets.jobs).toBe(0);

    const again = testRunner(fixAndAddTest);
    const resumed = await createController().resume({ runRef: report.stateDir, plugin: plugin(), validators, runner: again });
    expect(resumed).toMatchObject({ status: "stopped", stopReason: "budgets exhausted", blocker: "jobs" });
    expect(again.commandJobs).toHaveLength(0);
  });

  it("charges a checkout's preparation as a job of its own", async () => {
    const run = async (jobs: number, runId: string) => {
      const env = await makeEnv(`budgets:\n  jobs: ${jobs}\n`);
      const runner = testRunner(fixAndAddTest);
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition: definitionWith(PREPARE), advances: [work, red, stop({ reason: "paused", blocker: "inspect" }, "pause")] }),
        validators,
        runner,
        stateRoot: env.stateRoot,
        runId,
      });
      return { report, runner, state: await loadRunState(report.stateDir) };
    };
    // Preflight, the implementer, and RED's preparation and run.
    const enough = await run(10, "checkout-budget");
    expect(enough.report.stopReason).toBe("paused");
    expect(enough.state.budgets.jobs).toBe(6);

    const short = await run(3, "checkout-short");
    expect(short.report).toMatchObject({ status: "stopped", stopReason: "budgets exhausted", blocker: "jobs" });
    expect(commandRuns(short.state.evidence, "red")).toEqual([]);
  });

  it("fails a checkout job whose preparation changes tracked files", async () => {
    const env = await makeEnv();
    const runner = testRunner(fixAndAddTest);
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith({ prepare: [{ id: "generate", argv: ["sh", "-c", "test -f probe.test || exit 0; echo touched >> README.md"] }] }),
        advances: [work, green],
      }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "dirty-prepare",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toContain("preparation failed in the checkout");
    expect(report.stopReason).toContain("changed tracked files: README.md");
  });

  it("fails a checkout job whose preparation reports no result for a declared command", async () => {
    const env = await makeEnv();
    const inner = testRunner(fixAndAddTest);
    const runner: Runner = {
      async runJob(job, ctx) {
        const result = await inner.runJob(job, ctx);
        if (!ctx.operationId.endsWith("-prepare")) return result;
        const kept = (result.evidence ?? []).filter((e) => (e.payload as CommandPayload).command.id !== "generate");
        return { ...result, evidence: kept };
      },
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: definitionWith(PREPARE), advances: [work, red] }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "unreported-prepare",
    });
    expect(report.status).toBe("stopped");
    expect(report.stopReason).toContain("preparation failed in the checkout");
    expect(report.stopReason).toContain("no result for generate");
    expect(commandRuns((await loadRunState(report.stateDir)).evidence, "red")).toEqual([]);
  });

  it("stops before any job when a declared tool is missing, naming it", async () => {
    const env = await makeEnv();
    let agentJobs = 0;
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith({ checks: [{ id: "go", argv: ["graphloom-missing-go-toolchain", "version"] }] }),
        advances: [work],
      }),
      validators,
      runner: testRunner(async (job, ctx) => {
        agentJobs += 1;
        return fixAndAddTest(job, ctx);
      }),
      stateRoot: env.stateRoot,
      runId: "missing-tool",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("environment check failed");
    expect(report.blocker).toMatch(/^go: .*ENOENT/);
    expect(agentJobs).toBe(0);
  });

  describe("nested results for another invocation", () => {
    const tampers = {
      "wrong run": (r: JobResult) => ({ ...r, runId: "other-run" }),
      "wrong operation": (r: JobResult) => ({ ...r, operationId: `${r.operationId}-other` }),
      "stale generation": (r: JobResult) => ({ ...r, generation: r.generation - 1 }),
    };
    // A stale checkout result discards the whole checkout job, its preparation included.
    const targets = [
      { target: "the environment preflight", hits: (ctx: JobContext) => ctx.operationId.startsWith("env-"), kept: [] },
      { target: "a checkout's preparation", hits: (ctx: JobContext) => ctx.operationId.endsWith("-prepare"), kept: ["preflight"] },
      {
        target: "a checkout's command",
        hits: (ctx: JobContext) => !ctx.operationId.startsWith("env-") && !ctx.operationId.endsWith("-prepare"),
        kept: ["preflight"],
      },
    ];
    const cases = targets.flatMap((t) => Object.entries(tampers).map(([tamper, change]) => ({ ...t, tamper, change })));

    it.each(cases)("stops on $tamper from $target without recording its evidence", async ({ hits, kept, change }) => {
      const env = await makeEnv();
      const inner = testRunner(fixAndAddTest);
      let tampered = 0;
      const runner: Runner = {
        async runJob(job, ctx) {
          const result = await inner.runJob(job, ctx);
          if (job.kind !== "command" || !hits(ctx)) return result;
          tampered += 1;
          return change(result);
        },
      };
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition: definitionWith(PREPARE), advances: [work, red, stop({ reason: "paused", blocker: "inspect" }, "pause")] }),
        validators,
        runner,
        stateRoot: env.stateRoot,
        runId: "stale-nested",
      });

      expect(tampered).toBe(1);
      expect(report).toMatchObject({ status: "stopped", stopReason: "stale job result identity" });
      expect(report.blocker).toContain("expected ");
      const state = await loadRunState(report.stateDir);
      const recorded = ["sh", "generate", "red"].flatMap((id) => commandRuns(state.evidence, id));
      expect([...new Set(recorded.map((e) => e.payload.checkout?.phase ?? "preflight"))].sort()).toEqual(kept);
      expect(commandRuns(state.evidence, "red")).toEqual([]);
    });
  });

  it("checks the environment again on resume", async () => {
    const env = await makeEnv();
    const marker = path.join(env.taskDir, "tool-installed");
    await writeFile(marker, "", "utf8");
    const environment = { checks: [{ id: "tool", argv: ["test", "-f", marker] }] };
    const paused = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition: definitionWith(environment), advances: [work, stop({ reason: "paused", blocker: "later" }, "pause")] }),
      validators,
      runner: testRunner(fixAndAddTest),
      stateRoot: env.stateRoot,
      runId: "resume-check",
    });
    expect(paused.stopReason).toBe("paused");

    await execFileAsync("rm", [marker]);
    const resumed = await createController().resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({ definition: definitionWith(environment), advances: [] }),
      validators,
      runner: testRunner(fixAndAddTest),
    });
    expect(resumed.status).toBe("stopped");
    expect(resumed.stopReason).toBe("environment check failed");
    expect(resumed.blocker).toBe("tool: exited 1");
  });

  it("refuses to complete when the workspace changed after the last stage accepted it", async () => {
    const env = await makeEnv();
    let worktree = "";
    const runner = testRunner(async (job, ctx) => {
      worktree = ctx.worktreePath;
      return job.purpose === "review" ? review() : fixAndAddTest(job, ctx);
    });
    const tamper: ScriptedAdvance = () => {
      writeFileSync(path.join(worktree, "README.md"), "tampered\n", "utf8");
      return stop({ reason: "complete", blocker: "none" }, "done");
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith(PREPARE),
        advances: [work, red, green, validate({ stageId: "write" }, "accept"), reviewJob, validate({ stageId: "review" }, "accept"), tamper],
      }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "drift",
    });

    expect(report.status).toBe("stopped");
    expect(report.stopReason).toBe("delivery changed after acceptance");
    expect(report.blocker).toContain("independent-review");
  });

  it("invalidates a receipt bound only to command evidence when the candidate changes afterward", async () => {
    const env = await makeEnv();
    let worktree = "";
    const runner = testRunner(async (job, ctx) => {
      worktree = ctx.worktreePath;
      return job.purpose === "review" ? review() : fixAndAddTest(job, ctx);
    });
    const tamper: ScriptedAdvance = () => {
      writeFileSync(path.join(worktree, "README.md"), "tampered further\n", "utf8");
      return reviewJob;
    };
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith(PREPARE),
        advances: [
          work,
          red,
          green,
          validate({ stageId: "write" }, "accept the fix"),
          tamper,
          validate({ stageId: "review" }, "accept the review"),
          stop({ reason: "complete", blocker: "none" }, "done"),
        ],
      }),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "command-identity",
    });

    const state = await loadRunState(report.stateDir);
    const writeReceipt = state.receipts.find((r) => r.stageId === "write")!;
    expect(writeReceipt.valid).toBe(false);
    expect(report.status).not.toBe("succeeded");
  });

  describe("pinned files", () => {
    const pinned = (sha256: string): EnvironmentDeclaration => ({ pinnedFiles: [{ path: "README.md", sha256 }] });
    const baseSha = createHash("sha256").update(BASE_README).digest("hex");
    const staleSha = createHash("sha256").update("older contributing guide\n").digest("hex");

    it("continues when the pinned files match", async () => {
      const env = await makeEnv();
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition: definitionWith(pinned(baseSha)), advances: [stop({ reason: "paused", blocker: "ok" }, "pause")] }),
        validators,
        runner: testRunner(fixAndAddTest),
        stateRoot: env.stateRoot,
        runId: "pinned-ok",
      });
      expect(report.stopReason).toBe("paused");
    });

    it("stops without a supervisor when a pinned file changed", async () => {
      const env = await makeEnv();
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition: definitionWith(pinned(staleSha)), advances: [work] }),
        validators,
        runner: testRunner(fixAndAddTest),
        stateRoot: env.stateRoot,
        runId: "pinned-stop",
      });
      expect(report.status).toBe("stopped");
      expect(report.stopReason).toBe("environment changed");
      expect(report.blocker).toContain("README.md changed");
    });

    it("hands a changed pinned file to the supervisor, blocks its jobs, and stops when no repair follows", async () => {
      const env = await makeEnv();
      const triggers: string[] = [];
      const supervisor = createScriptedSupervisor({
        decisions: [
          (input) => {
            triggers.push(input.trigger.code);
            return returnToNormal({ summary: "nothing to repair" }, "return");
          },
        ],
      });
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition: definitionWith(pinned(staleSha)), advances: [work] }),
        validators,
        runner: testRunner(fixAndAddTest),
        supervisor,
        stateRoot: env.stateRoot,
        runId: "pinned-recovery",
      });
      expect(triggers).toEqual(["environment_changed"]);
      expect(report.status).toBe("stopped");
      expect(report.stopReason).toBe("environment changed");
      expect(report.blocker).toMatch(/^no repair updated the environment declaration/);
    });

    it("refuses recovery jobs while the declaration is stale", async () => {
      const env = await makeEnv();
      // Each refused dispatch is inadmissible and re-asked within the turn
      // (#117); after the third, the environment_changed trigger's safe
      // default is to stop (returning would only hit the same block).
      const supervisor = createScriptedSupervisor({ decisions: [work, work, work] });
      const report = await createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition: definitionWith(pinned(staleSha)), advances: [] }),
        validators,
        runner: testRunner(fixAndAddTest),
        supervisor,
        stateRoot: env.stateRoot,
        runId: "pinned-refuse",
      });
      expect(report.stopReason).toBe("supervisor_inadmissible");
      expect(report.blocker).toContain("recovery dispatch rejected");
      expect(report.blocker).toContain("environment declaration");
      const state = await loadRunState(report.stateDir);
      expect(state.supervisorOutcomes).toMatchObject([
        { outcome: "supervisor_inadmissible", triggerCode: "environment_changed", applied: "stop" },
      ]);
      expect(state.supervisorOutcomes?.[0]?.rejections).toHaveLength(3);
    });
  });

  it("rejects a checkout on a job that may write", async () => {
    const env = await makeEnv();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition: definitionWith(),
        advances: [dispatch({ stageId: "write", kind: "command", purpose: "work", instruction: "x", writeScope: ["."], checkout: { from: "candidate" } }, "bad")],
      }),
      validators,
      runner: testRunner(fixAndAddTest),
      stateRoot: env.stateRoot,
      runId: "checkout-write",
    });
    expect(report.stopReason).toBe("checkout rejected");
  });
});

async function makeEnv(taskExtra = ""): Promise<{ taskDir: string; taskPath: string; stateRoot: string }> {
  await access(path.join(helloBundle, "dist"));
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-env-"));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(repoPath, "README.md"), BASE_README, "utf8");
  await writeFile(path.join(repoPath, ".gitignore"), "generated.txt\n", "utf8");
  await git("add", "README.md", ".gitignore");
  await git("commit", "-m", "init");

  const pluginsDir = path.join(taskDir, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  await symlink(helloBundle, path.join(pluginsDir, "hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, `graph: hello\nrepo: ./test-repo\nrequest: Fix the README.\n${taskExtra}`, "utf8");
  return { taskDir, taskPath, stateRoot: path.join(taskDir, "state") };
}
