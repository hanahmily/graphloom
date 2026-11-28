// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HubStoredInput } from "@graphloom/sdk";
import { parseTaskYaml, PRIVATE_REPOSITORY_COMMIT } from "@graphloom/controller";
import { createNoRepositoryFixture, createScope } from "@graphloom/testkit";
import { digestExecutorSource } from "@graphloom/runner";
import { boundedText, captureHubInput, inputDigest, materializeHubTask, runtimeDigest, verifyHubInput, writePrivateJsonOrText } from "../src/hub-input.js";
import { makeCliEnv } from "./cli-env.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function captured() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gl-hub-input-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, "runtime"); const bundle = path.join(directory, "bundle"); const repo = path.join(directory, "source");
  for (const child of [runtime, bundle, repo, ...["packages", "executors", "apps"].map(name => path.join(runtime, name))]) await mkdir(child, { recursive: true });
  await writeFile(path.join(runtime, "package.json"), '{}\n'); await writeFile(path.join(runtime, "package-lock.json"), '{}\n');
  await writeFile(path.join(bundle, "index.js"), "export default {};\n");
  const text = "graph: hello\nrepo: source\nrequest: |\n  Keep # and : in the request.\n  Second line.\nbudgets:\n  jobs: 10\n";
  const taskFile = path.join(directory, "task.yaml"); await writePrivateJsonOrText(taskFile, text);
  const runnerConfig = path.join(directory, "runner.json"); await writeFile(runnerConfig, "{}\n");
  const configFile = path.join(directory, "config.json"); await writeFile(configFile, '{"profile":"test"}\n');
  const input: HubStoredInput = { taskFile, taskDigest: digest(text), taskPath: "/original/task.yaml", repoPath: repo, baseCommit: "a".repeat(40), bundlePath: bundle, bundleDigest: await digestExecutorSource(bundle), runtimePath: path.join(runtime, "main.js"), runtimeRoot: runtime, runtimeDigest: await runtimeDigest(runtime), runtimeConfig: { runner: { path: runnerConfig, digest: digest("{}\n") } }, configFile, configDigest: digest('{"profile":"test"}\n') };
  return { directory, input, text, runtime, bundle, runnerConfig, configFile };
}

describe("hub immutable input capture", () => {
  it("captures real task bytes/base commit without creating a run or calling a plugin", async () => {
    const env = await makeCliEnv(cleanups); const runner = path.join(env.dir, "runner.json"); await writeFile(runner, "{}\n");
    const taskPath = path.join(env.dir, "task.yaml"); const bytes = await readFile(taskPath, "utf8");
    const captured = await captureHubInput(taskPath, { runnerConfig: runner }, env.env);
    expect(captured.task).toBe(bytes); expect(captured.taskDigest).toBe(digest(bytes));
    expect(captured.baseCommit).toBe(await env.git("rev-parse", "HEAD")); expect(captured.repoPath).toBe(await realpath(env.repo));
    expect(captured.runtimeConfig?.runner).toMatchObject({ path: runner, digest: digest("{}\n") });
    await expect(stat(env.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await env.git("status", "--porcelain")).toBe("");
  });

  it("captures a task with no repository as its own directory and the private repository's commit, deterministically", async () => {
    const scope = createScope(); cleanups.push(() => scope.dispose());
    const env = await makeCliEnv(cleanups); const runner = path.join(env.dir, "runner.json"); await writeFile(runner, "{}\n");
    const f = await createNoRepositoryFixture(scope);
    const first = await captureHubInput(f.taskPath, { runnerConfig: runner }, env.env);
    expect(first.repoPath).toBe(await realpath(f.taskDir));
    expect(first.baseCommit).toBe(PRIVATE_REPOSITORY_COMMIT);
    expect(first.task).not.toMatch(/^repo:/m);
    await expect(stat(f.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    // A second submission of the same task is the same request.
    expect(inputDigest(await captureHubInput(f.taskPath, { runnerConfig: runner }, env.env))).toBe(inputDigest(first));
  });

  it("materializes a task with no repository without a repo link or a base", async () => {
    const f = await captured();
    const text = "graph: hello\nrequest: Survey.\nbudgets:\n  jobs: 10\n";
    await writeFile(f.input.taskFile, text);
    const input = { ...f.input, taskDigest: digest(text), baseCommit: PRIVATE_REPOSITORY_COMMIT };
    const launch = await materializeHubTask(input);
    const launched = await readFile(launch, "utf8");
    expect(launched).not.toMatch(/^(repo|base):/m);
    expect(parseTaskYaml(launched)).toMatchObject({ graph: "hello", request: "Survey.", config: "config.json", budgets: { jobs: 10 } });
    await expect(stat(path.join(f.directory, "repo"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await realpath(path.join(f.directory, "plugins", "hello"))).toBe(f.input.bundlePath);
  });

  it("does not capture a task for a graph that needs a repository when its repo: is empty", async () => {
    const env = await makeCliEnv(cleanups); const runner = path.join(env.dir, "runner.json"); await writeFile(runner, "{}\n");
    const taskPath = path.join(env.dir, "task.yaml");
    for (const line of ['repo: ""', "repo: ''"]) {
      await writeFile(taskPath, (await readFile(taskPath, "utf8")).replace(/^repo:.*$/m, line));
      await expect(captureHubInput(taskPath, { runnerConfig: runner }, env.env)).rejects.toThrow("graph hello needs a repository: name it with repo: in the task file");
    }
  });

  it("materializes a task whose empty repo: names nothing without inventing a repo link", async () => {
    const f = await captured();
    const text = 'graph: hello\nrepo: ""\nrequest: Survey.\n';
    await writeFile(f.input.taskFile, text);
    const launch = await materializeHubTask({ ...f.input, taskDigest: digest(text), baseCommit: PRIVATE_REPOSITORY_COMMIT });
    expect(await readFile(launch, "utf8")).not.toMatch(/^repo: repo$/m);
    expect(parseTaskYaml(await readFile(launch, "utf8")).repo).toBeUndefined();
    await expect(stat(path.join(f.directory, "repo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verifies captured task/config/runtime bytes and rejects changed queued bundles", async () => {
    const f = await captured();
    await expect(verifyHubInput(f.input, true)).resolves.toBeUndefined();
    await writeFile(f.input.taskFile, f.text.replace("Second line.", "Changed task."));
    await expect(verifyHubInput(f.input, true)).rejects.toThrow("captured task does not match");
    await writeFile(f.input.taskFile, f.text);
    const { taskDigest: _omitted, ...missingDigest } = f.input;
    await expect(verifyHubInput(missingDigest, true)).rejects.toThrow("captured task does not match");
    await writeFile(path.join(f.bundle, "index.js"), "export default {changed:true};\n");
    await expect(verifyHubInput(f.input, true)).rejects.toThrow("queued plugin bundle changed");
    await expect(verifyHubInput(f.input, false)).resolves.toBeUndefined();
    await writeFile(f.runnerConfig, '{"changed":true}');
    await expect(verifyHubInput(f.input, false)).rejects.toThrow("runtime configuration changed");
    await writeFile(f.runnerConfig, "{}\n"); await writeFile(f.configFile, '{"profile":"changed"}');
    await expect(verifyHubInput(f.input, false)).rejects.toThrow("captured task config");
    await writeFile(f.configFile, '{"profile":"test"}\n'); await writeFile(path.join(f.runtime, "package-lock.json"), '{"changed":true}');
    await expect(verifyHubInput(f.input, false)).rejects.toThrow("pinned runtime changed");
  });

  it("materializes pinned references while preserving request/budgets and rejects tampering", async () => {
    const f = await captured(); const launch = await materializeHubTask(f.input);
    const parsed = parseTaskYaml(await readFile(launch, "utf8"));
    expect(parsed.request).toBe(parseTaskYaml(f.text).request);
    expect(parsed).toMatchObject({ graph: "hello", repo: "repo", base: "a".repeat(40), budgets: { jobs: 10 }, config: "config.json" });
    expect(await realpath(path.join(f.directory, "repo"))).toBe(f.input.repoPath);
    expect(await realpath(path.join(f.directory, "plugins", "hello"))).toBe(f.input.bundlePath);
    expect(await materializeHubTask(f.input)).toBe(launch);
    await writeFile(launch, "graph: hostile\n");
    await expect(materializeHubTask(f.input)).rejects.toThrow("captured launch task changed");
  });

  it.each([
    'request: |\n      npm test fails\n  then inspect the output\n',
    'request: "\t\tkeep leading tabs"\n',
    'request: |\n\n    indented line\n  next line\n\n',
  ])("preserves the captured request when rewriting pinned references: %j", async (request) => {
    const f = await captured();
    const text = `graph: hello\nrepo: source\n${request}budgets:\n  jobs: 10\n`;
    await writeFile(f.input.taskFile, text);
    f.input.taskDigest = digest(text);
    const launch = await materializeHubTask(f.input);
    expect(parseTaskYaml(await readFile(launch, "utf8")).request).toBe(parseTaskYaml(text).request);
  });

  it("bounds UTF-8 reads and uses independent private atomic temporary files", async () => {
    const f = await captured(); const file = path.join(f.directory, "atomic.json");
    const oldTemp = `${file}.${process.pid}.tmp`; await writeFile(oldTemp, "unrelated file");
    const texts = Array.from({ length: 8 }, (_, i) => JSON.stringify({ iteration: i, payload: "x".repeat(4000) }));
    await Promise.all(texts.map(text => writePrivateJsonOrText(file, text)));
    expect(texts).toContain(await readFile(file, "utf8")); expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(oldTemp, "utf8")).toBe("unrelated file");
    await expect(boundedText(file, 100)).rejects.toThrow("exceeds");
    await writeFile(file, Buffer.from([0xff, 0xfe])); await expect(boundedText(file, 100)).rejects.toThrow("UTF-8");
  });
});
