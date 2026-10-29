// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import path from "node:path";
import {
  dispatch,
  isStaleFailure,
  jsonSchemaProblem,
  MAX_EXECUTOR_INPUT_BYTES,
  observe,
  stop,
  supervise,
  validate,
  type AgentRoleDeclaration,
  type EnvironmentCommand,
  type GraphBudgetDefaults,
  type GraphDecision,
  type GraphDefinition,
  type GraphPlugin,
  type JobSpec,
  type Requirement,
  type RunView,
  type ValidationResult,
  type ValidatorBinding,
} from "@graphloom/sdk";
import { analyze, type Analysis } from "./analysis.js";
import { checkoutCommand, GIT_ENV, GUARD_REFUSED, guardCommand, headTreeCommand, ledgerReadCommand, reviewDirCommand } from "./commands.js";
import {
  ANSWERS_STAGE,
  CODING_AGENT,
  COMMAND,
  ENV_PLUGIN_ROOT,
  ENV_WORKTREE,
  FETCH_STAGE,
  NOT_IMPLEMENTED,
  QUESTIONS_STAGE,
  REPORTER_JOB,
  REPORT_STAGE,
  REQUIREMENT_ANSWERS,
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
  REVIEW_MD,
} from "./constants.js";
import { commandRuns, describeCommand, environmentOutput, outputTail, succeeded, validatorEvidence, type CommandRun } from "./evidence.js";
import { CHANGE_REPORT_SCHEMA } from "./report.js";
import { CLAIM_CHECK_SCHEMA } from "./claims.js";
import { itemsOf, REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME, reportFlow } from "./flow.js";
import { measurementState, metricsDiffCommand, staticCommand, type Batch } from "./measurements.js";
import { checkerInstruction, reporterInstruction } from "./prompts.js";
import { harnessName, parseProfile, ProfileError, ROLES, DISTINCT_PAIRS, type Profile } from "./profile.js";
import { requestedPull, type PullRequest } from "./request.js";
import { secretFindings } from "./secrets.js";
import { readInput, snapshotState, type ReadSpec } from "./snapshot.js";
import { CLAIM_CHECK_SCHEMA_NAME } from "./claims.js";
import { outputsOf, validatorById } from "./validators.js";
import { reportWriteCommand, writtenReport } from "./write.js";

export { GRAPH_ID, GRAPH_VERSION };

const asSchema = (schema: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;

/** The defaults the design gives a pr-review run (design §13.3), under the profile's own and the task's. */
const DEFAULT_BUDGETS: GraphBudgetDefaults = { agentInvocations: 1_200, jobs: 220, decisions: 240, corrections: 12, activeMs: 4 * 3_600_000, waitMs: 6 * 3_600_000 };

/** Environment checks the graph adds to the profile's: where the worktree, the plugin and Go live (for the confined static tools). */
function generatedChecks(): EnvironmentCommand[] {
  return [
    { id: ENV_WORKTREE, argv: ["sh", "-c", "pwd -P"] },
    {
      id: ENV_PLUGIN_ROOT,
      argv: ["sh", "-c", 'r=${GRAPHLOOM_PLUGIN_ROOT:-}; [ -n "$r" ] || { echo "GRAPHLOOM_PLUGIN_ROOT is not set: GraphLoom sets it to the plugin\'s directory for environment checks" >&2; exit 127; }; cd "$r" && pwd -P'],
    },
    { id: "go-root", argv: ["sh", "-c", "go env GOROOT 2>/dev/null || true"] },
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
      statement: `For every function the pull request adds or modifies, complexity and nesting were measured by the pinned static tools (gometrics, tsmetrics) over the head tree, under bwrap with no network, and every value recomputes from its evidence. Coverage and mutation run the pull request's own tests, which belongs in the Docker sandbox that a later version brings; in this version each record says so: ${profile.metrics.coverage ? "not run (coverage arrives in a later wave)" : "not run (coverage disabled by the profile)"}, CRAP shown as its upper bound.`,
      evidenceSchema: "graphloom-metrics-v1",
    },
    {
      id: REQUIREMENT_CLAIMS,
      statement: `An independent ${checker} report checker, on a harness other than the reporter's, judged every report item against the diff, and every item left is supported with quotes that match the diff's text. An item that was not supported after one revision is removed and recorded, and its file is accounted for in "other".`,
      evidenceSchema: CLAIM_CHECK_SCHEMA_NAME,
    },
    {
      id: REQUIREMENT_QUESTIONS,
      statement: `Every required question was asked (purpose, existing equivalent, reuse of a library, common logic, missing test, split function, complexity and coverage, weak test). The Questions stage is ${NOT_IMPLEMENTED}: this requirement fails closed.`,
      evidenceSchema: "questions-v1",
    },
    {
      id: REQUIREMENT_ANSWERS,
      statement: `Every question has an answer with evidence and a status. The Answers stage is ${NOT_IMPLEMENTED}: this requirement fails closed.`,
      evidenceSchema: "answers-v1",
    },
    {
      id: REQUIREMENT_GROUNDED,
      statement: `An independent checker re-checked every answer against the trees. The Answers stage is ${NOT_IMPLEMENTED}: this requirement fails closed.`,
      // The answer checker's own result shape arrives with the Answers stage. It is not claim-check-v1 yet,
      // so no report-checker reply is ever walked against this requirement's closed validator.
      evidenceSchema: "answer-check-v1",
    },
  ];
  const bindings: ValidatorBinding[] = [
    { requirementId: REQUIREMENT_SNAPSHOT, validatorId: "pr-snapshot", version: "1" },
    { requirementId: REQUIREMENT_CHECKED_OUT, validatorId: "head-tree", version: "1" },
    { requirementId: REQUIREMENT_LEDGER, validatorId: "review-scope", version: "1" },
    { requirementId: REQUIREMENT_REPORT, validatorId: "change-report", version: "1" },
    { requirementId: REQUIREMENT_MEASUREMENTS, validatorId: "measurements", version: "1" },
    { requirementId: REQUIREMENT_CLAIMS, validatorId: "claims-checked", version: "1", independence: "separate-reviewer" },
    { requirementId: REQUIREMENT_QUESTIONS, validatorId: "questions-complete", version: "1" },
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
      { name: CLAIM_CHECK_SCHEMA_NAME, schema: asSchema(CLAIM_CHECK_SCHEMA), evidenceKind: "review" },
    ],
    stages: [
      { id: FETCH_STAGE, name: "Fetch", requirementIds: [REQUIREMENT_SNAPSHOT, REQUIREMENT_CHECKED_OUT, REQUIREMENT_LEDGER] },
      { id: REPORT_STAGE, name: "Report", requirementIds: [REQUIREMENT_REPORT, REQUIREMENT_MEASUREMENTS, REQUIREMENT_CLAIMS] },
      { id: QUESTIONS_STAGE, name: "Questions", requirementIds: [REQUIREMENT_QUESTIONS] },
      { id: ANSWERS_STAGE, name: "Answers", requirementIds: [REQUIREMENT_ANSWERS, REQUIREMENT_GROUNDED] },
    ],
    requirements,
    defaultValidators: bindings,
    environment: { checks: [...structuredClone(profile.environment.checks), ...generatedChecks()] },
    defaultBudgets: { ...DEFAULT_BUDGETS, ...(profile.budgets ?? {}) },
    agentRoles: agentRoles(profile),
    supervisor: structuredClone(profile.supervisorPreference),
  };
}

/**
 * The roles the profile assigns harnesses to (design §13.1), for `graphloom
 * doctor --task`. The questioner and the answerer belong to stages this
 * version does not run, and are declared so the operator sees the whole role
 * set, with its distinctness constraints, now.
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
  if (stage === undefined || stage.id === QUESTIONS_STAGE || stage.id === ANSWERS_STAGE) {
    return withPrivate(
      stop(
        { reason: "report ready", blocker: `the report is written to ${REVIEW_MD} in the worktree; the Questions and Answers stages are ${NOT_IMPLEMENTED}, so the run ends here`, retryable: false },
        "the report is ready; questions and answers are not built in this version",
      ),
    );
  }
  return stage.id === FETCH_STAGE ? fetch(ctx, view) : report(ctx, view);
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
  return validateStage(ctx, view, FETCH_STAGE);
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

function agentJob(ctx: Context, view: RunView, spec: { jobId?: string; purpose: "diagnostic" | "review"; instruction: string; schema: string; harness: string; assignment: string; continueFrom?: string }, analysis: Analysis): JobSpec | { problem: string; incompatible?: true } {
  const worktree = environmentOutput(view.evidence, ENV_WORKTREE);
  if (worktree === undefined || !path.isAbsolute(worktree)) return { problem: "the environment check recorded no worktree path, which the confinement masks need" };
  const masks = agentConfigMasks(worktree, analysis.snapshot.files.flatMap((f) => [f.path, ...(f.previousPath !== null ? [f.previousPath] : [])]));
  if ("problem" in masks) return { problem: masks.problem, incompatible: true };
  return {
    ...(spec.jobId !== undefined ? { jobId: spec.jobId } : {}),
    stageId: REPORT_STAGE,
    kind: "agent",
    purpose: spec.purpose,
    readOnly: true,
    instruction: spec.instruction,
    resultSchema: spec.schema,
    executor: CODING_AGENT,
    input: { assignment: spec.assignment, harness: spec.harness },
    // Untrusted-read confinement (design §12.2): home hidden, repository agent configuration masked, no GitHub token.
    confinement: { kind: "bwrap", network: true, mask: masks.masks, binds: [] },
    ...(ctx.profile.agentTimeoutMs !== undefined ? { timeoutMs: ctx.profile.agentTimeoutMs } : {}),
    ...(spec.continueFrom !== undefined ? { continueFrom: spec.continueFrom } : {}),
  };
}

/** The newest reporter session, which no later job has continued. */
function reporterSession(view: RunView): string | undefined {
  const sessions = (view.agentSessions ?? []).filter((s) => s.stageId === REPORT_STAGE && s.dispatchKey === REPORTER_JOB && s.status === "ok" && s.generation <= view.generation);
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
      const assignment = reporterInstruction({ pr, snapshot: analysis.snapshot, sections: analysis.sections, facts: analysis.facts, kind: flow.kind, feedback: flow.feedback });
      const from = flow.kind === "first" ? undefined : reporterSession(view);
      const job = agentJob(ctx, view, { jobId: REPORTER_JOB, purpose: "diagnostic", instruction: "Write the change report", schema: flow.schema, harness: profile.roles.reporter, assignment, ...(from !== undefined ? { continueFrom: from } : {}) }, analysis);
      if ("problem" in job) return refused(job);
      const why = { first: "write the change report (read-only, confined)", correction: "correct the report: deterministic validation found problems", revision: "revise the report: the claim check did not support some items" }[flow.kind];
      return dispatchAgent(view, job, why);
    }
    case "checker": {
      const assignment = checkerInstruction({ pr, snapshot: analysis.snapshot, report: flow.report, items: itemsOf(flow.report, analysis.ctx), retry: flow.retry });
      const job = agentJob(ctx, view, { purpose: "review", instruction: "Check the report's claims against the diff", schema: CLAIM_CHECK_SCHEMA_NAME, harness: profile.roles["report-checker"], assignment }, analysis);
      if ("problem" in job) return refused(job);
      return dispatchAgent(view, job, `check every report item with a fresh read-only ${harnessName(profile.roles["report-checker"])} session`);
    }
    case "done":
      return measureAndWrite(ctx, view, analysis, flow);
  }
}

/** Where a tool of the confined static job lives: the plugin's directory, and the Go and Node installations under a hidden home. */
function toolBinds(view: RunView, batches: readonly Batch[]): Array<{ path: string; readOnly: boolean }> | undefined {
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
  const m = measurementState(view.evidence, analysis.snapshot.files, profile);
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
      const commands = batches.map((b) => staticCommand(b, m.hunks, binds[0]!.path, generated, process.execPath));
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
    case "failed":
      return supervise({ reason: `the static measurements failed: ${m.problems.slice(0, 3).join("; ")}`, evidenceRefs: m.refs.slice(-10) }, "hand the failed measurements to the supervisor");
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
  return withPrivate(dispatch(commandJob(REPORT_STAGE, `Write ${REVIEW_MD} and report.json`, { commands: [command] }), "write report.json and the readable review.md"));
}
