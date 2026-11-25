// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Docker-confined jobs' memory (docs/design-run-hub.md §6.2): each container gets
 * `--memory` and an equal `--memory-swap`, the runner config's `docker.maxMemory`
 * caps them, and a container the kernel OOM-killed is a recognised failure. A stub
 * `docker` on PATH stands in for the daemon; nothing here starts a container.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerConfinement, JobSpec } from "@graphloom/sdk";
import { containerMemory, dockerRunArgs, dockerSizeBytes, withDockerConfinement } from "./sandbox-docker.js";
import type { JobContext, JobEvidenceItem, Runner } from "./types.js";

/** The built wrapper: the package's test script builds before it runs vitest. */
const WRAPPER = fileURLToPath(new URL("../dist/sandbox-docker-run.js", import.meta.url));
const IMAGE = "golang@sha256:" + "a".repeat(64);
const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

function confinement(memory = "8g"): DockerConfinement {
  return { kind: "docker", image: IMAGE, cpus: 2, memory, pids: 128, tmp: "64m", wallClockMs: 60_000, writable: ["."], readOnly: [], env: {} };
}

/** A stub docker: `run` records its arguments and exits with $STUB_RUN_EXIT; `inspect` says $STUB_OOM. */
async function stubDocker(runExit: number, oomKilled: boolean) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-docker-memory-"));
  temporary.push(dir);
  await writeFile(path.join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
case "$1" in
  run) exit ${runExit} ;;
  inspect) echo ${oomKilled ? "true" : "false"}; exit 0 ;;
  info) echo '[]'; exit 0 ;;
  *) exit 0 ;;
esac
`);
  await chmod(path.join(dir, "docker"), 0o755);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH ?? ""}`);
  const work = path.join(dir, "work");
  await mkdir(work);
  return { dir, work, calls: async () => (await readFile(path.join(dir, "calls"), "utf8")).trim().split("\n") };
}

/** Runs each rewritten command (the wrapper) as the command executor would, and reports like it. */
const commandRunner: Runner = {
  async runJob(job, ctx) {
    const commands = (job.input as { commands: Array<{ id: string; argv: string[] }> }).commands;
    const evidence: JobEvidenceItem[] = [];
    const failures: string[] = [];
    for (const command of commands) {
      const [node, , spec] = command.argv;
      const run = spawnSync(node!, [WRAPPER, spec!], { encoding: "utf8", env: process.env });
      evidence.push({ kind: "command", payload: { command: { id: command.id, argv: command.argv, exitCode: run.status, stderrTail: run.stderr } } });
      if (run.status !== 0) failures.push(`${command.id} exited ${run.status}`);
    }
    return { status: "ok", summary: failures.length ? failures.join("; ") : `${commands.length} command(s) succeeded`, runId: ctx.runId, operationId: ctx.operationId, generation: ctx.generation, evidence };
  },
};

function job(memory: string): JobSpec {
  return { stageId: "check", kind: "command", purpose: "check", instruction: "run the tests", readOnly: true, input: { commands: [{ id: "test", argv: ["go", "test", "./..."] }] }, confinement: confinement(memory) };
}
function context(dir: string, work: string): JobContext {
  return { runId: "run-memory", operationId: `op-${Math.random().toString(36).slice(2, 8)}`, generation: 1, worktreePath: work, artifactDir: path.join(dir, "artifacts") };
}

describe("docker-confined jobs' memory", () => {
  it("passes --memory with an equal --memory-swap, without --rm, and caps it at the runner's ceiling", () => {
    const args = dockerRunArgs(confinement("8g"), { runId: "r", operationId: "o", name: "n", cwd: "/w", writable: [], readOnly: [], argv: ["true"], uid: 1, gid: 1 });
    expect(args.join(" ")).toContain("--memory 8g --memory-swap 8g");
    expect(args).not.toContain("--rm");
    expect(containerMemory("8g", { maxMemory: "6g" })).toEqual({ memory: "6g", capped: true });
    expect(containerMemory("4g", { maxMemory: "6g" })).toEqual({ memory: "4g", capped: false });
    expect(containerMemory("8g")).toEqual({ memory: "8g", capped: false });
    expect(dockerSizeBytes("512m")).toBe(512 * 1024 ** 2);
    expect(() => withDockerConfinement(commandRunner, { maxMemory: "lots" })).toThrow(/docker size/);
  });

  it("reports a container the kernel OOM-killed at its memory limit as that, and removes it", async () => {
    const stub = await stubDocker(137, true);
    const runner = withDockerConfinement(commandRunner, { maxMemory: "6g" });
    const result = await runner.runJob(job("8g"), context(stub.dir, stub.work));
    expect(result.summary).toBe("test exited 137; test: the container was killed at its memory limit (--memory 6g, the runner config's docker.maxMemory in place of the declared 8g; exit 137, OOMKilled)");
    const command = (result.evidence![0]!.payload as { command: { argv: string[]; stderrTail: string; sandbox: Record<string, unknown> } }).command;
    expect(command.argv).toEqual(["go", "test", "./..."]);
    expect(command.sandbox).toMatchObject({ kind: "docker", image: IMAGE, memory: "6g", declaredMemory: "8g", oomKilled: true });
    expect(command.stderrTail).toContain("was killed at its memory limit (--memory 6g; OOMKilled)");
    const calls = await stub.calls();
    const run = calls.find((call) => call.startsWith("run "))!;
    expect(run).toContain("--memory 6g --memory-swap 6g");
    expect(run).not.toContain("--rm");
    expect(calls).toContainEqual(expect.stringMatching(/^inspect --format \{\{\.State\.OOMKilled\}\} graphloom-run-memory-/));
    expect(calls).toContainEqual(expect.stringMatching(/^rm -f -v graphloom-run-memory-/));
  });

  it("leaves an exit 137 that was not an OOM kill, and a job under the ceiling, as they are", async () => {
    const stub = await stubDocker(137, false);
    const result = await withDockerConfinement(commandRunner, { maxMemory: "6g" }).runJob(job("4g"), context(stub.dir, stub.work));
    expect(result.summary).toBe("test exited 137");
    const sandbox = (result.evidence![0]!.payload as { command: { sandbox: Record<string, unknown> } }).command.sandbox;
    expect(sandbox).toEqual({ kind: "docker", image: IMAGE, memory: "4g" });
    expect((await stub.calls()).find((call) => call.startsWith("run "))).toContain("--memory 4g --memory-swap 4g");
  });
});
