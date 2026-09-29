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
  QUALIFICATION_CASES,
  advanceFix,
  createGraph,
  ginkgoSpecs,
  qualifyValidators,
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
  plan?: DecisionRecord;
  /** The implementer's result for each implement job, in order. */
  implement?: Array<DecisionRecord | undefined>;
  /** Command outcomes in the candidate checkout for each candidate job, by command id. */
  candidate?: Array<Partial<Record<string, CommandResult>>>;
  candidateMutations?: string[][];
  red?: CommandResult;
  review?: Record<string, unknown>;
  changes?: string;
  /** Bump the generation once Fix is accepted, as an operator's resume does. */
  resumeAfterFix?: boolean;
  issueBody?: string;
  comments?: Array<{ author: string; createdAt: string; body: string }>;
  /** Whether the comment listing reached its last page. */
  commentsComplete?: boolean;
}

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
  let seq = 0;
  let generation = 1;
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
      if (job.purpose === "diagnostic") output = scenario.plan ?? PLAN;
      else if (job.purpose === "work") {
        output = scenario.implement?.[implemented] ?? PLAN;
        implemented += 1;
        digest = `d${implemented}`;
      } else if (job.purpose === "review") {
        record("other", { codingAgent: { status: "completed", output: scenario.review ?? { verdict: "approved", summary: "ok" } } }, job, op);
        record("review", scenario.review ?? { verdict: "approved", summary: "ok" }, job, op);
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
      activeVersion: "banyandb-fix@0.1.0",
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
      const results = stage.requirementIds.map((requirementId) => {
        const binding = definition.defaultValidators.find((b) => b.requirementId === requirementId)!;
        return { requirementId, binding, result: validatorById(binding.validatorId)!.evaluate({ requirementId, statement: "s", evidence, candidateDigest: digest }) };
      });
      const failure = results.find((r) => r.result.status !== "passed");
      if (failure !== undefined) throw new Error(`validate ${stage.id} failed: ${failure.requirementId}: ${failure.result.reason}`);
      for (const r of results) receipts.push({ id: `rcpt-${receipts.length + 1}`, stageId: stage.id, requirementId: r.requirementId, validatorBinding: r.binding, candidateFingerprint: "fp", evidenceRefs: [], valid: true, candidateDigest: digest });
      if (scenario.resumeAfterFix === true && stage.id === "fix") generation += 1;
    } else {
      return { decision, decisions, jobs, evidence, receipts };
    }
  }
  throw new Error("the graph did not finish in 60 steps");
}

const summaries = (decisions: GraphDecision[]) => decisions.map((d) => d.action.type);

describe("banyandb-fix graph", () => {
  it("declares the contributor checklist the controller checks before any job", () => {
    const definition = createGraph().describe();
    expect(definition.stages.map((s) => s.id)).toEqual(["fix", "review"]);
    expect(definition.environment).toEqual(ENVIRONMENT);
    expect(ENVIRONMENT.checks!.map((c) => c.id)).toEqual(["go", "git", "make", "check-req"]);
    expect(ENVIRONMENT.prepare!.map((c) => c.argv.join(" "))).toEqual(["make generate"]);
    expect(ENVIRONMENT.pinnedFiles![0]!.path).toBe("CONTRIBUTING.md");
  });

  it("fixes, checks, reviews and delivers #14111", () => {
    const { decision, jobs } = simulate({});
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });

    const [issue, comments, plan, implement, candidate, red, review, deliver] = jobs;
    expect(issue!.executor!.id).toBe("graphloom.github/get-issue");
    expect(issue!.input).toMatchObject({ owner: "apache", repo: "skywalking", number: ISSUE });
    expect(comments!.executor!.id).toBe("graphloom.github/list-issue-comments");

    expect(plan).toMatchObject({ jobId: "implementer", kind: "agent", purpose: "diagnostic", readOnly: true, input: { harness: "claude-code" } });
    expect((plan!.input as { assignment: string }).assignment).toContain("It should not be an error.");
    expect(implement).toMatchObject({ jobId: "implementer", purpose: "work", continueFrom: "op-2", input: { harness: "claude-code" } });
    expect(implement!.writeScope).toEqual([".", "!api/proto", "!go.mod", "!go.sum", "!.github"]);

    expect(candidate).toMatchObject({ kind: "command", readOnly: true, checkout: { from: "candidate" } });
    const ids = (candidate!.input as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    expect(ids).toEqual(["changes-diff", "regression", "test-ci", "license-check", "build", "lint", "check"]);
    expect(red).toMatchObject({ checkout: { from: "base", paths: ["pkg/timestamp/scheduler_test.go"] } });
    const redArgv = (red!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(redArgv).toEqual(regressionArgv({ package: "./pkg/timestamp", name: TEST }));

    expect(review).toMatchObject({ purpose: "review", readOnly: true, input: { harness: "pi", resultSchema: "review-verdict-v1" } });
    expect(review!.continueFrom).toBeUndefined();

    const argv = (deliver!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
    expect(argv[4]).toBe(`fix/${ISSUE}`);
    const message = argv.slice(5).join("");
    expect(message).toContain(`Fixes apache/skywalking#${ISSUE}`);
    expect(message).toContain("Should TotalTasksTimeout keep counting actions that are still running?");
    expect(message).toMatch(/RED: .* \(receipt rcpt-\d+\)/);
  });

  it("hands the planner and the reviewer a long issue whole, with its latest maintainer answer", () => {
    const answer = "Maintainer answer: keep the action running and warn once.";
    const { decision, jobs } = simulate({
      issueBody: `Backups longer than five minutes are reported as action timed out.\n${"log line\n".repeat(4_000)}`,
      comments: [
        { author: "reporter", createdAt: "2026-09-01", body: "Maybe cancel it at five minutes?" },
        { author: "maintainer", createdAt: "2026-09-02", body: answer },
      ],
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    for (const job of [jobs.find((j) => j.purpose === "diagnostic" && j.kind === "agent")!, jobs.find((j) => j.purpose === "review")!]) {
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
    const review = jobs.find((j) => j.purpose === "review")!;
    const assignment = (review.input as { assignment: string }).assignment;
    expect(assignment).toContain(PLAN.summary);
    expect(assignment).toMatch(/regression in the candidate checkout: regression exited 0/);
    const deliver = jobs.at(-1)!;
    const message = (deliver.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv.slice(5).join("");
    expect(message).toContain(`- RED: ${TEST} in ./pkg/timestamp fails by assertion on base-sha`);
  });

  it("stops at the plan with the draft question when a maintainer must decide", () => {
    const { decision, jobs } = simulate({
      plan: { status: "blocked", summary: "The API shape is a product decision.", decisions: [], openQuestions: ["Which API?"], draftComment: "Should the new API be X or Y?" },
    });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "needs maintainer decision", blocker: "Should the new API be X or Y?" } });
    expect(jobs.some((j) => j.purpose === "work")).toBe(false);
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
    expect(work[1]!.continueFrom).toBe("op-3");
    // Checks rerun for the corrected change.
    expect(jobs.filter((j) => j.checkout?.from === "candidate")).toHaveLength(2);
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

  it("stops with the reviewer's question when a choice is really a product decision", () => {
    const { decision } = simulate({ review: { verdict: "request_changes", summary: "changes the metric", productDecision: "Should the metric change?" } });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "needs maintainer decision", blocker: "Should the metric change?" } });
  });

  it("delivers an approved change and asks the reviewer's product question in the pull request", () => {
    const question = "Should the timeout become configurable per task?";
    const { decision, jobs } = simulate({ review: { verdict: "approved", summary: "ok", productDecision: question } });
    expect(decision.action).toMatchObject({ type: "stop", stop: { reason: "complete" } });
    const deliver = jobs.find((j) => (j.input as { commands?: Array<{ id: string }> }).commands?.[0]?.id === COMMAND.deliver)!;
    const message = (deliver.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv.slice(5).join("");
    expect(message).toContain(`- ${question}`);
  });

  it("hands requested changes to the supervisor", () => {
    const { decision } = simulate({ review: { verdict: "request_changes", summary: "use run.Go", findings: [{ axis: "standards", severity: "blocking", detail: "raw goroutine" }] } });
    expect(decision.action).toMatchObject({ type: "supervise" });
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
