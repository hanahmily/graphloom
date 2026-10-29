// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createScriptedGraph, dispatch, stop, type ConfinementSpec, type GraphDefinition, type JobSpec } from "@graphloom/sdk";
import { createScriptedRunner, type JobContext, type Runner } from "@graphloom/runner";
import { createController } from "./index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

// The hello bundle's own definition, which the run's pin must match.
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
    { requirementId: "independent-review", validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" },
  ],
};

const bwrap: ConfinementSpec = { kind: "bwrap", network: false, mask: ["~/.ssh"], binds: [] };
const docker: ConfinementSpec = {
  kind: "docker",
  image: `busybox@sha256:${"b".repeat(64)}`,
  cpus: 1,
  memory: "1g",
  pids: 64,
  tmp: "64m",
  wallClockMs: 60_000,
  writable: ["."],
  readOnly: [],
  env: {},
};

async function makeEnv(): Promise<{ taskPath: string; stateRoot: string }> {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-job-confinement-"));
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  await symlink(helloBundle, path.join(taskDir, "plugins/hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, `graph: hello\nrepo: ./test-repo\nrequest: "Check."\n`, "utf8");
  return { taskPath, stateRoot: path.join(taskDir, "state") };
}

function recordingRunner(): { runner: Runner; seen: Array<{ job: JobSpec; ctx: JobContext }> } {
  const seen: Array<{ job: JobSpec; ctx: JobContext }> = [];
  const runner = createScriptedRunner({
    jobs: [
      async (job, ctx) => {
        seen.push({ job, ctx });
        return { status: "ok", summary: "ran" };
      },
    ],
  });
  return { runner, seen };
}

const command = (confinement: unknown): JobSpec =>
  ({
    stageId: "write",
    kind: "command",
    purpose: "check",
    instruction: "run it",
    readOnly: true,
    input: { commands: [{ id: "c", argv: ["true"] }] },
    confinement,
  }) as JobSpec;

describe("a job's own confinement through the controller", () => {
  it("gives a bwrap job the run's scope, with the confinement kept on the job the runner receives", async () => {
    const env = await makeEnv();
    const { runner, seen } = recordingRunner();
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(command(bwrap), "check"), stop({ reason: "done", blocker: "none" }, "done")] }),
      validators: {},
      runner,
      stateRoot: env.stateRoot,
      runId: "bwrap-scope",
    });
    expect(seen).toHaveLength(1);
    const { job, ctx } = seen[0]!;
    expect(job.confinement).toEqual(bwrap);
    expect(ctx.confinement?.scratchDir).toMatch(/\/scratch$/);
    expect(ctx.confinement?.writablePaths).toContain(ctx.worktreePath);
    expect(ctx.scratchDir).toBe(ctx.confinement?.scratchDir);
  });

  it("gives a docker job the run's scratch directory for its mounts, and no host confinement of its own", async () => {
    const env = await makeEnv();
    const { runner, seen } = recordingRunner();
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(command(docker), "check"), stop({ reason: "done", blocker: "none" }, "done")] }),
      validators: {},
      runner,
      stateRoot: env.stateRoot,
      runId: "docker-scope",
    });
    const { job, ctx } = seen[0]!;
    expect(job.confinement).toEqual(docker);
    expect(ctx.scratchDir).toMatch(/\/scratch$/);
    expect(ctx.confinement).toBeUndefined();
  });

  it("leaves a plain job unconfined, as before", async () => {
    const env = await makeEnv();
    const { runner, seen } = recordingRunner();
    await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(command(undefined), "check"), stop({ reason: "done", blocker: "none" }, "done")] }),
      validators: {},
      runner,
      stateRoot: env.stateRoot,
      runId: "plain",
    });
    expect(seen[0]!.job.confinement).toBeUndefined();
    expect(seen[0]!.ctx.confinement).toBeUndefined();
  });

  it("does not run a job whose confinement is malformed, such as an image without a digest", async () => {
    const env = await makeEnv();
    const { runner, seen } = recordingRunner();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [dispatch(command({ ...docker, image: "busybox:latest" }), "check"), stop({ reason: "done", blocker: "none" }, "done")] }),
      validators: {},
      runner,
      stateRoot: env.stateRoot,
      runId: "malformed",
    });
    expect(seen).toEqual([]);
    expect(report.status).not.toBe("succeeded");
    expect(report.blocker ?? report.stopReason ?? "").toMatch(/digest|confinement/);
  });
});

describe("a resume releases what a stopped controller left", () => {
  it("asks the runner to release the run before it dispatches anything", async () => {
    const env = await makeEnv();
    const released: string[] = [];
    const base = createScriptedRunner({ jobs: [] });
    const runner: Runner = { ...base, releaseRun: async (id) => void released.push(id) };
    const plugin = () => createScriptedGraph({ definition, advances: [stop({ reason: "pause", blocker: "waiting", retryable: true }, "pause")] });
    const first = await createController().run({ taskPath: env.taskPath, plugin: plugin(), validators: {}, runner, stateRoot: env.stateRoot, runId: "release-1" });
    expect(first.status).not.toBe("succeeded");
    expect(released).toEqual([]);
    await createController().resume({ runRef: first.stateDir, plugin: plugin(), validators: {}, runner }).catch(() => undefined);
    expect(released).toEqual(["release-1"]);
  });
});
