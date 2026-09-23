import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface LockLease {
  owner: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
}

const DEFAULT_LEASE_MS = 60_000;

/**
 * Exclusive create-based lock with owner lease and stale recovery.
 * Crash leftovers expire after leaseMs (or sooner if the owner pid is dead).
 */
export async function withDirectoryLock<T>(
  lockDir: string,
  lockName: string,
  fn: () => Promise<T>,
  options?: { retries?: number; delayMs?: number; leaseMs?: number },
): Promise<T> {
  await mkdir(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, lockName);
  const retries = options?.retries ?? 200;
  const delayMs = options?.delayMs ?? 25;
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
  const owner = `${process.pid}:${randomUUID()}`;

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let i = 0; i < retries; i += 1) {
    try {
      handle = await open(lockPath, "wx");
      const lease: LockLease = {
        owner,
        pid: process.pid,
        createdAt: Date.now(),
        expiresAt: Date.now() + leaseMs,
      };
      await handle.writeFile(JSON.stringify(lease), "utf8");
      await handle.sync();
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await tryReclaimStaleLock(lockPath)) {
        continue;
      }
      await sleep(delayMs);
    }
  }
  if (!handle) {
    throw new Error(`timed out acquiring lock ${lockPath}`);
  }

  const renew = setInterval(() => {
    void renewLease(lockPath, owner, leaseMs).catch(() => undefined);
  }, Math.max(1_000, Math.floor(leaseMs / 3)));
  renew.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

async function tryReclaimStaleLock(lockPath: string): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    let lease: LockLease | undefined;
    try {
      lease = JSON.parse(raw) as LockLease;
    } catch {
      // Corrupt lock — reclaim.
      await unlink(lockPath);
      return true;
    }
    const expired = !lease.expiresAt || Date.now() > lease.expiresAt;
    const deadOwner = typeof lease.pid === "number" && !pidAlive(lease.pid);
    if (expired || deadOwner) {
      await unlink(lockPath);
      return true;
    }
    // Touch check: extremely old mtime as last resort.
    const st = await stat(lockPath);
    if (Date.now() - st.mtimeMs > DEFAULT_LEASE_MS * 2) {
      await unlink(lockPath);
      return true;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return true;
    }
  }
  return false;
}

async function renewLease(lockPath: string, owner: string, leaseMs: number): Promise<void> {
  const raw = await readFile(lockPath, "utf8");
  const lease = JSON.parse(raw) as LockLease;
  if (lease.owner !== owner) {
    return;
  }
  lease.expiresAt = Date.now() + leaseMs;
  await writeFile(lockPath, JSON.stringify(lease), "utf8");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
