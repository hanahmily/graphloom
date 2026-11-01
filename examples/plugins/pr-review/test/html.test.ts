// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { htmlProblems, parseQaDoc, parseReportDoc, renderReviewHtml, reviewHtmlFrom, type QaDoc, type ReportDoc } from "../src/html.js";
import { stateDiagramSvg } from "../src/htmlsvg.js";
import { LARGE_LIMITS, REHEARSAL_HEAD, REHEARSAL_MERGE_BASE } from "../src/rehearsal.js";
import { recordedHtml, recordedNecessityJson, recordedQa, recordedReport } from "../src/parts.js";
import type { StateEntry } from "../src/report.js";
import { simulate, type Simulation } from "./support.js";

const GITHUB = { owner: "apache", repo: "skywalking-banyandb", head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE };
const htmlOf = (sim: Simulation): string => {
  const h = recordedHtml(sim.evidence, true);
  if (h.state !== "read") throw new Error("no review.html was written whole");
  return h.value;
};
const SECTIONS = ["<h2>Necessity</h2>", "<h2>Summary</h2>", "<h2>Architecture</h2>", "<h2>Change map</h2>", "<h2>Report</h2>", "<h2>Measurements</h2>", "<h2>Q&amp;A</h2>", "<h2>Removed by the claim check, and notes</h2>"];
const inOrder = (html: string, parts: string[]): boolean => parts.every((p, i) => html.includes(p) && (i === 0 || html.indexOf(p) > html.indexOf(parts[i - 1]!)));

describe("review.html of a standard report (design 6.11)", () => {
  const sim = simulate({ scenarioName: "architecture-diagram" });
  const html = htmlOf(sim);

  it("is written at the Report stage with the Q&A pending, and whole at the Answers stage, beside review.md", () => {
    expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "report ready" } });
    const early = recordedHtml(sim.evidence, false);
    expect(early.state).toBe("read");
    expect((early as { value: string }).value).toContain("<h2>Q&amp;A</h2> <span class=\"badge grey\">pending</span>");
    expect((early as { value: string }).value).toContain("<h2>Necessity</h2> <span class=\"badge grey\">pending</span>");
    expect(html).not.toContain("pending</span>");
    expect(sim.jobs.map((j) => j.instruction)).toEqual(expect.arrayContaining(["Write .graphloom/review/review.html"]));
  });

  it("has every section, in the order the design gives", () => {
    expect(inOrder(html, SECTIONS)).toBe(true);
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("opens with the header cards: the pull request, files, lines, commits, checks, the mode and N1's coloured badge", () => {
    const head = html.slice(0, html.indexOf("</header>"));
    expect(head).toContain("apache/skywalking-banyandb#7");
    for (const label of ["Files", "Lines", "Commits", "GitHub checks", "Mode", "N1: is it necessary?"]) expect(head).toContain(`<div class="label">${label}</div>`);
    expect(head).toMatch(/<span class="badge (ok|warn|bad|grey)">(necessary|questionable|unnecessary|needs author)<\/span>/);
    expect(head).toContain(`href="https://github.com/apache/skywalking-banyandb/commit/${REHEARSAL_HEAD}"`);
    expect(head).toContain("by contributor");
  });

  it("draws the architecture diagram as an inline SVG and records the connection the claim check did not support", () => {
    const arch = html.slice(html.indexOf("<h2>Architecture</h2>"), html.indexOf("<h2>Change map</h2>"));
    expect(arch).toContain("<svg");
    for (const label of ["Server command", "Group schema", "robfig/cron", "Liaison gRPC API"]) expect(arch).toContain(label);
    expect(arch).toContain("2 components".replace("2", "4"));
    expect(arch).toContain("2 connections");
    const removed = html.slice(html.indexOf("<h2>Removed by the claim check"));
    expect(removed).toContain("<strong>A.e2</strong>");
    expect(removed).toContain("sets retention_days from the flag");
  });

  it("links only to GitHub at the pinned head and base, and passes the inertness check on its own bytes", () => {
    expect(htmlProblems(html, GITHUB)).toEqual([]);
    expect(html).not.toMatch(/<script|<link|<img|<iframe|\ssrc=|\sonclick=/i);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
    expect(hrefs.length).toBeGreaterThan(5);
    expect(hrefs.every((h) => h.startsWith("https://github.com/apache/skywalking-banyandb/"))).toBe(true);
    expect(hrefs.some((h) => h.includes(`/blob/${REHEARSAL_HEAD}/banyand/cmd/server/flags.go#L`))).toBe(true);
  });

  it("is of a reasonable size: inline SVG, no embedded images", () => {
    expect(html.length).toBeLessThan(400_000);
    expect(html).not.toMatch(/base64|data:/);
  });

  it("shows the change map per report section, the items as cards with their citations, and the Q&A collapsed by default", () => {
    const map = html.slice(html.indexOf("<h2>Change map</h2>"), html.indexOf("<h2>Report</h2>"));
    expect(map).toContain("Lines added and deleted per report section");
    expect(map).toContain("<svg");
    const items = html.slice(html.indexOf("<h2>Report</h2>"), html.indexOf("<h2>Measurements</h2>"));
    expect(items).toMatch(/<div class="item" id="R\d+">/);
    expect(items).toContain('class="cites"');
    const qa = html.slice(html.indexOf("<h2>Q&amp;A</h2>"));
    expect(qa).toMatch(/<details (open )?class="qa">/);
  });

  it("writes the same markdown with a mermaid block for the diagram, and the removed edge under 'Removed by the claim check'", () => {
    const md = recordedQa(sim.evidence);
    expect(md.state).toBe("read");
    const text = (md as { value: { markdown: string } }).value.markdown;
    expect(text).toContain("## Architecture\n```mermaid\nflowchart LR");
    expect(text).toContain("## Removed by the claim check");
    expect(text).toContain("`A.e2`");
  });
});

describe("review.html of a large report", () => {
  const sim = simulate({ scenarioName: "large-pull-request", config: { limits: LARGE_LIMITS }, maxSteps: 250 });
  const html = htmlOf(sim);

  it("has every section, the mode in the header, and the change map per area", () => {
    expect(inOrder(html, SECTIONS)).toBe(true);
    expect(html).toContain("large: ");
    const map = html.slice(html.indexOf("<h2>Change map</h2>"), html.indexOf("<h2>Report</h2>"));
    expect(map).toContain("Lines added and deleted per area");
    expect(map).toMatch(/A1 /);
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });

  it("draws the synthesis job's architecture diagram", () => {
    const arch = html.slice(html.indexOf("<h2>Architecture</h2>"), html.indexOf("<h2>Change map</h2>"));
    expect(arch).toContain("pkg/alpha");
    expect(arch).toContain("pkg/beta");
    expect(arch).toContain("applies Alpha1");
  });
});

describe("review.html when N1 stops the questions, and when a question needs the author", () => {
  it("shows N1's three parts, the principles badges and the checker's judgment", () => {
    const sim = simulate({ scenarioName: "necessity-principle-broken" });
    const html = htmlOf(sim);
    const necessity = html.slice(html.indexOf("<h2>Necessity</h2>"), html.indexOf("<h2>Summary</h2>"));
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
  });

  it("opens a question that needs the author and collapses the others", () => {
    const sim = simulate({ scenarioName: "needs-author-purpose" });
    const html = htmlOf(sim);
    const qa = html.slice(html.indexOf("<h2>Q&amp;A</h2>"));
    expect(qa).toMatch(/<details open class="qa"><summary>[^]*?needs author<\/span>/);
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
    const html = renderReviewHtml({ report: report(), qa });
    const body = html.slice(html.indexOf("<h2>Q&amp;A</h2>"));
    expect(body.match(/<details open class="qa">/g)).toHaveLength(1);
    expect(body.match(/<details class="qa">/g)).toHaveLength(2);
    for (const [cls, text] of [["ok", "answered"], ["warn", "partially answered"], ["bad", "needs author"]]) expect(body).toContain(`<span class="badge ${cls}">${text}</span>`);
    expect(body).toContain("1 answered, 1 partially answered, 1 needs author");
  });

  it("says the remaining questions were skipped when N1 concluded unnecessary", () => {
    const sim = simulate({ scenarioName: "necessity-unnecessary" });
    expect(htmlOf(sim)).toContain("Remaining questions skipped");
  });
});

describe("measurements in review.html", () => {
  it("colours cells against the limits and draws the coverage and CRAP bars with the threshold", () => {
    const sim = simulate({ scenarioName: "coverage-measured" });
    const html = htmlOf(sim);
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
    const html = renderReviewHtml({ report: doc });
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
    const html = renderReviewHtml({ report: report({ sections: [{ id: "features", title: "Every feature", none: false, items: [item] }] }) });
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
    architecture: { nodes: [], edges: [] },
    measurements: { none: "no function was added or modified" },
    ...over,
  };
}

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
    architecture: {
      nodes: [{ id: "n", label: evil, kind: "package", change: "added", paths: [evil], cite: { path: "a.go", side: "head", start: 1, end: 1 } }],
      edges: [],
    },
  });
  const qa: QaDoc = {
    questions: [
      { id: "Q1", type: "purpose", item: "R1", text: evil, origin: "required", answer: { answer: evil, status: "answered", citations: [{ path: "a.go", tree: "head", start: 1, end: 1, quote: evil }], searches: [], check: { verdict: "supported", note: evil, searches: [] } } },
      { id: "Q2", type: "purpose", item: "R1", text: "second", origin: "required", answer: { answer: `agent says ${evil}`, status: "needs author", check: { verdict: "supported", note: "", searches: [] } } },
    ],
  };

  it("escapes everything a model or the pull request wrote: no script, no injected element, in the title, an item, a state entry and an answer", () => {
    const html = renderReviewHtml({ report: hostile, qa });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<title>apache/skywalking-banyandb#7: &lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(html).toContain("agent says &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });

  it("goes through the JSON the files hold: reviewHtmlFrom renders report.json and qa.json texts the same way", () => {
    const json = JSON.stringify({ schema: "pr-change-report-v1", ...hostile });
    const qaJson = JSON.stringify({ schema: "pr-qa-v1", ...qa });
    expect(parseReportDoc(json)).toBeDefined();
    expect(parseQaDoc(qaJson)).toBeDefined();
    expect(parseReportDoc("{}")).toBeUndefined();
    expect(reviewHtmlFrom("not json")).toBeUndefined();
    expect(reviewHtmlFrom(json, qaJson)).toBe(renderReviewHtml({ report: hostile, qa }));
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
    expect(bad(wrap('<div href="https://github.com/apache/skywalking-banyandb/pull/7"></div>')).join()).toMatch(/href on <div>/);
    expect(bad(wrap('<meta http-equiv="refresh" content="0;url=https://evil.example/">')).join()).toMatch(/meta/);
  });

  it("applies the URL-scheme check to URL-bearing attributes only: text that merely contains `data:` passes, a real data: or javascript: URL does not", () => {
    // A lifecycle entry named `metadata: cache`, in a title, an aria-label and the text.
    const entry: StateEntry = { name: "metadata: cache", scope: "per call", initial: "javascript: none", transitions: [{ when: "data: arrives", effect: "metadata: cache fills", cite: { path: "pkg/a.go", side: "head", start: 1, end: 1, symbol: "" } }], reads: [] };
    const item = { id: "R1", text: "Adds metadata: cache.", cites: [{ path: "pkg/a.go", side: "head" as const, start: 1, end: 1, symbol: "" }], facts: [], state: [entry], behavior: [] };
    const html = renderReviewHtml({ report: report({ sections: [{ id: "features", title: "Every feature", none: false, items: [item] }] }) });
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
