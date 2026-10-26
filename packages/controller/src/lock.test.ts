// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withDirectoryLock } from "./lock.js";

const directories: string[] = [];
const moduleUrl = new URL("../dist/lock.js", import.meta.url).href;
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-lock-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runChild(script: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 || signal === "SIGKILL" ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
  return { child, done };
}

describe("directory locks", () => {
  it("serializes separate processes even when an old lock file is empty", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "test.lock"), "");
    const script = `
      import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
      import { mkdir, rm } from 'node:fs/promises';
      for (let i = 0; i < 4; i++) {
        await withDirectoryLock(${JSON.stringify(dir)}, 'test.lock', async () => {
          await mkdir(${JSON.stringify(path.join(dir, "exclusive"))});
          await new Promise(r => setTimeout(r, 5));
          await rm(${JSON.stringify(path.join(dir, "exclusive"))}, { recursive: true });
        });
      }
    `;
    await Promise.all(Array.from({ length: 6 }, () => runChild(script).done));
  });

  it("does not let elapsed leases unlock a live holder and releases on callback failure", async () => {
    const dir = await directory();
    await expect(withDirectoryLock(dir, "test.lock", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(withDirectoryLock(dir, "test.lock", async () => {
        throw new Error("entered another owner's lock");
      }, { retries: 1, delayMs: 1 })).rejects.toThrow("timed out acquiring lock");
      throw new Error("callback failure");
    }, { leaseMs: 1 })).rejects.toThrow("callback failure");
    await expect(withDirectoryLock(dir, "test.lock", async () => "released")).resolves.toBe("released");
  });

  it("releases the lock when its controller process dies", async () => {
    const dir = await directory();
    const { child, done } = runChild(`
      import { withDirectoryLock } from ${JSON.stringify(moduleUrl)};
      await withDirectoryLock(${JSON.stringify(dir)}, 'test.lock', async () => {
        console.log('ready');
        await new Promise(() => {});
      });
    `);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("controller exited before locking")));
      });
      child.kill("SIGKILL");
      await done;
      await expect(withDirectoryLock(dir, "test.lock", async () => "recovered")).resolves.toBe("recovered");
    } finally {
      child.kill("SIGKILL");
      await done;
    }
  });

  it("keeps the same lock when the protected directory is renamed and recreated", async () => {
    const root = await directory();
    const dir = path.join(root, "run");
    await mkdir(dir);
    await withDirectoryLock(dir, "test.lock", async () => {
      await rename(dir, path.join(root, "deleted-run"));
      await mkdir(dir);
      await expect(withDirectoryLock(dir, "test.lock", async () => undefined, { retries: 1, delayMs: 1 })).rejects.toThrow("timed out acquiring lock");
    });
    await expect(withDirectoryLock(dir, "test.lock", async () => "released")).resolves.toBe("released");
  });
});
