// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Shared vitest globalSetup for every workspace.
//
// Routes every temp dir the suite (and the code under test) creates through
// os.tmpdir() into one per-run root by pointing TMPDIR at it, then removes that
// root in teardown. Individual tests need no cleanup code and cannot leak into
// the real temp dir, including dirs created by child processes and the code
// under test. Teardown also verifies nothing escaped: any gl-* entry that
// appeared in the real temp dir during the run (and was absent before it) fails
// the run. Set GRAPHLOOM_TMP_GUARD=warn to report instead of failing.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let realTmp;
let runRoot;
let previousTmpdir;
let before;
let startedAt;

function glEntries(dir) {
  try {
    return readdirSync(dir).filter((name) => name.startsWith("gl-"));
  } catch {
    return [];
  }
}

export function setup() {
  realTmp = tmpdir();
  before = new Set(glEntries(realTmp));
  startedAt = Date.now();
  mkdirSync(realTmp, { recursive: true });
  runRoot = mkdtempSync(path.join(realTmp, "graphloom-test-run-"));
  previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = runRoot;
}

export function teardown() {
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
  rmSync(runRoot, { recursive: true, force: true, maxRetries: 3 });

  const leaked = glEntries(realTmp).filter((name) => {
    if (before.has(name)) return false;
    try {
      return statSync(path.join(realTmp, name)).mtimeMs >= startedAt - 1000;
    } catch {
      return false;
    }
  });
  if (leaked.length === 0) return;
  const message = `${leaked.length} gl-* temp entr${leaked.length === 1 ? "y" : "ies"} appeared in ${realTmp} during this run (e.g. ${leaked.slice(0, 3).join(", ")}); the suite is bypassing TMPDIR or another process created them.`;
  if (process.env.GRAPHLOOM_TMP_GUARD === "warn") console.warn(message);
  else throw new Error(message);
}
