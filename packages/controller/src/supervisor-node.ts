// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Supervisor-only nodes (docs/design-graph-topology.md §5): the supervisor
 * enters one in recovery (`enter`), which opens a side visit off the live
 * path; the node's work and validation run for it; the controller notices
 * when its validation settled the visit and hands the run to the supervisor
 * (`supervisor_node_settled`); only the supervisor leaves it, along one of
 * its declared out-edges.
 *
 * The controller knows only that entry to such a node is the supervisor's,
 * its visit cap and its out-edges. It never reads what the node is for, what
 * its requirements mean or which out-edge fits a result.
 */
import { isSupervisorOnly, successors, type GraphAction, type StageId } from "@graphloom/sdk";
import type { Inadmissible } from "./inadmissible.js";
import type { DurableRunState, VisitRecord } from "./state.js";
import { forwardRoute, nextSeq, pathIndex, runTopology, sideVisitOf, SUPERVISOR_ONLY_NODE, tailOf, UNDECLARED_EDGE, withPath, type PathState } from "./traversal.js";

/** The precondition a graph decision with `enter` names (§5.2). */
export const ENTER_IS_SUPERVISORS = "enter is the supervisor's";
/** The recovery trigger the controller opens when a side visit settles (§5.2). */
export const SUPERVISOR_NODE_SETTLED = "supervisor_node_settled";

/** Most evidence refs the settle trigger cites. */
const MAX_TRIGGER_REFS = 20;

type NodeState =PathState & Pick<DurableRunState, "mode">;

/** The visits of `stageId` the supervisor has opened. */
export function visitsOf(state: PathState, stageId: StageId): number {
  return withPath(state).visits.filter((v) => v.stageId === stageId && v.entered === "enter").length;
}

/**
 * Why `enter` of `stageId` is not admitted, or undefined (§5.2, §5.5): a
 * supervisor action only, in recovery; the node is supervisor-only, has
 * visits left, and no side visit is open.
 */
export function enterRefusal(state: NodeState, stageId: StageId): Inadmissible | undefined {
  if (state.mode !== "recovery") {
    return { precondition: ENTER_IS_SUPERVISORS, detail: `enter ${stageId}: only the supervisor enters a node, in recovery; the run is in ${state.mode} mode` };
  }
  const stage = state.definition.stages.find((s) => s.id === stageId);
  if (stage === undefined) {
    return {
      precondition: "undeclared stage",
      detail: `stageId ${stageId} is not in the pinned graph definition; stages are ${state.definition.stages.map((s) => s.id).join(", ")}`,
    };
  }
  const supervisorOnly = state.definition.stages.filter((s) => isSupervisorOnly(s)).map((s) => s.id);
  if (!isSupervisorOnly(stage)) {
    return {
      precondition: SUPERVISOR_ONLY_NODE,
      detail: `${stageId} is graph-entered: the run reaches it along edges, not by enter; supervisor-only nodes: ${supervisorOnly.length > 0 ? supervisorOnly.join(", ") : "none"}`,
    };
  }
  const open = sideVisitOf(state);
  if (open !== undefined) {
    return { precondition: SUPERVISOR_ONLY_NODE, detail: `the side visit of ${open.stageId} is open; leave it along one of its out-edges before entering ${stageId}` };
  }
  const used = visitsOf(state, stageId);
  const cap = stage.maxVisits ?? 0;
  if (used >= cap) {
    return { precondition: SUPERVISOR_ONLY_NODE, detail: `${stageId} has used ${used} of its ${cap} visits (maxVisits ${cap}); it cannot be entered again in this run` };
  }
  return undefined;
}

/**
 * Opens a side visit of `stageId`, entered from the tail: `current` becomes
 * the node under its next attempt and the attempt is open. No correction, no
 * generation bump (§5.2, §7.4). Assumes `enterRefusal` admitted it.
 */
export function enterNode<T extends NodeState & Pick<DurableRunState, "stageAttempts" | "openAttempt">>(state: T, stageId: StageId, attempt: number): T {
  const base = withPath(state);
  const visit: VisitRecord = {
    seq: nextSeq(base.visits),
    stageId,
    attempt,
    entered: "enter",
    from: tailOf(base).seq,
    generation: base.generation,
    operation: "enter",
  };
  return {
    ...base,
    visits: [...base.visits, visit],
    sideVisit: visit.seq,
    current: { stageId, attempt },
    stageAttempts: { ...base.stageAttempts, [stageId]: attempt },
    openAttempt: { ...base.openAttempt, [stageId]: true },
  };
}

/**
 * Why an action is not admitted while a side visit is open, or undefined
 * (§5.2). Dispatch and validate name only the open node (`forwardRefusal`
 * enforces that for both modes); here: the graph may not `reenter` or stop
 * `complete`, and the supervisor may `reenter` only along the node's
 * out-edges (`leaveRefusal`).
 */
export function sideVisitRefusal(state: NodeState, action: GraphAction): Inadmissible | undefined {
  const side = sideVisitOf(state);
  if (side === undefined) return undefined;
  if (state.mode === "recovery") return action.type === "reenter" ? leaveRefusal(state, action.reenter.stageId || state.current.stageId) : undefined;
  if (action.type === "reenter") {
    return { precondition: SUPERVISOR_ONLY_NODE, detail: `reenter ${action.reenter.stageId}: the side visit of ${side.stageId} is open; only the supervisor leaves it` };
  }
  if (action.type === "stop" && action.stop.reason === "complete") {
    return { precondition: SUPERVISOR_ONLY_NODE, detail: `stop complete: the side visit of ${side.stageId} is open; only the supervisor leaves it` };
  }
  return undefined;
}

/**
 * Why the supervisor's `reenter { stageId: X }` out of the open side visit is
 * not admitted, or undefined (§4.4, §5.2): a declared edge `S → X`, and, for
 * X off the live path, a forward move from the tail that reaches it.
 */
export function leaveRefusal(state: NodeState, to: StageId): Inadmissible | undefined {
  const side = sideVisitOf(state);
  if (side === undefined) return undefined;
  const exits = successors(runTopology(state.definition), side.stageId);
  if (!exits.includes(to)) {
    return {
      precondition: UNDECLARED_EDGE,
      detail: `leave ${side.stageId} to ${to}: the supervisor leaves a supervisor-only node along one of its out-edges; out-edges of ${side.stageId}: ${exits.map((x) => `${side.stageId} → ${x}`).join(", ")}`,
    };
  }
  if (pathIndex(state, to) >= 0) return undefined;
  if (forwardRoute(closed(state), to) !== undefined) return undefined;
  return {
    precondition: UNDECLARED_EDGE,
    detail: `leave ${side.stageId} to ${to}: ${to} is off the live path and no route of declared edges leads from the tail ${tailOf(state).stageId} to it across accepted nodes`,
  };
}

/** The state with the open side visit closed, ending as `ended`; its node's attempt is no longer open. */
export function closeSideVisit<T extends PathState>(state: T, ended: string): T {
  const side = sideVisitOf(state);
  if (side === undefined) return state;
  const base = withPath(state);
  const visits = base.visits.map((v) => (v.seq === side.seq && v.ended === undefined ? { ...v, ended } : v));
  const { [side.stageId]: _open, ...openAttempt } = base.openAttempt ?? {};
  void _open;
  const { sideVisit: _closed, ...rest } = { ...base, visits, openAttempt };
  void _closed;
  return rest as T;
}

function closed<T extends PathState>(state: T): T {
  const { sideVisit: _closed, ...rest } = state;
  void _closed;
  return rest as T;
}

/**
 * Records on the open side visit what a validation of its node minted: the
 * new receipts (one per requirement) and each requirement's reason. A
 * validation that minted none leaves the visit as it was.
 */
export function recordSettlement<T extends PathState>(
  state: T,
  receipts: readonly string[],
  outcomes: ReadonlyArray<{ requirementId: string; reason: string }>,
): T {
  const side = sideVisitOf(state);
  if (side === undefined || receipts.length === 0) return state;
  const base = withPath(state);
  const settlement = { receipts: [...receipts], reasons: outcomes.map((o) => ({ requirementId: o.requirementId, reason: o.reason })) };
  return { ...base, visits: base.visits.map((v) => (v.seq === side.seq ? { ...v, settlement } : v)) };
}

/**
 * The open side visit when it is settled (§5.2): its latest validation
 * minted a receipt for every requirement of its node, and each is still
 * valid. Undefined when no side visit is open or it is not settled.
 */
export function settledSideVisit(state: PathState): VisitRecord | undefined {
  const side = sideVisitOf(state);
  if (side?.settlement === undefined) return undefined;
  const stage = state.definition.stages.find((s) => s.id === side.stageId);
  if (stage === undefined) return undefined;
  const minted = new Set(side.settlement.receipts);
  const holds = stage.requirementIds.every((id) => state.receipts.some((r) => minted.has(r.id) && r.requirementId === id && r.stageId === side.stageId && r.valid));
  return holds ? side : undefined;
}

/**
 * The `supervisor_node_settled` trigger for a settled side visit: a message
 * citing each receipt with its requirement, binding and the validator's
 * reason, and the evidence the receipts accepted.
 */
export function settledTrigger(state: PathState, side: VisitRecord, bound: (text: string) => string): { message: string; evidenceRefs: string[] } {
  const minted = new Set(side.settlement?.receipts ?? []);
  const receipts = state.receipts.filter((r) => minted.has(r.id));
  const reasons = new Map((side.settlement?.reasons ?? []).map((r) => [r.requirementId, r.reason]));
  const cited = receipts
    .map((r) => `${r.id} (${r.requirementId}, validator ${r.validatorBinding.validatorId} v${r.validatorBinding.version}): ${reasons.get(r.requirementId) ?? "passed"}`)
    .join("; ");
  const exits = successors(runTopology(state.definition), side.stageId).map((x) => `${side.stageId} → ${x}`).join(", ");
  const message = bound(
    `supervisor-only node ${side.stageId} settled in visit ${side.seq} (attempt ${side.attempt}): ${cited}. Leave it with reenter along an out-edge (${exits}).`,
  );
  // The newest records the receipts accepted; a receipt names every record of its candidate.
  return { message, evidenceRefs: [...new Set(receipts.flatMap((r) => r.evidenceRefs))].slice(-MAX_TRIGGER_REFS) };
}
