// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `graphloom version` (docs/design-release.md §2.4). The product version's
 * source of truth is the root `package.json`; a release tree also carries
 * `release.json`, written by `scripts/release.sh build`, and that file wins.
 * A clone with no `release.json` reports `<root version>-dev+<short sha>`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The installation root: `apps/graphloom/dist/version.js` is three levels below it, in a clone and in a release tree. */
export function installRoot(): string {
  return realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."));
}

export interface VersionInfo {
  version: string;
  /** Full commit sha, when known. */
  commit?: string;
  /** The parsed `release.json`, when this is a release tree. */
  release?: Record<string, unknown>;
}

/** The product version of the tree at `root`: its `release.json`, or the root `package.json` plus the Git commit. */
export function versionInfo(root: string): VersionInfo {
  const release = readJson(path.join(root, "release.json"));
  if (release !== undefined) {
    if (release.product !== "graphloom" || typeof release.version !== "string") {
      throw new Error(`${path.join(root, "release.json")} is not a GraphLoom release manifest`);
    }
    const git = release.git as { commit?: unknown } | undefined;
    return {
      version: release.version,
      ...(typeof git?.commit === "string" ? { commit: git.commit } : {}),
      release,
    };
  }
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg === undefined || typeof pkg.version !== "string") {
    throw new Error(`neither release.json nor a versioned package.json found at ${root}`);
  }
  const commit = gitCommit(root);
  return {
    version: commit !== undefined ? `${pkg.version}-dev+${commit.slice(0, 7)}` : `${pkg.version}-dev`,
    ...(commit !== undefined ? { commit } : {}),
  };
}

/** The three forms of `graphloom version`: text, `--json` (the whole release manifest), and `--root`. */
export function formatVersion(root: string, args: readonly string[]): string {
  if (args.includes("--root")) return root;
  const info = versionInfo(root);
  if (args.includes("--json")) {
    return JSON.stringify(info.release ?? { product: "graphloom", version: info.version, ...(info.commit !== undefined ? { git: { commit: info.commit } } : {}) }, null, 2);
  }
  return info.release !== undefined && info.commit !== undefined
    ? `graphloom ${info.version} (${info.commit.slice(0, 7)})`
    : `graphloom ${info.version}`;
}

function readJson(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const value = JSON.parse(raw) as unknown;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** HEAD of the Git work tree whose top level is exactly `root`; a tree nested in some other repository has no commit of its own. */
function gitCommit(root: string): string | undefined {
  try {
    const run = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (realpathSync(run("rev-parse", "--show-toplevel")) !== realpathSync(root)) return undefined;
    const sha = run("rev-parse", "HEAD");
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}
