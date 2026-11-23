// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// The shared fixture of the issue-fix rehearsal suite, split across issue-fix-rehearsal.<group>.test.ts so vitest runs
// the scenarios in parallel; the smoke group runs on every pull request, the others in the full tier (test/tiers.ts).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, vi } from "vitest";
import type { JobResult } from "@graphloom/runner";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createScope, createTaskWorkspace, goVersion, issueFixRepoFiles, ISSUE_FIX_ISSUE as ISSUE, repoRoot as root } from "@graphloom/testkit";
import { REHEARSAL_GITHUB_TOKEN_ENV } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

export const GO = goVersion();

export interface RehearsalEnv {
  dir: string;
  repo: string;
  taskPath: string;
}

/**
 * The testkit's Go module shaped like BanyanDB where it matters to the graph,
 * with the #14111 defect, the same one `issue-fix-e2e.test.ts` uses, except
 * CONTRIBUTING.md is the real repository's file, byte for byte: the shipped
 * banyandb profile (examples/plugins/issue-fix/profiles/banyandb.json) pins
 * that file's real sha256, and the task names that profile unmodified, so a
 * rehearsal runs the bundle's own `describe(config)`, pin included.
 */
async function makeEnv(scope: ReturnType<typeof createScope>, profileBudgets?: Record<string, number>): Promise<RehearsalEnv> {
  const contributing = await readFile(path.join(root, "examples/skywalking-banyandb/CONTRIBUTING.md"));
  // The config is the bundle's own shipped profile, as examples/issue-fix-banyandb-task.yaml names it;
  // with `profileBudgets`, a copy of it beside the task with those budgets instead.
  const shipped = "plugins/issue-fix/profiles/banyandb.json";
  const config =
    profileBudgets === undefined
      ? { name: shipped }
      : {
          name: "banyandb-budgets.json",
          value: { ...(JSON.parse(await readFile(path.join(root, "examples", shipped), "utf8")) as object), budgets: profileBudgets },
        };
  const env = await createTaskWorkspace(scope, {
    graph: "issue-fix",
    repoName: "banyandb",
    files: issueFixRepoFiles(GO!, contributing),
    config,
    request: `Fix apache/skywalking#${ISSUE}.`,
  });
  return { dir: env.dir, repo: env.repo.path, taskPath: env.taskPath };
}

/**
 * Stands in for open-code-review on PATH (same fixture as the e2e test): a
 * delegation mode that records where it ran and what changed, and a `node`
 * new enough for the environment check, since this fixture's own Makefile
 * never actually invokes it.
 */
async function fakeOcr(dir: string): Promise<string> {
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "ocr"),
    [
      "#!/bin/sh",
      // Records the environment every invocation sees, for the leak test (#187).
      `env >> ${JSON.stringify(path.join(dir, "ocr-env.txt"))}`,
      '[ "$1 $2" = "delegate preview" ] || exit 1',
      '[ "$3" = --help ] && exit 0',
      'echo \'{"mode":"workspace","reviewable_files":[]}\'',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // Fakes only the one thing the environment check asks of it (--version); anything
  // else (notably the Claude Code and Codex stand-ins' own #!/usr/bin/env node
  // shebang) must still reach the real interpreter, or they never actually run.
  await writeFile(
    path.join(bin, "node"),
    `#!/bin/sh\n[ "$1" = "--version" ] && { echo "v24.6.0"; exit 0; }\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

export interface Rehearsal {
  /** The fixture every test shares: a real environment, a fake GitHub, and the issue the banyandb profile's example is modeled on. */
  ready(profileBudgets?: Record<string, number>): Promise<RehearsalEnv>;
  /** The fake GitHub of the current test. */
  github(): FakeGitHub;
}

/** Registers the suite's hooks in the calling test file and returns its fixture. */
export function useRehearsal(): Rehearsal {
  const scope = createScope();
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

  return {
    async ready(profileBudgets) {
      const env = await makeEnv(scope, profileBudgets);
      github = await startFakeGitHub({
        issues: [{ number: ISSUE, title: "Scheduler reports long actions as timed out", state: "open", labels: ["bug"], body: "Backups over five minutes log action timed out." }],
      });
      github.comments.set(ISSUE, [{ id: 1, body: "A running backup is not an error; report it as running." }]);
      const ocrBin = await fakeOcr(env.dir);
      const agents = await writeFakeCodingAgents(env.dir);
      savedPath = process.env.PATH;
      // The environment check (go/git/ocr/node/claude/codex) reads bare names off
      // PATH directly, never the operator's own runner config — a fake claude/
      // codex here is what lets it pass regardless of what is actually installed.
      process.env.PATH = `${ocrBin}:${agents.bin}:${savedPath}`;
      // The plugin's ocr check prefers its bundled open-code-review to one on PATH; this names the stand-in.
      vi.stubEnv("GRAPHLOOM_OCR_BIN", path.join(ocrBin, "ocr"));
      vi.stubEnv(GITHUB_API_URL_ENV, github.baseUrl);
      vi.stubEnv(REHEARSAL_GITHUB_TOKEN_ENV, "fake");
      // B2's capability probe reads the operator's own runner config separately;
      // point it at the same fake binaries so it genuinely passes too.
      const runnerConfigPath = path.join(env.dir, "runner.json");
      await writeFile(runnerConfigPath, JSON.stringify(fakeRunnerConfig(agents)));
      vi.stubEnv(RUNNER_CONFIG_ENV, runnerConfigPath);
      // check reports the supervisor selection from the operator's supervisor config: a flat Pi one here, never the real one.
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

/** A runner that answers every probe dispatch with an empty, contract-valid code review. */
export function stubReviewResult(): JobResult {
  return {
    status: "ok",
    summary: "stubbed",
    runId: "probe",
    operationId: "op",
    generation: 1,
    evidence: [{ kind: "other", payload: { codingAgent: { output: { comments: [], prior: [], summary: { total_files: 0, reviewed_files: 0, skipped: [] } } } } }],
  };
}
