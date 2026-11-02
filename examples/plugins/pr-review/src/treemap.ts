// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * A squarified treemap (Bruls, Huizing and van Wijk) in plain code, for the risk map of `review.html` (design §6.11).
 * Deterministic: the same items give the same rectangles, with ties ordered by id, and the rectangles tile the box
 * exactly (each strip's last rectangle ends on the strip's edge, so no rounding opens a gap or an overlap).
 */

export interface TreeItem {
  id: string;
  /** The size, positive: the rectangle's area is this share of the box. */
  value: number;
}

export interface TreeRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The worst aspect ratio of a strip of areas laid along a side of length `side`. */
function worst(areas: readonly number[], side: number): number {
  const sum = areas.reduce((n, a) => n + a, 0);
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * The items laid out in the box (x, y, w, h), largest first. A value that is not positive counts as the smallest
 * positive value, so every item is drawn. An empty list gives no rectangle.
 */
export function squarify(items: readonly TreeItem[], x: number, y: number, w: number, h: number): TreeRect[] {
  if (items.length === 0 || w <= 0 || h <= 0) return [];
  const positive = items.map((i) => i.value).filter((v) => v > 0);
  const floor = positive.length === 0 ? 1 : Math.min(...positive);
  const sorted = items
    .map((i) => ({ id: i.id, value: i.value > 0 ? i.value : floor }))
    .sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = sorted.reduce((n, i) => n + i.value, 0);
  const scale = (w * h) / total;
  const out: TreeRect[] = [];
  let rest = { x, y, w, h };
  let at = 0;
  while (at < sorted.length) {
    const side = Math.min(rest.w, rest.h);
    // Grow the strip while the worst aspect ratio does not get worse.
    let end = at + 1;
    let areas = [sorted[at]!.value * scale];
    while (end < sorted.length) {
      const next = [...areas, sorted[end]!.value * scale];
      if (worst(next, side) > worst(areas, side)) break;
      areas = next;
      end += 1;
    }
    const strip = sorted.slice(at, end);
    const sum = areas.reduce((n, a) => n + a, 0);
    const last = end >= sorted.length;
    if (rest.w >= rest.h) {
      // A column on the left, as wide as its area needs; the last strip takes what is left, exactly.
      const cw = last ? rest.w : sum / rest.h;
      let cy = rest.y;
      strip.forEach((item, k) => {
        const ch = k === strip.length - 1 ? rest.y + rest.h - cy : (areas[k]! / sum) * rest.h;
        out.push({ id: item.id, x: rest.x, y: cy, w: cw, h: ch });
        cy += ch;
      });
      rest = { x: rest.x + cw, y: rest.y, w: rest.w - cw, h: rest.h };
    } else {
      const rh = last ? rest.h : sum / rest.w;
      let cx = rest.x;
      strip.forEach((item, k) => {
        const cwk = k === strip.length - 1 ? rest.x + rest.w - cx : (areas[k]! / sum) * rest.w;
        out.push({ id: item.id, x: cx, y: rest.y, w: cwk, h: rh });
        cx += cwk;
      });
      rest = { x: rest.x, y: rest.y + rh, w: rest.w, h: rest.h - rh };
    }
    at = end;
  }
  return out;
}
