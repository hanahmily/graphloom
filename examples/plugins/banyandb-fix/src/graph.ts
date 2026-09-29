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
  REQUIREMENT_BUILDS,
  REQUIREMENT_CHANGELOG,
  REQUIREMENT_DECISIONS,
  REQUIREMENT_PASSES,
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
  sameCheckoutJob,
  succeeded,
} from "./evidence.js";
import {
  candidateCommands,
  deliverCommands,
  implementInstruction,
  issueRef,
  planInstruction,
  pullRequestDescription,
  redCommands,
  reviewInstruction,
  snapshotText,
} from "./prompts.js";
import { implementerRecord, isTestPath, validatorById } from "./validators.js";

/** Graph bookkeeping; everything else is read back from recorded evidence. */
export interface FixPrivateState {
  generation: number;
  /** Corrections the graph dispatched in Fix in this generation. */
  corrections: number;
}

const definition: GraphDefinition = {
  graphId: "banyandb-fix",
  version: "0.1.0",
  privateStateSchema: "banyandb-fix-private-v1",
  stages: [
    {
      id: FIX_STAGE,
      name: "Fix",
      requirementIds: [REQUIREMENT_DECISIONS, REQUIREMENT_REPRODUCES, REQUIREMENT_PASSES, REQUIREMENT_BUILDS, REQUIREMENT_SCOPE, REQUIREMENT_CHANGELOG],
    },
    { id: REVIEW_STAGE, name: "Review", requirementIds: [REQUIREMENT_REVIEW] },
  ],
  requirements: [
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
        "An independent read-only reviewer approves the current change on the Spec and Standards axes, and the verdict is bound to that change.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: REQUIREMENT_DECISIONS, validatorId: "decisions-recorded", version: "1" },
    { requirementId: REQUIREMENT_REPRODUCES, validatorId: "red-reproduces", version: "1" },
    { requirementId: REQUIREMENT_PASSES, validatorId: "green-passes", version: "1" },
    { requirementId: REQUIREMENT_BUILDS, validatorId: "build-checks", version: "1" },
    { requirementId: REQUIREMENT_SCOPE, validatorId: "write-scope", version: "1" },
    { requirementId: REQUIREMENT_CHANGELOG, validatorId: "changes-entry", version: "1" },
    { requirementId: REQUIREMENT_REVIEW, validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" },
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
  const snapshotBody = snapshotText(snapshot.issue, comments.comments);

  const planRun = agentRuns(view.evidence, FIX_STAGE, "diagnostic").at(-1);
  if (planRun === undefined || planRun.status !== "completed") {
    return dispatchAgent(view, planJob(planInstruction({ issue, request: view.task.request, snapshot: snapshotBody })), "plan the fix (read-only)", state);
  }
  const plan = parseDecisionRecord(planRun.output);
  if ("problem" in plan) {
    return supervise({ reason: `the plan returned no valid decision record: ${plan.problem}`, evidenceRefs: [planRun.record.ref] }, "escalate an invalid plan", JSON.stringify(state));
  }
  const blocked = notReady(plan.record, [planRun.record.ref], "the plan");
  if (blocked !== undefined) return blocked;

  const current = inGeneration(view.evidence, view.generation);
  const implemented = agentRuns(current, FIX_STAGE, "work").at(-1);
  const latestRecord = implementerRecord(view.evidence).record ?? plan.record;
  if (implemented === undefined || implemented.status !== "completed") {
    return dispatchAgent(
      view,
      implementJob(view, issue, latestRecord, reviewFeedback(view, implemented === undefined)),
      implemented === undefined ? "implement the fix, continuing the plan session" : "retry the implementation",
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
      implementJob(view, issue, record ?? latestRecord, feedback),
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
  const verdict = latestReview(current);
  if (verdict === undefined) {
    // Fix was accepted for this candidate, possibly before a resume moved the generation on.
    const record = implementerRecord(view.evidence).record;
    const snapshot = issueSnapshot(view.evidence, issue)!;
    const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", view.candidateDigest);
    return dispatchAgent(
      view,
      {
        stageId: REVIEW_STAGE,
        kind: "agent",
        purpose: "review",
        readOnly: true,
        instruction: "Review the fix",
        resultSchema: "review-verdict-v1",
        executor: CODING_AGENT,
        input: {
          assignment: reviewInstruction({
            issue,
            snapshot: snapshotText(snapshot.issue, issueComments(view.evidence)?.comments ?? []),
            record: record!,
            base: green?.checkout?.base ?? "the pinned base commit",
            paths: green?.checkout?.paths ?? [],
            checks: checkFacts(view.evidence, view.candidateDigest),
          }),
          resultSchema: "review-verdict-v1",
          harness: REVIEWER_HARNESS,
        },
      },
      "dispatch a fresh read-only reviewer",
      state,
    );
  }
  // An approved change does not depend on the answer; delivery asks it in the pull request.
  if (verdict.productDecision !== undefined && verdict.verdict !== "approved") {
    return stop(
      { reason: "needs maintainer decision", blocker: verdict.productDecision, evidenceRefs: [verdict.record.ref] },
      "the reviewer found a product decision an agent must not make",
    );
  }
  if (verdict.verdict === "approved") {
    return withPrivate(validate({ stageId: REVIEW_STAGE }, "validate the approved change"), state);
  }
  const findings = verdict.findings.map((f) => f.detail).join("; ");
  return supervise(
    { reason: `the reviewer requested changes: ${verdict.summary}${findings !== "" ? ` (${findings})` : ""}`, evidenceRefs: [verdict.record.ref] },
    "hand the requested changes to the supervisor",
    JSON.stringify(state),
  );
}

function deliver(view: RunView, issue: number, state: FixPrivateState): GraphDecision {
  const current = inGeneration(view.evidence, view.generation);
  const delivered = commandRuns(current, COMMAND.deliver).filter((r) => r.record.candidateDigest === view.candidateDigest).at(-1);
  const branch = `fix/${issue}`;
  if (delivered === undefined) {
    const record = implementerRecord(view.evidence).record!;
    const asked = latestReview(current)?.productDecision;
    const openQuestions = asked !== undefined && !record.openQuestions.includes(asked) ? [...record.openQuestions, asked] : record.openQuestions;
    const green = latestCheckoutRun(view.evidence, COMMAND.regression, "candidate", view.candidateDigest);
    const message = pullRequestDescription({
      issue,
      issueTitle: issueSnapshot(view.evidence, issue)?.issue.title ?? issueRef(issue),
      record: { ...record, openQuestions },
      base: green?.checkout?.base ?? "",
      receipts: view.receipts,
      checks: [],
    });
    return withPrivate(
      dispatch(
        {
          stageId: REVIEW_STAGE,
          kind: "command",
          purpose: "diagnostic",
          readOnly: true,
          instruction: `Put the change on ${branch}`,
          input: { commands: deliverCommands(branch, message) },
        },
        `put the change on the local branch ${branch} with the draft pull request as its message`,
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
    `the change is on ${branch}; the draft pull request is its commit message`,
  );
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

/** One line per check bound to the change, for the reviewer. */
function checkFacts(evidence: EvidenceRecord[], digest: string | undefined): string[] {
  return commandRuns(evidence)
    .filter((r) => r.checkout?.phase === "run" && r.record.candidateDigest === digest && r.command.id !== COMMAND.changesDiff)
    .map((r) => `${r.command.id} in the ${r.checkout!.from} checkout: ${describeCommand(r.command)} (evidence ${r.record.ref})`);
}

/** The reviewer's requested changes, when Fix is being redone after a review. */
function reviewFeedback(view: RunView, fresh: boolean): string[] | undefined {
  if (!fresh) return undefined;
  const verdict = latestReview(view.evidence);
  if (verdict === undefined || verdict.verdict !== "request_changes" || (verdict.record.generation ?? view.generation) >= view.generation) return undefined;
  return [`The reviewer requested changes: ${verdict.summary}`, ...verdict.findings.map((f) => `${f.axis ?? "finding"}${f.severity !== undefined ? ` (${f.severity})` : ""}: ${f.detail}`)];
}

function planJob(assignment: string): JobSpec {
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
