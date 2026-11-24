// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The GitHub executor's rehearsal stand-in (docs/design-graph-rehearsal.md
 * §4.6): `--offline`'s choice, not quick mode's default — GitHub reads are
 * real by default during a rehearsal (cheap, and they verify the operator's
 * token), so this is loaded in place of `../executors.js` only when the
 * caller explicitly asks to replay recorded reads instead. It serves every
 * read-only `graphloom.github/*` id from the active scenario's own `reads`.
 *
 * It declares every write id of the real module too, with the real id,
 * version, effect and input checks, so a graph sees the same executor catalog
 * offline as online: the binding's `allowedEffects` (read-only in a rehearsal,
 * §4.6 never asks for writes) withholds the write, and a graph that reads its
 * grant (`effectGranted: false`, such as a review graph that then stops with
 * `posting not enabled`) ends as it would online. A write that runs anyway
 * fails: a stand-in never writes, and never reaches GitHub.
 *
 * A read the scenario has no recording for fails the job — never a
 * fabricated payload — and is logged so the evaluator can report the gap
 * under B2 once the rehearsal ends, independent of whatever the graph's own
 * recovery did with the failure.
 */
import { defineExecutor, nextRead, recordUnverifiedRead, requireScenario, type ExecutorDefinition } from "@graphloom/sdk";
import { executors as realExecutors } from "../executors.js";

const STAND_IN_NAME = "github";

/** Read-only ids this stand-in answers; a write id is simply not among them (../package.js's GITHUB_EXECUTOR_IDS also lists create/update/add/remove ids). */
const READ_EXECUTOR_IDS = [
  "graphloom.github/list-issues",
  "graphloom.github/list-pulls",
  "graphloom.github/get-issue",
  "graphloom.github/get-pull",
  "graphloom.github/get-viewer",
  "graphloom.github/get-file",
  "graphloom.github/list-issue-comments",
  "graphloom.github/list-labels",
  "graphloom.github/list-milestones",
  "graphloom.github/list-pull-files",
  "graphloom.github/list-pull-commits",
  "graphloom.github/list-pull-reviews",
  "graphloom.github/list-pull-review-comments",
  "graphloom.github/list-review-threads",
  "graphloom.github/list-check-runs",
] as const;

function readExecutor(id: string): ExecutorDefinition<unknown, unknown> {
  return defineExecutor<unknown, unknown>({
    id,
    version: "1",
    effect: "read",
    async execute() {
      // Seam guard (§4.2): refuse before touching anything else.
      const scenario = requireScenario(STAND_IN_NAME);
      const read = nextRead(scenario, id);
      if (read === undefined) {
        recordUnverifiedRead(id);
        return { status: "failed", summary: `rehearsal stand-in: no recorded read for ${id} (--offline has no scenario.reads entry)` };
      }
      return { status: "ok", summary: "replayed recorded read (stand-in)", evidence: [{ kind: "other", payload: { github: read } }] };
    },
  });
}

/** A write id as the real module declares it, minus its network capabilities, whose execution always fails: a rehearsal never writes. */
function writeExecutor(real: ExecutorDefinition<unknown, unknown>): ExecutorDefinition<unknown, unknown> {
  const { id, version, effect, inputSchema, inputProblem, inputShape } = real;
  return defineExecutor<unknown, unknown>({
    id,
    effect,
    ...(version !== undefined ? { version } : {}),
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(inputProblem !== undefined ? { inputProblem } : {}),
    ...(inputShape !== undefined ? { inputShape } : {}),
    async execute() {
      requireScenario(STAND_IN_NAME);
      return { status: "failed", summary: `rehearsal stand-in: ${id} is a write, and a rehearsal never writes to GitHub` };
    },
  });
}

export const executors = [
  ...READ_EXECUTOR_IDS.map(readExecutor),
  ...(realExecutors as ExecutorDefinition<unknown, unknown>[]).filter((e) => e.effect === "write").map(writeExecutor),
];
