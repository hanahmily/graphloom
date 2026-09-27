import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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
export async function deleteRun(stateDir: string, options: { force?: boolean } = {}): Promise<DeleteReport> {
  const report = await withDirectoryLock(stateDir, "run.exec.lock", async () => {
    const state = await loadRunState(stateDir);
    const refuse = (why: string) => new Error(`cannot delete run ${state.runId}: ${why}`);
    const owner = await readOwnerClaim(stateDir);
    if (owner && !isClaimStale(owner)) throw refuse(`it is owned by live controller pid ${owner.controllerPid}; stop it first`);
    if (state.status === "running") throw refuse("it is running; stop it first");

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
      if (hasWorktree) await git(repo, "worktree", "remove", "--force", worktreePath);
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
      if (entry !== "state.json" && entry !== "run.exec.lock") await rm(path.join(stateDir, entry), { recursive: true, force: true });
    }
    await rm(path.join(stateDir, "state.json"));
    return { runId, stateDir, worktreePath, branch };
  });
  await rm(stateDir, { recursive: true, force: true });
  return report;
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
