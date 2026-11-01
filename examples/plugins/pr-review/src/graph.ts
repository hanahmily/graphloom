// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import {
  dispatch,
  isStaleFailure,
  jsonSchemaProblem,
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_JOB_TIMEOUT_MS,
  observe,
  stop,
  supervise,
  validate,
  type AgentRoleDeclaration,
  type ApprovalDeclaration,
  type EnvironmentCommand,
  type GraphBudgetDefaults,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type ReferenceSet,
  type Requirement,
  type RunView,
  type ValidationResult,
  type ValidatorBinding,
} from "@graphloom/sdk";
import { analyze, type Analysis } from "./analysis.js";
import { checkoutCommand, GIT_ENV, GUARD_REFUSED, guardCommand, headTreeCommand, ledgerReadCommand, pinnedBase, reviewDirCommand } from "./commands.js";
import {
  ANSWERER_JOB,
  ANSWERS_STAGE,
  CODING_AGENT,
  COMMAND,
  ENV_PLUGIN_ROOT,
  ENV_WORKTREE,
  FETCH_STAGE,
  LEDGER_MOVED,
  NECESSITY_JSON,
  QUESTIONER_JOB,
  QUESTIONS_STAGE,
  REPORTER_JOB,
  REPORT_STAGE,
  REQUIREMENT_ANSWERS,
  REVIEW_LAYER_APPROVAL,
  REQUIREMENT_CHECKED_OUT,
  REQUIREMENT_CLAIMS,
  REQUIREMENT_GROUNDED,
  REQUIREMENT_LEDGER,
  REQUIREMENT_MEASUREMENTS,
  REQUIREMENT_QUESTIONS,
  REQUIREMENT_REPORT,
  REQUIREMENT_SNAPSHOT,
  GRAPH_ID,
  GRAPH_VERSION,
  QA_JSON,
  REVIEW_MD,
} from "./constants.js";
import { commandRuns, describeCommand, environmentOutput, outputTail, succeeded, validatorEvidence, type CommandRun } from "./evidence.js";
import { LIMITS } from "./metrics/crap.js";
import { CHANGE_REPORT_SCHEMA } from "./report.js";
import { CLAIM_CHECK_SCHEMA, claimTargets } from "./claims.js";
import { REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME, reportFlow } from "./flow.js";
import { measurementState, metricsDiffCommand, staticBaseCommand, staticCommand } from "./measurements.js";
import { coverageCommand, coverageConfinement, missingProbe, sandboxEnvironmentChecks, type CoveragePlan } from "./coverage.js";
import { checkerInstruction, reporterInstruction } from "./prompts.js";
import { harnessName, parseProfile, ProfileError, ROLES, DISTINCT_PAIRS, type Profile, type Role } from "./profile.js";
import { prepareTask } from "./prepare.js";
import { requestedPull, type PullRequest } from "./request.js";
import { secretFindings } from "./secrets.js";
import { readInput, snapshotState, type PullFile, type ReadSpec } from "./snapshot.js";
import { CLAIM_CHECK_SCHEMA_NAME } from "./claims.js";
import { outputsOf, validatorById } from "./validators.js";
import { reportWriteCommand, writtenQa, writtenReport } from "./write.js";
import { ANSWER_CHECK_REFERENCES, ANSWER_CHECK_SCHEMA, ANSWER_CHECK_SCHEMA_NAME, ANSWERS_REFERENCES, ANSWERS_REVISION_SCHEMA_NAME, ANSWERS_SCHEMA, ANSWERS_SCHEMA_NAME, answersFlow } from "./answers.js";
import { baseDirIn } from "./basetree.js";
import { sourceDirs } from "./inventory.js";
import { ledgerRead, priorShowCommand, writtenLedger } from "./ledger.js";
import { QUESTIONS_REFERENCES, QUESTIONS_SCHEMA, QUESTIONS_SCHEMA_NAME, requiredQuestions, type Question } from "./questions.js";
import { CLAIM_CHECK_REFERENCES } from "./claims.js";
import { necessityQuestion, NECESSITY_ID, NECESSITY_REFERENCES, NECESSITY_REVISION_SCHEMA_NAME, NECESSITY_SCHEMA, NECESSITY_SCHEMA_NAME, type NecessityRecord } from "./necessity.js";
import { principlesReadCommand, type Principle } from "./principles.js";
import { answerCheckerInstruction, answererInstruction, necessityCheckerInstruction, necessityInstruction, questionerInstruction } from "./qaprompts.js";
import { afterNecessity, answerContext, answerWrites, necessityFlow, necessityRecordCommand, necessityRecordOf, qaContext, qaOutputs, questionSet, questionerFlow, recordedNecessity, type QaContext } from "./qaflow.js";

export { GRAPH_ID, GRAPH_VERSION };

const asSchema = (schema: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/** The ids a job's contract field is constrained to: the contract's `enum`, with each id's description for reconciling a value that names the thing instead. */
const idSet = (ids: readonly string[], describe?: (id: string) => string): ReferenceSet => ({ ids: [...ids], ...(describe !== undefined ? { descriptions: Object.fromEntries(ids.filter((i) => i !== "").map((i) => [i, describe(i)])) } : {}) });
const oneLineText = (s: string): string => s.replace(/\s+/g, " ").trim();
/** Per-job id sets for a contract's reference paths; a path with no ids is left unconstrained (an empty enum would allow nothing). */
const idRefs = (sets: Record<string, ReferenceSet>): Record<string, ReferenceSet> => Object.fromEntries(Object.entries(sets).filter(([, v]) => v.ids.length > 0));
const principleRefs = (path: string, ps: readonly Principle[]): Record<string, ReferenceSet> => idRefs({ [path]: idSet(ps.map((p) => p.id), (id) => oneLineText(ps.find((p) => p.id === id)?.statement ?? "").slice(0, 300)) });
const questionRefs = (path: string, qs: readonly Question[]): Record<string, ReferenceSet> => idRefs({ [path]: idSet(qs.map((q) => q.id), (id) => oneLineText(qs.find((q) => q.id === id)?.text ?? "")) });

/** What N1's requirement says of the project's design principles (design §7.5.1), when the profile names a file. */
function principlesText(profile: Profile): string {
  const cfg = profile.questions.principles;
  if (cfg === undefined) return "";
  return `; the project's design principles file ${cfg.path} was read read-only at ${cfg.ref !== undefined ? `the ref ${cfg.ref}` : "the pinned base commit"}, never from the pull request's head, the ref resolved once to a commit and the file recorded whole as evidence (a missing file is recorded as absent and changes nothing, and a pull request that changes the file is flagged and still judged by the version read), and the answer gives one verdict (preserves, breaks or not-applicable) with an explanation and path:line citations for each principle that applies (its globs match a changed file, or it names none), each applicable principle exactly once, preserves and breaks each cited; when the answer checker supports a breaks verdict, a necessary conclusion becomes questionable and names the broken principle, every other conclusion stays as it is, no principle break skips a question, and a break the checker does not support is recorded with both statements and changes nothing`;
}

/** The defaults the design gives a pr-review run (design §13.3), under the profile's own and the task's. */
const DEFAULT_BUDGETS: GraphBudgetDefaults = { agentInvocations: 1_200, jobs: 220, decisions: 240, corrections: 12, activeMs: 4 * 3_600_000, waitMs: 6 * 3_600_000 };

/** Environment checks the graph adds to the profile's: where the worktree, the plugin and Go live (for the confined static tools), and the state of the sandbox images (reported by `graphloom check` and `doctor --task`, never failing the run). */
function generatedChecks(profile: Profile): EnvironmentCommand[] {
  return [
    { id: ENV_WORKTREE, argv: ["sh", "-c", "pwd -P"] },
    {
      id: ENV_PLUGIN_ROOT,
      argv: ["sh", "-c", 'r=${GRAPHLOOM_PLUGIN_ROOT:-}; [ -n "$r" ] || { echo "GRAPHLOOM_PLUGIN_ROOT is not set: GraphLoom sets it to the plugin\'s directory for environment checks" >&2; exit 127; }; cd "$r" && pwd -P'],
    },
    { id: "go-root", argv: ["sh", "-c", "go env GOROOT 2>/dev/null || true"] },
    ...sandboxEnvironmentChecks(profile),
  ];
}

/** The graph definition for a profile. The stage list is fixed per plugin version, whatever the profile says. */
export function definitionFor(profile: Profile): GraphDefinition {
  const checker = harnessName(profile.roles["report-checker"]);
  const requirements: Requirement[] = [
    {
      id: REQUIREMENT_SNAPSHOT,
      statement: `The pull request's metadata, every changed file with its patch, every commit, review, review comment and review thread (with resolution), and the head's check runs were read completely from GitHub for the one head the request names. It has at most ${profile.limits.maxFiles} files and ${profile.limits.maxPatchBytes} bytes of patch, and touches nothing under .graphloom/.`,
      evidenceSchema: "github-read-v1",
    },
    {
      id: REQUIREMENT_CHECKED_OUT,
      statement: "The worktree holds exactly the head's tree on the pinned merge base, materialized by `git checkout --no-overlay` with hooks off and no global or system Git configuration, so no repository code ran to produce it; .graphloom/review/ exists with its own .gitignore.",
      evidenceSchema: "checkout-command-v1",
    },
    {
      id: REQUIREMENT_LEDGER,
      statement: "The pull request's ledger ref (refs/graphloom/pr-review/<owner>/<repo>/<N>/ledger) was read, or recorded absent. This version reports the whole pull request either way.",
      evidenceSchema: "command-report-v1",
    },
    {
      id: REQUIREMENT_REPORT,
      statement: `Every template section is present, with cited items or an explicit None. Every citation lies inside the pull request's diff on the side it names. Every changed file (a renamed file under both names, a deleted file too) and every detector fact is cited, and no item carries a severity, finding or verdict (the result contract has no such field). report.json and ${REVIEW_MD} hold exactly that report.`,
      evidenceSchema: "change-report-v1",
    },
    {
      id: REQUIREMENT_MEASUREMENTS,
      statement: `For every function the pull request adds or modifies, complexity and nesting were measured by the pinned static tools (gometrics, tsmetrics) over the head tree, under bwrap with no network, and every value recomputes from its evidence. A modified function is also measured at the base: its file is read at the pinned base (git show <base>:<path>, read-only, recorded whole) and measured by the same tools, confined with no network and recomputed from the recorded text, so its row shows base → head and says whether an over-the-limit value was already there, or why the base is not known (a base that cannot be measured never fails the report). Coverage runs the pull request's own tests, so it runs only in the Docker sandbox (no network, a read-only dependency cache, a prepared checkout of the head, images pinned by digest and pulled in Fetch): ${profile.metrics.coverage ? "each function's statement coverage is attributed by line range from the sandbox's report (go test -coverprofile; the repository's own vitest with @vitest/coverage-v8), and its CRAP is recomputed, or the function says why it was not run (Docker or the image is not available, the profile's sandboxed setup failed, a package did not build offline, no vitest coverage provider in the repository) and its CRAP is shown as its upper bound" : "not run (coverage disabled by the profile), CRAP shown as its upper bound"}. Mutation arrives with a later version.`,
      evidenceSchema: "graphloom-metrics-v1",
    },
    {
      id: REQUIREMENT_CLAIMS,
      statement: `An independent ${checker} report checker, on a harness other than the reporter's, judged every report item against the diff, and every item left is supported with quotes that match the diff's text. An item that was not supported after one revision is removed and recorded, and its file is accounted for in "other".`,
      evidenceSchema: CLAIM_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_QUESTIONS,
      statement: `The necessity question N1 was asked first, before every other question: is the problem real on the base (the claimed problem quoted from the pull request's text, the base behavior traced through the base code with path:line citations, a failing test on the base optional and not available in this version), does the fix fit the system's design (the repository's design and architecture documents${profile.questions.designDocs.length > 0 ? ` (${profile.questions.designDocs.join(", ")})` : ""} and code comments searched, the design statement and the changed lines cited, and whether the change preserves or breaks them said)${principlesText(profile)}, and is there a simpler or existing way; it concludes necessary, questionable, unnecessary or needs author, in one line. An independent ${harnessName(profile.roles["answer-checker"])} answer checker verified each cited design statement, each trace step${profile.questions.principles !== undefined ? ", each principle verdict" : ""} and the conclusion, with searches of its own, and N1's checked answer and the decision it led to${profile.questions.principles !== undefined ? " (with the principles file's path, ref, commit and the verdicts)" : ""} are recorded in necessity.json. When N1 concludes unnecessary and the checker supports it, and the operator did not ask for every question, no other question is asked and the skip is recorded (only N1 is required). Otherwise every required question was asked: purpose for each change item whose purpose the pull request's text does not state (a stated purpose is recorded with a quote that matches that text instead), existing-equivalent, reuse-library and common-logic for each new symbol, missing-test for each new or modified symbol the test map finds no covering test for, split-function for each changed function with complexity of ${LIMITS.complexity} or more or nesting over ${LIMITS.nesting}, complexity-coverage for each function with measured coverage and CRAP of ${LIMITS.crap} or more or with unknown coverage and complexity of ${LIMITS.complexity} or more (an upper-bound CRAP alone asks nothing), and weak-test for each surviving mutant (none in this version: mutation testing arrives later). The groundwork behind them (symbols from the language packs, whole-repository searches over the pinned base commit, similarity, the dependency inventory, the test map) was read by read-only commands, and every changed function has a measurement record.`,
      evidenceSchema: QUESTIONS_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_ANSWERS,
      statement: `N1 has its recorded answer first (when it is the only question, because it concluded unnecessary and the checker supports it, the Q&A says the remaining questions were skipped). Every other question has an answer from the ${harnessName(profile.roles.answerer)} answerer with evidence (citations that resolve in the tree they name, the searches run with their results, inventory entries) and a status of answered, partially answered or needs author. Every "none found" answer lists its whole-repository searches. Every cited metric equals its measurement record. Every proposal's line ranges lie inside its function and its names are new to the package. ${QA_JSON} and ${REVIEW_MD} are written, and the pull request's ledger ref was advanced by compare-and-swap from the value Fetch read with this head's report.json and qa.json.`,
      evidenceSchema: ANSWERS_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_GROUNDED,
      statement: `An independent ${harnessName(profile.roles["answer-checker"])} answer checker, on a harness other than the answerer's, re-checked every cited equivalent, library, duplicate and covering test, and every "none found" claim with searches of its own, against the trees, and had verified N1's cited design statements, trace steps${profile.questions.principles !== undefined ? ", principle verdicts" : ""} and conclusion. Every answer left is supported or partial; an answer still unsupported after one correction is needs author, with both statements recorded (for N1, its conclusion becomes questionable and every question is asked).`,
      evidenceSchema: ANSWER_CHECK_SCHEMA_NAME,
    },
  ];
  const bindings: ValidatorBinding[] = [
    { requirementId: REQUIREMENT_SNAPSHOT, validatorId: "pr-snapshot", version: "1" },
    { requirementId: REQUIREMENT_CHECKED_OUT, validatorId: "head-tree", version: "1" },
    { requirementId: REQUIREMENT_LEDGER, validatorId: "review-scope", version: "1" },
    { requirementId: REQUIREMENT_REPORT, validatorId: "change-report", version: "1" },
    { requirementId: REQUIREMENT_MEASUREMENTS, validatorId: "measurements", version: "1" },
    { requirementId: REQUIREMENT_CLAIMS, validatorId: "claims-checked", version: "1", independence: "separate-reviewer" },
    // N1's check is review evidence: the controller admits it only from a read-only review job on another operation.
    { requirementId: REQUIREMENT_QUESTIONS, validatorId: "questions-complete", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_ANSWERS, validatorId: "answers-complete", version: "1" },
    { requirementId: REQUIREMENT_GROUNDED, validatorId: "answers-grounded", version: "1", independence: "separate-reviewer" },
  ];
  return {
    graphId: GRAPH_ID,
    version: GRAPH_VERSION,
    privateStateSchema: "pr-review-private-v1",
    resultContracts: [
      { name: REPORTER_SCHEMA_NAME, schema: asSchema(CHANGE_REPORT_SCHEMA), evidenceKind: "other" },
      { name: REVISION_SCHEMA_NAME, schema: asSchema(CHANGE_REPORT_SCHEMA), evidenceKind: "other" },
      // Kind "review": the claims-checked requirement is judged by an independent reviewer, and the controller
      // admits one only from the review evidence of a read-only review job.
      { name: CLAIM_CHECK_SCHEMA_NAME, schema: asSchema(CLAIM_CHECK_SCHEMA), evidenceKind: "review", references: [...CLAIM_CHECK_REFERENCES] },
      { name: QUESTIONS_SCHEMA_NAME, schema: asSchema(QUESTIONS_SCHEMA), evidenceKind: "other", references: [...QUESTIONS_REFERENCES] },
      { name: ANSWERS_SCHEMA_NAME, schema: asSchema(ANSWERS_SCHEMA), evidenceKind: "other", references: [...ANSWERS_REFERENCES] },
      { name: ANSWERS_REVISION_SCHEMA_NAME, schema: asSchema(ANSWERS_SCHEMA), evidenceKind: "other", references: [...ANSWERS_REFERENCES] },
      { name: NECESSITY_SCHEMA_NAME, schema: asSchema(NECESSITY_SCHEMA), evidenceKind: "other", references: [...NECESSITY_REFERENCES] },
      { name: NECESSITY_REVISION_SCHEMA_NAME, schema: asSchema(NECESSITY_SCHEMA), evidenceKind: "other", references: [...NECESSITY_REFERENCES] },
      // Kind "review": answers-grounded is judged by an independent reviewer (a read-only review job on another harness).
      { name: ANSWER_CHECK_SCHEMA_NAME, schema: asSchema(ANSWER_CHECK_SCHEMA), evidenceKind: "review", references: [...ANSWER_CHECK_REFERENCES] },
    ],
    stages: [
      { id: FETCH_STAGE, name: "Fetch", requirementIds: [REQUIREMENT_SNAPSHOT, REQUIREMENT_CHECKED_OUT, REQUIREMENT_LEDGER] },
      { id: REPORT_STAGE, name: "Report", requirementIds: [REQUIREMENT_REPORT, REQUIREMENT_MEASUREMENTS, REQUIREMENT_CLAIMS] },
      { id: QUESTIONS_STAGE, name: "Questions", requirementIds: [REQUIREMENT_QUESTIONS] },
      { id: ANSWERS_STAGE, name: "Answers", requirementIds: [REQUIREMENT_ANSWERS, REQUIREMENT_GROUNDED] },
    ],
    requirements,
    defaultValidators: bindings,
    environment: { checks: [...structuredClone(profile.environment.checks), ...generatedChecks(profile)] },
    defaultBudgets: { ...DEFAULT_BUDGETS, ...(profile.budgets ?? {}) },
    agentRoles: agentRoles(profile),
    supervisor: structuredClone(profile.supervisorPreference),
    approvals: approvalDeclarations(),
  };
}

/**
 * The operator decisions this version declares (design §11). `review-layer` opens the Review stage, which 0.1 does
 * not have, so an approval is refused with that reason and a decline finishes the run report-only.
 */
export function approvalDeclarations(): ApprovalDeclaration[] {
  return [
    {
      id: REVIEW_LAYER_APPROVAL,
      stageId: "review",
      description: "continue into the review layer (aspect reviewers, findings, a draft); declining finishes the run report-only",
      unavailable: `pr-review ${GRAPH_VERSION} has no Review stage (its first layer is the report, the questions and the answers), so --approve ${REVIEW_LAYER_APPROVAL} is refused; --decline ${REVIEW_LAYER_APPROVAL} finishes the run as succeeded, report only`,
    },
  ];
}

/** The operator's latest recorded decision on approval `id`, from the run's `operator-approval` evidence. */
export function approvalDecision(evidence: RunView["evidence"], id: string): "approve" | "decline" | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const payload = evidence[i]!.payload as { type?: unknown; approvalId?: unknown; decision?: unknown } | undefined;
    if (payload?.type === "operator-approval" && payload.approvalId === id && (payload.decision === "approve" || payload.decision === "decline")) return payload.decision;
  }
  return undefined;
}

/**
 * The roles the profile assigns harnesses to (design §13.1), for `graphloom
 * doctor --task`: the whole role set with its distinctness constraints.
 */
export function agentRoles(profile: Profile): AgentRoleDeclaration[] {
  return ROLES.map((role) => {
    const distinctFrom = DISTINCT_PAIRS.filter(([checked]) => checked === role).map(([, author]) => author);
    return { role, harness: profile.roles[role], access: "read" as const, ...(distinctFrom.length > 0 ? { distinctFrom } : {}), setting: `harnesses.${role}` };
  });
}

/** The graph: its definition and routing both come from the task's profile (`config`). */
export function createGraph(): GraphPlugin {
  return {
    describe: (config?: unknown) => definitionFor(parseProfile(config)),
    advance: advancePullRequest,
    prepareTask,
  };
}

const withPrivate = (decision: GraphDecision): GraphDecision => ({ ...decision, privateState: JSON.stringify({ v: 1 }) });

export function advancePullRequest(view: RunView): GraphDecision {
  let profile: Profile;
  try {
    profile = parseProfile(view.config);
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return stop({ reason: "incompatible task", blocker: err.message, retryable: false }, "reject a task without a usable profile");
  }
  const pr = requestedPull(view.task.request, profile);
  if ("problem" in pr) return stop({ reason: "incompatible task", blocker: pr.problem, retryable: false }, "reject a request that names no pull request of the profile's project");
  const definition = definitionFor(profile);
  const stage = definition.stages.find((s) => !s.requirementIds.every((id) => view.receipts.some((r) => r.stageId === s.id && r.requirementId === id && r.valid)) || view.openAttempt?.[s.id] === true);
  const ctx: Context = { profile, definition, pr };
  if (stage === undefined) {
    if (approvalDecision(view.evidence, REVIEW_LAYER_APPROVAL) === "decline") {
      return withPrivate(
        stop(
          { reason: "complete", blocker: `report only: the operator declined the review layer; the report, the questions and their answers are in ${REVIEW_MD} in the worktree`, retryable: false },
          "the operator declined the review layer: finish with the report and the Q&A",
        ),
      );
    }
    // N1's answerer sits in the Questions stage; when it was the only answer, that is the session to discuss.
    const rec = recordedNecessity(view.evidence);
    const chat = rec.state === "read" && rec.record.decision.action === "skip" ? QUESTIONS_STAGE : ANSWERS_STAGE;
    return withPrivate(
      stop(
        {
          reason: "report ready",
          blocker: `the report, the questions and their answers are written to ${REVIEW_MD} in the worktree (report.json and qa.json beside it). graphloom session open <run> --stage ${chat} discusses them; graphloom resume <run> --decline review-layer finishes the run report-only (this version has no Review stage, so --approve review-layer is refused)`,
          retryable: false,
        },
        "the report and the Q&A are ready; the review layer is not built in this version",
      ),
    );
  }
  switch (stage.id) {
    case FETCH_STAGE:
      return fetch(ctx, view);
    case REPORT_STAGE:
      return report(ctx, view);
    case QUESTIONS_STAGE:
      return questions(ctx, view);
    default:
      return answers(ctx, view);
  }
}

interface Context {
  profile: Profile;
  definition: GraphDefinition;
  pr: PullRequest;
}

/** The latest run of command `id`: its result, and whether it failed since the operator's last resume (a failure before it is run again once). */
function commandState(view: RunView, id: string): { run: CommandRun | undefined; failed: boolean; retry: boolean } {
  const run = commandRuns(view.evidence, id).at(-1);
  if (run === undefined) return { run, failed: false, retry: false };
  const ok = succeeded(run.command);
  return { run, failed: !ok, retry: !ok && isStaleFailure(run.record, view) };
}

function commandJob(stageId: string, instruction: string, commands: JobSpec["input"] & object, extra: Partial<JobSpec> = {}): JobSpec {
  return { stageId, kind: "command", purpose: "diagnostic", readOnly: true, instruction, input: commands, ...extra };
}

function githubJob(spec: ReadSpec, input: Record<string, unknown>): JobSpec {
  return { stageId: FETCH_STAGE, kind: "command", purpose: "diagnostic", readOnly: true, instruction: `Read the ${spec.label}`, executor: spec.pin, input };
}

function fetch(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  // The head is checked out first, then the pull request is read: evidence is judged against the workspace
  // change it was produced under, and the checkout changes it, so a read made before would no longer count.
  const guard = commandState(view, COMMAND.guard);
  if (guard.failed && !guard.retry && guard.run !== undefined) {
    if (guard.run.command.exitCode === GUARD_REFUSED) {
      return stop({ reason: "incompatible task", blocker: `the pull request touches .graphloom/, which holds this graph's own files and which a pull request may not change: ${outputTail(guard.run.command, 300).replace(/\s+/g, " ")}`, evidenceRefs: [guard.run.record.ref], retryable: false }, "stop: the pull request touches .graphloom/");
    }
  }
  const checkout = commandState(view, COMMAND.checkout);
  const tree = commandState(view, COMMAND.headTree);
  const dir = commandState(view, COMMAND.reviewDir);
  const checked = [guard, checkout, tree, dir];
  const failed = checked.find((c) => c.failed && !c.retry);
  if (failed?.run !== undefined) {
    return supervise({ reason: `the checkout of the head failed: ${describeCommand(failed.run.command)}: ${outputTail(failed.run.command)}`, evidenceRefs: [failed.run.record.ref] }, "escalate a failed checkout");
  }
  if (checked.some((c) => c.run === undefined || c.retry)) {
    // One writer job with fixed argv: the only job of the run that changes the worktree's tracked files (design §4).
    const job: JobSpec = {
      stageId: FETCH_STAGE,
      kind: "command",
      purpose: "work",
      writeScope: ["."],
      instruction: "Materialize the pull request's head in the worktree (no hook, no filter, no repository code)",
      input: { commands: [guardCommand(pr.head), checkoutCommand(pr.head), headTreeCommand(pr.head), reviewDirCommand()], env: { ...GIT_ENV } },
    };
    return withPrivate(dispatch(job, `check out head ${pr.head.slice(0, 12)} over the pinned merge base`));
  }
  const s = snapshotState(view.evidence, pr, profile.limits);
  if (s.state === "reading") return withPrivate(dispatch(githubJob(s.next, readInput(s.next, pr, s.cursor)), s.why));
  if (s.state === "incompatible") return stop({ reason: "incompatible task", blocker: s.problem, evidenceRefs: s.refs.slice(-10), retryable: false }, "stop: this pull request cannot be reported");
  const ledger = commandState(view, COMMAND.ledger);
  if (ledger.failed && !ledger.retry && ledger.run !== undefined) {
    return supervise({ reason: `the ledger read failed: ${describeCommand(ledger.run.command)}`, evidenceRefs: [ledger.run.record.ref] }, "escalate a failed ledger read");
  }
  if (ledger.run === undefined || ledger.retry) {
    return withPrivate(dispatch(commandJob(FETCH_STAGE, "Read the pull request's ledger ref", { commands: [ledgerReadCommand(pr.owner, pr.repo, pr.number)], env: { ...GIT_ENV } }), "read the ledger ref, or record it absent"));
  }
  // The project's design principles file, read from the profile's ref or the pinned base, never the head (design §7.5.1).
  const configured = profile.questions.principles;
  const pinned = pinnedBase(view.evidence);
  if (configured !== undefined && pinned !== undefined) {
    const principles = commandState(view, COMMAND.principles);
    const mine = principles.run !== undefined && sameArgv(principles.run.command.argv, principlesReadCommand(configured, pinned).argv);
    if (principles.failed && !principles.retry && principles.run !== undefined && mine) {
      return supervise({ reason: `reading the design principles file failed: ${describeCommand(principles.run.command)}: ${outputTail(principles.run.command)}`, evidenceRefs: [principles.run.record.ref] }, "escalate a failed principles read");
    }
    if (principles.run === undefined || principles.retry || !mine) {
      return withPrivate(dispatch(commandJob(FETCH_STAGE, `Read the design principles file ${configured.path}`, { commands: [principlesReadCommand(configured, pinned)], env: { ...GIT_ENV } }), `read ${configured.path} at ${configured.ref ?? `the pinned base ${pinned.slice(0, 12)}`}, or record it absent`));
    }
  }
  // The sandbox images are checked, and pulled by digest when missing, here: before the run's no-network jobs, never during one.
  const probe = missingProbe(view.evidence, profile);
  if (probe.length > 0) return withPrivate(dispatch(sandboxProbeJob(FETCH_STAGE, probe), "check the Docker sandbox images by digest, and pull a missing one, before any sandboxed job"));
  return validateStage(ctx, view, FETCH_STAGE);
}

/** The image checks (and pulls) and the host cache lookups: graph commands that run no pull request code, from `/`. */
export function sandboxProbeJob(stageId: string, commands: EnvironmentCommand[]): JobSpec {
  return commandJob(stageId, "Check the Docker sandbox images by digest, pulling a missing one", { commands, continueOnFailure: true }, { timeoutMs: Math.min(MAX_JOB_TIMEOUT_MS, 35 * 60_000 * Math.max(1, commands.length)) });
}

/** The coverage job (design §12.2): the pull request's own tests, in the Docker sandbox, over a prepared checkout of the head. */
export function coverageJob(plan: CoveragePlan, root: string): JobSpec {
  const language = plan.language === "go" ? "Go" : "TypeScript";
  return {
    stageId: REPORT_STAGE,
    kind: "command",
    purpose: "diagnostic",
    readOnly: true,
    instruction: `Measure the changed ${language} functions' statement coverage with the pull request's own tests (Docker sandbox: no network, read-only dependency cache, a checkout of the head)`,
    input: { commands: plan.commands.map((c) => coverageCommand(c, root, plan.sandbox.wallClockMs)), continueOnFailure: true },
    checkout: { from: "candidate" },
    confinement: coverageConfinement(plan, root),
    timeoutMs: Math.min(MAX_JOB_TIMEOUT_MS, (plan.sandbox.wallClockMs + 120_000) * plan.commands.length + 10 * 60_000),
  };
}

/** Judges the stage's requirements with the shipped validators first, so a failure goes to the supervisor with its reason instead of looping. */
function validateStage(ctx: Context, view: RunView, stageId: string): GraphDecision {
  const stage = ctx.definition.stages.find((s) => s.id === stageId)!;
  const failures: string[] = [];
  for (const id of stage.requirementIds) {
    const binding = ctx.definition.defaultValidators.find((b) => b.requirementId === id)!;
    const statement = ctx.definition.requirements.find((r) => r.id === id)!.statement;
    const result = validatorById(binding.validatorId)!.evaluate({ requirementId: id, statement, evidence: validatorEvidence(view.evidence, view.candidateDigest), ...(view.candidateDigest !== undefined ? { candidateDigest: view.candidateDigest } : {}), config: view.config }) as ValidationResult;
    if (result.status !== "passed") failures.push(`${id}: ${result.reason}`);
  }
  if (failures.length > 0) {
    return supervise({ reason: `the ${stage.name} stage does not validate: ${failures.slice(0, 3).join("; ")}` }, `hand the failing ${stage.name} requirements to the supervisor`);
  }
  return withPrivate(validate({ stageId }, `validate ${stage.name} from the recorded evidence`));
}

/** The most paths one bwrap confinement can mask (`confinementProblem`'s bound). */
const MAX_MASKS = 64;

/**
 * The paths of repository-provided agent configuration (design §12.1) to hide from an agent: the usual
 * top-level ones, and for every file the pull request adds or changes under such a name, the topmost path
 * that carries it (`a/.claude` for `a/.claude/x/y`, `docs/CLAUDE.md` for itself). More than the confinement
 * can mask, or a path no mask can name, is refused, never left exposed.
 */
export function agentConfigMasks(worktree: string, changed: readonly string[]): { masks: string[] } | { problem: string } {
  const names = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "AGENTS.override.md", ".claude", ".codex", ".agents", ".pi", ".mcp.json", ".opencode"];
  const roots = new Set(names);
  for (const p of changed) {
    const segments = p.split("/");
    const at = segments.findIndex((seg) => names.includes(seg));
    if (at < 0) continue;
    const prefix = segments.slice(0, at + 1).join("/");
    if (/[\n\u0000]/.test(prefix) || segments.includes("..")) return { problem: `the pull request changes ${JSON.stringify(p)}, an agent-configuration path that no confinement mask can name` };
    roots.add(prefix);
  }
  if (roots.size > MAX_MASKS) return { problem: `the pull request adds or changes agent configuration in ${roots.size} places, more than the ${MAX_MASKS} paths one confinement can hide from the agents` };
  return { masks: [...roots].map((p) => path.posix.join(worktree, p)) };
}

/** What a job that cannot be built asks for: the pull request is refused when it is the pull request's fault, else the supervisor decides. */
function refused(job: { problem: string; incompatible?: true }): GraphDecision {
  if (job.incompatible === true) return stop({ reason: "incompatible task", blocker: job.problem, retryable: false }, "stop: the agents cannot be confined for this pull request");
  return supervise({ reason: job.problem }, "escalate a missing worktree path");
}

function agentJob(ctx: Context, view: RunView, spec: { jobId?: string; stageId?: string; purpose: "diagnostic" | "review"; instruction: string; schema: string; harness: string; role: Role; assignment: string; continueFrom?: string; readOnlyBinds?: readonly string[]; references?: Record<string, ReferenceSet> }, files: readonly PullFile[]): JobSpec | { problem: string; incompatible?: true } {
  const worktree = environmentOutput(view.evidence, ENV_WORKTREE);
  if (worktree === undefined || !path.isAbsolute(worktree)) return { problem: "the environment check recorded no worktree path, which the confinement masks need" };
  const masks = agentConfigMasks(worktree, files.flatMap((f) => [f.path, ...(f.previousPath !== null ? [f.previousPath] : [])]));
  if ("problem" in masks) return { problem: masks.problem, incompatible: true };
  // The role's model and effort travel as the job's harness options; a role that sets neither inherits the harness's own.
  const { model, effort } = ctx.profile.roleSettings[spec.role] ?? {};
  const harnessOptions = model !== undefined || effort !== undefined ? { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) } : undefined;
  return {
    ...(spec.jobId !== undefined ? { jobId: spec.jobId } : {}),
    stageId: spec.stageId ?? REPORT_STAGE,
    kind: "agent",
    purpose: spec.purpose,
    readOnly: true,
    instruction: spec.instruction,
    resultSchema: spec.schema,
    executor: CODING_AGENT,
    input: { assignment: spec.assignment, harness: spec.harness, ...(harnessOptions !== undefined ? { harnessOptions } : {}) },
    // The id fields of the contract are constrained to the ids this job lists (an enum in the schema the harness enforces).
    ...(spec.references !== undefined && Object.keys(spec.references).length > 0 ? { knownReferences: spec.references } : {}),
    // Untrusted-read confinement (design §12.2): home hidden, repository agent configuration masked, no GitHub token.
    confinement: { kind: "bwrap", network: true, mask: masks.masks, binds: (spec.readOnlyBinds ?? []).map((p) => ({ path: p, readOnly: true })) },
    ...(ctx.profile.agentTimeoutMs !== undefined ? { timeoutMs: ctx.profile.agentTimeoutMs } : {}),
    ...(spec.continueFrom !== undefined ? { continueFrom: spec.continueFrom } : {}),
  };
}

/** Where the base commit's files are exported for the agents (design §7.3), when the groundwork recorded the export. */
function baseTreeDir(view: RunView, groundwork: { baseTree?: unknown }): string | undefined {
  const worktree = environmentOutput(view.evidence, ENV_WORKTREE);
  return groundwork.baseTree !== undefined && worktree !== undefined && path.isAbsolute(worktree) ? baseDirIn(worktree) : undefined;
}

/** The newest session of job `jobId` in `stageId`, which no later job has continued. */
function jobSession(view: RunView, stageId: string, jobId: string): string | undefined {
  const sessions = (view.agentSessions ?? []).filter((s) => s.stageId === stageId && s.dispatchKey === jobId && s.status === "ok" && s.generation <= view.generation);
  const continued = new Set(sessions.map((s) => s.continuedFrom).filter((s) => s !== undefined));
  return sessions.filter((s) => !continued.has(s.operationId)).at(-1)?.operationId;
}

/** Only agent work spends an invocation; a job that cannot fit what an executor accepts stops the run, naming the limit. */
function dispatchAgent(view: RunView, job: JobSpec, summary: string): GraphDecision {
  if (view.budgets.agentInvocations <= 0) return stop({ reason: "budgets exhausted", blocker: "no agent invocations left", retryable: false }, `cannot ${summary}`);
  const executorId = job.executor?.id ?? CODING_AGENT.id;
  const shape = view.executors?.find((e) => e.id === executorId)?.inputShape;
  const problem = shape !== undefined ? jsonSchemaProblem(shape.schema, job.input) : undefined;
  if (problem !== undefined) {
    return stop({ reason: "incompatible task", blocker: `the input to ${summary} does not fit what ${executorId} declares: ${problem}; the pull request's files, facts and text are too large together`, retryable: false }, `stop: the input to ${summary} does not fit ${executorId}'s declared input shape`);
  }
  const sent = Buffer.byteLength(JSON.stringify(job.input ?? null), "utf8");
  if (sent > MAX_EXECUTOR_INPUT_BYTES) {
    return stop({ reason: "incompatible task", blocker: `the input to ${summary} is ${sent} bytes once serialized, more than the ${MAX_EXECUTOR_INPUT_BYTES} an executor input carries`, retryable: false }, `stop: the input to ${summary} does not fit an executor input`);
  }
  return withPrivate(dispatch(job, summary));
}

function report(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const a = analyze(view.evidence, profile, pr);
  if (a.state !== "ready") {
    return supervise({ reason: a.state === "pending" ? `the report stage lost the pull request snapshot: ${a.reason}` : a.problem }, "escalate a missing snapshot");
  }
  const { analysis } = a;
  const flow = reportFlow(view.evidence, analysis.ctx);
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved report to the supervisor");
    case "reporter": {
      const assignment = reporterInstruction({ pr, snapshot: analysis.snapshot, sections: analysis.sections, facts: analysis.facts, candidates: analysis.ctx.candidates ?? [], kind: flow.kind, feedback: flow.feedback });
      const from = flow.kind === "first" ? undefined : jobSession(view, REPORT_STAGE, REPORTER_JOB);
      const job = agentJob(ctx, view, { jobId: REPORTER_JOB, purpose: "diagnostic", instruction: "Write the change report", schema: flow.schema, harness: profile.roles.reporter, role: "reporter", assignment, ...(from !== undefined ? { continueFrom: from } : {}) }, analysis.snapshot.files);
      if ("problem" in job) return refused(job);
      const why = { first: "write the change report (read-only, confined)", correction: "correct the report: deterministic validation found problems", revision: "revise the report: the claim check did not support some items" }[flow.kind];
      return dispatchAgent(view, job, why);
    }
    case "checker": {
      const assignment = checkerInstruction({ pr, snapshot: analysis.snapshot, report: flow.report, targets: claimTargets(flow.report, analysis.ctx), retry: flow.retry });
      const targets = claimTargets(flow.report, analysis.ctx);
      const references = idRefs({ [CLAIM_CHECK_REFERENCES[0]!]: idSet(targets.map((t) => t.id), (id) => oneLineText(targets.find((t) => t.id === id)?.text ?? "").slice(0, 300)) });
      const job = agentJob(ctx, view, { purpose: "review", instruction: "Check the report's claims against the diff", schema: CLAIM_CHECK_SCHEMA_NAME, harness: profile.roles["report-checker"], role: "report-checker", assignment, references }, analysis.snapshot.files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check every report item with a fresh read-only ${harnessName(profile.roles["report-checker"])} session`);
    }
    case "done":
      return measureAndWrite(ctx, view, analysis, flow);
  }
}

/** Where a tool of the confined static job lives: the plugin's directory, and the Go and Node installations under a hidden home. */
function toolBinds(view: RunView, batches: ReadonlyArray<{ language: string }>): Array<{ path: string; readOnly: boolean }> | undefined {
  const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT);
  if (root === undefined) return undefined;
  const binds = [{ path: root, readOnly: true }];
  const goRoot = environmentOutput(view.evidence, "go-root");
  if (batches.some((b) => b.language === "go") && goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/") binds.push({ path: goRoot, readOnly: true });
  const nodeRoot = path.dirname(path.dirname(process.execPath));
  if (batches.some((b) => b.language === "typescript") && nodeRoot !== "/" && nodeRoot !== ".") binds.push({ path: nodeRoot, readOnly: true });
  return binds;
}

function measureAndWrite(ctx: Context, view: RunView, analysis: Analysis, flow: Extract<ReturnType<typeof reportFlow>, { state: "done" }>): GraphDecision {
  const { profile, pr } = ctx;
  const m = measurementState(view.evidence, analysis.snapshot.files, profile, retryOf(view));
  switch (m.state) {
    case "observe":
      return withPrivate(observe({ paths: m.paths }, "observe the changed files the static tools measure, so their records can be recomputed from the head's bytes"));
    case "diff": {
      const diff = commandState(view, COMMAND.metricsDiff);
      if (diff.failed && !diff.retry && diff.run !== undefined) return supervise({ reason: `the changed-lines diff failed: ${describeCommand(diff.run.command)}`, evidenceRefs: [diff.run.record.ref] }, "escalate a failed diff");
      return withPrivate(dispatch(commandJob(REPORT_STAGE, "List the changed lines (git diff -U0 -w)", { commands: [metricsDiffCommand()], env: { ...GIT_ENV } }), "list the head-side changed lines for the static metrics tools"));
    }
    case "tools": {
      const binds = toolBinds(view, m.batches);
      if (binds === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the static tools run from" }, "escalate a missing plugin path");
      const batches = m.batches.slice(0, 16);
      const generated = profile.metrics.generated;
      const goRoot = environmentOutput(view.evidence, "go-root");
      const goBin = goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/" ? path.join(goRoot, "bin", "go") : "go";
      const commands = batches.map((b) => staticCommand(b, m.hunks, binds[0]!.path, generated, process.execPath, goBin));
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Measure the changed functions' complexity and nesting (parse only; no network; no repository code runs)",
        input: { commands, continueOnFailure: true },
        confinement: { kind: "bwrap", network: false, mask: [], binds },
      };
      return withPrivate(dispatch(job, `measure ${batches.length} batch(es) of changed files with the static metrics tools, confined with no network`));
    }
    case "baseFiles":
      // The modified functions' base files, as `git show <base>:<path>` prints them: read-only, no repository code.
      return withPrivate(dispatch(commandJob(REPORT_STAGE, "Read the base versions of the modified files (git show <base>:<path>)", { commands: m.commands.slice(0, 16), continueOnFailure: true, env: { ...GIT_ENV } }), `read ${Math.min(16, m.commands.length)} base file(s) so each modified function can be measured at the base too`));
    case "baseTools": {
      const binds = toolBinds(view, m.batches);
      if (binds === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the static tools run from" }, "escalate a missing plugin path");
      const batches = m.batches.slice(0, 16);
      const goRoot = environmentOutput(view.evidence, "go-root");
      const goBin = goRoot !== undefined && path.isAbsolute(goRoot) && goRoot !== "/" ? path.join(goRoot, "bin", "go") : "go";
      const commands = batches.map((b) => staticBaseCommand(b, m.base, binds[0]!.path, profile.metrics.generated, process.execPath, goBin));
      const job: JobSpec = {
        stageId: REPORT_STAGE,
        kind: "command",
        purpose: "diagnostic",
        readOnly: true,
        instruction: "Measure the modified functions at the base: complexity and nesting by the same static tools over the base files (parse only; no network; no repository code runs)",
        input: { commands, continueOnFailure: true, env: { ...GIT_ENV } },
        confinement: { kind: "bwrap", network: false, mask: [], binds },
      };
      return withPrivate(dispatch(job, `measure ${batches.length} base file(s) with the static metrics tools, confined with no network`));
    }
    case "probe":
      return withPrivate(dispatch(sandboxProbeJob(REPORT_STAGE, m.commands), "check the Docker sandbox images by digest: Fetch did not record them"));
    case "coverage": {
      const root = environmentOutput(view.evidence, ENV_PLUGIN_ROOT);
      if (root === undefined) return supervise({ reason: "the environment check recorded no plugin directory, which the coverage scripts run from" }, "escalate a missing plugin path");
      return withPrivate(dispatch(coverageJob(m.plan, root), `measure statement coverage of the changed ${m.plan.language} functions in the Docker sandbox over a checkout of the head`));
    }
    case "failed":
      return supervise({ reason: `the measurements failed: ${m.problems.slice(0, 3).join("; ")}`, evidenceRefs: m.refs.slice(-10) }, "hand the failed measurements to the supervisor");
    default:
      break;
  }
  const outputs = outputsOf(view.evidence, profile, pr, analysis, flow, m);
  const write = commandState(view, COMMAND.reportWrite);
  if (write.run !== undefined && !write.failed) {
    const written = writtenReport(write.run.command.argv);
    if (written?.json === outputs.json && (written.markdown === outputs.markdown || /… \(cut short; see [^)]*\)\n$/.test(written.markdown))) {
      return validateStage(ctx, view, REPORT_STAGE);
    }
  }
  if (write.failed && !write.retry && write.run !== undefined) {
    return supervise({ reason: `writing the report failed: ${describeCommand(write.run.command)}: ${outputTail(write.run.command)}`, evidenceRefs: [write.run.record.ref] }, "escalate a failed report write");
  }
  if (commandRuns(view.evidence, COMMAND.reportWrite).length >= 4) {
    return supervise({ reason: "the written report keeps differing from the one the evidence recomputes" }, "escalate a report write that does not settle");
  }
  const secrets = [...secretFindings(outputs.json), ...secretFindings(outputs.markdown)];
  if (secrets.length > 0) {
    return stop({ reason: "report refused", blocker: `the report would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a report that holds a secret");
  }
  const command = reportWriteCommand(outputs.json, outputs.markdown);
  if (command === undefined) {
    return stop({ reason: "incompatible task", blocker: "the report is too large for one write command", retryable: false }, "stop: the report does not fit one command");
  }
  const idNotes = flow.reading.notes.length > 0 ? `; claim-check ids normalized: ${flow.reading.notes.slice(0, 4).join("; ")}` : "";
  return withPrivate(dispatch(commandJob(REPORT_STAGE, `Write ${REVIEW_MD} and report.json`, { commands: [command] }), `write report.json and the readable review.md${idNotes}`));
}

/** Whether a failed command may run again: the operator resumed since it failed. */
const retryOf = (view: RunView) => (run: CommandRun): boolean => isStaleFailure(run.record, view);

/** What the groundwork still needs, as the decision that gets it (or stops the run). */
function groundworkDecision(step: Extract<ReturnType<typeof qaContext>, { state: "groundwork" }>["step"], stageId: string): GraphDecision {
  switch (step.state) {
    case "observe":
      return withPrivate(observe({ paths: step.paths }, "observe the changed source files the symbol extraction reads, so symbols come from the head's bytes"));
    case "run":
      return withPrivate(dispatch(commandJob(stageId, "Read the base commit for the groundwork (declarations, searches, dependencies)", { commands: step.commands, env: { ...GIT_ENV } }), step.why));
    case "failed":
      return supervise({ reason: `the groundwork could not be read: ${step.problems.join("; ")}`, evidenceRefs: step.refs.slice(-10) }, "hand a failed groundwork read to the supervisor");
    case "incompatible":
      return stop({ reason: "incompatible task", blocker: step.problem, retryable: false }, "stop: the pull request is past a profile limit");
  }
}

function questions(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const c = qaContext(view.evidence, profile, pr, retryOf(view));
  if (c.state === "pending") return supervise({ reason: `the Questions stage lost what it reads: ${c.reason}` }, "escalate a missing report or snapshot");
  if (c.state === "groundwork") return groundworkDecision(c.step, QUESTIONS_STAGE);
  const files = c.ctx.analysis.snapshot.files;
  // N1, the necessity question, comes first (design §7.5): answered and checked before any other question is asked.
  const nf = necessityFlow(view.evidence, c.ctx, retryOf(view));
  switch (nf.state) {
    case "supervise":
      return supervise({ reason: nf.reason, evidenceRefs: nf.refs }, "hand the unresolved necessity answer to the supervisor");
    case "answerer": {
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const assignment = necessityInstruction({ pr, snapshot: c.ctx.analysis.snapshot, view: c.ctx.view, designDocs: c.ctx.designDocs, context: c.ctx.context, kind: nf.kind, feedback: nf.feedback, ...(c.ctx.principles !== undefined ? { principles: c.ctx.principles } : {}), ...(baseDir !== undefined ? { baseDir } : {}) });
      const from = nf.kind === "first" ? undefined : jobSession(view, QUESTIONS_STAGE, ANSWERER_JOB);
      const references = principleRefs(NECESSITY_REFERENCES[0]!, c.ctx.principles?.applicable ?? []);
      const job = agentJob(ctx, view, { jobId: ANSWERER_JOB, stageId: QUESTIONS_STAGE, purpose: "diagnostic", instruction: "Answer the necessity question N1 from the whole codebase", schema: nf.schema, harness: profile.roles.answerer, role: "answerer", assignment, references, ...(from !== undefined ? { continueFrom: from } : {}) }, files);
      if ("problem" in job) return refused(job);
      const why = { first: "answer the necessity question N1 (read-only, confined): is the problem real, does the fix fit the design, is there a simpler way", correction: "correct the necessity answer: deterministic validation found problems", revision: "revise the necessity answer: the answer checker did not support it" }[nf.kind];
      return dispatchAgent(view, job, why);
    }
    case "verify":
      return withPrivate(dispatch(commandJob(QUESTIONS_STAGE, "Check the necessity answer's citations against the trees", { commands: nf.commands.slice(0, 16), env: { ...GIT_ENV } }), "resolve each citation of the necessity answer in the tree it names"));
    case "checker": {
      const answer = nf.answers.get(NECESSITY_ID)!;
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const assignment = necessityCheckerInstruction({ pr, snapshot: c.ctx.analysis.snapshot, question: necessityQuestion(), answer, designDocs: c.ctx.designDocs, context: c.ctx.context, retry: nf.retry, ...(c.ctx.principles !== undefined ? { principles: c.ctx.principles } : {}), ...(baseDir !== undefined ? { baseDir } : {}) });
      const references = idRefs({ ...questionRefs(ANSWER_CHECK_REFERENCES[0]!, [necessityQuestion()]), ...principleRefs(ANSWER_CHECK_REFERENCES[1]!, c.ctx.principles?.applicable ?? []) });
      const job = agentJob(ctx, view, { stageId: QUESTIONS_STAGE, purpose: "review", instruction: "Check the necessity answer against the trees", schema: ANSWER_CHECK_SCHEMA_NAME, harness: profile.roles["answer-checker"], role: "answer-checker", assignment, references }, files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check the necessity answer with a fresh read-only ${harnessName(profile.roles["answer-checker"])} session`);
    }
    case "done":
      break;
  }
  const record: NecessityRecord = necessityRecordOf(c.ctx, nf.final[0]!, pr.askAll === true);
  const command = necessityRecordCommand(record);
  if (command === undefined) return stop({ reason: "incompatible task", blocker: "the necessity answer is too large for one write command", retryable: false }, "stop: the necessity record does not fit one command");
  const write = commandState(view, COMMAND.necessityWrite);
  if (write.run === undefined || write.failed || !sameArgv(write.run.command.argv, command.argv)) {
    if (write.failed && !write.retry && write.run !== undefined) {
      return supervise({ reason: `recording the necessity answer failed: ${describeCommand(write.run.command)}: ${outputTail(write.run.command)}`, evidenceRefs: [write.run.record.ref] }, "escalate a failed necessity write");
    }
    if (commandRuns(view.evidence, COMMAND.necessityWrite).length >= 4) return supervise({ reason: "the recorded necessity answer keeps differing from the one the evidence recomputes" }, "escalate a necessity write that does not settle");
    return withPrivate(dispatch(commandJob(QUESTIONS_STAGE, `Record N1's checked answer and its decision in ${NECESSITY_JSON}`, { commands: [command] }), `record N1's outcome (${record.decision.action === "skip" ? "the other questions are skipped" : "every question is asked"}) as evidence`));
  }
  if (record.decision.action === "skip") return validateStage(ctx, view, QUESTIONS_STAGE);
  const flow = questionerFlow(view.evidence, c.ctx);
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved questions to the supervisor");
    case "questioner": {
      const required = requiredQuestions({ view: c.ctx.view, groundwork: c.ctx.groundwork }, new Map());
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const assignment = questionerInstruction({ pr, snapshot: c.ctx.analysis.snapshot, view: c.ctx.view, groundwork: c.ctx.groundwork, required, feedback: flow.feedback, kind: flow.kind, ...(baseDir !== undefined ? { baseDir } : {}) });
      const from = flow.kind === "first" ? undefined : jobSession(view, QUESTIONS_STAGE, QUESTIONER_JOB);
      const itemIds = c.ctx.view.items.map((i) => i.id);
      const symbolIds = c.ctx.groundwork.symbols.map((x) => x.id);
      const references = idRefs({ "purposes[].item": idSet(itemIds), "questions[].item": idSet(itemIds), "questions[].symbol": idSet(["", ...symbolIds]) });
      const job = agentJob(ctx, view, { jobId: QUESTIONER_JOB, stageId: QUESTIONS_STAGE, purpose: "diagnostic", instruction: "Ask the questions (ask only; never answer)", schema: QUESTIONS_SCHEMA_NAME, harness: profile.roles.questioner, role: "questioner", assignment, references, ...(from !== undefined ? { continueFrom: from } : {}) }, files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, flow.kind === "first" ? "ask the questions (read-only, confined)" : "correct the questions: deterministic validation found problems");
    }
    case "done":
      return validateStage(ctx, view, QUESTIONS_STAGE);
  }
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

function answers(ctx: Context, view: RunView): GraphDecision {
  const { profile, pr } = ctx;
  const c = qaContext(view.evidence, profile, pr, retryOf(view));
  if (c.state === "pending") return supervise({ reason: `the Answers stage lost what it reads: ${c.reason}` }, "escalate a missing report or snapshot");
  if (c.state === "groundwork") return supervise({ reason: `the Answers stage lost the groundwork the questions rest on (${c.step.state})` }, "escalate a missing groundwork");
  // N1's checked answer and decision are the recorded evidence of the Questions stage (design §7.5).
  const rec = recordedNecessity(view.evidence);
  if (rec.state !== "read") return supervise({ reason: `the Answers stage lost the necessity record (${rec.state === "failed" ? rec.reason : "none was written"})` }, "escalate a missing necessity record");
  const skipped = rec.record.decision.action === "skip";
  let output: Parameters<typeof questionSet>[1];
  if (!skipped) {
    const qf = questionerFlow(view.evidence, c.ctx);
    if (qf.state !== "done") return supervise({ reason: `the Answers stage lost the questions (${qf.state})` }, "escalate missing questions");
    output = qf.output;
  }
  const set = questionSet(c.ctx, output, skipped);
  // A confirmed unnecessary N1 is the only question: nothing else is answered or checked.
  if (skipped) return writeAnswers(ctx, view, c.ctx, set, [rec.record.final], rec.record);
  const rest = afterNecessity(set);
  const actx = answerContext(c.ctx, rest);
  const flow = answersFlow(view.evidence, actx, c.ctx.base, retryOf(view));
  const files = c.ctx.analysis.snapshot.files;
  switch (flow.state) {
    case "supervise":
      return supervise({ reason: flow.reason, evidenceRefs: flow.refs }, "hand the unresolved answers to the supervisor");
    case "answerer": {
      const mounted = sourceDirs(c.ctx.groundwork.inventory);
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const assignment = answererInstruction({ pr, snapshot: c.ctx.analysis.snapshot, view: c.ctx.view, groundwork: c.ctx.groundwork, questions: rest, kind: flow.kind, feedback: flow.feedback, ...(flow.only !== undefined ? { only: flow.only } : {}), mountedDirs: mounted, ...(baseDir !== undefined ? { baseDir } : {}) });
      const from = flow.kind === "first" ? undefined : jobSession(view, ANSWERS_STAGE, ANSWERER_JOB);
      // Untrusted-read confinement, with the dependency source mounted read-only (design §7.3).
      const references = questionRefs(ANSWERS_REFERENCES[0]!, flow.only !== undefined ? rest.filter((q) => flow.only!.includes(q.id)) : rest);
      const job = agentJob(ctx, view, { jobId: ANSWERER_JOB, stageId: ANSWERS_STAGE, purpose: "diagnostic", instruction: "Answer the questions from the whole codebase", schema: flow.schema, harness: profile.roles.answerer, role: "answerer", assignment, readOnlyBinds: mounted, references, ...(from !== undefined ? { continueFrom: from } : {}) }, files);
      if ("problem" in job) return refused(job);
      const why = { first: "answer the questions (read-only, confined, dependency source mounted read-only)", correction: "correct the answers: deterministic validation found problems", revision: "revise the answers: the answer checker did not support some" }[flow.kind];
      return dispatchAgent(view, job, why);
    }
    case "verify":
      return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Check the answers' citations and proposed names against the trees", { commands: flow.commands.slice(0, 16), env: { ...GIT_ENV } }), "resolve each citation in the tree it names, and each proposed name in the package"));
    case "checker": {
      const mounted = sourceDirs(c.ctx.groundwork.inventory);
      const baseDir = baseTreeDir(view, c.ctx.groundwork);
      const assignment = answerCheckerInstruction({ pr, snapshot: c.ctx.analysis.snapshot, groundwork: c.ctx.groundwork, questions: rest, answers: flow.answers, retry: flow.retry, mountedDirs: mounted, ...(baseDir !== undefined ? { baseDir } : {}) });
      // The same dependency source, read-only, so a library or dependency citation can be re-checked where it points.
      const job = agentJob(ctx, view, { stageId: ANSWERS_STAGE, purpose: "review", instruction: "Check the answers against the trees", schema: ANSWER_CHECK_SCHEMA_NAME, harness: profile.roles["answer-checker"], role: "answer-checker", assignment, readOnlyBinds: mounted, references: questionRefs(ANSWER_CHECK_REFERENCES[0]!, rest) }, files);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check every answer with a fresh read-only ${harnessName(profile.roles["answer-checker"])} session`);
    }
    case "done":
      return writeAnswers(ctx, view, c.ctx, set, [rec.record.final, ...flow.final], rec.record);
  }
}

/** After the answers: write qa.json and review.md, advance the ledger by compare-and-swap, then validate the stage. */
function writeAnswers(ctx: Context, view: RunView, c: QaContext, set: ReturnType<typeof questionSet>, final: Parameters<typeof qaOutputs>[2], necessity: NecessityRecord): GraphDecision {
  const w = answerWrites(view.evidence, c, set, final, necessity);
  if (w.qa === undefined) return stop({ reason: "incompatible task", blocker: w.problem ?? "the Q&A cannot be written", retryable: false }, "stop: the Q&A does not fit one write command");
  const write = commandState(view, COMMAND.qaWrite);
  if (write.run === undefined || write.failed || !sameArgv(write.run.command.argv, w.qa.argv)) {
    if (write.failed && !write.retry && write.run !== undefined) {
      return supervise({ reason: `writing the Q&A failed: ${describeCommand(write.run.command)}: ${outputTail(write.run.command)}`, evidenceRefs: [write.run.record.ref] }, "escalate a failed Q&A write");
    }
    if (commandRuns(view.evidence, COMMAND.qaWrite).length >= 4) return supervise({ reason: "the written Q&A keeps differing from the one the evidence recomputes" }, "escalate a Q&A write that does not settle");
    const written = writtenQa(w.qa.argv);
    const secrets = [...secretFindings(written?.json ?? ""), ...secretFindings(written?.markdown ?? "")];
    if (secrets.length > 0) {
      return stop({ reason: "report refused", blocker: `the Q&A would hold what looks like a credential (${[...new Set(secrets)].slice(0, 3).join("; ")}); it was not written`, retryable: false }, "refuse to write a Q&A that holds a secret");
    }
    return withPrivate(dispatch(commandJob(ANSWERS_STAGE, `Write ${QA_JSON} and ${REVIEW_MD}`, { commands: [w.qa] }), "write qa.json and the whole review.md (Report, Measurements, Q&A)"));
  }
  return recordLedger(ctx, view, c, w);
}

function recordLedger(ctx: Context, view: RunView, c: QaContext, w: ReturnType<typeof answerWrites>): GraphDecision {
  const read = ledgerRead(view.evidence);
  const lw = commandState(view, COMMAND.ledgerWrite);
  if (read === undefined || w.old === undefined) return supervise({ reason: w.problem ?? "the ledger value Fetch read is not in the evidence" }, "escalate a missing ledger read");
  const ref = writtenLedger(lw.run?.command.argv ?? [])?.ref ?? "the ledger ref";
  if (lw.run !== undefined && lw.failed) {
    if (!lw.retry) {
      if (lw.run.command.exitCode === LEDGER_MOVED) {
        return stop({ reason: "ledger moved", blocker: `another run advanced ${ref} after Fetch read it; resume to read it again and record this head after it`, evidenceRefs: [lw.run.record.ref], retryable: true }, "stop: lost the compare-and-swap on the ledger");
      }
      return supervise({ reason: `advancing the ledger failed: ${describeCommand(lw.run.command)}: ${outputTail(lw.run.command)}`, evidenceRefs: [lw.run.record.ref] }, "escalate a failed ledger write");
    }
    // After the operator's resume: read the ledger again first, since the value the write swapped from was stale.
    const at = (r: string): number => view.evidence.findIndex((e) => e.ref === r);
    if (at(read.run.record.ref) < at(lw.run.record.ref)) {
      return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Read the pull request's ledger ref again", { commands: [ledgerReadCommand(c.pr.owner, c.pr.repo, c.pr.number)], env: { ...GIT_ENV } }), "read the ledger ref again: it moved since Fetch read it"));
    }
  }
  const lr = commandState(view, COMMAND.ledger);
  if (lr.failed && lr.run !== undefined) return supervise({ reason: `the ledger read failed: ${describeCommand(lr.run.command)}`, evidenceRefs: [lr.run.record.ref] }, "escalate a failed ledger read");
  if (w.prior?.state === "missing" || (w.prior?.state === "unreadable" && retryOf(view)(w.prior.run))) {
    return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Read the prior ledger's ledger.json", { commands: [priorShowCommand(w.old)], continueOnFailure: true, env: { ...GIT_ENV } }), "read the prior ledger.json, so the new one keeps its heads"));
  }
  if (w.prior?.state === "unreadable") {
    return supervise({ reason: w.problem ?? "the prior ledger cannot be read", evidenceRefs: [w.prior.run.record.ref] }, "escalate a prior ledger that cannot be read: it is never overwritten");
  }
  if (w.ledger === undefined) return stop({ reason: "incompatible task", blocker: w.problem ?? "the ledger files cannot be written", retryable: false }, "stop: the ledger files do not fit one command");
  if (lw.run !== undefined && !lw.failed && sameArgv(lw.run.command.argv, w.ledger.argv)) return validateStage(ctx, view, ANSWERS_STAGE);
  if (commandRuns(view.evidence, COMMAND.ledgerWrite).length >= 6) return supervise({ reason: "the ledger write keeps differing from the one the evidence recomputes" }, "escalate a ledger write that does not settle");
  return withPrivate(dispatch(commandJob(ANSWERS_STAGE, "Advance the pull request's ledger ref by compare-and-swap (no repository code runs)", { commands: [w.ledger], env: { ...GIT_ENV } }), "record this head's report and Q&A in the ledger, from the value Fetch read"));
}
