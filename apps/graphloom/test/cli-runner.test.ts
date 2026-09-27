import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRunState } from "@graphloom/controller";
import { createCliRunner } from "../dist/cli-runner.js";
import { loadRunnerConfig } from "../src/runner-config.js";

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

  it("serves an explicit coding-agent pin and refuses unknown IDs and changed pinned bytes", async () => {
    const f = await fixture();
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(f.dir, "claude"));
    const runner = createCliRunner(await loadRunnerConfig({ GRAPHLOOM_RUNNER_CONFIG: f.config }));
    const catalog = await runner.describeExecutors!();
    const coding = catalog.find((entry) => entry.id === "graphloom.coding-agent/run")!;
    expect(coding.isolation).toBe("unrestricted");
    expect(coding.source).toBe(path.join(root, "executors/coding-agent"));
    expect(catalog.find((entry) => entry.id === "graphloom.agent/run")?.source).toBe(coding.source);
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
    expect(state.evidence.find((e) => e.kind === "review")?.payload).toMatchObject({
      verdict: "approved", summary: "Checked exact greeting bytes",
      producer: { executorId: "graphloom.agent/run", purpose: "review", readOnly: true },
    });
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

  it("fails before creating a run when explicit runner configuration is malformed", async () => {
    const f = await fixture();
    await writeFile(f.config, "{ invalid");
    expect((await f.run()).stderr).toContain("invalid JSON in runner config");
    await expect(stat(path.join(f.repo, "graphloom-state"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(f.config);
    expect((await f.run()).stderr).toContain("cannot read runner config");
  });
});
