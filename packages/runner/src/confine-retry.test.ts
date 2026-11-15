// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BwrapStatus, confinementUnsupported, SANDBOX_SETUP_ATTEMPTS, sandboxSetupBackoffMs, sandboxSetupHitTransientMount } from "./confine.js";

/** What bubblewrap 0.9.0 printed on a host whose Docker healthchecks mount under /tmp, verbatim. */
const CONTAINERD =
  'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/tmp/containerd-mount1715733460": Invalid argument\n';
const GONE =
  'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/var/lib/docker/overlay2/abc/merged": No such file or directory\n';

const notExecuted = { exitCode: undefined };

describe("a sandbox whose setup failed on a host mount that changed under it", () => {
  it("is recognised from bubblewrap's own message when bubblewrap reported no exit code", () => {
    expect(sandboxSetupHitTransientMount(CONTAINERD, notExecuted)).toBe(true);
    expect(sandboxSetupHitTransientMount(GONE, notExecuted)).toBe(true);
    // A submount of another recursive bind than the root's fails the same way.
    expect(
      sandboxSetupHitTransientMount(
        'bwrap: Can\'t bind mount /oldroot/home/u/work on /newroot/home/u/work: Unable to apply mount flags: remount "/newroot/home/u/work/m": Invalid argument',
        notExecuted,
      ),
    ).toBe(true);
  });

  it("is not recognised once the command was executed, whatever it printed", () => {
    // bubblewrap reports an exit code only for a command it executed: the message is then the command's own.
    expect(sandboxSetupHitTransientMount(CONTAINERD, { exitCode: 1 })).toBe(false);
    expect(sandboxSetupHitTransientMount(CONTAINERD, { exitCode: 0 })).toBe(false);
  });

  it("is not recognised for any other setup failure, or with anything else on standard error", () => {
    for (const stderr of [
      "bwrap: Can't find source path /nonexist: No such file or directory\n",
      'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/proc/sys": Operation not permitted\n',
      "bwrap: Can't bind mount /oldroot/x on /newroot/x: Unable to mount source on destination: Invalid argument\n",
      "bwrap: No permissions to create new namespace, likely because the kernel does not allow non-privileged user namespaces.\n",
      `something the job printed\n${CONTAINERD}`,
      `${CONTAINERD}${CONTAINERD}`,
      "",
    ]) {
      expect(sandboxSetupHitTransientMount(stderr, notExecuted), stderr).toBe(false);
    }
  });

  it("is started again a bounded number of times, with a short, growing wait", () => {
    expect(SANDBOX_SETUP_ATTEMPTS).toBe(4);
    const waits = Array.from({ length: SANDBOX_SETUP_ATTEMPTS - 1 }, (_, i) => sandboxSetupBackoffMs(i + 1));
    expect(waits).toEqual([100, 200, 400]);
    expect(sandboxSetupBackoffMs(20)).toBe(1_000);
  });
});

/** Run the installed bubblewrap; its standard error and what it reported on its status stream. */
async function realBwrap(args: string[]): Promise<{ code: number | null; stderr: string; status: BwrapStatus }> {
  return await new Promise((resolve) => {
    const child = spawn("bwrap", [...args.slice(0, -1), "--json-status-fd", "3", "--", ...args.slice(-1)[0]!.split(" ")], {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    });
    const status = new BwrapStatus();
    status.read(child.stdio[3] as NodeJS.ReadableStream);
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    child.once("close", (code) => resolve({ code, stderr, status }));
  });
}

describe.skipIf((await confinementUnsupported()) !== undefined)("the installed bubblewrap", () => {
  const base = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc"];

  it("reports no exit code when its setup fails before the command", async () => {
    const res = await realBwrap([...base, "--ro-bind", "/nonexistent-graphloom-path", "/mnt", "true"]);
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/^bwrap: Can't find source path/);
    expect(res.status.childPid).toBeTypeOf("number");
    expect(res.status.exitCode).toBeUndefined();
  });

  it("reports the exit code of a command it executed, so a command printing its setup message is not taken for one", async () => {
    const script = path.join(mkdtempSync(path.join(os.tmpdir(), "gl-bwrap-forge-")), "forge.sh");
    writeFileSync(script, `printf '%s\\n' '${CONTAINERD.trim().replaceAll("'", "'\\''")}' >&2\nexit 1\n`);
    const res = await realBwrap([...base, `sh ${script}`]);
    expect(res.code).toBe(1);
    expect(res.stderr).toBe(CONTAINERD);
    expect(res.status.exitCode).toBe(1);
    expect(sandboxSetupHitTransientMount(res.stderr, res.status)).toBe(false);
    // The message alone would have been taken for a setup failure.
    expect(sandboxSetupHitTransientMount(res.stderr, notExecuted)).toBe(true);
    rmSync(path.dirname(script), { recursive: true, force: true });
  });
});

describe("bubblewrap's status stream", () => {
  it("records the sandbox's init pid as soon as it comes, and the exit code only when reported", async () => {
    const stream = new PassThrough();
    const status = new BwrapStatus();
    const pids: number[] = [];
    status.read(stream, (pid) => pids.push(pid));
    stream.write('{ "child-pid": 3605280, "mnt-namespace": 4026533511, "pid-');
    stream.write('namespace": 4026533512 }\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(pids).toEqual([3605280]);
    expect(status.exitCode).toBeUndefined();
    stream.end('{ "exit-code": 1 }\n');
    await new Promise((resolve) => stream.once("end", resolve));
    expect(status.childPid).toBe(3605280);
    expect(status.exitCode).toBe(1);
    expect(pids).toEqual([3605280]);
  });

  it("ignores a line that is not JSON", () => {
    const status = new BwrapStatus();
    status.line("not json");
    status.line("null");
    expect(status).toMatchObject({ childPid: undefined, exitCode: undefined });
  });
});
