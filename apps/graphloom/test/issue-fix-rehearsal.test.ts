import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSpec } from "@graphloom/sdk";
import type { JobResult } from "@graphloom/runner";
import { GITHUB_API_URL_ENV } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { check, probe, rehearse, REHEARSAL_GITHUB_TOKEN_ENV } from "../src/rehearsal.js";
import { RUNNER_CONFIG_ENV } from "../src/runner-config.js";
import { fakeRunnerConfig, writeFakeCodingAgents } from "./fixtures/fake-coding-agents.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ISSUE = 14111;

function goVersion(): string | undefined {
  try {
    return execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim().replace(/^go/, "");
  } catch {
    return undefined;
  }
}
const GO = goVersion();

const LICENSE = "// Licensed under the Apache License, Version 2.0.\n\n";
const BUGGY = `${LICENSE}package timestamp\n\n// Status reports a scheduled action after it has run for minutes.\nfunc Status(minutes int, running bool) string {\n\tif minutes >= generatedLimit {\n\t\treturn "timed out"\n\t}\n\treturn "ok"\n}\n`;
const CHANGES = "# Changes by Version\n\n## 0.12.0\n\n### Bug Fixes\n\n- Older fix.\n\n## 0.11.0\n\n- Old.\n";
const CHECK_MAKEFILE = [".PHONY: test", "test:", "\t@go version >/dev/null", ""].join("\n");
const MAKEFILE = [
  ".PHONY: generate test-ci license-check build lint check",
  // Like BanyanDB's mocks: generated, gitignored, and needed by the tests.
  "generate:",
  "\t@printf 'package timestamp\\n\\nconst generatedLimit = 5\\n' > pkg/timestamp/mock_limit.go",
  "test-ci:",
  "\tgo test -count=1 $(PKG)",
  "license-check:",
  "\t@for f in $$(git ls-files '*.go'); do head -1 $$f | grep -q '^// Licensed' || { echo \"$$f: no license header\" >&2; exit 1; }; done",
  "build:",
  "\tgo build ./...",
  "lint:",
  "\tgo vet ./...",
  "check:",
  "\tgofmt -w $$(git ls-files '*.go')",
  "\t@test -z \"$$(git status --porcelain)\" || { git status --porcelain >&2; exit 1; }",
  "",
].join("\n");

/**
 * A Go module shaped like BanyanDB where it matters to the graph, with the
 * #14111 defect — the same fixture `issue-fix-e2e.test.ts` builds, except
 * CONTRIBUTING.md is the real repository's file, byte for byte: the shipped
 * banyandb profile (examples/plugins/issue-fix/profiles/banyandb.json) pins
 * that file's real sha256, and the task names that profile unmodified, so a
 * rehearsal runs the bundle's own `describe(config)`, pin included.
 */
async function makeEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-issue-fix-rehearsal-"));
  const repo = path.join(dir, "banyandb");
  await mkdir(path.join(repo, "pkg", "timestamp"), { recursive: true });
  await mkdir(path.join(repo, "scripts", "ci", "check"), { recursive: true });
  const contributing = await readFile(path.join(root, "examples/skywalking-banyandb/CONTRIBUTING.md"));
  const files: Record<string, string | Buffer> = {
    "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`,
    ".gitignore": "mock_*.go\n",
    Makefile: MAKEFILE,
    "scripts/ci/check/Makefile": CHECK_MAKEFILE,
    "CONTRIBUTING.md": contributing,
    "CHANGES.md": CHANGES,
    "pkg/timestamp/scheduler.go": BUGGY,
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(repo, name), bytes);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "maintainer@example.com");
  await git("config", "user.name", "Maintainer");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");

  const taskPath = path.join(dir, "task.yaml");
  // The config is the bundle's own shipped profile, as examples/issue-fix-banyandb-task.yaml names it.
  await writeFile(taskPath, `graph: issue-fix\nrepo: ./banyandb\nconfig: plugins/issue-fix/profiles/banyandb.json\nrequest: ${JSON.stringify(`Fix apache/skywalking#${ISSUE}.`)}\n`);
  await mkdir(path.join(dir, "plugins"));
  await execFileAsync("ln", ["-s", path.join(root, "examples/plugins/issue-fix"), path.join(dir, "plugins", "issue-fix")]);
  return { dir, repo, taskPath };
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

const temps: string[] = [];
let github: FakeGitHub | undefined;
let savedPath: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (savedPath !== undefined) process.env.PATH = savedPath;
  savedPath = undefined;
  await github?.close();
  github = undefined;
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

/** The fixture both tests share: a real environment, a fake GitHub, and the issue the banyandb profile's example is modeled on. */
async function ready() {
  const env = await makeEnv();
  temps.push(env.dir);
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
  vi.stubEnv(GITHUB_API_URL_ENV, github.baseUrl);
  vi.stubEnv(REHEARSAL_GITHUB_TOKEN_ENV, "fake");
  // B2's capability probe reads the operator's own runner config separately;
  // point it at the same fake binaries so it genuinely passes too.
  const runnerConfigPath = path.join(env.dir, "runner.json");
  await writeFile(runnerConfigPath, JSON.stringify(fakeRunnerConfig(agents)));
  vi.stubEnv(RUNNER_CONFIG_ENV, runnerConfigPath);
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
  }, 120_000);

  it("walks the banyandb profile's recorded replies through its real validators at L0, finding nothing a real dispatch would not", async () => {
    const env = await ready();
    const report = await check(env.taskPath);
    expect(report.ok, JSON.stringify(report.problems)).toBe(true);
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
