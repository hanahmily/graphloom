#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Prints, as a Markdown list, the test files that failed in the vitest JSON reports (--reporter=json) under a
// directory, each with up to three of its failing tests. CI's full-tier failure issue quotes it.
//
// Usage: scripts/ci/failed-files.mjs <reports-dir>

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (dir === undefined) {
  console.error("usage: failed-files.mjs <reports-dir>");
  process.exit(2);
}

/** The path relative to the repository checkout the report was written in. */
function repoRelative(file) {
  const cwd = `${process.cwd()}${path.sep}`;
  if (file.startsWith(cwd)) return file.slice(cwd.length);
  // A report from another checkout path: drop everything up to the workspace directories.
  const m = /(?:^|\/)((?:apps|packages|executors|examples|scripts)\/.*)$/.exec(file);
  return m ? m[1] : file;
}

let names = [];
try {
  names = readdirSync(dir, { recursive: true }).filter((name) => String(name).endsWith(".json"));
} catch {
  // No reports were downloaded: every failure was outside a test run (install, build, typecheck) or killed it.
}

const lines = [];
for (const name of names.map(String).sort()) {
  let report;
  try {
    report = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  } catch {
    lines.push(`- \`${name}\`: the report is not readable JSON (the run was likely cut short)`);
    continue;
  }
  for (const file of report.testResults ?? []) {
    if (file.status !== "failed") continue;
    const tests = (file.assertionResults ?? []).filter((t) => t.status === "failed").map((t) => t.fullName ?? t.title);
    const detail = tests.length > 0 ? `: ${tests.slice(0, 3).map((t) => JSON.stringify(t)).join(", ")}${tests.length > 3 ? `, and ${tests.length - 3} more` : ""}` : file.message ? `: ${String(file.message).split("\n")[0]}` : "";
    lines.push(`- \`${repoRelative(file.name)}\`${detail}`);
  }
}
console.log(lines.length > 0 ? lines.join("\n") : "- (no test report names a failing file; see the failing jobs)");
