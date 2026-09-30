import { execFile } from "node:child_process";
import { access, constants, mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadRunState, parseTaskYaml, resolveStateDir, resolveUnderBase, type RepairDeps, type RepairReviewer } from "@graphloom/controller";
import { assertAdmittedCandidateRoot, createCandidateReviewTools, createPiSupervisorSession, type PiSupervisorSession } from "@graphloom/supervisor";
import type { SupervisorConfig } from "./supervisor-config.js";

const execFileAsync = promisify(execFile);

const REVIEWER_SESSION_ID = "graphloom-repair-reviewer";

/** Where the task's plugin bundle is installed, the same way the controller's intake resolves it. */
export async function resolveBundlePath(taskPath: string): Promise<string> {
  const absoluteTask = path.resolve(taskPath);
  const task = parseTaskYaml(await readFile(absoluteTask, "utf8"));
  return resolveUnderBase(path.join(path.dirname(absoluteTask), "plugins"), task.graph, "graph bundle");
}

/** Where a resuming run's plugin bundle is installed, from its own pinned intake. */
export async function resolveBundlePathForResume(runRef: string, stateRoot?: string): Promise<string> {
  const stateDir = await resolveStateDir(runRef, stateRoot);
  const state = await loadRunState(stateDir);
  return state.intake.bundle.bundlePath;
}

/**
 * Qualified repair hooks for `graphloom run`/`resume`: an independent
 * read-only Pi reviewer, in a session distinct from the supervisor's, and a
 * preflight that rebuilds the candidate and runs the installed bundle's own
 * `scripts/qualify.mjs` against it, so a patch cannot weaken the cases that
 * judge it. `patchAuthor` is left unset: the live supervisor session patches
 * the candidate in-band, through its own `grantCandidateCoding`.
 */
export function piRepairDeps(config: SupervisorConfig, bundlePath: string): RepairDeps {
  let session: Promise<PiSupervisorSession> | undefined;
  const reviewerSession = (): Promise<PiSupervisorSession> => {
    session ??= (async () => {
      const sessionDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-repair-reviewer-"));
      return createPiSupervisorSession({
        runId: REVIEWER_SESSION_ID,
        sessionDir,
        provider: config.provider,
        modelId: config.modelId,
        ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
        ...(config.promptTimeoutMs !== undefined ? { promptTimeoutMs: config.promptTimeoutMs } : {}),
      });
    })();
    return session;
  };

  const reviewer: RepairReviewer = {
    sessionId: REVIEWER_SESSION_ID,
    async review({ candidateRoot, target }) {
      const repairsDir = path.dirname(path.dirname(candidateRoot));
      const root = await assertAdmittedCandidateRoot(repairsDir, candidateRoot);
      const s = await reviewerSession();
      const text = await s.prompt(repairReviewPrompt({ candidateRoot: root, target }), {
        tools: createCandidateReviewTools(root),
      });
      return parseRepairVerdict(text);
    },
  };

  return {
    reviewer,
    async preflight({ candidateRoot }) {
      const tsc = path.join(bundlePath, "node_modules", ".bin", "tsc");
      if (!(await isExecutable(tsc))) {
        return { ok: false, summary: `the installed plugin has no node_modules/.bin/tsc; run npm ci in ${bundlePath}` };
      }
      try {
        await execFileAsync(tsc, ["-p", path.join(candidateRoot, "tsconfig.json")]);
      } catch (err) {
        return { ok: false, summary: `the candidate does not build: ${commandOutput(err)}` };
      }
      const qualify = path.join(bundlePath, "scripts", "qualify.mjs");
      if (!(await exists(qualify))) {
        return { ok: true, summary: "the candidate builds; the installed plugin has no scripts/qualify.mjs to run" };
      }
      try {
        const { stdout } = await execFileAsync(process.execPath, [qualify, candidateRoot]);
        return { ok: true, summary: `the candidate builds; ${stdout.trim()}` };
      } catch (err) {
        return { ok: false, summary: `the candidate builds, but qualification failed: ${commandOutput(err)}` };
      }
    },
  };
}

/** The reviewer's assignment: judge the candidate independently, read-only. */
export function repairReviewPrompt(args: { candidateRoot: string; target: string }): string {
  return [
    "You are an independent reviewer of a qualified repair candidate. You did not write this patch and cannot change it: your tools are read-only.",
    `Target: ${args.target}`,
    `Candidate root: ${args.candidateRoot}. Your working directory is the candidate root.`,
    "Read the patch and judge whether it fixes the defect it claims to, without breaking the target's contract, without weakening tests or qualification cases, and without changing anything the patch was not scoped to.",
    "Reply with exactly one line starting with `VERDICT: approved` or `VERDICT: rejected`, then a short plain-text reason (a few sentences, no private reasoning).",
  ].join("\n");
}

const VERDICT = /^VERDICT:\s*(approved|rejected)\b/im;

/** The reviewer's verdict line, fail-closed: anything unparseable is not approved. */
export function parseRepairVerdict(text: string): { approved: boolean; reason: string } {
  const match = VERDICT.exec(text);
  if (!match) return { approved: false, reason: `the reviewer gave no VERDICT line: ${text.trim().slice(0, 500)}` };
  const reason = text.slice(match.index + match[0].length).trim() || text.trim();
  return { approved: match[1]!.toLowerCase() === "approved", reason };
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

async function isExecutable(p: string): Promise<boolean> {
  return access(p, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function commandOutput(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  return (e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)).slice(0, 2000);
}
