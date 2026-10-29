// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BUILTIN_COMMAND_EXECUTOR_ID, SCRATCH_MOUNT_PREFIX, pinJobExecutor, type DockerConfinement, type JobSpec } from "@graphloom/sdk";
import { ensureRealDir, ensureRealDirBelow } from "./confine.js";
import type { JobContext, JobEvidenceItem, JobResult, Runner } from "./types.js";

const execFileAsync = promisify(execFile);

/** The label every container of a run carries, so a resume can find what a stopped controller left. */
export const RUN_LABEL = "graphloom.run";
const OPERATION_LABEL = "graphloom.op";
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const DOCKER_TIMEOUT_MS = 30_000;

/** The module that runs one container for the command executor and kills it by name when stopped. */
export const DOCKER_RUN_MODULE = fileURLToPath(new URL("./sandbox-docker-run.js", import.meta.url));

/** What the wrapper reads from its spec file. */
export interface DockerRunSpec {
  name: string;
  wallClockMs: number;
  /** Arguments after `docker`. */
  args: string[];
  /**
   * Mount sources below a root the job can change (the workspace, the run's scratch): each component
   * is checked again, without following links, just before this container starts, since an earlier
   * command of the job may have replaced one with a link.
   */
  guards: Array<{ root: string; rel: string }>;
}

export interface DockerRunOptions {
  runId: string;
  operationId: string;
  /** Unique container name. */
  name: string;
  /** The job's working directory inside the container, also the host path it is mounted from when named. */
  cwd: string;
  /** Resolved absolute host paths, each mounted at the same path. */
  writable: readonly string[];
  readOnly: readonly string[];
  argv: readonly string[];
  uid: number;
  gid: number;
}

/**
 * The arguments after `docker` that run `argv` in one container, built from the confinement's data
 * alone. The image is never pulled, nothing of the host environment is passed but the declared
 * variables, and the network is off.
 */
export function dockerRunArgs(spec: DockerConfinement, options: DockerRunOptions): string[] {
  if (!DIGEST.test(spec.image)) throw new Error(`docker image ${JSON.stringify(spec.image)} must be pinned by digest (name@sha256:...)`);
  if (options.argv.length === 0 || options.argv[0] === "") throw new Error("a docker command needs a program");
  const [program, ...rest] = options.argv as [string, ...string[]];
  return [
    "run",
    "--rm",
    "--name", options.name,
    "--label", `${RUN_LABEL}=${options.runId}`,
    "--label", `${OPERATION_LABEL}=${options.operationId}`,
    "--network", "none",
    "--cpus", String(spec.cpus),
    "--memory", spec.memory,
    "--memory-swap", spec.memory,
    "--pids-limit", String(spec.pids),
    "--read-only",
    // Executable, so toolchains can run what they build in /tmp (Docker's default tmpfs is noexec).
    "--tmpfs", `/tmp:rw,exec,nosuid,nodev,size=${spec.tmp}`,
    "--user", `${options.uid}:${options.gid}`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pull", "never",
    ...options.writable.flatMap((p) => ["-v", `${p}:${p}:rw`]),
    ...options.readOnly.flatMap((p) => ["-v", `${p}:${p}:ro`]),
    "-w", options.cwd,
    ...Object.entries(spec.env).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    "--entrypoint", program,
    spec.image,
    ...rest,
  ];
}

/** A host path a mount names: absolute, `.` or relative to the workspace, or `@scratch/<dir>` in the run's scratch. */
function resolveMount(mount: string, cwd: string, scratchDir: string | undefined): { path: string; create: boolean } | string {
  if (mount.startsWith(SCRATCH_MOUNT_PREFIX)) {
    if (scratchDir === undefined) return `mount ${mount} names the run's scratch directory, and the job was given none`;
    return { path: path.join(scratchDir, mount.slice(SCRATCH_MOUNT_PREFIX.length)), create: true };
  }
  return { path: path.isAbsolute(mount) ? path.normalize(mount) : path.resolve(cwd, mount), create: false };
}

/** Container names Docker accepts: `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. */
function containerName(runId: string, operationId: string, index: number): string {
  const part = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48);
  return `graphloom-${part(runId)}-${part(operationId)}-${index}-${randomBytes(3).toString("hex")}`;
}

/** Why the image cannot be used for a job now (no docker, no daemon, image missing), or undefined when it can. */
export async function dockerImageProblem(image: string): Promise<string | undefined> {
  try {
    await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { timeout: DOCKER_TIMEOUT_MS });
    return undefined;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") return "the docker CLI is not installed, so the sandbox cannot run";
    const text = `${e.stderr ?? ""}`.trim();
    if (/cannot connect|is the docker daemon running|permission denied/i.test(text)) {
      return `the docker daemon is not reachable by this user (${text.split("\n")[0]}), so the sandbox cannot run`;
    }
    return `docker image ${image} is not present locally; pull it before the run (graphloom sandbox pull ${image}), jobs never pull`;
  }
}

export type ImageOutcome =
  | { status: "present" }
  | { status: "pulled" }
  | { status: "missing"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Make sure `image` (pinned by digest) is in the local image store, before a run: present as it is,
 * or pulled when `pull` is true. The one place an image is fetched; a job never pulls, so a run
 * cannot depend on the network at the time its sandbox starts. A digest fixes the image's bytes,
 * so what is pulled is what the plugin pinned.
 */
export async function ensureDockerImage(image: string, options: { pull: boolean }): Promise<ImageOutcome> {
  if (!DIGEST.test(image)) return { status: "failed", reason: `image ${JSON.stringify(image)} must be pinned by digest (name@sha256:<64 hex digits>)` };
  if (/^[-.]/.test(image)) return { status: "failed", reason: `image ${JSON.stringify(image)} is not a valid image reference` };
  const problem = await dockerImageProblem(image);
  if (problem === undefined) return { status: "present" };
  // Only a missing image is fixed by pulling; no CLI or no daemon is not.
  if (!/is not present locally/.test(problem)) return { status: "failed", reason: problem };
  if (!options.pull) return { status: "missing", reason: `docker image ${image} is not present locally` };
  try {
    await execFileAsync("docker", ["pull", image], { timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return { status: "failed", reason: `docker pull ${image} failed: ${(e.stderr ?? e.message).trim().split("\n").slice(-2).join(" ")}` };
  }
  const after = await dockerImageProblem(image);
  return after === undefined ? { status: "pulled" } : { status: "failed", reason: `docker pulled ${image} but it is still not in the local store: ${after}` };
}

let rootless: Promise<boolean> | undefined;

/** Whether the daemon is rootless: its `root` is the operator, and the operator's own uid is a stranger in it. */
export function daemonIsRootless(): Promise<boolean> {
  rootless ??= execFileAsync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { timeout: DOCKER_TIMEOUT_MS }).then(
    ({ stdout }) => stdout.includes("rootless"),
    () => false,
  );
  return rootless;
}

/**
 * The user the container's commands run as. A rootful daemon maps container ids to host ids as they
 * are, so the operator's own uid keeps owning the workspace. In a rootless daemon the operator is
 * container root (all other ids are subordinate ids that own nothing of theirs), so the commands
 * run as that unprivileged-on-the-host root, which `--cap-drop ALL` and `no-new-privileges` still bind.
 */
export function containerIdentity(rootlessDaemon: boolean, uid: number, gid: number): { uid: number; gid: number } {
  return rootlessDaemon ? { uid: 0, gid: 0 } : { uid, gid };
}

/** `docker kill` each named container; one that is already gone is fine. */
export async function killContainers(names: readonly string[]): Promise<void> {
  await Promise.all(names.map((name) => execFileAsync("docker", ["kill", name], { timeout: DOCKER_TIMEOUT_MS }).catch(() => undefined)));
}

async function removeContainers(ids: readonly string[]): Promise<void> {
  if (ids.length > 0) await execFileAsync("docker", ["rm", "-f", ...ids], { timeout: DOCKER_TIMEOUT_MS }).catch(() => undefined);
}

/**
 * Remove every container labelled with the run, running or not: what a stopped controller left.
 * Best effort; a machine without Docker has none.
 */
export async function removeRunContainers(runId: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", ["ps", "-aq", "--filter", `label=${RUN_LABEL}=${runId}`], { timeout: DOCKER_TIMEOUT_MS });
    await removeContainers(stdout.split("\n").filter((id) => id !== ""));
  } catch {
    /* no docker CLI or daemon: nothing of ours is running */
  }
}

/** The first component of `rel` below `root` that is a symbolic link, if any. */
function linkBelow(root: string, rel: string): string | undefined {
  let current = root;
  for (const part of path.normalize(rel).split(path.sep)) {
    if (part === "." || part === "") continue;
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

interface OriginalCommand {
  id: string;
  argv: string[];
}

interface PreparedDockerJob {
  job: JobSpec;
  names: string[];
  originals: Map<string, OriginalCommand>;
}

/**
 * The job as the command executor will run it: each command becomes one wrapper run that starts its
 * container and kills it by name on a stop or when the container's wall clock ends. The container
 * description goes in a spec file under the run's artifacts, so it does not count against the
 * executor's argument limits. Or why the job cannot run.
 */
async function prepareDockerJob(job: JobSpec, spec: DockerConfinement, ctx: JobContext): Promise<PreparedDockerJob | { refusal: string }> {
  const { confinement: _spec, ...plain } = job;
  void _spec;
  const input = job.input as { commands?: unknown; env?: unknown } | undefined;
  const commands = input?.commands;
  if (!Array.isArray(commands) || commands.some((c) => c === null || typeof c !== "object" || !Array.isArray((c as { argv?: unknown }).argv))) {
    // Not a command input: the executor says what is wrong with it.
    return { job: plain, names: [], originals: new Map() };
  }
  if (input?.env !== undefined && Object.keys(input.env as object).length > 0) {
    return { refusal: "a command job in a docker confinement takes its environment from the confinement's env, not from input.env" };
  }
  const problem = await dockerImageProblem(spec.image);
  if (problem !== undefined) return { refusal: problem };

  const mounts = (list: readonly string[]): string[] | { refusal: string } => {
    const resolved: string[] = [];
    for (const mount of list) {
      const target = resolveMount(mount, ctx.worktreePath, ctx.scratchDir);
      if (typeof target === "string") return { refusal: target };
      resolved.push(target.path);
    }
    return resolved;
  };
  const writable = mounts(spec.writable);
  if (!Array.isArray(writable)) return writable;
  const readOnly = mounts(spec.readOnly);
  if (!Array.isArray(readOnly)) return readOnly;
  // Docker follows a link at a mount source, so a link an earlier job planted must never be one. Scratch
  // is the runner's: each component is checked without following links, and a link in the way is
  // replaced. A path under the workspace is the job's own, so a link there refuses the job.
  for (const mount of [...spec.writable, ...spec.readOnly]) {
    if (mount.startsWith(SCRATCH_MOUNT_PREFIX) && ctx.scratchDir !== undefined) {
      ensureRealDir(ctx.scratchDir);
      ensureRealDirBelow(ctx.scratchDir, mount.slice(SCRATCH_MOUNT_PREFIX.length));
    } else if (!path.isAbsolute(mount)) {
      const link = linkBelow(ctx.worktreePath, mount);
      if (link !== undefined) return { refusal: `docker confinement mount ${mount} passes through a symbolic link (${link}), which a container would follow out of the workspace` };
    }
  }
  const missing = [...writable, ...readOnly].filter((p) => !existsSync(p));
  if (missing.length > 0) return { refusal: `docker confinement mounts paths that do not exist: ${missing.join(", ")}` };
  const notDirectory = writable.filter((p) => !statSync(p).isDirectory());
  if (notDirectory.length > 0) return { refusal: `docker confinement's writable paths must be directories: ${notDirectory.join(", ")}` };

  const specDir = path.join(ctx.artifactDir, "docker", ctx.operationId);
  await mkdir(specDir, { recursive: true });
  const guards: Array<{ root: string; rel: string }> = [];
  for (const mount of [...spec.writable, ...spec.readOnly]) {
    if (mount.startsWith(SCRATCH_MOUNT_PREFIX) && ctx.scratchDir !== undefined) guards.push({ root: ctx.scratchDir, rel: mount.slice(SCRATCH_MOUNT_PREFIX.length) });
    else if (!path.isAbsolute(mount) && mount !== ".") guards.push({ root: ctx.worktreePath, rel: mount });
  }
  const names: string[] = [];
  const originals = new Map<string, OriginalCommand>();
  const rewritten: unknown[] = [];
  for (const [index, raw] of (commands as Array<{ id: string; argv: string[] }>).entries()) {
    const name = containerName(ctx.runId, ctx.operationId, index);
    names.push(name);
    originals.set(raw.id, { id: raw.id, argv: [...raw.argv] });
    let args: string[];
    try {
      args = dockerRunArgs(spec, {
        runId: ctx.runId,
        operationId: ctx.operationId,
        name,
        cwd: ctx.worktreePath,
        writable,
        readOnly,
        argv: raw.argv,
        ...containerIdentity(await daemonIsRootless(), process.getuid?.() ?? 0, process.getgid?.() ?? 0),
      });
    } catch (err) {
      return { refusal: err instanceof Error ? err.message : String(err) };
    }
    const specFile = path.join(specDir, `${index}.json`);
    const runSpec: DockerRunSpec = { name, wallClockMs: spec.wallClockMs, args, guards };
    await writeFile(specFile, JSON.stringify(runSpec, null, 2), "utf8");
    rewritten.push({ ...(raw as object), argv: [process.execPath, DOCKER_RUN_MODULE, specFile] });
  }
  return { job: { ...plain, input: { ...(input as object), commands: rewritten } }, names, originals };
}

/** The evidence of a docker job names the command the plugin declared, and the image it ran in. */
function restoreEvidence(evidence: JobEvidenceItem[] | undefined, spec: DockerConfinement, originals: ReadonlyMap<string, OriginalCommand>): JobEvidenceItem[] | undefined {
  if (evidence === undefined) return undefined;
  return evidence.map((item) => {
    const command = (item.payload as { command?: { id?: unknown } } | undefined)?.command;
    const original = typeof command?.id === "string" ? originals.get(command.id) : undefined;
    if (item.kind !== "command" || command === undefined || original === undefined) return item;
    return { ...item, payload: { ...(item.payload as object), command: { ...command, argv: original.argv, sandbox: { kind: "docker", image: spec.image } } } };
  });
}

/**
 * Serve a job's docker confinement for the built-in command executor, which `inner` runs: the job's
 * commands run inside containers, which are killed by name when the job stops or times out, and
 * removed afterwards. `releaseRun` removes the containers a stopped controller left behind. A job
 * with another executor, or no docker confinement, passes through untouched.
 */
export function withDockerConfinement(inner: Runner): Runner {
  const applies = (job: JobSpec): { pinned: JobSpec; spec: DockerConfinement } | undefined => {
    const pinned = pinJobExecutor(job);
    return pinned.confinement?.kind === "docker" && pinned.executor?.id === BUILTIN_COMMAND_EXECUTOR_ID
      ? { pinned, spec: pinned.confinement }
      : undefined;
  };
  return {
    ...inner,
    async checkJob(job, ctx) {
      const found = applies(job);
      if (found === undefined) return inner.checkJob?.(job, ctx);
      // The container, not the host, is where the commands write: the host scope does not apply to them.
      const { confinement: _spec, ...plain } = found.pinned;
      void _spec;
      return inner.checkJob?.(plain, ctx === undefined ? undefined : { ...(ctx.executorSource !== undefined ? { executorSource: ctx.executorSource } : {}) });
    },
    async runJob(job, ctx) {
      const found = applies(job);
      if (found === undefined) return inner.runJob(job, ctx);
      const failed = (summary: string): JobResult => ({ status: "failed", summary, runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation });
      let prepared: PreparedDockerJob | { refusal: string };
      try {
        prepared = await prepareDockerJob(found.pinned, found.spec, ctx);
      } catch (err) {
        return failed(`docker confinement could not be prepared, so the job was not run: ${err instanceof Error ? err.message : String(err)}`);
      }
      if ("refusal" in prepared) return failed(`docker confinement refused the job, which was not run: ${prepared.refusal}`);
      const { names } = prepared;
      const onAbort = () => void killContainers(names);
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await inner.runJob(prepared.job, ctx);
        const evidence = restoreEvidence(result.evidence, found.spec, prepared.originals);
        return evidence !== undefined ? { ...result, evidence } : result;
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
        // Anything the job left running goes with it.
        await removeContainers(names);
      }
    },
    async releaseRun(runId) {
      await removeRunContainers(runId);
      await inner.releaseRun?.(runId);
    },
  };
}
