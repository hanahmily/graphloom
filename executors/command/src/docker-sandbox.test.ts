// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinExecutorRunner, dockerRunArgs, type JobContext, type Runner } from "@graphloom/runner";
import type { DockerConfinement, JobSpec } from "@graphloom/sdk";
import type { CommandOutcome } from "./run.js";

/** A small image, pinned by digest: the sandbox refuses anything else. */
const IMAGE = "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";

/** Why these tests cannot run here, or undefined when Docker and the image are available. */
function dockerUnavailable(): string | undefined {
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 30_000 });
  if (info.error !== undefined || info.status !== 0) return "the docker CLI or daemon is not available";
  if (spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0) return undefined;
  // Test setup is the one place an image is pulled; a job never pulls.
  const pull = spawnSync("docker", ["pull", IMAGE], { encoding: "utf8", timeout: 180_000 });
  return pull.status === 0 ? undefined : `${IMAGE} is not present locally and could not be pulled`;
}

const unavailable = dockerUnavailable();
if (unavailable !== undefined) console.warn(`docker sandbox tests skipped: ${unavailable}`);

const HOST_HOME = os.homedir();
let dir: string;
let work: string;
let scratch: string;
let runner: Runner;
let runId: string;
let op = 0;

const noFallback = { runJob: async () => { throw new Error("not served"); } };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gl-docker-"));
  work = path.join(dir, "work");
  scratch = path.join(dir, "scratch");
  await mkdir(work);
  await mkdir(scratch);
  await writeFile(path.join(work, "tracked.txt"), "original\n");
  runId = `dockertest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const { commandBinding, commandExecutorPackage } = await import("../dist/package.js");
  runner = createBuiltinExecutorRunner({
    packages: [{ manifest: commandExecutorPackage, ...commandBinding() }],
    fallback: noFallback,
    stopGraceMs: 3_000,
  });
});

afterEach(async () => {
  spawnSync("sh", ["-c", `docker ps -aq --filter label=graphloom.run=${runId} | xargs -r docker rm -f`], { stdio: "ignore" });
  await rm(dir, { recursive: true, force: true });
});

function confinement(over: Partial<DockerConfinement> = {}): DockerConfinement {
  return {
    kind: "docker",
    image: IMAGE,
    cpus: 1,
    memory: "256m",
    pids: 64,
    tmp: "16m",
    wallClockMs: 60_000,
    writable: ["."],
    readOnly: [],
    env: { HOME: "/tmp", FOO: "bar" },
    ...over,
  };
}

function job(commands: Array<{ id: string; argv: string[] }>, over: Partial<DockerConfinement> = {}, extra: Partial<JobSpec> = {}): JobSpec {
  return {
    stageId: "check",
    kind: "command",
    purpose: "check",
    instruction: "run contributor code",
    readOnly: true,
    input: { commands, continueOnFailure: true },
    confinement: confinement(over),
    ...extra,
  };
}

function ctx(signal?: AbortSignal): JobContext {
  op += 1;
  return {
    runId,
    operationId: `op-${op}`,
    generation: 1,
    worktreePath: work,
    artifactDir: path.join(dir, "artifacts"),
    scratchDir: scratch,
    ...(signal !== undefined ? { signal } : {}),
  };
}

async function runCommands(commands: Array<{ id: string; argv: string[] }>, over: Partial<DockerConfinement> = {}): Promise<CommandOutcome[]> {
  const result = await runner.runJob(job(commands, over), ctx());
  expect(result.status, result.summary).toBe("ok");
  return result.evidence!.map((e) => (e.payload as { command: CommandOutcome }).command);
}

const sh = (script: string) => ["sh", "-c", script];

function running(): string[] {
  return spawnSync("docker", ["ps", "-q", "--filter", `label=graphloom.run=${runId}`], { encoding: "utf8" }).stdout.split("\n").filter((l) => l !== "");
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return condition();
}

describe("docker confinement: what the job is built from", () => {
  it("builds the documented docker run from data alone", () => {
    const args = dockerRunArgs(confinement({ writable: [], readOnly: [] }), {
      runId: "r1",
      operationId: "o1",
      name: "graphloom-r1-o1-0-abc",
      cwd: "/w",
      writable: ["/w", "/cache"],
      readOnly: ["/mod"],
      argv: ["go", "test", "./..."],
      uid: 1000,
      gid: 1001,
    });
    const text = args.join(" ");
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--name"]);
    for (const part of [
      "--label graphloom.run=r1",
      "--network none",
      "--cpus 1",
      "--memory 256m --memory-swap 256m",
      "--pids-limit 64",
      "--read-only",
      "--tmpfs /tmp:rw,exec,nosuid,nodev,size=16m",
      "--user 1000:1001",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--pull never",
      "-v /w:/w:rw -v /cache:/cache:rw -v /mod:/mod:ro",
      "-w /w",
      "--env HOME=/tmp --env FOO=bar",
      `--entrypoint go ${IMAGE} test ./...`,
    ]) {
      expect(text).toContain(part);
    }
  });

  it("refuses an image that is not pinned by digest", () => {
    expect(() =>
      dockerRunArgs(confinement({ image: "busybox:latest" }), { runId: "r", operationId: "o", name: "n", cwd: "/w", writable: [], readOnly: [], argv: ["true"], uid: 1, gid: 1 }),
    ).toThrow(/pinned by digest/);
  });
});

describe.skipIf(unavailable !== undefined)("a command job in a docker confinement", () => {
  it("runs its argv in the container, in the workspace, and records the declared command", async () => {
    const [pwd, ident] = await runCommands([{ id: "pwd", argv: ["pwd"] }, { id: "id", argv: ["id", "-u"] }]);
    expect(pwd).toMatchObject({ id: "pwd", argv: ["pwd"], exitCode: 0 });
    expect(pwd!.stdoutTail.trim()).toBe(work);
    expect(ident!.stdoutTail.trim()).toBe(String(process.getuid!()));
    expect((pwd as unknown as { sandbox: { image: string } }).sandbox.image).toBe(IMAGE);
  });

  it("has no network: a command that dials out fails", async () => {
    const [nets, dial] = await runCommands([
      { id: "nets", argv: sh("ls /sys/class/net") },
      { id: "dial", argv: sh("nc -w 3 1.1.1.1 80 </dev/null") },
    ]);
    expect(nets!.stdoutTail.trim()).toBe("lo");
    expect(dial!.exitCode).not.toBe(0);
  });

  it("stops a fork bomb at the pids limit, leaving the host alone", async () => {
    // Only shell builtins after the loop: the shell itself cannot fork once the limit is reached.
    const [bomb] = await runCommands(
      [{ id: "bomb", argv: sh('(for i in $(seq 1 400); do sleep 4 & done) 2>&1; read n < /sys/fs/cgroup/pids.current; echo "alive=$n"') }],
      { pids: 40 },
    );
    const alive = Number(/alive=(\d+)/.exec(bomb!.stdoutTail)?.[1]);
    expect(alive).toBeGreaterThan(30);
    expect(alive).toBeLessThanOrEqual(40);
    expect(bomb!.stderrTail + bomb!.stdoutTail).toMatch(/can't fork|Resource temporarily unavailable/i);
  }, 90_000);

  it("kills an allocation beyond the memory limit", async () => {
    const [hog] = await runCommands([{ id: "hog", argv: sh('x=$(head -c 400000000 /dev/zero | tr "\\0" a); echo survived') }], { memory: "64m" });
    expect(hog!.stdoutTail).not.toContain("survived");
    expect(hog!.exitCode).toBe(137);
  }, 90_000);

  it("keeps the root filesystem read-only and writes only to the declared paths", async () => {
    const cache = path.join(scratch, "cache");
    const ro = path.join(dir, "ro-input");
    const hidden = path.join(dir, "undeclared");
    await mkdir(ro);
    await mkdir(hidden);
    await writeFile(path.join(ro, "dep.txt"), "dep");
    await writeFile(path.join(hidden, "secret.txt"), "secret");
    const [probe] = await runCommands(
      [
        {
          id: "probe",
          argv: sh(
            [
              'touch /etc/x 2>/dev/null && echo root-writable',
              'touch /usr/x 2>/dev/null && echo usr-writable',
              `echo hello > ${work}/out.txt && echo work-ok`,
              `echo hello > ${cache}/out.txt && echo cache-ok`,
              `cat ${ro}/dep.txt; echo`,
              `touch ${ro}/new 2>/dev/null && echo ro-writable`,
              `cat ${hidden}/secret.txt 2>/dev/null && echo undeclared-visible`,
              'echo tmp > /tmp/t && echo tmp-ok',
              'cp /bin/busybox /tmp/busybox && /tmp/busybox true && echo tmp-exec-ok',
              'true',
            ].join("; "),
          ),
        },
      ],
      { writable: [".", "@scratch/cache"], readOnly: [ro] },
    );
    const out = probe!.stdoutTail;
    expect(out).not.toMatch(/root-writable|usr-writable|ro-writable|undeclared-visible/);
    expect(out).toContain("work-ok");
    expect(out).toContain("cache-ok");
    expect(out).toContain("dep");
    expect(out).toContain("tmp-ok");
    expect(out).toContain("tmp-exec-ok");
    expect(await readFile(path.join(work, "out.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(path.join(cache, "out.txt"), "utf8")).toBe("hello\n");
    await expect(readdir(ro)).resolves.toEqual(["dep.txt"]);
  });

  it("sees no host home directory and none of the host environment", async () => {
    process.env.GRAPHLOOM_TEST_SECRET = "leaked-credential";
    try {
      const [probe] = await runCommands([
        { id: "home", argv: sh(`ls -A ${HOST_HOME} 2>&1 | head -3; echo "[$HOME]"; env`) },
      ]);
      expect(probe!.stdoutTail).not.toContain("leaked-credential");
      expect(probe!.stdoutTail).not.toContain("GRAPHLOOM_TEST_SECRET");
      expect(probe!.stdoutTail).not.toMatch(/^USER=/m);
      expect(probe!.stdoutTail).toContain("FOO=bar");
      expect(probe!.stdoutTail).toContain("[/tmp]");
      expect(probe!.stdoutTail).toMatch(/No such file or directory|^\[/m);
      // The host's home is not mounted: nothing of it (a login file) is listed.
      expect(probe!.stdoutTail).not.toContain(".bashrc");
      expect(probe!.stdoutTail).not.toContain(".ssh");
    } finally {
      delete process.env.GRAPHLOOM_TEST_SECRET;
    }
  });

  it("takes its environment from the confinement, never from the input", async () => {
    const result = await runner.runJob(job([{ id: "e", argv: ["env"] }], {}, { input: { commands: [{ id: "e", argv: ["env"] }], env: { EXTRA: "1" } } }), ctx());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/environment from the confinement's env/);
  });

  it("refuses an image that is not pinned by digest, before anything runs", async () => {
    await expect(runner.runJob(job([{ id: "x", argv: ["true"] }], { image: "busybox:1.36" }), ctx())).rejects.toThrow(/pinned by digest/);
  });

  it("never pulls: a missing image is a clear failure and stays missing", async () => {
    const missing = `busybox@sha256:${"0".repeat(64)}`;
    const result = await runner.runJob(job([{ id: "x", argv: ["true"] }], { image: missing }), ctx());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/not present locally; pull it before the run/);
    expect(spawnSync("docker", ["image", "inspect", missing], { stdio: "ignore" }).status).not.toBe(0);
    // A command that reaches the CLI itself refuses to pull too.
    const run = spawnSync("docker", ["run", "--rm", "--pull", "never", missing, "true"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
  });

  it("does not follow a link an earlier job left in scratch, and replaces it", async () => {
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(scratch, "cache"));
    const [probe] = await runCommands(
      [{ id: "w", argv: sh(`echo planted > ${scratch}/cache/f && echo wrote`) }],
      { writable: [".", "@scratch/cache"] },
    );
    expect(probe!.stdoutTail).toContain("wrote");
    expect((await lstat(path.join(scratch, "cache"))).isSymbolicLink()).toBe(false);
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(path.join(scratch, "cache", "f"), "utf8")).toBe("planted\n");
  });

  it("refuses a workspace mount that passes through a link", async () => {
    const outside = path.join(dir, "outside-ws");
    await mkdir(outside);
    await symlink(outside, path.join(work, "build"));
    const result = await runner.runJob(job([{ id: "x", argv: ["true"] }], { writable: ["build"] }), ctx());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/passes through a symbolic link/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a mount that does not exist", async () => {
    const result = await runner.runJob(job([{ id: "x", argv: ["true"] }], { readOnly: [path.join(dir, "missing")] }), ctx());
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/paths that do not exist/);
  });

  it("ends a container at its wall clock", async () => {
    const started = Date.now();
    const [slow] = await runCommands([{ id: "slow", argv: ["sleep", "60"] }], { wallClockMs: 2_000 });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(slow!.exitCode).toBe(124);
    expect(slow!.stderrTail).toMatch(/exceeded its wall clock/);
    expect(await until(() => running().length === 0, 10_000)).toBe(true);
  }, 60_000);

  it("kills the container by name when the run stops", async () => {
    const stop = new AbortController();
    const pending = runner.runJob(job([{ id: "long", argv: ["sleep", "120"] }]), ctx(stop.signal));
    expect(await until(() => running().length === 1, 30_000)).toBe(true);
    stop.abort();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(await until(() => running().length === 0, 15_000)).toBe(true);
    expect(spawnSync("docker", ["ps", "-aq", "--filter", `label=graphloom.run=${runId}`], { encoding: "utf8" }).stdout.trim()).toBe("");
  }, 60_000);

  it("removes a stopped controller's leftover containers on resume, and only that run's", async () => {
    const start = (label: string) =>
      spawnSync("docker", ["run", "-d", "--label", label, "--network", "none", IMAGE, "sleep", "120"], { encoding: "utf8" }).stdout.trim();
    const ours = start(`graphloom.run=${runId}`);
    const other = start("graphloom.run=someone-elses-run");
    try {
      expect(ours).not.toBe("");
      await runner.releaseRun!(runId);
      const exists = (id: string) => spawnSync("docker", ["inspect", id], { stdio: "ignore" }).status === 0;
      expect(exists(ours)).toBe(false);
      expect(exists(other)).toBe(true);
    } finally {
      spawnSync("docker", ["rm", "-f", ours, other], { stdio: "ignore" });
    }
  }, 60_000);

  it("leaves the checkout unchanged when it is mounted read-only", async () => {
    const tree = async () => {
      const hash = createHash("sha256");
      for (const name of (await readdir(work)).sort()) hash.update(name).update(await readFile(path.join(work, name)));
      return hash.digest("hex");
    };
    const before = await tree();
    const [probe] = await runCommands(
      [{ id: "write", argv: sh("echo changed > tracked.txt 2>&1 || echo denied; touch new.txt 2>&1 || echo denied-new; cat tracked.txt") }],
      { writable: [], readOnly: ["."] },
    );
    expect(probe!.stdoutTail).toContain("denied");
    expect(probe!.stdoutTail).toContain("original");
    expect(await tree()).toBe(before);
  });
});
