// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { access, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicManagedFile } from "./managed.js";
import { withDirectoryLock } from "./lock.js";

const STOP_REQUEST = "stop.request";

export interface StopRequest {
  interruptionCommandId?: string;
  managedDisconnect?: boolean;
}

function precedence(request: StopRequest): number {
  return request.interruptionCommandId !== undefined ? 2 : request.managedDisconnect === true ? 1 : 3;
}

/** Durable stop signal for cross-process Stop (CLI ≠ owner loop). */
export async function writeStopRequest(stateDir: string, options: StopRequest = {}): Promise<StopRequest> {
  return withDirectoryLock(stateDir, "run.stop.lock", async () => {
    const existing = await readStopRequest(stateDir);
    // Operator hold > planned interruption > unplanned channel loss. Keep the
    // first equally strong intent, including its durable shutdown command ID.
    if (existing !== undefined && precedence(existing) >= precedence(options)) return existing;
    await atomicManagedFile(stateDir, STOP_REQUEST, { at: new Date().toISOString(), pid: process.pid, ...options });
    return options;
  });
}

export async function clearStopRequest(stateDir: string): Promise<void> {
  await unlink(path.join(stateDir, STOP_REQUEST)).catch(() => undefined);
}

export async function hasStopRequest(stateDir: string): Promise<boolean> {
  try {
    await access(path.join(stateDir, STOP_REQUEST));
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Unknown or malformed metadata still means an explicit operator stop. */
export async function readStopRequest(stateDir: string): Promise<StopRequest | undefined> {
  let raw: string;
  try { raw = await readFile(path.join(stateDir, STOP_REQUEST), "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : {}; }
  try {
    const request: unknown = JSON.parse(raw);
    if (request === null || typeof request !== "object" || Array.isArray(request)) return {};
    const value = request as Record<string, unknown>;
    if (value.interruptionCommandId !== undefined) {
      return typeof value.interruptionCommandId === "string" && value.interruptionCommandId.length > 0 && value.managedDisconnect !== true
        ? { interruptionCommandId: value.interruptionCommandId } : {};
    }
    return value.managedDisconnect === true ? { managedDisconnect: true } : {};
  } catch { return {}; }
}
