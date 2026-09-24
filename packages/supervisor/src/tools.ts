/**
 * GraphLoom-owned supervisor tools / actions.
 * Pi default bash/edit/write stay disabled; the supervisor proposes admitted
 * GraphDecision actions only (JSON reply or propose_decision tool).
 */

export const GRAPHLOOM_SUPERVISOR_ACTIONS = [
  "dispatch",
  "observe",
  "validate",
  "reenter",
  "qualify_repair",
  "activate_repair",
  "return",
  "stop",
] as const;

export type GraphLoomSupervisorAction = (typeof GRAPHLOOM_SUPERVISOR_ACTIONS)[number];

/** Tool name for a terminating decision proposal (when customTools are wired). */
export const PROPOSE_DECISION_TOOL = "propose_decision";
