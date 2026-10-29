// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EnvironmentCommand } from "@graphloom/sdk";
import { COMMAND, REVIEW_DIR, ledgerRef } from "./constants.js";

/**
 * The graph's own git commands (design §4). Each runs git on pinned trees
 * and writes files; none runs repository code.
 */

/**
 * The environment of every one of them: no global or system Git configuration,
 * so no user filter, hook or textconv from there can run. Passed as the job's
 * `env`, so the checkout's argv is exactly the fixed one.
 */
export const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } as const;

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
