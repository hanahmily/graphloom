import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import { isClaimStale, readOwnerClaim } from "./owner.js";
import { loadRunState } from "./state.js";

const execFileAsync = promisify(execFile);

export interface DeleteReport {
  runId: string;
  stateDir: string;
  worktreePath: string;
  branch: string;
}

/**
 * Delete a run that no controller is driving: its worktree, its branch, then
 * its state directory, so a failure partway leaves a run that can be deleted
 * again. Paths come from the run's own naming, never from the state file alone.
 */
export async function deleteRun(stateDir: string, options: { force?: boolean } = {}): Promise<DeleteReport> {
  const tombstone = `${stateDir}.deleted-${randomBytes(4).toString("hex")}`;
  const report = await withDirectoryLock(stateDir, "run.exec.lock", async () => {
    const state = await loadRunState(stateDir);
    const refuse = (why: string) => new Error(`cannot delete run ${state.runId}: ${why}`);
    const owner = await readOwnerClaim(stateDir);
    if (owner && !isClaimStale(owner)) throw refuse(`it is owned by live controller pid ${owner.controllerPid}; stop it first`);
    if (state.status === "running") throw refuse("it is running; stop it first");

    const runId = assertSafeRunId(state.runId);
    const repo = state.intake.repoPath;
    const worktreePath = path.join(repo, "graphloom", runId);
    const branch = `graphloom/${runId}`;
    if (state.worktreePath !== worktreePath) throw refuse(`its worktree ${state.worktreePath} is not ${worktreePath}`);
    if (state.worktreeBranch !== branch) throw refuse(`its branch ${state.worktreeBranch} is not ${branch}`);

    await withDirectoryLock(repo, ".graphloom-repo.lock", async () => {
      const hasWorktree = existsSync(worktreePath);
      const hasBranch = await git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).then(
        () => true,
        () => false,
      );
      if (options.force !== true) {
        if (hasWorktree) {
          const changed = (await git(worktreePath, "status", "--porcelain")).split("\n").filter(Boolean).map((l) => l.slice(3));
          if (changed.length > 0) {
            throw refuse(`its worktree has uncommitted changes (${listed(changed)}); pass force to discard them`);
          }
        }
        if (hasBranch) {
          const ahead = Number(await git(repo, "rev-list", "--count", `${state.intake.pinnedHead}..${branch}`));
          if (ahead > 0) throw refuse(`branch ${branch} has ${ahead} commit(s) beyond the pinned head; pass force to discard them`);
        }
      }
      // git refuses a path that is not one of this repo's worktrees, so nothing else is removed.
      if (hasWorktree) await git(repo, "worktree", "remove", "--force", worktreePath);
      await git(repo, "worktree", "prune");
      if (hasBranch) await git(repo, "branch", "-D", branch);
    });

    // Out of sight under the lock, so no other command sees a half-deleted run.
    await rename(stateDir, tombstone);
    return { runId, stateDir, worktreePath, branch };
  });
  await rm(tombstone, { recursive: true, force: true });
  return report;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout.trim();
}

function listed(paths: string[]): string {
  return paths.length <= 5 ? paths.join(", ") : `${paths.slice(0, 5).join(", ")}, and ${paths.length - 5} more`;
}
