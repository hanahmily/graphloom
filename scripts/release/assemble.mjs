// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Assembles the release tree and writes `release.json`
 * (docs/design-release.md §2.3, §2.4, §6 step 6).
 *
 *   node scripts/release/assemble.mjs --src <gated, pruned staging tree> --out <dir>
 *        --node <extracted node-v<v>-linux-x64 dir> --node-pin release/node.json
 *        --version <v> --commit <sha> --epoch <SOURCE_DATE_EPOCH> --sdk-tgz <graphloom-sdk-<v>.tgz>
 *        [--platform linux-x64]
 *
 * Creates `<out>/graphloom-<version>-<platform>/` and prints it. The source
 * tree must already be built, gated, and pruned to production dependencies.
 */
import { existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, readJson, runMain, sha256, sha256File, walk } from "./lib.mjs";
import { pruneTree } from "./prune-tree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Core packages: `package.json` and `dist/` only (§2.3). */
export const CORE_PACKAGES = ["packages/sdk", "packages/agent-harness", "packages/controller", "packages/plugin-host", "packages/supervisor", "packages/runner", "apps/graphloom"];

/** The commands of the release gate (§6 step 4), recorded in `release.json`. */
export const GATE = ["NODE_ENV=development npm ci --include=dev", "npm run build", "npm run typecheck", "npm test"];

const ROOT_FILES = ["package.json", "package-lock.json", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"];

/** The installer and the user shim (§4.2, §4.3), copied from `scripts/` to the tree's root, executable. */
const INSTALL_FILES = [["scripts/install.sh", "install.sh"], ["scripts/shim.sh", "shim.sh"]];

/** Never copied from a source-repairable package: dependencies, run state, caches, local secrets. */
function skipInPackage(name) {
  return name === "node_modules" || name === ".git" || name === "graphloom-state" || name === "coverage" || name === ".cache" || /^\.env(\.|$)/.test(name) || name.endsWith(".tsbuildinfo");
}

/** Never copied from `node_modules`: test-runner and tool caches written by the gate. */
function skipInModules(name) {
  return name === ".cache" || name === ".vite" || name === ".vitest";
}

const filtered = (skip) => (src) => !skip(path.basename(src));

/**
 * Checks the §3 lockstep rule: the root, every core package (and the SDK),
 * and the CLI carry the product version.
 */
export function checkLockstep(src, version) {
  const problems = [];
  for (const rel of [".", ...CORE_PACKAGES]) {
    const pkg = readJson(path.join(src, rel, "package.json"));
    if (pkg.version !== version) problems.push(`${rel === "." ? "package.json" : `${rel}/package.json`} is ${pkg.version}, not the product version ${version}`);
  }
  return problems;
}

/** Removes symlinks under `dir` whose target is missing, such as links to workspaces the release does not ship; returns them. */
async function dropDanglingLinks(dir) {
  const dropped = [];
  for (const e of await walk(dir)) {
    if (!e.stat.isSymbolicLink()) continue;
    if (await realpath(e.abs).then(() => false, () => true)) {
      dropped.push(`${e.rel} -> ${await readlink(e.abs)}`);
      await rm(e.abs);
    }
  }
  return dropped;
}

export async function assemble({ src, out, nodeDir, nodePin, version, commit, epoch, sdkTgz, platform = "linux-x64", log = () => {} }) {
  const lockstep = checkLockstep(src, version);
  if (lockstep.length > 0) throw new Error(`version lockstep (§3):\n  ${lockstep.join("\n  ")}`);

  const name = `graphloom-${version}-${platform}`;
  const dest = path.join(out, name);
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  await mkdir(dest, { recursive: true });

  for (const file of ROOT_FILES) {
    if (existsSync(path.join(src, file))) await copyFile(path.join(src, file), path.join(dest, file));
    else if (file !== "CHANGELOG.md") throw new Error(`staging tree has no ${file}`);
  }
  for (const [from, to] of INSTALL_FILES) {
    if (!existsSync(path.join(src, from))) throw new Error(`staging tree has no ${from}`);
    await copyFile(path.join(src, from), path.join(dest, to));
    await chmod(path.join(dest, to), 0o755);
  }
  // The release signing key's allowed_signers (§2.5), committed with R5: install.sh verifies later releases against it.
  if (existsSync(path.join(src, "release", "allowed_signers"))) {
    await mkdir(path.join(dest, "release"), { recursive: true });
    await copyFile(path.join(src, "release", "allowed_signers"), path.join(dest, "release", "allowed_signers"));
  }

  await cp(path.join(src, "node_modules"), path.join(dest, "node_modules"), { recursive: true, verbatimSymlinks: true, filter: filtered(skipInModules) });

  for (const rel of CORE_PACKAGES) {
    await mkdir(path.join(dest, rel), { recursive: true });
    await copyFile(path.join(src, rel, "package.json"), path.join(dest, rel, "package.json"));
    if (!existsSync(path.join(src, rel, "dist"))) throw new Error(`${rel} is not built`);
    await cp(path.join(src, rel, "dist"), path.join(dest, rel, "dist"), { recursive: true });
  }

  const repairable = [];
  for (const parent of ["executors", "examples/plugins"]) {
    for (const entry of readdirSync(path.join(src, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = `${parent}/${entry.name}`;
      if (!existsSync(path.join(src, rel, "package.json"))) continue;
      if (!existsSync(path.join(src, rel, "dist"))) throw new Error(`${rel} is not built`);
      await cp(path.join(src, rel), path.join(dest, rel), { recursive: true, verbatimSymlinks: true, filter: filtered(skipInPackage) });
      repairable.push(rel);
    }
  }

  for (const entry of readdirSync(path.join(src, "examples"), { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".yaml") || entry.name === "README.md")) {
      await copyFile(path.join(src, "examples", entry.name), path.join(dest, "examples", entry.name));
    }
  }

  await mkdir(path.join(dest, "node", "bin"), { recursive: true });
  await copyFile(path.join(nodeDir, "bin", "node"), path.join(dest, "node", "bin", "node"));
  await chmod(path.join(dest, "node", "bin", "node"), 0o755);
  await copyFile(path.join(nodeDir, "LICENSE"), path.join(dest, "node", "LICENSE"));

  await mkdir(path.join(dest, "bin"), { recursive: true });
  await copyFile(path.join(here, "launcher.sh"), path.join(dest, "bin", "graphloom"));
  await chmod(path.join(dest, "bin", "graphloom"), 0o755);

  // Before the links, digests, and notices, so each reflects what ships.
  await pruneTree(dest, { platform, log });
  for (const link of await dropDanglingLinks(dest)) log(`assemble: dropped link to an unshipped or pruned package: ${link}`);

  const release = await releaseManifest({ src, dest, version, commit, epoch, sdkTgz, nodePin, platform, repairable });
  await writeFile(path.join(dest, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return { dest, release };
}

/** `release.json` (§2.4) for the assembled tree at `dest`. */
export async function releaseManifest({ src, dest, version, commit, epoch, sdkTgz, nodePin, platform, repairable }) {
  const { digestExecutorSource } = await import(pathToFileURL(path.join(src, "packages", "runner", "dist", "index.js")).href);
  const { PROTOCOL_VERSION } = await import(pathToFileURL(path.join(src, "packages", "sdk", "dist", "index.js")).href);
  // The run-state format the release writes (§5.2), from the controller that writes it.
  const { CURRENT_STATE_FORMAT } = await import(pathToFileURL(path.join(src, "packages", "controller", "dist", "index.js")).href);
  const executors = [];
  const plugins = [];
  for (const rel of repairable) {
    const pkg = readJson(path.join(dest, rel, "package.json"));
    if (rel.startsWith("executors/")) {
      executors.push({ package: pkg.name, version: pkg.version, digest: await digestExecutorSource(path.join(dest, rel)) });
      continue;
    }
    const manifestFile = path.join(dest, rel, "graphloom.manifest.json");
    const raw = await readFile(manifestFile);
    const manifest = JSON.parse(raw.toString("utf8"));
    if (manifest.version !== pkg.version) throw new Error(`${rel}: package.json version ${pkg.version} differs from its manifest version ${manifest.version} (§3)`);
    plugins.push({ graphId: manifest.graphId, version: manifest.version, manifestSha256: sha256(raw), sourceTree: manifest.digests?.sourceTree });
  }
  const sdkPkg = readJson(path.join(src, "packages", "sdk", "package.json"));
  return {
    product: "graphloom",
    version,
    license: "Apache-2.0",
    platform,
    git: { tag: `v${version}`, commit, sourceDateEpoch: Number(epoch) },
    lockfileSha256: await sha256File(path.join(dest, "package-lock.json")),
    node: { version: nodePin.version, sha256: nodePin.sha256 },
    sdk: { version: sdkPkg.version, sdkProtocol: PROTOCOL_VERSION, sha256: await sha256File(sdkTgz) },
    stateFormat: CURRENT_STATE_FORMAT,
    executors: executors.sort((a, b) => a.package.localeCompare(b.package)),
    plugins: plugins.sort((a, b) => a.graphId.localeCompare(b.graphId)),
    gate: GATE,
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    for (const required of ["src", "out", "node", "node-pin", "version", "commit", "epoch", "sdk-tgz"]) {
      if (!flags[required]) throw new Error(`assemble.mjs: --${required} is required`);
    }
    const { readNodePin } = await import("./fetch-node.mjs");
    const { dest } = await assemble({
      src: path.resolve(flags.src),
      out: path.resolve(flags.out),
      nodeDir: path.resolve(flags.node),
      nodePin: readNodePin(path.resolve(flags["node-pin"])),
      version: flags.version,
      commit: flags.commit,
      epoch: flags.epoch,
      sdkTgz: path.resolve(flags["sdk-tgz"]),
      platform: flags.platform ?? "linux-x64",
      log: (line) => console.error(line),
    });
    console.log(dest);
  });
}
