/**
 * The `vitest` regression runner: one test, by its full name, in one test
 * file, through a small vitest reporter the command installs for the run.
 * The reporter writes one marker line naming the test's result, whether a
 * hook or an enclosing suite or file failed around it, and the file's own
 * load error, so a large test file's report still fits the command's report
 * tail. vitest's JSON reporter cannot be used: it reports a test whose
 * `beforeEach` failed as an assertion failure of the test, and drops an
 * `afterAll` failure entirely.
 */
import type { RegressionOutcome, RegressionRunner, RegressionTestRef } from "./types.js";

const MARKER = "GraphLoomVitest";

interface VitestTestResult {
  fullName: string;
  /** `passed`, `failed`, or vitest's own state (`skip`, `todo`, …). */
  status: string;
  /** The first error, as `Name: message`. */
  failure: string;
  /** A `beforeEach` or `afterEach` hook of this test did not pass: its body may never have run. */
  hook?: boolean;
  /** Errors and failed hooks of the suites and file around the test. */
  scope?: string[];
}

interface VitestSummary {
  /** The test the run was asked for: its repository-relative file and full name. */
  target?: { file: string; name: string };
  files?: Array<{ name: string; status: string; message: string }>;
  tests?: VitestTestResult[];
  /** Errors vitest caught outside any test, such as an unhandled rejection. */
  unhandled?: string[];
  missing?: boolean;
  unreadable?: boolean;
}

/**
 * The reporter. vitest leaves a hook's state at `run` when the hook throws
 * (it sets `pass` only when the hook returns), so any hook state other than
 * `pass` is a failed hook. Only the file whose real path is the target's
 * counts: vitest's file argument is a substring filter, so other files ending
 * the same way may run too. It also writes the run's own status, `0` only
 * when the test passed with nothing around it failing, `1` when it did not,
 * `3` when the report has no result for it.
 */
const REPORTER = `import fs from "node:fs";
const env = process.env;
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
const text = (e) => (e && typeof e === "object" ? (e.name ? String(e.name) : "Error") + ": " + String(e.message ?? "") : String(e)).slice(0, 600);
const failedHooks = (r) => Object.entries((r && r.hooks) || {}).filter(([, s]) => s !== "pass").map(([h]) => h);
export default class GraphLoomRegressionReporter {
  // vitest 5 calls only onTestRunEnd (its test modules carry the raw file task); vitest 3 and 4 call onFinished too.
  onTestRunEnd(modules = [], errors = []) {
    this.onFinished(modules.map((m) => m.task ?? m), errors);
  }
  onFinished(files = [], errors = []) {
    const want = real(env.GRAPHLOOM_VITEST_TARGET);
    const name = env.GRAPHLOOM_VITEST_NAME;
    const out = { target: { file: env.GRAPHLOOM_VITEST_FILE, name }, files: [], tests: [] };
    const around = (task, label) => {
      const r = task.result || {};
      return [...(r.errors || []).map(text), ...failedHooks(r).map((h) => "a " + h + " hook of " + label + " failed")];
    };
    const walk = (task, titles, scope) => {
      for (const t of task.tasks || []) {
        if (t.type === "suite") {
          walk(t, [...titles, t.name], [...scope, ...around(t, JSON.stringify(t.name))]);
        } else if ([...titles, t.name].join(" ") === name) {
          const r = t.result || {};
          out.tests.push({
            fullName: name,
            status: r.state === "pass" ? "passed" : r.state === "fail" ? "failed" : String(r.state || t.mode || ""),
            failure: (r.errors || []).map(text)[0] || "",
            hook: failedHooks(r).length > 0,
            scope,
          });
        }
      }
    };
    for (const f of files) {
      if (real(f.filepath) !== want) continue;
      out.files.push({ name: String(f.filepath), status: String((f.result && f.result.state) || ""), message: ((f.result && f.result.errors) || []).map(text).join("\\n").slice(0, 600) });
      walk(f, [], failedHooks(f.result).map((h) => "a file-level " + h + " hook failed"));
    }
    if (errors.length > 0) out.unhandled = errors.slice(0, 5).map(text);
    const clean = (t) => !t.hook && t.scope.length === 0;
    const passed = out.tests.length > 0 && out.tests.every((t) => t.status === "passed" && clean(t)) && !out.unhandled && out.files.every((f) => f.message === "");
    fs.writeFileSync(env.GRAPHLOOM_REPORT_FILE, JSON.stringify({ ${MARKER}: out }) + "\\n");
    fs.writeFileSync(env.GRAPHLOOM_REPORT_FILE + ".status", passed ? "0" : out.tests.length > 0 ? "1" : "3");
  }
}
`;

/**
 * Runs with NODE_ENV=test whatever the caller's is: vitest only defaults it, and a
 * production NODE_ENV (as a deployed agent shell often has) makes React load its production
 * build, which has no `act`, so every component test fails in setup.
 *
 * Finds the test file's package (the nearest directory with a package.json)
 * and the nearest installed vitest, and runs only the named test there with
 * the reporter above. Exits with the target test's own status, not vitest's:
 * other files vitest's filter selected cannot pass or fail it.
 */
const SCRIPT = [
  'f="$1"; t="$2"; p="$3"',
  'case "$f" in /*|../*|*/../*) echo "$f is not a repository-relative path" >&2; exit 2;; esac',
  '[ -f "$f" ] || { echo "$f does not exist" >&2; exit 2; }',
  'd=$(dirname "$f"); while [ "$d" != "." ] && [ ! -f "$d/package.json" ]; do d=$(dirname "$d"); done',
  's="$d"; bin=""',
  'while :; do if [ -x "$s/node_modules/.bin/vitest" ]; then bin="$(cd "$s" && pwd)/node_modules/.bin/vitest"; break; fi; [ "$s" = "." ] && break; s=$(dirname "$s"); done',
  '[ -n "$bin" ] || { echo "vitest is not installed: no node_modules/.bin/vitest at or above $d" >&2; exit 127; }',
  'a="$(cd "$(dirname "$f")" && pwd -P)/$(basename "$f")"',
  'r="$GRAPHLOOM_REPORT_FILE"; rm -f "$r" "$r.status"',
  'tmp="$(mktemp -d)"; printf \'%s\' "$4" > "$tmp/graphloom-regression-reporter.mjs"',
  '(cd "$d" && NODE_ENV=test GRAPHLOOM_VITEST_TARGET="$a" GRAPHLOOM_VITEST_NAME="$t" GRAPHLOOM_VITEST_FILE="$f" "$bin" run "$a" --testNamePattern "$p" --reporter="$tmp/graphloom-regression-reporter.mjs")',
  "rc=$?",
  'rm -rf "$tmp"',
  `[ -s "$r" ] || echo '{"${MARKER}":{"missing":true}}' > "$r"`,
  'n="$(cat "$r.status" 2>/dev/null)"; rm -f "$r.status"',
  'case "$n" in 0|1) exit "$n" ;; esac',
  // No result for the target: never a success, whatever else ran.
  '[ "$rc" -eq 0 ] && exit 1',
  "exit $rc",
].join("\n");

/** `text` as a regular expression that matches it literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `--testNamePattern` matches a test's titles joined by a space in vitest 3 and by " > " in vitest 5,
 * so each space of the name matches either: the name's own spaces and the join are not told apart.
 * The reporter compares the title path itself, so a looser pattern can only run extra tests, never
 * report one as the target.
 */
export function namePattern(name: string): string {
  return `^${escapeRegExp(name).replace(/ /g, "(?: > | )")}$`;
}

/** The argv that runs exactly the named test in its file and writes the reduced report. */
export function vitestArgv(test: RegressionTestRef): string[] {
  return ["sh", "-c", SCRIPT, "regression", test.package, test.name, namePattern(test.name), REPORTER];
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
  // A report of another test, such as one recorded before the record renamed it, says nothing about this one.
  if (summary.target?.file !== test.package || summary.target.name !== test.name) return "not-run";
  const tests = (summary.tests ?? []).filter((t) => t.fullName === test.name);
  // A failed hook, suite or file around the test: its result proves nothing either way.
  const disturbed = tests.some((t) => t.hook === true || (t.scope ?? []).length > 0) || (summary.unhandled ?? []).length > 0;
  if (disturbed && tests.some((t) => t.status === "failed" || t.status === "passed")) return "setup-failed";
  const failed = tests.find((t) => t.status === "failed");
  if (failed !== undefined) return failureOutcome(failed.failure);
  const message = (summary.files ?? []).map((f) => f.message).find((m) => m.trim() !== "");
  if (message !== undefined) return LOAD_ERROR.test(message) ? "build-failed" : "setup-failed";
  if (tests.some((t) => t.status === "passed")) return "passed";
  return "not-run";
}

/** The file errors, the test's failures, and failures around it, first lines only. */
export function vitestOutput(report: string): string {
  const summary = vitestSummary(report);
  if (summary === undefined) return "";
  return [
    ...(summary.files ?? []).filter((f) => f.message.trim() !== "").map((f) => `${f.name}: ${f.message.trim()}`),
    ...(summary.tests ?? []).filter((t) => t.failure.trim() !== "").map((t) => `${t.fullName}${t.hook === true ? " (in a hook)" : ""}: ${t.failure.split("\n")[0]}`),
    ...[...new Set((summary.tests ?? []).flatMap((t) => t.scope ?? []))].map((s) => `around the test: ${s.split("\n")[0]}`),
    ...(summary.unhandled ?? []).map((u) => `unhandled: ${u.split("\n")[0]}`),
  ].join("\n");
}

const SOURCE = /\.[cm]?[jt]sx?$/;

export const vitestRunner: RegressionRunner = {
  id: "vitest",
  testFieldHelp:
    "package is the test file, relative to the repository root (packages/sdk/src/scope.test.ts); name is the test's full name as vitest reports it, its describe titles and its own title joined by single spaces; omit focus",
  reproducesEvidence: "vitest reports it failed with an assertion error in its own body, its file loaded, and no hook, suite or file around it failed",
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
