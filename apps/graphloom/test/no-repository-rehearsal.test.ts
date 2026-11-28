// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNoRepositoryFixture, createScope } from "@graphloom/testkit";
import { runGate } from "../src/gate.js";
import { check, describeTask, rehearse } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const scope = createScope();
afterEach(async () => { vi.unstubAllEnvs(); await scope.dispose(); });

/** A task for a graph without a repository, with fake agent CLIs so B2 genuinely passes. */
async function fixture() {
  const f = await createNoRepositoryFixture(scope);
  const agents = await writeFakeCodingAgents(f.dir);
  const runnerConfig = path.join(f.dir, "runner.json");
  await writeFile(runnerConfig, JSON.stringify(fakeRunnerConfig(agents)));
  vi.stubEnv(RUNNER_CONFIG_ENV, runnerConfig);
  return f;
}

describe("check, rehearse and the gate for a graph without a repository", () => {
  it("checks a task that names no repo, and describes it", async () => {
    const f = await fixture();
    const report = await check(f.taskPath);
    expect(report.problems).toEqual([]);
    expect(report.definition?.graphId).toBe("tidy");
    const described = await describeTask(f.taskPath);
    expect(described.definition.graphId).toBe("tidy");
    expect(described.environment).toEqual([]);
  }, 30_000);

  it("rehearses on stand-ins to the converged run, leaving nothing beside the task and no repository behind", async () => {
    const f = await fixture();
    const verdict = await rehearse(f.taskPath);
    // The fixture graph runs no agent job, so the one boundary nothing exercised (B5) keeps the verdict from `ready`.
    expect(verdict.convergence).toMatchObject({ met: true, actual: { status: "succeeded", receipts: ["survey"] } });
    expect(Object.entries(verdict.boundaries).filter(([, b]) => b.status !== "passed").map(([id, b]) => `${id}:${b.status}`)).toEqual(["B5:unexercised"]);
    expect(verdict.verdict).toBe("inconclusive");
    // The temporary task the rehearsal writes beside the task is gone; no repository or state appeared there.
    expect((await readdir(f.taskDir)).sort()).toEqual(["plugins", "task.yaml"]);
    expect(await readFile(f.taskPath, "utf8")).not.toMatch(/^repo:/m);
  }, 60_000);

  it("gates a run: refused without a state root, and with one rehearses on the same fingerprint every time", async () => {
    const f = await fixture();
    await expect(runGate(f.taskPath)).rejects.toThrow("graph tidy works without a repository, so its runs have no default state root; pass --state-root <dir>");
    const first = await runGate(f.taskPath, { stateRoot: f.stateRoot });
    expect(first.fingerprint).not.toBe("");
    expect(first.notes.join("; ")).toContain("B5");
    const second = await runGate(f.taskPath, { stateRoot: f.stateRoot });
    expect(second.fingerprint).toBe(first.fingerprint);
  }, 90_000);
});
