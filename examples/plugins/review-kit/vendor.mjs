#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Copies the review kit's sources (`examples/plugins/review-kit/src`) into a
 * plugin's `src/kit/`, replacing what was there, byte for byte
 * (docs/design-pr-review-split.md §2). A plugin runs it as
 * `npm run vendor -w <plugin>`, whose script is `node ../review-kit/vendor.mjs`;
 * the plugin is the current directory, or the directory given as the argument.
 *
 * The copy is source, not a dependency, so it is inside the plugin's manifest
 * digest and a qualified repair in one plugin's run cannot change another
 * plugin. Each plugin's drift test fails when its copy differs from the kit;
 * after a copy, rebuild the plugin and regenerate its manifest.
 */
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kit = path.join(path.dirname(fileURLToPath(import.meta.url)), "src");
const plugin = path.resolve(process.argv[2] ?? process.cwd());
const pkgFile = path.join(plugin, "package.json");
if (!existsSync(pkgFile) || !existsSync(path.join(plugin, "src"))) {
  process.stderr.write(`vendor: ${plugin} is not a plugin directory (no package.json and src/)\n`);
  process.exit(2);
}
const target = path.join(plugin, "src", "kit");
rmSync(target, { recursive: true, force: true });
cpSync(kit, target, { recursive: true });
const name = JSON.parse(readFileSync(pkgFile, "utf8")).name;
process.stdout.write(`vendor: copied ${path.relative(process.cwd(), kit) || "."} to ${path.relative(process.cwd(), target)}\n`);
process.stdout.write(`next: npm run build -w ${name} && npm run manifest -w ${name}\n`);
