// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { fitParts, type ItemParts } from "../src/answertext.js";
import { clip, clipKeep, cutAt } from "../src/escape.js";
import { effectivePacks } from "../src/packs.js";
import { parsePatch } from "../src/patch.js";
import { createInput, planReview, findingMarker, MAX_INLINE_COMMENTS } from "../src/publish.js";
import { MAX_EXECUTOR_INPUT_BYTES } from "@graphloom/sdk";
import { MAX_ITEM_TEXT, round1Record, type Round1Record } from "../src/round1.js";
import type { PullFile } from "../src/snapshot.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7, head: HEAD };
const PATCH = "@@ -0,0 +1,4 @@\n+package schema\n+\n+func ParseTTL() {}\n+// end";
const FILES: PullFile[] = [{ path: "pkg/schema/ttl.go", status: "added", previousPath: null, additions: 4, deletions: 0, patch: PATCH, patchOmitted: false, parsed: parsePatch(PATCH) }];
const GITHUB = { owner: PULL.owner, repo: PULL.repo, head: HEAD, base: BASE };

/** Sentences of a known length, so a cut can be told from a whole text: "Sentence 1 says what it says." and so on. */
function prose(chars: number): string {
  const out: string[] = [];
  for (let n = 1; out.join(" ").length < chars; n += 1) out.push(`Sentence ${n} sets segment-level retention for the group and says so plainly.`);
  const text = out.join(" ");
  return text.slice(0, text.lastIndexOf(".", chars) + 1);
}

interface Cite {
  path: string;
  start: number;
  end: number;
  tree: string;
  quote?: string;
}
function record(question: Record<string, unknown>, symbols: unknown[] = [{ id: "S1", path: "pkg/schema/ttl.go", startLine: 40, qualified: "ParseTTL" }]): Round1Record {
  const qa = JSON.stringify({ schema: "pr-qa-v1", symbols, questions: [{ item: "R1", symbol: "S1", stable: "k", ...question }] });
  return round1Record({ head: HEAD, necessity: undefined, qa, files: FILES, itemCites: {}, packs: effectivePacks({ symbols: [] }), github: GITHUB })!;
}
const withoutN1 = (r: Round1Record): Round1Record => ({ ...r, issues: r.issues.filter((i) => i.id !== "N1") });
const plan = (r: Round1Record) => planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: withoutN1(r) });

const CITES: Cite[] = [
  { path: "pkg/schema/ttl.go", start: 3, end: 9, tree: "head" },
  { path: "pkg/other/retention.go", start: 20, end: 20, tree: "base" },
  { path: "pkg/other/group.go", start: 1, end: 40, tree: "head" },
  { path: "docs/design/ttl notes.md", start: 7, end: 12, tree: "base" },
  { path: "/home/u/go/pkg/mod/github.com/x/ttl@v1.2.0/ttl.go", start: 5, end: 8, tree: "dependency" },
];
const SPLIT = {
  kind: "split",
  splits: [
    { name: "parseUnit", startLine: 41, endLine: 52, responsibility: "reads the unit suffix" },
    { name: "parseCount", startLine: 53, endLine: 70, responsibility: "reads the integer part and checks its range" },
  ],
  testFile: "",
  testName: "",
  cases: [],
  assertion: "",
};

describe("round 1 posts the whole answer", () => {
  it("an answer of 1,900 characters with five citations and a split proposal is posted whole, with a link per citation and the proposal", () => {
    const answer = prose(1_900);
    expect(answer.length).toBeGreaterThan(1_700);
    const r = record({ id: "Q21", type: "split-function", text: "Should ParseTTL be split?", answer: { answer, status: "partially answered", none_found: false, citations: CITES, inventory: [{ name: "github.com/x/ttl", version: "v1.2.0" }], proposal: SPLIT } });
    const issue = r.issues.find((i) => i.id === "Q21")!;
    expect(issue.body).toContain(answer);
    expect(issue.body).not.toMatch(/answer shortened/);
    const links = [
      `[\`pkg/schema/ttl.go:3-9\`](https://github.com/apache/skywalking-banyandb/blob/${HEAD}/pkg/schema/ttl.go#L3-L9)`,
      `[\`pkg/other/retention.go:20\` (base)](https://github.com/apache/skywalking-banyandb/blob/${BASE}/pkg/other/retention.go#L20)`,
      `[\`pkg/other/group.go:1-40\`](https://github.com/apache/skywalking-banyandb/blob/${HEAD}/pkg/other/group.go#L1-L40)`,
      `[\`docs/design/ttl notes.md:7-12\` (base)](https://github.com/apache/skywalking-banyandb/blob/${BASE}/docs/design/ttl%20notes.md#L7-L12)`,
      "`github.com/x/ttl@v1.2.0` (dependency",
    ];
    for (const l of links) expect(issue.body, l).toContain(l);
    expect(issue.body).toContain("Proposal: split into\n- `parseUnit` (lines 41–52): reads the unit suffix\n- `parseCount` (lines 53–70): reads the integer part and checks its range");
    // The posted item is the issue, not clipped, not kept apart as a longer text.
    const item = plan(r).items.find((x) => x.id === "Q21")!;
    expect(item.full).toBeUndefined();
    expect(item.body).toContain(issue.body);
    for (const l of links) expect(item.body).toContain(l);
    expect(item.body).toContain(answer);
    expect(item.body).toContain("parseCount");
  });

  it("an existing-reuse-common answer of 4,000 characters fits whole, with every citation and not only three", () => {
    const answer = prose(3_990);
    expect(answer.length).toBeGreaterThan(3_800);
    const cites = Array.from({ length: 8 }, (_, n): Cite => ({ path: `pkg/other/reuse${n}.go`, start: n + 1, end: n + 5, tree: "head" }));
    const r = record({ id: "Q5", type: "existing-reuse-common", text: "Does this already exist?", answer: { answer, status: "answered", none_found: false, citations: cites, inventory: [] } });
    const issue = r.issues.find((i) => i.id === "Q5")!;
    expect(issue.kinds).toEqual(["existing"]);
    expect(issue.body).toContain(answer);
    for (const c of cites) expect(issue.body).toContain(`/blob/${HEAD}/${c.path}#L${c.start}-L${c.end}`);
    const item = plan(r).items.find((x) => x.id === "Q5")!;
    expect(item.full).toBeUndefined();
    expect(item.body).toContain(answer);
    expect(item.body.length).toBeLessThan(MAX_ITEM_TEXT);
    for (const c of cites) expect(item.body).toContain(`/blob/${HEAD}/${c.path}#L${c.start}-L${c.end}`);
  });

  it("names a citation without a link when no commit is pinned, and never leaves a citation out", () => {
    const qa = JSON.stringify({ schema: "pr-qa-v1", symbols: [{ id: "S1", path: "pkg/schema/ttl.go", startLine: 40, qualified: "ParseTTL" }], questions: [{ id: "Q1", item: "R1", symbol: "S1", stable: "k", type: "purpose", text: "why", answer: { answer: "because", status: "needs author", none_found: false, citations: CITES.slice(0, 4), inventory: [] } }] });
    const body = round1Record({ head: HEAD, necessity: undefined, qa, files: FILES, itemCites: {}, packs: [] })!.issues.find((i) => i.id === "Q1")!.body;
    expect(body).toContain("Citations: `pkg/schema/ttl.go:3-9`, `pkg/other/retention.go:20` (base), `pkg/other/group.go:1-40`, `docs/design/ttl notes.md:7-12` (base)");
  });
});

describe("when the review body has no room", () => {
  const many = (n: number): Round1Record => {
    const symbols = [{ id: "S1", path: "pkg/schema/ttl.go", startLine: 40, qualified: "ParseTTL" }];
    const questions = Array.from({ length: n }, (_, i) => ({
      id: `Q${i + 1}`,
      item: "R1",
      symbol: "S1",
      stable: `k${i}`,
      type: "split-function",
      text: `Should function ${i + 1} be split?`,
      answer: { answer: prose(3_900), status: "partially answered", none_found: false, citations: CITES.slice(0, 4).map((c, k) => ({ ...c, path: `pkg/f${i}/c${k}.go` })), inventory: [], proposal: SPLIT },
    }));
    return round1Record({ head: HEAD, necessity: undefined, qa: JSON.stringify({ schema: "pr-qa-v1", symbols, questions }), files: FILES, itemCites: {}, packs: [], github: GITHUB })!;
  };

  it("cuts an answer at a sentence end, says so and where the whole answer is, and keeps every citation link", () => {
    const r = withoutN1(many(14));
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: r });
    expect(p.problem).toBeUndefined();
    expect(p.body.length).toBeLessThanOrEqual(40_000);
    const shortened = p.items.filter((x) => x.full !== undefined);
    expect(shortened.length).toBeGreaterThan(0);
    for (const x of shortened) {
      expect(x.body).toContain(`(answer shortened; the full answer is in the report's Q&A, ${x.id})`);
      // What stays of the answer is whole sentences.
      const kept = /Answer \(partially answered\): (.*?) \(answer shortened/s.exec(x.body)![1]!;
      expect(kept.endsWith("plainly."), kept.slice(-60)).toBe(true);
      expect(kept.length).toBeGreaterThan(0);
      // The citations all survive, whatever became of the proposal.
      const n = Number(x.id.slice(1)) - 1;
      for (let k = 0; k < 4; k += 1) expect(x.body, `${x.id} c${k}`).toContain(`/pkg/f${n}/c${k}.go`);
      expect(x.full).toContain(prose(3_900));
      expect(x.body.length).toBeLessThan(p.body.length);
      expect(p.body).toContain(x.body);
    }
  });

  it("falls back to a word boundary when the text has no sentence end, and still says so", () => {
    const parts: ItemParts = { id: "Q9", head: "**needs the author** (Q9). Why?", label: "What was checked", answer: "word ".repeat(600).trim(), cites: ["[`a.go:1`](https://example.test/a.go)", "[`b.go:2`](https://example.test/b.go)"], proposal: "" };
    const text = fitParts(parts, 700);
    expect(text.length).toBeLessThanOrEqual(700);
    expect(text).toContain("(answer shortened; the full answer is in the report's Q&A, Q9)");
    expect(text).toContain("https://example.test/a.go");
    expect(text).toContain("https://example.test/b.go");
    const kept = /What was checked: (.*?)… ?\(answer shortened|What was checked: (.*?) \(answer shortened/s.exec(text)!;
    expect(/^(word )*word…?$/.test((kept[1] ?? kept[2])!)).toBe(true);
  });

  it("drops the proposal's detail before a citation link, and counts any link it must leave out", () => {
    const parts: ItemParts = { id: "Q9", head: "**needs the author** (Q9). Why?", label: "Answer (answered)", answer: "It does. ".repeat(50), cites: Array.from({ length: 6 }, (_, n) => `[\`f${n}.go:1\`](https://example.test/f${n}.go)`), proposal: `Proposal: ${"detail ".repeat(100)}` };
    const mid = fitParts(parts, 900);
    expect(mid.length).toBeLessThanOrEqual(900);
    for (let n = 0; n < 6; n += 1) expect(mid).toContain(`https://example.test/f${n}.go`);
    expect(mid).toContain("proposal");
    const tight = fitParts(parts, 330);
    expect(tight).toContain("https://example.test/f0.go");
    expect(tight).toMatch(/, and \d+ more in the report's Q&A, Q9/);
  });
});

describe("clip", () => {
  it("cuts at a sentence end, else a word boundary, never inside a word", () => {
    expect(cutAt("One two three. Four five six seven.", 25)).toEqual({ text: "One two three.", cut: true, sentence: true });
    expect(cutAt("alpha beta gamma delta", 14)).toEqual({ text: "alpha beta", cut: true, sentence: false });
    expect(clip("alpha beta gamma delta", 14)).toBe("alpha beta…");
    expect(clip("alpha beta", 40)).toBe("alpha beta");
    expect(cutAt("a very long single token", 3).text).toBe("a");
  });
});

describe("the whole executor input is bounded in bytes", () => {
  const PATCH_BIG = `@@ -0,0 +1,80 @@\n${Array.from({ length: 80 }, (_, n) => `+line ${n}`).join("\n")}`;
  const BIG: PullFile[] = [{ path: "pkg/schema/ttl.go", status: "added", previousPath: null, additions: 80, deletions: 0, patch: PATCH_BIG, patchOmitted: false, parsed: parsePatch(PATCH_BIG) }];
  const make = (n: number, text: (i: number) => string): Round1Record => {
    const symbols = Array.from({ length: n }, (_, i) => ({ id: `S${i + 1}`, path: "pkg/schema/ttl.go", startLine: i + 1, qualified: `f${i}` }));
    const questions = Array.from({ length: n }, (_, i) => ({ id: `Q${i + 1}`, item: "R1", symbol: `S${i + 1}`, stable: `k${i}`, type: "split-function", text: `Should f${i} be split?`, answer: { answer: text(i), status: "partially answered", none_found: false, citations: CITES.slice(0, 3).map((c, k) => ({ ...c, path: `pkg/f${i}/c${k}.go` })), inventory: [], proposal: SPLIT } }));
    return withoutN1(round1Record({ head: HEAD, necessity: undefined, qa: JSON.stringify({ schema: "pr-qa-v1", symbols, questions }), files: BIG, itemCites: {}, packs: [], github: GITHUB })!);
  };
  const bytes = (p: ReturnType<typeof planReview>): number => Buffer.byteLength(JSON.stringify(createInput(PULL, p)), "utf8");

  it("fits 50 inline items of about 6,000 characters, shortened at boundaries with the note, citations kept", () => {
    const r = make(50, () => `${prose(2_000)} ${prose(2_000)} ${prose(1_900)}`);
    // Unbounded, this is over the executor's limit.
    const unbounded = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: r, maxInputBytes: 100_000_000 });
    expect(unbounded.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(bytes(unbounded)).toBeGreaterThan(MAX_EXECUTOR_INPUT_BYTES);
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: r });
    expect(p.problem).toBeUndefined();
    expect(p.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    const shortened = p.items.filter((x) => x.full !== undefined);
    expect(shortened.length).toBeGreaterThan(0);
    for (const x of shortened) {
      expect(x.body).toContain(`(answer shortened; the full answer is in the report's Q&A, ${x.id})`);
      const kept = /Answer \(partially answered\): (.*?) \(answer shortened/s.exec(x.body)![1]!;
      expect(kept.endsWith("plainly."), kept.slice(-40)).toBe(true);
      const n = Number(x.id.slice(1)) - 1;
      for (let k = 0; k < 3; k += 1) expect(x.body).toContain(`/pkg/f${n}/c${k}.go`);
    }
  });

  it("measures bytes, not characters: multi-byte text is shortened though its characters would fit", () => {
    const cjk = (n: number): string => "保留期按段设置。".repeat(Math.ceil(n / 8)).slice(0, n);
    const r = make(50, () => cjk(3_900));
    const chars = r.issues.reduce((n, x) => n + x.body.length, 0);
    expect(chars).toBeLessThan(MAX_EXECUTOR_INPUT_BYTES);
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: r });
    expect(p.problem).toBeUndefined();
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    expect(p.items.some((x) => x.full !== undefined)).toBe(true);
    for (const x of p.items.filter((y) => y.full !== undefined)) expect(x.body).toContain("answer shortened");
  });

  it("says why when the input cannot fit even with every item shortened as far as it goes", () => {
    const r = make(50, () => prose(2_000));
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: r, maxInputBytes: 5_000 });
    expect(p.problem).toMatch(/^the review's input is \d+ bytes, over the \d+ the executor takes/);
  });
});

describe("a suggestion block is atomic when a posted body shrinks", () => {
  const unclosed = (s: string): boolean => (s.match(/^\s*```/gm) ?? []).length % 2 === 1;

  it("keeps each suggestion whole or drops it with a note, never cut inside its fence, in 50 large findings", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: `F${i + 1}`, kind: "finding", aspects: ["correctness"], severity: "P2", proof: { state: "non-behavioral" }, path: "pkg/a.go", side: "RIGHT", line: i + 1, anchored: true, body: prose(3_950), suggestion: `const x = ${"1 + ".repeat(240)}1;` }));
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: { schema: "pr-review-round1-v1", head: HEAD, necessity: "necessary", issues: [] } as unknown as Round1Record, draft: { comments: entries, summary: "s" } as never });
    expect(p.problem).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(createInput(PULL, p)), "utf8")).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    expect(p.comments).toHaveLength(MAX_INLINE_COMMENTS);
    for (const c of [...p.comments.map((x) => x.body), p.body]) expect(unclosed(c)).toBe(false);
    let dropped = 0;
    for (const x of p.items) {
      if (x.body.includes("(suggested change omitted for size; see the report)")) {
        dropped += 1;
        expect(x.body).not.toContain("```suggestion");
        expect(x.full).toContain("```suggestion");
      }
    }
    expect(dropped).toBeGreaterThan(0);
  });

  it("clipKeep drops a block it would cut, whole", () => {
    const text = `${"word ".repeat(20)}\n\n\`\`\`suggestion\nconst x = 1;\nconst y = 2;\n\`\`\``;
    const out = clipKeep(text, 130);
    expect(unclosed(out)).toBe(false);
    expect(out).not.toContain("```");
    expect(clipKeep(text, text.length)).toBe(text);
  });

  it("clipKeep never retreats to a sentence end inside an earlier block", () => {
    const text = `Intro\n\`\`\`js\n// A sentence.\n\`\`\`\n${"tail ".repeat(30)}`;
    for (let n = 20; n < text.length; n += 1) expect(unclosed(clipKeep(text, n)), `n=${n}`).toBe(false);
  });
});
