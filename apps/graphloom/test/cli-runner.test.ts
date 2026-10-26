// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRunState } from "@graphloom/controller";
import { createCliRunner, isEnvironmentDispatch } from "../dist/cli-runner.js";
import { loadRunnerConfig, parseRunnerConfig } from "../src/runner-config.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(root, "apps/graphloom/dist/main.js");
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(badReview = false, live = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-cli-runner-"));
  dirs.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  await execFileAsync("git", ["init", "-q"], { cwd: repo });
  await execFileAsync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  await mkdir(path.join(dir, "plugins"));
  await symlink(path.join(root, "examples/plugins/hello"), path.join(dir, "plugins/hello"));
  await writeFile(path.join(dir, "task.yaml"), "graph: hello\nrepo: ./repo\nrequest: Create GREETING.txt.\n");
  const command = path.join(dir, "agent.mjs");
  await writeFile(command, await readFile(path.join(root, "apps/graphloom/test/fixtures/cli-agent.mjs")));
  await chmod(command, 0o700);
  const config = path.join(dir, "runner.json");
  await writeFile(config, JSON.stringify({ harness: "claude-code", allowUnrestricted: true, claude: { command, passEnv: ["GRAPHLOOM_TEST_BAD_REVIEW", "GRAPHLOOM_TEST_LIVE_DIR"] } }));
  const { GRAPHLOOM_SUPERVISOR_CONFIG: _supervisor, CLAUDE_CONFIG_DIR: _claude, ...inherited } = process.env;
  const env = { ...inherited, HOME: dir, GRAPHLOOM_RUNNER_CONFIG: config, GRAPHLOOM_TEST_BAD_REVIEW: badReview ? "1" : "0", GRAPHLOOM_TEST_LIVE_DIR: live ? path.join(dir, "live") : "" };
  const run = () => execFileAsync(process.execPath, [cli, "run", "task.yaml"], { cwd: dir, env }).catch((err: { stdout: string; stderr: string }) => err);
  return { dir, repo, config, env, run };
}

async function eventually<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the live CLI run");
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
}

describe("configured CLI runner", () => {
  it("stops an active agent from another CLI process before reporting that the run stopped", async () => {
    const f = await fixture(false, true);
    const running = execFileAsync(process.execPath, [cli, "run", "task.yaml"], { cwd: f.dir, env: f.env, timeout: 25_000 });
    const completion = running.catch((err: { stdout: string; stderr: string }) => err);
    let agentPid: number | undefined;
    try {
      const live = await eventually(async () => {
        const raw = await readFile(path.join(f.env.GRAPHLOOM_TEST_LIVE_DIR, "running.json"), "utf8").catch(() => undefined);
        try { return raw === undefined ? undefined : JSON.parse(raw) as { pid: number; cwd: string }; } catch { return undefined; }
      });
      agentPid = live.pid;
      expect(processExists(agentPid)).toBe(true);
      const stateRoot = path.join(f.repo, "graphloom-state");
      const stateDir = await eventually(async () => {
        for (const name of await readdir(stateRoot)) {
          const candidate = path.join(stateRoot, name);
          const state = await loadRunState(candidate).catch(() => undefined);
          if (state?.status === "running") return candidate;
        }
        return undefined;
      });
      const stopped = await execFileAsync(process.execPath, [cli, "stop", stateDir], { cwd: f.dir, env: f.env, timeout: 15_000 });
      expect(JSON.parse(stopped.stdout).status).toBe("stopped");
      expect(processExists(agentPid)).toBe(false);
      expect(await readFile(path.join(f.env.GRAPHLOOM_TEST_LIVE_DIR, "interrupted"), "utf8")).toBe("interrupt received\n");
      const heartbeat = await readFile(path.join(f.env.GRAPHLOOM_TEST_LIVE_DIR, "heartbeat"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await readFile(path.join(f.env.GRAPHLOOM_TEST_LIVE_DIR, "heartbeat"), "utf8")).toBe(heartbeat);
      const result = await completion;
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).status).toBe("stopped");
      await expect(stat(path.join(stateDir, "run.owner.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const state = await loadRunState(stateDir);
      const sessionDir = state.pendingDispatch?.session?.dir;
      expect(sessionDir).toBeDefined();
      const transcripts = (await readdir(sessionDir!)).filter((name) => name.endsWith(".jsonl"));
      expect(transcripts).toHaveLength(1);
      expect(await readFile(path.join(sessionDir!, transcripts[0]!), "utf8")).toContain("Interrupted live turn");
      const resumed = await execFileAsync(process.execPath, [cli, "resume", stateDir], {
        cwd: f.dir, env: { ...f.env, GRAPHLOOM_TEST_LIVE_DIR: "" }, timeout: 15_000,
      }).catch((err: { stdout: string; stderr: string }) => err);
      expect(JSON.parse(resumed.stdout).status, resumed.stdout || resumed.stderr).toBe("succeeded");
    } finally {
      if (agentPid !== undefined && processExists(agentPid)) process.kill(-agentPid, "SIGKILL");
      if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
      await completion;
    }
  }, 40_000);

  it("shows the supervisor what a coding-agent job's input must carry, and refuses {prompt} naming the field", async () => {
    // A live supervisor sent input {prompt: "..."} and was refused with no reason.
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(f.dir, "claude"));
    const runner = createCliRunner(await loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: f.config }));
    const coding = (await runner.describeExecutors!()).find((entry) => entry.id === "graphloom.coding-agent/run")!;
    const schema = coding.inputShape!.schema as { required: string[]; properties: Record<string, { enum?: string[] }> };
    expect(schema.required).toEqual(["assignment"]);
    // The harness choice is the router's to take out, so it is part of what the job sends.
    expect(schema.properties.harness?.enum).toContain("claude-code");
    expect(coding.inputShape!.example).toEqual({ assignment: expect.any(String) });
    const job = (input: unknown) => ({
      stageId: "write", kind: "agent" as const, purpose: "work" as const, instruction: "unused",
      executor: { id: coding.id, version: "1", digest: coding.digest }, input,
    });
    expect(await runner.checkJob!(job({ prompt: "Create GREETING.txt" }))).toBe(
      "executor graphloom.coding-agent/run: input failed schema validation: assignment: required",
    );
    expect(await runner.checkJob!(job({ harness: "claude-code", assignment: "Create GREETING.txt" }))).toBeUndefined();
  });

  it("serves an explicit coding-agent pin and refuses unknown IDs and changed pinned bytes", async () => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(f.dir, "claude"));
    const runner = createCliRunner(await loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: f.config }));
    const catalog = await runner.describeExecutors!();
    const coding = catalog.find((entry) => entry.id === "graphloom.coding-agent/run")!;
    expect(coding.isolation).toBe("unrestricted");
    expect(coding.source).toBe(path.join(root, "executors/coding-agent"));
    expect(catalog.find((entry) => entry.id === "graphloom.agent/run")?.source).toBe(coding.source);
    // The alias takes its assignment from the instruction, so it advertises no input shape.
    expect(catalog.find((entry) => entry.id === "graphloom.agent/run")?.inputShape).toBeUndefined();
    expect(coding.inputShape).toBeDefined();
    let calls = 0;
    const context = {
      runId: "direct", operationId: "op", generation: 1, worktreePath: f.repo, artifactDir: f.dir,
      children: { callTool: async () => ({ status: "failed" as const, summary: "no tools" }), reserveModelCall: async () => { calls += 1; return true; } },
    };
    const job = {
      stageId: "write", kind: "agent" as const, purpose: "work" as const, instruction: "Unused for an explicit executor input",
      executor: { id: coding.id, version: "1", digest: coding.digest }, input: { assignment: "Create GREETING.txt", resultSchema: "writer-result-v1" },
    };
    expect(await runner.runJob({ ...job, executor: { ...job.executor, digest: "0".repeat(64) } }, context))
      .toMatchObject({ status: "failed", summary: expect.stringContaining("does not match pinned") });
    expect(calls).toBe(0);
    expect(await runner.runJob({ ...job, executor: { id: "other/missing" } }, context))
      .toMatchObject({ status: "failed", summary: "CLI runner does not serve executor other/missing" });
    expect(await runner.runJob(job, context)).toMatchObject({ status: "ok", runId: "direct", operationId: "op", generation: 1 });
    expect(calls).toBe(1);
  });

  it("completes the real hello graph with pinned agent identity, accounting, sessions, and reviewer evidence", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as { status: string; stateDir: string; worktreePath: string };
    expect(report.status).toBe("succeeded");
    expect(await readFile(path.join(report.worktreePath, "GREETING.txt"), "utf8")).toBe("Hello, GraphLoom!\n");
    const state = await loadRunState(report.stateDir);
    expect(state.receipts.filter((r) => r.valid)).toHaveLength(2);
    expect(state.executorCatalog?.map((e) => e.id)).toContain("graphloom.agent/run");
    expect(state.agentSessions).toHaveLength(2);
    expect(state.agentSessions?.every((s) => s.executorId === "graphloom.agent/run")).toBe(true);
    const reviewRecord = state.evidence.find((e) => e.kind === "review");
    expect(reviewRecord?.payload).toMatchObject({
      verdict: "approved", summary: "Checked exact greeting bytes",
      producer: { executorId: "graphloom.agent/run", purpose: "review", readOnly: true },
    });
    // §4.1/§6.1: the controller classified this itself, from hello's own
    // declared review-verdict-v1 contract — not a schema name cli-runner.ts
    // or the controller know on their own.
    expect(reviewRecord?.contract).toMatchObject({ name: "review-verdict-v1", status: "valid", problems: [] });
    expect(state.budgets.agentInvocations).toBe(state.intake.budgets.agentInvocations - 2);
    expect((await execFileAsync("git", ["status", "--porcelain"], { cwd: f.repo })).stdout).not.toContain("GREETING");
  });

  it("never substitutes an approval when the reviewer omits its verdict", async () => {
    const f = await fixture(true);
    const result = await f.run();
    const report = JSON.parse(result.stdout) as { status: string; stateDir: string };
    expect(report.status).toBe("stopped");
    const state = await loadRunState(report.stateDir);
    expect(state.evidence.filter((e) => e.kind === "review")).toEqual([]);
    expect(state.receipts.some((r) => r.stageId === "write" && r.valid)).toBe(true);
    expect(state.receipts.some((r) => r.stageId === "review" && r.valid)).toBe(false);
  });

  it("checks a coding-agent job's input against the real executor's schema, as runJob would shape it, without running it", async () => {
    // Run 4c70ff66-dd9: supervisor-authored coding-agent jobs without an
    // assignment failed only inside the executor.
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(f.dir, "claude"));
    const runner = createCliRunner(await loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: f.config }));
    const job = (input: Record<string, unknown>) => ({
      stageId: "fix", kind: "agent" as const, purpose: "work" as const, instruction: "unused", writeScope: ["GREETING.txt"],
      executor: { id: "graphloom.coding-agent/run", version: "1" }, input,
    });
    expect(await runner.checkJob!(job({ harness: "claude-code", instruction: "fix it" }))).toBe("executor graphloom.coding-agent/run: input failed schema validation: assignment: required");
    // `harness` is the runner's to strip, so a valid job passes with it.
    expect(await runner.checkJob!(job({ assignment: "Create GREETING.txt", harness: "claude-code" }))).toBeUndefined();
    expect(await runner.checkJob!(job({ assignment: "Create GREETING.txt", harness: "pi" }))).toBe(
      'agent job asks for harness "pi", which the runner config does not enable (harnesses: claude-code)',
    );
    expect(await readdir(f.repo)).not.toContain("GREETING.txt");
  });

  it("runs each agent job on the harness it names, and refuses one the config does not enable", async () => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(f.dir, "claude"));
    const base = JSON.parse(await readFile(f.config, "utf8")) as Record<string, unknown>;
    const agentDir = path.join(f.dir, "pi-agent");
    await mkdir(agentDir);
    const both = { ...base, harnesses: ["claude-code", "pi"], pi: { provider: "faux-e2e", modelId: "faux", agentDir } };
    const piFixture = path.join(root, "apps/graphloom/test/fixtures/pi-faux-harness.mjs");
    const runner = createCliRunner(parseRunnerConfig(both), {}, { pi: piFixture });
    const context = (operationId: string) => ({
      runId: "direct", operationId, generation: 1, worktreePath: f.repo, artifactDir: f.dir,
      children: { callTool: async () => ({ status: "failed" as const, summary: "no tools" }), reserveModelCall: async () => true },
    });
    const job = (input: Record<string, unknown>) => ({
      stageId: "fix", kind: "agent" as const, purpose: "work" as const, instruction: "unused", writeScope: ["GREETING.txt"],
      executor: { id: "graphloom.coding-agent/run", version: "1" }, input: { assignment: "Create GREETING.txt", ...input },
    });
    const harnessOf = (result: { evidence?: { payload?: unknown }[] }) =>
      result.evidence?.map((e) => (e.payload as { codingAgent?: { harness: string } }).codingAgent?.harness).find(Boolean);

    const onPi = await runner.runJob(job({ harness: "pi", harnessOptions: { faux: [{ text: "done" }] } }), context("op-pi"));
    expect(onPi.status, onPi.summary).toBe("ok");
    expect(harnessOf(onPi)).toBe("pi");
    const onDefault = await runner.runJob(job({ resultSchema: "writer-result-v1" }), context("op-default"));
    expect(onDefault.status, onDefault.summary).toBe("ok");
    expect(harnessOf(onDefault)).toBe("claude-code");

    // This runner no longer classifies or validates a result against a
    // schema name: that is the controller's job now (recordJobEvidence,
    // against the run's own declared resultContracts), reading a contract
    // the controller resolves and forwards as ctx.resultContract — not
    // something this direct runner.runJob call (with a hand-built context
    // that supplies none) can exercise. The runner's own job is just to
    // forward the harness choice and schema text unchanged, whatever job.kind
    // or input.resultSchema says; it still records as kind: "other".
    const verdict = {
      verdict: "request_changes",
      summary: "changes what the metric counts",
      findings: [{ axis: "spec", severity: "blocking", detail: "TotalTasksTimeout no longer counts running actions" }],
      productDecision: "Should TotalTasksTimeout keep counting actions that are still running?",
    };
    const review = await runner.runJob(
      {
        stageId: "review", kind: "agent", purpose: "review", readOnly: true, instruction: "unused",
        executor: { id: "graphloom.coding-agent/run", version: "1" },
        input: { assignment: "Review the fix", resultSchema: "review-verdict-v1", harness: "pi", harnessOptions: { faux: [{ tool: "submit_result", args: verdict }, { text: "reviewed" }] } },
      },
      context("op-review"),
    );
    expect(review.status, review.summary).toBe("ok");
    expect(review.evidence).toMatchObject([{ kind: "other", payload: { codingAgent: { output: verdict } } }]);

    const claudeOnly = createCliRunner(parseRunnerConfig(base), {});
    expect(await claudeOnly.runJob(job({ harness: "pi" }), context("op-refused"))).toMatchObject({
      status: "failed",
      summary: 'agent job asks for harness "pi", which the runner config does not enable (harnesses: claude-code)',
    });
  });

  it("serves command jobs always, and GitHub reads only when the config asks for them", async () => {
    const f = await fixture();
    const base = JSON.parse(await readFile(f.config, "utf8")) as Record<string, unknown>;
    const plain = createCliRunner(parseRunnerConfig(base), {});
    const ids = (await plain.describeExecutors!()).map((e) => e.id);
    expect(ids).toContain("graphloom.command/run");
    expect(ids.some((id) => id.startsWith("graphloom.github/"))).toBe(false);

    const result = await plain.runJob(
      { stageId: "fix", kind: "command", purpose: "check", instruction: "list files", readOnly: true, input: { commands: [{ id: "ls", argv: ["git", "status", "--porcelain"] }] } },
      { runId: "direct", operationId: "op-cmd", generation: 1, worktreePath: f.repo, artifactDir: f.dir },
    );
    expect(result).toMatchObject({ status: "ok", evidence: [{ kind: "command", payload: { command: { id: "ls", exitCode: 0 } } }] });

    const withGitHub = createCliRunner(parseRunnerConfig({ ...base, github: { tokenEnv: "GL_TEST_GITHUB_TOKEN" } }), { GL_TEST_GITHUB_TOKEN: "t0ken" });
    const described = await withGitHub.describeExecutors!();
    expect(described.map((e) => e.id)).toEqual(expect.arrayContaining(["graphloom.github/get-issue", "graphloom.github/list-issue-comments"]));
    expect(JSON.stringify(described)).not.toContain("t0ken");
  });

  it("tells command jobs where the enabled harnesses' agents and logins are", async () => {
    const f = await fixture();
    const agents = {
      harness: "claude-code",
      harnesses: ["claude-code", "codex"],
      allowUnrestricted: true,
      claude: { command: "/opt/claude/bin/claude", configDir: "/srv/claude-config" },
      codex: { command: "/opt/codex/bin/codex", codexHome: "/srv/codex-home" },
    };
    const job = {
      stageId: "fix",
      kind: "command" as const,
      purpose: "check" as const,
      instruction: "print the agent locations",
      readOnly: true,
      input: { commands: [{ id: "where", argv: ["sh", "-c", 'printf "%s|" "$GRAPHLOOM_CLAUDE_BIN" "$GRAPHLOOM_CLAUDE_CONFIG_DIR" "$GRAPHLOOM_CODEX_BIN" "$GRAPHLOOM_CODEX_HOME"'] }] },
    };
    const ctx = { runId: "direct", operationId: "op-where", generation: 1, worktreePath: f.repo, artifactDir: f.dir };
    const stdout = async (config: Record<string, unknown>) => {
      const result = await createCliRunner(parseRunnerConfig(config), {}).runJob(job, ctx);
      return (result.evidence![0]!.payload as { command: { stdoutTail: string } }).command.stdoutTail;
    };
    vi.stubEnv("GRAPHLOOM_CLAUDE_BIN", "");
    vi.stubEnv("GRAPHLOOM_CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("GRAPHLOOM_CODEX_BIN", "");
    vi.stubEnv("GRAPHLOOM_CODEX_HOME", "");
    expect(await stdout(agents)).toBe("/opt/claude/bin/claude|/srv/claude-config|/opt/codex/bin/codex|/srv/codex-home|");
    // Settings of a harness the config does not enable stay out.
    expect(await stdout({ ...agents, harnesses: undefined })).toBe("/opt/claude/bin/claude|/srv/claude-config|||");
  });

  it("fails before creating a run when explicit runner configuration is malformed", async () => {
    const f = await fixture();
    await writeFile(f.config, "{ invalid");
    expect((await f.run()).stderr).toContain("invalid JSON in runner config");
    await expect(stat(path.join(f.repo, "graphloom-state"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(f.config);
    expect((await f.run()).stderr).toContain("cannot read runner config");
  });
});

describe("isEnvironmentDispatch", () => {
  // Regression: matching by command id alone let a graph-authored command job
  // that happened to reuse the environment's own ids, with different argv,
  // reach the real executor in quick-mode rehearsal instead of being stubbed.
  const environmentCommands = new Map([
    ["go", ["go", "version"]],
    ["git", ["git", "--version"]],
  ]);

  it("matches the environment's own declared checks, id and argv together", () => {
    const job = { input: { commands: [{ id: "go", argv: ["go", "version"] }, { id: "git", argv: ["git", "--version"] }] } };
    expect(isEnvironmentDispatch(job, environmentCommands)).toBe(true);
  });

  it("does not match a different command count, order aside", () => {
    const job = { input: { commands: [{ id: "go", argv: ["go", "version"] }] } };
    expect(isEnvironmentDispatch(job, environmentCommands)).toBe(false);
  });

  it("does not match a graph-authored command reusing an environment id with different argv", () => {
    const job = { input: { commands: [{ id: "go", argv: ["go", "test", "./..."] }, { id: "git", argv: ["git", "--version"] }] } };
    expect(isEnvironmentDispatch(job, environmentCommands)).toBe(false);
  });

  it("does not match a command missing argv entirely", () => {
    const job = { input: { commands: [{ id: "go" }, { id: "git", argv: ["git", "--version"] }] } };
    expect(isEnvironmentDispatch(job, environmentCommands)).toBe(false);
  });
});
