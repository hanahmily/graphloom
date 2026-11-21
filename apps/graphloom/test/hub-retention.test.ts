// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hubRetentionFile, registerHubRetention, retainHubInstallations } from "../src/hub-retention.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "gl-hub-retention-"));
  roots.push(root);
  return root;
}
async function input(home: string, version: string): Promise<string> {
  const directory = path.join(home, "versions", version, "bundle");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "entry.js");
  await writeFile(file, "export {};");
  return file;
}
async function holdInstallLock(home: string): Promise<() => Promise<void>> {
  const child = spawn("flock", ["--exclusive", "--no-fork", path.join(home, "install.lock"), "sh", "-c", "printf 'locked\\n'; read -r release || :"], { stdio: ["pipe", "pipe", "inherit"] });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited ${code}`)));
    child.stdout.once("data", () => resolve());
  });
  return async () => { child.stdin.end(); await closed; };
}

describe("hub installation retention", () => {
  it("retains every installed home behind runtime and plugin symlinks without depending on hub state", async () => {
    const root = await temporary();
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const runtime = await input(first, "1.0.0");
    const bundle = await input(first, "1.1.0");
    const other = await input(second, "2.0.0-rc.1");
    const link = path.join(root, "linked-plugin");
    await symlink(bundle, link);
    const source = path.join(root, "source.ts");
    await writeFile(source, "source checkout");
    const hub = path.join(root, "absent-hub");
    expect(await retainHubInstallations(hub, [runtime, link, other, source])).toEqual([first, second]);
    for (const home of [first, second]) {
      expect(JSON.parse(await readFile(hubRetentionFile(home, hub), "utf8"))).toEqual({ protocolVersion: 1, hubDirectory: hub });
    }
    expect(await retainHubInstallations(hub, [source])).toEqual([]);
  });

  it("shares the installer lock and refuses acceptance when prune removed a captured input", async () => {
    const root = await temporary();
    const home = path.join(root, "install");
    const reference = await input(home, "1.0.0");
    const release = await holdInstallLock(home);
    const hub = path.join(root, "hub");
    let settled = false;
    const registration = registerHubRetention(home, hub, [reference]).then(
      () => { settled = true; return undefined; },
      (error: unknown) => { settled = true; return error; },
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await expect(access(hubRetentionFile(home, hub))).rejects.toMatchObject({ code: "ENOENT" });
      await rm(path.join(home, "versions", "1.0.0"), { recursive: true });
    } finally { await release(); }
    expect(await registration).toMatchObject({ code: "ENOENT" });
    await expect(access(hubRetentionFile(home, hub))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the installer lock after a durable registration", async () => {
    const root = await temporary();
    await registerHubRetention(root, path.join(root, "hub"));
    const release = await holdInstallLock(root);
    await release();
  });
});
