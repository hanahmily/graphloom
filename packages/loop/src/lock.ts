// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The mechanism of packages/hub/src/lock.ts (acquireHubLock), copied rather than
// imported so the loop package does not depend on the hub: a util-linux `flock`
// child holds a kernel lock on the file and owns the descriptor. The kernel drops
// the lock when the holder dies (the child sees stdin close when this process is
// killed), so a crashed holder never leaves the store locked and there is no pid
// file to take over.

import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface FileLock {
  /** The directory with symlinks resolved; the lock file lives in it, and callers should put their own files there too. */
  directory: string;
  release: () => Promise<void>;
}

/**
 * Take the exclusive lock on `<directory>/<name>`; rejects with a message naming "locked" when another holder has it.
 * The directory is created 0700 and must be owned by this user with no group or other access. `onLost` fires once if
 * the helper exits while the lock is still held (not on release): the kernel lock is gone and another process may hold it.
 */
export async function acquireFileLock(directory: string, name: string, onLost: () => void = () => undefined): Promise<FileLock> {
  if (process.platform !== "linux" || !process.getuid) throw new Error("the loop store requires Linux and util-linux flock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`loop store directory must be owned by this user with mode 0700: ${directory}`);
  }
  const file = path.join(resolved, name);
  const child = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", file, "sh", "-c", "printf 'locked\\n'; read -r release || :"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`loop store is locked by another process or flock failed (${code}): ${error.trim()}`)));
      let received = "";
      child.stdout.on("data", (chunk: Buffer) => {
        received = (received + chunk.toString()).slice(-4096);
        if (received.includes("locked\n")) resolve();
      });
    });
  } catch (cause) {
    child.stdin.destroy();
    await closed;
    throw cause;
  }
  let released = false;
  child.once("close", () => { if (!released) onLost(); });
  return { directory: resolved, release: async () => {
    if (released) return;
    released = true;
    child.stdin.end();
    await closed;
  } };
}
