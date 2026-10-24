import { readFileSync } from "node:fs";
import type { EvidenceRecord, ValidationStatus, Validator } from "@graphloom/sdk";
import { CODING_AGENT, COMMAND, FIX_STAGE, REVIEW_STAGE } from "./constants.js";
import type { DecisionRecord } from "./decision-record.js";
import { definitionFor } from "./graph.js";
import { parseProfile } from "./profile.js";
import { goTestRunner } from "./runners/go-test.js";
import { vitestRunner } from "./runners/vitest.js";

/** A profile shipped in the bundle's `profiles/` directory, as JSON: the cases judge against these exact files. */
export function shippedProfile(name: "banyandb" | "graphloom" | "canopy"): unknown {
  return JSON.parse(readFileSync(new URL(`../profiles/${name}.json`, import.meta.url), "utf8")) as unknown;
}

const BANYANDB = shippedProfile("banyandb");
const GRAPHLOOM = shippedProfile("graphloom");
const CHANGES_PATH = "CHANGES.md";
/** The banyandb profile's own command ids. */
const BYDB = { testCi: "test-ci", build: "build", lint: "lint", check: "check" } as const;

/** One expected outcome, derived from a requirement statement rather than from any validator's code. */
export interface QualificationCase {
  validatorId: string;
  name: string;
  /** The profile the case judges against, as the task's config carries it. */
  config: unknown;
  evidence: EvidenceRecord[];
  /** Earlier generations' evidence, as the controller passes it. */
  history?: EvidenceRecord[];
  expected: ValidationStatus;
}

export interface QualificationReport {
  ok: boolean;
  summary: string;
  candidateMismatches: string[];
  baselineMismatches: string[];
}

type ValidatorLookup = (validatorId: string) => Validator | undefined;

/** The live change every case is judged against. */
const DIGEST = "qualify-digest";
const OTHER = "qualify-stale-digest";
const TEST = "TestSchedulerReportsLongActions";

let seq = 0;
const ref = () => `qualify-${++seq}`;

const READY: DecisionRecord = {
  status: "ready",
  summary: "Warn while a scheduled action is still running instead of reporting a timeout.",
  test: { package: "./pkg/timestamp", name: TEST, expectedValueSource: "the issue's expected behaviour section" },
  productionCaller: "pkg/timestamp.Scheduler.trigger",
  decisions: [
    { point: "What happens at the timeout", tier: "behaviour", options: ["cancel", "warn and wait"], chosen: "warn and wait", basis: "the issue: it should not be reported as an error" },
    { point: "Keep counting TotalTasksTimeout", tier: "product", options: ["keep", "stop"], basis: "changes what the metric means" },
  ],
  openQuestions: ["Should TotalTasksTimeout keep counting actions that are still running?"],
};

const implementer = (record: unknown): EvidenceRecord => ({
  ref: ref(),
  kind: "other",
  candidateDigest: DIGEST,
  payload: {
    codingAgent: { harness: "claude-code", status: "completed", output: record },
    producer: { operationId: "op-implement", stageId: FIX_STAGE, purpose: "work", readOnly: false, kind: "agent", executorId: CODING_AGENT.id },
  },
});

interface RunOptions {
  from?: "base" | "candidate";
  paths?: string[];
  mutations?: string[];
  prepared?: boolean;
  op?: string;
  report?: string;
  stdout?: string;
  digest?: string;
  stageId?: string;
  purpose?: string;
  timedOut?: boolean;
  reverted?: boolean;
  revertedPaths?: string[];
  /** The argv the run executed; a regression run defaults to the one for the case's recorded test. */
  argv?: string[];
}

const command = (id: string, exitCode: number, o: RunOptions = {}): EvidenceRecord => ({
  ref: ref(),
  kind: "command",
  candidateDigest: o.digest ?? DIGEST,
  payload: {
    command: {
      id,
      argv: o.argv ?? [id],
      exitCode,
      signal: null,
      timedOut: o.timedOut ?? false,
      aborted: false,
      durationMs: 1,
      stdoutTail: o.stdout ?? "",
      stderrTail: "",
      ...(o.report !== undefined ? { report: { text: o.report, truncated: false } } : {}),
    },
    checkout: {
      from: o.from ?? "candidate",
      base: "base-commit",
      commit: `${o.from ?? "candidate"}-commit`,
      paths: o.paths ?? ["CHANGES.md", "pkg/timestamp/scheduler.go", "pkg/timestamp/scheduler_test.go"],
      prepared: o.prepared ?? true,
      mutations: o.mutations ?? [],
      phase: "run",
      ...(o.reverted ? { reverted: true, revertedPaths: o.revertedPaths ?? [] } : {}),
    },
    producer: { operationId: o.op ?? `op-${o.from ?? "candidate"}`, stageId: o.stageId ?? FIX_STAGE, purpose: o.purpose ?? "check", readOnly: true, kind: "command" },
  },
});

const events = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");
const failedByAssertion = events(
  { Action: "run", Test: TEST },
  { Action: "output", Test: TEST, Output: "scheduler_test.go:42: expected no timeout error\n" },
  { Action: "fail", Test: TEST },
  { Action: "fail", Package: "p" },
);
const passedReport = events({ Action: "run", Test: TEST }, { Action: "pass", Test: TEST }, { Action: "pass", Package: "p" });
const panicked = events(
  { Action: "run", Test: TEST },
  { Action: "output", Test: TEST, Output: "panic: runtime error: invalid memory address or nil pointer dereference [recovered]\n" },
  { Action: "fail", Test: TEST },
  { Action: "fail", Package: "p" },
);
const buildFailed = events({ ImportPath: "p [p.test]", Action: "build-fail" }, { Action: "fail", Package: "p", Output: "FAIL p [build failed]\n" });

const SUITE_READY: DecisionRecord = { ...READY, test: { ...READY.test!, focus: "scheduler warns while an action runs" } };
const spec = (text: string, state: string, node = "It", failureNode = state === "passed" ? "" : node) => ({ text, node, state, failureNode, message: "" });
/** A suite's go test -json report followed by the line naming the Ginkgo specs that ran. */
const suite = (report: string, specs: Array<ReturnType<typeof spec>>) => `${report}\n${JSON.stringify({ GraphLoomGinkgo: { specs } })}`;
const FOCUSED = "scheduler warns while an action runs";

const red = (report: string, exitCode = 1, o: RunOptions = {}) =>
  command(COMMAND.regression, exitCode, { from: "base", paths: ["pkg/timestamp/scheduler_test.go"], report, ...o });
/** RED retried against the candidate with the implementer's own patch undoing the behavioral fix. */
const redReverted = (report: string, exitCode = 1, o: RunOptions = {}) =>
  command(COMMAND.regression, exitCode, { from: "candidate", reverted: true, revertedPaths: ["pkg/timestamp/scheduler.go"], report, ...o });
const green = (report = passedReport, exitCode = 0, o: RunOptions = {}) => command(COMMAND.regression, exitCode, { report, ...o });
const candidate = (overrides: Partial<Record<string, number>> = {}, o: RunOptions = {}): EvidenceRecord[] => [
  green(passedReport, overrides[COMMAND.regression] ?? 0, o),
  ...[BYDB.testCi, BYDB.build, BYDB.lint, BYDB.check].map((id) => command(id, overrides[id] ?? 0, o)),
];

const CHANGES = "# Changes by Version\n\nRelease Notes.\n\n## 0.12.0\n\n### Bug Fixes\n\n- Warn instead of reporting a timeout for long scheduled actions.\n\n## 0.11.0\n\n- Older.\n";
const file = (bytes: string, digest = DIGEST): EvidenceRecord => ({ ref: ref(), kind: "file", candidateDigest: digest, payload: { path: CHANGES_PATH, bytes }, fingerprint: `fp-${seq}` });
const diff = (added: string): EvidenceRecord => command(COMMAND.changesDiff, 0, { stdout: `diff --git a/CHANGES.md b/CHANGES.md\n+++ b/CHANGES.md\n@@ -9,0 +10 @@\n+${added}\n` });

const comment = (severity: string | undefined) => ({
  path: "pkg/timestamp/scheduler.go",
  start_line: 10,
  end_line: 12,
  category: "bug",
  ...(severity !== undefined ? { severity } : {}),
  content: "Close waits for an action that ignores cancellation.",
});
/** The code reviewer's structured result. */
const reviewed = (comments: object[], summary: object = { total_files: 3, reviewed_files: 3, skipped: [] }, prior: Record<string, string> = {}) => ({
  comments,
  prior: Object.entries(prior).map(([finding, status]) => ({ finding, status, reason: status })),
  summary,
});
interface CodeReviewOptions {
  status?: string;
  readOnly?: boolean;
  digest?: string;
}
const codeReviewRun = (output: unknown, o: CodeReviewOptions = {}): EvidenceRecord => ({
  ref: ref(),
  kind: "other",
  candidateDigest: o.digest ?? DIGEST,
  payload: {
    codingAgent: { harness: "codex", status: o.status ?? "completed", output },
    producer: { operationId: "op-code-review", stageId: REVIEW_STAGE, purpose: "review", readOnly: o.readOnly ?? true, kind: "agent", executorId: CODING_AGENT.id },
  },
});
const SCHEDULER_PATH = "pkg/timestamp/scheduler.go";
const SCHEDULER = "package timestamp\n\nfunc (s *Scheduler) Close() {\n\tctx, done := context.WithTimeout(context.Background(), s.closeTimeout)\n\tdefer done()\n\ts.wait(ctx)\n}\n";
const BOUNDED = { path: SCHEDULER_PATH, line: 4, text: "ctx, done := context.WithTimeout(context.Background(), s.closeTimeout)" };
/** The verifier's verdict on F1. */
const verification = (verdict: string, quotes: object[] = [], digest = DIGEST): EvidenceRecord => ({
  ref: ref(),
  kind: "other",
  candidateDigest: digest,
  payload: {
    codingAgent: { harness: "claude-code", status: "completed", output: { verdicts: [{ finding: "F1", verdict, reason: `${verdict} by the verifier`, quotes }] } },
    producer: { operationId: "op-verify", stageId: REVIEW_STAGE, purpose: "diagnostic", readOnly: true, kind: "agent", executorId: CODING_AGENT.id },
  },
});
const confirmed = (digest = DIGEST) => verification("confirmed", [{ path: SCHEDULER_PATH, line: 6, text: "s.wait(ctx)" }], digest);
const refuted = (quotes: object[] = [BOUNDED]) => verification("refuted", quotes);
const scheduler = (bytes = SCHEDULER, digest = DIGEST): EvidenceRecord => ({ ref: ref(), kind: "file", candidateDigest: digest, payload: { path: SCHEDULER_PATH, bytes }, fingerprint: `fp-${seq}` });
/** F1, raised and confirmed on an earlier change in an earlier generation. */
const confirmedEarlier = () => [codeReviewRun(reviewed([comment("high")]), { digest: OTHER }), confirmed(OTHER)];
/** Clean review rounds on `n` earlier changes. */
const earlierRounds = (n: number) => Array.from({ length: n }, (_, i) => codeReviewRun(reviewed([]), { digest: `${OTHER}-${i + 1}` }));

const c = (validatorId: string, name: string, evidence: EvidenceRecord[], expected: ValidationStatus, history?: EvidenceRecord[], config: unknown = BANYANDB): QualificationCase => ({
  validatorId,
  name,
  config,
  evidence: withRegressionArgv(evidence, config),
  expected,
  ...(history !== undefined ? { history } : {}),
});

/**
 * A regression run names its test only in its argv: give each regression run
 * without an explicit argv the one the profile's runner builds for the
 * case's recorded test, as a real check job would have run.
 */
function withRegressionArgv(evidence: EvidenceRecord[], config: unknown): EvidenceRecord[] {
  const record = [...evidence].reverse().find((e) => (e.payload as { producer?: { purpose?: string } } | undefined)?.producer?.purpose === "work");
  const test = (record?.payload as { codingAgent?: { output?: DecisionRecord } } | undefined)?.codingAgent?.output?.test;
  if (test === undefined) return evidence;
  const argv = parseProfile(config).runner.argv(test);
  return evidence.map((e) => {
    const command = (e.payload as { command?: { id?: string; argv?: string[] } } | undefined)?.command;
    if (command?.id !== COMMAND.regression || command.argv?.length !== 1 || command.argv[0] !== COMMAND.regression) return e;
    return { ...e, payload: { ...(e.payload as object), command: { ...command, argv } } };
  });
}

// The graphloom profile: the vitest runner, npm build checks, no changelog.
const TS_TEST = "packages/sdk/src/scope.test.ts";
const TS_SOURCE = "packages/sdk/src/scope.ts";
const TS_NAME = "writeScopeAllows forbids a path below an excluded directory";
const TS_READY: DecisionRecord = {
  ...READY,
  test: { package: TS_TEST, name: TS_NAME, expectedValueSource: "the issue: an excluded directory covers everything below it" },
  productionCaller: "packages/sdk/src/scope.ts writeScopeAllows",
};
/** vitest's report as the runner reduces it: the named test's results and each file's own error. */
const vitest = (tests: Array<{ status: string; failure?: string; hook?: boolean; scope?: string[] }>, fileMessage = "") =>
  JSON.stringify({
    GraphLoomVitest: {
      target: { file: TS_TEST, name: TS_NAME },
      files: [{ name: `/w/${TS_TEST}`, status: tests.some((t) => t.status === "failed") || fileMessage !== "" ? "failed" : "passed", message: fileMessage }],
      tests: tests.map((t) => ({ fullName: TS_NAME, status: t.status, failure: t.failure ?? "", hook: t.hook ?? false, scope: t.scope ?? [] })),
    },
  });
const tsAssertion = vitest([{ status: "failed", failure: "AssertionError: expected true to be false // Object.is equality\n    at scope.test.ts:12:5" }]);
const tsPassed = vitest([{ status: "passed" }]);
const TS_PATHS = [TS_SOURCE, TS_TEST];
const g = (validatorId: string, name: string, evidence: EvidenceRecord[], expected: ValidationStatus): QualificationCase => c(validatorId, name, evidence, expected, undefined, GRAPHLOOM);
const tsRed = (report: string, exitCode = 1, o: RunOptions = {}) => command(COMMAND.regression, exitCode, { from: "base", paths: [TS_TEST], report, ...o });
const tsGreen = (report = tsPassed, exitCode = 0, o: RunOptions = {}) => command(COMMAND.regression, exitCode, { paths: TS_PATHS, report, ...o });
const tsBuilds = (overrides: Partial<Record<string, number>> = {}, skip: string[] = []) =>
  ["typecheck", "build", "test"].filter((id) => !skip.includes(id)).map((id) => command(id, overrides[id] ?? 0, { paths: TS_PATHS }));

/** The graphloom profile with one `final` tier command, for the final-checks cases. */
const FINAL_PROFILE: unknown = {
  ...(GRAPHLOOM as object),
  commands: [...(GRAPHLOOM as { commands: object[] }).commands, { id: "smoke", argv: ["npm", "run", "smoke"], requirement: "final-checks", tier: "final" }],
};
const f = (name: string, evidence: EvidenceRecord[], expected: ValidationStatus): QualificationCase => c("final-checks", name, evidence, expected, undefined, FINAL_PROFILE);
const finalCommand = (exitCode: number, o: RunOptions = {}): EvidenceRecord => command("smoke", exitCode, { stageId: REVIEW_STAGE, ...o });

/** Positive and negative cases for every shipped validator. */
export const QUALIFICATION_CASES: readonly QualificationCase[] = [
  c("decisions-recorded", "complete ready record", [implementer(READY)], "passed"),
  c("decisions-recorded", "a product decision taken", [implementer({ ...READY, decisions: [{ ...READY.decisions[1]!, chosen: "stop" }] })], "failed"),
  c("decisions-recorded", "a behaviour point without a choice", [implementer({ ...READY, decisions: [{ ...READY.decisions[0]!, chosen: "" }] })], "failed"),
  c("decisions-recorded", "a point without a tier", [implementer({ ...READY, decisions: [{ point: "x", options: [], basis: "b" }] })], "failed"),
  c("decisions-recorded", "no regression test", [implementer({ ...READY, test: undefined })], "failed"),
  c("decisions-recorded", "a test name go test cannot select", [implementer({ ...READY, test: { ...READY.test!, name: "scheduler reports" } })], "failed"),
  c("decisions-recorded", "a blocked record", [implementer({ ...READY, status: "blocked" })], "failed"),
  c("decisions-recorded", "no implementer result", [], "inconclusive"),

  c("red-reproduces", "fails by assertion on the base", [implementer(READY), red(failedByAssertion)], "passed"),
  c("red-reproduces", "does not build on the base", [implementer(READY), red(buildFailed)], "failed"),
  c("red-reproduces", "passes on the base", [implementer(READY), red(passedReport, 0)], "failed"),
  c("red-reproduces", "production code applied", [implementer(READY), red(failedByAssertion, 1, { paths: ["pkg/timestamp/scheduler.go", "pkg/timestamp/scheduler_test.go"] })], "failed"),
  c("red-reproduces", "preparation failed", [implementer(READY), red(failedByAssertion, 1, { prepared: false })], "failed"),
  c("red-reproduces", "the check changed a file", [implementer(READY), red(failedByAssertion, 1, { mutations: ["pkg/timestamp/scheduler_test.go"] })], "failed"),
  c("red-reproduces", "the test panics on the base", [implementer(READY), red(panicked, 2)], "failed"),
  c("red-reproduces", "another test failed", [implementer(READY), red(events({ Action: "fail", Test: "TestOther" }))], "failed"),
  c("red-reproduces", "no test files changed", [implementer(READY), green(passedReport, 0, { paths: ["pkg/timestamp/scheduler.go"] })], "failed"),
  c("red-reproduces", "a Ginkgo spec fails by assertion on the base", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec(FOCUSED, "failed")]))], "passed"),
  c("red-reproduces", "a Ginkgo suite's setup fails on the base", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec("", "failed", "BeforeSuite")]))], "failed"),
  c("red-reproduces", "a Ginkgo spec panics on the base", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec(FOCUSED, "panicked")]))], "failed"),
  c("red-reproduces", "a Ginkgo spec fails in its BeforeEach", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec(FOCUSED, "failed", "It", "BeforeEach")]))], "failed"),
  c("red-reproduces", "a Ginkgo run lost its spec summary", [implementer(SUITE_READY), red(failedByAssertion)], "failed"),
  c("red-reproduces", "only a spec other than the focused one fails", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec("scheduler stops cleanly", "failed"), spec(FOCUSED, "passed")]))], "failed"),
  c("red-reproduces", "the RED check timed out", [implementer(READY), red(failedByAssertion, 1, { timedOut: true })], "failed"),
  c("red-reproduces", "RED ran a test the record has since renamed", [implementer(READY), red(failedByAssertion, 1, { argv: goTestRunner.argv({ ...READY.test!, name: "TestOldName" }) })], "inconclusive"),
  c("red-reproduces", "RED ran the same test in another package", [implementer(READY), red(failedByAssertion, 1, { argv: goTestRunner.argv({ ...READY.test!, package: "./pkg/other" }) })], "inconclusive"),
  c("red-reproduces", "RED ran on an older change", [implementer(READY), red(failedByAssertion, 1, { digest: OTHER })], "inconclusive"),
  c("red-reproduces", "fails by assertion on the candidate with the fix reverted", [implementer(READY), redReverted(failedByAssertion)], "passed"),
  c("red-reproduces", "still does not build with the fix reverted", [implementer(READY), redReverted(buildFailed)], "failed"),
  c("red-reproduces", "the revert patch touches the test file", [implementer(READY), redReverted(failedByAssertion, 1, { revertedPaths: ["pkg/timestamp/scheduler_test.go"] })], "failed"),
  c("red-reproduces", "the revert patch reverted no file", [implementer(READY), redReverted(failedByAssertion, 1, { revertedPaths: [] })], "failed"),
  c(
    "red-reproduces",
    "a reverted retry supersedes an earlier unbuildable plain RED",
    [implementer(READY), red(buildFailed), redReverted(failedByAssertion)],
    "passed",
  ),

  c("green-passes", "test and packages pass", [implementer(READY), ...candidate()], "passed"),
  c("green-passes", "the regression fails", [implementer(READY), green(failedByAssertion, 1), command(BYDB.testCi, 0)], "failed"),
  c("green-passes", "the package tests fail", [implementer(READY), ...candidate({ [BYDB.testCi]: 2 })], "failed"),
  c("green-passes", "the package tests did not run", [implementer(READY), green()], "failed"),
  c("green-passes", "the check changed a file", [implementer(READY), ...candidate({}, { mutations: ["pkg/timestamp/scheduler.go"] })], "failed"),
  c("green-passes", "the Ginkgo spec that failed on the base passes", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec(FOCUSED, "failed")])), green(suite(passedReport, [spec(FOCUSED, "passed")])), command(BYDB.testCi, 0)], "passed"),
  c("green-passes", "the Ginkgo focus matches no spec", [implementer(SUITE_READY), green(suite(passedReport, [])), command(BYDB.testCi, 0)], "failed"),
  c("green-passes", "GREEN passes another Ginkgo spec than the one that failed on the base", [implementer(SUITE_READY), red(suite(failedByAssertion, [spec(FOCUSED, "failed")])), green(suite(passedReport, [spec("scheduler logs", "passed")])), command(BYDB.testCi, 0)], "failed"),
  c("green-passes", "GREEN ran a test the record has since renamed", [implementer(READY), green(passedReport, 0, { argv: goTestRunner.argv({ ...READY.test!, name: "TestOldName" }) }), command(BYDB.testCi, 0)], "inconclusive"),
  c("green-passes", "GREEN ran on an older change", [implementer(READY), ...candidate({}, { digest: OTHER })], "inconclusive"),

  c("build-checks", "all build checks pass", [...candidate()], "passed"),
  c("build-checks", "lint fails", [...candidate({ [BYDB.lint]: 2 })], "failed"),
  c("build-checks", "make check reformatted a file", [green(), ...[BYDB.testCi, BYDB.build, BYDB.lint].map((id) => command(id, 0)), command(BYDB.check, 0, { mutations: ["pkg/timestamp/scheduler.go"] })], "failed"),
  c("build-checks", "make check did not run", [green(), ...[BYDB.testCi, BYDB.build, BYDB.lint].map((id) => command(id, 0))], "failed"),
  c("build-checks", "only the cheap tier ran, so the full tier's build and check did not", [green(), command(BYDB.testCi, 0), command(BYDB.lint, 0)], "failed"),
  c("build-checks", "the full tier ran as its own job on the same change", [green(), command(BYDB.testCi, 0), command(BYDB.lint, 0), command(BYDB.build, 0, { op: "op-full" }), command(BYDB.check, 0, { op: "op-full" })], "passed"),
  c("build-checks", "the full tier passed on an older change", [green(), command(BYDB.testCi, 0), command(BYDB.lint, 0), command(BYDB.build, 0, { digest: OTHER }), command(BYDB.check, 0, { digest: OTHER })], "failed"),
  c("build-checks", "no candidate checks", [], "inconclusive"),

  c("write-scope", "code, test and changelog", [implementer(READY), green()], "passed"),
  c("write-scope", "go.mod without a reason", [implementer(READY), green(passedReport, 0, { paths: ["go.mod", "pkg/timestamp/scheduler.go"] })], "failed"),
  c("write-scope", "a proto file", [implementer(READY), green(passedReport, 0, { paths: ["api/proto/banyandb/v1/x.proto"] })], "failed"),
  c("write-scope", "go.mod with a recorded reason", [implementer({ ...READY, scopeExceptions: [{ path: "go.mod", reason: "the fix needs a newer dependency" }] }), green(passedReport, 0, { paths: ["go.mod"] })], "passed"),
  c("write-scope", "not checked out", [implementer(READY)], "inconclusive"),

  c("changes-entry", "an entry under the current release", [file(CHANGES), green(), diff("- Warn instead of reporting a timeout for long scheduled actions.")], "passed"),
  c("changes-entry", "an entry under an older release", [file(CHANGES.replace("- Older.", "- Older.\n- Late entry.")), green(), diff("- Late entry.")], "failed"),
  c("changes-entry", "no new entry", [file(CHANGES), green(), command(COMMAND.changesDiff, 0, { stdout: "" })], "failed"),
  c("changes-entry", "no release section", [file("# Changes\n\n- Warn.\n"), green(), diff("- Warn.")], "failed"),
  c("changes-entry", "CHANGES.md not observed for this change", [file(CHANGES, OTHER), green(), diff("- Warn instead of reporting a timeout for long scheduled actions.")], "inconclusive"),

  c("open-code-review", "no comments", [codeReviewRun(reviewed([]))], "passed"),
  c("open-code-review", "only low and medium comments", [codeReviewRun(reviewed([comment("low"), comment("medium")]))], "passed"),
  c("open-code-review", "a high comment not yet verified", [codeReviewRun(reviewed([comment("low"), comment("high")]))], "inconclusive"),
  c("open-code-review", "a high comment the verifier confirmed", [codeReviewRun(reviewed([comment("low"), comment("high")])), confirmed()], "failed"),
  c("open-code-review", "a critical comment the verifier confirmed", [codeReviewRun(reviewed([comment("critical")])), confirmed()], "failed"),
  c("open-code-review", "a comment without a severity the verifier confirmed", [codeReviewRun(reviewed([comment(undefined)])), confirmed()], "failed"),
  c("open-code-review", "a high comment refuted with quotes that match the change", [codeReviewRun(reviewed([comment("high")])), refuted(), scheduler()], "passed"),
  c("open-code-review", "a refutation whose quote does not match the change", [codeReviewRun(reviewed([comment("high")])), refuted(), scheduler(SCHEDULER.replace("s.closeTimeout", "time.Hour"))], "failed"),
  c("open-code-review", "a refutation quoting a line of another change", [codeReviewRun(reviewed([comment("high")])), refuted(), scheduler(SCHEDULER, OTHER)], "inconclusive"),
  c("open-code-review", "a refutation quoting a path outside the worktree", [codeReviewRun(reviewed([comment("high")])), refuted([{ ...BOUNDED, path: "../scheduler.go" }])], "failed"),
  c("open-code-review", "a refutation without quotes", [codeReviewRun(reviewed([comment("high")])), refuted([])], "failed"),
  c("open-code-review", "the verifier could not decide", [codeReviewRun(reviewed([comment("high")])), verification("uncertain")], "failed"),
  c("open-code-review", "a confirmation without a witness", [codeReviewRun(reviewed([comment("high")])), verification("confirmed")], "failed"),
  c("open-code-review", "the latest pass on the change it was confirmed on calls it resolved", [codeReviewRun(reviewed([comment("high")])), confirmed(), codeReviewRun(reviewed([], undefined, { F1: "resolved" }))], "failed"),
  c("open-code-review", "a finding confirmed on an earlier change and resolved on this one", [codeReviewRun(reviewed([], undefined, { F1: "resolved" }))], "passed", confirmedEarlier()),
  c("open-code-review", "a finding confirmed on an earlier change and still present", [codeReviewRun(reviewed([], undefined, { F1: "still_present" }))], "failed", confirmedEarlier()),
  c("open-code-review", "a new high comment after the three discovery rounds", [codeReviewRun(reviewed([comment("high")]))], "passed", earlierRounds(3)),
  c("open-code-review", "a known finding still present after the three discovery rounds", [codeReviewRun(reviewed([comment("high")], undefined, { F1: "still_present" }))], "failed", [...confirmedEarlier(), ...earlierRounds(2).map((e) => ({ ...e, payload: { ...(e.payload as object), codingAgent: { harness: "codex", status: "completed", output: reviewed([], undefined, { F1: "still_present" }) } } }))]),
  c("open-code-review", "a pass that gives an open finding no status", [codeReviewRun(reviewed([]))], "failed", confirmedEarlier()),
  c("open-code-review", "a clean pass only in an earlier generation", [], "inconclusive", [codeReviewRun(reviewed([]))]),
  c("open-code-review", "some files were not reviewed", [codeReviewRun(reviewed([], { total_files: 3, reviewed_files: 2, skipped: [] }))], "failed"),
  c("open-code-review", "a file was skipped", [codeReviewRun(reviewed([], { total_files: 3, reviewed_files: 3, skipped: [{ path: "a.go", reason: "generated" }] }))], "failed"),
  c("open-code-review", "no file was reviewed", [codeReviewRun(reviewed([], { total_files: 0, reviewed_files: 0, skipped: [] }))], "failed"),
  c("open-code-review", "no coverage summary", [codeReviewRun({ comments: [] })], "failed"),
  c("open-code-review", "the reviewer failed", [codeReviewRun(null, { status: "failed" })], "failed"),
  c("open-code-review", "the review could write", [codeReviewRun(reviewed([]), { readOnly: false })], "failed"),
  c("open-code-review", "the review ran on an older change", [codeReviewRun(reviewed([]), { digest: OTHER })], "inconclusive"),
  c("open-code-review", "the review did not run", [...candidate()], "inconclusive"),

  g("decisions-recorded", "a test file and full test name vitest can select", [implementer(TS_READY)], "passed"),
  g("decisions-recorded", "a Go package for the vitest runner", [implementer(READY)], "failed"),
  g("decisions-recorded", "a Ginkgo focus for the vitest runner", [implementer({ ...TS_READY, test: { ...TS_READY.test!, focus: "spec" } })], "failed"),
  g("decisions-recorded", "a source file named as the test file", [implementer({ ...TS_READY, test: { ...TS_READY.test!, package: TS_SOURCE } })], "failed"),
  g("decisions-recorded", "a test file outside the repository", [implementer({ ...TS_READY, test: { ...TS_READY.test!, package: "../x.test.ts" } })], "failed"),

  g("red-reproduces", "fails by an assertion error on the base", [implementer(TS_READY), tsRed(tsAssertion)], "passed"),
  g("red-reproduces", "calls a function the base does not have", [implementer(TS_READY), tsRed(vitest([{ status: "failed", failure: "TypeError: (0 , writeScopeAllows) is not a function" }]))], "failed"),
  g("red-reproduces", "the test file does not load on the base", [implementer(TS_READY), tsRed(vitest([], "Cannot find module './scope-helpers.js' imported from scope.test.ts"))], "failed"),
  g("red-reproduces", "throws something other than an assertion on the base", [implementer(TS_READY), tsRed(vitest([{ status: "failed", failure: "Error: ENOENT: no such file or directory" }]))], "failed"),
  g("red-reproduces", "a hook fails before the test runs", [implementer(TS_READY), tsRed(vitest([{ status: "skipped" }], "Error: beforeAll timed out"))], "failed"),
  g("red-reproduces", "a beforeEach assertion fails, so the test body never ran", [implementer(TS_READY), tsRed(vitest([{ status: "failed", failure: "AssertionError: expected 1 to be 2", hook: true }]))], "failed"),
  g("red-reproduces", "the body fails, but an enclosing suite's hook failed too", [implementer(TS_READY), tsRed(vitest([{ status: "failed", failure: "AssertionError: expected 1 to be 2", scope: ['a beforeAll hook of "suite" failed'] }]))], "failed"),
  g("red-reproduces", "passes on the base", [implementer(TS_READY), tsRed(tsPassed, 0)], "failed"),
  g("red-reproduces", "vitest wrote no report", [implementer(TS_READY), tsRed("", 1)], "failed"),
  g("red-reproduces", "production code applied", [implementer(TS_READY), tsRed(tsAssertion, 1, { paths: TS_PATHS })], "failed"),
  g("red-reproduces", "fails by assertion with the fix reverted", [implementer(TS_READY), command(COMMAND.regression, 1, { from: "candidate", reverted: true, revertedPaths: [TS_SOURCE], report: tsAssertion })], "passed"),

  g("green-passes", "the regression passes, with no further commands to run", [implementer(TS_READY), tsGreen()], "passed"),
  g("green-passes", "the test passes but its suite's afterAll fails", [implementer(TS_READY), tsGreen(vitest([{ status: "passed", scope: ["AssertionError: expected 1 to be 3"] }]), 1)], "failed"),
  g("green-passes", "a clean pass reported despite the afterAll failure", [implementer(TS_READY), tsGreen(vitest([{ status: "passed", scope: ["AssertionError: expected 1 to be 3"] }]), 0)], "failed"),
  g("green-passes", "the regression fails on the change", [implementer(TS_READY), tsGreen(tsAssertion, 1)], "failed"),
  g("green-passes", "GREEN ran a test the record has since renamed", [implementer(TS_READY), tsGreen(tsPassed, 0, { argv: vitestRunner.argv({ ...TS_READY.test!, name: "writeScopeAllows an old name" }) })], "inconclusive"),
  g("green-passes", "a report of another test, under this test's argv", [implementer(TS_READY), tsGreen(JSON.stringify({ GraphLoomVitest: { target: { file: TS_TEST, name: "another" }, files: [], tests: [{ fullName: TS_NAME, status: "passed", failure: "" }] } }))], "failed"),
  g("red-reproduces", "RED ran a test the record has since renamed", [implementer(TS_READY), tsRed(tsAssertion, 1, { argv: vitestRunner.argv({ ...TS_READY.test!, name: "writeScopeAllows an old name" }) })], "inconclusive"),
  g("green-passes", "the regression test is not in the report", [implementer(TS_READY), tsGreen(vitest([]), 0)], "failed"),

  g("build-checks", "typecheck, build and the full suite pass", [tsGreen(), ...tsBuilds()], "passed"),
  g("build-checks", "the full suite fails", [tsGreen(), ...tsBuilds({ test: 1 })], "failed"),
  g("build-checks", "the full suite did not run", [tsGreen(), ...tsBuilds({}, ["test"])], "failed"),

  g("write-scope", "source and test", [implementer(TS_READY), tsGreen()], "passed"),
  g("write-scope", "the lockfile without a reason", [implementer(TS_READY), tsGreen(tsPassed, 0, { paths: ["package-lock.json", TS_SOURCE] })], "failed"),
  g("write-scope", "the frozen legacy tree", [implementer(TS_READY), tsGreen(tsPassed, 0, { paths: ["legacy/go/main.go"] })], "failed"),
  g("write-scope", "the lockfile with a recorded reason", [implementer({ ...TS_READY, scopeExceptions: [{ path: "package-lock.json", reason: "the fix needs a new dependency" }] }), tsGreen(tsPassed, 0, { paths: ["package-lock.json"] })], "passed"),

  f("final run passed", [finalCommand(0)], "passed"),
  f("final run exited non-zero", [finalCommand(1)], "failed"),
  f("final run timed out", [finalCommand(0, { timedOut: true })], "failed"),
  f("final run left a file changed", [finalCommand(0, { mutations: ["build/out.json"] })], "failed"),
  f("final run in an unprepared checkout", [finalCommand(0, { prepared: false })], "failed"),
  f("no final run", [], "inconclusive"),
  f("final run on an older change", [finalCommand(0, { digest: OTHER })], "inconclusive"),
  f("final command run in the base checkout", [finalCommand(0, { from: "base" })], "inconclusive"),

  g("open-code-review", "no comments", [codeReviewRun(reviewed([]))], "passed"),
];

/**
 * Qualify a candidate's validators against the cases. With a baseline, the
 * old version must get at least one case wrong: a repair has to reproduce the
 * defect it fixes.
 */
export function qualifyValidators(candidate: ValidatorLookup, baseline?: ValidatorLookup): QualificationReport {
  const candidateMismatches = mismatches(candidate);
  const baselineMismatches = baseline ? mismatches(baseline) : [];
  const total = QUALIFICATION_CASES.length;
  let summary: string;
  if (candidateMismatches.length > 0) {
    summary = `candidate fails ${candidateMismatches.length} of ${total} qualification cases: ${candidateMismatches.join("; ")}`;
  } else if (baseline && baselineMismatches.length === 0) {
    summary = `the old version passes all ${total} qualification cases, so no defect is reproduced`;
  } else {
    summary = `candidate passes all ${total} qualification cases` + (baseline ? `; the old version fails ${baselineMismatches.join("; ")}` : "");
  }
  return { ok: candidateMismatches.length === 0 && (!baseline || baselineMismatches.length > 0), summary, candidateMismatches, baselineMismatches };
}

function mismatches(lookup: ValidatorLookup): string[] {
  return QUALIFICATION_CASES.flatMap((q) => {
    const got = outcome(lookup, q);
    return got === q.expected ? [] : [`${q.validatorId}: ${q.name} (expected ${q.expected}, got ${got})`];
  });
}

function outcome(lookup: ValidatorLookup, q: QualificationCase): string {
  const validator = lookup(q.validatorId);
  if (validator === undefined) return "no validator";
  const definition = definitionFor(parseProfile(q.config));
  const binding = definition.defaultValidators.find((b) => b.validatorId === q.validatorId);
  if (binding === undefined) return "not bound by this profile";
  const requirementId = binding.requirementId;
  const statement = definition.requirements.find((r) => r.id === requirementId)!.statement;
  try {
    return validator.evaluate({ requirementId, statement, evidence: q.evidence, ...(q.history !== undefined ? { history: q.history } : {}), candidateDigest: DIGEST, config: q.config }).status;
  } catch (err) {
    return `a throw (${err instanceof Error ? err.message : String(err)})`;
  }
}
