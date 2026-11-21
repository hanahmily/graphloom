// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

/** The lock helper owns the descriptor. Graph children cannot inherit it. */
export async function acquireHubLock(directory: string, onLost: () => void = () => undefined): Promise<{ release: () => Promise<void>; pid: number }> {
  if (process.platform !== "linux" || !process.getuid) throw new Error("hub requires Linux and util-linux flock");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw new Error(`hub directory must be owned by this user with mode 0700: ${directory}`);
  }
  const file = path.join(await realpath(directory), "hub.lock");
  const child = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", file, "sh", "-c", "printf 'locked\\n'; read -r release || :"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`hub is locked or flock failed (${code}): ${error}`)));
      let received = "";
      child.stdout.on("data", (chunk: Buffer) => {
        received = (received + chunk.toString()).slice(-4096);
        if (received.includes("locked\n")) resolve();
      });
    });
  } catch (error) {
    child.stdin.destroy();
    await closed;
    throw error;
  }
  let released = false;
  child.once("close", () => { if (!released) onLost(); });
  return { pid: child.pid!, release: async () => {
    if (released) return;
    released = true;
    child.stdin.end();
    await closed;
  } };
}
