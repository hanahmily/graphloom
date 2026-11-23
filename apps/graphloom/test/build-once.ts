// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileAsync, repoRoot } from "@graphloom/testkit";

/**
 * Builds one workspace once per test run, however many test files ask for it.
 *
 * A rehearsal suite is split across several files that vitest runs in parallel workers; each must see the plugin's
 * freshly built `dist/`, but two `tsc` runs writing the same `dist/` while a third file imports it could read a
 * half-written module. The first caller takes a lock directory under the run's own temp root (the shared vitest
 * global setup points TMPDIR at one root per run, inherited by every worker) and builds; the others wait for its
 * outcome.
 */
export async function buildOnce(workspace: string, timeoutMs = 120_000): Promise<void> {
  const dir = path.join(os.tmpdir(), `graphloom-build-${workspace.replace(/[^A-Za-z0-9-]/g, "_")}`);
  const done = path.join(dir, "done");
  const failed = path.join(dir, "failed");
  let owner = true;
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    owner = false;
  }
  if (owner) {
    try {
      await execFileAsync("npm", ["run", "build", "-w", workspace], { cwd: repoRoot });
    } catch (err) {
      await writeFile(failed, err instanceof Error ? err.message : String(err));
      throw err;
    }
    await writeFile(done, "");
    return;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await stat(done).then(() => true, () => false)) return;
    const failure = await readFile(failed, "utf8").catch(() => undefined);
    if (failure !== undefined) throw new Error(`building ${workspace} failed in another test file: ${failure}`);
    if (Date.now() >= deadline) throw new Error(`timed out waiting for another test file to build ${workspace}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
