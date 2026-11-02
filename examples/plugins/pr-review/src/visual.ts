// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The visual-only `review.html` (design §6.11): the report as diagrams and visual elements, nothing else. The sections
 * are the verdict and scope tiles, the data-flow diagrams, the risk map (a treemap of the areas), the question status
 * grid and, when the review layer ran, the findings grid. Every visible text is a short label, a number or a badge;
 * anything longer is a tooltip (an SVG `<title>`, an HTML `title` attribute) and is in the appendix, which stays the
 * full detail. Plugin code only, deterministic, no script: every text goes through `esc`.
 */
import { CHECK_LISTS, type CheckList } from "./briefing.js";
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
  const n1 = tile(
    conclusion === undefined ? "grey" : (CONCLUSION_TONE[conclusion] ?? "grey"),
    `<small>${NECESSITY_ID}: is it necessary?</small><strong>${esc(conclusion ?? "pending")}</strong>`,
    n?.final.necessity !== undefined ? clip(n.final.necessity.rationale, 240) : "N1 is answered after the report",
    appendixAt(l, `q-${NECESSITY_ID}`),
    " big",
  );
  const grid =
    n === undefined
      ? tile("grey", "pending", "the principles are judged with N1")
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

function flowsSection(r: ReportDoc): string {
  const fs = r.briefing.features;
  const figures = fs.map((f, k) => {
    const d: DrawnDiagram | undefined = r.diagrams?.features[f.id];
    const svg = d?.via === "diagram-design" ? d.svg : featureSvg(f, `fl${k + 1}`);
    // The only caption is the name; the summary, and the reason a drawing is the plugin's own, are in the tooltip (and in the appendix).
    const tip = d?.via === "plugin" ? `${f.summary} (${d.note})` : f.summary;
    return `<div class="flow" id="${esc(f.id)}"><div class="cap" title="${esc(tip)}"><span class="rid">${esc(f.id)}</span> ${esc(clip(f.name, 80))}</div><div class="scroll">${svg}</div></div>`;
  });
  return `<section class="vis" id="flows"><h2>Data flow</h2>${figures.length === 0 ? tile("grey", "no new feature", "the report names no new feature with a data path") : figures.join("")}</section>`;
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

const MAP_W = 960;
const MAP_H = 400;
const CHAR_W = 6.4;

function riskSection(r: ReportDoc): string {
  const areas = riskAreas(r);
  if (areas.length === 0) return `<section class="vis" id="risk"><h2>Risk map</h2>${tile("grey", "no changed lines", "no area has changed lines")}</section>`;
  const rects = squarify(areas.map((a) => ({ id: a.id, value: a.lines })), 0, 0, MAP_W, MAP_H);
  const byId = new Map(areas.map((a) => [a.id, a] as const));
  const cells: string[] = [];
  const counts = new Map<RiskKind, number>();
  const where = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const rect of rects) {
    const area = byId.get(rect.id)!;
    where.set(area.id, rect);
    const { kind, entries } = areaRisk(area, r.briefing.check);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const room = Math.floor((rect.w - 10) / CHAR_W);
    const full = `${area.id} ${area.label}`;
    const text = rect.h < 18 || room < area.id.length ? "" : full.length <= room ? full : room >= area.id.length + 4 ? clip(full, room) : area.id;
    const tip = [`${area.id} ${area.label} (${area.lines} lines changed)`, ...(entries.length === 0 ? [RISK_NAMES.none] : entries)].join("\n");
    cells.push(
      `<g><title>${esc(tip)}</title><rect x="${rect.x.toFixed(1)}" y="${rect.y.toFixed(1)}" width="${rect.w.toFixed(1)}" height="${rect.h.toFixed(1)}" fill="${RISK_FILL[kind]}" stroke="#ffffff" stroke-width="2"/>`,
      text === "" ? "" : `<text x="${(rect.x + 6).toFixed(1)}" y="${(rect.y + 15).toFixed(1)}" font-size="11" font-weight="600" fill="#1d2733">${esc(text)}</text>`,
      `</g>`,
    );
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
  return `<section class="vis" id="risk"><h2>Risk map</h2><div class="scroll">${svg}</div><div class="legend">${legend}${hot}</div></section>`;
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
export const findingTone = (f: Pick<Finding, "state" | "kind">): FindingTone => (f.state === "disputed" ? "disputed" : proofOf(f).state === "unproven" ? "unproven" : "confirmed");

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
    const tip = here.map((f) => `${f.id} ${findingTone(f)}: ${clip(f.content, 140)} (${f.path}:${f.startLine})`).join("\n");
    return tile(FINDING_TONE[worst], `<strong>${here.length}</strong>`, `${severity} ${aspect}\n${tip}`, appendixAt(l, `f-${here[0]!.id}`), " cell");
  };
  const head = `<span class="fh"></span>${SEVERITIES.map((s) => `<span class="fh">${esc(s)}</span>`).join("")}`;
  const rows = aspects.map((a) => `<span class="fh">${esc(a)}</span>${SEVERITIES.map((s) => cell(a, s)).join("")}`).join("");
  const count = (t: FindingTone): number => live.filter((f) => findingTone(f) === t).length;
  const legend = FINDING_ORDER.map((t) => `<span class="key"><span class="sw ${FINDING_TONE[t]}"></span>${t} ${count(t)}</span>`).join("");
  const verdict = tile(d.recommended === "request-changes" ? "bad" : d.recommended === "comment" ? "warn" : "ok", `<small>recommended</small><strong>${esc(d.recommended)}</strong>`, `the draft's verdict; the maintainer posts it`, undefined, " stat");
  return `<section class="vis" id="review"><h2>Review</h2><div class="row">${verdict}<div class="fgrid">${head}${rows}</div></div><div class="legend">${legend}</div></section>`;
}

// ---- the page ----

/** The sections of `review.html` after the header strip, in order: verdict and scope, data flow, risk map, questions and, when the review layer ran, the review. */
export function visualSections(i: HtmlInput, l: VisualLinks): string[] {
  return [verdictSection(i, l), flowsSection(i.report), riskSection(i.report), questionsSection(i, l), reviewSection(i.review, l)].filter((x) => x !== "");
}

export const VISUAL_CSS = `
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
`;
