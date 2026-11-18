// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * pr-review 1.0 (design-pr-review-split §4, §11 item 5): the context source chosen by its rule and recomputed by `review-context`,
 * the leads computed from measurement records, test maps and searches, a missing lead status corrected in the same session, a
 * raised lead's finding verified like any other, the verdict with and without a round-1 record, and nothing of round 1 posted again.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { computeLeads, MAX_LEADS, NOT_GIVEN, type LeadInput } from "../src/leads.js";
import type { MetricsRecord } from "../src/kit/metrics/record.js";
import type { SymbolDef } from "../src/kit/symbols.js";
import type { TestEvidence } from "../src/kit/testmap.js";
import type { ViewItem } from "../src/kit/reportview.js";
import { REHEARSAL_DESIGN_HEAD, REHEARSAL_HEAD, REHEARSAL_REQUEST, REHEARSAL_REQUEST_NO_REPORT } from "../src/rehearsal.js";
import { recordedContext, recordedSeed } from "../src/runcontext.js";
import { recordedAspect, writtenDraftFiles } from "../src/reviewdraft.js";
import { reviewContext } from "../src/validators.js";
import { findingsProven, leadsJudged } from "../src/reviewvalidators.js";
import { REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME } from "../src/review.js";
import { priorChunkText, writtenReviewLedger } from "../src/kit/ledger.js";
import { findingMarker } from "../src/publish.js";
import { BANYANDB, candidateEvidence, scenarioWith, simulate, type Simulation } from "./support.js";

const contextOf = (s: Simulation) => {
  const c = recordedContext(s.evidence);
  if (c.state !== "read") throw new Error(`no context: ${JSON.stringify(s.final).slice(0, 400)}`);
  return c.value;
};
const reporters = (s: Simulation) => s.jobs.filter((j) => j.resultSchema === "change-report-v1").length;
const seedOf = (s: Simulation): string => {
  const w = recordedSeed(s.evidence);
  if (w.state !== "read") throw new Error("no seed");
  return w.value;
};
const body = (s: Simulation): string => String(s.github.creates.at(-1)?.body ?? "");
const evaluate = (s: Simulation, request: string | undefined) => {
  const evidence = candidateEvidence(s.evidence, s.evidence.flatMap((e) => (e.candidateDigest !== undefined ? [e.candidateDigest] : [])).at(-1)!);
  return reviewContext.evaluate({ requirementId: "review-context", statement: "", evidence, config: BANYANDB, ...(request !== undefined ? { request } : {}) });
};
const ended = (s: Simulation) => expect(s.final.action, JSON.stringify(s.final).slice(0, 800)).toMatchObject({ type: "stop", stop: { reason: "complete" } });

describe("the context source, chosen by its rule and recomputed by review-context (design-pr-review-split §4.2)", () => {
  const thisHead = simulate({ scenarioName: "design-review" });
  const earlier = simulate({ scenarioName: "design-review-earlier-head" });
  const unusable = simulate({ scenarioName: "design-review-unusable-delta" });
  const prelude = simulate({ scenarioName: "prelude" });
  const none = simulate({ scenarioName: "no-report", request: REHEARSAL_REQUEST_NO_REPORT });

  it("takes the design section's report of this head as it is: no reporter runs, and the seed is the design review's report", () => {
    ended(thisHead);
    expect(contextOf(thisHead)).toMatchObject({ source: "design-review", head: REHEARSAL_HEAD, reasons: [], noReport: false });
    expect(contextOf(thisHead).delta).toBeUndefined();
    expect(reporters(thisHead)).toBe(0);
    expect(thisHead.jobs.filter((j) => j.resultSchema === "claim-check-v1")).toEqual([]);
    expect(seedOf(thisHead)).toContain("The context of this review is the design review (round 1, pr-design-review) of this head");
    expect(seedOf(thisHead)).not.toContain("## Since this report");
    expect(evaluate(thisHead, REHEARSAL_REQUEST)).toMatchObject({ status: "passed" });
  });

  it("takes an earlier design head's report when the delta to this head is usable, with a Since this report part", () => {
    ended(earlier);
    expect(contextOf(earlier)).toMatchObject({ source: "design-review", head: REHEARSAL_DESIGN_HEAD, delta: [{ path: "docs/retention.md", whole: false, hunks: [{ oldStart: 3, oldCount: 0, newStart: 4, newCount: 1 }] }] });
    expect(reporters(earlier)).toBe(0);
    const seed = seedOf(earlier);
    expect(seed).toContain("## Since this report");
    expect(seed).toContain(`describe ${REHEARSAL_DESIGN_HEAD.slice(0, 12)}; this head is ${REHEARSAL_HEAD.slice(0, 12)}`);
    expect(seed).toContain("- docs/retention.md: @@ -3,0 +4,1 @@");
    expect(evaluate(earlier, REHEARSAL_REQUEST)).toMatchObject({ status: "passed" });
  });

  it("falls back to the prelude when the delta from the earlier head is not usable, recording why", () => {
    ended(unusable);
    expect(contextOf(unusable)).toMatchObject({ source: "prelude", reasons: [expect.stringMatching(/^the delta from the design head fedcba987654 could not be read/)] });
    expect(reporters(unusable)).toBe(1);
    expect(evaluate(unusable, REHEARSAL_REQUEST)).toMatchObject({ status: "passed" });
  });

  it("is the prelude when there is no ledger and no --no-report", () => {
    expect(contextOf(prelude)).toMatchObject({ source: "prelude", reasons: [expect.stringContaining("no ledger")], noReport: false });
    expect(reporters(prelude)).toBe(1);
  });

  it("is none only with the request's suffix: the seed is the pull request's metadata and patches, and no report is written", () => {
    ended(none);
    expect(contextOf(none)).toMatchObject({ source: "none", noReport: true });
    expect(reporters(none)).toBe(0);
    expect(seedOf(none)).toContain("# Patches of the files in scope");
    expect(writtenDraftFiles(none.evidence).html.state).toBe("none");
    expect(evaluate(none, REHEARSAL_REQUEST_NO_REPORT)).toMatchObject({ status: "passed" });
    // The validator reads the suffix from the pinned request: without it, a recorded none fails.
    expect(evaluate(none, REHEARSAL_REQUEST)).toMatchObject({ status: "failed", reason: expect.stringContaining('only a request that says "without a report"') });
    expect(evaluate(none, undefined)).toMatchObject({ status: "failed" });
  });

  it("keeps a usable design report under --no-report: the suffix replaces the prelude only", () => {
    const s = simulate({ scenarioName: "design-review", request: REHEARSAL_REQUEST_NO_REPORT });
    expect(contextOf(s)).toMatchObject({ source: "design-review", noReport: true });
    expect(evaluate(s, REHEARSAL_REQUEST_NO_REPORT)).toMatchObject({ status: "passed" });
    // A prelude recorded where the request asked for none is not what the evidence recomputes.
    expect(evaluate(prelude, REHEARSAL_REQUEST_NO_REPORT)).toMatchObject({ status: "failed", reason: expect.stringContaining("recompute none") });
  });
});

describe("round 1 in the posted review (design-pr-review-split §4.5)", () => {
  it("lists and counts the design review's open item, with a link, and posts nothing of round 1 again", () => {
    const s = simulate({ scenarioName: "design-review" });
    const text = body(s);
    expect(text.split("\n")[0]).toBe("Changes requested: 2 open");
    expect(text).toContain("Design review at 0123456 (this head): 1 open item:");
    expect(text).toContain("- Q1: [comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r6001)");
    // No round-1 item is a comment or a marked item of this review.
    expect(text).not.toContain(findingMarker("Q1"));
    expect(text).not.toContain(findingMarker("N1"));
    for (const c of s.github.creates[0]!.comments as Array<{ body: string }>) expect(c.body).toMatch(/<!-- graphloom-finding: F\d+ -->$/);
  });

  it("says the head it is as of when the design review reviewed another head", () => {
    expect(body(simulate({ scenarioName: "design-review-earlier-head" }))).toContain(`Design review as of ${REHEARSAL_DESIGN_HEAD.slice(0, 7)}; run pr-design-review on this head to re-check them: 1 open item:`);
  });

  it("counts the findings only when round 1 was not run", () => {
    const text = body(simulate({ scenarioName: "prelude" }));
    expect(text.split("\n")[0]).toBe("Changes requested: 1 open");
    expect(text).toContain("Round 1 (the design review) was not run on this pull request; the verdict counts this review's findings only.");
  });

  it("reads a v1 ledger migrated in memory, and its first write of the review section migrates it", () => {
    const sha = "c".repeat(40);
    const v1 = {
      schema: "graphloom-pr-ledger-v1",
      heads: [{ sha: "a".repeat(40), base: "b".repeat(40), reviewed: false, round1: "issues", reviewId: 7000, open: 1 }],
      qa: [],
      findings: [{ head: "a".repeat(40), id: "Q2", origin: "round1", path: "pkg/a.go", line: 3, key: "purpose|item|pkg/a.go", state: "open", github: { head: "a".repeat(40), reviewId: 7000, commentId: 9000, inline: true }, history: [{ head: "a".repeat(40), status: "open" }] }],
    };
    const s = simulate({ scenario: scenarioWith("reuse-lead", (x) => Object.assign(x.commands!, { "ledger-read": { exitCode: 0, stdout: `present ${sha}\n` }, "ledger-prior": { exitCode: 0, stdout: priorChunkText(JSON.stringify(v1), 0) } })) });
    ended(s);
    expect(body(s)).toContain("- Q2: [comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r9000)");
    const write = s.jobs.find((j) => j.instruction.startsWith("Advance the ledger's review section"))!;
    expect(writtenReviewLedger((write.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv)).toMatchObject({ old: sha, migration: { mode: "v1" } });
  });
});

// ---- leads (design-pr-review-split §4.3) ----

const sym = (id: string, path: string, qualified: string, change: "new" | "modified", start: number, end: number, kind = "func"): SymbolDef => ({ id, path, language: "go", scope: "x", dir: path.slice(0, path.lastIndexOf("/")), kind, name: qualified.split(".").at(-1)!, qualified, exported: true, startLine: start, endLine: end, signature: `func ${qualified}()`, body: `func ${qualified}() {}`, change });
const rec = (path: string, fn: string, start: number, end: number, over: Partial<MetricsRecord> = {}): MetricsRecord => ({ path, function: fn, startLine: start, endLine: end, change: "added", test: false, complexity: 2, decisions: [], nesting: 1, nestingPath: [], coverage: { source: "unknown", reason: "not run" }, ...over });
const test: TestEvidence = { kind: "reference", path: "pkg/c/tested_test.go", line: 4, text: "c.Delta()" };

const SYMBOLS = [
  sym("S1", "pkg/a/feature.go", "a.Alpha", "new", 3, 10),
  sym("S2", "pkg/a/feature.go", "a.Beta", "new", 12, 20),
  sym("S3", "pkg/b/util.go", "b.Gamma", "modified", 5, 30),
  sym("S4", "pkg/c/tested.go", "c.Delta", "new", 3, 12),
  sym("S5", "pkg/c/tested.go", "c.Kind", "new", 14, 16, "type"),
  sym("S6", "pkg/d/z.go", "d.Zeta", "new", 2, 9),
];
const RECORDS = (coverage: boolean): MetricsRecord[] => [
  rec("pkg/b/util.go", "b.Gamma", 5, 30, { change: "modified", complexity: 12, nesting: 4, base: { complexity: 12, nesting: 4, startLine: 5, endLine: 28, path: "pkg/b/util.go" } }),
  rec("pkg/c/tested.go", "c.Delta", 3, 12, { complexity: 9, ...(coverage ? { coverage: { source: "measured", covered: 2, total: 10 }, mutation: { status: "run", killed: 3, timeout: 0, invalid: 0, survivors: [{ line: 7, operator: "relational-inversion", original: "a > b", mutated: "a <= b" }] } } : {}) }),
  rec("pkg/d/z.go", "d.Zeta", 2, 9, coverage ? { coverage: { source: "measured", covered: 3, total: 4 } } : {}),
];
const W1: ViewItem = { id: "W1", section: "highlevel", text: "Adds the alpha feature.", cites: [{ path: "pkg/a/feature.go", side: "head", start: 3, end: 20, symbol: "" }], facts: [] };
const ALL = ["pkg/a/feature.go", "pkg/b/util.go", "pkg/c/tested.go", "pkg/d/z.go"];
const input = (over: Partial<LeadInput> = {}, coverage = true): LeadInput => ({
  records: RECORDS(coverage),
  groundwork: {
    symbols: SYMBOLS,
    testMap: new Map([["S4", [test]]]),
    candidates: [
      { symbol: "S4", path: "pkg/old/delta.go", line: 30, via: ["name"], similarity: 0.2 },
      { symbol: "S6", path: "pkg/d/z.go", line: 1, via: ["name"], similarity: 1 },
      { symbol: "S1", path: "pkg/old/alpha.go", line: 4, via: ["tokens"], similarity: 0.2 },
    ],
    prSimilar: [],
  },
  changes: [W1],
  scope: new Set(ALL),
  changed: new Set(ALL),
  similarity: 0.5,
  searched: true,
  ...over,
});
const kinds = (l: ReturnType<typeof computeLeads>) => l.map((x) => [x.id, x.kind, x.subject]);

describe("the leads, from measurement records, test maps and searches", () => {
  it("computes every kind, untested-feature first, then by kind in the table's order, path and line", () => {
    const leads = computeLeads(input());
    expect(kinds(leads)).toEqual([
      ["L1", "untested-feature", "W1"],
      ["L2", "missing-test", "b.Gamma"],
      ["L3", "weak-test", "c.Delta"],
      ["L4", "split-function", "b.Gamma"],
      ["L5", "crap", "b.Gamma"],
      ["L6", "crap", "c.Delta"],
      ["L7", "reuse", "c.Delta"],
    ]);
    expect(leads.every((l) => l.given)).toBe(true);
    // The functions of the feature are inside its lead, not missing-test leads of their own; a type is never a test lead.
    expect(leads.find((l) => l.kind === "untested-feature")!.facts.join(" ")).toMatch(/a\.Alpha .*a\.Beta/s);
    expect(leads.find((l) => l.kind === "weak-test")).toMatchObject({ path: "pkg/c/tested.go", line: 7, facts: [expect.stringContaining("`a > b` → `a <= b`"), expect.any(String)] });
    expect(leads.find((l) => l.kind === "split-function")!.facts.join(" ")).toContain("inherited");
    // A candidate inside the changed files, or one found by tokens below the similarity, is no reuse lead.
    expect(leads.filter((l) => l.kind === "reuse").map((l) => l.subject)).toEqual(["c.Delta"]);
  });

  it("with coverage off or not run: the test map alone decides, crap uses its unknown-coverage rule, and there is no weak-test lead", () => {
    const leads = computeLeads(input({}, false));
    expect(kinds(leads)).toEqual([
      ["L1", "untested-feature", "W1"],
      ["L2", "missing-test", "b.Gamma"],
      ["L3", "missing-test", "d.Zeta"],
      ["L4", "split-function", "b.Gamma"],
      ["L5", "crap", "b.Gamma"],
      ["L6", "reuse", "c.Delta"],
    ]);
  });

  it("is computed for the review's scope only (large mode: the files of the scoped areas), with no untested-feature without a report", () => {
    expect(kinds(computeLeads(input({ scope: new Set(["pkg/a/feature.go"]) })))).toEqual([["L1", "untested-feature", "W1"]]);
    expect(kinds(computeLeads(input({ scope: new Set(["pkg/a/feature.go"]), changes: [] })))).toEqual([
      ["L1", "missing-test", "a.Alpha"],
      ["L2", "missing-test", "a.Beta"],
    ]);
  });

  it("computes no reuse lead past limits.maxNewSymbols, where no search ran", () => {
    expect(computeLeads(input({ searched: false })).some((l) => l.kind === "reuse")).toBe(false);
  });

  it("gives at most 60, untested-feature first; the rest are recorded as not given", () => {
    const many = Array.from({ length: 70 }, (_, i) => sym(`S${i + 1}`, `pkg/m/f${String(i).padStart(2, "0")}.go`, `m.F${i}`, "new", 1, 5));
    const leads = computeLeads({ ...input(), records: [], groundwork: { symbols: many, testMap: new Map(), candidates: [], prSimilar: [] }, changes: [{ ...W1, cites: [{ path: "pkg/m/f69.go", side: "head", start: 1, end: 5, symbol: "" }] }], scope: new Set(many.map((s) => s.path)) });
    expect(leads).toHaveLength(70);
    expect(leads[0]).toMatchObject({ kind: "untested-feature", given: true });
    expect(leads.filter((l) => l.given)).toHaveLength(MAX_LEADS);
    expect(leads.slice(MAX_LEADS).every((l) => !l.given)).toBe(true);
    expect(NOT_GIVEN).toBe("not given: over the lead bound of 60");
  });
});

describe("the maintainability reviewer judges each lead it is given", () => {
  it("records a status for every lead of the run, recomputed by leads-judged", () => {
    const s = simulate({ scenarioName: "complex-function" });
    ended(s);
    const r = recordedAspect(s.evidence, "maintainability");
    expect(r.state === "read" && r.value.leads.map((l) => [l.kind, l.status])).toEqual([["untested-feature", "not-an-issue"], ["split-function", "not-an-issue"], ["crap", "not-an-issue"]]);
    const c = recordedAspect(s.evidence, "correctness");
    expect(c.state === "read" && c.value.leads).toEqual([]);
    const evidence = candidateEvidence(s.evidence, s.evidence.flatMap((e) => (e.candidateDigest !== undefined ? [e.candidateDigest] : [])).at(-1)!);
    expect(leadsJudged.evaluate({ requirementId: "leads-judged", statement: "", evidence, config: BANYANDB })).toMatchObject({ status: "passed" });
    // The correctness reviewer gets the untested functions as context, with no status asked.
    const correctness = s.jobs.find((j) => j.instruction.startsWith("Review the correctness aspect (pass 1)"))!;
    expect((correctness.input as { assignment: string }).assignment).toContain("Test gaps in your scope");
  });

  it("sends a missing lead status back to the same session as a correction", () => {
    const scenario = scenarioWith("complex-function", (x) => {
      const replies = x.results[REVIEW_SCHEMA_NAME]!;
      const first = structuredClone(replies[2]!);
      (first.output as { leads: unknown[] }).leads = (first.output as { leads: unknown[] }).leads.slice(1);
      replies.splice(2, 0, first);
    });
    const s = simulate({ scenario });
    ended(s);
    const passes = s.jobs.filter((j) => j.instruction === "Review the maintainability aspect (pass 1)");
    expect(passes).toHaveLength(2);
    expect(passes[0]!.continueFrom).toBeUndefined();
    expect(passes[1]!.continueFrom).toMatch(/^op\d+$/);
    expect((passes[1]!.input as { assignment: string }).assignment).toMatch(/missing L1/);
    const r = recordedAspect(s.evidence, "maintainability");
    expect(r.state === "read" && r.value.leads.every((l) => l.status === "not-an-issue")).toBe(true);
  });

  it("verifies a raised lead's finding like any other: an untested feature confirmed is drafted at P1 and asks for changes", () => {
    const s = simulate({ scenarioName: "untested-feature" });
    ended(s);
    const r = recordedAspect(s.evidence, "maintainability");
    if (r.state !== "read") throw new Error("not recorded");
    const lead = r.value.leads.find((l) => l.kind === "untested-feature")!;
    expect(lead).toMatchObject({ status: "raised", finding: expect.stringMatching(/^F\d+$/) });
    const f = r.value.findings.find((x) => x.id === lead.finding)!;
    expect(f).toMatchObject({ lead: lead.id, leadKind: "untested-feature", state: "confirmed", verdict: { verdict: "confirmed" } });
    const verify = s.jobs.find((j) => j.instruction === "Verify the maintainability pass 1 findings")!;
    expect((verify.input as { assignment: string }).assignment).toContain("Raised from an untested-feature lead");
    const draft = JSON.parse((writtenDraftFiles(s.evidence).draftJson as { value: string }).value) as { recommended: string; comments: Array<{ id: string; severity: string; lead?: { kind: string } }> };
    expect(draft.comments.find((c) => c.id === f.id)).toMatchObject({ severity: "P1", lead: { kind: "untested-feature" } });
    expect(draft.recommended).toBe("request-changes");
    const evidence = candidateEvidence(s.evidence, s.evidence.flatMap((e) => (e.candidateDigest !== undefined ? [e.candidateDigest] : [])).at(-1)!);
    expect(findingsProven.evaluate({ requirementId: "findings-proven", statement: "", evidence, config: BANYANDB })).toMatchObject({ status: "passed", reason: expect.stringContaining("raised from an untested-feature lead") });
    // A finding that says it was raised from an untested-feature lead that does not recompute is not proven.
    const forged = evidence.map((e): EvidenceRecord => {
      const c = (e.payload as { command?: { id: string; argv: string[] } }).command;
      if (c?.id !== "review-aspect-maintainability") return e;
      return { ...e, payload: { ...(e.payload as object), command: { ...c, argv: c.argv.map((a) => a.split(`"lead":"${lead.id}"`).join('"lead":"L99"')) } } };
    });
    expect(findingsProven.evaluate({ requirementId: "findings-proven", statement: "", evidence: forged, config: BANYANDB })).toMatchObject({ status: "failed", reason: expect.stringContaining("does not recompute") });
  });
});

describe("a finding raised from a reuse lead is drafted and posted at P0 (design §7.3)", () => {
  // The reuse-lead scenario's maintainability reviewer raises its reuse lead (L2) at P3, and its untested-feature lead (L1) at P3 too;
  // the verifier confirms the reuse finding (F4).
  const scenario = scenarioWith("reuse-lead", (x) => {
    const pass = x.results[REVIEW_SCHEMA_NAME]![2]!.output as { comments: Array<Record<string, unknown>>; leads: Array<Record<string, unknown>> };
    const own = pass.comments[0]!;
    pass.comments.push(
      { ...own, start_line: 6, end_line: 18, severity: "P3", distinct: true, content: "ParseTTL repeats timestamp.ParseDuration (pkg/timestamp/duration.go:30); call it instead." },
      { ...own, start_line: 1, end_line: 1, severity: "P3", distinct: true, content: "ParseTTL has no test." },
    );
    pass.leads = [
      { lead: "L1", status: "raised", comment: 2, reason: "raised as a comment" },
      { lead: "L2", status: "raised", comment: 1, reason: "raised as a comment" },
    ];
    const verify = x.results[VERIFY_SCHEMA_NAME]![1]!.output as { verdicts: Array<Record<string, unknown>> };
    verify.verdicts.push({ ...verify.verdicts[0]!, finding: "F4", witness: "pkg/timestamp/duration.go:30", reason: "ParseDuration parses the same units", fixes: false });
  });
  const s = simulate({ scenario });
  const candidate = (): EvidenceRecord[] => candidateEvidence(s.evidence, s.evidence.flatMap((e) => (e.candidateDigest !== undefined ? [e.candidateDigest] : [])).at(-1)!);

  it("verifies the P3 reuse comment as a finding, and still counts the P3 untested-feature comment as a nit", () => {
    ended(s);
    const r = recordedAspect(s.evidence, "maintainability");
    if (r.state !== "read") throw new Error("not recorded");
    expect(r.value.passes[0]).toMatchObject({ raised: ["F3", "F4"], nits: 1 });
    expect(r.value.findings.find((f) => f.id === "F4")).toMatchObject({ lead: "L2", leadKind: "reuse", severity: "P3", state: "confirmed" });
    expect(r.value.leads.map((l) => [l.id, l.status, l.finding])).toEqual([["L1", "raised", "a nit (P3): not verified or posted"], ["L2", "raised", "F4"]]);
    const verify = s.jobs.filter((j) => j.resultSchema === VERIFY_SCHEMA_NAME).at(-1)!;
    expect((verify.input as { assignment: string }).assignment).toContain("F4 [maintainability, non-behavioral, P3]");
  });

  it("drafts it at P0, recommends request-changes, and posts it labelled P0, with every receipt of Review, Draft and Publish valid", () => {
    const draft = JSON.parse((writtenDraftFiles(s.evidence).draftJson as { value: string }).value) as { recommended: string; comments: Array<{ id: string; severity: string; lead?: { id: string; kind: string } }> };
    expect(draft.comments.find((c) => c.id === "F4")).toMatchObject({ severity: "P0", lead: { id: "L2", kind: "reuse" } });
    expect(draft.recommended).toBe("request-changes");
    const posted = [body(s), ...(s.github.creates[0]!.comments as Array<{ body: string }>).map((c) => c.body)].find((t) => t.includes(findingMarker("F4")))!;
    expect(posted).toContain("**[P0] critical**");
    expect(s.receipts.filter((x) => x.valid).map((x) => x.requirementId)).toEqual(expect.arrayContaining(["leads-judged", "findings-proven", "draft-composed", "ledger-recorded", "review-published"]));
    expect(findingsProven.evaluate({ requirementId: "findings-proven", statement: "", evidence: candidate(), config: BANYANDB })).toMatchObject({ status: "passed", reason: expect.stringContaining("1 raised from a weak-test, split-function, crap or reuse lead (drafted at P0)") });
  });

  it("keeps the reuse lead when an untested-feature lead's comment, raised first, and the reuse comment merge into one finding", () => {
    const merged = simulate({
      scenario: scenarioWith("reuse-lead", (x) => {
        const pass = x.results[REVIEW_SCHEMA_NAME]![2]!.output as { comments: Array<Record<string, unknown>>; leads: Array<Record<string, unknown>> };
        const own = pass.comments[0]!;
        pass.comments.push({ ...own, start_line: 1, end_line: 2, severity: "P2", content: "ParseTTL has no test." }, { ...own, start_line: 2, end_line: 3, severity: "P3", content: "ParseTTL repeats timestamp.ParseDuration; call it instead." });
        pass.leads = [
          { lead: "L1", status: "raised", comment: 1, reason: "raised as a comment" },
          { lead: "L2", status: "raised", comment: 2, reason: "raised as a comment" },
        ];
        const verify = x.results[VERIFY_SCHEMA_NAME]![1]!.output as { verdicts: Array<Record<string, unknown>> };
        verify.verdicts.push({ ...verify.verdicts[0]!, finding: "F4", witness: "pkg/timestamp/duration.go:30", reason: "ParseDuration parses the same units", fixes: false });
      }),
    });
    ended(merged);
    const r = recordedAspect(merged.evidence, "maintainability");
    if (r.state !== "read") throw new Error("not recorded");
    expect(r.value.passes[0]).toMatchObject({ raised: ["F3", "F4"], nits: 0, merged: 1 });
    expect(r.value.findings.find((f) => f.id === "F4")).toMatchObject({ lead: "L2", leadKind: "reuse", state: "confirmed" });
    const draft = JSON.parse((writtenDraftFiles(merged.evidence).draftJson as { value: string }).value) as { recommended: string; comments: Array<{ id: string; severity: string; lead?: { id: string; kind: string } }> };
    expect(draft.comments.find((c) => c.id === "F4")).toMatchObject({ severity: "P0", lead: { id: "L2", kind: "reuse" } });
    expect(draft.recommended).toBe("request-changes");
    expect(merged.receipts.some((x) => x.requirementId === "findings-proven" && x.valid)).toBe(true);
  });

  it("fails findings-proven for a forged lead: an unknown id, another kind, or a lead the record does not show raised by the finding", () => {
    const forge = (from: string, to: string): EvidenceRecord[] =>
      candidate().map((e): EvidenceRecord => {
        const c = (e.payload as { command?: { id: string; argv: string[] } }).command;
        if (c?.id !== "review-aspect-maintainability") return e;
        return { ...e, payload: { ...(e.payload as object), command: { ...c, argv: c.argv.map((a) => a.split(from).join(to)) } } };
      });
    const judge = (evidence: EvidenceRecord[]) => findingsProven.evaluate({ requirementId: "findings-proven", statement: "", evidence, config: BANYANDB });
    expect(judge(forge('"lead":"L2"', '"lead":"L99"'))).toMatchObject({ status: "failed", reason: expect.stringContaining("F4 is raised from the reuse lead L99, which does not recompute") });
    expect(judge(forge('"leadKind":"reuse"', '"leadKind":"crap"'))).toMatchObject({ status: "failed", reason: expect.stringContaining("F4 is raised from the crap lead L2, which does not recompute") });
    expect(judge(forge('"finding":"F4"', '"finding":"F3"'))).toMatchObject({ status: "failed", reason: expect.stringContaining("F4 names the reuse lead L2, which the record does not show raised by it") });
  });
});
