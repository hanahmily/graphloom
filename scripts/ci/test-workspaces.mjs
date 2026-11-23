#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Runs `vitest run` in each workspace that has a test script, one workspace at a time, against the already built
// dist/ (CI's jobs build once; a workspace's own `npm test` also recompiles it first). Every workspace runs even when
// one fails; the exit status is 1 when any failed. With --report-dir, each workspace also writes vitest's JSON report
// there, which CI reads to name the failing files.
//
// Usage: scripts/ci/test-workspaces.mjs [--only <name>,...] [--exclude <name>,...] [--report-dir <dir>]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}
const list = (value) => (value === undefined ? undefined : value.split(",").map((s) => s.trim()).filter(Boolean));
const only = list(option("--only"));
const exclude = list(option("--exclude")) ?? [];
const reportDir = option("--report-dir");

/** @type {Array<{ name: string; location: string; scripts?: Record<string, string> }>} */
const workspaces = JSON.parse(execFileSync("npm", ["query", ".workspace", "--json"], { cwd: root, encoding: "utf8" }));
const known = new Set(workspaces.map((w) => w.name));
for (const name of [...(only ?? []), ...exclude]) {
  if (!known.has(name)) {
    console.error(`test-workspaces: no workspace named ${name}`);
    process.exit(2);
  }
}
const selected = workspaces.filter((w) => w.scripts?.test !== undefined && (only === undefined || only.includes(w.name)) && !exclude.includes(w.name));

if (reportDir !== undefined) mkdirSync(reportDir, { recursive: true });
const failed = [];
for (const w of selected) {
  console.log(`\n> ${w.name}: vitest run`);
  const args = ["vitest", "run"];
  if (reportDir !== undefined) {
    args.push("--reporter=default", "--reporter=json", `--outputFile.json=${path.resolve(reportDir, `${w.name.replace(/[@/]/g, "_")}.json`)}`);
  }
  const result = spawnSync("npx", args, { cwd: path.join(root, w.location), stdio: "inherit" });
  if (result.status !== 0) failed.push(w.name);
}
if (failed.length > 0) {
  console.error(`\ntest-workspaces: failed in ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\ntest-workspaces: ${selected.length} workspaces passed`);
