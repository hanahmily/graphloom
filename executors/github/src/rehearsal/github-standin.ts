/**
 * The GitHub executor's rehearsal stand-in (docs/design-graph-rehearsal.md
 * §4.6): `--offline`'s choice, not quick mode's default — GitHub reads are
 * real by default during a rehearsal (cheap, and they verify the operator's
 * token), so this is loaded in place of `../executors.js` only when the
 * caller explicitly asks to replay recorded reads instead. It serves every
 * read-only `graphloom.github/*` id from the active scenario's own `reads`;
 * a write id is never declared here at all, so it fails the same way an
 * unknown executor id always does, regardless of the binding's own
 * `allowedEffects` (read-only by default, §4.6 never asks for writes).
 *
 * A read the scenario has no recording for fails the job — never a
 * fabricated payload — and is logged so the evaluator can report the gap
 * under B2 once the rehearsal ends, independent of whatever the graph's own
 * recovery did with the failure.
 */
import { defineExecutor, nextRead, recordUnverifiedRead, requireScenario, type ExecutorDefinition } from "@graphloom/sdk";

const STAND_IN_NAME = "github";

/** Read-only ids this stand-in answers; a write id is simply not among them (../package.js's GITHUB_EXECUTOR_IDS also lists create/update/add/remove ids). */
const READ_EXECUTOR_IDS = [
  "graphloom.github/list-issues",
  "graphloom.github/list-pulls",
  "graphloom.github/get-issue",
  "graphloom.github/get-pull",
  "graphloom.github/get-file",
  "graphloom.github/list-issue-comments",
  "graphloom.github/list-labels",
  "graphloom.github/list-milestones",
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

export const executors = READ_EXECUTOR_IDS.map(readExecutor);
