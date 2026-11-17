// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { necessityJson } from "../src/necessity.js";
import type { PriorItem } from "../src/prior.js";
import { itemCitesOf, round1Record, ROUND1_SCHEMA, type Round1Kind } from "../src/round1.js";
import { pullFile } from "../src/kit/snapshot.js";

const HEAD = "a".repeat(40);
const patch = "@@ -0,0 +1,3 @@\n+package a\n+\n+func Parse() {}";
const FILES = [pullFile({ path: "pkg/a/a.go", previousPath: null, status: "added", additions: 3, deletions: 0, patch })!];
const necessity = (conclusion: string): string =>
  necessityJson({
    final: { question: "N1", answer: "", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" }, check: { verdict: "supported", note: "" }, history: [], notes: [], necessity: { conclusion, rationale: "why", problem: { claim: "", quotes: [], trace: [], canHappen: "yes", explanation: "" }, reproduction: "", principles: [], design: { statements: [], changed: [], effect: "unrelated", explanation: "", searches: [] }, alternatives: { exists: false, explanation: "", citations: [] }, searches: [] } } as never,
    decision: { action: "ask-all", reason: "" } as never,
  });
interface Q {
  id: string;
  type: string;
  item?: string;
  stable?: string;
  status?: string;
  none_found?: boolean;
  reusable?: boolean;
  citations?: Array<{ path: string; start: number; end: number; tree: string }>;
}
const qa = (...qs: Q[]): string =>
  JSON.stringify({
    schema: "pr-qa-v1",
    questions: [{ id: "N1", type: "necessity", item: "", stable: "necessity|N1", text: "Is it necessary?" }, ...qs.map((q) => ({ id: q.id, type: q.type, item: q.item ?? "W1", stable: q.stable ?? `${q.type}|item|pkg/a/a.go`, text: `${q.type}?`, answer: { answer: "an answer", status: q.status ?? "answered", none_found: q.none_found ?? false, ...(q.reusable !== undefined ? { reusable: q.reusable } : {}), citations: q.citations ?? [], inventory: [], proposal: { kind: "none" } } }))],
    symbols: [],
  });
const record = (qaJson: string, prior: PriorItem[] = [], conclusion = "necessary") => round1Record({ head: HEAD, necessity: necessity(conclusion), qa: qaJson, files: FILES, itemCites: { W1: { path: "pkg/a/a.go", start: 3, end: 3 } }, prior })!;
const prior = (id: string, key: string): PriorItem => ({ id, origin: "round1", key, status: "open", head: "b".repeat(40), history: [] });
const outside = [{ path: "pkg/timestamp/duration.go", start: 30, end: 42, tree: "base" }];

describe("the gate (design-pr-review-split §3.6)", () => {
  it("has the kinds necessity, needs-author, partial and existing, and no missing-test kind", () => {
    const r = record(
      qa(
        { id: "Q1", type: "purpose", status: "needs author" },
        { id: "Q2", type: "existing-feature", status: "partially answered", none_found: true, stable: "existing-feature|item|pkg/b/b.go" },
        { id: "Q3", type: "existing-feature", reusable: true, citations: outside, item: "W2", stable: "existing-feature|item|pkg/c/c.go" },
        // A question of a moved type (from a hand-made Q&A) never makes an item, even with no covering test.
        { id: "Q4", type: "missing-test", none_found: true, stable: "missing-test|item|pkg/a/a.go" },
      ),
      [],
      "questionable",
    );
    expect(r.schema).toBe(ROUND1_SCHEMA);
    expect(r.issues.map((x) => [x.id, x.kinds])).toEqual([["N1", ["necessity"]], ["Q1", ["needs-author"]], ["Q2", ["partial"]], ["Q3", ["existing"]]]);
    const kinds = new Set<Round1Kind>(r.issues.flatMap((x) => x.kinds));
    expect([...kinds].sort()).toEqual(["existing", "necessity", "needs-author", "partial"]);
    expect(JSON.stringify(r)).not.toContain("missing-test\"]");
  });

  it("notes an existing-feature answer that found nothing reusable or names the changed code, and merges answers citing one outside equivalent", () => {
    const r = record(
      qa(
        { id: "Q1", type: "existing-feature", reusable: false, citations: outside },
        { id: "Q2", type: "existing-feature", reusable: true, citations: [{ path: "pkg/a/a.go", start: 1, end: 3, tree: "head" }], stable: "existing-feature|item|pkg/a/a.go#2" },
        { id: "Q3", type: "existing-feature", reusable: true, citations: outside, item: "W2", stable: "existing-feature|item|pkg/c/c.go" },
        { id: "Q4", type: "existing-feature", reusable: true, citations: outside, item: "W3", stable: "existing-feature|item|pkg/d/d.go" },
      ),
    );
    expect(r.noted?.map((n) => n.id)).toEqual(["Q1", "Q2"]);
    expect(r.issues.map((x) => [x.id, x.covers])).toEqual([["Q3", ["Q4"]]]);
  });

  it("judges an earlier open item by its stable key: open while an open item has the key, fixed when its question raises nothing or no question has the key", () => {
    const r = record(
      qa({ id: "Q7", type: "purpose", status: "needs author", stable: "purpose|item|pkg/a/a.go" }, { id: "Q8", type: "existing-feature", none_found: true, stable: "existing-feature|item|pkg/a/a.go" }),
      // Q2's key is this head's Q7 (an id the ledger did not keep), Q3's question is now answered, Q5's subject left the change.
      [prior("Q2", "purpose|item|pkg/a/a.go"), prior("Q3", "existing-feature|item|pkg/a/a.go"), prior("Q5", "existing-feature|item|pkg/gone/gone.go")],
    );
    expect(r.prior).toEqual([
      { id: "Q2", key: "purpose|item|pkg/a/a.go", status: "open", reason: "it is still an open item on this head" },
      { id: "Q3", key: "existing-feature|item|pkg/a/a.go", status: "fixed", reason: "its question is now answered, with no open kind" },
      { id: "Q5", key: "existing-feature|item|pkg/gone/gone.go", status: "fixed", reason: "no question has its key on this head: its subject is no longer in the change" },
    ]);
  });

  it("anchors an item on its high-level change's first head cite", () => {
    const report = JSON.stringify({ sections: [{ id: "features", items: [{ id: "R1", text: "x", cites: [{ path: "pkg/a/a.go", side: "head", start: 3, end: 3, symbol: "" }] }] }], briefing: { whatsNew: [{ text: "x", cites: [{ path: "pkg/a/a.go", side: "head", start: 1, end: 2, symbol: "" }] }] } });
    expect(itemCitesOf(report)).toEqual({ R1: { path: "pkg/a/a.go", start: 3, end: 3 }, W1: { path: "pkg/a/a.go", start: 1, end: 2 } });
    // With no capability kept, the coarsest change item stands in as W1.
    const fallback = JSON.stringify({ sections: [{ id: "features", items: [{ id: "R1", text: "x", cites: [{ path: "pkg/a/a.go", side: "head", start: 3, end: 3, symbol: "" }] }] }], briefing: { whatsNew: [] } });
    expect(itemCitesOf(fallback).W1).toEqual({ path: "pkg/a/a.go", start: 3, end: 3 });
    const r = record(qa({ id: "Q1", type: "purpose", status: "needs author" }));
    expect(r.issues[0]).toMatchObject({ id: "Q1", path: "pkg/a/a.go", line: 3, anchored: true });
  });
});
