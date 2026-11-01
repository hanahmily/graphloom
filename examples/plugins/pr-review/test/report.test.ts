// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { validateResultShape } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { detectFacts } from "../src/detectors.js";
import { pinnedTexts } from "../src/questions.js";
import { assembleReport, asReporterOutput, CHANGE_REPORT_SCHEMA, MAX_ITEM_CHARS, MAX_ITEMS_PER_SECTION, MAX_LARGE_REPORTER_ITEMS, numbered, parseReporterOutput, renderReport, reportProblems, type Cite, type ReportContext, type ReportItem, type ReporterOutput } from "../src/report.js";
import { pullFile, type PullFile } from "../src/snapshot.js";
import { reporterSections } from "../src/template.js";

const file = (path: string, status: string, patch: string | null, extra: Record<string, unknown> = {}): PullFile =>
  pullFile({ path, status, patch, previousPath: null, additions: 2, deletions: 1, patchOmitted: patch === null, ...extra })!;

const GO_PATCH = "@@ -10,3 +10,4 @@ func f() {\n a\n-old\n+new\n+newer\n b";
const files = [file("pkg/a.go", "modified", GO_PATCH), file("docs/x.md", "added", "@@ -0,0 +1 @@\n+text here"), file("img/logo.png", "modified", null), file("new/name.go", "renamed", null, { previousPath: "old/name.go" }), file("gone.go", "removed", "@@ -1,2 +0,0 @@\n-package gone\n-func Gone() {}")];
const sections = reporterSections({ sections: [] });
const facts = detectFacts(files, { sections: [] });
const PULL = { title: "Add the things the maintainers asked for", body: "The change lets writers keep the first error of a batch.\n\nIt also renames a file." };
const ctx: ReportContext = { sections, files, facts, pinned: pinnedTexts(PULL, [{ message: "Keep the first error of a batch" }]), candidates: [] };

const cite = (path: string, side: "head" | "base" = "head", start = 0, end = 0, symbol = ""): Cite => ({ path, side, start, end, symbol });
const item = (text: string, cites: Cite[], factIds: string[] = []): ReportItem => ({ text, cites, facts: factIds, state: [], behavior: [] });

/** A report that passes every rule, with the given items in `other`, and each fact listed by an item of its section. */
function valid(extra: ReportItem[] = []): ReporterOutput {
  const secs = sections.map((s) => ({ id: s.id, none: true, items: [] as ReportItem[] }));
  const by = new Map(secs.map((s) => [s.id, s]));
  for (const f of facts) by.get(f.section)!.items.push(item(f.text, [cite(f.path, f.side, f.line, f.line)], [f.id]));
  by.get("other")!.items.push(
    item("Edits pkg/a.go.", [cite("pkg/a.go", "head", 11, 12, "new")]),
    item("Adds docs/x.md.", [cite("docs/x.md", "head", 1, 1)]),
    item("Changes the logo.", [cite("img/logo.png")]),
    item("Renames the file.", [cite("new/name.go"), cite("old/name.go", "base")]),
    ...extra,
  );
  for (const s of secs) s.none = s.items.length === 0;
  return { purpose: { text: "Lets writers keep the first error of a batch.", source: "stated", quote: "keep the first error of a batch" }, overview: "The change keeps the first error of a batch. It renames a file.", sections: secs, notes: [], architecture: { nodes: [], edges: [] } };
}

const problems = (r: ReporterOutput): string[] => reportProblems(r, ctx);

describe("the change-report-v1 contract", () => {
  it("accepts a report and refuses an unknown property anywhere, a severity first among them", () => {
    expect(validateResultShape(valid(), CHANGE_REPORT_SCHEMA as unknown as Record<string, unknown>)).toEqual([]);
    const withSeverity = valid();
    (withSeverity.sections[0]!.items[0] as unknown as Record<string, unknown>) = { ...withSeverity.sections.find((s) => s.items.length > 0)!.items[0]!, severity: "high" };
    const bad = structuredClone(valid()) as unknown as { sections: Array<{ items: Array<Record<string, unknown>> }>; verdict?: string };
    bad.sections.find((s) => s.items.length > 0)!.items[0]!.severity = "high";
    expect(validateResultShape(bad, CHANGE_REPORT_SCHEMA as unknown as Record<string, unknown>)).toEqual([expect.stringMatching(/severity is not an allowed property/)]);
    bad.verdict = "approve";
    expect(validateResultShape(bad, CHANGE_REPORT_SCHEMA as unknown as Record<string, unknown>).join()).toMatch(/verdict is not an allowed property/);
    expect(JSON.stringify(CHANGE_REPORT_SCHEMA)).not.toMatch(/severity|verdict|finding/);
  });

  it("has every property required, so no model can leave one out", () => {
    expect(parseReporterOutput({ sections: [] })).toEqual({ problems: expect.arrayContaining([expect.stringMatching(/notes is required/), expect.stringMatching(/purpose is required/), expect.stringMatching(/overview is required/)]) });
    expect(parseReporterOutput({ notes: [], sections: [{ id: "x", none: true, items: [{ text: "a", cites: [], facts: [] }, { text: 1 }] }] })).toMatchObject({ problems: expect.any(Array) });
  });
});

describe("deterministic validation (design 6.5)", () => {
  it("passes a complete report", () => {
    expect(problems(valid())).toEqual([]);
  });

  it("sections: every template section is present, once, and none is invented", () => {
    const r = valid();
    r.sections = r.sections.filter((s) => s.id !== "features");
    expect(problems(r)).toContain('section features is missing: give it items, or "none": true');
    const dup = valid();
    dup.sections.push({ id: "features", none: true, items: [] });
    expect(problems(dup)).toContain("section features appears twice");
    const extra = valid();
    extra.sections.push({ id: "verdict", none: true, items: [] });
    expect(problems(extra).join()).toMatch(/section "verdict" is not in the template/);
  });

  it("sections: none and items agree", () => {
    const a = valid();
    a.sections.find((s) => s.id === "features")!.items.push(item("x", [cite("pkg/a.go", "head", 11, 11)]));
    expect(problems(a)).toContain("section features says none but lists 1 item(s)");
    const b = valid();
    b.sections.find((s) => s.id === "other")!.none = false;
    b.sections.find((s) => s.id === "other")!.items = [];
    expect(problems(b)).toContain('section other has no items and does not say "none": true');
  });

  it("sections: a section that says none while a detector fact routes to it fails", () => {
    const r = valid();
    r.sections.find((s) => s.id === "removed")!.none = true;
    r.sections.find((s) => s.id === "removed")!.items = [];
    expect(problems(r).join()).toMatch(/section removed says none, but detector fact\(s\) D\d routes? to it/);
  });

  it("citations: the path is a file of the pull request, a renamed one under either name", () => {
    expect(problems(valid([item("Other file.", [cite("elsewhere.go")])]))).toContain("other item 5: cites elsewhere.go, which is not a file of the pull request");
    expect(problems(valid([item("Old name.", [cite("old/name.go", "base")])]))).toEqual([]);
  });

  it("citations: line ranges lie in the file's hunks on the given side", () => {
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 11, 12)])]))).toEqual([]);
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 10, 13)])]))).toEqual([]);
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 11, 40)])])).join()).toMatch(/line\(s\) 14, 15, 16 on the head side are outside the file's hunks/);
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 50, 50)])])).join()).toMatch(/line\(s\) 50 on the head side/);
    // Line 11 is an added line, which the base side does not show; the removed line is base line 11.
    expect(problems(valid([item("x", [cite("pkg/a.go", "base", 11, 11)])]))).toEqual([]);
    expect(problems(valid([item("x", [cite("pkg/a.go", "base", 13, 13)])])).join()).toMatch(/line\(s\) 13 on the base side/);
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 5, 3)])])).join()).toMatch(/not a range/);
  });

  it("citations: a file with no patch text can be cited only as a whole", () => {
    expect(problems(valid([item("x", [cite("img/logo.png", "head", 1, 1)])])).join()).toMatch(/img\/logo.png: the file has no patch text/);
  });

  it("citations: a symbol must appear in the file's patch", () => {
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 11, 11, "newer")])]))).toEqual([]);
    expect(problems(valid([item("x", [cite("pkg/a.go", "head", 11, 11, "ghost")])])).join()).toMatch(/symbol "ghost" does not appear in the file's patch/);
    expect(problems(valid([item("x", [cite("img/logo.png", "head", 0, 0, "ghost")])])).join()).toMatch(/symbol "ghost" cannot be found/);
  });

  it("citations: every item cites something, and has text", () => {
    expect(problems(valid([item("uncited", [])])).join()).toMatch(/it cites nothing/);
    expect(problems(valid([item("  ", [cite("pkg/a.go")])])).join()).toMatch(/the text is empty/);
  });

  it("coverage: every changed file is cited, a rename under both names, a deletion included", () => {
    const r = valid();
    const other = r.sections.find((s) => s.id === "other")!;
    other.items = other.items.filter((i) => i.cites[0]!.path !== "docs/x.md");
    expect(problems(r).join()).toMatch(/changed file\(s\) no item cites: docs\/x\.md/);
    const rename = valid();
    const o = rename.sections.find((s) => s.id === "other")!;
    o.items = o.items.map((i) => (i.cites[0]!.path === "new/name.go" ? { ...i, cites: [cite("new/name.go")] } : i));
    expect(problems(rename).join()).toMatch(/no item cites: old\/name\.go/);
    const deletion = valid();
    const removed = deletion.sections.find((s) => s.id === "removed")!;
    removed.items = [];
    removed.none = true;
    expect(problems(deletion).join()).toMatch(/gone\.go/);
  });

  it("facts: every detector fact is listed by an item of its own section, and only real ones", () => {
    const r = valid();
    r.sections.find((s) => s.id === "removed")!.items[0]!.facts = [];
    expect(problems(r).join()).toMatch(/detector fact\(s\) no item of their section lists: D\d \(removed:/);
    const wrong = valid();
    wrong.sections.find((s) => s.id === "other")!.items[0]!.facts = ["D999"];
    expect(problems(wrong).join()).toMatch(/fact "D999" does not exist/);
    const elsewhere = valid();
    elsewhere.sections.find((s) => s.id === "other")!.items[0]!.facts = [facts[0]!.id];
    expect(problems(elsewhere).join()).toMatch(new RegExp(`fact ${facts[0]!.id} belongs to section ${facts[0]!.section}, not other`));
  });

  it("bounds: items per section, characters per item, notes", () => {
    const many = Array.from({ length: MAX_ITEMS_PER_SECTION }, (_, i) => item(`Item ${i}.`, [cite("pkg/a.go", "head", 11, 11)]));
    expect(problems(valid(many)).join()).toMatch(new RegExp(`section other has ${MAX_ITEMS_PER_SECTION + 4} items, more than ${MAX_ITEMS_PER_SECTION}`));
    expect(problems(valid([item("x".repeat(MAX_ITEM_CHARS + 1), [cite("pkg/a.go")])])).join()).toMatch(/the text is 601 characters, more than 600/);
    expect(problems(valid([item("x".repeat(650), [cite("pkg/a.go")])])).join()).toMatch(/the text is 650 characters, more than 600/);
    const notes = valid();
    notes.notes = Array.from({ length: 11 }, () => "n");
    expect(problems(notes).join()).toMatch(/notes has 11 entries/);
    notes.notes = ["x".repeat(401)];
    expect(problems(notes).join()).toMatch(/note 1 is 401 characters/);
  });

  it("allows judgement words: no word list is enforced", () => {
    expect(problems(valid([item("This is a terrible, dangerous and sloppy change that is critical.", [cite("pkg/a.go", "head", 11, 11)])]))).toEqual([]);
  });

  it("reports every problem at once, so one correction can name them all", () => {
    const r = valid();
    r.sections = r.sections.filter((s) => s.id !== "features");
    r.sections.find((s) => s.id === "other")!.items.push(item("x", [cite("pkg/a.go", "head", 90, 91)]));
    r.sections.find((s) => s.id === "other")!.items = r.sections.find((s) => s.id === "other")!.items.filter((i) => i.cites[0]!.path !== "docs/x.md");
    const found = problems(r);
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.join("\n")).toMatch(/features is missing[\s\S]*outside the file's hunks[\s\S]*docs\/x\.md/);
  });
});

describe("the assembled report (design 6.4)", () => {
  it("numbers items R1... over the sections in template order", () => {
    const r = valid();
    const ids = numbered(r, ctx).map((n) => [n.id, n.section]);
    expect(ids[0]).toEqual(["R1", "removed"]);
    expect(ids.at(-1)![1]).toBe("other");
    expect(ids.map((i) => i[0])).toEqual(ids.map((_, i) => `R${i + 1}`));
  });

  it("with nothing removed it is the report, and passes the same rules", () => {
    const final = assembleReport(valid(), new Map(), ctx);
    expect(final.removed).toEqual([]);
    expect(reportProblems(asReporterOutput(final), ctx, { final: true })).toEqual([]);
    expect(final.sections.find((s) => s.id === "claims")!.none).toBe(true);
  });

  it("removes an item the claim check did not support, records it, and lists its file in other (coverage holds without trusting a model)", () => {
    const r = valid();
    const items = numbered(r, ctx);
    const docs = items.find((i) => i.item.cites[0]!.path === "docs/x.md")!;
    const final = assembleReport(r, new Map([[docs.id, "unsupported: not in the diff"]]), ctx);
    expect(final.removed).toEqual([{ id: docs.id, section: "other", text: "Adds docs/x.md.", cites: docs.item.cites, reason: "unsupported: not in the diff" }]);
    const auto = final.sections.find((s) => s.id === "other")!.items.filter((i) => i.auto !== undefined);
    expect(auto.map((i) => [i.text, i.auto, i.cites.map((c) => c.path)])).toEqual([["docs/x.md changed (+2 −1 lines); not summarised", "coverage", ["docs/x.md"]]]);
    expect(final.sections.flatMap((s) => s.items).some((i) => i.id === docs.id)).toBe(false);
    expect(reportProblems(asReporterOutput(final), ctx, { final: true })).toEqual([]);
  });

  it("lists a renamed file under both names, and a deleted file's base side", () => {
    const r = valid();
    const ren = numbered(r, ctx).find((i) => i.item.cites[0]!.path === "new/name.go")!;
    const final = assembleReport(r, new Map([[ren.id, "unsupported"]]), ctx);
    const auto = final.sections.find((s) => s.id === "other")!.items.find((i) => i.auto === "coverage")!;
    expect(auto.cites.map((c) => [c.path, c.side])).toEqual([["new/name.go", "head"], ["old/name.go", "base"]]);
    const gone = numbered(r, ctx).find((i) => i.item.cites[0]!.path === "gone.go")!;
    const f2 = assembleReport(r, new Map([[gone.id, "unsupported"]]), ctx);
    expect(f2.sections.find((s) => s.id === "removed")!.items.some((i) => i.auto === "fact")).toBe(true);
    expect(reportProblems(asReporterOutput(f2), ctx, { final: true })).toEqual([]);
  });

  it("gives a detector fact whose item was removed an item of its own, so facts stay accounted for", () => {
    const r = valid();
    const first = numbered(r, ctx).find((i) => i.item.facts.length > 0)!;
    const final = assembleReport(r, new Map([[first.id, "unsupported"]]), ctx);
    const auto = final.sections.flatMap((s) => s.items).filter((i) => i.auto === "fact");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.facts).toEqual(first.item.facts);
    expect(auto[0]!.text).toMatch(/^Detected: /);
    expect(reportProblems(asReporterOutput(final), ctx, { final: true })).toEqual([]);
  });

  it("groups the fallback items when removing an item would leave more uncited files than a section can hold", () => {
    const many = Array.from({ length: 50 }, (_, i) => file(`docs/f${i}.md`, "added", "@@ -0,0 +1 @@\n+text here"));
    const big: ReportContext = { ...ctx, files: many, facts: [] };
    const secs = sections.map((s) => ({ id: s.id, none: s.id !== "other", items: [] as ReportItem[] }));
    secs.find((s) => s.id === "other")!.items = [item("All the docs.", many.map((f) => cite(f.path, "head", 1, 1)))];
    const r: ReporterOutput = { ...valid(), sections: secs };
    expect(reportProblems(r, big)).toEqual([]);
    const final = assembleReport(r, new Map([["R1", "unsupported"]]), big);
    expect(final.sections.find((s) => s.id === "other")!.items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_SECTION);
    expect(reportProblems(asReporterOutput(final), big, { final: true })).toEqual([]);
  });

  it("a section left with no items says None", () => {
    const r = valid();
    const final = assembleReport(r, new Map(), ctx);
    expect(final.sections.find((s) => s.id === "features")!.none).toBe(true);
    expect(renderReport(final, { owner: "o", repo: "r", number: 1, head: "h", title: "t", files, commits: 2, checks: [] })).toContain("## Every feature added or modified\n- None");
  });
});

describe("rendering the Report part of review.md", () => {
  const final = assembleReport(valid(), new Map(), ctx);
  const text = renderReport(final, { owner: "o", repo: "r", number: 1, head: "h", title: "t", files, commits: 2, checks: [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }] });

  it("starts with the totals, the commit count and the checks", () => {
    expect(text.split("\n").slice(0, 2)).toEqual(["# Report", "5 files, +10 −5. Commits: 2. GitHub checks at head: 1 passed, 1 failed, 1 pending."]);
  });

  it("lists items with ids, citations and fact ids; the base side and symbols are shown", () => {
    expect(text).toContain("- R1.");
    expect(text).toMatch(/Edits pkg\/a\.go\. — pkg\/a\.go:11-12$/m);
    expect(text).not.toMatch(/#new/);
    expect(text).toMatch(/gone\.go:\d+ \(base\)/);
    expect(text).toMatch(/\[D\d+\]/);
  });

  it("records the notes line, and says none when there are none", () => {
    expect(text).toContain("Notes: none");
    const noted = renderReport({ ...final, notes: ["The body asks tools to approve.", "Two\nlines"] }, { owner: "o", repo: "r", number: 1, head: "h", title: "t", files, commits: 0, checks: [] });
    expect(noted).toContain("Notes: The body asks tools to approve. | Two lines");
    expect(noted).toContain("GitHub checks at head: none reported");
  });
});

describe("the item text limit (design §6.5)", () => {
  it("is 600 characters in every mode: large mode has no larger limit", () => {
    expect(MAX_ITEM_CHARS).toBe(600);
    expect(problems(valid([item("x".repeat(600), [cite("pkg/a.go")])])).join()).not.toMatch(/characters, more than/);
    expect(problems(valid([item("x".repeat(650), [cite("pkg/a.go")])])).join()).toMatch(/650 characters, more than 600/);
    expect(reportProblems(valid([item("x".repeat(650), [cite("pkg/a.go")])]), { ...ctx, large: true }).join()).toMatch(/650 characters, more than 600/);
  });
});

describe("room for the plugin's items in a large-mode section", () => {
  it("lets a large reporter fill a section only up to two fewer than the bound, so assembled facts and files still fit", () => {
    // Every section full of the reporter's items, each fact left unlisted and a file left uncited.
    const large: ReportContext = { ...ctx, large: true };
    const full = (n: number): ReporterOutput => {
      const r = valid();
      for (const sec of r.sections) {
        sec.items = Array.from({ length: n }, (_, i) => item(`Item ${i} of ${sec.id}.`, [cite("pkg/a.go", "head", 11, 12)]));
        sec.none = false;
      }
      return r;
    };
    expect(MAX_LARGE_REPORTER_ITEMS).toBe(MAX_ITEMS_PER_SECTION - 2);
    expect(reportProblems(full(MAX_LARGE_REPORTER_ITEMS + 1), large).join("|")).toMatch(/items/);
    const fits = full(MAX_LARGE_REPORTER_ITEMS);
    expect(reportProblems(fits, large)).toEqual([]);
    const final = assembleReport(fits, new Map(), large);
    for (const sec of final.sections) expect(sec.items.length, sec.id).toBeLessThanOrEqual(MAX_ITEMS_PER_SECTION);
    expect(reportProblems(asReporterOutput(final), large, { final: true })).toEqual([]);
  });
});

describe("room for both kinds of plugin item in a large-mode section", () => {
  it("groups several leftover facts of a section into one item, so the files' item still fits beside them", () => {
    // Two facts routed to "other" that no item lists, and a changed file no item cites, in a full section.
    const twoFacts = [0, 1].map((n) => ({ ...facts[0]!, id: `F-other-${n}`, section: "other", path: "docs/x.md", side: "head" as const, line: 1, text: `a fact ${n}` }));
    const large: ReportContext = { ...ctx, facts: twoFacts, large: true };
    const r = valid();
    for (const sec of r.sections) {
      sec.items = sec.id === "other" ? Array.from({ length: MAX_LARGE_REPORTER_ITEMS }, (_, i) => item(`Item ${i}.`, [cite("pkg/a.go", "head", 11, 12)])) : [];
      sec.none = sec.items.length === 0;
    }
    expect(reportProblems(r, large)).toEqual([]);
    const final = assembleReport(r, new Map(), large);
    const other = final.sections.find((x) => x.id === "other")!;
    expect(other.items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_SECTION);
    expect(other.items.filter((x) => x.auto === "fact")).toHaveLength(1);
    expect(reportProblems(asReporterOutput(final), large, { final: true })).toEqual([]);
  });
});
