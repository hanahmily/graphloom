#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Checks that every hand-written source file carries the SPDX header from
 * docs/design-release.md §2.8 ("Source headers"):
 *
 *   // SPDX-License-Identifier: Apache-2.0
 *   // Copyright 2026 Hongtao Gao and the GraphLoom contributors
 *
 * in the file's comment syntax, as its first two lines, or right after a
 * shebang line. Prints each offending path and exits 1 when any covered file
 * lacks it. `--fix` inserts the header instead. `--root <dir>` checks another
 * tree (default: this repository).
 *
 * Files come from `git ls-files` when the root is the top of a Git work tree.
 * A tree without Git metadata, such as the `git archive` staging tree the
 * release gate runs in (§6), is walked instead.
 *
 * Covered: `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, and `.sh`, including
 * tests. Exempt: declaration files (`.d.ts`), generated output (`dist/`),
 * dependencies (`node_modules/`), test fixtures (any `fixtures/` directory),
 * vendored third-party sources (any `vendor/` directory: copied unmodified, with
 * their own license), and the unbuilt historical tree under `legacy/`. JSON, Markdown, lockfiles,
 * and generated manifests are not covered extensions.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LICENSE_LINE = "SPDX-License-Identifier: Apache-2.0";
export const COPYRIGHT_LINE = "Copyright 2026 Hongtao Gao and the GraphLoom contributors";

const SLASH_COMMENT = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const HASH_COMMENT = new Set([".sh"]);
const EXEMPT_SEGMENTS = new Set(["dist", "node_modules", "fixtures", "vendor"]);
const EXEMPT_PREFIXES = ["legacy/"];

/** The comment prefix for a covered path, or null when the path is not covered. */
export function commentPrefix(rel) {
  const posix = rel.split(path.sep).join("/");
  if (EXEMPT_PREFIXES.some((prefix) => posix.startsWith(prefix))) return null;
  if (posix.split("/").slice(0, -1).some((segment) => EXEMPT_SEGMENTS.has(segment))) return null;
  if (/\.d\.[cm]?ts$/.test(posix)) return null;
  const ext = path.posix.extname(posix);
  if (SLASH_COMMENT.has(ext)) return "//";
  if (HASH_COMMENT.has(ext)) return "#";
  return null;
}

export function headerLines(prefix) {
  return [`${prefix} ${LICENSE_LINE}`, `${prefix} ${COPYRIGHT_LINE}`];
}

/** True when the text starts with the header, after an optional shebang line. */
export function hasHeader(text, prefix) {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = lines[0]?.startsWith("#!") ? 1 : 0;
  const [license, copyright] = headerLines(prefix);
  return lines[start] === license && lines[start + 1] === copyright;
}

/** The text with the header inserted after any shebang, followed by a blank line. */
export function addHeader(text, prefix) {
  const header = `${headerLines(prefix).join("\n")}\n`;
  let shebang = "";
  let rest = text;
  if (text.startsWith("#!")) {
    const end = text.indexOf("\n");
    shebang = end === -1 ? `${text}\n` : text.slice(0, end + 1);
    rest = end === -1 ? "" : text.slice(end + 1);
  }
  const separator = rest === "" || rest.startsWith("\n") ? "" : "\n";
  return `${shebang}${header}${separator}${rest}`;
}

/** Tracked files when root is the top of a Git work tree; otherwise every file under root. */
export function sourceFiles(root) {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status === 0 && realpathSync(top.stdout.trim()) === realpathSync(root)) {
    const result = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ls-files failed in ${root}: ${result.stderr || result.error?.message}`);
    }
    return result.stdout.split("\0").filter(Boolean);
  }
  return walk(root, "");
}

function walk(root, prefix) {
  const out = [];
  for (const entry of readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || EXEMPT_SEGMENTS.has(entry.name) || EXEMPT_PREFIXES.includes(`${rel}/`)) continue;
      out.push(...walk(root, rel));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Covered files under root that lack the header; with fix, adds it and returns the fixed paths. */
export function checkHeaders(root, { fix = false } = {}) {
  const missing = [];
  for (const rel of sourceFiles(root)) {
    const prefix = commentPrefix(rel);
    if (prefix === null) continue;
    const file = path.join(root, rel);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue; // deleted in the work tree
      throw error;
    }
    if (hasHeader(text, prefix)) continue;
    missing.push(rel);
    if (fix) writeFileSync(file, addHeader(text, prefix));
  }
  return missing;
}

function main(argv) {
  const fix = argv.includes("--fix");
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex === -1
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
      : path.resolve(argv[rootIndex + 1] ?? ".");
  const missing = checkHeaders(root, { fix });
  if (missing.length === 0) {
    console.log("check-headers: every covered source file has the SPDX header");
    return 0;
  }
  if (fix) {
    console.log(`check-headers: added the SPDX header to ${missing.length} file(s):`);
    for (const rel of missing) console.log(`  ${rel}`);
    return 0;
  }
  console.error(`check-headers: ${missing.length} file(s) lack the SPDX header:`);
  for (const rel of missing) console.error(`  ${rel}`);
  console.error("Run `node scripts/check-headers.mjs --fix` to add it.");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
