// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmod, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Removes a tree, making read-only directories writable first when a plain
 * removal is refused: Go's module cache marks its directories read-only, so a
 * run's scratch or worktree holding one cannot be removed as is. Symbolic
 * links are removed, never followed. Throws when the tree still cannot be removed.
 */
export async function removeTree(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
    await makeWritable(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

/** Gives the owner write and search permission on `dir` and every directory below it (not through links). */
export async function makeWritable(dir: string): Promise<void> {
  const stat = await lstat(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat?.isDirectory()) return;
  await chmod(dir, (stat.mode & 0o777) | 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeWritable(path.join(dir, entry.name));
  }
}
