// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confinementUnsupported, createBuiltinExecutorRunner, type JobContext, type Runner } from "@graphloom/runner";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import type { JobSpec } from "@graphloom/sdk";
import { exampleBundle, execFileAsync, goVersion, repoRoot } from "@graphloom/testkit";

const unsupported = await confinementUnsupported();
const GO = goVersion();
const bundle = exampleBundle("pr-review");

interface BasePlugin {
  baseFileCommand(t: { index: number; path: string; language: "go" | "typescript" }, base: string): { id: string; argv: string[] };
  staticBaseCommand(b: { id: string; language: "go" | "typescript"; path: string; text: string }, base: string, root: string, generated: string[], node: string, goBin?: string): { id: string; argv: string[] };
  GIT_ENV: Record<string, string>;
  BASE_FILES: Record<string, string>;
  DOCS: Record<string, unknown>;
}

interface Plugin {
  staticCommand(batch: { id: string; language: "go" | "typescript"; paths: string[] }, hunks: Map<string, Array<{ start: number; end: number }>>, root: string, generated: string[], node: string): { id: string; argv: string[] };
  FLAGS_DOC: unknown;
  REHEARSAL_HEAD_FILES: Record<string, string>;
}
let plugin: Plugin;
let basePlugin: BasePlugin;
let dir: string;
let work: string;
let runner: Runner;

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-pr-review"], { cwd: repoRoot });
  const measurements = (await import(pathToFileURL(path.join(bundle, "dist", "measurements.js")).href)) as Pick<Plugin, "staticCommand">;
  const rehearsal = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal.js")).href)) as Pick<Plugin, "FLAGS_DOC" | "REHEARSAL_HEAD_FILES">;
  plugin = { ...measurements, ...rehearsal };
  const base = (await import(pathToFileURL(path.join(bundle, "dist", "measurements.js")).href)) as Pick<BasePlugin, "baseFileCommand" | "staticBaseCommand">;
  const commands = (await import(pathToFileURL(path.join(bundle, "dist", "commands.js")).href)) as Pick<BasePlugin, "GIT_ENV">;
  const fixtures = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal-fixtures.js")).href)) as Pick<BasePlugin, "BASE_FILES">;
  const docs = (await import(pathToFileURL(path.join(bundle, "dist", "rehearsal-docs.js")).href)) as Pick<BasePlugin, "DOCS">;
  basePlugin = { ...base, ...commands, ...fixtures, ...docs };
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-pr-confined-"));
  work = path.join(dir, "work");
  await mkdir(path.join(work, "banyand/cmd/server"), { recursive: true });
  await writeFile(path.join(work, "banyand/cmd/server/flags.go"), plugin.REHEARSAL_HEAD_FILES["banyand/cmd/server/flags.go"]!);
  runner = createBuiltinExecutorRunner({
    packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
    fallback: { runJob: async () => { throw new Error("not served"); } },
  });
}, 120_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(unsupported !== undefined || GO === undefined)("the static metrics job, run for real under its bwrap confinement", () => {
  it("measures the head tree with no network, binding only the plugin and the Go installation read-only, and leaves the worktree unchanged", async () => {
    const goRoot = spawnSync("go", ["env", "GOROOT"], { encoding: "utf8" }).stdout.trim();
    const hunks = new Map([["banyand/cmd/server/flags.go", [{ start: 14, end: 17 }]]]);
    const command = plugin.staticCommand({ id: "static-go-1", language: "go", paths: ["banyand/cmd/server/flags.go"] }, hunks, bundle, [], process.execPath);
    const job: JobSpec = {
      stageId: "report",
      kind: "command",
      purpose: "diagnostic",
      readOnly: true,
      instruction: "Measure",
      input: { commands: [command], continueOnFailure: true },
      confinement: { kind: "bwrap", network: false, mask: [], binds: [{ path: bundle, readOnly: true }, { path: goRoot, readOnly: true }] },
    };
    const ctx: JobContext = {
      runId: "r1",
      operationId: "op-1",
      generation: 1,
      worktreePath: work,
      artifactDir: path.join(dir, "artifacts"),
      confinement: { scratchDir: path.join(dir, "scratch"), writablePaths: [work] },
    };
    const result = await runner.runJob(job, ctx);
    expect(result.status, result.summary).toBe("ok");
    const outcome = (result.evidence![0]!.payload as { command: { exitCode: number; stderrTail: string; report?: { text: string } } }).command;
    expect(outcome.stderrTail).toBe("");
    expect(outcome.exitCode).toBe(0);
    expect(JSON.parse(outcome.report!.text)).toEqual(plugin.FLAGS_DOC);
    expect(await readFile(path.join(work, "banyand/cmd/server/flags.go"), "utf8")).toBe(plugin.REHEARSAL_HEAD_FILES["banyand/cmd/server/flags.go"]);
  }, 180_000);

  it("measures a modified function's file at the base: git show reads the base, the same tool measures it, the worktree (the head) is unchanged", async () => {
    const goRoot = spawnSync("go", ["env", "GOROOT"], { encoding: "utf8" }).stdout.trim();
    const file = "banyand/cmd/server/flags.go";
    const repo = path.join(dir, "base-repo");
    await mkdir(path.join(repo, "banyand/cmd/server"), { recursive: true });
    const env = { ...process.env, ...basePlugin.GIT_ENV, GIT_AUTHOR_NAME: "n", GIT_AUTHOR_EMAIL: "a@b.c", GIT_COMMITTER_NAME: "n", GIT_COMMITTER_EMAIL: "a@b.c" };
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env });
    git("init", "-q", "-b", "main");
    await writeFile(path.join(repo, file), basePlugin.BASE_FILES[file]!);
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    await writeFile(path.join(repo, file), plugin.REHEARSAL_HEAD_FILES[file]!);
    const target = { index: 1, path: file, language: "go" as const };
    const read = basePlugin.baseFileCommand(target, sha);
    const measure = basePlugin.staticBaseCommand({ id: "static-base-go-1", language: "go", path: file, text: basePlugin.BASE_FILES[file]! }, sha, bundle, [], process.execPath, path.join(goRoot, "bin", "go"));
    const job: JobSpec = {
      stageId: "report",
      kind: "command",
      purpose: "diagnostic",
      readOnly: true,
      instruction: "Measure the base",
      input: { commands: [read, measure], continueOnFailure: true, env: { ...basePlugin.GIT_ENV } },
      confinement: { kind: "bwrap", network: false, mask: [], binds: [{ path: bundle, readOnly: true }, { path: goRoot, readOnly: true }] },
    };
    const ctx: JobContext = {
      runId: "r2",
      operationId: "op-2",
      generation: 1,
      worktreePath: repo,
      artifactDir: path.join(dir, "artifacts2"),
      confinement: { scratchDir: path.join(dir, "scratch2"), writablePaths: [repo] },
    };
    const result = await runner.runJob(job, ctx);
    expect(result.status, result.summary).toBe("ok");
    const [first, second] = result.evidence!.map((e) => (e.payload as { command: { exitCode: number; stderrTail: string; report?: { text: string } } }).command);
    expect(first!.stderrTail).toBe("");
    expect(first!.exitCode).toBe(0);
    expect(first!.report!.text).toBe(basePlugin.BASE_FILES[file]);
    expect(second!.stderrTail).toBe("");
    expect(second!.exitCode).toBe(0);
    expect(JSON.parse(second!.report!.text)).toEqual(basePlugin.DOCS[`base:${file}`]);
    // The head the worktree holds is untouched, and the scratch directory the tool used is gone from it.
    expect(await readFile(path.join(repo, file), "utf8")).toBe(plugin.REHEARSAL_HEAD_FILES[file]);
    expect(git("status", "--porcelain").stdout.split("\n").filter((l) => l !== "")).toEqual([" M banyand/cmd/server/flags.go"]);
  }, 180_000);
});
