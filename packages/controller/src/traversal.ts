// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The traversal engine (docs/design-graph-topology.md §4): every run walks
 * its graph's nodes along edges, a definition without `edges` as the implicit
 * chain (`normalizeTopology`). The live path is the walk from the start node
 * to the tail with every closed cycle erased; visits are its history.
 *
 * Pure functions over durable state. Routing reads the tail, never `current`.
 * The controller learns nothing here about what a node means: only its id,
 * its requirements' receipts, and the declared edges.
 */
import { isSupervisorOnly, normalizeTopology, successors, type GraphDefinition, type GraphTopology, type StageAttempt, type StageId, type TopologyView } from "@graphloom/sdk";
import type { Inadmissible } from "./inadmissible.js";
import type { DurableRunState, VisitEntry, VisitRecord } from "./state.js";

/** The precondition every refused move along the graph names (§4.3, §4.4). */
export const UNDECLARED_EDGE = "undeclared edge";
/** The precondition an action refused while a supervisor-only node's side visit is open names (§5.2). */
export const SUPERVISOR_ONLY_NODE = "supervisor-only node";

const topologies = new WeakMap<GraphDefinition, GraphTopology>();

/** The run's topology: the declared one, or the implicit chain of a definition without edges. */
export function runTopology(definition: GraphDefinition): GraphTopology {
  let topology = topologies.get(definition);
  if (topology === undefined) {
    topology = normalizeTopology(definition);
    topologies.set(definition, topology);
  }
  return topology;
}

/** The state a path computation reads. */
export type PathState = Pick<DurableRunState, "definition" | "current" | "receipts" | "generation" | "path" | "visits" | "stageAttempts" | "agentSessions" | "openAttempt" | "sideVisit">;

/**
 * The attempt a node last ran under: the highest it recorded, its agent
 * sessions', or the current attempt when the run is on it; 1 for a node that
 * never ran. (`nextStageAttempt` is this plus one.)
 */
export function latestAttempt(state: Pick<PathState, "current" | "stageAttempts" | "agentSessions">, stageId: StageId): number {
  const recorded = state.stageAttempts?.[stageId] ?? 0;
  const fromSessions = Math.max(0, ...(state.agentSessions ?? []).filter((r) => r.stageId === stageId).map((r) => r.attempt));
  const current = state.current.stageId === stageId ? state.current.attempt : 0;
  return Math.max(1, recorded, fromSessions, current);
}

/**
 * The live path a state without one has (§11.3): for a definition without
 * edges, the prefix of the list through the furthest stage that has a
 * recorded attempt, any receipt, or is current, each a `migrated` visit with
 * the stage's latest attempt. A declared topology starts at its start node.
 */
export function derivePath(state: Pick<PathState, "definition" | "current" | "receipts" | "generation" | "stageAttempts" | "agentSessions">): { path: number[]; visits: VisitRecord[] } {
  const topology = runTopology(state.definition);
  let ids: StageId[];
  if (topology.implicit) {
    const stages = state.definition.stages.map((s) => s.id);
    let furthest = 0;
    stages.forEach((id, i) => {
      const reached = state.stageAttempts?.[id] !== undefined || state.receipts.some((r) => r.stageId === id) || state.current.stageId === id;
      if (reached) furthest = i;
    });
    ids = stages.slice(0, furthest + 1);
  } else {
    ids = [topology.start];
  }
  const visits: VisitRecord[] = ids.map((stageId, i) => ({
    seq: i + 1,
    stageId,
    attempt: latestAttempt(state, stageId),
    entered: "migrated",
    ...(i > 0 ? { from: i } : {}),
    generation: state.generation,
    operation: "migration",
  }));
  return { path: visits.map((v) => v.seq), visits };
}

/** The state with its path and visits recorded (derived once for a state that has none). */
export function withPath<T extends PathState>(state: T): T & { path: number[]; visits: VisitRecord[] } {
  if (state.path !== undefined && state.visits !== undefined) return state as T & { path: number[]; visits: VisitRecord[] };
  return { ...state, ...derivePath(state) };
}

/** The first visit of a fresh run: the start node, attempt 1. */
export function startPath(definition: GraphDefinition, generation: number): { path: number[]; visits: VisitRecord[] } {
  const start = runTopology(definition).start;
  return { path: [1], visits: [{ seq: 1, stageId: start, attempt: 1, entered: "start", generation, operation: "intake" }] };
}

/** The live path's visits, start first; the last is the tail. */
export function livePath(state: PathState): VisitRecord[] {
  const { path, visits } = withPath(state);
  const bySeq = new Map(visits.map((v) => [v.seq, v]));
  return path.map((seq) => {
    const visit = bySeq.get(seq);
    if (visit === undefined) throw new Error(`run state names visit ${seq} on its live path but records no such visit`);
    return visit;
  });
}

export function tailOf(state: PathState): VisitRecord {
  const path = livePath(state);
  const tail = path.at(-1);
  if (tail === undefined) throw new Error("run state has an empty live path");
  return tail;
}

/** The open side visit of a supervisor-only node (§5.2), or undefined. */
export function sideVisitOf(state: PathState): VisitRecord | undefined {
  if (state.sideVisit === undefined) return undefined;
  const visit = withPath(state).visits.find((v) => v.seq === state.sideVisit);
  if (visit === undefined) throw new Error(`run state names side visit ${state.sideVisit} but records no such visit`);
  return visit;
}

/** The node's position on the live path, or -1. */
export function pathIndex(state: PathState, stageId: StageId): number {
  return livePath(state).findIndex((v) => v.stageId === stageId);
}

function isGraphEntered(definition: GraphDefinition, stageId: StageId): boolean {
  const stage = definition.stages.find((s) => s.id === stageId);
  return stage !== undefined && !isSupervisorOnly(stage);
}

/** Every requirement of the node has a valid receipt (as recorded; admission invalidates by identity first). */
export function nodeComplete(state: Pick<PathState, "definition" | "receipts">, stageId: StageId): boolean {
  const stage = state.definition.stages.find((s) => s.id === stageId);
  if (stage === undefined) return false;
  return stage.requirementIds.every((id) => state.receipts.some((r) => r.stageId === stageId && r.requirementId === id && r.valid));
}

/** §4.1: complete, and not opened by a reentry since its last validation. */
export function nodeAccepted(state: Pick<PathState, "definition" | "receipts" | "openAttempt">, stageId: StageId): boolean {
  return nodeComplete(state, stageId) && state.openAttempt?.[stageId] !== true;
}

/**
 * A shortest route from the tail along edges between graph-entered nodes to a
 * node `goal` accepts, through nodes `pass` accepts, entering no node already
 * on the live path. Neighbours are taken in `stages` order, so the choice
 * between equally short routes is deterministic. Returns the nodes after the
 * tail, the goal last.
 */
function routeFromTail(state: PathState, goal: (node: StageId) => boolean, pass: (node: StageId) => boolean): StageId[] | undefined {
  const topology = runTopology(state.definition);
  const onPath = new Set(livePath(state).map((v) => v.stageId));
  const order = new Map(state.definition.stages.map((s, i) => [s.id, i]));
  const tail = tailOf(state).stageId;
  const next = (node: StageId) =>
    successors(topology, node)
      .filter((to) => isGraphEntered(state.definition, to) && !onPath.has(to))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const parent = new Map<StageId, StageId>();
  const seen = new Set<StageId>([tail]);
  const queue: StageId[] = [tail];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const to of next(node)) {
      if (seen.has(to)) continue;
      seen.add(to);
      parent.set(to, node);
      if (goal(to)) {
        const route = [to];
        for (let at = node; at !== tail; at = parent.get(at)!) route.unshift(at);
        return route;
      }
      if (pass(to)) queue.push(to);
    }
  }
  return undefined;
}

/** The tail's out-edges, for a refusal's detail. */
function outEdges(state: PathState, from: StageId): string {
  const to = successors(runTopology(state.definition), from);
  return to.length === 0 ? "none" : to.map((t) => `${from} → ${t}`).join(", ");
}

function pathText(state: PathState): string {
  return livePath(state).map((v) => `${v.stageId}#${v.attempt}`).join(" → ");
}

/**
 * §4.3: why an action naming `stageId` is not a forward move, or undefined
 * when the node is on the live path or a forward move reaches it. Reads the
 * receipts as recorded, which is what the graph saw when it chose the node.
 */
export function forwardRefusal(state: PathState, stageId: StageId): Inadmissible | undefined {
  const tail = tailOf(state).stageId;
  // §5.2: while a side visit is open, the only node an action may name is its own.
  const side = sideVisitOf(state);
  if (side !== undefined) {
    if (stageId === side.stageId) return undefined;
    return {
      precondition: SUPERVISOR_ONLY_NODE,
      detail: `tail ${tail}, node ${stageId}: the side visit of supervisor-only node ${side.stageId} is open; only actions for ${side.stageId} are admitted until the supervisor leaves it`,
    };
  }
  if (pathIndex(state, stageId) >= 0) return undefined;
  if (forwardRoute(state, stageId) !== undefined) return undefined;
  const why = !isGraphEntered(state.definition, stageId)
    ? `${stageId} is supervisor-only`
    : `no route of declared edges leads from ${tail} to ${stageId} across accepted nodes off the live path`;
  return {
    precondition: UNDECLARED_EDGE,
    detail: `tail ${tail}, node ${stageId}: ${why}; live path ${pathText(state)}; out-edges of ${tail}: ${outEdges(state, tail)}`,
  };
}

/** The nodes a forward move to `stageId` appends after the tail (carried ones first, the node last), or undefined. */
export function forwardRoute(state: PathState, stageId: StageId): StageId[] | undefined {
  if (state.sideVisit !== undefined || !isGraphEntered(state.definition, stageId) || pathIndex(state, stageId) >= 0) return undefined;
  return routeFromTail(state, (node) => node === stageId, (node) => nodeAccepted(state, node));
}

export function nextSeq(visits: readonly VisitRecord[]): number {
  return Math.max(0, ...visits.map((v) => v.seq)) + 1;
}

/** Appends `route` to the live path: every node but the last carried, the last entered as `last`. */
function extend<T extends PathState>(state: T, route: StageId[], last: { entered: VisitEntry; attempt: number }, operation: string): T & { path: number[]; visits: VisitRecord[] } {
  const base = withPath(state);
  const visits = [...base.visits];
  const path = [...base.path];
  let from = path.at(-1);
  route.forEach((stageId, i) => {
    const final = i === route.length - 1;
    const visit: VisitRecord = {
      seq: nextSeq(visits),
      stageId,
      attempt: final && last.entered !== "carried" ? last.attempt : latestAttempt(base, stageId),
      entered: final ? last.entered : "carried",
      ...(from !== undefined ? { from } : {}),
      generation: base.generation,
      operation,
    };
    visits.push(visit);
    path.push(visit.seq);
    from = visit.seq;
  });
  return { ...base, path, visits };
}

/**
 * §4.3: the state after an action naming `stageId`: unchanged for a node on
 * the live path (a supporting action), the path extended by a forward move
 * otherwise. `attempt` is the attempt the node's new visit runs under (the
 * one `current` takes).
 */
export function moveTo<T extends PathState>(state: T, stageId: StageId, attempt: number, operation: string): { state: T } | { refusal: Inadmissible } {
  const refusal = forwardRefusal(state, stageId);
  if (refusal !== undefined) return { refusal };
  // A node on the live path, or the open side visit's own (§5.2): the path does not change.
  if (pathIndex(state, stageId) >= 0 || state.sideVisit !== undefined) return { state };
  return { state: extend(state, forwardRoute(state, stageId)!, { entered: "edge", attempt }, operation) };
}

/**
 * §4.4: why `reenter` of `stageId` is not admitted, or undefined. The graph
 * reenters the tail, or a live-path node along a declared edge from the tail;
 * the supervisor any live-path node. A node ahead of the path is never
 * reentered: the run moves forward to it.
 */
export function reentryRefusal(state: PathState & Pick<DurableRunState, "mode">, stageId: StageId): Inadmissible | undefined {
  const tail = tailOf(state).stageId;
  if (pathIndex(state, stageId) < 0) {
    return {
      precondition: UNDECLARED_EDGE,
      detail: `tail ${tail}, node ${stageId}: reenter names a node that is not on the live path ${pathText(state)}; to go ahead, the run moves forward`,
    };
  }
  if (state.mode === "recovery" || stageId === tail) return undefined;
  if (successors(runTopology(state.definition), tail).includes(stageId)) return undefined;
  return {
    precondition: UNDECLARED_EDGE,
    detail: `tail ${tail}, node ${stageId}: the graph reenters along a declared edge from the tail; out-edges of ${tail}: ${outEdges(state, tail)}`,
  };
}

/**
 * Truncates the live path at `stageId`'s visit and replaces it with a new one
 * (§4.4): what a reentry does to the path, and a resume that sends the run
 * back to a node (§7.1). The removed visits stay in `visits`, each recording
 * the reentry that removed it.
 */
export function reenterPath<T extends PathState>(state: T, stageId: StageId, attempt: number, operation: string, from?: number): T & { path: number[]; visits: VisitRecord[] } {
  const base = withPath(state);
  const index = livePath(base).findIndex((v) => v.stageId === stageId);
  if (index < 0) throw new Error(`reentry of ${stageId}, which is not on the live path`);
  const removed = new Set(base.path.slice(index));
  const tail = base.path.at(-1)!;
  // §7.1: a truncation that removes the visit an open side visit was entered from closes the side visit.
  const side = sideVisitOf(base);
  const orphaned = side !== undefined && side.from !== undefined && removed.has(side.from) ? side : undefined;
  const visits = base.visits.map((v) =>
    v.ended !== undefined ? v : removed.has(v.seq) ? { ...v, ended: `replaced by reentry of ${stageId}` } : v.seq === orphaned?.seq ? { ...v, ended: `closed by reentry of ${stageId}` } : v,
  );
  const visit: VisitRecord = { seq: nextSeq(visits), stageId, attempt, entered: "reenter", from: from ?? tail, generation: base.generation, operation };
  const next = { ...base, path: [...base.path.slice(0, index), visit.seq], visits: [...visits, visit] };
  if (orphaned === undefined) return next;
  const { [orphaned.stageId]: _open, ...openAttempt } = next.openAttempt ?? {};
  void _open;
  const { sideVisit: _closed, ...rest } = { ...next, openAttempt };
  void _closed;
  return rest as T & { path: number[]; visits: VisitRecord[] };
}

/**
 * §4.6: the state with the live path carried forward from a non-terminal
 * tail to a terminal node, along a route on which every node after the tail
 * is accepted; the state unchanged when the tail is terminal or no such route
 * exists.
 */
export function carryToTerminal<T extends PathState>(state: T): T {
  const topology = runTopology(state.definition);
  if (state.sideVisit !== undefined || topology.terminal.includes(tailOf(state).stageId)) return state;
  const terminal = new Set(topology.terminal);
  const route = routeFromTail(state, (node) => terminal.has(node) && nodeAccepted(state, node), (node) => nodeAccepted(state, node));
  return route === undefined ? state : extend(state, route, { entered: "carried", attempt: 0 }, "stop");
}

/** §4.6: why the live path does not complete the run, or undefined when it does (delivery drift aside). */
export function completionProblem(state: PathState): string | undefined {
  const topology = runTopology(state.definition);
  const tail = tailOf(state).stageId;
  if (state.sideVisit !== undefined) return "a side visit of a supervisor-only node is open";
  if (!topology.terminal.includes(tail)) return `the live path ${pathText(state)} ends at ${tail}, not a terminal node (${topology.terminal.join(", ")})`;
  const open = livePath(state).find((v) => !nodeAccepted(state, v.stageId));
  if (open !== undefined) return `${open.stageId} on the live path is not accepted`;
  return undefined;
}

/**
 * The graph-entered nodes not strictly before `stageId` on the live path:
 * the node itself, every node after it, and every node off the path. On an
 * implicit chain (whose live path is a prefix of the list) these are the
 * stage and every later one, the set a positional invalidation named.
 */
export function nodesFrom(state: PathState, stageId: StageId): Set<StageId> {
  const index = pathIndex(state, stageId);
  const before = new Set(livePath(state).slice(0, index < 0 ? livePath(state).length : index).map((v) => v.stageId));
  before.delete(stageId);
  return new Set(state.definition.stages.filter((s) => !isSupervisorOnly(s) && !before.has(s.id)).map((s) => s.id));
}

/** Marks every valid receipt of `nodes` invalid. */
export function invalidateNodes<T extends Pick<DurableRunState, "receipts" | "stateRevision">>(state: T, nodes: ReadonlySet<StageId>): T {
  return { ...state, receipts: state.receipts.map((r) => (r.valid && nodes.has(r.stageId) ? { ...r, valid: false } : r)), stateRevision: state.stateRevision + 1 };
}

/**
 * §7.3: activation restarts the live path at the start node: every
 * graph-entered node's receipts become invalid, the path becomes a new visit
 * of the start node with attempt 1, and `current` that visit.
 */
export function restartAtStart<T extends PathState & Pick<DurableRunState, "stateRevision">>(state: T, operation: string): T & { path: number[]; visits: VisitRecord[] } {
  const base = withPath(state);
  const start = runTopology(base.definition).start;
  const graphNodes = new Set(base.definition.stages.filter((s) => !isSupervisorOnly(s)).map((s) => s.id));
  // The live path's visits and an open side visit close (§7.3).
  const removed = new Set([...base.path, ...(base.sideVisit !== undefined ? [base.sideVisit] : [])]);
  const visits = base.visits.map((v) => (removed.has(v.seq) && v.ended === undefined ? { ...v, ended: "closed by activation" } : v));
  const visit: VisitRecord = { seq: nextSeq(visits), stageId: start, attempt: 1, entered: "start", from: base.path.at(-1)!, generation: base.generation, operation };
  const { sideVisit: _closed, ...restarted } = { ...invalidateNodes(base, graphNodes), path: [visit.seq], visits: [...visits, visit], current: { stageId: start, attempt: 1 } };
  void _closed;
  return restarted as T & { path: number[]; visits: VisitRecord[] };
}

/** The declared parts of a definition its topology is made of: the node set with each node's entry and visit cap, and `edges`, `start`, `terminal`. */
export type DeclaredTopology = Pick<GraphDefinition, "edges" | "start" | "terminal"> & {
  stages: ReadonlyArray<Pick<GraphDefinition["stages"][number], "id" | "entry" | "maxVisits">>;
};

const edgeText = (e: { from: StageId; to: StageId }) => `${e.from} → ${e.to}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The node set's changes: ids added or removed, or the same ids reordered (a step-list change, reported as the stages'). */
export function nodeChanges(candidate: Pick<DeclaredTopology, "stages">, base: Pick<DeclaredTopology, "stages">): string[] {
  const changes: string[] = [];
  const baseIds = base.stages.map((s) => s.id);
  const candidateIds = candidate.stages.map((s) => s.id);
  for (const id of candidateIds) if (!baseIds.includes(id)) changes.push(`node ${id} added`);
  for (const id of baseIds) if (!candidateIds.includes(id)) changes.push(`node ${id} removed`);
  if (changes.length === 0 && !same(candidateIds, baseIds)) changes.push("nodes reordered");
  return changes;
}

/**
 * What `candidate` declares differently from `base` about the topology
 * (docs/design-graph-topology.md §7.3), each named: nodes added, removed or
 * reordered (a chain's edges follow the order), a node's `entry` or
 * `maxVisits`, edges added, removed or reordered, `start`, `terminal`. The
 * comparison is of what each declares, not of the normalized topology: a
 * chain (no `edges`) and a definition declaring the same edges differ. Empty
 * when the two declare the same topology.
 */
export function topologyChanges(candidate: DeclaredTopology, base: DeclaredTopology): string[] {
  const changes = nodeChanges(candidate, base);
  for (const want of base.stages) {
    const got = candidate.stages.find((s) => s.id === want.id);
    if (got === undefined) continue;
    if (got.entry !== want.entry) changes.push(`node ${want.id} entry ${want.entry ?? "(none)"} → ${got.entry ?? "(none)"}`);
    if (got.maxVisits !== want.maxVisits) changes.push(`node ${want.id} maxVisits ${want.maxVisits ?? "(none)"} → ${got.maxVisits ?? "(none)"}`);
  }
  const edgePairs = (edges: DeclaredTopology["edges"]) => edges?.map((e) => ({ from: e.from, to: e.to }));
  if (!same(edgePairs(candidate.edges), edgePairs(base.edges))) {
    if (base.edges === undefined) changes.push("edges declared (the run walks an implicit chain)");
    else if (candidate.edges === undefined) changes.push("edges removed (the run walks a declared topology)");
    else {
      const baseEdges = base.edges.map(edgeText);
      const candidateEdges = candidate.edges.map(edgeText);
      const edgeChanges = [
        ...candidateEdges.filter((e) => !baseEdges.includes(e)).map((e) => `edge ${e} added`),
        ...baseEdges.filter((e) => !candidateEdges.includes(e)).map((e) => `edge ${e} removed`),
      ];
      changes.push(...(edgeChanges.length > 0 ? edgeChanges : ["edges reordered"]));
    }
  }
  if (!same(candidate.start, base.start)) changes.push(`start ${base.start ?? "(default)"} → ${candidate.start ?? "(default)"}`);
  if (!same(candidate.terminal, base.terminal)) changes.push(`terminal ${base.terminal?.join(", ") ?? "(default)"} → ${candidate.terminal?.join(", ") ?? "(default)"}`);
  return changes;
}

/** `RunView.topology`: the topology with its defaults, the live path and an open side visit. */
export function topologyView(state: PathState & Pick<DurableRunState, "sideVisit">): TopologyView {
  const topology = runTopology(state.definition);
  const visits = withPath(state).visits;
  const side = state.sideVisit !== undefined ? visits.find((v) => v.seq === state.sideVisit) : undefined;
  const attemptOf = (v: VisitRecord): StageAttempt => ({ stageId: v.stageId, attempt: v.attempt });
  return {
    start: topology.start,
    terminal: [...topology.terminal],
    edges: topology.edges.map((e) => ({ from: e.from, to: e.to })),
    implicit: topology.implicit,
    path: livePath(state).map(attemptOf),
    ...(side !== undefined ? { sideVisit: attemptOf(side) } : {}),
  };
}
