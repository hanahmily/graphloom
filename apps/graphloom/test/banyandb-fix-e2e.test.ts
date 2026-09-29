import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GraphPlugin, JobSpec, Validator } from "@graphloom/sdk";
import { createBuiltinExecutorRunner, type JobContext, type JobResult, type Runner } from "@graphloom/runner";
import { createController, loadRunState } from "@graphloom/controller";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = path.join(repoRoot, "examples/plugins/banyandb-fix");
const ISSUE = 14111;
const TEST = "TestStatusWhileRunning";

function goVersion(): string | undefined {
  try {
    return execFileSync("go", ["env", "GOVERSION"], { encoding: "utf8" }).trim().replace(/^go/, "");
  } catch {
    return undefined;
  }
}
const GO = goVersion();

interface FixPlugin {
  createGraph(): GraphPlugin;
  validatorById(id: string): Validator | undefined;
}
let plugin: FixPlugin;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-banyandb-fix"], { cwd: repoRoot });
  plugin = (await import(pathToFileURL(path.join(bundle, "dist", "index.js")).href)) as FixPlugin;
}, 120_000);

const temps: string[] = [];
let github: FakeGitHub | undefined;
afterEach(async () => {
  await github?.close();
  github = undefined;
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

const LICENSE = "// Licensed under the Apache License, Version 2.0.\n\n";
const BUGGY = `${LICENSE}package timestamp\n\n// Status reports a scheduled action after it has run for minutes.\nfunc Status(minutes int, running bool) string {\n\tif minutes >= generatedLimit {\n\t\treturn "timed out"\n\t}\n\treturn "ok"\n}\n`;
const FIXED = BUGGY.replace("\tif minutes >= generatedLimit {", "\tif running {\n\t\treturn \"running\"\n\t}\n\tif minutes >= generatedLimit {");
const REGRESSION = `${LICENSE}package timestamp\n\nimport "testing"\n\nfunc ${TEST}(t *testing.T) {\n\tif got := Status(generatedLimit, true); got != "running" {\n\t\tt.Fatalf("Status = %q, want running", got)\n\t}\n}\n`;
const CHANGES = "# Changes by Version\n\n## 0.12.0\n\n### Bug Fixes\n\n- Older fix.\n\n## 0.11.0\n\n- Old.\n";
const MAKEFILE = [
  ".PHONY: check-req generate test-ci license-check build lint check",
  "check-req:",
  "\t@go version >/dev/null",
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

/** A Go module shaped like BanyanDB where it matters to the graph, with the #14111 defect. */
async function makeEnv() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-bydb-fix-"));
  temps.push(dir);
  const repo = path.join(dir, "banyandb");
  await mkdir(path.join(repo, "pkg", "timestamp"), { recursive: true });
  const files: Record<string, string> = {
    "go.mod": `module example.com/banyandb\n\ngo ${GO}\n`,
    ".gitignore": "mock_*.go\n",
    Makefile: MAKEFILE,
    "CONTRIBUTING.md": "# Contributing\n\nRun make check-req, then make generate.\n",
    "CHANGES.md": CHANGES,
    "pkg/timestamp/scheduler.go": BUGGY,
  };
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(repo, name), bytes);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q", "-b", "main");
  // Delivery commits as the repository's own identity, not a global one.
  await git("config", "user.email", "maintainer@example.com");
  await git("config", "user.name", "Maintainer");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");

  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, `graph: banyandb-fix\nrepo: ./banyandb\nrequest: ${JSON.stringify(`Fix apache/skywalking#${ISSUE}.`)}\n`);
  await mkdir(path.join(dir, "plugins"));
  await execFileAsync("ln", ["-s", bundle, path.join(dir, "plugins", "banyandb-fix")]);
  const contributing = createHash("sha256").update(files["CONTRIBUTING.md"]!).digest("hex");
  return { dir, repo, taskPath, stateRoot: path.join(dir, "state"), contributing };
}

/** The shipped graph, with the checklist pinned to the fixture's CONTRIBUTING.md instead of BanyanDB's. */
function fixtureGraph(contributing: string): GraphPlugin {
  const graph = plugin.createGraph();
  const definition = graph.describe();
  return {
    describe: () => ({
      ...definition,
      environment: { ...definition.environment, pinnedFiles: [{ path: "CONTRIBUTING.md", sha256: contributing }] },
    }),
    advance: (view) => graph.advance(view),
  };
}

const PLAN = {
  status: "ready",
  summary: "Report a running action as running at the timeout instead of timed out.",
  title: "Report long scheduled actions as running, not timed out",
  test: { package: "./pkg/timestamp", name: TEST, expectedValueSource: "the issue: a running backup is not an error" },
  productionCaller: "pkg/timestamp.Status",
  decisions: [
    { point: "What to report at the timeout", tier: "behaviour", options: ["timed out", "running"], chosen: "running", basis: "the maintainer's comment" },
    { point: "Whether the timeout metric still counts running actions", tier: "product", options: ["keep", "stop"], basis: "changes alerting" },
  ],
  openQuestions: ["Should the timeout metric keep counting running actions?"],
};

/**
 * Real command and GitHub executors, as the CLI composes them, with scripted
 * Claude Code and Pi agents: the plan, an implementation that writes the fix,
 * test and changelog entry, and an approving review.
 */
function fixRunner(baseUrl: string) {
  const agentJobs: JobSpec[] = [];
  let session = 0;
  const agent: Runner = {
    async describeExecutors() {
      return [{ id: "graphloom.coding-agent/run", digest: "scripted", source: "in-process", isolation: "in-process", builtin: false }];
    },
    async runJob(job: JobSpec, ctx: JobContext): Promise<JobResult> {
      agentJobs.push(job);
      const identity = { runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation };
      const done = (output: unknown, extra: JobResult["evidence"] = []): JobResult => ({
        status: "ok",
        summary: "done",
        sessionRef: `session-${++session}`,
        evidence: [{ kind: "other", payload: { codingAgent: { harness: (job.input as { harness: string }).harness, status: "completed", output } } }, ...extra],
        ...identity,
      });
      if (job.purpose === "review") {
        const verdict = { verdict: "approved", summary: "The fix and test match the issue; the metric question is listed." };
        return done(verdict, [{ kind: "review", payload: verdict }]);
      }
      if (job.purpose === "work") {
        const at = (p: string) => path.join(ctx.worktreePath, p);
        await writeFile(at("pkg/timestamp/scheduler.go"), FIXED);
        await writeFile(at("pkg/timestamp/status_test.go"), REGRESSION);
        await writeFile(at("CHANGES.md"), CHANGES.replace("- Older fix.\n", "- Older fix.\n- Report scheduled actions that are still running as running, not timed out.\n"));
      }
      return done(PLAN);
    },
  };
  const runner = createBuiltinExecutorRunner({
    packages: [
      { manifest: commandExecutorPackage, ...commandBinding() },
      { manifest: githubExecutorPackage, ...githubBinding({ baseUrl, token: "fake" }) },
    ],
    fallback: agent,
  });
  return { runner, agentJobs };
}

describe.skipIf(GO === undefined)("banyandb-fix on a Go repository", () => {
  it("checks the environment, fixes the issue with RED and GREEN proof, gets a review, and delivers a local branch", async () => {
    const env = await makeEnv();
    github = await startFakeGitHub({
      issues: [{ number: ISSUE, title: "Scheduler reports long actions as timed out", state: "open", labels: ["bug"], body: "Backups over five minutes log action timed out." }],
    });
    github.comments.set(ISSUE, [{ id: 1, body: "A running backup is not an error; report it as running." }]);
    const { runner, agentJobs } = fixRunner(github.baseUrl);
    const definition = fixtureGraph(env.contributing).describe();
    const validators = Object.fromEntries(definition.defaultValidators.map((b) => [b.validatorId, plugin.validatorById(b.validatorId)!]));

    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: fixtureGraph(env.contributing),
      validators,
      runner,
      stateRoot: env.stateRoot,
      runId: "bydb-14111",
    });

    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    const state = await loadRunState(report.stateDir);
    expect(state.receipts.filter((r) => r.valid).map((r) => `${r.stageId}/${r.requirementId}`)).toEqual([
      "fix/decisions-recorded",
      "fix/reproduces",
      "fix/passes",
      "fix/builds",
      "fix/in-scope",
      "fix/changelog-entry",
      "review/spec-and-standards-review",
    ]);
    expect(new Set(state.receipts.map((r) => r.candidateDigest))).toEqual(new Set([state.candidateDigest]));

    // The plan saw the issue and its comments; the implementer continued the plan's session.
    const [plan, implement, review] = agentJobs;
    expect((plan!.input as { assignment: string }).assignment).toContain("A running backup is not an error");
    expect(implement!.continueFrom).toBeDefined();
    expect(review!.input).toMatchObject({ harness: "pi" });

    // RED failed by assertion on the base with only the test; GREEN passed on the committed change.
    const command = (id: string) =>
      state.evidence.filter((e) => e.kind === "command" && (e.payload as { command?: { id?: string } }).command?.id === id && (e.payload as { checkout?: { phase?: string } }).checkout?.phase === "run");
    const [red] = command("regression").filter((e) => (e.payload as { checkout: { from: string } }).checkout.from === "base");
    expect(red!.payload).toMatchObject({ command: { exitCode: 1 }, checkout: { paths: ["pkg/timestamp/status_test.go"], prepared: true, mutations: [] } });
    expect((red!.payload as { command: { report: { text: string } } }).command.report.text).toContain('Status = \\"timed out\\", want running');
    for (const id of ["test-ci", "license-check", "build", "lint", "check"]) {
      expect(command(id).at(-1)!.payload, id).toMatchObject({ command: { exitCode: 0 }, checkout: { from: "candidate", mutations: [] } });
    }

    // Delivery: a local branch with the whole change and the PR description, and the worktree untouched.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: env.repo, encoding: "utf8" });
    expect(git("show", `fix/${ISSUE}:pkg/timestamp/scheduler.go`)).toBe(FIXED);
    expect(git("ls-tree", "-r", "--name-only", `fix/${ISSUE}`).split("\n")).not.toContain("pkg/timestamp/mock_limit.go");
    expect(git("log", "-1", "--format=%an <%ae>", `fix/${ISSUE}`).trim()).toBe("Maintainer <maintainer@example.com>");
    const message = git("log", "-1", "--format=%B", `fix/${ISSUE}`);
    expect(message).toMatch(/^Report long scheduled actions as running, not timed out\n/);
    expect(message).toContain(`Fixes apache/skywalking#${ISSUE}`);
    expect(message).toContain("Should the timeout metric keep counting running actions?");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: report.worktreePath, encoding: "utf8" })).toContain("M pkg/timestamp/scheduler.go");
    expect(await readFile(path.join(report.worktreePath, "pkg/timestamp/mock_limit.go"), "utf8")).toContain("generatedLimit");
    expect(github.requests.every((r) => r.method === "GET")).toBe(true);
  }, 600_000);
});
