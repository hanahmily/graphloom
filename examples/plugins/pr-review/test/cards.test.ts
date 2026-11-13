// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The change cards of review.html (design §6.11, 0.25): the plugin-computed data behind them (core and synced-along files,
 * bounded code excerpts cut from the patches), their rendering (one sentence, the split of the files, the escaped and
 * bounded code), and that the page stays inert.
 */
import { describe, expect, it } from "vitest";
import type { Change } from "../src/briefing.js";
import { buildCards, citedHunk, MAX_CARD_EXCERPT_LINES, MAX_EXCERPT_LINE_CHARS, MAX_EXCERPT_LINES, MAX_SYNCED_LISTED } from "../src/cards.js";
import type { Cite } from "../src/cites.js";
import { htmlProblems, renderReviewHtml, type ReportDoc } from "../src/html.js";
import { REHEARSAL_HEAD, REHEARSAL_MERGE_BASE } from "../src/rehearsal.js";
import { pullFile, type PullFile } from "../src/snapshot.js";

const GITHUB = { owner: "apache", repo: "skywalking-banyandb", head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE };
const file = (path: string, patch: string | null, over: Partial<{ status: string; previousPath: string | null }> = {}): PullFile =>
  pullFile({ path, status: over.status ?? "modified", previousPath: over.previousPath ?? null, additions: 3, deletions: 1, sha: null, patch, patchOmitted: patch === null })!;
const at = (path: string, start: number, end = start, side: "head" | "base" = "head"): Cite => ({ path, side, start, end, symbol: "" });

// Head lines 10..14: a (ctx), new, newer, newest (added), b (ctx); base line 11 `old` is removed.
const PATCH = "@@ -10,3 +10,5 @@ func f() {\n a\n-old\n+new\n+newer\n+newest\n b";
const files = [file("pkg/a.go", PATCH), file("pkg/b.go", PATCH), file("pkg/c_test.go", PATCH), file("docs/x.md", PATCH), file("img/logo.png", null)];
const change = (cites: Cite[], over: Partial<Change> = {}): Change => ({ text: "Adds a thing.", cites, title: "Things: adds one thing", overview: "There was none; now one is added.", coreFiles: [cites[0]!.path], feature: "", ...over });

describe("citedHunk: the patch lines a cite covers", () => {
  it("takes the lines of the range on the head side, with the removed lines between them in patch order", () => {
    expect(citedHunk(at("pkg/a.go", 11, 12), files)).toEqual([
      { kind: "del", line: 11, text: "old" },
      { kind: "add", line: 11, text: "new" },
      { kind: "add", line: 12, text: "newer" },
    ]);
  });

  it("takes a base-side cite from the base numbers: the removed line and the context around it, with the lines that replace it", () => {
    expect(citedHunk(at("pkg/a.go", 10, 11, "base"), files)!.map((l) => `${l.kind}${l.line}:${l.text}`)).toEqual(["ctx10:a", "del11:old", "add11:new", "add12:newer", "add13:newest"]);
  });

  it("gives nothing for a whole-file cite, a file with no patch text, a file the pull request does not change, or lines outside the hunks", () => {
    expect(citedHunk(at("pkg/a.go", 0), files)).toBeUndefined();
    expect(citedHunk(at("img/logo.png", 0), files)).toBeUndefined();
    expect(citedHunk(at("pkg/other.go", 3), files)).toBeUndefined();
    expect(citedHunk(at("pkg/a.go", 90), files)).toBeUndefined();
  });

  it("cuts a long line", () => {
    const f = file("pkg/long.go", `@@ -1,1 +1,1 @@\n+${"x".repeat(500)}`);
    const [line] = citedHunk(at("pkg/long.go", 1), [f])!;
    expect(line!.text).toHaveLength(MAX_EXCERPT_LINE_CHARS);
    expect(line!.text.endsWith("…")).toBe(true);
  });
});

describe("buildCards: core and synced-along files, and the bounded excerpts", () => {
  const items = [
    { cites: [at("pkg/a.go", 11), at("pkg/c_test.go", 11)] },
    { cites: [at("docs/x.md", 11)] },
    { cites: [at("pkg/b.go", 11), at("pkg/a.go", 12)], auto: "fact" as const },
    { cites: [at("img/logo.png", 0)], auto: "coverage" as const },
  ];

  it("computes the synced files as the files the change's cites and its items touch, less the core, in the file list's order", () => {
    const [card] = buildCards({ whatsNew: [change([at("pkg/a.go", 11, 12), at("docs/x.md", 12)], { coreFiles: ["pkg/a.go"] })] }, files, items);
    expect(card!.id).toBe("W1");
    expect(card!.core).toEqual(["pkg/a.go"]);
    // docs/x.md from the cites, c_test.go and b.go from items that cite the core file; the unrelated coverage item does not count.
    expect(card!.synced).toEqual(["pkg/b.go", "pkg/c_test.go", "docs/x.md"]);
    expect(card!.syncedMore).toBe(0);
  });

  it("leaves a file that is core out of the synced list, and a change with no item beyond its cites has only those", () => {
    const [card] = buildCards({ whatsNew: [change([at("pkg/a.go", 11), at("pkg/b.go", 11)], { coreFiles: ["pkg/a.go", "pkg/b.go"] })] }, files, [{ cites: [at("docs/x.md", 11)] }]);
    expect(card!.core).toEqual(["pkg/a.go", "pkg/b.go"]);
    expect(card!.synced).toEqual([]);
  });

  it("lists at most the bound and counts the rest", () => {
    const many = Array.from({ length: MAX_SYNCED_LISTED + 5 }, (_, i) => file(`gen/f${String(i).padStart(2, "0")}.go`, PATCH));
    const all = [file("pkg/a.go", PATCH), ...many];
    const [card] = buildCards({ whatsNew: [change([at("pkg/a.go", 11)])] }, all, [{ cites: [at("pkg/a.go", 11), ...many.map((f) => at(f.path, 11))] }]);
    expect(card!.synced).toHaveLength(MAX_SYNCED_LISTED);
    expect(card!.syncedMore).toBe(5);
  });

  it("bounds the excerpt of a cite and of a card, saying what was left out", () => {
    const big = `@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`).join("\n")}`;
    const f = [file("pkg/big.go", big)];
    const cites = [at("pkg/big.go", 1, 40), at("pkg/big.go", 1, 40), at("pkg/big.go", 1, 40), at("pkg/big.go", 1, 40)];
    const [card] = buildCards({ whatsNew: [change(cites)] }, f, []);
    expect(card!.excerpts.map((e) => e.lines.length)).toEqual([MAX_EXCERPT_LINES, MAX_EXCERPT_LINES, MAX_EXCERPT_LINES]);
    expect(card!.excerpts.map((e) => e.more)).toEqual([28, 28, 28]);
    expect(card!.excerpts.reduce((n, e) => n + e.lines.length, 0)).toBe(MAX_CARD_EXCERPT_LINES);
    // The fourth cite's lines are left out whole.
    expect(card!.excerptsMore).toBe(40);
  });

  it("gives a cite with no lines in a hunk no excerpt (its link still shows on the page)", () => {
    const [card] = buildCards({ whatsNew: [change([at("pkg/other.go", 3, 4), at("img/logo.png", 0)], { coreFiles: [] })] }, files, []);
    expect(card!.excerpts).toEqual([]);
  });
});

function doc(whatsNew: Change[], over: Partial<ReportDoc> = {}): ReportDoc {
  const briefing = { whatsNew, features: [], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] };
  return {
    pull: { owner: "apache", repo: "skywalking-banyandb", number: 7, head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE, title: "Add a thing" },
    files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    commits: 1,
    checks: [],
    mode: "standard",
    summary: { purpose: null, overview: null },
    sections: [{ id: "features", title: "Every feature", none: true, items: [] }],
    notes: [],
    removed: [],
    removedParts: [],
    briefing,
    cards: buildCards(briefing, files, [{ cites: [at("pkg/a.go", 11), at("docs/x.md", 11)] }]),
    scope: { production: { files: 1, added: 4, deleted: 1 }, tests: { files: 0, added: 0, deleted: 0 }, docs: { files: 0, added: 0, deleted: 0 }, generated: { files: 0, added: 0, deleted: 0 } },
    measurements: { none: "none" },
    ...over,
  } as ReportDoc;
}

describe("the change cards of review.html", () => {
  const html = renderReviewHtml({ report: doc([change([at("pkg/a.go", 11, 12)], { title: "Things: adds one thing", overview: "There was none; now one is added." })]) });

  it("shows a card with the id, the title and the one sentence, in the Changes section", () => {
    expect(html).toContain("<h2>Changes</h2>");
    expect(html).toContain('<div class="chg" id="W1">');
    expect(html).toContain("Things: adds one thing");
    expect(html).toContain('<p class="co">There was none; now one is added.</p>');
    // The sentence is the only paragraph of the page.
    expect([...html.matchAll(/<p[ >]/g)].length - [...html.matchAll(/<p class="sub"/g)].length).toBe(1);
  });

  it("splits the files: core files as chips, the synced-along ones in a collapsed details", () => {
    const core = html.slice(html.indexOf('<div class="chips">'), html.indexOf("<details"));
    expect(core).toContain("pkg/a.go:11-12");
    expect(core).not.toContain("docs/x.md");
    const also = html.slice(html.indexOf('<details class="also">'));
    expect(also).toMatch(/^<details class="also"><summary>also changed \(1\)<\/summary>/);
    expect(also.slice(0, also.indexOf("</details>"))).toContain("docs/x.md");
    expect(html).not.toMatch(/<details class="also" open/);
  });

  it("holds the cited code in a collapsed details, with line numbers, marks and the link to the lines", () => {
    const code = html.slice(html.indexOf('<details class="code">'), html.indexOf("</details>", html.indexOf('<details class="code">')));
    expect(code).toContain("<summary>cited code (3 lines)</summary>");
    expect(code).toContain('<span class="l del">- 11  old</span>');
    expect(code).toContain('<span class="l add">+ 11  new</span>');
    expect(code).toContain('<span class="l add">+ 12  newer</span>');
    expect(code).toContain(`href="https://github.com/apache/skywalking-banyandb/blob/${REHEARSAL_HEAD}/pkg/a.go#L11-L12"`);
    expect(code).not.toContain(" open");
  });

  it("stays inert and passes the deterministic check", () => {
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(htmlProblems(html, GITHUB)).toEqual([]);
  });

  it("escapes the title, the sentence, the paths and the code, and says what the bounds left out", () => {
    const evilPatch = `@@ -1,2 +1,${MAX_EXCERPT_LINES + 3} @@\n${Array.from({ length: MAX_EXCERPT_LINES + 3 }, (_, i) => `+${i === 0 ? '<script>alert("x")</script> & </pre>' : `l${i}`}`).join("\n")}`;
    const evilFile = file('pkg/<img src=x onerror=1>.go', evilPatch);
    const fs = [evilFile];
    const w = change([at(evilFile.path, 1, MAX_EXCERPT_LINES + 3)], { title: "<b>t</b>", overview: '</p><script>x</script> "q"' });
    const briefing = { whatsNew: [w], features: [], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] };
    const page = renderReviewHtml({ report: doc([w], { briefing, files: [{ path: evilFile.path, status: "modified", additions: 15, deletions: 0 }], cards: buildCards(briefing, fs, []) }) });
    expect(page.toLowerCase()).not.toContain("<script");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<b>t</b>");
    expect(page).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;/pre&gt;");
    expect(page).toContain("&lt;b&gt;t&lt;/b&gt;");
    expect(page).toContain("… 3 more lines, at the link");
    expect(htmlProblems(page, GITHUB)).toEqual([]);
  });

  it("shows a feature's diagram inside the card that names it, and a feature no change names after the cards", () => {
    const feature = {
      id: "F1",
      name: "Retention sweep",
      summary: "A flag sets retention and a sweep removes what expired.",
      stages: [
        { id: "flag", label: "retention flag", kind: "source" as const, cite: at("pkg/a.go", 11) },
        { id: "sweep", label: "nightly sweep", kind: "process" as const, cite: at("pkg/a.go", 12) },
      ],
      flows: [{ from: "flag", to: "sweep", label: "schedules", cite: at("pkg/a.go", 11) }],
    };
    const w = change([at("pkg/a.go", 11, 12)], { feature: "F1" });
    const briefing = { whatsNew: [w], features: [feature, { ...feature, id: "F2", name: "Other flow" }], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] };
    const page = renderReviewHtml({ report: doc([w], { briefing, cards: buildCards(briefing, files, []) }) });
    const card = page.slice(page.indexOf('<div class="chg" id="W1">'), page.indexOf("<h3>Other data flows</h3>"));
    expect(card).toContain('<div class="flow" id="F1">');
    expect(card).not.toContain('id="F2"');
    expect(page.slice(page.indexOf("<h3>Other data flows</h3>"))).toContain('<div class="flow" id="F2">');
    expect(htmlProblems(page, GITHUB)).toEqual([]);
  });

  it("renders a report written before 0.25 (no cards) with the diagrams under the old heading", () => {
    const old = renderReviewHtml({ report: doc([change([at("pkg/a.go", 11)])], { cards: undefined as never }) });
    expect(old).toContain("<h2>Data flow</h2>");
    expect(old).not.toContain('class="chg"');
  });

  it("links every cite of the change, also one on an unchanged file (large mode) and one past the excerpt budget", () => {
    const big = `@@ -1,40 +1,40 @@\n${Array.from({ length: 40 }, (_, i) => `+line ${i + 1}`).join("\n")}`;
    const fs = [file("pkg/big.go", big)];
    const cites = [at("pkg/big.go", 1, 12), at("pkg/big.go", 13, 24), at("pkg/big.go", 25, 36), at("pkg/big.go", 37, 40), at("pkg/unchanged.go", 7, 9)];
    const withUnchanged = change(cites, { coreFiles: ["pkg/big.go"] });
    const briefing = { whatsNew: [withUnchanged], features: [], check: { surfaces: [], behavior: [], compatibility: [], risks: [], tests: [] }, areas: [] };
    const cards = buildCards(briefing, fs, []);
    expect(cards[0]!.excerptsMore).toBeGreaterThan(0);
    const page = renderReviewHtml({ report: doc([withUnchanged], { briefing, files: [{ path: "pkg/big.go", status: "modified", additions: 40, deletions: 0 }], cards, mode: "large" }) });
    const card = page.slice(page.indexOf('<div class="chg" id="W1">'), page.indexOf("</section>", page.indexOf('<div class="chg" id="W1">')));
    const links = card.slice(card.indexOf('<div class="chips cl">'), card.indexOf("</div>", card.indexOf('<div class="chips cl">')));
    for (const [path, range] of [["pkg/big.go", "L1-L12"], ["pkg/big.go", "L25-L36"], ["pkg/big.go", "L37-L40"], ["pkg/unchanged.go", "L7-L9"]]) expect(links).toContain(`/blob/${REHEARSAL_HEAD}/${path}#${range}"`);
    expect(htmlProblems(page, GITHUB)).toEqual([]);
  });
});
