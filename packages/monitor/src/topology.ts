// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { ELK as ElkEngine, ElkNode } from 'elkjs/lib/elk-api.js';
import type { TopologyPanel } from '@graphloom/sdk';
import { Canvas, clipText, widthOf } from './cells.js';

type Point = { x: number; y: number };
type Geometry = { graph: ElkNode; width: number; height: number };
export interface TopologyDrawing { lines: string[]; fallbackReason?: string }
const cache = new Map<string, Promise<Geometry>>();
let engine: Promise<ElkEngine> | undefined;
function layoutEngine(): Promise<ElkEngine> {
  // Keep ordinary overview/status requests independent of the layout engine's startup cost.
  engine ??= import('elkjs/lib/elk.bundled.js').then(module => new module.default.default());
  return engine;
}

/** ELK geometry is accepted only after checking cell bounds and every directed route. */
export async function drawTopology(panel: TopologyPanel, width: number): Promise<TopologyDrawing> {
  const { topology, page, hiddenEdges, hiddenNodes, missingEndpoints } = panel.content;
  const fallback = (fallbackReason: string): TopologyDrawing => ({ lines: [], fallbackReason });
  if (topology.source === 'legacy') return fallback('Legacy stage view: declared edges and traversal are unavailable.');
  if (page.omitted || hiddenEdges || hiddenNodes) return fallback('Scoped or paginated topology; complete relationships are listed as directed adjacency.');
  if (missingEndpoints.length) return fallback('Topology contains unreported endpoints; retaining the declared adjacency.');
  if (!topology.nodes.length) return fallback('Topology has no reported nodes.');
  if (topology.nodes.length > 40 || topology.edges.length > 80) return fallback('Topology exceeds the bounded diagram layout; use paginated adjacency.');
  if (new Set(topology.nodes.map(node => node.id)).size !== topology.nodes.length || new Set(topology.edges.map(edge => edge.id)).size !== topology.edges.length) return fallback('Duplicate topology identity; diagram omitted.');
  const ids = new Map(topology.nodes.map((node, i) => [node.id, `n${i}`]));
  const key = JSON.stringify([width, topology.nodes, topology.edges]);
  let pending = cache.get(key);
  if (!pending) {
    const children: ElkNode[] = topology.nodes.map(node => {
      const incoming = topology.edges.filter(edge => edge.to === node.id);
      const outgoing = topology.edges.filter(edge => edge.from === node.id);
      return { id: ids.get(node.id)!, width: Math.min(28, Math.max(8, widthOf(node.label ?? node.id) + 4)), height: Math.max(4, incoming.length + 2, outgoing.length + 2),
        layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
        ports: [
          ...incoming.map(edge => ({ id: `in${topology.edges.indexOf(edge)}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } })),
          ...outgoing.map(edge => ({ id: `out${topology.edges.indexOf(edge)}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'EAST' } })),
        ] };
    });
    pending = layoutEngine().then(elk => elk.layout<ElkNode>({ id: 'root', layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '5', 'elk.spacing.edgeNode': '3', 'elk.spacing.edgeEdge': '2',
      'elk.layered.spacing.nodeNodeBetweenLayers': '10', 'elk.layered.spacing.edgeNodeBetweenLayers': '3',
      'elk.padding': '[top=1,left=1,bottom=1,right=1]',
    }, children, edges: topology.edges.map((edge, i) => ({ id: `e${i}`, sources: [`out${i}`], targets: [`in${i}`] })) }))
      .then(graph => ({ graph, width: Math.ceil(graph.width ?? 0) + 1, height: Math.ceil(graph.height ?? 0) + 1 }));
    cache.set(key, pending);
    if (cache.size > 16) cache.delete(cache.keys().next().value!);
  }
  let geometry: Geometry;
  try { geometry = await pending; } catch { cache.delete(key); return fallback('ELK layout unavailable; preserving directed adjacency.'); }
  if (geometry.width > width || geometry.height > 72 || geometry.width < 1 || geometry.height < 1) return fallback('Diagram does not fit this viewport; preserving directed adjacency.');
  const canvas = new Canvas(geometry.width, geometry.height);
  const boxes = (geometry.graph.children ?? []).map((node, i) => ({ id: node.id, original: topology.nodes[i]!, x: Math.round(node.x ?? 0), y: Math.round(node.y ?? 0), w: Math.round(node.width ?? 0), h: Math.round(node.height ?? 0) }));
  for (let i = 0; i < boxes.length; i++) {
    const node = boxes[i]!;
    if (node.x < 0 || node.y < 0 || node.x + node.w >= geometry.width || node.y + node.h >= geometry.height) return fallback('Rounded node geometry exceeds viewport; using adjacency.');
    if (boxes.slice(i + 1).some(other => node.x <= other.x + other.w && other.x <= node.x + node.w && node.y <= other.y + other.h && other.y <= node.y + node.h)) return fallback('Rounded nodes overlap; using adjacency.');
    canvas.put(node.x, node.y, `┌${'─'.repeat(node.w - 1)}┐`);
    canvas.put(node.x, node.y + node.h, `└${'─'.repeat(node.w - 1)}┘`);
    for (let y = node.y + 1; y < node.y + node.h; y++) { canvas.put(node.x, y, '│'); canvas.put(node.x + node.w, y, '│'); }
    canvas.put(node.x + 2, node.y + Math.floor(node.h / 2), clipText(node.original.label ?? node.original.id, node.w - 3));
  }
  const occupied = new Map<string, string>();
  for (const edge of geometry.graph.edges ?? []) {
    if (!edge.sections || edge.sections.length !== 1) return fallback('Multi-section edge cannot be qualified for cells; using adjacency.');
    const section = edge.sections[0]!;
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map(point => ({ x: Math.round(point.x), y: Math.round(point.y) }));
    const route: Point[] = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!; const b = points[i]!;
      if (a.x !== b.x && a.y !== b.y) return fallback('Rounded edge is not orthogonal; using adjacency.');
      const dx = Math.sign(b.x - a.x); const dy = Math.sign(b.y - a.y);
      const distance = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      for (let step = i === 1 ? 0 : 1; step <= distance; step++) route.push({ x: a.x + step * dx, y: a.y + step * dy });
    }
    if (route.length < 2) return fallback('Edge has no directional route; using adjacency.');
    for (let i = 0; i < route.length; i++) {
      const point = route[i]!;
      const key = `${point.x},${point.y}`;
      if (point.x < 0 || point.y < 0 || point.x >= geometry.width || point.y >= geometry.height) return fallback('Rounded edge exceeds viewport; using adjacency.');
      if (occupied.has(key) && occupied.get(key) !== edge.id) return fallback('Rounded edge routes touch or cross ambiguously; using adjacency.');
      if (i > 0 && i < route.length - 1 && boxes.some(node => point.x >= node.x && point.x <= node.x + node.w && point.y >= node.y && point.y <= node.y + node.h)) return fallback('Rounded edge intersects a node; using adjacency.');
      occupied.set(key, edge.id);
      const before = route[Math.max(0, i - 1)]!; const after = route[Math.min(route.length - 1, i + 1)]!;
      const north = before.y < point.y || after.y < point.y;
      const south = before.y > point.y || after.y > point.y;
      const west = before.x < point.x || after.x < point.x;
      const east = before.x > point.x || after.x > point.x;
      let glyph = north && east ? '└' : north && west ? '┘' : south && east ? '┌' : south && west ? '┐' : west || east ? '─' : '│';
      if (i === route.length - 1) glyph = point.x > before.x ? '▶' : point.x < before.x ? '◀' : point.y > before.y ? '▼' : '▲';
      canvas.put(point.x, point.y, glyph);
    }
  }
  return { lines: canvas.lines().map(line => line.trimEnd()) };
}
