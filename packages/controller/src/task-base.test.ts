// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createScriptedRunner } from "@graphloom/runner";
import { candidateChange, createRunWorktree } from "./worktree.js";
import { createController, IntakeError, intakeTask, parseTaskYaml } from "./index.js";

const execFileAsync = promisify(execFile);

const PLUGIN = `
export function createGraph() {
  return {
    describe() {
      return {
        graphId: "based", version: "1.0.0",
        stages: [{ id: "s", name: "S", requirementIds: ["r"] }],
        requirements: [{ id: "r", statement: "r", evidenceSchema: "x-v1" }],
        defaultValidators: [{ requirementId: "r", validatorId: "v", version: "1" }],
      };
    },
    advance() { return { action: { type: "stop", stop: { reason: "done", blocker: "stop" } }, reason: "stop" }; },
  };
}
export function validatorById() { return undefined; }
`;

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

/** A repository with two commits (`first`, then `second` = HEAD) and a task carrying the extra lines. */
async function makeEnv(taskExtra: (first: string, second: string) => string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-task-base-"));
  temps.push(dir);
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  const git = async (...args: string[]) => (await execFileAsync("git", args, { cwd: repo })).stdout.trim();
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  const first = await git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "b.txt"), "two\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "second");
  const second = await git("rev-parse", "HEAD");
  const bundle = path.join(dir, "plugins", "based");
  await mkdir(path.join(bundle, "dist"), { recursive: true });
  await writeFile(path.join(bundle, "dist", "index.js"), PLUGIN);
  await writeFile(
    path.join(bundle, "graphloom.manifest.json"),
    JSON.stringify({ graphId: "based", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./dist/index.js" } }),
  );
  const taskPath = path.join(dir, "task.yaml");
  await writeFile(taskPath, `graph: based\nrepo: ./repo\n${taskExtra(first, second)}request: "Review."\n`);
  return { dir, repo, taskPath, first, second, git, stateRoot: path.join(dir, "state") };
}

describe("task base", () => {
  it("parses the base field", () => {
    expect(parseTaskYaml("graph: g\nrepo: r\nbase: 3f1c9e\nrequest: go\n").base).toBe("3f1c9e");
    expect(parseTaskYaml("graph: g\nrepo: r\nbase: 'v1.0'\nrequest: go\n").base).toBe("v1.0");
    expect(parseTaskYaml("graph: g\nrepo: r\nrequest: go\n").base).toBeUndefined();
    expect(() => parseTaskYaml("graph: g\nrepo: r\nbase: --upload-pack=x\nrequest: go\n")).toThrow(IntakeError);
  });

  it("pins the base commit instead of HEAD", async () => {
    const env = await makeEnv((first) => `base: ${first}\n`);
    const pin = await intakeTask(env.taskPath);
    expect(pin.pinnedHead).toBe(env.first);
    expect(pin.pinnedHead).not.toBe(env.second);
  });

  it("resolves a tag name to its commit", async () => {
    const env = await makeEnv(() => "base: base-tag\n");
    await env.git("tag", "base-tag", env.first);
    expect((await intakeTask(env.taskPath)).pinnedHead).toBe(env.first);
  });

  it("measures the run's change against the base", async () => {
    const env = await makeEnv((first) => `base: ${first}\n`);
    const pin = await intakeTask(env.taskPath);
    const { worktreePath } = await createRunWorktree(pin.repoPath, "run-base", pin.pinnedHead, path.join(env.dir, "state"));
    // The worktree starts at the base: HEAD's later file is absent until something materializes it.
    await expect(execFileAsync("test", ["-e", path.join(worktreePath, "b.txt")])).rejects.toBeDefined();
    const empty = await candidateChange(worktreePath, pin.pinnedHead);
    expect(empty.fingerprints.size).toBe(0);
    await execFileAsync("git", ["checkout", "--no-overlay", env.second, "--", "."], { cwd: worktreePath });
    const change = await candidateChange(worktreePath, pin.pinnedHead);
    expect([...change.fingerprints.keys()]).toEqual(["b.txt"]);
    expect(change.digest).not.toBe(empty.digest);
    const diff = (await execFileAsync("git", ["diff", pin.pinnedHead], { cwd: worktreePath })).stdout;
    expect(diff).toContain("b.txt");
  });

  it("refuses a base that is not a commit of the repository", async () => {
    const env = await makeEnv(() => `base: ${"0".repeat(40)}\n`);
    await expect(intakeTask(env.taskPath)).rejects.toThrow(/base "0{40}" is not a commit/);
    const named = await makeEnv(() => "base: no-such-branch\n");
    await expect(intakeTask(named.taskPath)).rejects.toThrow(IntakeError);
    // A tree is not a commit.
    const tree = await makeEnv(() => "base: HEAD^{tree}\n");
    await expect(intakeTask(tree.taskPath)).rejects.toThrow(/not a commit/);
  });

  it("pins HEAD when the task names no base", async () => {
    const env = await makeEnv(() => "");
    const pin = await intakeTask(env.taskPath);
    expect(pin.pinnedHead).toBe(env.second);
    expect(pin.task.base).toBeUndefined();
  });

  it("shows the base in inspect", async () => {
    const env = await makeEnv((first) => `base: ${first}\n`);
    const controller = createController();
    const report = await controller.run({ taskPath: env.taskPath, runner: createScriptedRunner({ jobs: [] }), stateRoot: env.stateRoot });
    const inspected = await controller.inspect(report.stateDir, { stateRoot: env.stateRoot });
    expect(inspected.base).toEqual({ requested: env.first, commit: env.first });
    const plain = await makeEnv(() => "");
    const plainReport = await controller.run({ taskPath: plain.taskPath, runner: createScriptedRunner({ jobs: [] }), stateRoot: plain.stateRoot });
    expect((await controller.inspect(plainReport.stateDir, { stateRoot: plain.stateRoot })).base).toBeUndefined();
  });
});
