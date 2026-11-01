// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The small SVG drawings of the HTML report (design §6.11): the state diagram of a lifecycle entry, the change map's
 * bar chart, and the CRAP bar with its threshold. Plugin code only; every text goes through `esc`.
 */
import { clip, esc, wrap } from "./escape.js";
import type { StateEntry } from "./report.js";

const FONT = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"';

/**
 * A lifecycle entry as a diagram: the initial value on the left, the state in the middle, and one arrow per
 * transition, labelled with its condition, to a box with the effect. The reads are listed by the caller under it.
 * `uid` keeps the arrow marker's id unique in the document.
 */
export function stateDiagramSvg(entry: StateEntry, uid: string): string {
  const rows = Math.max(1, entry.transitions.length);
  const rowH = 70;
  const height = rows * rowH + 24;
  const width = 940;
  const stateX = 250;
  const stateW = 190;
  const stateH = 58;
  const effectX = 700;
  const effectW = 224;
  const cy = height / 2;
  const marker = `${uid}-arrow`;
  const parts: string[] = [
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(`Lifecycle of ${entry.name}: starts ${clip(entry.initial, 60)}, ${entry.transitions.length} transition(s)`)}" ${FONT}>`,
    `<defs><marker id="${marker}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#4a5a6a"/></marker></defs>`,
  ];
  // The initial value.
  const initial = wrap(entry.initial, 24, 3);
  parts.push(
    `<g><title>${esc(`initial: ${entry.initial}`)}</title><rect x="12" y="${cy - 30}" width="170" height="60" rx="30" fill="#e8f1fb" stroke="#4a7fb5" stroke-width="1.5"/>`,
    `<text x="97" y="${cy - 14 + 4}" text-anchor="middle" font-size="10" fill="#4a5a6a">starts</text>`,
    ...initial.map((l, i) => `<text x="97" y="${cy + 2 + i * 12}" text-anchor="middle" font-size="11" font-weight="600" fill="#1d2733">${esc(l)}</text>`),
    `</g>`,
    `<path d="M182,${cy} L${stateX - 2},${cy}" fill="none" stroke="#4a5a6a" stroke-width="1.5" marker-end="url(#${marker})"/>`,
  );
  // The state itself.
  const name = wrap(entry.name, 24, 2);
  parts.push(
    `<g><title>${esc(`${entry.name} (${entry.scope})`)}</title><rect x="${stateX}" y="${cy - stateH / 2}" width="${stateW}" height="${stateH}" rx="8" fill="#fff7e6" stroke="#d98e04" stroke-width="1.5"/>`,
    ...name.map((l, i) => `<text x="${stateX + stateW / 2}" y="${cy - 8 + i * 14 - (name.length - 1) * 5}" text-anchor="middle" font-size="12.5" font-weight="600" fill="#1d2733">${esc(l)}</text>`),
    `<text x="${stateX + stateW / 2}" y="${cy + stateH / 2 - 8}" text-anchor="middle" font-size="10" fill="#4a5a6a">${esc(clip(entry.scope, 30))}</text>`,
    `</g>`,
  );
  // One arrow per transition, labelled with its condition.
  entry.transitions.forEach((t, i) => {
    const y = 12 + i * rowH + rowH / 2;
    const x1 = stateX + stateW;
    const mid = (x1 + effectX) / 2;
    const label = wrap(`when ${t.when}`, 40, 3);
    parts.push(
      `<g><title>${esc(`when ${t.when}: ${t.effect}`)}</title>`,
      `<path d="M${x1},${cy} C${x1 + 70},${cy} ${effectX - 70},${y} ${effectX - 2},${y}" fill="none" stroke="#4a5a6a" stroke-width="1.5" marker-end="url(#${marker})"/>`,
      ...label.map((l, k) => `<text x="${mid}" y="${(cy + y) / 2 - 4 + k * 11 - (label.length - 1) * 11}" text-anchor="middle" font-size="10" fill="#33414f" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(l)}</text>`),
      `<rect x="${effectX}" y="${y - 24}" width="${effectW}" height="48" rx="6" fill="#eef6ee" stroke="#2e8b57" stroke-width="1.2"/>`,
      ...wrap(t.effect, 34, 3).map((l, k, all) => `<text x="${effectX + effectW / 2}" y="${y + 4 + k * 12 - (all.length - 1) * 6}" text-anchor="middle" font-size="10.5" fill="#1d2733">${esc(l)}</text>`),
      `</g>`,
    );
  });
  parts.push(`</svg>`);
  return parts.join("\n");
}

export interface BarRow {
  label: string;
  added: number;
  deleted: number;
}

/** A horizontal bar chart of added and deleted lines, one row per label (the change map, design §6.11). */
export function changeMapSvg(rows: readonly BarRow[]): string {
  if (rows.length === 0) return "";
  const labelW = 230;
  const barMax = 520;
  const rowH = 24;
  const max = Math.max(1, ...rows.map((r) => r.added + r.deleted));
  const height = rows.length * rowH + 34;
  const width = labelW + barMax + 150;
  const out: string[] = [`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Lines added and deleted, ${rows.length} rows" ${FONT}>`];
  rows.forEach((r, i) => {
    const y = 6 + i * rowH;
    const a = Math.round((r.added / max) * barMax);
    const d = Math.round((r.deleted / max) * barMax);
    out.push(
      `<g><title>${esc(`${r.label}: +${r.added} −${r.deleted}`)}</title>`,
      `<text x="${labelW - 8}" y="${y + 14}" text-anchor="end" font-size="12" fill="#1d2733">${esc(clip(r.label, 34))}</text>`,
      `<rect x="${labelW}" y="${y + 3}" width="${a}" height="15" fill="#4caf7a"/>`,
      `<rect x="${labelW + a}" y="${y + 3}" width="${d}" height="15" fill="#e0675d"/>`,
      `<text x="${labelW + a + d + 8}" y="${y + 15}" font-size="11" fill="#33414f">+${r.added} −${r.deleted}</text>`,
      `</g>`,
    );
  });
  const ly = rows.length * rowH + 14;
  out.push(
    `<rect x="${labelW}" y="${ly}" width="12" height="10" fill="#4caf7a"/><text x="${labelW + 18}" y="${ly + 9}" font-size="11" fill="#33414f">added</text>`,
    `<rect x="${labelW + 70}" y="${ly}" width="12" height="10" fill="#e0675d"/><text x="${labelW + 88}" y="${ly + 9}" font-size="11" fill="#33414f">deleted</text>`,
    `</svg>`,
  );
  return out.join("\n");
}

/** A bar for a function's CRAP value with the threshold marked (design §6.11); over the threshold the bar is red. */
export function crapBarSvg(value: number, threshold: number, scaleMax: number): string {
  const w = 180;
  const h = 14;
  const max = Math.max(scaleMax, threshold * 1.5, value);
  const bar = Math.max(1, Math.round((value / max) * w));
  const mark = Math.round((threshold / max) * w);
  return [
    `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(`CRAP ${value}, threshold ${threshold}`)}">`,
    `<rect x="0" y="2" width="${w}" height="10" rx="2" fill="#eceff1"/>`,
    `<rect x="0" y="2" width="${bar}" height="10" rx="2" fill="${value >= threshold ? "#e0675d" : "#4caf7a"}"/>`,
    `<line x1="${mark}" y1="0" x2="${mark}" y2="${h}" stroke="#1d2733" stroke-width="1.5"/>`,
    `</svg>`,
  ].join("");
}
