// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * `resume --upgrade` and run ownership in the controller (docs/design-release.md
 * §5.1, §5.2, phase R3): the committed state-format fixtures migrate and
 * complete on a scripted runner; each refusal leaves the run unchanged; the
 * migration framework backs up, records, and never changes protected content.
 *
 * GRAPHLOOM_CAPTURE_STATE_FIXTURE=<name> re-captures the current format's
 * fixture into test/fixtures/state-formats/<name>/ (docs/design-release.md §6
 * step 8); it is skipped otherwise.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createScriptedGraph,
  dispatch,
  observe,
  stop,
  validate,
  type ScriptedAdvance,
  type GraphDefinition,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type Runner } from "@graphloom/runner";
import { createController, loadRunState } from "./index.js";
import type { InstallRecord } from "./state.js";
import { CURRENT_STATE_FORMAT, type StateFormatRegistry } from "./state-migrations/index.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "../test/fixtures/state-formats");

const GREETING = "Hello, GraphLoom!\n";
const GREETING_PATH = "GREETING.txt";
const OWNER: InstallRecord = { version: "0.0.0", root: "/opt/graphloom/versions/0.0.0" };
const target: InstallRecord = { version: "0.1.0", root: "/opt/graphloom/versions/0.1.0" };

/** The fixture graph: Write then Review, the step set every fixture of this graph pins. */
const definition: GraphDefinition = {
  graphId: "fixture",
  version: "1.0.0",
  stages: [
    { id: "write", name: "Write", requirementIds: ["greeting-bytes"] },
    { id: "review", name: "Review", requirementIds: ["independent-review"] },
  ],
  requirements: [
    { id: "greeting-bytes", statement: "GREETING.txt contains exactly Hello, GraphLoom!\\n and nothing else changed.", evidenceSchema: "workspace-bytes-v1" },
    { id: "independent-review", statement: "An independent reviewer approves GREETING.txt.", evidenceSchema: "review-verdict-v1" },
  ],
  defaultValidators: [
    { requirementId: "greeting-bytes", validatorId: "exact-greeting", version: "1" },
    { requirementId: "independent-review", validatorId: "independent-reviewer", version: "1", independence: "separate-reviewer" },
  ],
};

const validators: Record<string, Validator> = {
  "exact-greeting": {
    evaluate(input) {
      const file = [...input.evidence].reverse().find((e) => e.kind === "file")?.payload as { path?: string; bytes?: string } | undefined;
      if (!file) return { status: "inconclusive", reason: "missing" };
      return file.path === GREETING_PATH && file.bytes === GREETING ? { status: "passed", reason: "ok" } : { status: "failed", reason: "bad bytes" };
    },
  },
  "independent-reviewer": {
    evaluate(input) {
      const review = [...input.evidence].reverse().find((e) => e.kind === "review")?.payload as { verdict?: string } | undefined;
      if (!review) return { status: "inconclusive", reason: "missing" };
      return review.verdict === "approved" ? { status: "passed", reason: "approved" } : { status: "failed", reason: "not approved" };
    },
  },
};

const WRITE_STEPS: ScriptedAdvance[] = [
  dispatch({ stageId: "write", kind: "agent", purpose: "work", instruction: "write", writeScope: [GREETING_PATH] }, "write"),
  observe({ paths: [GREETING_PATH], includeWorkspaceManifest: true }, "observe"),
  validate({ stageId: "write", requirementIds: ["greeting-bytes"] }, "v-write"),
];
const REVIEW_STEPS: ScriptedAdvance[] = [
  dispatch({ stageId: "review", kind: "agent", purpose: "review", instruction: "review", readOnly: true }, "review"),
  validate({ stageId: "review", requirementIds: ["independent-review"] }, "v-review"),
  stop({ reason: "complete", blocker: "none" }, "done"),
];

const writeRunner = (): Runner =>
  createScriptedRunner({
    jobs: [
      async (_job, ctx) => {
        await writeFile(path.join(ctx.worktreePath, GREETING_PATH), GREETING, "utf8");
        return { status: "ok", summary: "wrote" };
      },
    ],
  });
const reviewRunner = (): Runner =>
  createScriptedRunner({
    jobs: [async () => ({ status: "ok" as const, summary: "approved", evidence: [{ kind: "review" as const, payload: { verdict: "approved", summary: "ok" } }] })],
  });

/** The fixture bundle's bytes: intake pins them, and the in-process scripted graph stands in for its code. */
const BUNDLE_FILES: Record<string, string> = {
  "graphloom.manifest.json": `${JSON.stringify({ graphId: "fixture", version: "1.0.0", sdkProtocol: 1, entryPoints: { createGraph: "./dist/index.js" }, privateStateSchema: "fixture-private-v1" }, null, 2)}\n`,
  "dist/index.js": "// The state-format fixture's graph runs in process (packages/controller/src/upgrade.test.ts).\nexport {};\n",
};

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Env {
  taskDir: string;
  taskPath: string;
  repoPath: string;
  stateRoot: string;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: "2026-10-27T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-27T00:00:00Z",
    },
  });
  return stdout.trim();
}

/** A task directory with a one-commit repository and the fixture bundle under plugins/fixture. */
async function makeEnv(bundle: Record<string, string> = BUNDLE_FILES): Promise<Env> {
  const taskDir = await realpath(await mkdtemp(path.join(os.tmpdir(), "gl-upgrade-")));
  temps.push(taskDir);
  const repoPath = path.join(taskDir, "test-repo");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, "init", "-q");
  await git(repoPath, "config", "commit.gpgsign", "false");
  await writeFile(path.join(repoPath, "README.md"), "repo\n", "utf8");
  await git(repoPath, "add", "README.md");
  await git(repoPath, "commit", "-q", "-m", "init");
  for (const [name, text] of Object.entries(bundle)) {
    const file = path.join(taskDir, "plugins", "fixture", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
  }
  const taskPath = path.join(taskDir, "task.yaml");
  await writeFile(taskPath, "graph: fixture\nrepo: ./test-repo\nrequest: |\n  Write GREETING.txt.\n", "utf8");
  return { taskDir, taskPath, repoPath, stateRoot: path.join(taskDir, "state") };
}

/** A run stopped after Write, owned by `OWNER`, in the current format. */
async function stoppedRun(runId = "up1"): Promise<{ env: Env; stateDir: string }> {
  const env = await makeEnv();
  const report = await createController().run({
    taskPath: env.taskPath,
    plugin: createScriptedGraph({ definition, advances: [...WRITE_STEPS, ...REVIEW_STEPS] }),
    validators,
    runner: writeRunner(),
    stateRoot: env.stateRoot,
    runId,
    install: OWNER,
    stopAfterStage: "Write",
  });
  expect(report.status).toBe("stopped");
  return { env, stateDir: report.stateDir };
}

function resumeUpgrade(stateDir: string, install: InstallRecord, extra: { stateFormats?: StateFormatRegistry; runner?: Runner; onMoved?: () => void } = {}) {
  return createController().resume({
    runRef: stateDir,
    plugin: createScriptedGraph({ definition, advances: REVIEW_STEPS }),
    validators,
    runner: extra.runner ?? reviewRunner(),
    updateExecutors: true,
    upgrade: { install, ...(extra.onMoved !== undefined ? { onMoved: extra.onMoved } : {}) },
    ...(extra.stateFormats !== undefined ? { stateFormats: extra.stateFormats } : {}),
  });
}

/** Every file under `dir` (except lock files), by relative path. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name.endsWith(".lock")) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = await readFile(file, "utf8");
  }
  return out;
}

async function editState(stateDir: string, edit: (state: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(stateDir, "state.json");
  const state = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  edit(state);
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

describe("run ownership (docs/design-release.md §5.1)", () => {
  it("records the owner and the state format at intake, and rehearse --stop-at's hook stops after the stage", async () => {
    const { stateDir } = await stoppedRun();
    const state = await loadRunState(stateDir);
    expect(state.install).toEqual(OWNER);
    expect(state.stateFormat).toBe(CURRENT_STATE_FORMAT);
    expect(state.stopReason).toBe("operator stop");
    expect(state.receipts.filter((r) => r.valid).map((r) => r.stageId)).toEqual(["write"]);
    const inspect = await createController().inspect(stateDir);
    expect(inspect.install).toEqual(OWNER);
    expect(inspect.stateFormat).toBe(CURRENT_STATE_FORMAT);
    expect(inspect.stages.map((s) => s.complete)).toEqual([true, false]);
  });

  it("refuses an unknown --stop-at stage before the run is created", async () => {
    const env = await makeEnv();
    await expect(
      createController().run({
        taskPath: env.taskPath,
        plugin: createScriptedGraph({ definition, advances: WRITE_STEPS }),
        validators,
        runner: writeRunner(),
        stateRoot: env.stateRoot,
        runId: "nostage",
        stopAfterStage: "Deploy",
      }),
    ).rejects.toThrow(/no stage "Deploy".*Write, Review/);
    expect(existsSync(path.join(env.stateRoot, "nostage"))).toBe(false);
  });

  it("refuses a plain resume of a run in another state format", async () => {
    const { stateDir } = await stoppedRun();
    await editState(stateDir, (s) => (s.stateFormat = CURRENT_STATE_FORMAT + 1));
    const before = await snapshot(stateDir);
    await expect(createController().resume({ runRef: stateDir, plugin: createScriptedGraph({ definition, advances: REVIEW_STEPS }), validators, runner: reviewRunner() })).rejects.toThrow(
      /state format 2, written by a newer GraphLoom/,
    );
    expect(await snapshot(stateDir)).toEqual(before);
  });
});

describe("resume --upgrade (docs/design-release.md §5.2)", () => {


  it("moves the run, records the transition, and completes it", async () => {
    const { stateDir } = await stoppedRun();
    const moved: unknown[] = [];
    const report = await createController().resume({
      runRef: stateDir,
      plugin: createScriptedGraph({ definition, advances: REVIEW_STEPS }),
      validators,
      runner: reviewRunner(),
      upgrade: { install: target, onMoved: (m) => void moved.push(m) },
    });
    expect(report.status).toBe("succeeded");
    expect(moved).toEqual([{ runId: "up1", stateDir, install: target, bundlePath: expect.stringMatching(/plugins\/fixture$/) }]);
    const inspect = await createController().inspect(stateDir);
    expect(inspect.install).toEqual(target);
    expect(inspect.installHistory).toEqual([expect.objectContaining({ from: OWNER, to: target, fromStateFormat: 1, toStateFormat: 1 })]);
    expect(inspect.stateMigrations).toEqual([]);
    expect(inspect.versionHistory.map((v) => v.reason)).toContain("upgrade: GraphLoom 0.0.0 -> 0.1.0, state format 1 -> 1");
    const state = await loadRunState(stateDir);
    expect(state.evidence.some((e) => (e.payload as { upgrade?: unknown } | undefined)?.upgrade !== undefined)).toBe(true);
  });

  it("applies ordered migrators with a backup, a recorded transition, and protected content unchanged", async () => {
    const { stateDir } = await stoppedRun();
    const original = await readFile(path.join(stateDir, "state.json"), "utf8");
    const before = JSON.parse(original) as { receipts: unknown; evidence: unknown[] };
    const order: string[] = [];
    // Format 2 moves `budgets` into a side file; format 3 moves it back under a new name. Neither touches receipts or evidence.
    const formats: StateFormatRegistry = {
      current: 3,
      migrators: [
        {
          from: 2,
          to: 3,
          files: ["budgets.json"],
          migrate(files) {
            order.push("2-3");
            const state = JSON.parse(files["state.json"]!) as Record<string, unknown>;
            const { "budgets.json": side, ...rest } = files;
            return { ...rest, "state.json": JSON.stringify({ ...state, budgets: JSON.parse(side!), stateFormat: 3 }, null, 2) };
          },
        },
        {
          from: 1,
          to: 2,
          migrate(files) {
            order.push("1-2");
            const { budgets, ...state } = JSON.parse(files["state.json"]!) as Record<string, unknown>;
            return { ...files, "state.json": JSON.stringify({ ...state, stateFormat: 2 }, null, 2), "budgets.json": JSON.stringify(budgets) };
          },
        },
      ],
    };
    const report = await resumeUpgrade(stateDir, target, { stateFormats: formats });
    expect(report.status).toBe("succeeded");
    expect(order).toEqual(["1-2", "2-3"]);
    expect(await readFile(path.join(stateDir, "migrations", "1-2", "state.json"), "utf8")).toBe(original);
    expect(JSON.parse(await readFile(path.join(stateDir, "migrations", "2-3", "budgets.json"), "utf8"))).toBeTypeOf("object");
    expect(existsSync(path.join(stateDir, "budgets.json"))).toBe(false);
    const state = await loadRunState(stateDir);
    expect(state.stateFormat).toBe(3);
    expect(state.stateMigrations?.map((m) => `${m.from}-${m.to}`)).toEqual(["1-2", "2-3"]);
    expect(state.installHistory?.[0]).toMatchObject({ fromStateFormat: 1, toStateFormat: 3 });
    // What the run accepted before the move is still there, byte for byte.
    expect(state.receipts.slice(0, (before.receipts as unknown[]).length)).toEqual(before.receipts);
    expect(state.evidence.slice(0, before.evidence.length)).toEqual(before.evidence);
  });

  it("refuses a migrator that changes accepted receipts, with the run unchanged", async () => {
    const { stateDir } = await stoppedRun();
    const before = await snapshot(stateDir);
    const formats: StateFormatRegistry = {
      current: 2,
      migrators: [
        {
          from: 1,
          to: 2,
          migrate(files) {
            const state = JSON.parse(files["state.json"]!) as { receipts: Array<{ valid: boolean }> };
            return { "state.json": JSON.stringify({ ...state, receipts: state.receipts.map((r) => ({ ...r, valid: false })), stateFormat: 2 }) };
          },
        },
      ],
    };
    await expect(resumeUpgrade(stateDir, target, { stateFormats: formats })).rejects.toThrow(/migrator 1-2 changed accepted receipts/);
    expect(await snapshot(stateDir)).toEqual(before);
  });

  const refusals: Array<{ name: string; edit?: (s: Record<string, unknown>) => void; target?: InstallRecord; formats?: StateFormatRegistry; error: RegExp }> = [
    { name: "a downgrade", edit: (s) => (s.install = { version: "0.2.0", root: "/opt/graphloom/versions/0.2.0" }), error: /downgrade: run up1 belongs to GraphLoom 0\.2\.0, which is newer than 0\.1\.0/ },
    { name: "a downgrade to a dev build of an older version", target: { version: "0.0.0-dev+abc1234", root: "/src/graphloom" }, edit: (s) => (s.install = { version: "0.0.1", root: "/x" }), error: /downgrade/ },
    { name: "crossing a major (0.x to 1.0)", target: { version: "1.0.0", root: "/opt/graphloom/versions/1.0.0" }, error: /another major version; a run never crosses a major version, so finish it on 0\.0\.0/ },
    { name: "an unknown future format", edit: (s) => (s.stateFormat = 7), error: /unknown state format 7: GraphLoom 0\.1\.0 writes format 1/ },
    { name: "a missing migrator", formats: { current: 3, migrators: [{ from: 1, to: 2, migrate: (f) => f }] }, error: /no state migrator from format 2 to 3/ },
    {
      name: "an unsettled repair activation",
      edit: (s) => (s.activationIntent = { artifactId: "cand-1", fromVersion: "fixture@1.0.0", toVersion: "fixture@repair-cand-1", generation: 1, at: "2026-10-27T00:00:00Z", status: "intent" }),
      error: /unsettled repair: the activation of candidate cand-1 is journaled but not settled.*resume the run on 0\.0\.0/,
    },
    { name: "a qualified candidate that is not activated", edit: (s) => (s.repairCandidates = [{ artifactId: "cand-2", status: "qualified" }]), error: /candidate cand-2 is qualified and not activated/ },
    {
      name: "an activated executor repair",
      edit: (s) =>
        (s.executorCatalog = [
          { id: "acme/x", digest: "c".repeat(64), source: "/old/acme", isolation: "sandbox", builtin: true, repair: { artifactId: "cand-3", root: "/run/cand-3", entryModule: "/run/cand-3/dist/index.js", baseDigest: "a".repeat(64) } },
        ]),
      error: /active repair: executor acme\/x runs the run-local copy cand-3/,
    },
    { name: "a run that is not stopped", edit: (s) => (s.status = "running"), error: /run up1 is running; only a stopped run can be moved/ },
    { name: "a plugin protocol change without --update-plugin", edit: (s) => ((s.intake as { bundle: { sdkProtocol: number } }).bundle.sdkProtocol = 2), error: /sdkProtocol 2.*combine --upgrade with --update-plugin/ },
  ];
  for (const refusal of refusals) {
    it(`refuses ${refusal.name}, with the run unchanged`, async () => {
      const { stateDir } = await stoppedRun();
      if (refusal.edit !== undefined) await editState(stateDir, refusal.edit);
      const before = await snapshot(stateDir);
      let moved = false;
      await expect(
        resumeUpgrade(stateDir, refusal.target ?? target, { ...(refusal.formats !== undefined ? { stateFormats: refusal.formats } : {}), onMoved: () => (moved = true) }),
      ).rejects.toThrow(refusal.error);
      expect(await snapshot(stateDir)).toEqual(before);
      expect(existsSync(path.join(stateDir, "migrations"))).toBe(false);
      expect(moved).toBe(false);
    });
  }

  it("lets the executor re-pin of --upgrade lift a final stop, as --update-executors does", async () => {
    const env = await makeEnv();
    const described = (source: string, digest: string): NonNullable<Runner["describeExecutors"]> => async () => [
      { id: "acme/extra", digest, source, isolation: "in-process", builtin: true },
    ];
    const first = writeRunner();
    first.describeExecutors = described("/old/acme", "a".repeat(64));
    const stopped = await createController().run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({ definition, advances: [...WRITE_STEPS, stop({ reason: "needs a maintainer", blocker: "final", retryable: false }, "final stop")] }),
      validators,
      runner: first,
      stateRoot: env.stateRoot,
      runId: "final1",
      install: OWNER,
    });
    expect(stopped.stopRetryable).toBe(false);
    const runner = reviewRunner();
    runner.describeExecutors = described("/new/acme", "b".repeat(64));
    const report = await resumeUpgrade(stopped.stateDir, target, { runner });
    expect(report.status).toBe("succeeded");
    const inspect = await createController().inspect(stopped.stateDir);
    expect(inspect.executorTransitions).toEqual([expect.objectContaining({ id: "acme/extra", fromSource: "/old/acme", toSource: "/new/acme" })]);
  });

  it("refuses --upgrade --update-plugin while an activated repair owns the plugin, with the run unchanged", async () => {
    const { stateDir } = await stoppedRun();
    await editState(stateDir, (s) => (s.activeVersion = "fixture@repair-cand-9"));
    const before = await snapshot(stateDir);
    await expect(
      createController().resume({
        runRef: stateDir,
        plugin: createScriptedGraph({ definition, advances: REVIEW_STEPS }),
        validators,
        runner: reviewRunner(),
        updatePlugin: true,
        upgrade: { install: target },
      }),
    ).rejects.toThrow(/active repair: the plugin runs the run-local copy fixture@repair-cand-9/);
    expect(await snapshot(stateDir)).toEqual(before);
  });

  it("moves a run across a plugin protocol change with --update-plugin and completes it", async () => {
    const { stateDir } = await stoppedRun();
    // The run pinned a bundle speaking another protocol; the installed bundle speaks this host's.
    await editState(stateDir, (s) => {
      const bundle = (s.intake as { bundle: { sdkProtocol: number; manifestDigest: string } }).bundle;
      bundle.sdkProtocol = 2;
      bundle.manifestDigest = "0".repeat(64);
    });
    const report = await createController().resume({
      runRef: stateDir,
      plugin: createScriptedGraph({ definition, advances: REVIEW_STEPS }),
      validators,
      runner: reviewRunner(),
      updatePlugin: true,
      upgrade: { install: target },
    });
    expect(report.status).toBe("succeeded");
    expect((await loadRunState(stateDir)).intake.bundle.sdkProtocol).toBe(1);
  });

  it("refuses an executor re-pin the update would refuse, with the run unchanged", async () => {
    const { stateDir } = await stoppedRun();
    await editState(stateDir, (s) => (s.executorCatalog = [{ id: "acme/gone", digest: "a".repeat(64), source: "/old/acme", isolation: "sandbox", builtin: false }]));
    const before = await snapshot(stateDir);
    const runner = reviewRunner();
    runner.describeExecutors = async () => [];
    await expect(resumeUpgrade(stateDir, target, { runner })).rejects.toThrow(/executor pin mismatch: pinned executor acme\/gone is no longer installed/);
    expect(await snapshot(stateDir)).toEqual(before);
  });
});

/** Placeholders a committed fixture uses for the paths and commit of the machine that captured it. */
const PLACEHOLDERS = ["@@STATE_DIR@@", "@@WORKTREE@@", "@@REPO@@", "@@TASK_DIR@@", "@@HEAD@@"] as const;

describe("committed state-format fixtures (docs/design-release.md §6 step 8)", () => {
  const fixtures = existsSync(fixturesRoot) ? readdirSync(fixturesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];

  it("has a fixture for the current format", async () => {
    const formats = await Promise.all(fixtures.map(async (name) => (JSON.parse(await readFile(path.join(fixturesRoot, name, "fixture.json"), "utf8")) as { stateFormat: number }).stateFormat));
    expect(formats).toContain(CURRENT_STATE_FORMAT);
  });

  for (const name of fixtures) {
    it(`moves fixture ${name} to this release and completes it on a scripted runner`, async () => {
      const dir = path.join(fixturesRoot, name);
      const meta = JSON.parse(await readFile(path.join(dir, "fixture.json"), "utf8")) as { runId: string; stateFormat: number; owner: InstallRecord; worktreeBranch: string };
      const bundle: Record<string, string> = {};
      for (const [rel, text] of Object.entries(await snapshot(path.join(dir, "bundle")))) bundle[rel] = text;
      const env = await makeEnv(bundle);
      const head = await git(env.repoPath, "rev-parse", "HEAD");
      const stateDir = path.join(env.stateRoot, meta.runId);
      const worktreePath = path.join(env.repoPath, "graphloom", meta.runId);
      await mkdir(path.dirname(worktreePath), { recursive: true });
      await git(env.repoPath, "worktree", "add", "-q", "-b", meta.worktreeBranch, worktreePath, head);
      await cp(path.join(dir, "worktree"), worktreePath, { recursive: true });
      const values: Record<(typeof PLACEHOLDERS)[number], string> = {
        "@@STATE_DIR@@": stateDir,
        "@@WORKTREE@@": worktreePath,
        "@@REPO@@": env.repoPath,
        "@@TASK_DIR@@": env.taskDir,
        "@@HEAD@@": head,
      };
      for (const [rel, text] of Object.entries(await snapshot(path.join(dir, "state")))) {
        const file = path.join(stateDir, rel);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, PLACEHOLDERS.reduce((t, p) => t.split(p).join(values[p]), text), "utf8");
      }

      const report = await resumeUpgrade(stateDir, target);
      expect(report.status).toBe("succeeded");
      const inspect = await createController().inspect(stateDir);
      expect(inspect.install).toEqual(target);
      expect(inspect.stateFormat).toBe(CURRENT_STATE_FORMAT);
      expect(inspect.installHistory).toEqual([expect.objectContaining({ from: meta.owner, to: target, fromStateFormat: meta.stateFormat, toStateFormat: CURRENT_STATE_FORMAT })]);
      expect(inspect.stateMigrations.map((m) => `${m.from}-${m.to}`)).toEqual(
        Array.from({ length: CURRENT_STATE_FORMAT - meta.stateFormat }, (_, i) => `${meta.stateFormat + i}-${meta.stateFormat + i + 1}`),
      );
      expect(inspect.stages.every((s) => s.complete)).toBe(true);
    });
  }

  it.skipIf(process.env.GRAPHLOOM_CAPTURE_STATE_FIXTURE === undefined)("captures the current format's fixture", async () => {
    const name = process.env.GRAPHLOOM_CAPTURE_STATE_FIXTURE!;
    const { env, stateDir } = await stoppedRun("fixture-run");
    const state = await loadRunState(stateDir);
    const out = path.join(fixturesRoot, name);
    await rm(out, { recursive: true, force: true });
    const replacements: Array<[string, string]> = (
      [
        [stateDir, "@@STATE_DIR@@"],
        [state.worktreePath, "@@WORKTREE@@"],
        [env.repoPath, "@@REPO@@"],
        [env.taskDir, "@@TASK_DIR@@"],
        [state.intake.pinnedHead, "@@HEAD@@"],
      ] as Array<[string, string]>
    ).sort((a, b) => b[0].length - a[0].length);
    for (const [rel, text] of Object.entries(await snapshot(stateDir))) {
      if (rel.startsWith("run.owner") || rel.includes(".tmp")) continue;
      const file = path.join(out, "state", rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, replacements.reduce((t, [from, to]) => t.split(from).join(to), text), "utf8");
    }
    for (const [rel, text] of Object.entries(BUNDLE_FILES)) {
      await mkdir(path.dirname(path.join(out, "bundle", rel)), { recursive: true });
      await writeFile(path.join(out, "bundle", rel), text, "utf8");
    }
    await mkdir(path.join(out, "worktree"), { recursive: true });
    await writeFile(path.join(out, "worktree", GREETING_PATH), await readFile(path.join(state.worktreePath, GREETING_PATH), "utf8"), "utf8");
    const meta = { runId: state.runId, stateFormat: state.stateFormat, owner: state.install, worktreeBranch: state.worktreeBranch, stoppedAfter: "Write" };
    await writeFile(path.join(out, "fixture.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  });
});
