// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A `PATH` with the host's tools but no Node (docs/design-release.md §6
 * step 8): smoke tests run the release with this as their whole `PATH`.
 *
 *   node scripts/release/no-node-path.mjs --dir <empty dir>
 *
 * Links every executable found on the current `PATH` into `<dir>` (the first
 * one of each name wins, as `PATH` lookup would) except Node and its package
 * managers, and prints `<dir>`.
 */
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain } from "./lib.mjs";

export const NODE_TOOLS = new Set(["node", "nodejs", "npm", "npx", "corepack", "pnpm", "yarn"]);

export async function makeNoNodePath(dir, searchPath = process.env.PATH ?? "") {
  await mkdir(dir, { recursive: true });
  const linked = new Set();
  for (const from of searchPath.split(path.delimiter).filter(Boolean)) {
    let names;
    try {
      names = readdirSync(from);
    } catch {
      continue;
    }
    for (const name of names) {
      if (linked.has(name) || NODE_TOOLS.has(name)) continue;
      const file = path.join(from, name);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
      } catch {
        continue;
      }
      linked.add(name);
      await symlink(file, path.join(dir, name));
    }
  }
  return dir;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.dir) throw new Error("usage: no-node-path.mjs --dir <dir>");
    console.log(await makeNoNodePath(path.resolve(flags.dir)));
  });
}
