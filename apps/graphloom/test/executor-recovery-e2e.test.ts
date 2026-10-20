import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateRepair,
  createScriptedGraph,
  dispatch,
  qualifyRepair,
  returnToNormal,
  stop,
  type GraphDecision,
  type GraphDefinition,
  type JobSpec,
  type Validator,
} from "@graphloom/sdk";
import {
  createBuiltinExecutorRunner,
  createChildExecutorRunner,
  createScriptedRunner,
  digestExecutorSource,
  type Runner,
} from "@graphloom/runner";
import { createController, loadRunState, saveRunState, type RepairDeps } from "@graphloom/controller";
import { createScriptedSupervisor, type ScriptedRecoveryStep, type SupervisorInput } from "@graphloom/supervisor";
import { githubBinding, githubExecutorPackage } from "@graphloom/executor-github";
import { startFakeGitHub, type FakeGitHub } from "@graphloom/executor-github/testing";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const helloBundle = path.join(repoRoot, "examples/plugins/hello");
const TOKEN = "ghp_executor_recovery_secret";
const GH_LIST = "graphloom.github/list-issue-comments";
const MIRROR = "acme.mirror/list-comments";
const WAIT_BUDGET_MS = 15 * 60_000;

const definition: GraphDefinition = {
  graphId: "hello",
  version: "0.1.0",
  stages: [
    { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
    { id: "review", name: "Review", requirementIds: ["independent-review"] },
  ],
  requirements: [
    {
      id: "greeting-bytes",
      statement:
        "GREETING.txt contains exactly the UTF-8 bytes Hello, GraphLoom!\\n and is the only changed path in the workspace (excluding Git metadata).",
      evidenceSchema: "workspace-bytes-v1",
    },
    {
      id: "independent-review",
      statement:
        "An independent read-only reviewer approves the current GREETING.txt revision against the pinned task.",
      evidenceSchema: "review-verdict-v1",
    },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    {
      requirementId: "independent-review",
      validatorId: "independent-reviewer",
      version: "1",
      independence: "separate-reviewer",
    },
  ],
};

const inconclusive: Validator = { evaluate: () => ({ status: "inconclusive", reason: "not exercised" }) };
const validators = { "exact-greeting": inconclusive, "independent-reviewer": inconclusive };

const issue = { owner: "acme", repo: "app", number: 1 };
function readJob(executorId: string, stageId = "write"): JobSpec {
  return {
    stageId,
    kind: "command",
    purpose: "check",
    instruction: "read the issue comments",
    readOnly: true,
    executor: { id: executorId, version: "1" },
    input: issue,
  };
}

/** Read through `executorId`, then stop with `reason` once the graph gets control back. */
function graph(executorId: string, reason = "read done") {
  return createScriptedGraph({
    definition,
    advances: [dispatch(readJob(executorId), "read"), stop({ reason, blocker: "none" }, "done")],
  });
}

interface Mirror {
  dir: string;
  entry: string;
}

/**
 * A custom executor package outside the repository. It imports the SDK
 * through its own node_modules, like an installed package would.
 */
async function mirrorPackage(parent: string, opts: { broken: boolean; retryAfterMs?: number }): Promise<Mirror> {
  const dir = path.join(parent, "acme-mirror");
  await mkdir(path.join(dir, "node_modules/@graphloom"), { recursive: true });
  await symlink(path.join(repoRoot, "packages/sdk"), path.join(dir, "node_modules/@graphloom/sdk"), "dir");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "acme-mirror", version: "1.0.0", type: "module", dependencies: { "@graphloom/sdk": "0.0.0" } }),
  );
  const failure = JSON.stringify({
    status: "failed",
    summary: "mirror returned a truncated page",
    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
  });
  const entry = path.join(dir, "index.mjs");
  await writeFile(
    entry,
    `import { stop } from "@graphloom/sdk";
const BROKEN = ${opts.broken};
export const executors = [
  {
    id: "${MIRROR}",
    version: "1",
    effect: "read",
    async execute(input) {
      if (BROKEN) return ${failure};
      return {
        status: "ok",
        summary: "mirror listed comments for #" + input.number,
        evidence: [{ kind: "other", payload: { mirror: { number: input.number, sdk: typeof stop } } }],
      };
    },
  },
];
`,
  );
  return { dir, entry };
}

/** GitHub built in (sandboxed), the mirror as a custom sandboxed child package. */
function hostRunner(server: FakeGitHub, mirror?: Mirror, sandbox = true): Runner {
  const scripted = createScriptedRunner({ jobs: [] });
  const fallback = mirror
    ? createChildExecutorRunner({
        entryModule: mirror.entry,
        sourceRoot: mirror.dir,
        executorIds: [MIRROR],
        sandbox,
        fallback: scripted,
      })
    : scripted;
  return createBuiltinExecutorRunner({
    packages: [{ manifest: githubExecutorPackage, ...githubBinding({ token: TOKEN, baseUrl: server.baseUrl }) }],
    fallback,
  });
}

function recorder(steps: ScriptedRecoveryStep[]) {
  const inputs: SupervisorInput[] = [];
  const decisions = steps.map((step): ScriptedRecoveryStep => async (input, index) => {
    // The controller's admission check, case-file sink and inspection port are functions, not recorded data.
    const { admission: _admission, recordFinding: _recordFinding, inspect: _inspect, ...recorded } = input;
    void _admission;
    void _recordFinding;
    void _inspect;
    inputs.push(structuredClone(recorded));
    return typeof step === "function" ? step(input, index) : structuredClone(step);
  });
  return { inputs, decisions };
}

const giveBack: GraphDecision = returnToNormal({ summary: "executor recovered" }, "return");

/** After an inadmissible proposal the supervisor is re-asked in-turn (#117); this one stops, naming the rejection. */
const stopOnRejection: ScriptedRecoveryStep = (input) =>
  stop({ reason: "inadmissible", blocker: input.rejection?.reason ?? "no rejection" }, "stop on rejection");

type Payload = Record<string, unknown>;
const payloads = (evidence: readonly { payload?: unknown }[], key: string): Payload[] =>
  evidence.map((e) => (e.payload as Payload | undefined)?.[key]).filter((p): p is Payload => p !== undefined);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => undefined);
});

async function fake(): Promise<FakeGitHub> {
  const server = await startFakeGitHub({ issues: [{ number: 1, title: "Add a greeting", state: "open", labels: [] }] });
  cleanups.push(() => server.close());
  return server;
}

const gets = (server: FakeGitHub) => server.requests.filter((r) => r.method === "GET");

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not reached");
}

describe("executor failure recovery (#41)", () => {
  it("retries a rate-limited built-in executor after a wait charged to the run's wait budget", async () => {
    const server = await fake();
    server.rateLimitNext(1, 2);
    const env = await makeEnv();
    const sup = recorder([dispatch(readJob(GH_LIST), "retry after the rate limit"), giveBack]);
    const started = Date.now();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(GH_LIST),
      validators,
      runner: hostRunner(server),
      supervisor: createScriptedSupervisor({ decisions: sup.decisions }),
      stateRoot: env.stateRoot,
      runId: "gh-retry",
    });

    expect(report.stopReason, report.blocker).toBe("read done");
    expect(sup.inputs[0]!.trigger.code).toBe("executor_failed");
    expect(sup.inputs[0]!.trigger.message).toMatch(/^executor graphloom\.github\/list-issue-comments failed: GitHub rate limited/);
    expect(gets(server)).toHaveLength(2);

    const state = await loadRunState(report.stateDir);
    const [failure] = payloads(state.evidence, "executorFailure");
    expect(failure).toMatchObject({ stageId: "write", status: "failed", executor: { id: GH_LIST } });
    const retryAfterMs = failure!.retryAfterMs as number;
    expect(retryAfterMs).toBeGreaterThan(0);
    const waited = WAIT_BUDGET_MS - state.budgets.waitMs!;
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(retryAfterMs);
    expect(Date.now() - started).toBeGreaterThanOrEqual(waited);
    expect(state.executorRetryAt?.[GH_LIST]).toBeUndefined();
    expect(payloads(state.evidence, "github")).not.toHaveLength(0);
  });

  it("stops instead of waiting when the requested wait exceeds the remaining budget", async () => {
    const server = await fake();
    server.rateLimitNext(1, 3600);
    const env = await makeEnv();
    const started = Date.now();
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(GH_LIST),
      validators,
      runner: hostRunner(server),
      supervisor: createScriptedSupervisor({ decisions: [dispatch(readJob(GH_LIST), "retry")] }),
      stateRoot: env.stateRoot,
      runId: "gh-wait",
    });

    expect(report.stopReason).toBe("wait budget exhausted");
    expect(report.blocker).toMatch(/^executor graphloom\.github\/list-issue-comments asks to wait 3[56]\d\ds; 900s of the run's wait budget remain$/);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(gets(server)).toHaveLength(1);
    expect((await loadRunState(report.stateDir)).budgets.waitMs).toBe(WAIT_BUDGET_MS);
  });

  it("drops a retry stopped during its wait as never started, and charges only the wait actually spent", async () => {
    const server = await fake();
    server.rateLimitNext(1, 3);
    const env = await makeEnv();
    const controller = createController();
    const stateDir = path.join(env.stateRoot, "wait-stop");
    const retry = dispatch(readJob(GH_LIST), "retry after the rate limit");
    const running = controller.run({
      taskPath: env.taskPath,
      plugin: graph(GH_LIST),
      validators,
      runner: hostRunner(server),
      supervisor: createScriptedSupervisor({ decisions: [retry] }),
      stateRoot: env.stateRoot,
      runId: "wait-stop",
    });
    await waitFor(async () => {
      const pending = (await loadRunState(stateDir)).pendingDispatch;
      return pending?.status === "waiting" && pending.notBefore !== undefined;
    });
    await controller.stop(stateDir);
    expect((await running).status).toBe("stopped");
    const stopped = await loadRunState(stateDir);
    expect(stopped.pendingDispatch?.status).toBe("waiting");
    expect(gets(server)).toHaveLength(1);

    const resumed = await controller.resume({
      runRef: stateDir,
      plugin: graph(GH_LIST),
      validators,
      runner: hostRunner(server),
      supervisor: createScriptedSupervisor({ decisions: [retry, giveBack] }),
    });
    expect(resumed.stopReason, resumed.blocker).toBe("read done");
    const state = await loadRunState(stateDir);
    const [failure] = payloads(state.evidence, "executorFailure");
    expect(WAIT_BUDGET_MS - state.budgets.waitMs!).toBeLessThanOrEqual(failure!.retryAfterMs as number);
    expect(payloads(state.evidence, "github")).not.toHaveLength(0);
  });

  it("clamps an executor's oversized retry request instead of failing the run", async () => {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: true, retryAfterMs: 1e300 });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({ decisions: [dispatch(readJob(MIRROR), "retry")] }),
      stateRoot: env.stateRoot,
      runId: "huge-wait",
    });
    expect(report.stopReason, report.blocker).toBe("wait budget exhausted");
    const [failure] = payloads((await loadRunState(report.stateDir)).evidence, "executorFailure");
    expect(failure!.retryAfterMs).toBe(30 * 24 * 60 * 60_000);
  });

  it("allows only built-in kind defaults in recovery when the runner pinned no executors", async () => {
    const env = await makeEnv();
    const runner = createScriptedRunner({ jobs: [async () => ({ status: "failed" as const, summary: "boom" })] });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph("acme.custom/list-comments"),
      validators,
      runner,
      supervisor: createScriptedSupervisor({
        decisions: [dispatch(readJob("acme.custom/list-comments"), "retry"), stopOnRejection],
      }),
      stateRoot: env.stateRoot,
      runId: "no-catalog",
    });
    expect(report.stopReason).toBe("inadmissible");
    expect(report.blocker).toBe(
      "recovery dispatch rejected: executor acme.custom/list-comments cannot be used in recovery: the runner did not describe its executors, so none were pinned",
    );
  });

  it("reports built-in and custom executor failures through the same recovery record", async () => {
    const server = await fake();
    server.rateLimitNext(1, 60);
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: true, retryAfterMs: 5 });
    const controller = createController();
    const observed: { trigger: SupervisorInput["trigger"]; failure: Payload; pinned: string }[] = [];
    for (const executorId of [GH_LIST, MIRROR]) {
      const sup = recorder([stop({ reason: "inspected", blocker: "none" }, "inspect")]);
      const report = await controller.run({
        taskPath: env.taskPath,
        plugin: graph(executorId),
        validators,
        runner: hostRunner(server, mirror),
        supervisor: createScriptedSupervisor({ decisions: sup.decisions }),
        stateRoot: env.stateRoot,
        runId: `parity-${executorId.split("/")[0]}`,
      });
      expect(report.stopReason, report.blocker).toBe("inspected");
      const state = await loadRunState(report.stateDir);
      observed.push({
        trigger: sup.inputs[0]!.trigger,
        failure: payloads(state.evidence, "executorFailure")[0]!,
        pinned: state.executorCatalog!.find((e) => e.id === executorId)!.digest,
      });
    }

    const [builtin, custom] = observed;
    expect(builtin!.trigger.code).toBe("executor_failed");
    expect(custom!.trigger.code).toBe("executor_failed");
    expect(custom!.trigger.message).toBe(`executor ${MIRROR} failed: mirror returned a truncated page`);
    expect(Object.keys(custom!.failure).sort()).toEqual(Object.keys(builtin!.failure).sort());
    expect(custom!.failure).toMatchObject({ retryAfterMs: 5, executor: { id: MIRROR, digest: custom!.pinned } });
    expect(builtin!.failure).toMatchObject({ executor: { id: GH_LIST, digest: builtin!.pinned } });
  });

  it("lets the supervisor switch to another pinned executor without adding graph steps", async () => {
    const server = await fake();
    server.rateLimitNext(1, 3600);
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: false });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(GH_LIST),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({ decisions: [dispatch(readJob(MIRROR), "use the mirror"), giveBack] }),
      stateRoot: env.stateRoot,
      runId: "alternate",
    });

    expect(report.stopReason, report.blocker).toBe("read done");
    const state = await loadRunState(report.stateDir);
    expect(payloads(state.evidence, "mirror")).toEqual([{ number: 1, sdk: "function" }]);
    // The rate limit only gates GitHub; the mirror ran without spending the wait budget.
    expect(state.budgets.waitMs).toBe(WAIT_BUDGET_MS);
    expect(state.executorRetryAt?.[GH_LIST]).toBeDefined();
  });

  it("refuses recovery dispatches for another stage or an executor the run did not pin", async () => {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const controller = createController();
    const cases: [JobSpec, string, RegExp][] = [
      [
        readJob("acme.unpinned/list-comments"),
        "executor pin rejected",
        /^executor acme\.unpinned\/list-comments is not pinned for this run$/,
      ],
      [
        readJob(MIRROR, "review"),
        "recovery dispatch rejected",
        /^recovery may only dispatch work for the current stage write, not review$/,
      ],
    ];
    for (const [i, [job, stopReason, blocker]] of cases.entries()) {
      const report = await controller.run({
        taskPath: env.taskPath,
        plugin: graph(MIRROR),
        validators,
        runner: hostRunner(server, mirror),
        supervisor: createScriptedSupervisor({ decisions: [dispatch(job, "try something else"), stopOnRejection] }),
        stateRoot: env.stateRoot,
        runId: `refused-${i}`,
      });
      // Inadmissible, returned to the supervisor in-turn rather than stopping the run (#117).
      expect(report.stopReason).toBe("inadmissible");
      expect(report.blocker?.startsWith(`${stopReason}: `)).toBe(true);
      expect(report.blocker?.slice(stopReason.length + 2)).toMatch(blocker);
    }
  });

  it("stops on an executor failure when the run has no supervisor", async () => {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      stateRoot: env.stateRoot,
      runId: "no-supervisor",
    });
    expect(report.stopReason).toBe("job failed: mirror returned a truncated page");
    const state = await loadRunState(report.stateDir);
    expect(payloads(state.evidence, "executorFailure")).toHaveLength(1);
  });
});

describe("pinned executor digests (#41)", () => {
  it("resumes with exactly the pinned executors and blocks when one changed or disappeared", async () => {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: false });
    const controller = createController();
    const first = await controller.run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR, "pause"),
      validators,
      runner: hostRunner(server, mirror),
      stateRoot: env.stateRoot,
      runId: "pinned",
    });
    expect(first.stopReason, first.blocker).toBe("pause");
    const catalog = (await loadRunState(first.stateDir)).executorCatalog!;
    expect(catalog.find((e) => e.id === MIRROR)).toMatchObject({
      digest: await digestExecutorSource(mirror.dir),
      isolation: "sandbox",
      builtin: false,
    });
    expect(catalog.find((e) => e.id === GH_LIST)).toMatchObject({ isolation: "sandbox", builtin: true });

    const resumed = await controller.resume({
      runRef: first.stateDir,
      plugin: graph(MIRROR, "resumed"),
      validators,
      runner: hostRunner(server, mirror),
    });
    expect(resumed.stopReason, resumed.blocker).toBe("resumed");

    const original = await readFile(mirror.entry, "utf8");
    await writeFile(mirror.entry, `${original}// upgraded\n`);
    const changed = await controller.resume({
      runRef: first.stateDir,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
    });
    expect(changed.stopReason).toBe("executor pin mismatch");
    expect(changed.blocker).toMatch(/^pinned executor acme\.mirror\/list-comments changed: digest /);

    await writeFile(mirror.entry, original);
    const unsandboxed = await controller.resume({
      runRef: first.stateDir,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror, false),
    });
    expect(unsandboxed.stopReason).toBe("executor pin mismatch");
    expect(unsandboxed.blocker).toBe(
      "pinned executor acme.mirror/list-comments changed: isolation unrestricted != pinned sandbox",
    );

    const missing = await controller.resume({
      runRef: first.stateDir,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server),
    });
    expect(missing.stopReason).toBe("executor pin mismatch");
    expect(missing.blocker).toBe("pinned executor acme.mirror/list-comments is no longer installed");
  });
});

describe("resume --update-executors (#156)", () => {
  async function pausedMirror(runId: string, opts: { copyBundle?: boolean } = {}) {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: false });
    if (opts.copyBundle) {
      const bundle = path.join(env.taskDir, "hello-bundle");
      await execFileAsync("cp", ["-r", helloBundle, bundle]);
      await rm(path.join(env.taskDir, "plugins/hello"));
      await symlink(bundle, path.join(env.taskDir, "plugins/hello"));
    }
    const first = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR, "pause"),
      validators,
      runner: hostRunner(server, mirror),
      stateRoot: env.stateRoot,
      runId,
    });
    expect(first.stopReason, first.blocker).toBe("pause");
    const resume = (runner: Runner, patch: { updateExecutors?: boolean; updatePlugin?: boolean } = {}) =>
      createController().resume({ runRef: first.stateDir, plugin: graph(MIRROR, "resumed"), validators, runner, ...patch });
    const upgrade = async () => writeFile(mirror.entry, `${await readFile(mirror.entry, "utf8")}// upgraded\n`);
    return { server, env, mirror, first, resume, upgrade };
  }
  const pinnedEntry = async (stateDir: string) => (await loadRunState(stateDir)).executorCatalog!.find((e) => e.id === MIRROR)!;

  it("re-pins an executor whose bytes changed and records old -> new digest at its generation", async () => {
    const { server, mirror, first, resume, upgrade } = await pausedMirror("update-executors");
    const before = await pinnedEntry(first.stateDir);
    const receiptsBefore = (await loadRunState(first.stateDir)).receipts;
    await upgrade();
    const upgraded = await digestExecutorSource(mirror.dir);

    const resumed = await resume(hostRunner(server, mirror), { updateExecutors: true });
    expect(resumed.stopReason, resumed.blocker).toBe("resumed");

    const state = await loadRunState(first.stateDir);
    expect(await pinnedEntry(first.stateDir)).toMatchObject({ digest: upgraded, isolation: "sandbox", builtin: false });
    expect(upgraded).not.toBe(before.digest);
    // Only the changed executor moved: the built-in GitHub pin is untouched.
    expect(state.executorTransitions).toMatchObject([
      { id: MIRROR, fromDigest: before.digest, toDigest: upgraded, generation: expect.any(Number), at: expect.any(String) },
    ]);
    const [recorded] = payloads(state.evidence, "executorUpdate");
    expect(recorded).toMatchObject({ transitions: [{ id: MIRROR, fromDigest: before.digest, toDigest: upgraded }] });
    expect(state.versionHistory.map((v) => v.reason)).toContain(
      `operator executor update: ${MIRROR} ${before.digest.slice(0, 12)} -> ${upgraded.slice(0, 12)}`,
    );
    expect(state.receipts).toEqual(receiptsBefore);
    const inspected = await createController().inspect(first.stateDir);
    expect(inspected.executorTransitions).toEqual(state.executorTransitions);

    // Later resumes need no flag: the new digest is the pin.
    const again = await resume(hostRunner(server, mirror));
    expect(again.stopReason, again.blocker).toBe("resumed");
    expect((await loadRunState(first.stateDir)).executorTransitions).toHaveLength(1);
  });

  it("re-pins an executor that only moved to another location, so a later plain resume needs no flag", async () => {
    const { server, mirror, first, resume } = await pausedMirror("update-executors-moved");
    const before = await pinnedEntry(first.stateDir);
    const dir = path.join(path.dirname(mirror.dir), "acme-mirror-moved");
    await execFileAsync("cp", ["-r", mirror.dir, dir]);
    const moved = { dir, entry: path.join(dir, "index.mjs") };
    expect(await digestExecutorSource(dir)).toBe(before.digest);

    const stopped = await resume(hostRunner(server, moved));
    expect(stopped.stopReason).toBe("executor pin mismatch");
    expect(stopped.blocker).toContain("--update-executors");

    const resumed = await resume(hostRunner(server, moved), { updateExecutors: true });
    expect(resumed.stopReason, resumed.blocker).toBe("resumed");
    const pinned = await pinnedEntry(first.stateDir);
    expect(pinned.source).not.toBe(before.source);
    expect((await loadRunState(first.stateDir)).executorTransitions).toMatchObject([
      { id: MIRROR, fromDigest: before.digest, toDigest: before.digest, fromSource: before.source, toSource: pinned.source },
    ]);

    const again = await resume(hostRunner(server, moved));
    expect(again.stopReason, again.blocker).toBe("resumed");
  });

  it("lifts a final stop when the upgraded executors are pinned, and holds it otherwise", async () => {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: false });
    const finalStop = (reason: string) =>
      createScriptedGraph({
        definition,
        advances: [dispatch(readJob(MIRROR), "read"), stop({ reason, blocker: "the mirror is defective", retryable: false }, "done")],
      });
    const first = await createController().run({
      taskPath: env.taskPath,
      plugin: finalStop("mirror defect"),
      validators,
      runner: hostRunner(server, mirror),
      stateRoot: env.stateRoot,
      runId: "update-executors-final",
    });
    expect(first.stopReason, first.blocker).toBe("mirror defect");
    await writeFile(mirror.entry, `${await readFile(mirror.entry, "utf8")}// fixed\n`);
    const resume = (updateExecutors?: boolean) =>
      createController().resume({
        runRef: first.stateDir,
        plugin: graph(MIRROR, "resumed"),
        validators,
        runner: hostRunner(server, mirror),
        ...(updateExecutors !== undefined ? { updateExecutors } : {}),
      });

    // The bytes changed but nothing was adopted: the final stop holds (the plugin's own stop, surfaced again).
    const held = await resume();
    expect(held.stopReason).not.toBe("resumed");
    expect((await loadRunState(first.stateDir)).executorTransitions).toBeUndefined();

    const lifted = await resume(true);
    expect(lifted.stopReason, lifted.blocker).toBe("resumed");
    expect((await loadRunState(first.stateDir)).executorTransitions).toHaveLength(1);
  });

  it("stops without the flag and says how to proceed", async () => {
    const { server, mirror, first, resume, upgrade } = await pausedMirror("update-executors-hint");
    const before = await pinnedEntry(first.stateDir);
    await upgrade();
    const stopped = await resume(hostRunner(server, mirror));
    expect(stopped.stopReason).toBe("executor pin mismatch");
    expect(stopped.blocker).toMatch(
      /^pinned executor acme\.mirror\/list-comments changed: digest [0-9a-f]{12} != pinned [0-9a-f]{12}; resume with --update-executors to pin the installed executor$/,
    );
    expect(await pinnedEntry(first.stateDir)).toEqual(before);
    expect((await loadRunState(first.stateDir)).executorTransitions).toBeUndefined();
  });

  it("refuses a changed isolation, an executor no longer installed, and a repaired entry, naming the executor", async () => {
    const { server, mirror, first, resume, upgrade } = await pausedMirror("update-executors-refused");
    await upgrade();
    const unsandboxed = await resume(hostRunner(server, mirror, false), { updateExecutors: true });
    expect(unsandboxed.stopReason).toBe("executor pin mismatch");
    expect(unsandboxed.blocker).toBe("pinned executor acme.mirror/list-comments changed: isolation unrestricted != pinned sandbox");

    const missing = await resume(hostRunner(server), { updateExecutors: true });
    expect(missing.stopReason).toBe("executor pin mismatch");
    expect(missing.blocker).toBe("pinned executor acme.mirror/list-comments is no longer installed");

    // An active run-local repair: the qualified copy stays pinned, and the installed bytes moving past its base is not adopted.
    const state = await loadRunState(first.stateDir);
    const entry = state.executorCatalog!.find((e) => e.id === MIRROR)!;
    const root = path.join(path.dirname(mirror.dir), "acme-mirror-repair");
    await execFileAsync("cp", ["-r", mirror.dir, root]);
    await writeFile(path.join(root, "index.mjs"), (await readFile(path.join(root, "index.mjs"), "utf8")).replace("// upgraded\n", "// repaired\n"));
    const repairedDigest = await digestExecutorSource(root);
    await saveRunState({
      ...state,
      executorCatalog: state.executorCatalog!.map((e) =>
        e.id === MIRROR
          ? { ...entry, digest: repairedDigest, repair: { artifactId: "repair-1", root, entryModule: path.join(root, "index.mjs"), baseDigest: entry.digest } }
          : e,
      ),
    });
    const repaired = await resume(hostRunner(server, mirror), { updateExecutors: true });
    expect(repaired.stopReason).toBe("executor pin mismatch");
    expect(repaired.blocker).toMatch(/^pinned executor acme\.mirror\/list-comments has an active repair repair-1; --update-executors does not replace it/);
    const after = await loadRunState(first.stateDir);
    expect(after.executorCatalog!.find((e) => e.id === MIRROR)).toMatchObject({ digest: repairedDigest, repair: { artifactId: "repair-1" } });
    expect(after.executorTransitions).toBeUndefined();
  });

  it("combines with --update-plugin", async () => {
    const { server, env, mirror, first, resume, upgrade } = await pausedMirror("update-both", { copyBundle: true });
    const pinned = (await loadRunState(first.stateDir)).intake.bundle;
    const before = await pinnedEntry(first.stateDir);
    await upgrade();
    const entry = path.join(env.taskDir, "hello-bundle/dist/index.js");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n// a fix to the graph's routing\n`);

    expect(await resume(hostRunner(server, mirror), { updatePlugin: true })).toMatchObject({ stopReason: "executor pin mismatch" });
    expect(await resume(hostRunner(server, mirror), { updateExecutors: true })).toMatchObject({ stopReason: "pin mismatch" });

    const both = await resume(hostRunner(server, mirror), { updatePlugin: true, updateExecutors: true });
    expect(both.stopReason, both.blocker).toBe("resumed");
    const state = await loadRunState(first.stateDir);
    expect(state.intake.bundle.entryDigest).not.toBe(pinned.entryDigest);
    expect((await pinnedEntry(first.stateDir)).digest).not.toBe(before.digest);
    expect(state.versionHistory.map((v) => v.reason).filter((r) => r.startsWith("operator "))).toHaveLength(2);
  });
});

describe("executor repair (#41)", () => {
  const reviewer = { sessionId: "independent-reviewer", review: async () => ({ approved: true, reason: "fix is minimal" }) };
  const preflight = async () => ({ ok: true, summary: "scripted preflight ok" });
  function repairDeps(patch: (candidateRoot: string) => Promise<void>): RepairDeps {
    return {
      patchAuthor: {
        sessionId: "scripted-supervisor",
        async patch({ candidateRoot }) {
          await patch(candidateRoot);
          return { summary: "patched the mirror executor" };
        },
      },
      reviewer,
      preflight,
    };
  }
  const editEntry = (from: string, to: string) => async (candidateRoot: string) => {
    const file = path.join(candidateRoot, "index.mjs");
    await writeFile(file, (await readFile(file, "utf8")).replace(from, to));
  };
  const qualify = qualifyRepair({ target: "executor", executorId: MIRROR, reason: "mirror truncates pages" }, "qualify");

  it("activates a qualified run-local copy, leaves the install untouched, and resumes from the copy", async () => {
    const server = await fake();
    const env = await makeEnv({ executorRepair: true });
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const installed = await readFile(mirror.entry, "utf8");
    const installedDigest = await digestExecutorSource(mirror.dir);
    const controller = createController();
    // The reviewer's own diff must compare the candidate against the mirror
    // executor's own package, not some other root (e.g. the plugin bundle) —
    // otherwise an unrelated-looking diff could make a correct patch look
    // like it replaced an entire other package.
    const seenBaseRoots: string[] = [];
    const deps = repairDeps(editEntry("const BROKEN = true", "const BROKEN = false"));
    const report = await controller.run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({
        decisions: [
          qualify,
          (input) => {
            const candidate = input.view.repairCandidates?.find((c) => c.status === "qualified");
            expect(candidate).toMatchObject({ target: "executor", executorId: MIRROR });
            return activateRepair({ qualifiedArtifactId: candidate!.artifactId, reason: "serve the fix" }, "activate");
          },
          dispatch(readJob(MIRROR), "retry on the repaired executor"),
          giveBack,
        ],
      }),
      repair: {
        ...deps,
        reviewer: {
          ...deps.reviewer,
          async review(args) {
            seenBaseRoots.push(args.baseRoot);
            return deps.reviewer.review(args);
          },
        },
      },
      stateRoot: env.stateRoot,
      runId: "exec-repair",
    });

    expect(report.stopReason, report.blocker).toBe("read done");
    expect(await readFile(mirror.entry, "utf8")).toBe(installed);
    expect(await digestExecutorSource(mirror.dir)).toBe(installedDigest);
    expect(seenBaseRoots).toEqual([mirror.dir]);

    const state = await loadRunState(report.stateDir);
    expect(payloads(state.evidence, "mirror")).toEqual([{ number: 1, sdk: "function" }]);
    const artifact = state.repairCandidates!.find((c) => c.status === "activated")!;
    expect(artifact).toMatchObject({ target: "executor", executorId: MIRROR, baseDigest: installedDigest });
    const entry = state.executorCatalog!.find((e) => e.id === MIRROR)!;
    expect(entry.repair).toMatchObject({ artifactId: artifact.artifactId, baseDigest: installedDigest });
    expect(entry.repair!.root.startsWith(report.stateDir)).toBe(true);
    expect(entry.digest).toBe(await digestExecutorSource(entry.repair!.root));
    expect(entry.digest).not.toBe(installedDigest);
    const linked = path.join(entry.repair!.root, "node_modules/@graphloom/sdk");
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await realpath(linked)).toBe(await realpath(path.join(repoRoot, "packages/sdk")));

    // The install is still broken; a resumed run keeps serving the reviewed copy.
    const resumed = await controller.resume({
      runRef: report.stateDir,
      plugin: graph(MIRROR, "resumed"),
      validators,
      runner: hostRunner(server, mirror),
    });
    expect(resumed.stopReason, resumed.blocker).toBe("resumed");
    expect(payloads((await loadRunState(report.stateDir)).evidence, "mirror")).toHaveLength(2);

    // The reviewed copy still runs only under the isolation the run pinned.
    const unsandboxed = await controller.resume({
      runRef: report.stateDir,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror, false),
    });
    expect(unsandboxed.stopReason).toBe("executor pin mismatch");
    expect(unsandboxed.blocker).toMatch(/isolation unrestricted != pinned sandbox$/);

    await writeFile(path.join(entry.repair!.root, "index.mjs"), "export const executors = [];\n");
    const tampered = await controller.resume({
      runRef: report.stateDir,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
    });
    expect(tampered.stopReason).toBe("executor pin mismatch");
  });

  it("requires the executorRepair grant", async () => {
    const server = await fake();
    const env = await makeEnv();
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({ decisions: [qualify, stopOnRejection] }),
      repair: repairDeps(editEntry("const BROKEN = true", "const BROKEN = false")),
      stateRoot: env.stateRoot,
      runId: "no-grant",
    });
    expect(report.stopReason).toBe("inadmissible");
    expect(report.blocker).toBe("qualify_repair missing operator grant: executorRepair grant is false");
  });

  it("rejects a candidate that changes the executors its package defines", async () => {
    const server = await fake();
    const env = await makeEnv({ executorRepair: true });
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({
        decisions: [qualify, stop({ reason: "repair rejected", blocker: "none" }, "give up")],
      }),
      repair: repairDeps(editEntry('effect: "read"', 'effect: "write"')),
      stateRoot: env.stateRoot,
      runId: "contract",
    });
    expect(report.stopReason, report.blocker).toBe("repair rejected");
    const [candidate] = (await loadRunState(report.stateDir)).repairCandidates!;
    expect(candidate).toMatchObject({ status: "rejected", target: "executor", executorId: MIRROR });
    expect(candidate!.rejectionReason).toBe(
      `candidate changes the executors its package defines: pinned ${MIRROR}@1:read, candidate ${MIRROR}@1:write`,
    );
  });

  it("rejects a candidate that changes its declared dependencies", async () => {
    const server = await fake();
    const env = await makeEnv({ executorRepair: true });
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({
        decisions: [qualify, stop({ reason: "repair rejected", blocker: "none" }, "give up")],
      }),
      repair: repairDeps(async (candidateRoot) => {
        const file = path.join(candidateRoot, "package.json");
        const pkg = JSON.parse(await readFile(file, "utf8")) as { dependencies?: Record<string, string> };
        await writeFile(file, JSON.stringify({ ...pkg, dependencies: { ...pkg.dependencies, "left-pad": "1.3.0" } }));
      }),
      stateRoot: env.stateRoot,
      runId: "deps",
    });
    expect(report.stopReason, report.blocker).toBe("repair rejected");
    const [candidate] = (await loadRunState(report.stateDir)).repairCandidates!;
    expect(candidate).toMatchObject({ status: "rejected", target: "executor", executorId: MIRROR });
    expect(candidate!.rejectionReason).toBe("candidate changes declared dependencies in package.json");
  });

  it("rejects a candidate that adds a package beside its linked dependencies", async () => {
    const server = await fake();
    const env = await makeEnv({ executorRepair: true });
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({
        decisions: [qualify, stop({ reason: "repair rejected", blocker: "none" }, "give up")],
      }),
      repair: repairDeps(async (candidateRoot) => {
        const shadow = path.join(candidateRoot, "node_modules", "left-pad");
        await mkdir(shadow, { recursive: true });
        await writeFile(path.join(shadow, "index.js"), "export default () => 'shadow';\n");
      }),
      stateRoot: env.stateRoot,
      runId: "shadow",
    });
    expect(report.stopReason, report.blocker).toBe("repair rejected");
    const [candidate] = (await loadRunState(report.stateDir)).repairCandidates!;
    expect(candidate).toMatchObject({ status: "rejected", target: "executor", executorId: MIRROR });
    expect(candidate!.rejectionReason).toBe("candidate contains entries review cannot see: node_modules/left-pad");
  });

  it("stops the run when the patch edits the installed executor package", async () => {
    const server = await fake();
    const env = await makeEnv({ executorRepair: true });
    const mirror = await mirrorPackage(env.taskDir, { broken: true });
    const report = await createController().run({
      taskPath: env.taskPath,
      plugin: graph(MIRROR),
      validators,
      runner: hostRunner(server, mirror),
      supervisor: createScriptedSupervisor({ decisions: [qualify] }),
      repair: repairDeps(async () => {
        await writeFile(mirror.entry, (await readFile(mirror.entry, "utf8")).replace("const BROKEN = true", "const BROKEN = false"));
      }),
      stateRoot: env.stateRoot,
      runId: "install-edit",
    });
    expect(report).toMatchObject({
      status: "stopped",
      stopReason: "repair patch changed files outside the candidate",
      blocker: `executor package ${mirror.dir}`,
    });
    expect((await loadRunState(report.stateDir)).repairCandidates![0]).toMatchObject({ status: "rejected" });
  });
});

async function makeEnv(opts: { executorRepair?: boolean } = {}): Promise<{ taskPath: string; stateRoot: string; taskDir: string }> {
  // Rebuilding rewrites dist/ under test files that run in parallel; `npm test` builds it first.
  if (!existsSync(path.join(repoRoot, "examples/plugins/hello/dist/index.js"))) {
    await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-hello"], { cwd: repoRoot });
  }
  const taskDir = await mkdtemp(path.join(os.tmpdir(), "gl-exec-recovery-"));
  cleanups.push(async () => {
    await execFileAsync("git", ["worktree", "prune"], { cwd: taskDir }).catch(() => undefined);
    await rm(taskDir, { recursive: true, force: true });
  });
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: repoPath });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: repoPath });
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd: repoPath });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoPath });
  await mkdir(path.join(taskDir, "plugins"), { recursive: true });
  await symlink(helloBundle, path.join(taskDir, "plugins/hello"));
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(
    taskPath,
    `graph: hello
repo: ./test-repo
request: |
  Create GREETING.txt containing exactly "Hello, GraphLoom!" followed by
  one newline. Do not modify other files.
${opts.executorRepair ? "grants:\n  executorRepair: true\n" : ""}`,
    "utf8",
  );
  return { taskPath, stateRoot: path.join(taskDir, "state"), taskDir };
}
