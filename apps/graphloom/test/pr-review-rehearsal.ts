// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The shared fixture of the pr-review rehearsal suite, split across pr-review-rehearsal.<group>.test.ts so vitest runs
// the scenarios in parallel; the smoke group runs on every pull request, the others in the full tier (test/tiers.ts).

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
export const bundle = exampleBundle("pr-review");

interface Fixture {
  REHEARSAL_REQUEST: string;
  REHEARSAL_REQUEST_NO_REPORT: string;
  REHEARSAL_HEAD_FILES: Record<string, string>;
}

export interface Rehearsal {
  /**
   * A repository that holds the head's files the scenarios' static metrics read
   * (the stubbed checkout writes none), a task naming the shipped BanyanDB
   * profile unmodified, as task preparation (wave 3: `graphloom task new`) will write it, and the
   * request the scenarios replay (`no-report`: the request `task new pr-review … --no-report` writes).
   */
  ready(request?: "no-report"): Promise<Awaited<ReturnType<typeof createTaskWorkspace>>>;
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
    await buildOnce("@graphloom/plugin-pr-review");
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
    async ready(request) {
      const profile = JSON.parse(await readFile(path.join(bundle, "profiles", "banyandb.json"), "utf8")) as object;
      const env = await createTaskWorkspace(scope, {
        graph: "pr-review",
        repoName: "banyandb",
        files: { "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`, ...fixture.REHEARSAL_HEAD_FILES },
        config: { name: "profile.json", value: profile },
        request: request === "no-report" ? fixture.REHEARSAL_REQUEST_NO_REPORT : fixture.REHEARSAL_REQUEST,
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
    },
    github() {
      if (github === undefined) throw new Error("ready() was not called");
      return github;
    },
  };
}

export const SUITE = "graphloom check and rehearse on pr-review with the BanyanDB profile, offline";

/**
 * The context source each context scenario's rule picks (design-pr-review-split §4.2): the prelude (no ledger), the
 * design review of this head, of an earlier head with a usable delta, of an earlier head whose delta is not usable
 * (back to the prelude), and no report (--no-report).
 */
export const CONTEXTS: Record<string, { source: string; reporter: boolean; request?: "no-report" }> = {
  prelude: { source: "prelude", reporter: true },
  "design-review": { source: "design-review", reporter: false },
  "design-review-earlier-head": { source: "design-review", reporter: false },
  "design-review-unusable-delta": { source: "prelude", reporter: true },
  "no-report": { source: "none", reporter: false, request: "no-report" },
};

// The offline stand-in never writes to GitHub (rehearsal design §4.6), so these runs stop once the Draft stage is
// accepted: after it the graph would publish its review, which is the one write the graph makes. The publish flow is
// covered by the plugin's own tests.

/** The test that a context scenario reaches Draft with the context source its rule chose. */
export function contextTest(rehearsal: Rehearsal, scenario: string): void {
  const want = CONTEXTS[scenario];
  if (want === undefined) throw new Error(`no context scenario ${scenario}`);
  it(`reaches Draft for the ${scenario} scenario with the ${want.source} context: Fetch, Report, Review and Draft accepted`, async () => {
    const env = await rehearsal.ready(want.request);
    const stopped = await rehearseStopAt(env.taskPath, "draft", { scenario, offline: true, commands: "stub" });
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    const state = await loadRunState(stopped.stateDir);
    expect([...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))].sort()).toEqual(["draft", "fetch", "report", "review"]);
    const commands = state.evidence.flatMap((e) => {
      const p = e.payload as { command?: { id?: unknown; argv?: unknown } } | undefined;
      return typeof p?.command?.id === "string" ? [{ id: p.command.id, argv: p.command.argv as string[] }] : [];
    });
    // The context record names the source the rule chose; a reporter runs only for the prelude.
    expect(commands.filter((c) => c.id.startsWith("context-json")).at(-1)?.argv.join(" ")).toContain(`"source":"${want.source}"`);
    expect(state.evidence.some((e) => (e as { resultSchema?: string }).resultSchema === "change-report-v1")).toBe(want.reporter);
    // The ledger's review section is written; nothing is written to GitHub offline.
    expect(commands.some((c) => c.id === "ledger-review-write")).toBe(true);
    expect(rehearsal.github().requests).toEqual([]);
  }, 180_000);
}

/** The test that a scenario reaches Draft. */
export function draftTest(rehearsal: Rehearsal, scenario: string): void {
  it(`reaches Draft for the ${scenario} scenario`, async () => {
    const env = await rehearsal.ready();
    const stopped = await rehearseStopAt(env.taskPath, "draft", { scenario, offline: true, commands: "stub" });
    expect(stopped.ok, JSON.stringify(stopped)).toBe(true);
    const state = await loadRunState(stopped.stateDir);
    expect([...new Set(state.receipts.filter((r) => r.valid).map((r) => r.stageId))].sort()).toEqual(["draft", "fetch", "report", "review"]);
    expect(rehearsal.github().requests).toEqual([]);
  }, 180_000);
}

/** A test file of scenarios: context scenarios (named in CONTEXTS) and plain Draft scenarios. */
export function scenarios(names: { contexts?: string[]; draft?: string[] }): void {
  const rehearsal = useRehearsal();
  describe.skipIf(GO === undefined)(SUITE, () => {
    for (const scenario of names.contexts ?? []) contextTest(rehearsal, scenario);
    for (const scenario of names.draft ?? []) draftTest(rehearsal, scenario);
  });
}
