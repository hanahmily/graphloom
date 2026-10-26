#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Regenerates graphloom.manifest.json from the built graph, with digests of
 * the source, profile and lock inputs. Run after `npm run build`:
 * `npm run manifest -w @graphloom/plugin-issue-fix`
 *
 * issue-fix describes itself only for a repository profile (the task's
 * config), so its stages and requirements depend on the run: the manifest
 * declares `taskConfig: "required"` and pins no requirements. A run pins the
 * definition `describe(config)` returns at intake; see
 * docs/design-issue-fix-graph.md.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function listFiles(dir, prefix) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

const pinned = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ...listFiles(path.join(root, "profiles"), "profiles"),
  // Every profile's "ocr" environment check runs it.
  "scripts/ocr-path.sh",
  ...listFiles(path.join(root, "src"), "src"),
  ...listFiles(path.join(root, "test"), "test"),
];
const files = Object.fromEntries(pinned.map((rel) => [rel, sha256(path.join(root, rel))]));
const tree = createHash("sha256");
for (const rel of pinned) tree.update(`${rel}\0${files[rel]}\n`);

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const { createGraph, GRAPH_ID, GRAPH_VERSION } = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
// Every shipped profile must describe cleanly, and all give one private-state schema.
const schemas = new Set();
for (const rel of pinned.filter((p) => p.startsWith("profiles/") && p.endsWith(".json"))) {
  const definition = createGraph().describe(JSON.parse(readFileSync(path.join(root, rel), "utf8")));
  if (definition.graphId !== GRAPH_ID || definition.version !== GRAPH_VERSION) throw new Error(`${rel}: graph ${definition.graphId}@${definition.version}`);
  schemas.add(definition.privateStateSchema);
}
if (schemas.size !== 1) throw new Error(`profiles disagree on the private-state schema: ${[...schemas].join(", ")}`);

const manifest = {
  graphId: GRAPH_ID,
  version: GRAPH_VERSION,
  sdkProtocol: 1,
  taskConfig: pkg.graphloom.taskConfig,
  entryPoints: {
    createGraph: "./dist/index.js",
    // docs/design-graph-rehearsal.md §4.4: declared only when the plugin ships one.
    ...(existsSync(path.join(root, "src", "rehearsal.ts")) ? { rehearsal: "./dist/rehearsal.js" } : {}),
  },
  privateStateSchema: [...schemas][0],
  repairContract: pkg.graphloom.repairContract,
  runtimeProfile: {
    node: pkg.engines.node,
    module: "nodenext",
    typescript: pkg.devDependencies.typescript,
    vitest: pkg.devDependencies.vitest,
  },
  digests: { sourceTree: tree.digest("hex"), packageLock: files["package-lock.json"], files },
};
writeFileSync(path.join(root, "graphloom.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote graphloom.manifest.json (${pinned.length} pinned files)`);
