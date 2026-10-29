// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { confineWorker, confinementUnsupported, type BwrapSandbox } from "./confine.js";

const unsupported = await confinementUnsupported();
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gl-bwrap-")));
const realHome = process.env.HOME;
const home = path.join(root, "home");
const work = path.join(root, "work");

let server: Server;
let port = 0;

beforeAll(async () => {
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  server = createServer((socket) => socket.end("hello"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  process.env.HOME = home;
});

afterAll(async () => {
  process.env.HOME = realHome;
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

/** Run `script` under the confinement, as a job would: the home directory is the test's own. */
async function run(sandbox: BwrapSandbox, script: string, extra: { trustedWritable?: string[] } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const launch = confineWorker({
    command: "sh",
    args: ["-c", script],
    env: { ...process.env },
    cwd: work,
    scratchDir: path.join(root, "scratch"),
    writable: [work],
    readPaths: [work],
    keepUserState: false,
    sandbox,
    ...extra,
  });
  // Asynchronous: the test's own server must keep answering while the job runs.
  return await new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, { env: launch.env, cwd: work, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const dial = `${JSON.stringify(process.execPath)} -e 'require("net").connect(${"PORT"}, "127.0.0.1").on("data", (d) => { console.log("got " + d); process.exit(0); }).on("error", (e) => { console.log("failed " + e.code); process.exit(3); })'`;

describe.skipIf(unsupported !== undefined)("a job's own bwrap sandbox", async () => {
  it("leaves the network on when asked, and takes it away when not", async () => {
    // The node binary may live under the (hidden) home of the machine running the tests; that is not what is tested.
    const script = dial.replace("PORT", String(port));
    const on = await run({ network: true, mask: [], binds: [] }, script);
    expect(on.stdout, on.stderr).toContain("got hello");
    const off = await run({ network: false, mask: [], binds: [] }, script);
    expect(off.status, off.stderr).toBe(3);
    expect(off.stdout).toMatch(/failed (ECONNREFUSED|ENETUNREACH|EADDRNOTAVAIL)/);
  });

  it("hides a masked directory and a masked file, and leaves their neighbours readable", async () => {
    const dir = path.join(root, "secrets");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "token"), "s3cret");
    const file = path.join(root, "credentials");
    writeFileSync(file, "hunter2");
    const open = path.join(root, "open.txt");
    writeFileSync(open, "visible");
    const unmasked = await run({ network: true, mask: [], binds: [] }, `cat ${dir}/token ${file}`);
    expect(unmasked.stdout).toBe("s3crethunter2");
    const masked = await run({ network: true, mask: [dir, file], binds: [] }, `cat ${dir}/token 2>&1; echo "[$?]"; cat ${file}; echo "[file:$(cat ${file} | wc -c)]"; cat ${open}`);
    expect(masked.stdout).not.toContain("s3cret");
    expect(masked.stdout).not.toContain("hunter2");
    expect(masked.stdout).toContain("[file:0]");
    expect(masked.stdout).toContain("visible");
    // The host's files are untouched.
    expect(readFileSync(path.join(dir, "token"), "utf8")).toBe("s3cret");
  });

  it("expands ~ in a mask to the operator's home", async () => {
    mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
    writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "oauth_token: x");
    const res = await run({ network: true, mask: ["~/.config/gh"], binds: [{ path: "~/.config", readOnly: true }] }, `cat ~/.config/gh/hosts.yml; ls -A ~/.config/gh | wc -l`);
    expect(res.stdout).not.toContain("oauth_token");
    expect(res.stdout.trim()).toBe("0");
  });

  it("hides the home directory but for the executor's own state", async () => {
    const state = path.join(home, ".agent");
    mkdirSync(state, { recursive: true });
    writeFileSync(path.join(state, "login"), "agent-login");
    writeFileSync(path.join(home, "private.txt"), "mine");
    mkdirSync(path.join(home, ".ssh"), { recursive: true });
    writeFileSync(path.join(home, ".ssh", "id_ed25519"), "key");
    const res = await run(
      { network: true, mask: [], binds: [] },
      `cat ${home}/.agent/login; echo; cat ${home}/private.txt 2>&1; cat ${home}/.ssh/id_ed25519 2>&1; echo "[$(ls -A ${home} | tr '\\n' ' ')]"; echo changed > ${home}/.agent/login && cat ${home}/.agent/login; echo new > ${home}/new.txt && echo wrote-new`,
      { trustedWritable: [state] },
    );
    expect(res.stdout).toContain("agent-login");
    expect(res.stdout).not.toContain("mine");
    expect(res.stdout).not.toContain("key");
    expect(res.stdout).toContain("[.agent ]");
    // The executor's state is writable, and what else the job writes in the hidden home dies with it.
    expect(res.stdout).toContain("changed");
    expect(readFileSync(path.join(state, "login"), "utf8")).toBe("changed\n");
    expect(existsSync(path.join(home, "new.txt"))).toBe(false);
    expect(readFileSync(path.join(home, "private.txt"), "utf8")).toBe("mine");
  });

  it("adds a read-only bind that cannot be written, and a read-write bind that can", async () => {
    const ro = path.join(home, "deps");
    const rw = path.join(home, "cache");
    mkdirSync(ro, { recursive: true });
    mkdirSync(rw, { recursive: true });
    writeFileSync(path.join(ro, "dep.txt"), "dependency");
    const res = await run(
      { network: true, mask: [], binds: [{ path: ro, readOnly: true }, { path: rw, readOnly: false }] },
      `cat ${ro}/dep.txt; echo; echo x > ${ro}/new 2>&1 && echo ro-wrote; echo y > ${rw}/out && echo rw-wrote`,
    );
    expect(res.stdout).toContain("dependency");
    expect(res.stdout).not.toContain("ro-wrote");
    expect(res.stdout).toContain("rw-wrote");
    expect(existsSync(path.join(ro, "new"))).toBe(false);
    expect(readFileSync(path.join(rw, "out"), "utf8")).toBe("y\n");
  });

  it("refuses a bind that does not exist, instead of starting without it", async () => {
    await expect(run({ network: true, mask: [], binds: [{ path: path.join(root, "nope"), readOnly: true }] }, "true")).rejects.toThrow(/sandbox bind .* does not exist/);
  });
});
