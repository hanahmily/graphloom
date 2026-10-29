// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND, REVIEW_DIR, ledgerRef } from "./constants.js";

/**
 * The graph's own git commands (design §4). Each runs git on pinned trees
 * and writes files; none runs repository code.
 */

/** Git's empty tree, which Git knows without the object being stored. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * The environment of every one of them, passed as the job's `env` so the
 * checkout's argv stays exactly the fixed one:
 *
 * - no global or system Git configuration, so no filter, hook or textconv from there runs;
 * - the filesystem monitor is off, whatever the repository's own configuration says;
 * - attributes are read from the empty tree, so a `.gitattributes` the pull request carries (or any
 *   attribute in the working tree) can name no filter, which is how a pull request could otherwise
 *   activate a filter driver that the review clone's local configuration defines.
 *
 * Needs Git 2.40 or later for `GIT_ATTR_SOURCE`; the profile's own git check asks for 2.41.
 */
export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.fsmonitor",
  GIT_CONFIG_VALUE_0: "false",
  GIT_ATTR_SOURCE: EMPTY_TREE,
} as const;

/** The exit status of the guard when the head touches `.graphloom/`, which the graph reads as an incompatible task. */
export const GUARD_REFUSED = 3;

const GUARD =
  'set -eu; names=$(git -c core.hooksPath=/dev/null diff --name-only --no-renames HEAD "$1" -- .graphloom); ' +
  `if [ -n "$names" ]; then printf '%s\\n' "$names" | head -n 5 >&2; exit ${GUARD_REFUSED}; fi; echo clear`;

/**
 * Refuses a head that touches `.graphloom/` (design §4), from the Git objects alone and before anything is
 * checked out: the pinned base (HEAD) against the head commit. It lists the first paths on stderr.
 */
export const guardCommand = (head: string): EnvironmentCommand => ({ id: COMMAND.guard, argv: ["sh", "-c", GUARD, COMMAND.guard, head] });

/**
 * Materialization (design §4): the pinned base plus the head's tree, with files
 * the head does not have removed, and no hook (core.hooksPath is off).
 */
export const checkoutCommand = (head: string): EnvironmentCommand => ({
  id: COMMAND.checkout,
  argv: ["git", "-c", "core.hooksPath=/dev/null", "checkout", "--no-overlay", head, "--", "."],
});

const HEAD_TREE =
  'set -eu; head="$1"; printf "head=%s\\n" "$(git -c core.hooksPath=/dev/null rev-parse --verify "$head^{tree}")"; ' +
  'printf "index=%s\\n" "$(git -c core.hooksPath=/dev/null write-tree)"; printf "base=%s\\n" "$(git rev-parse --verify HEAD)"; ' +
  'if git -c core.hooksPath=/dev/null diff --quiet --no-ext-diff --no-textconv "$head" --; then echo worktree=clean; else echo worktree=dirty; fi';

/** What the worktree now holds, as facts the validator compares: the head's tree, the index's tree, the pinned base, and whether the files match. */
export const headTreeCommand = (head: string): EnvironmentCommand => ({ id: COMMAND.headTree, argv: ["sh", "-c", HEAD_TREE, COMMAND.headTree, head] });

const REVIEW_DIR_SCRIPT = `set -eu; mkdir -p ${REVIEW_DIR}; printf '*\\n' > ${REVIEW_DIR}/.gitignore; echo ready`;

/** `.graphloom/review/` with its own `.gitignore` (`*`), which keeps its files out of the candidate digest. */
export const reviewDirCommand = (): EnvironmentCommand => ({ id: COMMAND.reviewDir, argv: ["sh", "-c", REVIEW_DIR_SCRIPT, COMMAND.reviewDir] });

const LEDGER =
  'if sha=$(git -c core.hooksPath=/dev/null rev-parse --verify --quiet "$1^{commit}"); then echo "present $sha"; else echo absent; fi';

/** Reads the PR's ledger ref, or records it absent (design §9.1). */
export const ledgerReadCommand = (owner: string, repo: string, n: number): EnvironmentCommand => ({
  id: COMMAND.ledger,
  argv: ["sh", "-c", LEDGER, COMMAND.ledger, ledgerRef(owner, repo, n)],
});

export interface HeadTree {
  head: string;
  index: string;
  base: string;
  clean: boolean;
}

export function parseHeadTree(text: string): HeadTree | undefined {
  const kv = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = /^([a-z]+)=(\S+)$/.exec(raw.trim());
    if (m !== null) kv.set(m[1]!, m[2]!);
  }
  const head = kv.get("head");
  const index = kv.get("index");
  const base = kv.get("base");
  const worktree = kv.get("worktree");
  if (head === undefined || index === undefined || base === undefined || worktree === undefined) return undefined;
  return { head, index, base, clean: worktree === "clean" };
}

export type Ledger = { present: false } | { present: true; sha: string };

export function parseLedger(text: string): Ledger | undefined {
  const line = text.trim().split("\n").at(-1)?.trim() ?? "";
  if (line === "absent") return { present: false };
  const m = /^present ([0-9a-f]{40})$/.exec(line);
  return m === null ? undefined : { present: true, sha: m[1]! };
}
