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
  /** Where the label sits. */
  lx: number;
  ly: number;
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

  const tallest = layers.reduce((m, l) => Math.max(m, l.length), 0);
  const columnHeight = tallest === 0 ? 0 : tallest * BOX_H + (tallest - 1) * GAP_Y;
  const placed = new Map<string, PlacedNode>();
  layers.forEach((layer, li) => {
    const h = layer.length * BOX_H + Math.max(0, layer.length - 1) * GAP_Y;
    const top = PAD + (columnHeight - h) / 2;
    layer.forEach((id, order) => placed.set(id, { id, layer: li, order, x: PAD + li * (BOX_W + GAP_X), y: Math.round(top + order * (BOX_H + GAP_Y)), w: BOX_W, h: BOX_H }));
  });

  const edges: PlacedEdge[] = [];
  arch.edges.forEach((e, index) => {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (a === undefined || b === undefined || e.from === e.to) return;
    const isBack = back.has(index);
    const forward = a.layer < b.layer;
    // From the right side of the left box to the left side of the right box; a back edge runs the other way round.
    const x1 = forward ? a.x + a.w : a.x;
    const x2 = forward ? b.x : b.x + b.w;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(40, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
    const bow = isBack ? 28 : 0;
    const c1 = `${x1 + dx},${y1 - bow}`;
    const c2 = `${x2 - dx},${y2 - bow}`;
    const mid = (v1: number, v2: number, p1: number, p2: number): number => (v1 + 3 * p1 + 3 * p2 + v2) / 8;
    edges.push({
      index,
      from: e.from,
      to: e.to,
      back: isBack,
      path: `M${x1},${y1} C${c1} ${c2} ${x2},${y2}`,
      lx: Math.round(mid(x1, x2, x1 + dx, x2 - dx)),
      ly: Math.round(mid(y1, y2, y1 - bow, y2 - bow)),
    });
  });
  const legendRoom = 44;
  return {
    nodes: ids.map((id) => placed.get(id)!),
    edges,
    layers,
    width: Math.max(2 * PAD + count * BOX_W + Math.max(0, count - 1) * GAP_X, 560),
    height: 2 * PAD + columnHeight + legendRoom,
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
    const label = `${e.label}${e.kind === "call" ? "" : ` (${e.kind})`}`;
    const shown = wrap(label, 26, 2);
    return [
      `<g>`,
      `<title>${esc(`${nodes.get(e.from)!.label} → ${nodes.get(e.to)!.label}: ${e.label} (${e.kind}, ${e.change})`)}</title>`,
      `<path d="${pe.path}" fill="none" stroke="${EDGE_STROKE[e.change]}" stroke-width="1.6"${e.change === "removed" ? ' stroke-dasharray="6 4"' : ""} marker-end="url(#arrow-${e.change})"/>`,
      ...shown.map((l, i) => `<text x="${pe.lx}" y="${pe.ly - 4 + i * 12 - (shown.length - 1) * 6}" text-anchor="middle" font-size="10.5" fill="#33414f" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(l)}</text>`),
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
