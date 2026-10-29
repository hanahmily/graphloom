// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOwnStateDirs } from "./registry.js";

const own = {
  env: ["GRAPHLOOM_CLAUDE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "GRAPHLOOM_CODEX_HOME", "CODEX_HOME"],
  homeRelative: [".claude", ".claude.json", ".codex"],
};

describe("resolveOwnStateDirs", () => {
  let dir: string;
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function setup(): Promise<{ home: string; tetrate: string }> {
    dir = await mkdtemp(path.join(os.tmpdir(), "gl-own-state-"));
    const home = path.join(dir, "home");
    const tetrate = path.join(home, ".claude-tetrate");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(tetrate, { recursive: true });
    await writeFile(path.join(home, ".claude.json"), "{}");
    return { home, tetrate };
  }

  it("keeps the dir the harness falls back to through CLAUDE_CONFIG_DIR, not only the GRAPHLOOM_ name", async () => {
    const { home, tetrate } = await setup();
    const dirs = resolveOwnStateDirs(own, { CLAUDE_CONFIG_DIR: tetrate }, home);
    expect(dirs).toContain(tetrate);
    expect(dirs).toContain(path.join(home, ".claude"));
  });

  it("keeps Claude Code's default account file beside its dir", async () => {
    const { home } = await setup();
    expect(resolveOwnStateDirs(own, {}, home)).toContain(path.join(home, ".claude.json"));
  });

  it("drops paths that do not exist and names a path once", async () => {
    const { home, tetrate } = await setup();
    const dirs = resolveOwnStateDirs(own, { GRAPHLOOM_CLAUDE_CONFIG_DIR: tetrate, CLAUDE_CONFIG_DIR: tetrate, CODEX_HOME: path.join(home, "missing") }, home);
    expect(dirs.filter((d) => d === tetrate)).toHaveLength(1);
    expect(dirs).not.toContain(path.join(home, "missing"));
    expect(dirs).not.toContain(path.join(home, ".codex"));
  });

  it("keeps nothing for an executor that declares no own state", () => {
    dir = os.tmpdir();
    expect(resolveOwnStateDirs(undefined, { CLAUDE_CONFIG_DIR: "/x" })).toEqual([]);
    dir = "";
  });
});
