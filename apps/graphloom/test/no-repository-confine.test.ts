// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivateRepository, PRIVATE_REPOSITORY_COMMIT } from "@graphloom/controller";
import { confineWorker, confinementUnsupported } from "@graphloom/runner";

/**
 * A run of a graph without a repository keeps its worktree inside its state directory, which can sit under
 * the operator's home directory. A confined job (the run's scope: the worktree and its git administrative
 * directory writable, the repository's common directory readable) must still read the worktree's git
 * metadata when the sandbox hides the home directory and masks a credentials directory.
 */
const unsupported = await confinementUnsupported();
const execFileAsync = promisify(execFile);
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gl-none-confine-")));
const realHome = process.env.HOME;
const home = path.join(root, "home");
const stateDir = path.join(home, ".local", "state", "graphloom", "runs", "tidy-1");
const repository = path.join(stateDir, "repository");
const worktree = path.join(repository, "graphloom", "tidy-1");
const admin = path.join(repository, ".git", "worktrees", "tidy-1");

beforeAll(async () => {
  mkdirSync(path.join(home, ".ssh"), { recursive: true });
  writeFileSync(path.join(home, ".ssh", "id"), "private");
  process.env.HOME = home;
  await createPrivateRepository(repository);
  await execFileAsync("git", ["worktree", "add", "-q", "-b", "graphloom/tidy-1", worktree, PRIVATE_REPOSITORY_COMMIT], { cwd: repository });
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(root, { recursive: true, force: true });
});

function inSandbox(script: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const launch = confineWorker({
    command: "sh",
    args: ["-c", script],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    cwd: worktree,
    scratchDir: path.join(stateDir, "scratch"),
    writable: [worktree, admin],
    readPaths: [path.join(repository, ".git")],
    keepUserState: false,
    sandbox: { network: false, mask: ["~/.ssh"], binds: [] },
  });
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { env: launch.env, cwd: worktree, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe.skipIf(unsupported !== undefined)("a confined job in a worktree inside the state directory", () => {
  it("reads the private repository's git metadata and writes its own worktree, while the mask still hides credentials", async () => {
    const result = await inSandbox([
      "git rev-parse HEAD",
      "git status --porcelain",
      "echo changed > survey.txt",
      "git status --porcelain",
      "test -e \"$HOME/.ssh/id\" && echo ssh-visible || echo ssh-hidden",
    ].join("; "));
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([PRIVATE_REPOSITORY_COMMIT, "?? survey.txt", "ssh-hidden"]);
    expect(result.status).toBe(0);
  });

  it("cannot change the repository's shared refs, and nothing it writes outside its worktree reaches the host", async () => {
    // Outside the writable paths the hidden home is an empty, throwaway file system.
    const result = await inSandbox("echo x > ../other.txt; git update-ref refs/heads/escape HEAD; echo $?");
    expect(Number(result.stdout.trim().split("\n").at(-1))).not.toBe(0);
    expect(existsSync(path.join(repository, "graphloom", "other.txt"))).toBe(false);
    expect((await execFileAsync("git", ["branch", "--list", "escape"], { cwd: repository })).stdout).toBe("");
  });
});
