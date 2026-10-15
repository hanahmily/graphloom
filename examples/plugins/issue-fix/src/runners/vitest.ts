/**
 * The `vitest` regression runner: one test, by its full name, in one test
 * file, through vitest's JSON reporter. The report is reduced to one marker
 * line naming the test's result and its file's load error, so a large test
 * file's report still fits the command's report tail.
 */
import type { RegressionOutcome, RegressionRunner, RegressionTestRef } from "./types.js";

const MARKER = "GraphLoomVitest";

interface VitestSummary {
  files?: Array<{ name: string; status: string; message: string }>;
  tests?: Array<{ fullName: string; status: string; failure: string }>;
  missing?: boolean;
  unreadable?: boolean;
}

/** Reduces vitest's JSON report to the named test's results and each file's own error. */
const REDUCE = `const fs = require("node:fs");
const [, file, name] = process.argv;
const out = {};
try {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  out.files = (d.testResults || []).map((t) => ({ name: String(t.name || ""), status: String(t.status || ""), message: String(t.message || "").slice(0, 600) }));
  out.tests = [];
  for (const t of d.testResults || []) {
    for (const a of t.assertionResults || []) {
      if (a.fullName === name) out.tests.push({ fullName: a.fullName, status: String(a.status || ""), failure: String((a.failureMessages || [])[0] || "").slice(0, 600) });
    }
  }
} catch {
  out[fs.existsSync(file) ? "unreadable" : "missing"] = true;
}
process.stdout.write(JSON.stringify({ ${MARKER}: out }) + "\\n");
`;

/**
 * Finds the test file's package (the nearest directory with a package.json)
 * and the nearest installed vitest, runs only the named test there, and
 * reduces the report. Exits with vitest's own status.
 */
const SCRIPT = [
  'f="$1"; t="$2"; p="$3"',
  'case "$f" in /*|../*|*/../*) echo "$f is not a repository-relative path" >&2; exit 2;; esac',
  '[ -f "$f" ] || { echo "$f does not exist" >&2; exit 2; }',
  'd=$(dirname "$f"); while [ "$d" != "." ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done',
  's="$d"; bin=""',
  'while :; do if [ -x "$s/node_modules/.bin/vitest" ]; then bin="$(cd "$s" && pwd)/node_modules/.bin/vitest"; break; fi; [ "$s" = "." ] && break; s=$(dirname "$s"); done',
  '[ -n "$bin" ] || { echo "vitest is not installed: no node_modules/.bin/vitest at or above $d" >&2; exit 127; }',
  'if [ "$d" = "." ]; then rel="$f"; else rel="${f#"$d"/}"; fi',
  'r="$GRAPHLOOM_REPORT_FILE"',
  '(cd "$d" && "$bin" run "$rel" --testNamePattern "$p" --reporter=json --outputFile="$r.vitest")',
  "rc=$?",
  `node -e "$4" "$r.vitest" "$t" > "$r" || echo '{"${MARKER}":{"unreadable":true}}' > "$r"`,
  'rm -f "$r.vitest"',
  "exit $rc",
].join("\n");

/** `text` as a regular expression that matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The argv that runs exactly the named test in its file and writes the reduced report. */
export function vitestArgv(test: RegressionTestRef): string[] {
  return ["sh", "-c", SCRIPT, "regression", test.package, test.name, `^${escapeRegExp(test.name)}$`, REDUCE];
}

/** The reduced report, or undefined when the run wrote none. */
export function vitestSummary(report: string): VitestSummary | undefined {
  let found: VitestSummary | undefined;
  for (const line of report.split("\n")) {
    if (!line.startsWith(`{"${MARKER}"`)) continue;
    try {
      found = ((JSON.parse(line) as Record<string, VitestSummary>)[MARKER] ?? { unreadable: true });
    } catch {
      found = { unreadable: true };
    }
  }
  return found;
}

/**
 * Errors that mean the test could not be loaded or referred to code the
 * checkout does not have: the TypeScript analogue of a Go build failure.
 */
const LOAD_ERROR = /is not a function|is not defined|is not a constructor|does not provide an export named|Cannot find module|Cannot find package|Failed to load|Failed to resolve import|SyntaxError/;

function failureOutcome(failure: string): RegressionOutcome {
  const first = failure.split("\n")[0] ?? "";
  if (/^AssertionError\b/.test(first)) return "failed";
  if (LOAD_ERROR.test(first)) return "build-failed";
  return "panicked";
}

export function vitestOutcome(report: string, test: RegressionTestRef): RegressionOutcome {
  const summary = vitestSummary(report);
  if (summary === undefined || summary.missing === true || summary.unreadable === true) return "not-run";
  const tests = summary.tests ?? [];
  const failed = tests.find((t) => t.status === "failed");
  if (failed !== undefined) return failureOutcome(failed.failure);
  if (tests.some((t) => t.status === "passed")) return "passed";
  const message = (summary.files ?? []).map((f) => f.message).find((m) => m.trim() !== "");
  if (message !== undefined) return LOAD_ERROR.test(message) ? "build-failed" : "setup-failed";
  void test;
  return "not-run";
}

/** The file errors and the test's failures, first lines only. */
export function vitestOutput(report: string): string {
  const summary = vitestSummary(report);
  if (summary === undefined) return "";
  return [
    ...(summary.files ?? []).filter((f) => f.message.trim() !== "").map((f) => `${f.name}: ${f.message.trim()}`),
    ...(summary.tests ?? []).filter((t) => t.failure.trim() !== "").map((t) => `${t.fullName}: ${t.failure.split("\n")[0]}`),
  ].join("\n");
}

const SOURCE = /\.[cm]?[jt]sx?$/;

export const vitestRunner: RegressionRunner = {
  id: "vitest",
  testFieldHelp:
    "package is the test file, relative to the repository root (packages/sdk/src/scope.test.ts); name is the test's full name as vitest reports it, its describe titles and its own title joined by single spaces; omit focus",
  reproducesEvidence: "vitest's JSON report shows it failed with an assertion error, and its file loaded",
  argv: vitestArgv,
  outcome: vitestOutcome,
  reportOutput: vitestOutput,
  testProblems(test, isTestPath) {
    const problems: string[] = [];
    const file = test.package;
    const parts = typeof file === "string" ? file.split("/") : [];
    if (
      typeof file !== "string" ||
      file.startsWith("/") ||
      file.includes("\\") ||
      parts.some((s) => s === "" || s === "." || s === "..") ||
      !SOURCE.test(file) ||
      !isTestPath(file)
    ) {
      problems.push(`test file ${JSON.stringify(file)} is not a repository-relative test file`);
    }
    if (typeof test.name !== "string" || test.name.trim() === "" || test.name !== test.name.trim() || /[\r\n]/.test(test.name)) {
      problems.push(`test name ${JSON.stringify(test.name)} is not a test's full name (its describe titles and its own title, joined by single spaces)`);
    }
    if (test.focus !== undefined) problems.push("vitest selects a test by its full name alone; leave focus out");
    return problems;
  },
  label: (test) => `"${test.name}"`,
  missingOnGreen: () => [],
};
