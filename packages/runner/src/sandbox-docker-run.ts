// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Runs one `docker run` for the command executor (`node sandbox-docker-run.js <spec.json>`) and
 * makes sure its container dies with it. The Docker CLI forwards SIGTERM but not SIGKILL, and a
 * container's first process ignores SIGTERM it does not handle, so on a stop signal or when the
 * container's wall clock ends this kills the container by name before it exits. When the container
 * ends on its own it reads whether the kernel OOM-killed it at its memory limit, writes that beside
 * the spec (`<spec>.end.json`), and removes the container (it runs without --rm so it can be read; its anonymous volumes go with it, as with --rm).
 */

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KILL_WAIT_MS = 10_000;
/**
 * The daemon records `State.OOMKilled` from the cgroup's oom event, which is handled apart from the
 * container's exit event that ends the `docker run` client. On a loaded host the client can return
 * (exit 137) before the flag is set, so one immediate `docker inspect` can read false for a container
 * the kernel did OOM-kill. After an exit 137 the wrapper therefore re-reads, every
 * OOM_POLL_MS, until the flag is true, or the container is final (`exited`/`dead`) and the flag read
 * false OOM_STABLE_READS times in a row, or OOM_WAIT_MS has passed. Only exit 137 pays this wait.
 */
const OOM_WAIT_MS = 2_000;
const OOM_POLL_MS = 100;
const OOM_STABLE_READS = 5;

interface Spec {
  name: string;
  wallClockMs: number;
  args: string[];
  guards: Array<{ root: string; rel: string }>;
  reportAt?: number;
  memory?: string;
}

const specFile = process.argv[2];
if (specFile === undefined) {
  process.stderr.write("usage: sandbox-docker-run <spec.json>\n");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specFile, "utf8")) as Spec;

// An earlier command of the job may have replaced a mount source with a link, which Docker would follow.
for (const guard of spec.guards ?? []) {
  let current = guard.root;
  for (const part of path.normalize(guard.rel).split(path.sep)) {
    if (part === "." || part === "") continue;
    current = path.join(current, part);
    let link = false;
    try {
      link = lstatSync(current).isSymbolicLink();
    } catch {
      break;
    }
    if (link) {
      process.stderr.write(`graphloom: mount source ${current} is a symbolic link, which a container would follow out of its mounts; not started\n`);
      process.exit(125);
    }
  }
}

// The command's report file (`GRAPHLOOM_REPORT_FILE`, a file the executor reads after the command) is the one
// host file a container may write besides its mounts: only that file is mounted, and named for the command inside.
const reportFile = process.env.GRAPHLOOM_REPORT_FILE;
const args = [...spec.args];
if (reportFile !== undefined && reportFile !== "" && path.isAbsolute(reportFile) && !/[:,\n]/.test(reportFile) && spec.reportAt !== undefined && spec.reportAt >= 0) {
  writeFileSync(reportFile, "");
  args.splice(spec.reportAt, 0, "-v", `${reportFile}:${reportFile}:rw`, "--env", `GRAPHLOOM_REPORT_FILE=${reportFile}`);
}

const child = spawn("docker", args, { stdio: ["ignore", "inherit", "inherit"] });
let stopping: "signal" | "wall-clock" | undefined;
let exited = false;

const killContainer = (): void => {
  spawnSync("docker", ["kill", spec.name], { stdio: "ignore", timeout: KILL_WAIT_MS });
};

const stop = (why: "signal" | "wall-clock"): void => {
  if (stopping !== undefined || exited) return;
  stopping = why;
  killContainer();
  // The CLI exits once its container is gone; do not wait on it forever.
  setTimeout(() => process.exit(why === "wall-clock" ? 124 : 143), KILL_WAIT_MS).unref();
};

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => stop("signal"));
const timer = setTimeout(() => {
  process.stderr.write(`graphloom: container ${spec.name} exceeded its wall clock of ${spec.wallClockMs} ms and was killed\n`);
  stop("wall-clock");
}, spec.wallClockMs);

child.once("error", (err) => {
  clearTimeout(timer);
  process.stderr.write(`graphloom: cannot start docker: ${err.message}\n`);
  process.exit(127);
});
const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
/** Whether Docker records the container as killed by the kernel's OOM killer (exit 137 alone could be any SIGKILL). */
const oomKilled = (): boolean => {
  const deadline = Date.now() + OOM_WAIT_MS;
  let stable = 0;
  for (;;) {
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.OOMKilled}} {{.State.Status}}", spec.name], { encoding: "utf8", timeout: KILL_WAIT_MS });
    if (inspect.status === 0) {
      const [flag, status] = inspect.stdout.trim().split(/\s+/);
      if (flag === "true") return true;
      stable = flag === "false" && (status === "exited" || status === "dead") ? stable + 1 : 0;
      if (stable >= OOM_STABLE_READS) return false;
    } else {
      stable = 0;
    }
    if (Date.now() + OOM_POLL_MS >= deadline) return false;
    sleepSync(OOM_POLL_MS);
  }
};
/** The container runs without --rm, so its state can be read: it is removed here once it ended. */
const removeContainer = (): void => {
  spawnSync("docker", ["rm", "-f", "-v", spec.name], { stdio: "ignore", timeout: KILL_WAIT_MS });
};

child.once("exit", (code, signal) => {
  exited = true;
  clearTimeout(timer);
  if (stopping !== undefined) {
    removeContainer();
    process.exit(stopping === "wall-clock" ? 124 : 143);
  }
  const exitCode = code ?? (signal !== null ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1);
  const oom = exitCode === 137 && oomKilled();
  if (oom) process.stderr.write(`graphloom: container ${spec.name} was killed at its memory limit (--memory ${spec.memory ?? "unknown"}; OOMKilled)\n`);
  try {
    writeFileSync(`${specFile}.end.json`, JSON.stringify({ exitCode, oomKilled: oom }));
  } catch {
    /* The job reports the exit code alone. */
  }
  removeContainer();
  process.exit(exitCode);
});
