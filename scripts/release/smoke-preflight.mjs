// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Repair preflight on a release tree (docs/design-release.md §2.2, §2.7).
 *
 *   <tree>/node/bin/node scripts/release/smoke-preflight.mjs --root <tree>
 *        [--plugin <examples/plugins/release>] [--sdk <packages/sdk>] [--target validator|plugin]
 *
 * Runs the CLI's own qualified-repair preflight (`piRepairDeps(...).preflight`
 * from `<tree>/apps/graphloom/dist/repair-config.js`) on a validator repair of
 * the release example plugin, the way a live run does: an installed copy with
 * a defective changelog validator, and a candidate that fixes it. Preflight
 * must build the candidate with GraphLoom's own `typescript` and pass the
 * installed copy's `scripts/qualify.mjs`. It refuses to run when any `PATH`
 * directory has a `node`, so a pass proves that preflight needs only the Node
 * running it and the tree's production dependencies.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, runMain } from "./lib.mjs";

/** The release plugin's shipped heading pattern accepts an optional date; the defect drops it. */
const DATE_SUFFIX = "(?: - \\d{4}-\\d{2}-\\d{2})?";

export function nodeOnPath(searchPath = process.env.PATH ?? "") {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

async function copyPlugin(from, to, sdk) {
  await cp(from, to, { recursive: true, filter: (src) => path.basename(src) !== "node_modules" && path.basename(src) !== "dist" });
  // An installed version directory is read-only, and a copy keeps its modes.
  execFileSync("chmod", ["-R", "u+w", to]);
  await mkdir(path.join(to, "node_modules", "@graphloom"), { recursive: true });
  await symlink(sdk, path.join(to, "node_modules", "@graphloom", "sdk"), "dir");
}

/**
 * `validator` (the default) repairs the installed copy's broken validator and
 * runs `qualify.mjs`; `plugin` only builds an unchanged candidate, which needs
 * nothing from the tree but the CLI and its `typescript`.
 */
export async function smokePreflight({ root, plugin, sdk, target = "validator" }) {
  const found = nodeOnPath();
  if (found !== undefined) throw new Error(`refusing to run: PATH has a node (${found}); preflight must not need one`);
  const repairConfig = path.join(root, "apps", "graphloom", "dist", "repair-config.js");
  const { piRepairDeps } = await import(pathToFileURL(repairConfig).href);

  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-release-preflight-"));
  try {
    const installed = path.join(dir, "plugins", "release");
    const candidate = path.join(dir, "candidate");
    await copyPlugin(plugin, installed, sdk);
    await copyPlugin(plugin, candidate, sdk);
    if (target === "validator") {
      const validators = path.join(installed, "src", "validators.ts");
      const shipped = await readFile(validators, "utf8");
      if (!shipped.includes(DATE_SUFFIX)) throw new Error(`${validators} no longer has the heading pattern this smoke test breaks`);
      await writeFile(validators, shipped.replace(DATE_SUFFIX, ""));
      const tsc = path.join(path.dirname(createRequire(repairConfig).resolve("typescript/package.json")), "bin", "tsc");
      execFileSync(process.execPath, [tsc, "-p", path.join(installed, "tsconfig.json")], { stdio: ["ignore", "pipe", "pipe"] });
    }

    const config = { provider: "minimax-cn", modelId: "MiniMax-M3", models: [{ provider: "minimax-cn", modelId: "MiniMax-M3" }] };
    const deps = piRepairDeps(config, installed);
    const result = await deps.preflight({ candidateRoot: candidate, target });
    if (!result.ok) throw new Error(`repair preflight failed: ${result.summary}`);
    return result.summary;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  runMain(async () => {
    const { flags } = parseArgs(process.argv.slice(2));
    if (!flags.root) throw new Error("usage: smoke-preflight.mjs --root <tree> [--plugin <dir>] [--sdk <dir>] [--target validator|plugin]");
    const root = path.resolve(flags.root);
    const summary = await smokePreflight({
      root,
      plugin: path.resolve(flags.plugin ?? path.join(root, "examples", "plugins", "release")),
      sdk: path.resolve(flags.sdk ?? path.join(root, "packages", "sdk")),
      target: flags.target ?? "validator",
    });
    console.log(`preflight: ok, with no node on PATH (${process.execPath}): ${summary}`);
  });
}
