/**
 * The end-to-end condition matrix (#144): each graph runs through the real
 * controller, its real child plugin host and the CLI's own runner and
 * supervisor composition, with scripted agents and a fake model provider (no
 * network, no model calls), under one realistic condition at a time. Every
 * condition reproduces a bug a dogfood run found; a cell passes when the run
 * completes, or stops with the reason named for it.
 */
import { realpath } from "node:fs/promises";
import { expect } from "vitest";
import { createController, loadRunState, type RunReport, type RunRequest } from "@graphloom/controller";
import { createBuiltinExecutorRunner, type Runner } from "@graphloom/runner";
import { commandBinding, commandExecutorPackage } from "@graphloom/executor-command";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import {
  EXTREME_BUDGETS,
  FAULTS,
  HELLO_REQUEST,
  ISSUE_FIX_FIXED,
  ISSUE_FIX_ISSUE,
  TRACKED_GRAPHLOOM_FILES,
  bumpBundleVersion,
  copyBundle,
  createIssueFixFixture,
  createTaskWorkspace,
  exampleBundle,
  helloAgents,
  ignoreGraphloomDir,
  prependPath,
  slowBundle,
  startFakeProvider,
  trackUnderGraphloomDir,
  watchProcessWarnings,
  type FakeProvider,
  type ProviderFault,
  type ScriptedAgents,
  type TaskWorkspace,
  type TaskWorkspaceOptions,
  type TestScope,
} from "@graphloom/testkit";
import { commandOptions } from "../../dist/cli-runner.js";
import { piSupervisorFactory } from "../../dist/supervisor-config.js";
import type { RunnerConfig } from "../../src/runner-config.js";

export type GraphName = "hello" | "issue-fix";

/** A graph's fixture: its workspace and the runner the CLI would compose for it, with scripted agents. */
interface Fixture {
  workspace: TaskWorkspace;
  /** A fresh runner (and the agents behind it) for one run or resume. */
  runner(options?: { failWork?: number; onJob?: (seen: number) => Promise<void> }): { runner: Runner; agents: ScriptedAgents };
  /** Graph-specific checks on a completed run. */
  verifyCompleted(report: RunReport): Promise<void>;
}

type WorkspaceShape = Pick<TaskWorkspaceOptions, "layout" | "budgets" | "bundle">;

async function fixture(scope: TestScope, graph: GraphName, shape: WorkspaceShape): Promise<Fixture> {
  if (graph === "hello") {
    const workspace = await createTaskWorkspace(scope, { graph, request: HELLO_REQUEST, ...shape });
    return {
      workspace,
      runner(options = {}) {
        const agents = helloAgents({
          ...(options.failWork !== undefined ? { failWork: options.failWork } : {}),
          ...(options.onJob !== undefined ? { onJob: (_job, _ctx, seen) => options.onJob!(seen) } : {}),
        });
        return { runner: agents, agents };
      },
      async verifyCompleted(report) {
        const state = await loadRunState(report.stateDir);
        expect(state.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["write", "review"]);
      },
    };
  }
  const f = await createIssueFixFixture(scope, shape);
  prependPath(scope, f.binDir);
  const config = f.agentConfig as RunnerConfig;
  return {
    workspace: f,
    runner(options = {}) {
      const agents = f.agents({
        ...(options.failWork !== undefined ? { failWork: options.failWork } : {}),
        ...(options.onJob !== undefined ? { onJob: (_job, _ctx, seen) => options.onJob!(seen) } : {}),
      });
      // As the CLI composes it: the real command and GitHub executors, coding agents behind them.
      const runner = createBuiltinExecutorRunner({
        packages: [
          { manifest: commandExecutorPackage, ...commandBinding(commandOptions(config)) },
          { manifest: githubExecutorPackage, ...githubBinding({ baseUrl: f.github.baseUrl, token: "fake" }) },
        ],
        fallback: agents,
      });
      return { runner, agents };
    },
    async verifyCompleted(report) {
      const state = await loadRunState(report.stateDir);
      expect(state.receipts.filter((r) => r.valid).map((r) => `${r.stageId}/${r.requirementId}`)).toContain("review/code-review");
      // Delivered: a local branch holding the fix, without the graph's own .graphloom/ files.
      const branch = `fix/${ISSUE_FIX_ISSUE}`;
      expect(await f.repo.git("show", `${branch}:pkg/timestamp/scheduler.go`)).toBe(ISSUE_FIX_FIXED.trimEnd());
      expect((await f.repo.git("ls-tree", "-r", "--name-only", branch)).split("\n")).not.toContain(".graphloom/issues.json");
    },
  };
}

/** What a cell asserts once its run is over. */
export interface Outcome {
  graph: GraphName;
  report: RunReport;
  fixture: Fixture;
  provider?: FakeProvider;
}

export interface Condition {
  /** Short id used in test names and the PR table. */
  id: string;
  /** The dogfood bug (fix PR) this condition reproduces. */
  bug: string;
  /** Expected result, as it reads in the matrix. */
  expected: string;
  shape?: (scope: TestScope, graph: GraphName) => Promise<WorkspaceShape>;
  /** Changes to the repository after the workspace exists (committed). */
  setup?: (fixture: Fixture) => Promise<void>;
  /** A supervisor on the fake provider, serving these faults, with a work job failing once to call it. */
  supervisor?: { faults: ProviderFault[]; quotaRetryMs?: number };
  /** Custom drive (default: one run); undefined when it asserted a refused run itself. */
  drive?: (scope: TestScope, graph: GraphName, fixture: Fixture) => Promise<RunReport | undefined>;
  /** Checks beyond the graph's own completion checks; `completes` runs those first. */
  verify(outcome: Outcome): Promise<void>;
  completes: boolean;
}

async function completed(outcome: Outcome): Promise<void> {
  expect(outcome.report.status, `${outcome.report.stopReason}: ${outcome.report.blocker}`).toBe("succeeded");
  await outcome.fixture.verifyCompleted(outcome.report);
}

export const CONDITIONS: Condition[] = [
  {
    id: "baseline",
    bug: "-",
    expected: "completes",
    completes: true,
    async verify() {},
  },
  {
    id: "task in a repository subdirectory (repo: .)",
    bug: "#127",
    expected: "completes; the run pins the repository's top level",
    completes: true,
    shape: async () => ({ layout: "subdirectory" }),
    async verify({ report, fixture: f }) {
      const state = await loadRunState(report.stateDir);
      expect(state.intake.repoPath).toBe(await realpath(f.workspace.repo.path));
    },
  },
  {
    id: "repository ignores .graphloom/",
    bug: "#140",
    expected: "completes (issue-fix delivers its branch)",
    completes: true,
    setup: (f) => ignoreGraphloomDir(f.workspace.repo),
    async verify() {},
  },
  {
    id: "repository tracks files under .graphloom/",
    bug: "#140 (review)",
    expected: "completes; the delivered branch keeps the tracked files",
    completes: true,
    setup: async (f) => {
      await trackUnderGraphloomDir(f.workspace.repo);
    },
    async verify({ graph, fixture: f }) {
      if (graph !== "issue-fix") return;
      const branch = `fix/${ISSUE_FIX_ISSUE}`;
      const tree = (await f.workspace.repo.git("ls-tree", "-r", "--name-only", branch)).split("\n");
      for (const file of Object.keys(TRACKED_GRAPHLOOM_FILES)) expect(tree).toContain(file);
      expect((await f.workspace.repo.git("diff", "--name-only", "HEAD", branch)).split("\n").sort()).toEqual([
        "CHANGES.md",
        "pkg/timestamp/scheduler.go",
        "pkg/timestamp/status_test.go",
      ]);
    },
  },
  {
    id: "30-day activeMs and waitMs budgets",
    bug: "#138",
    expected: "completes without a TimeoutOverflowWarning",
    completes: true,
    shape: async () => ({ budgets: EXTREME_BUDGETS }),
    async drive(scope, _graph, f) {
      const watch = watchProcessWarnings();
      scope.defer(() => watch.dispose());
      const report = await runOnce(f);
      // Warnings are emitted on the next tick.
      await new Promise((r) => setImmediate(r));
      expect(watch.timerOverflows(), "TimeoutOverflowWarning count").toBe(0);
      return report;
    },
    async verify() {},
  },
  {
    id: "plugin version bumped mid-run (resume --update-plugin)",
    bug: "#133",
    expected: "operator stop, then the resume moves to the new version and completes",
    completes: true,
    shape: async (scope, graph) => ({ bundle: await copyBundle(scope, exampleBundle(graph)) }),
    async drive(_scope, _graph, f) {
      const runId = "matrix-bump";
      const controller = createController();
      const first = f.runner({
        onJob: async (seen) => {
          if (seen === 0) await controller.stop(runId, { stateRoot: f.workspace.stateRoot });
        },
      });
      const stopped = await controller.run({ taskPath: f.workspace.taskPath, runner: first.runner, stateRoot: f.workspace.stateRoot, runId });
      expect(stopped, `${stopped.stopReason}: ${stopped.blocker}`).toMatchObject({ status: "stopped", stopReason: "operator stop" });
      const bundle = await realpath(f.workspace.bundlePath);
      const { to } = await bumpBundleVersion(bundle, "9.9.9");
      const resumed = await createController().resume({ runRef: stopped.stateDir, runner: f.runner().runner, updatePlugin: true });
      expect(resumed.status, `${resumed.stopReason}: ${resumed.blocker}`).toBe("succeeded");
      const state = await loadRunState(resumed.stateDir);
      expect(state.activeVersion).toBe(`${state.intake.bundle.graphId}@${to}`);
      return resumed;
    },
    async verify() {},
  },
  {
    id: "slow plugin child (delayed load and stdout)",
    bug: "#137",
    expected: "completes",
    completes: true,
    shape: async (scope, graph) => ({ bundle: await slowBundle(scope, exampleBundle(graph), { loadDelayMs: 300, stdoutDelayMs: 20 }) }),
    async verify() {},
  },
  {
    id: "slow plugin child that fails to load",
    bug: "#137",
    expected: 'refused: "plugin describe failed: failed to load plugin: <its error>"',
    completes: false,
    shape: async (scope, graph) => ({
      bundle: await slowBundle(scope, exampleBundle(graph), { loadDelayMs: 300, stdoutDelayMs: 100, failLoad: "testkit: the plugin's own import failed" }),
    }),
    async drive(_scope, _graph, f) {
      await expect(runOnce(f)).rejects.toThrow(/^plugin describe failed: failed to load plugin: testkit: the plugin's own import failed$/);
      return undefined;
    },
    async verify() {},
  },
  {
    id: "provider: empty-signature thinking",
    bug: "#129",
    expected: "completes; thinking is replayed as thinking, never as text",
    completes: true,
    supervisor: { faults: [FAULTS.emptySignatureThinking] },
    async verify({ provider }) {
      expect(provider!.served).toEqual(["empty-signature-thinking", "decide:return"]);
    },
  },
  {
    id: "provider: tool call billed but dropped",
    bug: "#129",
    expected: "completes; the identical prompt is resent without the dropped reply",
    completes: true,
    supervisor: { faults: [FAULTS.droppedToolCall] },
    async verify({ provider }) {
      expect(provider!.served).toEqual(["dropped-tool-call", "decide:return"]);
    },
  },
  {
    id: "provider: HTTP 500",
    bug: "#139",
    expected: "completes after a backoff",
    completes: true,
    supervisor: { faults: [FAULTS.transient500] },
    async verify({ report, provider }) {
      expect(provider!.served).toEqual(["http-error:500", "decide:return"]);
      const state = await loadRunState(report.stateDir);
      expect(state.remedies?.map((r) => r.condition)).toContain("supervisor provider transient");
    },
  },
  {
    id: "provider: 429 without a reset time",
    bug: "#118/#124",
    expected: 'stops: "supervisor provider quota: 429 ..." (not remedied: no reset time)',
    completes: false,
    supervisor: { faults: [FAULTS.quota429NoReset] },
    async verify({ report, provider }) {
      expect(report.status).toBe("stopped");
      expect(report.stopReason).toMatch(/^supervisor provider quota: 429 .*\(2056\)/);
      expect(report.blocker).toMatch(/not remedied: .*no reset time/);
      expect(provider!.served).toEqual(["http-error:429"]);
    },
  },
  {
    id: "provider: 429 without a reset time, operator quotaRetryMs",
    bug: "#118/#124",
    expected: "completes after the operator's wait",
    completes: true,
    supervisor: { faults: [FAULTS.quota429NoReset], quotaRetryMs: 200 },
    async verify({ provider }) {
      expect(provider!.served).toEqual(["http-error:429", "decide:return"]);
    },
  },
];

function runOnce(f: Fixture, options: { failWork?: number; supervisorFactory?: RunRequest["supervisorFactory"] } = {}): Promise<RunReport> {
  const { runner } = f.runner(options.failWork !== undefined ? { failWork: options.failWork } : {});
  return createController().run({
    taskPath: f.workspace.taskPath,
    runner,
    stateRoot: f.workspace.stateRoot,
    runId: "matrix",
    ...(options.supervisorFactory !== undefined ? { supervisorFactory: options.supervisorFactory } : {}),
  });
}

/** Run one cell: build the condition, drive the graph, assert the expected outcome. */
export async function runCell(scope: TestScope, graph: GraphName, condition: Condition): Promise<void> {
  const shape = (await condition.shape?.(scope, graph)) ?? {};
  const f = await fixture(scope, graph, shape);
  await condition.setup?.(f);
  let provider: FakeProvider | undefined;
  let report: RunReport | undefined;
  if (condition.supervisor !== undefined) {
    provider = await startFakeProvider(scope, { faults: condition.supervisor.faults });
    const supervisorFactory = piSupervisorFactory({
      provider: provider.provider,
      modelId: provider.modelId,
      // With thinking on, as MiniMax runs; Pi then replays thinking blocks.
      thinkingLevel: "high",
      models: [{ provider: provider.provider, modelId: provider.modelId, thinkingLevel: "high" }],
      agentDir: provider.agentDir,
      promptTimeoutMs: 10_000,
      ...(condition.supervisor.quotaRetryMs !== undefined ? { quotaRetryMs: condition.supervisor.quotaRetryMs } : {}),
    });
    // A work job fails once, so the controller calls the supervisor.
    report = await runOnce(f, { supervisorFactory, failWork: 1 });
    expect(provider.violations, "requests the fake provider refused").toEqual([]);
  } else {
    report = condition.drive !== undefined ? await condition.drive(scope, graph, f) : await runOnce(f);
  }
  if (report === undefined) return;
  const outcome: Outcome = { graph, report, fixture: f, ...(provider !== undefined ? { provider } : {}) };
  if (condition.completes) await completed(outcome);
  await condition.verify(outcome);
}
