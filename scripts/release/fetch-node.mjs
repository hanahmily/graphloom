// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Fetches and verifies the pinned Node runtime (docs/design-release.md §2.7).
 *
 *   node scripts/release/fetch-node.mjs --dest <dir> [--pin release/node.json]
 *        [--cache <dir>] [--base-url https://nodejs.org/dist]
 *
 * The tarball `node-v<version>-<platform>.tar.xz` must match the SHA-256
 * committed in the pin, and the release's own `SHASUMS256.txt` must list the
 * same digest. A verified copy is cached (default
 * `${XDG_CACHE_HOME:-~/.cache}/graphloom-release/node`) and re-verified on
 * every use. The tarball is extracted to `<dest>/node-v<version>-<platform>/`,
 * whose `bin/node --version` must name the pinned version. Prints that
 * directory. `--base-url` may be a `file://` URL or a directory, so tests run
 * against a local fixture instead of the network.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, readJson, runMain, sha256, sha256File } from "./lib.mjs";

export const DEFAULT_BASE_URL = "https://nodejs.org/dist";

export function defaultCacheDir(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "graphloom-release", "node");
}

/** The committed pin, validated: `{ version, sha256, platform }`. */
export function readNodePin(file) {
  const pin = readJson(file);
  if (typeof pin.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
    throw new Error(`${file}: version must be an exact x.y.z Node version`);
  }
  if (typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
    throw new Error(`${file}: sha256 must be a lowercase hex SHA-256`);
  }
  const platform = pin.platform ?? "linux-x64";
  if (typeof platform !== "string" || !/^[a-z0-9]+-[a-z0-9]+$/.test(platform)) throw new Error(`${file}: platform must look like linux-x64`);
  return { version: pin.version, sha256: pin.sha256, platform };
}

export function nodeTarballName(pin) {
  return `node-v${pin.version}-${pin.platform}.tar.xz`;
}

/** Reads `<base>/v<version>/<file>` from https, http, file://, or a plain directory. */
async function download(baseUrl, version, file) {
  const local = baseUrl.startsWith("file:") ? fileURLToPath(baseUrl) : /^[a-z]+:\/\//i.test(baseUrl) ? undefined : baseUrl;
  if (local !== undefined) return readFile(path.join(local, `v${version}`, file));
  const url = `${baseUrl.replace(/\/+$/, "")}/v${version}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The digest `SHASUMS256.txt` lists for `file`, or undefined. */
export function shasumsEntry(text, file) {
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === file) return m[1];
  }
  return undefined;
}

/**
 * Ensures a verified tarball is in the cache and returns its path. A cached
 * copy whose digest no longer matches the pin is discarded and fetched again;
 * a downloaded copy that does not match is refused and never cached.
 */
export async function fetchNodeTarball({ pin, cacheDir = defaultCacheDir(), baseUrl = DEFAULT_BASE_URL, log = () => {} }) {
  const file = nodeTarballName(pin);
  const cached = path.join(cacheDir, file);
  if (existsSync(cached)) {
    if ((await sha256File(cached)) === pin.sha256) {
      log(`node: using verified cache ${cached}`);
      return cached;
    }
    log(`node: cached ${cached} does not match the pin; fetching again`);
    await rm(cached, { force: true });
  }
  log(`node: fetching ${file} from ${baseUrl}`);
  const [tarball, shasums] = await Promise.all([download(baseUrl, pin.version, file), download(baseUrl, pin.version, "SHASUMS256.txt")]);
  const actual = sha256(tarball);
  if (actual !== pin.sha256) {
    throw new Error(`refusing ${file}: its SHA-256 ${actual} does not match the pinned ${pin.sha256}`);
  }
  const listed = shasumsEntry(shasums.toString("utf8"), file);
  if (listed !== pin.sha256) {
    throw new Error(`refusing ${file}: SHASUMS256.txt lists ${listed ?? "no digest"} for it, not the pinned ${pin.sha256}`);
  }
  await mkdir(cacheDir, { recursive: true });
  const partial = `${cached}.partial-${process.pid}`;
  await writeFile(partial, tarball);
  await rename(partial, cached);
  return cached;
}

/** Fetches, verifies, and extracts the runtime; returns the extracted `node-v<version>-<platform>` directory. */
export async function fetchNode({ pinFile, dest, cacheDir, baseUrl, log = () => {} }) {
  const pin = readNodePin(pinFile);
  const tarball = await fetchNodeTarball({ pin, cacheDir, baseUrl, log });
  await mkdir(dest, { recursive: true });
  // Extract a private copy so the cache is never handed to tar while another build reads it.
  const local = path.join(dest, nodeTarballName(pin));
  await copyFile(tarball, local);
  if ((await sha256File(local)) !== pin.sha256) throw new Error(`refusing ${local}: changed while copying from the cache`);
  const root = path.join(dest, `node-v${pin.version}-${pin.platform}`);
  await rm(root, { recursive: true, force: true });
  execFileSync("tar", ["-xJf", local, "-C", dest], { stdio: ["ignore", "ignore", "inherit"] });
  await rm(local, { force: true });
  const node = path.join(root, "bin", "node");
  const reported = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
  if (reported !== `v${pin.version}`) throw new Error(`${node} reports ${reported}, not the pinned v${pin.version}`);
  log(`node: verified ${nodeTarballName(pin)} (${pin.sha256}), ${reported}`);
  return { root, version: pin.version, sha256: pin.sha256, platform: pin.platform };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.dest) throw new Error("usage: fetch-node.mjs --dest <dir> [--pin <node.json>] [--cache <dir>] [--base-url <url>]");
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const result = await fetchNode({
      pinFile: path.resolve(flags.pin ?? path.join(repo, "release", "node.json")),
      dest: path.resolve(flags.dest),
      cacheDir: flags.cache ? path.resolve(flags.cache) : defaultCacheDir(),
      baseUrl: flags["base-url"] ?? DEFAULT_BASE_URL,
      log: (line) => console.error(line),
    });
    console.log(result.root);
  });
}
