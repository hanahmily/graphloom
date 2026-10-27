// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The release build's checks (docs/design-release.md §2, §6, phase R1): the
 * pinned Node fetch, the license check and notices, the tree content checks,
 * the SDK pack file list, and repair preflight on a production-pruned tree
 * with no `node` on PATH. Each script runs as `scripts/release.sh build`
 * runs it, as a child process, against local fixtures; nothing here touches
 * the network.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { claudeRehearsalStandIn, codexRehearsalStandIn, writeStandInLauncher } from "@graphloom/executor-coding-agent";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = path.join(repoRoot, "scripts", "release");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", dir]);
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-release-build-")));
  dirs.push(dir);
  return dir;
}

function script(name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [path.join(scripts, name), ...args], { encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function writePackage(dir: string, pkg: Record<string, unknown>, files: Record<string, string> = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
}

describe("fetching the pinned Node (§2.7)", () => {
  /** A nodejs.org-shaped mirror holding one fake runtime whose `bin/node --version` prints `reports`. */
  async function mirror(version: string, reports = `v${version}`) {
    const dir = await tempDir();
    const name = `node-v${version}-linux-x64`;
    const tree = path.join(dir, "tree", name);
    await mkdir(path.join(tree, "bin"), { recursive: true });
    await writeFile(path.join(tree, "bin", "node"), `#!/bin/sh\necho ${reports}\n`, { mode: 0o755 });
    await writeFile(path.join(tree, "LICENSE"), "Node.js license text\n");
    const release = path.join(dir, "mirror", `v${version}`);
    await mkdir(release, { recursive: true });
    const tarball = path.join(release, `${name}.tar.xz`);
    await execFileAsync("tar", ["-cJf", tarball, "-C", path.join(dir, "tree"), name]);
    const digest = sha256(await readFile(tarball));
    await writeFile(path.join(release, "SHASUMS256.txt"), `${"0".repeat(64)}  node-v${version}-darwin-arm64.tar.xz\n${digest}  ${name}.tar.xz\n`);
    const pin = path.join(dir, "node.json");
    await writeFile(pin, JSON.stringify({ version, platform: "linux-x64", sha256: digest }));
    return { dir, pin, digest, tarball, shasums: path.join(release, "SHASUMS256.txt"), baseUrl: `file://${path.join(dir, "mirror")}` };
  }

  it("downloads, verifies against the pin and SHASUMS256.txt, caches, and extracts the runtime", async () => {
    const m = await mirror("24.0.1");
    const dest = path.join(m.dir, "dest");
    const cache = path.join(m.dir, "cache");
    const first = script("fetch-node.mjs", ["--pin", m.pin, "--dest", dest, "--cache", cache, "--base-url", m.baseUrl]);
    expect(first.stderr).toContain("verified node-v24.0.1-linux-x64.tar.xz");
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe(path.join(dest, "node-v24.0.1-linux-x64"));
    expect(await readFile(path.join(dest, "node-v24.0.1-linux-x64", "LICENSE"), "utf8")).toBe("Node.js license text\n");
    expect(sha256(await readFile(path.join(cache, "node-v24.0.1-linux-x64.tar.xz")))).toBe(m.digest);

    // A verified cache serves the next build with no source at all.
    const cached = script("fetch-node.mjs", ["--pin", m.pin, "--dest", dest, "--cache", cache, "--base-url", path.join(m.dir, "nowhere")]);
    expect(cached.status).toBe(0);
    expect(cached.stderr).toContain("using verified cache");

    // A cache that no longer matches is discarded and fetched again.
    await writeFile(path.join(cache, "node-v24.0.1-linux-x64.tar.xz"), "corrupted");
    const refetched = script("fetch-node.mjs", ["--pin", m.pin, "--dest", dest, "--cache", cache, "--base-url", m.baseUrl]);
    expect(refetched.stderr).toContain("does not match the pin; fetching again");
    expect(refetched.status).toBe(0);
  });

  it("refuses a tarball that does not match the pinned digest, and never caches it", async () => {
    const m = await mirror("24.0.2");
    await writeFile(m.pin, JSON.stringify({ version: "24.0.2", platform: "linux-x64", sha256: "a".repeat(64) }));
    const cache = path.join(m.dir, "cache");
    const result = script("fetch-node.mjs", ["--pin", m.pin, "--dest", path.join(m.dir, "dest"), "--cache", cache, "--base-url", m.baseUrl]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`refusing node-v24.0.2-linux-x64.tar.xz: its SHA-256 ${m.digest} does not match the pinned ${"a".repeat(64)}`);
    expect(await readdir(cache).catch(() => [])).toEqual([]);
  });

  it("refuses a tarball whose SHASUMS256.txt entry disagrees with the pin", async () => {
    const m = await mirror("24.0.3");
    await writeFile(m.shasums, `${"b".repeat(64)}  node-v24.0.3-linux-x64.tar.xz\n`);
    const result = script("fetch-node.mjs", ["--pin", m.pin, "--dest", path.join(m.dir, "dest"), "--cache", path.join(m.dir, "cache"), "--base-url", m.baseUrl]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`SHASUMS256.txt lists ${"b".repeat(64)} for it`);
  });

  it("refuses a runtime that reports another version, and a malformed pin", async () => {
    const m = await mirror("24.0.4", "v20.0.0");
    const wrong = script("fetch-node.mjs", ["--pin", m.pin, "--dest", path.join(m.dir, "dest"), "--cache", path.join(m.dir, "cache"), "--base-url", m.baseUrl]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("reports v20.0.0, not the pinned v24.0.4");
    await writeFile(m.pin, JSON.stringify({ version: "24", sha256: m.digest }));
    expect(script("fetch-node.mjs", ["--pin", m.pin, "--dest", path.join(m.dir, "dest")]).stderr).toContain("exact x.y.z Node version");
  });

  it("pins an exact Node 24 release with a SHA-256 in release/node.json", async () => {
    const pin = JSON.parse(await readFile(path.join(repoRoot, "release", "node.json"), "utf8")) as { version: string; sha256: string; platform: string };
    expect(pin.version).toMatch(/^24\.\d+\.\d+$/);
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pin.platform).toBe("linux-x64");
  });
});

describe("the license check and THIRD_PARTY_NOTICES (§2.8)", () => {
  const allowlist = path.join(repoRoot, "release", "license-allowlist.json");

  /** A tree with allowed packages (one nested, one dual-licensed, one by legacy `licenses`) and a workspace link. */
  async function tree() {
    const root = await tempDir();
    const modules = path.join(root, "node_modules");
    await writePackage(path.join(modules, "good"), { name: "good", version: "1.0.0", license: "MIT" }, { LICENSE: "MIT License\nCopyright good authors\n" });
    await writePackage(path.join(modules, "good", "node_modules", "nested"), { name: "nested", version: "2.0.0", license: "(Apache-2.0 AND BSD-3-Clause)" }, { "LICENSE.txt": "nested license\n" });
    await writePackage(path.join(modules, "dual"), { name: "dual", version: "1.1.0", license: "MIT OR GPL-3.0-or-later" });
    await writePackage(path.join(modules, "@scope", "legacy"), { name: "@scope/legacy", version: "0.1.0", licenses: [{ type: "ISC" }] });
    await writePackage(path.join(root, "packages", "own"), { name: "@graphloom/own", version: "0.0.0" });
    await mkdir(path.join(modules, "@graphloom"), { recursive: true });
    await symlink("../../packages/own", path.join(modules, "@graphloom", "own"));
    return root;
  }

  it("allows every shipped license on the list and writes the notices, ending with Node's license", async () => {
    const root = await tree();
    const out = path.join(root, "THIRD_PARTY_NOTICES");
    await writeFile(path.join(root, "NODE_LICENSE"), "Node.js is licensed for use as follows: ...\n");
    const result = script("notices.mjs", ["--root", root, "--allowlist", allowlist, "--out", out, "--node-license", path.join(root, "NODE_LICENSE"), "--node-version", "v24.0.0"]);
    expect(result.stderr).toContain("licenses: 4 package(s) allowed");
    expect(result.status).toBe(0);
    const notices = await readFile(out, "utf8");
    expect(notices).toContain("good@1.0.0\nLicense: MIT\n\nMIT License\nCopyright good authors");
    expect(notices).toContain("nested@2.0.0\nLicense: (Apache-2.0 AND BSD-3-Clause)\n\nnested license");
    expect(notices).toContain("dual@1.1.0\nLicense: MIT OR GPL-3.0-or-later");
    expect(notices).toContain("@scope/legacy@0.1.0\nLicense: ISC");
    expect(notices).not.toContain("@graphloom/own");
    expect(notices.trimEnd().endsWith("Node.js v24.0.0 (node/bin/node)\n\nNode.js is licensed for use as follows: ...")).toBe(true);
  });

  it("fails on a planted disallowed license, naming the package", async () => {
    const root = await tree();
    await writePackage(path.join(root, "node_modules", "copyleft"), { name: "copyleft", version: "3.0.0", license: "GPL-3.0-only" });
    await writePackage(path.join(root, "node_modules", "good", "node_modules", "weak"), { name: "weak", version: "1.0.0", license: "MIT AND LGPL-2.1" });
    const result = script("notices.mjs", ["--root", root, "--allowlist", allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("license check failed for 2 package(s)");
    expect(result.stderr).toContain("copyleft@3.0.0: disallowed license GPL-3.0-only (never allowed: GPL-3.0-only)");
    expect(result.stderr).toContain("weak@1.0.0: disallowed license MIT AND LGPL-2.1");
  });

  it("fails on a missing, unparseable, or unlisted license", async () => {
    const root = await tree();
    await writePackage(path.join(root, "node_modules", "none"), { name: "none", version: "1.0.0" });
    await writePackage(path.join(root, "node_modules", "see"), { name: "see", version: "1.0.0", license: "SEE LICENSE IN LICENSE.md" });
    await writePackage(path.join(root, "node_modules", "mpl"), { name: "mpl", version: "1.0.0", license: "MPL-2.0" });
    await writePackage(path.join(root, "node_modules", "private"), { name: "private", version: "1.0.0", license: "UNLICENSED" });
    const result = script("notices.mjs", ["--root", root, "--allowlist", allowlist]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("none@1.0.0: no license declared");
    expect(result.stderr).toContain('see@1.0.0: unparseable license expression: "SEE LICENSE IN LICENSE.md"');
    expect(result.stderr).toContain("mpl@1.0.0: license MPL-2.0 is not on the allowlist");
    expect(result.stderr).toContain("private@1.0.0: disallowed license UNLICENSED");
  });

  it("admits a recorded per-package exception with its reason, but never a denied license", async () => {
    const root = await tree();
    await writePackage(path.join(root, "node_modules", "psf"), { name: "psf", version: "2.0.1", license: "Python-2.0" });
    await writePackage(path.join(root, "node_modules", "copyleft"), { name: "copyleft", version: "3.0.0", license: "GPL-3.0-only" });
    const list = path.join(root, "allowlist.json");
    const base = JSON.parse(await readFile(allowlist, "utf8")) as Record<string, unknown>;
    await writeFile(
      list,
      JSON.stringify({
        ...base,
        exceptions: [
          { package: "psf", license: "Python-2.0", reason: "PSF-2.0 is a permissive license (argparse)" },
          { package: "copyleft", license: "GPL-3.0-only", reason: "no exception admits a copyleft license" },
        ],
      }),
    );
    const out = path.join(root, "NOTICES");
    const failing = script("notices.mjs", ["--root", root, "--allowlist", list, "--out", out]);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain("copyleft@3.0.0: disallowed license GPL-3.0-only");
    expect(failing.stderr).not.toContain("psf@");

    await rm(path.join(root, "node_modules", "copyleft"), { recursive: true });
    const passing = script("notices.mjs", ["--root", root, "--allowlist", list, "--out", out]);
    expect(passing.status).toBe(0);
    expect(passing.stderr).toContain("1 by recorded exception");
    expect(await readFile(out, "utf8")).toContain("psf@2.0.1\nLicense: Python-2.0\nLicense exception: PSF-2.0 is a permissive license (argparse)");
  });

  it("checks the package itself with --self, as for the SDK tarball", async () => {
    const root = await tempDir();
    await writePackage(root, { name: "@graphloom/sdk", version: "0.0.0", license: "Apache-2.0" });
    expect(script("notices.mjs", ["--root", root, "--allowlist", allowlist, "--self"]).status).toBe(0);
    await writePackage(root, { name: "@graphloom/sdk", version: "0.0.0", license: "UNLICENSED" });
    const result = script("notices.mjs", ["--root", root, "--allowlist", allowlist, "--self"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@graphloom/sdk@0.0.0: disallowed license UNLICENSED");
  });
});

describe("the release tree content checks (§2.3, §6 step 6)", () => {
  /** The smallest tree that passes: a core package with dist/ only, a dependency with a portable shebang and a relative .bin link. */
  async function cleanTree() {
    const root = await tempDir();
    await writeFile(path.join(root, "package.json"), "{}");
    await writePackage(path.join(root, "packages", "sdk"), { name: "@graphloom/sdk" });
    await mkdir(path.join(root, "packages", "sdk", "dist"));
    await writeFile(path.join(root, "packages", "sdk", "dist", "index.js"), "export {};\n");
    await writePackage(path.join(root, "node_modules", "tool"), { name: "tool" }, {
      "cli.js": "#!/usr/bin/env node\nconsole.log('hi');\n",
      // A vendor's documented placeholder key, and a build cache a dependency publishes, are not ours to refuse.
      "README.md": "Set AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE to try it.\n",
      "tsconfig.tsbuildinfo": "{}",
    });
    await mkdir(path.join(root, "node_modules", ".bin"));
    await symlink("../tool/cli.js", path.join(root, "node_modules", ".bin", "tool"));
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "graphloom"), "#!/bin/sh\nexec true\n", { mode: 0o755 });
    return root;
  }

  it("passes a clean tree", async () => {
    const root = await cleanTree();
    const result = script("check-tree.mjs", ["--root", root, "--forbid", "/home/maintainer", "--forbid", "/tmp/graphloom-release-abc"]);
    expect(result.stderr).toContain("passes the content checks");
    expect(result.status).toBe(0);
  });

  it("fails on excluded paths, host paths, absolute shebangs, escaping or dangling links, .env files, and credentials", async () => {
    const root = await cleanTree();
    const outside = await tempDir();
    await mkdir(path.join(root, "packages", "testkit"), { recursive: true });
    await mkdir(path.join(root, "legacy", "go"), { recursive: true });
    await mkdir(path.join(root, "docs"));
    await mkdir(path.join(root, "packages", "sdk", "src"));
    await writeFile(path.join(root, "packages", "sdk", "src", "index.ts"), "export {};\n");
    await mkdir(path.join(root, "examples", "graphloom-state"), { recursive: true });
    await mkdir(path.join(root, "node_modules", ".vite"));
    await writeFile(path.join(root, ".env.local"), "X=1\n");
    await writeFile(path.join(root, "node_modules", "tool", "config.js"), "module.exports = '/home/maintainer/graphloom/node_modules';\n");
    await writeFile(path.join(root, "node_modules", "tool", "standin.js"), "#!/home/maintainer/.nvm/versions/node/v24.6.0/bin/node\n");
    await writeFile(path.join(root, "node_modules", "tool", "leak.js"), `const token = "${"gh"}p_${"A1b2".repeat(9)}";\n`);
    await symlink(outside, path.join(root, "node_modules", "absolute"));
    const escape = path.relative(path.join(root, "node_modules", ".bin"), outside);
    await symlink(escape, path.join(root, "node_modules", ".bin", "escape"));
    await symlink("../missing/cli.js", path.join(root, "node_modules", ".bin", "dangling"));
    const result = script("check-tree.mjs", ["--root", root, "--forbid", "/home/maintainer"]);
    expect(result.status).toBe(1);
    for (const problem of [
      "excluded path present: packages/testkit",
      "excluded path present: legacy",
      "excluded path present: docs",
      "core package ships more than package.json and dist/: packages/sdk/src",
      "excluded directory present: examples/graphloom-state",
      "excluded directory present: node_modules/.vite",
      ".env file present: .env.local",
      "contains the host path /home/maintainer: node_modules/tool/config.js",
      'non-portable shebang "#!/home/maintainer/.nvm/versions/node/v24.6.0/bin/node": node_modules/tool/standin.js',
      "credential-shaped string (GitHub token): node_modules/tool/leak.js",
      `absolute symlink: node_modules/absolute -> ${outside}`,
      `symlink leaves the tree: node_modules/.bin/escape -> ${escape}`,
      "dangling symlink: node_modules/.bin/dangling -> ../missing/cli.js",
    ]) {
      expect(result.stderr).toContain(problem);
    }
  });
});

describe("pruning node_modules for the release platform (§6 step 6)", () => {
  const modules = (root: string, ...rel: string[]) => path.join(root, "node_modules", ...rel);
  const exists = (p: string) => readFile(path.join(p, "package.json")).then(() => true, () => false);

  /** A tree where a shrinkwrapped `pi` pins every platform's binary and its own copies of top-level packages. */
  async function platformTree() {
    const root = await tempDir();
    await writeFile(path.join(root, "package.json"), "{}");
    await writePackage(modules(root, "@esbuild", "linux-x64"), { name: "@esbuild/linux-x64", version: "1.0.0", os: ["linux"], cpu: ["x64"], license: "MIT" });
    await writePackage(modules(root, "@rollup", "rollup-linux-x64-musl"), { name: "@rollup/rollup-linux-x64-musl", version: "1.0.0", os: ["linux"], cpu: ["x64"], libc: ["musl"], license: "MIT" });
    await writePackage(modules(root, "not-windows"), { name: "not-windows", version: "1.0.0", os: ["!win32"], license: "MIT" });
    const pi = modules(root, "pi");
    await writePackage(pi, { name: "pi", version: "1.0.0", license: "MIT", dependencies: { same: "1.0.0", edited: "1.0.0", pinned: "1.0.0" } });
    for (const platform of ["darwin-arm64", "win32-x64", "linux-arm64"]) {
      const [os, cpu] = platform.split("-");
      await writePackage(path.join(pi, "node_modules", "@esbuild", platform), { name: `@esbuild/${platform}`, version: "1.0.0", os: [os], cpu: [cpu], license: "MIT" });
    }
    // Byte-identical to the top-level copy, with a dependency that resolves to the same files from both places.
    for (const dir of [modules(root, "same"), path.join(pi, "node_modules", "same")]) {
      await writePackage(dir, { name: "same", version: "1.0.0", license: "MIT", dependencies: { leaf: "^1.0.0" } }, { "index.js": "module.exports = 1;\n" });
    }
    await writePackage(modules(root, "leaf"), { name: "leaf", version: "1.0.0", license: "MIT" }, { "index.js": "module.exports = 'leaf';\n" });
    // Same version, different bytes: not the same package to load.
    await writePackage(modules(root, "edited"), { name: "edited", version: "1.0.0", license: "MIT" }, { "index.js": "module.exports = 'top';\n" });
    await writePackage(path.join(pi, "node_modules", "edited"), { name: "edited", version: "1.0.0", license: "MIT" }, { "index.js": "module.exports = 'nested';\n" });
    // Identical itself, but its own dependency resolves to another version from the top level.
    for (const dir of [modules(root, "pinned"), path.join(pi, "node_modules", "pinned")]) {
      await writePackage(dir, { name: "pinned", version: "1.0.0", license: "MIT", dependencies: { dep: "^2.0.0" } }, { "index.js": "module.exports = 1;\n" });
    }
    await writePackage(modules(root, "dep"), { name: "dep", version: "2.1.0", license: "MIT" });
    await writePackage(path.join(pi, "node_modules", "dep"), { name: "dep", version: "2.0.0", license: "MIT" });
    return { root, pi };
  }

  it("fails the content check on a package for another platform", async () => {
    const { root } = await platformTree();
    const result = script("check-tree.mjs", ["--root", root, "--platform", "linux-x64"]);
    expect(result.status).toBe(1);
    for (const problem of [
      'package for another platform (os ["darwin"], release is linux-x64): node_modules/pi/node_modules/@esbuild/darwin-arm64',
      'package for another platform (os ["win32"], release is linux-x64): node_modules/pi/node_modules/@esbuild/win32-x64',
      'package for another platform (cpu ["arm64"], release is linux-x64): node_modules/pi/node_modules/@esbuild/linux-arm64',
      'package for another platform (libc ["musl"], release is linux-x64): node_modules/@rollup/rollup-linux-x64-musl',
    ]) {
      expect(result.stderr).toContain(problem);
    }
    expect(result.stderr).not.toContain("@esbuild/linux-x64");
    expect(result.stderr).not.toContain("not-windows");
  });

  it("removes other platforms' packages and nested copies an identical, identically-resolving copy above serves", async () => {
    const { root, pi } = await platformTree();
    const result = script("prune-tree.mjs", ["--root", root, "--platform", "linux-x64"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("removed 4 package(s) for other platforms");
    expect(result.stderr).toContain("removed 1 nested duplicate(s)");
    expect(await exists(modules(root, "@esbuild", "linux-x64"))).toBe(true);
    expect(await exists(modules(root, "not-windows"))).toBe(true);
    expect(await exists(modules(root, "@rollup", "rollup-linux-x64-musl"))).toBe(false);
    expect(await readdir(path.join(pi, "node_modules"))).toEqual(["dep", "edited", "pinned"]);
    // What stays is what changes behaviour if shared: other bytes, or another dependency closure.
    expect(await readFile(path.join(pi, "node_modules", "edited", "index.js"), "utf8")).toContain("nested");
    expect(script("check-tree.mjs", ["--root", root]).status).toBe(0);
  });
});

describe("the SDK tarball (§3.1, §6 step 5)", () => {
  /** `npm pack` of a copy of the built SDK with LICENSE and NOTICE, as release.sh packs it. */
  async function packSdk(edit: (dir: string) => Promise<void> = async () => {}) {
    const dir = await tempDir();
    const sdk = path.join(dir, "sdk");
    await mkdir(sdk);
    await cp(path.join(repoRoot, "packages", "sdk", "package.json"), path.join(sdk, "package.json"));
    await cp(path.join(repoRoot, "packages", "sdk", "dist"), path.join(sdk, "dist"), { recursive: true });
    await cp(path.join(repoRoot, "LICENSE"), path.join(sdk, "LICENSE"));
    await cp(path.join(repoRoot, "NOTICE"), path.join(sdk, "NOTICE"));
    await edit(sdk);
    const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", dir], { cwd: sdk });
    return path.join(dir, stdout.trim().split("\n").pop()!);
  }

  it("holds package.json, dist/, LICENSE, and NOTICE, and names the product version", async () => {
    const version = (JSON.parse(await readFile(path.join(repoRoot, "packages", "sdk", "package.json"), "utf8")) as { version: string }).version;
    const tarball = await packSdk();
    expect(path.basename(tarball)).toBe(`graphloom-sdk-${version}.tgz`);
    const ok = script("check-pack.mjs", ["--tarball", tarball, "--version", version]);
    expect(ok.stderr).toContain("holds package.json, dist/, LICENSE, and NOTICE only");
    expect(ok.status).toBe(0);
    const wrongVersion = script("check-pack.mjs", ["--tarball", tarball, "--version", "9.9.9"]);
    expect(wrongVersion.status).toBe(1);
    expect(wrongVersion.stderr).toContain(`package.json version ${version}, not 9.9.9`);
  }, 60_000);

  it("fails on a missing NOTICE or a file outside the list", async () => {
    const tarball = await packSdk(async (sdk) => {
      await rm(path.join(sdk, "NOTICE"));
      await writeFile(path.join(sdk, "README.md"), "# sdk\n");
      await writeFile(path.join(sdk, "dist", "leftover.test.js"), "\n");
    });
    const result = script("check-pack.mjs", ["--tarball", tarball]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing package/NOTICE");
    expect(result.stderr).toContain("unexpected file package/README.md");
    expect(result.stderr).toContain("must not ship package/dist/leftover.test.js");
  }, 60_000);
});

describe("repair preflight on a production-pruned tree with no node on PATH (§2.2, §2.7)", () => {
  /** The production closure as `npm prune --omit=dev` keeps it: name -> real path, from npm's own `.prod` query. */
  async function productionClosure(): Promise<Map<string, string>> {
    const { stdout } = await execFileAsync("npm", ["query", ".prod"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
    const nodes = JSON.parse(stdout) as { name: string; location: string; realpath: string }[];
    return new Map(nodes.filter((n) => /^node_modules\/(@[^/]+\/)?[^/]+$/.test(n.location) || !n.location.includes("node_modules")).map((n) => [n.name, n.realpath]));
  }

  /**
   * A tree holding the built CLI and, in its node_modules, links to exactly
   * the top-level production closure: GraphLoom's own `typescript` resolves
   * from the CLI only if pruning keeps it.
   */
  async function prunedTree(drop: string[] = []) {
    const closure = await productionClosure();
    const root = await tempDir();
    await mkdir(path.join(root, "apps", "graphloom"), { recursive: true });
    await cp(path.join(repoRoot, "apps", "graphloom", "package.json"), path.join(root, "apps", "graphloom", "package.json"));
    await cp(path.join(repoRoot, "apps", "graphloom", "dist"), path.join(root, "apps", "graphloom", "dist"), { recursive: true });
    for (const [name, real] of closure) {
      if (drop.includes(name) || name === "graphloom" || name === "@graphloom/cli") continue;
      await mkdir(path.dirname(path.join(root, "node_modules", name)), { recursive: true });
      await symlink(real, path.join(root, "node_modules", name), "dir");
    }
    const noNode = path.join(root, "no-node-bin");
    const made = script("no-node-path.mjs", ["--dir", noNode]);
    expect(made.status).toBe(0);
    return { root, env: { ...process.env, PATH: noNode } };
  }

  const preflight = (root: string, env: NodeJS.ProcessEnv, target = "validator") =>
    script(
      "smoke-preflight.mjs",
      ["--root", root, "--plugin", path.join(repoRoot, "examples", "plugins", "release"), "--sdk", path.join(repoRoot, "packages", "sdk"), "--target", target],
      env,
    );

  it("keeps typescript and vitest in the production closure, as @graphloom/cli dependencies", async () => {
    const closure = await productionClosure();
    expect(closure.has("typescript")).toBe(true);
    expect(closure.has("vitest")).toBe(true);
    const cli = JSON.parse(await readFile(path.join(repoRoot, "apps", "graphloom", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(cli.dependencies)).toEqual(expect.arrayContaining(["typescript", "vitest"]));
  });

  it("builds and qualifies a validator candidate with GraphLoom's own tsc on the Node running it", async () => {
    const { root, env } = await prunedTree();
    const result = preflight(root, env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("preflight: ok, with no node on PATH");
    expect(result.stdout).toContain("the candidate builds; candidate passes all");
  }, 120_000);

  it("fails preflight when pruning drops typescript, and refuses to run with a node on PATH", async () => {
    const { root, env } = await prunedTree(["typescript"]);
    const pruned = preflight(root, env, "plugin");
    expect(pruned.status).toBe(1);
    expect(pruned.stderr).toContain("graphloom's own typescript installation cannot be resolved");

    const withNode = path.join(root, "with-node");
    await mkdir(withNode);
    await writeFile(path.join(withNode, "node"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(withNode, "node"), 0o755);
    const refused = preflight(root, { ...env, PATH: `${env.PATH}${path.delimiter}${withNode}` });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refusing to run: PATH has a node");
  }, 120_000);
});

describe("rehearsal stand-ins on GraphLoom's own Node (§2.7)", () => {
  it("start through their launcher with no node on PATH, from a shell as an environment check runs them, never through their own shebang", async () => {
    const dir = await tempDir();
    const empty = path.join(dir, "empty");
    await mkdir(empty);
    for (const [name, standIn, banner] of [
      ["claude", claudeRehearsalStandIn, "graphloom-rehearsal-claude-standin"],
      ["codex", codexRehearsalStandIn, "graphloom-rehearsal-codex-standin"],
    ] as const) {
      // Plain tsc output: no build step rewrites the shebang to the building machine's Node.
      expect((await readFile(standIn, "utf8")).split("\n")[0]).toBe("#!/usr/bin/env node");
      const launcher = await writeStandInLauncher(path.join(dir, "it's here"), name, standIn);
      const direct = await execFileAsync(launcher, ["--version"], { env: { PATH: empty } });
      expect(direct.stdout).toContain(banner);
      const viaShell = await execFileAsync("/bin/sh", ["-c", '"$GRAPHLOOM_BIN" --version'], { env: { PATH: empty, GRAPHLOOM_BIN: launcher } });
      expect(viaShell.stdout).toContain(banner);
    }
  });
});

describe("the issue-fix plugin's bundled open-code-review (§2.3, §2.8, §6 step 6)", () => {
  const installed = path.join(repoRoot, "node_modules", "@alibaba-group");
  const hostBinary = path.join(installed, "ocr-linux-x64", "bin", "opencodereview");
  const onLinuxX64 = process.platform === "linux" && process.arch === "x64" && spawnSync("test", ["-x", hostBinary]).status === 0;

  /**
   * The shipped layout: the pinned open-code-review and its linux-x64 binary
   * hoisted to the top-level node_modules, as `npm ci` installs them, plus two
   * other platforms' packages a lockfile could reify, and the issue-fix
   * bundle's lookup script and profiles.
   */
  async function shippedTree() {
    const root = await tempDir();
    await writeFile(path.join(root, "package.json"), "{}");
    for (const name of ["open-code-review", "ocr-linux-x64"]) {
      await cp(path.join(installed, name), path.join(root, "node_modules", "@alibaba-group", name), { recursive: true });
    }
    for (const [os_, cpu] of [["darwin", "arm64"], ["win32", "x64"]] as const) {
      const dir = path.join(root, "node_modules", "@alibaba-group", `ocr-${os_}-${cpu}`);
      await writePackage(dir, { name: `@alibaba-group/ocr-${os_}-${cpu}`, version: "1.13.3", os: [os_], cpu: [cpu], license: "Apache-2.0" });
      await mkdir(path.join(dir, "bin"));
      await writeFile(path.join(dir, "bin", "opencodereview"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    const plugin = path.join(root, "examples", "plugins", "issue-fix");
    for (const rel of ["package.json", "scripts", "profiles"]) {
      await cp(path.join(repoRoot, "examples", "plugins", "issue-fix", rel), path.join(plugin, rel), { recursive: true });
    }
    return { root, plugin };
  }

  it.skipIf(!onLinuxX64)("ships the pinned version, prunes other platforms' binaries, passes the license and content checks, and runs read-only with no node on PATH", async () => {
    const { root, plugin } = await shippedTree();
    const pkg = JSON.parse(await readFile(path.join(plugin, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const pinned = pkg.dependencies["@alibaba-group/open-code-review"]!;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    const versionOf = async (name: string) =>
      (JSON.parse(await readFile(path.join(root, "node_modules", "@alibaba-group", name, "package.json"), "utf8")) as { version: string }).version;
    expect(await versionOf("open-code-review")).toBe(pinned);
    expect(await versionOf("ocr-linux-x64")).toBe(pinned);

    const pruned = script("prune-tree.mjs", ["--root", root, "--platform", "linux-x64"]);
    expect(pruned.status, pruned.stderr).toBe(0);
    expect(pruned.stderr).toContain("removed 2 package(s) for other platforms");
    expect((await readdir(path.join(root, "node_modules", "@alibaba-group"))).sort()).toEqual(["ocr-linux-x64", "open-code-review"]);

    const forbid = ["--forbid", repoRoot, ...(os.homedir().length > 1 ? ["--forbid", os.homedir()] : [])];
    const checked = script("check-tree.mjs", ["--root", root, "--platform", "linux-x64", ...forbid]);
    expect(checked.status, checked.stderr).toBe(0);

    const out = path.join(root, "THIRD_PARTY_NOTICES");
    const notices = script("notices.mjs", ["--root", root, "--allowlist", path.join(repoRoot, "release", "license-allowlist.json"), "--out", out]);
    expect(notices.status, notices.stderr).toBe(0);
    const text = await readFile(out, "utf8");
    expect(text).toContain(`@alibaba-group/open-code-review@${pinned}\nLicense: Apache-2.0\n`);
    expect(text).toContain(`@alibaba-group/ocr-linux-x64@${pinned}\nLicense: Apache-2.0\n`);

    // As installed: read-only, no node on PATH, and the check run as the controller runs it.
    const noNode = path.join(await tempDir(), "bin");
    expect(script("no-node-path.mjs", ["--dir", noNode]).status).toBe(0);
    const home = await tempDir();
    spawnSync("chmod", ["-R", "a-w", root]);
    const check = (JSON.parse(await readFile(path.join(plugin, "profiles", "graphloom.json"), "utf8")) as { environment: { checks: { id: string; argv: string[] }[] } })
      .environment.checks.find((c) => c.id === "ocr")!;
    const [cmd, ...args] = check.argv;
    const env = { PATH: noNode, HOME: home, GRAPHLOOM_PLUGIN_ROOT: plugin };
    const { stdout } = await execFileAsync(cmd!, args, { cwd: home, env });
    const binary = path.join(root, "node_modules", "@alibaba-group", "ocr-linux-x64", "bin", "opencodereview");
    expect(stdout.trim()).toBe(binary);
    expect((await execFileAsync(binary, ["version"], { env })).stdout).toContain(`open-code-review v${pinned} `);
  }, 120_000);
});

describe("scripts/release.sh", () => {
  const releaseSh = path.join(repoRoot, "scripts", "release.sh");

  it("refuses a malformed version, an unknown subcommand, and an option of another subcommand", () => {
    const bad = spawnSync(releaseSh, ["build", "1.2"], { encoding: "utf8" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("version must be MAJOR.MINOR.PATCH");
    const usage = spawnSync(releaseSh, [], { encoding: "utf8" });
    expect(usage.status).toBe(2);
    for (const sub of ["prepare", "build", "publish"]) expect(usage.stderr).toContain(`scripts/release.sh ${sub} `);
    expect(spawnSync(releaseSh, ["tag", "1.2.3"], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(releaseSh, ["publish", "1.2.3", "--commit", "HEAD"], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(releaseSh, ["build", "1.2.3", "--dry-run"], { encoding: "utf8" }).status).toBe(2);
    const both = spawnSync(releaseSh, ["build", "1.2.3", "--unsigned", "--signing-key", "k"], { encoding: "utf8" });
    expect(both.stderr).toContain("--signing-key and --unsigned are mutually exclusive");
  });
});
