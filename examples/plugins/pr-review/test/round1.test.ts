// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { FinalAnswer } from "../src/answers.js";
import { defaultNecessity } from "../src/rehearsal-qa.js";
import { necessityAnswer, necessityJson, type Necessity, type PrincipleVerdict } from "../src/necessity.js";
import { effectivePacks } from "../src/packs.js";
import { MAX_ITEM_TEXT, parseRound1Record, round1Json, round1Record, ROUND1_SCHEMA } from "../src/round1.js";
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
  answer?: { status: string; none_found?: boolean; reusable?: boolean; answer?: string; citations?: Array<{ path: string; start: number; end: number; tree: string }> };
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

  describe("an existing-equivalent answer is an issue only when the equivalent lies outside the change", () => {
    const cite = (path: string, tree = "base", start = 10) => ({ path, start, end: start + 5, tree });
    const reuse = (id: string, citations: Array<ReturnType<typeof cite>>, symbol = "S1"): Q => ({ id, type: "existing-reuse-common", symbol, answer: { status: "answered", citations } });
    const files = [file("pkg/schema/ttl.go"), { ...file("pkg/merge/new.go"), status: "renamed", previousPath: "pkg/merge/old.go" }];

    it("is not an issue when every equivalent is in a file the pull request changes, and is noted", () => {
      const r = run([reuse("Q1", [cite("pkg/schema/ttl.go"), cite("pkg/merge/old.go"), cite("pkg/merge/new.go", "head")])], necessity("necessary"), files);
      expect(r.issues.filter((i) => i.id === "Q1")).toEqual([]);
      expect(r.noted).toEqual([{ id: "Q1", key: expect.any(String), note: "the equivalent it names is the code this pull request changes" }]);
    });

    it("is an issue when the equivalent is in a file the pull request does not change", () => {
      const r = run([reuse("Q1", [cite("pkg/timestamp/duration.go")])], necessity("necessary"), files);
      expect(ids(r)).toEqual(["Q1"]);
      expect(r.noted).toBeUndefined();
    });

    it("is an issue when it cites a declared library, even at a path the pull request also changes", () => {
      const r = run([reuse("Q1", [cite("pkg/schema/ttl.go", "dependency")])], necessity("necessary"), files);
      expect(ids(r)).toEqual(["Q1"]);
    });

    it("is an issue when the citations are mixed, one inside the change and one outside", () => {
      const r = run([reuse("Q1", [cite("pkg/schema/ttl.go"), cite("pkg/timestamp/duration.go")])], necessity("necessary"), files);
      expect(ids(r)).toEqual(["Q1"]);
    });

    it("stays an issue when the answer cites nothing, since it cannot show the equivalent is the changed code", () => {
      expect(ids(run([reuse("Q1", [])], necessity("necessary"), files))).toEqual(["Q1"]);
    });

    it("lists several symbols citing the same outside equivalent as one issue", () => {
      const symbols = [1, 2, 3].map((n) => ({ id: `S${n}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `sym${n}` }));
      const questions = [reuse("Q1", [cite("pkg/timestamp/duration.go")], "S1"), reuse("Q2", [cite("pkg/timestamp/duration.go"), cite("pkg/schema/ttl.go")], "S2"), reuse("Q3", [cite("pkg/other/x.go")], "S3"), reuse("Q4", [cite("pkg/timestamp/duration.go")], "S3")];
      const r = round1Record({ head: "h".repeat(40), necessity: necessity("necessary"), qa: qa(questions, symbols), files, itemCites: { R1: { path: "pkg/schema/ttl.go", start: 3, end: 3 } }, packs: PACKS, prior: [{ id: "Q2", key: "k2", origin: "round1", status: "open" } as never] })!;
      expect(ids(r)).toEqual(["Q1", "Q3"]);
      expect(r.issues[0]!.covers).toEqual(["Q2", "Q4"]);
      expect(r.issues[0]!.body).toContain("`sym2` (Q2)");
      expect(r.prior).toEqual([expect.objectContaining({ id: "Q2", status: "open" })]);
    });
    it("lists, for each question a merged issue covers, its own question, whole answer and citations", () => {
      const symbols = [1, 2, 3].map((n) => ({ id: `S${n}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `sym${n}` }));
      const withText = (q: Q, text: string): Q => ({ ...q, answer: { ...q.answer!, answer: text } });
      const qs = [reuse("Q1", [cite("pkg/a.go")], "S1"), withText(reuse("Q2", [cite("pkg/b.go", "base", 20)], "S2"), "b already merges rows"), reuse("Q3", [cite("pkg/a.go"), cite("pkg/b.go", "base", 20)], "S3")];
      const r = round1Record({ head: "h".repeat(40), necessity: necessity("necessary"), qa: qa(qs, symbols), files, itemCites: { R1: { path: "pkg/schema/ttl.go", start: 3, end: 3 } }, packs: PACKS })!;
      expect(r.issues[0]!.covered).toEqual([expect.objectContaining({ id: "Q2", symbol: "`sym2`", equivalents: ["pkg/b.go:20"], excerpt: "b already merges rows" }), expect.objectContaining({ id: "Q3", equivalents: ["pkg/a.go:10", "pkg/b.go:20"] })]);
      expect(r.issues[0]!.body).toContain("**`sym2` (Q2)**. question Q2\n\nAnswer (answered): b already merges rows\n\nCitations: `pkg/b.go:20-25` (base)");
    });

    describe("a merged issue carries each covered answer whole, as a single issue does (0.26.3)", () => {
      // The shape of the live run's Q9, Q44 and Q52: a long answer with a parenthesised list of base paths that the old merge cut at 200 characters.
      const longAnswer = (tag: string) => `${tag} already exists in the base, in two places. The first is the formatter at base sidx/query.go:509, which does the same grouping. The second is the helper at base trace/tracing.go:404 (base sidx/query.go:509, base trace/tracing.go:404, base measure/measure.go:179), which the others call. ${"It could be shared by moving it to a common package. ".repeat(6)}End of ${tag}.`;
      const symbols = [1, 2, 3].map((n) => ({ id: `S${n}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `sym${n}` }));
      const pinned = { owner: "o", repo: "r", number: 7, head: "a".repeat(40), base: "b".repeat(40) };
      const build = (n: number, answerOf: (id: string) => string) => {
        const syms = Array.from({ length: n }, (_, k) => ({ id: `S${k + 1}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `sym${k + 1}` }));
        const qs = Array.from({ length: n }, (_, k) => ({ ...reuse(`Q${k + 1}`, [cite("pkg/timestamp/duration.go")], `S${k + 1}`), answer: { status: "answered", answer: answerOf(`Q${k + 1}`), citations: [cite("pkg/timestamp/duration.go"), cite(`pkg/own${k + 1}.go`, "base", 40 + k)] } }));
        return round1Record({ head: "h".repeat(40), necessity: necessity("necessary"), qa: qa(qs, syms), files, itemCites: { R1: { path: "pkg/schema/ttl.go", start: 3, end: 3 } }, packs: PACKS, github: pinned } as never)!;
      };

      it("shows every covered question's text, its whole answer and its citation links, with no unexplained cut", () => {
        void symbols;
        const r = build(3, longAnswer);
        const m = r.issues[0]!;
        expect(m.covers).toEqual(["Q2", "Q3"]);
        for (const id of ["Q2", "Q3"]) {
          expect(m.body, id).toContain(`question ${id}`);
          expect(m.body, id).toContain(longAnswer(id));
          expect(m.body, id).toContain(`https://github.com/o/r/blob/${"b".repeat(40)}/pkg/own${id.slice(1)}.go#L4`);
        }
        expect(m.body).not.toContain("…");
        expect(m.body).not.toContain("answer shortened");
        expect(m.body.length).toBeLessThanOrEqual(MAX_ITEM_TEXT);
      });

      it("shortens only when the budget forces it, by the publish rule, saying where the full answer is", () => {
        const huge = (id: string) => `${id} is described in many sentences. ${"A sentence that adds detail about the duplicated helper. ".repeat(60)}`;
        const r = build(8, huge);
        const m = r.issues[0]!;
        expect(m.body.length).toBeLessThanOrEqual(MAX_ITEM_TEXT);
        expect(m.covers).toHaveLength(7);
        for (const id of m.covers!) {
          expect(m.body, id).toContain(`(answer shortened; the full answer is in the report's Q&A, ${id})`);
          // The cut is at a sentence end: the text before the note ends in a full stop, never mid-word.
          expect(m.body, id).toMatch(new RegExp(`detail about the duplicated helper\\. \\(answer shortened; the full answer is in the report's Q&A, ${id}\\)`));
        }
        expect(m.body).not.toMatch(/…/);
      });

      it("keeps every covered id and its symbol when even the shortened answers cannot fit", () => {
        const r = build(60, longAnswer);
        const m = r.issues[0]!;
        expect(m.body.length).toBeLessThanOrEqual(MAX_ITEM_TEXT);
        expect(m.body).toContain("each answer is in the report's Q&A");
        expect(m.body).not.toContain("…");
        for (const id of m.covers!) expect(m.body).toContain(`(${id})`);
      });
    });

    describe("an existing-reuse-common answer that found nothing to reuse is not headed 'something equivalent already exists' (0.26.3)", () => {
      // The shape of the live run's Q1 and Q37: none_found false because related code is cited, but the answer says no equivalent exists.
      const noneButRelated = (id: string, reusable?: boolean): Q => ({ id, type: "existing-reuse-common", symbol: "S1", answer: { status: "answered", none_found: false, ...(reusable !== undefined ? { reusable } : {}), answer: "No equivalent accessor exists in the base. The nearest helper works on other columns, so it cannot be called as is.", citations: [{ path: "pkg/encoding/bytes.go", start: 87, end: 94, tree: "base" }, { path: "pkg/query/retained_bytes.go", start: 109, end: 113, tree: "base" }] } });

      it("is no issue and is noted when the answer says reusable false", () => {
        const r = run([noneButRelated("Q1", false)]);
        expect(r.issues).toEqual([]);
        expect(r.noted).toEqual([{ id: "Q1", key: expect.any(String), note: "the answer found no equivalent, library or shared logic it could reuse" }]);
      });

      it("is an existing issue only when the answer says reusable true", () => {
        const r = run([noneButRelated("Q1", true)]);
        expect(r.issues.map((i) => [i.id, i.kinds])).toEqual([["Q1", ["existing"]]]);
        expect(r.issues[0]!.body).toContain("**something equivalent already exists**");
      });

      it("keeps an answer recorded before 0.26.3, which has no reusable field, judged as it was", () => {
        expect(ids(run([noneButRelated("Q1")]))).toEqual(["Q1"]);
      });

      it("heads a not-reusable answer that still needs the author with that reason alone", () => {
        const q = noneButRelated("Q1", false);
        q.answer!.status = "needs author";
        const r = run([q]);
        expect(r.issues.map((i) => i.kinds)).toEqual([["needs-author"]]);
        expect(r.issues[0]!.body).toContain("**needs the author**");
        expect(r.issues[0]!.body).not.toContain("equivalent already exists");
      });

      it("never merges a not-reusable answer into an equivalent issue, so no headline of a merged issue denies its answer", () => {
        const cite = { path: "pkg/timestamp/duration.go", start: 30, end: 42, tree: "base" };
        const symbols = [1, 2].map((n) => ({ id: `S${n}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `sym${n}` }));
        const qs: Q[] = [{ id: "Q1", type: "existing-reuse-common", symbol: "S1", answer: { status: "answered", reusable: true, citations: [cite] } }, { id: "Q2", type: "existing-reuse-common", symbol: "S2", answer: { status: "answered", reusable: false, citations: [cite] } }];
        const r = round1Record({ head: "h".repeat(40), necessity: necessity("necessary"), qa: qa(qs, symbols), files: FILES, itemCites: {}, packs: PACKS })!;
        expect(ids(r)).toEqual(["Q1"]);
        expect(r.issues[0]!.covers).toBeUndefined();
      });
    });

    it("builds a merged body that fits the posted budget and names every covered question, in the body and in covers", () => {
      for (const n of [8, 40, 120]) {
        const symbols = Array.from({ length: n }, (_, k) => ({ id: `S${k + 1}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `someLongQualifiedSymbolName${k + 1}` }));
        const long = "this already exists and merges rows the same way ".repeat(8);
        const qs = Array.from({ length: n }, (_, k) => ({ ...reuse(`Q${k + 1}`, [cite("pkg/timestamp/duration.go", "base", 10 + k)], `S${k + 1}`), answer: { status: "answered", answer: long, citations: [cite("pkg/timestamp/duration.go", "base", 10)] } }));
        const r = round1Record({ head: "h".repeat(40), necessity: necessity("necessary"), qa: qa(qs, symbols), files, itemCites: { R1: { path: "pkg/schema/ttl.go", start: 3, end: 3 } }, packs: PACKS })!;
        const merged = r.issues.filter((i) => i.covers !== undefined);
        expect(merged).toHaveLength(1);
        const m = merged[0]!;
        expect(m.body.length, `n=${n}`).toBeLessThanOrEqual(MAX_ITEM_TEXT);
        // Every question is either named in the body and in covers, or still its own issue; none is lost.
        for (const q of qs.slice(1)) {
          const inBody = new RegExp(`\\b${q.id}\\b`).test(m.body);
          expect(inBody, q.id).toBe(m.covers!.includes(q.id));
          expect(inBody || ids(r).includes(q.id), q.id).toBe(true);
        }
        if (n <= 40) expect(m.covers).toHaveLength(n - 1);
      }
    });

    it("joins two groups through a question that cites both, whatever the order of the questions", () => {
      const symbols = [1, 2, 3].map((n) => ({ id: `S${n}`, path: "pkg/schema/ttl.go", startLine: 3, qualified: `sym${n}` }));
      const qs = [reuse("Q1", [cite("pkg/a.go")], "S1"), reuse("Q2", [cite("pkg/b.go")], "S2"), reuse("Q3", [cite("pkg/a.go"), cite("pkg/b.go")], "S3")];
      const go = (order: Q[]) => round1Record({ head: "h".repeat(40), necessity: necessity("necessary"), qa: qa(order, symbols), files, itemCites: { R1: { path: "pkg/schema/ttl.go", start: 3, end: 3 } }, packs: PACKS })!;
      const shape = (r: ReturnType<typeof go>) => r.issues.map((i) => [i.id, i.covers]).sort();
      const expected = [["Q1", ["Q2", "Q3"]]];
      for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) expect(shape(go(order.map((n) => qs[n]!))), order.join()).toEqual(expected);
    });
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
