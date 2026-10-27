// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import type { JobResult } from "@graphloom/runner";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { createScope, createTaskWorkspace, goVersion, issueFixRepoFiles, ISSUE_FIX_ISSUE as ISSUE, repoRoot as root } from "@graphloom/testkit";
import { check, probe, rehearse, REHEARSAL_GITHUB_TOKEN_ENV } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const GO = goVersion();
const scope = createScope();

/**
 * The testkit's Go module shaped like BanyanDB where it matters to the graph,
 * with the #14111 defect, the same one `issue-fix-e2e.test.ts` uses, except
 * CONTRIBUTING.md is the real repository's file, byte for byte: the shipped
 * banyandb profile (examples/plugins/issue-fix/profiles/banyandb.json) pins
 * that file's real sha256, and the task names that profile unmodified, so a
 * rehearsal runs the bundle's own `describe(config)`, pin included.
 */
async function makeEnv(profileBudgets?: Record<string, number>) {
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

/** The fixture both tests share: a real environment, a fake GitHub, and the issue the banyandb profile's example is modeled on. */
async function ready(profileBudgets?: Record<string, number>) {
  const env = await makeEnv(profileBudgets);
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
}

describe.skipIf(GO === undefined)("graphloom rehearse (L1) on issue-fix with the banyandb profile", () => {
  // Full mode (--commands run): Fix's RED/GREEN validators need the same
  // command id ("regression") to behave differently per checkout (fail on
  // the base commit, pass on the candidate) — quick mode's one stubbed
  // result per command id (docs/design-graph-rehearsal.md §3.2) cannot
  // represent that, so this plugin's own Fix stage is not quick-mode
  // rehearsable yet.
  it("reaches ready for the happy scenario, across all three coding harnesses", async () => {
    const env = await ready();
    const report = await rehearse(env.taskPath, { commands: "run" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    expect(report.convergence.actual.receipts.sort()).toEqual(["fix", "review"]);
    // The rehearsal run pinned the harness issue-fix's preference picks among stand-ins for all three (S5).
    expect(report.supervisorSelection).toEqual({
      harness: "pi",
      source: "plugin",
      reason: "the plugin's preference (pi, claude-code, codex): pi; a scripted stand-in answers for it",
    });
  }, 120_000);

  // #193: a review that fails once on a confirmed finding is the graph's own
  // known correction. The scenario scripts no supervisor decision, so a
  // supervisor episode would stop the run (or enter recovery, which B7 flags)
  // and the verdict could not be ready.
  it("reenters Fix itself when review confirms a finding once, and reaches delivery with no supervisor episode (#193)", async () => {
    const env = await ready();
    const report = await rehearse(env.taskPath, { commands: "run", scenario: "review-reenters" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    expect(report.boundaries.B7.status).toBe("passed");
    expect(report.convergence.actual.receipts.sort()).toEqual(["fix", "review"]);
  }, 180_000);

  it("never lets a command the graph runs see the variables that configure the stand-ins (#187)", async () => {
    const env = await ready();
    const report = await rehearse(env.taskPath, { commands: "run" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    const seen = await readFile(path.join(env.dir, "ocr-env.txt"), "utf8");
    expect(seen).toMatch(/^PATH=/m); // the check really ran, and with the operator's environment
    expect(seen).not.toMatch(/GRAPHLOOM_REHEARSAL/);
  }, 120_000);

  it("walks the banyandb profile's recorded replies through its real validators at L0, finding nothing a real dispatch would not", async () => {
    const env = await ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
    // The selection run would make: issue-fix prefers pi, which the flat Pi config enables.
    expect(report.supervisor).toEqual({ status: "selected", harness: "pi", source: "plugin", reason: "the plugin's preference (pi, claude-code, codex): pi", warnings: [] });
  }, 30_000);

  it("--offline never asks the real (fake) GitHub, and reports the unrecorded read as unverified under B2", async () => {
    const env = await ready();
    // The go-test scenario declares no `reads` at all (§4.5 has not
    // recorded one yet): every dispatched read is unrecorded by construction,
    // which is exactly the gap --offline exists to report rather than hide.
    const report = await rehearse(env.taskPath, { offline: true });
    expect(github!.requests).toEqual([]);
    expect(report.substituted.some((s) => s.startsWith("github: rehearsal stand-in"))).toBe(true);
    expect(report.boundaries.B2.status).toBe("unverified");
    expect(report.boundaries.B2.notes.some((n) => n.startsWith("offline: no recorded read for graphloom.github/"))).toBe(true);
  }, 30_000);
});

describe.skipIf(GO === undefined)("rehearsal under a profile that declares a live recoveryReserve (#151 review)", () => {
  // A live run's reserve (90 of 1,800) does not fit a rehearsal's 24 calls:
  // the generated task names a reserve of its own.
  const LIVE = { agentInvocations: 1800, recoveryReserve: 90 };

  it("checks, rehearses and probes successfully", async () => {
    const env = await ready(LIVE);
    const checked = await check(env.taskPath);
    expect(checked.ok, JSON.stringify(checked.problems)).toBe(true);
    const report = await rehearse(env.taskPath, { commands: "run" });
    expect(report.verdict, JSON.stringify({ blocker: report.blocker, convergence: report.convergence })).toBe("ready");
    const fakeRunner = {
      async runJob(): Promise<JobResult> {
        return {
          status: "ok",
          summary: "stubbed",
          runId: "probe",
          operationId: "op",
          generation: 1,
          evidence: [{ kind: "other", payload: { codingAgent: { output: { comments: [], prior: [], summary: { total_files: 0, reviewed_files: 0, skipped: [] } } } } }],
        };
      },
    };
    const probed = await probe(env.taskPath, { contract: "code-review-v2", commands: "run" }, fakeRunner);
    expect(probed.status).toBe("ok");
  }, 240_000);
});

describe.skipIf(GO === undefined)("graphloom probe (L3) on issue-fix with the banyandb profile", () => {
  it("dispatches code-review-v2 to the codex harness the graph actually uses, not the runner's default", async () => {
    const env = await ready();
    const jobs: JobSpec[] = [];
    const fakeRunner = {
      async runJob(job: JobSpec): Promise<JobResult> {
        jobs.push(job);
        return {
          status: "ok",
          summary: "stubbed",
          runId: "probe",
          operationId: "op",
          generation: 1,
          evidence: [{ kind: "other", payload: { codingAgent: { output: { comments: [], prior: [], summary: { total_files: 0, reviewed_files: 0, skipped: [] } } } } }],
        };
      },
    };
    // Note: the runner's own default harness is "claude-code" (~/.config/graphloom/runner.json
    // is irrelevant here anyway, since this test supplies its own fake), so a probe that silently
    // fell back to a default instead of reading the real dispatch's harness would still "succeed"
    // here with the wrong harness recorded — the assertion below is what actually catches that.
    // Full mode: probe's own internal rehearsal must reach the Review stage, which
    // needs Fix's RED/GREEN checks to behave for real (see the rehearse test above).
    const report = await probe(env.taskPath, { contract: "code-review-v2", commands: "run" }, fakeRunner);
    expect(report.status).toBe("ok");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.input).toMatchObject({ harness: "codex" });
  }, 120_000);
});
