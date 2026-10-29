// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** First Node release line with a stable `--permission` model. */
const MIN_PERMISSION_NODE = [22, 13] as const;

/** Throw unless this Node runtime can enforce the executor sandbox. */
export function assertSandboxSupported(version: string = process.versions.node): void {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [needMajor, needMinor] = MIN_PERMISSION_NODE;
  if (major > needMajor || (major === needMajor && minor >= needMinor)) return;
  throw new Error(
    `Node ${version} cannot enforce executor filesystem and process scopes; ` +
      `built-in executors require Node >= ${needMajor}.${needMinor}`,
  );
}

/**
 * Node flags that confine an executor process to reading its own code and
 * dependencies. Writes, child processes, worker threads, native addons, and
 * WASI stay denied because the permission model grants none of them by default.
 */
export function sandboxNodeArgs(modules: readonly string[], extraReadPaths: readonly string[] = []): string[] {
  const readable = new Set<string>();
  const seen = new Set<string>();
  for (const file of modules) addPackageClosure(packageRootOf(file), readable, seen);
  for (const p of extraReadPaths) readable.add(path.resolve(p));
  return ["--permission", ...[...readable].sort().map((p) => `--allow-fs-read=${p}`)];
}

/**
 * Every directory a module's packages read at run time: each module's package, its real location, and
 * the dependencies Node's resolver reaches from it. What a confined job that hides the operator's home
 * must still see of an executor installed beneath it.
 */
export function packageClosure(modules: readonly string[]): string[] {
  const readable = new Set<string>();
  const seen = new Set<string>();
  for (const file of modules) addPackageClosure(packageRootOf(file), readable, seen);
  return [...readable].sort();
}

/** Nearest directory at or above `file` holding a package.json. */
export function packageRootOf(file: string): string {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(path.resolve(file));
    dir = parent;
  }
}

/** A package, its real location, and every dependency as Node's resolver will reach it. */
function addPackageClosure(root: string, readable: Set<string>, seen: Set<string>): void {
  const real = realpathSync(root);
  readable.add(root);
  readable.add(real);
  if (seen.has(real)) return;
  seen.add(real);
  for (const dep of dependencyNames(real)) {
    const link = findDependency(real, dep);
    if (link !== undefined) addPackageClosure(link, readable, seen);
  }
}

function dependencyNames(root: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/** Node resolves bare specifiers from the importer's real path up through `node_modules`. */
function findDependency(fromRealRoot: string, name: string): string | undefined {
  let dir = fromRealRoot;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
