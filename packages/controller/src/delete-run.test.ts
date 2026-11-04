// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScriptedGraph, dispatch, stop, type GraphDefinition } from "@graphloom/sdk";
import { createScriptedRunner } from "@graphloom/runner";
import { createController, loadRunState, saveRunState } from "./index.js";
import { HELLO_VERSION } from "./testing/hello-version.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const helloBundle = path.join(path.resolve(here, "../../.."), "examples/plugins/hello");

const definition: GraphDefinition = {
  graphId: "hello",
  version: HELLO_VERSION,
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
      independence: "separate-reviewer",
    },
  ],
};
const unused = { evaluate: () => ({ status: "inconclusive" as const, reason: "unused" }) };
const validators = { "exact-greeting": unused, "independent-reviewer": unused };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function makeEnv() {
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-delete-"));
  cleanups.push(() => rm(taskDir, { recursive: true, force: true }));
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repoPath });
  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git("add", "README.md");
  await git("commit", "-m", "init");
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  await symlink(helloBundle, path.join(taskDir, "plugins/hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: hello\nrepo: ./test-repo\nrequest: Create GREETING.txt.\n", "utf8");
  return { taskPath, repoPath, stateRoot: path.join(taskDir, "state"), git };
}

type Env = Awaited<ReturnType<typeof makeEnv>>;

async function stoppedRun(env: Env, runId: string) {
  const report = await createController().run({
    taskPath: env.taskPath,
    plugin: createScriptedGraph({ definition, advances: [stop({ reason: "paused", blocker: "test pause" }, "pause")] }),
    runner: createScriptedRunner({ jobs: [] }),
    validators,
    stateRoot: env.stateRoot,
    runId,
  });
  expect(report.status).toBe("stopped");
  return report;
}

async function branches(env: Env): Promise<string> {
  return (await env.git("branch", "--list", "graphloom/*")).stdout.trim();
}

describe("deleting a run", () => {
  it("removes a stopped run's worktree, branch, and state directory", async () => {
    const env = await makeEnv();
    const run = await stoppedRun(env, "done-with");
    expect(await branches(env)).toContain("graphloom/done-with");

    const report = await createController().delete("done-with", { stateRoot: env.stateRoot });
    expect(report).toEqual({ runId: "done-with", stateDir: run.stateDir, worktreePath: run.worktreePath, branch: "graphloom/done-with" });
    expect(await readdir(env.stateRoot)).toEqual([]);
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(await branches(env)).toBe("");
    expect((await env.git("worktree", "list")).stdout).not.toContain(run.worktreePath);
    expect((await env.git("config", "--get-regexp", "graphloom").catch(() => ({ stdout: "" }))).stdout).toBe("");
    expect(existsSync(path.join(env.repoPath, "README.md"))).toBe(true);
    await expect(createController().delete(run.stateDir)).rejects.toThrow();
  });

  it("refuses to discard uncommitted changes or branch commits unless forced", async () => {
    const env = await makeEnv();
    const dirty = await stoppedRun(env, "dirty");
    await writeFile(path.join(dirty.worktreePath, "notes.md"), "unsaved\n", "utf8");
    await expect(createController().delete(dirty.stateDir)).rejects.toThrow(
      "cannot delete run dirty: its worktree has uncommitted changes (notes.md); pass force to discard them",
    );
    expect(existsSync(dirty.stateDir)).toBe(true);
    await createController().delete(dirty.stateDir, { force: true });
    expect(existsSync(dirty.worktreePath)).toBe(false);

    await writeFile(path.join(env.repoPath, ".git", "info", "exclude"), "*.log\n", "utf8");
    const ignored = await stoppedRun(env, "ignored");
    await writeFile(path.join(ignored.worktreePath, "build.log"), "output\n", "utf8");
    await expect(createController().delete(ignored.stateDir)).rejects.toThrow(
      "cannot delete run ignored: its worktree has uncommitted changes (build.log); pass force to discard them",
    );
    await createController().delete(ignored.stateDir, { force: true });

    const committed = await stoppedRun(env, "committed");
    await writeFile(path.join(committed.worktreePath, "work.md"), "work\n", "utf8");
    await execFileAsync("git", ["add", "work.md"], { cwd: committed.worktreePath });
    await execFileAsync("git", ["commit", "-m", "agent work"], { cwd: committed.worktreePath });
    await expect(createController().delete(committed.stateDir)).rejects.toThrow(
      "cannot delete run committed: branch graphloom/committed has 1 commit(s) beyond the pinned head; pass force to discard them",
    );
    expect(await branches(env)).toContain("graphloom/committed");
    await createController().delete(committed.stateDir, { force: true });
    expect(await branches(env)).toBe("");
  });

  it("preserves ignored files unless deletion is explicitly forced", async () => {
    const env = await makeEnv();
    await writeFile(path.join(env.repoPath, ".gitignore"), "notes.private\ncache/\n");
    await env.git("add", ".gitignore");
    await env.git("commit", "-m", "ignore local files");
    const run = await stoppedRun(env, "ignored");
    await writeFile(path.join(run.worktreePath, "notes.private"), "keep this\n");
    await mkdir(path.join(run.worktreePath, "cache"));
    await writeFile(path.join(run.worktreePath, "cache", "notes.txt"), "also keep\n");

    await expect(createController().delete(run.stateDir)).rejects.toThrow("pass force to discard");
    expect(existsSync(path.join(run.worktreePath, "notes.private"))).toBe(true);
    expect(existsSync(path.join(run.worktreePath, "cache", "notes.txt"))).toBe(true);
    expect(existsSync(run.stateDir)).toBe(true);
    expect(await branches(env)).toContain("graphloom/ignored");

    await createController().delete(run.stateDir, { force: true });
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(existsSync(run.stateDir)).toBe(false);
  });

  it("refuses a run that is running, owned by a live controller, or has an active session", async () => {
    const env = await makeEnv();
    const run = await stoppedRun(env, "busy");
    const state = await loadRunState(run.stateDir);
    await saveRunState({ ...state, status: "running" });
    await expect(createController().delete(run.stateDir)).rejects.toThrow("cannot delete run busy: it is running; stop it first");

    await saveRunState({ ...(await loadRunState(run.stateDir)), status: "stopped" });
    const owner = spawn("sleep", ["30"], { stdio: "ignore" });
    cleanups.push(async () => owner.kill());
    const claim = { ownerId: "other", controllerPid: owner.pid, claimedAt: new Date().toISOString(), expiresAt: Date.now() + 60_000 };
    await writeFile(path.join(run.stateDir, "run.owner.json"), JSON.stringify(claim), "utf8");
    await expect(createController().delete(run.stateDir)).rejects.toThrow(
      `cannot delete run busy: it is owned by live controller pid ${owner.pid}; stop it first`,
    );
    expect(existsSync(run.stateDir)).toBe(true);

    const controller = createController();
    let started!: () => void;
    const jobStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "wait", writeScope: ["GREETING.txt"] }, "wait")],
      }),
      runner: createScriptedRunner({
        jobs: [
          async () => {
            started();
            await gate;
            return { status: "failed" as const, summary: "stopped" };
          },
        ],
      }),
      validators,
      stateRoot: env.stateRoot,
      runId: "live",
    });
    await jobStarted;
    const live = path.join(env.stateRoot, "live");
    await expect(controller.delete(live)).rejects.toThrow("cannot delete run live: it has an active controller session; stop it first");
    await controller.stop(live);
    release();
    await running;
    await controller.delete(live, { force: true });
    expect(existsSync(live)).toBe(false);
  });

  it("refuses a state file whose worktree or branch is not the run's own", async () => {
    const env = await makeEnv();
    const run = await stoppedRun(env, "tampered");
    const state = await loadRunState(run.stateDir);
    await saveRunState({ ...state, worktreePath: env.repoPath });
    await expect(createController().delete(run.stateDir)).rejects.toThrow(
      `cannot delete run tampered: its worktree ${env.repoPath} is not ${run.worktreePath}`,
    );
    await saveRunState({ ...state, worktreeBranch: "main" });
    await expect(createController().delete(run.stateDir)).rejects.toThrow(
      "cannot delete run tampered: its branch main is not graphloom/tampered",
    );
    expect(existsSync(path.join(env.repoPath, "README.md"))).toBe(true);

    await saveRunState(state);
    const moved = path.join(env.stateRoot, "moved");
    await rename(run.stateDir, moved);
    await expect(createController().delete(moved, { force: true })).rejects.toThrow(
      `cannot delete run tampered: its state directory ${moved} is not named for it`,
    );
  });

  it("refuses to delete another run's worktree and branch, even with force", async () => {
    const env = await makeEnv();
    const other = await makeEnv();
    const run = await stoppedRun(env, "same");
    const theirs = await stoppedRun(other, "same");
    const state = await loadRunState(run.stateDir);
    await saveRunState({
      ...state,
      intake: { ...state.intake, repoPath: other.repoPath },
      worktreePath: theirs.worktreePath,
    });
    await expect(createController().delete(run.stateDir, { force: true })).rejects.toThrow(
      `cannot delete run same: branch graphloom/same in ${other.repoPath} belongs to the run at ${theirs.stateDir}`,
    );
    expect(existsSync(theirs.worktreePath)).toBe(true);
    expect(await branches(other)).toContain("graphloom/same");

    await saveRunState(state);
    await env.git("config", "--unset", "branch.graphloom/same.graphloomStateDir");
    await expect(createController().delete(run.stateDir, { force: true })).rejects.toThrow(
      `cannot delete run same: ${env.repoPath} does not record which run owns branch graphloom/same; remove it with git`,
    );
    expect(existsSync(run.worktreePath)).toBe(true);
  });

  it("keeps a commit made to the branch after the check", async () => {
    const env = await makeEnv();
    const run = await stoppedRun(env, "raced");
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    const bin = path.join(path.dirname(env.stateRoot), "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "git"),
      [
        "#!/bin/sh",
        'if [ "$1" = worktree ] && [ "$2" = remove ]; then',
        `  c=$(${realGit} commit-tree -p refs/heads/graphloom/raced -m late "$(${realGit} rev-parse HEAD^{tree})")`,
        `  ${realGit} update-ref refs/heads/graphloom/raced "$c"`,
        "fi",
        `exec ${realGit} "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
    cleanups.push(async () => vi.unstubAllEnvs());
    await expect(createController().delete(run.stateDir)).rejects.toThrow(
      "cannot delete run raced: branch graphloom/raced moved while it was being deleted; run delete again",
    );
    vi.unstubAllEnvs();
    expect((await env.git("log", "-1", "--format=%s", "graphloom/raced")).stdout.trim()).toBe("late");
    await expect(createController().delete(run.stateDir)).rejects.toThrow(
      "cannot delete run raced: branch graphloom/raced has 1 commit(s) beyond the pinned head; pass force to discard them",
    );
    await createController().delete(run.stateDir, { force: true });
    expect(await branches(env)).toBe("");
  });

  it("can repeat a delete whose state directory removal failed", async () => {
    const env = await makeEnv();
    const run = await stoppedRun(env, "stuck");
    const locked = path.join(run.stateDir, "extra", "locked");
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(locked, "held"), "x", "utf8");
    await chmod(locked, 0o500);
    cleanups.push(() => chmod(locked, 0o700).catch(() => undefined));
    await expect(createController().delete(run.stateDir)).rejects.toThrow(/EACCES/);
    expect(existsSync(run.worktreePath)).toBe(false);
    expect(existsSync(path.join(run.stateDir, "state.json"))).toBe(true);

    await chmod(locked, 0o700);
    await createController().delete("stuck", { stateRoot: env.stateRoot });
    expect(await readdir(env.stateRoot)).toEqual([]);
  });

  it("finishes a delete that stopped partway", async () => {
    const env = await makeEnv();
    const run = await stoppedRun(env, "partial");
    await rm(run.worktreePath, { recursive: true, force: true });
    await createController().delete(run.stateDir);
    expect(existsSync(run.stateDir)).toBe(false);
    expect(await branches(env)).toBe("");

    const noBranch = await stoppedRun(env, "no-branch");
    await env.git("worktree", "remove", "--force", noBranch.worktreePath);
    await env.git("branch", "-D", "graphloom/no-branch");
    await createController().delete(noBranch.stateDir);
    expect(existsSync(noBranch.stateDir)).toBe(false);
  });
});
