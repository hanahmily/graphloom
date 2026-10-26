// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadRunState, parseTaskYaml, resolveStateDir, resolveUnderBase, type RepairDeps, type RepairReviewer } from "@graphloom/controller";
import type { EvidenceRecord } from "@graphloom/sdk";
import { assertAdmittedCandidateRoot, createCandidateReviewTools, createPiSupervisorSession, type PiSupervisorSession } from "@graphloom/supervisor";
import type { SupervisorConfig } from "./supervisor-config.js";

const execFileAsync = promisify(execFile);

const REVIEWER_SESSION_ID = "graphloom-repair-reviewer";

/**
 * GraphLoom's own `tsc` script, not the installed plugin's: `bundlePath` is `state.intake.bundle.bundlePath`,
 * which `applyActivateRepair` repoints at the activated repair's own candidate tree once any plugin-level
 * repair has ever been activated — and a candidate root never ships `node_modules` (reviewers must see
 * the whole tree; `linkDependencies` links only `@graphloom/*` packages beside it, never `typescript`).
 * Resolving `tsc/.bin` from `bundlePath` therefore breaks preflight for every repair after the first
 * plugin-level activation, regardless of target. GraphLoom's own installation always has `typescript` as
 * a real dependency, independent of whatever `bundlePath` currently is.
 * It runs as `process.execPath <tsc>`, never through its `#!/usr/bin/env node`
 * shebang: a release runs on its bundled Node, with no `node` on `PATH`
 * (docs/design-release.md §2.7).
 */
function resolveGraphloomTsc(): string {
  const require = createRequire(import.meta.url);
  const typescriptPkg = require.resolve("typescript/package.json");
  return path.join(path.dirname(typescriptPkg), "bin", "tsc");
}

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
  let resolvedSession: PiSupervisorSession | undefined;
  const reviewerSession = (): Promise<PiSupervisorSession> => {
    session ??= (async () => {
      const sessionDir = await mkdtemp(path.join(os.tmpdir(), "graphloom-repair-reviewer-"));
      const s = await createPiSupervisorSession({
        runId: REVIEWER_SESSION_ID,
        sessionDir,
        provider: config.provider,
        modelId: config.modelId,
        ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
        ...(config.agentDir !== undefined ? { agentDir: config.agentDir } : {}),
        ...(config.promptTimeoutMs !== undefined ? { promptTimeoutMs: config.promptTimeoutMs } : {}),
        ...(config.promptTotalTimeoutMs !== undefined ? { promptTotalTimeoutMs: config.promptTotalTimeoutMs } : {}),
      });
      resolvedSession = s;
      return s;
    })();
    return session;
  };

  const reviewer: RepairReviewer = {
    sessionId: REVIEWER_SESSION_ID,
    async review({ candidateRoot, baseRoot, target, reason, task, requirement, patchSummary, evidence, maxProviderCalls }) {
      // This reviewer always implements drainProviderCalls, so the controller always
      // reserves and passes an allowance; a missing one would be a caller bug, and
      // failing closed (refuse) is safer than prompting with no cap at all.
      const cap = maxProviderCalls ?? 0;
      if (cap <= 0) return { approved: false, reason: "no agentInvocations budget remains for independent review" };
      const repairsDir = path.dirname(path.dirname(candidateRoot));
      const root = await assertAdmittedCandidateRoot(repairsDir, candidateRoot);
      // baseRoot, not the fixed bundlePath: for an executor repair, the candidate is a
      // copy of that executor's own package, not of the plugin bundle — diffing against
      // the plugin would show the reviewer what looks like the candidate replacing the
      // entire plugin with unrelated code.
      const diff = await candidateDiff(baseRoot, root);
      const s = await reviewerSession();
      const text = await s.prompt(
        repairReviewPrompt({
          candidateRoot: root,
          target,
          reason,
          task,
          ...(requirement !== undefined ? { requirement } : {}),
          ...(patchSummary !== undefined ? { patchSummary } : {}),
          evidence,
          diff,
        }),
        {
          tools: createCandidateReviewTools(root),
          maxTurns: cap,
        },
      );
      return parseRepairVerdict(text);
    },
    drainProviderCalls() {
      return resolvedSession?.drainTurnCount?.() ?? 0;
    },
  };

  return {
    reviewer,
    async preflight({ candidateRoot, target }) {
      let tsc: string;
      try {
        tsc = resolveGraphloomTsc();
      } catch (err) {
        return { ok: false, summary: `graphloom's own typescript installation cannot be resolved: ${commandOutput(err)}` };
      }
      if (!(await exists(tsc))) {
        return { ok: false, summary: `graphloom's own typescript installation has no bin/tsc at ${tsc}` };
      }
      try {
        await execFileAsync(process.execPath, [tsc, "-p", path.join(candidateRoot, "tsconfig.json")]);
      } catch (err) {
        return { ok: false, summary: `the candidate does not build: ${commandOutput(err)}` };
      }
      // scripts/qualify.mjs requires the installed (unpatched) validators to fail a case the
      // candidate now passes: a validator-regression contract that does not apply to a plugin-
      // or executor-level patch (an environment/checklist fix, for example), which changes no
      // validator and would leave the installed copy passing every case, rejecting a good patch.
      // The controller's own describe()-compatibility and steps-pin checks already guard those.
      if (target !== "validator") {
        return { ok: true, summary: "the candidate builds; scripts/qualify.mjs judges validator patches only, skipped for this target" };
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

/** The reviewer's assignment: the original task and defect, the patch, its diff, and judge independently, read-only. */
export function repairReviewPrompt(args: {
  candidateRoot: string;
  target: string;
  reason: string;
  task: string;
  requirement?: string;
  patchSummary?: string;
  evidence: EvidenceRecord[];
  diff: string;
}): string {
  return [
    "You are an independent reviewer of a qualified repair candidate. You did not write this patch and cannot change it: your tools are read-only.",
    `Target: ${args.target}`,
    `Candidate root: ${args.candidateRoot}. Your working directory is the candidate root.`,
    "",
    "The run's original task:",
    clip(args.task, 4_000),
    ...(args.requirement !== undefined ? ["", "The disputed requirement:", clip(args.requirement, 1_000)] : []),
    "",
    "Why the supervisor requested this repair:",
    clip(args.reason, 2_000),
    ...(args.patchSummary !== undefined ? ["", "The patch author's own summary of what it changed:", clip(args.patchSummary, 2_000)] : []),
    ...(args.evidence.length > 0 ? ["", "Evidence the supervisor cited for the defect:", ...args.evidence.map(describeEvidence)] : []),
    "",
    "Diff from the installed version to this candidate:",
    args.diff,
    "",
    "Judge whether the patch fixes the defect above, without breaking the target's contract, without weakening tests or qualification cases, and without changing anything the patch was not scoped to. Use your read-only tools to read any file the diff does not make clear.",
    "Reply with exactly one line starting with `VERDICT: approved` or `VERDICT: rejected`, then a short plain-text reason (a few sentences, no private reasoning).",
  ].join("\n");
}

const MAX_DIFF_CHARS = 20_000;

/** A unified diff from the installed bundle to the candidate, bounded and excluding build/dependency output. */
export async function candidateDiff(bundlePath: string, candidateRoot: string): Promise<string> {
  const exclude = ["node_modules", "dist", ".git"].flatMap((d) => ["--exclude", d]);
  try {
    const { stdout } = await execFileAsync("diff", ["-ru", ...exclude, bundlePath, candidateRoot]);
    return stdout.trim() === "" ? "(no textual difference)" : clip(stdout, MAX_DIFF_CHARS);
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    // diff exits 1 when it found differences to report; anything else is a real failure.
    if (e.code === 1 && typeof e.stdout === "string") return clip(e.stdout, MAX_DIFF_CHARS);
    return `(could not compute a diff: ${commandOutput(err)})`;
  }
}

function describeEvidence(e: EvidenceRecord): string {
  const payload = typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload ?? {});
  return `- ${e.kind}: ${clip(payload, 800)}`;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
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

function commandOutput(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  return (e.stderr?.trim() || e.stdout?.trim() || e.message || String(err)).slice(0, 2000);
}
