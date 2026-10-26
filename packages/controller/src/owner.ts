// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const OWNER_FILE = "run.owner.json";
const DEFAULT_LEASE_MS = 60_000;

/** Linux identity that remains distinct when a PID is reused or the host reboots. */
export interface ProcessIdentity {
  bootId: string;
  /** /proc/<pid>/stat field 22, kept as text to avoid loss of integer precision. */
  startTime: string;
}

export interface RunOwnerClaim {
  ownerId: string;
  controllerPid: number;
  controllerIdentity?: ProcessIdentity;
  /** Plugin child pid when using createChildPluginHost; omitted for in-process. */
  childPid?: number;
  childIdentity?: ProcessIdentity;
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
  const controllerIdentity = readProcessIdentity(process.pid);
  if (controllerIdentity === undefined) throw new Error("cannot identify controller process from Linux /proc");
  const claim: RunOwnerClaim = {
    ownerId: `${process.pid}:${randomUUID()}`,
    controllerPid: process.pid,
    controllerIdentity,
    claimedAt: new Date().toISOString(),
    expiresAt: Date.now() + leaseMs,
  };
  if (options?.childPid !== undefined) {
    claim.childPid = options.childPid;
    const identity = readProcessIdentity(options.childPid);
    if (identity !== undefined) claim.childIdentity = identity;
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
    ...(existing.controllerIdentity !== undefined ? { controllerIdentity: existing.controllerIdentity } : {}),
    claimedAt: existing.claimedAt,
    expiresAt: Date.now() + leaseMs,
  };
  const childPid = options?.childPid ?? existing.childPid;
  if (childPid !== undefined) {
    claim.childPid = childPid;
    // A heartbeat must not adopt a different process that reused a dead child's PID.
    const identity = childPid === existing.childPid ? existing.childIdentity : readProcessIdentity(childPid);
    if (identity !== undefined) claim.childIdentity = identity;
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
    ...(existing.controllerIdentity !== undefined ? { controllerIdentity: existing.controllerIdentity } : {}),
    claimedAt: existing.claimedAt,
    expiresAt: existing.expiresAt,
  };
  if (childPid !== undefined) {
    claim.childPid = childPid;
    // A heartbeat must not adopt a different process that reused a dead child's PID.
    const identity = childPid === existing.childPid ? existing.childIdentity : readProcessIdentity(childPid);
    if (identity !== undefined) claim.childIdentity = identity;
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
    killedChild = tryKill(claim.childPid, claim.childIdentity, "SIGKILL");
  }

  let signaledController = false;
  if (
    typeof claim.controllerPid === "number" &&
    claim.controllerPid > 0 &&
    claim.controllerPid !== process.pid
  ) {
    // Cooperative: SIGTERM lets the owner observe stop.request and exit cleanly.
    signaledController = tryKill(claim.controllerPid, claim.controllerIdentity, "SIGTERM");
  }

  return { killedChild, signaledController };
}

export function isClaimStale(claim: RunOwnerClaim): boolean {
  // Jobs and retry waits can exceed the lease interval. Elapsed time does not
  // authorize stealing ownership from a controller that is still executing.
  if (!pidAlive(claim.controllerPid)) return true;
  const current = readProcessIdentity(claim.controllerPid);
  // Legacy claims and inaccessible /proc cannot prove that a live PID is the
  // original controller. Keep them fenced conservatively, but never signal them.
  return claim.controllerIdentity !== undefined && current !== undefined &&
    !sameProcess(claim.controllerIdentity, current);
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

/** Read a process identity without importing or executing any plugin code. */
export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesized and may itself contain spaces or parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTime = fields[19];
    if (!bootId || startTime === undefined || !/^\d+$/.test(startTime)) return undefined;
    return { bootId, startTime };
  } catch {
    return undefined;
  }
}

function sameProcess(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return expected.bootId === actual.bootId && expected.startTime === actual.startTime;
}

function tryKill(pid: number, identity: ProcessIdentity | undefined, signal: NodeJS.Signals): boolean {
  // Old PID-only records are intentionally non-signaling: the stop request is
  // still durable, and a live legacy controller must cooperate or be handled
  // by the operator after verifying its identity outside GraphLoom.
  if (identity === undefined) return false;
  const current = readProcessIdentity(pid);
  if (current === undefined || !sameProcess(identity, current)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}
