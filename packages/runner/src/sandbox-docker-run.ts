// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Runs one `docker run` for the command executor (`node sandbox-docker-run.js <spec.json>`) and
 * makes sure its container dies with it. The Docker CLI forwards SIGTERM but not SIGKILL, and a
 * container's first process ignores SIGTERM it does not handle, so on a stop signal or when the
 * container's wall clock ends this kills the container by name before it exits.
 */

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const KILL_WAIT_MS = 10_000;

interface Spec {
  name: string;
  wallClockMs: number;
  args: string[];
  guards: Array<{ root: string; rel: string }>;
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

const child = spawn("docker", spec.args, { stdio: ["ignore", "inherit", "inherit"] });
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
child.once("exit", (code, signal) => {
  exited = true;
  clearTimeout(timer);
  if (stopping === "wall-clock") process.exit(124);
  if (stopping === "signal") process.exit(143);
  process.exit(code ?? (signal !== null ? 128 + (signal === "SIGKILL" ? 9 : 15) : 1));
});
