// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { access, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const STOP_REQUEST = "stop.request";

/** Durable stop signal for cross-process Stop (CLI ≠ owner loop). */
export async function writeStopRequest(stateDir: string): Promise<void> {
  await writeFile(
    path.join(stateDir, STOP_REQUEST),
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid }),
    "utf8",
  );
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
