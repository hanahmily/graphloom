// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The visual-only review.html (design §6.11): the treemap of the risk map, the colour of an area, the scope bar, the
 * question grid and its links, and the page rendered from a large-mode run.
 */
import { describe, expect, it } from "vitest";
import { htmlPagesFrom, htmlProblems, parseReportDoc, renderReviewHtml, type ReportDoc } from "../src/html.js";
import { LARGE_LIMITS, REHEARSAL_HEAD, REHEARSAL_MERGE_BASE } from "../src/rehearsal.js";
import { recordedAppendix, recordedHtml } from "../src/parts.js";
import { squarify } from "../src/treemap.js";
import { areaRisk, checkCounts, questionGroups, riskAreas, scopeBarSvg, TYPE_ABBREVIATIONS, type QuestionTile } from "../src/visual.js";
import { simulate } from "./support.js";

const GITHUB = { owner: "apache", repo: "skywalking-banyandb", head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE };

describe("the squarified treemap", () => {
  const items = [{ id: "a", value: 60 }, { id: "b", value: 25 }, { id: "c", value: 25 }, { id: "d", value: 10 }, { id: "e", value: 5 }, { id: "f", value: 5 }];
  const rects = squarify(items, 0, 0, 960, 400);
  const overlap = (a: (typeof rects)[number], b: (typeof rects)[number]): number => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  it("is deterministic: the same items give the same rectangles, whatever their order, ties broken by id", () => {
    expect(squarify(items, 0, 0, 960, 400)).toEqual(rects);
    expect(squarify([...items].reverse(), 0, 0, 960, 400)).toEqual(rects);
    const ties = squarify([{ id: "y", value: 1 }, { id: "x", value: 1 }], 0, 0, 10, 10);
    expect(ties.map((r) => r.id)).toEqual(["x", "y"]);
  });

  it("tiles the box exactly: every rectangle inside it, none overlapping another, their areas adding up to the box", () => {
    expect(rects.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-9);
      expect(r.y).toBeGreaterThanOrEqual(-1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(960 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(400 + 1e-6);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
    }
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) expect(overlap(rects[i]!, rects[j]!)).toBeLessThan(1e-6);
    expect(rects.reduce((n, r) => n + r.w * r.h, 0)).toBeCloseTo(960 * 400, 3);
  });

  it("sizes each rectangle in proportion to its value", () => {
    const total = items.reduce((n, i) => n + i.value, 0);
    for (const r of rects) expect((r.w * r.h) / (960 * 400)).toBeCloseTo(items.find((i) => i.id === r.id)!.value / total, 6);
  });

  it("keeps the rectangles close to squares, and draws an item of no size as large as the smallest positive one", () => {
    for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(6);
    const zero = squarify([{ id: "big", value: 9 }, { id: "none", value: 0 }], 0, 0, 100, 100);
    expect(zero.find((r) => r.id === "none")!.w * zero.find((r) => r.id === "none")!.h).toBeCloseTo(100 * 100 / 2, 6);
    expect(squarify([], 0, 0, 10, 10)).toEqual([]);
    expect(squarify([{ id: "only", value: 3 }], 5, 7, 20, 30)).toEqual([{ id: "only", x: 5, y: 7, w: 20, h: 30 }]);
  });
});

describe("the colour of an area on the risk map", () => {
  const cite = (path: string) => [{ path, side: "head" as const, start: 1, end: 2, symbol: "" }];
  const area = { id: "A1", label: "the write path", lines: 10, paths: new Set(["pkg/a.go", "pkg/b.go"]) };
  const check = (over: Partial<ReportDoc["briefing"]["check"]>): ReportDoc["briefing"]["check"] => ({ surfaces: [], behavior: [], compatibility: [], risks: [], tests: [], ...over });

  it("is none when no entry of the check lists cites a file of the area, and the tests list says nothing of risk", () => {
    expect(areaRisk(area, check({})).kind).toBe("none");
    expect(areaRisk(area, check({ risks: [{ text: "elsewhere", cites: cite("pkg/z.go") }] })).kind).toBe("none");
    expect(areaRisk(area, check({ tests: [{ text: "a test", cites: cite("pkg/a.go") }] }))).toEqual({ kind: "none", entries: [] });
  });

  it("takes the most serious kind cited: risk, then compatibility, then changed behavior, then new surface", () => {
    const entry = (text: string, path = "pkg/a.go") => ({ text, cites: cite(path) });
    expect(areaRisk(area, check({ surfaces: [entry("s")] })).kind).toBe("surface");
    expect(areaRisk(area, check({ surfaces: [entry("s")], behavior: [entry("b")] })).kind).toBe("behavior");
    expect(areaRisk(area, check({ surfaces: [entry("s")], behavior: [entry("b")], compatibility: [entry("c")] })).kind).toBe("compatibility");
    const all = areaRisk(area, check({ surfaces: [entry("s")], behavior: [entry("b")], compatibility: [entry("c")], risks: [entry("r", "pkg/b.go")] }));
    expect(all.kind).toBe("risk");
    // The tooltip's entries, most serious first, one line each.
    expect(all.entries).toEqual(["risk: r", "compatibility: c", "changed behavior: b", "new surface: s"]);
  });
});

describe("the scope bar", () => {
  const scope = { production: { files: 3, added: 600, deleted: 40 }, tests: { files: 2, added: 300, deleted: 10 }, docs: { files: 1, added: 90, deleted: 0 }, generated: { files: 1, added: 10, deleted: 5 } };

  it("is one stacked bar of the lines added, split four ways in proportion, with counts as labels, and a thin bar of the lines deleted", () => {
    const svg = scopeBarSvg(scope);
    const widths = [...svg.matchAll(/<rect x="[\d.]+" y="0" width="([\d.]+)" height="30"/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(4);
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(960, 0);
    expect(widths[0]! / 960).toBeCloseTo(0.6, 2);
    expect(widths[1]! / 960).toBeCloseTo(0.3, 2);
    expect(svg).toContain(">Production code +600<");
    expect(svg).toContain(">Tests +300<");
    // The small segments do not fit a label; the legend names every kind with its counts.
    expect(svg).toContain("Generated / other +10 −5");
    expect(svg).toContain("Docs +90 −0");
    expect(svg.match(/height="8"/g)).toHaveLength(3);
    expect(svg).toContain("<title>Production code: 3 files, +600 −40</title>");
  });

  it("says so when no line changed", () => {
    expect(scopeBarSvg({ production: { files: 0, added: 0, deleted: 0 }, tests: { files: 0, added: 0, deleted: 0 }, docs: { files: 0, added: 0, deleted: 0 }, generated: { files: 0, added: 0, deleted: 0 } })).toContain("no changed lines");
  });

  it("counts the checks as passed, failed and pending", () => {
    expect(checkCounts([{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "failure" }, { status: "in_progress", conclusion: null }, { status: "completed", conclusion: "skipped" }])).toEqual({ passed: 2, failed: 1, pending: 1 });
  });
});

describe("the question grid's order and labels", () => {
  const q = (id: string, item: string, type = "purpose", status = "answered"): QuestionTile => ({ id, type, item, text: `${id}?`, status });

  it("puts N1 first, then groups the questions by the change they are about, in the order asked", () => {
    const g = questionGroups([q("Q2", "W2"), q("N1", "", "necessity"), q("Q1", "W1"), q("Q3", "W2", "missing-test"), q("Q4", "W1", "missing-test")]);
    expect(g.n1.map((x) => x.id)).toEqual(["N1"]);
    expect(g.groups.map((x) => [x.item, x.tiles.map((t) => t.id)])).toEqual([["W2", ["Q2", "Q3"]], ["W1", ["Q1", "Q4"]]]);
  });

  it("has a short label for every question type", () => {
    for (const t of ["necessity", "purpose", "existing-reuse-common", "missing-test", "split-function", "complexity-coverage", "weak-test", "other"]) expect(TYPE_ABBREVIATIONS[t]).toMatch(/^[A-Z]{3,5}$/);
  });
});

describe("review.html of a large-mode run", () => {
  const sim = simulate({ scenarioName: "large-pull-request", config: { limits: LARGE_LIMITS }, maxSteps: 250 });
  const written = recordedHtml(sim.evidence, true);
  const appendixWritten = recordedAppendix(sim.evidence, true);
  if (written.state !== "read" || appendixWritten.state !== "read") throw new Error("the pages were not written");
  const html = written.value;
  const appendix = appendixWritten.value;
  const report = parseReportDoc(sim.written!.json)!;
  const qa = JSON.parse(sim.qa!.json) as { questions: Array<{ id: string; type: string; item: string; text: string; answer?: { status: string } }> };

  it("has the four visual sections after the header strip, in order, and passes the inertness check", () => {
    const at = ["<header", "<h2>Verdict and scope</h2>", "<h2>Data flow</h2>", "<h2>Risk map</h2>", "<h2>Questions</h2>"].map((s) => html.indexOf(s));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(htmlProblems(html, GITHUB)).toEqual([]);
    expect(html).not.toMatch(/<(script|link|img|iframe|ul|ol|table|details|pre)\b/);
  });

  it("is deterministic", () => {
    expect(renderReviewHtml({ report })).toBe(renderReviewHtml({ report }));
    expect(htmlPagesFrom(sim.written!.json, sim.qa!.json)!.review).toBe(htmlPagesFrom(sim.written!.json, sim.qa!.json)!.review);
  });

  it("draws one rectangle for each area with changed lines, each sized by its lines and carrying a tooltip with its label", () => {
    const risk = html.slice(html.indexOf("<h2>Risk map</h2>"), html.indexOf("<h2>Questions</h2>"));
    const areas = riskAreas(report);
    expect(areas.length).toBeGreaterThanOrEqual(3);
    const cells = [...risk.matchAll(/<g><title>([^<]*)<\/title><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)];
    expect(cells).toHaveLength(areas.length);
    const total = areas.reduce((n, a) => n + a.lines, 0);
    for (const a of areas) {
      const cell = cells.find((c) => c[1]!.startsWith(`${a.id} `))!;
      expect(cell[1]).toContain(`(${a.lines} lines changed)`);
      expect((Number(cell[4]) * Number(cell[5])) / (960 * 400)).toBeCloseTo(a.lines / total, 2);
    }
    // The legend names the five colours with counts.
    for (const name of ["risk", "compatibility", "changed behavior", "new surface", "nothing to check"]) expect(risk).toContain(`</span>${name} `);
    expect(risk).toContain("hotspot function");
  });

  it("puts the hotspot functions as at most five dots, each with a tooltip", () => {
    const dots = [...html.matchAll(/<g><title>([^<]*)<\/title><circle /g)];
    expect(dots.length).toBeGreaterThan(0);
    expect(dots.length).toBeLessThanOrEqual(5);
    for (const d of dots) expect(d[1]).toMatch(/CRAP .*complexity .*— .+:\d+$/);
  });

  it("shows N1 and every question as a tile that links to its anchor in the appendix, grouped by high-level change", () => {
    const grid = html.slice(html.indexOf("<h2>Questions</h2>"));
    const tiles = [...grid.matchAll(/<a class="tile (ok|warn|bad|grey) (?:big|q)" href="review-appendix.html#q-([A-Za-z0-9]+)" title="([^"]*)">/g)];
    expect(tiles).toHaveLength(qa.questions.length);
    // N1 first; then the questions of W1, then W2.
    expect(tiles[0]![2]).toBe("N1");
    const chips = [...grid.matchAll(/<span class="chip" title="[^"]*">([A-Za-z0-9]+)<\/span>/g)].map((m) => m[1]);
    expect(chips).toEqual(["N1", "W1", "W2"]);
    // Every link has its target in the appendix.
    for (const t of tiles) expect(appendix).toMatch(new RegExp(`<details id="q-${t[2]}"`));
    // Colour is the answer's status.
    for (const x of qa.questions.filter((y) => y.id !== "N1")) {
      const tone = { answered: "ok", "partially answered": "warn", "needs author": "bad" }[x.answer?.status ?? ""] ?? "grey";
      expect(html).toContain(`<a class="tile ${tone} q" href="review-appendix.html#q-${x.id}"`);
    }
    // The legend counts each status.
    for (const status of ["answered", "partially answered", "needs author", "unanswered"]) {
      const n = qa.questions.filter((x) => (x.answer?.status ?? "unanswered") === status).length;
      expect(grid).toContain(`</span>${status} ${n}</span>`);
    }
  });

  it("carries the question in one line in each tile's tooltip, and the change's text in its chip's", () => {
    const first = qa.questions.find((x) => x.item === "W1")!;
    expect(html).toContain(`title="${first.id} [${first.type}] ${first.answer!.status}: `);
    const w1 = report.briefing.whatsNew[0]!.text;
    expect(html).toContain(`<span class="chip" title="${w1.replace(/&/g, "&amp;")}">W1</span>`);
  });

  it("asks at most 16 questions: N1 and three for each of at most five high-level changes", () => {
    expect(qa.questions.length).toBeLessThanOrEqual(16);
    expect(qa.questions.length).toBe(1 + 3 * report.briefing.whatsNew.length);
  });
});
