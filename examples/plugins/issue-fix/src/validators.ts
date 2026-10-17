import type { EvidenceRecord, ValidationInput, ValidationResult, Validator } from "@graphloom/sdk";
import { COMMAND, FIX_STAGE, REVIEW_STAGE } from "./constants.js";
import { decisionProblems, outOfScope, parseDecisionRecord, type DecisionRecord } from "./decision-record.js";
import {
  agentRuns,
  describeCommand,
  latestCheckoutRun,
  latestFile,
  latestRevertedCheckoutRun,
  sameCheckoutJob,
  succeeded,
  type AgentRun,
  type CommandRun,
} from "./evidence.js";
import { describeFinding, findingById, findingLedger } from "./findings.js";
import { describeCoverage, isBlocking, reviewComplete } from "./ocr.js";
import { commandsFor, isTestPath, parseProfile, ProfileError, type Profile } from "./profile.js";

const passed = (reason: string): ValidationResult => ({ status: "passed", reason });
const failed = (reason: string): ValidationResult => ({ status: "failed", reason });
const inconclusive = (reason: string): ValidationResult => ({ status: "inconclusive", reason });

/** A validator that judges against the run's profile, which the controller passes as the task's config. */
function profiled(evaluate: (input: ValidationInput, profile: Profile) => ValidationResult): Validator {
  return {
    evaluate(input) {
      let profile: Profile;
      try {
        profile = parseProfile(input.config);
      } catch (err) {
        if (err instanceof ProfileError) return inconclusive(err.message);
        throw err;
      }
      return evaluate(input, profile);
    },
  };
}

/** The implementer's latest decision record in this evidence. */
export function implementerRecord(evidence: EvidenceRecord[]): { record?: DecisionRecord; problem?: string } {
  const run = agentRuns(evidence, FIX_STAGE, "work").at(-1);
  if (run === undefined) return { problem: "the implementer has not run" };
  const parsed = parseDecisionRecord(run.output);
  return "record" in parsed ? { record: parsed.record } : { problem: `the implementer's decision record is invalid: ${parsed.problem}` };
}

export const decisionsRecorded: Validator = profiled((input, profile) => {
  const { record, problem } = implementerRecord(input.evidence);
  if (record === undefined) return inconclusive(problem!);
  const problems = decisionProblems(record, profile);
  return problems.length === 0 ? passed("the decision record is complete") : failed(problems.join("; "));
});

/** A checkout run that can count: prepared, and it changed no file. */
function cleanRun(run: CommandRun): string | undefined {
  if (run.checkout?.prepared !== true) return `${run.command.id} ran in an unprepared checkout`;
  if (run.checkout.mutations.length > 0) {
    return `the checks in the ${run.checkout.from} checkout that ran ${run.command.id} left files changed: ${run.checkout.mutations.slice(0, 10).join(", ")}`;
  }
  return undefined;
}

export const reportText = (run: CommandRun): string => run.command.report?.text ?? run.command.stdoutTail;

export const reproduces: Validator = profiled((input, profile) => {
  const { record } = implementerRecord(input.evidence);
  if (record?.test === undefined) return inconclusive("no regression test is named");
  const testPath = (p: string) => isTestPath(profile, p);
  // A reverted-candidate retry, when present, is the authoritative RED
  // evidence: it exists only because the plain base checkout could not
  // even build the test alone (see graph.ts), so the base run's own
  // build-failed result no longer speaks for the current RED attempt.
  // Only runs of this test count: a renamed test on an unchanged candidate needs its own RED.
  const argv = profile.runner.argv(record.test);
  const red = latestRevertedCheckoutRun(input.evidence, COMMAND.regression, input.candidateDigest, argv) ?? latestCheckoutRun(input.evidence, COMMAND.regression, "base", input.candidateDigest, argv);
  if (red === undefined) {
    const candidate = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
    if (candidate !== undefined && !candidate.checkout!.paths.some(testPath)) return failed("the change adds or edits no test files");
    return inconclusive("no RED check ran on the current change");
  }
  const unclean = cleanRun(red);
  if (unclean !== undefined) return failed(unclean);
  const reverted = red.checkout!.reverted === true;
  if (reverted) {
    const touched = red.checkout!.revertedPaths ?? [];
    if (touched.length === 0) return failed("the RED checkout's revert patch reverted no file");
    if (touched.some(testPath)) return failed("the RED checkout's revert patch must not touch test files");
  } else if (red.checkout!.paths.length === 0 || !red.checkout!.paths.every(testPath)) {
    return failed("the RED checkout must apply only test files");
  }
  if (red.command.timedOut === true || red.command.aborted === true || red.command.spawnError !== undefined) {
    return failed(`the RED check did not finish (${describeCommand(red.command)})`);
  }
  const name = profile.runner.label(record.test);
  const where = reverted ? "on the candidate with this round's behavioral fix reverted" : "on the base commit with only the test files applied";
  const outcome = profile.runner.outcome(reportText(red), record.test);
  if (outcome === "failed" && !succeeded(red.command)) return passed(`${name} fails ${where}`);
  if (outcome === "build-failed") return failed(`${name} does not build ${where}; RED must fail by assertion`);
  if (outcome === "setup-failed") return failed(`${name} fails in its setup ${where}, not in the spec; RED must fail by assertion`);
  if (outcome === "panicked") return failed(`${name} panics ${where} instead of failing an assertion; RED must fail by assertion`);
  if (outcome === "passed") return failed(`${name} passes ${where}, so it does not reproduce the bug`);
  return failed(`${name} has no result ${where} (${describeCommand(red.command)})`);
});

export const passes: Validator = profiled((input, profile) => {
  const { record } = implementerRecord(input.evidence);
  if (record?.test === undefined) return inconclusive("no regression test is named");
  const argv = profile.runner.argv(record.test);
  const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest, argv);
  if (green === undefined) return inconclusive(`no GREEN check of ${profile.runner.label(record.test)} ran on the current change`);
  const unclean = cleanRun(green);
  if (unclean !== undefined) return failed(unclean);
  const name = profile.runner.label(record.test);
  const outcome = profile.runner.outcome(reportText(green), record.test);
  if (outcome !== "passed" || !succeeded(green.command)) return failed(`${name} does not pass on the change (${outcome}, ${describeCommand(green.command)})`);
  // Only the plain base RED carries finer test identities (Ginkgo specs) to
  // cross-check; a reverted-candidate RED has none here, so this secondary
  // check is simply skipped then, same as when no RED has run at all.
  const red = latestCheckoutRun(input.evidence, COMMAND.regression, "base", input.candidateDigest, argv);
  const missing = profile.runner.missingOnGreen(red !== undefined ? reportText(red) : undefined, reportText(green));
  if (missing.length > 0) return failed(`GREEN did not pass the spec that failed on the base: ${missing.join("; ")}`);
  const further = commandsFor(profile, "passes");
  for (const c of further) {
    const run = sameCheckoutJob(input.evidence, green, c.id);
    if (run === undefined) return failed(further.length === 1 ? "the affected packages' tests did not run" : `${c.id} did not run`);
    const runUnclean = cleanRun(run);
    if (runUnclean !== undefined) return failed(runUnclean);
    if (!succeeded(run.command)) return failed(further.length === 1 ? `the affected packages' tests fail: ${describeCommand(run.command)}` : describeCommand(run.command));
  }
  return passed(further.length > 0 ? `${record.test.name} and the affected packages pass on the change` : `${record.test.name} passes on the change`);
});

export const builds: Validator = profiled((input, profile) => {
  const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
  if (green === undefined) return inconclusive("no candidate checks ran on the current change");
  const ids = commandsFor(profile, "builds").map((c) => c.id);
  const problems: string[] = [];
  for (const id of ids) {
    const run = sameCheckoutJob(input.evidence, green, id);
    if (run === undefined) {
      problems.push(`${id} did not run`);
      continue;
    }
    const unclean = cleanRun(run);
    if (unclean !== undefined) problems.push(unclean);
    else if (!succeeded(run.command)) problems.push(describeCommand(run.command));
  }
  return problems.length === 0 ? passed(`${ids.join(", ")} pass on the change`) : failed(problems.join("; "));
});

export const inScope: Validator = profiled((input, profile) => {
  const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
  if (green === undefined) return inconclusive("the current change has not been checked out");
  const { record } = implementerRecord(input.evidence);
  const outside = outOfScope(green.checkout!.paths, record, profile);
  return outside.length === 0 ? passed(`${green.checkout!.paths.length} changed paths are within the write scope`) : failed(`changed outside the write scope: ${outside.join(", ")}`);
});

/** Lines a unified diff adds as list items, without the leading `+`. */
export function addedBullets(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => /^\+\s*[-*] \S/.test(l) && !l.startsWith("+++"))
    .map((l) => l.slice(1).trim());
}

/** The first release section of a changelog: from the first `## ` heading to the next. */
export function currentRelease(changes: string): { heading: string; body: string } | undefined {
  const lines = changes.split("\n");
  const start = lines.findIndex((l) => /^## \S/.test(l));
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## \S/.test(l));
  return { heading: lines[start]!.slice(3).trim(), body: (end < 0 ? rest : rest.slice(0, end)).join("\n") };
}

export const changelogEntry: Validator = profiled((input, profile) => {
  if (profile.changelog === undefined) return inconclusive(`the ${profile.name} profile names no changelog`);
  const path = profile.changelog.path;
  const file = latestFile(input.evidence, path, input.candidateDigest);
  if (file === undefined) return inconclusive(`${path} was not observed for the current change`);
  const green = latestCheckoutRun(input.evidence, COMMAND.regression, "candidate", input.candidateDigest);
  const diff = green !== undefined ? sameCheckoutJob(input.evidence, green, COMMAND.changesDiff) : undefined;
  if (diff === undefined) return inconclusive(`the ${path} diff was not recorded for the current change`);
  const release = currentRelease(file.bytes);
  if (release === undefined) return failed(`${path} has no "## " release section`);
  const added = addedBullets(diff.command.stdoutTail);
  if (added.length === 0) return failed(`the change adds no entry to ${path}`);
  const sectionLines = new Set(release.body.split("\n").map((l) => l.trim()));
  return added.some((b) => sectionLines.has(b))
    ? passed(`${path} has a new entry under ${release.heading}`)
    : failed(`the new ${path} entry is not under the current release ${release.heading}`);
});

/** The latest code review pass on the change `digest` names. */
export function latestCodeReview(evidence: EvidenceRecord[], digest: string | undefined): AgentRun | undefined {
  return agentRuns(evidence, REVIEW_STAGE, "review").filter((r) => digest !== undefined && r.record.candidateDigest === digest).at(-1);
}

/**
 * Review convergence's acceptance rule: the latest pass on the current change
 * ran in this generation, read-only, finished, covered every file and gave
 * every status; no finding awaits verification or observation; every finding
 * that pass raised was dismissed; and none is confirmed or disputed. History
 * rebuilds the ledger; it never stands in for the current pass. It reads
 * nothing repository-specific.
 */
export const codeReview: Validator = {
  evaluate(input: ValidationInput) {
    const run = latestCodeReview(input.evidence, input.candidateDigest);
    if (run === undefined) return inconclusive("the code has not been reviewed on the current change");
    if (!run.producer.readOnly) return failed("the code review must come from a read-only review job");
    if (run.status !== "completed") return failed(`the code reviewer did not finish (${run.status})`);
    const ledger = findingLedger([...(input.history ?? []), ...input.evidence]);
    const pass = ledger.passes.find((p) => p.run.record.ref === run.record.ref)!;
    if (pass.report === undefined) return failed(pass.problem!);
    const { report } = pass;
    if (!reviewComplete(report)) return failed(`the code review did not cover every file: ${describeCoverage(report)}`);
    if (pass.missingStatus.length > 0) return failed(`the code review gave no status for open finding(s) ${pass.missingStatus.join(", ")}`);
    const waiting = ledger.findings.filter((f) => f.state === "pending");
    if (waiting.length > 0) return inconclusive(`finding(s) ${waiting.map((f) => f.id).join(", ")} await verification`);
    const blocking = ledger.findings.filter((f) => f.state === "confirmed" || f.state === "disputed");
    if (blocking.length > 0) {
      return failed(`${blocking.length} critical or high finding(s) confirmed or disputed: ${blocking.slice(0, 3).map((f) => describeFinding(f, input.candidateDigest)).join("; ")}`);
    }
    const survived = pass.raised.filter((id) => findingById(ledger, id)?.state !== "dismissed");
    if (survived.length > 0) return failed(`the latest pass raised finding(s) ${survived.join(", ")} that verification did not dismiss`);
    const fixed = ledger.findings.filter((f) => f.state === "fixed").length;
    const dismissed = ledger.findings.filter((f) => f.state === "dismissed").length;
    const lower = report.comments.filter((c) => !isBlocking(c)).length;
    const settled = [...(fixed > 0 ? [`${fixed} fixed`] : []), ...(dismissed > 0 ? [`${dismissed} dismissed`] : [])];
    return passed(
      `the code review ${describeCoverage(report)} and left no critical or high finding open${settled.length > 0 ? ` (${settled.join(", ")})` : ""}${lower > 0 ? `; ${lower} lower-severity comment(s)` : ""}`,
    );
  },
};

const VALIDATORS: Record<string, Validator> = {
  "decisions-recorded": decisionsRecorded,
  "red-reproduces": reproduces,
  "green-passes": passes,
  "build-checks": builds,
  "write-scope": inScope,
  "changes-entry": changelogEntry,
  "open-code-review": codeReview,
};

/** A shipped validator; it reads the run's profile from `ValidationInput.config`. */
export function validatorById(id: string): Validator | undefined {
  return VALIDATORS[id];
}

/**
 * The shipped validators with `config` bound, for a caller that evaluates
 * them in-process rather than through a plugin host, which attaches it.
 */
export function validatorsFor(config: unknown): Record<string, Validator> {
  return Object.fromEntries(
    Object.entries(VALIDATORS).map(([id, v]) => [id, { evaluate: (input: ValidationInput) => v.evaluate({ ...input, config: input.config ?? config }) }]),
  );
}
