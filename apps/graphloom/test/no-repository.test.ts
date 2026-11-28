// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createController, IntakeError, intakeTask, loadRunState, manifestRepository, PRIVATE_REPOSITORY_COMMIT, readTaskIntake } from "@graphloom/controller";
import { createScriptedRunner } from "@graphloom/runner";
import { bumpBundleVersion, createNoRepositoryFixture, createScope, NO_REPOSITORY_VERSION, type NoRepositoryFixture } from "@graphloom/testkit";

const execFileAsync = promisify(execFile);
const scope = createScope();
afterEach(() => scope.dispose());

const runner = () => createScriptedRunner({ jobs: [] });
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

async function startPaused(f: NoRepositoryFixture, runId = "tidy-1") {
  // Stops once the Survey stage is accepted, before the graph's own stop: the run can be resumed.
  const report = await createController().run({ taskPath: f.taskPath, runner: runner(), stateRoot: f.stateRoot, runId, stopAfterStage: "Survey" });
  return report;
}

describe("manifestRepository", () => {
  it("is required when absent, accepts required and none, and refuses optional and anything else", () => {
    expect(manifestRepository("{}")).toBe("required");
    expect(manifestRepository('{"repository":"required"}')).toBe("required");
    expect(manifestRepository('{"repository":"none"}')).toBe("none");
    expect(() => manifestRepository('{"repository":"optional"}')).toThrow('manifest repository must be "required" or "none", got "optional"');
    expect(() => manifestRepository('{"repository":true}')).toThrow('manifest repository must be "required" or "none", got true');
  });
});

describe("intake of a task for a graph that works without a repository", () => {
  it("reads it with no repository and no writes, and pins the private repository's commit", async () => {
    const f = await createNoRepositoryFixture(scope);
    const read = await readTaskIntake(f.taskPath);
    expect(read.repository).toEqual({ mode: "none", pinnedHead: PRIVATE_REPOSITORY_COMMIT });
    expect(read.task.repo).toBeUndefined();
    expect(existsSync(f.stateRoot)).toBe(false);
  });

  it("makes intakeTask refuse without a private repository path, and use the one it is given", async () => {
    const f = await createNoRepositoryFixture(scope);
    await expect(intakeTask(f.taskPath)).rejects.toThrow(`graph tidy works without a repository, so its runs have no default state root; pass --state-root <dir>`);
    const pin = await intakeTask(f.taskPath, { privateRepository: path.join(f.stateRoot, "r", "repository") });
    expect(pin.repoPath).toBe(path.join(f.stateRoot, "r", "repository"));
    expect(pin.pinnedHead).toBe(PRIVATE_REPOSITORY_COMMIT);
    expect(existsSync(f.stateRoot)).toBe(false);
  });

  it("refuses repo: and base: for such a graph", async () => {
    const withRepo = await createNoRepositoryFixture(scope, { taskLines: "repo: .\n" });
    await expect(readTaskIntake(withRepo.taskPath)).rejects.toThrow("graph tidy works without a repository; remove repo: from the task file");
    const withBase = await createNoRepositoryFixture(scope, { taskLines: "base: main\n" });
    await expect(readTaskIntake(withBase.taskPath)).rejects.toThrow("graph tidy works without a repository, so base: names nothing; remove it");
  });

  it("reads an empty repo: for a graph that needs none as no repo: at all", async () => {
    const f = await createNoRepositoryFixture(scope, { taskLines: 'repo: ""\n' });
    const read = await readTaskIntake(f.taskPath);
    expect(read.repository.mode).toBe("none");
    expect(read.task.repo).toBeUndefined();
  });

  it("refuses a missing repo: for a graph that needs one (declared or by default), and refuses repository optional", async () => {
    for (const repository of [undefined, "required"]) {
      const f = await createNoRepositoryFixture(scope, { repository });
      await expect(readTaskIntake(f.taskPath)).rejects.toThrow("graph tidy needs a repository: name it with repo: in the task file");
      await expect(readTaskIntake(f.taskPath)).rejects.toBeInstanceOf(IntakeError);
    }
    // An empty repo: names nothing, so it is no more a repository than a missing one.
    for (const line of ['repo: ""', "repo: ''", "repo:   "]) {
      const empty = await createNoRepositoryFixture(scope, { repository: "required", taskLines: `${line}\n` });
      await expect(readTaskIntake(empty.taskPath), line).rejects.toThrow("graph tidy needs a repository: name it with repo: in the task file");
    }
    const optional = await createNoRepositoryFixture(scope, { repository: "optional" });
    await expect(readTaskIntake(optional.taskPath)).rejects.toThrow('manifest repository must be "required" or "none", got "optional"');
  });
});

describe("a run of a graph that works without a repository", () => {
  it("refuses a standalone run with no state root, creating nothing", async () => {
    const f = await createNoRepositoryFixture(scope);
    await expect(createController().run({ taskPath: f.taskPath, runner: runner() })).rejects.toThrow("works without a repository, so its runs have no default state root; pass --state-root <dir>");
    expect(existsSync(path.join(f.taskDir, "graphloom-state"))).toBe(false);
  });

  it("succeeds in a private repository inside its state directory, pinned to the constant commit", async () => {
    const f = await createNoRepositoryFixture(scope);
    const report = await createController().run({ taskPath: f.taskPath, runner: runner(), stateRoot: f.stateRoot, runId: "tidy-1" });
    expect(report.status, report.blocker).toBe("succeeded");
    expect(report.sourceDirtyBefore).toEqual([]);
    const state = await loadRunState(report.stateDir);
    const repository = path.join(f.stateRoot, "tidy-1", "repository");
    expect(state.intake.repoPath).toBe(repository);
    expect(state.intake.pinnedHead).toBe(PRIVATE_REPOSITORY_COMMIT);
    expect(state.intake.task.repo).toBeUndefined();
    expect(state.worktreePath).toBe(path.join(repository, "graphloom", "tidy-1"));
    expect(await git(repository, "rev-parse", "refs/heads/graphloom/tidy-1")).toBe(PRIVATE_REPOSITORY_COMMIT);
    expect(await git(state.worktreePath, "rev-parse", "HEAD")).toBe(PRIVATE_REPOSITORY_COMMIT);
    // Nothing outside the state root: the task's directory holds no repository, no state, no worktree.
    expect(existsSync(path.join(f.taskDir, ".git"))).toBe(false);
    expect(existsSync(path.join(f.taskDir, "graphloom"))).toBe(false);
  });

  it("gives two runs the same pinned head and separate repositories", async () => {
    const f = await createNoRepositoryFixture(scope);
    const a = await createController().run({ taskPath: f.taskPath, runner: runner(), stateRoot: f.stateRoot, runId: "tidy-a" });
    const b = await createController().run({ taskPath: f.taskPath, runner: runner(), stateRoot: f.stateRoot, runId: "tidy-b" });
    const [sa, sb] = [await loadRunState(a.stateDir), await loadRunState(b.stateDir)];
    expect(sa.intake.pinnedHead).toBe(sb.intake.pinnedHead);
    expect(sa.intake.repoPath).not.toBe(sb.intake.repoPath);
  });

  it("resumes with the same repository", async () => {
    const f = await createNoRepositoryFixture(scope);
    const paused = await startPaused(f);
    expect(paused.status).toBe("stopped");
    const before = await loadRunState(paused.stateDir);
    const resumed = await createController().resume({ runRef: paused.stateDir, runner: runner() });
    expect(resumed.status, resumed.blocker).toBe("succeeded");
    const after = await loadRunState(paused.stateDir);
    expect(after.intake.repoPath).toBe(before.intake.repoPath);
    expect(after.worktreePath).toBe(before.worktreePath);
  });

  it("resumes with --update-plugin to a new version that keeps its mode, and refuses one that changes it", async () => {
    const f = await createNoRepositoryFixture(scope);
    const paused = await startPaused(f);
    await bumpBundleVersion(f.bundle, "1.0.1");
    const resumed = await createController().resume({ runRef: paused.stateDir, runner: runner(), updatePlugin: true });
    expect(resumed.status, resumed.blocker).toBe("succeeded");
    expect((await loadRunState(paused.stateDir)).intake.bundle.version).toBe("1.0.1");

    const flip = await createNoRepositoryFixture(scope);
    const flipped = await startPaused(flip, "tidy-flip");
    await bumpBundleVersion(flip.bundle, "1.0.1");
    const manifestPath = path.join(flip.bundle, "graphloom.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, repository: "required" }, null, 2)}\n`);
    const refused = await createController().resume({ runRef: flipped.stateDir, runner: runner(), updatePlugin: true });
    expect(refused).toMatchObject({ status: "stopped", stopReason: "pin mismatch" });
    expect(refused.blocker).toBe('the installed bundle declares repository "required" but this run was started with "none"; a plugin update cannot change it');
    // Dropping the key is the same change.
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, repository: undefined }, null, 2)}\n`);
    const dropped = await createController().resume({ runRef: flipped.stateDir, runner: runner(), updatePlugin: true });
    expect(dropped.blocker).toContain('declares repository "required" but this run was started with "none"');
    expect(NO_REPOSITORY_VERSION).toBe("1.0.0");
  });

  it("is removed whole by delete, with and without force", async () => {
    const f = await createNoRepositoryFixture(scope);
    const done = await createController().run({ taskPath: f.taskPath, runner: runner(), stateRoot: f.stateRoot, runId: "tidy-del" });
    const report = await createController().delete(done.stateDir);
    expect(report).toMatchObject({ runId: "tidy-del", branch: "graphloom/tidy-del" });
    expect(existsSync(done.stateDir)).toBe(false);

    const dirty = await startPaused(f, "tidy-dirty");
    const worktree = (await loadRunState(dirty.stateDir)).worktreePath;
    await writeFile(path.join(worktree, "note.txt"), "x\n");
    await expect(createController().delete(dirty.stateDir)).rejects.toThrow("its worktree has uncommitted changes (note.txt); pass force to discard them");
    expect(existsSync(worktree)).toBe(true);
    await createController().delete(dirty.stateDir, { force: true });
    expect(existsSync(dirty.stateDir)).toBe(false);
    expect(existsSync(f.stateRoot) ? await git(f.stateRoot, "rev-parse", "--is-inside-work-tree").catch(() => "no") : "no").toBe("no");
  });
});
