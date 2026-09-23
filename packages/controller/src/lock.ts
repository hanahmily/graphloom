import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * Exclusive create-based lock for a directory (cross-process).
 * Polls briefly if the lock is held.
 */
export async function withDirectoryLock<T>(
  lockDir: string,
  lockName: string,
  fn: () => Promise<T>,
  options?: { retries?: number; delayMs?: number },
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, lockName);
  const retries = options?.retries ?? 200;
  const delayMs = options?.delayMs ?? 25;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let i = 0; i < retries; i += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      await sleep(delayMs);
    }
  }
  if (!handle) {
    throw new Error(`timed out acquiring lock ${lockPath}`);
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
