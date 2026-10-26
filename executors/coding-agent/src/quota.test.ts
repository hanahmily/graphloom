// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutorContext } from "@graphloom/sdk";
import { createClaudeCodeHarness } from "./claude.js";
import { createCodingAgentExecutor } from "./run.js";

const fakeClaude = fileURLToPath(new URL("../test/fake-claude.mjs", import.meta.url));

describe("coding-agent executor on a usage limit (fake Claude Code)", () => {
  const temps: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
  });

  async function run(message: string, opts: { git?: boolean; before?: Array<Record<string, unknown>> } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-quota-"));
    temps.push(dir);
    const worktree = path.join(dir, "worktree");
    await mkdir(worktree);
    if (opts.git === true) execFileSync("git", ["-C", worktree, "init", "-q"]);
    const scriptFile = path.join(dir, "script.json");
    const logFile = path.join(dir, "log.jsonl");
    const bin = path.join(dir, "claude");
    await writeFile(bin, `#!/bin/sh\nexport FAKE_CLAUDE_SCRIPT="${scriptFile}" FAKE_CLAUDE_LOG="${logFile}"\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, "utf8");
    await chmod(bin, 0o755);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "claude-config"));
    await writeFile(scriptFile, JSON.stringify({ start: [...(opts.before ?? []), { limit: message }], resume: [] }), "utf8");
    const sleeps: number[] = [];
    const executor = createCodingAgentExecutor(createClaudeCodeHarness({ command: bin, killGraceMs: 500 }), {
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      sleep: async (ms) => (sleeps.push(ms), true),
    });
    const ctx: ExecutorContext = {
      runId: "r1",
      operationId: "op1",
      generation: 1,
      worktreePath: worktree,
      artifactDir: dir,
      usage: { reserveModelCall: async () => true },
    };
    const result = await executor.execute({ assignment: "work" }, ctx);
    const calls = existsSync(logFile) ? (await readFile(logFile, "utf8")).split("\n").filter(Boolean).length : 0;
    return { result, sleeps, calls };
  }

  it("reports failureKind quota with the parsed reset, without retrying in the executor", async () => {
    const reset = new Date(Date.now() + 10 * 60_000);
    reset.setUTCSeconds(0, 0);
    const hour = reset.getUTCHours() % 12 || 12;
    const clock = `${hour}:${String(reset.getUTCMinutes()).padStart(2, "0")}${reset.getUTCHours() >= 12 ? "pm" : "am"}`;
    const { result, sleeps, calls } = await run(`You've hit your session limit · resets ${clock} (UTC)`);
    expect(result).toMatchObject({ status: "failed", failureKind: "quota", resetAt: reset.toISOString() });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("reports failureKind quota without resetAt when the message states no reset", async () => {
    const { result } = await run("You've hit your session limit");
    expect(result).toMatchObject({ status: "failed", failureKind: "quota" });
    expect(result).not.toHaveProperty("resetAt");
  });

  it("reports whether the failed try may have had effects, so the controller does not repeat them", async () => {
    const limit = "You've hit your session limit";
    expect((await run(limit, { git: true })).result).toMatchObject({ failureKind: "quota", effects: "none" });
    expect((await run(limit, { git: true, before: [{ bash: "echo partial > PARTIAL.txt" }] })).result).toMatchObject({ failureKind: "quota", effects: "some" });
    // Not a git worktree: a change cannot be ruled out.
    expect((await run(limit)).result).toMatchObject({ failureKind: "quota", effects: "unknown" });
  });
});
