/**
 * A regression runner: the code that runs exactly one named regression test
 * and reads its report. Runners are the part of a repository profile that
 * cannot be data; a profile selects one by name (`regression.runner`).
 */

/**
 * What a runner's report says about the regression test:
 * - `failed`: the test ran and failed by assertion, not by a build error or a crash;
 * - `panicked`: the test ran and crashed (a Go panic, a non-assertion exception), so it proves nothing about the behaviour it asserts;
 * - `passed`: the test ran and passed;
 * - `build-failed`: the test could not be built or loaded, so it never ran;
 * - `not-run`: the report has no result for the test.
 */
export type TestOutcome = "failed" | "panicked" | "passed" | "build-failed" | "not-run";

/** `setup-failed`: the test failed outside its own body, in a hook or suite setup. */
export type RegressionOutcome = TestOutcome | "setup-failed";

/** The decision record's `test`: where the test lives, its name, and (for Ginkgo) the spec to focus. */
export interface RegressionTestRef {
  package: string;
  name: string;
  focus?: string;
}

export type RunnerId = "go-test" | "vitest";

export interface RegressionRunner {
  readonly id: RunnerId;
  /** How the planner fills `test.package`, `test.name` and `test.focus`, for the plan prompt. */
  readonly testFieldHelp: string;
  /** How RED's report shows an assertion failure, for the `reproduces` requirement statement. */
  readonly reproducesEvidence: string;
  /** The argv that runs exactly the regression test and writes its report to `$GRAPHLOOM_REPORT_FILE`. */
  argv(test: RegressionTestRef): string[];
  /** What the report says about the test. */
  outcome(report: string, test: RegressionTestRef): RegressionOutcome;
  /** The report's own error messages, such as a compile or load error, for a correction. */
  reportOutput(report: string): string;
  /** Why a planned test cannot be run by this runner; empty when it can. */
  testProblems(test: { package?: unknown; name?: unknown; focus?: unknown }, isTestPath: (path: string) => boolean): string[];
  /** The test as messages name it. */
  label(test: RegressionTestRef): string;
  /** Finer-grained tests (such as Ginkgo specs) that failed in RED but did not pass in GREEN; empty when the runner has none. */
  missingOnGreen(redReport: string | undefined, greenReport: string): string[];
}
