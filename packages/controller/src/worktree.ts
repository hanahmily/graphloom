import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";

const execFileAsync = promisify(execFile);

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}

/**
 * Create `graphloom/<run-id>` worktree from pinned HEAD.
 * Does not copy uncommitted source changes. Serialized under a per-repo lock.
 */
export async function createRunWorktree(
  repoPath: string,
  runId: string,
  pinnedHead: string,
): Promise<WorktreeResult> {
  const safeId = assertSafeRunId(runId);
  const worktreePath = path.join(repoPath, "graphloom", safeId);
  const branchName = `graphloom/${safeId}`;
  await withDirectoryLock(repoPath, ".graphloom-repo.lock", async () => {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, pinnedHead],
      { cwd: repoPath },
    );
  });
  return { worktreePath, branchName };
}

export async function listDirtyPaths(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "-uall"],
    { cwd: repoPath },
  );
  return stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
}

/** Workspace change manifest relative to pinned HEAD (tracked + untracked, no .git). */
export async function workspaceChangeManifest(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "-uall"],
    { cwd: worktreePath },
  );
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const raw = line.slice(3).trim();
    const arrow = raw.includes(" -> ") ? raw.split(" -> ").pop()! : raw;
    if (arrow === ".git" || arrow.startsWith(".git/")) continue;
    paths.push(arrow);
  }
  return [...new Set(paths)].sort();
}

export async function readWorktreeFile(
  worktreePath: string,
  relativePath: string,
): Promise<string | undefined> {
  const rootReal = await realpath(worktreePath);
  const target = path.resolve(worktreePath, relativePath);
  // Reject symlink components before following them out of the tree.
  let cursor = worktreePath;
  const parts = relativePath.split(/[/\\]/).filter(Boolean);
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await lstat(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`symlink rejected in worktree path: ${relativePath}`);
    }
  }

  const targetReal = await realpath(target).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return undefined;
    }
    throw err;
  });
  if (targetReal === undefined) {
    return undefined;
  }
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error(`path escapes worktree: ${relativePath}`);
  }

  try {
    return await readFile(targetReal, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function assertWorktreeMatches(
  repoPath: string,
  worktreePath: string,
  branchName: string,
  pinnedHead: string,
): Promise<void> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoPath,
  });
  const blocks = stdout.split("\n\n");
  const expectedPath = await realpath(worktreePath).catch(() => null);
  if (!expectedPath) {
    throw new Error(`worktree missing: ${worktreePath}`);
  }
  let found = false;
  for (const block of blocks) {
    const lines = block.split("\n");
    const wt = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length);
    if (!wt) continue;
    const wtReal = await realpath(wt).catch(() => null);
    if (wtReal === expectedPath) {
      found = true;
      if (branch && branch !== `refs/heads/${branchName}`) {
        throw new Error(
          `worktree branch mismatch: expected ${branchName}, got ${branch}`,
        );
      }
      // HEAD may advance with commits inside the worktree; pin is the creation base.
      void head;
      void pinnedHead;
      break;
    }
  }
  if (!found) {
    throw new Error(`worktree not registered: ${worktreePath}`);
  }
}
