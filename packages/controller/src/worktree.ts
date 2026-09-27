import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath } from "node:fs/promises";
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
 * Git config key naming the state directory of the run that owns a branch.
 * It lives in the repository, so editing a run's state file cannot claim
 * another run's worktree and branch.
 */
export function runStateDirKey(branchName: string): string {
  return `branch.${branchName}.graphloomStateDir`;
}

/**
 * Create `graphloom/<run-id>` worktree from pinned HEAD, recording `stateDir`
 * as its owner. Does not copy uncommitted source changes. Serialized under a
 * per-repo lock.
 */
export async function createRunWorktree(
  repoPath: string,
  runId: string,
  pinnedHead: string,
  stateDir: string,
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
    await execFileAsync("git", ["config", runStateDirKey(branchName), path.resolve(stateDir)], { cwd: repoPath });
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

/**
 * Fingerprint of every path git would commit that differs from HEAD: tracked
 * changes and untracked files, not ignored ones (build output, dependencies).
 * Comparing two fingerprints shows which paths a job changed, including a path
 * that was already dirty before it.
 */
export async function worktreeChangeFingerprints(worktreePath: string): Promise<Map<string, string>> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-z", "-uall"], {
    cwd: worktreePath,
    maxBuffer: 64 * 1024 * 1024,
  });
  const paths = new Set<string>();
  const entries = stdout.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    paths.add(entry.slice(3));
    // Renames and copies are followed by their source path.
    if (entry[0] === "R" || entry[0] === "C") paths.add(entries[(i += 1)]!);
  }
  const fingerprints = new Map<string, string>();
  for (const rel of paths) {
    if (rel === ".git" || rel.startsWith(".git/")) continue;
    fingerprints.set(rel, await fingerprintPath(path.join(worktreePath, rel)));
  }
  return fingerprints;
}

async function fingerprintPath(file: string): Promise<string> {
  const st = await lstat(file).catch(() => undefined);
  if (st === undefined) return "missing";
  if (st.isSymbolicLink()) return `link:${await readlink(file)}`;
  if (!st.isFile()) return "other";
  return `file:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

/**
 * Paths a job changed that still differ from HEAD. A path restored to HEAD is
 * left out, so a correction may undo a stray change outside its scope.
 */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([rel, fp]) => before.get(rel) !== fp).map(([rel]) => rel).sort();
}

/** Changed paths a job was not allowed to write: all of them when read-only, else those outside `writeScope`. */
export function pathsOutsideWriteScope(changed: string[], job: { readOnly?: boolean; writeScope?: string[] }): string[] {
  if (job.readOnly === true) return changed;
  const scope = (job.writeScope ?? []).map((entry) => entry.replace(/\/+$/, ""));
  return changed.filter((rel) => !scope.some((entry) => rel === entry || rel.startsWith(`${entry}/`)));
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
