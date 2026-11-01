// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { appendixHtmlFrom, htmlProblems, parseQaDoc, parseReportDoc, renderAppendixHtml, renderReviewHtml, reviewHtmlFrom, type QaDoc, type ReportDoc } from "../src/html.js";
import { stateDiagramSvg } from "../src/htmlsvg.js";
import { LARGE_LIMITS, REHEARSAL_HEAD, REHEARSAL_MERGE_BASE } from "../src/rehearsal.js";
import { recordedAppendix, recordedHtml, recordedNecessityJson, recordedQa, recordedReport } from "../src/parts.js";
import type { StateEntry } from "../src/report.js";
import { simulate, type Simulation } from "./support.js";

const GITHUB = { owner: "apache", repo: "skywalking-banyandb", head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE };
const htmlOf = (sim: Simulation): string => {
  const h = recordedHtml(sim.evidence, true);
  if (h.state !== "read") throw new Error("no review.html was written whole");
  return h.value;
};
const appendixOf = (sim: Simulation): string => {
  const h = recordedAppendix(sim.evidence, true);
  if (h.state !== "read") throw new Error("no review-appendix.html was written whole");
  return h.value;
};
/** The sections of the briefing, in the order the design gives, and the only ones review.html has. */
const BRIEFING = ["<h2>Briefing</h2>", "<h2>Data flow per new feature</h2>", "<h2>What you need to check</h2>", "<h2>Hotspots</h2>", "<h2>Areas</h2>", "<h2>Open questions</h2>"];
const APPENDIX = ["<h2>Summary</h2>", "<h2>Necessity</h2>", "<h2>Change map</h2>", "<h2>Change items</h2>", "<h2>Measurements</h2>", "<h2>Q&amp;A</h2>", "<h2>Removed by the claim check, and notes</h2>"];
const inOrder = (html: string, parts: string[]): boolean => parts.every((p, i) => html.includes(p) && (i === 0 || html.indexOf(p) > html.indexOf(parts[i - 1]!)));
const headings = (html: string): string[] => [...html.matchAll(/<h2>.*?<\/h2>/g)].map((m) => m[0]);

describe("review.html, the briefing of a standard report (design 6.1, 6.11)", () => {
  const sim = simulate({ scenarioName: "feature-data-flow" });
  const html = htmlOf(sim);
  const appendix = appendixOf(sim);

  it("is written at the Report stage with the verdict and the open questions pending, and whole at the Answers stage, beside review.md and the appendix", () => {
    expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
    const early = recordedHtml(sim.evidence, false);
    expect(early.state).toBe("read");
    expect((early as { value: string }).value).toContain('<h2>Open questions</h2> <span class="badge grey">pending</span>');
    expect((early as { value: string }).value).toContain('<span class="label">N1: is it necessary?</span> <span class="badge grey">pending</span>');
    expect(html).not.toContain("pending</span>");
    expect(sim.jobs.map((j) => j.instruction)).toEqual(expect.arrayContaining(["Write .graphloom/review/review.html", "Write .graphloom/review/review-appendix.html"]));
  });

  it("has the six sections of the briefing in the approved order, and nothing else", () => {
    expect(inOrder(html, BRIEFING)).toBe(true);
    expect(headings(html)).toEqual(headings(html).filter((h, i, all) => all.indexOf(h) === i));
    expect(headings(html).map((h) => h.replace(/<\/?h2>/g, "").replace(/&amp;/g, "&"))).toEqual(["Briefing", "Data flow per new feature", "What you need to check", "Hotspots", "Areas", "Open questions"]);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("does not hold the change items, the whole measurements table, the module diagram or the full Q&A", () => {
    expect(html).not.toMatch(/<div class="item"/);
    expect(html).not.toContain('<table class="metrics">');
    expect(html).not.toContain("Architecture");
    expect(html).not.toContain("<h2>Change items</h2>");
    expect(html).not.toContain('<details class="qa"');
    expect(html).not.toContain("<h2>Necessity</h2>");
    expect(html).not.toMatch(/<table class="beh">|<div class="state">/);
  });

  it("opens with the pull request, its size and links, then the purpose, what is new, the scope that matters and the verdict", () => {
    const head = html.slice(0, html.indexOf("</header>"));
    expect(head).toContain("apache/skywalking-banyandb#7");
    expect(head).toContain(`href="https://github.com/apache/skywalking-banyandb/commit/${REHEARSAL_HEAD}"`);
    expect(head).toContain("by contributor");
    expect(head).toMatch(/\d+ files · <span class="plus">\+\d+<\/span> <span class="minus">−\d+<\/span> · \d+ commits · GitHub checks: .* · mode: standard · <a href="review-appendix.html">appendix<\/a>/);
    const brief = html.slice(html.indexOf("<h2>Briefing</h2>"), html.indexOf("<h2>Data flow per new feature</h2>"));
    expect(brief).toMatch(/<p class="lead"><strong>Purpose<\/strong> <span class="badge (ok|grey)">(stated|inferred)<\/span>/);
    expect(brief).toMatch(/<h3>What's new<\/h3><ul class="plain new"><li>/);
    expect(brief).toContain("<h3>Scope that matters</h3>");
    for (const row of ["Production code", "Tests", "Docs", "Generated / other", "Total"]) expect(brief).toContain(`<th>${row}</th>`);
    expect(brief).toContain("<h3>Verdict</h3>");
    expect(brief).toMatch(/N1: is it necessary\?<\/span> <span class="badge (ok|warn|bad|grey)">(necessary|questionable|unnecessary|needs author)<\/span>/);
    expect(brief).toContain("Principles touched");
    expect(brief).toContain("Questions that need the author");
  });

  it("draws each feature's data flow as an inline SVG, with its stages and flows cited, and records the flow the claim check did not support in the appendix", () => {
    const flow = html.slice(html.indexOf("<h2>Data flow per new feature</h2>"), html.indexOf("<h2>What you need to check</h2>"));
    expect(flow).toContain("<svg");
    expect(flow).toContain('<span class="rid">F1</span> Nightly retention sweep');
    for (const label of ["retention_days flag", "Group retention_days", "Nightly sweep", "robfig/cron scheduler"]) expect(flow).toContain(label);
    expect(flow).toContain("Data flow: Nightly retention sweep");
    expect(flow).toContain("Stages and flows, with their cites");
    const removed = appendix.slice(appendix.indexOf("<h2>Removed by the claim check"));
    expect(removed).toContain("<strong>F1.f2</strong>");
    expect(removed).toContain("schedules the nightly sweep");
  });

  it("lists what to check in five lists, with cites, and the hotspots, areas and open questions after", () => {
    const check = html.slice(html.indexOf("<h2>What you need to check</h2>"), html.indexOf("<h2>Hotspots</h2>"));
    expect((check.match(/<h4>/g) ?? []).length).toBe(5);
    for (const title of ["New surfaces", "Changed behavior of existing code paths", "Compatibility", "Risks", "Tests added"]) expect(check).toContain(title);
    expect(check).toContain('class="cites"');
    const areas = html.slice(html.indexOf("<h2>Areas</h2>"), html.indexOf("<h2>Open questions</h2>"));
    expect(areas).toMatch(/<li>[^<]+: \d+ items?<\/li>/);
    expect(areas).toContain("graphloom session open &lt;run&gt; --stage report");
    const open = html.slice(html.indexOf("<h2>Open questions</h2>"));
    expect(open).toMatch(/\d+ answered — see the appendix\./);
  });

  it("links to the appendix at the bottom, and only to GitHub at the pinned head and base or to the other file, and passes the inertness check", () => {
    expect(htmlProblems(html, GITHUB)).toEqual([]);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\ssrc=|\sonclick=/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs.every((h) => h.startsWith("https://github.com/apache/skywalking-banyandb/") || /^review-appendix\.html(#[\w.:-]+)?$/.test(h))).toBe(true);
    expect(html.trimEnd().endsWith('<p class="foot"><a href="review-appendix.html">Appendix: every change item, the full measurements, the claim check\'s removals, and the whole Q&amp;A</a></p>\n</main></body></html>')).toBe(true);
    expect(hrefs.some((h) => h.includes(`/blob/${REHEARSAL_HEAD}/banyand/cmd/server/flags.go#L`))).toBe(true);
  });

  it("is of a reasonable size: inline SVG, no embedded images", () => {
    expect(html.length).toBeLessThan(150_000);
    expect(html).not.toMatch(/base64|data:/);
  });

  it("writes review.md with the briefing first and the appendix under its own heading, complete", () => {
    const md = recordedQa(sim.evidence);
    expect(md.state).toBe("read");
    const text = (md as { value: { markdown: string } }).value.markdown;
    const order = ["# Briefing", "## What's new", "## Scope that matters", "## Necessity and principles", "## Data flow per new feature", "## What you need to check", "## Hotspots", "## Areas", "## Open questions", "# Appendix", "## Necessity", "## Report", "## Measurements", "## Q&A"];
    order.forEach((h, i) => {
      expect(text, h).toContain(`\n${h}\n`);
      if (i > 0) expect(text.indexOf(`\n${h}\n`), h).toBeGreaterThan(text.indexOf(`\n${order[i - 1]}\n`));
    });
    expect(text).not.toContain("```mermaid");
    expect(text).toContain("### F1. Nightly retention sweep");
    expect(text).toContain("### R1.");
    expect(text).toContain("`F1.f2`");
    expect(text).toContain("answered — see the appendix.");
  });
});

describe("review-appendix.html (design 6.11)", () => {
  const sim = simulate({ scenarioName: "feature-data-flow" });
  const html = appendixOf(sim);

  it("has every section the briefing leaves out, in order", () => {
    expect(inOrder(html, APPENDIX)).toBe(true);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("holds all the change items with their citations, and the change map per report section", () => {
    const map = html.slice(html.indexOf("<h2>Change map</h2>"), html.indexOf("<h2>Change items</h2>"));
    expect(map).toContain("Lines added and deleted per report section");
    expect(map).toContain("<svg");
    const items = html.slice(html.indexOf("<h2>Change items</h2>"), html.indexOf("<h2>Measurements</h2>"));
    expect(items).toMatch(/<div class="item" id="R\d+">/);
    expect(items).toContain('class="cites"');
  });

  it("holds the whole Q&A, collapsed by default, each question with an id the briefing links to", () => {
    const qa = html.slice(html.indexOf("<h2>Q&amp;A</h2>"));
    expect(qa).toMatch(/<details id="q-[^"]+"( open)? class="qa">/);
  });

  it("is linked from the briefing and links back, and is inert and self-contained", () => {
    expect(html).toContain('<a href="review.html">briefing</a>');
    expect(html).toContain('<a href="review.html">Back to the briefing</a>');
    expect(htmlProblems(html, GITHUB)).toEqual([]);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\ssrc=|\sonclick=/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.every((h) => h.startsWith("https://github.com/apache/skywalking-banyandb/") || h === "review.html")).toBe(true);
  });

  it("is written at the Report stage with the Necessity and the Q&A pending", () => {
    const early = recordedAppendix(sim.evidence, false);
    expect(early.state).toBe("read");
    expect((early as { value: string }).value).toContain('<h2>Q&amp;A</h2> <span class="badge grey">pending</span>');
    expect((early as { value: string }).value).toContain('<h2>Necessity</h2> <span class="badge grey">pending</span>');
  });
});

describe("review.html of a large report", () => {
  const sim = simulate({ scenarioName: "large-pull-request", config: { limits: LARGE_LIMITS }, maxSteps: 250 });
  const html = htmlOf(sim);
  const appendix = appendixOf(sim);

  it("has the same six sections, the mode in the header, and the areas with the reporter's label, files and lines, and the dive-in command", () => {
    expect(headings(html)).toHaveLength(6);
    expect(inOrder(html, BRIEFING)).toBe(true);
    expect(html).toContain("mode: large: ");
    const areas = html.slice(html.indexOf("<h2>Areas</h2>"), html.indexOf("<h2>Open questions</h2>"));
    expect(areas).toContain("<th>What it is</th>");
    expect(areas).toMatch(/<td>A2<\/td><td>changes under pkg\/alpha<\/td><td>1<\/td><td>\+\d+ −0<\/td>/);
    expect(areas).toContain("<td>generated code (generated)</td>");
    expect(areas).toContain("graphloom session open &lt;run&gt; --stage report");
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });

  it("draws the feature's data flow", () => {
    const flow = html.slice(html.indexOf("<h2>Data flow per new feature</h2>"), html.indexOf("<h2>What you need to check</h2>"));
    expect(flow).toContain("pkg/alpha rules");
    expect(flow).toContain("pkg/beta applier");
    expect(flow).toContain("applies Alpha1");
  });

  it("shows the change map per area in the appendix", () => {
    const map = appendix.slice(appendix.indexOf("<h2>Change map</h2>"), appendix.indexOf("<h2>Change items</h2>"));
    expect(map).toContain("Lines added and deleted per area");
    expect(map).toMatch(/A1 /);
    expect(htmlProblems(appendix, GITHUB)).toEqual([]);
  });
});

describe("review.html when N1 stops the questions, and when a question needs the author", () => {
  it("shows N1's three parts, the principles badges and the checker's judgment", () => {
    const sim = simulate({ scenarioName: "necessity-principle-broken" });
    const html = appendixOf(sim);
    const necessity = html.slice(html.indexOf("<h2>Necessity</h2>"), html.indexOf("<h2>Change map</h2>"));
    expect(necessity).toContain("1. Is the problem real on the base?");
    expect(necessity).toContain("2. Does the fix fit the system's design?");
    expect(necessity).toContain("3. Is there a simpler or existing way?");
    expect(necessity).toContain("Design principles");
    expect(necessity).toContain('<span class="badge bad">breaks</span>');
    expect(necessity).toContain("offline-idempotent");
    expect(necessity).toContain("checker:");
    expect(necessity).toMatch(/<ol class="trace">/);
    expect(necessity).toContain('<span class="badge warn">questionable</span>');
    expect(recordedNecessityJson(sim.evidence).state).toBe("read");
    // The briefing shows the verdict: N1 questionable, the broken principle, and N1 among the open questions.
    const brief = htmlOf(sim);
    const verdict = brief.slice(brief.indexOf("<h3>Verdict</h3>"), brief.indexOf("<h2>Data flow per new feature</h2>"));
    expect(verdict).toContain('<span class="badge warn">questionable</span>');
    expect(verdict).toContain('<span class="badge bad">offline-idempotent: breaks</span>');
    const open = brief.slice(brief.indexOf("<h2>Open questions</h2>"));
    expect(open).toContain('<a href="review-appendix.html#q-N1"><strong>N1</strong></a>');
    // The link has a target: the appendix's Necessity section carries the id.
    expect(html).toMatch(/<details id="q-N1"[^>]*><summary><h2>Necessity<\/h2>/);
  });

  it("opens a question that needs the author and collapses the others", () => {
    const sim = simulate({ scenarioName: "needs-author-purpose" });
    const html = appendixOf(sim);
    const qa = html.slice(html.indexOf("<h2>Q&amp;A</h2>"));
    expect(qa).toMatch(/<details id="q-[^"]+" open class="qa"><summary>[^]*?needs author<\/span>/);
    const brief = htmlOf(sim);
    expect(brief.slice(brief.indexOf("<h2>Open questions</h2>"))).toMatch(/<span class="badge bad">needs author<\/span>/);
  });

  it("collapses answered and partially answered questions, with a badge each, and opens only those that need the author", () => {
    const answer = (status: string) => ({ answer: `an answer (${status})`, status, check: { verdict: "supported", note: "", searches: [] } });
    const qa: QaDoc = {
      questions: [
        { id: "Q1", type: "purpose", item: "R1", text: "why?", origin: "required", answer: answer("answered") },
        { id: "Q2", type: "missing-test", item: "R1", text: "tests?", origin: "required", answer: answer("partially answered") },
        { id: "Q3", type: "split-function", item: "R1", text: "split?", origin: "required", answer: answer("needs author") },
      ],
    };
    const html = renderAppendixHtml({ report: report(), qa });
    const body = html.slice(html.indexOf("<h2>Q&amp;A</h2>"));
    expect(body.match(/<details id="q-Q\d" open class="qa">/g)).toHaveLength(1);
    expect(body.match(/<details id="q-Q\d" class="qa">/g)).toHaveLength(2);
    for (const [cls, text] of [["ok", "answered"], ["warn", "partially answered"], ["bad", "needs author"]]) expect(body).toContain(`<span class="badge ${cls}">${text}</span>`);
    expect(body).toContain("1 answered, 1 partially answered, 1 needs author");
  });

  it("lists in the briefing only the questions that need a person, counts the answered ones, and counts the ones that need the author", () => {
    const answer = (status: string) => ({ answer: `an answer (${status})`, status, check: { verdict: "supported", note: "", searches: [] } });
    const qa: QaDoc = {
      questions: [
        { id: "Q1", type: "purpose", item: "R1", text: "why?", origin: "required", answer: answer("answered") },
        { id: "Q2", type: "missing-test", item: "R1", text: "tests?", origin: "required", answer: answer("partially answered") },
        { id: "Q3", type: "split-function", item: "R1", text: "split?", origin: "required", answer: answer("needs author") },
        { id: "Q4", type: "common-logic", item: "R1", text: "shared?", origin: "required", answer: answer("answered") },
      ],
    };
    const html = renderReviewHtml({ report: report(), qa });
    const open = html.slice(html.indexOf("<h2>Open questions</h2>"));
    expect(open).toContain("2 of 4");
    expect(open).toContain('href="review-appendix.html#q-Q2"');
    expect(open).toContain('href="review-appendix.html#q-Q3"');
    expect(open).not.toContain("#q-Q1");
    expect(open).not.toContain("#q-Q4");
    expect(open).toContain("2 answered — see the appendix.");
    expect(html).toContain('Questions that need the author</span> <span class="badge bad">1</span>');
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });

  it("names a dependency citation as such and never links it into the reviewed repository", () => {
    const qa: QaDoc = {
      questions: [{ id: "Q1", type: "reuse-library", item: "R1", text: "library?", origin: "required", answer: { answer: "the library has it", status: "answered", citations: [{ path: "/go/pkg/mod/example.com/lib@v1.2.0/parse.go", tree: "dependency", start: 10, end: 12, quote: "func Parse" }, { path: "pkg/a.go", tree: "head", start: 3, end: 3, quote: "x" }], searches: [], check: { verdict: "supported", note: "", searches: [] } } }],
    };
    const body = renderAppendixHtml({ report: report(), qa }).split("<h2>Q&amp;A</h2>")[1]!;
    expect(body).toContain("<code>/go/pkg/mod/example.com/lib@v1.2.0/parse.go:10-12</code> <span class=\"muted\">(dependency)</span>");
    expect(body).not.toMatch(/href="[^"]*go\/pkg\/mod/);
    expect(body).toMatch(/href="https:\/\/github\.com\/apache\/skywalking-banyandb\/blob\/[0-9a-f]+\/pkg\/a\.go#L3"/);
  });

  it("says the remaining questions were skipped when N1 concluded unnecessary", () => {
    const sim = simulate({ scenarioName: "necessity-unnecessary" });
    expect(appendixOf(sim)).toContain("Remaining questions skipped");
    const open = htmlOf(sim).slice(htmlOf(sim).indexOf("<h2>Open questions</h2>"));
    expect(open).toContain('<a href="review-appendix.html#q-N1"><strong>N1</strong></a>');
  });
});

describe("measurements in review.html", () => {
  it("colours cells against the limits and draws the coverage and CRAP bars with the threshold", () => {
    const sim = simulate({ scenarioName: "coverage-measured" });
    const html = appendixOf(sim);
    const m = html.slice(html.indexOf("<h2>Measurements</h2>"), html.indexOf("<h2>Q&amp;A</h2>"));
    expect(m).toContain('class="bad"');
    expect(m).toContain("over the limit of");
    expect(m).toContain('<div class="bar"><div class="fill" style="width:40%"></div></div>');
    expect(m).toMatch(/<svg[^>]*aria-label="CRAP [\d.]+, threshold 30"/);
    expect(m).toContain("the dark mark in the bar");
  });

  it("says in the cell whether an over-the-limit value was inherited, made worse, or introduced", () => {
    const record = (name: string, complexity: number, base: number) => ({
      path: "pkg/a.go", function: name, startLine: 1, endLine: 9, change: "modified", test: false, complexity, decisions: [], nesting: 1, nestingPath: [],
      base: { complexity: base, nesting: 1, startLine: 1, endLine: 9, path: "pkg/a.go" },
    });
    const doc = report({ measurements: { tools: "static", coverage: [], mutation: "not run", records: [record("worse", 14, 12), record("inherited", 12, 12), record("introduced", 12, 5), record("within", 4, 3)] } as never });
    const html = renderAppendixHtml({ report: doc });
    expect(html).toContain("12 → 14 (over the limit of 10 at the base; inherited, made worse)");
    expect(html).toContain("12 → 12 (over the limit of 10 at the base; inherited, not raised)");
    expect(html).toContain("5 → 12 (over the limit of 10: introduced by the pull request)");
    expect(html).toContain('<td class="ok">3 → 4</td>');
  });
});

describe("state diagrams (design 6.11)", () => {
  const entry: StateEntry = {
    name: "stored",
    scope: "per call",
    initial: "0",
    transitions: [
      { when: "an event is stored", effect: "stored += 1", cite: { path: "pkg/a.go", side: "head", start: 3, end: 3, symbol: "" } },
      { when: "the batch is empty", effect: "stays 0", cite: { path: "pkg/a.go", side: "head", start: 5, end: 5, symbol: "" } },
      { when: "the flush fails", effect: "reset to 0", cite: { path: "pkg/a.go", side: "head", start: 7, end: 7, symbol: "" } },
    ],
    reads: [{ where: "after the flush", decision: "replies with the first error when stored is 0", cite: { path: "pkg/a.go", side: "head", start: 9, end: 9, symbol: "" } }],
  };

  it("draws the initial value and one labelled arrow for each of three transitions", () => {
    const svg = stateDiagramSvg(entry, "t1");
    expect((svg.match(/marker-end="url\(#t1-arrow\)"/g) ?? []).length).toBe(4);
    for (const when of ["when an event is stored", "when the batch is empty", "when the flush fails"]) expect(svg).toContain(when);
    for (const effect of ["stored += 1", "stays 0", "reset to 0"]) expect(svg).toContain(effect);
    expect(svg).toContain("starts");
    expect(svg).toContain(">0<");
    expect(svg).not.toContain("<script");
  });

  it("is placed in the item's card with its reads listed under it and the transitions in words", () => {
    const item = { id: "R1", text: "Counts stored events.", cites: [{ path: "pkg/a.go", side: "head" as const, start: 3, end: 9, symbol: "" }], facts: [], state: [entry], behavior: [{ case: "every event fails", before: "success", after: "an error" }] };
    const html = renderAppendixHtml({ report: report({ sections: [{ id: "features", title: "Every feature", none: false, items: [item] }] }) });
    expect(html).toContain('<div class="state"><h5>stored');
    expect(html).toContain('<ul class="plain reads"><li>read after the flush: replies with the first error when stored is 0');
    expect(html).toContain("<th>Case</th><th>Before</th><th>After</th>");
    expect(html).toContain("<td>every event fails</td><td>success</td><td>an error</td>");
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });
});

/** A small report document, for what a rehearsal does not draw. */
function report(over: Partial<ReportDoc> = {}): ReportDoc {
  return {
    pull: { owner: "apache", repo: "skywalking-banyandb", number: 7, head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE, title: "Count stored events", author: "contributor" },
    files: [{ path: "pkg/a.go", status: "modified", additions: 4, deletions: 1 }],
    commits: 1,
    checks: [{ status: "completed", conclusion: "success" }],
    mode: "standard",
    summary: { purpose: { text: "Report a failed batch.", source: "inferred", quote: "" }, overview: "It counts events." },
    sections: [{ id: "features", title: "Every feature", none: true, items: [] }],
    notes: [],
    removed: [],
    removedParts: [],
    briefing: { whatsNew: [{ text: "Counts stored events.", cites: [{ path: "pkg/a.go", side: "head", start: 3, end: 3, symbol: "" }] }], features: [], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] },
    scope: { production: { files: 1, added: 4, deleted: 1 }, tests: { files: 0, added: 0, deleted: 0 }, docs: { files: 0, added: 0, deleted: 0 }, generated: { files: 0, added: 0, deleted: 0 } },
    measurements: { none: "no function was added or modified" },
    ...over,
  };
}

describe("the briefing's counted parts (design 6.1)", () => {
  const record = (name: string, crap: number | undefined, complexity: number, over: Record<string, unknown> = {}) => ({
    path: "pkg/a.go", function: name, startLine: 5, endLine: 20, change: "added", test: false, complexity, decisions: [], nesting: 1, nestingPath: [], ...(crap !== undefined ? { crap } : {}), ...over,
  });

  it("shows the scope as four rows and a total, with plus and minus lines", () => {
    const html = renderReviewHtml({ report: report({ scope: { production: { files: 3, added: 120, deleted: 20 }, tests: { files: 2, added: 80, deleted: 5 }, docs: { files: 1, added: 10, deleted: 0 }, generated: { files: 1, added: 400, deleted: 0 } } }) });
    expect(html).toContain('<tr><th>Production code</th><td>3</td><td class="plus">+120</td><td class="minus">−20</td></tr>');
    expect(html).toContain('<tr><th>Generated / other</th><td>1</td><td class="plus">+400</td><td class="minus">−0</td></tr>');
    expect(html).toContain('<tr class="total"><th>Total</th><td>7</td><td class="plus">+610</td><td class="minus">−25</td></tr>');
  });

  it("lists the five hotspots by CRAP, then complexity, and says base → head where a modified function got worse; the full table is not in the briefing", () => {
    const records = [
      record("small", 2, 2),
      record("a1", 40, 12),
      record("a2", 40, 15),
      record("b", 31, 9, { change: "modified", base: { complexity: 6, nesting: 1, startLine: 1, endLine: 9, path: "pkg/a.go" } }),
      record("c", 12, 20),
      record("d", 8, 4),
      record("e", 5, 4),
      record("testfn", undefined, 30, { test: true }),
    ];
    const html = renderReviewHtml({ report: report({ measurements: { tools: "static", coverage: [], mutation: "not run", records } as never }) });
    const spot = html.slice(html.indexOf("<h2>Hotspots</h2>"), html.indexOf("<h2>Areas</h2>"));
    const names = [...spot.matchAll(/<li>(\w+) — CRAP/g)].map((m) => m[1]);
    expect(names).toEqual(["a2", "a1", "b", "c", "d"]);
    expect(spot).toContain("b — CRAP 31 (upper bound, coverage unknown), complexity 6 → 9, nesting 1 (modified)");
    expect(spot).toContain("a2 — CRAP 40 (upper bound, coverage unknown), complexity 15, nesting 1 (added)");
    expect(spot).not.toContain("testfn");
    expect(html).not.toContain('<table class="metrics">');
    expect(renderAppendixHtml({ report: report({ measurements: { tools: "static", coverage: [], mutation: "not run", records } as never }) })).toContain('<table class="metrics">');
  });

  it("says when nothing is measured", () => {
    expect(renderReviewHtml({ report: report() })).toContain("No function is measured: no function was added or modified.");
  });

  it("shows the sections with their item counts for a report with no areas or a single one, and the areas for one with several", () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `R${i + 1}`, text: "t", cites: [{ path: "pkg/a.go", side: "head" as const, start: 3, end: 3, symbol: "" }], facts: [], state: [], behavior: [] }));
    const sections = [{ id: "features", title: "Every feature", none: false, items: items(2) }, { id: "config", title: "Config", none: false, items: items(1) }, { id: "schema", title: "Schema", none: true, items: [] }];
    const standard = renderReviewHtml({ report: report({ sections }) });
    const areas = standard.slice(standard.indexOf("<h2>Areas</h2>"), standard.indexOf("<h2>Open questions</h2>"));
    expect(areas).toContain("<li>Every feature: 2 items</li>");
    expect(areas).toContain("<li>Config: 1 item</li>");
    expect(areas).not.toContain("Schema");
    const area = (id: string) => ({ id, name: `dir/${id}`, kind: "read" as const, paths: ["pkg/a.go"], additions: 3, deletions: 1 });
    const single = renderReviewHtml({ report: report({ sections, mode: "large", areas: [area("A1")] }) });
    expect(single).toContain("<li>Every feature: 2 items</li>");
    const several = renderReviewHtml({ report: report({ sections, mode: "large", areas: [area("A1"), area("A2")], briefing: { ...report().briefing, areas: [{ id: "A2", label: "the write path" }] } }) });
    expect(several).toContain("<td>A1</td><td>dir/A1</td>");
    expect(several).toContain("<td>A2</td><td>the write path</td><td>1</td><td>+3 −1</td>");
    expect(several).not.toContain("<li>Every feature: 2 items</li>");
  });
});

describe("hostile text (design 12.1)", () => {
  const evil = "<script>alert(1)</script>";
  const hostile = report({
    pull: { owner: "apache", repo: "skywalking-banyandb", number: 7, head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE, title: evil, author: `"><img src=x onerror=alert(1)>` },
    summary: { purpose: { text: evil, source: "stated", quote: evil }, overview: `${evil} & <b>bold</b>` },
    sections: [
      {
        id: "features",
        title: "Every feature",
        none: false,
        items: [
          {
            id: "R1",
            text: evil,
            cites: [{ path: `a/"><script>x</script>.go`, side: "head", start: 1, end: 2, symbol: "" }],
            facts: [evil],
            state: [{ name: evil, scope: evil, initial: evil, transitions: [{ when: evil, effect: evil, cite: { path: "a.go", side: "head", start: 1, end: 1, symbol: "" } }], reads: [] }],
            behavior: [{ case: evil, before: evil, after: evil }],
          },
        ],
      },
    ],
    notes: [evil],
    briefing: {
      whatsNew: [{ text: evil, cites: [{ path: `a/"><script>x</script>.go`, side: "head", start: 1, end: 1, symbol: "" }] }],
      features: [
        {
          id: "F1",
          name: evil,
          summary: evil,
          stages: [
            { id: "a", label: evil, kind: "source", cite: { path: "a.go", side: "head", start: 1, end: 1, symbol: "" } },
            { id: "b", label: "second", kind: "store", cite: { path: "a.go", side: "head", start: 2, end: 2, symbol: "" } },
          ],
          flows: [{ from: "a", to: "b", label: evil, cite: { path: "a.go", side: "head", start: 1, end: 1, symbol: "" } }],
        },
      ],
      check: { surfaces: [{ text: evil, cites: [{ path: "a.go", side: "head", start: 1, end: 1, symbol: "" }] }], behavior: [], compatibility: [], risks: [], tests: [] },
      areas: [{ id: "A1", label: evil }],
    },
  });
  const qa: QaDoc = {
    questions: [
      { id: "Q1", type: "purpose", item: "R1", text: evil, origin: "required", answer: { answer: evil, status: "answered", citations: [{ path: "a.go", tree: "head", start: 1, end: 1, quote: evil }], searches: [], check: { verdict: "supported", note: evil, searches: [] } } },
      { id: "Q2", type: "purpose", item: "R1", text: "second", origin: "required", answer: { answer: `agent says ${evil}`, status: "needs author", check: { verdict: "supported", note: "", searches: [] } } },
    ],
  };

  it("escapes everything a model or the pull request wrote: no script, no injected element, in the title, an item, a state entry and an answer", () => {
    const html = renderReviewHtml({ report: hostile, qa }) + renderAppendixHtml({ report: hostile, qa });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<title>apache/skywalking-banyandb#7: &lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(html).toContain("agent says &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(htmlProblems(renderReviewHtml({ report: hostile, qa }), GITHUB)).toEqual([]);
    expect(htmlProblems(renderAppendixHtml({ report: hostile, qa }), GITHUB)).toEqual([]);
  });

  it("goes through the JSON the files hold: reviewHtmlFrom renders report.json and qa.json texts the same way", () => {
    const json = JSON.stringify({ schema: "pr-change-report-v1", ...hostile });
    const qaJson = JSON.stringify({ schema: "pr-qa-v1", ...qa });
    expect(parseReportDoc(json)).toBeDefined();
    expect(parseQaDoc(qaJson)).toBeDefined();
    expect(parseReportDoc("{}")).toBeUndefined();
    expect(reviewHtmlFrom("not json")).toBeUndefined();
    expect(reviewHtmlFrom(json, qaJson)).toBe(renderReviewHtml({ report: hostile, qa }));
    expect(appendixHtmlFrom(json, qaJson)).toBe(renderAppendixHtml({ report: hostile, qa }));
    expect(appendixHtmlFrom("not json")).toBeUndefined();
  });
});

describe("the inertness check on the written bytes (design 6.11)", () => {
  const ok = renderReviewHtml({ report: report() });
  const wrap = (body: string): string => ok.replace("</main>", `${body}</main>`);
  const bad = (html: string): string[] => htmlProblems(html, GITHUB);

  it("accepts what the renderer writes", () => {
    expect(bad(ok)).toEqual([]);
    expect(bad(wrap('<a href="https://github.com/apache/skywalking-banyandb/pull/7">x</a>'))).toEqual([]);
    expect(bad(wrap(`<a href="https://github.com/apache/skywalking-banyandb/blob/${REHEARSAL_HEAD}/pkg/a.go#L1-L2">x</a>`))).toEqual([]);
    expect(bad(wrap(`<a href="https://github.com/apache/skywalking-banyandb/blob/${REHEARSAL_MERGE_BASE}/pkg/a.go">x</a>`))).toEqual([]);
  });

  it("rejects a script, however it is written", () => {
    expect(bad(wrap("<script>alert(1)</script>")).join()).toMatch(/<script/);
    expect(bad(wrap("<SCRIPT src=x></SCRIPT>")).join()).toMatch(/<script/);
    expect(bad(wrap("< script>1</script>")).length).toBeGreaterThan(0);
  });

  it("rejects an external URL: an image, a stylesheet, a font, a frame, a src, an import, a url() in CSS", () => {
    expect(bad(wrap('<img src="https://evil.example/x.png">')).join()).toMatch(/img/);
    expect(bad(wrap('<link rel="stylesheet" href="https://evil.example/x.css">')).join()).toMatch(/link/);
    expect(bad(wrap('<iframe src="https://evil.example/"></iframe>')).join()).toMatch(/iframe/);
    expect(bad(wrap('<svg><image href="https://evil.example/x.png"/></svg>')).join()).toMatch(/image/);
    expect(bad(wrap('<div src="https://evil.example/x"></div>')).join()).toMatch(/src/);
    expect(bad(ok.replace("</style>", "@import url(https://evil.example/f.css);</style>")).join()).toMatch(/@import|url\(/);
    expect(bad(ok.replace("</style>", "body{background:url(https://evil.example/x.png)}</style>")).join()).toMatch(/url\(/);
    expect(bad(wrap('<div style="background:url(https://evil.example/x.png)"></div>')).join()).toMatch(/url\(/);
    expect(bad(wrap('<svg><rect fill="url(#ok)"/></svg>'))).toEqual([]);
  });

  it("rejects an event handler, a link anywhere but this pull request, its commits and its files at the pinned head or base, and a javascript: URL", () => {
    expect(bad(wrap('<div onclick="alert(1)"></div>')).join()).toMatch(/onclick/);
    expect(bad(wrap('<a href="https://evil.example/">x</a>')).join()).toMatch(/evil\.example/);
    expect(bad(wrap('<a href="https://github.com/other/repo/pull/1">x</a>')).join()).toMatch(/other\/repo/);
    expect(bad(wrap('<a href="https://github.com/apache/skywalking-banyandb/blob/main/pkg/a.go">x</a>')).join()).toMatch(/blob\/main/);
    expect(bad(wrap(`<a href="https://github.com/apache/skywalking-banyandb/commit/${"f".repeat(40)}">x</a>`)).join()).toMatch(/commit/);
    expect(bad(wrap('<a href="javascript:alert(1)">x</a>')).join()).toMatch(/javascript/);
    expect(bad(wrap('<a href="#top">x</a>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<a href="other.html">x</a>')).join()).toMatch(/other\.html/);
    expect(bad(wrap('<a href="review-appendix.html#q-Q1">x</a>'))).toEqual([]);
    expect(bad(wrap('<a href="review.html">x</a>'))).toEqual([]);
    expect(bad(wrap('<a href="review.html?x=1">x</a>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<a href="review-appendix.html#a b">x</a>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<div href="https://github.com/apache/skywalking-banyandb/pull/7"></div>')).join()).toMatch(/href on <div>/);
    expect(bad(wrap('<meta http-equiv="refresh" content="0;url=https://evil.example/">')).join()).toMatch(/meta/);
  });

  it("applies the URL-scheme check to URL-bearing attributes only: text that merely contains `data:` passes, a real data: or javascript: URL does not", () => {
    // A lifecycle entry named `metadata: cache`, in a title, an aria-label and the text.
    const entry: StateEntry = { name: "metadata: cache", scope: "per call", initial: "javascript: none", transitions: [{ when: "data: arrives", effect: "metadata: cache fills", cite: { path: "pkg/a.go", side: "head", start: 1, end: 1, symbol: "" } }], reads: [] };
    const item = { id: "R1", text: "Adds metadata: cache.", cites: [{ path: "pkg/a.go", side: "head" as const, start: 1, end: 1, symbol: "" }], facts: [], state: [entry], behavior: [] };
    const html = renderAppendixHtml({ report: report({ sections: [{ id: "features", title: "Every feature", none: false, items: [item] }] }) });
    expect(html).toContain('aria-label="Lifecycle of metadata: cache');
    expect(bad(html)).toEqual([]);
    expect(bad(wrap('<div title="the data: URL scheme" aria-label="javascript: is not run"></div>'))).toEqual([]);
    expect(bad(wrap('<a href="data:text/html,<p>x</p>">x</a>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<a href="data:text/html;base64,AAAA">x</a>')).join()).toMatch(/data:/);
    expect(bad(wrap('<a href="javascript:alert(1)">x</a>')).join()).toMatch(/javascript:/);
    expect(bad(wrap('<a href=" JaVaScRiPt:alert(1)">x</a>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<div srcset="data:image/png;base64,AA 1x"></div>')).length).toBeGreaterThan(0);
    expect(bad(wrap('<form action="javascript:alert(1)"></form>')).length).toBeGreaterThan(0);
  });

  it("rejects markup it cannot read", () => {
    expect(bad(wrap('<div class="a"')).join()).toMatch(/malformed/);
    expect(bad(wrap("<p><</p>")).join()).toMatch(/malformed/);
  });
});
