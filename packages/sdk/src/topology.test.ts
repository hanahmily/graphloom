// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertGraphDefinition,
  isSupervisorOnly,
  MAX_GRAPH_EDGES,
  MAX_GRAPH_NODES,
  normalizeTopology,
  reachableFrom,
  reachingTo,
  successors,
  topologyProblem,
  type EdgeDefinition,
  type GraphDefinition,
  type StageDefinition,
} from "./index.js";

/** A definition over these stages, with one requirement per stage unless a stage names its own. */
function definition(stages: Array<Partial<StageDefinition> & { id: string }>, topology: Partial<GraphDefinition> = {}): GraphDefinition {
  const full = stages.map((s) => ({ name: s.id.toUpperCase(), requirementIds: [`${s.id}-done`], ...s }));
  const requirementIds = [...new Set(full.flatMap((s) => s.requirementIds))];
  return {
    graphId: "g",
    version: "1.0.0",
    stages: full,
    requirements: requirementIds.map((id) => ({ id, statement: `${id} holds`, evidenceSchema: "s" })),
    defaultValidators: requirementIds.map((id) => ({ requirementId: id, validatorId: `v-${id}`, version: "1" })),
    ...topology,
  };
}

const edge = (from: string, to: string): EdgeDefinition => ({ from, to });

/** The issue-fix 0.17 topology of docs/design-graph-topology.md §3.1. */
const issueFix017 = definition(
  [
    { id: "fix", requirementIds: ["fix-done"] },
    { id: "review", requirementIds: ["review-done"] },
    { id: "arbitrate", requirementIds: ["design-ruling"], entry: "supervisor", maxVisits: 6 },
  ],
  {
    edges: [edge("fix", "review"), edge("review", "fix"), edge("arbitrate", "fix"), edge("arbitrate", "review")],
    start: "fix",
    terminal: ["review"],
  },
);

/** The implicit chain of §3.3 over `ids`, written out by hand. */
function chain(ids: string[]): EdgeDefinition[] {
  const edges: EdgeDefinition[] = [];
  ids.forEach((from, i) => {
    if (i + 1 < ids.length) edges.push(edge(from, ids[i + 1]!));
    for (let j = 0; j < i; j++) edges.push(edge(from, ids[j]!));
  });
  return edges;
}

function refusal(def: GraphDefinition): string {
  try {
    assertGraphDefinition(def);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("definition was accepted");
}

describe("definition rules (docs/design-graph-topology.md §3.2)", () => {
  it("accepts the issue-fix 0.17 topology and every definition without edges", () => {
    expect(() => assertGraphDefinition(issueFix017)).not.toThrow();
    expect(() => assertGraphDefinition(definition([{ id: "a" }, { id: "b" }]))).not.toThrow();
    expect(() => assertGraphDefinition(definition([{ id: "a", entry: "graph" }]))).not.toThrow();
    // A chain keeps today's leniency: a requirement two stages name is not refused without edges.
    expect(() => assertGraphDefinition(definition([{ id: "a", requirementIds: ["r"] }, { id: "b", requirementIds: ["r"] }]))).not.toThrow();
  });

  it("refuses start, terminal, a supervisor entry or maxVisits without edges", () => {
    const two = [{ id: "a" }, { id: "b" }];
    expect(refusal(definition(two, { start: "a" }))).toBe("definition.start needs declared edges");
    expect(refusal(definition(two, { terminal: ["b"] }))).toBe("definition.terminal needs declared edges");
    expect(refusal(definition([{ id: "a" }, { id: "s", entry: "supervisor", maxVisits: 1 }]))).toBe('definition.stages[1].entry "supervisor" needs declared edges');
    expect(refusal(definition([{ id: "a", maxVisits: 2 }]))).toBe("definition.stages[0].maxVisits needs declared edges");
  });

  it("refuses an edge naming an undeclared node, repeating another, or looping on itself", () => {
    const two = [{ id: "a" }, { id: "b" }];
    expect(refusal(definition(two, { edges: [edge("a", "b"), edge("b", "c")] }))).toBe("definition.edges[1] names undeclared node c");
    expect(refusal(definition(two, { edges: [edge("x", "b")] }))).toBe("definition.edges[0] names undeclared node x");
    expect(refusal(definition(two, { edges: [edge("a", "b"), edge("a", "b")] }))).toBe("definition.edges[1] repeats the edge a → b");
    expect(refusal(definition(two, { edges: [edge("a", "b"), edge("b", "b")] }))).toBe("definition.edges[1] is a self-loop on b; a retry of a node is a reentry of it");
  });

  it("refuses an undeclared or supervisor-only start or terminal, and an empty terminal", () => {
    const withS = [{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor" as const, maxVisits: 1 }];
    const edges = [edge("a", "b"), edge("s", "a")];
    expect(refusal(definition(withS, { edges, start: "z" }))).toBe("definition.start names undeclared node z");
    expect(refusal(definition(withS, { edges, start: "s" }))).toBe("definition.start s is supervisor-only");
    expect(refusal(definition(withS, { edges, terminal: ["b", "z"] }))).toBe("definition.terminal[1] names undeclared node z");
    expect(refusal(definition(withS, { edges, terminal: ["s"] }))).toBe("definition.terminal[0] s is supervisor-only");
    expect(refusal(definition(withS, { edges, terminal: [] }))).toBe("definition.terminal is empty: no terminal node is declared and every graph-entered node has an out-edge");
    // Every graph-entered node leaves: no default terminal.
    expect(refusal(definition([{ id: "a" }, { id: "b" }], { edges: [edge("a", "b"), edge("b", "a")] }))).toBe(
      "definition.terminal is empty: no terminal node is declared and every graph-entered node has an out-edge",
    );
    expect(refusal(definition([{ id: "s", entry: "supervisor", maxVisits: 1 }], { edges: [] }))).toBe("definition has no graph-entered node to start at");
  });

  it("refuses an edge entering a supervisor-only node, from a graph node or another supervisor-only node", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor" as const, maxVisits: 1 }, { id: "t", entry: "supervisor" as const, maxVisits: 1 }];
    expect(refusal(definition(nodes, { edges: [edge("a", "b"), edge("s", "a"), edge("t", "a"), edge("a", "s")] }))).toBe(
      "definition.edges[3] enters supervisor-only node s; only the supervisor enters it",
    );
    expect(refusal(definition(nodes, { edges: [edge("a", "b"), edge("s", "a"), edge("t", "s")] }))).toBe(
      "definition.edges[2] enters supervisor-only node s; only the supervisor enters it",
    );
  });

  it("refuses a supervisor-only node without an out-edge, requirements or maxVisits, and a maxVisits out of range", () => {
    const edges = [edge("a", "b"), edge("s", "a")];
    expect(refusal(definition([{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor", maxVisits: 1 }], { edges: [edge("a", "b")] }))).toBe(
      "supervisor-only node s has no out-edge",
    );
    expect(refusal(definition([{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor", maxVisits: 1, requirementIds: [] }], { edges }))).toBe(
      "supervisor-only node s has no requirements",
    );
    expect(refusal(definition([{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor" }], { edges }))).toBe("supervisor-only node s needs maxVisits");
    for (const maxVisits of [0, 65, 1.5, -1]) {
      expect(refusal(definition([{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor", maxVisits }], { edges }))).toBe(
        "definition.stages[2].maxVisits must be an integer from 1 to 64",
      );
    }
    expect(refusal(definition([{ id: "a", maxVisits: 99 }, { id: "b" }], { edges: [edge("a", "b")] }))).toBe(
      "definition.stages[0].maxVisits must be an integer from 1 to 64",
    );
    // The bounds themselves, and a maxVisits on a graph-entered node, are accepted.
    for (const maxVisits of [1, 64]) {
      expect(() => assertGraphDefinition(definition([{ id: "a", maxVisits: 3 }, { id: "b" }, { id: "s", entry: "supervisor", maxVisits }], { edges }))).not.toThrow();
    }
  });

  it("refuses a graph-entered node unreachable from start or unable to reach a terminal node", () => {
    const three = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(refusal(definition(three, { edges: [edge("a", "b")] }))).toBe("node c is not reachable from start a");
    expect(refusal(definition(three, { edges: [edge("a", "b"), edge("c", "b")] }))).toBe("node c is not reachable from start a");
    // b and c cycle forever: neither reaches the terminal a declared node lists.
    expect(refusal(definition(three, { edges: [edge("a", "b"), edge("b", "c"), edge("c", "b")], terminal: ["a"] }))).toBe("node b cannot reach a terminal node");
    // A path through a supervisor-only node does not count: only the supervisor leaves it.
    const viaS = [{ id: "a" }, { id: "b" }, { id: "s", entry: "supervisor" as const, maxVisits: 1 }];
    expect(refusal(definition(viaS, { edges: [edge("s", "b")], terminal: ["a", "b"] }))).toBe("node b is not reachable from start a");
    // start defaults to the first graph-entered node, even after a supervisor-only one.
    expect(() => assertGraphDefinition(definition([{ id: "s", entry: "supervisor", maxVisits: 1 }, { id: "a" }, { id: "b" }], { edges: [edge("a", "b"), edge("s", "a")] }))).not.toThrow();
  });

  it("refuses more than 64 nodes or 256 edges", () => {
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => ({ id: `n${i}` }));
    expect(refusal(definition(nodes))).toBe("definition declares 65 nodes, more than 64");
    expect(() => assertGraphDefinition(definition(nodes.slice(0, MAX_GRAPH_NODES)))).not.toThrow();
    const ids = Array.from({ length: 20 }, (_, i) => `n${i}`);
    const all = ids.flatMap((from) => ids.filter((to) => to !== from).map((to) => edge(from, to)));
    expect(all.length).toBeGreaterThan(MAX_GRAPH_EDGES);
    expect(refusal(definition(ids.map((id) => ({ id })), { edges: all, terminal: ["n19"] }))).toBe(`definition declares ${all.length} edges, more than 256`);
  });

  it("refuses a requirement two nodes name once edges are declared, and a repeated node id", () => {
    expect(refusal(definition([{ id: "a", requirementIds: ["r"] }, { id: "b", requirementIds: ["r", "q"] }], { edges: [edge("a", "b")] }))).toBe(
      "requirement r is named by nodes a and b; a requirement belongs to one node",
    );
    expect(refusal(definition([{ id: "a" }, { id: "b" }, { id: "a" }], { edges: [edge("a", "b")] }))).toBe("definition.stages[2].id repeats node a");
  });

  it("checks the shapes of the topology fields", () => {
    const two = [{ id: "a" }, { id: "b" }];
    expect(refusal({ ...definition(two), edges: {} as unknown as EdgeDefinition[] })).toBe("definition.edges must be an array");
    expect(refusal(definition(two, { edges: [{ from: "a" } as EdgeDefinition] }))).toBe("definition.edges[0].to must be a non-empty string");
    expect(refusal(definition(two, { edges: [edge("a", "b")], start: "" }))).toBe("definition.start must be a non-empty string");
    expect(refusal(definition(two, { edges: [edge("a", "b")], terminal: "b" as unknown as string[] }))).toBe("definition.terminal must be an array of non-empty strings");
    expect(refusal(definition([{ id: "a", entry: "operator" as "graph" }]))).toBe("definition.stages[0].entry must be graph or supervisor");
    expect(refusal(definition([{ id: "a", maxVisits: "2" as unknown as number }]))).toBe("definition.stages[0].maxVisits must be a number");
  });
});

describe("normalizeTopology (§3.3)", () => {
  it.each([
    [["a", "b"]],
    [["a", "b", "c"]],
    [["a", "b", "c", "d", "e"]],
  ])("turns the list %j into the implicit chain", (ids) => {
    const topology = normalizeTopology(definition(ids.map((id) => ({ id }))));
    expect(topology).toEqual({ start: ids[0], terminal: [ids.at(-1)], edges: chain(ids), implicit: true });
    // Forward edges go one step; every earlier stage has a back edge.
    ids.forEach((id, i) => {
      expect(successors(topology, id)).toEqual([...(i + 1 < ids.length ? [ids[i + 1]] : []), ...ids.slice(0, i)]);
    });
    expect(topology.edges).toHaveLength(ids.length - 1 + (ids.length * (ids.length - 1)) / 2);
  });

  it("writes the three-stage chain out", () => {
    expect(normalizeTopology(definition([{ id: "a" }, { id: "b" }, { id: "c" }])).edges).toEqual([
      edge("a", "b"),
      edge("b", "c"),
      edge("b", "a"),
      edge("c", "a"),
      edge("c", "b"),
    ]);
  });

  it("makes a single stage its own start and terminal with no edges", () => {
    expect(normalizeTopology(definition([{ id: "only" }]))).toEqual({ start: "only", terminal: ["only"], edges: [], implicit: true });
  });

  it("keeps a declared topology and applies its defaults", () => {
    expect(normalizeTopology(issueFix017)).toEqual({
      start: "fix",
      terminal: ["review"],
      edges: issueFix017.edges,
      implicit: false,
    });
    const defaults = definition([{ id: "s", entry: "supervisor", maxVisits: 2 }, { id: "a" }, { id: "b" }, { id: "c" }], {
      edges: [edge("a", "b"), edge("a", "c"), edge("s", "a")],
    });
    // start: the first graph-entered node; terminal: every graph-entered node with no out-edge.
    expect(normalizeTopology(defaults)).toEqual({ start: "a", terminal: ["b", "c"], edges: defaults.edges, implicit: false });
  });
});

const PLUGINS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/plugins");

/** The stage ids a plugin's `describe()` lists, read from its source: the `stages: [...]` of `src/graph.ts`, constants resolved. */
function shippedStageIds(plugin: string): string[] {
  const src = path.join(PLUGINS, plugin, "src");
  const constants = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith(".ts")) {
        for (const m of readFileSync(file, "utf8").matchAll(/export const (\w+) = "([^"]*)";/g)) constants.set(m[1]!, m[2]!);
      }
    }
  };
  walk(src);
  const graph = readFileSync(path.join(src, "graph.ts"), "utf8");
  const open = graph.indexOf("stages: [");
  expect(open).toBeGreaterThan(-1);
  let end = graph.indexOf("[", open);
  for (let depth = 0; ; end++) {
    if (graph[end] === "[") depth++;
    else if (graph[end] === "]" && --depth === 0) break;
  }
  const block = graph.slice(open, end);
  return [...block.matchAll(/\bid: (\w+|"[^"]*")/g)].map((m) => {
    const ref = m[1]!;
    if (ref.startsWith('"')) return ref.slice(1, -1);
    const value = constants.get(ref);
    if (value === undefined) throw new Error(`${plugin}: unresolved stage constant ${ref}`);
    return value;
  });
}

describe("the shipped plugins as implicit chains", () => {
  const shipped: Record<string, string[]> = {
    hello: ["write", "review"],
    release: ["bump", "changelog", "review"],
    "issue-fix": ["fix", "review"],
    "pr-review": ["fetch", "report", "review", "draft", "publish"],
    "pr-design-review": ["fetch", "report", "questions", "answers", "round1", "publish"],
  };

  it("covers every shipped graph plugin", () => {
    const plugins = readdirSync(PLUGINS).filter((p) => p !== "review-kit");
    expect(plugins.sort()).toEqual(Object.keys(shipped).sort());
  });

  it.each(Object.entries(shipped))("%s keeps its stage order on the chain", (plugin, ids) => {
    expect(shippedStageIds(plugin)).toEqual(ids);
    const def = definition(ids.map((id) => ({ id })));
    expect(() => assertGraphDefinition(def)).not.toThrow();
    const topology = normalizeTopology(def);
    expect(topology).toEqual({ start: ids[0], terminal: [ids.at(-1)], edges: chain(ids), implicit: true });
    // The reentries the plugins make today run along back edges: every earlier stage is a successor.
    ids.forEach((id, i) => ids.slice(0, i).forEach((earlier) => expect(successors(topology, id)).toContain(earlier)));
  });
});

describe("reachability", () => {
  const diamond = { edges: [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"), edge("s", "b")] };

  it("finds every node reachable from a node, itself included", () => {
    expect(reachableFrom(diamond, "a")).toEqual(new Set(["a", "b", "c", "d"]));
    expect(reachableFrom(diamond, "d")).toEqual(new Set(["d"]));
    expect(reachableFrom(diamond, "s")).toEqual(new Set(["s", "b", "d"]));
  });

  it("finds every node that reaches a target, the targets included", () => {
    expect(reachingTo(diamond, ["d"])).toEqual(new Set(["a", "b", "c", "d", "s"]));
    expect(reachingTo(diamond, ["c"])).toEqual(new Set(["a", "c"]));
  });

  it("walks only edges whose ends pass the filter", () => {
    const notB = (id: string) => id !== "b";
    expect(reachableFrom(diamond, "a", notB)).toEqual(new Set(["a", "c", "d"]));
    expect(reachingTo(diamond, ["d"], (id) => id !== "s")).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("follows cycles without looping", () => {
    const cycle = { edges: [edge("fix", "review"), edge("review", "fix")] };
    expect(reachableFrom(cycle, "review")).toEqual(new Set(["fix", "review"]));
    expect(reachingTo(cycle, ["review"])).toEqual(new Set(["fix", "review"]));
  });

  it("tells a supervisor-only node apart", () => {
    expect(issueFix017.stages.filter(isSupervisorOnly).map((s) => s.id)).toEqual(["arbitrate"]);
    expect(topologyProblem(issueFix017)).toBeUndefined();
  });
});
