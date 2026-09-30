import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { AgentSessionView, EvidenceRecord, GraphDecision, JobSpec, Receipt, RunView, Validator } from "@graphloom/sdk";
import {
  CHANGES_PATH,
  CODE_REVIEW_SCHEMA,
  COMMAND,
  ENVIRONMENT,
  candidateCommands,
  MAX_SNAPSHOT_CHARS,
  QUALIFICATION_CASES,
  VERIFICATION_SCHEMA,
  advanceFix,
  blockingComments,
  codeReviewInstruction,
  createGraph,
  findingLedger,
  ginkgoSpecs,
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
  /** The code reviewer's result for each review, in order; the last repeats. */
  codeReviews?: Array<{ output: unknown; status?: string }>;
  /** The verifier's result for each verification, in order; the last repeats. By default it confirms every finding it is given. */
  verifications?: Array<{ output: unknown; status?: string }>;
  /** Bytes an observation records for each path; CHANGES.md defaults to `changes`, anything else to empty. */
  files?: Record<string, string>;
  /** What the environment check printed for ocr; null records no passing check. */
  ocrPath?: string | null;
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
  let implemented = 0;
  let candidates = 0;
  let planned = 0;
  let planReviewed = 0;
  let codeReviewed = 0;
  let verified = 0;
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
  if (scenario.ocrPath !== null) {
    const stdoutTail = `${scenario.ocrPath ?? OCR}\n`;
    record("command", { command: { id: "ocr", argv: ["sh"], exitCode: 0, stdoutTail, stderrTail: "" }, environment: { phase: "preflight" } }, undefined, "env-0");
  }
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
      if (job.purpose === "diagnostic" && job.stageId === "review") {
        const ids = [...assignment(job).matchAll(/^- (F\d+) /gm)].map((m) => m[1]!);
        const confirmAll = verdicts(...ids.map((finding) => ({ finding, verdict: "confirmed", quotes: [{ path: "pkg/timestamp/scheduler.go", line: 7, text: "s.wait(ctx)" }] })));
        const result: { output: unknown; status?: string } = nth(scenario.verifications, verified++) ?? confirmAll;
        record("other", { codingAgent: { harness: "claude-code", status: result.status ?? "completed", output: result.output } }, job, op);
        return;
      }
      if (job.purpose === "diagnostic") output = nth(scenario.plans, planned++) ?? PLAN;
      else if (job.purpose === "work") {
        output = scenario.implement?.[implemented] ?? nth(scenario.plans, planned - 1) ?? PLAN;
        implemented += 1;
        digest = `d${implemented}`;
      } else if (job.purpose === "review" && job.stageId === "review") {
        const result = nth(scenario.codeReviews, codeReviewed++) ?? reviewed();
        record("other", { codingAgent: { harness: "codex", status: result.status ?? "completed", output: result.output } }, job, op);
        return;
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
      activeVersion: "banyandb-fix@0.3.0",
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
      for (const p of action.observe.paths ?? []) {
        observed.push(p);
        record("file", { path: p, bytes: p === CHANGES_PATH ? (scenario.changes ?? CHANGES) : (scenario.files?.[p] ?? "") }, undefined, op);
      }
    } else if (action.type === "validate") {
      const stage = definition.stages.find((s) => s.id === action.validate.stageId)!;
      const visible = candidateEvidence(evidence, generation);
      const history = evidence.filter((e) => e.generation! < generation);
      const results = stage.requirementIds.map((requirementId) => {
        const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
        return { requirementId, binding, result: validatorById(binding.validatorId)!.evaluate({ requirementId, statement: "s", evidence: visible, history, candidateDigest: digest }) };
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
      return { decision, decisions, jobs, evidence, receipts, observed };
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
    expect(ENVIRONMENT.checks!.map((c) => c.id)).toEqual(["go", "git", "ocr", "codex", "claude", "make", "check-req"]);
    expect(ENVIRONMENT.prepare!.map((c) => c.argv.join(" "))).toEqual(["make generate"]);
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canopy-node: Node.js is required only when the candidate touches ui/ or mcp/", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bydb-canopy-"));
    try {
      const repo = path.join(root, "repo");
      await mkdir(path.join(repo, "pkg"), { recursive: true });
      const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
      await writeFile(path.join(repo, "pkg", "a.go"), "package pkg\n");
      await git("init", "-q", "-b", "main");
      await git("config", "user.email", "a@example.com");
      await git("config", "user.name", "A");
      await git("add", ".");
      await git("commit", "-q", "-m", "base");

      const { argv } = candidateCommands(PLAN.test!).find((c) => c.id === COMMAND.canopyNode)!;
      // A PATH with only git and sed, so the host's own Node (if any) never leaks in.
      const tools = path.join(root, "tools");
      await mkdir(tools);
      for (const [name, real] of Object.entries({ sh: "/usr/bin/sh", git: "/usr/bin/git", sed: "/usr/bin/sed", grep: "/usr/bin/grep" })) {
        await execFileAsync("ln", ["-s", real, path.join(tools, name)]);
      }
      const bin = path.join(root, "bin");
      await mkdir(bin);
      const node = (body: string) => writeFile(path.join(bin, "node"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      const run = async (extraPath?: string) =>
        execFileAsync(argv[0]!, argv.slice(1), { cwd: repo, env: { PATH: `${extraPath ? `${extraPath}:` : ""}${tools}` } }).then(
          () => ({ code: 0, stderr: "" }),
          (err: { code: number; stderr: string }) => ({ code: err.code, stderr: err.stderr.trim() }),
        );

      // No candidate change under ui/ or mcp/: passes without Node on PATH.
      await writeFile(path.join(repo, "pkg", "a.go"), "package pkg\n\nconst x = 1\n");
      await git("commit", "-qam", "touch pkg only");
      expect(await run()).toEqual({ code: 0, stderr: "" });

      // The candidate touches ui/: Node is required.
      await mkdir(path.join(repo, "ui"), { recursive: true });
      await writeFile(path.join(repo, "ui", "app.ts"), "export const x = 1;\n");
      await git("add", ".");
      await git("commit", "-q", "-m", "touch ui");
      expect(await run()).toMatchObject({ code: 127, stderr: "the change touches ui/ or mcp/ (Canopy); Node.js >= 24.6.0 is required but node was not found" });

      await node("echo v20.0.0");
      expect(await run(bin)).toMatchObject({ code: 1, stderr: "the change touches ui/ or mcp/ (Canopy); Node.js >= 24.6.0 required, found v20.0.0" });

      await node("echo v24.6.0");
      expect(await run(bin)).toEqual({ code: 0, stderr: "" });
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
    expect(ids).toEqual(["changes-diff", "regression", "test-ci", "license-check", "build", "lint", "check", "canopy-node"]);
    expect(red).toMatchObject({ checkout: { from: "base", paths: ["pkg/timestamp/scheduler_test.go"] } });
    const redArgv = (red!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(redArgv).toEqual(regressionArgv({ package: "./pkg/timestamp", name: TEST }));

    expect(codeReview).toMatchObject({
      stageId: "review",
      kind: "agent",
      purpose: "review",
      readOnly: true,
      input: { harness: "codex", resultSchema: CODE_REVIEW_SCHEMA },
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

  it("returns the plan reviewer's findings to the planner's session and reviews the revision afresh", () => {
    const revised: DecisionRecord = { ...PLAN, summary: "Warn at the timeout, keep Close bounded by cancelling on shutdown." };
    const finding = { axis: "reach", severity: "blocking", detail: "Scheduler.Close waits for trigger, which never returns for an action that ignores cancellation." };
    const { decision, jobs } = simulate({
      plans: [PLAN, revised],
      planReviews: [{ verdict: "request_changes", summary: "the plan misses the shutdown path", findings: [finding] }, { verdict: "approved", summary: "ok" }],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const plans = jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent");
    const planReviews = jobs.filter((j) => j.purpose === "review" && j.stageId === "fix");
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

  it("verifies a high comment, sweeps once more for new ones, and hands the confirmed finding to the supervisor", () => {
    const { decision, jobs } = simulate({ codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" })] });
    expect(decision.action).toMatchObject({ type: "supervise" });
    const reason = (decision.action as { supervise: { reason: string } }).supervise.reason;
    expect(reason).toContain("1 critical or high finding(s) confirmed or disputed: F1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(reason).toContain("passes on this change: 2 (sweep saturated); 0 fixed, 0 dismissed, 1 new confirmed, 0 regression(s), 0 disputed");
    expect(reason).toMatch(/\d+ agent invocation\(s\) left/);
    expect(jobs.some((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver)).toBe(false);

    const review = jobs.filter((j) => j.stageId === "review");
    expect(review.map((j) => `${j.purpose}:${(j.input as { harness: string }).harness}`)).toEqual(["review:codex", "diagnostic:claude-code", "review:codex"]);
    const verification = review[1]!;
    expect(verification).toMatchObject({ kind: "agent", readOnly: true, resultSchema: "finding-verification-v1", input: { resultSchema: VERIFICATION_SCHEMA } });
    expect(verification.jobId).toBeUndefined();
    expect(verification.continueFrom).toBeUndefined();
    expect(assignment(verification)).toContain("- F1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(assignment(verification)).toContain("- pkg/timestamp/scheduler_test.go");
    // The sweep pass knows F1 by name, owes it a status, and looks for issues beyond it.
    expect(assignment(review[2])).toContain("- F1 (confirmed) pkg/timestamp/scheduler.go:88-95");
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
    expect(body).toContain("  - F1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever for an action that ignores cancellation. Verifier: Close bounds the wait with closeTimeout.");
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
    expect(reason).toContain("F1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever for an action that ignores cancellation. Verifier: the timeout may not cover wait");
    expect(reason).toContain("F2 pkg/timestamp/scheduler.go:120-121 (high, bug): trigger leaks the timer. Verifier: the verifier gave no verdict");
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

  it("does not pass a code review that failed or did not cover every file", () => {
    for (const run of [
      { output: null, status: "failed" },
      reviewed([], { total_files: 3, reviewed_files: 2, skipped: [] }),
      reviewed([], { total_files: 3, reviewed_files: 3, skipped: [{ path: "pkg/timestamp/scheduler_test.go", reason: "too long" }] }),
      reviewed([{ ...HANG, severity: undefined }]),
    ]) {
      const { decision } = simulate({ codeReviews: [run] });
      expect(decision.action).toMatchObject({ type: "supervise" });
    }
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

  it("revisits the plan with the confirmed findings when the supervisor re-enters Fix, and fixes them on the new change", () => {
    const { decision, jobs } = simulate({
      reenter: 1,
      codeReviews: [reviewed([HANG]), priorPass({ F1: "still_present" }), priorPass({ F1: "resolved" })],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const plans = jobs.filter((j) => j.purpose === "diagnostic" && j.kind === "agent" && j.stageId === "fix");
    const work = jobs.filter((j) => j.purpose === "work");
    expect(plans).toHaveLength(2);
    expect(work).toHaveLength(2);
    const revisit = assignment(plans[1]);
    expect(revisit).toContain("The working tree holds your previous change");
    expect(revisit).toContain("Code review of your previous change found 1 critical or high defect(s), each confirmed by an independent verifier:");
    expect(revisit).toContain("F1 pkg/timestamp/scheduler.go:88-95 (high, bug): Close now waits forever");
    expect(revisit).toContain("pkg/timestamp/scheduler.go:7 `s.wait(ctx)`");
    expect(deliverArgs(jobs).body).toContain("no critical or high finding left open (1 fixed during review)");
    // The revisited plan continues the implementer's session and is reviewed again before implementing.
    const implementOp = `op-${jobs.indexOf(work[0]!)}`;
    expect(plans[1]!.continueFrom).toBe(implementOp);
    const planReviews = jobs.filter((j) => j.purpose === "review" && j.stageId === "fix");
    expect(planReviews).toHaveLength(2);
    expect(assignment(planReviews[1])).toContain("Close now waits forever");
    const passes = jobs.filter((j) => j.purpose === "review" && j.stageId === "review");
    expect(passes).toHaveLength(3);
    // The first pass on the new change owes F1 a status and is not a sweep.
    expect(assignment(passes[2])).toContain("- F1 (confirmed) pkg/timestamp/scheduler.go:88-95");
    expect(assignment(passes[2])).not.toContain("An earlier pass");
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
    for (const job of [jobs.find((j) => j.purpose === "diagnostic" && j.kind === "agent")!, jobs.find((j) => j.purpose === "review" && j.stageId === "fix")!]) {
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
    const codeReview = jobs.find((j) => j.stageId === "review" && j.purpose === "review")!;
    expect(codeReview).toMatchObject({ kind: "agent", readOnly: true, input: { harness: "codex" } });
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
    const background = reviewBackground(issue, PLAN);
    expect(background.length).toBeLessThanOrEqual(2_000);
    expect(background).toContain(PLAN.summary);
    expect(background).toContain("- What to do at five minutes: warn and wait");
    const text = codeReviewInstruction({ ocr: "/home/me/.nvm/bin/ocr", base: "abc123", background });
    expect(text).toContain("`/home/me/.nvm/bin/ocr delegate preview --format json`");
    expect(text).toContain("`/home/me/.nvm/bin/ocr delegate rule --format json <path>...`");
    expect(text).toContain("against HEAD (the base commit abc123)");
    expect(text).toContain("Go test files (`_test.go`) are reviewable too");
    expect(text).toContain("a test whose expected value is derived from the new code rather than from the issue");
    expect(text).toContain(background);
    expect(codeReviewInstruction({ ocr: "/it's/ocr", base: "b", background: "" })).toContain(`'/it'\\''s/ocr' delegate preview`);
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
    const text = codeReviewInstruction({ ocr: "ocr", base: "b", background: "", known, sweep: true });
    expect(text).toContain("Give each one a status in `prior`");
    expect(text).toContain("- F2 (confirmed) a.go:3 (high, bug): leak");
    expect(text).toContain("Do not report them again unless the defect is back in the current code; then report it with its name in `finding`.\n- F1 (dismissed) b.go:9 (high, bug): race");
    expect(text).toContain("look for critical or high issues that are not on the list");
    expect(codeReviewInstruction({ ocr: "ocr", base: "b", background: "" })).not.toContain("prior`:");
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

  it("sends a withdrawn confirmation back to verification, and leaves a pass that skips a status incomplete", () => {
    const evidence = [pass("d1", [HANG]), confirm("d1"), pass("d1", [], { F1: "withdrawn" })];
    expect(states(evidence)).toEqual({ F1: "pending@d1" });
    evidence.push(confirm("d1"), pass("d2", []));
    const last = findingLedger(evidence).passes.at(-1)!;
    expect(last.missingStatus).toEqual(["F1"]);
    expect(states(evidence)).toEqual({ F1: "confirmed@d1" });
  });

  it("reads a comment that names an open finding as its status, and one naming an unknown finding as new", () => {
    const evidence = [pass("d1", [HANG, { ...HANG, severity: "medium", content: "naming" }]), confirm("d1"), pass("d1", [{ ...HANG, finding: "F1" }, { ...HANG, finding: "F9" }])];
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

  it("matches a quote within three lines with whitespace collapsed, and observes only safe file paths", () => {
    expect(quoteMatches({ ...BOUNDED, line: 8, text: "ctx,  done :=\tcontext.WithTimeout(context.Background(), s.closeTimeout)" }, SCHEDULER)).toBe(true);
    expect(quoteMatches({ ...BOUNDED, line: 9 }, SCHEDULER)).toBe(false);
    expect(quoteMatches({ ...BOUNDED, text: "done()" }, SCHEDULER)).toBe(false);
    expect(["pkg/timestamp/scheduler.go", ".golangci.yml", "banyand/Makefile.inc"].every(observablePath)).toBe(true);
    for (const p of ["../x.go", "/etc/passwd", "pkg/./x.go", ".git/config", "pkg/timestamp", ".github", "pkg//x.go", "a b.go"]) expect(observablePath(p), p).toBe(false);
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
