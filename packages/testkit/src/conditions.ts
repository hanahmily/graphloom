// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GitRepo } from "./git.js";
import type { TaskBudgets } from "./task.js";

/** The directory GraphLoom graphs keep their own files in, inside a run's worktree. */
export const GRAPHLOOM_DIR = ".graphloom";

/**
 * The repository's own root `.gitignore` ignores `.graphloom/`, as
 * GraphLoom's does (#140: issue-fix's delivery named the ignored path in a
 * `git add` pathspec, which exits 1).
 */
export async function ignoreGraphloomDir(repo: GitRepo): Promise<void> {
  const at = path.join(repo.path, ".gitignore");
  const existing = await readFile(at, "utf8").catch(() => "");
  await repo.write({ ".gitignore": `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${GRAPHLOOM_DIR}/\n` });
  await repo.commit(`ignore ${GRAPHLOOM_DIR}/`, { paths: [".gitignore"] });
}

/** Files the repository itself tracks under `.graphloom/` (#140 review: the delivery must keep them). */
export const TRACKED_GRAPHLOOM_FILES: Record<string, string> = {
  [`${GRAPHLOOM_DIR}/README.md`]: "The repository's own notes, tracked under .graphloom/.\n",
};

export async function trackUnderGraphloomDir(repo: GitRepo, files: Record<string, string> = TRACKED_GRAPHLOOM_FILES): Promise<string[]> {
  await repo.write(files);
  await repo.commit(`track files under ${GRAPHLOOM_DIR}/`, { force: true, paths: Object.keys(files) });
  return Object.keys(files);
}

/** Node replaces a timer delay above this with 1ms (and warns). */
export const NODE_MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Active-time and wait budgets of 30 days, above setTimeout's 2^31-1 ms limit,
 * as the #121 dogfood task set them (#138: the deadline timer fired every
 * millisecond). Merge into a task's budgets.
 */
export const EXTREME_BUDGETS: Required<Pick<TaskBudgets, "activeMs" | "waitMs">> = {
  activeMs: 30 * 24 * 60 * 60 * 1000,
  waitMs: 30 * 24 * 60 * 60 * 1000,
};

export interface WarningWatch {
  /** Names of the process warnings seen so far (`TimeoutOverflowWarning`, ...). */
  readonly warnings: string[];
  /** Overflowed timers seen so far. */
  timerOverflows(): number;
  dispose(): void;
}

/** Collect this process's warnings until disposed (a long budget must not overflow a timer). */
export function watchProcessWarnings(): WarningWatch {
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.name);
  process.on("warning", onWarning);
  return {
    warnings,
    timerOverflows: () => warnings.filter((w) => w === "TimeoutOverflowWarning").length,
    dispose: () => process.off("warning", onWarning),
  };
}
