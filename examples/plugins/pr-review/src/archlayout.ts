// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The architecture diagram as SVG (design §6.10), by plugin code with no third-party tool: a layered layout (layers
 * by longest path from the nodes with no incoming edges, cycles broken at the back edges a depth-first search
 * finds, the order inside a layer by barycentre over a few sweeps), boxes coloured by `change`, edge labels and a
 * legend. `layoutArchitecture` is a pure, deterministic function of the diagram; `architectureSvg` draws its result.
 */
import type { Architecture, ArchEdge, ArchNode } from "./architecture.js";
import { esc, wrap } from "./escape.js";

export const BOX_W = 176;
export const BOX_H = 52;
const GAP_X = 190;
const GAP_Y = 26;
const PAD = 24;
const SWEEPS = 4;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedNode {
  id: string;
  layer: number;
  /** Position inside the layer, from the top. */
  order: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedEdge {
  /** The edge's index in the diagram (0-based). */
  index: number;
  from: string;
  to: string;
  /** Drawn against the layering: the cycle was broken at this edge. */
  back: boolean;
  path: string;
  /** Where the label sits (its centre), its lines, and the rectangle behind it. */
  lx: number;
  ly: number;
  label: string[];
  box: Rect;
}

export interface ArchLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** Node ids per layer, in order. */
  layers: string[][];
  width: number;
  height: number;
}

/**
 * Back edges by depth-first search from the nodes in the order given, following edges in the order given: an edge to
 * a node still on the stack closes a cycle and is reversed for layering. Self-loops are ignored.
 */
function backEdges(ids: readonly string[], edges: readonly ArchEdge[]): Set<number> {
  const out = new Map<string, Array<{ to: string; index: number }>>(ids.map((id) => [id, []]));
  edges.forEach((e, index) => {
    if (e.from !== e.to && out.has(e.from) && out.has(e.to)) out.get(e.from)!.push({ to: e.to, index });
  });
  const state = new Map<string, 0 | 1 | 2>(ids.map((id) => [id, 0]));
  const back = new Set<number>();
  const visit = (v: string): void => {
    state.set(v, 1);
    for (const { to, index } of out.get(v)!) {
      const s = state.get(to);
      if (s === 1) back.add(index);
      else if (s === 0) visit(to);
    }
    state.set(v, 2);
  };
  for (const id of ids) if (state.get(id) === 0) visit(id);
  return back;
}

/** The layout of a diagram: deterministic, and the boxes of one layer never overlap. */
export function layoutArchitecture(arch: Architecture): ArchLayout {
  const ids = arch.nodes.map((n) => n.id);
  const known = new Set(ids);
  const back = backEdges(ids, arch.edges);
  // The DAG: every edge between two different nodes, back edges reversed.
  const dag: Array<{ from: string; to: string }> = [];
  arch.edges.forEach((e, index) => {
    if (e.from === e.to || !known.has(e.from) || !known.has(e.to)) return;
    dag.push(back.has(index) ? { from: e.to, to: e.from } : { from: e.from, to: e.to });
  });
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const d of dag) incoming.get(d.to)!.push(d.from);
  // Longest path from the sources: the layer of a node is one past the deepest of its predecessors.
  const layerOf = new Map<string, number>();
  const depth = (v: string): number => {
    const known = layerOf.get(v);
    if (known !== undefined) return known;
    const l = incoming.get(v)!.reduce((m, u) => Math.max(m, depth(u) + 1), 0);
    layerOf.set(v, l);
    return l;
  };
  for (const id of ids) depth(id);
  const count = ids.length === 0 ? 0 : Math.max(...ids.map((id) => layerOf.get(id)!)) + 1;
  const layers: string[][] = Array.from({ length: count }, () => []);
  for (const id of ids) layers[layerOf.get(id)!]!.push(id);

  // Order inside a layer: barycentre of the neighbours in the layers already placed, sweeping down then up.
  const neighbours = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const d of dag) {
    neighbours.get(d.from)!.push(d.to);
    neighbours.get(d.to)!.push(d.from);
  }
  const position = (): Map<string, number> => new Map(layers.flatMap((l) => l.map((id, i) => [id, i] as const)));
  const sweep = (order: number[]): void => {
    for (const li of order) {
      const pos = position();
      const reference = (id: string): number | undefined => {
        const ps = neighbours.get(id)!.filter((n) => layerOf.get(n)! !== li && Math.abs(layerOf.get(n)! - li) >= 1).map((n) => pos.get(n)!);
        return ps.length === 0 ? undefined : ps.reduce((a, b) => a + b, 0) / ps.length;
      };
      const before = new Map(layers[li]!.map((id, i) => [id, i] as const));
      layers[li] = [...layers[li]!].sort((a, b) => {
        const ra = reference(a) ?? before.get(a)!;
        const rb = reference(b) ?? before.get(b)!;
        return ra !== rb ? ra - rb : before.get(a)! - before.get(b)!;
      });
    }
  };
  // Down: each layer after the first by the layer before it; up: each layer before the last by the one after it.
  const down = Array.from({ length: Math.max(0, count - 1) }, (_, i) => i + 1);
  const up = Array.from({ length: Math.max(0, count - 1) }, (_, i) => count - 2 - i);
  for (let s = 0; s < SWEEPS; s += 1) sweep(s % 2 === 0 ? down : up);

  // Back edges run in lanes above the boxes, so they never cross a box; each lane is 12 units higher than the one before.
  const backCount = [...back].filter((i) => arch.edges[i]!.from !== arch.edges[i]!.to && known.has(arch.edges[i]!.from) && known.has(arch.edges[i]!.to)).length;
  const top0 = 20 + 12 * backCount;
  const tallest = layers.reduce((m, l) => Math.max(m, l.length), 0);
  const columnHeight = tallest === 0 ? 0 : tallest * BOX_H + (tallest - 1) * GAP_Y;
  const placed = new Map<string, PlacedNode>();
  layers.forEach((layer, li) => {
    const h = layer.length * BOX_H + Math.max(0, layer.length - 1) * GAP_Y;
    const top = top0 + (columnHeight - h) / 2;
    layer.forEach((id, order) => placed.set(id, { id, layer: li, order, x: PAD + li * (BOX_W + GAP_X), y: Math.round(top + order * (BOX_H + GAP_Y)), w: BOX_W, h: BOX_H }));
  });
  const boxes = [...placed.values()];

  // Parallel edges between one pair of nodes are spread, so they and their labels do not lie on one another.
  const pairs = new Map<string, number[]>();
  arch.edges.forEach((e, index) => {
    if (e.from === e.to || !placed.has(e.from) || !placed.has(e.to)) return;
    const key = [e.from, e.to].sort().join(">");
    pairs.set(key, [...(pairs.get(key) ?? []), index]);
  });

  const edges: PlacedEdge[] = [];
  const taken: Rect[] = [];
  const hits = (r: Rect, others: readonly Rect[]): boolean => others.some((o) => r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h);
  let lane = 0;
  arch.edges.forEach((e, index) => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (a === undefined || b === undefined || e.from === e.to) return;
    const isBack = back.has(index);
    const forward = a.layer < b.layer;
    const sibs = pairs.get([e.from, e.to].sort().join(">"))!;
    const spread = (sibs.indexOf(index) - (sibs.length - 1) / 2) * 14;
    const text = wrap(`${e.label}${e.kind === "call" ? "" : ` (${e.kind})`}`, 22, 2);
    const lw = Math.round(Math.max(...text.map((l) => l.length)) * 5.8 + 10);
    const lh = text.length * 12 + 4;
    const rectAt = (cx: number, cy: number): Rect => ({ x: Math.round(cx - lw / 2), y: Math.round(cy - lh / 2), w: lw, h: lh });
    let path: string;
    let spot: { x: number; y: number };
    if (isBack) {
      // Out of the right side of the box that points back, up the gap beside its column, along the lane above every box,
      // and down the gap beside the target's column into its left side: it crosses no box.
      const laneY = 8 + 12 * lane;
      lane += 1;
      const xa = a.x + a.w + 14;
      const xb = b.x - 14;
      const y1 = a.y + a.h / 2 + spread;
      const y2 = b.y + b.h / 2 + spread;
      path = `M${a.x + a.w},${y1} L${xa},${y1} L${xa},${laneY} L${xb},${laneY} L${xb},${y2} L${b.x},${y2}`;
      spot = { x: Math.round((xa + xb) / 2), y: laneY };
    } else {
      // From the right side of the left box to the left side of the right box.
      const x1 = a.x + a.w;
      const x2 = b.x;
      const y1 = a.y + a.h / 2 + spread;
      const y2 = b.y + b.h / 2 + spread;
      const dx = Math.max(40, (x2 - x1) / 2);
      path = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      const at = (t: number): { x: number; y: number } => {
        const u = 1 - t;
        return { x: u * u * u * x1 + 3 * u * u * t * (x1 + dx) + 3 * u * t * t * (x2 - dx) + t * t * t * x2, y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2 };
      };
      // The label sits at the edge's midpoint; where that is taken by a box or another label it moves along the edge.
      const free = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85].map(at).find((p) => !hits(rectAt(p.x, p.y), boxes) && !hits(rectAt(p.x, p.y), taken));
      spot = free ?? at(0.5);
      if (free === undefined) {
        for (let k = 0; k < 20 && hits(rectAt(spot.x, spot.y), taken); k += 1) spot = { x: spot.x, y: spot.y + 14 };
      }
    }
    const rect = rectAt(spot.x, spot.y);
    taken.push(rect);
    edges.push({ index, from: e.from, to: e.to, back: isBack, path, lx: Math.round(spot.x), ly: Math.round(spot.y), label: text, box: rect });
    void forward;
  });
  const legendRoom = 44;
  return {
    nodes: ids.map((id) => placed.get(id)!),
    edges,
    layers,
    width: Math.max(2 * PAD + count * BOX_W + Math.max(0, count - 1) * GAP_X, 560),
    height: top0 + columnHeight + PAD + legendRoom,
  };
}

const FILL = { added: "#d7f0dd", modified: "#fdeccd", unchanged: "#eceff1" } as const;
const STROKE = { added: "#2e8b57", modified: "#d98e04", unchanged: "#90a4ae" } as const;
const EDGE_STROKE = { added: "#2e8b57", modified: "#d98e04", unchanged: "#78909c", removed: "#c62828" } as const;

function boxSvg(n: ArchNode, p: PlacedNode): string {
  const lines = wrap(n.label, 24, 2);
  const text = lines.map((l, i) => `<text x="${p.x + p.w / 2}" y="${p.y + 20 + i * 14}" text-anchor="middle" font-size="12.5" font-weight="600" fill="#1d2733">${esc(l)}</text>`).join("");
  return [
    `<g>`,
    `<title>${esc(`${n.label} (${n.kind}, ${n.change}): ${n.paths.join(", ")}`)}</title>`,
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="6" fill="${FILL[n.change]}" stroke="${STROKE[n.change]}" stroke-width="1.5"/>`,
    text,
    `<text x="${p.x + p.w / 2}" y="${p.y + p.h - 7}" text-anchor="middle" font-size="10" fill="#4a5a6a">${esc(`${n.kind} · ${n.change}`)}</text>`,
    `</g>`,
  ].join("");
}

/** The diagram as an inline SVG: coloured boxes, arrows with their labels, and a legend. Empty text when there is nothing to draw. */
export function architectureSvg(arch: Architecture): string {
  if (arch.nodes.length === 0) return "";
  const layout = layoutArchitecture(arch);
  const nodes = new Map(arch.nodes.map((n) => [n.id, n] as const));
  const placed = new Map(layout.nodes.map((p) => [p.id, p] as const));
  const marker = (change: ArchEdge["change"]): string => `<marker id="arrow-${change}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${EDGE_STROKE[change]}"/></marker>`;
  const edges = layout.edges.map((pe) => {
    const e = arch.edges[pe.index]!;
    const shown = pe.label;
    return [
      `<g>`,
      `<title>${esc(`${nodes.get(e.from)!.label} → ${nodes.get(e.to)!.label}: ${e.label} (${e.kind}, ${e.change})`)}</title>`,
      `<path d="${pe.path}" fill="none" stroke="${EDGE_STROKE[e.change]}" stroke-width="1.6"${e.change === "removed" ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#arrow-${e.change})"/>`,
      `<rect x="${pe.box.x}" y="${pe.box.y}" width="${pe.box.w}" height="${pe.box.h}" rx="3" fill="#ffffff" fill-opacity="0.92" stroke="#d9e0e7" stroke-width="0.8"/>`,
      ...shown.map((l, i) => `<text x="${pe.lx}" y="${pe.box.y + 12 + i * 12}" text-anchor="middle" font-size="10.5" fill="#33414f">${esc(l)}</text>`),
      `</g>`,
    ].join("");
  });
  const legendY = layout.height - 30;
  const swatch = (x: number, change: ArchNode["change"], label: string): string => `<rect x="${x}" y="${legendY}" width="16" height="12" rx="3" fill="${FILL[change]}" stroke="${STROKE[change]}"/><text x="${x + 22}" y="${legendY + 10}" font-size="11" fill="#33414f">${esc(label)}</text>`;
  const legend = [
    swatch(PAD, "added", "added"),
    swatch(PAD + 84, "modified", "modified"),
    swatch(PAD + 190, "unchanged", "unchanged (context)"),
    `<line x1="${PAD + 340}" y1="${legendY + 6}" x2="${PAD + 372}" y2="${legendY + 6}" stroke="${EDGE_STROKE.removed}" stroke-width="1.6" stroke-dasharray="6 4"/><text x="${PAD + 378}" y="${legendY + 10}" font-size="11" fill="#33414f">removed connection</text>`,
  ].join("");
  return [
    `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" role="img" aria-label="Architecture diagram: ${arch.nodes.length} components, ${arch.edges.length} connections" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">`,
    `<defs>${(["added", "modified", "unchanged", "removed"] as const).map(marker).join("")}</defs>`,
    ...edges,
    ...arch.nodes.map((n) => boxSvg(n, placed.get(n.id)!)),
    legend,
    `</svg>`,
  ].join("\n");
}
