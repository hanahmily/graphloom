// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRunState } from "@graphloom/controller";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createScope, createTaskWorkspace, exampleBundle, execFileAsync, goVersion, repoRoot } from "@graphloom/testkit";
import { check, rehearseStopAt, resumeRehearsal, REHEARSAL_GITHUB_TOKEN_ENV } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const GO = goVersion();
const bundle = exampleBundle("pr-design-review");
const scope = createScope();

interface Fixture {
  REHEARSAL_REQUEST: string;
  REHEARSAL_HEAD_FILES: Record<string, string>;
}
let fixture: Fixture;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-pr-design-review"], { cwd: repoRoot });
  fixture = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal.js")).href)) as Fixture;
}, 120_000);

let github: FakeGitHub | undefined;
let savedPath: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (savedPath !== undefined) process.env.PATH = savedPath;
  savedPath = undefined;
  await github?.close();
  github = undefined;
  await scope.dispose();
});

/** A repository holding the head's files the static metrics read, and a task naming the shipped BanyanDB profile unmodified. */
async function ready() {
  const profile = JSON.parse(await readFile(path.join(bundle, "profiles", "banyandb.json"), "utf8")) as object;
  const env = await createTaskWorkspace(scope, {
    graph: "pr-design-review",
    repoName: "banyandb",
    files: { "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`, ...fixture.REHEARSAL_HEAD_FILES },
    config: { name: "profile.json", value: profile },
    request: fixture.REHEARSAL_REQUEST,
    bundle,
  });
  github = await startFakeGitHub({});
  const agents = await writeFakeCodingAgents(env.dir);
  savedPath = process.env.PATH;
  process.env.PATH = `${agents.bin}:${savedPath}`;
  vi.stubEnv(GITHUB_API_URL_ENV, github.baseUrl);
  vi.stubEnv(REHEARSAL_GITHUB_TOKEN_ENV, "fake");
  const runnerConfigPath = path.join(env.dir, "runner.json");
  await writeFile(runnerConfigPath, JSON.stringify(fakeRunnerConfig(agents)));
  vi.stubEnv(RUNNER_CONFIG_ENV, runnerConfigPath);
  const supervisorConfigPath = path.join(env.dir, "supervisor.json");
  await writeFile(supervisorConfigPath, JSON.stringify({ provider: "minimax-cn", modelId: "MiniMax-M3" }));
  vi.stubEnv("GRAPHLOOM_SUPERVISOR_CONFIG", supervisorConfigPath);
  return env;
}

/** Every command job the run dispatched, by command id. */
async function commandIds(stateDir: string): Promise<string[]> {
  const state = await loadRunState(stateDir);
  return state.evidence.flatMap((e) => {
    const p = e.payload as { command?: { id?: unknown } } | undefined;
    return typeof p?.command?.id === "string" ? [p.command.id] : [];
  });
}

describe.skipIf(GO === undefined)("graphloom check and rehearse on pr-design-review with the BanyanDB profile, offline", () => {
  it("checks: the stage list, the recorded replies walked through the real validators, and the environment (no Docker check)", async () => {
    const env = await ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("docker-");
  }, 60_000);

  // The offline stand-in never writes to GitHub (rehearsal design §4.6): a run with open items stops once Round 1 is decided, since
  // posting them is the graph's one write. No Docker image is probed in any of them.
  for (const scenario of ["happy", "report", "report-corrections", "injection", "large-pull-request", "added-other", "other-corrected", "answer-finds-existing-feature", "answer-no-library-with-whole-repo-search", "answer-checker-contradicts", "needs-author-purpose", "purpose-stated", "necessity-unnecessary", "necessity-disputed", "necessity-necessary", "state-lifecycle"]) {
    it(`reaches Round 1 for the ${scenario} scenario with no Docker probe`, async () => {
      const env = await ready();
      const stopped = await rehearseStopAt(env.taskPath, "round1", { scenario, offline: true, commands: "stub" });
      expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
      const state = await loadRunState(stopped.stateDir);
      expect([...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))].sort()).toEqual(["answers", "fetch", "questions", "report", "round1"]);
      expect((await commandIds(stopped.stateDir)).filter((id) => id.startsWith("sandbox-") || id.startsWith("cover-") || id.startsWith("host-"))).toEqual([]);
      expect(github!.requests).toEqual([]);
    }, 180_000);
  }

  it("converges for a clean design review: Publish posts nothing, needs no GitHub write, and the run ends complete naming the PR review", async () => {
    const env = await ready();
    const stopped = await rehearseStopAt(env.taskPath, "publish", { scenario: "design-clean", offline: true, commands: "stub" });
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    const state = await loadRunState(stopped.stateDir);
    expect([...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))].sort()).toEqual(["answers", "fetch", "publish", "questions", "report", "round1"]);
    // Every stage is accepted: the graph's own last call ends the run complete, with the line that names the next command.
    const ended = await resumeRehearsal(stopped.stateDir);
    expect(ended.stopReason).toBe("complete");
    expect(ended.blocker).toBe("design review clean at 0123456; nothing posted. Next: graphloom task new pr-review apache/skywalking-banyandb#7 --profile banyandb");
    const ids = await commandIds(stopped.stateDir);
    expect(ids).toContain("ledger-published");
    expect(ids.filter((id) => id.startsWith("sandbox-") || id.startsWith("cover-"))).toEqual([]);
    expect(github!.requests).toEqual([]);
  }, 180_000);
});
