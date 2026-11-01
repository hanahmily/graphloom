// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { Flow, Stage } from "../src/briefing.js";
import { BOX_H, BOX_W, featureSvg, layoutFlow, type FlowLayout, type PlacedNode } from "../src/flowlayout.js";

const cite = { path: "pkg/a/x.go", side: "head" as const, start: 1, end: 1, symbol: "" };
const stage = (id: string, over: Partial<Stage> = {}): Stage => ({ id, label: `Stage ${id}`, kind: "process", cite, ...over });
const flow = (from: string, to: string, over: Partial<Flow> = {}): Flow => ({ from, to, label: `${from} to ${to}`, cite, ...over });
const feature = (ids: string[], pairs: Array<[string, string]>) => ({ stages: ids.map((id) => stage(id)), flows: pairs.map(([a, b]) => flow(a, b)) });
const at = (l: FlowLayout, id: string): PlacedNode => l.nodes.find((n) => n.id === id)!;

const overlap = (a: PlacedNode, b: PlacedNode): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A reproducible dense graph: 30 stages, 60 flows, some of them cycles. */
function dense() {
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
  return feature(ids, pairs);
}

describe("the layered layout of a feature's data flow (design 6.10)", () => {
  it("puts a stage in the layer of the longest path from the stages with no incoming flow", () => {
    const l = layoutFlow(feature(["a", "b", "c", "d"], [["a", "b"], ["b", "c"], ["a", "c"], ["d", "c"]]));
    expect(l.layers).toEqual([["a", "d"], ["b"], ["c"]].map((x) => expect.arrayContaining(x)));
    expect([at(l, "a").layer, at(l, "b").layer, at(l, "c").layer, at(l, "d").layer]).toEqual([0, 1, 2, 0]);
  });

  it("breaks a cycle at the back flow a depth-first search finds, and draws that flow against the layering", () => {
    const l = layoutFlow(feature(["a", "b", "c"], [["a", "b"], ["b", "c"], ["c", "a"]]));
    expect([at(l, "a").layer, at(l, "b").layer, at(l, "c").layer]).toEqual([0, 1, 2]);
    expect(l.edges.map((e) => e.back)).toEqual([false, false, true]);
    const back = l.edges[2]!;
    const c = at(l, "c");
    const a = at(l, "a");
    const mid = (n: PlacedNode) => n.y + BOX_H / 2;
    expect(back.path).toMatch(new RegExp(`^M${c.x + BOX_W},${mid(c)} L${c.x + BOX_W + 14},${mid(c)} L${c.x + BOX_W + 14},(\\d+) L${a.x - 14},\\1 L${a.x - 14},${mid(a)} L${a.x},${mid(a)}$`));
    const laneY = Number(/ L\d+,(\d+) L\d+,\1 /.exec(back.path)![1]);
    expect(l.nodes.every((n) => n.y > laneY)).toBe(true);
  });

  it("places each label on a background rectangle that no box and no other label overlaps, and spreads parallel flows", () => {
    const hit = (r: { x: number; y: number; w: number; h: number }, o: { x: number; y: number; w: number; h: number }) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
    const check = (l: FlowLayout) => {
      const boxes = l.edges.map((e) => e.box);
      for (let i = 0; i < boxes.length; i += 1) {
        for (const n of l.nodes) expect(hit(boxes[i]!, n), `label ${i} over ${n.id}`).toBe(false);
        for (let j = i + 1; j < boxes.length; j += 1) expect(hit(boxes[i]!, boxes[j]!), `labels ${i} and ${j}`).toBe(false);
      }
    };
    const fan = layoutFlow({ stages: ["c", "r", "s", "m", "l"].map((id) => stage(id)), flows: [flow("c", "r", { label: "replies with the first error" }), flow("c", "s", { label: "flushes groups" }), flow("c", "m", { label: "records the batch" }), flow("c", "l", { label: "logs" })] });
    check(fan);
    const twin = layoutFlow(feature(["a", "b"], [["a", "b"], ["a", "b"]]));
    expect(twin.edges[0]!.path).not.toBe(twin.edges[1]!.path);
    check(twin);
    const one = layoutFlow(feature(["a", "b"], [["a", "b"]]));
    expect(one.edges[0]!.lx).toBeGreaterThan(at(one, "a").x + BOX_W);
    expect(one.edges[0]!.lx).toBeLessThan(at(one, "b").x);
  });

  it("orders a layer by the barycentre of its neighbours, so two crossing flows are uncrossed", () => {
    const l = layoutFlow(feature(["s1", "s2", "t1", "t2"], [["s1", "t2"], ["s2", "t1"]]));
    expect(l.layers[1]).toEqual(["t2", "t1"]);
    expect(at(l, "t2").y).toBeLessThan(at(l, "t1").y);
  });

  it("never overlaps two boxes, for a dense graph of 30 stages and 60 flows with cycles", () => {
    const l = layoutFlow(dense());
    expect(l.nodes).toHaveLength(30);
    for (let i = 0; i < l.nodes.length; i += 1) for (let j = i + 1; j < l.nodes.length; j += 1) expect(overlap(l.nodes[i]!, l.nodes[j]!), `${l.nodes[i]!.id} and ${l.nodes[j]!.id}`).toBe(false);
    expect(l.nodes.every((n) => n.x >= 0 && n.y >= 0 && n.x + n.w <= l.width && n.y + n.h <= l.height)).toBe(true);
  });

  it("is stable: the same feature lays out and draws identically, every time", () => {
    const a = dense();
    const first = JSON.stringify(layoutFlow(a));
    for (let i = 0; i < 3; i += 1) expect(JSON.stringify(layoutFlow(structuredClone(a)))).toBe(first);
    expect(featureSvg(a)).toBe(featureSvg(structuredClone(a)));
  });

  it("handles what a feature can hold: no stages, a self-loop, a flow to a stage that is gone, one stage alone", () => {
    expect(layoutFlow({ stages: [], flows: [] })).toMatchObject({ nodes: [], edges: [], layers: [] });
    expect(featureSvg({ stages: [], flows: [] })).toBe("");
    const l = layoutFlow({ stages: [stage("a")], flows: [flow("a", "a"), flow("a", "ghost")] });
    expect(l.nodes).toHaveLength(1);
    expect(l.edges).toEqual([]);
    expect(layoutFlow(feature(["a"], [])).layers).toEqual([["a"]]);
  });
});

describe("the SVG of a feature's data flow", () => {
  const f = {
    stages: [stage("a", { label: "Where it enters", kind: "source" }), stage("m", { label: "Where it is routed" }), stage("u", { label: "Where it is kept", kind: "store" })],
    flows: [flow("a", "m", { label: "feeds" }), flow("m", "u", { label: "persists" })],
  };
  const svg = featureSvg(f);

  it("colours the boxes by the kind of the stage", () => {
    expect(svg).toMatch(/<rect x="\d+" y="\d+" width="176" height="52" rx="6" fill="#dcebf9" stroke="#3b78b5"/);
    expect(svg).toMatch(/fill="#d7f0dd" stroke="#2e8b57"/);
    expect(svg).toMatch(/fill="#eceff1" stroke="#90a4ae"/);
  });

  it("labels the flows, names the kinds in a legend, and describes itself", () => {
    for (const label of ["feeds", "persists"]) expect(svg).toContain(label);
    for (const kind of [">source<", ">process<", ">store<"]) expect(svg).toContain(kind);
    expect(svg).not.toContain(">sink<");
    expect(svg).toContain("Data flow: 3 stages, 2 flows");
  });

  it("gives its arrow marker an id of the caller's, so several drawings can share one document", () => {
    expect(featureSvg(f, "fl2")).toContain('id="fl2-arrow-flow"');
    expect(featureSvg(f, "fl2")).toContain("url(#fl2-arrow-flow)");
  });

  it("is plain inline SVG with no script, no link and no external reference, and escapes a hostile label", () => {
    const hostile = featureSvg({ stages: [stage("a", { label: '<script>alert(1)</script>"><image href=x>' })], flows: [] });
    expect(hostile).not.toMatch(/<(script|image|a)[\s>]/);
    expect(hostile).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/https?:|href|xlink|<script/);
    expect(svg.startsWith("<svg viewBox=")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });
});
