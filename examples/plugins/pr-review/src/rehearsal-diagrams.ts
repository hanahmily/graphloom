// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The diagram documents a rehearsal's stand-in model returns for the `diagrams-v1` job (design §6.10, §16): small, plain
 * documents in the shape the diagram-design skill produces (its light minimal template, system fonts, a Data flow
 * or a State machine), drawn from the checked data alone with connectors the skill's geometry check accepts. They pass the
 * skill's own `self_check.py --offline` and `verify-geometry.py` (a test runs both on them when `python3` is there) and the
 * plugin's label rule, so a rehearsal exercises the whole diagram flow with a drawing that stands. They are test data, not a
 * layout engine: each stage's connectors leave and enter its right side, one lane each.
 */
import type { FinalFeature } from "./briefing.js";
import { diagramSpecs, featureDiagramId, type DiagramInput, type DiagramSpec } from "./diagrams.js";
import { esc, wrap } from "./escape.js";

const MONO = "ui-monospace, monospace";
const SANS = "system-ui, sans-serif";
const up4 = (n: number): number => Math.ceil(n / 4) * 4;

const MARKERS =
  '<marker id="arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#4f5d75"/></marker>' +
  '<marker id="arrow-accent" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0, 8 3, 0 6" fill="#bf4520"/></marker>';

function document(slug: string, eyebrow: string, heading: string, title: string, description: string, width: number, height: number, body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `  <title>${esc(heading)}</title>`,
    "  <style>",
    "    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }",
    "    :root { --color-paper: #f5f5f5; --color-ink: #2d3142; --color-muted: #4f5d75; --color-accent: #bf4520; }",
    `    body { font-family: ${SANS}; background: var(--color-paper); color: var(--color-ink); min-height: 100vh; padding: 3rem 2rem; }`,
    "    .frame { max-width: 1200px; width: 100%; margin: 0 auto; }",
    "    .diagram-container { width: 100%; overflow-x: auto; }",
    `    .eyebrow { font-family: ${MONO}; font-size: 0.66rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color-muted); margin-bottom: 0.5rem; }`,
    "    h1 { font-size: 1.6rem; font-weight: 400; margin-bottom: 1.5rem; }",
    `    svg { width: 100%; min-width: ${width}px; display: block; }`,
    "    @media print { .diagram-container { overflow-x: visible; } svg { min-width: 0; } }",
    "  </style>",
    "</head>",
    "<body>",
    '  <div class="frame">',
    `    <p class="eyebrow">${esc(eyebrow)} · Diagram Design</p>`,
    `    <h1>${esc(heading)}</h1>`,
    '    <div class="diagram-container">',
    `      <svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${slug}-title ${slug}-desc">`,
    `        <title id="${slug}-title">${esc(title)}</title>`,
    `        <desc id="${slug}-desc">${esc(description)}</desc>`,
    `        <defs>${MARKERS}</defs>`,
    '        <rect width="100%" height="100%" fill="#f5f5f5"/>',
    body,
    "      </svg>",
    "    </div>",
    "  </div>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const text = (x: number, y: number, s: string, o: { size?: number; weight?: number; fill?: string; mono?: boolean; anchor?: string; attrs?: string } = {}): string =>
  `<text x="${x}" y="${y}" fill="${o.fill ?? "#2d3142"}" font-size="${o.size ?? 12}"${o.weight !== undefined ? ` font-weight="${o.weight}"` : ""} font-family="${o.mono === true ? MONO : SANS}"${o.anchor !== undefined ? ` text-anchor="${o.anchor}"` : ""}${o.attrs ?? ""}>${esc(s)}</text>`;

/** A label mask and its text, left aligned at `x`: the plate the skill puts behind an arrow label, 20 to 200 wide and 12 tall. */
function maskedLabel(x: number, y: number, label: string, width: number): string[] {
  const lines = wrap(label, Math.max(6, Math.floor((width - 8) / 5.8)), 8);
  return lines.flatMap((l, i) => {
    const w = Math.min(200, Math.max(20, Math.ceil(l.length * 5.8) + 8));
    return [`<rect x="${x}" y="${y + i * 12}" width="${w}" height="12" rx="2" fill="#f5f5f5"/>`, text(x + 4, y + i * 12 + 9, l, { size: 8, fill: "#4f5d75", mono: true })];
  });
}

// ---- Data flow ----

interface PlacedBox {
  id: string;
  label: string;
  lines: string[];
  kind: string;
  y: number;
  h: number;
}

const BOX_X = 24;
const BOX_W = 160;

/** The Data flow document of one feature: its stages in a column, in the order given, the flows as connectors on their right, one lane each, every label in a column beside the lanes. */
export function featureDocument(f: FinalFeature, spec: DiagramSpec): string {
  const stages = f.stages;
  const known = new Set(stages.map((n) => n.id));
  const flows = f.flows.filter((e) => e.from !== e.to && known.has(e.from) && known.has(e.to));
  const degree = new Map(stages.map((n) => [n.id, 0]));
  flows.forEach((e) => {
    degree.set(e.from, degree.get(e.from)! + 1);
    degree.set(e.to, degree.get(e.to)! + 1);
  });
  let y = 16;
  const boxes = new Map<string, PlacedBox>();
  for (const n of stages) {
    const lines = wrap(n.label, 20, 8);
    const h = up4(Math.max(28 + 14 * (1 + lines.length), 16 * (degree.get(n.id)! + 1)));
    boxes.set(n.id, { id: n.id, label: n.label, lines, kind: n.kind, y, h });
    y += h + 32;
  }
  const used = new Map(stages.map((n) => [n.id, 0]));
  const port = (id: string): number => {
    const k = used.get(id)! + 1;
    used.set(id, k);
    return boxes.get(id)!.y + 16 * k;
  };
  // The lanes are 16 apart; every label stands in a column to the right of the last lane, level with the line it names, so no lane crosses one.
  const labelW = 144;
  const labelX = BOX_X + BOX_W + 24 + 16 * Math.max(1, flows.length) + 8;
  const width = up4(labelX + labelW + 8 + 24);
  const height = up4(Math.max(y, 120) + 56);
  const paths: string[] = [];
  const labels: string[] = [];
  flows.forEach((e, k) => {
    const lane = BOX_X + BOX_W + 24 + 16 * k;
    const ya = port(e.from);
    const yb = port(e.to);
    const x0 = BOX_X + BOX_W;
    const focal = k === 0;
    paths.push(`<path d="M ${x0} ${ya} H ${lane} V ${yb} H ${x0}" fill="none" stroke="${focal ? "#bf4520" : "#4f5d75"}" stroke-width="1.2" marker-end="url(#${focal ? "arrow-accent" : "arrow"})"/>`);
    if (e.label.trim() !== "") labels.push(...maskedLabel(labelX, ya - 6, e.label, labelW));
  });
  const nodeSvg = [...boxes.values()].map((b) =>
    [
      "<g>",
      `<rect x="${BOX_X}" y="${b.y}" width="${BOX_W}" height="${b.h}" rx="6" fill="#ffffff" stroke="#2d3142" stroke-width="1"/>`,
      text(BOX_X + 8, b.y + 16, b.kind.toUpperCase(), { size: 9, fill: "#4f5d75", mono: true }),
      ...b.lines.map((l, i) => text(BOX_X + 8, b.y + 32 + 14 * i, l, { size: 12, weight: 600 })),
      "</g>",
    ].join(""),
  );
  return document("data-flow", "Data flow", f.name, spec.title, spec.description, width, height, [...paths, ...labels, ...nodeSvg].join("\n"));
}

// ---- State machine ----

/** The State machine document of one lifecycle entry: the start dot, the initial state, one transition per recorded transition, the reads. */
export function stateDocument(entry: DiagramInput["states"][number]["entry"], spec: DiagramSpec): string {
  const n = Math.max(1, entry.transitions.length);
  const initialLines = wrap(entry.initial, 30, 8);
  const nameLines = wrap(entry.name, 28, 8);
  const boxX = 120;
  const boxW = 240;
  const effectX = 640;
  const effectW = 256;
  const effects = entry.transitions.map((t) => wrap(t.effect, 36, 8));
  const rowH = effects.map((l) => up4(24 + 14 * l.length));
  const pitch = Math.max(...rowH, 56) + 32;
  const initialH = up4(Math.max(16 * (n + 1), 40 + 14 * (nameLines.length + initialLines.length + 1)));
  const top = 56;
  const machineH = Math.max(initialH, n * pitch);
  const readsTop = top + machineH + 40;
  const reads = entry.reads.map((r) => wrap(`${r.where} — ${r.decision}`, 110, 8));
  const height = up4(readsTop + (reads.length > 0 ? 28 : 0) + reads.reduce((a, l) => a + 14 * l.length + 6, 0) + 24);
  const width = 960;
  const cy = top + initialH / 2;
  const parts: string[] = [];
  parts.push(`<line x1="68" y1="${cy}" x2="${boxX}" y2="${cy}" stroke="#4f5d75" stroke-width="1.2" marker-end="url(#arrow)"/>`);
  entry.transitions.forEach((t, k) => {
    const py = top + 16 * (k + 1);
    const ey = top + k * pitch + rowH[k]! / 2;
    const lane = boxX + boxW + 24 + 24 * k;
    parts.push(`<path d="M ${boxX + boxW} ${py} H ${lane} V ${ey} H ${effectX}" fill="none" stroke="${k === 0 ? "#bf4520" : "#4f5d75"}" stroke-width="1.2" marker-end="url(#${k === 0 ? "arrow-accent" : "arrow"})"/>`);
    // Above the last horizontal segment, 6px clear of it, where nothing else runs.
    const lines = wrap(t.when, Math.max(6, Math.floor((effectX - lane - 32) / 5.8)), 8).length;
    parts.push(...maskedLabel(lane + 12, ey - 18 - 12 * (lines - 1), t.when, effectX - lane - 24));
  });
  parts.push(`<circle cx="60" cy="${cy}" r="6" fill="#2d3142"/>`);
  parts.push(
    `<rect x="${boxX}" y="${top}" width="${boxW}" height="${initialH}" rx="8" fill="#ffffff" stroke="#2d3142" stroke-width="1"/>`,
    text(boxX + 8, top + 16, "STATE", { size: 8, fill: "#4f5d75", mono: true }),
    ...nameLines.map((l, i) => text(boxX + 8, top + 36 + 14 * i, l, { size: 13, weight: 600 })),
    text(boxX + 8, top + 36 + 14 * nameLines.length + 4, "INITIAL", { size: 8, fill: "#4f5d75", mono: true }),
    ...initialLines.map((l, i) => text(boxX + 8, top + 36 + 14 * nameLines.length + 18 + 14 * i, l, { size: 11 })),
  );
  entry.transitions.forEach((_t, k) => {
    const ty = top + k * pitch;
    parts.push(`<rect x="${effectX}" y="${ty}" width="${effectW}" height="${rowH[k]!}" rx="8" fill="#ffffff" stroke="#4f5d75" stroke-width="1"/>`, ...effects[k]!.map((l, i) => text(effectX + 8, ty + 18 + 14 * i, l, { size: 11 })));
  });
  if (reads.length > 0) {
    parts.push(text(24, readsTop + 8, "Reads", { size: 11, weight: 600, mono: true }));
    let ry = readsTop + 28;
    for (const lines of reads) {
      lines.forEach((l, i) => parts.push(text(40, ry + 14 * i, l, { size: 10, fill: "#4f5d75" })));
      ry += 14 * lines.length + 6;
    }
  }
  return document("state", "State machine", entry.name, spec.title, spec.description, width, height, parts.join("\n"));
}

/** The `diagrams-v1` result a rehearsal's stand-in model returns for the checked data: one document for each diagram asked. */
export function fixtureDiagrams(input: DiagramInput): { diagrams: Array<{ id: string; html: string }> } {
  const { drawn } = diagramSpecs(input);
  return {
    diagrams: drawn.map((spec) => ({
      id: spec.id,
      html: spec.kind === "feature" ? featureDocument(input.features.find((f) => featureDiagramId(f.id) === spec.id)!, spec) : stateDocument(input.states.find((s) => s.id === spec.id)!.entry, spec),
    })),
  };
}
