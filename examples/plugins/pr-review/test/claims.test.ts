// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { quoteMatches, readClaimCheck } from "../src/claims.js";
import type { ReportItem } from "../src/report.js";
import { pullFile, type PullFile } from "../src/snapshot.js";

const file = (path: string, patch: string | null, extra: Record<string, unknown> = {}): PullFile =>
  pullFile({ path, status: "modified", patch, previousPath: null, additions: 1, deletions: 1, patchOmitted: patch === null, ...extra })!;

const a = file("a.go", "@@ -20,3 +20,4 @@\n ctx line\n-removed  text   here\n+added line one\n+added   line two\n tail line");
const bin = file("logo.png", null);
const files = [a, bin];

const item = (path: string): ReportItem => ({ text: "claim", cites: [{ path, side: "head", start: 0, end: 0, symbol: "" }], facts: [] });
const items = [{ id: "R1", item: item("a.go") }, { id: "R2", item: item("logo.png") }];
const reading = (verdicts: unknown[]) => readClaimCheck({ verdicts }, items, files) as Exclude<ReturnType<typeof readClaimCheck>, { problems: string[] }>;
const v = (itemId: string, verdict: string, quotes: unknown[] = [], note = "") => ({ item: itemId, verdict, note, quotes });

describe("quoteMatches", () => {
  it("matches a verbatim excerpt of a diff line, whitespace collapsed", () => {
    expect(quoteMatches({ path: "a.go", line: 21, text: "added line one" }, a)).toBe(true);
    expect(quoteMatches({ path: "a.go", line: 22, text: "added line two" }, a)).toBe(true);
    expect(quoteMatches({ path: "a.go", line: 22, text: "added   line    two" }, a)).toBe(true);
    expect(quoteMatches({ path: "a.go", line: 21, text: "line one" }, a)).toBe(true);
  });

  it("finds removed text by its base-side number, and context by either", () => {
    expect(quoteMatches({ path: "a.go", line: 21, text: "removed text here" }, a)).toBe(true);
    expect(quoteMatches({ path: "a.go", line: 20, text: "ctx line" + "!" }, a)).toBe(false);
  });

  it("accepts a line within three of the one cited, and not further", () => {
    expect(quoteMatches({ path: "a.go", line: 24, text: "added line one" }, a)).toBe(true);
    expect(quoteMatches({ path: "a.go", line: 25, text: "added line one" }, a)).toBe(false);
    expect(quoteMatches({ path: "a.go", line: 18, text: "added line one" }, a)).toBe(true);
  });

  it("refuses a short quote, text that is not in the diff, and a bad line", () => {
    expect(quoteMatches({ path: "a.go", line: 21, text: "added" }, a)).toBe(false);
    expect(quoteMatches({ path: "a.go", line: 21, text: "never written anywhere" }, a)).toBe(false);
    expect(quoteMatches({ path: "a.go", line: 0, text: "added line one" }, a)).toBe(false);
    expect(quoteMatches({ path: "logo.png", line: 1, text: "anything at all here" }, bin)).toBe(false);
  });
});

describe("readClaimCheck", () => {
  const good = { path: "a.go", line: 21, text: "added line one" };

  it("takes a supported item with a matching quote", () => {
    const r = reading([v("R1", "supported", [good]), v("R2", "supported")]);
    expect([...r.supported]).toEqual(["R1", "R2"]);
    expect(r.weak.size + r.unchecked.length).toBe(0);
  });

  it("stands an item that cites only files with no patch text on the checker's word, without a quote", () => {
    expect([...reading([v("R1", "unsupported"), v("R2", "supported")]).supported]).toEqual(["R2"]);
  });

  it("makes supported without a quote, and with a quote that does not match, as weak as unsupported", () => {
    const r = reading([v("R1", "supported", []), v("R2", "supported")]);
    expect(r.weak.get("R1")).toBe("supported without a quote");
    const wrong = reading([v("R1", "supported", [good, { path: "a.go", line: 21, text: "invented text goes here" }]), v("R2", "supported")]);
    expect(wrong.weak.get("R1")).toMatch(/1 of its 2 quote\(s\) do not match/);
  });

  it("refuses a quote of a file the item does not cite", () => {
    const other = file("b.go", "@@ -1 +1 @@\n-x\n+quoted elsewhere");
    const r = readClaimCheck({ verdicts: [v("R1", "supported", [{ path: "b.go", line: 1, text: "quoted elsewhere" }]), v("R2", "supported")] }, items, [...files, other]) as { weak: Map<string, string> };
    expect(r.weak.get("R1")).toMatch(/do not match/);
  });

  it("keeps partial and unsupported verdicts with the checker's note", () => {
    const r = reading([v("R1", "partial", [], "only half is shown"), v("R2", "unsupported", [], "")]);
    expect(r.weak.get("R1")).toBe("partial: only half is shown");
    expect(r.weak.get("R2")).toBe("unsupported");
  });

  it("counts an item with no verdict as unchecked", () => {
    expect(reading([v("R1", "supported", [good])]).unchecked).toEqual(["R2"]);
  });

  it("lets the weaker of two verdicts for one item stand", () => {
    const r = reading([v("R1", "supported", [good]), v("R1", "unsupported", [], "no"), v("R2", "supported")]);
    expect(r.weak.get("R1")).toBe("unsupported: no");
  });

  it("uses at most three quotes", () => {
    const quotes = [good, good, good, { path: "a.go", line: 21, text: "not in the diff at all" }];
    expect([...reading([v("R1", "supported", quotes), v("R2", "supported")]).supported]).toContain("R1");
  });

  it("refuses a result that breaks the contract, naming what", () => {
    expect(readClaimCheck({ verdicts: [{ item: "R1", verdict: "approve", note: "", quotes: [] }] }, items, files)).toEqual({ problems: [expect.stringMatching(/verdict must be one of/)] });
    expect(readClaimCheck({ verdicts: [{ item: "R1", verdict: "supported", note: "", quotes: [], tone: "rude" }] }, items, files)).toEqual({ problems: [expect.stringMatching(/tone is not an allowed property/)] });
    expect(readClaimCheck({}, items, files)).toEqual({ problems: [expect.stringMatching(/verdicts is required/)] });
  });
});
