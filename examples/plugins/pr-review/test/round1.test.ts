// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { FinalAnswer } from "../src/answers.js";
import { defaultNecessity } from "../src/rehearsal-qa.js";
import { necessityAnswer, necessityJson, type Necessity, type PrincipleVerdict } from "../src/necessity.js";
import { effectivePacks } from "../src/packs.js";
import { parseRound1Record, round1Json, round1Record, ROUND1_SCHEMA } from "../src/round1.js";
import type { PullFile } from "../src/snapshot.js";
import { parsePatch } from "../src/patch.js";

const PACKS = effectivePacks({ symbols: [] });
const PATCH = "@@ -0,0 +1,4 @@\n+package schema\n+\n+func ParseTTL() {}\n+// end";
const file = (path: string, patch: string | null = PATCH): PullFile => ({ path, status: "added", previousPath: null, additions: 4, deletions: 0, patch, patchOmitted: patch === null, parsed: parsePatch(patch) });
const FILES = [file("pkg/schema/ttl.go")];

/** `necessity.json` for an N1 with this conclusion and principle verdicts, the checker supporting each verdict unless said otherwise. */
function necessity(conclusion: Necessity["conclusion"], over: { principles?: PrincipleVerdict[]; checks?: Array<{ id: string; verdict: "supported" | "unsupported" }>; verdict?: FinalAnswer["check"]["verdict"] } = {}): string {
  const n: Necessity = { ...defaultNecessity("Parse retention durations"), conclusion, rationale: `the change is ${conclusion}`, ...(over.principles !== undefined ? { principles: over.principles } : {}) };
  n.design = { ...n.design, changed: [{ path: "pkg/schema/ttl.go", tree: "head", start: 3, end: 3, quote: "func ParseTTL" }] };
  const final = { ...necessityAnswer(n), check: { verdict: over.verdict ?? "supported", note: "", searches: [], principles: (over.checks ?? []).map((c) => ({ ...c, note: "" })) }, notes: [], history: [] } as unknown as FinalAnswer;
  return necessityJson({ final, decision: { action: "ask-all", reason: "test" } });
}

interface Q {
  id: string;
  type: string;
  item?: string;
  symbol?: string;
  text?: string;
  answer?: { status: string; none_found?: boolean; answer?: string; citations?: Array<{ path: string; start: number; end: number; tree: string }> };
}
const qa = (questions: Q[], symbols: Array<{ id: string; path: string; startLine: number }> = [{ id: "S1", path: "pkg/schema/ttl.go", startLine: 3 }]): string =>
  JSON.stringify({ schema: "pr-qa-v1", symbols, questions: questions.map((q) => ({ item: "R1", text: `question ${q.id}`, ...q, answer: q.answer !== undefined ? { answer: "the answer", none_found: false, citations: [], ...q.answer } : undefined })) });

const run = (questions: Q[], n: string | undefined = necessity("necessary"), files: readonly PullFile[] = FILES) => round1Record({ head: "h".repeat(40), necessity: n, qa: qa(questions), files, itemCites: { R1: { path: "pkg/schema/ttl.go", start: 3, end: 3 } }, packs: PACKS })!;
const ids = (r: ReturnType<typeof run>): string[] => r.issues.map((i) => i.id);
const TEST_CITE = [{ path: "pkg/schema/ttl_test.go", start: 1, end: 9, tree: "base" }];

describe("round 1's issues, computed from necessity.json and qa.json", () => {
  it("are none when N1 is necessary and every answer is plain, so the same run goes on to round 2", () => {
    const r = run([
      { id: "Q1", type: "purpose", answer: { status: "answered", citations: [{ path: "pkg/schema/ttl.go", start: 3, end: 3, tree: "head" }] } },
      { id: "Q2", type: "existing-reuse-common", symbol: "S1", answer: { status: "answered", none_found: true } },
      { id: "Q3", type: "missing-test", symbol: "S1", answer: { status: "answered", citations: TEST_CITE } },
      { id: "Q4", type: "split-function", symbol: "S1", answer: { status: "answered" } },
    ]);
    expect(r).toMatchObject({ schema: ROUND1_SCHEMA, necessity: "necessary", issues: [] });
  });

  it("include N1 when its conclusion is not necessary: questionable, unnecessary or needs author", () => {
    for (const c of ["questionable", "unnecessary", "needs author"] as const) {
      const r = run([], necessity(c));
      expect(r.issues, c).toHaveLength(1);
      expect(r.issues[0]).toMatchObject({ id: "N1", kinds: ["necessity"], path: "pkg/schema/ttl.go", line: 3, anchored: true });
      expect(r.issues[0]!.body).toContain(`Necessity: ${c}`);
    }
  });

  it("include N1 when the checker supports a broken design principle, though the answerer said necessary, and say which", () => {
    const broken: PrincipleVerdict = { id: "offline-idempotent", verdict: "breaks", explanation: "x", citations: [] };
    const supported = run([], necessity("necessary", { principles: [broken], checks: [{ id: "offline-idempotent", verdict: "supported" }] }));
    expect(supported.necessity).toBe("questionable");
    expect(supported.issues[0]!.body).toContain("Design principle broken (the checker supports it): offline-idempotent.");
    const unsupported = run([], necessity("necessary", { principles: [broken], checks: [{ id: "offline-idempotent", verdict: "unsupported" }] }));
    expect(unsupported.issues).toEqual([]);
  });

  it("include N1 when the checker downgraded it (unsupported after the correction)", () => {
    expect(ids(run([], necessity("necessary", { verdict: "downgraded" })))).toEqual(["N1"]);
  });

  it("treat a run with no necessity.json as N1 needing the author", () => {
    expect(round1Record({ head: "h", necessity: undefined, qa: qa([]), files: FILES, itemCites: {}, packs: PACKS })!.issues[0]).toMatchObject({ id: "N1", status: "needs author" });
  });

  it("include every question whose answer needs the author, and every partially answered one", () => {
    const r = run([
      { id: "Q1", type: "purpose", answer: { status: "needs author" } },
      { id: "Q2", type: "split-function", symbol: "S1", answer: { status: "partially answered" } },
      { id: "Q3", type: "split-function", symbol: "S1", answer: { status: "answered" } },
    ]);
    expect(r.issues.map((i) => [i.id, i.kinds, i.status])).toEqual([["Q1", ["needs-author"], "needs author"], ["Q2", ["partial"], "partially answered"]]);
  });

  it("include an answer that found an existing equivalent, a reusable library or common logic, even when it is fully answered", () => {
    const r = run([
      { id: "Q1", type: "existing-reuse-common", symbol: "S1", answer: { status: "answered", none_found: false, citations: [{ path: "pkg/timestamp/duration.go", start: 30, end: 42, tree: "base" }] } },
      { id: "Q2", type: "existing-reuse-common", symbol: "S1", answer: { status: "answered", none_found: true } },
    ]);
    expect(r.issues.map((i) => [i.id, i.kinds, i.status])).toEqual([["Q1", ["existing"], "answered"]]);
    expect(r.issues[0]!.body).toContain("pkg/timestamp/duration.go:30");
  });

  it("include a missing-test question whose answer finds no covering test, even when it is fully answered", () => {
    const r = run([
      { id: "Q1", type: "missing-test", symbol: "S1", answer: { status: "answered", none_found: true } },
      { id: "Q2", type: "missing-test", symbol: "S1", answer: { status: "answered", citations: [{ path: "pkg/schema/ttl.go", start: 3, end: 3, tree: "head" }] } },
      { id: "Q3", type: "missing-test", symbol: "S1", answer: { status: "answered", citations: TEST_CITE } },
      { id: "Q4", type: "missing-test", symbol: "S1", answer: { status: "needs author" } },
    ]);
    expect(r.issues.map((i) => [i.id, i.kinds])).toEqual([["Q1", ["missing-test"]], ["Q2", ["missing-test"]], ["Q4", ["needs-author", "missing-test"]]]);
  });

  it("judge a cited test by the effective packs' own convention, so a configured test path is not a false blocking issue", () => {
    const cited = (path: string) => [{ id: "Q1", type: "missing-test", symbol: "S1", answer: { status: "answered", citations: [{ path, start: 1, end: 9, tree: "base" }] } }] as Q[];
    const issuesFor = (path: string, packs = PACKS) => round1Record({ head: "h", necessity: necessity("necessary"), qa: qa(cited(path)), files: FILES, itemCites: {}, packs })!.issues;
    for (const p of ["pkg/a_test.go", "src/a.test.ts", "src/a.spec.tsx"]) expect(issuesFor(p), p).toEqual([]);
    expect(issuesFor("pkg/a.go")).toHaveLength(1);
    // A project that keeps its tests under check/ declares it in its profile's symbol pack; the default packs know nothing of it.
    const custom = effectivePacks({ symbols: [{ language: "go", globs: ["**/*.go"], testFiles: ["**/check/**"] }] as never });
    expect(issuesFor("pkg/check/ttl.go", custom)).toEqual([]);
    expect(issuesFor("pkg/check/ttl.go")).toHaveLength(1);
  });

  it("anchor an issue inside a hunk of the file's patch, and send one outside it, or in a file without a patch, to the review body", () => {
    const inside = run([{ id: "Q1", type: "purpose", symbol: "S1", answer: { status: "needs author" } }]);
    expect(inside.issues[0]).toMatchObject({ path: "pkg/schema/ttl.go", line: 3, anchored: true });
    const outside = round1Record({ head: "h", necessity: necessity("necessary"), qa: qa([{ id: "Q1", type: "purpose", symbol: "S1", answer: { status: "needs author" } }], [{ id: "S1", path: "pkg/schema/ttl.go", startLine: 40 }]), files: FILES, itemCites: {}, packs: PACKS })!;
    expect(outside.issues[0]).toMatchObject({ line: 40, anchored: false });
    const noPatch = run([{ id: "Q1", type: "purpose", symbol: "S1", answer: { status: "needs author" } }], necessity("necessary"), [file("pkg/schema/ttl.go", null)]);
    expect(noPatch.issues[0]).toMatchObject({ anchored: false });
    const nowhere = run([{ id: "Q1", type: "purpose", item: "R9", answer: { status: "needs author" } }]);
    expect(nowhere.issues[0]).not.toHaveProperty("path");
    expect(nowhere.issues[0]!.anchored).toBe(false);
  });

  it("hold no path inside .graphloom/ and read back from their JSON", () => {
    const r = run([{ id: "Q1", type: "purpose", symbol: "S1", text: "See .graphloom/review/review.md for why", answer: { status: "needs author", answer: "kept in .graphloom/review/qa.json" } }]);
    expect(r.issues[0]!.body).not.toContain(".graphloom/");
    expect(parseRound1Record(round1Json(r))).toEqual(r);
    expect(parseRound1Record("{}")).toBeUndefined();
    expect(round1Record({ head: "h", necessity: undefined, qa: "not json", files: [], itemCites: {}, packs: PACKS })).toBeUndefined();
  });

  it("skip N1's own question in the Q&A list (it is judged from necessity.json) and a question that was never answered", () => {
    const r = run([{ id: "N1", type: "necessity", answer: { status: "needs author" } }, { id: "Q1", type: "purpose" }]);
    expect(r.issues).toEqual([]);
  });
});
