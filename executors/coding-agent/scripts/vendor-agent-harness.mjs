#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Vendors `@graphloom/agent-harness` into this executor package
 * (docs/design-supervisor-harnesses.md §3.2): copies the library's built
 * `dist` (its `.js` and `.d.ts` files) into `dist/vendor/agent-harness/`,
 * which the executor imports through its `#agent-harness/*` subpath imports.
 * A run pins the executor by a digest over its package tree that skips
 * `node_modules`, so only a vendored copy puts the harness code under that pin.
 *
 * The library is taken from the workspace checkout this package sits in
 * (`../../packages/agent-harness`). A copy of the package standing alone, such
 * as a run-local executor repair's candidate tree or an installed release,
 * has no such checkout: there the vendored copy already in `dist/` is the
 * code under review and is kept as it is.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIBRARY = "@graphloom/agent-harness";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(packageRoot, "dist", "vendor", "agent-harness");
const libraryRoot = path.resolve(packageRoot, "..", "..", "packages", "agent-harness");

function isLibrary(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === LIBRARY;
  } catch {
    return false;
  }
}

/** Built library files, relative to `dir`, sorted: modules and declarations only, never source maps. */
async function builtFiles(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await builtFiles(dir, rel)));
    else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) out.push(rel);
  }
  return out.sort();
}

/** The maps point at the library's own sources, which are not vendored. */
function withoutSourceMap(text) {
  return text.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
}

if (!isLibrary(libraryRoot)) {
  if (existsSync(target)) {
    console.error(`vendor-agent-harness: no ${LIBRARY} checkout beside this package; keeping the vendored copy in dist/vendor/agent-harness`);
    process.exit(0);
  }
  console.error(`vendor-agent-harness: ${LIBRARY} not found at ${libraryRoot}, and dist/vendor/agent-harness holds no vendored copy`);
  process.exit(1);
}
const source = path.join(libraryRoot, "dist");
if (!existsSync(source)) {
  console.error(`vendor-agent-harness: ${LIBRARY} is not built (no ${source}); run npm run build -w ${LIBRARY} first`);
  process.exit(1);
}
await rm(target, { recursive: true, force: true });
for (const rel of await builtFiles(source)) {
  const to = path.join(target, rel);
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, withoutSourceMap(await readFile(path.join(source, rel), "utf8")));
}
