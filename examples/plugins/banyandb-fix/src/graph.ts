import {
  dispatch,
  observe,
  stop,
  supervise,
  validate,
  type EvidenceRecord,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type RunView,
  type ValidationResult,
} from "@graphloom/sdk";
import {
  CHANGES_PATH,
  CODE_REVIEWER_HARNESS,
  CODING_AGENT,
  COMMAND,
  ENVIRONMENT,
  FIX_STAGE,
  GET_ISSUE,
  IMPLEMENTER_HARNESS,
  IMPLEMENTER_JOB,
  ISSUE_REPO,
  LIST_ISSUE_COMMENTS,
  MAX_FINDING_ROUNDS,
  MAX_FIX_CORRECTIONS,
  MAX_PLAN_REVIEW_ROUNDS,
  MAX_SWEEP_PASSES,
  REQUIREMENT_BUILDS,
  REQUIREMENT_CHANGELOG,
  REQUIREMENT_DECISIONS,
  REQUIREMENT_PASSES,
  REQUIREMENT_PLAN_REVIEW,
  REQUIREMENT_REPRODUCES,
  REQUIREMENT_REVIEW,
  REQUIREMENT_SCOPE,
  REVIEW_STAGE,
  REVIEWER_HARNESS,
  VERIFIER_HARNESS,
} from "./constants.js";
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
  latestReview,
  outputTail,
  reviews,
  sameCheckoutJob,
  succeeded,
  type ReviewVerdict,
} from "./evidence.js";
import {
  describeFinding,
  findingById,
  findingLedger,
  knownFindings,
  passUsable,
  pathsToObserve,
  roundSummary,
  toVerify,
  VERIFICATION_SCHEMA,
  verificationInstruction,
} from "./findings.js";
import { CODE_REVIEW_SCHEMA, codeReviewInstruction, describeCoverage, isBlocking, reviewBackground } from "./ocr.js";
import {
  describePlanFinding,
  knownPlanFindings,
  pathsToObservePlan,
  planFindingLedger,
  planVerificationInstruction,
  PLAN_REVIEW_SCHEMA,
  toVerifyPlan,
  type PlanLedger,
  type PlanReviewPass,
} from "./plan-findings.js";
import {
  candidateCommands,
  commitMessage,
  deliverCommands,
  implementInstruction,
  issueRef,
  planInstruction,
  planReviewInstruction,
  planRevisionInstruction,
  pullRequestDescription,
  redCommands,
  snapshotText,
} from "./prompts.js";
import { codeReview, implementerRecord, isTestPath, planReviewed, validatorById } from "./validators.js";

/** Graph bookkeeping; everything else is read back from recorded evidence. */
export interface FixPrivateState {
  generation: number;
  /** Corrections the graph dispatched in Fix in this generation. */
  corrections: number;
}

const definition: GraphDefinition = {
  graphId: "banyandb-fix",
  version: "0.4.0",
  privateStateSchema: "banyandb-fix-private-v1",
  stages: [
    {
      id: FIX_STAGE,
      name: "Fix",
      requirementIds: [
        REQUIREMENT_PLAN_REVIEW,
        REQUIREMENT_DECISIONS,
        REQUIREMENT_REPRODUCES,
        REQUIREMENT_PASSES,
        REQUIREMENT_BUILDS,
        REQUIREMENT_SCOPE,
        REQUIREMENT_CHANGELOG,
      ],
    },
    { id: REVIEW_STAGE, name: "Review", requirementIds: [REQUIREMENT_REVIEW] },
  ],
  requirements: [
    {
      id: REQUIREMENT_PLAN_REVIEW,
      statement:
        "A fresh read-only reviewer reviewed the current plan record, following the plan the implementer followed, on the spec, decisions, reach and test axes, and gave a status for every finding the planner had a chance to answer; every finding that pass raised was dismissed or resolved; no plan finding of this generation is confirmed or disputed; and the reviewer approved.",
      evidenceSchema: "review-verdict-v1",
      // The plan itself, not this requirement's own review-verdict evidence:
      // a revised plan must be reviewed again even with unchanged workspace bytes.
      identityArtifactSchema: "decision-record-v1",
    },
    {
      id: REQUIREMENT_DECISIONS,
      statement:
        "The implementer's decision record is ready, names the regression test and the production caller, gives every unclear point a tier and a basis, takes an option for every behaviour point, and marks no product point chosen.",
      evidenceSchema: "decision-record-v1",
      identityArtifactSchema: "decision-record-v1",
    },
    {
      id: REQUIREMENT_REPRODUCES,
      statement:
        "In a prepared checkout of the base commit with only the change's test files applied, the named regression test fails by assertion (go test -json reports it failed, and the package built), and the check changed no file.",
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_PASSES,
      statement:
        "In a prepared checkout of the full change, the named regression test passes and make test-ci passes for the changed Go packages, and the checks changed no file.",
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_BUILDS,
      statement: "In the same checkout of the full change, make license-check, make build, make lint and make check all pass and change no file.",
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_SCOPE,
      statement:
        "Every changed path is inside the repository and outside api/proto, go.mod, go.sum and .github, except those the decision record names with a reason.",
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_CHANGELOG,
      statement: "The change adds a list entry to CHANGES.md inside its first \"## \" release section.",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: REQUIREMENT_REVIEW,
      statement:
        "The latest read-only Codex review pass on the current change, following open-code-review's delegation workflow in this generation, reviewed every changed file, test files included, skipped none, and gave a status for every open finding; every critical or high finding it raised was refuted by an independent read-only verifier with quotes that match the change; and no finding of the run is confirmed and unfixed, disputed, or awaiting verification.",
      evidenceSchema: "code-review-v2",
    },
  ],
  defaultValidators: [
    { requirementId: REQUIREMENT_PLAN_REVIEW, validatorId: "plan-reviewer", version: "2", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_DECISIONS, validatorId: "decisions-recorded", version: "1" },
    { requirementId: REQUIREMENT_REPRODUCES, validatorId: "red-reproduces", version: "1" },
    { requirementId: REQUIREMENT_PASSES, validatorId: "green-passes", version: "1" },
    { requirementId: REQUIREMENT_BUILDS, validatorId: "build-checks", version: "1" },
    { requirementId: REQUIREMENT_SCOPE, validatorId: "write-scope", version: "1" },
    { requirementId: REQUIREMENT_CHANGELOG, validatorId: "changes-entry", version: "1" },
    { requirementId: REQUIREMENT_REVIEW, validatorId: "open-code-review", version: "2" },
  ],
  environment: ENVIRONMENT,
};

export function createGraph(): GraphPlugin {
  return {
    describe: () => JSON.parse(JSON.stringify(definition)) as GraphDefinition,
    advance: advanceFix,
  };
}

/** The issue the request names: `apache/skywalking#N`, or the first `#N`. */
export function requestedIssue(request: string): number | undefined {
  const match = /apache\/skywalking#(\d+)/.exec(request) ?? /#(\d+)\b/.exec(request);
  return match !== null ? Number(match[1]) : undefined;
}

export function advanceFix(view: RunView): GraphDecision {
  const issue = requestedIssue(view.task.request);
  if (issue === undefined) {
    return stop({ reason: "incompatible task", blocker: "the request names no apache/skywalking issue" }, "reject a request without an issue");
  }
  const state = readPrivate(view);
  const stage = definition.stages.find(
    (s) =>
      !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) ||
      view.openAttempt?.[s.id] === true,
  );
  if (stage === undefined) return deliver(view, issue, state);
  return stage.id === FIX_STAGE ? fix(view, issue, state) : review(view, issue, state);
}

function fix(view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const snapshot = issueSnapshot(view.evidence, issue);
  if (snapshot === undefined) {
    return withPrivate(dispatch(githubJob(GET_ISSUE, "Fetch the issue", { ...ISSUE_REPO, number: issue }), `fetch ${issueRef(issue)}`), state);
  }
  const comments = issueComments(view.evidence);
  if (comments === undefined) {
    return withPrivate(
      dispatch(githubJob(LIST_ISSUE_COMMENTS, "Fetch the issue comments", { ...ISSUE_REPO, number: issue, perPage: 100, maxPages: 5 }), `fetch the comments on ${issueRef(issue)}`),
      state,
    );
  }
  const snapshotResult = snapshotText(snapshot.issue, comments.comments, comments.complete);
  if ("problem" in snapshotResult) return partialSnapshot(snapshotResult.problem, [snapshot.record.ref, comments.record.ref]);
  const snapshotBody = snapshotResult.text;
  // Scoped to this attempt (generation), not the live candidate digest: the
  // plan and its review predate any workspace change (the implementer has
  // not run yet when they are accepted), and the later command checks
  // already scope themselves to `digest` explicitly (latestCheckoutRun,
  // latestFile, correctionFeedback). Filtering by candidateDigest here would
  // exclude the plan's own evidence the moment the implementer's first edit
  // changes it, making Fix look like it has no plan yet on every pass; not
  // filtering at all would instead carry a stale, already-superseded plan
  // and its approval straight through a reentry. Generation is exactly the
  // fence between this attempt and a prior one it needs here.
  const current = view.evidence.filter((e) => e.generation === view.generation);

  const planRun = agentRuns(current, FIX_STAGE, "diagnostic").filter((r) => r.status === "completed").at(-1);
  if (planRun === undefined) {
    const revisit = agentRuns(view.evidence, FIX_STAGE, "diagnostic").some((r) => r.status === "completed");
    const assignment = revisit
      ? planRevisionInstruction({ issue, feedback: reentryFeedback(view), changed: agentRuns(view.evidence, FIX_STAGE, "work").length > 0 })
      : planInstruction({ issue, request: view.task.request, snapshot: snapshotBody });
    return dispatchAgent(view, planJob(view, assignment), revisit ? "revisit the plan after returning to Fix (read-only)" : "plan the fix (read-only)", state);
  }
  const plan = parseDecisionRecord(planRun.output);
  if ("problem" in plan) {
    return supervise({ reason: `the plan returned no valid decision record: ${plan.problem}`, evidenceRefs: [planRun.record.ref] }, "escalate an invalid plan", JSON.stringify(state));
  }
  const blocked = notReady(plan.record, [planRun.record.ref], "the plan");
  if (blocked !== undefined) return blocked;

  const ledger = planFindingLedger(current, FIX_STAGE);
  const planReviews = reviews(current, FIX_STAGE);
  const reviewed = planReviews.filter((r) => current.indexOf(r.record) > current.indexOf(planRun.record)).at(-1);
  if (reviewed === undefined) {
    const earlier = planReviews.at(-1);
    const earlierPass = earlier !== undefined ? ledger.passes.find((p) => p.record.ref === earlier.record.ref) : undefined;
    const previous = earlierPass !== undefined ? planFeedback(ledger, earlierPass) : agentRuns(view.evidence, FIX_STAGE, "work").length > 0 ? reentryFeedback(view) : undefined;
    return dispatchAgent(
      view,
      planReviewJob(planReviewInstruction({ issue, snapshot: snapshotBody, record: plan.record, known: knownPlanFindings(ledger), ...(previous !== undefined ? { previous } : {}) })),
      "dispatch a fresh read-only reviewer for the plan",
      state,
    );
  }
  const planPass = ledger.passes.find((p) => p.record.ref === reviewed.record.ref)!;
  if (planPass.productDecision !== undefined && planPass.verdict !== "approved") {
    return supervise(
      { reason: `the plan reviewer named a product decision an agent must not make: ${planPass.productDecision}`, evidenceRefs: [planPass.record.ref] },
      "hand a reviewer's product decision to the supervisor",
      JSON.stringify(state),
    );
  }
  const planAwaiting = pathsToObservePlan(ledger);
  if (planAwaiting.length > 0) return withPrivate(observe({ paths: planAwaiting }, "observe the lines a plan-review refutation quotes"), state);
  const pendingPlanVerification = toVerifyPlan(ledger);
  if (pendingPlanVerification.length > 0) {
    const background = reviewBackground(snapshot.issue, plan.record);
    const assignment = planVerificationInstruction({ findings: pendingPlanVerification, background, changed: [] });
    return dispatchAgent(
      view,
      planVerificationJob(assignment),
      `verify plan finding(s) ${pendingPlanVerification.map((f) => f.id).join(", ")} with a fresh read-only session`,
      state,
    );
  }
  const stuckPlanFinding = ledger.findings.find((f) => (f.state === "confirmed" || f.state === "disputed") && f.rounds >= MAX_FINDING_ROUNDS);
  if (stuckPlanFinding !== undefined || planReviews.length >= MAX_PLAN_REVIEW_ROUNDS) {
    return supervise(
      {
        reason:
          stuckPlanFinding !== undefined
            ? `plan finding ${stuckPlanFinding.id} is still unresolved after ${stuckPlanFinding.rounds} round(s): ${describePlanFinding(stuckPlanFinding)}`
            : `the plan review has run ${planReviews.length} passes in this generation without converging`,
        evidenceRefs: [...planReviews.map((r) => r.record.ref), ...ledger.verifications.map((v) => v.record.ref)].slice(-10),
      },
      "hand the disputed plan to the supervisor",
      JSON.stringify(state),
    );
  }
  const planReviewStatement = definition.requirements.find((r) => r.id === REQUIREMENT_PLAN_REVIEW)!.statement;
  const planResult = planReviewed.evaluate({
    requirementId: REQUIREMENT_PLAN_REVIEW,
    statement: planReviewStatement,
    evidence: current,
    ...(view.candidateDigest !== undefined ? { candidateDigest: view.candidateDigest } : {}),
  }) as ValidationResult;
  if (planResult.status !== "passed") {
    return dispatchAgent(
      view,
      planJob(view, planRevisionInstruction({ issue, feedback: planFeedback(ledger, planPass), changed: agentRuns(view.evidence, FIX_STAGE, "work").length > 0 })),
      "revise the plan with the reviewer's findings",
      state,
    );
  }

  const implemented = agentRuns(current, FIX_STAGE, "work").at(-1);
  if (implemented === undefined || implemented.status !== "completed") {
    return dispatchAgent(
      view,
      implementJob(view, issue, plan.record, undefined),
      implemented === undefined ? "implement the reviewed plan, continuing the plan session" : "retry the implementation",
      state,
    );
  }
  const record = implementerRecord(current).record;
  if (record !== undefined) {
    const stopped = notReady(record, [implemented.record.ref], "the implementer");
    if (stopped !== undefined) return stopped;
  }

  const digest = view.candidateDigest;
  if (digest === undefined) {
    return supervise({ reason: "the controller reports no candidate digest for the worktree" }, "escalate a missing candidate digest", JSON.stringify(state));
  }
  const test = record?.test;
  const results = evaluateFix(current, digest);
  const decisions = results.find((r) => r.requirementId === REQUIREMENT_DECISIONS)!;
  if (record !== undefined && test !== undefined && decisions.result.status === "passed") {
    if (latestFile(current, CHANGES_PATH, digest) === undefined) {
      return withPrivate(observe({ paths: [CHANGES_PATH] }, `observe ${CHANGES_PATH} for the current change`), state);
    }
    const green = latestCheckoutRun(current, COMMAND.regression, "candidate", digest);
    if (green === undefined) {
      return withPrivate(
        dispatch(checkJob("Candidate checks", { from: "candidate" }, candidateCommands(test), true), "run GREEN and the build checks on the committed change"),
        state,
      );
    }
    const tests = green.checkout!.paths.filter(isTestPath);
    if (tests.length > 0 && latestCheckoutRun(current, COMMAND.regression, "base", digest) === undefined) {
      return withPrivate(
        dispatch(checkJob("RED check", { from: "base", paths: tests }, redCommands(test), false), "run RED on the base commit with only the test files"),
        state,
      );
    }
  }

  if (results.every((r) => r.result.status === "passed")) {
    return withPrivate(validate({ stageId: FIX_STAGE }, "validate Fix from the checks bound to the current change"), state);
  }
  const feedback = correctionFeedback(current, digest, results);
  if (state.corrections < MAX_FIX_CORRECTIONS && view.budgets.corrections > 0) {
    return dispatchAgent(
      view,
      implementJob(view, issue, record ?? plan.record, feedback),
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
 * Review convergence on the current change: review passes until one raises
 * nothing that survives verification, then the acceptance rule.
 */
function review(view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const digest = view.candidateDigest;
  if (digest === undefined) {
    return supervise({ reason: "the controller reports no candidate digest for the worktree" }, "escalate a missing candidate digest", JSON.stringify(state));
  }
  const current = forIdentity(view.evidence, view.candidateDigest);
  const currentRefs = new Set(current.map((e) => e.ref));
  const ledger = findingLedger(view.evidence);
  const passes = ledger.passes.filter((p) => p.digest === digest && currentRefs.has(p.run.record.ref));
  const last = passes.at(-1);
  // Fix was accepted for this candidate, possibly before a resume moved the generation on.
  const record = implementerRecord(view.evidence).record!;
  const background = reviewBackground(issueSnapshot(view.evidence, issue)!.issue, record);
  const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", digest);

  const pass = (sweep: boolean): GraphDecision => {
    const ocr = environmentOutput(view.evidence, "ocr");
    if (ocr === undefined) {
      return supervise({ reason: "the environment check recorded no open-code-review path for the code reviewer" }, "escalate a missing ocr path", JSON.stringify(state));
    }
    const base = green?.checkout?.base ?? "the run's base commit";
    const assignment = codeReviewInstruction({ ocr, base, background, known: knownFindings(ledger), sweep });
    const summary = sweep
      ? `review the change again for critical or high issues the ${passes.length} earlier pass(es) missed (read-only)`
      : "review the change with Codex in open-code-review's delegation mode (read-only)";
    return dispatchAgent(view, codeReviewJob(assignment), summary, state);
  };
  if (last === undefined) return pass(false);

  const paths = pathsToObserve(ledger, digest);
  if (paths.length > 0) return withPrivate(observe({ paths }, "observe the lines a refutation quotes on the current change"), state);
  const pending = toVerify(ledger, digest);
  if (pending.length > 0) {
    const assignment = verificationInstruction({ findings: pending, background, changed: green?.checkout?.paths ?? [] });
    return dispatchAgent(view, verificationJob(assignment), `verify ${pending.map((f) => f.id).join(", ")} with a fresh read-only Claude Code session`, state);
  }
  const survived = last.raised.some((id) => {
    const s = findingById(ledger, id)?.state;
    return s === "confirmed" || s === "disputed";
  });
  if (passUsable(last) && survived && passes.length < MAX_SWEEP_PASSES) return pass(true);

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

function deliver(view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const current = forIdentity(view.evidence, view.candidateDigest);
  const delivered = commandRuns(current, COMMAND.deliver).filter((r) => r.record.candidateDigest === view.candidateDigest).at(-1);
  const branch = `fix/${issue}`;
  if (delivered === undefined) {
    const record = implementerRecord(view.evidence).record!;
    // An approved plan does not depend on the answer; the pull request asks it.
    const asked = latestReview(view.evidence, FIX_STAGE)?.productDecision;
    const openQuestions = asked !== undefined && !record.openQuestions.includes(asked) ? [...record.openQuestions, asked] : record.openQuestions;
    const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", view.candidateDigest);
    const issueTitle = issueSnapshot(view.evidence, issue)?.issue.title ?? issueRef(issue);
    const body = pullRequestDescription({
      issue,
      issueTitle,
      record: { ...record, openQuestions },
      base: green?.checkout?.base ?? "",
      ...reviewSummary(view),
    });
    return withPrivate(
      dispatch(
        {
          stageId: REVIEW_STAGE,
          kind: "command",
          purpose: "diagnostic",
          readOnly: true,
          instruction: `Put the change on ${branch}`,
          input: { commands: deliverCommands(branch, commitMessage({ issue, issueTitle, record }), body) },
        },
        `put the change on the local branch ${branch} and write the pull request body`,
      ),
      state,
    );
  }
  if (!succeeded(delivered.command)) {
    return stop(
      { reason: "delivery failed", blocker: `${describeCommand(delivered.command)}: ${outputTail(delivered.command, 500)}`, evidenceRefs: [delivered.record.ref] },
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
  return stop({ reason: "incompatible task", blocker: problem, evidenceRefs: refs }, "stop: the issue snapshot cannot be handed to the agents whole");
}

/** The test plan's line for the code review, and the dismissed findings a maintainer can overrule. */
function reviewSummary(view: RunView): { review: string; dismissed: string[] } {
  const ledger = findingLedger(view.evidence);
  const last = ledger.passes.filter((p) => p.digest === view.candidateDigest).at(-1);
  if (last?.report === undefined) return { review: "Code review did not produce a result.", dismissed: [] };
  const { report } = last;
  const dismissed = ledger.findings.filter((f) => f.state === "dismissed");
  const fixed = ledger.findings.filter((f) => f.state === "fixed").length;
  const lower = report.comments.filter((c) => !isBlocking(c)).length;
  const by = `Codex in open-code-review's delegation mode (${describeCoverage(report)})`;
  const settled = [
    ...(fixed > 0 ? [`${fixed} fixed during review`] : []),
    ...(dismissed.length > 0 ? [`${dismissed.length} refuted by an independent verifier, listed below`] : []),
  ];
  const open = settled.length > 0 ? `no critical or high finding left open (${settled.join("; ")})` : "no critical or high comments";
  return {
    review: report.comments.length === 0 && settled.length === 0 ? `Reviewed by ${by}: no comments.` : `Reviewed by ${by}: ${open}${lower > 0 ? `; ${lower} lower-severity comment(s) left for the reviewer` : ""}.`,
    dismissed: dismissed.map(describeFinding),
  };
}

/** What a plan review pass's open findings ask the planner to change. */
function planFeedback(ledger: PlanLedger, pass: PlanReviewPass): string[] {
  const header = pass.verdict === "request_changes" ? `The plan reviewer sent your plan back: ${pass.summary}` : `The plan reviewer's findings on your plan: ${pass.summary}`;
  const relevant = ledger.findings.filter((f) => pass.raised.includes(f.id) || ((f.state === "confirmed" || f.state === "disputed") && f.on === pass.planRef));
  return [header, ...relevant.map(describePlanFinding)];
}

/** Why the run is back in Fix: the confirmed findings of the code review, when there are any. Dismissed and disputed ones never reach the implementer. */
function reentryFeedback(view: RunView): string[] {
  const confirmed = findingLedger(view.evidence).findings.filter((f) => f.state === "confirmed");
  if (confirmed.length === 0) {
    return ["The run returned to Fix after a resume or a supervisor decision. Check the plan against the current code and the change in the working tree."];
  }
  return [
    `Code review of your previous change found ${confirmed.length} critical or high defect(s), each confirmed by an independent verifier:`,
    ...confirmed.slice(0, 10).map(describeFinding),
  ];
}

/** A plan or implementer that cannot proceed stops the run with its question. */
function notReady(record: DecisionRecord, refs: string[], who: string): GraphDecision | undefined {
  if (record.status === "ready") return undefined;
  const reason = record.status === "blocked" ? "needs maintainer decision" : "cannot reproduce";
  const question = record.draftComment?.trim() || record.openQuestions[0] || record.summary;
  return stop({ reason, blocker: question.slice(0, 1_000), evidenceRefs: refs }, `${who} returned ${record.status}: ${record.summary.slice(0, 200)}`);
}

function evaluateFix(evidence: EvidenceRecord[], digest: string): Array<{ requirementId: string; result: ValidationResult }> {
  const stage = definition.stages.find((s) => s.id === FIX_STAGE)!;
  return stage.requirementIds.map((requirementId) => {
    const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
    const statement = definition.requirements.find((r) => r.id === requirementId)!.statement;
    return { requirementId, result: validatorById(binding.validatorId)!.evaluate({ requirementId, statement, evidence, candidateDigest: digest }) as ValidationResult };
  });
}

/** What the implementer needs to fix: each unmet requirement, with the failing command's output. */
function correctionFeedback(evidence: EvidenceRecord[], digest: string, results: Array<{ requirementId: string; result: ValidationResult }>): string[] {
  const feedback = results.filter((r) => r.result.status !== "passed").map((r) => `${r.requirementId}: ${r.result.reason}`);
  const runs = [latestCheckoutRun(evidence, COMMAND.regression, "base", digest), latestCheckoutRun(evidence, COMMAND.regression, "candidate", digest)];
  const green = runs[1];
  if (green !== undefined) {
    for (const id of [COMMAND.testCi, COMMAND.license, COMMAND.build, COMMAND.lint, COMMAND.check]) runs.push(sameCheckoutJob(evidence, green, id));
  }
  const reported = new Set<string>();
  for (const run of runs) {
    if (run === undefined) continue;
    if (run.checkout !== undefined && run.checkout.mutations.length > 0 && !reported.has(run.checkout.commit)) {
      reported.add(run.checkout.commit);
      feedback.push(`the checks in the ${run.checkout.from} checkout left ${run.checkout.mutations.join(", ")} changed (make check reformats Go code; run make format); make the change so the checks leave it unchanged`);
    }
    if (run.command.id === COMMAND.regression && run.checkout?.from === "base") continue;
    if (!succeeded(run.command)) feedback.push(`${describeCommand(run.command)} in the ${run.checkout?.from ?? "worktree"} checkout:\n${outputTail(run.command)}`);
  }
  return feedback;
}

/** A plan continues the implementer's session when there is one, so a revision keeps what the planner read. */
function planJob(view: RunView, assignment: string): JobSpec {
  const from = implementerSession(view);
  return {
    jobId: IMPLEMENTER_JOB,
    stageId: FIX_STAGE,
    kind: "agent",
    purpose: "diagnostic",
    readOnly: true,
    instruction: "Plan the fix",
    resultSchema: "decision-record-v1",
    executor: CODING_AGENT,
    input: { assignment, resultSchema: DECISION_RECORD_SCHEMA, harness: IMPLEMENTER_HARNESS },
    ...(from !== undefined ? { continueFrom: from } : {}),
  };
}

/** A fresh session each time: the plan reviewer carries nothing from an earlier review. */
function planReviewJob(assignment: string): JobSpec {
  return {
    stageId: FIX_STAGE,
    kind: "agent",
    purpose: "review",
    readOnly: true,
    instruction: "Review the plan",
    resultSchema: "review-verdict-v1",
    executor: CODING_AGENT,
    input: { assignment, resultSchema: PLAN_REVIEW_SCHEMA, harness: REVIEWER_HARNESS },
  };
}

/**
 * A fresh read-only session, distinct from both the planner's and the plan
 * reviewer's, that judges a plan finding the reviewer repeated after the
 * planner had a chance to answer it. Purpose `verify`, not `diagnostic`: the
 * plan itself is looked up by {FIX_STAGE, "diagnostic"}, and this job's own
 * {verdicts:[...]} result must never be misread as a plan.
 */
function planVerificationJob(assignment: string): JobSpec {
  return {
    stageId: FIX_STAGE,
    kind: "agent",
    purpose: "verify",
    readOnly: true,
    instruction: "Verify the plan review findings",
    resultSchema: "finding-verification-v1",
    executor: CODING_AGENT,
    input: { assignment, resultSchema: VERIFICATION_SCHEMA, harness: VERIFIER_HARNESS },
  };
}

/** A fresh read-only session that reviews the change in the run worktree. */
function codeReviewJob(assignment: string): JobSpec {
  return {
    stageId: REVIEW_STAGE,
    kind: "agent",
    purpose: "review",
    readOnly: true,
    instruction: "Review the code",
    resultSchema: "code-review-v2",
    executor: CODING_AGENT,
    input: { assignment, resultSchema: CODE_REVIEW_SCHEMA, harness: CODE_REVIEWER_HARNESS },
  };
}

/** A fresh read-only session, on another model family than the reviewer, that has never written the change. */
function verificationJob(assignment: string): JobSpec {
  return {
    stageId: REVIEW_STAGE,
    kind: "agent",
    purpose: "diagnostic",
    readOnly: true,
    instruction: "Verify the code review findings",
    resultSchema: "finding-verification-v1",
    executor: CODING_AGENT,
    input: { assignment, resultSchema: VERIFICATION_SCHEMA, harness: VERIFIER_HARNESS },
  };
}

function implementJob(view: RunView, issue: number, record: DecisionRecord, feedback: string[] | undefined): JobSpec {
  const from = implementerSession(view);
  return {
    jobId: IMPLEMENTER_JOB,
    stageId: FIX_STAGE,
    kind: "agent",
    purpose: "work",
    instruction: "Implement the fix",
    resultSchema: "decision-record-v1",
    writeScope: writeScopeFor(record),
    executor: CODING_AGENT,
    input: {
      assignment: implementInstruction({ issue, plan: record, ...(feedback !== undefined ? { feedback } : {}) }),
      resultSchema: DECISION_RECORD_SCHEMA,
      harness: IMPLEMENTER_HARNESS,
    },
    ...(from !== undefined ? { continueFrom: from } : {}),
  };
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
  const blank: FixPrivateState = { generation: view.generation, corrections: 0 };
  if (!view.privateState) return blank;
  try {
    const saved = JSON.parse(view.privateState) as Partial<FixPrivateState>;
    return saved.generation === view.generation ? { ...blank, ...saved } : blank;
  } catch {
    return blank;
  }
}

/** Only agent work spends an invocation; checks and validation stay open after the last one. */
function dispatchAgent(view: RunView, job: JobSpec, summary: string, state: FixPrivateState): GraphDecision {
  if (view.budgets.agentInvocations <= 0) {
    return stop({ reason: "budgets exhausted", blocker: "no agent invocations left" }, `cannot ${summary}`);
  }
  return withPrivate(dispatch(job, summary), state);
}

function withPrivate(decision: GraphDecision, state: FixPrivateState): GraphDecision {
  return { ...decision, privateState: JSON.stringify(state) };
}
