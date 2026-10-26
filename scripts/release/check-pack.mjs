// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The SDK tarball's file list (docs/design-release.md §3.1, §6 step 5).
 *
 *   node scripts/release/check-pack.mjs --tarball graphloom-sdk-<v>.tgz [--version <v>]
 *
 * `npm pack` of `@graphloom/sdk` must hold exactly `package.json`, `dist/`,
 * `LICENSE`, and `NOTICE` under `package/`, with `dist/index.js` and
 * `dist/index.d.ts` present, and `package.json` naming the expected version.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain } from "./lib.mjs";

const REQUIRED = ["package/package.json", "package/LICENSE", "package/NOTICE", "package/dist/index.js", "package/dist/index.d.ts"];
const ALLOWED = (entry) => ["package/package.json", "package/LICENSE", "package/NOTICE"].includes(entry) || entry.startsWith("package/dist/");

/** Problems with the SDK tarball's entries; `entries` are paths as `tar -t` lists them. */
export function checkSdkEntries(entries) {
  const files = entries.map((e) => e.replace(/^\.\//, "")).filter((e) => e !== "" && !e.endsWith("/"));
  const problems = [];
  for (const r of REQUIRED) if (!files.includes(r)) problems.push(`missing ${r}`);
  for (const f of files) {
    if (!ALLOWED(f)) problems.push(`unexpected file ${f}`);
    if (/\.test\.|\.tsbuildinfo$|(^|\/)\.env/.test(f)) problems.push(`must not ship ${f}`);
  }
  return problems;
}

export function listTarball(tarball) {
  return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n").filter(Boolean);
}

export function checkSdkTarball(tarball, { version } = {}) {
  const problems = checkSdkEntries(listTarball(tarball));
  if (problems.length === 0) {
    const pkg = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
    if (pkg.name !== "@graphloom/sdk") problems.push(`package.json names ${pkg.name}, not @graphloom/sdk`);
    if (version !== undefined && pkg.version !== version) problems.push(`package.json version ${pkg.version}, not ${version}`);
    if (pkg.license !== "Apache-2.0") problems.push(`package.json license ${pkg.license}, not Apache-2.0`);
  }
  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.tarball) throw new Error("usage: check-pack.mjs --tarball <graphloom-sdk-<v>.tgz> [--version <v>]");
    const problems = checkSdkTarball(path.resolve(flags.tarball), { version: flags.version });
    if (problems.length > 0) throw new Error(`SDK tarball check failed:\n  ${problems.join("\n  ")}`);
    console.error(`sdk: ${path.basename(flags.tarball)} holds package.json, dist/, LICENSE, and NOTICE only`);
  });
}
