// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IntakeError } from "./intake-error.js";

const execFileAsync = promisify(execFile);

/**
 * The one commit every private repository pins: the empty tree, authored and
 * committed by `GraphLoom <graphloom@invalid>` at time 0. It is written with
 * `git hash-object`, never `git commit`, so no user, signing, hook or default
 * object-format configuration can change its hash. A run, its resume, the
 * hub's request digest and the gate fingerprint can all depend on it.
 */
export const PRIVATE_REPOSITORY_COMMIT = "92fb572e8a9f58f9d4b978ea898bf900181c8be0";

const COMMIT_OBJECT = [
  "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  "author GraphLoom <graphloom@invalid> 0 +0000",
  "committer GraphLoom <graphloom@invalid> 0 +0000",
  "",
  "GraphLoom private repository",
  "",
].join("\n");

/** The private repository's directory name inside a run's state directory. */
export const PRIVATE_REPOSITORY_DIRECTORY = "repository";

/** Marks a repository GraphLoom made for a run (a local git config key). */
const MARKER_KEY = "graphloom.privateRepository";

/** Git's environment with no user, system or repository-selecting configuration. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_TEMPLATE_DIR", "GIT_DEFAULT_HASH", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) {
    delete env[key];
  }
  return env;
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  const child = execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env: gitEnv(), encoding: "utf8" });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout.trim();
}

function notOurs(dir: string): IntakeError {
  return new IntakeError(`the run's private repository at ${dir} is not one GraphLoom made; operator reconciliation required`);
}

/** Whether `dir` is a private repository GraphLoom made: the marker is set and `HEAD` is the pinned commit. */
export async function isPrivateRepository(dir: string): Promise<boolean> {
  try {
    if ((await git(dir, ["config", "--local", "--get", MARKER_KEY])) !== "true") return false;
    return (await git(dir, ["rev-parse", "--verify", "HEAD"])) === PRIVATE_REPOSITORY_COMMIT;
  } catch {
    return false;
  }
}

/**
 * Create the private repository for a run that works without one, at `dir`
 * (inside the run's state directory): one empty commit on `main`, pinned by
 * `PRIVATE_REPOSITORY_COMMIT`, with `/graphloom/` (where run worktrees go)
 * excluded so the source checkout reads as clean. Idempotent: an existing
 * directory must already be one this function made (marker set, `HEAD` the
 * constant), else the call refuses. The repository is built beside `dir` and
 * renamed into place, so a crash never leaves a half-made one.
 */
export async function createPrivateRepository(dir: string): Promise<void> {
  const present = await lstat(dir).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (present) {
    if (await isPrivateRepository(dir)) return;
    throw notOurs(dir);
  }
  const parent = path.dirname(dir);
  await mkdir(parent, { recursive: true });
  const building = `${dir}.creating`;
  await rm(building, { recursive: true, force: true });
  try {
    await git(parent, ["init", "--object-format=sha1", "--template=", "-q", building]);
    await git(building, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const written = await git(building, ["hash-object", "-t", "commit", "-w", "--stdin"], COMMIT_OBJECT);
    if (written !== PRIVATE_REPOSITORY_COMMIT) throw new Error(`private repository commit hashed to ${written}, not ${PRIVATE_REPOSITORY_COMMIT}`);
    await git(building, ["update-ref", "refs/heads/main", written]);
    await mkdir(path.join(building, ".git", "info"), { recursive: true });
    await writeFile(path.join(building, ".git", "info", "exclude"), "/graphloom/\n", "utf8");
    await git(building, ["config", "--local", MARKER_KEY, "true"]);
    await rename(building, dir);
  } catch (error) {
    await rm(building, { recursive: true, force: true });
    throw error;
  }
}
