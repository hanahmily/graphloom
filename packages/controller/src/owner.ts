import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const OWNER_FILE = "run.owner.json";
const DEFAULT_LEASE_MS = 60_000;

export interface RunOwnerClaim {
  ownerId: string;
  controllerPid: number;
  /** Plugin child pid when using createChildPluginHost; omitted for in-process. */
  childPid?: number;
  claimedAt: string;
  expiresAt: number;
}

export async function readOwnerClaim(stateDir: string): Promise<RunOwnerClaim | undefined> {
  try {
    const raw = await readFile(path.join(stateDir, OWNER_FILE), "utf8");
    return JSON.parse(raw) as RunOwnerClaim;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

export async function clearOwnerClaim(stateDir: string): Promise<void> {
  await unlink(path.join(stateDir, OWNER_FILE)).catch(() => undefined);
}

/**
 * Claim exclusive loop ownership for this controller process.
 * Fails if another controller is alive, even while a long job outlasts its lease.
 */
export async function claimRunOwner(
  stateDir: string,
  options?: { childPid?: number; leaseMs?: number },
): Promise<RunOwnerClaim> {
  const existing = await readOwnerClaim(stateDir);
  if (existing && !isClaimStale(existing) && existing.controllerPid !== process.pid) {
    throw new Error(
      `run already owned by controller pid ${existing.controllerPid} (owner ${existing.ownerId})`,
    );
  }
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
  const claim: RunOwnerClaim = {
    ownerId: `${process.pid}:${randomUUID()}`,
    controllerPid: process.pid,
    claimedAt: new Date().toISOString(),
    expiresAt: Date.now() + leaseMs,
  };
  if (options?.childPid !== undefined) {
    claim.childPid = options.childPid;
  }
  await writeOwnerClaim(stateDir, claim);
  return claim;
}

export async function renewRunOwner(
  stateDir: string,
  ownerId: string,
  options?: { childPid?: number; leaseMs?: number },
): Promise<RunOwnerClaim> {
  const existing = await readOwnerClaim(stateDir);
  if (!existing || existing.ownerId !== ownerId) {
    throw new Error("lost run owner lease");
  }
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
  const claim: RunOwnerClaim = {
    ownerId: existing.ownerId,
    controllerPid: existing.controllerPid,
    claimedAt: existing.claimedAt,
    expiresAt: Date.now() + leaseMs,
  };
  const childPid = options?.childPid ?? existing.childPid;
  if (childPid !== undefined) {
    claim.childPid = childPid;
  }
  await writeOwnerClaim(stateDir, claim);
  return claim;
}

export async function updateOwnerChildPid(
  stateDir: string,
  ownerId: string,
  childPid: number | undefined,
): Promise<void> {
  const existing = await readOwnerClaim(stateDir);
  if (!existing || existing.ownerId !== ownerId) {
    return;
  }
  const claim: RunOwnerClaim = {
    ownerId: existing.ownerId,
    controllerPid: existing.controllerPid,
    claimedAt: existing.claimedAt,
    expiresAt: existing.expiresAt,
  };
  if (childPid !== undefined) {
    claim.childPid = childPid;
  }
  await writeOwnerClaim(stateDir, claim);
}

/** Signal/reap persisted owner processes from a separate stop CLI. */
export async function reapOwnerProcesses(stateDir: string): Promise<{
  killedChild: boolean;
  signaledController: boolean;
}> {
  const claim = await readOwnerClaim(stateDir);
  if (!claim) {
    return { killedChild: false, signaledController: false };
  }

  let killedChild = false;
  if (typeof claim.childPid === "number" && claim.childPid > 0) {
    killedChild = tryKill(claim.childPid, "SIGKILL");
  }

  let signaledController = false;
  if (
    typeof claim.controllerPid === "number" &&
    claim.controllerPid > 0 &&
    claim.controllerPid !== process.pid
  ) {
    // Cooperative: SIGTERM lets the owner observe stop.request and exit cleanly.
    signaledController = tryKill(claim.controllerPid, "SIGTERM");
  }

  return { killedChild, signaledController };
}

export function isClaimStale(claim: RunOwnerClaim): boolean {
  // Jobs and retry waits can exceed the lease interval. Elapsed time does not
  // authorize stealing ownership from a controller that is still executing.
  return !pidAlive(claim.controllerPid);
}

async function writeOwnerClaim(stateDir: string, claim: RunOwnerClaim): Promise<void> {
  const temporary = path.join(stateDir, `.${OWNER_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(claim, null, 2), "utf8");
    await rename(temporary, path.join(stateDir, OWNER_FILE));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function tryKill(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
