// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, symlink, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { intakeTask, parseTaskYaml } from "@graphloom/controller";
import { digestExecutorSource } from "@graphloom/runner";
import type { HubInput, HubStoredInput } from "@graphloom/sdk";
import { stableHash } from "@graphloom/sdk";
import type { HubServiceConfig } from "./hub-config.js";
import { runnerConfigPath } from "./runner-config.js";
import { selfInstall } from "./ownership.js";

const MAX_TASK_BYTES = 256 * 1024;

/** Read-only intake: no graph callback, worktree, rehearsal or provider is run here. */
export async function captureHubInput(taskPath: string, config: Pick<HubServiceConfig, "runnerConfig" | "supervisorConfig">, env: NodeJS.ProcessEnv = process.env): Promise<HubInput> {
  const absolute = await realpath(taskPath);
  const task = await boundedText(absolute, MAX_TASK_BYTES);
  const intake = await intakeTask(absolute);
  if (task !== await boundedText(absolute, MAX_TASK_BYTES) || JSON.stringify(parseTaskYaml(task)) !== JSON.stringify(intake.task)) throw new Error("task changed during submission; submit again");
  const self = selfInstall();
  const runnerPath = config.runnerConfig ?? runnerConfigPath(env).file;
  const supervisorPath = config.supervisorConfig ?? env.GRAPHLOOM_SUPERVISOR_CONFIG ?? path.join(env.HOME ?? os.homedir(), ".config", "graphloom", "supervisor.json");
  const runner = await configReference(runnerPath, true);
  const supervisor = await configReference(supervisorPath, config.supervisorConfig !== undefined || env.GRAPHLOOM_SUPERVISOR_CONFIG !== undefined);
  return {
    task, taskDigest: createHash("sha256").update(task).digest("hex"), taskPath: absolute,
    ...(intake.config !== undefined ? { config: intake.config.text, configDigest: intake.config.sha256 } : {}),
    repoPath: await realpath(intake.repoPath), baseCommit: intake.pinnedHead,
    bundlePath: await realpath(intake.bundle.bundlePath), bundleDigest: await digestExecutorSource(intake.bundle.bundlePath),
    runtimePath: path.join(self.record.root, "apps", "graphloom", "dist", "main.js"),
    runtimeNode: await realpath(process.execPath), runtimeRoot: self.record.root, runtimeVersion: self.record.version,
    runtimeDigest: await runtimeDigest(self.record.root),
    runtimeConfig: { ...(runner !== undefined ? { runner } : {}), ...(supervisor !== undefined ? { supervisor } : {}) },
  };
}

export function inputDigest(input: HubInput): string { return stableHash(input); }

export async function verifyHubInput(input: HubStoredInput, initial: boolean): Promise<void> {
  await verifyHubTaskInput(input, initial);
  if (input.runtimeRoot === undefined || await runtimeDigest(input.runtimeRoot) !== input.runtimeDigest) throw new Error("pinned runtime changed or is missing; restore its exact build before continuing");
}

/** Task/config pins survive an explicit runtime upgrade; verify them independently of the old installation. */
export async function verifyHubTaskInput(input: HubStoredInput, initial: boolean): Promise<void> {
  if (input.taskDigest === undefined || createHash("sha256").update(await boundedText(input.taskFile, MAX_TASK_BYTES)).digest("hex") !== input.taskDigest) throw new Error("captured task does not match its digest");
  if (initial && await digestExecutorSource(input.bundlePath) !== input.bundleDigest) throw new Error("queued plugin bundle changed; create a replacement submission with the intended bundle");
  for (const ref of Object.values(input.runtimeConfig ?? {})) {
    if (await fileDigest(ref.path) !== ref.digest) throw new Error(`pinned runtime configuration changed: ${ref.path}`);
  }
  if (input.configFile !== undefined && await fileDigest(input.configFile) !== input.configDigest) throw new Error("captured task config does not match its digest");
}

/** Private links make the controller's ordinary relative-path intake rules apply unchanged. */
export async function materializeHubTask(input: HubStoredInput): Promise<string> {
  const directory = path.dirname(input.taskFile);
  const captured = await boundedText(input.taskFile, MAX_TASK_BYTES);
  const task = parseTaskYaml(captured);
  await mkdir(path.join(directory, "plugins"), { recursive: true, mode: 0o700 });
  await checkedLink(input.repoPath, path.join(directory, "repo"));
  await checkedLink(input.bundlePath, path.join(directory, "plugins", task.graph));
  // Preserve the request's original representation, including indentation and tabs.
  // Intake accepts a deliberately small YAML subset; serializing its strings again
  // can change their meaning even when a general YAML serializer would round-trip.
  let text = captured.replace(/^repo:.*$/gm, "repo: repo");
  const pin = (key: string, value: string) => {
    const field = new RegExp(`^${key}:.*$`, "gm");
    if (field.test(text)) text = text.replace(field, `${key}: ${value}`);
    else text = `${text.replace(/\n?$/, "\n")}${key}: ${value}\n`;
  };
  pin("base", input.baseCommit);
  if (input.configFile !== undefined) pin("config", path.basename(input.configFile));
  const rewritten = parseTaskYaml(text);
  if (rewritten.request !== task.request) throw new Error("captured request changed during materialization");
  const target = path.join(directory, "launch-task.yaml");
  try {
    if (await readFile(target, "utf8") !== text) throw new Error("captured launch task changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writePrivateJsonOrText(target, text);
  }
  return target;
}

async function checkedLink(target: string, link: string): Promise<void> {
  try { await symlink(target, link, "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (await realpath(link) !== await realpath(target)) throw new Error(`captured input link changed: ${link}`);
}

export async function boundedText(file: string, max: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    if ((await handle.stat()).size > max) throw new Error(`${file} exceeds ${max} bytes`);
    const bytes = Buffer.alloc(max + 1);
    let size = 0;
    while (size <= max) {
      const got = await handle.read(bytes, size, bytes.length - size, null);
      if (got.bytesRead === 0) break;
      size += got.bytesRead;
      if (size > max) throw new Error(`${file} exceeds ${max} bytes`);
    }
    const content = bytes.subarray(0, size);
    const text = content.toString("utf8");
    if (!Buffer.from(text).equals(content)) throw new Error(`${file} must be UTF-8`);
    return text;
  } finally { await handle.close(); }
}

export async function writePrivateJsonOrText(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const dir = await open(path.dirname(file), "r");
    try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function configReference(file: string, required: boolean): Promise<{ path: string; digest: string } | undefined> {
  try {
    const resolved = await realpath(file);
    return { path: resolved, digest: await fileDigest(resolved) };
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function fileDigest(file: string): Promise<string> { return createHash("sha256").update(await readFile(file)).digest("hex"); }

/** Pin built modules and lockfile; source edits without rebuilding do not alter the executable. */
export async function runtimeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of ["package.json", "package-lock.json"]) hash.update(file).update(await readFile(path.join(root, file)));
  for (const parent of ["packages", "executors", "apps"]) {
    for (const name of (await readdir(path.join(root, parent))).sort()) {
      const dist = path.join(root, parent, name, "dist");
      try { if (!(await lstat(dist)).isDirectory()) continue; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      hash.update(`${parent}/${name}`).update(await digestExecutorSource(dist));
    }
  }
  return hash.digest("hex");
}
