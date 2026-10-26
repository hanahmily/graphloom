#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Regenerates graphloom.manifest.json from the built definition, with digests of
 * the source and lock inputs. Run after `npm run build`:
 * `npm run manifest -w @graphloom/plugin-banyandb-fix`
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
  ...listFiles(path.join(root, "src"), "src"),
  ...listFiles(path.join(root, "test"), "test"),
];
const files = Object.fromEntries(pinned.map((rel) => [rel, sha256(path.join(root, rel))]));
const tree = createHash("sha256");
for (const rel of pinned) tree.update(`${rel}\0${files[rel]}\n`);

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const { createGraph } = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
const definition = createGraph().describe();

const manifest = {
  graphId: definition.graphId,
  version: definition.version,
  sdkProtocol: 1,
  entryPoints: {
    createGraph: "./dist/index.js",
    // docs/design-graph-rehearsal.md §4.4: declared only when the plugin ships one.
    ...(existsSync(path.join(root, "src", "rehearsal.ts")) ? { rehearsal: "./dist/rehearsal.js" } : {}),
  },
  privateStateSchema: definition.privateStateSchema,
  repairContract: pkg.graphloom.repairContract,
  runtimeProfile: {
    node: pkg.engines.node,
    module: "nodenext",
    typescript: pkg.devDependencies.typescript,
    vitest: pkg.devDependencies.vitest,
  },
  digests: { sourceTree: tree.digest("hex"), packageLock: files["package-lock.json"], files },
  requirements: definition.requirements,
  stages: definition.stages,
};
writeFileSync(path.join(root, "graphloom.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote graphloom.manifest.json (${pinned.length} pinned files)`);
