import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}

/**
 * Create `graphloom/<run-id>` worktree from pinned HEAD.
 * Does not copy uncommitted source changes.
 */
export async function createRunWorktree(
  repoPath: string,
  runId: string,
  pinnedHead: string,
): Promise<WorktreeResult> {
  const worktreePath = path.join(repoPath, "graphloom", runId);
  const branchName = `graphloom/${runId}`;
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, pinnedHead],
    { cwd: repoPath },
  );
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
    // rename: "old -> new"
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
  const { readFile } = await import("node:fs/promises");
  const target = path.resolve(worktreePath, relativePath);
  if (!target.startsWith(worktreePath + path.sep) && target !== worktreePath) {
    throw new Error(`path escapes worktree: ${relativePath}`);
  }
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeMarker(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}
