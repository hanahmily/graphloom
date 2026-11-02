// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { effectiveRules, ruleFileText, ruleGroups, shippedRules } from "../src/aspects.js";
import { anchored, clusters, composeDraft, draftMarkdown, scrub, type DraftInput } from "../src/draft.js";
import { parseAreasInput, chooseScope, conversationSummary, cutBytes, seedReason, selectBase, SEED_MAX_BYTES, type Conversation } from "../src/reviewscope.js";
import { keptSuggestion, parsePass, parseVerification, type AspectRecord, type Finding } from "../src/review.js";
import { proofOf } from "../src/proof.js";
import type { Partition } from "../src/areas.js";
import type { PullFile } from "../src/snapshot.js";
import { parsePatch } from "../src/patch.js";

const file = (path: string, patch: string | null = "@@ -1,2 +1,3 @@\n a\n+b\n c"): PullFile => ({ path, status: "modified", previousPath: null, additions: 1, deletions: 0, patch, patchOmitted: patch === null, parsed: parsePatch(patch) });

const turn = (operator: string, answer?: string) => ({ operator, ...(answer !== undefined ? { answer } : {}) });
const conversation = (turns: Conversation["turns"], over: Partial<Conversation> = {}): Conversation => ({ ref: "e1", stageId: "answers", baseSession: "claude-job", forkSession: "claude-c1", endedAt: "2026-10-30T10:00:00.000Z", contextTokens: 1000, transcriptOmitted: false, turns, ...over });

describe("the conversation summary", () => {
  it("keeps each maintainer message verbatim and cuts each agent answer to 1 KiB, marked", () => {
    const long = "a".repeat(3_000);
    const s = conversationSummary([conversation([turn("A ttl of 0 must mean no expiry.", long), turn("And the flag?", "short")])]);
    expect(s.text).toContain("Maintainer: A ttl of 0 must mean no expiry.");
    expect(s.text).toContain("Agent: short");
    const agent = s.text.split("\n").find((l) => l.startsWith("Agent: a"))!;
    expect(Buffer.byteLength(agent.slice("Agent: ".length), "utf8")).toBeLessThanOrEqual(1_024);
    expect(agent.endsWith("… [cut]")).toBe(true);
    expect(s).toMatchObject({ cuts: 1, turns: 2 });
  });

  it("lists the conversations of the chain oldest first", () => {
    const s = conversationSummary([conversation([turn("first question")], { endedAt: "2026-10-30T09:00:00.000Z" }), conversation([turn("second question")], { endedAt: "2026-10-30T10:00:00.000Z" })]);
    expect(s.text.indexOf("Conversation 1")).toBeLessThan(s.text.indexOf("first question"));
    expect(s.text.indexOf("first question")).toBeLessThan(s.text.indexOf("Conversation 2"));
    expect(s.text.indexOf("Conversation 2")).toBeLessThan(s.text.indexOf("second question"));
  });

  it("is at most 32 KiB: the oldest agent answers go first, the maintainer's messages are cut last, every cut marked", () => {
    const turns = Array.from({ length: 60 }, (_, i) => turn(`message ${i} ${"m".repeat(300)}`, "x".repeat(900)));
    const s = conversationSummary([conversation(turns)]);
    expect(s.bytes).toBeLessThanOrEqual(SEED_MAX_BYTES);
    const lines = s.text.split("\n");
    const agents = lines.filter((l) => l.startsWith("Agent: "));
    // The oldest answers are the cut markers; the newest are whole.
    expect(agents[0]).toBe("Agent: … [cut]");
    expect(agents.at(-1)).toBe(`Agent: ${"x".repeat(900)}`);
    // Every maintainer message is still whole: the answers alone made room.
    expect(lines.filter((l) => l.startsWith("Maintainer: ")).every((l) => l.length > 300)).toBe(true);
    expect(s.cuts).toBeGreaterThan(0);
  });

  it("cuts maintainer messages, oldest first, only when the answers' cuts are not enough, and then leaves out whole turns", () => {
    const big = Array.from({ length: 12 }, (_, i) => turn(`m${i} ${"q".repeat(4_000)}`, "a"));
    const s = conversationSummary([conversation(big)]);
    expect(s.bytes).toBeLessThanOrEqual(SEED_MAX_BYTES);
    const maint = s.text.split("\n").filter((l) => l.startsWith("Maintainer: "));
    expect(maint.some((l) => l.endsWith("… [cut]"))).toBe(true);
    // The newest messages are not cut before the oldest.
    expect(maint.at(-1)!.endsWith("… [cut]")).toBe(false);
    const many = Array.from({ length: 3_000 }, (_, i) => turn(`message number ${i} ${"z".repeat(100)}`));
    const t = conversationSummary([conversation(many)]);
    expect(t.bytes).toBeLessThanOrEqual(SEED_MAX_BYTES);
    expect(t.text).toMatch(/\(\d+ older turns? of the conversation left out/);
    expect(t.text).toContain("message number 2999");
  });

  it("is empty without a conversation and does not split a character", () => {
    expect(conversationSummary([])).toEqual({ text: "", bytes: 0, cuts: 0, turns: 0 });
    const cut = cutBytes("é".repeat(600), 1_024);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(1_024);
    expect(cut.endsWith("… [cut]")).toBe(true);
    expect(cut).not.toContain("�");
  });
});

describe("the review base session", () => {
  const conv = (forkSession: string, endedAt: string, stageId = "answers", baseSession = "claude-job"): { ref: string; kind: "other"; payload: unknown } => ({
    ref: `ev-${forkSession}`,
    kind: "other",
    payload: { type: "operator-conversation", stageId, baseSession, rootSession: "claude-job", forkSession, harness: "claude-code", startedAt: endedAt, endedAt, transcript: { sha256: "x", bytes: 1 }, contextTokens: 5_000, turns: [turn("hello")] },
  });
  const job = { operationId: "op-answerer", stageId: "answers", attempt: 1, generation: 1, dispatchKey: "answerer", executorId: "x", status: "ok" as const, sessionRef: "claude-job", settledAt: "2026-10-30T08:00:00.000Z" };

  it("is the latest operator conversation of the Answers stage by endedAt, and records its chain", () => {
    const evidence = [conv("claude-c1", "2026-10-30T09:00:00.000Z"), conv("claude-c2", "2026-10-30T10:00:00.000Z", "answers", "claude-c1"), conv("claude-other", "2026-10-30T11:00:00.000Z", "questions")];
    const sessions = [job, { ...job, operationId: "conv-2", origin: "operator" as const, parent: "conv-1", sessionRef: "claude-c2", dispatchKey: "operator" }];
    const base = selectBase({ agentSessions: sessions, evidence, generation: 1 }, "answers", "answerer");
    expect(base).toMatchObject({ kind: "conversation", sessionRef: "claude-c2", operationId: "conv-2", contextTokens: 5_000, chain: ["claude-c1", "claude-c2"] });
  });

  it("is the answerer's own session without a conversation, and none without a session", () => {
    expect(selectBase({ agentSessions: [job, { ...job, operationId: "op-later", continuedFrom: "op-answerer", sessionRef: "claude-job2" }], evidence: [], generation: 1 }, "answers", "answerer")).toMatchObject({ kind: "answerer", operationId: "op-later", sessionRef: "claude-job2" });
    expect(selectBase({ agentSessions: [], evidence: [], generation: 1 }, "answers", "answerer")).toEqual({ kind: "none", stageId: "answers", chain: [] });
  });

  it("gives the reason every reviewer is seeded: the token bound when it applies, else that forking is not available", () => {
    expect(seedReason({ kind: "answerer", stageId: "answers", chain: [] }, 100_000)).toBe("forking is not available in this version");
    expect(seedReason({ kind: "conversation", stageId: "answers", contextTokens: 143_000, chain: [] }, 100_000)).toBe("base context 143,000 tokens over 100,000");
    expect(seedReason({ kind: "conversation", stageId: "answers", contextTokens: 90_000, chain: [] }, 100_000)).toBe("forking is not available in this version");
    expect(seedReason({ kind: "conversation", stageId: "answers", transcriptOmitted: true, chain: [] }, 100_000)).toMatch(/transcript was omitted/);
  });
});

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
    expect(chooseScope({ mode: { mode: "standard", reasons: [] }, files, check: check(), areasInput: "A1" })).toMatchObject({ problem: expect.stringContaining("reviewed whole") });
  });

  it("is the areas the operator picked, in large mode", () => {
    const s = chooseScope({ mode: large, files, partition, check: check(), areasInput: "A3,A1" });
    expect(s).toEqual({ mode: "large", source: "operator", areas: [{ id: "A1", name: "a", files: 2 }, { id: "A3", name: "c", files: 1 }], files: ["a/x.go", "a/y.go", "c/w.go"] });
  });

  it("is, without a list, the areas that the risks, behavior and compatibility entries cite", () => {
    const s = chooseScope({ mode: large, files, partition, check: check({ risks: [bullet("b/z.go")], compatibility: [bullet("c/w.go")], behavior: [bullet("b/z.go")] }) });
    expect(s).toMatchObject({ source: "default", files: ["b/z.go", "c/w.go"], areas: [{ id: "A2" }, { id: "A3" }] });
  });

  it("refuses a default that cites no area, an unknown or generated area, and a list that is not area ids", () => {
    expect(chooseScope({ mode: large, files, partition, check: check() })).toMatchObject({ problem: expect.stringMatching(/no default scope.*the areas are A1, A2, A3/) });
    expect(chooseScope({ mode: large, files, partition, check: check(), areasInput: "A9" })).toMatchObject({ problem: expect.stringMatching(/A9 is not an area/) });
    expect(chooseScope({ mode: large, files, partition, check: check(), areasInput: "generated" })).toMatchObject({ problem: expect.stringContaining("not a comma-separated list of area ids") });
    expect(parseAreasInput("A1, A2,A1")).toEqual(["A1", "A2"]);
    expect(parseAreasInput("a1")).toMatchObject({ problem: expect.any(String) });
  });
});

describe("the aspects' rule files", () => {
  it("ship one entry per language glob and a final **, in the format ocr honors", () => {
    expect(shippedRules("security").map((r) => r.path)).toEqual(["**/*.go", "**/*.ts", "**/*.tsx", "**"]);
    const doc = JSON.parse(ruleFileText("correctness")) as { merge_system_rule: boolean; rules: Array<{ path: string; rule: string }> };
    expect(doc.merge_system_rule).toBe(false);
    expect(doc.rules[0]!.rule).toMatch(/^Aspect: correctness\. Go code: review only this:.*Out of scope:.*A finding outside the correctness aspect is left out\.$/);
  });

  it("take a profile's entries over the shipped ones: the same path replaces, a new one comes before **", () => {
    const rules = effectiveRules("security", [{ path: "**/*.go", rule: "Aspect: security. Go: only unsafe." }, { path: "**/*.proto", rule: "Aspect: security. Proto." }]);
    expect(rules.map((r) => r.path)).toEqual(["**/*.go", "**/*.ts", "**/*.tsx", "**/*.proto", "**"]);
    expect(rules[0]!.rule).toBe("Aspect: security. Go: only unsafe.");
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
    expect(proofOf({ kind: "behavioral" })).toEqual({ state: "unproven", reason: "reproducing tests are not available in this version" });
    expect(proofOf({ kind: "non-behavioral" })).toEqual({ state: "non-behavioral" });
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
    expect(d.judgment.map((e) => [e.id, e.reason])).toEqual([["F2", "unproven: reproducing tests are not available in this version"], ["F3", "disputed: the verifier could not decide"]]);
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
