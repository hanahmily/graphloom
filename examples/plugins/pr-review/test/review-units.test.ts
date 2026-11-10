// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { effectiveRules, ruleFileText, ruleGroups, shippedRules } from "../src/aspects.js";
import { anchored, clusters, composeDraft, draftMarkdown, scrub, type DraftInput } from "../src/draft.js";
import { chooseScope } from "../src/reviewscope.js";
import { keptSuggestion, parsePass, parseVerification, type AspectRecord, type Finding } from "../src/review.js";
import { proofOf } from "../src/proof.js";
import type { Partition } from "../src/areas.js";
import type { PullFile } from "../src/snapshot.js";
import { parsePatch } from "../src/patch.js";

const file = (path: string, patch: string | null = "@@ -1,2 +1,3 @@\n a\n+b\n c"): PullFile => ({ path, status: "modified", previousPath: null, additions: 1, deletions: 0, patch, patchOmitted: patch === null, parsed: parsePatch(patch) });

describe("the files in scope", () => {
  const files = ["a/x.go", "a/y.go", "b/z.go", "c/w.go", "gen/g.go"].map((p) => file(p));
  const partition: Partition = {
    areas: [
      { id: "A1", name: "a", paths: ["a/x.go", "a/y.go"], bytes: 10, kind: "read" },
      { id: "A2", name: "b", paths: ["b/z.go"], bytes: 10, kind: "read" },
      { id: "A3", name: "c", paths: ["c/w.go"], bytes: 10, kind: "read" },
      { id: "generated", name: "generated", paths: ["gen/g.go"], bytes: 10, kind: "generated" },
    ],
    omitted: [],
  };
  const large = { mode: "large" as const, reasons: [] };
  const bullet = (path: string) => ({ text: "x", cites: [{ path, side: "head" as const, start: 1, end: 1, symbol: "" }] });
  const check = (over: Partial<Record<"risks" | "behavior" | "compatibility", Array<ReturnType<typeof bullet>>>> = {}) => ({ risks: [], behavior: [], compatibility: [], ...over });

  it("is the whole pull request in standard mode", () => {
    expect(chooseScope({ mode: { mode: "standard", reasons: [] }, files, check: check() })).toEqual({ mode: "standard", source: "whole", areas: [], files: files.map((f) => f.path) });
  });

  it("is, in large mode, the areas that the risks, behavior and compatibility entries cite", () => {
    const s = chooseScope({ mode: large, files, partition, check: check({ risks: [bullet("b/z.go")], compatibility: [bullet("c/w.go")], behavior: [bullet("b/z.go")] }) });
    expect(s).toMatchObject({ source: "default", files: ["b/z.go", "c/w.go"], areas: [{ id: "A2" }, { id: "A3" }] });
  });

  it("is every readable area when the briefing cites none, never the generated files, and says so", () => {
    expect(chooseScope({ mode: large, files, partition, check: check() })).toEqual({ mode: "large", source: "all-areas", areas: [{ id: "A1", name: "a", files: 2 }, { id: "A2", name: "b", files: 1 }, { id: "A3", name: "c", files: 1 }], files: ["a/x.go", "a/y.go", "b/z.go", "c/w.go"] });
  });
});

describe("the aspects' rule files", () => {
  it("ship one entry per language glob and a final **, in the format ocr honors", () => {
    expect(shippedRules("security").map((r) => r.path)).toEqual(["**/*.go", "**/*.ts", "**/*.tsx", "**"]);
    const doc = JSON.parse(ruleFileText("correctness")) as { merge_system_rule: boolean; rules: Array<{ path: string; rule: string }> };
    expect(doc.merge_system_rule).toBe(false);
    expect(doc.rules[0]!.rule).toMatch(/^Aspect: correctness\. Go code: review only this:.*Out of scope:.*A finding outside the correctness aspect is left out\.$/);
  });

  it("take a profile's entries over the shipped ones: the same path replaces, a new one comes before every shipped one", () => {
    const rules = effectiveRules("security", [{ path: "**/*.go", rule: "Aspect: security. Go: only unsafe." }, { path: "**/*.proto", rule: "Aspect: security. Proto." }]);
    expect(rules.map((r) => r.path)).toEqual(["**/*.proto", "**/*.go", "**/*.ts", "**/*.tsx", "**"]);
    expect(rules[1]!.rule).toBe("Aspect: security. Go: only unsafe.");
  });

  it("let a path-specific profile rule win over the shipped language glob that also matches the file", () => {
    const text = ruleFileText("security", [{ path: "src/auth/**", rule: "Aspect: security. Auth code: review sessions and tokens only." }]);
    const g = ruleGroups(text, ["src/auth/login.ts", "src/util/x.ts"]);
    expect(g.state === "ok" && g.groups.map((x) => [x.path, x.files])).toEqual([["src/auth/**", ["src/auth/login.ts"]], ["**/*.ts", ["src/util/x.ts"]]]);
  });

  it("resolve every file of the scope to one entry, and fail on a rule file that is not a custom one or leaves a file unmatched", () => {
    const g = ruleGroups(ruleFileText("maintainability"), ["a/x.go", "web/app.tsx", "docs/readme.md", "top.go"]);
    expect(g.state === "ok" && g.groups.map((x) => [x.path, x.files])).toEqual([["**/*.go", ["a/x.go", "top.go"]], ["**/*.tsx", ["web/app.tsx"]], ["**", ["docs/readme.md"]]]);
    expect(ruleGroups(JSON.stringify({ rules: [{ path: "**", rule: "x" }] }), ["a"])).toMatchObject({ state: "failed", problems: [expect.stringMatching(/not a custom rule file/)] });
    expect(ruleGroups(JSON.stringify({ merge_system_rule: false, rules: [{ path: "**/*.go", rule: "x" }] }), ["a.md"])).toMatchObject({ state: "failed", problems: [expect.stringMatching(/fall under no rule: a\.md/)] });
    expect(ruleGroups(JSON.stringify({ merge_system_rule: false, rules: [{ pattern: "**", content: "x" }] }), ["a"])).toMatchObject({ state: "failed" });
    expect(ruleGroups("not json", ["a"])).toMatchObject({ state: "failed" });
  });
});

describe("the findings contract", () => {
  const scope = new Set(["pkg/a.go", "pkg/b.go"]);
  const known = new Set(["F1"]);
  const comment = { path: "pkg/a.go", side: "RIGHT", start_line: 3, end_line: 5, aspect: "correctness", kind: "behavioral", severity: "P1", content: "wrong", suggestion: "", finding: "", evidence: "read it", distinct: false };
  const summary = { total_files: 2, reviewed_files: 2, skipped: [] };
  const read = (comments: unknown[], s: unknown = summary) => parsePass({ comments, summary: s }, { aspect: "correctness", scope, known });

  it("accepts a well-formed pass", () => {
    expect(read([comment])).toMatchObject({ comments: [{ path: "pkg/a.go" }] });
    expect(read([])).toMatchObject({ comments: [] });
    expect(read([{ ...comment, finding: "F1" }])).toMatchObject({ comments: [{ finding: "F1" }] });
  });

  it("names every problem: a file out of scope, a bad range, a correctness comment that is not behavioral, an unknown finding", () => {
    const r = read([{ ...comment, path: "pkg/zzz.go" }, { ...comment, start_line: 9, end_line: 3 }, { ...comment, kind: "non-behavioral" }, { ...comment, finding: "F9" }, { ...comment, severity: "P7" }]);
    expect(r).toMatchObject({ problems: expect.arrayContaining([expect.stringMatching(/comments\[0\]\.path.*not a file in the review's scope/), expect.stringMatching(/comments\[1\] needs 1 <= start_line/), expect.stringMatching(/comments\[2\]: a correctness finding is behavioral/), expect.stringMatching(/comments\[3\]\.finding/), expect.stringMatching(/comments\[4\]\.severity/)]) });
  });

  it("requires every file of the scope reviewed and none skipped", () => {
    expect(read([], { total_files: 1, reviewed_files: 1, skipped: [] })).toMatchObject({ problems: [expect.stringMatching(/every one of the 2 file/)] });
    expect(read([], { total_files: 2, reviewed_files: 2, skipped: [{ path: "pkg/b.go", reason: "big" }] })).toMatchObject({ problems: [expect.stringMatching(/skip none/)] });
  });

  it("reads a verifier's verdicts and ignores a finding it was not asked about", () => {
    const v = { finding: "F1", verdict: "confirmed", kind: "behavioral", witness: "pkg/a.go:4", quotes: [], reason: "yes", fixes: false };
    const r = parseVerification({ verdicts: [v, { ...v, finding: "F7" }] }, new Set(["F1", "F2"]));
    expect("verdicts" in r && [...r.verdicts.keys(), r.ignored]).toEqual(["F1", ["F7"]]);
    expect(parseVerification({ verdicts: [{ ...v, verdict: "maybe" }] }, new Set(["F1"]))).toMatchObject({ problems: [expect.stringMatching(/verdict must be/)] });
  });
});

const finding = (over: Partial<Finding>): Finding => ({ id: "F1", aspect: "correctness", raisedBy: "correctness", pass: 1, path: "pkg/a.go", side: "RIGHT", startLine: 2, endLine: 3, severity: "P1", kind: "non-behavioral", content: "text", suggestion: "", evidence: "", distinct: false, state: "confirmed", reaffirmed: [], notes: [], verdict: { verdict: "confirmed", kind: "non-behavioral", witness: "pkg/a.go:2", quotes: [], reason: "yes", fixes: true }, ...over });

describe("a suggestion is kept only when it can be posted", () => {
  it("needs a confirmation, the verifier's fixes, the RIGHT side and at most 20 lines", () => {
    expect(keptSuggestion(finding({ suggestion: "x := 1\n" }))).toEqual({ text: "x := 1" });
    expect(keptSuggestion(finding({ suggestion: "" }))).toBeUndefined();
    expect(keptSuggestion(finding({ suggestion: "x", side: "LEFT" }))).toMatchObject({ dropped: expect.stringContaining("base") });
    expect(keptSuggestion(finding({ suggestion: "x", verdict: { verdict: "confirmed", kind: "non-behavioral", witness: "a:1", quotes: [], reason: "", fixes: false } }))).toMatchObject({ dropped: expect.stringContaining("did not say") });
    expect(keptSuggestion(finding({ suggestion: Array.from({ length: 21 }, () => "l").join("\n") }))).toMatchObject({ dropped: expect.stringContaining("21 lines") });
    expect(keptSuggestion(finding({ suggestion: "x", state: "disputed", verdict: { verdict: "uncertain", kind: "non-behavioral", witness: "", quotes: [], reason: "", fixes: true } }))).toMatchObject({ dropped: expect.any(String) });
  });
});

describe("the proof of a finding is the one place the reproducing tests plug in", () => {
  it("makes a behavioral finding unproven, with the reason, and a non-behavioral one need no test", () => {
    expect(proofOf({ kind: "behavioral" })).toEqual({ state: "unproven", reason: "no test" });
    expect(proofOf({ kind: "non-behavioral" })).toEqual({ state: "non-behavioral" });
    expect(proofOf({ kind: "behavioral", proof: { state: "unproven", reason: "test does not fail" } })).toEqual({ state: "unproven", reason: "test does not fail" });
    const record = { language: "go" as const, dir: "pkg", name: "TestX", expect: "assertion" as const, sha256: "0".repeat(64), runs: ["failed" as const, "failed" as const] };
    expect(proofOf({ kind: "behavioral", proof: { state: "proven", record } })).toEqual({ state: "proven", summary: "proven by a failing test the graph ran (TestX)" });
  });
});

describe("the draft", () => {
  const files = [file("pkg/a.go", "@@ -1,3 +1,6 @@\n a\n+b\n+c\n+d\n+e\n f"), file("docs/x.md", null)];
  const record = (aspect: AspectRecord["aspect"], findings: Finding[], extra: Partial<AspectRecord> = {}): AspectRecord => ({ schema: "pr-review-aspect-v1", aspect, reviewer: "claude-code", verifier: "codex", context: { kind: "seeded", reason: "forking is not available in this version" }, scopeFiles: 2, passes: [{ n: 1, reviewed: 2, raised: findings.map((f) => f.id), reaffirmed: [], nits: 0, merged: 0 }], findings, unsaturated: false, ...extra });
  const scope = { schema: "pr-review-scope-v1" as const, mode: "standard" as const, source: "whole" as const, areas: [], files: ["pkg/a.go", "docs/x.md"], base: { kind: "answerer" as const, stageId: "answers", sessionRef: "claude-job", chain: [] }, context: { kind: "seeded" as const, reason: "forking is not available in this version" }, summary: { sha256: "x", bytes: 0, cuts: 0, turns: 0 }, harnesses: {} };
  const input = (records: AspectRecord[], extra: Partial<DraftInput> = {}): DraftInput => ({ pull: { owner: "o", repo: "r", number: 7 }, head: "a".repeat(40), files, scope, records, ...extra });

  it("links confirmed findings of different aspects on overlapping lines into one entry, listing every aspect, under the first", () => {
    const a = finding({ id: "F1", aspect: "maintainability", raisedBy: "maintainability", startLine: 2, endLine: 4, severity: "P2" });
    const b = finding({ id: "F2", aspect: "correctness", raisedBy: "correctness", startLine: 3, endLine: 5, severity: "P1", kind: "non-behavioral" });
    const c = finding({ id: "F3", aspect: "security", raisedBy: "security", startLine: 3, endLine: 4, distinct: true });
    expect(clusters([a, b, c]).map((g) => g.map((f) => f.id))).toEqual([["F2", "F1"], ["F3"]]);
    const d = composeDraft(input([record("correctness", [b]), record("maintainability", [a]), record("security", [c])]));
    const merged = d.comments.find((e) => e.id === "F2")!;
    expect(merged).toMatchObject({ aspects: ["correctness", "maintainability"], linked: ["F1"], severity: "P2" });
    expect(d.comments.map((e) => e.id)).toEqual(["F2", "F3"]);
  });

  it("drafts a non-behavioral finding at most as P2 and lists behavioral and disputed ones for judgment with their reasons", () => {
    const nb = finding({ id: "F1", severity: "P0", kind: "non-behavioral", aspect: "maintainability", raisedBy: "maintainability" });
    const bh = finding({ id: "F2", severity: "P0", kind: "behavioral", startLine: 5, endLine: 6 });
    const dis = finding({ id: "F3", state: "disputed", notes: ["the verifier could not decide"], kind: "behavioral", startLine: 40, endLine: 41 });
    const d = composeDraft(input([record("correctness", [bh, dis]), record("maintainability", [nb])]));
    expect(d.comments.map((e) => [e.id, e.severity, e.proof?.state])).toEqual([["F1", "P2", "non-behavioral"]]);
    expect(d.judgment.map((e) => [e.id, e.reason])).toEqual([["F2", "unproven: no test"], ["F3", "disputed: the verifier could not decide"]]);
    expect(d.judgment[0]!.severity).toBe("P2");
    expect(d.recommended).toBe("comment");
  });

  it("recommends approve when nothing is open and drafts it as comment", () => {
    const d = composeDraft(input([record("correctness", []), record("maintainability", []), record("security", [])]));
    expect(d.recommended).toBe("approve");
    expect(d.verdict).toBe("comment");
    expect(draftMarkdown(d)).toContain("Verdict: comment        <!-- recommended: approve -->");
    expect(d.summary.length).toBeLessThanOrEqual(1_200);
  });

  it("takes the Q&A items: needs author is a pre-selected comment, the rest is not selected", () => {
    const qa = {
      symbols: [{ id: "S1", path: "pkg/a.go", startLine: 2, endLine: 5 }],
      questions: [
        { id: "N1", type: "necessity", text: "necessary?", answer: { answer: "yes", status: "answered" } },
        { id: "Q1", type: "missing-test", symbol: "S1", text: "Which test covers ParseTTL?", answer: { answer: "none found in pkg/a_test.go", status: "needs author" } },
        { id: "Q2", type: "split-function", symbol: "S1", text: "Split it?", answer: { answer: "split at 18", status: "answered" } },
      ],
    };
    const d = composeDraft(input([record("correctness", [])], { qa }));
    expect(d.comments.map((e) => [e.id, e.kind, e.anchored])).toEqual([["Q1", "question", true]]);
    expect(d.notSelected.map((e) => e.id)).toEqual(["Q2"]);
    expect(d.recommended).toBe("comment");
    const md = draftMarkdown(d);
    expect(md).toContain("### Questions\n#### Q1 · question · pkg/a.go:2 · RIGHT");
    expect(md).toContain("## Not selected (move an entry into Comments to post it)\n### Q2");
  });

  it("anchors a comment only inside a hunk on its side, and keeps the review's own bookkeeping out of a body", () => {
    expect(anchored(files[0], "RIGHT", 2, 4)).toBe(true);
    expect(anchored(files[0], "RIGHT", 2, 40)).toBe(false);
    expect(anchored(files[1], "RIGHT", 1, 1)).toBe(false);
    expect(anchored(undefined, "RIGHT", 1, 1)).toBe(false);
    expect(scrub("see .graphloom/review/review.md:3 and `.graphloom/x`")).toBe("see [a review file]:3 and `[a review file]`");
  });

  it("renders the sections of the design: Summary, Comments by aspect, Needs your judgment, Not selected, For the maintainer", () => {
    const f1 = finding({ id: "F1", aspect: "security", raisedBy: "security", suggestion: "safe()" });
    const f2 = finding({ id: "F2", startLine: 40, endLine: 40, aspect: "maintainability", raisedBy: "maintainability" });
    const md = draftMarkdown(composeDraft(input([record("correctness", []), record("maintainability", [f2]), record("security", [f1])])));
    for (const h of ["## Summary", "## Comments", "### Security", "### Maintainability", "## Needs your judgment", "## Not selected", "## For the maintainer (never posted)"]) expect(md).toContain(h);
    expect(md.indexOf("### Security")).toBeLessThan(md.indexOf("### Maintainability"));
    expect(md).toContain("```suggestion\nsafe()\n```");
    expect(md).toContain("not in the diff (goes in the review body)");
  });
});

describe("the findings a reviewer must not raise again", () => {
  const known = Array.from({ length: 120 }, (_, i) => finding({ id: `F${i + 1}`, content: `finding number ${i + 1} ${"x".repeat(200)}`, path: `pkg/f${i}.go` }));
  const base = { pr: { mode: "review" as const, owner: "o", repo: "r", number: 1, head: "a".repeat(40) }, snapshot: { pull: { title: "t", body: "b" }, commits: [] } as never, aspect: "correctness" as const, pass: 2, files: ["pkg/a.go"], scopeLine: "the whole pull request", groups: [], summary: "", context: { kind: "seeded" as const, reason: "x" }, feedback: [], reviewDir: "/work/tree/.graphloom/review" };

  it("lists every known finding in a file when they do not fit inline, and tells the reviewer to read it", async () => {
    const { planReviewer } = await import("../src/reviewprompts.js");
    const planned = planReviewer({ ...base, known });
    const spill = planned.spills.find((s) => s.name.startsWith("review-known-findings-"));
    expect(spill).toBeDefined();
    for (const f of known) expect(spill!.text).toContain(`${f.id} [`);
    expect(planned.text).toContain(`/work/tree/.graphloom/review/${spill!.name}`);
    expect(planned.text).toMatch(/Read that file first, and do not raise again any finding in it/);
    expect(planned.text).not.toContain("F120 [");
  });

  it("keeps a short list inline with no file", async () => {
    const { planReviewer } = await import("../src/reviewprompts.js");
    const planned = planReviewer({ ...base, known: known.slice(0, 3) });
    expect(planned.spills.filter((s) => s.name.startsWith("review-known-findings-"))).toEqual([]);
    expect(planned.text).toContain("F3 [");
  });
});

describe("a confirmation's witness", () => {
  it("is a repository path and a positive line, with or without an extension", async () => {
    const { WITNESS } = await import("../src/review.js");
    for (const ok of ["pkg/a.go:12", "Makefile:12", "Dockerfile:8", "bin/build:3", "api/v1/x.proto:1 in Write"]) expect(WITNESS.test(ok), ok).toBe(true);
    for (const bad of ["somewhere in the function", "pkg/a.go", "pkg/a.go:0", "/etc/passwd:1", "../x.go:3", "pkg/../x.go:3", ":12"]) expect(WITNESS.test(bad), bad).toBe(false);
  });
});

describe("assignment and summary bounds with very large inputs", () => {
  it("keeps the verifier's assignment within the bound for 100 long findings, all of them in the spill file", async () => {
    const { planVerifier } = await import("../src/reviewprompts.js");
    const findings = Array.from({ length: 100 }, (_, i) => ({
      id: `F${i + 1}`, aspect: "correctness", raisedBy: "correctness", pass: 1, path: "pkg/transfer/importer/apply.go", side: "RIGHT", startLine: 10 + i, endLine: 12 + i,
      severity: "P2", kind: "behavioral", content: "c".repeat(1_000), suggestion: "s".repeat(300), evidence: "e".repeat(300), distinct: true, state: "open", reaffirmed: [], notes: [],
    }));
    const planned = planVerifier({ pr: { mode: "review", owner: "o", repo: "r", number: 1, head: "h".repeat(40) } as never, snapshot: { pull: { title: "t", body: "b" }, commits: [] } as never, aspect: "correctness", pass: 1, findings: findings as never, feedback: [], reviewDir: "/review" });
    const text = (planned as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(62_000);
    expect(text).toContain("F100");
    const spilled = ((planned as { spills: Array<{ text: string }> }).spills ?? []).map((s) => s.text).join("\n");
    for (const f of findings) expect(spilled).toContain(`${f.id} [`);
  });
});
