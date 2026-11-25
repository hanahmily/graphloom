// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drainRunContainers, withDockerConfinement } from "./sandbox-docker.js";
import { createChildExecutorRunner } from "./registry.js";
import type { Runner } from "./types.js";

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function docker(script: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-docker-drain-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "docker"), `#!/bin/sh\n${script}\n`);
  await chmod(path.join(dir, "docker"), 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
  vi.stubEnv("MANAGED_DOCKER_FIXTURE", dir);
  return dir;
}

const inert: Runner = {
  async runJob() { throw new Error("no jobs in cleanup tests"); },
  managed: { async check() { return undefined; }, async drain() { return { drained: true, resources: [] }; } },
};

describe("managed external execution cleanup", () => {
  it("verifies container absence after removal, instead of trusting rm exit alone", async () => {
    const dir = await docker('printf "%s\\n" "$*" >> "$MANAGED_DOCKER_FIXTURE/calls"\nif [ "$1" = ps ]; then\n  if [ ! -f "$MANAGED_DOCKER_FIXTURE/removed" ]; then printf "abc123\\n"; fi\nelse touch "$MANAGED_DOCKER_FIXTURE/removed"; fi');
    expect(await drainRunContainers("run-1")).toEqual({ drained: true, resources: [] });
    expect((await readFile(path.join(dir, "calls"), "utf8")).trim().split("\n")).toEqual([
      "ps -aq --filter label=graphloom.run=run-1", "rm -f -v abc123", "ps -aq --filter label=graphloom.run=run-1",
    ]);
  });

  it("keeps drainage uncertain for daemon errors and containers remaining after rm", async () => {
    await docker('printf "daemon unavailable\\n" >&2\nexit 1');
    expect(await drainRunContainers("run-1")).toMatchObject({ drained: false });
    vi.unstubAllEnvs();
    await docker('if [ "$1" = ps ]; then printf "still-running\\n"; fi');
    expect(await drainRunContainers("run-1")).toEqual({ drained: false, resources: ["docker:still-running"] });
  });

  it("consults the durable Docker inventory after a restart", async () => {
    const dir = await docker('printf "daemon unavailable\\n" >&2\nexit 1');
    const wrapped = withDockerConfinement(inert);
    expect(await wrapped.managed!.check(dir)).toBeUndefined();
    expect(await wrapped.managed!.drain("run", dir)).toEqual({ drained: true, resources: [] });
    await writeFile(path.join(dir, "managed-docker.used"), "run");
    const restarted = withDockerConfinement(inert);
    expect(await restarted.managed!.drain("run", dir)).toMatchObject({ drained: false });
  });

  it("refuses unregistered external execution contracts", async () => {
    const dir = await docker("exit 0");
    const child = createChildExecutorRunner({ entryModule: path.join(dir, "executor.mjs"), executorIds: ["custom/run"], fallback: inert });
    expect(await child.managed!.check(dir)).toContain("no managed external cleanup contract");
    expect(await child.managed!.drain("run", dir)).toMatchObject({ drained: false });
  });
});
