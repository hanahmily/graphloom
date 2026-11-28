// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createPrivateRepository, PRIVATE_REPOSITORY_COMMIT } from "./private-repository.js";
import { createRunWorktree, listDirtyPaths } from "./worktree.js";

const execFileAsync = promisify(execFile);
const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-private-repo-"));
  temps.push(dir);
  return dir;
}

const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", args, { cwd })).stdout.trim();

describe("createPrivateRepository", () => {
  it("pins the constant commit on main, with worktrees excluded and a clean status", async () => {
    const dir = path.join(await temp(), "repository");
    await createPrivateRepository(dir);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(PRIVATE_REPOSITORY_COMMIT);
    expect(await git(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(await git(dir, "cat-file", "-t", PRIVATE_REPOSITORY_COMMIT)).toBe("commit");
    expect(await readFile(path.join(dir, ".git", "info", "exclude"), "utf8")).toContain("/graphloom/");
    expect(await listDirtyPaths(dir)).toEqual([]);
  });

  it("hashes the commit exactly as git hash-object does", async () => {
    const dir = await temp();
    const object = "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor GraphLoom <graphloom@invalid> 0 +0000\ncommitter GraphLoom <graphloom@invalid> 0 +0000\n\nGraphLoom private repository\n";
    const child = execFileAsync("git", ["hash-object", "-t", "commit", "--stdin"], { cwd: dir });
    child.child.stdin?.end(object);
    expect((await child).stdout.trim()).toBe(PRIVATE_REPOSITORY_COMMIT);
  });

  it("gives the same commit in different directories", async () => {
    const root = await temp();
    await createPrivateRepository(path.join(root, "a", "repository"));
    await createPrivateRepository(path.join(root, "b", "repository"));
    expect(await git(path.join(root, "a", "repository"), "rev-parse", "HEAD")).toBe(await git(path.join(root, "b", "repository"), "rev-parse", "HEAD"));
  });

  it("is idempotent, and leaves no half-made sibling", async () => {
    const root = await temp();
    const dir = path.join(root, "repository");
    await createPrivateRepository(dir);
    await writeFile(path.join(dir, ".git", "marker-kept"), "x");
    await createPrivateRepository(dir);
    expect(await readFile(path.join(dir, ".git", "marker-kept"), "utf8")).toBe("x");
    await expect(readFile(path.join(`${dir}.creating`, "x"))).rejects.toThrow();
  });

  it("clears the leftover of a crash inside an earlier creation, then builds", async () => {
    const root = await temp();
    const dir = path.join(root, "repository");
    await mkdir(path.join(`${dir}.creating`, ".git"), { recursive: true });
    await writeFile(path.join(`${dir}.creating`, "junk"), "x");
    await createPrivateRepository(dir);
    expect(await git(dir, "rev-parse", "HEAD")).toBe(PRIVATE_REPOSITORY_COMMIT);
    await expect(readFile(path.join(`${dir}.creating`, "junk"))).rejects.toThrow();
  });

  it("refuses a directory GraphLoom did not make", async () => {
    const root = await temp();
    const plain = path.join(root, "plain");
    await mkdir(plain);
    await expect(createPrivateRepository(plain)).rejects.toThrow(`the run's private repository at ${plain} is not one GraphLoom made; operator reconciliation required`);
    const other = path.join(root, "other");
    await mkdir(other);
    await git(other, "init", "-q", "-b", "main");
    await git(other, "-c", "user.email=a@b.c", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "x");
    await expect(createPrivateRepository(other)).rejects.toThrow("is not one GraphLoom made");
    // Marker set but another commit.
    await git(other, "config", "graphloom.privateRepository", "true");
    await expect(createPrivateRepository(other)).rejects.toThrow("is not one GraphLoom made");
  });

  it("hashes the same under a hostile global config: signing, hooks and a sha256 default", async () => {
    const root = await temp();
    const home = path.join(root, "home");
    const hooks = path.join(root, "hooks");
    await mkdir(home);
    await mkdir(hooks);
    const fired = path.join(root, "hook-fired");
    for (const hook of ["post-checkout", "reference-transaction", "pre-commit", "post-commit"]) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> ${fired}\nexit 1\n`, { mode: 0o755 });
    }
    const globalConfig = path.join(root, "gitconfig");
    await writeFile(globalConfig, `[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n[core]\n\thooksPath = ${hooks}\n[init]\n\tdefaultObjectFormat = sha256\n\tdefaultBranch = trunk\n\ttemplateDir = ${hooks}\n`);
    const saved = { ...process.env };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = home;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "init.defaultObjectFormat";
    process.env.GIT_CONFIG_VALUE_0 = "sha256";
    process.env.GIT_AUTHOR_NAME = "Someone Else";
    process.env.GIT_COMMITTER_DATE = "2001-01-01T00:00:00Z";
    try {
      const dir = path.join(root, "repository");
      await createPrivateRepository(dir);
      expect(await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" } }).then((r) => r.stdout.trim())).toBe(PRIVATE_REPOSITORY_COMMIT);
      expect(await readFile(path.join(dir, ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
      expect(await readFile(path.join(dir, ".git", "config"), "utf8")).toContain("repositoryformatversion = 0");
      await expect(readFile(fired, "utf8")).rejects.toThrow();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe("a worktree of the private repository", () => {
  it("is created at <repo>/graphloom/<id> on its own branch, and the repository stays clean", async () => {
    const root = await temp();
    const dir = path.join(root, "state", "run-1", "repository");
    await createPrivateRepository(dir);
    const { worktreePath, branchName } = await createRunWorktree(dir, "run-1", PRIVATE_REPOSITORY_COMMIT, path.join(root, "state", "run-1"));
    expect(worktreePath).toBe(path.join(dir, "graphloom", "run-1"));
    expect(branchName).toBe("graphloom/run-1");
    expect(await git(worktreePath, "rev-parse", "HEAD")).toBe(PRIVATE_REPOSITORY_COMMIT);
    // Only the excluded worktree directory shows (as an ignored path); nothing is untracked or modified.
    expect(await git(dir, "status", "--porcelain", "--untracked-files=normal")).toBe("");
    // The repository is still the one GraphLoom made, with a worktree in it.
    await createPrivateRepository(dir);
    // A second run's worktree.
    await createRunWorktree(dir, "run-2", PRIVATE_REPOSITORY_COMMIT, path.join(root, "state", "run-2"));
    expect(await git(dir, "worktree", "list", "--porcelain")).toContain(path.join(dir, "graphloom", "run-2"));
  });
});
