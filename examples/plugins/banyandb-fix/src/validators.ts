import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import {
  BUILD_COMMANDS,
  CHANGES_PATH,
  COMMAND,
  FIX_STAGE,
} from "./constants.js";
import { decisionProblems, outOfScope, parseDecisionRecord, type DecisionRecord } from "./decision-record.js";
import {
  agentRuns,
  describeCommand,
  latestCheckoutRun,
  latestFile,
  latestReview,
  sameCheckoutJob,
  succeeded,
  type CommandRun,
} from "./evidence.js";
import { ginkgoSpecs, regressionOutcome } from "./gotest.js";

const passed = (reason: string): ValidationResult => ({ status: "passed", reason });
const failed = (reason: string): ValidationResult => ({ status: "failed", reason });
const inconclusive = (reason: string): ValidationResult => ({ status: "inconclusive", reason });

/** The implementer's latest decision record in this evidence. */
export function implementerRecord(evidence: EvidenceRecord[]): { record?: DecisionRecord; problem?: string } {
  const run = agentRuns(evidence, FIX_STAGE, "work").at(-1);
  if (run === undefined) return { problem: "the implementer has not run" };
  const parsed = parseDecisionRecord(run.output);
  return "record" in parsed ? { record: parsed.record } : { problem: `the implementer's decision record is invalid: ${parsed.problem}` };
}

export const decisionsRecorded: Validator = {
  evaluate(input) {
    const { record, problem } = implementerRecord(input.evidence);
    if (record === undefined) return inconclusive(problem!);
    const problems = decisionProblems(record);
    return problems.length === 0 ? passed("the decision record is complete") : failed(problems.join("; "));
  },
};

/** A checkout run that can count: prepared, and it changed no file. */
function cleanRun(run: CommandRun): string | undefined {
  if (run.checkout?.prepared !== true) return `${run.command.id} ran in an unprepared checkout`;
  if (run.checkout.mutations.length > 0) {
    return `the checks in the ${run.checkout.from} checkout that ran ${run.command.id} left files changed: ${run.checkout.mutations.slice(0, 10).join(", ")}`;
  }
  return undefined;
}

const reportText = (run: CommandRun): string => run.command.report?.text ?? run.command.stdoutTail;

/** The regression test as messages name it: the suite and its focused spec for Ginkgo. */
const testLabel = (record: DecisionRecord): string =>
  record.test!.focus !== undefined ? `${record.test!.name} (spec "${record.test!.focus}")` : record.test!.name;

export const isTestPath = (p: string): boolean => p.endsWith("_test.go") || p.includes("/testdata/") || p.startsWith("testdata/");

export const reproduces: Validator = {
  evaluate(input) {
    const { record } = implementerRecord(input.evidence);
    if (record?.test === undefined) return inconclusive("no regression test is named");
    const red = latestCheckoutRun(input.evidence, COMMAND.regression, "base", input.candidateDigest);
    if (red === undefined) {
      const candidate = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
      if (candidate !== undefined && !candidate.checkout!.paths.some(isTestPath)) return failed("the change adds or edits no test files");
      return inconclusive("no RED check ran on the current change");
    }
    const unclean = cleanRun(red);
    if (unclean !== undefined) return failed(unclean);
    if (red.checkout!.paths.length === 0 || !red.checkout!.paths.every(isTestPath)) return failed("the RED checkout must apply only test files");
    const name = testLabel(record);
    const outcome = regressionOutcome(reportText(red), record.test);
    if (outcome === "failed" && !succeeded(red.command)) return passed(`${name} fails on the base commit with only the test files applied`);
    if (outcome === "build-failed") return failed(`${name} does not build on the base commit; RED must fail by assertion`);
    if (outcome === "setup-failed") return failed(`${name} fails in its setup on the base commit, not in the spec; RED must fail by assertion`);
    if (outcome === "passed") return failed(`${name} passes on the base commit, so it does not reproduce the bug`);
    return failed(`${name} has no result on the base commit (${describeCommand(red.command)})`);
  },
};

export const passes: Validator = {
  evaluate(input) {
    const { record } = implementerRecord(input.evidence);
    if (record?.test === undefined) return inconclusive("no regression test is named");
    const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
    if (green === undefined) return inconclusive("no GREEN check ran on the current change");
    const unclean = cleanRun(green);
    if (unclean !== undefined) return failed(unclean);
    const name = testLabel(record);
    const outcome = regressionOutcome(reportText(green), record.test);
    if (outcome !== "passed" || !succeeded(green.command)) return failed(`${name} does not pass on the change (${outcome}, ${describeCommand(green.command)})`);
    const red = latestCheckoutRun(input.evidence, COMMAND.regression, "base", input.candidateDigest);
    const failedOnBase = red !== undefined ? (ginkgoSpecs(reportText(red)) ?? []).filter((s) => s.node === "It" && s.state !== "passed").map((s) => s.text) : [];
    const passedHere = new Set((ginkgoSpecs(reportText(green)) ?? []).filter((s) => s.state === "passed").map((s) => s.text));
    const missing = failedOnBase.filter((text) => !passedHere.has(text));
    if (missing.length > 0) return failed(`GREEN did not pass the spec that failed on the base: ${missing.join("; ")}`);
    const testCi = sameCheckoutJob(input.evidence, green, COMMAND.testCi);
    if (testCi === undefined) return failed("the affected packages' tests did not run");
    const testCiUnclean = cleanRun(testCi);
    if (testCiUnclean !== undefined) return failed(testCiUnclean);
    if (!succeeded(testCi.command)) return failed(`the affected packages' tests fail: ${describeCommand(testCi.command)}`);
    return passed(`${record.test.name} and the affected packages pass on the change`);
  },
};

export const builds: Validator = {
  evaluate(input) {
    const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
    if (green === undefined) return inconclusive("no candidate checks ran on the current change");
    const problems: string[] = [];
    for (const id of BUILD_COMMANDS) {
      const run = sameCheckoutJob(input.evidence, green, id);
      if (run === undefined) {
        problems.push(`${id} did not run`);
        continue;
      }
      const unclean = cleanRun(run);
      if (unclean !== undefined) problems.push(unclean);
      else if (!succeeded(run.command)) problems.push(describeCommand(run.command));
    }
    return problems.length === 0 ? passed(`${BUILD_COMMANDS.join(", ")} pass on the change`) : failed(problems.join("; "));
  },
};

export const inScope: Validator = {
  evaluate(input) {
    const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
    if (green === undefined) return inconclusive("the current change has not been checked out");
    const { record } = implementerRecord(input.evidence);
    const outside = outOfScope(green.checkout!.paths, record);
    return outside.length === 0 ? passed(`${green.checkout!.paths.length} changed paths are within the write scope`) : failed(`changed outside the write scope: ${outside.join(", ")}`);
  },
};

/** Lines a unified diff adds as list items, without the leading `+`. */
export function addedBullets(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => /^\+\s*[-*] \S/.test(l) && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim());
}

/** The first release section of CHANGES.md: from the first `## ` heading to the next. */
export function currentRelease(changes: string): { heading: string; body: string } | undefined {
  const lines = changes.split("\n");
  const start = lines.findIndex((l) => /^## \S/.test(l));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## \S/.test(l));
  return { heading: lines[start]!.slice(3).trim(), body: (end < 0 ? rest : rest.slice(0, end)).join("\n") };
}

export const changelogEntry: Validator = {
  evaluate(input) {
    const file = latestFile(input.evidence, CHANGES_PATH, input.candidateDigest);
    if (file === undefined) return inconclusive(`${CHANGES_PATH} was not observed for the current change`);
    const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
    const diff = green !== undefined ? sameCheckoutJob(input.evidence, green, COMMAND.changesDiff) : undefined;
    if (diff === undefined) return inconclusive(`the ${CHANGES_PATH} diff was not recorded for the current change`);
    const release = currentRelease(file.bytes);
    if (release === undefined) return failed(`${CHANGES_PATH} has no "## " release section`);
    const added = addedBullets(diff.command.stdoutTail);
    if (added.length === 0) return failed(`the change adds no entry to ${CHANGES_PATH}`);
    const sectionLines = new Set(release.body.split("\n").map((l) => l.trim()));
    return added.some((b) => sectionLines.has(b))
      ? passed(`${CHANGES_PATH} has a new entry under ${release.heading}`)
      : failed(`the new ${CHANGES_PATH} entry is not under the current release ${release.heading}`);
  },
};

export const independentReview: Validator = {
  evaluate(input: ValidationInput) {
    const review = latestReview(input.evidence);
    if (review === undefined) return inconclusive("no review verdict");
    if (input.candidateDigest !== undefined && review.record.candidateDigest !== input.candidateDigest) return failed("the verdict is for a different change");
    if (review.verdict === "approved") return passed("the reviewer approved the change");
    if (review.verdict === "request_changes") return failed(`the reviewer requested changes: ${review.summary}`);
    return inconclusive(`unknown verdict ${JSON.stringify(review.verdict)}`);
  },
};

const VALIDATORS: Record<string, Validator> = {
  "decisions-recorded": decisionsRecorded,
  "red-reproduces": reproduces,
  "green-passes": passes,
  "build-checks": builds,
  "write-scope": inScope,
  "changes-entry": changelogEntry,
  "independent-reviewer": independentReview,
};

export function validatorById(id: string): Validator | undefined {
  return VALIDATORS[id];
}
