#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Qualifies a repair candidate's built validators against this copy's cases,
 * and requires this copy's own validators to reproduce the defect. Run it from
 * the installed plugin, never from the candidate, so a patch cannot weaken the
 * cases that judge it:
 * `node <installed>/scripts/qualify.mjs <candidateRoot>`
 * Exits 0 when the candidate qualifies, 1 when it does not.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const candidateRoot = process.argv[2];
if (!candidateRoot) {
  console.error("usage: qualify.mjs <candidateRoot>");
  process.exit(2);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const load = (dir, module) => import(pathToFileURL(path.join(path.resolve(dir), "dist", module)).href);

const { qualifyValidators } = await load(root, "qualification.js");
const baseline = await load(root, "validators.js");
const candidate = await load(candidateRoot, "validators.js");
const report = qualifyValidators(candidate.validatorById, baseline.validatorById);
console.log(report.summary);
process.exit(report.ok ? 0 : 1);
