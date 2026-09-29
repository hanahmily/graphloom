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
  CODING_AGENT,
  COMMAND,
  ENVIRONMENT,
  FIX_STAGE,
  GET_ISSUE,
  IMPLEMENTER_HARNESS,
  IMPLEMENTER_JOB,
  ISSUE_REPO,
  LIST_ISSUE_COMMENTS,
  MAX_FIX_CORRECTIONS,
  MAX_PLAN_REVISIONS,
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
} from "./constants.js";
import { DECISION_RECORD_SCHEMA, parseDecisionRecord, writeScopeFor, type DecisionRecord } from "./decision-record.js";
import {
  agentRuns,
  commandRuns,
  describeCommand,
  inGeneration,
  issueComments,
  issueSnapshot,
  latestCheckoutRun,
  latestFile,
  latestReview,
  outputTail,
  reviews,
  sameCheckoutJob,
  succeeded,
  type CommandRun,
  type ReviewVerdict,
} from "./evidence.js";
import { blockingComments, codeReviewCommands, describeComment, parseOcrReport, reviewBackground, reviewComplete } from "./ocr.js";
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
import { codeReview, implementerRecord, isTestPath, validatorById } from "./validators.js";

/** Graph bookkeeping; everything else is read back from recorded evidence. */
export interface FixPrivateState {
  generation: number;
  /** Corrections the graph dispatched in Fix in this generation. */
  corrections: number;
}

const definition: GraphDefinition = {
  graphId: "banyandb-fix",
  version: "0.2.0",
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
        "A fresh read-only reviewer approved the plan the implementer followed, after that plan was written, on the spec, decisions, reach and test axes.",
      evidenceSchema: "review-verdict-v1",
    },
    {
      id: REQUIREMENT_DECISIONS,
      statement:
        "The implementer's decision record is ready, names the regression test and the production caller, gives every unclear point a tier and a basis, takes an option for every behaviour point, and marks no product point chosen.",
      evidenceSchema: "decision-record-v1",
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
        "open-code-review, run read-only in a prepared checkout of the current change, reviewed every changed file and reported no critical or high comment, and the checkout was left unchanged.",
      evidenceSchema: "checkout-command-v1",
    },
  ],
  defaultValidators: [
    { requirementId: REQUIREMENT_PLAN_REVIEW, validatorId: "plan-reviewer", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_DECISIONS, validatorId: "decisions-recorded", version: "1" },
    { requirementId: REQUIREMENT_REPRODUCES, validatorId: "red-reproduces", version: "1" },
    { requirementId: REQUIREMENT_PASSES, validatorId: "green-passes", version: "1" },
    { requirementId: REQUIREMENT_BUILDS, validatorId: "build-checks", version: "1" },
    { requirementId: REQUIREMENT_SCOPE, validatorId: "write-scope", version: "1" },
    { requirementId: REQUIREMENT_CHANGELOG, validatorId: "changes-entry", version: "1" },
    { requirementId: REQUIREMENT_REVIEW, validatorId: "open-code-review", version: "1" },
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
    (s) => !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)),
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
  const current = inGeneration(view.evidence, view.generation);

  // Validators see only this generation's evidence, so every generation plans and reviews its plan.
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

  const planReviews = reviews(current, FIX_STAGE);
  const verdict = planReviews.filter((r) => current.indexOf(r.record) > current.indexOf(planRun.record)).at(-1);
  if (verdict === undefined) {
    const earlier = planReviews.at(-1);
    const previous = earlier !== undefined ? verdictFeedback(earlier) : agentRuns(view.evidence, FIX_STAGE, "work").length > 0 ? reentryFeedback(view) : undefined;
    return dispatchAgent(view, planReviewJob(planReviewInstruction({ issue, snapshot: snapshotBody, record: plan.record, ...(previous !== undefined ? { previous } : {}) })), "dispatch a fresh read-only reviewer for the plan", state);
  }
  if (verdict.productDecision !== undefined && verdict.verdict !== "approved") {
    return stop(
      { reason: "needs maintainer decision", blocker: verdict.productDecision, evidenceRefs: [verdict.record.ref] },
      "the plan reviewer found a product decision an agent must not make",
    );
  }
  if (verdict.verdict !== "approved") {
    const sentBack = planReviews.filter((r) => r.verdict !== "approved").length;
    if (sentBack > MAX_PLAN_REVISIONS) {
      return supervise(
        { reason: `the reviewer sent the plan back ${sentBack} times: ${verdict.summary}`, evidenceRefs: planReviews.map((r) => r.record.ref) },
        "hand the disputed plan to the supervisor",
        JSON.stringify(state),
      );
    }
    return dispatchAgent(
      view,
      planJob(view, planRevisionInstruction({ issue, feedback: verdictFeedback(verdict), changed: agentRuns(view.evidence, FIX_STAGE, "work").length > 0 })),
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

function review(view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const current = inGeneration(view.evidence, view.generation);
  // Fix was accepted for this candidate, possibly before a resume moved the generation on.
  const run = latestCheckoutRun(current, COMMAND.codeReview, "candidate", view.candidateDigest);
  if (run === undefined) {
    const record = implementerRecord(view.evidence).record!;
    const snapshot = issueSnapshot(view.evidence, issue)!;
    return withPrivate(
      dispatch(
        {
          stageId: REVIEW_STAGE,
          kind: "command",
          purpose: "review",
          readOnly: true,
          instruction: "Review the change with open-code-review",
          checkout: { from: "candidate" },
          input: { commands: codeReviewCommands(reviewBackground(snapshot.issue, record)) },
        },
        "review the committed change with open-code-review",
      ),
      state,
    );
  }
  const statement = definition.requirements.find((r) => r.id === REQUIREMENT_REVIEW)!.statement;
  const result = codeReview.evaluate({ requirementId: REQUIREMENT_REVIEW, statement, evidence: current, candidateDigest: run.record.candidateDigest! }) as ValidationResult;
  if (result.status === "passed") return withPrivate(validate({ stageId: REVIEW_STAGE }, "validate the reviewed change"), state);
  return supervise(
    { reason: `code review did not pass: ${result.reason}`, evidenceRefs: [run.record.ref] },
    "hand the code review findings to the supervisor",
    JSON.stringify(state),
  );
}

function deliver(view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const current = inGeneration(view.evidence, view.generation);
  const delivered = commandRuns(current, COMMAND.deliver).filter((r) => r.record.candidateDigest === view.candidateDigest).at(-1);
  const branch = `fix/${issue}`;
  if (delivered === undefined) {
    const record = implementerRecord(view.evidence).record!;
    // An approved plan does not depend on the answer; the pull request asks it.
    const asked = latestReview(view.evidence, FIX_STAGE)?.productDecision;
    const openQuestions = asked !== undefined && !record.openQuestions.includes(asked) ? [...record.openQuestions, asked] : record.openQuestions;
    const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", view.candidateDigest);
    const reviewed = latestCheckoutRun(view.evidence, COMMAND.codeReview, "candidate", view.candidateDigest);
    const issueTitle = issueSnapshot(view.evidence, issue)?.issue.title ?? issueRef(issue);
    const body = pullRequestDescription({
      issue,
      issueTitle,
      record: { ...record, openQuestions },
      base: green?.checkout?.base ?? "",
      review: reviewed !== undefined ? reviewSummary(reviewed) : "Code review did not run.",
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

/** The test plan's line for the code review. */
function reviewSummary(run: CommandRun): string {
  const parsed = parseOcrReport(run.command.report?.text ?? run.command.stdoutTail);
  if ("problem" in parsed) return "Code review did not produce a result.";
  const { report } = parsed;
  const by = `open-code-review${report.model !== undefined ? ` with ${report.model}` : ""}`;
  return report.commentCount === 0
    ? `Reviewed with ${by}: no comments.`
    : `Reviewed with ${by}: no critical or high comments; ${report.commentCount} lower-severity comment(s) left for the reviewer.`;
}

/** What a plan reviewer's verdict asks the planner to change. */
function verdictFeedback(verdict: ReviewVerdict): string[] {
  return [
    `The plan reviewer sent your plan back: ${verdict.summary}`,
    ...verdict.findings.map((f) => `${f.axis ?? "finding"}${f.severity !== undefined ? ` (${f.severity})` : ""}: ${f.detail}`),
  ];
}

/** Why the run is back in Fix: the code review that failed an earlier change, when there is one. */
function reentryFeedback(view: RunView): string[] {
  const run = commandRuns(view.evidence, COMMAND.codeReview)
    .filter((r) => (r.record.generation ?? view.generation) < view.generation)
    .at(-1);
  const parsed = run !== undefined ? parseOcrReport(run.command.report?.text ?? run.command.stdoutTail) : undefined;
  if (parsed === undefined || "problem" in parsed || (reviewComplete(parsed.report) && blockingComments(parsed.report).length === 0)) {
    return ["The run returned to Fix after a resume or a supervisor decision. Check the plan against the current code and the change in the working tree."];
  }
  const blocking = blockingComments(parsed.report);
  return [
    `Code review of your previous change did not pass (open-code-review status ${parsed.report.status}${blocking.length > 0 ? `, ${blocking.length} critical or high comment(s)` : ""}):`,
    ...blocking.slice(0, 10).map(describeComment),
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
    input: { assignment, resultSchema: "review-verdict-v1", harness: REVIEWER_HARNESS },
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
