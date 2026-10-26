// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Shrinks an assembled release tree's `node_modules` without changing what
 * any module resolves to (docs/design-release.md §2.3, §6 step 6).
 *
 *   node scripts/release/prune-tree.mjs --root <tree> [--platform linux-x64] [--libc glibc]
 *
 * 1. **Platform prune.** Removes every installed package whose `package.json`
 *    `os`, `cpu`, or `libc` excludes the release target. A package that
 *    bundles its own shrinkwrap (pi-coding-agent) gets every platform's
 *    optional binaries when npm reifies it, whichever platform it runs on.
 * 2. **Exact dedupe.** Removes a nested copy of a package when Node, after
 *    the removal, resolves the same name to a copy with byte-identical files
 *    and the same resolution for its whole dependency closure. A shrinkwrap
 *    pins its own copies of packages the top level already has at the same
 *    version; those are the copies this removes.
 *
 * Prints what it removed and the bytes saved.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain, sha256 } from "./lib.mjs";

/** npm's `os`/`cpu`/`libc` rule: excluded by a matching `!value`, or by a positive list that does not name the value. */
export function excludedBy(list, value) {
  if (list === undefined) return false;
  const entries = (Array.isArray(list) ? list : [list]).filter((e) => typeof e === "string");
  if (entries.length === 0) return false;
  if (entries.includes(`!${value}`)) return true;
  const positive = entries.filter((e) => !e.startsWith("!"));
  return positive.length > 0 && !positive.includes(value);
}

export function parseTarget(platform = "linux-x64", libc = "glibc") {
  const [os, cpu] = platform.split("-");
  if (!os || !cpu) throw new Error(`platform must look like linux-x64, got ${platform}`);
  return { os, cpu, libc };
}

/** Why the package at `pkg` cannot run on `target`, or undefined when it can. */
export function platformMismatch(pkg, target) {
  if (excludedBy(pkg.os, target.os)) return `os ${JSON.stringify(pkg.os)}`;
  if (excludedBy(pkg.cpu, target.cpu)) return `cpu ${JSON.stringify(pkg.cpu)}`;
  if (target.os === "linux" && excludedBy(pkg.libc, target.libc)) return `libc ${JSON.stringify(pkg.libc)}`;
  return undefined;
}

function readPkg(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** Every real (non-link) package directory under `modules`, nested `node_modules` included, outermost first. */
export function installedPackages(modules) {
  const out = [];
  const visit = (dir) => {
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (name.startsWith("@")) {
        visit(full);
        continue;
      }
      const pkg = readPkg(full);
      if (pkg === undefined) continue;
      out.push({ dir: full, pkg });
      visit(path.join(full, "node_modules"));
    }
  };
  visit(modules);
  return out;
}

function duBytes(p) {
  const stat = lstatSync(p);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(p).reduce((sum, n) => sum + duBytes(path.join(p, n)), 0);
}

/** Packages under `<root>/node_modules` that do not run on `target`: `{ rel, reason }`. */
export function foreignPackages(root, target) {
  return installedPackages(path.join(root, "node_modules"))
    .map(({ dir, pkg }) => ({ rel: path.relative(root, dir).split(path.sep).join("/"), reason: platformMismatch(pkg, target) }))
    .filter((p) => p.reason !== undefined);
}

export async function prunePlatform(root, target) {
  const removed = [];
  let bytes = 0;
  for (const { rel, reason } of foreignPackages(root, target)) {
    const dir = path.join(root, rel);
    if (!existsSync(dir)) continue; // inside a package removed earlier
    bytes += duBytes(dir);
    await rm(dir, { recursive: true, force: true });
    removed.push(`${rel} (${reason})`);
  }
  return { removed, bytes };
}

/** Where Node resolves bare `name` from a module inside `fromDir`: the nearest `node_modules/<name>` up to `root`. */
export function resolvePackageDir(fromDir, name, root) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.basename(dir) === "node_modules" ? undefined : path.join(dir, "node_modules", name);
    if (candidate !== undefined && existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    if (dir === root || path.dirname(dir) === dir) return undefined;
    dir = path.dirname(dir);
  }
}

const digests = new Map();

/** Digest of a package's own files (its relative paths and bytes), excluding its nested `node_modules`. */
function contentDigest(dir) {
  const cached = digests.get(dir);
  if (cached !== undefined) return cached;
  const digest = computeDigest(dir);
  digests.set(dir, digest);
  return digest;
}

function computeDigest(dir) {
  const parts = [];
  const visit = (rel) => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      if (rel === "" && name === "node_modules") continue;
      const r = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path.join(dir, r));
      if (stat.isDirectory()) visit(r);
      else parts.push(r, stat.isSymbolicLink() ? `link:${readlinkSafe(path.join(dir, r))}` : sha256(readFileSync(path.join(dir, r))));
    }
  };
  visit("");
  return sha256(parts.join("\0"));
}

function readlinkSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return "";
  }
}

function dependencyNames(pkg) {
  return [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})])];
}

/**
 * True when every dependency in `a`'s closure resolves to the same files as
 * in `b`'s: each step compares the package directories Node would load from
 * each side by content, so a copy may be shared only when nothing it loads
 * would change.
 */
function sameClosure(a, b, root, seen = new Set()) {
  const key = `${a}\0${b}`;
  if (a === b || seen.has(key)) return true;
  seen.add(key);
  const pa = readPkg(a);
  const pb = readPkg(b);
  if (pa === undefined || pb === undefined || pa.version !== pb.version || contentDigest(a) !== contentDigest(b)) return false;
  for (const dep of dependencyNames(pa)) {
    const ra = resolvePackageDir(a, dep, root);
    const rb = resolvePackageDir(b, dep, root);
    if (ra === undefined && rb === undefined) continue; // an optional dependency absent on both sides
    if (ra === undefined || rb === undefined || !sameClosure(ra, rb, root, seen)) return false;
  }
  return true;
}

/**
 * Removes nested copies that an identical, identically-resolving copy higher
 * up would serve, one at a time until none is left, so each removal is judged
 * against the tree as it then is.
 */
export async function dedupeNested(root) {
  const rootReal = realpathSync(root);
  const removed = [];
  let bytes = 0;
  for (;;) {
    let progress = false;
    for (const { dir } of installedPackages(path.join(rootReal, "node_modules"))) {
      const scoped = path.basename(path.dirname(dir)).startsWith("@");
      const parentModules = scoped ? path.dirname(path.dirname(dir)) : path.dirname(dir);
      if (parentModules === path.join(rootReal, "node_modules")) continue; // a top-level copy has nowhere higher to defer to
      // The name a dependent requires: the directory it is installed under, which an alias may make differ from package.json's name.
      const name = path.relative(parentModules, dir).split(path.sep).join("/");
      // What this copy's dependents load once it is gone: Node's next lookup, above the package that owns parentModules.
      const owner = path.dirname(parentModules);
      const above = resolvePackageDir(path.dirname(owner), name, rootReal);
      if (above === undefined || !sameClosure(dir, above, rootReal)) continue;
      const size = duBytes(dir);
      // Its own nested packages go with it; the copy above resolves the same closure without them.
      await rm(dir, { recursive: true, force: true });
      bytes += size;
      removed.push(`${path.relative(rootReal, dir).split(path.sep).join("/")} -> ${path.relative(rootReal, above).split(path.sep).join("/")}`);
      progress = true;
      break;
    }
    if (!progress) return { removed, bytes };
  }
}

/** Removes scope and `node_modules` directories that the removals left empty. */
async function removeEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    if (!stat.isDirectory()) continue;
    await removeEmptyDirs(full);
    if ((name.startsWith("@") || name === "node_modules") && readdirSync(full).length === 0) await rm(full, { recursive: true });
  }
}

export async function pruneTree(root, { platform = "linux-x64", libc = "glibc", log = () => {} } = {}) {
  const target = parseTarget(platform, libc);
  const foreign = await prunePlatform(root, target);
  for (const line of foreign.removed) log(`prune: not for ${platform}: ${line}`);
  log(`prune: removed ${foreign.removed.length} package(s) for other platforms, ${foreign.bytes} bytes`);
  const dedupe = await dedupeNested(root);
  log(`prune: removed ${dedupe.removed.length} nested duplicate(s) that identical copies above serve, ${dedupe.bytes} bytes`);
  await removeEmptyDirs(path.join(root, "node_modules"));
  return { foreign, dedupe };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.root) throw new Error("usage: prune-tree.mjs --root <tree> [--platform linux-x64] [--libc glibc]");
    await pruneTree(path.resolve(flags.root), { platform: flags.platform ?? "linux-x64", libc: flags.libc ?? "glibc", log: (l) => console.error(l) });
  });
}
