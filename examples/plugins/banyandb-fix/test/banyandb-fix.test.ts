import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentSessionView, EvidenceRecord, GraphDecision, JobSpec, Receipt, RunView, Validator } from "@graphloom/sdk";
import {
  CHANGES_PATH,
  COMMAND,
  ENVIRONMENT,
  MAX_SNAPSHOT_CHARS,
  OCR_RULE,
  QUALIFICATION_CASES,
  advanceFix,
  blockingComments,
  codeReviewCommands,
  createGraph,
  ginkgoSpecs,
  parseOcrReport,
  qualifyValidators,
  reviewBackground,
  regressionArgv,
  regressionOutcome,
  requestedIssue,
  testOutcome,
  validatorById,
  type DecisionRecord,
  type GinkgoSpec,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
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
}

interface Scenario {
  /** The planner's result for each plan job, in order; the last repeats. */
  plans?: DecisionRecord[];
  /** The implementer's result for each implement job, in order. */
  implement?: Array<DecisionRecord | undefined>;
  /** Command outcomes in the candidate checkout for each candidate job, by command id. */
  candidate?: Array<Partial<Record<string, CommandResult>>>;
  candidateMutations?: string[][];
  red?: CommandResult;
  /** The plan reviewer's verdict for each plan review, in order; the last repeats. */
  planReviews?: Array<Record<string, unknown>>;
  /** The code-review command's outcome for each run, in order; the last repeats. */
  codeReviews?: CommandResult[];
  changes?: string;
  /** Bump the generation once Fix is accepted, as an operator's resume does. */
  resumeAfterFix?: boolean;
  issueBody?: string;
  comments?: Array<{ author: string; createdAt: string; body: string }>;
  /** Whether the comment listing reached its last page. */
  commentsComplete?: boolean;
  /** Supervise decisions the supervisor answers by re-entering Fix. */
  reenter?: number;
}

const ocrReport = (status: string, comments: Array<Record<string, unknown>> = []) =>
  JSON.stringify({ GraphLoomOcr: { status, message: "", model: "MiniMax-M3", commentCount: comments.length, comments, warnings: [] } });
const HANG = { path: "pkg/timestamp/scheduler.go", start_line: 88, end_line: 95, category: "bug", severity: "high", content: "Close now waits forever for an action that ignores cancellation." };

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
  let privateState: string | undefined;
  let digest = "d0";
  let implemented = 0;
  let candidates = 0;
  let planned = 0;
  let planReviewed = 0;
  let codeReviewed = 0;
  let reentries = scenario.reenter ?? 0;
  let seq = 0;
  let generation = 1;
  const nth = <T>(list: T[] | undefined, i: number): T | undefined => (list === undefined || list.length === 0 ? undefined : list[Math.min(i, list.length - 1)]);
  const budgets = { agentInvocations: 32, jobs: 64, decisions: 128, corrections: 8 };

  const record = (kind: EvidenceRecord["kind"], payload: Record<string, unknown>, job: JobSpec | undefined, op: string): EvidenceRecord => {
    const e: EvidenceRecord = {
      ref: `ev-${++seq}`,
      kind,
      generation,
      candidateDigest: digest,
      payload: job === undefined ? payload : { ...payload, producer: { operationId: op, stageId: job.stageId, purpose: job.purpose, readOnly: job.readOnly === true, kind: job.kind, ...(job.executor ? { executorId: job.executor.id } : {}) } },
    };
    evidence.push(e);
    return e;
  };
  const commandPayload = (id: string, r: CommandResult) => ({
    command: { id, argv: [id], exitCode: r.exitCode ?? 0, stdoutTail: r.stdout ?? "", stderrTail: r.stderr ?? "", ...(r.report !== undefined ? { report: { text: r.report, truncated: false } } : {}) },
  });

  function run(job: JobSpec, op: string): void {
    jobs.push(job);
    const input = job.input as { commands?: Array<{ id: string }>; number?: number } | undefined;
    if (job.executor?.id === "graphloom.github/get-issue") {
      record("other", { github: { item: { number: input!.number, title: "Scheduler reports long actions as timed out", state: "open", url: "u", labels: [], body: scenario.issueBody ?? "Backups longer than five minutes are reported as action timed out." } } }, job, op);
      return;
    }
    if (job.executor?.id === "graphloom.github/list-issue-comments") {
      const items = scenario.comments ?? [{ author: "maintainer", createdAt: "2026-09-01", body: "It should not be an error." }];
      record("other", { github: { items, page: { complete: scenario.commentsComplete ?? true } } }, job, op);
      return;
    }
    if (job.kind === "agent") {
      let output: unknown;
      if (job.purpose === "diagnostic") output = nth(scenario.plans, planned++) ?? PLAN;
      else if (job.purpose === "work") {
        output = scenario.implement?.[implemented] ?? nth(scenario.plans, planned - 1) ?? PLAN;
        implemented += 1;
        digest = `d${implemented}`;
      } else if (job.purpose === "review") {
        const verdict = nth(scenario.planReviews, planReviewed++) ?? { verdict: "approved", summary: "ok" };
        record("other", { codingAgent: { status: "completed", output: verdict } }, job, op);
        record("review", verdict, job, op);
        sessions.push({ operationId: op, stageId: job.stageId, attempt: 1, generation, dispatchKey: "review", executorId: job.executor!.id, status: "ok" });
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
    if (job.checkout?.from === "candidate" && input!.commands![0]!.id === COMMAND.codeReview) {
      const result = nth(scenario.codeReviews, codeReviewed++) ?? { report: ocrReport("complete") };
      record("command", { ...commandPayload(COMMAND.codeReview, result), checkout: { from: "candidate", base: "base-sha", commit: `c-${op}`, paths: CHANGED, prepared: true, mutations: [], phase: "run" } }, job, op);
      return;
    }
    if (job.checkout?.from === "candidate") {
      const results = scenario.candidate?.[candidates] ?? {};
      const mutations = scenario.candidateMutations?.[candidates] ?? [];
      candidates += 1;
      for (const c of input!.commands!) {
        const defaults: CommandResult =
          c.id === COMMAND.regression ? { report: PASSED } : c.id === COMMAND.changesDiff ? { stdout: "+- Warn while a scheduled action is still running.\n" } : {};
        record("command", { ...commandPayload(c.id, { ...defaults, ...results[c.id] }), checkout: { from: "candidate", base: "base-sha", commit: `c-${op}`, paths: CHANGED, prepared: true, mutations, phase: "run" } }, job, op);
      }
      return;
    }
    if (job.checkout?.from === "base") {
      record("command", { ...commandPayload(COMMAND.regression, scenario.red ?? { exitCode: 1, report: FAILED }), checkout: { from: "base", base: "base-sha", commit: `b-${op}`, paths: job.checkout.paths, prepared: true, mutations: [], phase: "run" } }, job, op);
      return;
    }
    for (const c of input!.commands!) record("command", commandPayload(c.id, { stdout: "abc123\n" }), job, op);
  }

  const definition = createGraph().describe();
  for (let step = 0; step < 60; step += 1) {
    const view: RunView = {
      runId: "run",
      task: { request, repo: "../skywalking-banyandb" },
      current: { stageId: "fix", attempt: 1 },
      receipts: structuredClone(receipts),
      evidence: structuredClone(evidence),
      outstanding: [],
      budgets,
      validatorBindings: definition.defaultValidators,
      generation,
      stateRevision: step,
      activeVersion: "banyandb-fix@0.2.0",
      candidateDigest: digest,
      ...(sessions.length > 0 ? { agentSessions: structuredClone(sessions) } : {}),
      ...(privateState !== undefined ? { privateState } : {}),
    };
    const decision = advanceFix(view);
    decisions.push(decision);
    if (decision.privateState !== undefined) privateState = decision.privateState;
    const action = decision.action;
    const op = `op-${step}`;
    if (action.type === "dispatch") run(action.job, op);
    else if (action.type === "observe") {
      for (const p of action.observe.paths ?? []) record("file", { path: p, bytes: p === CHANGES_PATH ? (scenario.changes ?? CHANGES) : "" }, undefined, op);
    } else if (action.type === "validate") {
      const stage = definition.stages.find((s) => s.id === action.validate.stageId)!;
      const visible = candidateEvidence(evidence, generation);
      const results = stage.requirementIds.map((requirementId) => {
        const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
        return { requirementId, binding, result: validatorById(binding.validatorId)!.evaluate({ requirementId, statement: "s", evidence: visible, candidateDigest: digest }) };
      });
      const failure = results.find((r) => r.result.status !== "passed");
      if (failure !== undefined) throw new Error(`validate ${stage.id} failed: ${failure.requirementId}: ${failure.result.reason}`);
      for (const r of results) receipts.push({ id: `rcpt-${receipts.length + 1}`, stageId: stage.id, requirementId: r.requirementId, validatorBinding: r.binding, candidateFingerprint: "fp", evidenceRefs: [], valid: true, candidateDigest: digest });
      if (scenario.resumeAfterFix === true && stage.id === "fix") generation += 1;
    } else if (action.type === "supervise" && reentries > 0) {
      // The supervisor re-enters Fix: receipts from Fix on are invalidated and the generation moves on.
      reentries -= 1;
      for (const r of receipts) r.valid = false;
      generation += 1;
    } else {
      return { decision, decisions, jobs, evidence, receipts };
    }
  }
  throw new Error("the graph did not finish in 60 steps");
}

/** What the controller shows validators: this generation, with only the latest review and the latest observation of each file. */
function candidateEvidence(evidence: EvidenceRecord[], generation: number): EvidenceRecord[] {
  const seen = new Set<string>();
  return evidence
    .filter((e) => e.generation === generation)
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
const assignment = (job: JobSpec | undefined) => (job!.input as { assignment: string }).assignment;

describe("banyandb-fix graph", () => {
  it("declares the contributor checklist the controller checks before any job", () => {
    const definition = createGraph().describe();
    expect(definition.stages.map((s) => s.id)).toEqual(["fix", "review"]);
    expect(definition.environment).toEqual(ENVIRONMENT);
    expect(ENVIRONMENT.checks!.map((c) => c.id)).toEqual(["go", "git", "ocr", "claude", "make", "check-req"]);
    expect(ENVIRONMENT.prepare!.map((c) => c.argv.join(" "))).toEqual(["make generate"]);
    expect(ENVIRONMENT.pinnedFiles![0]!.path).toBe("CONTRIBUTING.md");
  });

  it("checks that open-code-review and Claude Code are installed and ready before any job", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bydb-tools-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const check = (id: string) => ENVIRONMENT.checks!.find((c) => c.id === id)!.argv;
    const tool = (name: string, body: string) => writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const run = async (id: string, env: Record<string, string> = {}) => {
      const [cmd, ...args] = check(id);
      return execFileAsync(cmd!, args, { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ...env } }).then(
        () => ({ code: 0, stderr: "" }),
        (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr.trim() }),
      );
    };
    try {
      expect(await run("ocr")).toEqual({ code: 127, stderr: "open-code-review (ocr) is not installed" });
      expect(await run("claude")).toEqual({ code: 127, stderr: "Claude Code (claude) is not installed" });

      await tool("ocr", 'case "$1" in version) exit 0;; llm) exit 1;; esac');
      expect(await run("ocr")).toEqual({ code: 1, stderr: "ocr llm test failed: configure a model with ocr config" });
      await tool("ocr", "exit 0");
      expect((await run("ocr")).code).toBe(0);

      // Logged in only for the config dir the harness would use.
      await tool("claude", `case "$1" in --version) exit 0;; auth) [ "$CLAUDE_CONFIG_DIR" = "${root}/claude" ];; esac`);
      expect(await run("claude")).toEqual({ code: 1, stderr: "Claude Code is not logged in: run claude auth login" });
      expect(await run("claude", { CLAUDE_CONFIG_DIR: `${root}/other` })).toEqual({ code: 1, stderr: `Claude Code is not logged in for ${root}/other: run claude auth login` });
      expect((await run("claude", { GRAPHLOOM_CLAUDE_CONFIG_DIR: `${root}/claude`, CLAUDE_CONFIG_DIR: `${root}/other` })).code).toBe(0);

      await tool("claude-custom", "exit 0");
      expect((await run("claude", { GRAPHLOOM_CLAUDE_BIN: path.join(bin, "claude-custom") })).code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans, reviews the plan, fixes, checks, reviews the code and delivers #14111", () => {
    const { decision, jobs } = simulate({});
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });

    const [issue, comments, plan, planReview, implement, candidate, red, codeReview, deliver] = jobs;
    expect(issue!.executor!.id).toBe("graphloom.github/get-issue");
    expect(issue!.input).toMatchObject({ owner: "apache", repo: "skywalking", number: ISSUE });
    expect(comments!.executor!.id).toBe("graphloom.github/list-issue-comments");

    expect(plan).toMatchObject({ jobId: "implementer", kind: "agent", purpose: "diagnostic", readOnly: true, input: { harness: "claude-code" } });
    expect(plan!.continueFrom).toBeUndefined();
    expect(assignment(plan)).toContain("It should not be an error.");
    expect(assignment(plan)).toContain("names each caller and lifecycle path that depends on the old behaviour");

    expect(planReview).toMatchObject({ stageId: "fix", kind: "agent", purpose: "review", readOnly: true, input: { harness: "pi", resultSchema: "review-verdict-v1" } });
    expect(planReview!.jobId).toBeUndefined();
    expect(planReview!.continueFrom).toBeUndefined();
    expect(assignment(planReview)).toContain(PLAN.summary);
    expect(assignment(planReview)).toContain("- reach:");

    expect(implement).toMatchObject({ jobId: "implementer", purpose: "work", continueFrom: "op-2", input: { harness: "claude-code" } });
    expect(implement!.writeScope).toEqual([".", "!api/proto", "!go.mod", "!go.sum", "!.github"]);

    expect(candidate).toMatchObject({ kind: "command", readOnly: true, checkout: { from: "candidate" } });
    const ids = (candidate!.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    expect(ids).toEqual(["changes-diff", "regression", "test-ci", "license-check", "build", "lint", "check"]);
    expect(red).toMatchObject({ checkout: { from: "base", paths: ["pkg/timestamp/scheduler_test.go"] } });
    const redArgv = (red!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(redArgv).toEqual(regressionArgv({ package: "./pkg/timestamp", name: TEST }));

    expect(codeReview).toMatchObject({ stageId: "review", kind: "command", purpose: "review", readOnly: true, checkout: { from: "candidate" } });
    const [review] = (codeReview!.input as { commands: Array<{ id: string; argv: string[] }> }).commands;
    expect(review!.id).toBe(COMMAND.codeReview);
    expect(review!.argv).toContain(OCR_RULE);
    expect(review!.argv.join(" ")).toContain(PLAN.summary);

    const { branch, message, body } = deliverArgs(jobs);
    expect(branch).toBe(`fix/${ISSUE}`);
    expect(deliver!.purpose).toBe("diagnostic");
    expect(message).toBe(`${PLAN.title}\n\n${PLAN.summary}\n\nFixes apache/skywalking#${ISSUE}`);
    expect(body).toContain(`### Fix apache/skywalking#${ISSUE}: Scheduler reports long actions as timed out`);
    expect(body).toContain("- Should TotalTasksTimeout keep counting actions that are still running?");
    expect(body).toContain("- What to do at five minutes: warn and wait.");
    expect(body).toContain("Reviewed with open-code-review with MiniMax-M3: no comments.");
    expect(body).toContain(`Fixes apache/skywalking#${ISSUE}.`);
    expect(`${message}\n${body}`).not.toMatch(/rcpt|receipt|ev-\d/);
    expect(decision.reason).toMatch(/pull request body is the report of evidence ev-\d+/);
  });

  it("returns the plan reviewer's findings to the planner's session and reviews the revision afresh", () => {
    const revised: DecisionRecord = { ...PLAN, summary: "Warn at the timeout, keep Close bounded by cancelling on shutdown." };
    const finding = { axis: "reach", severity: "blocking", detail: "Scheduler.Close waits for trigger, which never returns for an action that ignores cancellation." };
    const { decision, jobs } = simulate({
      plans: [PLAN, revised],
      planReviews: [{ verdict: "request_changes", summary: "the plan misses the shutdown path", findings: [finding] }, { verdict: "approved", summary: "ok" }],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const plans = jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent");
    const planReviews = jobs.filter((j) => j.purpose === "review" && j.kind === "agent");
    expect(plans).toHaveLength(2);
    expect(planReviews).toHaveLength(2);
    expect(plans[1]).toMatchObject({ jobId: "implementer", readOnly: true, continueFrom: "op-2" });
    expect(assignment(plans[1])).toContain(`reach (blocking): ${finding.detail}`);
    expect(assignment(plans[1])).not.toContain("working tree holds your previous change");
    expect(planReviews[1]!.continueFrom).toBeUndefined();
    expect(assignment(planReviews[1])).toContain(revised.summary);
    expect(assignment(planReviews[1])).toContain(`The plan was revised because of:\n- The plan reviewer sent your plan back: the plan misses the shutdown path`);
    const implement = jobs.find((j) => j.purpose === "work")!;
    expect(implement.continueFrom).toBe("op-4");
    expect(assignment(implement)).toContain(revised.summary);
  });

  it("hands a plan the reviewer keeps sending back to the supervisor", () => {
    const { decision, jobs } = simulate({ planReviews: [{ verdict: "request_changes", summary: "still misses Close" }] });
    expect(decision.action).toMatchObject({ type: "supervise" });
    expect((decision.action as { supervise: { reason: string } }).supervise.reason).toContain("sent the plan back 3 times");
    expect(jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent")).toHaveLength(3);
    expect(jobs.some((j) => j.purpose === "work")).toBe(false);
  });

  it("stops at the plan with the draft question when a maintainer must decide", () => {
    const { decision, jobs } = simulate({
      plans: [{ status: "blocked", summary: "The API shape is a product decision.", decisions: [], openQuestions: ["Which API?"], draftComment: "Should the new API be X or Y?" }],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "needs maintainer decision", blocker: "Should the new API be X or Y?" } });
    expect(jobs.some((j) => j.purpose === "work" || j.purpose === "review")).toBe(false);
  });

  it("stops with the plan reviewer's question when the plan depends on a product decision", () => {
    const { decision, jobs } = simulate({ planReviews: [{ verdict: "request_changes", summary: "changes the metric", productDecision: "Should the metric change?" }] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "needs maintainer decision", blocker: "Should the metric change?" } });
    expect(jobs.some((j) => j.purpose === "work")).toBe(false);
  });

  it("delivers an approved plan and asks the reviewer's product question in the pull request", () => {
    const question = "Should the timeout become configurable per task?";
    const { decision, jobs } = simulate({ planReviews: [{ verdict: "approved", summary: "ok", productDecision: question }] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(deliverArgs(jobs).body).toContain(`- ${question}`);
    expect(deliverArgs(jobs).message).not.toContain(question);
  });

  it("hands a high code-review comment to the supervisor instead of delivering", () => {
    const { decision, jobs } = simulate({ codeReviews: [{ report: ocrReport("complete", [HANG]) }] });
    expect(decision.action).toMatchObject({ type: "supervise" });
    const reason = (decision.action as { supervise: { reason: string } }).supervise.reason;
    expect(reason).toContain("1 critical or high comment(s)");
    expect(reason).toContain("pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(jobs.some((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver)).toBe(false);
  });

  it("does not pass a code review that failed or did not cover every file", () => {
    for (const run of [{ exitCode: 1, report: '{"GraphLoomOcr":{"missing":true}}' }, { report: ocrReport("partial") }, { report: ocrReport("complete", [{ ...HANG, severity: undefined }]) }]) {
      const { decision } = simulate({ codeReviews: [run] });
      expect(decision.action).toMatchObject({ type: "supervise" });
    }
  });

  it("delivers with lower-severity code-review comments left for the maintainers", () => {
    const { decision, jobs } = simulate({ codeReviews: [{ report: ocrReport("complete", [{ ...HANG, severity: "low" }]) }] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(deliverArgs(jobs).body).toContain("no critical or high comments; 1 lower-severity comment(s) left for the reviewer.");
  });

  it("revisits the plan with the code review's findings when the supervisor re-enters Fix", () => {
    const { decision, jobs } = simulate({ reenter: 1, codeReviews: [{ report: ocrReport("complete", [HANG]) }, { report: ocrReport("complete") }] });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const plans = jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent");
    const work = jobs.filter((j) => j.purpose === "work");
    expect(plans).toHaveLength(2);
    expect(work).toHaveLength(2);
    const revisit = assignment(plans[1]);
    expect(revisit).toContain("The working tree holds your previous change");
    expect(revisit).toContain("Code review of your previous change did not pass (open-code-review status complete, 1 critical or high comment(s))");
    expect(revisit).toContain("Close now waits forever");
    // The revisited plan continues the implementer's session and is reviewed again before implementing.
    const implementOp = `op-${jobs.indexOf(work[0]!)}`;
    expect(plans[1]!.continueFrom).toBe(implementOp);
    const planReviews = jobs.filter((j) => j.purpose === "review" && j.kind === "agent");
    expect(planReviews).toHaveLength(2);
    expect(assignment(planReviews[1])).toContain("Close now waits forever");
    expect(jobs.indexOf(planReviews[1]!)).toBeLessThan(jobs.indexOf(work[1]!));
  });

  it("hands the planner and the plan reviewer a long issue whole, with its latest maintainer answer", () => {
    const answer = "Maintainer answer: keep the action running and warn once.";
    const { decision, jobs } = simulate({
      issueBody: `Backups longer than five minutes are reported as action timed out.\n${"log line\n".repeat(4_000)}`,
      comments: [
        { author: "reporter", createdAt: "2026-09-01", body: "Maybe cancel it at five minutes?" },
        { author: "maintainer", createdAt: "2026-09-02", body: answer },
      ],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    for (const job of [jobs.find((j) => j.purpose === "diagnostic" && j.kind === "agent")!, jobs.find((j) => j.purpose === "review" && j.kind === "agent")!]) {
      const assignment = (job.input as { assignment: string }).assignment;
      expect(assignment.length).toBeGreaterThan(36_000);
      expect(assignment).toContain(answer);
      expect(assignment).not.toContain("truncated");
    }
  });

  it("stops before any agent when the issue snapshot cannot be handed over whole", () => {
    const incomplete = simulate({ commentsComplete: false });
    expect(incomplete.decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringContaining("more comments than the run fetched") } });
    expect(incomplete.jobs.filter((j) => j.kind === "agent")).toEqual([]);

    const huge = simulate({ issueBody: "x".repeat(MAX_SNAPSHOT_CHARS + 1) });
    expect(huge.decision.action).toMatchObject({ type: "stop", stop: { reason: "incompatible task", blocker: expect.stringContaining(`more than the ${MAX_SNAPSHOT_CHARS}`) } });
    expect(huge.jobs.filter((j) => j.kind === "agent")).toEqual([]);
  });

  it("reviews and delivers the accepted fix after a resume", () => {
    const { decision, jobs } = simulate({ resumeAfterFix: true });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    expect(jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent")).toHaveLength(1);
    const codeReview = jobs.find((j) => j.kind === "command" && j.purpose === "review")!;
    expect(codeReview.checkout).toEqual({ from: "candidate" });
    expect(deliverArgs(jobs).body).toContain(`- ${TEST} in \`./pkg/timestamp\` fails by assertion on base-sha`);
  });

  it("returns a failing check's output to the implementer, who continues its session", () => {
    const { decision, jobs } = simulate({
      candidate: [{ [COMMAND.lint]: { exitCode: 2, stderr: "scheduler.go:12: unused variable" } }, {}],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const work = jobs.filter((j) => j.purpose === "work");
    expect(work).toHaveLength(2);
    const correction = (work[1]!.input as { assignment: string }).assignment;
    expect(correction).toContain("lint exited 2");
    expect(correction).toContain("scheduler.go:12: unused variable");
    expect(work[0]!.continueFrom).toBe("op-2");
    expect(work[1]!.continueFrom).toBe("op-4");
    // Checks rerun for the corrected change.
    expect(jobs.filter((j) => j.checkout?.from === "candidate" && j.purpose === "check")).toHaveLength(2);
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

  it("does not accept a RED test that fails to build on the base", () => {
    const { jobs } = simulate({ red: { exitCode: 2, report: events({ ImportPath: "p [p.test]", Action: "build-fail" }) } });
    const correction = (jobs.filter((j) => j.purpose === "work")[1]!.input as { assignment: string }).assignment;
    expect(correction).toContain("does not build on the base commit");
  });

  it("hands the run to the supervisor after two corrections", () => {
    const failing = { [COMMAND.build]: { exitCode: 1, stderr: "undefined: x" } };
    const { decision, jobs } = simulate({ candidate: [failing, failing, failing] });
    expect(decision.action.type).toBe("supervise");
    expect(jobs.filter((j) => j.purpose === "work")).toHaveLength(3);
  });

  it("rejects a request that names no issue", () => {
    expect(requestedIssue("Fix the scheduler.")).toBeUndefined();
    expect(requestedIssue("Fix apache/skywalking#14111.\nDecisions: see #1")).toBe(14111);
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
    expect(regressionOutcome(FAILED, { name: TEST, focus: "ignored in a plain package" })).toBe("failed");
    expect(ginkgoSpecs(ginkgo([{ state: "failed", failureNode: "It" }]))!.map((s) => s.text)).toEqual(["scheduler warns"]);
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
      expect(await run("./pkg/plain", "a long description of the test")).toBe(`test -json -count=1 -run ^${TEST}$ ./pkg/plain`);
      const suiteReport = path.join(root, "pkgsuite.out");
      expect((await run("./pkg/suite", "warns while running")).split("\n")[0]).toBe(
        `test -json -count=1 -run ^${TEST}$ ./pkg/suite -args -ginkgo.focus=warns while running -ginkgo.json-report=${suiteReport}.ginkgo`,
      );
      expect(await run("./pkg/suite")).toBe(`test -json -count=1 -run ^${TEST}$ ./pkg/suite`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("open-code-review command", () => {
  const issue = { number: ISSUE, title: "Scheduler reports long actions as timed out", state: "open", url: "u", labels: [], body: "x".repeat(10_000) };

  it("keeps the background within open-code-review's recommended size and every argument within the command executor's limit", () => {
    const background = reviewBackground(issue, PLAN);
    expect(background.length).toBeLessThanOrEqual(2_000);
    expect(background).toContain(PLAN.summary);
    expect(background).toContain("- What to do at five minutes: warn and wait");
    const argv = codeReviewCommands(background)[0]!.argv;
    expect(argv.length).toBeLessThanOrEqual(64);
    for (const arg of argv) expect(arg.length).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(OCR_RULE)).toMatchObject({ include: ["**/*_test.go"], rules: [{ path: "**/*.go", merge_system_rule: true }] });
  });

  it.skipIf(REAL_GO === "")("runs ocr on HEAD with the rule and background, and reduces its result without the model's reasoning", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bydb-ocr-"));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const comments = [
      ...Array.from({ length: 40 }, (_, i) => ({ path: "a.go", start_line: i + 1, end_line: i + 1, severity: "low", category: "style", content: `nit ${i}`, thinking: "private reasoning" })),
      { ...HANG, thinking: "private reasoning", content: `${HANG.content} ${"y".repeat(2_000)}` },
    ];
    const result = { status: "complete", llm: { provider: "minimax-cn", model: "MiniMax-M3" }, message: "done", summary: { files_reviewed: 3, total_tokens: 10 }, comments, warnings: [{ file: "a.go", type: "tool", message: "file_read failed" }] };
    // Stands in for ocr: keeps its arguments and the rule and background it was given, then writes the result; `go run` stays real.
    await writeFile(
      path.join(bin, "ocr"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/args"\nwhile [ $# -gt 0 ]; do case "$1" in --rule) cp "$2" "${root}/rule.json";; --background-file) cp "$2" "${root}/background.md";; --output) out="$2";; esac; shift; done\nprintf '%s' '${JSON.stringify(result)}' > "$out"\necho "review done" >&2\n`,
      { mode: 0o755 },
    );
    const report = path.join(root, "code-review.out");
    const background = reviewBackground(issue, PLAN);
    try {
      const [cmd, ...args] = codeReviewCommands(background)[0]!.argv;
      const { stderr } = await execFileAsync(cmd!, args, { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GRAPHLOOM_REPORT_FILE: report } });
      expect(stderr).toContain("review done");
      const passed = (await readFile(path.join(root, "args"), "utf8")).trim().split("\n");
      expect(passed.slice(0, 10)).toEqual(["review", "--commit", "HEAD", "--format", "json", "--audience", "agent", "--effort", "high", "--rule"]);
      expect(passed).toContain("--max-tokens-budget");
      expect(await readFile(path.join(root, "rule.json"), "utf8")).toBe(OCR_RULE);
      expect((await readFile(path.join(root, "background.md"), "utf8")).trim()).toBe(background.trim());

      const text = await readFile(report, "utf8");
      expect(text).not.toContain("private reasoning");
      const parsed = parseOcrReport(text);
      if ("problem" in parsed) throw new Error(parsed.problem);
      expect(parsed.report).toMatchObject({ status: "complete", model: "MiniMax-M3", commentCount: 41, warnings: [{ message: "file_read failed" }] });
      expect(parsed.report.comments).toHaveLength(30);
      expect(parsed.report.comments[0]).toMatchObject({ path: HANG.path, start_line: 88, severity: "high" });
      expect(parsed.report.comments[0]!.content.length).toBeLessThan(1_300);
      expect(blockingComments(parsed.report)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
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
