// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { Architecture, ArchEdge, ArchNode } from "../src/architecture.js";
import { architectureSvg, BOX_H, BOX_W, layoutArchitecture, type ArchLayout, type PlacedNode } from "../src/archlayout.js";

const node = (id: string, over: Partial<ArchNode> = {}): ArchNode => ({ id, label: `Component ${id}`, kind: "package", change: "added", paths: [`pkg/${id}`], cite: { path: `pkg/${id}/x.go`, side: "head", start: 1, end: 1 }, ...over });
const edge = (from: string, to: string, over: Partial<ArchEdge> = {}): ArchEdge => ({ from, to, label: `${from} to ${to}`, kind: "call", change: "added", cite: { path: "pkg/a/x.go", side: "head", start: 1, end: 1 }, ...over });
const arch = (ids: string[], pairs: Array<[string, string]>): Architecture => ({ nodes: ids.map((id) => node(id)), edges: pairs.map(([a, b]) => edge(a, b)) });
const at = (l: ArchLayout, id: string): PlacedNode => l.nodes.find((n) => n.id === id)!;

const overlap = (a: PlacedNode, b: PlacedNode): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A reproducible dense graph: 30 nodes, 60 edges, some of them cycles. */
function dense(): Architecture {
  const ids = Array.from({ length: 30 }, (_, i) => `n${i}`);
  const pairs: Array<[string, string]> = [];
  let s = 7;
  const next = (n: number): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % n;
  };
  while (pairs.length < 60) {
    const a = ids[next(30)]!;
    const b = ids[next(30)]!;
    if (a !== b) pairs.push([a, b]);
  }
  return arch(ids, pairs);
}

describe("the layered layout of the architecture diagram (design 6.10)", () => {
  it("puts a node in the layer of the longest path from the nodes with no incoming edge", () => {
    const l = layoutArchitecture(arch(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["a", "c"], ["d", "c"]]));
    expect(l.layers).toEqual([["a", "d"], ["b"], ["c"]].map((x) => expect.arrayContaining(x)));
    expect([at(l, "a").layer, at(l, "b").layer, at(l, "c").layer, at(l, "d").layer]).toEqual([0, 1, 2, 0]);
  });

  it("breaks a cycle at the back edge a depth-first search finds, and draws that edge against the layering", () => {
    const l = layoutArchitecture(arch(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]));
    expect([at(l, "a").layer, at(l, "b").layer, at(l, "c").layer]).toEqual([0, 1, 2]);
    expect(l.edges.map((e) => e.back)).toEqual([false, false, true]);
    // The back edge runs in a lane above every box: up from the top of c, along the lane, and down into the top of a.
    const back = l.edges[2]!;
    const c = at(l, "c");
    const a = at(l, "a");
    const mid = (n: PlacedNode) => n.y + BOX_H / 2;
    expect(back.path).toMatch(new RegExp(`^M${c.x + BOX_W},${mid(c)} L${c.x + BOX_W + 14},${mid(c)} L${c.x + BOX_W + 14},(\\d+) L${a.x - 14},\\1 L${a.x - 14},${mid(a)} L${a.x},${mid(a)}$`));
    const laneY = Number(/ L\d+,(\d+) L\d+,\1 /.exec(back.path)![1]);
    expect(l.nodes.every((n) => n.y > laneY)).toBe(true);
  });

  it("places each label at its edge's midpoint on a background rectangle that no box and no other label overlaps, and spreads parallel edges", () => {
    const rects = (l: ArchLayout) => l.edges.map((e) => e.box);
    const hit = (r: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
    const check = (l: ArchLayout) => {
      const boxes = rects(l);
      for (let i = 0; i < boxes.length; i += 1) {
        for (const n of l.nodes) expect(hit(boxes[i]!, n), `label ${i} over ${n.id}`).toBe(false);
        for (let j = i + 1; j < boxes.length; j += 1) expect(hit(boxes[i]!, boxes[j]!), `labels ${i} and ${j}`).toBe(false);
      }
    };
    const fan = layoutArchitecture({ nodes: ["c", "r", "s", "m", "l"].map((id) => node(id)), edges: [edge("c", "r", { label: "replies with the first error" }), edge("c", "s", { label: "flushes groups" }), edge("c", "m", { label: "counted the old way" }), edge("l", "c", { label: "sends write batches" }), edge("r", "l", { label: "INTERNAL_ERROR", kind: "rpc" })] });
    check(fan);
    const twin = layoutArchitecture(arch(["a", "b"], [["a", "b"], ["a", "b"]]));
    expect(twin.edges[0]!.path).not.toBe(twin.edges[1]!.path);
    check(twin);
    // A label sits on its edge: its centre is where the curve passes, in the gap between the layers for a one-layer edge.
    const one = layoutArchitecture(arch(["a", "b"], [["a", "b"]]));
    expect(one.edges[0]!.lx).toBeGreaterThan(at(one, "a").x + BOX_W);
    expect(one.edges[0]!.lx).toBeLessThan(at(one, "b").x);
  });

  it("orders a layer by the barycentre of its neighbours, so two crossing edges are uncrossed", () => {
    const l = layoutArchitecture(arch(["s1", "s2", "t1", "t2"], [["s1", "t2"], ["s2", "t1"]]));
    expect(l.layers[1]).toEqual(["t2", "t1"]);
    expect(at(l, "t2").y).toBeLessThan(at(l, "t1").y);
  });

  it("never overlaps two boxes: not in a layer, not anywhere, for a dense graph of 30 nodes and 60 edges with cycles", () => {
    const l = layoutArchitecture(dense());
    expect(l.nodes).toHaveLength(30);
    for (let i = 0; i < l.nodes.length; i += 1) for (let j = i + 1; j < l.nodes.length; j += 1) expect(overlap(l.nodes[i]!, l.nodes[j]!), `${l.nodes[i]!.id} and ${l.nodes[j]!.id}`).toBe(false);
    for (const layer of l.layers) {
      const boxes = layer.map((id) => at(l, id)).sort((a, b) => a.y - b.y);
      boxes.slice(1).forEach((b, k) => expect(b.y).toBeGreaterThanOrEqual(boxes[k]!.y + boxes[k]!.h));
      expect(new Set(boxes.map((b) => b.x)).size).toBe(1);
    }
    expect(l.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + n.w <= l.width && n.y + n.h <= l.height)).toBe(true);
  });

  it("is stable: the same diagram lays out and draws identically, every time", () => {
    const a = dense();
    const first = JSON.stringify(layoutArchitecture(a));
    for (let i = 0; i < 3; i += 1) expect(JSON.stringify(layoutArchitecture(structuredClone(a)))).toBe(first);
    expect(architectureSvg(a)).toBe(architectureSvg(structuredClone(a)));
  });

  it("handles what a diagram can hold: no nodes, a self-loop, an edge to a node that is gone, one node alone", () => {
    expect(layoutArchitecture({ nodes: [], edges: [] })).toMatchObject({ nodes: [], edges: [], layers: [] });
    expect(architectureSvg({ nodes: [], edges: [] })).toBe("");
    const l = layoutArchitecture({ nodes: [node("a")], edges: [edge("a", "a"), edge("a", "ghost")] });
    expect(l.nodes).toHaveLength(1);
    expect(l.edges).toEqual([]);
    expect(layoutArchitecture(arch(["a"], [])).layers).toEqual([["a"]]);
  });
});

describe("the SVG of the architecture diagram", () => {
  const diagram: Architecture = {
    nodes: [node("a", { label: "Added thing" }), node("m", { label: "Modified thing", change: "modified" }), node("u", { label: "Context thing", change: "unchanged" })],
    edges: [edge("a", "m", { label: "feeds" }), edge("m", "u", { label: "was called", change: "removed" }), edge("u", "a", { label: "calls back", kind: "rpc", change: "unchanged" })],
  };
  const svg = architectureSvg(diagram);

  it("colours the boxes by change: added green, modified amber, unchanged grey", () => {
    expect(svg).toMatch(/<rect x="\d+" y="\d+" width="176" height="52" rx="6" fill="#d7f0dd" stroke="#2e8b57"/);
    expect(svg).toMatch(/fill="#fdeccd" stroke="#d98e04"/);
    expect(svg).toMatch(/fill="#eceff1" stroke="#90a4ae"/);
  });

  it("labels the edges, draws a removed one dashed and red, and has a legend", () => {
    for (const label of ["feeds", "was called", "calls back (rpc)"]) expect(svg).toContain(label);
    expect(svg).toMatch(/stroke="#c62828" stroke-width="1.6" stroke-dasharray="6 4" marker-end="url\(#arrow-removed\)"/);
    expect((svg.match(/stroke-dasharray="6 4"/g) ?? []).length).toBe(2);
    expect(svg).toContain(">unchanged (context)<");
    expect(svg).toContain(">removed connection<");
    expect(svg).toContain("Architecture diagram: 3 components, 3 connections");
  });

  it("is plain inline SVG with no script, no link and no external reference, and escapes a hostile label", () => {
    const hostile = architectureSvg({ nodes: [node("a", { label: '<script>alert(1)</script>"><image href=x>' })], edges: [] });
    expect(hostile).not.toMatch(/<(script|image|a)[\s>]/);
    expect(hostile).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/https?:|href|xlink|<script/);
    expect(svg.startsWith("<svg viewBox=")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });
});
