// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  activateRepair,
  createScriptedGraph,
  dispatch,
  observe,
  qualifyRepair,
  returnToNormal,
  stop,
  validate,
  type GraphPlugin,
  type JobSpec,
  type Validator,
} from "@graphloom/sdk";
import { createScriptedRunner, type JobContext } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController, FINAL_STOP_HELD_REMEDY, loadRunState, type RepairDeps } from "@graphloom/controller";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = path.join(repoRoot, "examples/plugins/release");
const RELEASE_VERSION = (JSON.parse(readFileSync(path.join(bundle, "graphloom.manifest.json"), "utf8")) as { version: string }).version;
const tsc = path.join(repoRoot, "node_modules/typescript/bin/tsc");

const REQUEST = "Release version 1.2.0: record it in VERSION and add a CHANGELOG.md entry for the new export command.";
const BASE_CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] - 2026-08-01\n\n- Import command\n";
/** The installed copy's defect: its heading pattern drops the optional release date. */
const DATE_SUFFIX = "(?: - \\d{4}-\\d{2}-\\d{2})?";

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await rm(temps.pop()!, { recursive: true, force: true });
});

beforeAll(async () => {
  await execFileAsync("npm", ["run", "build", "-w", "@graphloom/plugin-release"], { cwd: repoRoot });
}, 120_000);

/**
 * A task beside an operator-installed copy of the release plugin, whose own
 * node_modules provides the SDK. `defective` installs it with a changelog
 * validator that rejects dated headings.
 */
async function makeEnv(opts: { defective?: boolean; grants?: boolean; request?: string } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gl-release-"));
  temps.push(dir);
  const repo = path.join(dir, "test-repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: repo });
  await git("init", "-q");
  await writeFile(path.join(repo, "VERSION"), "1.1.0\n");
  await writeFile(path.join(repo, "CHANGELOG.md"), BASE_CHANGELOG);
  await git("add", ".");
  await git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "init");

  const installed = path.join(dir, "plugins", "release");
  await cp(bundle, installed, { recursive: true, filter: (src) => path.basename(src) !== "node_modules" });
  await mkdir(path.join(installed, "node_modules", "@graphloom"), { recursive: true });
  await symlink(path.join(repoRoot, "packages/sdk"), path.join(installed, "node_modules", "@graphloom", "sdk"), "dir");
  if (opts.defective) {
    const source = path.join(installed, "src", "validators.ts");
    const shipped = await readFile(source, "utf8");
    expect(shipped).toContain(DATE_SUFFIX);
    await writeFile(source, shipped.replace(DATE_SUFFIX, ""));
    await execFileAsync(process.execPath, [tsc, "-p", path.join(installed, "tsconfig.json")]);
  }

  const taskPath = path.join(dir, "task.yaml");
  await writeFile(
    taskPath,
    `graph: release\nrepo: ./test-repo\nrequest: ${JSON.stringify(opts.request ?? REQUEST)}\n` +
      (opts.grants ? "grants:\n  sourceRepair: false\n  validatorSubstitution: true\n" : ""),
  );
  return { dir, installed, taskPath, stateRoot: path.join(dir, "state") };
}

type Job = (job: JobSpec, ctx: JobContext) => Promise<{ status: "ok"; summary: string; evidence?: { kind: "review"; payload: unknown }[] }>;

const bump: Job = async (_job, ctx) => {
  await writeFile(path.join(ctx.worktreePath, "VERSION"), "1.2.0\n");
  return { status: "ok", summary: "wrote VERSION" };
};
const changelog = (bullet: string): Job => async (_job, ctx) => {
  const entry = `## [1.2.0] - 2026-09-27\n\n- ${bullet}\n\n## [1.1.0]`;
  await writeFile(path.join(ctx.worktreePath, "CHANGELOG.md"), BASE_CHANGELOG.replace("## [1.1.0]", entry));
  return { status: "ok", summary: "added the 1.2.0 entry" };
};
const reviewer = (verdict: "approved" | "request_changes", summary: string): Job => async () => ({
  status: "ok",
  summary,
  evidence: [{ kind: "review", payload: { verdict, summary } }],
});

/** Scripted jobs in order, recording each job the controller dispatched. */
function runner(jobs: Job[]) {
  const seen: JobSpec[] = [];
  return {
    seen,
    runner: createScriptedRunner({
      jobs: jobs.map((run) => async (job: JobSpec, ctx: JobContext) => {
        seen.push(job);
        return run(job, ctx);
      }),
    }),
  };
}

const validReceipts = (receipts: { stageId: string; requirementId: string; valid: boolean }[]) =>
  receipts.filter((r) => r.valid).map((r) => `${r.stageId}/${r.requirementId}`);

/**
 * Repair deps whose preflight rebuilds the candidate, then runs the installed
 * copy's qualification cases against it, so the patch cannot edit the checks.
 */
function repairDeps(installed: string, supervisorSessionId: string, patch: (candidateRoot: string) => Promise<void>) {
  const reviewed: string[] = [];
  const deps: RepairDeps = {
    patchAuthor: {
      sessionId: supervisorSessionId,
      async patch({ candidateRoot }) {
        await patch(candidateRoot);
        await execFileAsync(process.execPath, [path.join(candidateRoot, "scripts", "generate-manifest.mjs")]);
        return { summary: "patched the changelog validator" };
      },
    },
    reviewer: {
      sessionId: "release-repair-reviewer",
      async review({ candidateRoot }) {
        reviewed.push(candidateRoot);
        return { approved: true, reason: "the heading pattern now matches the requirement statement" };
      },
    },
    async preflight({ candidateRoot }) {
      await execFileAsync(process.execPath, [tsc, "-p", path.join(candidateRoot, "tsconfig.json")]);
      try {
        const { stdout } = await execFileAsync(process.execPath, [path.join(installed, "scripts", "qualify.mjs"), candidateRoot]);
        return { ok: true, summary: `rebuilt dist; ${stdout.trim()}` };
      } catch (err) {
        return { ok: false, summary: `rebuilt dist; ${(err as { stdout?: string }).stdout?.trim() ?? String(err)}` };
      }
    },
  };
  return { deps, reviewed };
}

/**
 * Resume conformance (#145), through the controller and the installed bundle
 * in its child host, with no supervisor: a resume retries what failed, and a
 * final stop resumes to the same blocker.
 */
describe("the release example plugin on resume", () => {
  const failed: Job = async () => ({ status: "failed", summary: "agent finished without a result" }) as unknown as Awaited<ReturnType<Job>>;

  it("re-runs a reviewer that failed before the resume, and completes", async () => {
    const env = await makeEnv();
    const first = runner([bump, changelog("Export command"), failed]);
    const stopped = await createController().run({ taskPath: env.taskPath, runner: first.runner, stateRoot: env.stateRoot, runId: "release-review-failed" });
    expect(stopped, `${stopped.stopReason}: ${stopped.blocker}`).toMatchObject({ status: "stopped", stopRetryable: true });

    // The resume re-opens Bump and Changelog too (their accepted workspace
    // manifests no longer match once both files changed), so their writers
    // run again before the reviewer does.
    const second = runner([bump, changelog("Export command"), reviewer("approved", "VERSION and the 1.2.0 entry match the request.")]);
    const resumed = await createController().resume({ runRef: stopped.stateDir, runner: second.runner });
    expect(resumed.status, `${resumed.stopReason}: ${resumed.blocker}`).toBe("succeeded");
    expect(second.seen.at(-1)).toMatchObject({ stageId: "review", purpose: "review" });
    expect((await loadRunState(resumed.stateDir)).lastResume).toMatchObject({ previousStopRetryable: true, pluginUpdated: false });
  }, 60_000);

  it("re-runs a writer that failed before the resume, and completes", async () => {
    const env = await makeEnv();
    const first = runner([failed]);
    const stopped = await createController().run({ taskPath: env.taskPath, runner: first.runner, stateRoot: env.stateRoot, runId: "release-work-failed" });
    expect(stopped, `${stopped.stopReason}: ${stopped.blocker}`).toMatchObject({ status: "stopped", stopRetryable: true });

    const second = runner([bump, changelog("Export command"), reviewer("approved", "VERSION and the 1.2.0 entry match the request.")]);
    const resumed = await createController().resume({ runRef: stopped.stateDir, runner: second.runner });
    expect(resumed.status, `${resumed.stopReason}: ${resumed.blocker}`).toBe("succeeded");
    // The failed writer runs again; its unwritten VERSION is not observed and accepted.
    expect(second.seen.map((j) => [j.stageId, j.purpose])).toEqual([
      ["bump", "work"],
      ["changelog", "work"],
      ["review", "review"],
    ]);
    expect(await readFile(path.join(resumed.worktreePath, "VERSION"), "utf8")).toBe("1.2.0\n");
  }, 60_000);

  it("surfaces the same blocker after a final stop, without asking the graph", async () => {
    const env = await makeEnv({ request: "Release the next version with a CHANGELOG.md entry." });
    const stopped = await createController().run({ taskPath: env.taskPath, runner: runner([]).runner, stateRoot: env.stateRoot, runId: "release-final" });
    expect(stopped, `${stopped.stopReason}: ${stopped.blocker}`).toMatchObject({ status: "stopped", stopReason: "incompatible task", stopRetryable: false });
    const held = await createController().resume({ runRef: stopped.stateDir, runner: runner([]).runner });
    expect(held).toMatchObject({ status: "stopped", stopReason: "incompatible task", blocker: stopped.blocker, generation: stopped.generation });
    expect((await loadRunState(held.stateDir)).remedies?.at(-1)?.remedy).toBe(FINAL_STOP_HELD_REMEDY);
  }, 60_000);
});

describe("the release example plugin through the controller", () => {
  it("charges a Bump rewrite after resume sends the run back past an accepted Changelog", async () => {
    const env = await makeEnv();
    const release = (await import(pathToFileURL(path.join(bundle, "dist", "index.js")).href)) as {
      createGraph(): GraphPlugin;
      validatorById(id: string): Validator | undefined;
    };
    const definition = release.createGraph().describe();
    const validators = Object.fromEntries(
      definition.defaultValidators.map((b) => [b.validatorId, release.validatorById(b.validatorId)!]),
    );
    const writeJob = (stageId: string) =>
      dispatch(
        { stageId, kind: "agent", purpose: "work", instruction: `write ${stageId}`, writeScope: [stageId === "bump" ? "VERSION" : "CHANGELOG.md"] },
        `dispatch ${stageId}`,
      );
    // Bump's own observe names only VERSION, matching the real graph
    // (hello/release only ever observe a stage's own paths): observing
    // CHANGELOG.md too, before Changelog has even run, would anchor Bump's
    // receipt to a file it has no business tracking, and invalidate it the
    // moment Changelog later creates that file.
    const observeBump = observe({ paths: ["VERSION"], includeWorkspaceManifest: true }, "observe VERSION");
    const observeRelease = observe({ paths: ["VERSION", "CHANGELOG.md"], includeWorkspaceManifest: true }, "observe");
    const controller = createController();

    const paused = await controller.run({
      taskPath: env.taskPath,
      plugin: createScriptedGraph({
        definition,
        advances: [
          writeJob("bump"),
          observeBump,
          validate({ stageId: "bump", requirementIds: ["version-file"] }, "validate bump"),
          writeJob("changelog"),
          observeRelease,
          validate({ stageId: "changelog", requirementIds: ["changelog-entry", "release-scope"] }, "validate changelog"),
          stop({ reason: "paused", blocker: "before review" }, "pause"),
        ],
      }),
      validators,
      runner: runner([bump, changelog("Export command")]).runner,
      stateRoot: env.stateRoot,
      runId: "release-resume-bump",
    });
    expect(validReceipts(paused.receipts)).toEqual(["bump/version-file", "changelog/changelog-entry", "changelog/release-scope"]);
    expect((await loadRunState(paused.stateDir)).budgets.corrections).toBe(8);
    await writeFile(path.join(paused.worktreePath, "VERSION"), "v1.2.0\n");

    const resumed = await controller.resume({
      runRef: paused.stateDir,
      plugin: createScriptedGraph({
        definition,
        advances: [observeRelease, writeJob("bump"), stop({ reason: "paused", blocker: "rewrote bump" }, "pause")],
      }),
      validators,
      runner: runner([bump]).runner,
    });

    expect(resumed, `${resumed.stopReason}: ${resumed.blocker}`).toMatchObject({ stopReason: "paused", blocker: "rewrote bump" });
    const state = await loadRunState(paused.stateDir);
    // Bump ran as attempt 1; re-opened by the resume's invalidation it runs as attempt 2.
    expect(state.current).toEqual({ stageId: "bump", attempt: 2 });
    expect(validReceipts(state.receipts)).toEqual([]);
    expect(state.budgets.corrections).toBe(7);
  }, 60_000);

  it("runs Bump → Changelog → Review from its installed bundle, reentering Changelog on the reviewer's request", async () => {
    const env = await makeEnv();
    const { seen, runner: scripted } = runner([
      bump,
      changelog("Export command"),
      reviewer("request_changes", "Say that the export command writes CSV."),
      changelog("Export command, which writes CSV"),
      reviewer("approved", "VERSION and the 1.2.0 entry match the request."),
    ]);
    const report = await createController().run({ taskPath: env.taskPath, runner: scripted, stateRoot: env.stateRoot, runId: "release-1" });

    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(validReceipts(report.receipts)).toEqual([
      "bump/version-file",
      "changelog/changelog-entry",
      "changelog/release-scope",
      "review/release-review",
    ]);
    expect(seen.map((j) => [j.stageId, j.purpose])).toEqual([
      ["bump", "work"],
      ["changelog", "work"],
      ["review", "review"],
      ["changelog", "work"],
      ["review", "review"],
    ]);
    expect(seen[3]!.instruction).toContain("An independent reviewer asked for changes: Say that the export command writes CSV.");
    expect(await readFile(path.join(report.worktreePath, "VERSION"), "utf8")).toBe("1.2.0\n");
    expect(await readFile(path.join(report.worktreePath, "CHANGELOG.md"), "utf8")).toContain("- Export command, which writes CSV\n");
    const state = await loadRunState(report.stateDir);
    expect(state.intake.bundle.bundlePath).toBe(env.installed);
    expect(state.definition.stages.map((s) => s.id)).toEqual(["bump", "changelog", "review"]);
    // Only the reentry is charged; the rewrite it starts is the new generation's first Changelog job.
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections - 1);
  }, 60_000);

  it("qualifies and activates a source repair of its changelog validator, then completes without redoing accepted work", async () => {
    const env = await makeEnv({ defective: true, grants: true });
    const SUPERVISOR = "release-supervisor";
    let trigger: string | undefined;
    const supervisor = createScriptedSupervisor({
      sessionId: SUPERVISOR,
      decisions: [
        (input) => {
          trigger = input.trigger.message;
          return qualifyRepair(
            { target: "validator", requirementId: "changelog-entry", reason: "the changelog validator rejects dated release headings" },
            "repair the changelog validator",
          );
        },
        (input) => {
          const qualified = input.view.repairCandidates?.find((c) => c.status === "qualified");
          if (!qualified) throw new Error(`expected a qualified candidate, got ${JSON.stringify(input.view.repairCandidates)}`);
          return activateRepair({ qualifiedArtifactId: qualified.artifactId, reason: "use the fixed validator" }, "activate");
        },
        returnToNormal({ summary: "changelog validator repaired" }, "resume the release"),
      ],
    });
    const { deps: repair, reviewed } = repairDeps(env.installed, SUPERVISOR, (candidateRoot) =>
      copyFile(path.join(bundle, "src", "validators.ts"), path.join(candidateRoot, "src", "validators.ts")),
    );
    const { seen, runner: scripted } = runner([
      bump,
      changelog("Export command"),
      changelog("Export command"),
      reviewer("approved", "VERSION and the 1.2.0 entry match the request."),
    ]);

    const report = await createController().run({
      taskPath: env.taskPath,
      runner: scripted,
      supervisor,
      repair,
      stateRoot: env.stateRoot,
      runId: "release-repair",
    });

    expect(report.status, `${report.stopReason}: ${report.blocker}`).toBe("succeeded");
    expect(trigger).toMatch(/^changelog still fails validation: first release heading "## \[1\.2\.0\] - 2026-09-27" is not/);
    const state = await loadRunState(report.stateDir);
    const [candidate, ...others] = state.repairCandidates ?? [];
    expect(others).toEqual([]);
    expect(candidate).toMatchObject({
      status: "activated",
      target: "validator",
      preflightSummary:
        "rebuilt dist; candidate passes all 29 qualification cases; the old version fails " +
        "changelog-entry: dated heading (expected passed, got failed); " +
        "changelog-entry: bullet under a subsection (expected passed, got failed)",
      reviewReason: "the heading pattern now matches the requirement statement",
    });
    expect(reviewed).toEqual([candidate!.candidateRoot]);
    expect(state.activeVersion).toBe(`release@repair-${candidate!.artifactId}`);
    expect(state.activationIntent?.status).toBe("committed");
    expect(state.intake.bundle.bundlePath).toBe(candidate!.candidateRoot);
    expect(await readFile(path.join(candidate!.candidateRoot, "dist", "validators.js"), "utf8")).toContain("(?: - \\d{4}-\\d{2}-\\d{2})?");
    expect(await readFile(path.join(env.installed, "src", "validators.ts"), "utf8")).not.toContain(DATE_SUFFIX);

    // The receipt accepted before the repair stays on record, superseded by the one under the repaired validator.
    expect(state.receipts.map((r) => [`${r.stageId}/${r.requirementId}`, r.valid])).toEqual([
      ["bump/version-file", false],
      ["bump/version-file", true],
      ["changelog/changelog-entry", true],
      ["changelog/release-scope", true],
      ["review/release-review", true],
    ]);
    // After activation the graph revalidated Bump and Changelog from the worktree; no work was redone.
    expect(seen.map((j) => [j.stageId, j.purpose])).toEqual([
      ["bump", "work"],
      ["changelog", "work"],
      ["changelog", "work"],
      ["review", "review"],
    ]);
    // One for the Changelog correction after its own observation, one for the repair.
    expect(state.budgets.corrections).toBe(state.intake.budgets.corrections - 2);
  }, 90_000);

  it("rejects an always-passing changelog validator in qualification, before review, and keeps the installed version", async () => {
    const env = await makeEnv({ defective: true, grants: true });
    const SUPERVISOR = "release-supervisor";
    let rejected: { status: string; rejectionReason?: string } | undefined;
    const supervisor = createScriptedSupervisor({
      sessionId: SUPERVISOR,
      decisions: [
        qualifyRepair(
          { target: "validator", requirementId: "changelog-entry", reason: "the changelog validator rejects dated release headings" },
          "repair the changelog validator",
        ),
        (input) => {
          rejected = input.view.repairCandidates?.[0];
          return stop({ reason: "repair rejected", blocker: "no qualified changelog validator" }, "stop for the operator");
        },
      ],
    });
    const { deps: repair, reviewed } = repairDeps(env.installed, SUPERVISOR, async (candidateRoot) => {
      const source = path.join(candidateRoot, "src", "validators.ts");
      await writeFile(
        source,
        `${await readFile(source, "utf8")}\nchangelogEntryValidator.evaluate = () => ({ status: "passed", reason: "always passes" });\n`,
      );
    });
    const { runner: scripted } = runner([bump, changelog("Export command"), changelog("Export command")]);

    const report = await createController().run({
      taskPath: env.taskPath,
      runner: scripted,
      supervisor,
      repair,
      stateRoot: env.stateRoot,
      runId: "release-always-passes",
    });

    expect(report).toMatchObject({ status: "stopped", stopReason: "repair rejected" });
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.rejectionReason).toMatch(/^rebuilt dist; candidate fails \d+ of 29 qualification cases: /);
    for (const negative of ["mismatched VERSION", "heading without brackets", "no listed change"]) {
      expect(rejected?.rejectionReason).toContain(`changelog-entry: ${negative} (expected failed, got passed)`);
    }
    expect(reviewed).toEqual([]);
    const state = await loadRunState(report.stateDir);
    expect(state.activeVersion).toBe(`release@${RELEASE_VERSION}`);
    expect(state.intake.bundle.bundlePath).toBe(env.installed);
    expect(validReceipts(state.receipts)).toEqual(["bump/version-file"]);
  }, 90_000);
});
