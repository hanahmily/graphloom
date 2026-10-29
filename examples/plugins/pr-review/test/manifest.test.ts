// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGraph, GRAPH_ID, GRAPH_VERSION } from "../src/index.js";
import { rehearsal } from "../src/rehearsal.js";
import { BANYANDB, root } from "./support.js";

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const list = (dir: string, prefix: string): string[] =>
  readdirSync(path.join(root, dir))
    .sort()
    .flatMap((name) => (statSync(path.join(root, dir, name)).isDirectory() ? list(`${dir}/${name}`, `${prefix}/${name}`) : [`${prefix}/${name}`]));

const manifest = JSON.parse(readFileSync(path.join(root, "graphloom.manifest.json"), "utf8")) as {
  graphId: string;
  version: string;
  taskConfig: string;
  entryPoints: Record<string, string>;
  repairContract: string;
  privateStateSchema: string;
  digests: { sourceTree: string; packageLock: string; files: Record<string, string> };
};

describe("graphloom.manifest.json", () => {
  it("names the graph, its version and its entry points, and needs a task config", () => {
    expect(manifest).toMatchObject({ graphId: GRAPH_ID, version: GRAPH_VERSION, taskConfig: "required", repairContract: "source-repairable", entryPoints: { createGraph: "./dist/index.js", rehearsal: "./dist/rehearsal.js" } });
    expect(manifest.privateStateSchema).toBe(createGraph().describe(BANYANDB).privateStateSchema);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version).toBe(GRAPH_VERSION);
  });

  it("is current: every pinned file's digest is its file's, and every file that should be pinned is (run `npm run manifest -w @graphloom/plugin-pr-review`)", () => {
    const expected = [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      ...list("profiles", "profiles"),
      ...list("scripts", "scripts").filter((p) => p !== "scripts/generate-manifest.mjs"),
      ...list("tools", "tools"),
      ...list("src", "src"),
      ...list("test", "test"),
    ];
    expect(Object.keys(manifest.digests.files)).toEqual(expected);
    const stale = expected.filter((rel) => manifest.digests.files[rel] !== sha256(path.join(root, rel)));
    expect(stale).toEqual([]);
    const tree = createHash("sha256");
    for (const rel of expected) tree.update(`${rel}\0${manifest.digests.files[rel]}\n`);
    expect(manifest.digests.sourceTree).toBe(tree.digest("hex"));
    expect(manifest.digests.packageLock).toBe(manifest.digests.files["package-lock.json"]);
  });

  it("ships the tools the graph runs from its own tree", () => {
    expect(Object.keys(manifest.digests.files)).toEqual(expect.arrayContaining(["tools/gometrics/main.go", "tools/gometrics/go.mod", "profiles/banyandb.json"]));
  });

  it("has a rehearsal entry whose scenarios the graph can describe", () => {
    expect(Object.keys(rehearsal(BANYANDB).scenarios)).toEqual(["happy", "report", "report-corrections", "injection", "complex-function", "sandbox-unavailable"]);
    expect(Object.keys(rehearsal({ not: "a profile" }).scenarios)).toEqual([]);
  });
});
