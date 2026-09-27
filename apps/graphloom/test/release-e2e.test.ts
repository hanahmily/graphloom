import { execFile } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { activateRepair, qualifyRepair, returnToNormal, type JobSpec } from "@graphloom/sdk";
import { createScriptedRunner, type JobContext } from "@graphloom/runner";
import { createScriptedSupervisor } from "@graphloom/supervisor";
import { createController, loadRunState, type RepairDeps } from "@graphloom/controller";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const bundle = path.join(repoRoot, "examples/plugins/release");
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
async function makeEnv(opts: { defective?: boolean; grants?: boolean } = {}) {
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
    `graph: release\nrepo: ./test-repo\nrequest: ${JSON.stringify(REQUEST)}\n` +
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

describe("the release example plugin through the controller", () => {
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
    const reviewed: string[] = [];
    const repair: RepairDeps = {
      patchAuthor: {
        sessionId: SUPERVISOR,
        async patch({ candidateRoot }) {
          await copyFile(path.join(bundle, "src", "validators.ts"), path.join(candidateRoot, "src", "validators.ts"));
          await execFileAsync(process.execPath, [path.join(candidateRoot, "scripts", "generate-manifest.mjs")]);
          return { summary: "accept an optional release date after the heading's version" };
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
        return { ok: true, summary: "rebuilt dist from the patched source" };
      },
    };
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
      preflightSummary: "rebuilt dist from the patched source",
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
  }, 90_000);
});
