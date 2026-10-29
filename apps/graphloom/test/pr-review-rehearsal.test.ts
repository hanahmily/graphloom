// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createScope, createTaskWorkspace, exampleBundle, execFileAsync, goVersion, repoRoot } from "@graphloom/testkit";
import { check, rehearse, REHEARSAL_GITHUB_TOKEN_ENV } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const GO = goVersion();
const bundle = exampleBundle("pr-review");
const scope = createScope();

interface Fixture {
  REHEARSAL_REQUEST: string;
  REHEARSAL_HEAD_FILES: Record<string, string>;
}
let fixture: Fixture;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-pr-review"], { cwd: repoRoot });
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

/**
 * A repository that holds the head's files the scenarios' static metrics read
 * (the stubbed checkout writes none), a task naming the shipped BanyanDB
 * profile unmodified, as task preparation (wave 3: `graphloom task new`) will write it, and the
 * request the scenarios replay.
 */
async function ready() {
  const profile = JSON.parse(await readFile(path.join(bundle, "profiles", "banyandb.json"), "utf8")) as object;
  const env = await createTaskWorkspace(scope, {
    graph: "pr-review",
    repoName: "banyandb",
    files: { "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`, ...fixture.REHEARSAL_HEAD_FILES },
    config: { name: "profile.json", value: profile },
    request: fixture.REHEARSAL_REQUEST,
    bundle,
  });
  github = await startFakeGitHub({});
  const agents = await writeFakeCodingAgents(env.dir);
  savedPath = process.env.PATH;
  // The environment checks (go, git, claude, codex) read bare names off PATH, never the operator's runner config.
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

describe.skipIf(GO === undefined)("graphloom check and rehearse on pr-review with the BanyanDB profile, offline", () => {
  it("checks: the stage list, the recorded replies walked through the real validators, and the environment", async () => {
    const env = await ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    expect(report.supervisor).toMatchObject({ status: "selected", harness: "pi", source: "plugin" });
  }, 60_000);

  for (const scenario of ["happy", "report", "report-corrections", "injection", "complex-function", "sandbox-unavailable"]) {
    it(`reaches ready for the ${scenario} scenario: Fetch and Report accepted, then the run stops final at "report ready"`, async () => {
      const env = await ready();
      const report = await rehearse(env.taskPath, { scenario, offline: true, commands: "stub" });
      expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence, boundaries: report.boundaries })).toBe("ready");
      expect(report.convergence.actual.receipts.sort()).toEqual(["fetch", "report"]);
      expect(report.convergence.actual.stopReason).toBe("report ready");
      // Offline: the fake GitHub was never asked.
      expect(github!.requests).toEqual([]);
    }, 180_000);
  }
});
