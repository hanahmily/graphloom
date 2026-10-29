// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { copyFile, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

// Repair qualification copies a bundle tree alone and runs `npm test` there, so
// bundle vitest configs must not depend on the repo-root global setup file.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const installRoot = path.dirname(path.dirname(require.resolve("vitest/package.json")));

const bundles = [
  "examples/plugins/hello",
  "examples/plugins/release",
  "examples/plugins/issue-fix",
  "examples/plugins/pr-review",
  "executors/coding-agent",
  "executors/command",
  "executors/github",
];

async function globalSetupOf(dir: string): Promise<unknown> {
  const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, path.join(dir, "vitest.config.ts"), dir);
  return (loaded?.config as { test?: { globalSetup?: unknown } }).test?.globalSetup;
}

describe("bundle vitest configs", () => {
  for (const bundle of bundles) {
    it(`${bundle} uses the repo-root setup in place and loads without it when copied`, async () => {
      expect(await globalSetupOf(path.join(repoRoot, bundle))).toHaveLength(1);

      const root = await mkdtemp(path.join(tmpdir(), "gl-bundle-config-"));
      const depth = bundle.split("/").length;
      const copy = path.join(root, ...Array.from({ length: depth }, (_, i) => `d${i}`));
      await mkdir(copy, { recursive: true });
      await symlink(installRoot, path.join(copy, "node_modules"), "dir");
      await copyFile(path.join(repoRoot, bundle, "vitest.config.ts"), path.join(copy, "vitest.config.ts"));
      expect(await globalSetupOf(copy)).toEqual([]);
    });
  }
});
