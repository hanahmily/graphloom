// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// vitest-summary.mjs <json> <run> <test file base name> <checkout root> <base64 of the test name>
// Reads the json reporter's output of one run of the scratch test and prints that run's lines of the graphloom-repro-v1
// report (`run`, `at`, `frame`, `message`; see repro.sh). Exactly one test of the given name must have run.
import { readFileSync } from "node:fs";

const [, , jsonPath, run, file, root, nameB64] = process.argv;
const name = Buffer.from(nameB64, "base64").toString("utf8");
const oneLine = (s, n) => s.replace(/\r?\n/g, "⏎").slice(0, n);
const out = (key, text) => console.log(`${key} ${run} ${text}`);

let report;
try {
  report = JSON.parse(readFileSync(jsonPath, "utf8"));
} catch {
  out("run", "killed");
  process.exit(0);
}
const tests = (report.testResults ?? []).flatMap((f) => f.assertionResults ?? []);
const mine = tests.filter((t) => t.title === name || t.fullName === name || (t.fullName ?? "").endsWith(` ${name}`));
if (mine.length !== 1 || tests.length !== 1) {
  out("run", "build-failed");
  const why = (report.testResults ?? []).map((f) => f.message).filter(Boolean).join(" ");
  out("message", oneLine(why !== "" ? why : `exactly the named test must run: ${tests.length} ran, ${mine.length} named ${name}`, 1000));
  process.exit(0);
}
const t = mine[0];
if (t.status !== "failed") {
  out("run", "passed");
  process.exit(0);
}
const msgs = t.failureMessages ?? [];
const first = msgs[0] ?? "";
if (/timed out/i.test(first)) {
  out("run", "timeout");
  process.exit(0);
}
out("run", "failed");
if (/AssertionError/.test(first)) {
  const m = new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(\\d+)`).exec(first);
  if (m !== null) out("at", `${file}:${m[1]}`);
}
for (const m of first.matchAll(/\(?((?:\/[^\s():]+)+):(\d+):\d+\)?/g)) {
  const p = m[1];
  if (p.startsWith(`${root}/`) && !p.includes("/node_modules/") && !p.endsWith(file)) out("frame", `${p.slice(root.length + 1)}:${m[2]}`);
}
out("message", oneLine(msgs.join("\n").split("\n").filter((l) => !/^\s+at /.test(l)).join("\n"), 2000));
