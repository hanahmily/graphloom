// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import { composeDraft, draftJson, draftMarkdown, priorityMismatch, withReview, type Draft, type DraftInput } from "../src/draft.js";
import { htmlPagesFrom } from "../src/html.js";
import { draftLedgerMeta, ledgerPatch, planReview, priorLines } from "../src/publish.js";
import { postedPriority, registryOf } from "../src/prior.js";
import { aspectPrior } from "../src/priorreview.js";
import { REHEARSAL_REQUEST } from "../src/rehearsal.js";
import type { AspectRecord, Finding } from "../src/review.js";
import { parsePatch } from "../src/kit/patch.js";
import type { PullFile } from "../src/kit/snapshot.js";
import { simulate } from "./support.js";

/**
 * One priority per finding (design §8.4, §9.1): wherever a person sees a finding or the ledger stores it, its priority is the final
 * one the draft rules give it. The reviewer's proposed one stays in its aspect record only.
 */
const HEAD = "a".repeat(40);
const PATCH = "@@ -1,3 +1,8 @@\n a\n+b\n+c\n+d\n+e\n+g\n+h\n f";
const files: PullFile[] = [{ path: "pkg/a.go", status: "modified", previousPath: null, additions: 6, deletions: 0, patch: PATCH, patchOmitted: false, parsed: parsePatch(PATCH) }];
const finding = (over: Partial<Finding>): Finding => ({ id: "F1", aspect: "correctness", raisedBy: "correctness", pass: 1, path: "pkg/a.go", side: "RIGHT", startLine: 2, endLine: 3, severity: "P1", kind: "non-behavioral", content: "text", suggestion: "", evidence: "", distinct: false, state: "confirmed", reaffirmed: [], notes: [], verdict: { verdict: "confirmed", kind: "non-behavioral", witness: "pkg/a.go:2", quotes: [], reason: "yes", fixes: false }, ...over });
const record = (aspect: AspectRecord["aspect"], findings: Finding[]): AspectRecord => ({ schema: "pr-review-aspect-v2", aspect, reviewer: "claude-code", verifier: "codex", context: { kind: "seeded", reason: "forking is not available in this version" }, scopeFiles: 1, passes: [{ n: 1, reviewed: 1, raised: findings.map((f) => f.id), reaffirmed: [], nits: 0, merged: 0 }], findings, unsaturated: false, leads: [] });
const scope = { schema: "pr-review-scope-v2" as const, mode: "standard" as const, source: "whole" as const, areas: [], files: ["pkg/a.go"], context: { kind: "seeded" as const, reason: "forking is not available in this version" }, contextSource: "prelude" as const, harnesses: {} };
const input = (records: AspectRecord[]): DraftInput => ({ pull: { owner: "apache", repo: "skywalking-banyandb", number: 7 }, head: HEAD, files, scope, records, context: { source: "prelude" }, round1: null });

// F1: raised from a reuse lead, proposed P3, confirmed: drafted at P0. F2: behavioral, proposed P0, no test: unproven, P2, judgment.
// F3: proposed P1 and refuted: in no draft entry, so it has no priority anywhere.
const F1 = finding({ id: "F1", aspect: "maintainability", raisedBy: "maintainability", severity: "P3", content: "ParseTTL repeats parseDuration in pkg/time.", lead: "L1", leadKind: "reuse" });
const F2 = finding({ id: "F2", aspect: "correctness", raisedBy: "correctness", severity: "P0", kind: "behavioral", startLine: 6, endLine: 6, content: "A trailing unit is accepted.", verdict: { verdict: "confirmed", kind: "behavioral", witness: "pkg/a.go:6", quotes: [], reason: "yes", fixes: false } });
const F3 = finding({ id: "F3", aspect: "maintainability", raisedBy: "maintainability", severity: "P1", startLine: 7, endLine: 7, state: "dismissed", content: "Unclear name.", verdict: { verdict: "refuted", kind: "non-behavioral", witness: "", quotes: [{ path: "pkg/a.go", line: 7, text: "h" }], reason: "the name is the project's", fixes: false } });
const draft = composeDraft(input([record("correctness", [F2]), record("maintainability", [F1, F3]), record("security", [])]));
const priorities = (text: string): string[] => [...new Set([...text.matchAll(/\bP[0-3]\b/g)].map((m) => m[0]))].sort();

describe("a finding has one priority, the final one, wherever it is shown or stored", () => {
  it("drafts the reuse finding at P0 and the unproven one at P2, and the draft's report part shows the same", () => {
    expect(draft.comments.map((e) => [e.id, e.severity])).toEqual([["F1", "P0"]]);
    expect(draft.judgment.map((e) => [e.id, e.severity])).toEqual([["F2", "P2"]]);
    expect(draft.review.findings.map((f) => [f.id, f.severity])).toEqual([["F1", "P0"], ["F2", "P2"], ["F3", undefined]]);
    const json = draftJson(draft);
    expect([...json.matchAll(/"severity": "(P\d)"/g)].map((m) => m[1]).sort()).toEqual(["P0", "P0", "P2", "P2"]);
  });

  it("shows it in draft.md and review.md, and never the proposed one", () => {
    const md = draftMarkdown(draft);
    expect(md).toContain("#### F1 · P0 · maintainability · non-behavioral · from lead L1 (reuse)");
    expect(priorities(md)).toEqual(["P0"]);
    const review = withReview("# apache/skywalking-banyandb#7\n", draft);
    expect(review).toContain("### P0 (1)\n- F1 · maintainability");
    expect(review).toContain("### P2 (1)\n- F2 · correctness");
    expect(review).toContain("#### F1 · maintainability · P0 · non-behavioral · confirmed");
    expect(review).toContain("#### F2 · correctness · P2 · behavioral · confirmed");
    expect(review).toContain("#### F3 · maintainability · non-behavioral · dismissed");
    expect(priorities(review)).toEqual(["P0", "P2"]);
  });

  it("shows it in the HTML report and its appendix", () => {
    const sim = simulate({ scenarioName: "review-layer", request: REHEARSAL_REQUEST, through: "review", maxSteps: 400 });
    const pages = htmlPagesFrom(sim.written!.json, undefined, undefined, draftJson(draft), { noDesign: "No design review in this run." })!;
    expect(pages.review).toMatch(/href="review-appendix.html#f-F1" title="P0 maintainability\nF1 confirmed/);
    expect(pages.review).toMatch(/href="review-appendix.html#f-F2" title="P2 correctness\nF2 unproven/);
    for (const empty of ["no P3 finding of maintainability", "no P0 finding of correctness", "no P1 finding of maintainability"]) expect(pages.review).toContain(empty);
    expect(pages.appendix).toMatch(/<h3>P0 <span class="muted">\(1\)<\/span><\/h3>/);
    expect(pages.appendix).toMatch(/<h3>P2 <span class="muted">\(1\)<\/span><\/h3>/);
    expect(pages.appendix).not.toMatch(/<h3>P[13] /);
    expect(pages.appendix).toContain("#### F1 · P0 · maintainability");
  });

  it("posts it, and the ledger stores it: none for the refuted finding", () => {
    const { meta, closed } = draftLedgerMeta(draft, files);
    const plan = planReview({ pull: { owner: "apache", repo: "skywalking-banyandb", number: 7 }, head: HEAD, nonce: "n", draft, round1: null, meta, closed });
    expect(plan.items.map((x) => x.id)).toEqual(["F1"]);
    expect(plan.comments[0]!.body).toMatch(/^\*\*\[P0\] critical\*\* · maintainability · non-behavioral/);
    expect(priorities(plan.body + plan.comments.map((c) => c.body).join("\n"))).toEqual(["P0"]);
    const patch = ledgerPatch({ head: HEAD }, plan, draft, { reviewId: 1, url: null, how: "created" }, new Map([["F1", 11]]));
    expect(patch.items.map((x) => [x.id, x.meta?.severity])).toEqual([["F1", "P0"]]);
    expect(patch.closed.map((x) => [x.id, x.meta.severity])).toEqual([["F3", undefined]]);
    expect(JSON.stringify(patch)).not.toMatch(/"severity":"P[13]"/);
  });

  it("is the one a later head's earlier findings carry", () => {
    const { meta, closed } = draftLedgerMeta(draft, files);
    const plan = planReview({ pull: { owner: "apache", repo: "skywalking-banyandb", number: 7 }, head: HEAD, nonce: "n", draft, round1: null, meta, closed });
    const patch = ledgerPatch({ head: HEAD }, plan, draft, { reviewId: 1, url: null, how: "created" }, new Map([["F1", 11]]));
    // The review section as ledger-published leaves it.
    const item = patch.items[0]!;
    const findings = [{ head: HEAD, id: item.id, origin: "round2", path: item.path, line: item.line, endLine: item.endLine, text: item.text, ...item.meta, state: "open", github: { head: HEAD, reviewId: 1, commentId: 11, inline: true }, history: [{ head: HEAD, status: "open" }] }, ...patch.closed.map((c) => ({ head: HEAD, id: c.id, origin: "round2", path: c.path, line: c.line, endLine: c.endLine, side: c.side, text: c.text, state: "withdrawn", ...c.meta }))];
    const registry = registryOf({ schema: "graphloom-pr-ledger-v2", review: { schema: "pr-review-ledger-v1", heads: [], findings } });
    expect(registry.items.map((i) => [i.id, i.severity])).toEqual([["F1", "P0"], ["F3", undefined]]);
    const given = aspectPrior(registry, "maintainability", files, new Set(["pkg/a.go"])).given;
    expect(given.map((p) => [p.id, p.severity])).toEqual([["F1", "P0"]]);
    const outcome = { id: "F1", status: "open" as const, how: "reviewer" as const, reason: "still there", path: "pkg/a.go", side: "RIGHT" as const, line: 2, endLine: 3, outdated: false };
    const lines = priorLines(registry, { owner: "apache", repo: "skywalking-banyandb", number: 7 }, [{ aspect: "maintainability", prior: [outcome] }] as never, files, []);
    expect(lines[0]!.moved?.meta.severity).toBe("P0");
  });

  it("refuses a draft whose stored priority is not the recomputed one", () => {
    const parsed = (): Draft => JSON.parse(draftJson(draft)) as Draft;
    expect(priorityMismatch(parsed(), draft)).toBeUndefined();
    const proposed = parsed();
    proposed.comments[0]!.severity = "P3";
    expect(priorityMismatch(proposed, draft)).toBe("F1 is drafted at P3, but the draft rules give P0");
    const shown = parsed();
    shown.review.findings.find((f) => f.id === "F2")!.severity = "P0";
    expect(priorityMismatch(shown, draft)).toBe("the report shows F2 at P0, but the draft rules give P2");
  });
});

describe("reading a review section pr-review 1.0 or 1.1.0 wrote, which stored the proposed priority", () => {
  const ledger = {
    schema: "graphloom-pr-ledger-v2",
    review: {
      schema: "pr-review-ledger-v1",
      heads: [{ sha: HEAD, context: { source: "prelude" }, round1: null, reviewId: 1, verdict: "changes-requested", open: 3, leads: { given: 1, raised: 1 } }],
      findings: [
        // Proposed P3 from a reuse lead, posted at P0.
        { head: HEAD, id: "F1", origin: "round2", key: "maintainability|pkg/a.go|x", path: "pkg/a.go", line: 2, endLine: 3, aspect: "maintainability", severity: "P3", kind: "non-behavioral", text: "**[P0] critical** · maintainability · non-behavioral\n\nParseTTL repeats parseDuration.", state: "open", github: { head: HEAD, reviewId: 1, commentId: 11, inline: true }, history: [{ head: HEAD, status: "open" }] },
        // Posted at P2, then reposted on a later head; stored at its proposed P0.
        { head: HEAD, id: "F4", origin: "round2", key: "correctness|pkg/a.go|y", path: "pkg/a.go", line: 5, aspect: "correctness", severity: "P0", kind: "behavioral", text: "**Still open** (first raised on aaaaaaa).\n\n**[P2] minor** · correctness\n\nA trailing unit is accepted.", state: "open", history: [] },
        // Withdrawn (never posted): what is stored is kept, and nothing shows it.
        { head: HEAD, id: "F5", origin: "round2", key: "maintainability|pkg/a.go|z", path: "pkg/a.go", line: 7, severity: "P1", text: "Unclear name.", state: "withdrawn", history: [] },
        // A 0.21 item with no label in its text: what is stored is kept.
        { head: HEAD, id: "F6", origin: "round2", key: "k", path: "pkg/a.go", line: 8, severity: "P1", text: "Old text.", state: "open", history: [] },
      ],
    },
  };

  it("reads each posted finding's final priority from its posted label, and keeps the stored one otherwise", () => {
    const registry = registryOf(ledger);
    expect(registry.items.map((i) => [i.id, i.severity])).toEqual([["F1", "P0"], ["F4", "P2"], ["F5", "P1"], ["F6", "P1"]]);
    expect(registry.nextF).toBe(7);
    expect(postedPriority("**[P1] major** · security\n\nx")).toBe("P1");
    expect(postedPriority("no label")).toBeUndefined();
  });

  it("writes the final priority back when an earlier finding is recorded at its new place", () => {
    const registry = registryOf(ledger);
    const outcome = { id: "F1", status: "open" as const, how: "reviewer" as const, reason: "still there", path: "pkg/a.go", side: "RIGHT" as const, line: 2, endLine: 3, outdated: false };
    const lines = priorLines(registry, { owner: "apache", repo: "skywalking-banyandb", number: 7 }, [{ aspect: "maintainability", prior: [outcome] }] as never, files, []);
    expect(lines.find((l) => l.id === "F1")!.moved?.meta.severity).toBe("P0");
    const given = aspectPrior(registry, "correctness", files, new Set(["pkg/a.go"])).given;
    expect(given.map((p) => [p.id, p.severity])).toEqual([["F4", "P2"]]);
  });
});
