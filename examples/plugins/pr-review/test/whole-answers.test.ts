// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { fitParts, type ItemParts } from "../src/kit/answertext.js";
import { clip, clipKeep, cutAt } from "../src/kit/escape.js";
import { createInput, planReview, MAX_INLINE_COMMENTS } from "../src/publish.js";
import type { Draft, DraftEntry } from "../src/draft.js";
import { MAX_EXECUTOR_INPUT_BYTES } from "@graphloom/sdk";

const HEAD = "a".repeat(40);
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7, head: HEAD };

/** Sentences of a known length, so a cut can be told from a whole text: "Sentence 1 says what it says." and so on. */
function prose(chars: number): string {
  const out: string[] = [];
  for (let n = 1; out.join(" ").length < chars; n += 1) out.push(`Sentence ${n} sets segment-level retention for the group and says so plainly.`);
  const text = out.join(" ");
  return text.slice(0, text.lastIndexOf(".", chars) + 1);
}

describe("the kit's item text parts, shortened when a body has no room", () => {
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
  const entries = (n: number, text: (i: number) => string): DraftEntry[] => Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, kind: "finding" as const, aspects: ["correctness" as const], severity: "P2" as const, proof: { state: "non-behavioral" as const }, path: "pkg/a.go", side: "RIGHT" as const, line: i + 1, anchored: true, body: text(i) }));
  const draft = (comments: DraftEntry[]): Draft => ({ comments, summary: "s", context: { source: "prelude" }, leads: { given: 0, raised: 0 } }) as unknown as Draft;
  const bytes = (p: ReturnType<typeof planReview>): number => Buffer.byteLength(JSON.stringify(createInput(PULL, p)), "utf8");

  it("fits 50 inline findings of about 6,000 characters, shortened at sentence ends, the whole text kept for the ledger", () => {
    const d = draft(entries(50, () => `${prose(2_000)} ${prose(2_000)} ${prose(1_900)}`));
    const unbounded = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: null, draft: d, maxInputBytes: 100_000_000 });
    expect(unbounded.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(bytes(unbounded)).toBeGreaterThan(MAX_EXECUTOR_INPUT_BYTES);
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: null, draft: d });
    expect(p.problem).toBeUndefined();
    expect(p.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    const shortened = p.items.filter((x) => x.full !== undefined);
    expect(shortened.length).toBeGreaterThan(0);
    for (const x of shortened) expect(x.full).toContain(prose(1_900));
  });

  it("measures bytes, not characters: multi-byte text is shortened though its characters would fit", () => {
    const cjk = (n: number): string => "保留期按段设置。".repeat(Math.ceil(n / 8)).slice(0, n);
    const d = draft(entries(50, () => cjk(3_900)));
    expect(d.comments.reduce((n, x) => n + x.body.length, 0)).toBeLessThan(MAX_EXECUTOR_INPUT_BYTES);
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: null, draft: d });
    expect(p.problem).toBeUndefined();
    expect(bytes(p)).toBeLessThanOrEqual(MAX_EXECUTOR_INPUT_BYTES);
    expect(p.items.some((x) => x.full !== undefined)).toBe(true);
  });

  it("says why when the input cannot fit even with every item shortened as far as it goes", () => {
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: null, draft: draft(entries(50, () => prose(2_000))), maxInputBytes: 5_000 });
    expect(p.problem).toMatch(/^the review's input is \d+ bytes, over the \d+ the executor takes/);
  });
});

describe("a suggestion block is atomic when a posted body shrinks", () => {
  const unclosed = (s: string): boolean => (s.match(/^\s*```/gm) ?? []).length % 2 === 1;

  it("keeps each suggestion whole or drops it with a note, never cut inside its fence, in 50 large findings", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: `F${i + 1}`, kind: "finding", aspects: ["correctness"], severity: "P2", proof: { state: "non-behavioral" }, path: "pkg/a.go", side: "RIGHT", line: i + 1, anchored: true, body: prose(3_950), suggestion: `const x = ${"1 + ".repeat(240)}1;` }));
    const p = planReview({ pull: PULL, head: HEAD, nonce: "op1", round1: null, draft: { comments: entries, summary: "s" } as never });
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
