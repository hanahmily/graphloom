import { copyFile, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfigFromFile } from "vite";

const bundleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoNodeModules = path.resolve(bundleRoot, "../../../node_modules");

async function loadGlobalSetup(dir: string): Promise<unknown> {
  const loaded = await loadConfigFromFile({ command: "serve", mode: "test" }, path.join(dir, "vitest.config.ts"), dir);
  return (loaded?.config as { test?: { globalSetup?: unknown } }).test?.globalSetup;
}

describe("bundle vitest config", () => {
  it("uses the repo-root global setup when present", async () => {
    expect(await loadGlobalSetup(bundleRoot)).toHaveLength(1);
  });

  it("loads without the repo-root file when the bundle is copied alone", async () => {
    // Repair qualification copies only the bundle tree, so ../../../vitest.global-setup.mjs is absent.
    const root = await mkdtemp(path.join(tmpdir(), "gl-bundle-config-"));
    const copy = path.join(root, "a", "b", "bundle");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(copy, { recursive: true });
    await symlink(repoNodeModules, path.join(copy, "node_modules"), "dir");
    await copyFile(path.join(bundleRoot, "vitest.config.ts"), path.join(copy, "vitest.config.ts"));
    expect(await loadGlobalSetup(copy)).toEqual([]);
  });
});
