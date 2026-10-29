// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Repair snapshots copy a bundle tree alone, so its tsconfig must not reach
// outside it, and a copy must still build with dependencies from the repo install.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const installRoot = path.dirname(path.dirname(require.resolve("vitest/package.json")));
const tscBin = require.resolve("typescript/bin/tsc");

const bundles = [
  "examples/plugins/hello",
  "examples/plugins/release",
  "examples/plugins/issue-fix",
  "examples/plugins/pr-review",
  "executors/coding-agent",
  "executors/command",
  "executors/github",
];

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"));
}

describe("bundle tsconfigs", () => {
  for (const bundle of bundles) {
    it(`${bundle} tsconfig is self-contained and agrees with the root base options`, async () => {
      const config = await readJson(path.join(repoRoot, bundle, "tsconfig.json"));
      expect(config.extends).toBeUndefined();
      const base = (await readJson(path.join(repoRoot, "tsconfig.base.json"))).compilerOptions;
      for (const key of ["target", "module", "moduleResolution", "strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes"]) {
        expect(config.compilerOptions[key], key).toEqual(base[key]);
      }
      for (const [key, value] of Object.entries(config.compilerOptions)) {
        if (key in base) expect(value, key).toEqual(base[key]);
      }
    });

    it(`${bundle} builds when copied alone into an isolated directory`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "gl-bundle-build-"));
      try {
        const depth = bundle.split("/").length;
        const copy = path.join(root, ...Array.from({ length: depth }, (_, i) => `d${i}`));
        await mkdir(copy, { recursive: true });
        await cp(path.join(repoRoot, bundle), copy, {
          recursive: true,
          filter: (src) => !["node_modules", "dist", ".git"].includes(path.basename(src)),
        });
        // Vendored libraries (dist/vendor, docs/design-supervisor-harnesses.md §3.2) are build inputs a repair snapshot carries.
        const vendored = path.join(repoRoot, bundle, "dist", "vendor");
        if (existsSync(vendored)) await cp(vendored, path.join(copy, "dist", "vendor"), { recursive: true });
        await symlink(installRoot, path.join(copy, "node_modules"), "dir");
        const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json"], { cwd: copy, encoding: "utf8" });
        expect(result.stdout + result.stderr).toBe("");
        expect(result.status).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
