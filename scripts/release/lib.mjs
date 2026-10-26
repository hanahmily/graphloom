// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Helpers shared by the release scripts (docs/design-release.md §6). They use
 * only Node's standard library: the release toolchain must not depend on a
 * third-party package that the release itself ships or prunes.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** SHA-256 hex digest of a file, streamed. */
export async function sha256File(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Every entry below `root`, depth first, as `{ rel, abs, stat }` with
 * POSIX-style relative paths. Symlinks are reported, never followed.
 * `skip(rel, stat)` returning true prunes an entry (and, for a directory,
 * everything below it).
 */
export async function walk(root, skip = () => false) {
  const out = [];
  const visit = async (relDir) => {
    const names = (await readdir(path.join(root, relDir))).sort();
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = path.join(root, rel);
      const stat = await lstat(abs);
      if (skip(rel, stat)) continue;
      out.push({ rel, abs, stat });
      if (stat.isDirectory()) await visit(rel);
    }
  };
  await visit("");
  return out;
}

/** Minimal `--flag value` / `--flag` parser; repeated flags collect into arrays. */
export function parseArgs(argv, { booleans = [], multiple = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (multiple.includes(name)) (flags[name] ??= []).push(value);
    else flags[name] = value;
  }
  return { flags, positional };
}

/** Run `main`, printing an error's message (not its stack) and exiting 1 on failure. */
export function runMain(main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
