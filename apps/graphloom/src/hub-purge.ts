// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Purging an archived hub submission's run files (docs/design-run-hub.md §4.3):
 * the run's state directory `<hub>/runs/<runId>`, its worktree and branch, through
 * the controller's run deletion, and the run's ownership records, so neither the
 * run's owning version nor a version its plugin link resolves into stays pinned
 * for `self prune`. The archive index entry is kept and marked by the caller.
 */
import { existsSync } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { assertSafeRunId, deleteManagedRun } from "@graphloom/controller";
import type { HubPurgeReport } from "@graphloom/sdk";
import { boundedText } from "./hub-input.js";
import { removeOwnershipRecord } from "./ownership.js";

export interface PurgeTarget {
  hubDirectory: string;
  submissionId: string;
  runId: string;
  /** The repository the archive entry recorded, when the index still holds it. */
  repoPath?: string;
}
export interface PurgeOptions {
  dryRun?: boolean;
  /** Discard uncommitted worktree changes and branch commits beyond the run's pinned head, as `graphloom delete --force`. */
  force?: boolean;
  /** Install homes whose `runs/<runId>.json` may name this run, besides the one its state records. */
  installHomes?: readonly string[];
}

/** What the run's state says about its worktree, owner and repository; empty when it cannot be read. */
interface RunFacts { worktreePath?: string; branch?: string; repoPath?: string; installHome?: string; }

async function runFacts(stateDir: string, runId: string): Promise<RunFacts> {
  let state: unknown;
  try { state = JSON.parse(await boundedText(path.join(stateDir, "state.json"), 64 * 1024 * 1024)); }
  catch { return {}; }
  if (!isObject(state) || state.runId !== runId) return {};
  const repoPath = isObject(state.intake) && typeof state.intake.repoPath === "string" && path.isAbsolute(state.intake.repoPath) ? state.intake.repoPath : undefined;
  const expected = repoPath !== undefined ? path.join(repoPath, "graphloom", runId) : undefined;
  const root = isObject(state.install) && typeof state.install.root === "string" && path.isAbsolute(state.install.root) ? state.install.root : undefined;
  // An installed version lives at <home>/versions/<version>.
  const installHome = root !== undefined && path.basename(path.dirname(root)) === "versions" ? path.dirname(path.dirname(root)) : undefined;
  return {
    ...(expected !== undefined && state.worktreePath === expected ? { worktreePath: expected, branch: `graphloom/${runId}` } : {}),
    ...(repoPath !== undefined ? { repoPath } : {}),
    ...(installHome !== undefined ? { installHome } : {}),
  };
}

/** Disk use (allocated blocks) of a tree, not following links; 0 when it is missing. */
export async function treeBytes(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const stat = await lstat(current).catch(() => undefined);
    if (!stat) continue;
    total += stat.blocks * 512;
    if (!stat.isDirectory()) continue;
    for (const name of await readdir(current).catch(() => [] as string[])) pending.push(path.join(current, name));
  }
  return total;
}

/**
 * Removes (or with `dryRun` measures) an archived submission's run files. Idempotent:
 * a missing state directory reports `alreadyPurged`, and a purge interrupted after the
 * worktree went is finished by the next one. Refusals (uncommitted changes or unpushed
 * commits without `force`, a live controller, a run another hub or submission owns) throw.
 */
export async function purgeRunFiles(target: PurgeTarget, options: PurgeOptions = {}): Promise<HubPurgeReport> {
  const runId = assertSafeRunId(target.runId);
  const hubDirectory = path.resolve(target.hubDirectory);
  const stateDir = path.join(hubDirectory, "runs", runId);
  const facts = await runFacts(stateDir, runId);
  const repoPath = target.repoPath ?? facts.repoPath ?? await readlink(path.join(hubDirectory, "submissions", target.submissionId, "repo")).catch(() => undefined);
  const present = existsSync(stateDir);
  const bytes = (await treeBytes(stateDir)) + (facts.worktreePath !== undefined ? await treeBytes(facts.worktreePath) : 0);
  const base: HubPurgeReport = {
    id: target.submissionId, runId, stateDir,
    ...(facts.worktreePath !== undefined ? { worktreePath: facts.worktreePath } : {}),
    ...(facts.branch !== undefined ? { branch: facts.branch } : {}),
    bytes, ...(present ? {} : { alreadyPurged: true }),
  };
  if (options.dryRun) return { ...base, dryRun: true };
  if (present) {
    if (repoPath === undefined || !path.isAbsolute(repoPath)) throw new Error(`cannot purge run ${runId}: its repository is unknown`);
    await deleteManagedRun(stateDir, { hubStateDir: hubDirectory, submissionId: target.submissionId, runId, repoPath, ...(options.force ? { force: true } : {}) });
  }
  // The run's ownership record pins its version (and its plugin link's) while the state
  // exists; remove it too, from every home that may hold it, only where it names this run.
  const removed: string[] = [];
  for (const home of new Set([...(facts.installHome !== undefined ? [facts.installHome] : []), ...(options.installHomes ?? [])])) {
    const file = path.join(home, "runs", `${runId}.json`);
    if (!existsSync(file)) continue;
    await removeOwnershipRecord(home, runId, stateDir);
    if (!existsSync(file)) removed.push(file);
  }
  return { ...base, ...(removed.length > 0 ? { ownershipRecords: removed } : {}) };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
