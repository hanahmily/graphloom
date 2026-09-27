import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("graphloom delete", () => {
  it("deletes a stopped CLI run, discarding worktree changes only with --force", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "gl-cli-delete-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const repo = path.join(dir, "test-repo");
    await mkdir(repo);
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
    await git("init", "-q");
    await git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
    await mkdir(path.join(dir, "plugins"));
    await symlink(path.join(repoRoot, "examples/plugins/hello"), path.join(dir, "plugins/hello"));
    await writeFile(path.join(dir, "task.yaml"), "graph: hello\nrepo: ./test-repo\nrequest: Create GREETING.txt.\n");

    const { GRAPHLOOM_SUPERVISOR_CONFIG: _config, ...inherited } = process.env;
    const env = { ...inherited, HOME: dir };
    const graphloom = (...args: string[]) => execFileAsync(process.execPath, [cli, ...args], { cwd: dir, env });

    const run = await graphloom("run", "task.yaml").catch((err: { stdout: string }) => err);
    const report = JSON.parse(run.stdout) as { runId: string; status: string; stateDir: string; worktreePath: string };
    expect(report.status).toBe("stopped");
    await writeFile(path.join(report.worktreePath, "scratch.txt"), "x\n");

    const refused = await graphloom("delete", report.runId, "--state-root", "test-repo/graphloom-state").catch(
      (err: { stderr: string }) => err,
    );
    expect(refused.stderr).toContain(
      `cannot delete run ${report.runId}: its worktree has uncommitted changes (scratch.txt); pass force to discard them`,
    );
    expect(existsSync(report.worktreePath)).toBe(true);

    const deleted = await graphloom("delete", report.runId, "--state-root", "test-repo/graphloom-state", "--force");
    expect(JSON.parse(deleted.stdout)).toEqual({
      runId: report.runId,
      stateDir: report.stateDir,
      worktreePath: report.worktreePath,
      branch: `graphloom/${report.runId}`,
    });
    expect(existsSync(report.stateDir)).toBe(false);
    expect(existsSync(report.worktreePath)).toBe(false);
    expect((await git("branch", "--list", "graphloom/*")).stdout).toBe("");
  }, 60_000);
});
