// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A graph's nodes and edges as pure data (docs/design-graph-topology.md §3):
 * the definition rules `assertGraphDefinition` applies, the implicit chain a
 * definition without `edges` becomes, and reachability over the result.
 */

import type { EdgeDefinition, GraphDefinition, GraphTopology, StageDefinition, StageId } from "./types.js";

/** Most nodes a definition may declare. */
export const MAX_GRAPH_NODES = 64;
/** Most edges a definition may declare. */
export const MAX_GRAPH_EDGES = 256;
/** Largest `maxVisits` a node may declare. */
export const MAX_NODE_VISITS = 64;

/** The parts of a definition its topology is a function of. */
export type TopologySource = Pick<GraphDefinition, "stages" | "edges" | "start" | "terminal">;

/** A node only the supervisor enters (`entry: "supervisor"`). */
export function isSupervisorOnly(stage: Pick<StageDefinition, "entry">): boolean {
  return stage.entry === "supervisor";
}

/**
 * The definition's topology with its defaults applied. Without `edges`, the
 * implicit chain of §3.3: for each stage in order, its forward edge to the next
 * stage and then its back edges to every earlier stage; start the first stage,
 * terminal the last. With `edges`: those edges, `start` or the first
 * graph-entered node, and `terminal` or every graph-entered node with no
 * out-edge. Assumes a definition `assertGraphDefinition` accepts.
 */
export function normalizeTopology(definition: TopologySource): GraphTopology {
  if (definition.edges === undefined) {
    const ids = uniqueIds(definition.stages);
    if (ids.length === 0) throw new Error("a definition without stages has no topology");
    const edges: EdgeDefinition[] = [];
    ids.forEach((from, i) => {
      if (i + 1 < ids.length) edges.push({ from, to: ids[i + 1]! });
      for (let j = 0; j < i; j++) edges.push({ from, to: ids[j]! });
    });
    return { start: ids[0]!, terminal: [ids[ids.length - 1]!], edges, implicit: true };
  }
  const edges = definition.edges.map((e) => ({ from: e.from, to: e.to }));
  const graphNodes = uniqueIds(definition.stages.filter((s) => !isSupervisorOnly(s)));
  const start = definition.start ?? graphNodes[0];
  if (start === undefined) throw new Error("a definition without a graph-entered node has no start");
  const leaving = new Set(edges.map((e) => e.from));
  const terminal = definition.terminal !== undefined ? [...definition.terminal] : graphNodes.filter((id) => !leaving.has(id));
  return { start, terminal, edges, implicit: false };
}

/** The targets of `node`'s out-edges, in edge order. */
export function successors(topology: Pick<GraphTopology, "edges">, node: StageId): StageId[] {
  return topology.edges.filter((e) => e.from === node).map((e) => e.to);
}

/**
 * Every node reachable from `from` (itself included) along edges whose two
 * ends both pass `through` (default: every node).
 */
export function reachableFrom(topology: Pick<GraphTopology, "edges">, from: StageId, through: (node: StageId) => boolean = () => true): Set<StageId> {
  return closure(topology.edges, [from], through, (e) => [e.from, e.to]);
}

/**
 * Every node from which one of `targets` is reachable (the targets included)
 * along edges whose two ends both pass `through` (default: every node).
 */
export function reachingTo(topology: Pick<GraphTopology, "edges">, targets: Iterable<StageId>, through: (node: StageId) => boolean = () => true): Set<StageId> {
  return closure(topology.edges, [...targets], through, (e) => [e.to, e.from]);
}

function closure(edges: EdgeDefinition[], seeds: StageId[], through: (node: StageId) => boolean, direction: (e: EdgeDefinition) => [StageId, StageId]): Set<StageId> {
  const next = new Map<StageId, StageId[]>();
  for (const e of edges) {
    const [a, b] = direction(e);
    if (!through(a) || !through(b)) continue;
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const seen = new Set<StageId>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    for (const b of next.get(queue.shift()!) ?? []) {
      if (seen.has(b)) continue;
      seen.add(b);
      queue.push(b);
    }
  }
  return seen;
}

/**
 * The first problem the definition rules of §3.2 find, or undefined. Assumes
 * the shapes are checked (`assertGraphDefinition` does both).
 */
export function topologyProblem(definition: TopologySource): string | undefined {
  const stages = definition.stages;
  if (stages.length > MAX_GRAPH_NODES) return `definition declares ${stages.length} nodes, more than ${MAX_GRAPH_NODES}`;
  const edges = definition.edges;
  if (edges === undefined) {
    if (definition.start !== undefined) return "definition.start needs declared edges";
    if (definition.terminal !== undefined) return "definition.terminal needs declared edges";
    for (const [i, s] of stages.entries()) {
      if (isSupervisorOnly(s)) return `definition.stages[${i}].entry "supervisor" needs declared edges`;
      if (s.maxVisits !== undefined) return `definition.stages[${i}].maxVisits needs declared edges`;
    }
    return undefined;
  }
  if (edges.length > MAX_GRAPH_EDGES) return `definition declares ${edges.length} edges, more than ${MAX_GRAPH_EDGES}`;

  const byId = new Map<StageId, StageDefinition>();
  for (const [i, s] of stages.entries()) {
    if (byId.has(s.id)) return `definition.stages[${i}].id repeats node ${s.id}`;
    byId.set(s.id, s);
  }
  const supervisorOnly = (id: StageId) => isSupervisorOnly(byId.get(id)!);

  const seen = new Set<string>();
  for (const [i, e] of edges.entries()) {
    for (const end of [e.from, e.to]) {
      if (!byId.has(end)) return `definition.edges[${i}] names undeclared node ${end}`;
    }
    if (e.from === e.to) return `definition.edges[${i}] is a self-loop on ${e.from}; a retry of a node is a reentry of it`;
    const key = JSON.stringify([e.from, e.to]);
    if (seen.has(key)) return `definition.edges[${i}] repeats the edge ${e.from} → ${e.to}`;
    seen.add(key);
  }

  if (definition.start !== undefined) {
    if (!byId.has(definition.start)) return `definition.start names undeclared node ${definition.start}`;
    if (supervisorOnly(definition.start)) return `definition.start ${definition.start} is supervisor-only`;
  }
  for (const [i, id] of (definition.terminal ?? []).entries()) {
    if (!byId.has(id)) return `definition.terminal[${i}] names undeclared node ${id}`;
    if (supervisorOnly(id)) return `definition.terminal[${i}] ${id} is supervisor-only`;
  }
  if (!stages.some((s) => !isSupervisorOnly(s))) return "definition has no graph-entered node to start at";
  const topology = normalizeTopology(definition);
  if (topology.terminal.length === 0) return "definition.terminal is empty: no terminal node is declared and every graph-entered node has an out-edge";

  for (const [i, e] of edges.entries()) {
    if (supervisorOnly(e.to)) return `definition.edges[${i}] enters supervisor-only node ${e.to}; only the supervisor enters it`;
  }

  for (const [i, s] of stages.entries()) {
    if (s.maxVisits !== undefined && !(Number.isInteger(s.maxVisits) && s.maxVisits >= 1 && s.maxVisits <= MAX_NODE_VISITS)) {
      return `definition.stages[${i}].maxVisits must be an integer from 1 to ${MAX_NODE_VISITS}`;
    }
    if (!isSupervisorOnly(s)) continue;
    // An out-edge to another supervisor-only node is an edge entering one, refused above.
    if (!edges.some((e) => e.from === s.id)) return `supervisor-only node ${s.id} has no out-edge`;
    if (s.requirementIds.length === 0) return `supervisor-only node ${s.id} has no requirements`;
    if (s.maxVisits === undefined) return `supervisor-only node ${s.id} needs maxVisits`;
  }

  const graphEntered = (id: StageId) => !supervisorOnly(id);
  const fromStart = reachableFrom(topology, topology.start, graphEntered);
  const toTerminal = reachingTo(topology, topology.terminal, graphEntered);
  for (const s of stages) {
    if (isSupervisorOnly(s)) continue;
    if (!fromStart.has(s.id)) return `node ${s.id} is not reachable from start ${topology.start}`;
    if (!toTerminal.has(s.id)) return `node ${s.id} cannot reach a terminal node`;
  }

  const owner = new Map<string, StageId>();
  for (const s of stages) {
    for (const r of s.requirementIds) {
      const other = owner.get(r);
      if (other !== undefined && other !== s.id) return `requirement ${r} is named by nodes ${other} and ${s.id}; a requirement belongs to one node`;
      owner.set(r, s.id);
    }
  }
  return undefined;
}

function uniqueIds(stages: Array<Pick<StageDefinition, "id">>): StageId[] {
  return [...new Set(stages.map((s) => s.id))];
}
