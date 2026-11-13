// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { emptyBriefing } from "../src/briefing.js";
import { claimTargets, readClaimCheck } from "../src/claims.js";
import { detectFacts } from "../src/detectors.js";
import { pinnedTexts } from "../src/questions.js";
import { STREAM_CHANGED, STREAM_PATH } from "../src/rehearsal-fixtures.js";
import { assembleReport, asReporterOutput, citedLines, citeLabel, purposeLine, renderReport, reportProblems, type Cite, type FinalReport, type ReportContext, type ReportItem, type ReporterOutput, type StateEntry } from "../src/report.js";
import { pullFile, type PullFile } from "../src/snapshot.js";
import { detectStateCandidates } from "../src/statecandidates.js";
import { reporterSections } from "../src/template.js";
import { assignmentOf, jobsOf, scenarioWith, simulate } from "./support.js";

const file = (path: string, status: string, patch: string | null): PullFile => pullFile({ path, status, patch, previousPath: null, additions: 3, deletions: 0, patchOmitted: patch === null })!;

// A counter and a first-error variable, set in two places and read once, as in a write callback.
const GO_PATCH = [
  "@@ -10,6 +10,14 @@ func (w *cb) Rev() {",
  " \tfor _, e := range events {",
  "+\tstored := 0",
  "+\tvar firstErr error",
  " \t\tif err := w.handle(e); err != nil {",
  "+\t\t\tif firstErr == nil {",
  "+\t\t\t\tfirstErr = err",
  "+\t\t\t}",
  " \t\t\tcontinue",
  " \t\t}",
  "+\t\tstored++",
  " \t}",
  "+\tif stored == 0 && firstErr != nil {",
  "+\t\treturn failure(firstErr)",
  "+\t}",
].join("\n");
const goFile = file("pkg/cb.go", "modified", GO_PATCH);
const changelog = file("CHANGES.md", "modified", "@@ -3,2 +3,3 @@\n - older entry\n+- reply with an error\n - oldest entry");
const files = [goFile, changelog];
const sections = reporterSections({ sections: [] });
const PULL = { title: "fix: reply with an error when a batch stores nothing", body: "The callback now replies with the first error when nothing was stored." };
const candidates = detectStateCandidates(files);
const ctx: ReportContext = { sections, files, facts: detectFacts(files, { sections: [] }), pinned: pinnedTexts(PULL, []), candidates };

const at = (path: string, start: number, end = start, side: "head" | "base" = "head"): Cite => ({ path, side, start, end, symbol: "" });
const find = (needle: string): number => {
  const l = goFile.parsed.lines.find((x) => x.text.includes(needle));
  if (l === undefined) throw new Error(needle);
  return l.line;
};
const stored: StateEntry = {
  name: "stored",
  scope: "per call",
  initial: "0",
  transitions: [{ when: "w.handle returns no error", effect: "increments by one", cite: at("pkg/cb.go", find("stored++")) }],
  reads: [{ where: "after the loop", decision: "stored == 0 && firstErr != nil switches the reply to an error", cite: at("pkg/cb.go", find("if stored == 0")) }],
};
const firstErr: StateEntry = {
  name: "firstErr",
  scope: "per call",
  initial: "nil",
  transitions: [{ when: "w.handle fails and firstErr is still nil", effect: "firstErr = err", cite: at("pkg/cb.go", find("firstErr = err")) }],
  reads: [{ where: "after the loop", decision: "the error the reply carries", cite: at("pkg/cb.go", find("return failure")) }],
};
const change = (over: Partial<ReportItem> = {}): ReportItem => ({
  text: "A batch that stores nothing is answered with its first failure.",
  cites: [at("pkg/cb.go", find("stored := 0"), find("var firstErr")), at("pkg/cb.go", find("stored++")), at("pkg/cb.go", find("if stored == 0"), find("return failure"))],
  facts: [],
  state: [stored, firstErr],
  behavior: [{ case: "every event fails", before: "success", after: "an error with the first failure" }],
  ...over,
});
const report = (over: Partial<ReporterOutput> = {}, item: ReportItem = change()): ReporterOutput => ({
  purpose: { text: "Report a failed batch to the sender.", source: "stated", quote: "replies with the first error when nothing was stored" },
  overview: "Rev counts the events it stores and keeps the first failure. A batch that stored nothing is answered with that failure.",
  sections: sections.map((s) => {
    const items = s.id === "features" ? [item] : s.id === "other" ? [{ text: "Adds a changelog entry.", cites: [at("CHANGES.md", 4)], facts: [], state: [], behavior: [] }] : [];
    return { id: s.id, none: items.length === 0, items };
  }),
  notes: [],
  ...emptyBriefing(),
  whatsNew: [{ text: "Reports a failed batch.", cites: [at("CHANGES.md", 4)], title: "Changelog: notes the failed-batch reply", overview: "The changelog did not mention it; now it does.", coreFiles: ["CHANGES.md"], feature: "" }],
  ...over,
});
const problems = (r: ReporterOutput, c: ReportContext = ctx): string[] => reportProblems(r, c);

describe("the summary", () => {
  it("passes a stated purpose whose quote is in the pull request's text, and an inferred one with no quote", () => {
    expect(problems(report())).toEqual([]);
    expect(problems(report({ purpose: { text: "Make failures visible.", source: "inferred", quote: "" } }))).toEqual([]);
  });

  it("refuses a stated purpose whose quote is not in the title, body or commit messages", () => {
    expect(problems(report({ purpose: { text: "x", source: "stated", quote: "this was never written anywhere" } })).join()).toMatch(/says it is stated, but its quote is not in the pull request's title, body or commit messages/);
    expect(problems(report({ purpose: { text: "x", source: "stated", quote: "" } })).join()).toMatch(/says it is stated/);
  });

  it("accepts a quote with its whitespace collapsed, from the title as well as the body", () => {
    expect(problems(report({ purpose: { text: "x", source: "stated", quote: "replies with the first   error\nwhen nothing was stored" } }))).toEqual([]);
    expect(problems(report({ purpose: { text: "x", source: "stated", quote: "reply with an error when a batch stores nothing" } }))).toEqual([]);
  });

  it("refuses an inferred purpose that carries a quote, an empty purpose and an empty or over-long overview", () => {
    expect(problems(report({ purpose: { text: "x", source: "inferred", quote: "a quote that is not needed" } })).join()).toMatch(/inferred purpose has no quote/);
    expect(problems(report({ purpose: { text: " ", source: "inferred", quote: "" } })).join()).toMatch(/purpose text is empty/);
    expect(problems(report({ overview: "" })).join()).toMatch(/overview is missing or empty/);
    expect(problems(report({ overview: "x".repeat(901) })).join()).toMatch(/overview is 901 characters/);
  });

  it("renders at the top of the Report part, marking an inferred purpose as inferred", () => {
    const header = { owner: "o", repo: "r", number: 1, head: "h", title: "t", files, commits: 1, checks: [] };
    const stated = renderReport(assembleReport(report(), new Map(), ctx), header).split("\n");
    expect(stated.slice(0, 3)).toEqual(["# Report", expect.stringMatching(/^2 files, /), ""]);
    expect(stated[3]).toBe("## Summary");
    expect(stated[4]).toMatch(/^\*\*Overview:\*\* Rev counts the events it stores/);
    // The purpose is the briefing's: quoted when stated, marked when inferred.
    const line = (r: ReporterOutput) => purposeLine(assembleReport(r, new Map(), ctx).summary, []);
    expect(line(report())).toBe('**Purpose** (stated: "replies with the first error when nothing was stored"): Report a failed batch to the sender.');
    expect(line(report({ purpose: { text: "Make failures visible.", source: "inferred", quote: "" } }))).toContain("**Purpose** (inferred from the diff; the pull request does not state it): Make failures visible.");
  });
});

describe("state candidates: the deterministic trigger for lifecycles", () => {
  it("finds a local declared in an added line and changed by a later one, and not the error idiom or a loop variable", () => {
    expect(candidates.map((c) => [c.name, c.kind])).toEqual([["stored", "accumulator"], ["firstErr", "accumulator"]]);
    expect(candidates[0]).toMatchObject({ path: "pkg/cb.go", line: find("stored := 0"), mutatedAt: find("stored++") });
  });

  it("finds an added struct field and a class property, and nothing in a test file or a removed one", () => {
    const struct = file("pkg/w.go", "modified", ["@@ -3,3 +3,5 @@ package w", " type writer struct {", " \tl *log.Logger", "+\tstored int", "+\tfirstErr error `json:\"-\"`", " }"].join("\n"));
    expect(detectStateCandidates([struct]).map((c) => [c.name, c.kind])).toEqual([["stored", "field"], ["firstErr", "field"]]);
    const klass = file("src/w.ts", "modified", ["@@ -1,3 +1,4 @@", " export class W {", "+  private cache = new Map<string, number>();", "   run() {}", " }"].join("\n"));
    expect(detectStateCandidates([klass]).map((c) => c.name)).toEqual(["cache"]);
    expect(detectStateCandidates([file("pkg/w_test.go", "added", "@@ -0,0 +1,3 @@\n+\tcount := 0\n+\tcount++\n+")])).toEqual([]);
    expect(detectStateCandidates([file("pkg/old.go", "removed", "@@ -1,3 +0,0 @@\n-\tcount := 0\n-\tcount++\n-")])).toEqual([]);
  });

  it("does not report a declaration nothing later changes, a loop header, or a name that is only compared", () => {
    const quiet = file("pkg/q.go", "modified", ["@@ -1,3 +1,8 @@ func q() {", "+\tlimit := 10", "+\tfor i := 0; i < limit; i++ {", "+\t\tuse(i)", "+\t}", "+\tif limit == 3 {", "+\t}", " }"].join("\n"));
    expect(detectStateCandidates([quiet])).toEqual([]);
  });

  it("demands a lifecycle entry named for each, in an item that cites its file", () => {
    const none = problems(report({}, change({ state: [] }))).join();
    expect(none).toMatch(/state the patch introduces has no lifecycle entry: stored \(pkg\/cb\.go:\d+, declared, then changed at line \d+\); firstErr/);
    expect(problems(report({}, change({ state: [stored] }))).join()).toMatch(/no lifecycle entry: firstErr/);
    expect(problems(report())).toEqual([]);
    // An entry in an item that does not cite the file does not count.
    const elsewhere = report();
    const other = elsewhere.sections.find((s) => s.id === "other")!;
    other.items[0]!.state = [stored, firstErr];
    elsewhere.sections.find((s) => s.id === "features")!.items[0]!.state = [];
    expect(problems(elsewhere).join()).toMatch(/no lifecycle entry: stored/);
  });
});

describe("lifecycle and behavior validation", () => {
  it("requires every lifecycle citation to lie inside the diff", () => {
    const bad: StateEntry = { ...stored, transitions: [{ ...stored.transitions[0]!, cite: at("pkg/cb.go", 90, 91) }] };
    expect(problems(report({}, change({ state: [bad, firstErr] }))).join()).toMatch(/state 1 transition 1: pkg\/cb\.go: line\(s\) 90, 91 on the head side are outside the file's hunks/);
    const ghost: StateEntry = { ...stored, reads: [{ ...stored.reads[0]!, cite: at("nowhere.go", 1) }] };
    expect(problems(report({}, change({ state: [ghost, firstErr] }))).join()).toMatch(/state 1 read 1: cites nowhere\.go, which is not a file/);
  });

  it("requires lines on a file with patch text: 0 and 0 and a symbol alone are refused, so every citation can read path:line", () => {
    const whole: Cite = { path: "pkg/cb.go", side: "head", start: 0, end: 0, symbol: "firstErr" };
    expect(problems(report({}, change({ cites: [whole] }))).join()).toMatch(/pkg\/cb\.go: the file has patch text, so cite the lines/);
    const entry: StateEntry = { ...stored, transitions: [{ ...stored.transitions[0]!, cite: whole }] };
    expect(problems(report({}, change({ state: [entry, firstErr] }))).join()).toMatch(/transition 1: pkg\/cb\.go: the file has patch text/);
  });

  it("bounds an entry, needs a transition or a read, and refuses an empty part or a repeated name", () => {
    const empty: StateEntry = { name: "stored", scope: "", initial: "0", transitions: [], reads: [] };
    expect(problems(report({}, change({ state: [empty, firstErr] }))).join()).toMatch(/state 1: the scope is empty[\s\S]*state 1: no transitions and no reads/);
    expect(problems(report({}, change({ state: [stored, stored, firstErr] }))).join()).toMatch(/"stored" appears twice in this item/);
    expect(problems(report({}, change({ behavior: [{ case: "c", before: "", after: "x".repeat(241) }] }))).join()).toMatch(/behavior 1: before is empty[\s\S]*behavior 1: after is 241 characters, more than 240/);
    expect(problems(report({}, change({ behavior: Array.from({ length: 9 }, () => ({ case: "c", before: "b", after: "a" })) }))).join()).toMatch(/9 behavior rows, more than 8/);
  });

  it("lets an item with no new state and no behavior change leave both empty", () => {
    expect(problems(report({}, change({ state: [], behavior: [] })), { ...ctx, candidates: [] })).toEqual([]);
  });
});

describe("citations always read as path:line", () => {
  const w = [goFile, changelog, file("logo.png", "modified", null)];
  it("resolves a symbol alone to the lines that mention it, and a whole file to its changed lines", () => {
    expect(citedLines({ path: "pkg/cb.go", side: "head", start: 0, end: 0, symbol: "stored++" }, w)).toEqual({ start: find("stored++"), end: find("stored++"), side: "head" });
    expect(citeLabel({ path: "pkg/cb.go", side: "head", start: 0, end: 0, symbol: "firstErr" }, w)).toBe(`pkg/cb.go:${find("var firstErr")}-${find("return failure")}`);
    expect(citeLabel({ path: "CHANGES.md", side: "head", start: 0, end: 0, symbol: "" }, w)).toBe("CHANGES.md:4");
  });

  it("keeps the tree a resolved range belongs to: a whole-file cite of a file that only deletes lines reads as base lines", () => {
    const shrunk = file("a.ts", "modified", "@@ -1,3 +1,1 @@\n keep\n-oldA\n-oldB");
    expect(citeLabel({ path: "a.ts", side: "head", start: 0, end: 0, symbol: "" }, [shrunk])).toBe("a.ts:2-3 (base)");
  });

  it("renders a file with no patch text as the path alone, never as a path and a colon", () => {
    expect(citeLabel({ path: "logo.png", side: "head", start: 0, end: 0, symbol: "" }, w)).toBe("logo.png");
    expect(citeLabel({ path: "pkg/cb.go", side: "head", start: 12, end: 12, symbol: "" }, w)).toBe("pkg/cb.go:12");
    expect(citeLabel({ path: "pkg/cb.go", side: "base", start: 12, end: 14, symbol: "" }, w)).toBe("pkg/cb.go:12-14 (base)");
  });

  it("renders a plugin-written whole-file citation with its hunk range", () => {
    const final = assembleReport(report(), new Map(["R2"].map((id) => [id, "unsupported"] as const)), ctx);
    const text = renderReport(final, { owner: "o", repo: "r", number: 1, head: "h", title: "t", files, commits: 1, checks: [] });
    expect(text).toContain("CHANGES.md changed (+3 −0 lines); not summarised — CHANGES.md:4");
    expect(text).not.toMatch(/[\w/]+\.(?:go|md):(?=[\s,)]|$)/m);
  });
});

describe("the claim targets and their reading", () => {
  it("makes a claim of the purpose, the overview, each item, each entry with each of its steps, and each behavior row", () => {
    expect(claimTargets(report(), { sections }).map((t) => t.id)).toEqual(["purpose", "overview", "R1", "R1.s1", "R1.s1.t1", "R1.s1.r1", "R1.s2", "R1.s2.t1", "R1.s2.r1", "R1.b1", "R2", "W1"]);
  });

  it("lets a stated purpose stand without a diff quote (its own quote was matched against the pull request's text), and an inferred one needs one", () => {
    const quiet = { verdicts: [{ item: "purpose", verdict: "supported", note: "", quotes: [] }] };
    const stated = claimTargets(report(), { sections }).filter((t) => t.id === "purpose");
    expect([...(readClaimCheck(quiet, stated, files) as { supported: Set<string> }).supported]).toEqual(["purpose"]);
    const inferred = claimTargets(report({ purpose: { text: "x", source: "inferred", quote: "" } }), { sections }).filter((t) => t.id === "purpose");
    expect((readClaimCheck(quiet, inferred, files) as { weak: Map<string, string> }).weak.get("purpose")).toBe("supported without a quote");
  });

  it("matches a transition's quote only in the file it cites, and a behavior row's in any file", () => {
    const targets = claimTargets(report(), { sections });
    const quote = { path: "pkg/cb.go", line: find("stored++"), text: "stored++" };
    const long = { path: "pkg/cb.go", line: find("firstErr = err"), text: "firstErr = err" };
    const verdicts = targets.map((t) => ({ item: t.id, verdict: "supported", note: "", quotes: [t.id === "R1.s1.t1" ? { ...quote, text: "stored++ line" } : t.id === "R1.b1" ? long : t.id === "R1.s2.t1" ? long : { path: "CHANGES.md", line: 4, text: "reply with an error" }] }));
    const r = readClaimCheck({ verdicts }, targets, files) as { weak: Map<string, string>; supported: Set<string> };
    expect(r.weak.get("R1.s1.t1")).toMatch(/do not match/);
    expect(r.supported.has("R1.b1")).toBe(true);
    expect(r.supported.has("R1.s2.t1")).toBe(true);
    // The transition cites pkg/cb.go; a quote of CHANGES.md does not support it.
    expect(r.weak.get("R1.s2.r1")).toMatch(/do not match/);
  });
});

describe("what the claim check removes: the item stays, the entry or row goes, and it is recorded", () => {
  const header = { owner: "o", repo: "r", number: 1, head: "h", title: "t", files, commits: 1, checks: [] };
  const feature = (final: FinalReport) => final.sections.find((s) => s.id === "features")!.items[0]!;

  it("drops a whole lifecycle entry when it, or any of its transitions or reads, is unsupported", () => {
    const final = assembleReport(report(), new Map([["R1.s2.t1", "unsupported: firstErr is also set by a later line"]]), ctx);
    expect(feature(final).state.map((e) => e.name)).toEqual(["stored"]);
    expect(final.removedParts).toEqual([{ id: "R1.s2.t1", kind: "state", item: "R1", label: "firstErr", reason: "unsupported: firstErr is also set by a later line" }]);
    expect(final.removed).toEqual([]);
    const text = renderReport(final, header);
    expect(text).toContain("Removed by the claim check: the lifecycle of `firstErr` (unsupported: firstErr is also set by a later line).");
    expect(reportProblems(asReporterOutput(final), ctx, { final: true })).toEqual([]);
  });

  it("drops a behavior row and keeps the rest", () => {
    const two = change({ behavior: [{ case: "every event fails", before: "success", after: "an error" }, { case: "some succeed", before: "success", after: "success" }] });
    const final = assembleReport(report({}, two), new Map([["R1.b2", "partial: the second case is not shown"]]), ctx);
    expect(feature(final).behavior.map((b) => b.case)).toEqual(["every event fails"]);
    expect(final.removedParts[0]).toMatchObject({ id: "R1.b2", kind: "behavior", item: "R1", label: "some succeed" });
    expect(renderReport(final, header)).toContain('Removed by the claim check: the before/after row "some succeed"');
  });

  it("removes an item whole when the item itself is unsupported, without recording its parts separately", () => {
    const final = assembleReport(report(), new Map([["R1", "unsupported"], ["R1.s1.t1", "unsupported"]]), ctx);
    expect(final.removed.map((r) => r.id)).toEqual(["R1"]);
    expect(final.removedParts).toEqual([]);
  });

  it("states when the purpose or the overview could not be supported, instead of showing it", () => {
    const final = assembleReport(report(), new Map([["purpose", "unsupported: the title says otherwise"], ["overview", "partial: names a mechanism no item has"]]), ctx);
    expect(final.summary).toEqual({ purpose: null, overview: null });
    expect(final.removedParts.map((p) => [p.id, p.kind])).toEqual([["purpose", "purpose"], ["overview", "overview"]]);
    const text = renderReport(final, header);
    expect(purposeLine(final.summary, final.removedParts)).toContain("**Purpose:** not given: the claim check could not support it (unsupported: the title says otherwise).");
    expect(text).toContain("**Overview:** not given: the claim check could not support it (partial: names a mechanism no item has).");
  });

  it("keeps the coverage the template asks: every changed file stays cited when the item that cited it goes", () => {
    const final = assembleReport(report(), new Map([["R1", "unsupported"]]), ctx);
    expect(reportProblems(asReporterOutput(final), ctx, { final: true })).toEqual([]);
    expect(final.sections.find((s) => s.id === "other")!.items.some((i) => i.auto === "coverage" && i.cites[0]!.path === "pkg/cb.go")).toBe(true);
  });
});

describe("the state-lifecycle scenario: a #1443-like change is one analysed item", () => {
  const sim = simulate({ scenarioName: "state-lifecycle" });
  const json = JSON.parse(sim.written!.json) as {
    summary: { purpose: { source: string; quote: string }; overview: string };
    sections: Array<{ id: string; none: boolean; items: ReportItem[] }>;
    removedParts: unknown[];
  };
  const items = json.sections.flatMap((s) => s.items.map((i) => ({ section: s.id, ...i })));

  it("reaches answers accepted, with the checker judging every claim, the lifecycle entries and the behavior rows included", () => {
    expect(sim.final.action).toMatchObject({ type: "stop", stop: { reason: "answers accepted" } });
    const check = assignmentOf(jobsOf(sim, "Check the report's")[0]!);
    for (const id of ["purpose", "overview", "R1 ", "R1.s1 ", "R1.s1.t1 ", "R1.s1.r1 ", "R1.s2 ", "R1.s2.t3 ", "R1.b1 ", "R1.b3 "]) expect(check).toContain(`\n${id}`);
    expect(json.removedParts).toEqual([]);
  });

  it("collapses the declarations, the three failure paths, the increment and the reply into ONE item, beside the changelog entry", () => {
    expect(items.map((i) => i.section)).toEqual(["features", "other"]);
    const [one] = items;
    expect(one!.cites).toHaveLength(STREAM_CHANGED.length);
    expect(one!.cites.every((c) => c.path === STREAM_PATH && c.start >= 1)).toBe(true);
    expect(one!.text).not.toMatch(/^Adds|^Declares/);
  });

  it("gives stored and firstErr each a lifecycle: initial value, every transition, the one read", () => {
    const [one] = items;
    expect(one!.state.map((s) => [s.name, s.scope, s.transitions.length, s.reads.length])).toEqual([["stored", "per call", 1, 1], ["firstErr", "per call", 3, 1]]);
    expect(one!.state[0]!.initial).toMatch(/^0/);
    expect(one!.state[0]!.transitions[0]!.when).toBe("w.handle returns no error for an event");
    expect(one!.state[0]!.reads[0]!.decision).toMatch(/stored == 0 && firstErr != nil/);
    expect(one!.state[1]!.initial).toMatch(/^nil/);
    expect(one!.state[1]!.transitions.map((t) => t.when)).toEqual(["proto.Unmarshal of a []byte event fails", "an event has an unsupported type", "w.handle returns an error"]);
  });

  it("gives the three-row before/after table", () => {
    const [one] = items;
    expect(one!.behavior).toHaveLength(3);
    expect(one!.behavior.map((b) => b.case)).toEqual(["every event of the batch fails", "some events are stored and some fail", "flushing the groups fails after events were stored"]);
  });

  it("renders the summary, the lifecycle block, the table and path:line citations in review.md", () => {
    const md = sim.written!.markdown;
    expect(md).toContain('**Purpose** (stated: "replies with the first error when nothing was stored")');
    expect(md).toContain("- State `stored` (per call); starts: 0, set at the start of the Rev call before the event loop");
    expect(md).toMatch(/    - when w\.handle returns no error for an event → increments by one; every failure path continues before it \(banyand\/stream\/write_standalone\.go:\d+\)/);
    expect(md).toMatch(/    - read once, after the groups are flushed: stored == 0 && firstErr != nil switches the reply from success to an INTERNAL_ERROR carrying firstErr \(banyand\/stream\/write_standalone\.go:\d+\)/);
    expect(md).toContain("    | Case | Before | After |");
    expect(md).toContain("    | every event of the batch fails | the empty success reply | an INTERNAL_ERROR reply with the original message ID and the first error |");
    expect(md).toContain("    | some events are stored and some fail | the empty success reply | the empty success reply (unchanged) |");
    expect(md).toMatch(/Adds a changelog entry for the fix\. — CHANGES\.md:\d+$/m);
    const report = md.slice(md.indexOf("# Report"), md.indexOf("# Measurements"));
    expect(report).not.toMatch(/[\w/]+\.(?:go|md):(?=[\s,)]|$)/m);
    expect(report).toMatch(/write_standalone\.go:\d+-\d+/);
  });

  it("states the purpose as stated, with a quote that is in the pull request's body", () => {
    expect(json.summary.purpose).toMatchObject({ source: "stated", quote: "replies with the first error when nothing was stored" });
    expect(json.summary.overview.split(/\.\s/).length).toBeLessThanOrEqual(4);
  });

  it("drops only the unsupported lifecycle entry after one revision, and keeps the item", () => {
    const flawed = scenarioWith("state-lifecycle", (s) => {
      const unsupported = (reply: { output?: unknown }): void => {
        const verdicts = (reply.output as { verdicts: Array<{ item: string; verdict: string; note: string; quotes: unknown[] }> }).verdicts;
        const v = verdicts.find((x) => x.item === "R1.s2.t2")!;
        v.verdict = "unsupported";
        v.note = "the unsupported-type path sets firstErr unconditionally";
        v.quotes = [];
      };
      const checks = s.results["claim-check-v1"]!;
      for (const reply of checks) unsupported(reply as { output?: unknown });
      s.results["change-report-revision-v1"] = [{ output: (s.results["change-report-v1"]![0] as { output: unknown }).output }];
      s.results["claim-check-v1"] = [checks[0]!, checks[0]!];
    });
    const out = simulate({ scenario: flawed });
    expect(jobsOf(out, "Write the change report")).toHaveLength(2);
    expect(assignmentOf(jobsOf(out, "Write the change report")[1]!)).toMatch(/R1\.s2\.t2: "firstErr changes when an event has an unsupported type.*the claim check: unsupported: the unsupported-type path/);
    const written = JSON.parse(out.written!.json) as { sections: Array<{ id: string; items: Array<{ state: Array<{ name: string }>; behavior: unknown[] }> }>; removedParts: Array<{ id: string; kind: string; label: string }> };
    const kept = written.sections.find((s) => s.id === "features")!.items[0]!;
    expect(kept.state.map((s) => s.name)).toEqual(["stored"]);
    expect(kept.behavior).toHaveLength(3);
    expect(written.removedParts).toEqual([{ id: "R1.s2.t2", kind: "state", item: "R1", label: "firstErr", reason: "unsupported: the unsupported-type path sets firstErr unconditionally" }]);
    expect(out.written!.markdown).toContain("Removed by the claim check: the lifecycle of `firstErr`");
    expect(out.final.action).toMatchObject({ type: "stop", stop: { reason: "answers accepted" } });
  });

  it("asks the reporter for the analysis: one item per conceptual change, lifecycle, before/after, and the state the scan found", () => {
    const prompt = assignmentOf(jobsOf(sim, "Write the change report")[0]!);
    expect(prompt).toMatch(/Analyse the change, do not narrate the diff/);
    expect(prompt).toMatch(/One item per conceptual change/);
    expect(prompt).toMatch(/Do not split one mechanism across items/);
    expect(prompt).toMatch(/stored \(banyand\/stream\/write_standalone\.go:\d+, declared, changed at line \d+\); firstErr/);
    expect(prompt).toMatch(/a cite is rendered as path:start-end/);
  });
});
