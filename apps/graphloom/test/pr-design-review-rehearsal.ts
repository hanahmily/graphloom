// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The shared fixture of the pr-design-review rehearsal suite, split across pr-design-review-rehearsal.<group>.test.ts
// so vitest runs the scenarios in parallel; the smoke group runs on every pull request, the others in the full tier
// (test/tiers.ts).

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRunState } from "@graphloom/controller";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createScope, createTaskWorkspace, exampleBundle, goVersion } from "@graphloom/testkit";
import { rehearseStopAt, REHEARSAL_GITHUB_TOKEN_ENV } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { buildOnce } from "./build-once.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

export const GO = goVersion();
export const bundle = exampleBundle("pr-design-review");

interface Fixture {
  REHEARSAL_REQUEST: string;
  REHEARSAL_HEAD_FILES: Record<string, string>;
}

export interface Rehearsal {
  /** A repository holding the head's files the static metrics read, and a task naming the shipped BanyanDB profile unmodified. */
  ready(): Promise<Awaited<ReturnType<typeof createTaskWorkspace>>>;
  /** The fake GitHub of the current test. */
  github(): FakeGitHub;
}

/** Registers the suite's hooks in the calling test file and returns its fixture. */
export function useRehearsal(): Rehearsal {
  const scope = createScope();
  let fixture: Fixture;
  let github: FakeGitHub | undefined;
  let savedPath: string | undefined;

  beforeAll(async () => {
    await buildOnce("@graphloom/plugin-pr-design-review");
    fixture = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal.js")).href)) as Fixture;
  }, 120_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (savedPath !== undefined) process.env.PATH = savedPath;
    savedPath = undefined;
    await github?.close();
    github = undefined;
    await scope.dispose();
  });

  return {
    async ready() {
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
    },
    github() {
      if (github === undefined) throw new Error("ready() was not called");
      return github;
    },
  };
}

/** Every command job the run dispatched, by command id. */
export async function commandIds(stateDir: string): Promise<string[]> {
  const state = await loadRunState(stateDir);
  return state.evidence.flatMap((e) => {
    const p = e.payload as { command?: { id?: unknown } } | undefined;
    return typeof p?.command?.id === "string" ? [p.command.id] : [];
  });
}

export const SUITE = "graphloom check and rehearse on pr-design-review with the BanyanDB profile, offline";

/**
 * The test that a scenario reaches Round 1. The offline stand-in never writes to GitHub (rehearsal design §4.6): a
 * run with open items stops once Round 1 is decided, since posting them is the graph's one write. No Docker image is
 * probed in any of them.
 */
export function round1Test(rehearsal: Rehearsal, scenario: string): void {
  it(`reaches Round 1 for the ${scenario} scenario with no Docker probe`, async () => {
    const env = await rehearsal.ready();
    const stopped = await rehearseStopAt(env.taskPath, "round1", { scenario, offline: true, commands: "stub" });
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    const state = await loadRunState(stopped.stateDir);
    expect([...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))].sort()).toEqual(["answers", "fetch", "questions", "report", "round1"]);
    expect((await commandIds(stopped.stateDir)).filter((id) => id.startsWith("sandbox-") || id.startsWith("cover-") || id.startsWith("host-"))).toEqual([]);
    expect(rehearsal.github().requests).toEqual([]);
  }, 180_000);
}

/** A test file of Round 1 scenarios only. */
export function round1Scenarios(scenarios: string[]): void {
  const rehearsal = useRehearsal();
  describe.skipIf(GO === undefined)(SUITE, () => {
    for (const scenario of scenarios) round1Test(rehearsal, scenario);
  });
}
