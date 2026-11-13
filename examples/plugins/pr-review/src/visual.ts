// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The visual-only `review.html` (design §6.11): the report as diagrams and visual elements, nothing else. The sections
 * are the verdict and scope tiles, the data-flow diagrams, the risk map (a treemap of the areas), the question status
 * grid and, when the review layer ran, the findings grid. Every visible text is a short label, a number or a badge;
 * anything longer is a tooltip (an SVG `<title>`, an HTML `title` attribute) and is in the appendix, which stays the
 * full detail. Plugin code only, deterministic, no script: every text goes through `esc`.
 */
import { CHECK_LISTS, type CheckList, type FinalFeature } from "./briefing.js";
import type { ChangeCard, Excerpt } from "./cards.js";
import type { DrawnDiagram } from "./diagrams.js";
import type { Draft } from "./draft.js";
import { clip, esc } from "./escape.js";
import { featureSvg } from "./flowlayout.js";
import type { HtmlInput, ReportDoc } from "./html.js";
import { effectiveConclusion, NECESSITY_ID } from "./necessity.js";
import { proofOf } from "./proof.js";
import { SEVERITIES, type Finding } from "./review.js";
import { hotspots, hotspotText, SCOPE_KINDS, SCOPE_TITLES, type ScopeKind } from "./scope.js";
import { squarify } from "./treemap.js";

/** The places the page links to: the pull request, its commits, and the other file of the report. */
export interface VisualLinks {
  pull: string;
  head: string;
  base?: string;
  appendix: string;
  /** A citation as the report writes it elsewhere: a link to the file at the pinned head or base on GitHub. */
  cite: (c: { path: string; side?: string; tree?: string; start: number; end: number }) => string;
}

const FONT = 'font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"';

/** Tile classes: the same four colours everywhere (green, amber, red, grey). */
export type Tone = "ok" | "warn" | "bad" | "grey";

const CONCLUSION_TONE: Record<string, Tone> = { necessary: "ok", questionable: "warn", unnecessary: "bad", "needs author": "grey" };
const VERDICT_TONE: Record<string, Tone> = { preserves: "ok", breaks: "bad", "not-applicable": "grey" };
const STATUS_TONE: Record<string, Tone> = { answered: "ok", "partially answered": "warn", "needs author": "bad" };

/** What each question type is called on a tile: a short abbreviation, with its meaning in the tooltip. */
export const TYPE_ABBREVIATIONS: Record<string, string> = {
  necessity: "NEC",
  purpose: "WHY",
  "existing-reuse-common": "REUSE",
  "missing-test": "TEST",
  "split-function": "SPLIT",
  "complexity-coverage": "COV",
  "weak-test": "WEAK",
  other: "ETC",
};

const appendixAt = (l: VisualLinks, anchor: string): string => `${l.appendix}#${anchor}`;

const tile = (tone: Tone, inner: string, title: string, href?: string, extra = ""): string =>
  href === undefined ? `<span class="tile ${tone}${extra}" title="${esc(title)}">${inner}</span>` : `<a class="tile ${tone}${extra}" href="${esc(href)}" title="${esc(title)}">${inner}</a>`;

// ---- 1. the header strip ----

/** PR number and title on one line, the head and base commits, and the link to the appendix. */
export function visualHeader(r: ReportDoc, l: VisualLinks): string {
  const name = `${r.pull.owner}/${r.pull.repo}#${r.pull.number}`;
  const sha = (s: string): string => s.slice(0, 7);
  return [
    `<header class="top vh"><h1><a href="${esc(l.pull)}" title="${esc(`${name} ${r.pull.title}`)}">${esc(name)}</a> <span class="title" title="${esc(r.pull.title)}">${esc(clip(r.pull.title, 90))}</span></h1>`,
    `<p class="sub"><a href="${esc(l.head)}" title="head ${esc(r.pull.head)}"><code>${esc(sha(r.pull.head))}</code></a>${r.pull.base !== undefined && l.base !== undefined ? ` ← <a href="${esc(l.base)}" title="base ${esc(r.pull.base)}"><code>${esc(sha(r.pull.base))}</code></a>` : ""} · <a href="${esc(l.appendix)}">appendix</a></p></header>`,
  ].join("");
}

// ---- 2. verdict and scope tiles ----

const SCOPE_FILL: Record<ScopeKind, string> = { production: "#3f86c9", tests: "#2e8b57", docs: "#d98e04", generated: "#90a4ae" };

/** The scope as one stacked bar of added lines (production, tests, docs, generated or other), the deleted lines as a thin second bar. */
export function scopeBarSvg(scope: ReportDoc["scope"]): string {
  const W = 960;
  const added = SCOPE_KINDS.map((k) => ({ k, n: scope[k].added }));
  const deleted = SCOPE_KINDS.map((k) => ({ k, n: scope[k].deleted }));
  const totalAdded = added.reduce((n, a) => n + a.n, 0);
  const totalDeleted = deleted.reduce((n, a) => n + a.n, 0);
  const segments = (rows: Array<{ k: ScopeKind; n: number }>, total: number, y: number, h: number, label: boolean, sign: string): string[] => {
    let x = 0;
    const out: string[] = [];
    for (const { k, n } of rows) {
      if (n <= 0 || total <= 0) continue;
      const w = Math.max(1, (n / total) * W);
      const row = scope[k];
      const text = `${SCOPE_TITLES[k]} ${sign}${n}`;
      out.push(`<g><title>${esc(`${SCOPE_TITLES[k]}: ${row.files} file${row.files === 1 ? "" : "s"}, +${row.added} −${row.deleted}`)}</title><rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${h}" fill="${SCOPE_FILL[k]}" stroke="#ffffff" stroke-width="1"/>`);
      if (label && w >= text.length * 6.6 + 10) out.push(`<text x="${(x + 8).toFixed(1)}" y="${y + h / 2 + 4}" font-size="12" font-weight="600" fill="#ffffff">${esc(text)}</text>`);
      out.push(`</g>`);
      x += w;
    }
    return out;
  };
  const legend = SCOPE_KINDS.filter((k) => scope[k].added > 0 || scope[k].deleted > 0).map((k, n) => `<g><rect x="${n * 190}" y="52" width="12" height="12" fill="${SCOPE_FILL[k]}"/><text x="${n * 190 + 18}" y="62" font-size="12" fill="#33414f">${esc(`${SCOPE_TITLES[k]} +${scope[k].added} −${scope[k].deleted}`)}</text></g>`);
  const empty = totalAdded + totalDeleted === 0;
  return [
    `<svg viewBox="0 0 ${W} 72" width="${W}" height="72" role="img" aria-label="${esc(`Scope: +${totalAdded} −${totalDeleted} lines by kind of file`)}" ${FONT}>`,
    empty ? `<text x="0" y="22" font-size="12" fill="#5b6b7b">no changed lines</text>` : "",
    ...segments(added, totalAdded, 0, 30, true, "+"),
    ...segments(deleted, totalDeleted, 36, 8, false, "−"),
    ...(empty ? [] : legend),
    `</svg>`,
  ].join("");
}

/** The checks as passed, failed and pending counts. */
export function checkCounts(checks: ReportDoc["checks"]): { passed: number; failed: number; pending: number } {
  const passed = checks.filter((c) => c.status === "completed" && ["success", "neutral", "skipped"].includes(c.conclusion ?? "")).length;
  const failed = checks.filter((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? "")).length;
  return { passed, failed, pending: checks.length - passed - failed };
}

function verdictSection(i: HtmlInput, l: VisualLinks): string {
  const r = i.report;
  const n = i.necessity;
  const conclusion = n !== undefined ? effectiveConclusion(n.final) : undefined;
  const principles = n?.final.necessity?.principles ?? [];
  // `rounds: review-only` (design §3.2): the Q&A was skipped by the operator's choice, which is not "pending".
  const skipped = n === undefined ? i.qa?.roundsSkipped : undefined;
  const n1 = tile(
    conclusion === undefined ? "grey" : (CONCLUSION_TONE[conclusion] ?? "grey"),
    `<small>${NECESSITY_ID}: is it necessary?</small><strong>${esc(conclusion ?? (skipped !== undefined ? "skipped" : "pending"))}</strong>`,
    n?.final.necessity !== undefined ? clip(n.final.necessity.rationale, 240) : skipped !== undefined ? skipped.note : "N1 is answered after the report",
    appendixAt(l, `q-${NECESSITY_ID}`),
    " big",
  );
  const grid =
    n === undefined
      ? skipped !== undefined
        ? tile("grey", "skipped", `skipped by the operator's choice (${skipped.reason})`)
        : tile("grey", "pending", "the principles are judged with N1")
      : principles.length === 0
        ? tile("grey", "none", "no project principle applies to this change")
        : principles.map((p) => tile(VERDICT_TONE[p.verdict] ?? "grey", esc(p.id), `${p.id} ${p.verdict}: ${clip(p.explanation, 200)}`, appendixAt(l, `q-${NECESSITY_ID}`), " sm")).join("");
  const added = r.files.reduce((a, f) => a + f.additions, 0);
  const deleted = r.files.reduce((a, f) => a + f.deletions, 0);
  const checks = checkCounts(r.checks);
  const checkTone: Tone = r.checks.length === 0 ? "grey" : checks.failed > 0 ? "bad" : checks.pending > 0 ? "warn" : "ok";
  const stat = (value: string, label: string, title: string, tone: Tone = "grey"): string => tile(tone, `<strong>${esc(value)}</strong><small>${esc(label)}</small>`, title, undefined, " stat");
  return [
    `<section class="vis" id="verdict"><h2>Verdict and scope</h2>`,
    `<div class="row">${n1}<div class="col"><h3>Principles</h3><div class="tiles">${grid}</div></div></div>`,
    `<h3>Scope</h3><div class="scroll">${scopeBarSvg(r.scope)}</div>`,
    `<div class="tiles">${stat(String(r.files.length), "files", `${r.files.length} changed files, +${added} −${deleted} lines`)}${stat(String(r.commits), "commits", `${r.commits} commits`)}${stat(r.checks.length === 0 ? "none" : `${checks.passed}/${r.checks.length}`, "checks", r.checks.length === 0 ? "no GitHub checks reported" : `${checks.passed} passed, ${checks.failed} failed, ${checks.pending} pending`, checkTone)}</div>`,
    `</section>`,
  ].join("");
}

// ---- 3. data-flow diagrams ----

/** One feature's data-flow diagram with its name as the only caption; the summary, and the reason a drawing is the plugin's own, are in the tooltip (and in the appendix). */
function flowFigure(r: ReportDoc, f: FinalFeature, k: number): string {
  const d: DrawnDiagram | undefined = r.diagrams?.features[f.id];
  const svg = d?.via === "diagram-design" ? d.svg : featureSvg(f, `fl${k + 1}`);
  const tip = d?.via === "plugin" ? `${f.summary} (${d.note})` : f.summary;
  return `<div class="flow" id="${esc(f.id)}"><div class="cap" title="${esc(tip)}"><span class="rid">${esc(f.id)}</span> ${esc(clip(f.name, 80))}</div><div class="scroll">${svg}</div></div>`;
}

const lineMark = { add: "+", del: "-", ctx: " " } as const;

/** One cite's excerpt: its GitHub link, the patch lines it covers with their numbers and marks in a `<pre>`, and what the bounds left out. */
function excerptHtml(e: Excerpt, l: VisualLinks): string {
  const width = String(Math.max(...e.lines.map((x) => x.line))).length;
  const pre = e.lines.map((x) => `<span class="l ${x.kind}">${esc(`${lineMark[x.kind]} ${String(x.line).padStart(width, " ")}  ${x.text}`)}</span>`).join("");
  const base = e.cite.side === "base" ? ' <span class="muted">(base side)</span>' : "";
  return `<div class="ex"><div class="exh">${l.cite(e.cite)}${base}</div><pre>${pre}</pre>${e.more > 0 ? `<div class="muted">… ${e.more} more line${e.more === 1 ? "" : "s"}, at the link</div>` : ""}</div>`;
}

/** A change's card (design §6.11): id and title, its one sentence, its diagram, core files, the files synced along, and the cited code. */
function changeCard(r: ReportDoc, c: ChangeCard, n: number, l: VisualLinks): string {
  const cites = r.briefing.whatsNew[n]?.cites ?? [];
  const feature = c.feature === "" ? undefined : r.briefing.features.find((f) => f.id === c.feature);
  const fileCite = (path: string, lines: boolean): { path: string; side: "head" | "base"; start: number; end: number } => {
    const own = lines ? cites.find((x) => x.path === path && x.start >= 1) : undefined;
    if (own !== undefined) return own;
    const removed = r.files.find((f) => f.path === path)?.status === "removed";
    return { path, side: removed ? "base" : "head", start: 0, end: 0 };
  };
  const core = c.core.map((p) => `<span class="corechip" title="core file: carries the change's logic">${l.cite(fileCite(p, true))}</span>`).join("");
  const alsoCount = c.synced.length + c.syncedMore;
  const also =
    alsoCount === 0
      ? ""
      : `<details class="also"><summary>also changed (${alsoCount})</summary><div class="chips">${c.synced.map((p) => `<span class="corechip sm">${l.cite(fileCite(p, false))}</span>`).join("")}${c.syncedMore > 0 ? `<span class="muted">+${c.syncedMore} more</span>` : ""}</div></details>`;
  const shown = c.excerpts.reduce((a, e) => a + e.lines.length, 0);
  const total = shown + c.excerpts.reduce((a, e) => a + e.more, 0) + c.excerptsMore;
  const code =
    c.excerpts.length === 0
      ? ""
      : `<details class="code"><summary>cited code (${total} line${total === 1 ? "" : "s"})</summary>${c.excerpts.map((e) => excerptHtml(e, l)).join("")}${c.excerptsMore > 0 ? `<div class="muted">… ${c.excerptsMore} more lines of other cites, at their links</div>` : ""}</details>`;
  return [
    `<div class="chg" id="${esc(c.id)}"><div class="ch"><span class="rid">${esc(c.id)}</span> <span class="ct" title="${esc(c.title)}">${esc(clip(c.title, 120))}</span></div>`,
    `<p class="co">${esc(clip(c.overview, 240))}</p>`,
    feature === undefined ? "" : flowFigure(r, feature, r.briefing.features.indexOf(feature)),
    `<div class="chips">${core}</div>`,
    // Every cite of the change is a link, whether or not an excerpt of it is shown (an unchanged file of a large report, a cite past the excerpt budget).
    cites.length === 0 ? "" : `<div class="chips cl">${cites.map((x) => `<span class="corechip sm" title="cited by this change">${l.cite(x)}</span>`).join("")}</div>`,
    also,
    code,
    `</div>`,
  ].join("");
}

/**
 * The Changes section: one card for each high-level change the claim check left (design §6.11), each with the diagram of
 * the feature it names. A feature no change names keeps its diagram after the cards; a report with no card (the claim
 * check left no change, or one written before 0.25) shows the diagrams alone, under the old heading.
 */
function flowsSection(r: ReportDoc, l: VisualLinks): string {
  const fs = r.briefing.features;
  const cards = r.cards ?? [];
  const drawn = new Set(cards.map((c) => c.feature).filter((x) => x !== ""));
  const loose = fs.map((f, k) => ({ f, k })).filter(({ f }) => !drawn.has(f.id) || cards.length === 0);
  const figures = loose.map(({ f, k }) => flowFigure(r, f, k));
  if (cards.length === 0) return `<section class="vis" id="flows"><h2>Data flow</h2>${figures.length === 0 ? tile("grey", "no new feature", "the report names no new feature with a data path") : figures.join("")}</section>`;
  return `<section class="vis" id="changes"><h2>Changes</h2>${cards.map((c, n) => changeCard(r, c, n, l)).join("")}${figures.length > 0 ? `<h3>Other data flows</h3>${figures.join("")}` : ""}</section>`;
}

// ---- 4. the risk map ----

/** What the briefing's check lists say of an area, from the most to the least serious. */
export const RISK_KINDS = ["risk", "compatibility", "behavior", "surface", "none"] as const;
export type RiskKind = (typeof RISK_KINDS)[number];

/** The list of `check` each kind comes from; the `tests` list says nothing of risk. */
const KIND_OF_LIST: Partial<Record<CheckList, RiskKind>> = { risks: "risk", compatibility: "compatibility", behavior: "behavior", surfaces: "surface" };

const RISK_FILL: Record<RiskKind, string> = { risk: "#e8847b", compatibility: "#f0a35e", behavior: "#f2d16b", surface: "#7fb2e0", none: "#e3e8ec" };
const RISK_NAMES: Record<RiskKind, string> = { risk: "risk", compatibility: "compatibility", behavior: "changed behavior", surface: "new surface", none: "nothing to check" };

export interface RiskArea {
  id: string;
  label: string;
  lines: number;
  paths: ReadonlySet<string>;
}

/** The areas of a large report; for any other report, the report's sections with the files their items cite (as the change map counts them). */
export function riskAreas(r: ReportDoc): RiskArea[] {
  const byPath = new Map(r.files.map((f) => [f.path, f] as const));
  const lines = (paths: ReadonlySet<string>): number => r.files.filter((f) => paths.has(f.path) || (f.previousPath != null && paths.has(f.previousPath))).reduce((n, f) => n + f.additions + f.deletions, 0);
  if (r.mode === "large" && r.areas !== undefined && r.areas.length > 0) {
    const labels = new Map(r.briefing.areas.map((a) => [a.id, a.label] as const));
    return r.areas.map((a) => ({ id: a.id, label: labels.get(a.id) ?? a.name, paths: new Set(a.paths), lines: lines(new Set(a.paths)) })).filter((a) => a.lines > 0);
  }
  return r.sections
    .filter((s) => s.id !== "measurements")
    .map((s) => {
      const paths = new Set([...new Set(s.items.flatMap((i) => i.cites.map((c) => c.path)))].filter((p) => byPath.has(p)));
      return { id: s.id, label: s.title, paths, lines: lines(paths) };
    })
    .filter((a) => a.lines > 0);
}

/**
 * What the briefing's check lists cite in an area. The kind is the most serious one cited, in this order: risk,
 * compatibility, changed behavior, new surface; an area no entry cites is `none`. `entries` are those entries, one line each.
 */
export function areaRisk(area: RiskArea, check: ReportDoc["briefing"]["check"]): { kind: RiskKind; entries: string[] } {
  const found = new Map<RiskKind, string[]>();
  for (const list of CHECK_LISTS) {
    const kind = KIND_OF_LIST[list];
    if (kind === undefined) continue;
    for (const e of check[list]) {
      if (e.cites.some((c) => area.paths.has(c.path))) found.set(kind, [...(found.get(kind) ?? []), `${RISK_NAMES[kind]}: ${clip(e.text, 140)}`]);
    }
  }
  const kind = RISK_KINDS.find((k) => k !== "none" && found.has(k)) ?? "none";
  return { kind, entries: RISK_KINDS.flatMap((k) => found.get(k) ?? []) };
}

/** One check entry that cites an area, with its kind and the cites inside the area. */
export interface AreaReason {
  kind: RiskKind;
  text: string;
  cites: ReportDoc["briefing"]["check"]["risks"][number]["cites"];
}

/** The entries of the check lists that cite an area, in the colour precedence (risk first), then the order of the list. */
export function areaReasons(area: RiskArea, check: ReportDoc["briefing"]["check"]): AreaReason[] {
  const found: AreaReason[] = [];
  for (const list of CHECK_LISTS) {
    const kind = KIND_OF_LIST[list];
    if (kind === undefined) continue;
    for (const e of check[list]) {
      const cites = e.cites.filter((c) => area.paths.has(c.path));
      if (cites.length > 0) found.push({ kind, text: e.text, cites });
    }
  }
  return RISK_KINDS.flatMap((k) => found.filter((f) => f.kind === k));
}

/** The element id of an area's reason card, the target of its rectangle's link. */
export const areaAnchor = (id: string): string => `area-${id.replace(/[^A-Za-z0-9_.:-]/g, "_")}`;

const MAX_CARD_CITES = 3;

/** The card of a coloured area: id, label and colour badge; one line for each check entry; the findings located in its files as chips. */
function areaCard(area: RiskArea, kind: RiskKind, reasons: readonly AreaReason[], findings: readonly Finding[], l: VisualLinks): string {
  const lines = reasons.map((x) => {
    const shown = x.cites.slice(0, MAX_CARD_CITES).map((c) => l.cite(c)).join(" ");
    const more = x.cites.length > MAX_CARD_CITES ? ` <span class="muted" title="${esc(x.cites.slice(MAX_CARD_CITES).map((c) => c.path).join(", "))}">+${x.cites.length - MAX_CARD_CITES}</span>` : "";
    return `<div class="re"><span class="rk ${x.kind}">${esc(RISK_NAMES[x.kind])}</span> <span class="rt" title="${esc(x.text)}">${esc(clip(x.text, 200))}</span> <span class="cites">${shown}${more}</span></div>`;
  });
  const chips = findings.map((f) => `<a class="fchip ${findingTone(f)}" href="${esc(appendixAt(l, `f-${f.id}`))}" title="${esc(`${f.id} ${f.severity} ${findingTone(f)}: ${clip(f.content, 140)} (${f.path}:${f.startLine})`)}">${esc(f.id)} ${esc(f.severity)}</a>`);
  return `<div class="rcard" id="${esc(areaAnchor(area.id))}"><div class="rh"><span class="aid">${esc(area.id)}</span> <span class="rl" title="${esc(area.label)}">${esc(clip(area.label, 60))}</span> <span class="rb ${kind}">${esc(RISK_NAMES[kind])}</span></div><div class="rlines">${lines.join("")}</div>${chips.length > 0 ? `<div class="fchips">${chips.join("")}</div>` : ""}</div>`;
}

const MAP_W = 960;
const MAP_H = 400;
const CHAR_W = 6.4;

function riskSection(r: ReportDoc, l: VisualLinks, d: Draft | undefined): string {
  const areas = riskAreas(r);
  if (areas.length === 0) return `<section class="vis" id="risk"><h2>Risk map</h2>${tile("grey", "no changed lines", "no area has changed lines")}</section>`;
  const rects = squarify(areas.map((a) => ({ id: a.id, value: a.lines })), 0, 0, MAP_W, MAP_H);
  const byId = new Map(areas.map((a) => [a.id, a] as const));
  const cells: string[] = [];
  const kinds = new Map<string, RiskKind>();
  const counts = new Map<RiskKind, number>();
  const where = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const rect of rects) {
    const area = byId.get(rect.id)!;
    where.set(area.id, rect);
    const { kind, entries } = areaRisk(area, r.briefing.check);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    kinds.set(area.id, kind);
    const room = Math.floor((rect.w - 10) / CHAR_W);
    const full = `${area.id} ${area.label}`;
    const text = rect.h < 18 || room < area.id.length ? "" : full.length <= room ? full : room >= area.id.length + 4 ? clip(full, room) : area.id;
    const tip = [`${area.id} ${area.label} (${area.lines} lines changed)`, ...(entries.length === 0 ? [RISK_NAMES.none] : entries)].join("\n");
    const cell = [
      `<g><title>${esc(tip)}</title><rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.w.toFixed(1)}" height="${rect.h.toFixed(1)}" fill="${RISK_FILL[kind]}" stroke="#ffffff" stroke-width="2"/>`,
      text === "" ? "" : `<text x="${(rect.x + 6).toFixed(1)}" y="${(rect.y + 15).toFixed(1)}" font-size="11" font-weight="600" fill="#1d2733">${esc(text)}</text>`,
      `</g>`,
    ].join("");
    // A coloured area links to its reason card; an area with nothing to check has none.
    cells.push(kind === "none" ? cell : `<a href="#${esc(areaAnchor(area.id))}">${cell}</a>`);
  }
  // The hotspot functions, as dots at the bottom of their area, left to right.
  const dots: string[] = [];
  const used = new Map<string, number>();
  for (const h of hotspots(r.measurements.records ?? [])) {
    const area = areas.find((a) => a.paths.has(h.path));
    const box = area === undefined ? undefined : where.get(area.id);
    if (area === undefined || box === undefined) continue;
    const k = used.get(area.id) ?? 0;
    used.set(area.id, k + 1);
    const perRow = Math.max(1, Math.floor((box.w - 12) / 14));
    const cx = box.x + 10 + (k % perRow) * 14;
    const cy = box.y + box.h - 10 - Math.floor(k / perRow) * 14;
    if (cy < box.y + 6) continue;
    dots.push(`<g><title>${esc(`${hotspotText(h)} — ${h.path}:${h.startLine}`)}</title><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="#1d2733" stroke="#ffffff" stroke-width="1.5"/></g>`);
  }
  const svg = [`<svg viewBox="0 0 ${MAP_W} ${MAP_H}" width="${MAP_W}" height="${MAP_H}" role="img" aria-label="${esc(`Risk map of ${areas.length} areas, sized by lines changed`)}" ${FONT}>`, ...cells, ...dots, `</svg>`].join("");
  const legend = RISK_KINDS.map((k) => `<span class="key"><span class="sw" style="background:${RISK_FILL[k]}"></span>${esc(RISK_NAMES[k])} ${counts.get(k) ?? 0}</span>`).join("");
  const hot = `<span class="key"><span class="sw dot"></span>hotspot function</span>`;
  const live = (d?.review.findings ?? []).filter((f) => f.state !== "dismissed");
  const cards = RISK_KINDS.flatMap((k) => areas.filter((a) => kinds.get(a.id) === k && k !== "none")).map((a) => areaCard(a, kinds.get(a.id)!, areaReasons(a, r.briefing.check), live.filter((f) => a.paths.has(f.path)), l));
  return `<section class="vis" id="risk"><h2>Risk map</h2><div class="scroll">${svg}</div><div class="legend">${legend}${hot}</div>${cards.length > 0 ? `<div class="rcards">${cards.join("")}</div>` : ""}</section>`;
}

// ---- 5. the question status grid ----

export interface QuestionTile {
  id: string;
  type: string;
  item: string;
  text: string;
  status: string;
}

/** Why a status has its colour, for the legend. */
const STATUS_ORDER = ["answered", "partially answered", "needs author", "unanswered"] as const;

/** N1 first, then the other questions grouped by the change they are about, in the order the questions were asked. */
export function questionGroups(qs: readonly QuestionTile[]): { n1: QuestionTile[]; groups: Array<{ item: string; tiles: QuestionTile[] }> } {
  const n1 = qs.filter((q) => q.id === NECESSITY_ID);
  const groups: Array<{ item: string; tiles: QuestionTile[] }> = [];
  for (const q of qs.filter((x) => x.id !== NECESSITY_ID)) {
    const g = groups.find((x) => x.item === q.item);
    if (g === undefined) groups.push({ item: q.item, tiles: [q] });
    else g.tiles.push(q);
  }
  return { n1, groups };
}

function questionsSection(i: HtmlInput, l: VisualLinks): string {
  const r = i.report;
  const qa = i.qa;
  const head = `<section class="vis" id="questions"><h2>Questions</h2>`;
  if (qa === undefined) return `${head}${tile("grey", "pending", "the Questions and Answers stages follow the report")}</section>`;
  if (qa.roundsSkipped !== undefined) return `${head}${tile("grey", "skipped by the operator&#39;s choice", qa.roundsSkipped.note)}</section>`;
  const tiles: QuestionTile[] = qa.questions.map((q) => ({ id: q.id, type: q.type, item: q.item, text: q.text, status: q.answer?.status ?? "unanswered" }));
  const { n1, groups } = questionGroups(tiles);
  const one = (q: QuestionTile): string => tile(STATUS_TONE[q.status] ?? "grey", `<strong>${esc(q.id)}</strong><small>${esc(TYPE_ABBREVIATIONS[q.type] ?? q.type.slice(0, 5).toUpperCase())}</small>`, `${q.id} [${q.type}] ${q.status}: ${clip(q.text, 200)}`, appendixAt(l, `q-${q.id}`), " q");
  const itemText = new Map<string, string>([
    ...r.briefing.whatsNew.map((w, n) => [`W${n + 1}`, w.text] as const),
    ...r.sections.flatMap((s) => s.items).map((it) => [it.id, it.text] as const),
  ]);
  const count = (s: string): number => tiles.filter((q) => q.status === s).length;
  const legend = STATUS_ORDER.map((s) => `<span class="key"><span class="sw ${STATUS_TONE[s] ?? "grey"}"></span>${esc(s)} ${count(s)}</span>`).join("");
  const body = [
    n1.length > 0 ? `<div class="grp"><span class="chip" title="the necessity question">N1</span><div class="tiles">${n1.map(one).join("")}</div></div>` : "",
    ...groups.map((g) => `<div class="grp"><span class="chip" title="${esc(clip(itemText.get(g.item) ?? "other questions", 200))}">${esc(g.item === "" ? "other" : g.item)}</span><div class="tiles">${g.tiles.map(one).join("")}</div></div>`),
  ].join("");
  return `${head}${body}<div class="legend">${legend}</div></section>`;
}

// ---- 6. the review layer ----

/** What a live finding is for the grid: disputed by its verifier, unproven (a behavioral finding no test proves), or confirmed. */
export type FindingTone = "confirmed" | "disputed" | "unproven";

const FINDING_TONE: Record<FindingTone, Tone> = { confirmed: "bad", disputed: "warn", unproven: "grey" };
const FINDING_ORDER: readonly FindingTone[] = ["confirmed", "disputed", "unproven"];

/** A finding's tone: disputed when its verifier did not settle it, else unproven when no test proves it, else confirmed. */
export const findingTone = (f: Pick<Finding, "state" | "kind"> & { proof?: Finding["proof"] }): FindingTone => (f.state === "disputed" ? "disputed" : proofOf(f).state === "unproven" ? "unproven" : "confirmed");

/**
 * The findings that stand (not the dismissed ones) as a grid of aspect by severity: each cell a tile with the count, the
 * colour of its most serious tone (confirmed, then disputed, then unproven), a tooltip of its findings in one line each,
 * and a link to the first of them in the appendix.
 */
function reviewSection(d: Draft | undefined, l: VisualLinks): string {
  if (d === undefined) return "";
  const live = d.review.findings.filter((f) => f.state !== "dismissed");
  const aspects = d.review.aspects.map((a) => a.aspect);
  const cell = (aspect: string, severity: string): string => {
    const here = live.filter((f) => f.aspect === aspect && f.severity === severity);
    if (here.length === 0) return tile("grey", "0", `no ${severity} finding of ${aspect}`, undefined, " cell empty");
    const worst = FINDING_ORDER.find((t) => here.some((f) => findingTone(f) === t))!;
    const tip = here.map((f) => `${f.id} ${findingTone(f)}${f.principle !== undefined ? ` (breaks principle ${f.principle})` : ""}: ${clip(f.content, 140)} (${f.path}:${f.startLine})`).join("\n");
    return tile(FINDING_TONE[worst], `<strong>${here.length}</strong>`, `${severity} ${aspect}\n${tip}`, appendixAt(l, `f-${here[0]!.id}`), " cell");
  };
  const head = `<span class="fh"></span>${SEVERITIES.map((s) => `<span class="fh">${esc(s)}</span>`).join("")}`;
  const rows = aspects.map((a) => `<span class="fh">${esc(a)}</span>${SEVERITIES.map((s) => cell(a, s)).join("")}`).join("");
  const count = (t: FindingTone): number => live.filter((f) => findingTone(f) === t).length;
  const legend = FINDING_ORDER.map((t) => `<span class="key"><span class="sw ${FINDING_TONE[t]}"></span>${t} ${count(t)}</span>`).join("");
  const verdict = tile(d.recommended === "request-changes" ? "bad" : d.recommended === "comment" ? "warn" : "ok", `<small>recommended</small><strong>${esc(d.recommended)}</strong>`, `the draft's verdict; the posted review's own verdict is its first line`, undefined, " stat");
  return `<section class="vis" id="review"><h2>Review</h2><div class="row">${verdict}<div class="fgrid">${head}${rows}</div></div><div class="legend">${legend}</div></section>`;
}

// ---- the page ----

/** The sections of `review.html` after the header strip, in order: verdict and scope, data flow, risk map, questions and, when the review layer ran, the review. */
export function visualSections(i: HtmlInput, l: VisualLinks): string[] {
  return [verdictSection(i, l), flowsSection(i.report, l), riskSection(i.report, l, i.review), questionsSection(i, l), reviewSection(i.review, l)].filter((x) => x !== "");
}

export const VISUAL_CSS = `
.chg{border:1px solid var(--line);border-radius:8px;padding:8px 12px 10px;margin:10px 0;background:#fcfdfe}.ch{font-weight:600}.ct{font-size:15px}.co{margin:4px 0 6px;font-size:14px}
.chips{display:flex;flex-wrap:wrap;gap:4px 6px;margin:6px 0}.corechip{display:inline-block;border:1px solid #b0c4d8;background:#eef4fa;border-radius:4px;padding:0 6px;font-size:12px}.corechip.sm{background:var(--greybg);border-color:var(--line)}
details.also,details.code{margin:4px 0}details.also>summary,details.code>summary{cursor:pointer;color:var(--muted);font-size:12px}
.ex{margin:6px 0}.exh{font-size:12px}.ex pre{margin:2px 0;font-size:12px;line-height:1.35;white-space:pre}.ex .l{display:block}.ex .l.add{background:#e6f4ec}.ex .l.del{background:#fbe4e2}
.vh h1 a{color:inherit;text-decoration:none}.vh h1 .title{white-space:nowrap}
section.vis{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:12px 0;padding:10px 14px 14px}
section.vis>h2{display:block;margin:0 0 8px}section.vis h3{display:block;margin:10px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.tiles{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch}.row{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start}.col{flex:1;min-width:240px}
.tile{display:inline-flex;flex-direction:column;justify-content:center;border:1px solid var(--line);border-radius:6px;padding:4px 10px;min-width:44px;text-align:center;text-decoration:none;color:var(--ink);background:var(--greybg);font-size:13px}
.tile small{font-size:10px;letter-spacing:.04em;opacity:.8}.tile strong{font-size:14px}
.tile.ok{background:var(--okbg);border-color:var(--ok)}.tile.warn{background:var(--warnbg);border-color:var(--warn)}.tile.bad{background:var(--badbg);border-color:var(--bad)}.tile.grey{background:var(--greybg);border-color:#90a4ae}
.tile.big{padding:14px 28px;min-width:200px}.tile.big strong{font-size:26px;text-transform:uppercase}.tile.sm{padding:2px 8px;font-size:12px;font-weight:600}.tile.stat strong{font-size:20px}
.tile.q{min-width:56px}.grp{display:flex;gap:8px;align-items:flex-start;margin:6px 0}.chip{display:inline-block;min-width:44px;text-align:center;background:#e3ecf5;color:#1f4f82;border-radius:4px;padding:4px 6px;font-weight:700;font-size:13px}
.flow{margin:8px 0 14px}.flow .cap{font-weight:600;margin:0 0 4px}
.fgrid{display:grid;grid-template-columns:repeat(5,auto);gap:4px 6px;align-items:center}.fh{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:center}.tile.cell{min-width:56px}.tile.empty{opacity:.45}
.legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font-size:12px;color:var(--muted)}.key{display:inline-flex;align-items:center;gap:5px}
.sw{display:inline-block;width:12px;height:12px;border-radius:2px;border:1px solid #b0bec5}.sw.ok{background:var(--okbg);border-color:var(--ok)}.sw.warn{background:var(--warnbg);border-color:var(--warn)}.sw.bad{background:var(--badbg);border-color:var(--bad)}.sw.grey{background:var(--greybg)}.sw.dot{background:#1d2733;border-radius:50%}
.rcards{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin-top:10px}
.rcard{border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px;background:var(--greybg)}.rcard:target{outline:3px solid #1f4f82;outline-offset:1px;background:#fff}
.rh{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.aid{font-weight:700}.rl{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rb,.rk{display:inline-block;border-radius:3px;padding:0 5px;font-size:10px;font-weight:600;color:#1d2733;white-space:nowrap}
.rb.risk,.rk.risk{background:#e8847b}.rb.compatibility,.rk.compatibility{background:#f0a35e}.rb.behavior,.rk.behavior{background:#f2d16b}.rb.surface,.rk.surface{background:#7fb2e0}
.rlines{margin:4px 0 0}.re{margin:3px 0}.rcard .cites{font-size:11px}
.fchips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}.fchip{font-size:11px;font-weight:600;border-radius:3px;padding:0 5px;text-decoration:none;color:var(--ink);border:1px solid #90a4ae;background:var(--greybg)}
.fchip.confirmed{background:var(--badbg);border-color:var(--bad)}.fchip.disputed{background:var(--warnbg);border-color:var(--warn)}
`;
