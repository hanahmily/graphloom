// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubPaths, loadHubConfig } from "../src/hub-config.js";
const folders: string[] = [];
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function config(value: unknown) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gl-hub-config-")); folders.push(directory);
  const file = path.join(directory, "hub.json"); await writeFile(file, JSON.stringify(value)); return { directory, file };
}

describe("hub configuration", () => {
  it("resolves private local paths and permits zero admission with bounded retry policy", async () => {
    const { directory, file } = await config({ directory: "state", socket: "hub.sock", cgroupRoot: "delegated", maxConcurrentRuns: 0, runnerConfig: "runner.json", retry: { automatic: false, maxAutomaticResumes: 0 } });
    const loaded = await loadHubConfig(file);
    expect(loaded).toMatchObject({ directory: path.join(directory, "state"), socket: path.join(directory, "hub.sock"), cgroupRoot: path.join(directory, "delegated"), maxConcurrentRuns: 0, runnerConfig: path.join(directory, "runner.json"), retry: { automatic: false, maxAutomaticResumes: 0 } });
  });
  it.each([
    { remote: "0.0.0.0" }, { maxConcurrentRuns: "3" }, { maxConcurrentRuns: -1 }, { retry: { extra: true } },
    { retry: { automatic: "false" } }, { retry: { baseDelayMs: 5000, maxDelayMs: 1000 } },
    { pollIntervalMs: 0 }, { socket: "x".repeat(150) }, { directory: "bad\0path" }, [], null,
  ])("rejects invalid settings %j", async value => {
    const { file } = await config(value); await expect(loadHubConfig(file)).rejects.toThrow();
  });
  it("uses explicit XDG/environment paths without borrowing the real operator home", () => {
    expect(hubPaths({ HOME: "/private", XDG_RUNTIME_DIR: "/runtime", XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/config" })).toEqual({ directory: "/state/graphloom/hub", socket: "/runtime/graphloom/hub.sock", config: "/config/graphloom/hub.json" });
    expect(hubPaths({ HOME: "/private", GRAPHLOOM_HUB_STATE: "/override-state", GRAPHLOOM_HUB_SOCKET: "/override.sock" }).socket).toBe("/override.sock");
  });
});
