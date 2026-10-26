// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Pi loads from a pruned release tree (docs/design-release.md §6 step 8).
 *
 *   <tree>/node/bin/node scripts/release/smoke-pi.mjs --root <tree>
 *
 * Imports the modules that load Pi the way GraphLoom does: the supervisor
 * package, the Pi harness and its rehearsal stand-in, and
 * `@earendil-works/pi-coding-agent` resolved from the harness. It then runs
 * esbuild as Pi's own dependency tree resolves it (through
 * `@earendil-works/chord`), which needs its native binary for this platform.
 * The platform prune and the nested dedupe (`prune-tree.mjs`) must leave all
 * of this working.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain } from "./lib.mjs";

/** The directory Node loads bare `name` from, for a module in `fromDir` (packages whose `exports` hide `package.json` included). */
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      const candidate = path.join(dir, "node_modules", name);
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }
    if (path.dirname(dir) === dir) throw new Error(`${name} does not resolve from ${fromDir}`);
  }
}

export async function smokePi(root) {
  const loaded = [];
  const load = async (file) => {
    await import(pathToFileURL(file).href);
    loaded.push(path.relative(root, file));
  };
  await load(path.join(root, "packages", "supervisor", "dist", "index.js"));
  const harness = path.join(root, "executors", "coding-agent", "dist", "pi.js");
  await load(harness);
  await load(path.join(root, "executors", "coding-agent", "dist", "rehearsal", "pi.js"));

  // The package is ESM-only and its `exports` hide package.json, so find it as Node would and follow its import entry.
  const piPackage = findPackage(path.dirname(harness), "@earendil-works/pi-coding-agent");
  const manifest = JSON.parse(readFileSync(path.join(piPackage, "package.json"), "utf8"));
  const entry = manifest.exports?.["."]?.import ?? manifest.exports?.["."]?.default ?? manifest.main;
  if (typeof entry !== "string") throw new Error(`${piPackage}/package.json names no import entry`);
  const piEntry = path.join(piPackage, entry);
  const pi = await import(pathToFileURL(piEntry).href);
  if (Object.keys(pi).length === 0) throw new Error(`${piEntry} exports nothing`);
  loaded.push(path.relative(root, piEntry));

  const chord = findPackage(piPackage, "@earendil-works/chord");
  const esbuild = createRequire(path.join(chord, "package.json"))("esbuild");
  const { code } = esbuild.transformSync("const x: number = 1; export default x;", { loader: "ts", format: "esm" });
  if (!code.includes("const x = 1")) throw new Error(`esbuild ${esbuild.version} returned unexpected output: ${code}`);
  return { loaded, esbuild: esbuild.version };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.root) throw new Error("usage: smoke-pi.mjs --root <tree>");
    const { loaded, esbuild } = await smokePi(path.resolve(flags.root));
    console.log(`pi: loaded ${loaded.join(", ")}; esbuild ${esbuild} transforms through @earendil-works/chord`);
  });
}
