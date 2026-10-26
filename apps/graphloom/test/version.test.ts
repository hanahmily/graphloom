// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { formatVersion, versionInfo } from "../src/version.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cli = path.join(repoRoot, "apps/graphloom/dist/main.js");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-version-")));
  dirs.push(dir);
  return dir;
}

const RELEASE = {
  product: "graphloom",
  version: "0.1.0",
  license: "Apache-2.0",
  platform: "linux-x64",
  git: { tag: "v0.1.0", commit: "0123456789abcdef0123456789abcdef01234567", sourceDateEpoch: 1761436800 },
  stateFormat: 1,
};

describe("graphloom version", () => {
  it("reports a release tree's release.json: version and commit, the whole file with --json, and the root with --root", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    await writeFile(path.join(root, "release.json"), JSON.stringify(RELEASE));
    expect(formatVersion(root, [])).toBe("graphloom 0.1.0 (0123456)");
    expect(JSON.parse(formatVersion(root, ["--json"]))).toEqual(RELEASE);
    expect(formatVersion(root, ["--root"])).toBe(root);
    expect(versionInfo(root)).toMatchObject({ version: "0.1.0", commit: RELEASE.git.commit });
  });

  it("refuses a release.json that is not a GraphLoom release manifest", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "release.json"), JSON.stringify({ product: "other", version: "1.0.0" }));
    expect(() => versionInfo(root)).toThrow(/not a GraphLoom release manifest/);
  });

  it("reports <version>-dev+<short sha> in a clone, and <version>-dev without Git metadata", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "graphloom", version: "0.2.0" }));
    expect(formatVersion(root, [])).toBe("graphloom 0.2.0-dev");
    expect(JSON.parse(formatVersion(root, ["--json"]))).toEqual({ product: "graphloom", version: "0.2.0-dev" });

    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "package.json");
    git("-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init");
    const sha = git("rev-parse", "HEAD");
    expect(formatVersion(root, [])).toBe(`graphloom 0.2.0-dev+${sha.slice(0, 7)}`);
    expect(JSON.parse(formatVersion(root, ["--json"]))).toEqual({ product: "graphloom", version: `0.2.0-dev+${sha.slice(0, 7)}`, git: { commit: sha } });
  });

  it("does not borrow the commit of an enclosing repository", async () => {
    const outer = await tempDir();
    execFileSync("git", ["-C", outer, "init", "-q"]);
    execFileSync("git", ["-C", outer, "-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
    const root = path.join(outer, "staging");
    await mkdir(root);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
    expect(formatVersion(root, [])).toBe("graphloom 0.3.0-dev");
  });

  it("is what the built CLI prints for this checkout", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { version: string };
    const text = (await execFileAsync(process.execPath, [cli, "version"])).stdout.trim();
    expect(text).toMatch(new RegExp(`^graphloom ${pkg.version.replaceAll(".", "\\.")}-dev(\\+[0-9a-f]{7})?$`));
    expect((await execFileAsync(process.execPath, [cli, "--version"])).stdout.trim()).toBe(text);
    expect((await execFileAsync(process.execPath, [cli, "version", "--root"])).stdout.trim()).toBe(await realpath(repoRoot));
    const json = JSON.parse((await execFileAsync(process.execPath, [cli, "version", "--json"])).stdout) as { product: string; version: string };
    expect(json.product).toBe("graphloom");
    expect(`graphloom ${json.version}`).toBe(text);
  });
});

describe("the product version (§3)", () => {
  it("is the root package.json version, carried in lockstep by every core package, the SDK, and the CLI", async () => {
    const version = (rel: string) => readFile(path.join(repoRoot, rel, "package.json"), "utf8").then((raw) => (JSON.parse(raw) as { version: string }).version);
    const product = await version(".");
    for (const rel of ["packages/sdk", "packages/controller", "packages/plugin-host", "packages/supervisor", "packages/runner", "apps/graphloom"]) {
      expect(`${rel} ${await version(rel)}`).toBe(`${rel} ${product}`);
    }
  });
});
