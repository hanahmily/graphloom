import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Linux advisory lock. The kernel releases it when the helper exits, including
 * when its controller dies and closes the helper's stdin pipe. Lock files stay
 * outside repositories and are never unlinked: replacing their inode would let
 * a waiter and a new caller acquire different locks for the same resource.
 */
export async function withDirectoryLock<T>(
  lockDir: string,
  lockName: string,
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    delayMs?: number;
    /** Retained for existing callers; kernel locks do not expire by elapsed time. */
    leaseMs?: number;
  },
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const resource = path.join(await realpath(lockDir), lockName);
  if (process.platform !== "linux" || process.getuid === undefined) {
    throw new Error("directory locking requires Linux and util-linux flock");
  }
  // Do not use TMPDIR: callers with different environments must still contend
  // for the same resource. Refuse pre-existing directories owned by other users
  // or writable/readable by them, including symlinks planted in /tmp.
  const uid = process.getuid();
  const lockRoot = `/tmp/graphloom-locks-${uid}`;
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const directory = await lstat(lockRoot);
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
    throw new Error(`unsafe lock directory ${lockRoot}`);
  }
  const lockPath = path.join(lockRoot, createHash("sha256").update(resource).digest("hex"));
  const waitSeconds = Math.max(0, (options?.retries ?? 200) * (options?.delayMs ?? 25)) / 1_000;
  // --no-fork gives the shell the locked descriptor. Its only input comes from
  // this controller; read exits on EOF without leaving an orphan lock holder.
  const child = spawn("flock", [
    "--exclusive", "--timeout", String(waitSeconds), "--no-fork", lockPath,
    "sh", "-c", "printf 'locked\\n'; read -r release || :",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString();
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(
        code === 1 ? `timed out acquiring lock ${resource}` : `cannot acquire lock ${resource}: ${stderr.trim() || `flock exited ${code}`}`,
      )));
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("locked\n")) resolve();
      });
    });
    return await fn();
  } finally {
    child.stdin.end();
    await closed;
  }
}
