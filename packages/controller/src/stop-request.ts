// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { access, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicManagedFile } from "./managed.js";
import { withDirectoryLock } from "./lock.js";

const STOP_REQUEST = "stop.request";

/** Durable stop signal for cross-process Stop (CLI ≠ owner loop). */
export async function writeStopRequest(stateDir: string, options?: { interruptionCommandId?: string; managedDisconnect?: boolean }): Promise<{ interruptionCommandId?: string; managedDisconnect?: boolean }> {
  return withDirectoryLock(stateDir, "run.stop.lock", async () => {
    if (options !== undefined) {
      // An explicit operator hold already requested always wins over shutdown.
      const existing = await readStopRequest(stateDir);
      const requested = existing === undefined ? undefined : JSON.parse(existing) as { interruptionCommandId?: string; managedDisconnect?: boolean };
      if (requested !== undefined && requested.interruptionCommandId === undefined && requested.managedDisconnect !== true) return {};
      await atomicManagedFile(stateDir, STOP_REQUEST, { at: new Date().toISOString(), pid: process.pid, ...options });
      return options;
    }
    await atomicManagedFile(stateDir, STOP_REQUEST, { at: new Date().toISOString(), pid: process.pid });
    return {};
  });
}

export async function clearStopRequest(stateDir: string): Promise<void> {
  await unlink(path.join(stateDir, STOP_REQUEST)).catch(() => undefined);
}

export async function hasStopRequest(stateDir: string): Promise<boolean> {
  try {
    await access(path.join(stateDir, STOP_REQUEST));
    return true;
  } catch {
    return false;
  }
}

export async function readStopRequest(stateDir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(stateDir, STOP_REQUEST), "utf8");
  } catch {
    return undefined;
  }
}
