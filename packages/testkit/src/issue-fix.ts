import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JobSpec } from "@graphloom/sdk";
import type { JobContext, JobEvidenceItem } from "@graphloom/runner";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";
import { scriptedAgents, type AgentReply, type ScriptedAgents, type ScriptedAgentsOptions } from "./agents.js";
import { exampleBundle, execFileAsync } from "./git.js";
import type { TestScope } from "./scope.js";
import { createTaskWorkspace, type TaskWorkspace, type TaskWorkspaceOptions } from "./task.js";

/** The installed Go toolchain's version (`1.25.8`), or undefined without one. */
export function goVersion(): string | undefined {
  try {
    return execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim().replace(/^go/, "");
  } catch {
    return undefined;
  }
}

/** The issue the fixture repository has (modeled on apache/skywalking#14111). */
export const ISSUE_FIX_ISSUE = 14111;
export const ISSUE_FIX_TEST = "TestStatusWhileRunning";

const LICENSE = "// Licensed under the Apache License, Version 2.0.\n\n";
export const ISSUE_FIX_BUGGY = `${LICENSE}package timestamp\n\n// Status reports a scheduled action after it has run for minutes.\nfunc Status(minutes int, running bool) string {\n\tif minutes >= generatedLimit {\n\t\treturn "timed out"\n\t}\n\treturn "ok"\n}\n`;
export const ISSUE_FIX_FIXED = ISSUE_FIX_BUGGY.replace("\tif minutes >= generatedLimit {", "\tif running {\n\t\treturn \"running\"\n\t}\n\tif minutes >= generatedLimit {");
export const ISSUE_FIX_REGRESSION = `${LICENSE}package timestamp\n\nimport "testing"\n\nfunc ${ISSUE_FIX_TEST}(t *testing.T) {\n\tif got := Status(generatedLimit, true); got != "running" {\n\t\tt.Fatalf("Status = %q, want running", got)\n\t}\n}\n`;
export const ISSUE_FIX_CHANGES = "# Changes by Version\n\n## 0.12.0\n\n### Bug Fixes\n\n- Older fix.\n\n## 0.11.0\n\n- Old.\n";
const CHECK_MAKEFILE = [".PHONY: test", "test:", "\t@go version >/dev/null", ""].join("\n");
const NOOP_GENERATE = [".PHONY: generate", "generate:", "\t@true", ""].join("\n");
const PKG_GENERATE = [".PHONY: generate", "generate:", "\t@printf 'package timestamp\\n\\nconst generatedLimit = 5\\n' > timestamp/mock_limit.go", ""].join("\n");
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

/** A Go module shaped like BanyanDB where it matters to the issue-fix graph, with the #14111 defect. */
export function issueFixRepoFiles(go: string, contributing: string | Buffer = "# Contributing\n\nRun make check-req, then make generate.\n"): Record<string, string | Buffer> {
  return {
    "go.mod": `module example.com/banyandb\n\ngo ${go}\n`,
    ".gitignore": "mock_*.go\n",
    Makefile: MAKEFILE,
    // The banyandb profile runs generate per project (api, mcp, mocks in banyand and pkg), as BanyanDB's own `make generate` does.
    "api/Makefile": NOOP_GENERATE,
    "mcp/Makefile": NOOP_GENERATE,
    "banyand/Makefile": NOOP_GENERATE,
    "pkg/Makefile": PKG_GENERATE,
    "scripts/ci/check/Makefile": CHECK_MAKEFILE,
    "CONTRIBUTING.md": contributing,
    "CHANGES.md": ISSUE_FIX_CHANGES,
    "pkg/timestamp/scheduler.go": ISSUE_FIX_BUGGY,
  };
}

export const ISSUE_FIX_PLAN = {
  status: "ready",
  summary: "Report a running action as running at the timeout instead of timed out.",
  title: "Report long scheduled actions as running, not timed out",
  test: { package: "./pkg/timestamp", name: ISSUE_FIX_TEST, expectedValueSource: "the issue: a running backup is not an error" },
  productionCaller: "pkg/timestamp.Status",
  decisions: [
    { point: "What to report at the timeout", tier: "behaviour", options: ["timed out", "running"], chosen: "running", basis: "the maintainer's comment" },
    { point: "Whether the timeout metric still counts running actions", tier: "product", options: ["keep", "stop"], basis: "changes alerting" },
  ],
  openQuestions: ["Should the timeout metric keep counting running actions?"],
};

/** A low-severity review comment the reviewer leaves. */
export const ISSUE_FIX_LOW_FINDING = { path: "pkg/timestamp/scheduler.go", start_line: 5, end_line: 5, category: "style", severity: "low", content: "Name the constant." };
/** A false positive: the fix returns "running" before the limit check. The verifier refutes it. */
export const ISSUE_FIX_FALSE_POSITIVE = {
  path: "pkg/timestamp/scheduler.go",
  start_line: 10,
  end_line: 12,
  category: "bug",
  severity: "high",
  content: "A running action past the limit is still reported as timed out.",
  finding: "",
  evidence: "Status(generatedLimit, true) reaches the limit check.",
};

/** Agent locations as the operator's runner.json names them (shape of the CLI's RunnerConfig). */
export interface FakeAgentConfig {
  harness: "claude-code";
  harnesses: Array<"claude-code" | "codex">;
  allowUnrestricted: true;
  claude: { command: string; configDir: string };
  codex: { command: string; codexHome: string };
}

export interface IssueFixFixtureOptions extends Omit<TaskWorkspaceOptions, "graph" | "request" | "files" | "config"> {
  /** The task's request (default: fix the fixture's issue). */
  request?: string;
  /** CONTRIBUTING.md bytes; the profile pins whatever is used. */
  contributing?: string | Buffer;
}

export interface IssueFixFixture extends TaskWorkspace {
  go: string;
  github: FakeGitHub;
  /** Prepend to PATH for the run: open-code-review and a `node` the environment check accepts. */
  binDir: string;
  /** Lines `ocr` appends per call: its cwd, arguments and the files the worktree change touches. */
  ocrCalls: string;
  /** Lines the Claude Code and Codex stand-ins append per call. */
  agentCalls: string;
  agentConfig: FakeAgentConfig;
  /** The task config: the shipped banyandb profile, pinned to the fixture's CONTRIBUTING.md. */
  profile: Record<string, unknown>;
  contributingSha256: string;
  /** Scripted Claude Code and Codex agents for one run of this fixture (a fresh set per run or resume). */
  agents(options?: Omit<ScriptedAgentsOptions, "reply" | "executors">): ScriptedAgents;
}

/**
 * Everything one end-to-end issue-fix run needs, without a model or network:
 * the Go repository with the issue's defect, a task naming the shipped
 * banyandb profile (with its checklist pinned to the fixture's
 * CONTRIBUTING.md: a profile edit, not a code change), a fake GitHub with the
 * issue and its comment, stand-ins for open-code-review, Claude Code and
 * Codex, and scripted agents that plan, fix, review and verify. Requires Go.
 */
export async function createIssueFixFixture(scope: TestScope, options: IssueFixFixtureOptions = {}): Promise<IssueFixFixture> {
  const go = goVersion();
  if (go === undefined) throw new Error("the issue-fix fixture needs a Go toolchain on PATH");
  const files = issueFixRepoFiles(go, options.contributing);
  const contributingSha256 = createHash("sha256").update(files["CONTRIBUTING.md"]!).digest("hex");
  const shipped = JSON.parse(await readFile(path.join(exampleBundle("issue-fix"), "profiles", "banyandb.json"), "utf8")) as Record<string, unknown>;
  const environment = shipped.environment as Record<string, unknown>;
  const profile = { ...shipped, environment: { ...environment, pinnedFiles: [{ path: "CONTRIBUTING.md", sha256: contributingSha256 }] } };
  const workspace = await createTaskWorkspace(scope, {
    ...options,
    graph: "issue-fix",
    repoName: options.repoName ?? "banyandb",
    request: options.request ?? `Fix apache/skywalking#${ISSUE_FIX_ISSUE}.`,
    files,
    config: { name: "banyandb-fixture.json", value: profile },
  });

  const github = await startFakeGitHub({
    issues: [{ number: ISSUE_FIX_ISSUE, title: "Scheduler reports long actions as timed out", state: "open", labels: ["bug"], body: "Backups over five minutes log action timed out." }],
  });
  scope.defer(() => github.close());
  github.comments.set(ISSUE_FIX_ISSUE, [{ id: 1, body: "A running backup is not an error; report it as running." }]);

  const binDir = path.join(workspace.dir, "bin");
  const ocrCalls = path.join(workspace.dir, "ocr-calls");
  await mkdir(binDir);
  await writeFile(
    path.join(binDir, "ocr"),
    [
      "#!/bin/sh",
      '[ "$1 $2" = "delegate preview" ] || exit 1',
      '[ "$3" = --help ] && exit 0',
      `{ echo "cwd=$(pwd)"; echo "args=$*"; echo "changed=$(git status --porcelain | awk '{print $2}' | sort | tr '\\n' ' ')"; } >> "${ocrCalls}"`,
      'echo \'{"mode":"workspace","reviewable_files":[]}\'',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // Answers only the environment check's --version with a version it accepts;
  // anything else (a stand-in's own `#!/usr/bin/env node`) reaches the real interpreter.
  await writeFile(path.join(binDir, "node"), `#!/bin/sh\n[ "$1" = "--version" ] && { echo "v24.6.0"; exit 0; }\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });

  // The preflight still needs Claude Code and Codex installed and logged in.
  // They sit off PATH, as runner.json names them, logged in only in the login
  // directories runner.json names.
  const agentBin = path.join(workspace.dir, "agents");
  const agentCalls = path.join(workspace.dir, "agent-calls");
  await mkdir(agentBin);
  const claudeConfig = path.join(workspace.dir, "claude-config");
  const codexHome = path.join(workspace.dir, "codex-home");
  const stand = (name: string, loginVar: string, loginDir: string) =>
    writeFile(
      path.join(agentBin, name),
      `#!/bin/sh\necho "${name} $* ${loginVar}=$${loginVar}" >> "${agentCalls}"\n[ "$1" = --version ] || [ "$${loginVar}" = "${loginDir}" ]\n`,
      { mode: 0o755 },
    );
  await stand("claude", "CLAUDE_CONFIG_DIR", claudeConfig);
  await stand("codex", "CODEX_HOME", codexHome);
  const agentConfig: FakeAgentConfig = {
    harness: "claude-code",
    harnesses: ["claude-code", "codex"],
    allowUnrestricted: true,
    claude: { command: path.join(agentBin, "claude"), configDir: claudeConfig },
    codex: { command: path.join(agentBin, "codex"), codexHome },
  };

  return {
    ...workspace,
    go,
    github,
    binDir,
    ocrCalls,
    agentCalls,
    agentConfig,
    profile,
    contributingSha256,
    agents: (agentOptions = {}) => issueFixAgents(agentOptions),
  };
}

/**
 * Scripted Claude Code and Codex: the plan, an implementation that writes
 * the fix, its test and a changelog entry, a code review that runs the ocr
 * its assignment names in the worktree (one low comment and one false
 * positive), and a verifier that refutes the false positive.
 */
export function issueFixAgents(options: Omit<ScriptedAgentsOptions, "reply" | "executors"> = {}): ScriptedAgents {
  let session = 0;
  const done = (job: JobSpec, output: unknown, extra: JobEvidenceItem[] = []): AgentReply => ({
    status: "ok",
    summary: "done",
    sessionRef: `session-${++session}`,
    evidence: [{ kind: "other", payload: { codingAgent: { harness: (job.input as { harness?: string } | undefined)?.harness, status: "completed", output } } }, ...extra],
  });
  return scriptedAgents({
    ...options,
    executors: [{ id: "graphloom.coding-agent/run", digest: "scripted", source: "in-process", isolation: "in-process", builtin: false }],
    async reply(job: JobSpec, ctx: JobContext) {
      if (job.purpose === "review" && job.stageId === "review") {
        const ocr = /`(\S+) delegate preview --format json`/.exec((job.input as { assignment: string }).assignment)![1]!;
        await execFileAsync(ocr, ["delegate", "preview", "--format", "json"], { cwd: ctx.worktreePath });
        return done(job, { comments: [ISSUE_FIX_LOW_FINDING, ISSUE_FIX_FALSE_POSITIVE], prior: [], summary: { total_files: 3, reviewed_files: 3, skipped: [] } });
      }
      if (job.purpose === "diagnostic" && job.stageId === "review") {
        const quotes = [
          { path: "pkg/timestamp/scheduler.go", line: 7, text: "if running {" },
          { path: "pkg/timestamp/scheduler.go", line: 8, text: 'return "running"' },
        ];
        return done(job, { verdicts: [{ finding: "F1", verdict: "refuted", reason: "Status returns running before it checks the limit.", quotes }] });
      }
      if (job.purpose === "work") {
        const at = (p: string) => path.join(ctx.worktreePath, p);
        await writeFile(at("pkg/timestamp/scheduler.go"), ISSUE_FIX_FIXED);
        await writeFile(at("pkg/timestamp/status_test.go"), ISSUE_FIX_REGRESSION);
        await writeFile(at("CHANGES.md"), ISSUE_FIX_CHANGES.replace("- Older fix.\n", "- Older fix.\n- Report scheduled actions that are still running as running, not timed out.\n"));
      }
      return done(job, ISSUE_FIX_PLAN);
    },
  });
}
