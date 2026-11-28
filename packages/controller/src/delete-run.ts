// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readManagedBinding, type ManagedRunBinding } from "./managed.js";
import { makeWritable, removeTree } from "./remove-tree.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import { isClaimStale, readOwnerClaim } from "./owner.js";
import { loadRunState } from "./state.js";
import { runStateDirKey, workspaceChangeManifest } from "./worktree.js";

const execFileAsync = promisify(execFile);

export interface DeleteReport {
  runId: string;
  stateDir: string;
  worktreePath: string;
  branch: string;
}

/**
 * Delete a run that no controller is driving: its worktree, its branch, then
 * its state directory, with `state.json` last, so a failure partway leaves a
 * run that can be deleted again. Paths come from the run's own naming, and the
 * repository must record this state directory as the branch's owner.
 */
export interface DeleteOptions {
  /** Discard uncommitted worktree changes and branch commits beyond the pinned head. */
  force?: boolean;
  /**
   * The hub purging its own archived submission's run (docs/design-run-hub.md §4.3):
   * a managed run is deleted only for the hub and submission its binding names. The
   * hub has drained the run, so a `running` label a killed controller left is no refusal.
   */
  managed?: { hubStateDir: string; submissionId: string };
}

export async function deleteRun(stateDir: string, options: DeleteOptions = {}): Promise<DeleteReport> {
  const report = await withDirectoryLock(stateDir, "run.exec.lock", async () => {
    assertManagedDeletion(await readManagedBinding(stateDir), options.managed);
    const state = await loadRunState(stateDir);
    const refuse = (why: string) => new Error(`cannot delete run ${state.runId}: ${why}`);
    const owner = await readOwnerClaim(stateDir);
    if (owner && !isClaimStale(owner)) throw refuse(`it is owned by live controller pid ${owner.controllerPid}; stop it first`);
    if (state.status === "running" && options.managed === undefined) throw refuse("it is running; stop it first");

    const runId = assertSafeRunId(state.runId);
    if (path.basename(stateDir) !== runId) throw refuse(`its state directory ${stateDir} is not named for it`);
    const repo = state.intake.repoPath;
    const worktreePath = path.join(repo, "graphloom", runId);
    const branch = `graphloom/${runId}`;
    if (state.worktreePath !== worktreePath) throw refuse(`its worktree ${state.worktreePath} is not ${worktreePath}`);
    if (state.worktreeBranch !== branch) throw refuse(`its branch ${state.worktreeBranch} is not ${branch}`);

    await withDirectoryLock(repo, ".graphloom-repo.lock", async () => {
      const hasWorktree = existsSync(worktreePath);
      const tip = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => undefined);
      if (hasWorktree || tip !== undefined) {
        const recorded = await git(repo, "config", "--get", runStateDirKey(branch)).catch(() => undefined);
        if (recorded === undefined) throw refuse(`${repo} does not record which run owns branch ${branch}; remove it with git`);
        if ((await canonical(recorded)) !== (await canonical(stateDir))) {
          throw refuse(`branch ${branch} in ${repo} belongs to the run at ${recorded}`);
        }
      }
      if (options.force !== true) {
        if (hasWorktree) {
          const changed = await workspaceChangeManifest(worktreePath);
          if (changed.length > 0) {
            throw refuse(`its worktree has uncommitted changes (${listed(changed)}); pass force to discard them`);
          }
        }
        if (tip !== undefined) {
          const ahead = Number(await git(repo, "rev-list", "--count", `${state.intake.pinnedHead}..${tip}`));
          if (ahead > 0) throw refuse(`branch ${branch} has ${ahead} commit(s) beyond the pinned head; pass force to discard them`);
        }
      }
      // git refuses a path that is not one of this repo's worktrees, so nothing else is removed.
      if (hasWorktree) await removeWorktree(repo, worktreePath);
      await git(repo, "worktree", "prune");
      if (tip !== undefined) {
        // Only the tip checked above, so a commit made since is never discarded.
        await git(repo, "update-ref", "-d", `refs/heads/${branch}`, tip).catch(() => {
          throw refuse(`branch ${branch} moved while it was being deleted; run delete again`);
        });
      }
      await git(repo, "config", "--unset", runStateDirKey(branch)).catch(() => undefined);
    });

    for (const entry of await readdir(stateDir)) {
      if (entry !== "state.json" && entry !== "run.exec.lock") await removeTree(path.join(stateDir, entry));
    }
    await removeTree(path.join(stateDir, "state.json"));
    return { runId, stateDir, worktreePath, branch };
  });
  await removeTree(stateDir);
  return report;
}

/**
 * Deletes a hub's archived run (docs/design-run-hub.md §4.3), also one a failed or
 * interrupted delete left without `state.json`: `deleteRun` removes that file only
 * after the worktree and branch, so what remains is the state directory alone,
 * unless the run never saved state; then a worktree or branch the repository
 * records for this state directory is removed only with `force`. Returns undefined
 * when the state directory is already gone.
 */
export async function deleteManagedRun(stateDir: string, options: { hubStateDir: string; submissionId: string; runId: string; repoPath: string; force?: boolean }): Promise<DeleteReport | undefined> {
  const runId = assertSafeRunId(options.runId);
  if (path.basename(stateDir) !== runId) throw new Error(`cannot delete run ${runId}: its state directory ${stateDir} is not named for it`);
  if (!existsSync(stateDir)) return undefined;
  const managed = { hubStateDir: options.hubStateDir, submissionId: options.submissionId };
  if (existsSync(path.join(stateDir, "state.json"))) return deleteRun(stateDir, { managed, ...(options.force === true ? { force: true } : {}) });
  const repo = options.repoPath;
  const worktreePath = path.join(repo, "graphloom", runId);
  const branch = `graphloom/${runId}`;
  await withDirectoryLock(stateDir, "run.exec.lock", async () => {
    assertManagedDeletion(await readManagedBinding(stateDir), managed);
    if (existsSync(path.join(stateDir, "state.json"))) throw new Error(`cannot delete run ${runId}: its state appeared while it was being deleted; try again`);
    const owner = await readOwnerClaim(stateDir);
    if (owner && !isClaimStale(owner)) throw new Error(`cannot delete run ${runId}: it is owned by live controller pid ${owner.controllerPid}`);
    if (existsSync(repo)) {
      await withDirectoryLock(repo, ".graphloom-repo.lock", async () => {
        const recorded = await git(repo, "config", "--get", runStateDirKey(branch)).catch(() => undefined);
        if (recorded === undefined || (await canonical(recorded)) !== (await canonical(stateDir))) return;
        const hasWorktree = existsSync(worktreePath);
        const tip = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).catch(() => undefined);
        if ((hasWorktree || tip !== undefined) && options.force !== true) {
          throw new Error(`cannot delete run ${runId}: it has no saved state but ${repo} still has its ${hasWorktree ? "worktree" : "branch"}; pass force to discard it`);
        }
        if (hasWorktree) await removeWorktree(repo, worktreePath);
        await git(repo, "worktree", "prune");
        if (tip !== undefined) await git(repo, "update-ref", "-d", `refs/heads/${branch}`, tip);
        await git(repo, "config", "--unset", runStateDirKey(branch)).catch(() => undefined);
      });
    }
    for (const entry of await readdir(stateDir)) if (entry !== "run.exec.lock") await removeTree(path.join(stateDir, entry));
  });
  await removeTree(stateDir);
  return { runId, stateDir, worktreePath, branch };
}

function assertManagedDeletion(binding: ManagedRunBinding | undefined, managed: DeleteOptions["managed"]): void {
  if (binding === undefined) return;
  if (managed === undefined) throw new Error("cannot delete a hub-managed run; archive it through the hub, then remove its files with graphloom hub purge");
  if (path.resolve(binding.hubStateDir) !== path.resolve(managed.hubStateDir) || binding.submissionId !== managed.submissionId) {
    throw new Error(`cannot delete run ${binding.runId}: it belongs to hub submission ${binding.submissionId} of the hub at ${binding.hubStateDir}`);
  }
}

/**
 * `git worktree remove`. When git fails on the worktree's files (read-only directories
 * of a Go module cache) it may already have unregistered the worktree; the directory is
 * then made writable and removed here. A path git never knew as a worktree is refused.
 */
async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  try { await git(repo, "worktree", "remove", "--force", worktreePath); }
  catch (error) {
    if (/is not a working tree/.test(String((error as { stderr?: unknown }).stderr ?? error))) throw error;
    await makeWritable(worktreePath);
    if (await isRegisteredWorktree(repo, worktreePath)) await git(repo, "worktree", "remove", "--force", worktreePath);
    else await removeTree(worktreePath);
  }
}

async function isRegisteredWorktree(repo: string, worktreePath: string): Promise<boolean> {
  const listed = (await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));
  const wanted = await canonical(worktreePath);
  for (const item of listed) if (item === worktreePath || await canonical(item) === wanted) return true;
  return false;
}

async function canonical(dir: string): Promise<string> {
  return realpath(dir).catch(() => path.resolve(dir));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function listed(paths: string[]): string {
  return paths.length <= 5 ? paths.join(", ") : `${paths.slice(0, 5).join(", ")}, and ${paths.length - 5} more`;
}
