// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { ChildProcess } from "node:child_process";

/**
 * Stops what an agent CLI started (spawned `detached`, so it leads its own
 * process group) once the CLI exits: nothing it started may outlive the job.
 * `terminate` sends SIGTERM to the group and arms SIGKILL after the grace
 * period; the returned promise settles when the group is gone, or after twice
 * the grace period. Keep the SIGKILL timer armed until then.
 */
export function drainOnExit(child: ChildProcess, terminate: () => void, killGraceMs: number): () => Promise<void> {
  let gone: Promise<void> | undefined;
  const drain = (): Promise<void> =>
    (gone ??= (async () => {
      if (child.pid === undefined || !groupAlive(child.pid)) return;
      terminate();
      await waitForGroupExit(child.pid, killGraceMs * 2);
    })());
  child.once("exit", () => void drain());
  return drain;
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForGroupExit(pid: number, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (groupAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}
