// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimePackageDirs } from "../src/graph.js";

// A release install: the plugin sits under the operator's home and `typescript` only in the install root's node_modules.
let home: string;
let plugin: string;
let tsDir: string;

beforeAll(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "prr-home-")));
  const install = path.join(home, ".local", "share", "graphloom", "versions", "0.1.1");
  plugin = path.join(install, "examples", "plugins", "pr-review");
  tsDir = path.join(install, "node_modules", "typescript");
  mkdirSync(path.join(plugin, "dist", "metrics"), { recursive: true });
  mkdirSync(path.join(tsDir, "lib"), { recursive: true });
  writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ name: "pr-review", type: "module" }));
  writeFileSync(path.join(tsDir, "package.json"), JSON.stringify({ name: "typescript", main: "./lib/typescript.js" }));
  writeFileSync(path.join(tsDir, "lib", "typescript.js"), "module.exports = { version: 'fake' };\n");
  writeFileSync(path.join(plugin, "dist", "metrics", "probe.mjs"), 'import ts from "typescript"; console.log(ts.version);\n');
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("static metrics tools in a release layout", () => {
  it("binds the typescript package that lives in an ancestor node_modules of the plugin", () => {
    expect(runtimePackageDirs(plugin, ["typescript"])).toContain(tsDir);
  });

  it("adds nothing for a package that does not resolve", () => {
    expect(runtimePackageDirs(plugin, ["no-such-package-here"])).toEqual([]);
  });

  const bwrap = spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0;
  (bwrap ? it : it.skip)("resolves typescript inside bwrap with the home hidden, only with that bind", () => {
    const run = (binds: string[]) =>
      spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--tmpfs", home, ...binds.flatMap((b) => ["--ro-bind", b, b]), process.execPath, path.join(plugin, "dist", "metrics", "probe.mjs")], { encoding: "utf8" });
    const without = run([plugin]);
    expect(without.status).not.toBe(0);
    expect(without.stderr).toContain("ERR_MODULE_NOT_FOUND");
    const withIt = run([plugin, ...runtimePackageDirs(plugin, ["typescript"])]);
    expect(withIt.stderr).toBe("");
    expect(withIt.stdout.trim()).toBe("fake");
  });
});
