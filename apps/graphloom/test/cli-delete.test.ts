// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeCliEnv } from "./cli-env.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("graphloom delete", () => {
  it("deletes a stopped CLI run, discarding worktree changes only with --force", async () => {
    const env = await makeCliEnv(cleanups);
    await env.fakeClaude({ start: [{ error: "the model is unavailable" }] });

    const run = await env.graphloom("run", "task.yaml");
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stateDir: string; worktreePath: string };
    expect(report.status).toBe("stopped");
    await writeFile(path.join(report.worktreePath, "scratch.txt"), "x\n");

    const refused = await env.graphloom("delete", report.runId, "--state-root", "test-repo/graphloom-state");
    expect(refused.stderr).toContain(
      `cannot delete run ${report.runId}: its worktree has uncommitted changes (scratch.txt); pass force to discard them`,
    );
    expect(existsSync(report.worktreePath)).toBe(true);

    const deleted = await env.graphloom("delete", report.runId, "--state-root", "test-repo/graphloom-state", "--force");
    expect(JSON.parse(deleted.stdout)).toEqual({
      runId: report.runId,
      stateDir: report.stateDir,
      worktreePath: report.worktreePath,
      branch: `graphloom/${report.runId}`,
    });
    expect(existsSync(report.stateDir)).toBe(false);
    expect(existsSync(report.worktreePath)).toBe(false);
    expect(await env.git("branch", "--list", "graphloom/*")).toBe("");
  }, 60_000);
});
