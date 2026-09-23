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
  const graphloomRoot = path.join(repoPath, "graphloom");
  const worktreePath = path.join(graphloomRoot, safeId);
  const branchName = `graphloom/${safeId}`;
  await withDirectoryLock(repoPath, ".graphloom-repo.lock", async () => {
    await assertNoSymlinkComponent(repoPath, "graphloom");
    await mkdir(graphloomRoot, { recursive: true });
    await assertNoSymlinkComponent(repoPath, "graphloom");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, pinnedHead],
      { cwd: repoPath },
    );
  });
  return { worktreePath, branchName };
}

/** Reject if any path component under base is a symlink. */
export async function assertNoSymlinkComponent(
  baseDir: string,
  relative: string,
): Promise<void> {
  let cursor = baseDir;
  for (const part of relative.split(/[/\\]/).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = await lstat(cursor);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
    if (st.isSymbolicLink()) {
      throw new Error(`symlink rejected in path: ${relative}`);
    }
  }
}

export async function listDirtyPaths(repoPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "-uall", "--ignored"],
    { cwd: repoPath },
  );
  return parsePorcelainPaths(stdout);
}

/**
 * Workspace change manifest relative to pinned HEAD.
 * Includes tracked, untracked, and ignored paths (excluding .git).
 */
export async function workspaceChangeManifest(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["status", "--porcelain", "-uall", "--ignored"],
    { cwd: worktreePath },
  );
  return parsePorcelainPaths(stdout);
}

function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // XY PATH or XY ORIG -> PATH (rename/copy)
    const raw = line.slice(3).trim();
    if (raw.includes(" -> ")) {
      const [from, to] = raw.split(" -> ");
      if (from) pushPath(paths, from.trim());
      if (to) pushPath(paths, to.trim());
    } else {
      pushPath(paths, raw);
    }
  }
  return [...new Set(paths)].sort();
}

function pushPath(paths: string[], p: string): void {
  if (p === ".git" || p.startsWith(".git/")) return;
  paths.push(p);
}

export async function readWorktreeFile(
  worktreePath: string,
  relativePath: string,
): Promise<string | undefined> {
  const rootReal = await realpath(worktreePath);
  // Lexical containment before any walk that could treat escapes as missing.
  const targetLexical = path.resolve(worktreePath, relativePath);
  if (targetLexical !== worktreePath && !targetLexical.startsWith(worktreePath + path.sep)) {
    throw new Error(`path escapes worktree: ${relativePath}`);
  }
  if (relativePath.split(/[/\\]/).includes("..")) {
    throw new Error(`path escapes worktree: ${relativePath}`);
  }

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

  const targetReal = await realpath(targetLexical).catch((err: NodeJS.ErrnoException) => {
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
      void head;
      void pinnedHead;
      break;
    }
  }
  if (!found) {
    throw new Error(`worktree not registered: ${worktreePath}`);
  }
}
