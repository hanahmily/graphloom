// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The combined existing-reuse-common question of large mode (design §7.6): its answer has three labelled parts, each
 * checked as the separate question would be, and its status is the weakest of the three.
 */
import { describe, expect, it } from "vitest";
import { ANSWERS_SCHEMA, answerProblems, assemble, parseAnswers, readAnswerCheck, unmeasuredAbsences, verificationPlan, weakestStatus, withParts, type Answer, type AnswerContext, type AnswerPart, type FinalAnswer } from "../src/answers.js";
import { htmlPagesFrom } from "../src/html.js";
import { COMBINED_PARTS, COMBINED_TYPE, type CombinedPart, type Question } from "../src/questions.js";
import { LARGE_LIMITS } from "../src/rehearsal.js";
import { scenarioWith, simulate } from "./support.js";

const question: Question = { id: "Q1", type: COMBINED_TYPE, item: "R1", text: "all three", origin: "required", key: `${COMBINED_TYPE}:item:R1` };
const search = (pattern: string, over: object = {}) => ({ pattern, tree: "base" as const, paths: [], ignoreCase: false as const, hits: 0, ...over });
const threeSearches = [search("a"), search("b"), search("c")];
const cite = { path: "pkg/a.go", tree: "base" as const, start: 1, end: 2, quote: "func A" };

function ctxOf(opts: { sourceless?: boolean } = {}): AnswerContext {
  const dependencies = [{ ecosystem: "go" as const, name: "github.com/spf13/cobra", version: "v1.9.1", manifest: "go.mod", indirect: false, ...(opts.sourceless === true ? {} : { source: "/mod/cobra" }) }];
  return { questions: [question], groundwork: { symbols: [], inventory: { dependencies, packages: [], truncated: [] } } as unknown as AnswerContext["groundwork"], view: { items: [], records: [] }, packs: [] };
}

const none = (part: CombinedPart, over: Partial<AnswerPart> = {}): AnswerPart => ({ part, answer: `none ${part}`, status: "answered", none_found: true, citations: [], searches: part === "reuse-library" ? [search("lib")] : threeSearches, inventory: [], ...over });
const found = (part: CombinedPart, over: Partial<AnswerPart> = {}): AnswerPart => ({ part, answer: `found ${part}`, status: "answered", none_found: false, citations: [cite], searches: [], inventory: [], ...over });
const wire = (parts: AnswerPart[], over: Partial<Answer> = {}): Answer => ({ question: "Q1", answer: "summary", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" }, parts, ...over });
const allNone = (over: Partial<Record<CombinedPart, Partial<AnswerPart>>> = {}): AnswerPart[] => COMBINED_PARTS.map((p) => none(p, over[p]));
const problems = (a: Answer, ctx = ctxOf()): string[] => answerProblems([withParts(a)], ctx);

describe("the combined answer's contract", () => {
  it("is part of the answers schema, empty for every other question", () => {
    const answer = (ANSWERS_SCHEMA.properties.answers.items as unknown as { required: string[]; properties: Record<string, { items?: { required: string[] } }> });
    expect(answer.required).toContain("parts");
    expect(answer.properties.parts!.items!.required).toEqual(["part", "answer", "status", "none_found", "citations", "searches", "inventory"]);
  });

  it("folds the parts in: the status is the weakest, the evidence together, the parts in canonical order", () => {
    const a = withParts(wire([found("common-logic"), none("reuse-library", { status: "partially answered" }), none("existing-equivalent")]));
    expect(a.parts!.map((p) => p.part)).toEqual(["existing-equivalent", "reuse-library", "common-logic"]);
    expect(a.status).toBe("partially answered");
    expect(a.none_found).toBe(true);
    expect(a.citations).toHaveLength(1);
    expect(a.searches).toHaveLength(4);
    expect(weakestStatus(["answered", "needs author", "partially answered"])).toBe("needs author");
    expect(weakestStatus(["answered", "partially answered"])).toBe("partially answered");
    expect(weakestStatus(["answered"])).toBe("answered");
    // An answer without parts is returned as it is.
    const plain = wire([]);
    expect(withParts(plain)).toBe(plain);
  });

  it("refuses evidence beside the parts, which would be neither shown nor checked as a part", () => {
    const out = { answers: [{ ...wire(allNone()), citations: [cite] }] };
    expect(parseAnswers(out)).toEqual({ problems: [expect.stringMatching(/Q1: a combined answer keeps its citations, searches and inventory in its parts/)] });
    const ok = parseAnswers({ answers: [wire(allNone({ "reuse-library": { status: "partially answered" } }))] }) as { answers: Answer[] };
    expect(ok.answers[0]!.status).toBe("partially answered");
    expect(ok.answers[0]!.searches).toHaveLength(7);
  });

  it("needs all three parts, once each, and each with its own evidence", () => {
    expect(problems(wire(allNone({ "reuse-library": { status: "partially answered" } })))).toEqual([]);
    expect(problems(wire([]))).toEqual([expect.stringMatching(/Q1: the answer has no parts/)]);
    expect(problems(wire(allNone().slice(0, 2))).join("|")).toMatch(/Q1: the common-logic part is missing/);
    expect(problems(wire([...allNone(), none("common-logic")])).join("|")).toMatch(/the common-logic part appears 2 times/);
    expect(problems(wire(allNone({ "common-logic": { searches: [], citations: [] } }))).join("|")).toMatch(/Q1 \(common-logic\): it has no evidence/);
    expect(problems(wire(allNone({ "existing-equivalent": { answer: " " } }))).join("|")).toMatch(/Q1 \(existing-equivalent\): the part's answer is empty/);
  });

  it("holds each part to the rules of the separate question: three whole-repository searches for an equivalent and common logic, one for a library", () => {
    expect(problems(wire(allNone({ "existing-equivalent": { searches: [search("a")] } })))).toEqual([expect.stringMatching(/Q1 \(existing-equivalent\): a "none found" answer lists the whole-repository searches .* \(3 or more.*not 1/)]);
    expect(problems(wire(allNone({ "common-logic": { searches: [search("a"), search("b", { paths: ["pkg"] }), search("c")] } })))).toEqual([expect.stringMatching(/Q1 \(common-logic\): .* not 2/)]);
    expect(problems(wire(allNone({ "reuse-library": { searches: [], inventory: [{ name: "github.com/spf13/cobra", version: "v1.9.1" }] } })))).toEqual([expect.stringMatching(/Q1 \(reuse-library\): a "none found" answer lists the whole-repository searches .* \(1 or more.*not 0/)]);
    // A part that names a candidate cites it.
    expect(problems(wire(allNone({ "existing-equivalent": { none_found: false, citations: [], searches: [search("x")] } })))).toEqual([expect.stringMatching(/Q1 \(existing-equivalent\): an answer that names an existing equivalent, library or duplicate cites it/)]);
    // Searches and citations of a part are validated like any answer's.
    expect(problems(wire(allNone({ "common-logic": { searches: [search("("), ...threeSearches] } }))).join("|")).toMatch(/Q1 \(common-logic\): the search "\(" is not a valid extended regular expression/);
    expect(problems(wire(allNone({ "existing-equivalent": { none_found: false, citations: [{ ...cite, path: "/abs" }], searches: [] } }))).join("|")).toMatch(/Q1 \(existing-equivalent\) citation 1 \(\/abs\): a base citation is a repository-relative path/);
    expect(problems(wire(allNone({ "existing-equivalent": { inventory: [{ name: "x", version: "1" }] } }))).join("|")).toMatch(/Q1 \(existing-equivalent\): inventory entry x@1 is not in the dependency inventory/);
  });

  it("makes a library none-found 'partially answered' while a dependency has no source here, as the separate question does", () => {
    const sourceless = ctxOf({ sourceless: true });
    expect(problems(wire(allNone()), sourceless).join("|")).toMatch(/Q1 \(reuse-library\): some declared dependency has no source available here, so a "none found" library answer is "partially answered"/);
    expect(problems(wire(allNone({ "reuse-library": { status: "partially answered" } })), sourceless)).toEqual([]);
    // The other two parts are not held to it.
    expect(problems(wire(allNone({ "reuse-library": { status: "partially answered" } })), sourceless)).toEqual([]);
  });

  it("keeps parts to the combined question alone", () => {
    const other: Question = { ...question, type: "purpose" };
    const a = withParts(wire(allNone()));
    expect(answerProblems([a], { ...ctxOf(), questions: [other] }).join("|")).toMatch(/parts belong to the combined existing-reuse-common question alone/);
  });

  it("verifies the citations and re-runs the searches of every part", () => {
    const a = withParts(wire([found("existing-equivalent"), none("reuse-library"), found("common-logic", { citations: [{ ...cite, path: "pkg/b.go" }] })]));
    const plan = verificationPlan([a], ctxOf(), "base0");
    expect(plan.filter((p) => p.kind === "cite").flatMap((p) => p.entries.map((e) => e.label))).toEqual(["base:pkg/a.go:1-2", "base:pkg/b.go:1-2"]);
    expect(plan.filter((p) => p.kind === "search").map((p) => p.search!.pattern)).toEqual(["lib"]);
  });

  it("asks for a part's absence to rest on its own measured searches", () => {
    const a = withParts(wire(allNone()));
    const plan = verificationPlan([a], ctxOf(), "base0");
    expect(unmeasuredAbsences([a], ctxOf(), plan)).toEqual([]);
    expect(unmeasuredAbsences([a], ctxOf(), plan.filter((p) => !(p.kind === "search" && p.search!.pattern === "b")))).toEqual([expect.stringMatching(/Q1 \(existing-equivalent\): its "none found" answer rests on 2 of the 3 whole-tree searches/), expect.stringMatching(/Q1 \(common-logic\): .* 2 of the 3/)]);
  });
});

describe("the checker's verdict on a combined answer", () => {
  const answers = new Map([["Q1", withParts(wire(allNone({ "reuse-library": { status: "partially answered" } })))]]);
  const own = [search("own")];
  const partVerdict = (part: CombinedPart, verdict: string, over: object = {}) => ({ part, verdict, note: `${part} ${verdict}`, searches: own, ...over });
  const verdictOf = (parts: unknown[], over: object = {}) => ({ verdicts: [{ question: "Q1", verdict: "supported", note: "", searches: [], principles: [], parts, ...over }] });
  const read = (out: unknown) => readAnswerCheck(out, [question], answers) as Exclude<ReturnType<typeof readAnswerCheck>, { problems: string[] }>;

  it("needs a verdict for every part, and searches of the checker's own for a part that says none found", () => {
    expect(read(verdictOf([partVerdict("existing-equivalent", "supported"), partVerdict("reuse-library", "supported")])).unchecked).toEqual(["Q1"]);
    expect(read(verdictOf([partVerdict("existing-equivalent", "supported"), partVerdict("reuse-library", "supported"), partVerdict("common-logic", "supported", { searches: [] })])).unchecked).toEqual(["Q1"]);
    expect(read(verdictOf([])).unchecked).toEqual(["Q1"]);
    const ok = read(verdictOf(COMBINED_PARTS.map((p) => partVerdict(p, "supported"))));
    expect(ok.unchecked).toEqual([]);
    expect(ok.supported.has("Q1")).toBe(true);
    expect(ok.searches.get("Q1")).toHaveLength(3);
  });

  it("takes the weakest verdict of the parts, naming the part in the note", () => {
    const partial = read(verdictOf([partVerdict("existing-equivalent", "supported"), partVerdict("reuse-library", "partial"), partVerdict("common-logic", "supported")]));
    expect(partial.partial.get("Q1")).toBe("reuse-library: reuse-library partial");
    expect(partial.unsupported.has("Q1")).toBe(false);
    const bad = read(verdictOf([partVerdict("existing-equivalent", "unsupported"), partVerdict("reuse-library", "partial"), partVerdict("common-logic", "unsupported")], { verdict: "supported" }));
    expect(bad.unsupported.get("Q1")).toBe("existing-equivalent: existing-equivalent unsupported; common-logic: common-logic unsupported");
    expect(bad.supported.has("Q1")).toBe(false);
    // The weaker of two verdicts for one part stands.
    const twice = read(verdictOf([partVerdict("existing-equivalent", "supported"), partVerdict("existing-equivalent", "unsupported"), partVerdict("reuse-library", "supported"), partVerdict("common-logic", "supported")]));
    expect(twice.unsupported.get("Q1")).toBe("existing-equivalent: existing-equivalent unsupported");
  });

  it("refuses a verdict without the parts field, which the contract requires", () => {
    const out = { verdicts: [{ question: "Q1", verdict: "supported", note: "", searches: [], principles: [] }] };
    expect(readAnswerCheck(out, [question], answers)).toEqual({ problems: [expect.stringMatching(/parts is required/)] });
  });

  it("assembles the parts with their own verdicts, downgrading an unsupported part to needs author and the question with it", () => {
    const current = new Map(answers);
    const reading = read(verdictOf([partVerdict("existing-equivalent", "unsupported"), partVerdict("reuse-library", "partial"), partVerdict("common-logic", "supported")]));
    const [final] = assemble([question], current, current, reading, true) as [FinalAnswer];
    expect(final.status).toBe("needs author");
    expect(final.check.verdict).toBe("downgraded");
    expect(final.parts!.map((p) => [p.part, p.status, p.check.verdict])).toEqual([["existing-equivalent", "needs author", "downgraded"], ["reuse-library", "partially answered", "partial"], ["common-logic", "answered", "supported"]]);
    expect(final.history).toEqual([{ answer: "summary", status: "partially answered" }]);
    expect(final.parts![1]!.check.searches).toHaveLength(1);
    // A supported or partial question keeps the weakest of the answerer's part statuses.
    const supported = assemble([question], current, current, read(verdictOf([partVerdict("existing-equivalent", "supported"), partVerdict("reuse-library", "partial"), partVerdict("common-logic", "supported")])), false)[0]!;
    expect(supported.status).toBe("partially answered");
    expect(supported.check.verdict).toBe("partial");
  });
});

describe("a large run: one combined question per item, three labelled parts, rendered", () => {
  const config = { limits: LARGE_LIMITS };
  const sim = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, config), config, maxSteps: 250 });
  const qa = JSON.parse(sim.qa!.json) as { questions: Array<{ id: string; type: string; item: string; answer?: { status: string; answer: string; parts?: Array<{ part: string; status: string; none_found: boolean; searches: unknown[]; check: { verdict: string } }>; check: { verdict: string } } }> };
  const combined = qa.questions.filter((q) => q.type === COMBINED_TYPE);

  it("asks one per item that adds symbols and none of the three separate types", () => {
    expect(combined.length).toBeGreaterThan(0);
    expect(new Set(combined.map((q) => q.item)).size).toBe(combined.length);
    expect(qa.questions.filter((q) => ["existing-equivalent", "reuse-library", "common-logic"].includes(q.type))).toEqual([]);
  });

  it("records the three parts, each judged, in qa.json", () => {
    for (const q of combined) {
      expect(q.answer!.parts!.map((p) => p.part)).toEqual(["existing-equivalent", "reuse-library", "common-logic"]);
      for (const p of q.answer!.parts!) expect(p.check.verdict).toBe("supported");
      // The rehearsal's library part is partially answered while a dependency has no source, so the question is too.
      expect(q.answer!.status).toBe("partially answered");
    }
  });

  it("shows the parts in review.md, review.html's open questions and review-appendix.html", () => {
    const md = sim.qa!.markdown;
    expect(md).toContain("one combined question per change item that adds symbols");
    expect(md).toMatch(/\*\*Existing equivalent — answered, none found\.\*\*/);
    expect(md).toMatch(/\*\*Reusable library — partially answered, none found\.\*\*/);
    expect(md).toMatch(/\*\*Common logic — answered, none found\.\*\*/);
    // The briefing's open line lists the three statuses.
    expect(md).toContain("(Existing equivalent: answered; Reusable library: partially answered; Common logic: answered)");
    const pages = htmlPagesFrom(sim.written!.json, sim.qa!.json)!;
    expect(pages.review).toContain("Reusable library");
    expect(pages.review).toContain("Existing equivalent");
    expect(pages.appendix).toContain("Common logic");
    expect(pages.appendix).toContain("Reusable library");
    expect(pages.appendix).toContain('class="part"');
  });

  it("leaves standard mode as it was: separate per-symbol questions, no combined one", () => {
    const standard = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, {}), config: {}, maxSteps: 250 });
    const sq = JSON.parse(standard.qa!.json) as { mode: string; questions: Array<{ type: string; symbol?: string; answer?: { parts?: unknown[] } }> };
    expect(sq.mode).toBe("standard");
    expect(sq.questions.filter((q) => q.type === COMBINED_TYPE)).toEqual([]);
    for (const type of ["existing-equivalent", "reuse-library", "common-logic"]) expect(sq.questions.filter((q) => q.type === type && q.symbol !== undefined)).toHaveLength(8);
    expect(sq.questions.every((q) => q.answer === undefined || (q.answer.parts ?? []).length === 0)).toBe(true);
    expect(standard.qa!.markdown).not.toContain("Existing equivalent —");
  });
});
