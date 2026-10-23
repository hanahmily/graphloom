import {
  dispatch,
  isStaleFailure,
  observe,
  stop,
  supervise,
  validate,
  type EnvironmentCommand,
  type EvidenceRecord,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type Requirement,
  type RunView,
  type ValidationResult,
  type ValidatorBinding,
} from "@graphloom/sdk";
import {
  CODING_AGENT,
  COMMAND,
  FIX_STAGE,
  GET_ISSUE,
  IMPLEMENTER_JOB,
  LIST_ISSUE_COMMENTS,
  MAX_DISCOVERY_ROUNDS,
  MAX_FIX_CORRECTIONS,
  MAX_SWEEP_PASSES,
  REQUIREMENT_BUILDS,
  REQUIREMENT_CHANGELOG,
  REQUIREMENT_DECISIONS,
  REQUIREMENT_PASSES,
  REQUIREMENT_REPRODUCES,
  REQUIREMENT_REVIEW,
  REQUIREMENT_SCOPE,
  REVIEW_STAGE,
} from "./constants.js";
import { acceptanceItems, coverageEntries, coverageFeedback, coverageFiles, coverageProblems, MAX_COVERAGE_FILES, observableCoverageFiles } from "./acceptance.js";
import { DECISION_RECORD_SCHEMA, parseDecisionRecord, writeScopeFor, type DecisionRecord } from "./decision-record.js";
import {
  agentRuns,
  commandRuns,
  describeCommand,
  environmentOutput,
  forIdentity,
  issueComments,
  issueSnapshot,
  latestCheckoutRun,
  latestFile,
  latestRevertFailure,
  latestRevertedCheckoutRun,
  outputTail,
  sameCheckoutJob,
  succeeded,
  type CommandRun,
} from "./evidence.js";
import {
  describeFinding,
  describeFollowUp,
  findingById,
  findingLedger,
  knownFindings,
  passUsable,
  pathsToObserve,
  reviewPhase,
  roundSummary,
  shortDigest,
  stillPresentNote,
  toVerify,
  VERIFICATION_SCHEMA,
  verificationInstruction,
  type Finding,
  type FindingLedger,
} from "./findings.js";
import {
  issueById,
  issueCommand,
  issueFileJson,
  issueIdOf,
  issueMarkdown,
  ISSUES_COMMAND,
  ISSUES_FILE,
  ISSUES_MARKDOWN,
  issueTableRows,
  readIssuesCommand,
  writeIssuesCommand,
  writtenJson,
  type IssueTable,
  type Rejection,
} from "./issues.js";
import { CODE_REVIEW_SCHEMA, codeReviewInstruction, describeCoverage, isBlocking, reviewBackground } from "./ocr.js";
import {
  commandLabel,
  commandsFor,
  commandsInTier,
  isTiered,
  type ProfileCommand,
  commandSummary,
  commandStatement,
  enforcedProtectedPaths,
  harnessName,
  isTestPath,
  issueRef,
  listAnd,
  parseProfile,
  ProfileError,
  type Profile,
} from "./profile.js";
import {
  candidateCommands,
  commitMessage,
  deliverCommands,
  implementInstruction,
  planInstruction,
  planRevisionInstruction,
  pullRequestDescription,
  redCommands,
  snapshotText,
} from "./prompts.js";
import { cleanRun, codeReview, implementerRecord, plannerRecord, reportText, validatorById, verifiedChecks } from "./validators.js";

export const GRAPH_ID = "issue-fix";
export const GRAPH_VERSION = "0.10.2";

/** Graph bookkeeping; everything else is read back from recorded evidence. */
export interface FixPrivateState {
  /** `view.current.attempt` as of the last call: unchanged by a resume, only by a reentry of Fix. */
  attempt: number;
  /** The generation this attempt actually started at (design-run-convergence.md
   * §4.1): no longer a fence on which evidence is visible — evidence is scoped
   * by candidate identity (`forIdentity`) so a reentry does not re-earn what an
   * unchanged candidate already earned — only a marker of when *this* attempt
   * began, to tell an implementer run that predates a reentry (stale: it ran
   * before the reentry asked for anything new) from one that answers it. */
  attemptGeneration: number;
  /** Corrections the graph dispatched in Fix in this attempt. */
  corrections: number;
}

const asSchema = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

/** What one advance call works from: the run's profile and the definition it gives. */
interface Context {
  profile: Profile;
  definition: GraphDefinition;
}

/**
 * The graph definition for a profile. The step set and requirement ids are
 * fixed by the profile: `builds` exists when the profile has build commands,
 * `changelog-entry` when it names a changelog. Statements are generated from
 * the profile, so they say what is checked for this repository.
 */
export function definitionFor(profile: Profile): GraphDefinition {
  const further = commandsFor(profile, "passes");
  const buildCommands = commandsFor(profile, "builds");
  const requirements: Requirement[] = [
    {
      id: REQUIREMENT_DECISIONS,
      statement:
        "The implementer's decision record is ready, names the regression test and the production caller, gives every unclear point a tier and a basis, takes an option for every behaviour point, and marks no product point chosen.",
      evidenceSchema: "decision-record-v2",
      identityArtifactSchema: "decision-record-v2",
    },
    {
      id: REQUIREMENT_REPRODUCES,
      statement: `In a prepared checkout of the base commit with only the change's test files applied, the named regression test fails by assertion (${profile.runner.reproducesEvidence}), and the check changed no file. When that checkout cannot even build the test alone, a prepared checkout of the full candidate with the implementer's own patch reverting just the behavioral change applied instead — the revert touching no test file — stands in, and the same build-and-fail-by-assertion rule applies there.`,
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_PASSES,
      statement: `In a prepared checkout of the full change, the named regression test passes${further.length > 0 ? ` and ${listAnd(further.map(commandStatement))}` : ""}, and the checks changed no file.`,
      evidenceSchema: "checkout-command-v1",
    },
    ...(buildCommands.length > 0
      ? [
          {
            id: REQUIREMENT_BUILDS,
            statement: `In the same checkout of the full change, ${listAnd(buildCommands.map(commandLabel))} all pass and change no file.`,
            evidenceSchema: "checkout-command-v1",
          },
        ]
      : []),
    {
      id: REQUIREMENT_SCOPE,
      statement:
        enforcedProtectedPaths(profile).length > 0
          ? `Every changed path is inside the repository and outside ${listAnd(enforcedProtectedPaths(profile))}, except those the decision record names with a reason.`
          : "Every changed path is inside the repository.",
      evidenceSchema: "checkout-command-v1",
    },
    ...(profile.changelog !== undefined
      ? [
          {
            id: REQUIREMENT_CHANGELOG,
            statement: `The change adds a list entry to ${profile.changelog.path} inside its first "## " release section.`,
            evidenceSchema: "workspace-bytes-v1",
          },
        ]
      : []),
    {
      id: REQUIREMENT_REVIEW,
      statement: `The latest read-only ${harnessName(profile.roles.reviewer)} review pass on the current change, following open-code-review's delegation workflow in this generation, reviewed every changed file, test files included, skipped none, and gave a status for every open finding; every critical or high finding it raised was refuted by an independent read-only verifier with quotes that match the change; and no finding of the run is confirmed and unfixed, disputed, or awaiting verification.`,
      evidenceSchema: "code-review-v2",
    },
  ];
  const bindings: Record<string, ValidatorBinding> = {
    [REQUIREMENT_DECISIONS]: { requirementId: REQUIREMENT_DECISIONS, validatorId: "decisions-recorded", version: "1" },
    [REQUIREMENT_REPRODUCES]: { requirementId: REQUIREMENT_REPRODUCES, validatorId: "red-reproduces", version: "1" },
    [REQUIREMENT_PASSES]: { requirementId: REQUIREMENT_PASSES, validatorId: "green-passes", version: "1" },
    [REQUIREMENT_BUILDS]: { requirementId: REQUIREMENT_BUILDS, validatorId: "build-checks", version: "1" },
    [REQUIREMENT_SCOPE]: { requirementId: REQUIREMENT_SCOPE, validatorId: "write-scope", version: "1" },
    [REQUIREMENT_CHANGELOG]: { requirementId: REQUIREMENT_CHANGELOG, validatorId: "changes-entry", version: "1" },
    [REQUIREMENT_REVIEW]: { requirementId: REQUIREMENT_REVIEW, validatorId: "open-code-review", version: "2" },
  };
  const fixRequirements = requirements.map((r) => r.id).filter((id) => id !== REQUIREMENT_REVIEW);
  return {
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    privateStateSchema: "issue-fix-private-v1",
    resultContracts: [
      { name: "decision-record-v2", schema: asSchema(DECISION_RECORD_SCHEMA), evidenceKind: "other" },
      { name: "finding-verification-v1", schema: asSchema(VERIFICATION_SCHEMA), evidenceKind: "other" },
      { name: "code-review-v2", schema: asSchema(CODE_REVIEW_SCHEMA), evidenceKind: "review" },
    ],
    stages: [
      { id: FIX_STAGE, name: "Fix", requirementIds: fixRequirements },
      { id: REVIEW_STAGE, name: "Review", requirementIds: [REQUIREMENT_REVIEW] },
    ],
    requirements,
    defaultValidators: requirements.map((r) => bindings[r.id]!),
    environment: structuredClone(profile.environment),
    ...(profile.budgets !== undefined ? { defaultBudgets: { ...profile.budgets } } : {}),
  };
}

/** The graph: its definition and routing both come from the task's profile (`config`). */
export function createGraph(): GraphPlugin {
  return {
    describe: (config?: unknown) => definitionFor(parseProfile(config)),
    advance: advanceFix,
  };
}

/** The issue the request names: `owner/repo#N` for the profile's issue repository, or the first `#N`. */
export function requestedIssue(request: string, profile: Profile): number | undefined {
  const repo = `${profile.issues.owner}/${profile.issues.repo}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${repo}#(\\d+)`).exec(request) ?? /#(\d+)\b/.exec(request);
  return match !== null ? Number(match[1]) : undefined;
}

export function advanceFix(view: RunView): GraphDecision {
  let profile: Profile;
  try {
    profile = parseProfile(view.config);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return stop({ reason: "incompatible task", blocker: err.message, retryable: false }, "reject a task without a usable profile");
  }
  const ctx: Context = { profile, definition: definitionFor(profile) };
  const issue = requestedIssue(view.task.request, profile);
  if (issue === undefined) {
    return stop({ reason: "incompatible task", blocker: `the request names no ${profile.issues.owner}/${profile.issues.repo} issue`, retryable: false }, "reject a request without an issue");
  }
  const state = readPrivate(view);
  const stage = ctx.definition.stages.find(
    (s) =>
      !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) ||
      view.openAttempt?.[s.id] === true,
  );
  if (stage === undefined) return deliver(ctx, view, issue, state);
  return stage.id === FIX_STAGE ? fix(ctx, view, issue, state) : review(ctx, view, issue, state);
}

function fix(ctx: Context, view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const { profile } = ctx;
  const snapshot = issueSnapshot(view.evidence, issue);
  if (snapshot === undefined) {
    return withPrivate(dispatch(githubJob(GET_ISSUE, "Fetch the issue", { owner: profile.issues.owner, repo: profile.issues.repo, number: issue }), `fetch ${issueRef(profile, issue)}`), state);
  }
  const comments = issueComments(view.evidence);
  if (comments === undefined) {
    return withPrivate(
      dispatch(
        githubJob(LIST_ISSUE_COMMENTS, "Fetch the issue comments", { owner: profile.issues.owner, repo: profile.issues.repo, number: issue, perPage: 100, maxPages: 5 }),
        `fetch the comments on ${issueRef(profile, issue)}`,
      ),
      state,
    );
  }
  const snapshotResult = snapshotText(profile, snapshot.issue, comments.comments, comments.complete);
  if ("problem" in snapshotResult) return partialSnapshot(snapshotResult.problem, [snapshot.record.ref, comments.record.ref]);
  const snapshotBody = snapshotResult.text;
  // The plan and the implementer's decision record are their own artifacts,
  // not workspace bytes (design-run-convergence.md §4.1): they stay on
  // record, unscoped by generation or candidate, until an explicit new
  // diagnostic or work dispatch supersedes them — a reentry alone does not
  // invalidate either, so it does not re-earn a plan or implementation that
  // is already right.
  const reopened = view.openAttempt?.[FIX_STAGE] === true;

  const planRun = agentRuns(view.evidence, FIX_STAGE, "diagnostic").filter((r) => r.status === "completed").at(-1);
  if (planRun === undefined) {
    const revisit = agentRuns(view.evidence, FIX_STAGE, "diagnostic").some((r) => r.status === "completed");
    const assignment = revisit
      ? planRevisionInstruction(profile, { issue, feedback: reentryFeedback(view), changed: agentRuns(view.evidence, FIX_STAGE, "work").length > 0 })
      : planInstruction(profile, { issue, request: view.task.request, snapshot: snapshotBody });
    return dispatchAgent(view, planJob(ctx, view, assignment), revisit ? "revisit the plan after returning to Fix (read-only)" : "plan the fix (read-only)", state);
  }
  const plan = parseDecisionRecord(planRun.output);
  if ("problem" in plan) {
    return supervise({ reason: `the plan returned no valid decision record: ${plan.problem}`, evidenceRefs: [planRun.record.ref] }, "escalate an invalid plan", JSON.stringify(state));
  }
  const blocked = notReady(plan.record, [planRun.record.ref], "the plan");
  if (blocked !== undefined) return blocked;

  const implemented = agentRuns(view.evidence, FIX_STAGE, "work").at(-1);
  // A reentry whose own implementer run predates it answers nothing new:
  // the same candidate that sent Fix back here is still the one on record.
  const stalePreReentry = reopened && implemented !== undefined && (implemented.record.generation ?? 0) < state.attemptGeneration;
  // The fixer may have marked issues fixed: read the file back before anything else.
  if (implemented !== undefined) {
    const read = issuesReadStep(view, FIX_STAGE, state);
    if (read !== undefined) return read;
  }
  // Every implementer job starts from the file as the graph last accepted it.
  const restore = issuesRestore(view, findingLedger(view.evidence), FIX_STAGE, state);
  const implementer = (job: JobSpec, summary: string, next: FixPrivateState): GraphDecision => restore ?? dispatchAgent(view, job, summary, next);
  if (implemented === undefined || implemented.status !== "completed" || stalePreReentry) {
    return implementer(
      implementJob(ctx, view, issue, plan.record, stalePreReentry ? reentryFeedback(view) : undefined),
      implemented === undefined ? "implement the reviewed plan, continuing the plan session" : stalePreReentry ? "answer why Fix was re-entered with a fresh implementation pass" : "retry the implementation",
      state,
    );
  }
  const record = implementerRecord(view.evidence).record;
  if (record !== undefined) {
    const stopped = notReady(record, [implemented.record.ref], "the implementer");
    if (stopped !== undefined) return stopped;
  }

  const digest = view.candidateDigest;
  if (digest === undefined) {
    return supervise({ reason: "the controller reports no candidate digest for the worktree" }, "escalate a missing candidate digest", JSON.stringify(state));
  }
  // The checks below are genuinely candidate-anchored: RED, GREEN, the build
  // suite and the changelog entry are all earned once per workspace change
  // and stay valid, unscoped by generation, until the candidate changes again.
  // A check that failed (or, for RED, could not run) before the operator's latest
  // resume is the exception: the operator resumed because something changed
  // (often the environment), so it runs again, once. A failure recorded since
  // the resume is acted on below, so a failing check cannot loop.
  const current = forIdentity(view.evidence, digest);
  const test = record?.test;
  const results = evaluateFix(ctx, view, current, digest);
  const decisions = results.find((r) => r.requirementId === REQUIREMENT_DECISIONS)!;
  if (record !== undefined && test !== undefined && decisions.result.status === "passed") {
    const changes = profile.changelog?.path;
    if (changes !== undefined && latestFile(current, changes, digest) === undefined) {
      return withPrivate(observe({ paths: [changes] }, `observe ${changes} for the current change`), state);
    }
    // Runs of this test only: the record may rename it without changing the candidate.
    const argv = profile.runner.argv(test);
    const green = latestCheckoutRun(current, COMMAND.regression, "candidate", digest, argv);
    // A profile with cheap commands checks in two jobs: GREEN and the cheap
    // commands first, the full commands only once those passed.
    const tiered = isTiered(profile);
    const first = tiered ? "cheap" : undefined;
    const firstCommands = tiered ? commandsInTier(profile, "cheap") : profile.commands;
    if (green === undefined || failedBeforeResume(current, green, firstCommands, view)) {
      return withPrivate(
        dispatch(
          checkJob(tiered ? "Cheap candidate checks" : "Candidate checks", { from: "candidate" }, candidateCommands(profile, test, first), true),
          green === undefined
            ? tiered ? "run GREEN and the cheap checks on the committed change" : "run GREEN and the build checks on the committed change"
            : "run GREEN and the " + (tiered ? "cheap" : "build") + " checks again: they failed before the operator's resume",
        ),
        state,
      );
    }
    // The cheap tier failing sends the correction back with that evidence; neither RED nor the full tier is paid for.
    const cheapFailed = tiered && !tierPassed(current, green, firstCommands, profile, test);
    const tests = green.checkout!.paths.filter((p) => isTestPath(profile, p));
    if (!cheapFailed && tests.length > 0) {
      const baseRed = latestCheckoutRun(current, COMMAND.regression, "base", digest, argv);
      if (baseRed === undefined || blockedBeforeResume(profile, baseRed, test, view)) {
        return withPrivate(
          dispatch(
            checkJob("RED check", { from: "base", paths: tests }, redCommands(profile, test), false),
            baseRed === undefined ? "run RED on the base commit with only the test files" : "run RED on the base commit again: it could not run before the operator's resume",
          ),
          state,
        );
      }
      // The base commit plus only the test files could not even build it:
      // the test depends on something this round's change added. Ask for a
      // patch undoing just the behavioral fix, then retry RED against the
      // full candidate with that patch reverted, instead of looping the
      // implementer on a generic "fix your code" correction that misdiagnoses
      // a structurally unfair check as a real defect.
      if (regressionBlocked(profile, baseRed, test)) {
        // A patch is only good for the candidate it was written against: the
        // implementer's record names a digest, and a patch the controller
        // already reported as not applying is dead until replaced.
        const stalePatch = staleRevertPatch(record, implemented.record.candidateDigest, digest, current);
        if (record.revertPatch === undefined || stalePatch !== undefined) {
          // Bounded exactly like a generic correction, so an implementer that
          // never supplies a working patch still lands on the supervisor
          // instead of looping forever: once exhausted, fall through below.
          if (state.corrections < MAX_FIX_CORRECTIONS && view.budgets.corrections > 0) {
            return implementer(
              implementJob(ctx, view, issue, record, revertPatchAsk(test, stalePatch)),
              stalePatch === undefined
                ? "ask the implementer for a patch reverting just this round's behavioral fix, since RED's base-commit checkout cannot build the test alone"
                : "ask the implementer for a fresh revert patch, since the recorded one does not fit the current candidate",
              { ...state, corrections: state.corrections + 1 },
            );
          }
        } else {
          const reverted = latestRevertedCheckoutRun(current, COMMAND.regression, digest, argv);
          if (reverted === undefined || blockedBeforeResume(profile, reverted, test, view)) {
            return withPrivate(
              dispatch(
                checkJob("RED check (reverted)", { from: "candidate", revertPatch: record.revertPatch }, redCommands(profile, test), false),
                reverted === undefined ? "run RED against the candidate with this round's behavioral fix reverted" : "run RED against the reverted candidate again: it could not run before the operator's resume",
              ),
              state,
            );
          }
        }
      }
    }
  }

  // The full tier runs once, on a candidate whose cheap tier passed and whose
  // other requirements do not already fail; Fix is accepted only when the
  // validators find both tiers' commands passed on this same digest.
  let skipped: string[] = [];
  if (record !== undefined && test !== undefined && decisions.result.status === "passed" && isTiered(profile)) {
    const green = latestCheckoutRun(current, COMMAND.regression, "candidate", digest, profile.runner.argv(test));
    const full = commandsInTier(profile, "full");
    if (green !== undefined && full.length > 0) {
      const runs = full.map((c) => sameCheckoutJob(current, green, c.id));
      // `passes` and `builds` judge commands of both tiers: they fail while the full tier has not run, which is no reason to hold it back.
      const failedElsewhere = results.some((r) => r.requirementId !== REQUIREMENT_BUILDS && r.requirementId !== REQUIREMENT_PASSES && r.result.status === "failed");
      if (!tierPassed(current, green, commandsInTier(profile, "cheap"), profile, test) || failedElsewhere) {
        skipped = full.filter((_, i) => runs[i] === undefined).map((c) => c.id);
      } else if (runs.some((r) => r === undefined) || failedBeforeResume(current, green, full, view)) {
        return withPrivate(
          dispatch(
            checkJob("Full candidate checks", { from: "candidate" }, candidateCommands(profile, test, "full"), true),
            runs.some((r) => r === undefined) ? "run the full checks: the cheap tier passed on this change" : "run the full checks again: they failed before the operator's resume",
          ),
          state,
        );
      }
    }
  }

  if (results.every((r) => r.result.status === "passed")) {
    // Before the change is accepted, and so before code review is paid for: every acceptance item is covered.
    const uncovered = acceptanceStep(ctx, view, issue, state, plan.record, record, current, digest, implementer);
    if (uncovered !== undefined) return uncovered;
    return withPrivate(validate({ stageId: FIX_STAGE }, "validate Fix from the checks bound to the current change"), state);
  }
  const feedback = correctionFeedback(profile, current, digest, skipped.length > 0 ? results.filter((r) => r.result.status === "failed") : results);
  if (skipped.length > 0) feedback.push(`the full checks (${skipped.join(", ")}) did not run, because the cheap checks or another requirement failed on this change; they run once those pass`);
  if (state.corrections < MAX_FIX_CORRECTIONS && view.budgets.corrections > 0) {
    return implementer(
      implementJob(ctx, view, issue, record ?? plan.record, feedback),
      "correct the change with the failing evidence",
      { ...state, corrections: state.corrections + 1 },
    );
  }
  return supervise(
    { reason: `Fix still fails after ${state.corrections} corrections: ${feedback.slice(0, 3).join("; ")}`, evidenceRefs: current.map((e) => e.ref).slice(-10) },
    "hand the unresolved Fix stage to the supervisor",
    JSON.stringify(state),
  );
}

/**
 * The acceptance-coverage check (acceptance.ts): when the plan lists the
 * issue's acceptance items, the implementer's record must cover each with
 * files and tests that exist in the candidate. Reads the named files into the
 * evidence first, then judges without a model; a gap is a normal correction.
 * Undefined when the plan lists nothing or the change is covered.
 */
function acceptanceStep(
  ctx: Context,
  view: RunView,
  issue: number,
  state: FixPrivateState,
  plan: DecisionRecord,
  record: DecisionRecord | undefined,
  current: EvidenceRecord[],
  digest: string,
  implementer: (job: JobSpec, summary: string, next: FixPrivateState) => GraphDecision,
): GraphDecision | undefined {
  const items = acceptanceItems(plan);
  if (items.length === 0 || record === undefined) return undefined;
  const entries = coverageEntries(record);
  const unread = coverageFiles(entries).length > MAX_COVERAGE_FILES ? [] : observableCoverageFiles(entries).filter((p) => latestFile(current, p, digest) === undefined);
  if (unread.length > 0) return withPrivate(observe({ paths: unread }, "observe the files the implementer's coverage map names, for the acceptance-coverage check"), state);
  const read = (path: string) => {
    const file = latestFile(current, path, digest);
    if (file === undefined) return undefined;
    return file.record.fingerprint === "missing" ? { exists: false as const } : { exists: true as const, bytes: file.bytes };
  };
  const green = latestCheckoutRun(current, COMMAND.regression, "candidate", digest);
  const problems = coverageProblems(items, entries, read, green?.checkout?.paths ?? []);
  if (problems.length === 0) return undefined;
  const feedback = [coverageFeedback(problems)];
  if (state.corrections < MAX_FIX_CORRECTIONS && view.budgets.corrections > 0) {
    return implementer(implementJob(ctx, view, issue, record, feedback), "send the change back: the acceptance items are not all covered, so code review does not run", { ...state, corrections: state.corrections + 1 });
  }
  return supervise(
    { reason: `the change still does not cover every acceptance item after ${state.corrections} corrections: ${problems.slice(0, 3).join("; ")}`, evidenceRefs: current.map((e) => e.ref).slice(-10) },
    "hand the unresolved acceptance coverage to the supervisor",
    JSON.stringify(state),
  );
}

/**
 * Review convergence on the current change: review passes until one raises
 * nothing that survives verification, then the acceptance rule.
 */
function review(ctx: Context, view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const { profile, definition } = ctx;
  const digest = view.candidateDigest;
  if (digest === undefined) {
    return supervise({ reason: "the controller reports no candidate digest for the worktree" }, "escalate a missing candidate digest", JSON.stringify(state));
  }
  const current = forIdentity(view.evidence, view.candidateDigest);
  const currentRefs = new Set(current.map((e) => e.ref));
  // An implementer run the graph has not read the issues file after (a resume onto this version, a recovery dispatch).
  const unread = issuesReadStep(view, REVIEW_STAGE, state);
  if (unread !== undefined) return unread;
  const ledger = findingLedger(view.evidence);
  const passes = ledger.passes.filter((p) => p.digest === digest && currentRefs.has(p.run.record.ref));
  const last = passes.at(-1);
  // Rounds 1..MAX_DISCOVERY_ROUNDS may raise new findings; later rounds only verify the known ones.
  const { round, phase } = reviewPhase(ledger, digest);
  const verifying = phase === "verify-only";
  // Fix was accepted for this candidate, possibly before a resume moved the generation on.
  const record = implementerRecord(view.evidence).record!;
  const background = reviewBackground(profile, issueSnapshot(view.evidence, issue)!.issue, record);
  const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", digest);
  const reviewer = harnessName(profile.roles.reviewer);

  const pass = (sweep: boolean): GraphDecision => {
    const ocr = environmentOutput(view.evidence, "ocr");
    if (ocr === undefined) {
      return supervise({ reason: "the environment check recorded no open-code-review path for the code reviewer" }, "escalate a missing ocr path", JSON.stringify(state));
    }
    const base = green?.checkout?.base ?? "the run's base commit";
    // The reviewer may read the issues file; it reports in its result, and the graph applies that.
    const restore = issuesRestore(view, ledger, REVIEW_STAGE, state);
    if (restore !== undefined) return restore;
    const items = acceptanceItems(plannerRecord(view.evidence));
    const assignment = codeReviewInstruction(profile, {
      ocr,
      base,
      background,
      known: knownFindings(ledger),
      sweep,
      round,
      issues: { file: ISSUES_FILE, markdown: ISSUES_MARKDOWN },
      ...(items.length > 0 ? { acceptance: { items, coverage: coverageEntries(record) } } : {}),
    });
    const summary = verifying
      ? `verify the known findings on the change in review round ${round}, after the ${MAX_DISCOVERY_ROUNDS} discovery rounds (read-only)`
      : sweep
      ? `review the change again for critical or high issues the ${passes.length} earlier pass(es) missed (read-only)`
      : `review the change with ${reviewer} in open-code-review's delegation mode (read-only)`;
    return dispatchAgent(view, codeReviewJob(profile, assignment), summary, state);
  };
  if (last === undefined) return pass(false);
  // An unusable pass (incomplete coverage, a crash, a non-read-only run) is not
  // a verdict to re-evaluate forever: retry a fresh pass the same way a sweep
  // continuation would, bounded by the same cap, rather than reporting the
  // same stale coverage gap to the supervisor on every subsequent attempt.
  if (!passUsable(last) && passes.length < MAX_SWEEP_PASSES) return pass(false);

  const paths = pathsToObserve(ledger, digest);
  if (paths.length > 0) return withPrivate(observe({ paths }, "observe the lines a refutation quotes on the current change"), state);
  const pending = toVerify(ledger, digest);
  if (pending.length > 0) {
    const assignment = verificationInstruction(profile, { findings: pending, background, changed: green?.checkout?.paths ?? [] });
    return dispatchAgent(
      view,
      verificationJob(profile, assignment),
      `verify ${pending.map((f) => f.id).join(", ")} with a fresh read-only ${harnessName(profile.roles.verifier)} session`,
      state,
    );
  }
  const survived = last.raised.some((id) => {
    const s = findingById(ledger, id)?.state;
    return s === "confirmed" || s === "disputed";
  });
  // A verification round makes one usable pass per candidate: there is nothing new to sweep for.
  if (passUsable(last) && survived && !verifying && passes.length < MAX_SWEEP_PASSES) return pass(true);

  const statement = definition.requirements.find((r) => r.id === REQUIREMENT_REVIEW)!.statement;
  const history = view.evidence.filter((e) => e.candidateDigest !== undefined && e.candidateDigest !== view.candidateDigest);
  const result = codeReview.evaluate({ requirementId: REQUIREMENT_REVIEW, statement, evidence: current, history, candidateDigest: digest }) as ValidationResult;
  if (result.status === "passed") return withPrivate(validate({ stageId: REVIEW_STAGE }, "validate the reviewed change"), state);
  const refs = [...passes.map((p) => p.run.record.ref), ...ledger.verifications.filter((v) => v.digest === digest && currentRefs.has(v.run.record.ref)).map((v) => v.run.record.ref)];
  return supervise(
    { reason: `code review did not pass: ${result.reason}. ${roundSummary(ledger, digest, passes)}; ${view.budgets.agentInvocations} agent invocation(s) left`, evidenceRefs: refs.slice(-10) },
    "hand the code review findings to the supervisor",
    JSON.stringify(state),
  );
}

function deliver(ctx: Context, view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const { profile } = ctx;
  const current = forIdentity(view.evidence, view.candidateDigest);
  // A resume retries what failed (design-typescript-core.md §8): a delivery that failed before the
  // operator's latest resume is tried again, since the operator resumed because something changed
  // (the deliver command, the repository, its environment). A failure since the resume stops the
  // run, so a failing delivery cannot loop.
  const delivered = commandRuns(current, COMMAND.deliver)
    .filter((r) => r.record.candidateDigest === view.candidateDigest && (succeeded(r.command) || !isStaleFailure(r.record, view)))
    .at(-1);
  const branch = `fix/${issue}`;
  if (delivered === undefined) {
    // Leave the final table in the worktree for the operator; it stays out of the commit.
    const ledger = findingLedger(view.evidence);
    const restore = issuesRestore(view, ledger, REVIEW_STAGE, state);
    if (restore !== undefined) return restore;
    const record = implementerRecord(view.evidence).record!;
    const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", view.candidateDigest);
    const issueTitle = issueSnapshot(view.evidence, issue)?.issue.title ?? issueRef(profile, issue);
    const plan = plannerRecord(view.evidence);
    const body = pullRequestDescription(profile, {
      issue,
      issueTitle,
      record,
      ...(plan !== undefined ? { plan } : {}),
      verified: verifiedChecks(view.evidence, profile, view.candidateDigest).map(commandSummary),
      base: green?.checkout?.base ?? "",
      ...reviewSummary(profile, view),
      ...(ledger.issues.issues.length > 0 ? { issues: issueTableRows(ledger.issues.issues) } : {}),
    });
    return withPrivate(
      dispatch(
        {
          stageId: REVIEW_STAGE,
          kind: "command",
          purpose: "diagnostic",
          readOnly: true,
          instruction: `Put the change on ${branch}`,
          input: { commands: deliverCommands(branch, commitMessage(profile, { issue, issueTitle, record, ...(plan !== undefined ? { plan } : {}) }), body) },
        },
        `put the change on the local branch ${branch} and write the pull request body`,
      ),
      state,
    );
  }
  if (!succeeded(delivered.command)) {
    return stop(
      {
        reason: "delivery failed",
        blocker: `${describeCommand(delivered.command)}: ${outputTail(delivered.command, 500, profile.runner.reportOutput)}`,
        evidenceRefs: [delivered.record.ref],
        retryable: true,
      },
      `could not create ${branch}`,
    );
  }
  return stop(
    { reason: "complete", blocker: "none", evidenceRefs: [delivered.record.ref] },
    `the change is on ${branch}; the pull request body is the report of evidence ${delivered.record.ref}`,
  );
}

/** Agents act only on the whole issue snapshot; when it cannot be supplied, the run stops rather than work from part of it. */
function partialSnapshot(problem: string, refs: string[]): GraphDecision {
  return stop({ reason: "incompatible task", blocker: problem, evidenceRefs: refs, retryable: false }, "stop: the issue snapshot cannot be handed to the agents whole");
}

/** The test plan's line for the code review, and the dismissed findings a maintainer can overrule. */
function reviewSummary(profile: Profile, view: RunView): { review: string; dismissed: string[]; reviewFollowUps: string[] } {
  const ledger = findingLedger(view.evidence);
  const last = ledger.passes.filter((p) => p.digest === view.candidateDigest).at(-1);
  if (last?.report === undefined) return { review: "Code review did not produce a result.", dismissed: [], reviewFollowUps: [] };
  const { report } = last;
  const dismissed = ledger.findings.filter((f) => f.state === "dismissed");
  const fixed = ledger.findings.filter((f) => f.state === "fixed").length;
  const lower = report.comments.filter((c) => !isBlocking(c)).length;
  const by = `${harnessName(profile.roles.reviewer)} in open-code-review's delegation mode (${describeCoverage(report)})`;
  const settled = [
    ...(fixed > 0 ? [`${fixed} fixed during review`] : []),
    ...(dismissed.length > 0 ? [`${dismissed.length} refuted by an independent verifier, listed below`] : []),
  ];
  const later = ledger.followUps.length > 0 ? `; ${ledger.followUps.length} critical or high comment(s) raised after the ${MAX_DISCOVERY_ROUNDS} discovery rounds, listed as follow-ups` : "";
  const open =
    settled.length > 0 ? `no critical or high finding left open (${settled.join("; ")})` : later !== "" ? "no critical or high finding left open" : "no critical or high comments";
  return {
    review: report.comments.length === 0 && settled.length === 0 && later === "" ? `Reviewed by ${by}: no comments.` : `Reviewed by ${by}: ${open}${later}${lower > 0 ? `; ${lower} lower-severity comment(s) left for the reviewer` : ""}.`,
    dismissed: dismissed.map((f) => describeFinding(f)),
    reviewFollowUps: ledger.followUps.map(describeFollowUp),
  };
}

/** Why the run is back in Fix: the confirmed findings of the code review, when there are any. Dismissed and disputed ones never reach the implementer. */
function reentryFeedback(view: RunView): string[] {
  const ledger = findingLedger(view.evidence);
  // Driven by the issues file: open and reopened issues first, then the ones marked fixed that the reviewer has yet to verify.
  const status = (f: Finding) => issueById(ledger.issues, issueIdOf(f.id))?.status ?? "open";
  const unsettled = ledger.findings.filter((f) => f.state === "confirmed");
  const confirmed = [...unsettled.filter((f) => status(f) !== "fixed"), ...unsettled.filter((f) => status(f) === "fixed")];
  if (confirmed.length === 0) {
    return ["The run returned to Fix after a resume or a supervisor decision. Check the plan against the current code and the change in the working tree."];
  }
  const current = view.candidateDigest;
  const shown = confirmed.slice(0, 10);
  const tracked = ledger.issues.issues.length > 0;
  const line = (f: Finding) => {
    const s = status(f);
    const label = s === "fixed" ? "fixed by you, not yet verified by the reviewer" : s;
    return tracked ? describeFinding(f, current).replace(/^(I\d+) /, `$1 [${label}] `) : describeFinding(f, current);
  };
  // The implementer's last pass left the candidate byte-identical while the
  // reviewer, reading that very code, still reports findings: repeating the
  // same feedback would get the same "already fixed" answer (live run
  // 4c70ff66-dd9, gens 12 and 14), so say plainly that nothing changed.
  const recheckedHere = current !== undefined && lastPassChangedNothing(view) ? shown.filter((f) => stillPresentNote(f)?.digest === current) : [];
  return [
    `Code review of your previous change found ${confirmed.length} critical or high defect(s), each confirmed by an independent verifier:`,
    ...(recheckedHere.length > 0
      ? [
          `Your last pass changed nothing: the candidate is byte-identical (digest ${shortDigest(current!)}) to the code the reviewer re-checked. The reviewer re-checked the current code and still reports ${listAnd(recheckedHere.map((f) => issueIdOf(f.id)))} as present, so its latest note below describes the code in your working tree, not an earlier revision. Fix what that note names; if you are sure a finding is wrong, say why in your decision record with file:line evidence from the current tree.`,
        ]
      : []),
    ...(tracked ? [`They are the open, reopened and fixed issues in ${ISSUES_FILE}; when you fix one, mark it there as described below.`] : []),
    ...shown.map(line),
  ];
}

/** The newest completed implementer pass left the candidate as the one before it did. */
function lastPassChangedNothing(view: RunView): boolean {
  const work = agentRuns(view.evidence, FIX_STAGE, "work").filter((r) => r.status === "completed");
  const [before, last] = work.slice(-2);
  return before !== undefined && last !== undefined && last.record.candidateDigest !== undefined && last.record.candidateDigest === before.record.candidateDigest;
}

/** A plan or implementer that cannot proceed stops the run with its question. */
function notReady(record: DecisionRecord, refs: string[], who: string): GraphDecision | undefined {
  if (record.status === "ready") return undefined;
  const reason = record.status === "blocked" ? "needs maintainer decision" : "cannot reproduce";
  const question = record.draftComment?.trim() || record.openQuestions[0] || record.summary;
  return stop({ reason, blocker: question.slice(0, 1_000), evidenceRefs: refs, retryable: false }, `${who} returned ${record.status}: ${record.summary.slice(0, 200)}`);
}

/** RED's checkout did not even run the named test: a reason to ask for a revert patch, not a generic correction. */
function regressionBlocked(profile: Profile, run: CommandRun, test: NonNullable<DecisionRecord["test"]>): boolean {
  const outcome = profile.runner.outcome(reportText(run), test);
  return outcome === "build-failed" || outcome === "setup-failed";
}

/** A RED run that could not run (it did not execute, or the test never ran), from before the operator's latest resume: run it again. */
function blockedBeforeResume(profile: Profile, run: CommandRun, test: NonNullable<DecisionRecord["test"]>, view: RunView): boolean {
  if (!isStaleFailure(run.record, view)) return false;
  // A RED that timed out, was aborted or could not start recorded nothing about the test.
  const { timedOut, aborted, spawnError } = run.command;
  return timedOut === true || aborted === true || spawnError !== undefined || regressionBlocked(profile, run, test) || profile.runner.outcome(reportText(run), test) === "not-run";
}

/**
 * Whether GREEN and every one of `commands` ran clean and succeeded in the same checkout, and the runner's own
 * reading of GREEN's report says the named test passed (an exit 0 that never ran it does not count); a command
 * that did not run did not pass.
 */
function tierPassed(evidence: EvidenceRecord[], green: CommandRun, commands: ProfileCommand[], profile: Profile, test: NonNullable<DecisionRecord["test"]>): boolean {
  const ran = [green, ...commands.map((c) => sameCheckoutJob(evidence, green, c.id))].every((run) => run !== undefined && cleanRun(run) === undefined && succeeded(run.command));
  return ran && profile.runner.outcome(reportText(green), test) === "passed";
}

/** Whether a command of the candidate-checks job that produced `green` failed before the operator's latest resume. */
function failedBeforeResume(evidence: EvidenceRecord[], green: CommandRun, commands: ProfileCommand[], view: RunView): boolean {
  return [green, ...commands.map((c) => sameCheckoutJob(evidence, green, c.id))].some((run) => run !== undefined && !succeeded(run.command) && isStaleFailure(run.record, view));
}

/** Why the record's revertPatch cannot be used for the candidate at `digest`, or undefined when it can. */
function staleRevertPatch(record: DecisionRecord, recordedDigest: string | undefined, digest: string, current: EvidenceRecord[]): string | undefined {
  if (record.revertPatch === undefined) return undefined;
  if (recordedDigest !== undefined && recordedDigest !== digest) return "it was written against an earlier version of the candidate, which has changed since";
  const failure = latestRevertFailure(current, digest);
  if (failure !== undefined && failure.patch === record.revertPatch) {
    return `it does not apply (in reverse) to the current candidate: ${failure.error.slice(0, 300)}`;
  }
  return undefined;
}

/** Feedback asking the implementer for a patch undoing just this round's behavioral change. */
function revertPatchAsk(test: NonNullable<DecisionRecord["test"]>, stale?: string): string[] {
  return [
    ...(stale !== undefined ? [`Your earlier revertPatch cannot be used: ${stale}. Write a new one against the current candidate (the files as they are now) and include it in your decision record.`] : []),
    `RED could not build ${test.name} on the base commit with only the test file(s) applied: the test depends on something this change added to the production code (e.g. a new parameter, type or helper), which a bare test-file checkout does not have.`,
    'Add a "revertPatch" field to your decision record: a unified diff (`git diff` format, applying cleanly in reverse to the full candidate) that undoes only this round\'s specific behavioral change in the production code, keeping everything else — including anything the test itself depends on. Do not revert the test file; RED will apply this patch in reverse on the full candidate and expect the named test to then fail by assertion.',
  ];
}

function evaluateFix(ctx: Context, view: RunView, evidence: EvidenceRecord[], digest: string): Array<{ requirementId: string; result: ValidationResult }> {
  const { definition } = ctx;
  const stage = definition.stages.find((s) => s.id === FIX_STAGE)!;
  return stage.requirementIds.map((requirementId) => {
    const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
    const statement = definition.requirements.find((r) => r.id === requirementId)!.statement;
    const input = { requirementId, statement, evidence, candidateDigest: digest, config: view.config };
    return { requirementId, result: validatorById(binding.validatorId)!.evaluate(input) as ValidationResult };
  });
}

/** What the implementer needs to fix: each unmet requirement, with the failing command's output. */
function correctionFeedback(profile: Profile, evidence: EvidenceRecord[], digest: string, results: Array<{ requirementId: string; result: ValidationResult }>): string[] {
  const feedback = results.filter((r) => r.result.status !== "passed").map((r) => `${r.requirementId}: ${r.result.reason}`);
  const runs = [latestCheckoutRun(evidence, COMMAND.regression, "base", digest), latestCheckoutRun(evidence, COMMAND.regression, "candidate", digest)];
  const green = runs[1];
  if (green !== undefined) {
    for (const c of profile.commands) runs.push(sameCheckoutJob(evidence, green, c.id));
  }
  const hint = profile.implementation.cleanCheckHint !== undefined ? ` (${profile.implementation.cleanCheckHint})` : "";
  const reported = new Set<string>();
  for (const run of runs) {
    if (run === undefined) continue;
    if (run.checkout !== undefined && run.checkout.mutations.length > 0 && !reported.has(run.checkout.commit)) {
      reported.add(run.checkout.commit);
      feedback.push(`the checks in the ${run.checkout.from} checkout left ${run.checkout.mutations.join(", ")} changed${hint}; make the change so the checks leave it unchanged`);
    }
    if (run.command.id === COMMAND.regression && run.checkout?.from === "base") continue;
    if (!succeeded(run.command)) {
      feedback.push(`${describeCommand(run.command)} in the ${run.checkout?.from ?? "worktree"} checkout:\n${outputTail(run.command, undefined, profile.runner.reportOutput)}`);
    }
  }
  return feedback;
}

/** A plan continues the implementer's session when there is one, so a revision keeps what the planner read. */
function planJob(ctx: Context, view: RunView, assignment: string): JobSpec {
  const from = implementerSession(view);
  return {
    jobId: IMPLEMENTER_JOB,
    stageId: FIX_STAGE,
    kind: "agent",
    purpose: "diagnostic",
    readOnly: true,
    instruction: "Plan the fix",
    resultSchema: "decision-record-v2",
    executor: CODING_AGENT,
    input: { assignment, harness: ctx.profile.roles.implementer },
    ...(from !== undefined ? { continueFrom: from } : {}),
  };
}

/** A fresh read-only session that reviews the change in the run worktree. */
function codeReviewJob(profile: Profile, assignment: string): JobSpec {
  return {
    stageId: REVIEW_STAGE,
    kind: "agent",
    purpose: "review",
    readOnly: true,
    instruction: "Review the code",
    resultSchema: "code-review-v2",
    executor: CODING_AGENT,
    input: { assignment, harness: profile.roles.reviewer },
  };
}

/** A fresh read-only session, on another model family than the reviewer, that has never written the change. */
function verificationJob(profile: Profile, assignment: string): JobSpec {
  return {
    stageId: REVIEW_STAGE,
    kind: "agent",
    purpose: "diagnostic",
    readOnly: true,
    instruction: "Verify the code review findings",
    resultSchema: "finding-verification-v1",
    executor: CODING_AGENT,
    input: { assignment, harness: profile.roles.verifier },
  };
}

function implementJob(ctx: Context, view: RunView, issue: number, given: DecisionRecord, feedback: string[] | undefined): JobSpec {
  const { profile } = ctx;
  // The implementer's own record may have dropped the planner's acceptance list; the list is the planner's.
  const planned = plannerRecord(view.evidence)?.acceptance;
  const record: DecisionRecord = given.acceptance === undefined && planned !== undefined ? { ...given, acceptance: planned } : given;
  const from = implementerSession(view);
  const table = findingLedger(view.evidence).issues;
  // The fixer's last edits to the issues file the graph refused, so it does not repeat them.
  const rejected = rejectedSinceLastWork(view, table).map((r) => `${ISSUES_FILE}: the graph rejected your edit and restored the file: ${r.note}.`);
  const all = [...rejected, ...(feedback ?? [])];
  return {
    jobId: IMPLEMENTER_JOB,
    stageId: FIX_STAGE,
    kind: "agent",
    purpose: "work",
    instruction: "Implement the fix",
    resultSchema: "decision-record-v2",
    writeScope: writeScopeFor(record, profile),
    executor: CODING_AGENT,
    input: {
      assignment: implementInstruction(profile, { issue, plan: record, ...(all.length > 0 ? { feedback: all } : {}), ...(table.issues.length > 0 ? { issues: true } : {}) }),
      harness: profile.roles.implementer,
    },
    ...(from !== undefined ? { continueFrom: from } : {}),
  };
}

/** Where a record sits in the run's evidence, or -1. */
const indexOf = (view: RunView, record: EvidenceRecord | undefined): number => (record === undefined ? -1 : view.evidence.findIndex((e) => e.ref === record.ref));

function lastIndexWhere(evidence: EvidenceRecord[], keep: (e: EvidenceRecord) => boolean): number {
  for (let i = evidence.length - 1; i >= 0; i -= 1) if (keep(evidence[i]!)) return i;
  return -1;
}

/** The newest record of an issues command, with what it says the worktree's file holds. */
function latestIssuesCommand(view: RunView): { record: EvidenceRecord; index: number; kind: "write" | "read"; ok: boolean; content: string | undefined } | undefined {
  for (let i = view.evidence.length - 1; i >= 0; i -= 1) {
    const record = view.evidence[i]!;
    const write = issueCommand(record, ISSUES_COMMAND.write);
    if (write !== undefined) return { record, index: i, kind: "write", ok: write.ok, content: writtenJson(write.argv) };
    const read = issueCommand(record, ISSUES_COMMAND.read);
    if (read !== undefined) {
      const present = read.stdout.trim().split("\n").at(-1)?.trim() === "present";
      return { record, index: i, kind: "read", ok: read.ok, content: present && read.report?.truncated !== true ? read.report?.text : undefined };
    }
  }
  return undefined;
}

const lastWork = (view: RunView): number => indexOf(view, agentRuns(view.evidence, FIX_STAGE, "work").at(-1)?.record);

/**
 * The graph handed the file out and an implementer ran since the last time it
 * read the file back: the fixer may have marked issues fixed.
 */
function issuesReadDue(view: RunView): boolean {
  const written = lastIndexWhere(view.evidence, (e) => issueCommand(e, ISSUES_COMMAND.write)?.ok === true);
  if (written < 0) return false;
  // Only a read that succeeded consumed the fixer's edits; a failed or timed-out one did not.
  const read = lastIndexWhere(view.evidence, (e) => issueCommand(e, ISSUES_COMMAND.read)?.ok === true);
  const work = lastWork(view);
  return work > written && work > read;
}

/** Failed reads after the last implementer run before the graph stops retrying. */
const MAX_FAILED_ISSUE_READS = 2;

/**
 * The read the fixer's last run still needs, or nothing: a failed read is
 * retried, and after MAX_FAILED_ISSUE_READS the supervisor decides, since
 * writing the accepted table over the unread file would lose the fixer's edits.
 */
function issuesReadStep(view: RunView, stageId: string, state: FixPrivateState): GraphDecision | undefined {
  if (!issuesReadDue(view)) return undefined;
  const work = lastWork(view);
  const failed = view.evidence.filter((e, i) => i > work && issueCommand(e, ISSUES_COMMAND.read)?.ok === false);
  if (failed.length >= MAX_FAILED_ISSUE_READS) {
    return supervise(
      { reason: `the graph could not read ${ISSUES_FILE} back after the fixer's last run (${failed.length} failed reads); it will not overwrite the fixer's unread edits`, evidenceRefs: failed.map((e) => e.ref) },
      "escalate an issues file the graph cannot read back",
      JSON.stringify(state),
    );
  }
  return withPrivate(
    dispatch(issuesJob(stageId, "read"), failed.length > 0 ? "retry reading back the fixer's edits to the review issues file" : "read back the fixer's edits to the review issues file"),
    state,
  );
}

/**
 * The job that brings the worktree's issues file in line with the table, before
 * an agent works from it, or undefined when it already is: the newest issues
 * command in this generation, after the last implementer run, shows exactly
 * the table's JSON. A resume or a reentry starts a new generation, so the file
 * is always rewritten from evidence before the next agent job.
 */
function issuesRestore(view: RunView, ledger: FindingLedger, stageId: string, state: FixPrivateState): GraphDecision | undefined {
  // Never write over fixer edits the graph has not read back.
  const unread = issuesReadStep(view, stageId, state);
  if (unread !== undefined) return unread;
  if (ledger.issues.issues.length === 0) return undefined;
  const { round, phase } = reviewPhase(ledger, view.candidateDigest ?? "");
  const json = issueFileJson(ledger.issues, { round, phase });
  const last = latestIssuesCommand(view);
  const fresh = last !== undefined && last.index > lastWork(view) && (last.record.generation ?? 0) === view.generation;
  if (fresh && last.ok && last.content === json) return undefined;
  if (fresh && !last.ok && last.kind === "write" && last.content === json) {
    return supervise({ reason: `the graph could not write ${ISSUES_FILE}`, evidenceRefs: [last.record.ref] }, "escalate a failed write of the issues file", JSON.stringify(state));
  }
  const markdown = issueMarkdown(ledger.issues, { round, phase, followUps: ledger.followUps.map(describeFollowUp) });
  const command = writeIssuesCommand(json, markdown);
  if (command === undefined) {
    return supervise({ reason: `${ISSUES_FILE} has grown larger than one command can write` }, "escalate an issues file too large to write", JSON.stringify(state));
  }
  const job = issuesJob(stageId, "write", command);
  const why =
    last === undefined
      ? "write the review issues file"
      : (last.record.generation ?? 0) !== view.generation
      ? "restore the review issues file from evidence after a resume or reentry"
      : "write the review issues file as the graph accepted it";
  return withPrivate(dispatch(job, `${why} (${ISSUES_FILE})`), state);
}

/** A read-only command job in the worktree that writes or reads the issues file; Git ignores the files it touches. */
function issuesJob(stageId: string, what: "write" | "read", command: EnvironmentCommand = readIssuesCommand()): JobSpec {
  return {
    stageId,
    kind: "command",
    purpose: "diagnostic",
    readOnly: true,
    instruction: what === "write" ? "Write the review issues file" : "Read back the review issues file",
    input: { commands: [command] },
  };
}

/** The rejections the latest read recorded, when no implementer has run since. */
function rejectedSinceLastWork(view: RunView, table: IssueTable): Rejection[] {
  const read = lastIndexWhere(view.evidence, (e) => issueCommand(e, ISSUES_COMMAND.read)?.ok === true);
  if (read < 0 || read < lastWork(view)) return [];
  const ref = view.evidence[read]!.ref;
  return table.rejections.filter((r) => r.evidence === ref);
}

/** The newest implementer session, which no later job has continued. */
function implementerSession(view: RunView): string | undefined {
  const sessions = (view.agentSessions ?? []).filter((s) => s.stageId === FIX_STAGE && s.dispatchKey === IMPLEMENTER_JOB && s.generation <= view.generation);
  const continued = new Set(sessions.map((s) => s.continuedFrom).filter((s) => s !== undefined));
  return sessions.filter((s) => !continued.has(s.operationId)).at(-1)?.operationId;
}

function githubJob(executor: NonNullable<JobSpec["executor"]>, instruction: string, input: Record<string, unknown>): JobSpec {
  return { stageId: FIX_STAGE, kind: "command", purpose: "diagnostic", readOnly: true, instruction, executor, input };
}

function checkJob(instruction: string, checkout: NonNullable<JobSpec["checkout"]>, commands: ReturnType<typeof candidateCommands>, continueOnFailure: boolean): JobSpec {
  return {
    stageId: FIX_STAGE,
    kind: "command",
    purpose: "check",
    readOnly: true,
    instruction,
    checkout,
    input: { commands, ...(continueOnFailure ? { continueOnFailure: true } : {}) },
  };
}

function readPrivate(view: RunView): FixPrivateState {
  const blank: FixPrivateState = { attempt: view.current.attempt, attemptGeneration: view.generation, corrections: 0 };
  if (!view.privateState) return blank;
  try {
    const saved = JSON.parse(view.privateState) as Partial<FixPrivateState>;
    // Same attempt as last observed: a resume may have bumped view.generation
    // since, but Fix was not reentered, so attemptGeneration (and corrections
    // count) carry forward unchanged rather than re-pinning to the new one.
    return saved.attempt === view.current.attempt && saved.attemptGeneration !== undefined
      ? { attempt: view.current.attempt, attemptGeneration: saved.attemptGeneration, corrections: saved.corrections ?? 0 }
      : blank;
  } catch {
    return blank;
  }
}

/** Only agent work spends an invocation; checks and validation stay open after the last one. */
function dispatchAgent(view: RunView, job: JobSpec, summary: string, state: FixPrivateState): GraphDecision {
  if (view.budgets.agentInvocations <= 0) {
    return stop({ reason: "budgets exhausted", blocker: "no agent invocations left", retryable: false }, `cannot ${summary}`);
  }
  return withPrivate(dispatch(job, summary), state);
}

function withPrivate(decision: GraphDecision, state: FixPrivateState): GraphDecision {
  return { ...decision, privateState: JSON.stringify(state) };
}
