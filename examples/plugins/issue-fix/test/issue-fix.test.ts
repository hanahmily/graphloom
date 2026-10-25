import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentSessionView, EvidenceRecord, GraphDecision, JobSpec, Receipt, RunView, Validator } from "@graphloom/sdk";
import {
  acceptanceItems,
  CODE_REVIEW_SCHEMA,
  DECISION_RECORD_SCHEMA,
  parseDecisionRecord,
  WHOLE_CHANGE_CHECK,
  COMMAND,
  candidateCommands,
  commandsFor,
  commandSummary,
  implementInstruction,
  commitMessage,
  deliverableFollowUp,
  withoutBookkeeping,
  listAnd,
  pullRequestDescription,
  parseProfile,
  shippedProfile,
  MAX_SNAPSHOT_CHARS,
  MAX_CONTEXT_BYTES,
  BENCH_GUIDANCE,
  readContext,
  contextDocuments,
  writtenText,
  QUALIFICATION_CASES,
  VERIFICATION_SCHEMA,
  advanceFix,
  blockingComments,
  codeReviewInstruction,
  createGraph,
  describeFinding,
  findingById,
  findingLedger,
  ginkgoSpecs,
  MAX_DISCOVERY_ROUNDS,
  MAX_SWEEP_PASSES,
  reviewPhase,
  reviewRound,
  verifyOnly,
  observablePath,
  parseCodeReview,
  parseVerification,
  pathsToObserve,
  quoteMatches,
  qualifyValidators,
  roundSummary,
  reviewBackground,
  regressionArgv,
  regressionOutcome,
  requestedIssue,
  testOutcome,
  toVerify,
  validatorById,
  implementerRecord,
  latestImplementerRecord,
  verificationInstruction,
  writtenJson,
  type DecisionRecord,
  type GinkgoSpec,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
/** The banyandb profile, as a task's config carries it: every test in this file runs issue-fix under it. */
const BANYANDB = shippedProfile("banyandb");
const PROFILE = parseProfile(BANYANDB);
const ENVIRONMENT = PROFILE.environment;
const CHANGES_PATH = "CHANGES.md";
const TEST = "TestSchedulerWarnsWhileRunning";
const ISSUE = 14111;

const PLAN: DecisionRecord = {
  status: "ready",
  summary: "Warn at the timeout while the action is still running, then log its real outcome.",
  title: "Stop reporting long scheduled actions as timed out",
  test: { package: "./pkg/timestamp", name: TEST, expectedValueSource: "the issue: a running action should not be reported as an error" },
  productionCaller: "pkg/timestamp.Scheduler.trigger",
  decisions: [
    { point: "What to do at five minutes", tier: "behaviour", options: ["cancel the action", "configurable timeout", "warn and wait"], chosen: "warn and wait", basis: "the issue says it should not be reported as an error" },
    { point: "Whether TotalTasksTimeout keeps counting these actions", tier: "product", options: ["keep", "stop"], basis: "changes what the metric means for alerting" },
  ],
  openQuestions: ["Should TotalTasksTimeout keep counting actions that are still running?"],
};

const REAL_GO = spawnSync("sh", ["-c", "command -v go"]).stdout.toString().trim();

const events = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");
const FAILED = events({ Action: "run", Test: TEST }, { Action: "fail", Test: TEST });
const PASSED = events({ Action: "run", Test: TEST }, { Action: "pass", Test: TEST });

interface CommandResult {
  exitCode?: number;
  report?: string;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
  spawnError?: string;
}

/** The profile, with the review's reentry cap set; scenarios that do not opt in get 0, so the graph hands every failure over. */
function withReentries(profile: unknown, graphReenters: Scenario["graphReenters"]): unknown {
  const p = structuredClone(profile) as { review: Record<string, unknown> };
  p.review.maxReentries = graphReenters === undefined ? 0 : (graphReenters.maxReentries ?? 4);
  return p;
}

interface Scenario {
  /** The planner's result for each plan job, in order; the last repeats. */
  plans?: DecisionRecord[];
  /** The implementer's result for each implement job, in order. */
  implement?: Array<DecisionRecord | undefined>;
  /** Implement passes (1-based) that change nothing: the candidate digest stays as it was. */
  unchangedWork?: number[];
  /** Command outcomes in the candidate checkout for each candidate job, by command id. */
  candidate?: Array<Partial<Record<string, CommandResult>>>;
  candidateMutations?: string[][];
  red?: CommandResult;
  /** The base RED outcome for each RED run, in order; the last repeats. Overrides `red`. */
  reds?: CommandResult[];
  /** Resume (a new generation) right after this candidate-checks run (1-based), as an operator does once the environment is fixed. */
  resumeAfterCandidate?: number;
  /** Outcomes for each full-tier job in order (the last repeats), instead of the round's `candidate` entry. */
  fullChecks?: Array<Partial<Record<string, CommandResult>>>;
  /** The profile config the run uses, instead of the banyandb profile. */
  profile?: unknown;
  /** Outcomes for each final-tier job in order, by command id (the last repeats); a command not listed succeeds. */
  finals?: Array<Partial<Record<string, CommandResult>>>;
  /** Resume right after this final-tier job (1-based). */
  resumeAfterFinal?: number;
  /** Resume after this many full-tier check jobs. */
  resumeAfterFullChecks?: number;
  /** Resume right after this base RED run (1-based). */
  resumeAfterRed?: number;
  /** The regression outcome for a reverted-candidate RED retry, when the base checkout cannot build the test alone. */
  redReverted?: CommandResult;
  /** The reverted RED outcome for each such run, in order; the last repeats. Overrides `redReverted`. */
  revertedReds?: CommandResult[];
  /** Resume right after this reverted RED run (1-based). */
  resumeAfterReverted?: number;
  /** Whether a revert patch applies to the candidate; false reports the controller's failed-apply evidence. */
  revertApplies?: (patch: string) => boolean;
  /** The code reviewer's result for each review, in order; the last repeats. */
  codeReviews?: Array<{ output: unknown; status?: string }>;
  /** The verifier's result for each verification, in order; the last repeats. By default it confirms every finding it is given. */
  verifications?: Array<{ output: unknown; status?: string }>;
  /** Bytes an observation records for each path; CHANGES.md defaults to `changes`, anything else to empty. */
  files?: Record<string, string | null>;
  /** What the environment check printed for ocr; null records no passing check. */
  ocrPath?: string | null;
  changes?: string;
  /** Bump the generation once Fix is accepted, as an operator's resume does. */
  resumeAfterFix?: boolean;
  /**
   * Once Fix is accepted, a supervisor-dispatched work job settles with no
   * decision-record contract: completed, output null, no resultSchema (the
   * shape of op-571 in run 4e89a0e1-a16, issue #191).
   */
  supervisorWorkAfterFix?: boolean;
  issueBody?: string;
  /** What a fake GitHub serves for a context document, by "owner/name:path"; a file not listed (or null) is not found. */
  contextFiles?: Record<string, string | null>;
  comments?: Array<{ author: string; createdAt: string; body: string }>;
  /** Whether the comment listing reached its last page. */
  commentsComplete?: boolean;
  /** Supervise decisions the supervisor answers by re-entering Fix. */
  reenter?: number;
  /**
   * Let the graph reenter Fix itself on a converging review failure (the real
   * routing). Off by default so scenarios written for supervisor reentry keep
   * handing the failure over; `maxReentries` sets the profile's cap.
   */
  graphReenters?: { maxReentries?: number };
  /** The corrections budget the run starts with; default 8. */
  corrections?: number;
  /** What each implement pass (by index) does to the worktree's .graphloom/issues.json. */
  fixerEdits?: Array<((file: string | undefined) => string | undefined) | undefined>;
  /** The first this many issues-read commands fail (exit 1), as a crashed or timed-out read does. */
  failReads?: number;
  /** Every context file write fails (exit 1). */
  failContextWrites?: boolean;
  /** The first this many deliver commands fail (exit 1), as an unusable deliver command does. */
  failDeliveries?: number;
  /** After the run stops on a failed delivery, resume once (a new generation), as an operator does after fixing it. */
  resumeAfterFailedDelivery?: boolean;
}

const OCR = "/opt/open code review/bin/ocr";
const reviewed = (comments: Array<Record<string, unknown>> = [], summary: object = { total_files: 3, reviewed_files: 3, skipped: [] }): { output: unknown; status?: string } => ({
  output: { comments, summary },
});
const HANG = { path: "pkg/timestamp/scheduler.go", start_line: 88, end_line: 95, category: "bug", severity: "high", content: "Close now waits forever for an action that ignores cancellation." };
const SUMMARY = { total_files: 3, reviewed_files: 3, skipped: [] };
/** A pass that gives each named finding `status` and raises `comments`. */
const priorPass = (statuses: Record<string, string>, comments: Array<Record<string, unknown>> = []): { output: unknown } => ({
  output: { comments, prior: Object.entries(statuses).map(([finding, status]) => ({ finding, status, reason: `${finding} is ${status}` })), summary: SUMMARY },
});
/** A pass that gives `finding` `status` with the reviewer's own `reason`. */
const notedPass = (finding: string, status: string, reason: string): { output: unknown } => ({ output: { comments: [], prior: [{ finding, status, reason }], summary: SUMMARY } });
const FIRST_NOTE = "Close still waits on s.wait(ctx) with no deadline (pkg/timestamp/scheduler.go:88-95).";
const LATEST_NOTE = "Partially fixed: Close now bounds its wait, but trigger still blocks on the action (pkg/timestamp/scheduler.go:101-104).";
const verdicts = (...list: Array<{ finding: string; verdict: string; reason?: string; quotes?: Array<{ path: string; line: number; text: string }> }>) => ({
  output: { verdicts: list.map((v) => ({ reason: `${v.verdict} by the verifier`, quotes: [], ...v })) },
});
const SCHEDULER = ["package timestamp", "", "func (s *Scheduler) Close() {", "\ts.cancel()", "\tctx, done := context.WithTimeout(context.Background(), s.closeTimeout)", "\tdefer done()", "\ts.wait(ctx)", "}"].join("\n");
const BOUNDED = { path: "pkg/timestamp/scheduler.go", line: 5, text: "ctx, done := context.WithTimeout(context.Background(), s.closeTimeout)" };

const CHANGES = "# Changes by Version\n\nRelease Notes.\n\n## 0.12.0\n\n### Bug Fixes\n\n- Warn while a scheduled action is still running.\n\n## 0.11.0\n\n- Older.\n";
const CHANGED = ["CHANGES.md", "pkg/timestamp/scheduler.go", "pkg/timestamp/scheduler_test.go"];

/**
 * Plays the controller for the graph: runs each decision against canned job
 * results, stamps evidence with the producer and the change's digest, and
 * mints receipts with the plugin's own validators.
 */
function simulate(scenario: Scenario, request = `Fix apache/skywalking#${ISSUE}.`) {
  const evidence: EvidenceRecord[] = [];
  const receipts: Receipt[] = [];
  const sessions: AgentSessionView[] = [];
  const jobs: JobSpec[] = [];
  const decisions: GraphDecision[] = [];
  const observed: string[] = [];
  let privateState: string | undefined;
  let digest = "d0";
  let planDigest = "p0";
  // decisions-recorded anchors to the plan's own content (identityArtifactSchema
  // in the real graph), not the workspace candidate — an implementer edit must
  // not invalidate an already-accepted plan.
  const identityFor = (requirementId: string): string => (requirementId === "decisions-recorded" ? planDigest : digest);
  let implemented = 0;
  let changed = 0;
  let candidates = 0;
  let fullJobs = 0;
  let finalJobs = 0;
  let redRuns = 0;
  let revertedRuns = 0;
  let planned = 0;
  let codeReviewed = 0;
  let verified = 0;
  let reentries = scenario.reenter ?? 0;
  let reenterDecisions = 0;
  let issuesFile: string | undefined;
  let issuesMarkdown: string | undefined;
  let failedReads = 0;
  let failedDeliveries = 0;
  let resumedDelivery = false;
  let seq = 0;
  let generation = 1;
  // What the controller tells the graph about the operator's latest resume.
  let resume: RunView["resume"];
  const resumeAt = (previousStopReason?: string) => {
    generation += 1;
    resume = { generation, at: "2026-10-19T00:00:00.000Z", pluginUpdated: false, ...(previousStopReason !== undefined ? { previousStopReason, previousStopRetryable: true } : {}) };
  };
  // Only a real reentry of Fix bumps attempt, exactly like the controller
  // (loop.ts's "reenter" case): resumeAfterFix bumps generation alone, the
  // same fence a bare resume applies, to prove the graph tells the two apart.
  let attempt = 1;
  const openAttempt: Record<string, boolean> = {};
  const nth = <T>(list: T[] | undefined, i: number): T | undefined => (list === undefined || list.length === 0 ? undefined : list[Math.min(i, list.length - 1)]);
  const budgets = { agentInvocations: 32, jobs: 64, decisions: 128, corrections: scenario.corrections ?? 8 };
  const config = withReentries(scenario.profile ?? BANYANDB, scenario.graphReenters);

  const record = (kind: EvidenceRecord["kind"], payload: Record<string, unknown>, job: JobSpec | undefined, op: string): EvidenceRecord => {
    const e: EvidenceRecord = {
      ref: `ev-${++seq}`,
      kind,
      generation,
      candidateDigest: digest,
      ...(job?.resultSchema !== undefined ? { resultSchema: job.resultSchema } : {}),
      payload: job === undefined ? payload : { ...payload, producer: { operationId: op, stageId: job.stageId, purpose: job.purpose, readOnly: job.readOnly === true, kind: job.kind, ...(job.executor ? { executorId: job.executor.id } : {}) } },
    };
    evidence.push(e);
    return e;
  };
  if (scenario.ocrPath !== null) {
    const stdoutTail = `${scenario.ocrPath ?? OCR}\n`;
    record("command", { command: { id: "ocr", argv: ["sh"], exitCode: 0, stdoutTail, stderrTail: "" }, environment: { phase: "preflight" } }, undefined, "env-0");
  }
  // The argv the job asked for: a regression run names its test only there.
  const commandPayload = (id: string, r: CommandResult, argv: string[] = [id]) => ({
    command: { id, argv, exitCode: r.exitCode ?? 0, ...(r.timedOut === true ? { timedOut: true } : {}), ...(r.aborted === true ? { aborted: true } : {}), ...(r.spawnError !== undefined ? { spawnError: r.spawnError } : {}), stdoutTail: r.stdout ?? "", stderrTail: r.stderr ?? "", ...(r.report !== undefined ? { report: { text: r.report, truncated: false } } : {}) },
  });

  function run(job: JobSpec, op: string): void {
    jobs.push(job);
    const input = job.input as { commands?: Array<{ id: string; argv: string[] }>; number?: number } | undefined;
    if (job.executor?.id === "graphloom.github/get-issue") {
      record("other", { github: { item: { number: input!.number, title: "Scheduler reports long actions as timed out", state: "open", url: "u", labels: [], body: scenario.issueBody ?? "Backups longer than five minutes are reported as action timed out." } } }, job, op);
      return;
    }
    if (job.executor?.id === "graphloom.github/get-file") {
      // A fake GitHub serving `contextFiles` by "owner/name:path"; a file it does not serve is not found.
      const asked = job.input as { owner: string; repo: string; path: string; ref?: string };
      const served = scenario.contextFiles?.[`${asked.owner}/${asked.repo}:${asked.path}`];
      const query = { owner: asked.owner, repo: asked.repo, path: asked.path, ref: asked.ref ?? null };
      const item =
        served === undefined || served === null
          ? { found: false, path: asked.path, ref: asked.ref ?? null, reason: "not-found" }
          : { found: true, path: asked.path, ref: asked.ref ?? null, sha: `blob-${asked.path}`.padEnd(40, "0"), size: Buffer.byteLength(served), text: served };
      record("other", { github: { operation: "get-file", query, item } }, job, op);
      return;
    }
    if (job.executor?.id === "graphloom.github/list-issue-comments") {
      const items = scenario.comments ?? [{ author: "maintainer", createdAt: "2026-09-01", body: "It should not be an error." }];
      record("other", { github: { items, page: { complete: scenario.commentsComplete ?? true } } }, job, op);
      return;
    }
    if (job.kind === "agent") {
      let output: unknown;
      if (job.purpose === "diagnostic" && job.stageId === "review") {
        const ids = [...assignment(job).matchAll(/^- (F\d+) /gm)].map((m) => m[1]!);
        const confirmAll = verdicts(...ids.map((finding) => ({ finding, verdict: "confirmed", quotes: [{ path: "pkg/timestamp/scheduler.go", line: 7, text: "s.wait(ctx)" }] })));
        const result: { output: unknown; status?: string } = nth(scenario.verifications, verified++) ?? confirmAll;
        record("other", { codingAgent: { harness: "claude-code", status: result.status ?? "completed", output: result.output } }, job, op);
        return;
      }
      if (job.purpose === "diagnostic") {
        output = nth(scenario.plans, planned++) ?? PLAN;
        // The plan's own identity, independent of the workspace candidate:
        // an implementer edit must not invalidate an already-accepted plan.
        planDigest = `p${planned}`;
      } else if (job.purpose === "work") {
        output = scenario.implement?.[implemented] ?? nth(scenario.plans, planned - 1) ?? PLAN;
        const edit = scenario.fixerEdits?.[implemented];
        if (edit !== undefined) issuesFile = edit(issuesFile);
        implemented += 1;
        // An implementer pass that edits nothing leaves the candidate byte-identical.
        if (!(scenario.unchangedWork ?? []).includes(implemented)) digest = `d${++changed}`;
        // A work dispatch settling is this attempt's chance at the stage's
        // own work; reentry's openAttempt has done its job once that happens.
        openAttempt[job.stageId] = false;
      } else if (job.purpose === "review" && job.stageId === "review") {
        const result = nth(scenario.codeReviews, codeReviewed++) ?? reviewed();
        record("other", { codingAgent: { harness: "codex", status: result.status ?? "completed", output: result.output } }, job, op);
        return;
      }
      record("other", { codingAgent: { harness: "claude-code", status: "completed", output } }, job, op);
      sessions.push({
        operationId: op,
        stageId: job.stageId,
        attempt: 1,
        generation,
        dispatchKey: job.jobId!,
        executorId: job.executor!.id,
        status: "ok",
        ...(job.continueFrom !== undefined ? { continuedFrom: job.continueFrom } : {}),
      });
      return;
    }
    if (job.checkout?.from === "candidate" && job.checkout.revertPatch !== undefined && scenario.revertApplies?.(job.checkout.revertPatch) === false) {
      record(
        "other",
        { checkout: { from: "candidate", base: "base-sha", commit: `rc-${op}`, paths: CHANGED, prepared: false, mutations: [], phase: "run", revertError: "error: patch failed: pkg/timestamp/scheduler.go:1", revertPatch: job.checkout.revertPatch } },
        job,
        op,
      );
      return;
    }
    if (job.checkout?.from === "candidate" && job.checkout.revertPatch !== undefined) {
      const outcome = nth(scenario.revertedReds, revertedRuns) ?? scenario.redReverted ?? { exitCode: 1, report: FAILED };
      revertedRuns += 1;
      record(
        "command",
        {
          ...commandPayload(COMMAND.regression, outcome, input!.commands![0]!.argv),
          checkout: { from: "candidate", base: "base-sha", commit: `rc-${op}`, paths: CHANGED, prepared: true, mutations: [], phase: "run", reverted: true, revertedPaths: ["pkg/timestamp/scheduler.go"] },
        },
        job,
        op,
      );
      if (scenario.resumeAfterReverted === revertedRuns) resumeAt();
      return;
    }
    if (job.checkout?.from === "candidate" && job.stageId === "review") {
      // The final tier: one job in Review, a checkout of the reviewed candidate.
      const results = nth(scenario.finals, finalJobs) ?? {};
      finalJobs += 1;
      for (const c of input!.commands!) {
        record("command", { ...commandPayload(c.id, { ...results[c.id] }, c.argv), checkout: { from: "candidate", base: "base-sha", commit: `f-${op}`, paths: CHANGED, prepared: true, mutations: [], phase: "run" } }, job, op);
      }
      if (scenario.resumeAfterFinal === finalJobs) resumeAt();
      return;
    }
    if (job.checkout?.from === "candidate") {
      // A round of candidate checks is one job, or two when the profile is tiered: the full job belongs to the round the cheap job opened.
      const greenJob = input!.commands!.some((c) => c.id === COMMAND.regression);
      const round = greenJob ? candidates++ : candidates - 1;
      const results = (!greenJob && scenario.fullChecks !== undefined ? nth(scenario.fullChecks, fullJobs) : undefined) ?? scenario.candidate?.[round] ?? {};
      const mutations = scenario.candidateMutations?.[round] ?? [];
      for (const c of input!.commands!) {
        const defaults: CommandResult =
          c.id === COMMAND.regression ? { report: PASSED } : c.id === COMMAND.changesDiff ? { stdout: "+- Warn while a scheduled action is still running.\n" } : {};
        record("command", { ...commandPayload(c.id, { ...defaults, ...results[c.id] }, c.argv), checkout: { from: "candidate", base: "base-sha", commit: `c-${op}`, paths: CHANGED, prepared: true, mutations, phase: "run" } }, job, op);
      }
      if (greenJob && scenario.resumeAfterCandidate === candidates) resumeAt();
      if (!greenJob && scenario.resumeAfterFullChecks === ++fullJobs) resumeAt();
      return;
    }
    if (job.checkout?.from === "base") {
      const red = nth(scenario.reds, redRuns) ?? scenario.red ?? { exitCode: 1, report: FAILED };
      redRuns += 1;
      record("command", { ...commandPayload(COMMAND.regression, red, input!.commands![0]!.argv), checkout: { from: "base", base: "base-sha", commit: `b-${op}`, paths: job.checkout.paths, prepared: true, mutations: [], phase: "run" } }, job, op);
      if (scenario.resumeAfterRed === redRuns) resumeAt();
      return;
    }
    for (const c of input!.commands!) {
      // The worktree's issues file: the write command's JSON, read back as its report.
      if (c.id === "issues-write") {
        issuesFile = writtenJson(c.argv);
        issuesMarkdown = c.argv.slice(5 + Number(c.argv[4])).join("");
        record("command", commandPayload(c.id, { stdout: "written\n" }, c.argv), job, op);
      } else if (c.id === "issues-read" && failedReads < (scenario.failReads ?? 0)) {
        failedReads += 1;
        record("command", commandPayload(c.id, { exitCode: 1, stderr: "sh: cat: I/O error\n" }, c.argv), job, op);
      } else if (c.id === COMMAND.deliver && failedDeliveries < (scenario.failDeliveries ?? 0)) {
        failedDeliveries += 1;
        record("command", commandPayload(c.id, { exitCode: 1, stderr: "The following paths are ignored by one of your .gitignore files:\n.graphloom\n" }, c.argv), job, op);
      } else if (c.id.startsWith("context-write-")) {
        record("command", commandPayload(c.id, scenario.failContextWrites === true ? { exitCode: 1, stderr: "chmod: denied\n" } : { stdout: "written\n" }, c.argv), job, op);
      } else if (c.id === "issues-read") {
        record("command", commandPayload(c.id, issuesFile === undefined ? { stdout: "missing\n" } : { stdout: "present\n", report: issuesFile }, c.argv), job, op);
      } else {
        record("command", commandPayload(c.id, { stdout: "abc123\n" }), job, op);
      }
    }
  }

  const definition = createGraph().describe(config);
  for (let step = 0; step < 100; step += 1) {
    const view: RunView = {
      runId: "run",
      task: { request, repo: "../skywalking-banyandb" },
      current: { stageId: "fix", attempt },
      // A receipt is valid only while the candidate it names is still the
      // accepted one — the same identity-match invalidation the controller
      // applies, simplified to one whole-candidate digest since Fix is the
      // only stage that ever edits it (unlike release's incremental Bump
      // then Changelog, nothing here grows the diff stage by stage).
      receipts: structuredClone(receipts).map((r) => (r.candidateDigest === identityFor(r.requirementId) ? r : { ...r, valid: false })),
      evidence: structuredClone(evidence),
      outstanding: [],
      budgets,
      validatorBindings: definition.defaultValidators,
      // What the runner hands a graph: the input shape the coding agent declares (its assignment is at most 64,000 characters).
      executors: [{ id: "graphloom.coding-agent/run", inputShape: { schema: { type: "object", required: ["assignment"], properties: { assignment: { type: "string", minLength: 1, maxLength: 64_000 } } }, example: { assignment: "x" } } }],
      generation,
      stateRevision: step,
      activeVersion: "issue-fix@0.1.0",
      config,
      candidateDigest: digest,
      ...(resume !== undefined ? { resume } : {}),
      ...(sessions.length > 0 ? { agentSessions: structuredClone(sessions) } : {}),
      ...(privateState !== undefined ? { privateState } : {}),
      ...(Object.values(openAttempt).some(Boolean) ? { openAttempt: { ...openAttempt } } : {}),
    };
    const decision = advanceFix(view);
    decisions.push(decision);
    if (decision.privateState !== undefined) privateState = decision.privateState;
    const action = decision.action;
    const op = `op-${step}`;
    if (action.type === "dispatch") {
      run(action.job, op);
    } else if (action.type === "observe") {
      for (const p of action.observe.paths ?? []) {
        observed.push(p);
        const file = record("file", { path: p, bytes: p === CHANGES_PATH ? (scenario.changes ?? CHANGES) : (scenario.files?.[p] ?? "") }, undefined, op);
        // A null file is one the worktree does not have: the controller records it as missing.
        if (scenario.files?.[p] === null) file.fingerprint = "missing";
      }
    } else if (action.type === "validate") {
      const stage = definition.stages.find((s) => s.id === action.validate.stageId)!;
      const visible = candidateEvidence(evidence, digest);
      const history = evidence.filter((e) => e.candidateDigest !== undefined && e.candidateDigest !== digest);
      const results = stage.requirementIds.map((requirementId) => {
        const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
        return { requirementId, binding, result: validatorById(binding.validatorId)!.evaluate({ requirementId, statement: "s", evidence: visible, history, candidateDigest: digest, config }) };
      });
      const failure = results.find((r) => r.result.status !== "passed");
      if (failure !== undefined) throw new Error(`validate ${stage.id} failed: ${failure.requirementId}: ${failure.result.reason}`);
      for (const r of results) receipts.push({ id: `rcpt-${receipts.length + 1}`, stageId: stage.id, requirementId: r.requirementId, validatorBinding: r.binding, candidateFingerprint: "fp", evidenceRefs: [], valid: true, candidateDigest: identityFor(r.requirementId) });
      if (scenario.resumeAfterFix === true && stage.id === "fix") resumeAt();
      if (scenario.supervisorWorkAfterFix === true && stage.id === "fix") {
        const free: JobSpec = { stageId: "fix", kind: "agent", purpose: "work", instruction: "supervisor work", readOnly: false };
        record("other", { codingAgent: { harness: "claude-code", status: "completed", output: null } }, free, `op-sup-${step}`);
      }
    } else if (action.type === "reenter") {
      // The controller's "reenter": a correction spent, the attempt bumped, Fix's work dispatched again.
      budgets.corrections -= 1;
      reenterDecisions += 1;
      openAttempt.fix = true;
      generation += 1;
      attempt += 1;
    } else if (action.type === "supervise" && reentries > 0) {
      // The supervisor re-enters Fix: its execution needs another attempt,
      // regardless of whether the candidate has changed yet (it has not, so
      // receipts stay valid — openAttempt alone is what sends Fix's work
      // dispatch again instead of skipping past it to Review).
      reentries -= 1;
      openAttempt.fix = true;
      generation += 1;
      attempt += 1;
    } else if (
      action.type === "stop" && action.stop.reason === "delivery failed" && scenario.resumeAfterFailedDelivery === true && !resumedDelivery
    ) {
      resumedDelivery = true;
      resumeAt("delivery failed");
    } else {
      return { decision, decisions, jobs, evidence, receipts, observed, issuesFile, issuesMarkdown, reenterDecisions };
    }
  }
  throw new Error("the graph did not finish in 100 steps");
}

/** What the controller shows validators: this accepted candidate, with only the latest review and the latest observation of each file. */
function candidateEvidence(evidence: EvidenceRecord[], digest: string): EvidenceRecord[] {
  const seen = new Set<string>();
  return evidence
    .filter((e) => e.candidateDigest === undefined || e.candidateDigest === digest)
    .reverse()
    .filter((e) => {
      const key = e.kind === "review" ? "review" : e.kind === "file" ? `file:${String((e.payload as { path?: unknown }).path)}` : undefined;
      if (key === undefined) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .reverse();
}

const deliverArgs = (jobs: JobSpec[]) => {
  const job = jobs.find((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver)!;
  const argv = (job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
  const n = Number(argv[5]);
  return { branch: argv[4], message: argv.slice(6, 6 + n).join(""), body: argv.slice(6 + n).join("") };
};
/** Candidate-checkout results for `ids`, all successful, bound to `digest`, as separate jobs of one candidate would leave them. */
function candidateEvidenceFor(ids: string[], digest = "d1"): EvidenceRecord[] {
  return ids.map((id, i) => ({
    ref: `t-${digest}-${id}-${i}`,
    kind: "command" as const,
    candidateDigest: digest,
    payload: {
      command: { id, argv: [id], exitCode: 0, stdoutTail: "", stderrTail: "", ...(id === COMMAND.regression ? { report: { text: PASSED, truncated: false } } : {}) },
      checkout: { from: "candidate", base: "base-sha", commit: `c-${id}`, paths: CHANGED, prepared: true, mutations: [], phase: "run" },
      producer: { operationId: `op-${id}`, stageId: "fix", purpose: "check", readOnly: true, kind: "command" },
    },
  }));
}

const assignment = (job: JobSpec | undefined) => (job!.input as { assignment: string }).assignment;

describe("issue-fix graph under the banyandb profile", () => {
  it("declares the contributor checklist the controller checks before any job", () => {
    const definition = createGraph().describe(BANYANDB);
    expect(definition.stages.map((s) => s.id)).toEqual(["fix", "review"]);
    expect(definition.environment).toEqual(ENVIRONMENT);
    expect(ENVIRONMENT.checks!.map((c) => c.id)).toEqual(["go", "git", "ocr", "codex", "claude", "make", "check-req", "node"]);
    // `make generate` split per project so each output is cached on its own inputs (#174).
    expect(ENVIRONMENT.prepare!.map((c) => c.id)).toEqual(["generate-proto", "generate-mcp", "generate-directives", "generate-mocks"]);
    expect(ENVIRONMENT.prepare!.slice(0, 2).map((c) => c.argv.join(" "))).toEqual(["make -C api generate", "make -C mcp generate"]);
    expect(ENVIRONMENT.pinnedFiles![0]!.path).toBe("CONTRIBUTING.md");
  });

  it("checks that open-code-review, Codex and Claude Code are installed and ready before any job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bydb-tools-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const check = (id: string) => ENVIRONMENT.checks!.find((c) => c.id === id)!.argv;
    const tool = (name: string, body: string) => writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const run = async (id: string, env: Record<string, string> = {}) => {
      const [cmd, ...args] = check(id);
      return execFileAsync(cmd!, args, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ...env } }).then(
        ({ stdout }) => ({ code: 0, stderr: "", stdout: stdout.trim() }),
        (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr.trim() }),
      );
    };
    try {
      expect(await run("ocr")).toEqual({ code: 127, stderr: "open-code-review (ocr) is not installed" });
      expect(await run("codex")).toEqual({ code: 127, stderr: "Codex (codex) is not installed" });
      expect(await run("claude")).toEqual({ code: 127, stderr: "Claude Code (claude) is not installed" });

      // An ocr without delegation mode fails; one with it prints its absolute path for the code reviewer.
      await tool("ocr", "exit 1");
      expect(await run("ocr")).toEqual({ code: 1, stderr: `${bin}/ocr has no delegation mode; install open-code-review 1.9 or later` });
      await tool("ocr", '[ "$1 $2 $3" = "delegate preview --help" ]');
      expect(await run("ocr")).toEqual({ code: 0, stderr: "", stdout: `${bin}/ocr` });

      await tool("codex", `case "$1" in --version) exit 0;; login) [ "$CODEX_HOME" = "${root}/codex" ];; esac`);
      expect(await run("codex")).toEqual({ code: 1, stderr: "Codex is not logged in: run codex login" });
      expect(await run("codex", { CODEX_HOME: `${root}/other` })).toEqual({ code: 1, stderr: `Codex is not logged in for ${root}/other: run codex login` });
      expect((await run("codex", { GRAPHLOOM_CODEX_HOME: `${root}/codex`, CODEX_HOME: `${root}/other` })).code).toBe(0);

      // Logged in only for the config dir the harness would use.
      await tool("claude", `case "$1" in --version) exit 0;; auth) [ "$CLAUDE_CONFIG_DIR" = "${root}/claude" ];; esac`);
      expect(await run("claude")).toEqual({ code: 1, stderr: "Claude Code is not logged in: run claude auth login" });
      expect(await run("claude", { CLAUDE_CONFIG_DIR: `${root}/other` })).toEqual({ code: 1, stderr: `Claude Code is not logged in for ${root}/other: run claude auth login` });
      expect((await run("claude", { GRAPHLOOM_CLAUDE_CONFIG_DIR: `${root}/claude`, CLAUDE_CONFIG_DIR: `${root}/other` })).code).toBe(0);

      await tool("claude-custom", "exit 0");
      expect((await run("claude", { GRAPHLOOM_CLAUDE_BIN: path.join(bin, "claude-custom") })).code).toBe(0);

      // Node.js is required unconditionally: make generate and make build need it for every task.
      await tool("node", "echo v20.0.0");
      expect(await run("node")).toEqual({ code: 1, stderr: "Node.js >= 24.6.0 required, found v20.0.0" });
      await tool("node", "echo v24.6.0");
      expect((await run("node")).code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans, fixes, checks, reviews the code and delivers #14111", () => {
    const { decision, jobs } = simulate({});
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });

    const [issue, comments, plan, implement, candidate, red, full, codeReview, deliver] = jobs;
    expect(issue!.executor!.id).toBe("graphloom.github/get-issue");
    expect(issue!.input).toMatchObject({ owner: "apache", repo: "skywalking", number: ISSUE });
    expect(comments!.executor!.id).toBe("graphloom.github/list-issue-comments");

    expect(plan).toMatchObject({ jobId: "implementer", kind: "agent", purpose: "diagnostic", readOnly: true, input: { harness: "claude-code" } });
    expect(plan!.continueFrom).toBeUndefined();
    expect(assignment(plan)).toContain("It should not be an error.");
    expect(assignment(plan)).toContain("names each caller and lifecycle path that depends on the old behaviour");

    expect(implement).toMatchObject({ jobId: "implementer", purpose: "work", continueFrom: "op-2", input: { harness: "claude-code" } });
    expect(implement!.writeScope).toEqual([".", "!api/proto", "!go.mod", "!go.sum", "!.github"]);

    expect(candidate).toMatchObject({ kind: "command", readOnly: true, checkout: { from: "candidate" } });
    const ids = (candidate!.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    // The cheap tier first (GREEN and the cheap commands), then RED, then the full tier.
    expect(ids).toEqual(["changes-diff", "regression", "test-ci", "lint"]);
    expect(full).toMatchObject({ kind: "command", readOnly: true, checkout: { from: "candidate" } });
    expect((full!.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id)).toEqual(["build", "check"]);
    expect(red).toMatchObject({ checkout: { from: "base", paths: ["pkg/timestamp/scheduler_test.go"] } });
    const redArgv = (red!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(redArgv).toEqual(regressionArgv({ package: "./pkg/timestamp", name: TEST }));

    expect(codeReview).toMatchObject({
      stageId: "review",
      kind: "agent",
      purpose: "review",
      readOnly: true,
      resultSchema: "code-review-v2",
      input: { harness: "codex" },
    });
    expect(codeReview!.checkout).toBeUndefined();
    expect(codeReview!.jobId).toBeUndefined();
    expect(codeReview!.continueFrom).toBeUndefined();
    expect(assignment(codeReview)).toContain(`'${OCR}' delegate preview --format json`);
    expect(assignment(codeReview)).toContain("against HEAD (the base commit base-sha)");
    expect(assignment(codeReview)).toContain(PLAN.summary);

    const { branch, message, body } = deliverArgs(jobs);
    expect(branch).toBe(`fix/${ISSUE}`);
    expect(deliver!.purpose).toBe("diagnostic");
    expect(message).toBe(`${PLAN.title}\n\n${PLAN.summary}\n\nFixes apache/skywalking#${ISSUE}`);
    expect(body).toContain(`### Fix apache/skywalking#${ISSUE}: Scheduler reports long actions as timed out`);
    expect(body).toContain("- Should TotalTasksTimeout keep counting actions that are still running?");
    expect(body).toContain("- What to do at five minutes: warn and wait.");
    expect(body).toContain("Reviewed by Codex in open-code-review's delegation mode (reviewed 3 of 3 file(s)): no comments.");
    expect(body).toContain(`Fixes apache/skywalking#${ISSUE}.`);
    expect(`${message}\n${body}`).not.toMatch(/rcpt|receipt|ev-\d/);
    expect(decision.reason).toMatch(/pull request body is the report of evidence ev-\d+/);
  });

  it("stops at the plan with the draft question when a maintainer must decide", () => {
    const { decision, jobs } = simulate({
      plans: [{ status: "blocked", summary: "The API shape is a product decision.", decisions: [], openQuestions: ["Which API?"], draftComment: "Should the new API be X or Y?" }],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "needs maintainer decision", blocker: "Should the new API be X or Y?" } });
    expect(jobs.some((j) => j.purpose === "work" || j.purpose === "review")).toBe(false);
  });

  it("verifies a high comment, sweeps once more for new ones, and hands the confirmed finding to the supervisor", () => {
    const { decision, jobs } = simulate({ codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" })] });
    expect(decision.action).toMatchObject({ type: "supervise" });
    const reason = (decision.action as { supervise: { reason: string } }).supervise.reason;
    expect(reason).toContain("1 critical or high finding(s) confirmed or disputed: I1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(reason).toContain("passes on this change: 2 (sweep saturated); 0 fixed, 0 dismissed, 1 new confirmed, 0 regression(s), 0 disputed");
    expect(reason).toMatch(/\d+ agent invocation\(s\) left/);
    expect(jobs.some((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver)).toBe(false);

    const review = jobs.filter((j) => j.stageId === "review" && j.kind === "agent");
    expect(review.map((j) => `${j.purpose}:${(j.input as { harness: string }).harness}`)).toEqual(["review:codex", "diagnostic:claude-code", "review:codex"]);
    const verification = review[1]!;
    expect(verification).toMatchObject({ kind: "agent", readOnly: true, resultSchema: "finding-verification-v1" });
    expect(verification.jobId).toBeUndefined();
    expect(verification.continueFrom).toBeUndefined();
    expect(assignment(verification)).toContain("- F1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(assignment(verification)).toContain("- pkg/timestamp/scheduler_test.go");
    // The sweep pass knows F1 by name, owes it a status, and looks for issues beyond it.
    expect(assignment(review[2])).toContain("- I1 (open) pkg/timestamp/scheduler.go:88-95");
    expect(assignment(review[2])).toContain("An earlier pass on this same change reported the findings above");
    expect(assignment(review[0])).not.toContain("An earlier pass");
  });

  it("dismisses a finding the verifier refutes with lines that match the change, and lists it in the pull request", () => {
    const { decision, jobs, observed } = simulate({
      codeReviews: [reviewed([HANG])],
      verifications: [verdicts({ finding: "F1", verdict: "refuted", reason: "Close bounds the wait with closeTimeout.", quotes: [BOUNDED] })],
      files: { "pkg/timestamp/scheduler.go": SCHEDULER },
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(observed).toContain("pkg/timestamp/scheduler.go");
    // One pass: it raised nothing that survived verification. The implementer never saw the false positive.
    expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "review")).toHaveLength(1);
    expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
    const { body } = deliverArgs(jobs);
    expect(body).toContain("no critical or high finding left open (1 refuted by an independent verifier, listed below)");
    expect(body).toContain("- Critical or high review findings an independent verifier refuted; overrule any that is wrong:");
    expect(body).toContain("  - I1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever for an action that ignores cancellation. Verifier: Close bounds the wait with closeTimeout.");
  });

  it("disputes a refutation whose quotes do not match or leave the worktree, and never observes such a path", () => {
    const { decision, jobs, observed } = simulate({
      codeReviews: [reviewed([HANG, { ...HANG, start_line: 120, end_line: 121, content: "trigger leaks the timer." }]), priorPass({ F1: "still_present", F2: "still_present" })],
      verifications: [
        verdicts(
          { finding: "F1", verdict: "refuted", quotes: [{ ...BOUNDED, text: "ctx, done := context.WithTimeout(ctx, time.Minute)" }] },
          { finding: "F2", verdict: "refuted", quotes: [{ path: "/etc/passwd", line: 1, text: "root:x:0:0:root:/root" }] },
        ),
        verdicts({ finding: "F1", verdict: "uncertain", reason: "the timeout may not cover wait" }),
      ],
      files: { "pkg/timestamp/scheduler.go": SCHEDULER },
    });
    expect(decision.action).toMatchObject({ type: "supervise" });
    const reason = (decision.action as { supervise: { reason: string } }).supervise.reason;
    expect(reason).toContain("2 critical or high finding(s) confirmed or disputed");
    expect(reason).toContain("I1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever for an action that ignores cancellation. Verifier: the timeout may not cover wait");
    expect(reason).toContain("I2 pkg/timestamp/scheduler.go:120-121 (high, bug): trigger leaks the timer. Verifier: the verifier gave no verdict");
    expect(reason).toContain("0 fixed, 0 dismissed, 0 new confirmed, 0 regression(s), 2 disputed");
    expect(observed).toEqual(["CHANGES.md", "pkg/timestamp/scheduler.go"]);
    // Disputed findings sent the sweep on; the second pass raised nothing new, and both findings, still present, were verified again.
    const verifications = jobs.filter((j) => j.stageId === "review" && j.purpose === "diagnostic" && j.kind === "agent");
    expect(verifications).toHaveLength(2);
    expect(assignment(verifications[1])).toContain("- F1 ");
    expect(assignment(verifications[1])).toContain("- F2 ");
    expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "review")).toHaveLength(2);
  });

  it("stops sweeping at four passes on one change when every pass finds a new defect", () => {
    const defect = (line: number) => ({ ...HANG, start_line: line, end_line: line, content: `defect at ${line}` });
    const still = (k: number) => Object.fromEntries(Array.from({ length: k }, (_, i) => [`F${i + 1}`, "still_present"]));
    const { decision, jobs } = simulate({
      codeReviews: [reviewed([defect(1)]), priorPass(still(1), [defect(2)]), priorPass(still(2), [defect(3)]), priorPass(still(3), [defect(4)]), priorPass(still(4))],
    });
    expect(decision.action).toMatchObject({ type: "supervise" });
    const reason = (decision.action as { supervise: { reason: string } }).supervise.reason;
    expect(reason).toContain("passes on this change: 4 (sweep stopped at the 4-pass limit); 0 fixed, 0 dismissed, 4 new confirmed");
    expect(reason).toContain("not converging");
    expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "review")).toHaveLength(4);
  });

  it("retries a pass that failed or did not cover every file, up to the sweep cap, before supervising", () => {
    // Regression: a live run found open-code-review's delegation excluding a
    // test file by its own default path filter (a transient, environment-level
    // problem, not a finding to adjudicate). The old code treated any unusable
    // pass as a final verdict and supervised on the very first one; an unusable
    // pass deserves the same retry budget a sweep continuation gets instead.
    for (const run of [
      { output: null, status: "failed" },
      reviewed([], { total_files: 3, reviewed_files: 2, skipped: [] }),
      reviewed([], { total_files: 3, reviewed_files: 3, skipped: [{ path: "pkg/timestamp/scheduler_test.go", reason: "too long" }] }),
    ]) {
      // nth() repeats the last scripted result, so every retry reproduces the
      // same unusable pass until the sweep cap gives up and hands it off.
      const { decision, jobs } = simulate({ codeReviews: [run] });
      expect(decision.action).toMatchObject({ type: "supervise" });
      expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "review")).toHaveLength(MAX_SWEEP_PASSES);
    }
  });

  describe("graph reentry of Fix on a review failure", () => {
    const TIMER = { ...HANG, start_line: 120, end_line: 121, content: "trigger leaks the timer." };
    const reentered = (decisions: Array<{ action: { type: string } }>) => decisions.filter((d) => d.action.type === "reenter");

    it("reenters Fix itself in the first failing round, names the findings, and gives the implementer the confirmed findings", () => {
      const { decision, decisions, jobs, reenterDecisions } = simulate({
        graphReenters: {},
        codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" }), priorPass({ F1: "resolved" })],
      });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(decisions.some((d) => d.action.type === "supervise")).toBe(false);
      expect(reenterDecisions).toBe(1);
      const [reentry] = reentered(decisions) as unknown as Array<{ action: { reenter: { stageId: string; reason: string; evidenceRefs?: string[] } } }>;
      expect(reentry!.action.reenter.stageId).toBe("fix");
      expect(reentry!.action.reenter.reason).toContain("confirmed 1 critical or high finding(s): I1 pkg/timestamp/scheduler.go:88-95 Close now waits forever");
      expect(reentry!.action.reenter.reason).toContain("review reentry 1 of 4");
      expect(reentry!.action.reenter.evidenceRefs).toHaveLength(1);
      // The same assignment the supervisor's reentry produces.
      const work = jobs.filter((j) => j.purpose === "work");
      expect(work).toHaveLength(2);
      const correction = assignment(work[1]);
      expect(correction).toContain("Code review of your previous change found 1 critical or high defect(s), each confirmed by an independent verifier:");
      expect(correction).toContain("I1 [open] pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
      expect(correction).toContain("pkg/timestamp/scheduler.go:7 `s.wait(ctx)`");
    });

    it("reenters again in round 2 when fewer findings are open than in round 1", () => {
      const { decision, decisions, reenterDecisions } = simulate({
        graphReenters: {},
        codeReviews: [reviewed([HANG, TIMER]), priorPass({ F1: "still_present", F2: "still_present" }), priorPass({ F1: "resolved", F2: "still_present" }), priorPass({ F1: "resolved", F2: "resolved" })],
      });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(decisions.some((d) => d.action.type === "supervise")).toBe(false);
      expect(reenterDecisions).toBe(2);
      const reasons = reentered(decisions).map((d) => (d.action as unknown as { reenter: { reason: string } }).reenter.reason);
      expect(reasons[1]).toContain("round 2 confirmed 1 critical or high finding(s) (2 before the last correction)");
      expect(reasons[1]).toContain("review reentry 2 of 4");
    });

    it("hands round 2 to the supervisor when as many findings stay open as before", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: {},
        codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" }), priorPass({ F1: "still_present" })],
      });
      expect(reenterDecisions).toBe(1);
      expect(decision.action).toMatchObject({ type: "supervise" });
      expect((decision.action as { supervise: { reason: string } }).supervise.reason).toContain("code review did not pass");
    });

    it("hands round 2 to the supervisor when it has more open findings than before", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: {},
        codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" }), priorPass({ F1: "still_present" }, [TIMER]), priorPass({ F1: "still_present", F2: "still_present" })],
      });
      expect(reenterDecisions).toBe(1);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("hands any disputed finding to the supervisor, even in the first round", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: {},
        codeReviews: [reviewed([HANG, TIMER]), priorPass({ F1: "still_present", F2: "still_present" })],
        verifications: [
          verdicts(
            { finding: "F1", verdict: "refuted", quotes: [{ ...BOUNDED, text: "ctx, done := context.WithTimeout(ctx, time.Minute)" }] },
            { finding: "F2", verdict: "confirmed", quotes: [BOUNDED] },
          ),
          verdicts({ finding: "F1", verdict: "uncertain", reason: "the timeout may not cover wait" }, { finding: "F2", verdict: "confirmed", quotes: [BOUNDED] }),
        ],
        files: { "pkg/timestamp/scheduler.go": SCHEDULER },
      });
      expect(reenterDecisions).toBe(0);
      expect(decision.action).toMatchObject({ type: "supervise" });
      expect((decision.action as { supervise: { reason: string } }).supervise.reason).toContain("confirmed or disputed");
    });

    it("hands the failure to the supervisor once the review reentry cap is reached", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: { maxReentries: 1 },
        codeReviews: [reviewed([HANG, TIMER]), priorPass({ F1: "still_present", F2: "still_present" }), priorPass({ F1: "resolved", F2: "still_present" })],
      });
      // Round 2 has fewer findings, but the one allowed reentry is spent.
      expect(reenterDecisions).toBe(1);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("hands the next failure to the supervisor when the implementer returns the same candidate after a reentry", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: { maxReentries: 4 },
        unchangedWork: [2],
        codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" }), priorPass({ F1: "still_present" })],
      });
      // One reentry; the correction changed nothing, so the same finding stays open: not converging, however far below the cap.
      expect(reenterDecisions).toBe(1);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("allows one reentry under a cap of 1 and supervises the second failure even as the candidate changes", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: { maxReentries: 1 },
        codeReviews: [reviewed([HANG, { ...HANG, start_line: 120, end_line: 121, content: "trigger leaks the timer." }]), priorPass({ F1: "still_present", F2: "still_present" }), priorPass({ F1: "resolved", F2: "still_present" })],
      });
      expect(reenterDecisions).toBe(1);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("does not reenter at all when the profile's cap is 0", () => {
      const { decision, reenterDecisions } = simulate({ graphReenters: { maxReentries: 0 }, codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" })] });
      expect(reenterDecisions).toBe(0);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("hands the failure to the supervisor when the corrections budget is nearly spent", () => {
      const { decision, reenterDecisions } = simulate({ graphReenters: {}, corrections: 1, codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" })] });
      expect(reenterDecisions).toBe(0);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("keeps the supervisor for a review that failed for a reason other than confirmed findings", () => {
      // A confirmed finding exists, but the sweep pass never covered every file: not a known correction.
      const { decision, reenterDecisions } = simulate({
        graphReenters: {},
        codeReviews: [reviewed([HANG]), reviewed([], { total_files: 3, reviewed_files: 2, skipped: [] })],
      });
      expect(reenterDecisions).toBe(0);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });

    it("counts reentries from evidence, so a resume does not reset the cap", () => {
      const { decision, reenterDecisions } = simulate({
        graphReenters: { maxReentries: 2 },
        resumeAfterFix: true,
        codeReviews: [reviewed([HANG, TIMER]), priorPass({ F1: "still_present", F2: "still_present" }), priorPass({ F1: "resolved", F2: "still_present" }), priorPass({ F1: "resolved", F2: "still_present" })],
      });
      expect(reenterDecisions).toBe(2);
      expect(decision.action).toMatchObject({ type: "supervise" });
    });
  });

  it("does not pass a code review that completed but left a finding unresolved", () => {
    const { decision } = simulate({ codeReviews: [reviewed([{ ...HANG, severity: undefined }])] });
    expect(decision.action).toMatchObject({ type: "supervise" });
  });

  it("recovers on a fresh retry after one unusable pass, without burning the whole sweep cap", () => {
    const { decision, jobs } = simulate({
      codeReviews: [reviewed([], { total_files: 3, reviewed_files: 2, skipped: [] }), reviewed()],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "review")).toHaveLength(2);
  });

  it("asks the supervisor when the environment check recorded no ocr path for the reviewer", () => {
    const { decision, jobs } = simulate({ ocrPath: null });
    expect(decision.action).toMatchObject({ type: "supervise", supervise: { reason: expect.stringContaining("no open-code-review path") } });
    expect(jobs.some((j) => j.stageId === "review")).toBe(false);
  });

  it("delivers with lower-severity code-review comments left for the maintainers", () => {
    const { decision, jobs } = simulate({ codeReviews: [reviewed([{ ...HANG, severity: "low" }])] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(deliverArgs(jobs).body).toContain("no critical or high comments; 1 lower-severity comment(s) left for the reviewer.");
  });

  it("does not redraft an already-approved plan when the supervisor re-enters Fix, and fixes the confirmed findings with a new implementation pass", () => {
    const { decision, jobs } = simulate({
      reenter: 1,
      codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" }), priorPass({ F1: "resolved" })],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const plans = jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent" && j.stageId === "fix");
    const work = jobs.filter((j) => j.purpose === "work");
    // The plan is still right; nothing re-drafts it just because Fix was re-entered.
    expect(plans).toHaveLength(1);
    expect(work).toHaveLength(2);
    // The reentry asks the implementer's own session for a fresh pass, carrying
    // code review's confirmed findings, instead of a plan revision in between.
    expect(work[1]!.continueFrom).toBe(`op-${jobs.indexOf(work[0]!)}`);
    const correction = assignment(work[1]);
    expect(correction).toContain("Code review of your previous change found 1 critical or high defect(s), each confirmed by an independent verifier:");
    expect(correction).toContain("I1 [open] pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(correction).toContain("pkg/timestamp/scheduler.go:7 `s.wait(ctx)`");
    expect(deliverArgs(jobs).body).toContain("no critical or high finding left open (1 fixed during review)");
    const passes = jobs.filter((j) => j.purpose === "review" && j.stageId === "review");
    expect(passes).toHaveLength(3);
    // The first pass on the new change owes F1 a status and is not a sweep.
    expect(assignment(passes[2])).toContain("- I1 (open) pkg/timestamp/scheduler.go:88-95");
    expect(assignment(passes[2])).not.toContain("An earlier pass");
  });

  it("hands the implementer the reviewer's latest still-present note verbatim, ahead of the original report", () => {
    const { decision, jobs } = simulate({
      reenter: 2,
      codeReviews: [reviewed([HANG]), notedPass("F1", "still_present", FIRST_NOTE), notedPass("F1", "still_present", LATEST_NOTE), notedPass("F1", "resolved", "bounded now")],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(3);
    const latest = assignment(work[2]);
    // The note the reviewer wrote on the candidate the implementer now holds, verbatim with its location, comes first.
    expect(latest).toMatch(/- I1 \[open\] Reviewer, latest pass on the current candidate \(ev-\d+\): still present — Partially fixed: Close now bounds its wait, but trigger still blocks on the action \(pkg\/timestamp\/scheduler\.go:101-104\)\./);
    expect(latest).toContain("Background, the original report (it describes an earlier revision, candidate d1; its line numbers and quotes may no longer match the code): pkg/timestamp/scheduler.go:88-95 (high, bug)");
    expect(latest.indexOf("scheduler.go:101-104")).toBeLessThan(latest.indexOf("scheduler.go:88-95"));
    expect(latest).not.toContain(FIRST_NOTE);
    // The candidate changed since the last pass, so no "changed nothing" note.
    expect(latest).not.toContain("Your last pass changed nothing");
  });

  it("tells the implementer plainly that its last pass changed nothing while the reviewer still reports the finding", () => {
    const { decision, jobs } = simulate({
      reenter: 3,
      unchangedWork: [3],
      codeReviews: [reviewed([HANG]), notedPass("F1", "still_present", FIRST_NOTE), notedPass("F1", "still_present", LATEST_NOTE), notedPass("F1", "resolved", "bounded now")],
    });
    // Live run 4c70ff66-dd9 (gens 12 and 14): the implementer answered the
    // same stale feedback with "already fixed, made no change", the candidate
    // stayed byte-identical, and review kept the finding open.
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(4);
    // The third pass changed something earlier (d1 -> d2), so its feedback carries no such line.
    expect(assignment(work[2])).not.toContain("Your last pass changed nothing");
    const after = assignment(work[3]);
    expect(after).toContain(
      "- Your last pass changed nothing: the candidate is byte-identical (digest d2) to the code the reviewer re-checked. The reviewer re-checked the current code and still reports I1 as present",
    );
    expect(after.indexOf("Your last pass changed nothing")).toBeLessThan(after.indexOf(LATEST_NOTE));
    expect(after).toContain(`I1 [open] Reviewer, latest pass on the current candidate`);
    expect(after).toContain(LATEST_NOTE);
    // The feedback is not the previous pass's verbatim.
    const feedback = (a: string) => a.slice(a.indexOf("Your last change did not pass"), a.indexOf("Implement the fix"));
    expect(feedback(after)).not.toBe(feedback(assignment(work[2])));
  });

  it("hands the planner a long issue whole, with its latest maintainer answer", () => {
    const answer = "Maintainer answer: keep the action running and warn once.";
    const { decision, jobs } = simulate({
      issueBody: `Backups longer than five minutes are reported as action timed out.\n${"log line\n".repeat(4_000)}`,
      comments: [
        { author: "reporter", createdAt: "2026-09-01", body: "Maybe cancel it at five minutes?" },
        { author: "maintainer", createdAt: "2026-09-02", body: answer },
      ],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const job = jobs.find((j) => j.purpose === "diagnostic" && j.kind === "agent")!;
    const assignment = (job.input as { assignment: string }).assignment;
    expect(assignment.length).toBeGreaterThan(36_000);
    expect(assignment).toContain(answer);
    expect(assignment).not.toContain("truncated");
  });

  it("stops before any agent when the issue snapshot cannot be handed over whole", () => {
    const incomplete = simulate({ commentsComplete: false });
    expect(incomplete.decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringContaining("more comments than the run fetched") } });
    expect(incomplete.jobs.filter((j) => j.kind === "agent")).toEqual([]);

    const huge = simulate({ issueBody: "x".repeat(MAX_SNAPSHOT_CHARS + 1) });
    expect(huge.decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringContaining(`more than the ${MAX_SNAPSHOT_CHARS}`) } });
    expect(huge.jobs.filter((j) => j.kind === "agent")).toEqual([]);
  });

  // docs/design-run-convergence.md §6 item 7. The real run this design is
  // named for (a23b53b8-5df, fixing apache/skywalking#14075, shipped as
  // apache/skywalking-banyandb#1383) issued zero receipts across 45
  // generations: the working-tree diff was unchanged from about generation
  // 12 on, the plan reviewer approved 19 passes in a row from generation 22,
  // yet every reentry and resume re-earned all seven Fix requirements from
  // scratch because freshness was generation-scoped, not candidate-scoped.
  // (That run's own durable state no longer exists to replay verbatim — the
  // directory was later recycled for unrelated work — so this reconstructs
  // its documented shape: one clean plan/review/implement/RED/GREEN/build
  // pass, surviving a resume exactly as the real fix would have.)
  it("accepts Fix as soon as all seven requirements hold for one candidate, and survives a resume without re-earning them", () => {
    const { decision, jobs, receipts } = simulate({ resumeAfterFix: true });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    // One pass earns every Fix requirement: no repeated planning or
    // rechecking, unlike the live run's 45 generations and 0 receipts.
    expect(jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent")).toHaveLength(1);
    expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
    expect(jobs.filter((j) => j.checkout?.from === "candidate" && j.purpose === "check")).toHaveLength(2);
    const fixReceipts = receipts.filter((r) => r.stageId === "fix" && r.valid);
    expect(fixReceipts.map((r) => r.requirementId).sort()).toEqual(
      ["builds", "changelog-entry", "decisions-recorded", "in-scope", "passes", "reproduces"].sort(),
    );
  });

  it("stops on a failed delivery, and tries it again after a resume", () => {
    const delivers = (jobs: JobSpec[]) => jobs.filter((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver);
    const failed = simulate({ failDeliveries: 1 });
    expect(failed.decision.action).toMatchObject({ type: "stop", stop: { reason: "delivery failed" } });
    expect(delivers(failed.jobs)).toHaveLength(1);
    const resumed = simulate({ failDeliveries: 1, resumeAfterFailedDelivery: true });
    expect(resumed.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(delivers(resumed.jobs)).toHaveLength(2);
    // A delivery that fails again after the resume stops the run: no loop.
    const again = simulate({ failDeliveries: 2, resumeAfterFailedDelivery: true });
    expect(again.decision.action).toMatchObject({ type: "stop", stop: { reason: "delivery failed", retryable: true } });
    expect(delivers(again.jobs)).toHaveLength(2);
  });

  it("reviews and delivers with the latest valid decision record when a later work run carries none (#191)", () => {
    const { decision, jobs, evidence } = simulate({ supervisorWorkAfterFix: true });
    // The free-form work run is the latest work run in the evidence...
    const work = evidence.filter((e) => (e.payload as { producer?: { purpose?: string } }).producer?.purpose === "work");
    expect(work.at(-1)?.resultSchema).toBeUndefined();
    expect((work.at(-1)?.payload as { codingAgent: { output: unknown } }).codingAgent.output).toBeNull();
    // ...and neither review nor delivery reads it as the implementer's answer.
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(jobs.some((j) => j.stageId === "review" && j.purpose === "review")).toBe(true);
    expect(deliverArgs(jobs).body).toContain(`- ${TEST} in \`./pkg/timestamp\` fails by assertion on base-sha`);
  });

  it("picks the latest valid decision record, and reports a problem rather than a record when none is valid (#191)", () => {
    const run = (output: unknown, resultSchema?: string): EvidenceRecord => ({
      ref: "ev-1",
      kind: "other",
      generation: 1,
      ...(resultSchema !== undefined ? { resultSchema } : {}),
      payload: { codingAgent: { harness: "claude-code", status: "completed", output }, producer: { operationId: "op-1", stageId: "fix", purpose: "work", readOnly: false, kind: "agent" } },
    });
    expect(latestImplementerRecord([run(null)])).toBeUndefined();
    expect(implementerRecord([run(null)]).problem).toMatch(/invalid/);
    // A later free-form run is skipped; a later contract-bound invalid one is the problem.
    expect(implementerRecord([run(PLAN), run(null)]).record).toBeDefined();
    expect(implementerRecord([run(PLAN), run(null, "decision-record-v2")]).record).toBeUndefined();
    expect(latestImplementerRecord([run(PLAN), run(null, "decision-record-v2")])).toBeDefined();
  });

  it("reviews and delivers the accepted fix after a resume", () => {
    const { decision, jobs } = simulate({ resumeAfterFix: true });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent")).toHaveLength(1);
    const codeReview = jobs.find((j) => j.stageId === "review" && j.purpose === "review")!;
    expect(codeReview).toMatchObject({ kind: "agent", readOnly: true, input: { harness: "codex" } });
    expect(deliverArgs(jobs).body).toContain(`- ${TEST} in \`./pkg/timestamp\` fails by assertion on base-sha`);
  });

  const candidateJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.checkout?.from === "candidate" && j.purpose === "check");
  const jobTier = (job: JobSpec) => ((job.input as { commands: Array<{ id: string }> }).commands.some((c) => c.id === COMMAND.regression) ? "cheap" : "full");
  const ranIds = (job: JobSpec) => (job.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id);

  it("returns a failing check's output to the implementer, who continues its session", () => {
    const { decision, jobs } = simulate({
      candidate: [{ ["lint"]: { exitCode: 2, stderr: "scheduler.go:12: unused variable" } }, {}],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(2);
    const correction = (work[1]!.input as { assignment: string }).assignment;
    expect(correction).toContain("lint exited 2");
    expect(correction).toContain("scheduler.go:12: unused variable");
    expect(work[0]!.continueFrom).toBe("op-2");
    expect(work[1]!.continueFrom).toBe("op-3");
    // The cheap tier failed, so the first round never reached the full tier; the corrected change runs both.
    expect(candidateJobs(jobs).map(jobTier)).toEqual(["cheap", "cheap", "full"]);
  });

  describe("checks that failed before a resume (#154)", () => {
    // One per round of checks: the cheap job, which opens it.
    const checks = (jobs: JobSpec[]) => candidateJobs(jobs).filter((j) => jobTier(j) === "cheap");
    const baseRuns = (jobs: JobSpec[]) => jobs.filter((j) => j.checkout?.from === "base");
    const lintFails = { ["lint"]: { exitCode: 2, stderr: "no space left on device" } };
    const blocked = { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) };

    it("runs the candidate checks again after a resume instead of correcting the implementer", () => {
      const { decision, jobs } = simulate({ candidate: [lintFails, {}], resumeAfterCandidate: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
      expect(checks(jobs)).toHaveLength(2);
    });

    it("keeps checks that passed across a resume, running nothing again", () => {
      const { decision, jobs } = simulate({ resumeAfterCandidate: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
      expect(checks(jobs)).toHaveLength(1);
    });

    it("corrects the implementer when the checks fail again after the resume", () => {
      const { decision, jobs } = simulate({ candidate: [lintFails, lintFails, {}], resumeAfterCandidate: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(checks(jobs)).toHaveLength(3);
      const work = jobs.filter((j) => j.purpose === "work");
      expect(work).toHaveLength(2);
      expect(assignment(work[1])).toContain("lint exited 2");
      // The correction came after the re-run, not before it.
      expect(jobs.indexOf(work[1]!)).toBeGreaterThan(jobs.indexOf(checks(jobs)[1]!));
    });

    it("runs a RED that could not build before the resume again, instead of asking for a revert patch", () => {
      const { decision, jobs } = simulate({ reds: [blocked, { exitCode: 1, report: FAILED }], resumeAfterRed: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
      expect(baseRuns(jobs)).toHaveLength(2);
    });

    it("runs a RED that timed out or never started before the resume again", () => {
      for (const failure of [{ exitCode: 1, timedOut: true }, { exitCode: 1, aborted: true }, { exitCode: 1, spawnError: "ENOSPC" }, { exitCode: 1, report: "" }] as CommandResult[]) {
        const { decision, jobs } = simulate({ reds: [failure, { exitCode: 1, report: FAILED }], resumeAfterRed: 1 });
        expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
        expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
        expect(baseRuns(jobs)).toHaveLength(2);
      }
    });

    it("runs a reverted RED that never ran before the resume again", () => {
      const withPatch: DecisionRecord = { ...PLAN, revertPatch: "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n" };
      const { decision, jobs } = simulate({
        implement: [withPatch],
        red: blocked,
        revertedReds: [{ exitCode: 1, timedOut: true }, { exitCode: 1, report: FAILED }],
        resumeAfterReverted: 1,
      });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => (j.checkout as { revertPatch?: string } | undefined)?.revertPatch !== undefined).length).toBeGreaterThanOrEqual(2);
    });

    it("asks for a revert patch when RED cannot build after the resume either", () => {
      const { jobs } = simulate({ reds: [blocked], resumeAfterRed: 1 });
      expect(baseRuns(jobs).length).toBeGreaterThanOrEqual(2);
      expect(assignment(jobs.filter((j) => j.purpose === "work")[1])).toContain("revertPatch");
    });
  });


  describe("two-tier candidate checks (#173)", () => {
    const buildFails = { build: { exitCode: 2, stderr: "undefined: warnAction" } };
    const lintFailsNow = { lint: { exitCode: 2, stderr: "scheduler.go:12: unused variable" } };

    it("declares no license-check in the banyandb profile: make check runs it", () => {
      const ids = (BANYANDB as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
      expect(ids).toEqual(["test-ci", "build", "lint", "check"]);
      const statement = createGraph().describe(BANYANDB).requirements.find((r) => r.id === "builds")!.statement;
      expect(statement).not.toContain("make license-check");
      expect(statement).toContain("make check (which includes license-check and check-format)");
    });

    it("declares the cheap and full tiers, and rejects an unknown one", () => {
      const tiers = Object.fromEntries((BANYANDB as { commands: Array<{ id: string; tier?: string }> }).commands.map((c) => [c.id, c.tier ?? "full"]));
      expect(tiers).toEqual({ "test-ci": "cheap", build: "full", lint: "cheap", check: "full" });
      const bad = structuredClone(BANYANDB) as { commands: Array<{ tier?: string }> };
      bad.commands[0]!.tier = "fast";
      expect(() => parseProfile(bad)).toThrow(/commands\[0\]\.tier must be cheap, full or final/);
    });

    it("dispatches no full-tier command when the cheap tier fails, and corrects the implementer with that evidence", () => {
      const { decision, jobs } = simulate({ candidate: [lintFailsNow, {}] });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      const rounds = candidateJobs(jobs);
      // Round 1: the cheap job only; the correction follows it directly.
      expect(ranIds(rounds[0]!)).toEqual(["changes-diff", "regression", "test-ci", "lint"]);
      const afterFirst = jobs.slice(jobs.indexOf(rounds[0]!) + 1);
      expect(afterFirst[0]).toMatchObject({ purpose: "work" });
      expect(afterFirst.slice(0, 1).some((j) => j.checkout !== undefined)).toBe(false);
      const correction = assignment(afterFirst[0]);
      expect(correction).toContain("lint exited 2");
      expect(correction).toContain("scheduler.go:12: unused variable");
      expect(correction).toContain("the full checks (build, check) did not run");
      // The failing round cost no RED or full-tier job.
      expect(jobs.slice(0, jobs.indexOf(afterFirst[0]!)).filter((j) => j.checkout?.from === "base")).toHaveLength(0);
      const full = rounds.filter((j) => jobTier(j) === "full").flatMap(ranIds);
      expect(full).toEqual(["build", "check"]);
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(2);
    });

    it("runs the full tier only after the cheap tier passed, and a full-tier failure corrects the implementer", () => {
      const { decision, jobs } = simulate({ candidate: [buildFails, {}] });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(candidateJobs(jobs).map(jobTier)).toEqual(["cheap", "full", "cheap", "full"]);
      const work = jobs.filter((j) => j.purpose === "work");
      expect(work).toHaveLength(2);
      expect(assignment(work[1])).toContain("build exited 2");
      expect(assignment(work[1])).toContain("undefined: warnAction");
    });

    it("does not accept Fix before both tiers passed on the same candidate digest", () => {
      const { decision, evidence, receipts } = simulate({ candidate: [buildFails, {}] });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      const digestOf = (id: string) => evidence.filter((e) => (e.payload as { command?: { id?: string } }).command?.id === id && (e.payload as { checkout?: { from?: string } }).checkout?.from === "candidate").map((e) => e.candidateDigest);
      // The first digest's full tier failed; the receipt for builds is bound to the corrected digest, where every command ran.
      const builds = receipts.filter((r) => r.requirementId === "builds" && r.valid);
      expect(builds).toHaveLength(1);
      for (const id of ["regression", "test-ci", "lint", "build", "check"]) expect(digestOf(id)).toContain(builds[0]!.candidateDigest);
      expect(digestOf("build").length).toBe(2);
    });

    it("does not count a command that did not run as passed", () => {
      const evidence = candidateEvidenceFor(["regression", "test-ci", "lint"]);
      const builds = validatorById("build-checks")!.evaluate({ requirementId: "builds", statement: "s", evidence, candidateDigest: "d1", config: BANYANDB });
      expect(builds).toMatchObject({ status: "failed" });
      expect(builds.reason).toContain("build did not run");
      expect(builds.reason).toContain("check did not run");
      const full = candidateEvidenceFor(["regression", "test-ci", "lint", "build", "check"]);
      expect(validatorById("build-checks")!.evaluate({ requirementId: "builds", statement: "s", evidence: full, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed" });
      // A full tier earned on another digest does not stand for this one.
      const other = [...candidateEvidenceFor(["regression", "test-ci", "lint"]), ...candidateEvidenceFor(["build", "check"], "d0")];
      expect(validatorById("build-checks")!.evaluate({ requirementId: "builds", statement: "s", evidence: other, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "failed" });
    });

    it("runs a cheap tier that failed before a resume again, and then the full tier", () => {
      const { decision, jobs } = simulate({ candidate: [lintFailsNow, {}], resumeAfterCandidate: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
      expect(candidateJobs(jobs).map(jobTier)).toEqual(["cheap", "cheap", "full"]);
    });

    it("runs a full tier that failed before a resume again, instead of correcting the implementer", () => {
      const { decision, jobs } = simulate({ fullChecks: [buildFails, {}], resumeAfterFullChecks: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
      // The cheap tier passed and stays valid across the resume: only the full tier runs again.
      expect(candidateJobs(jobs).map(jobTier)).toEqual(["cheap", "full", "full"]);
    });

    it("corrects the implementer when the full tier fails again after the resume", () => {
      const { jobs } = simulate({ fullChecks: [buildFails, buildFails, {}], resumeAfterFullChecks: 1 });
      expect(candidateJobs(jobs).map(jobTier).slice(0, 3)).toEqual(["cheap", "full", "full"]);
      const work = jobs.filter((j) => j.purpose === "work");
      expect(work.length).toBeGreaterThanOrEqual(2);
      expect(jobs.indexOf(work[1]!)).toBeGreaterThan(jobs.indexOf(candidateJobs(jobs)[2]!));
    });

    it("lists the self-check commands in the implementer assignment, and asks for a report of what ran", () => {
      const { jobs } = simulate({});
      const first = assignment(jobs.find((j) => j.purpose === "work"));
      const selfCheck = (BANYANDB as { implementation: { selfCheck: string[] } }).implementation.selfCheck;
      expect(selfCheck.length).toBeGreaterThan(0);
      for (const command of selfCheck) expect(first).toContain(`\`${command}\``);
      expect(first).toContain(`the regression test (${TEST}`);
      expect(first).toContain("Before you return status ready, run these yourself");
      expect(first).toContain("selfChecks");
      // A profile without selfCheck adds no such line.
      const plain = structuredClone(BANYANDB) as { implementation: { selfCheck?: string[] } };
      delete plain.implementation.selfCheck;
      expect(implementInstruction(parseProfile(plain), { issue: 1, plan: PLAN })).not.toContain("Before you return status ready");
    });

    it("dispatches the full tier when a passes command (test-ci) belongs to it, and accepts Fix once it passes", () => {
      const profile = structuredClone(BANYANDB) as { commands: Array<{ id: string; tier?: string }> };
      for (const c of profile.commands) c.tier = c.id === "lint" ? "cheap" : "full";
      const { decision, jobs, receipts } = simulate({ profile });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      const rounds = candidateJobs(jobs);
      expect(rounds.map(jobTier)).toEqual(["cheap", "full"]);
      expect(ranIds(rounds[0]!)).toEqual(["changes-diff", "regression", "lint"]);
      expect(ranIds(rounds[1]!)).toEqual(["test-ci", "build", "check"]);
      // No correction was spent waiting for evidence that had not been asked for yet.
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(1);
      const valid = receipts.filter((r) => r.stageId === "fix" && r.valid).map((r) => r.requirementId);
      expect(valid).toEqual(expect.arrayContaining(["passes", "builds"]));
    });

    it("corrects the implementer when that full-tier test-ci fails", () => {
      const profile = structuredClone(BANYANDB) as { commands: Array<{ id: string; tier?: string }> };
      for (const c of profile.commands) c.tier = c.id === "lint" ? "cheap" : "full";
      const { decision, jobs } = simulate({ profile, candidate: [{ "test-ci": { exitCode: 2, stderr: "FAIL pkg/timestamp" } }, {}] });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      const work = jobs.filter((j) => j.purpose === "work");
      expect(work).toHaveLength(2);
      expect(assignment(work[1])).toContain("test-ci exited 2");
    });

    it("does not dispatch the full tier when GREEN exits 0 without running the named test, and corrects the implementer", () => {
      const { decision, jobs } = simulate({ candidate: [{ [COMMAND.regression]: { exitCode: 0, report: "" } }, {}] });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      const rounds = candidateJobs(jobs);
      expect(rounds.map(jobTier)).toEqual(["cheap", "cheap", "full"]);
      const work = jobs.filter((j) => j.purpose === "work");
      expect(work).toHaveLength(2);
      // The correction follows the first cheap job directly: no RED, no full tier in between.
      expect(jobs.indexOf(work[1]!)).toBe(jobs.indexOf(rounds[0]!) + 1);
      expect(assignment(work[1])).toContain("does not pass on the change");
    });

    it("runs every check in one job when a profile declares no cheap command", () => {
      const flat = structuredClone(BANYANDB) as { commands: Array<{ tier?: string }> };
      for (const c of flat.commands) delete c.tier;
      const profile = parseProfile(flat);
      expect(candidateCommands(profile, PLAN.test!).map((c) => c.id)).toEqual(["changes-diff", "regression", "test-ci", "build", "lint", "check"]);
    });
  });

  it("fails a change that make check reformats, even when the command exits 0", () => {
    const { jobs } = simulate({ candidateMutations: [["pkg/timestamp/scheduler.go"], []] });
    const correction = (jobs.filter((j) => j.purpose === "work")[1]!.input as { assignment: string }).assignment;
    expect(correction).toContain("the checks in the candidate checkout that ran regression left files changed: pkg/timestamp/scheduler.go");
    expect(correction.match(/checkout left pkg\/timestamp\/scheduler\.go changed/g)).toHaveLength(1);
  });

  it("shows the implementer why the regression test did not run", () => {
    const usage = events(
      { Action: "start", Package: "p" },
      { Action: "output", Package: "p", Output: '{"level":"info","message":"maxprocs: Leaving GOMAXPROCS=32"}\n' },
      { Action: "output", Package: "p", Output: "flag provided but not defined: -ginkgo.focus\n" },
      { Action: "output", Package: "p", Output: "Usage of /tmp/go-build1/b001/timestamp.test:\n" },
      { Action: "output", Package: "p", Output: "  -test.bench regexp\n" },
      { Action: "output", Package: "p", Output: "    \trun only benchmarks matching regexp\n" },
      { Action: "fail", Package: "p" },
    );
    const { jobs } = simulate({ candidate: [{ [COMMAND.regression]: { exitCode: 1, report: usage } }, {}] });
    const correction = (jobs.filter((j) => j.purpose === "work")[1]!.input as { assignment: string }).assignment;
    expect(correction).toContain("regression exited 1 in the candidate checkout:\nflag provided but not defined: -ginkgo.focus");
    expect(correction).not.toContain("-test.bench");
    expect(correction).not.toContain("maxprocs");
  });

  it("asks for a patch reverting the fix when RED cannot build on the base, instead of a generic correction", () => {
    const { jobs } = simulate({ red: { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) } });
    const ask = (jobs.filter((j) => j.purpose === "work")[1]!.input as { assignment: string }).assignment;
    expect(ask).toContain("RED could not build");
    expect(ask).toContain("revertPatch");
  });

  it("hands an unbuildable RED to the supervisor once the implementer never supplies a working revert patch", () => {
    const { decision } = simulate({ red: { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) } });
    expect(decision.action.type).toBe("supervise");
  });

  it("retries RED against the candidate with the implementer's own patch reverted, and accepts it once it fails by assertion", () => {
    const withPatch: DecisionRecord = {
      ...PLAN,
      revertPatch: "diff --git a/pkg/timestamp/scheduler.go b/pkg/timestamp/scheduler.go\n--- a/pkg/timestamp/scheduler.go\n+++ b/pkg/timestamp/scheduler.go\n@@ -1 +1 @@\n-old\n+new\n",
    };
    const { decision, jobs, receipts } = simulate({
      red: { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) },
      implement: [undefined, withPatch],
      redReverted: { exitCode: 1, report: FAILED },
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const reverted = jobs.find((j) => j.checkout?.from === "candidate" && j.checkout.revertPatch !== undefined);
    expect(reverted).toBeDefined();
    expect(receipts.some((r) => r.stageId === "fix" && r.requirementId === "reproduces" && r.valid)).toBe(true);
  });

  it("asks for a fresh revert patch when the recorded one no longer applies, instead of failing the executor", () => {
    const patch = (marker: string) => `diff --git a/pkg/timestamp/scheduler.go b/pkg/timestamp/scheduler.go\n--- a/pkg/timestamp/scheduler.go\n+++ b/pkg/timestamp/scheduler.go\n@@ -1 +1 @@\n-${marker}\n+new\n`;
    const stale: DecisionRecord = { ...PLAN, revertPatch: patch("stale") };
    const fresh: DecisionRecord = { ...PLAN, revertPatch: patch("fresh") };
    const { decision, jobs, receipts } = simulate({
      red: { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) },
      implement: [undefined, stale, fresh],
      revertApplies: (p) => p === fresh.revertPatch,
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    // The stale patch was tried once, then never again; the fresh one was tried.
    const tried = jobs.filter((j) => j.checkout?.from === "candidate" && j.checkout.revertPatch !== undefined).map((j) => (j.checkout as { revertPatch: string }).revertPatch);
    expect(tried).toEqual([stale.revertPatch, fresh.revertPatch]);
    const ask = (jobs.filter((j) => j.purpose === "work")[2]!.input as { assignment: string }).assignment;
    expect(ask).toContain("Your earlier revertPatch cannot be used");
    expect(ask).toContain("does not apply");
    expect(receipts.some((r) => r.stageId === "fix" && r.requirementId === "reproduces" && r.valid)).toBe(true);
  });

  it("retries an unchanged revert patch at most once per candidate, and hands off once corrections run out", () => {
    const stale: DecisionRecord = { ...PLAN, revertPatch: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" };
    const { decision, jobs } = simulate({
      red: { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) },
      implement: [undefined, stale, stale, stale],
      revertApplies: () => false,
    });
    expect(decision.action.type).toBe("supervise");
    expect(jobs.filter((j) => j.checkout?.from === "candidate" && j.checkout.revertPatch !== undefined)).toHaveLength(2);
  });

  describe("what the commit and the pull request say (#161)", () => {
    const CHANGE = "`Scheduler.trigger` now warns when an action runs past five minutes and logs its real outcome when it ends, instead of reporting it as timed out.";
    const round = (summary: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({ ...PLAN, change: CHANGE, summary, ...extra });
    const LAST_ROUND =
      "I fixed the two reopened findings I3 and I5 and marked them fixed in .graphloom/issues.json. I did not re-run make test-ci, build and check in this attempt.";

    it("describes the change from `change`, not from the last correction round's report, and names only the checks the evidence shows passed", () => {
      const { decision, jobs } = simulate({
        implement: [
          round("I wrote the test and the fix."),
          round("I fixed lint findings I1 and I2."),
          round(LAST_ROUND, { followUps: ["Re-run make test-ci in a checkout with free disk.", "Consider a metric for actions that outlive the warning."] }),
        ],
        candidate: [{ lint: { exitCode: 2, stderr: "unused" } }, { build: { exitCode: 1, stderr: "undefined: x" } }, {}],
      });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(3);
      const { message, body } = deliverArgs(jobs);
      expect(message).toBe(`${PLAN.title}\n\n${CHANGE}\n\nFixes apache/skywalking#${ISSUE}`);
      expect(body).toContain(`## Summary\n${CHANGE}\n`);
      for (const text of [message, body]) {
        expect(text).not.toContain(".graphloom");
        expect(text).not.toMatch(/\bI\d+\b/);
        expect(text).not.toMatch(/I did not|I fixed|I wrote/);
      }
      // The graph's pinned checks passed on the delivered candidate: the Test plan says so from evidence.
      const plan = body.slice(body.indexOf("## Test plan"));
      const checks = [...commandsFor(PROFILE, "passes"), ...commandsFor(PROFILE, "builds")].map(commandSummary);
      expect(plan).toContain(`- ${listAnd(checks)} pass.`);
      // An environment note about a check the graph ran itself is dropped; a real follow-up stays.
      expect(body).not.toMatch(/free disk|Re-run/);
      expect(body).toContain("- Consider a metric for actions that outlive the warning.");
    });

    it("lists as passed only the pinned checks whose evidence shows them passing", () => {
      const verified = [commandSummary(commandsFor(PROFILE, "builds")[0]!)];
      const body = pullRequestDescription(PROFILE, { issue: ISSUE, issueTitle: "t", record: round("x"), base: "abc", review: "Reviewed.", verified });
      expect(body).toContain(`- ${verified[0]} pass.`);
      const further = commandSummary(commandsFor(PROFILE, "passes")[0]!);
      expect(body).not.toContain(further);
      expect(pullRequestDescription(PROFILE, { issue: ISSUE, issueTitle: "t", record: round("x"), base: "abc", review: "Reviewed.", verified: [] })).not.toMatch(/ pass\.\n/);
    });

    it("strips bookkeeping from a `change` that carries it anyway", () => {
      const record = round("s", { change: "Actions past five minutes are reported as running. Fixed I3 and I5 in .graphloom/issues.json. I did not run make test-ci." });
      expect(commitMessage(PROFILE, { issue: ISSUE, issueTitle: "t", record })).toContain("\n\nActions past five minutes are reported as running.\n\n");
    });

    it("keeps follow-ups that merely contain a pinned command's id or a word like disk, and drops re-runs of pinned checks", () => {
      const keep = [
        "Consider persisting checkpoints across restarts.",
        "Look at rebuilding the index lazily.",
        "Disk usage of the cache grows with the number of environments.",
        "Re-running compaction after a crash may duplicate parts.",
        "Add a lint rule for this.",
      ];
      for (const note of keep) expect(deliverableFollowUp(PROFILE, note), note).toBe(note);
      const drop = ["Re-run make test-ci in a checkout with free disk.", "Run `build` again once the sandbox has network.", "I3 still open."];
      for (const note of drop) expect(deliverableFollowUp(PROFILE, note), note).toBeUndefined();
    });

    it("keeps the useful sentence of a follow-up whose other sentence is a re-run of a pinned check", () => {
      expect(deliverableFollowUp(PROFILE, "Consider a metric for long-running actions. I did not re-run make test-ci.")).toBe("Consider a metric for long-running actions.");
      expect(deliverableFollowUp(PROFILE, "Consider a metric for long-running actions. Re-run make test-ci with free disk.")).toBe("Consider a metric for long-running actions.");
      expect(deliverableFollowUp(PROFILE, "Re-run make test-ci with free disk. I did not run it.")).toBeUndefined();
    });

    it("renders sanitized text for follow-ups, decisions and open questions, never the original", () => {
      expect(deliverableFollowUp(PROFILE, "Consider a metric for long-running actions. I fixed I3 in .graphloom/issues.json.")).toBe("Consider a metric for long-running actions.");
      const record = round("x", {
        followUps: ["Consider a metric for long-running actions. I fixed I3 in .graphloom/issues.json."],
        openQuestions: ["Should the metric keep counting? I left it as is for I5."],
        decisions: [{ point: "What to do", tier: "behaviour", options: ["warn", "cancel"], chosen: "warn", basis: "The issue asks for it. I confirmed I2 against .graphloom/issues.json." }],
      });
      const body = pullRequestDescription(PROFILE, { issue: ISSUE, issueTitle: "t", record, base: "abc", review: "Reviewed." });
      expect(body).toContain("- Consider a metric for long-running actions.\n");
      expect(body).toContain("- Should the metric keep counting?\n");
      expect(body).toContain("- What to do: warn. The issue asks for it. Alternatives: cancel.");
      expect(body).not.toMatch(/\bI\d+\b|\.graphloom|I fixed|I left|I confirmed/);
    });

    it("leaves out a decision whose point or choice is nothing but bookkeeping", () => {
      const record = round("x", {
        decisions: [
          { point: "Address I3 in .graphloom/issues.json", tier: "behaviour", options: ["a", "b"], chosen: "a", basis: "Keeps the order." },
          { point: "Retry policy", tier: "behaviour", options: ["fixed", "backoff"], chosen: "I fixed I5.", basis: "Simpler." },
          { point: "Timeout", tier: "behaviour", options: ["warn", "cancel"], chosen: "warn", basis: "The issue asks for it." },
        ],
      });
      const body = pullRequestDescription(PROFILE, { issue: ISSUE, issueTitle: "t", record, base: "abc", review: "Reviewed." });
      expect(body).toContain("- Timeout: warn. The issue asks for it. Alternatives: cancel.");
      expect(body).not.toMatch(/\bI\d+\b|\.graphloom|I fixed|Retry policy/);
      const onlyBookkeeping = round("x", { decisions: [{ point: "Address I3", tier: "behaviour", options: ["a"], chosen: "a", basis: "" }] });
      expect(pullRequestDescription(PROFILE, { issue: ISSUE, issueTitle: "t", record: onlyBookkeeping, base: "abc", review: "Reviewed." })).not.toContain("## Decisions");
    });

    it("keeps change sentences that only look like narration, and still strips narration and ids", () => {
      const change = 'I/O errors are now retried. The I2C probe is unchanged. The log says "I fixed it" on success.';
      expect(withoutBookkeeping(change)).toBe(change);
      const narrated = "Retries are bounded. I fixed the hang. We saw it twice and I did not run make test-ci. I'm done. Closes I3, F1 and .graphloom/issues.json.";
      expect(withoutBookkeeping(narrated)).toBe("Retries are bounded.");
    });

    it("delivers a legacy record without `change` from the plan, then its own summary, without the round's narrative", () => {
      const legacy: DecisionRecord = { ...PLAN, summary: LAST_ROUND };
      const plan = { ...PLAN, summary: "Warn at the timeout while the action is still running." };
      expect(commitMessage(PROFILE, { issue: ISSUE, issueTitle: "t", record: legacy, plan })).toBe(`${PLAN.title}\n\n${plan.summary}\n\nFixes apache/skywalking#${ISSUE}`);
      // With no plan to fall back on, nothing but bookkeeping remains in the summary, so the title stands in.
      expect(commitMessage(PROFILE, { issue: ISSUE, issueTitle: "t", record: legacy })).toBe(`${PLAN.title}\n\n${PLAN.title}\n\nFixes apache/skywalking#${ISSUE}`);
    });

    it("asks the planner and the implementer for `change` apart from the round's summary", () => {
      const { jobs } = simulate({});
      const [plan, implement] = [jobs.find((j) => j.purpose === "diagnostic" && j.kind === "agent"), jobs.find((j) => j.purpose === "work")];
      for (const job of [plan, implement]) {
        expect(assignment(job)).toContain("- change: what the change as a whole does and why");
        expect(job!.resultSchema).toBe("decision-record-v2");
      }
      expect(assignment(implement)).toContain("summary is your report on this pass");
    });
  });

  it("hands the run to the supervisor after two corrections", () => {
    const failing = { ["build"]: { exitCode: 1, stderr: "undefined: x" } };
    const { decision, jobs } = simulate({ candidate: [failing, failing, failing] });
    expect(decision.action.type).toBe("supervise");
    expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(3);
  });

  it("rejects a request that names no issue", () => {
    expect(requestedIssue("Fix the scheduler.", PROFILE)).toBeUndefined();
    expect(requestedIssue("Fix apache/skywalking#14111.\nDecisions: see #1", PROFILE)).toBe(14111);
    const { decision } = simulate({}, "Fix the scheduler.");
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task" } });
  });
});

describe("go test -json outcome", () => {
  it("tells an assertion failure from a build failure", () => {
    expect(testOutcome(FAILED, TEST)).toBe("failed");
    expect(testOutcome(PASSED, TEST)).toBe("passed");
    expect(testOutcome(events({ Action: "build-fail" }), TEST)).toBe("build-failed");
    expect(testOutcome("FAIL\tp [build failed]", TEST)).toBe("build-failed");
    expect(testOutcome(events({ Action: "fail", Test: "TestOther" }), TEST)).toBe("not-run");
    expect(testOutcome(events({ Action: "pass", Test: TEST }, { Action: "fail", Test: TEST }), TEST)).toBe("failed");
  });

  it("tells a panic from an assertion failure", () => {
    const panic = events({ Action: "output", Test: TEST, Output: "panic: runtime error: index out of range [recovered]\n" }, { Action: "fail", Test: TEST });
    expect(testOutcome(panic, TEST)).toBe("panicked");
    expect(testOutcome(events({ Action: "output", Test: "TestOther", Output: "panic: boom\n" }, { Action: "fail", Test: TEST }), TEST)).toBe("failed");
    expect(testOutcome(events({ Action: "output", Test: TEST, Output: "expected panic: none\n" }, { Action: "fail", Test: TEST }), TEST)).toBe("failed");
  });

  it("judges a Ginkgo suite by the specs that ran, not by the suite's TestXxx", () => {
    const ginkgo = (specs: Array<Partial<GinkgoSpec>>) =>
      `${FAILED}\n${JSON.stringify({ GraphLoomGinkgo: { specs: specs.map((s) => ({ text: "scheduler warns", node: "It", state: "passed", failureNode: "", message: "", ...s })) } })}`;
    const suite = { name: TEST, focus: "warns" };
    expect(regressionOutcome(ginkgo([{ state: "failed", failureNode: "It" }]), suite)).toBe("failed");
    expect(regressionOutcome(ginkgo([{ state: "panicked", failureNode: "It" }]), suite)).toBe("panicked");
    expect(regressionOutcome(ginkgo([{ state: "passed" }]), suite)).toBe("passed");
    expect(regressionOutcome(ginkgo([{ node: "BeforeSuite", state: "failed", failureNode: "BeforeSuite" }]), suite)).toBe("not-run");
    expect(regressionOutcome(ginkgo([{ state: "failed", failureNode: "BeforeEach" }]), suite)).toBe("setup-failed");
    expect(regressionOutcome(ginkgo([]), suite)).toBe("not-run");
    expect(regressionOutcome(`${FAILED}\n{"GraphLoomGinkgo":{"missing":true}}`, suite)).toBe("not-run");
    expect(regressionOutcome(events({ Action: "build-fail" }, { GraphLoomGinkgo: { missing: true } }), suite)).toBe("build-failed");
    expect(regressionOutcome(`${FAILED}\n{"GraphLoomPlainTest":true}`, { name: TEST, focus: "ignored in a plain package" })).toBe("failed");
    expect(ginkgoSpecs(ginkgo([{ state: "failed", failureNode: "It" }]))!.map((s) => s.text)).toEqual(["scheduler warns"]);
  });

  it("judges only the focused spec, and a focused run without its spec summary as not run", () => {
    const ginkgo = (specs: Array<Partial<GinkgoSpec>>) =>
      `${FAILED}\n${JSON.stringify({ GraphLoomGinkgo: { specs: specs.map((s) => ({ text: "scheduler warns", node: "It", state: "passed", failureNode: "", message: "", ...s })) } })}`;
    const suite = { name: TEST, focus: "scheduler warns" };
    expect(regressionOutcome(ginkgo([{ text: "scheduler stops", state: "failed", failureNode: "It" }]), suite)).toBe("not-run");
    expect(regressionOutcome(ginkgo([{ text: "scheduler stops", state: "failed", failureNode: "It" }, {}]), suite)).toBe("passed");
    expect(regressionOutcome(ginkgo([{ text: "scheduler stops", state: "passed" }, { state: "failed", failureNode: "It" }]), suite)).toBe("failed");
    // The suite's TestXxx failed, but nothing shows which spec ran: an interrupted run or lost summary is not RED.
    expect(regressionOutcome(FAILED, suite)).toBe("not-run");
    expect(regressionOutcome(FAILED, { name: TEST })).toBe("failed");
  });

  it.skipIf(REAL_GO === "")("reduces a real Ginkgo report to the specs that ran", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bydb-ginkgo-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    // Stands in for `go test`: writes the Ginkgo report it was asked for; `go run` stays real.
    const report = [
      {
        SuiteSucceeded: false,
        SpecReports: [
          { ContainerHierarchyTexts: [], LeafNodeType: "BeforeSuite", LeafNodeText: "", State: "passed", Failure: {} },
          { ContainerHierarchyTexts: ["scheduler"], LeafNodeType: "It", LeafNodeText: "warns", State: "failed", Failure: { Message: "expected warn", FailureNodeType: "It" } },
          { ContainerHierarchyTexts: ["scheduler"], LeafNodeType: "It", LeafNodeText: "other", State: "skipped", Failure: {} },
        ],
      },
    ];
    await writeFile(
      path.join(bin, "go"),
      `#!/bin/sh\nif [ "$1" = test ]; then for a in "$@"; do case "$a" in -ginkgo.json-report=*) printf '%s' '${JSON.stringify(report)}' > "\${a#-ginkgo.json-report=}";; esac; done; echo '{"Action":"fail","Test":"${TEST}"}'; exit 1; fi\nexec ${REAL_GO} "$@"\n`,
      { mode: 0o755 },
    );
    await mkdir(path.join(root, "pkg", "suite"), { recursive: true });
    await writeFile(path.join(root, "pkg", "suite", "a_test.go"), 'package suite\nimport "github.com/onsi/ginkgo/v2"\n', "utf8");
    const out = path.join(root, "regression.out");
    try {
      const [cmd, ...args] = regressionArgv({ package: "./pkg/suite", name: TEST, focus: "warns" });
      await execFileAsync(cmd!, args, { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRAPHLOOM_REPORT_FILE: out } }).catch(() => undefined);
      const text = await readFile(out, "utf8");
      expect(ginkgoSpecs(text)).toEqual([
        { text: "", node: "BeforeSuite", state: "passed", failureNode: "", message: "" },
        { text: "scheduler warns", node: "It", state: "failed", failureNode: "It", message: "expected warn" },
      ]);
      expect(regressionOutcome(text, { name: TEST, focus: "warns" })).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("focuses a spec only in a package whose tests use Ginkgo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bydb-regression-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "go"), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    await mkdir(path.join(root, "pkg", "plain"), { recursive: true });
    await writeFile(path.join(root, "pkg", "plain", "a_test.go"), 'package plain\nimport "testing"\n', "utf8");
    await mkdir(path.join(root, "pkg", "suite"), { recursive: true });
    await writeFile(path.join(root, "pkg", "suite", "a_test.go"), 'package suite\nimport "github.com/onsi/ginkgo/v2"\n', "utf8");
    const run = async (pkg: string, focus?: string) => {
      const report = path.join(root, `${pkg.replace(/\W/g, "")}.out`);
      const [cmd, ...args] = regressionArgv({ package: pkg, name: TEST, ...(focus !== undefined ? { focus } : {}) });
      await execFileAsync(cmd!, args, { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRAPHLOOM_REPORT_FILE: report } });
      return (await readFile(report, "utf8")).trim();
    };
    try {
      const plain = [`test -json -count=1 -run ^${TEST}$ ./pkg/plain`, '{"GraphLoomPlainTest":true}'].join("\n");
      expect(await run("./pkg/plain", "a long description of the test")).toBe(plain);
      const suiteReport = path.join(root, "pkgsuite.out");
      expect((await run("./pkg/suite", "warns (twice) [x] a.b+")).split("\n")[0]).toBe(
        `test -json -count=1 -run ^${TEST}$ ./pkg/suite -args -ginkgo.focus=warns \\(twice\\) \\[x\\] a\\.b\\+ -ginkgo.json-report=${suiteReport}.ginkgo`,
      );
      expect(await run("./pkg/suite")).toBe([`test -json -count=1 -run ^${TEST}$ ./pkg/suite`, '{"GraphLoomPlainTest":true}'].join("\n"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("code review in open-code-review's delegation mode", () => {
  const issue = { number: ISSUE, title: "Scheduler reports long actions as timed out", state: "open", url: "u", labels: [], body: "x".repeat(10_000) };

  it("tells the reviewer to run ocr by its absolute path, on the worktree change, with test files and the extra rule", () => {
    const background = reviewBackground(PROFILE, issue, PLAN);
    expect(background.length).toBeLessThanOrEqual(2_000);
    expect(background).toContain(PLAN.summary);
    expect(background).toContain("- What to do at five minutes: warn and wait");
    const text = codeReviewInstruction(PROFILE, { ocr: "/home/me/.nvm/bin/ocr", base: "abc123", background });
    expect(text).toContain("`/home/me/.nvm/bin/ocr delegate preview --format json`");
    expect(text).toContain("`/home/me/.nvm/bin/ocr delegate rule --format json <path>...`");
    expect(text).toContain("against HEAD (the base commit abc123)");
    expect(text).toContain("the change's Go test files (`_test.go`), other tests");
    expect(text).toContain("a test whose expected value is derived from the new code rather than from the issue");
    expect(text).toContain(background);
    expect(codeReviewInstruction(PROFILE, { ocr: "/it's/ocr", base: "b", background: "" })).toContain(`'/it'\\''s/ocr' delegate preview`);
  });

  it("reviews every changed file under every profile, ocr's exclusions included, but never .graphloom/, and checks the change as a whole (#148)", () => {
    for (const profile of [PROFILE, parseProfile(shippedProfile("graphloom"))]) {
      const text = codeReviewInstruction(profile, { ocr: "ocr", base: "b", background: "" });
      const lines = text.split("\n");
      const list = lines.find((l) => l.startsWith("2. "))!;
      // Every file preview excluded goes back on the list, whatever the profile and whatever the reason.
      expect(list).toContain("Your list is every changed file. Add back every file preview excluded, whatever its reason");
      expect(list).toContain(`the change's ${profile.review.testFiles}, other tests, docs, fixtures, generated files and anything else it left out`);
      expect(list).not.toContain("Leave out other excluded files");
      // Only the run's own bookkeeping stays out.
      expect(list).toContain("Leave out only `.graphloom/`");
      // ocr resolves the rules for the whole list.
      expect(lines.find((l) => l.startsWith("3. "))).toContain("`ocr delegate rule --format json <path>...` with every file on your list");
      // The per-file review stays, then the change as a whole.
      const perFile = lines.findIndex((l) => l.startsWith("4. "));
      expect(lines[perFile]).toContain("For each file, read its diff");
      expect(lines[perFile + 1]).toBe(WHOLE_CHANGE_CHECK);
      for (const focus of ["data passed between modules", "promises one file makes that another breaks", "budget and limit invariants", "changed paths that no test in the change covers"]) {
        expect(WHOLE_CHANGE_CHECK).toContain(focus);
      }
      // The profile's own extra rule is kept.
      expect(text).toContain(`Extra rule for ${profile.review.language} files:`);
      // A verification round still covers every file but raises nothing new: no whole-change search.
      const verifying = codeReviewInstruction(profile, { ocr: "ocr", base: "b", background: "", round: MAX_DISCOVERY_ROUNDS + 1 });
      expect(verifying).toContain("Leave out only `.graphloom/`");
      expect(verifying).not.toContain(WHOLE_CHANGE_CHECK);
      expect(verifying).toContain("a verification round");
    }
  });

  it("asks for a result Codex's structured output accepts: every property required, none extra", () => {
    const strict = (schema: Record<string, unknown>): void => {
      if (schema.type === "object") {
        const properties = schema.properties as Record<string, Record<string, unknown>>;
        expect(schema.additionalProperties).toBe(false);
        expect([...(schema.required as string[])].sort()).toEqual(Object.keys(properties).sort());
        for (const p of Object.values(properties)) strict(p);
      }
      if (schema.type === "array") strict(schema.items as Record<string, unknown>);
    };
    strict(JSON.parse(CODE_REVIEW_SCHEMA));
    strict(JSON.parse(VERIFICATION_SCHEMA));
  });

  it("shows a pass the known findings by name: open ones owe a status, settled ones return only by name", () => {
    const known = { open: [{ id: "F2", state: "confirmed", description: "a.go:3 (high, bug): leak" }], settled: [{ id: "F1", state: "dismissed", description: "b.go:9 (high, bug): race" }] };
    const text = codeReviewInstruction(PROFILE, { ocr: "ocr", base: "b", background: "", known, sweep: true });
    expect(text).toContain("Give each one a status in `prior`");
    expect(text).toContain("- F2 (confirmed) a.go:3 (high, bug): leak");
    expect(text).toContain("Do not report them again unless the defect is back in the current code; then report it with its name in `finding`.\n- F1 (dismissed) b.go:9 (high, bug): race");
    expect(text).toContain("look for critical or high issues that are not on the list");
    expect(codeReviewInstruction(PROFILE, { ocr: "ocr", base: "b", background: "" })).not.toContain("prior`:");
  });

  it("reads each pass's statuses and named comments, and the verifier's verdicts", () => {
    const parsed = parseCodeReview({
      comments: [{ ...HANG, finding: " F1 ", evidence: "Close blocks on wg.Wait" }, { ...HANG, finding: "", evidence: "" }],
      prior: [{ finding: "F2", status: "resolved", reason: "gone" }, { finding: "F3", status: "fixed", reason: "not a status" }],
      summary: SUMMARY,
    });
    if ("problem" in parsed) throw new Error(parsed.problem);
    expect(parsed.report.comments.map((c) => [c.finding, c.evidence])).toEqual([["F1", "Close blocks on wg.Wait"], [undefined, undefined]]);
    expect(parsed.report.prior).toEqual([{ finding: "F2", status: "resolved", reason: "gone" }]);
    const verification = parseVerification({ verdicts: [{ finding: "F1", verdict: "refuted", reason: "r", quotes: [BOUNDED, { path: "x" }] }, { finding: "F2", verdict: "maybe" }] });
    if ("problem" in verification) throw new Error(verification.problem);
    expect([...verification.verdicts.keys()]).toEqual(["F1"]);
    expect(verification.verdicts.get("F1")!.quotes).toEqual([BOUNDED]);
    expect(parseVerification("done")).toEqual({ problem: "the verifier returned no verdicts" });
  });

  it("reads the reviewer's result, most severe first, and refuses one without coverage", () => {
    const parsed = parseCodeReview({
      comments: [{ ...HANG, severity: "low" }, { path: "a.go", content: "no severity" }, HANG],
      summary: { total_files: 3, reviewed_files: 3, skipped: [] },
    });
    if ("problem" in parsed) throw new Error(parsed.problem);
    expect(parsed.report.comments.map((c) => c.severity ?? "none")).toEqual(["high", "none", "low"]);
    expect(blockingComments(parsed.report)).toHaveLength(2);
    expect(parseCodeReview({ comments: [] })).toEqual({ problem: "the code reviewer's result has no comments or coverage summary" });
    expect(parseCodeReview("looks fine")).toEqual({ problem: "the code reviewer returned no result" });
    expect(parseCodeReview({ comments: [{ severity: "high" }], summary: { total_files: 1, reviewed_files: 1, skipped: [] } })).toEqual({
      problem: "a code review comment has no path or content",
    });
  });
});

describe("findings ledger", () => {
  let n = 0;
  const agent = (purpose: string, digest: string, output: unknown, status = "completed"): EvidenceRecord => ({
    ref: `r-${++n}`,
    kind: "other",
    generation: 1,
    candidateDigest: digest,
    payload: { codingAgent: { status, output }, producer: { operationId: `op-${n}`, stageId: "review", purpose, readOnly: true, kind: "agent", executorId: "graphloom.coding-agent/run" } },
  });
  const pass = (digest: string, comments: Array<Record<string, unknown>>, statuses: Record<string, string> = {}) => agent("review", digest, priorPass(statuses, comments).output);
  const verify = (digest: string, ...list: Parameters<typeof verdicts>) => agent("diagnostic", digest, verdicts(...list).output);
  const confirm = (digest: string, finding = "F1") => verify(digest, { finding, verdict: "confirmed", quotes: [{ path: "pkg/timestamp/scheduler.go", line: 7, text: "s.wait(ctx)" }] });
  const file = (digest: string, bytes: string, path = "pkg/timestamp/scheduler.go"): EvidenceRecord => ({ ref: `r-${++n}`, kind: "file", generation: 1, candidateDigest: digest, payload: { path, bytes } });
  const states = (evidence: EvidenceRecord[]) => Object.fromEntries(findingLedger(evidence).findings.map((f) => [f.id, `${f.state}@${f.on}`]));

  it("fixes a confirmed finding only on another change, and reopens it as a regression when raised again by name", () => {
    const evidence = [pass("d1", [HANG]), confirm("d1"), pass("d1", [], { F1: "resolved" })];
    expect(states(evidence)).toEqual({ F1: "confirmed@d1" });
    evidence.push(pass("d2", [], { F1: "resolved" }));
    expect(states(evidence)).toEqual({ F1: "fixed@d2" });
    evidence.push(pass("d3", [{ ...HANG, finding: "F1" }]));
    const ledger = findingLedger(evidence);
    expect(states(evidence)).toEqual({ F1: "pending@d3" });
    expect(ledger.findings[0]!.regressedOn).toBe("d3");
    expect(ledger.passes.at(-1)!.raised).toEqual(["F1"]);
    expect(roundSummary(ledger, "d3", [ledger.passes.at(-1)!])).toContain("1 regression(s)");
  });

  it("carries a regression's current occurrence, not the original one it was first raised with", () => {
    const original = { path: "pkg/timestamp/old.go", start_line: 10, end_line: 10, category: "bug", severity: "high", content: "Close waits forever." };
    const regression = { ...original, path: "pkg/timestamp/new.go", start_line: 55, end_line: 55, content: "Close does not honour cancellation." };
    const evidence = [pass("d1", [original]), confirm("d1"), pass("d2", [], { F1: "resolved" }), pass("d3", [{ ...regression, finding: "F1" }])];
    const ledger = findingLedger(evidence);
    const f1 = findingById(ledger, "F1")!;
    expect(f1.comment).toMatchObject({ path: "pkg/timestamp/new.go", start_line: 55, content: "Close does not honour cancellation." });
    expect(f1.original).toMatchObject({ path: "pkg/timestamp/old.go", start_line: 10 });
    expect(describeFinding(f1)).toContain("pkg/timestamp/new.go:55");
    expect(describeFinding(f1)).not.toContain("pkg/timestamp/old.go");
    const instruction = verificationInstruction(PROFILE, { findings: toVerify(ledger, "d3"), background: "bg", changed: [] });
    expect(instruction).toContain("pkg/timestamp/new.go:55");
    expect(instruction).not.toContain("pkg/timestamp/old.go");
  });

  it("carries a dismissed finding's current occurrence when it is raised again at a new location", () => {
    const original = { path: "pkg/timestamp/old.go", start_line: 10, end_line: 10, category: "bug", severity: "high", content: "Close waits forever." };
    const dismissed = [pass("d1", [original]), verify("d1", { finding: "F1", verdict: "refuted", reason: "bounded", quotes: [BOUNDED] }), file("d1", SCHEDULER)];
    expect(states(dismissed)).toEqual({ F1: "dismissed@d1" });
    const regression = { ...original, path: "pkg/timestamp/new.go", start_line: 55, end_line: 55, content: "A new call path reaches the same hang." };
    const raisedAgain = [...dismissed, pass("d2", [{ ...regression, finding: "F1" }])];
    const ledger = findingLedger(raisedAgain);
    const f1 = findingById(ledger, "F1")!;
    expect(f1.comment).toMatchObject({ path: "pkg/timestamp/new.go", start_line: 55 });
    expect(f1.original).toMatchObject({ path: "pkg/timestamp/old.go", start_line: 10 });
  });

  it("sends a withdrawn confirmation back to verification, and leaves a pass that skips a status incomplete", () => {
    const evidence = [pass("d1", [HANG]), confirm("d1"), pass("d1", [], { F1: "withdrawn" })];
    expect(states(evidence)).toEqual({ F1: "pending@d1" });
    evidence.push(confirm("d1"), pass("d2", []));
    const last = findingLedger(evidence).passes.at(-1)!;
    expect(last.missingStatus).toEqual(["F1"]);
    expect(states(evidence)).toEqual({ F1: "confirmed@d1" });
  });

  it("reads a comment that names an open finding as its status, and one naming an unknown finding as new", () => {
    const evidence = [pass("d1", [HANG, { ...HANG, severity: "medium", content: "naming" }]), confirm("d1"), pass("d1", [{ ...HANG, finding: "F1" }, { ...HANG, start_line: 200, end_line: 210, finding: "F9" }])];
    const ledger = findingLedger(evidence);
    expect(states(evidence)).toEqual({ F1: "confirmed@d1", F2: "pending@d1" });
    expect(ledger.passes[1]!.missingStatus).toEqual([]);
    expect(ledger.passes[1]!.raised).toEqual(["F2"]);
  });

  it("keeps a dismissal while its quoted lines match a later change, and reopens it when they break", () => {
    const dismissed = [pass("d1", [HANG]), verify("d1", { finding: "F1", verdict: "refuted", reason: "bounded", quotes: [BOUNDED] }), file("d1", SCHEDULER)];
    expect(states(dismissed)).toEqual({ F1: "dismissed@d1" });
    const raisedAgain = [...dismissed, pass("d2", [{ ...HANG, finding: "F1" }])];
    const waiting = findingLedger(raisedAgain);
    expect(states(raisedAgain)).toEqual({ F1: "pending@d2" });
    expect(pathsToObserve(waiting, "d2")).toEqual(["pkg/timestamp/scheduler.go"]);
    expect(states([...raisedAgain, file("d2", SCHEDULER)])).toEqual({ F1: "dismissed@d1" });
    const broken = [...raisedAgain, file("d2", SCHEDULER.replace("s.closeTimeout", "0"))];
    expect(states(broken)).toEqual({ F1: "pending@d2" });
    expect(findingLedger(broken).findings[0]!.awaiting).toBeUndefined();
  });

  it("disputes a finding on conflicting verdicts, a missing verdict, a failed verifier or a confirmation without a witness", () => {
    const two = pass("d1", [HANG, { ...HANG, start_line: 120 }]);
    expect(states([two, verify("d1", { finding: "F1", verdict: "confirmed", quotes: [BOUNDED] }, { finding: "F1", verdict: "refuted", quotes: [BOUNDED] })])).toEqual({ F1: "disputed@d1", F2: "disputed@d1" });
    expect(states([two, agent("diagnostic", "d1", null, "failed")])).toEqual({ F1: "disputed@d1", F2: "disputed@d1" });
    expect(states([two, verify("d1", { finding: "F1", verdict: "confirmed" }, { finding: "F2", verdict: "refuted" })])).toEqual({ F1: "disputed@d1", F2: "disputed@d1" });
    const ledger = findingLedger([two, verify("d1")]);
    expect(ledger.findings[0]!.dispute).toBe("the verifier gave no verdict");
  });

  it("keeps the reviewer's latest still-present reason and leads with it once the code has moved on (run 4c70ff66-dd9)", () => {
    // Trimmed from run 4c70ff66-dd9: F1 was raised and confirmed against
    // loop.ts:483 on e98132c9; the gen-7 review pass (ev-g7-124) and later
    // ones kept it still_present with a new reason naming other code.
    const raised = { path: "packages/controller/src/loop.ts", start_line: 483, end_line: 483, category: "bug", severity: "high", content: "createSupervisorInspection is built without a signal, so inspection calls outlive the turn." };
    const confirmed = verify("e98132c9", {
      finding: "F1",
      verdict: "confirmed",
      reason: "loop.ts builds the inspection without the turn's signal.",
      quotes: [{ path: "packages/controller/src/loop.ts", line: 483, text: "const inspection = createSupervisorInspection({ state: () => state });" }],
    });
    const LIVE_NOTE =
      "Partially fixed: composed signals and raceAbort bound caller waiting, but checkValidate discards the signal (inspection.ts:143-147), and candidateChange launches Git without cancellation or timeout (worktree.ts:144-148). Aborted work can continue and retain resources.";
    const stillPresent = agent("review", "285e2902", { comments: [], prior: [{ finding: "F1", status: "still_present", reason: LIVE_NOTE }], summary: SUMMARY });
    const evidence = [pass("e98132c9", [raised]), confirmed, stillPresent];
    const f1 = findingById(findingLedger(evidence), "F1")!;
    expect(f1).toMatchObject({ state: "confirmed", verifiedOn: "e98132c9", note: { status: "still_present", reason: LIVE_NOTE, digest: "285e2902", ref: stillPresent.ref } });
    const text = describeFinding(f1, "285e2902");
    expect(text.startsWith(`I1 Reviewer, latest pass on the current candidate (${stillPresent.ref}): still present — ${LIVE_NOTE}`)).toBe(true);
    expect(text).toContain("inspection.ts:143-147");
    expect(text).toContain("Background, the original report (it describes an earlier revision, candidate e98132c9;");
    expect(text.indexOf("inspection.ts:143-147")).toBeLessThan(text.indexOf("loop.ts:483"));
    // Read on a later candidate, the note says it predates that change.
    expect(describeFinding(f1, "9f00aa11")).toContain("Reviewer, latest pass on candidate 285e2902, before your latest change");
    // A resolved status ends the lead: the finding is fixed and its note no longer applies.
    const fixed = findingById(findingLedger([...evidence, agent("review", "9f00aa11", { comments: [], prior: [{ finding: "F1", status: "resolved", reason: "signal passed" }], summary: SUMMARY })]), "F1")!;
    expect(fixed.state).toBe("fixed");
    expect(describeFinding(fixed)).not.toContain("Reviewer, latest pass");
  });

  it("matches a quote within three lines with whitespace collapsed, and observes only safe file paths", () => {
    expect(quoteMatches({ ...BOUNDED, line: 8, text: "ctx,  done :=\tcontext.WithTimeout(context.Background(), s.closeTimeout)" }, SCHEDULER)).toBe(true);
    expect(quoteMatches({ ...BOUNDED, line: 9 }, SCHEDULER)).toBe(false);
    expect(quoteMatches({ ...BOUNDED, text: "done()" }, SCHEDULER)).toBe(false);
    expect(["pkg/timestamp/scheduler.go", ".golangci.yml", "banyand/Makefile.inc"].every(observablePath)).toBe(true);
    for (const p of ["../x.go", "/etc/passwd", "pkg/./x.go", ".git/config", "pkg/timestamp", ".github", "pkg//x.go", "a b.go"]) expect(observablePath(p), p).toBe(false);
  });
});

describe("review discovery rounds", () => {
  const defect = (line: number) => ({ ...HANG, start_line: line, end_line: line, content: `defect at ${line}` });
  const verifyRound = /This is review round \d+, a verification round/;

  it("raises new findings for three rounds, then only verifies the known ones and lists new comments as follow-ups", () => {
    const { decision, jobs, issuesFile, issuesMarkdown } = simulate({
      reenter: 4,
      codeReviews: [
        // Round 1 (d1): F1, verified, and a sweep pass that finds nothing more.
        reviewed([defect(1)]),
        priorPass({ F1: "still_present" }),
        // Round 2 (d2): F1 fixed, F2 new.
        priorPass({ F1: "resolved" }, [defect(2)]),
        priorPass({ F2: "still_present" }),
        // Round 3 (d3): F2 fixed, F3 new.
        priorPass({ F2: "resolved" }, [defect(3)]),
        priorPass({ F3: "still_present" }),
        // Round 4 (d4): verification only. F3 is still there; the new high comment is a follow-up.
        priorPass({ F3: "still_present" }, [defect(4)]),
        // Round 5 (d5): F3 fixed, another new comment kept as a follow-up.
        priorPass({ F3: "resolved" }, [defect(5)]),
      ],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const passes = jobs.filter((j) => j.stageId === "review" && j.purpose === "review");
    // Two passes (a pass and its sweep) in each discovery round, one in each verification round.
    expect(passes).toHaveLength(8);
    for (const p of passes.slice(0, 6)) expect(assignment(p)).not.toMatch(verifyRound);
    expect(assignment(passes[6])).toContain(`This is review round 4, a verification round. The first ${MAX_DISCOVERY_ROUNDS} rounds`);
    expect(assignment(passes[6])).toContain("do not look for new issues and do not raise new findings");
    expect(assignment(passes[6])).toContain("- I3 (open) pkg/timestamp/scheduler.go:3 (high, bug): defect at 3");
    expect(assignment(passes[6])).not.toContain("An earlier pass on this same change");
    expect(assignment(passes[6])).not.toContain("Extra rule for");
    expect(assignment(passes[5])).toContain("Extra rule for");
    expect(assignment(passes[7])).toContain("This is review round 5, a verification round");
    // Only the discovery rounds' findings went to the verifier.
    const verifications = jobs.filter((j) => j.stageId === "review" && j.purpose === "diagnostic" && j.kind === "agent");
    expect(verifications.map((j) => [...assignment(j).matchAll(/^- (F\d+) /gm)].map((m) => m[1]))).toEqual([["F1"], ["F2"], ["F3"]]);
    // F3, still present in round 4, went back to Fix with the reviewer's latest note.
    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(5);
    expect(assignment(work[4])).toMatch(/I3 \[open\] Reviewer, latest pass on the current candidate \(ev-\d+\): still present — F3 is still_present\./);
    expect(assignment(work[4])).not.toContain("defect at 4");
    const { body } = deliverArgs(jobs);
    expect(body).toContain("no critical or high finding left open (3 fixed during review); 2 critical or high comment(s) raised after the 3 discovery rounds, listed as follow-ups.");
    expect(body).toContain("## Follow-ups");
    expect(body).toContain("- Code review: pkg/timestamp/scheduler.go:4 (high, bug): defect at 4 (raised in review round 4, after the 3 discovery rounds; not verified or fixed in this change)");
    expect(body).toContain("- Code review: pkg/timestamp/scheduler.go:5 (high, bug): defect at 5 (raised in review round 5");
    // The reviewer cannot add an issue in a verification round: the issues file holds the discovery rounds' three, all done.
    const file = JSON.parse(issuesFile!) as { issues: Array<{ id: string; status: string; round: number }> };
    expect(file.issues.map((i) => `${i.id}:${i.status}:r${i.round}`)).toEqual(["I1:done:r1", "I2:done:r2", "I3:done:r3"]);
    expect(issuesMarkdown).toContain("## Follow-ups");
    expect(issuesMarkdown).toContain("defect at 4");
    expect(body).toContain("## Review issues");
    expect(body).not.toMatch(/\| I4 /);
  });

  it("hands a known finding still present in a verification round to the supervisor, without a sweep or a verifier", () => {
    const { decision, jobs } = simulate({
      reenter: 3,
      codeReviews: [
        reviewed([defect(1)]),
        priorPass({ F1: "still_present" }),
        priorPass({ F1: "still_present" }),
        priorPass({ F1: "still_present" }),
        priorPass({ F1: "still_present" }, [defect(9), { ...defect(10), severity: "critical" }]),
      ],
    });
    expect(decision.action).toMatchObject({ type: "supervise" });
    const reason = (decision.action as { supervise: { reason: string } }).supervise.reason;
    expect(reason).toContain("1 critical or high finding(s) confirmed or disputed: I1 ");
    expect(reason).toContain("review round 4 (verify-only after 3 discovery rounds); passes on this change: 1");
    expect(reason).toContain("2 new comment(s) kept as follow-ups");
    expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "review")).toHaveLength(5);
    expect(jobs.filter((j) => j.stageId === "review" && j.purpose === "diagnostic" && j.kind === "agent")).toHaveLength(1);
  });

  describe("round counting", () => {
    let n = 0;
    const pass = (digest: string, comments: Array<Record<string, unknown>> = [], statuses: Record<string, string> = {}, generation = 1): EvidenceRecord => ({
      ref: `rr-${++n}`,
      kind: "other",
      generation,
      candidateDigest: digest,
      payload: {
        codingAgent: { status: "completed", output: priorPass(statuses, comments).output },
        producer: { operationId: `op-${n}`, stageId: "review", purpose: "review", readOnly: true, kind: "agent", executorId: "graphloom.coding-agent/run" },
      },
    });

    it("groups the sweep's passes on one candidate into one round, and never moves a round back", () => {
      const evidence = [pass("d1"), pass("d1"), pass("d1"), pass("d2"), pass("d3"), pass("d3"), pass("d4"), pass("d2")];
      const ledger = findingLedger(evidence);
      expect(ledger.passes.map((p) => p.round)).toEqual([1, 1, 1, 2, 3, 3, 4, 4]);
      expect(reviewRound(ledger, "d2")).toBe(4);
      expect(reviewRound(ledger, "d5")).toBe(5);
      expect([3, 4].map(verifyOnly)).toEqual([false, true]);
      expect(reviewPhase(ledger, "d4")).toEqual({ round: 4, phase: "verify-only" });
      expect(reviewPhase(findingLedger(evidence.slice(0, 6)), "d3")).toEqual({ round: 3, phase: "discovery" });
    });

    it("counts rounds from evidence alone, so a resume or a validator's history view sees the same round", () => {
      const evidence = [pass("d1", [defect(1)]), pass("d2", [], { F1: "resolved" }), pass("d3"), pass("d4", [defect(4)], {}, 7), pass("d4", [defect(5)], {}, 9)];
      const ledger = findingLedger(evidence);
      expect(ledger.findings.map((f) => f.id)).toEqual(["F1"]);
      expect(ledger.followUps.map((f) => [f.comment.content, f.round])).toEqual([["defect at 4", 4], ["defect at 5", 4]]);
      expect(ledger.passes.at(-1)!.raised).toEqual([]);
      // The validator reads other candidates as history and only the latest pass on the current one.
      const validatorView = findingLedger([...evidence.slice(0, 3), evidence[4]!]);
      expect(validatorView.passes.at(-1)!.round).toBe(4);
      expect(validatorView.followUps.map((f) => f.comment.content)).toEqual(["defect at 5"]);
    });

    it("agrees with the validator on round and phase when the run returns to an earlier candidate", () => {
      // Codex review of #135: the controller shows the validator the other
      // candidates as history first, and only the latest pass on the current one.
      const reviewPass = (digest: string, generation: number, comments: Array<Record<string, unknown>> = []): EvidenceRecord => ({ ...pass(digest, comments, {}, generation), kind: "review" });
      const work = (digest: string, generation: number): EvidenceRecord => ({
        ref: `rw-${++n}`,
        kind: "other",
        generation,
        candidateDigest: digest,
        payload: { codingAgent: { status: "completed", output: {} }, producer: { operationId: `op-${n}`, stageId: "fix", purpose: "work", readOnly: false, kind: "agent", executorId: "graphloom.coding-agent/run" } },
      });
      const evidence = [
        work("d1", 1), reviewPass("d1", 1),
        work("d2", 2), reviewPass("d2", 2),
        work("d3", 3), reviewPass("d3", 3),
        work("d4", 4), reviewPass("d4", 4, [defect(4)]),
        work("d1", 5), reviewPass("d1", 5),
      ];
      const graph = findingLedger(evidence);
      const history = evidence.filter((e) => e.candidateDigest !== "d1");
      const current = [...evidence.filter((e) => e.candidateDigest === "d1" && e.kind !== "review"), evidence.at(-1)!];
      const validator = findingLedger([...history, ...current]);
      for (const ledger of [graph, validator]) {
        expect(ledger.findings).toEqual([]);
        expect(ledger.followUps.map((f) => [f.comment.content, f.round])).toEqual([["defect at 4", 4]]);
        expect(ledger.passes.at(-1)!.round).toBe(4);
        expect(reviewPhase(ledger, "d1")).toEqual({ round: 4, phase: "verify-only" });
      }
      expect(graph.passes.filter((p) => p.digest === "d4").map((p) => p.round)).toEqual(validator.passes.filter((p) => p.digest === "d4").map((p) => p.round));
      const result = validatorById("open-code-review")!.evaluate({ requirementId: "code-review", statement: "s", evidence: current, history, candidateDigest: "d1" }) as { status: string; reason: string };
      expect(result.status).toBe("passed");
    });

    it("still reopens a fixed finding the reviewer names again in a verification round", () => {
      const evidence = [pass("d1", [defect(1)]), pass("d2", [], { F1: "resolved" }), pass("d3"), pass("d4", [{ ...defect(1), finding: "F1" }])];
      const ledger = findingLedger(evidence);
      expect(ledger.findings[0]).toMatchObject({ id: "F1", state: "pending", regressedOn: "d4" });
      expect(ledger.followUps).toEqual([]);
    });
  });

  it("passes the code review requirement in a verification round that raises only new comments", () => {
    let n = 0;
    const pass = (digest: string, comments: Array<Record<string, unknown>> = []): EvidenceRecord => ({
      ref: `rv-${++n}`,
      kind: "review",
      generation: 1,
      candidateDigest: digest,
      payload: {
        codingAgent: { status: "completed", output: priorPass({}, comments).output },
        producer: { operationId: `op-${n}`, stageId: "review", purpose: "review", readOnly: true, kind: "agent", executorId: "graphloom.coding-agent/run" },
      },
    });
    const history = [pass("d1"), pass("d2"), pass("d3")];
    const evaluate = (current: EvidenceRecord[], earlier: EvidenceRecord[], digest: string) =>
      validatorById("open-code-review")!.evaluate({ requirementId: "code-review", statement: "s", evidence: current, history: earlier, candidateDigest: digest }) as { status: string; reason: string };
    const later = evaluate([pass("d4", [defect(4)])], history, "d4");
    expect(later.status).toBe("passed");
    expect(later.reason).toContain("1 follow-up(s) raised after the discovery rounds");
    // The same comment in round 3 is a finding and must be verified first.
    expect(evaluate([pass("d3", [defect(4)])], history.slice(0, 2), "d3").status).toBe("inconclusive");
  });
});

describe("the issues file", () => {
  interface FileIssue {
    id: string;
    severity: string;
    status: string;
    round: number;
    location: { path: string; startLine: number; endLine: number };
    history: Array<{ actor: string; from: string | null; to: string; note: string; round: number; candidate: string; evidence: string }>;
  }
  const parse = (text: string | undefined) => JSON.parse(text!) as { schema: string; issues: FileIssue[] };
  /** The fixer's edit: mark `id` fixed with a note, as the protocol asks. */
  const markFixed = (id: string, note: string) => (file: string | undefined) => {
    const f = parse(file);
    const i = f.issues.find((x) => x.id === id)!;
    i.history.push({ actor: "fixer", from: i.status, to: "fixed", note } as FileIssue["history"][number]);
    i.status = "fixed";
    return JSON.stringify(f, null, 2);
  };
  const setStatus = (id: string, status: string) => (file: string | undefined) => {
    const f = parse(file);
    f.issues.find((x) => x.id === id)!.status = status;
    return JSON.stringify(f);
  };
  const FIX_NOTE = "Close now waits with s.closeTimeout (pkg/timestamp/scheduler.go:5).";
  const REOPEN_NOTE = "Close bounds its wait, but trigger still blocks on the action (pkg/timestamp/scheduler.go:101-104).";
  const commandIds = (job: JobSpec) => (job.input as { commands?: Array<{ id: string }> }).commands?.map((c) => c.id) ?? [];
  const writtenBefore = (jobs: JobSpec[], job: JobSpec) => {
    const write = jobs.slice(0, jobs.indexOf(job)).filter((j) => commandIds(j).includes("issues-write")).at(-1)!;
    return parse(writtenJson((write.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv));
  };

  it("tracks a high finding from the reviewer's report to done: verified open, marked fixed by the fixer, verified done by the reviewer, listed in the pull request", () => {
    const { decision, jobs, evidence, issuesFile, issuesMarkdown } = simulate({
      reenter: 1,
      codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" }), notedPass("I1", "resolved", "Close bounds its wait now (pkg/timestamp/scheduler.go:5).")],
      fixerEdits: [undefined, markFixed("I1", FIX_NOTE)],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const issueJobs = jobs.filter((j) => commandIds(j).some((id) => id.startsWith("issues-")));
    // The first review round wrote no file; the fixer got it before its second pass, and the graph read it back after.
    expect(issueJobs.map((j) => `${j.stageId}:${commandIds(j)[0]}`)).toEqual(["review:issues-write", "fix:issues-write", "fix:issues-read", "review:issues-write", "review:issues-write"]);
    for (const j of issueJobs) expect(j).toMatchObject({ kind: "command", readOnly: true, purpose: "diagnostic" });
    for (const j of issueJobs) expect(j.checkout).toBeUndefined();

    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(2);
    expect(assignment(work[0])).not.toContain(".graphloom/issues.json");
    const fixer = assignment(work[1]);
    expect(writtenBefore(jobs, work[1]!).issues.map((i) => `${i.id}:${i.status}`)).toEqual(["I1:open"]);
    expect(fixer).toContain("I1 [open] pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(fixer).toContain("They are the open, reopened and fixed issues in .graphloom/issues.json");
    expect(fixer).toContain('set its `status` to `fixed` and append to its `history` one entry {"actor": "fixer"');

    // The reviewer verifies the fixed issue by its id, with the fixer's note in front of it.
    const passes = jobs.filter((j) => j.purpose === "review" && j.stageId === "review");
    expect(assignment(passes[2])).toContain(`- I1 (fixed) pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever for an action that ignores cancellation. Fixer's note: ${FIX_NOTE}`);
    expect(assignment(passes[2])).toContain("tracked in `.graphloom/issues.json`");
    expect(assignment(passes[2])).toContain("do not edit them");

    const file = parse(issuesFile);
    expect(file.schema).toBe("graphloom-issues-v1");
    expect(file.issues).toHaveLength(1);
    const i1 = file.issues[0]!;
    expect(i1).toMatchObject({ id: "I1", severity: "P1", status: "done", round: 1, location: { path: "pkg/timestamp/scheduler.go", startLine: 88, endLine: 95 } });
    expect(i1.history.map((h) => `${h.actor}:${h.from}->${h.to}@r${h.round}`)).toEqual(["verifier:null->open@r1", "fixer:open->fixed@r2", "reviewer:fixed->done@r2"]);
    expect(i1.history[1]).toMatchObject({ note: FIX_NOTE, candidate: "d2" });
    expect(i1.history[2]!.note).toBe("Close bounds its wait now (pkg/timestamp/scheduler.go:5).");
    // Each event names the evidence it rests on.
    for (const h of i1.history) expect(evidence.some((e) => e.ref === h.evidence)).toBe(true);
    expect(issuesMarkdown).toContain("| I1 | P1 (high) | done | `pkg/timestamp/scheduler.go:88-95` |");

    const { body } = deliverArgs(jobs);
    expect(body).toContain("## Review issues");
    expect(body).toContain("| I1 | P1 (high) | done | `pkg/timestamp/scheduler.go:88-95` | Close now waits forever for an action that ignores cancellation. | reviewer: Close bounds its wait now");
    const deliver = jobs.find((j) => commandIds(j).includes(COMMAND.deliver))!;
    expect((deliver.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv[2]).toContain("git rm -r -q --cached --ignore-unmatch -- .graphloom");
  });

  it("reopens a fixed issue with the reviewer's note, hands that note to the fixer, and accepts the next fix", () => {
    const { decision, jobs, issuesFile } = simulate({
      reenter: 2,
      codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" }), notedPass("I1", "still_present", REOPEN_NOTE), notedPass("I1", "resolved", "trigger no longer blocks.")],
      fixerEdits: [undefined, markFixed("I1", "Bounded Close's wait."), markFixed("I1", "trigger now runs the action in its own goroutine (scheduler.go:101).")],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(3);
    expect(writtenBefore(jobs, work[2]!).issues.map((i) => `${i.id}:${i.status}`)).toEqual(["I1:reopened"]);
    const latest = assignment(work[2]);
    expect(latest).toMatch(/- I1 \[reopened\] Reviewer, latest pass on the current candidate \(ev-\d+\): still present — Close bounds its wait, but trigger still blocks/);
    expect(latest).toContain(REOPEN_NOTE);
    const i1 = parse(issuesFile).issues[0]!;
    expect(i1.status).toBe("done");
    expect(i1.history.map((h) => `${h.actor}:${h.from}->${h.to}`)).toEqual(["verifier:null->open", "fixer:open->fixed", "reviewer:fixed->reopened", "fixer:reopened->fixed", "reviewer:fixed->done"]);
    expect(i1.history[2]!.note).toBe(REOPEN_NOTE);
  });

  it("rejects the fixer marking an issue done, restores the file, tells the fixer, and still lets only the reviewer close it", () => {
    const { decision, jobs, issuesFile } = simulate({
      reenter: 2,
      codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" }), notedPass("I1", "still_present", REOPEN_NOTE), notedPass("I1", "resolved", "fixed now")],
      fixerEdits: [undefined, setStatus("I1", "done"), markFixed("I1", FIX_NOTE)],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    // The rejected edit was undone before the reviewer and the next fixer pass saw the file.
    const passes = jobs.filter((j) => j.purpose === "review" && j.stageId === "review");
    expect(writtenBefore(jobs, passes[2]!).issues.map((i) => `${i.id}:${i.status}`)).toEqual(["I1:open"]);
    expect(assignment(passes[2])).toContain("- I1 (open) ");
    expect(assignment(work[2])).toContain(
      "- .graphloom/issues.json: the graph rejected your edit and restored the file: the fixer moved I1 from open to done: only the code reviewer marks an issue done.",
    );
    const i1 = parse(issuesFile).issues[0]!;
    expect(i1.history.map((h) => `${h.actor}:${h.from}->${h.to}`)).toEqual(["verifier:null->open", "graph:open->open", "fixer:open->fixed", "reviewer:fixed->done"]);
    expect(i1.history[1]!.note).toContain("rejected the fixer's edit: the fixer moved I1 from open to done");
  });

  it("retries a failed read of the fixer's edits instead of writing over them, and keeps the edits it reads", () => {
    const { decision, jobs, issuesFile } = simulate({
      reenter: 1,
      failReads: 1,
      codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" }), notedPass("I1", "resolved", "bounded")],
      fixerEdits: [undefined, markFixed("I1", FIX_NOTE)],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    const after = jobs.slice(jobs.indexOf(work[1]!) + 1).filter((j) => commandIds(j).some((id) => id.startsWith("issues-")));
    // The failed read is retried before any write; nothing overwrote the fixer's edit unread.
    expect(after.slice(0, 3).map((j) => commandIds(j)[0])).toEqual(["issues-read", "issues-read", "issues-write"]);
    const i1 = parse(issuesFile).issues[0]!;
    expect(i1.history.map((h) => `${h.actor}:${h.from}->${h.to}`)).toEqual(["verifier:null->open", "fixer:open->fixed", "reviewer:fixed->done"]);
    expect(i1.history[1]!.note).toBe(FIX_NOTE);
  });

  it("hands an issues file it cannot read back to the supervisor, leaving the fixer's edit in place", () => {
    const { decision, jobs, issuesFile } = simulate({
      reenter: 1,
      failReads: 99,
      codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" })],
      fixerEdits: [undefined, markFixed("I1", FIX_NOTE)],
    });
    expect(decision.action).toMatchObject({ type: "supervise", supervise: { reason: expect.stringContaining("could not read .graphloom/issues.json back after the fixer's last run (2 failed reads)") } });
    const work = jobs.filter((j) => j.purpose === "work");
    const after = jobs.slice(jobs.indexOf(work[1]!) + 1);
    expect(after.map((j) => commandIds(j)[0])).toEqual(["issues-read", "issues-read"]);
    // The worktree still holds the fixer's edit: the graph never restored over it.
    expect(parse(issuesFile).issues[0]!).toMatchObject({ status: "fixed" });
  });

  it("records the fixed step itself when the fixer forgot to mark an issue the reviewer finds resolved", () => {
    const { decision, issuesFile } = simulate({ reenter: 1, codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" }), priorPass({ I1: "resolved" })] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const i1 = parse(issuesFile).issues[0]!;
    expect(i1.history.map((h) => `${h.actor}:${h.from}->${h.to}`)).toEqual(["verifier:null->open", "graph:open->fixed", "reviewer:fixed->done"]);
  });

  it("lists a refuted finding as dismissed", () => {
    const { decision, jobs, issuesFile } = simulate({
      codeReviews: [reviewed([HANG])],
      verifications: [verdicts({ finding: "F1", verdict: "refuted", reason: "Close bounds the wait with closeTimeout.", quotes: [BOUNDED] })],
      files: { "pkg/timestamp/scheduler.go": SCHEDULER },
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(parse(issuesFile).issues.map((i) => `${i.id}:${i.status}:${i.history[0]!.actor}`)).toEqual(["I1:dismissed:verifier"]);
    expect(deliverArgs(jobs).body).toContain("| I1 | P1 (high) | dismissed |");
  });

  it("restores the file from evidence before the next agent job after a resume, whatever the worktree holds", () => {
    const run = simulate({ codeReviews: [reviewed([HANG]), priorPass({ I1: "still_present" })] });
    expect(run.decision.action).toMatchObject({ type: "supervise" });
    const definition = createGraph().describe(BANYANDB);
    const receipts = run.receipts.filter((r) => r.stageId === "fix");
    const view = (generation: number, evidence: EvidenceRecord[]): RunView => ({
      runId: "run",
      task: { request: `Fix apache/skywalking#${ISSUE}.`, repo: "../skywalking-banyandb" },
      current: { stageId: "fix", attempt: 2 },
      receipts,
      evidence: structuredClone(evidence),
      outstanding: [],
      budgets: { agentInvocations: 8, jobs: 8, decisions: 8, corrections: 8 },
      validatorBindings: definition.defaultValidators,
      generation,
      stateRevision: 1,
      activeVersion: "issue-fix@0.4.0",
      config: BANYANDB,
      candidateDigest: "d1",
      openAttempt: { fix: true },
    });
    // Resumed into a reentered Fix at a new generation: the file is written, from evidence, before the implementer runs.
    const resumed = advanceFix(view(5, run.evidence));
    expect(resumed.action).toMatchObject({ type: "dispatch", job: { kind: "command", readOnly: true } });
    const job = (resumed.action as { job: JobSpec }).job;
    expect(commandIds(job)).toEqual(["issues-write"]);
    const json = writtenJson((job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv)!;
    expect(parse(json).issues.map((i) => `${i.id}:${i.status}`)).toEqual(["I1:open"]);
    expect(resumed.reason).toContain("restore the review issues file from evidence after a resume or reentry");
    // The same evidence always gives the same file, so a replay restores it byte for byte.
    const again = advanceFix(view(6, run.evidence));
    expect(writtenJson(((again.action as { job: JobSpec }).job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv)).toBe(json);
    // Once written in this generation, the implementer runs next.
    const written: EvidenceRecord = {
      ref: "ev-written",
      kind: "command",
      generation: 5,
      candidateDigest: "d1",
      payload: { command: { id: "issues-write", argv: (job.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv, exitCode: 0, stdoutTail: "written\n", stderrTail: "" }, producer: { operationId: "op-w", stageId: "fix", purpose: "diagnostic", readOnly: true, kind: "command" } },
    };
    expect(advanceFix(view(5, [...run.evidence, written])).action).toMatchObject({ type: "dispatch", job: { purpose: "work" } });
  });
});

describe("qualification", () => {
  it("the installed validators pass every case", () => {
    const report = qualifyValidators(validatorById);
    expect(report.candidateMismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(QUALIFICATION_CASES.length).toBeGreaterThan(30);
  });

  it("rejects a candidate that always passes, and requires the old version to reproduce a defect", () => {
    const lenient: Validator = { evaluate: () => ({ status: "passed", reason: "ok" }) };
    const report = qualifyValidators((id) => (id === "build-checks" ? lenient : validatorById(id)));
    expect(report.ok).toBe(false);
    expect(report.candidateMismatches.some((m) => m.startsWith("build-checks: lint fails"))).toBe(true);

    const fixed = qualifyValidators(validatorById, (id) => (id === "build-checks" ? lenient : validatorById(id)));
    expect(fixed.ok).toBe(true);
    expect(qualifyValidators(validatorById, validatorById).ok).toBe(false);
  });
});

describe("acceptance coverage before code review (#183)", () => {
  const SRC = "pkg/timestamp/scheduler.go";
  const SRC_TEST = "pkg/timestamp/scheduler_test.go";
  const ITEMS = [
    { id: "A1", text: "A running action is not reported as timed out." },
    { id: "A2", text: "The action's real outcome is logged when it ends." },
  ];
  const PLANNED: DecisionRecord = { ...PLAN, acceptance: ITEMS };
  const COVERED: DecisionRecord = {
    ...PLANNED,
    coverage: [
      { id: "A1", files: [SRC], tests: [{ file: SRC_TEST, name: TEST }] },
      { id: "A2", files: [SRC], tests: [{ file: SRC_TEST, name: "TestSchedulerLogsOutcome" }] },
    ],
  };
  const FILES = { [SRC]: "package timestamp\n", [SRC_TEST]: `func ${TEST}(t *testing.T) {}\nfunc TestSchedulerLogsOutcome(t *testing.T) {}\n` };
  const implementerJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.jobId === "implementer" && j.purpose === "work");
  const reviewJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "review" && j.purpose === "review");

  it("sends an implementer record that skips an item back before code review, naming the item", () => {
    const partial: DecisionRecord = { ...PLANNED, coverage: [COVERED.coverage![0]!] };
    const { decision, jobs, observed } = simulate({ plans: [PLANNED], implement: [partial, COVERED], files: FILES });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = implementerJobs(jobs);
    expect(work).toHaveLength(2);
    expect(assignment(work[1])).toContain("acceptance-coverage");
    expect(assignment(work[1])).toContain("A2 (The action's real outcome is logged when it ends.) has no entry in the record's coverage");
    expect(assignment(work[1])).not.toContain("A1 (A running");
    expect(observed).toEqual(expect.arrayContaining([SRC, SRC_TEST]));
    // The correction came first: no review job precedes the second implementer pass.
    expect(jobs.indexOf(reviewJobs(jobs)[0]!)).toBeGreaterThan(jobs.indexOf(work[1]!));
  });

  it("sends a record that names a file, or a test file, the change does not have back before code review", () => {
    const noFile: DecisionRecord = { ...COVERED, coverage: [{ ...COVERED.coverage![0]!, files: ["pkg/timestamp/missing.go"] }, COVERED.coverage![1]!] };
    const first = simulate({ plans: [PLANNED], implement: [noFile, COVERED], files: { ...FILES, "pkg/timestamp/missing.go": null } });
    expect(first.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(assignment(implementerJobs(first.jobs)[1])).toContain("file pkg/timestamp/missing.go does not exist in the change");
    const noTestFile: DecisionRecord = { ...COVERED, coverage: [{ ...COVERED.coverage![0]!, tests: [{ file: "pkg/timestamp/nope_test.go", name: TEST }] }, COVERED.coverage![1]!] };
    const second = simulate({ plans: [PLANNED], implement: [noTestFile, COVERED], files: { ...FILES, "pkg/timestamp/nope_test.go": null } });
    expect(assignment(implementerJobs(second.jobs)[1])).toContain("test file pkg/timestamp/nope_test.go does not exist in the change");
    expect(reviewJobs(second.jobs).length).toBeGreaterThan(0);
  });

  it("sends a record whose test title is not in its file, or has no title, back before code review", () => {
    const wrongName: DecisionRecord = { ...COVERED, coverage: [COVERED.coverage![0]!, { ...COVERED.coverage![1]!, tests: [{ file: SRC_TEST, name: "TestNeverWritten" }] }] };
    const { jobs } = simulate({ plans: [PLANNED], implement: [wrongName, COVERED], files: FILES });
    expect(assignment(implementerJobs(jobs)[1])).toContain(`test "TestNeverWritten" does not appear in ${SRC_TEST}`);
    const empty: DecisionRecord = { ...COVERED, coverage: [{ id: "A1", files: [], tests: [] }, COVERED.coverage![1]!] };
    expect(assignment(implementerJobs(simulate({ plans: [PLANNED], implement: [empty, COVERED], files: FILES }).jobs)[1])).toContain("A1 (A running action is not reported as timed out.) names no file and no test");
  });

  it("dispatches review for a complete record, with the acceptance list and the coverage map", () => {
    const { decision, jobs } = simulate({ plans: [PLANNED], implement: [COVERED], files: FILES });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(implementerJobs(jobs)).toHaveLength(1);
    const text = assignment(reviewJobs(jobs)[0]);
    expect(text).toContain("The issue's acceptance items, and where the implementer says each is implemented and tested");
    expect(text).toContain(`- A1: A running action is not reported as timed out. (files: ${SRC}; tests: ${SRC_TEST}: ${TEST})`);
    expect(text).toContain("- A2: The action's real outcome is logged when it ends.");
    // The implementer was told the list and what it owes.
    expect(assignment(implementerJobs(jobs)[0])).toContain("The record's acceptance lists 2 item(s): A1, A2");
  });

  it("runs as before for a plan without an acceptance list: no check, no observation, no acceptance block", () => {
    const { decision, jobs, observed } = simulate({ files: FILES });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(implementerJobs(jobs)).toHaveLength(1);
    expect(observed).toEqual([CHANGES_PATH]);
    expect(assignment(reviewJobs(jobs)[0])).not.toContain("acceptance items");
    expect(assignment(implementerJobs(jobs)[0])).not.toContain("acceptance lists");
  });

  it("counts the correction against the normal budget and hands a persistent gap to the supervisor, never reviewing", () => {
    const { decision, jobs } = simulate({ plans: [PLANNED], implement: [PLANNED, PLANNED, PLANNED], files: FILES });
    expect(decision.action.type).toBe("supervise");
    expect(implementerJobs(jobs)).toHaveLength(3);
    expect(reviewJobs(jobs)).toHaveLength(0);
    expect(decision.reason).toContain("hand the unresolved acceptance coverage to the supervisor");
  });

  it("keeps the planner's list when the implementer's record drops it, and reads the contract as additive", () => {
    const { acceptance: _planned, ...dropped } = COVERED;
    const { decision, jobs } = simulate({ plans: [PLANNED], implement: [dropped], files: FILES });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(implementerJobs(jobs)).toHaveLength(1);
    const schema = JSON.parse(DECISION_RECORD_SCHEMA) as { required: string[]; properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["acceptance", "coverage"]));
    // Additive: neither is required, so a record from before 0.10.0 still parses and runs.
    expect(schema.required).not.toContain("acceptance");
    expect(schema.required).not.toContain("coverage");
    expect(parseDecisionRecord(JSON.stringify(PLAN))).toHaveProperty("record");
    expect(acceptanceItems(PLAN)).toEqual([]);
  });
});

describe("context documents (#195)", () => {
  const DESIGN = "# Relational design\n\nA join keeps duplicate matches.\n";
  const TICKETS = "# Tickets\n\nR01 is a bounded INNER JOIN.\n";
  const LOCAL = "# Local contract\n\nThe change documents its grammar.\n";
  const withContext = (context: unknown[]): unknown => {
    const profile = structuredClone(BANYANDB) as { issues: Record<string, unknown> };
    profile.issues.context = context;
    return profile;
  };
  const CROSS = withContext([
    { repo: "acme/private-design", path: "docs/relational-design.md", ref: "main" },
    { repo: "acme/private-design", path: "docs/relational-tickets.md" },
  ]);
  const SERVED = { "acme/private-design:docs/relational-design.md": DESIGN, "acme/private-design:docs/relational-tickets.md": TICKETS };
  const getFiles = (jobs: JobSpec[]) => jobs.filter((j) => j.executor?.id === "graphloom.github/get-file");
  const agents = (jobs: JobSpec[], purpose: string, stage: string) => jobs.filter((j) => j.kind === "agent" && j.purpose === purpose && j.stageId === stage);

  it("reads a cross-repository context once, in Fix, before any agent, and gives both documents to the planner, the implementer and the reviewer", () => {
    const { decision, jobs, evidence } = simulate({ profile: CROSS, contextFiles: SERVED });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    // One read job per document, read-only, in the profile's order, after the issue and its comments and before the plan.
    const reads = getFiles(jobs);
    expect(reads.map((j) => j.input)).toEqual([
      { owner: "acme", repo: "private-design", path: "docs/relational-design.md", ref: "main" },
      { owner: "acme", repo: "private-design", path: "docs/relational-tickets.md" },
    ]);
    for (const read of reads) expect(read).toMatchObject({ stageId: "fix", kind: "command", purpose: "diagnostic", readOnly: true });
    const firstAgent = jobs.findIndex((j) => j.kind === "agent");
    expect(jobs.indexOf(reads[1]!)).toBeLessThan(firstAgent);
    // The documents are evidence, with the blob sha and size the executor reported.
    const item = (evidence.find((e) => (e.payload as { github?: { operation?: string } }).github?.operation === "get-file")!.payload as { github: { item: Record<string, unknown> } }).github.item;
    expect(item).toMatchObject({ found: true, path: "docs/relational-design.md", size: Buffer.byteLength(DESIGN) });

    const plan = assignment(agents(jobs, "diagnostic", "fix")[0]);
    const work = assignment(agents(jobs, "work", "fix")[0]);
    const review = assignment(agents(jobs, "review", "review")[0]);
    for (const [who, text] of [["planner", plan], ["implementer", work], ["reviewer", review]] as const) {
      expect(text, who).toContain("## Context document: acme/private-design:docs/relational-design.md@main (");
      expect(text, who).toContain(DESIGN.trim());
      expect(text, who).toContain("## Context document: acme/private-design:docs/relational-tickets.md (");
      expect(text, who).toContain(TICKETS.trim());
    }
    // The planner may cite them in its acceptance items.
    expect(plan).toContain("an item's text may cite the document by its name");
    // The issue snapshot still comes first, and the planner is told whose authority wins.
    expect(plan.indexOf("Issue snapshot")).toBeLessThan(plan.indexOf("## Context document"));
    expect(plan).toContain("the issue's own acceptance criteria and maintainer comments still come first");
  });

  it("reads a document of the target repository from the worktree, once, and keeps the first reading when the file changes", () => {
    const profile = withContext([{ path: "docs/local.md" }]);
    const { decision, jobs, observed } = simulate({ profile, files: { "docs/local.md": LOCAL } });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(getFiles(jobs)).toEqual([]);
    expect(observed.filter((p) => p === "docs/local.md")).toHaveLength(1);
    expect(assignment(agents(jobs, "diagnostic", "fix")[0])).toContain(`## Context document: docs/local.md (`);
    expect(assignment(agents(jobs, "review", "review")[0])).toContain(LOCAL.trim());

    // A later observation of the same path (the implementer's own edit) never replaces the pinned one.
    const before: EvidenceRecord = { ref: "e1", kind: "file", generation: 1, candidateDigest: "d0", fingerprint: "a".repeat(64), payload: { path: "docs/local.md", bytes: LOCAL } };
    const after: EvidenceRecord = { ref: "e2", kind: "file", generation: 2, candidateDigest: "d1", fingerprint: "b".repeat(64), payload: { path: "docs/local.md", bytes: "# Edited\n" } };
    expect(readContext([before, after], { path: "docs/local.md" })).toMatchObject({ kind: "read", doc: { text: LOCAL, digest: "a".repeat(64), bytes: Buffer.byteLength(LOCAL) } });
  });

  it("does not read the documents again after a resume or a reentry", () => {
    const resumed = simulate({ profile: CROSS, contextFiles: SERVED, resumeAfterCandidate: 1 });
    expect(resumed.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(getFiles(resumed.jobs)).toHaveLength(2);
    const afterFix = simulate({ profile: CROSS, contextFiles: SERVED, resumeAfterFix: true });
    expect(getFiles(afterFix.jobs)).toHaveLength(2);
    // The pinned documents also reach a correction pass after the graph sends Fix back.
    const finding = { path: "pkg/timestamp/scheduler.go", start_line: 88, end_line: 95, category: "bug", severity: "high", content: "Close now waits forever for an action that ignores cancellation." };
    const back = simulate({ profile: CROSS, contextFiles: SERVED, graphReenters: {}, codeReviews: [reviewed([finding]), priorPass({ F1: "still_present" }), priorPass({ F1: "resolved" })] });
    expect(back.reenterDecisions).toBe(1);
    expect(getFiles(back.jobs)).toHaveLength(2);
    const work = agents(back.jobs, "work", "fix");
    expect(work).toHaveLength(2);
    expect(assignment(work[1])).toContain(DESIGN.trim());
  });

  it("stops with an incompatible-task reason, before any agent, when a document is missing", () => {
    const missing = simulate({ profile: CROSS, contextFiles: { "acme/private-design:docs/relational-design.md": DESIGN } });
    expect(missing.decision.action).toMatchObject({
      type: "stop",
      stop: { reason: "incompatible task", blocker: expect.stringContaining("the context document acme/private-design:docs/relational-tickets.md cannot be used: it does not exist at that ref"), retryable: false },
    });
    expect(missing.jobs.filter((j) => j.kind === "agent")).toEqual([]);
    const local = simulate({ profile: withContext([{ path: "docs/nope.md" }]), files: { "docs/nope.md": null } });
    expect(local.decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringContaining("docs/nope.md cannot be used: the target repository has no such file at the base commit") } });
    expect(local.jobs.filter((j) => j.kind === "agent")).toEqual([]);
  });

  it("enforces the size bound on the documents together, naming them", () => {
    const big = "x".repeat(MAX_CONTEXT_BYTES / 2 + 1);
    const over = simulate({ profile: CROSS, contextFiles: { "acme/private-design:docs/relational-design.md": big, "acme/private-design:docs/relational-tickets.md": big } });
    expect(over.decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringMatching(new RegExp(`more than the ${MAX_CONTEXT_BYTES} a run carries`)), retryable: false } });
    expect((over.decision.action as { stop: { blocker: string } }).stop.blocker).toContain("docs/relational-design.md");
    expect(over.jobs.filter((j) => j.kind === "agent")).toEqual([]);
    // Exactly the bound is fine.
    const half = { "acme/private-design:docs/relational-design.md": "y".repeat(MAX_CONTEXT_BYTES / 2), "acme/private-design:docs/relational-tickets.md": "z".repeat(MAX_CONTEXT_BYTES / 2) };
    const exact = simulate({ profile: CROSS, contextFiles: half });
    expect(exact.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    // Long documents are files, not prompt text, so they never crowd the issue out of the assignment.
    expect(exact.jobs.filter((j) => j.kind === "agent").every((j) => assignment(j).length < 20_000)).toBe(true);
  });

  const writes = (jobs: JobSpec[]) => jobs.filter((j) => (j.input as { commands?: Array<{ id: string }> } | undefined)?.commands?.some((c) => c.id.startsWith("context-write-")));
  const LONG = "L".repeat(20_000);
  const LONG_DOCS = Object.fromEntries(DOCS_OF(LONG));
  function DOCS_OF(text: string): Array<[string, string]> {
    return [
      ["acme/private-design:docs/relational-design.md", `# Design\n${text}\n"quoted" and \\backslashed\n`],
      ["acme/private-design:docs/relational-tickets.md", `# Tickets\n${text}\n`],
    ];
  }

  it("hands documents too long for a prompt to every agent job as read-only files, written from the evidence, and lists them in the assignment", () => {
    const { decision, jobs } = simulate({ profile: CROSS, contextFiles: LONG_DOCS });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(getFiles(jobs)).toHaveLength(2);
    // One command per document, in a read-only job, writing below .graphloom/context, before the first agent job.
    const written = writes(jobs);
    expect(written.length).toBeGreaterThan(0);
    expect(written[0]).toMatchObject({ stageId: "fix", kind: "command", purpose: "diagnostic", readOnly: true });
    const commands = (written[0]!.input as { commands: Array<{ id: string; argv: string[] }> }).commands;
    expect(commands.map((c) => c.id)).toEqual(["context-write-1", "context-write-2"]);
    expect(commands.map((c) => c.argv[4])).toEqual([".graphloom/context/01-relational-design.md", ".graphloom/context/02-relational-tickets.md"]);
    expect(writtenText(commands[0]!.argv, "context-write-1")!.text).toBe(LONG_DOCS["acme/private-design:docs/relational-design.md"]);
    expect(jobs.indexOf(written[0]!)).toBeLessThan(jobs.findIndex((j) => j.kind === "agent"));
    // Planner, implementer, reviewer: the listing, never the text.
    const plan = assignment(agents(jobs, "diagnostic", "fix")[0]);
    for (const text of [plan, assignment(agents(jobs, "work", "fix")[0]), assignment(agents(jobs, "review", "review")[0])]) {
      expect(text).toContain("Read them in full with your file tools before you start");
      expect(text).toMatch(/- \.graphloom\/context\/01-relational-design\.md: acme\/private-design:docs\/relational-design\.md@main \(.+, \d+ bytes\)/);
      expect(text).toContain("- .graphloom/context/02-relational-tickets.md: acme/private-design:docs/relational-tickets.md (");
      expect(text).not.toContain(LONG);
      expect(text).not.toContain("## Context document");
    }
    expect(plan.length).toBeLessThan(20_000);
    // Verifiers get the same list.
    const verifier = verificationInstruction(parseProfile(CROSS), { findings: [], background: "b", changed: [], context: contextDocuments(simulate({ profile: CROSS, contextFiles: LONG_DOCS }).evidence, parseProfile(CROSS)) });
    expect(verifier).toContain("- .graphloom/context/01-relational-design.md:");
    expect(verifier).not.toContain(LONG);
  });

  it("writes the files again after an implementer run and after a resume, never fetching them again", () => {
    const base = simulate({ profile: CROSS, contextFiles: LONG_DOCS });
    const resumed = simulate({ profile: CROSS, contextFiles: LONG_DOCS, resumeAfterCandidate: 1 });
    expect(resumed.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(writes(resumed.jobs).length).toBeGreaterThan(writes(base.jobs).length);
    expect(getFiles(resumed.jobs)).toHaveLength(2);
    // After an implementer run (which may have touched them) before the next agent job: at least the first write and one after the implementer.
    const work = base.jobs.findIndex((j) => j.kind === "agent" && j.purpose === "work");
    expect(writes(base.jobs).some((w) => base.jobs.indexOf(w) > work)).toBe(true);
  });

  it("hands a failed write of a context file to the supervisor, naming the file", () => {
    const failing = simulate({ profile: CROSS, contextFiles: LONG_DOCS, failContextWrites: true });
    expect(failing.decision.action).toMatchObject({ type: "supervise", supervise: { reason: expect.stringContaining("could not write the context document file .graphloom/context/01-relational-design.md") } });
    expect(failing.jobs.filter((j) => j.kind === "agent")).toEqual([]);
  });

  it("stops, naming the document, when one is too long to be written as a file, whatever the escapes cost", () => {
    // Quotes, backslashes and newlines: 142,500 bytes raw, under the bound for documents, about twice that serialized.
    const heavy = '"\\\n'.repeat(47_500);
    expect(Buffer.byteLength(heavy)).toBeLessThan(MAX_CONTEXT_BYTES);
    const { decision, jobs } = simulate({ profile: CROSS, contextFiles: { ...SERVED, "acme/private-design:docs/relational-design.md": heavy } });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringMatching(/docs\/relational-design\.md@main \(142500 bytes\) is too long to hand to the agents as a file/), retryable: false } });
    expect(jobs.filter((j) => j.kind === "agent")).toEqual([]);
    // The same bytes without escapes fit.
    const plain = simulate({ profile: CROSS, contextFiles: { ...SERVED, "acme/private-design:docs/relational-design.md": "x".repeat(Buffer.byteLength(heavy)) } });
    expect(plain.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
  });

  it("checks each agent job's input against the limits its executor declares, and stops naming the field and the limit", () => {
    // 70,000 characters of issue: the coding agent's assignment is at most 64,000.
    const { decision, jobs } = simulate({ issueBody: "w".repeat(70_000) });
    expect(decision.action).toMatchObject({
      type: "stop",
      stop: { reason: "incompatible task", blocker: expect.stringMatching(/does not fit what graphloom\.coding-agent\/run declares: assignment: must be at most 64000 characters/), retryable: false },
    });
    expect(jobs.filter((j) => j.kind === "agent")).toEqual([]);
    // Within the limit the same run proceeds.
    expect(simulate({ issueBody: "w".repeat(40_000) }).decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
  });

  it("runs as before for a profile without context: no read, no block", () => {
    const { jobs, decision } = simulate({});
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(getFiles(jobs)).toEqual([]);
    expect(assignment(agents(jobs, "diagnostic", "fix")[0])).not.toContain("Context document");
  });
});

describe("the final command tier (#196)", () => {
  const SMOKE = { id: "smoke", argv: ["make", "smoke"], timeoutMs: 600_000, requirement: "final-checks", tier: "final", label: "make smoke", section: "Smoke test" };
  const withFinal = (...commands: object[]): unknown => {
    const profile = structuredClone(BANYANDB) as { commands: object[] };
    profile.commands.push(...(commands.length > 0 ? commands : [SMOKE]));
    return profile;
  };
  const FINAL = withFinal();
  const finalJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "review" && j.purpose === "check");
  const reviewJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "review" && j.purpose === "review" && j.kind === "agent");
  const cheapJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "fix" && j.purpose === "check" && j.instruction === "Cheap candidate checks");
  const fullJobs = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "fix" && j.purpose === "check" && j.instruction === "Full candidate checks");
  const SMOKE_FAILED: CommandResult = { exitCode: 2, stderr: "smoke: the join returned 3 rows, want 4\n" };

  it("declares a Review requirement only for a profile with final commands", () => {
    const plain = createGraph().describe(BANYANDB);
    expect(plain.stages.find((s) => s.id === "review")!.requirementIds).toEqual(["code-review"]);
    const final = createGraph().describe(FINAL);
    expect(final.stages.find((s) => s.id === "review")!.requirementIds).toEqual(["code-review", "final-checks"]);
    expect(final.stages.find((s) => s.id === "fix")!.requirementIds).toEqual(plain.stages.find((s) => s.id === "fix")!.requirementIds);
    expect(final.requirements.find((r) => r.id === "final-checks")!.statement).toBe("In a prepared checkout of the reviewed change, make smoke all pass and change no file.");
    expect(final.defaultValidators.find((b) => b.requirementId === "final-checks")).toMatchObject({ validatorId: "final-checks" });
    // The final command is not part of the candidate checks, in any tier.
    const profile = parseProfile(FINAL);
    for (const tier of [undefined, "cheap", "full"] as const) {
      expect(candidateCommands(profile, PLAN.test!, tier).map((c) => c.id)).not.toContain("smoke");
    }
  });

  it("runs once, after code review passes, in a checkout of the candidate, and reports it in the pull request", () => {
    const { decision, jobs, receipts } = simulate({ profile: FINAL, finals: [{ smoke: { report: JSON.stringify({ summary: ["| size | ns/op |", "|---|---|", "| 1,024 | 812 |"] }) } }] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const runs = finalJobs(jobs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ stageId: "review", kind: "command", purpose: "check", readOnly: true, checkout: { from: "candidate" } });
    expect((runs[0]!.input as { commands: Array<{ id: string; argv: string[]; timeoutMs: number }> }).commands).toEqual([{ id: "smoke", argv: ["make", "smoke"], timeoutMs: 600_000 }]);
    // After the review that passed, never before it, and before delivery.
    expect(jobs.indexOf(runs[0]!)).toBeGreaterThan(jobs.indexOf(reviewJobs(jobs).at(-1)!));
    const delivery = jobs.find((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver)!;
    expect(jobs.indexOf(delivery)).toBeGreaterThan(jobs.indexOf(runs[0]!));
    expect(receipts.filter((r) => r.stageId === "review").map((r) => r.requirementId)).toEqual(["code-review", "final-checks"]);
    // The pull request names the command in its test plan and shows the report's summary, labelled as reported.
    const { body } = deliverArgs(jobs);
    expect(body).toContain("`make smoke`");
    expect(body).toContain("## Smoke test\nReported by `make smoke`; the run gated only on its exit status.\n\n| size | ns/op |\n|---|---|\n| 1,024 | 812 |");
  });

  it("runs once even when review needs several passes on the candidate", () => {
    // The first pass does not cover every file, so a second pass is needed.
    const { decision, jobs } = simulate({ profile: FINAL, codeReviews: [reviewed([], { total_files: 3, reviewed_files: 2, skipped: [] }), reviewed()] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(reviewJobs(jobs)).toHaveLength(2);
    expect(finalJobs(jobs)).toHaveLength(1);
    expect(jobs.indexOf(finalJobs(jobs)[0]!)).toBeGreaterThan(jobs.indexOf(reviewJobs(jobs)[1]!));
    // A report without a summary still gets its section, saying what was gated.
    expect(deliverArgs(jobs).body).toContain("## Smoke test\nReported by `make smoke`; the run gated only on its exit status.");
  });

  it("does not run when review does not pass: the supervisor gets the review failure, no final job ran", () => {
    const finding = { path: "pkg/timestamp/scheduler.go", start_line: 88, end_line: 95, category: "bug", severity: "high", content: "Close now waits forever for an action that ignores cancellation." };
    const { decision, jobs } = simulate({ profile: FINAL, codeReviews: [reviewed([finding])] });
    expect(decision.action).toMatchObject({ type: "supervise" });
    expect(finalJobs(jobs)).toEqual([]);
  });

  it("sends Fix back with the failing final command's output, and the next candidate runs every tier again", () => {
    const { decision, jobs, reenterDecisions, decisions } = simulate({ profile: FINAL, graphReenters: {}, finals: [{ smoke: SMOKE_FAILED }, {}] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(reenterDecisions).toBe(1);
    const reenter = decisions.find((d) => d.action.type === "reenter")!;
    expect(reenter.action).toMatchObject({ type: "reenter", reenter: { stageId: "fix", reason: expect.stringContaining("the final checks failed on the reviewed change") } });
    expect((reenter.action as { reenter: { reason: string } }).reenter.reason).toContain("smoke exited 2");
    expect((reenter.action as { reenter: { reason: string } }).reenter.reason).toContain("(reentry 1 of 4)");
    // The implementer is told what failed, with the output.
    const work = jobs.filter((j) => j.kind === "agent" && j.purpose === "work");
    expect(work).toHaveLength(2);
    expect(assignment(work[1])).toContain("Code review passed, but the final checks, which run once on the reviewed change, failed");
    expect(assignment(work[1])).toContain("smoke exited 2 in the candidate checkout");
    expect(assignment(work[1])).toContain("the join returned 3 rows, want 4");
    // The correction is a new candidate: both check tiers, code review and the final tier run again, in that order.
    expect(cheapJobs(jobs)).toHaveLength(2);
    expect(fullJobs(jobs)).toHaveLength(2);
    expect(reviewJobs(jobs).length).toBeGreaterThanOrEqual(2);
    expect(finalJobs(jobs)).toHaveLength(2);
    expect(jobs.indexOf(finalJobs(jobs)[0]!)).toBeLessThan(jobs.indexOf(work[1]!));
    expect(jobs.indexOf(work[1]!)).toBeLessThan(jobs.indexOf(cheapJobs(jobs)[1]!));
    expect(jobs.indexOf(cheapJobs(jobs)[1]!)).toBeLessThan(jobs.indexOf(finalJobs(jobs)[1]!));
  });

  it("counts a final failure against the review reentry cap, then hands the failure to the supervisor", () => {
    const { decision, jobs, reenterDecisions } = simulate({ profile: FINAL, graphReenters: { maxReentries: 1 }, finals: [{ smoke: SMOKE_FAILED }] });
    expect(reenterDecisions).toBe(1);
    expect(finalJobs(jobs)).toHaveLength(2);
    expect(decision.action).toMatchObject({ type: "supervise", supervise: { reason: expect.stringContaining("the final checks failed on the reviewed change: final-checks: smoke exited 2") } });
    // With no reentries allowed the first failure goes straight to the supervisor.
    const none = simulate({ profile: FINAL, finals: [{ smoke: SMOKE_FAILED }] });
    expect(none.reenterDecisions).toBe(0);
    expect(none.decision.action).toMatchObject({ type: "supervise" });
  });

  it("hands over a final failure that a reentry did not change, instead of running it again", () => {
    const { decision, jobs, reenterDecisions } = simulate({ profile: FINAL, graphReenters: {}, unchangedWork: [2], finals: [{ smoke: SMOKE_FAILED }] });
    expect(reenterDecisions).toBe(1);
    expect(decision.action).toMatchObject({ type: "supervise" });
    // The unchanged candidate already has its one final run.
    expect(finalJobs(jobs)).toHaveLength(1);
  });

  it("fails a final command that leaves a file changed, even when it exits 0", () => {
    const profile = parseProfile(FINAL);
    const run = (mutations: string[]): EvidenceRecord => ({
      ref: "f1",
      kind: "command",
      candidateDigest: "d1",
      payload: { command: { id: "smoke", argv: ["make", "smoke"], exitCode: 0, stdoutTail: "", stderrTail: "" }, checkout: { from: "candidate", base: "b", commit: "c", paths: CHANGED, prepared: true, mutations, phase: "run" }, producer: { operationId: "op-f", stageId: "review", purpose: "check", readOnly: true, kind: "command" } },
    });
    const evaluate = (evidence: EvidenceRecord[]) => validatorById("final-checks")!.evaluate({ requirementId: "final-checks", statement: "s", evidence, candidateDigest: "d1", config: FINAL });
    expect(evaluate([run([])])).toMatchObject({ status: "passed" });
    expect(evaluate([run(["build/out.txt"])])).toMatchObject({ status: "failed", reason: expect.stringContaining("left files changed: build/out.txt") });
    expect(evaluate([])).toMatchObject({ status: "inconclusive" });
    // A run on another candidate is no evidence for this one.
    expect(evaluate([{ ...run([]), candidateDigest: "d0" }])).toMatchObject({ status: "inconclusive" });
    expect(profile.commands.at(-1)).toMatchObject({ id: "smoke", tier: "final" });
  });

  it("runs a profile without final commands exactly as before: no final job, no Review requirement, no section", () => {
    const { decision, jobs, receipts } = simulate({});
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(finalJobs(jobs)).toEqual([]);
    expect(receipts.filter((r) => r.stageId === "review").map((r) => r.requirementId)).toEqual(["code-review"]);
    expect(deliverArgs(jobs).body).not.toContain("Reported by");
  });

  describe("after a resume (#154)", () => {
    it("runs a final failure from before the latest resume once more, and passes", () => {
      const { decision, jobs, reenterDecisions } = simulate({ profile: FINAL, finals: [{ smoke: SMOKE_FAILED }, {}], resumeAfterFinal: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(finalJobs(jobs)).toHaveLength(2);
      // The stale failure was not acted on: no reentry, no second implementer pass.
      expect(reenterDecisions).toBe(0);
      expect(jobs.filter((j) => j.kind === "agent" && j.purpose === "work")).toHaveLength(1);
    });

    it("acts on a failure recorded since the resume, so a failing command cannot loop", () => {
      const { decision, jobs } = simulate({ profile: FINAL, finals: [{ smoke: SMOKE_FAILED }], resumeAfterFinal: 1 });
      expect(finalJobs(jobs)).toHaveLength(2);
      expect(decision.action).toMatchObject({ type: "supervise", supervise: { reason: expect.stringContaining("smoke exited 2") } });
    });

    it("does not run a final command that passed before the resume again", () => {
      const { decision, jobs } = simulate({ profile: FINAL, resumeAfterFinal: 1 });
      expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
      expect(finalJobs(jobs)).toHaveLength(1);
    });
  });

  it("checks the tier and requirement a profile declares for a command", () => {
    const broken = (command: object) => () => parseProfile(withFinal(command));
    expect(broken({ ...SMOKE, requirement: "passes" })).toThrow(/a final tier command counts toward final-checks/);
    expect(broken({ ...SMOKE, tier: "full" })).toThrow(/only a final tier command may/);
    expect(broken({ ...SMOKE, tier: "last" })).toThrow(/tier must be cheap, full or final/);
    expect(broken({ ...SMOKE, requirement: "bench" })).toThrow(/requirement must be passes, builds, final-checks or bench-gates/);
    expect(broken({ ...SMOKE, section: "" })).toThrow(/section is a pull request heading/);
    expect(broken({ ...SMOKE, tier: undefined, requirement: "builds", section: "X" })).toThrow(/section is a pull request heading, for a final tier command only/);
    expect(broken(SMOKE)).not.toThrow();
    expect(broken({ ...SMOKE, section: undefined })).not.toThrow();
  });
});

describe("the banyandb-ql profile and its benchmark gates (#197)", () => {
  const QL = shippedProfile("banyandb-ql");
  const ql = parseProfile(QL);
  const REQUEST = "Implement hanahmily/banyandb-ql-design#7.";
  const DOCS = ["relational-design", "relational-tickets", "catalog-b-context"];
  const SERVED = Object.fromEntries(DOCS.map((d) => [`hanahmily/banyandb-ql-design:docs/${d}.md`, `# ${d}\n\nThe contract text of ${d}.\n`]));
  const SIZES = [
    { facts: 1_024, dimensions: 64 },
    { facts: 16_384, dimensions: 1_024 },
  ];
  type Json = Record<string, unknown>;
  /** A complete, passing `ql-bench-report/v1`, as a ticket's runner writes it, with `patch` applied by key. */
  const benchReport = (patch: (report: Json) => void = () => undefined): Json => {
    const samples = (base: number) =>
      [1, 2, 3, 4, 5].flatMap((pair) =>
        ["operator", "reference"].map((variant) => ({
          pair,
          order: pair % 2 === 1 ? "AB" : "BA",
          variant,
          nsPerOp: base * (variant === "operator" ? 1 : 40) + pair,
          allocBytesPerOp: 4_096,
          allocsPerOp: 12,
          retainedBytes: 65_536,
          rpcP50Ns: 900_000,
          rpcP95Ns: 1_400_000,
          rpcCpuNs: 700_000,
        })),
      );
    const report: Json = {
      schema: "ql-bench-report/v1",
      ticket: "R01",
      environment: { goVersion: "go1.26.10", commit: "a".repeat(40), baseCommit: "b".repeat(40), seed: 20261024, cpus: 4, memoryBytes: 8_589_934_592, swapBytes: 0 },
      budgets: { queryBytes: 268_435_456, perOperatorBytes: 134_217_728 },
      preflight: SIZES.map((s, i) => ({ ...s, fits: true, peakAccountedBytes: 1_000_000 * (i + 1), budgetBytes: 268_435_456 })),
      gates: { exactResults: { checked: 52_224, mismatches: 0 }, failedTimedCalls: { count: 0 }, accountedMemory: { peakBytes: 2_000_000, budgetBytes: 268_435_456 }, outstandingResources: { count: 0 } },
      cases: SIZES.map((size, i) => ({
        name: "join-unique",
        size,
        samples: samples(800 * (i + 1)),
        effects: [{ metric: "nsPerOp", comparison: "operator-vs-reference", estimate: -0.97, ciLow: -0.98, ciHigh: -0.96, confidence: 0.95 }],
      })),
    };
    patch(report);
    return report;
  };
  /** What the bench-gates command leaves as its report file: the wrapper's envelope. */
  const envelope = (report: Json): string => JSON.stringify({ harness: { image: "golang:1.26.10", imageGo: "go version go1.26.10 linux/amd64", cpus: 4, memory: "8g", memorySwap: "8g" }, report });
  const gates = (report: Json) => report.gates as Record<string, Record<string, number>>;
  const bench = (report: Json, o: Partial<CommandResult> = {}): Partial<Record<string, CommandResult>> => ({ "bench-gates": { report: envelope(report), ...o } });
  const finalRuns = (jobs: JobSpec[]) => jobs.filter((j) => j.stageId === "review" && j.purpose === "check");
  const work = (jobs: JobSpec[]) => jobs.filter((j) => j.kind === "agent" && j.purpose === "work");
  const run = (finals: Array<Partial<Record<string, CommandResult>>>, more: Partial<Scenario> = {}) =>
    simulate({ profile: QL, contextFiles: SERVED, finals, ...more }, REQUEST);

  it("derives from the banyandb profile: same project, environment checks, budgets and commands, plus the private tracker, the context and the benchmark", () => {
    const base = parseProfile(BANYANDB);
    expect(ql.name).toBe("banyandb-ql");
    expect(ql.project).toBe(base.project);
    expect(ql.budgets).toEqual(base.budgets);
    expect(ql.regression).toEqual(base.regression);
    expect(ql.harnesses).toEqual(base.harnesses);
    expect(ql.commands.slice(0, base.commands.length)).toEqual(base.commands);
    // The environment is banyandb's, plus one check that the benchmark's container runtime is there.
    expect(ql.environment.checks!.filter((c) => c.id !== "docker")).toEqual(base.environment.checks);
    expect(ql.environment.checks!.find((c) => c.id === "docker")!.argv[2]).toContain("docker info");
    // And one prepare output: at the base the tickets build on, `make check` formats api/ with bin/buf, which only `make generate` installs (api/Makefile defines BUF after lint-api.mk reads it, so the format target has no rule for it), so a checkout restored from the prepare cache needs the binary cached too.
    const prepare = (profile: typeof ql) => profile.environment.prepare!.map((c) => (c.id === "generate-proto" ? { ...c, outputs: c.outputs!.filter((o) => o !== "bin/buf") } : c));
    expect(ql.environment.prepare!.find((c) => c.id === "generate-proto")!.outputs).toContain("bin/buf");
    expect(prepare(ql)).toEqual(prepare(base));
    expect({ ...ql.environment, checks: undefined, prepare: undefined }).toEqual({ ...base.environment, checks: undefined, prepare: undefined });
    expect(ql.issues).toEqual({
      owner: "hanahmily",
      repo: "banyandb-ql-design",
      context: DOCS.map((d) => ({ repo: "hanahmily/banyandb-ql-design", path: `docs/${d}.md` })),
    });
    expect(ql.commands.at(-1)).toMatchObject({ id: "bench-gates", tier: "final", requirement: "bench-gates", section: "Benchmark" });
    expect(createGraph().describe(QL).stages.find((s) => s.id === "review")!.requirementIds).toEqual(["code-review", "bench-gates"]);
  });

  it("runs the benchmark in docker with the frozen resources, a golang image from go.mod, a read-only module cache that the environment names", () => {
    const argv = ql.commands.at(-1)!.argv;
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    const script = argv[2]!;
    expect(script).toContain("docker run --rm --cpus=4 --memory=8g --memory-swap=8g");
    expect(script).toContain(`image="\${GRAPHLOOM_BENCH_IMAGE:-golang:$want}"`);
    expect(script).toContain("sed -n 's/^go //p' go.mod");
    expect(script).toContain('-v "$cache:/go/pkg/mod:ro"');
    expect(script).toContain('-v "$PWD:/src"');
    // The module cache is the operator's, not hard-coded.
    expect(script).toContain("GRAPHLOOM_BENCH_GOMODCACHE");
    expect(script).toContain("go env GOMODCACHE");
    expect(script).not.toContain("/mnt/d/gomodcache");
    expect(script).toContain("make bench-ql-report");
    expect(script).toContain("build/bench/ql-report.json");
    // A missing target is an actionable failure.
    expect(script).toContain("this checkout has no make target bench-ql-report");
    expect(script).toContain("GOPROXY=off");
  });

  it("gives the planner and the implementer the context documents, the benchmark rules and the report schema, citing the rules' document", () => {
    const { jobs } = run([{}]);
    const plan = assignment(jobs.find((j) => j.kind === "agent" && j.purpose === "diagnostic" && j.stageId === "fix"));
    const implement = assignment(work(jobs)[0]);
    for (const text of [plan, implement]) {
      for (const d of DOCS) expect(text).toContain(`## Context document: hanahmily/banyandb-ql-design:docs/${d}.md (`);
      expect(text).toContain('docs/relational-tickets.md, "Benchmark rules for every ticket"');
      expect(text).toContain("docs/relational-tickets.md");
      expect(text).toContain('"schema":"ql-bench-report/v1"');
      expect(text).toContain("five paired repetitions with alternated order");
      expect(text).toContain("1,024 facts/64 dimension rows and 16,384 facts/1,024 dimension rows");
      expect(text).toContain("make bench-ql-report");
      expect(text).toContain("build/bench/ql-report.json");
      expect(text).toContain("timings are reported, never gated");
    }
    // The profile's notes are exactly the guidance the code documents.
    expect(ql.planning.notes!.join("\n")).toContain(BENCH_GUIDANCE);
    // The planner is told to keep the private design out of public text.
    expect(plan).toContain("do not cite the design repository, its issue numbers or its file names");
  });

  it("reaches delivery on a stub runner's passing report, with a Benchmark section, and neither Fixes nor the private repository in the commit or the pull request", () => {
    const report = benchReport();
    const { decision, jobs, receipts } = run([bench(report)]);
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(finalRuns(jobs)).toHaveLength(1);
    expect(receipts.filter((r) => r.stageId === "review").map((r) => r.requirementId)).toEqual(["code-review", "bench-gates"]);
    const { message, body } = deliverArgs(jobs);
    expect(body).toContain("## Benchmark\nReported by `make bench-ql-report` in docker (4 CPUs, 8 GiB, no extra swap) in golang:1.26.10, 4 CPUs, 8g memory, 8g memory+swap.");
    expect(body).toContain("Toolchain go1.26.10, commit aaaaaaaaaaaa on base bbbbbbbbbbbb, fixture seed 20261024.");
    expect(body).toContain("The run gated only on the hard gates below; timings are reported and never judged.");
    expect(body).toContain("Hard gates (all held):\n- Exact results: 52224 checked, 0 differ.\n- Failed timed calls: 0.\n- Accounted memory: peak 2000000 of a 268435456 byte budget.\n- Outstanding owned resources: 0.\n- Preflight 1,024/64 fits: peak 1000000 of 268435456 bytes.\n- Preflight 16,384/1,024 fits: peak 2000000 of 268435456 bytes.");
    expect(body).toContain("Reported only, not gated (medians of the paired samples):");
    expect(body).toContain("| join-unique (operator) | 1,024/64 | 5 | 803 | 4,096 | 12 | 65,536 | 900,000 | 1,400,000 | 700,000 |");
    expect(body).toContain("| join-unique (reference) | 16,384/1,024 | 5 | 64,003 |");
    expect(body).toContain("- join-unique, nsPerOp (operator-vs-reference): -0.97 [-0.98, -0.96] at 95%");
    // The test plan lists the benchmark among what passed.
    expect(body).toContain("`make bench-ql-report` in docker (4 CPUs, 8 GiB, no extra swap)");
    // Implements, not Fixes, and nothing of the private tracker.
    expect(message.split("\n").at(-1)).toMatch(/^Implements the Measure QL /);
    expect(body.split("\n")[0]).toMatch(/^### Implements the Measure QL /);
    for (const text of [message, body]) {
      expect(text).not.toContain("Fixes");
      expect(text).not.toContain("hanahmily");
      expect(text).not.toContain("banyandb-ql-design");
      expect(text).not.toMatch(/Fix hanahmily/);
    }
  });

  it("scrubs a reference to the private repository an agent wrote into the commit or the pull request", () => {
    const leaky: DecisionRecord = {
      ...PLAN,
      change: "Adds the join planner, per hanahmily/banyandb-ql-design#7 and https://github.com/hanahmily/banyandb-ql-design/blob/main/docs/relational-design.md (see hanahmily/banyandb-ql-design:docs/relational-tickets.md@main).",
      followUps: ["Revisit the fan-out case, as hanahmily/banyandb-ql-design#9 asks."],
    };
    const { decision, jobs } = run([bench(benchReport())], { plans: [leaky], implement: [leaky] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const { message, body } = deliverArgs(jobs);
    for (const text of [message, body]) {
      expect(text).not.toMatch(/hanahmily|banyandb-ql-design/);
      expect(text).toContain("Adds the join planner, per and");
    }
    expect(body).toContain("- Revisit the fan-out case, as asks.");
    // Without the option nothing is scrubbed: the profile's own references stay.
    const kept = pullRequestDescription(parseProfile(BANYANDB), { issue: 1, issueTitle: "T", record: leaky, base: "abc", review: "r" });
    expect(kept).toContain("hanahmily/banyandb-ql-design#7");
  });

  it("sends Fix back when a hard gate fails, with the failing gate and its numbers, even though the command exited 0; the corrected change passes", () => {
    const failing = benchReport((r) => {
      gates(r).exactResults!.mismatches = 3;
    });
    const { decision, jobs, reenterDecisions, decisions } = run([bench(failing), bench(benchReport())], { graphReenters: {} });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(reenterDecisions).toBe(1);
    const reason = (decisions.find((d) => d.action.type === "reenter")!.action as { reenter: { reason: string } }).reenter.reason;
    expect(reason).toContain("bench-gates: bench-gates: hard gate failed, exact results: 3 of 52224 results differ from the oracle");
    const second = assignment(work(jobs)[1]);
    expect(second).toContain("Code review passed, but the final checks, which run once on the reviewed change, failed");
    expect(second).toContain("hard gate failed, exact results: 3 of 52224 results differ from the oracle");
    expect(finalRuns(jobs)).toHaveLength(2);
    // The next candidate ran every tier again before its benchmark.
    expect(jobs.filter((j) => j.stageId === "fix" && j.instruction === "Cheap candidate checks")).toHaveLength(2);
    expect(deliverArgs(jobs).body).toContain("## Benchmark");
  });

  it("names the same failure to the supervisor when the reentries run out", () => {
    const failing = benchReport((r) => {
      gates(r).outstandingResources!.count = 2;
    });
    const { decision } = run([bench(failing)]);
    expect(decision.action).toMatchObject({ type: "supervise", supervise: { reason: expect.stringContaining("outstanding resources: 2 owned resource(s) were not released") } });
  });

  it("fails a missing make target with a message the implementer can act on", () => {
    const missing: Partial<CommandResult> = {
      exitCode: 1,
      stderr: "bench-gates: this checkout has no make target bench-ql-report. The ticket's change must add it: it runs the ticket's benchmark runner and writes build/bench/ql-report.json (schema ql-bench-report/v1, given in the implementation guidance).\n",
    };
    const { decision, jobs } = run([{ "bench-gates": missing }, bench(benchReport())], { graphReenters: {} });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const second = assignment(work(jobs)[1]);
    expect(second).toContain("bench-gates exited 1 in the candidate checkout");
    expect(second).toContain("no make target bench-ql-report. The ticket's change must add it");
  });

  describe("the bench-gates validator", () => {
    const run1 = (command: Partial<CommandResult>, o: { mutations?: string[]; digest?: string } = {}): EvidenceRecord => ({
      ref: "b1",
      kind: "command",
      candidateDigest: o.digest ?? "d1",
      payload: {
        command: { id: "bench-gates", argv: ["sh"], exitCode: command.exitCode ?? 0, stdoutTail: command.stdout ?? "", stderrTail: command.stderr ?? "", ...(command.timedOut === true ? { timedOut: true } : {}), ...(command.report !== undefined ? { report: { text: command.report, truncated: false } } : {}) },
        checkout: { from: "candidate", base: "b", commit: "c", paths: CHANGED, prepared: true, mutations: o.mutations ?? [], phase: "run" },
        producer: { operationId: "op-b", stageId: "review", purpose: "check", readOnly: true, kind: "command" },
      },
    });
    const judge = (evidence: EvidenceRecord[]) => validatorById("bench-gates")!.evaluate({ requirementId: "bench-gates", statement: "s", evidence, candidateDigest: "d1", config: QL });
    const report = (patch?: (r: Json) => void, raw = false) => run1({ report: raw ? JSON.stringify(benchReport(patch)) : envelope(benchReport(patch)) });
    const failsWith = (patch: (r: Json) => void, text: RegExp) => expect(judge([report(patch)])).toMatchObject({ status: "failed", reason: expect.stringMatching(text) });

    it("passes a complete report whose hard gates hold, as an envelope or bare, and says timings are not judged", () => {
      expect(judge([report()])).toMatchObject({ status: "passed", reason: expect.stringContaining("every hard gate holds (52224 results exact, no failed timed call, peak 2000000 of 268435456 accounted bytes, no outstanding resource, both sizes fit); timings are reported, not judged") });
      expect(judge([report(undefined, true)])).toMatchObject({ status: "passed" });
    });

    it("fails each hard gate on its own, naming the numbers", () => {
      failsWith((r) => void (gates(r).exactResults!.mismatches = 1), /hard gate failed, exact results: 1 of 52224 results differ from the oracle/);
      failsWith((r) => void (gates(r).exactResults!.checked = 0), /no result was checked against the oracle/);
      failsWith((r) => void (gates(r).failedTimedCalls!.count = 4), /failed timed calls: 4 timed call\(s\) failed, and a failure is never a faster observation/);
      failsWith((r) => void (gates(r).accountedMemory!.peakBytes = 300_000_000), /accounted memory: peak 300000000 bytes exceeds the 268435456 byte budget/);
      failsWith((r) => void (gates(r).outstandingResources!.count = 1), /outstanding resources: 1 owned resource\(s\) were not released/);
    });

    it("fails a preflight that does not fit either size, or is missing one, whatever its own `fits` says", () => {
      failsWith((r) => void ((r.preflight as Json[])[1]!.fits = false), /preflight 16,384\/1,024: peak 2000000 bytes does not fit the 268435456 byte budget/);
      failsWith((r) => void ((r.preflight as Json[])[0]!.peakAccountedBytes = 999_999_999), /preflight 1,024\/64: peak 999999999 bytes does not fit/);
      failsWith((r) => void (r.preflight = (r.preflight as Json[]).slice(0, 1)), /preflight: no entry for 16,384\/1,024/);
      failsWith((r) => void delete r.gates, /exact results: the report gives no checked and mismatches counts/);
    });

    it("never judges a latency: the slowest possible timings and a worse-than-reference effect still pass", () => {
      const slow = (r: Json) => {
        for (const c of r.cases as Json[]) {
          for (const s of c.samples as Json[]) s.nsPerOp = 9e15;
          c.effects = [{ metric: "nsPerOp", comparison: "operator-vs-reference", estimate: 5_000, ciLow: 4_000, ciHigh: 6_000, confidence: 0.95 }];
        }
      };
      expect(judge([report(slow)])).toMatchObject({ status: "passed" });
    });

    it("fails an incomplete report: wrong schema, missing environment or budgets, a size without a case, fewer than five alternated pairs, an effect without an interval", () => {
      failsWith((r) => void (r.schema = "ql-bench-report/v0"), /the report is incomplete: schema is "ql-bench-report\/v0"/);
      failsWith((r) => void delete r.environment, /environment is missing/);
      failsWith((r) => void ((r.environment as Json).seed = undefined), /environment.seed is missing/);
      failsWith((r) => void (r.budgets = {}), /budgets must list the effective admission budgets/);
      failsWith((r) => void (r.cases = (r.cases as Json[]).slice(0, 1)), /no case at 16,384\/1,024/);
      failsWith((r) => void ((r.cases as Json[])[0]!.samples = ((r.cases as Json[])[0]!.samples as Json[]).slice(0, 6)), /join-unique: 3 paired repetition\(s\), want 5/);
      failsWith((r) => void ((r.cases as Json[])[0]!.samples = { pairs: 5 }), /join-unique: samples must list the raw samples, not count them/);
      failsWith((r) => void ((r.cases as Json[])[1]!.samples = { count: 10, pairs: 5, medians: {} }), /join-unique: samples must list the raw samples/);
      failsWith((r) => void ((r.cases as Json[]).forEach((c) => void (c.samples = (c.samples as Json[]).filter((s) => s.variant !== "reference")))), /a pair needs two variants measured against each other/);
      failsWith((r) => void ((r.cases as Json[])[0]!.samples = ((r.cases as Json[])[0]!.samples as Json[]).filter((s) => !(s.pair === 3 && s.variant === "reference"))), /pair 3 does not hold each variant exactly once/);
      failsWith((r) => void ((r.cases as Json[])[0]!.samples = [...((r.cases as Json[])[0]!.samples as Json[]), { pair: 6, order: "BA", variant: "operator", nsPerOp: 1, allocBytesPerOp: 1, retainedBytes: 1 }, { pair: 6, order: "BA", variant: "reference", nsPerOp: 1, allocBytesPerOp: 1, retainedBytes: 1 }]), /join-unique: 6 paired repetition\(s\), want 5/);
      failsWith((r) => void ((r.cases as Json[])[0]!.samples = ((r.cases as Json[])[0]!.samples as Json[]).map((s) => (s.pair === 2 && s.variant === "reference" ? { ...s, order: "AB" } : s))), /pair 2 has more than one order/);
      failsWith((r) => void ((r.cases as Json[])[0]!.samples = ((r.cases as Json[])[0]!.samples as Json[]).map((s) => ({ ...s, order: "AB" }))), /the pairs' order is not alternated/);
      failsWith((r) => void ((r.cases as Json[])[1]!.effects = [{ metric: "nsPerOp", estimate: 1 }]), /an effect needs a metric, an estimate and an interval/);
      failsWith((r) => void ((r.cases as Json[])[1]!.effects = []), /no paired effect estimate/);
      failsWith((r) => void delete ((r.cases as Json[])[0]!.samples as Json[])[0]!.retainedBytes, /every sample needs nsPerOp, allocBytesPerOp and retainedBytes/);
    });

    it("fails a command that did not succeed, left a file changed, or wrote no readable report; stays inconclusive before the benchmark ran", () => {
      expect(judge([run1({ exitCode: 2, report: envelope(benchReport()) })])).toMatchObject({ status: "failed", reason: "bench-gates exited 2" });
      expect(judge([run1({ timedOut: true, exitCode: 0, report: envelope(benchReport()) })])).toMatchObject({ status: "failed", reason: "bench-gates timed out" });
      expect(judge([run1({ report: envelope(benchReport()) }, { mutations: ["Makefile"] })])).toMatchObject({ status: "failed", reason: expect.stringContaining("left files changed: Makefile") });
      expect(judge([run1({ report: "" })])).toMatchObject({ status: "failed", reason: expect.stringContaining("is not valid JSON") });
      expect(judge([run1({ report: envelope(benchReport()).slice(0, 2_000) })])).toMatchObject({ status: "failed", reason: expect.stringContaining("is not valid JSON") });
      expect(judge([run1({ report: "[1,2]" })])).toMatchObject({ status: "failed", reason: expect.stringContaining("not a JSON object") });
      expect(judge([])).toMatchObject({ status: "inconclusive" });
      expect(judge([run1({ report: envelope(benchReport()) }, { digest: "d0" })])).toMatchObject({ status: "inconclusive" });
    });

    it("reads a stubbed command's report from its stdout when the run keeps no report file", () => {
      expect(judge([run1({ stdout: envelope(benchReport()) })])).toMatchObject({ status: "passed" });
    });
  });

  it("runs a rehearsal scenario with stubbed commands: the stub's report from stdout reaches delivery; a failing gate in it does not", () => {
    // `graphloom rehearse` stubs a command from the scenario's `commands` map, which carries stdout and no report file.
    const passing = run([{ "bench-gates": { stdout: envelope(benchReport()) } }]);
    expect(passing.decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(deliverArgs(passing.jobs).body).toContain("## Benchmark");
    const failing = run([{ "bench-gates": { stdout: envelope(benchReport((r) => void (gates(r).failedTimedCalls!.count = 1))) } }]);
    expect(failing.decision.action.type).toBe("supervise");
  });
});
