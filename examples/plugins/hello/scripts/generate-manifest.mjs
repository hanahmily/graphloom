#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Regenerates graphloom.manifest.json with source/lockfile digests for pinning.
 * Run after changing sources or the package lock: `npm run manifest -w @graphloom/plugin-hello`
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist" || name === "scripts") continue;
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFiles(full, rel));
    } else if (st.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

const sourceFiles = listFiles(path.join(root, "src")).map((f) => `src/${f}`);
const testFiles = listFiles(path.join(root, "test")).map((f) => `test/${f}`);
const pinnedFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ...sourceFiles,
  ...testFiles,
].filter((rel) => {
  try {
    return statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
});

const fileDigests = Object.fromEntries(
  pinnedFiles.map((rel) => [rel, sha256File(path.join(root, rel))]),
);

const sourceTreeHash = createHash("sha256");
for (const rel of pinnedFiles) {
  sourceTreeHash.update(rel);
  sourceTreeHash.update("\0");
  sourceTreeHash.update(fileDigests[rel]);
  sourceTreeHash.update("\n");
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const lockExists = pinnedFiles.includes("package-lock.json");

const manifest = {
  graphId: "hello",
  version: pkg.version,
  sdkProtocol: 1,
  entryPoints: {
    createGraph: "./dist/index.js",
    // docs/design-graph-rehearsal.md §4.4: declared only when the plugin ships one.
    ...(existsSync(path.join(root, "src", "rehearsal.ts")) ? { rehearsal: "./dist/rehearsal.js" } : {}),
  },
  privateStateSchema: "hello-private-v1",
  repairContract: "source-repairable",
  runtimeProfile: {
    node: pkg.engines?.node ?? ">=22",
    module: "nodenext",
    typescript: pkg.devDependencies?.typescript ?? "declared",
    vitest: pkg.devDependencies?.vitest ?? "declared",
  },
  digests: {
    sourceTree: sourceTreeHash.digest("hex"),
    packageLock: lockExists ? fileDigests["package-lock.json"] : null,
    files: fileDigests,
  },
  requirements: [
    {
      id: "greeting-bytes",
      statement:
        "GREETING.txt contains exactly the UTF-8 bytes Hello, GraphLoom!\\n and is the only changed path in the workspace (excluding Git metadata).",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: "independent-review",
      statement:
        "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  stages: [
    { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
    { id: "review", name: "Review", requirementIds: ["independent-review"] },
  ],
};

writeFileSync(
  path.join(root, "graphloom.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
console.log(`wrote graphloom.manifest.json (${pinnedFiles.length} pinned files)`);
