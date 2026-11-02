// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The existence, reuse and common-logic question (design §7.1, §7.3, §7.6): one question with one answer, one status
 * and one verdict, in standard mode for each new symbol and in large mode for each high-level change.
 */
import { describe, expect, it } from "vitest";
import { ANSWERS_SCHEMA, ANSWER_CHECK_SCHEMA, answerProblems, assemble, readAnswerCheck, unmeasuredAbsences, verificationPlan, type Answer, type AnswerContext, type FinalAnswer } from "../src/answers.js";
import { QUESTION_TYPES, REUSE_TYPE, finalQuestions, questionerProblems, requiredQuestions, type Question } from "../src/questions.js";
import { planQuestioner } from "../src/qaprompts.js";
import { coarsestChanges, highLevelId, type ReportView, type ViewItem } from "../src/reportview.js";
import { evidencePull } from "../src/analysis.js";
import { qaContext, type QaContext } from "../src/qaflow.js";
import { profileOf, simulate } from "./support.js";

/** The real context of a scenario: its groundwork, report and measurement records, built from the evidence. */
function contextOf(name: string): { ctx: QaContext } {
  const sim = simulate({ scenarioName: name });
  const profile = profileOf({});
  const c = qaContext(sim.evidence, profile, evidencePull(sim.evidence, profile)!);
  if (c.state !== "ready") throw new Error(`context is ${c.state}`);
  return { ctx: c.ctx };
}

const question: Question = { id: "Q1", type: REUSE_TYPE, item: "W1", text: "all three", origin: "required", key: `${REUSE_TYPE}:item:W1` };
const search = (pattern: string, over: object = {}) => ({ pattern, tree: "base" as const, paths: [], ignoreCase: false as const, hits: 0, ...over });
const three = [search("a"), search("b"), search("c")];
const cite = { path: "pkg/a.go", tree: "base" as const, start: 1, end: 2, quote: "func A" };

function ctxOf(opts: { sourceless?: boolean } = {}): AnswerContext {
  const dependencies = [{ ecosystem: "go" as const, name: "github.com/spf13/cobra", version: "v1.9.1", manifest: "go.mod", indirect: false, ...(opts.sourceless === true ? {} : { source: "/mod/cobra" }) }];
  return { questions: [question], groundwork: { symbols: [], inventory: { dependencies, packages: [], truncated: [] } } as unknown as AnswerContext["groundwork"], view: { items: [], records: [] }, packs: [] };
}

const answer = (over: Partial<Answer> = {}): Answer => ({ question: "Q1", answer: "Nothing like it exists, no declared library does it, and no logic is duplicated.", status: "answered", none_found: true, citations: [], searches: three, inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" }, ...over });
const problems = (a: Answer, ctx = ctxOf()): string[] => answerProblems([a], ctx);

describe("one question, one answer", () => {
  it("has one type for the question, and the contracts have no parts", () => {
    expect(QUESTION_TYPES).toEqual(["necessity", "purpose", "existing-reuse-common", "missing-test", "split-function", "complexity-coverage", "weak-test", "other"]);
    const answers = ANSWERS_SCHEMA.properties.answers.items as unknown as { required: string[]; properties: Record<string, unknown> };
    expect(answers.required).not.toContain("parts");
    expect(answers.properties.parts).toBeUndefined();
    expect(JSON.stringify(ANSWER_CHECK_SCHEMA)).not.toContain('"parts"');
  });

  it("takes a none-found answer with three whole-repository searches, as one statement with one status", () => {
    expect(problems(answer())).toEqual([]);
    expect(problems(answer({ searches: [search("a")] }))).toEqual([expect.stringMatching(/Q1: a "none found" answer lists the whole-repository searches .* \(3 or more.*not 1/)]);
    expect(problems(answer({ searches: [search("a"), search("b", { paths: ["pkg"] }), search("c")] }))).toEqual([expect.stringMatching(/not 2/)]);
    // An answer that names a candidate cites it.
    expect(problems(answer({ none_found: false, searches: [], citations: [] })).join("|")).toMatch(/Q1: an answer that names an existing equivalent, library or duplicate cites it/);
    expect(problems(answer({ none_found: false, searches: [], citations: [cite] }))).toEqual([]);
  });

  it("makes a none-found answer 'partially answered' while a dependency has no source here, whichever of the three concerns it was about", () => {
    const sourceless = ctxOf({ sourceless: true });
    expect(problems(answer(), sourceless).join("|")).toMatch(/some declared dependency has no source available here, so a "none found" answer is "partially answered"/);
    expect(problems(answer({ status: "partially answered" }), sourceless)).toEqual([]);
  });

  it("re-runs the searches and verifies the citations of the one answer", () => {
    const a = answer({ none_found: false, citations: [cite], searches: [search("lib")] });
    const plan = verificationPlan([a], ctxOf(), "base0");
    expect(plan.filter((p) => p.kind === "cite").flatMap((p) => p.entries.map((e) => e.label))).toEqual(["base:pkg/a.go:1-2"]);
    expect(plan.filter((p) => p.kind === "search").map((p) => p.search!.pattern)).toEqual(["lib"]);
    const none = answer();
    const noneplan = verificationPlan([none], ctxOf(), "base0");
    expect(unmeasuredAbsences([none], ctxOf(), noneplan)).toEqual([]);
    expect(unmeasuredAbsences([none], ctxOf(), noneplan.filter((p) => !(p.kind === "search" && p.search!.pattern === "b")))).toEqual([expect.stringMatching(/Q1: its "none found" answer rests on 2 of the 3 whole-tree searches/)]);
  });

  it("is judged as a whole: one verdict, one status, and an unsupported one is needs author with both statements kept", () => {
    const answers = new Map([["Q1", answer({ answer: "FIRST", status: "partially answered" })]]);
    const verdict = (v: string) => ({ verdicts: [{ question: "Q1", verdict: v, note: `${v} note`, searches: [search("own")], principles: [] }] });
    const read = (out: unknown) => readAnswerCheck(out, [question], answers) as Exclude<ReturnType<typeof readAnswerCheck>, { problems: string[] }>;
    expect(read(verdict("supported")).supported.has("Q1")).toBe(true);
    expect(read({ verdicts: [{ question: "Q1", verdict: "supported", note: "", searches: [], principles: [] }] }).unchecked).toEqual(["Q1"]);
    const reading = read(verdict("unsupported"));
    const current = new Map([["Q1", answer({ answer: "SECOND", status: "partially answered" })]]);
    const [final] = assemble([question], current, answers, reading, true) as [FinalAnswer];
    expect(final.status).toBe("needs author");
    expect(final.check.verdict).toBe("downgraded");
    expect(final.history).toEqual([{ answer: "FIRST", status: "partially answered" }, { answer: "SECOND", status: "partially answered" }]);
    expect("parts" in final).toBe(false);
  });
});

describe("the required question, in standard mode for each new symbol", () => {
  const complex = contextOf("complex-function");

  it("is one question for each new symbol, with no separate equivalent, library or common-logic question", () => {
    const required = requiredQuestions({ view: complex.ctx.view, groundwork: complex.ctx.groundwork }, new Map());
    const news = complex.ctx.groundwork.symbols.filter((s) => s.change === "new");
    expect(news.length).toBeGreaterThan(0);
    const reuse = required.filter((q) => q.type === REUSE_TYPE);
    expect(reuse.map((q) => q.symbol)).toEqual(news.map((s) => s.id));
    for (const q of reuse) {
      expect(q.key).toBe(`${REUSE_TYPE}:${q.symbol}`);
      expect(q.text).toMatch(/already have the same or an equivalent.*existing internal package or an already-declared third-party library.*duplicate logic.*Answer all three in one statement/s);
    }
    expect(required.map((q) => q.type)).not.toEqual(expect.arrayContaining(["existing-equivalent"]));
  });
});

describe("the required questions in large mode, for each high-level change", () => {
  const complex = contextOf("complex-function");
  const change = (n: number, path: string): ViewItem => ({ id: highLevelId(n), section: "highlevel", text: `capability ${n}`, cites: [{ path, side: "head", start: 1, end: 9, symbol: "" }], facts: [] });
  const view = (n: number): ReportView => ({ ...complex.ctx.view, changes: Array.from({ length: n }, (_, i) => change(i + 1, complex.ctx.groundwork.symbols[0]?.path ?? "pkg/a.go")) });
  const ask = (n: number) => requiredQuestions({ view: view(n), groundwork: complex.ctx.groundwork, large: true }, new Map());

  it("asks purpose, the one existence question and missing-test for each of the changes, whatever the size of the report", () => {
    for (const n of [1, 3, 5]) {
      const qs = ask(n);
      expect(qs).toHaveLength(3 * n);
      for (let i = 1; i <= n; i += 1) expect(qs.filter((q) => q.item === `W${i}`).map((q) => q.type).sort()).toEqual(["existing-reuse-common", "missing-test", "purpose"]);
    }
    expect(ask(5).filter((q) => q.symbol !== undefined || q.fn !== undefined)).toEqual([]);
  });

  it("names the change and its cites in the question, and lists the functions of the cited files the test map finds no test for", () => {
    const qs = ask(2);
    const reuse = qs.find((q) => q.type === REUSE_TYPE && q.item === "W2")!;
    expect(reuse.text).toContain('W2 "capability 2" (');
    expect(reuse.text).toContain(complex.ctx.groundwork.symbols[0]!.path);
    const missing = qs.find((q) => q.type === "missing-test" && q.item === "W1")!;
    expect(missing.text).toMatch(/Which tests cover this change, W1 "capability 1"/);
  });
});

describe("large mode adds no question, and falls back to the coarsest items when the briefing kept no capability", () => {
  const complex = contextOf("complex-function");
  const view = (n: number): ReportView => ({ ...complex.ctx.view, changes: Array.from({ length: n }, (_, i) => ({ id: highLevelId(i + 1), section: "highlevel", text: `capability ${i + 1}`, cites: [{ path: "pkg/a.go", side: "head" as const, start: 1, end: 9, symbol: "" }], facts: [] })) });
  const required = requiredQuestions({ view: view(5), groundwork: complex.ctx.groundwork, large: true }, new Map());
  const output = {
    purposes: [],
    questions: [
      ...required.map((r) => ({ key: r.key, type: r.type, item: r.item, symbol: "", text: r.text })),
      { key: "", type: "split-function" as const, item: "W1", symbol: "", text: "could it be split?" },
      { key: "", type: "complexity-coverage" as const, item: "W2", symbol: "", text: "which tests?" },
    ],
  };

  it("refuses an added question in large mode, and accepts it in standard mode", () => {
    expect(questionerProblems(output, view(5), complex.ctx.groundwork, required, true).join("|")).toMatch(/question 16: no question is added in large mode.*question 17: no question is added in large mode/);
    expect(questionerProblems(output, view(5), complex.ctx.groundwork, required)).toEqual([]);
  });

  it("keeps five changes at N1 and 15 questions: an addition that gets through is dropped", () => {
    expect(finalQuestions(required, output, complex.ctx.groundwork, true)).toHaveLength(15);
    expect(finalQuestions(required, output, complex.ctx.groundwork)).toHaveLength(17);
  });

  it("does not invite the questioner to add questions in large mode", () => {
    const base = { pr: { mode: "report" as const, owner: "o", repo: "r", number: 1, head: "a".repeat(40) }, snapshot: { pull: { title: "t", body: "b" }, commits: [] } as never, view: view(5), groundwork: complex.ctx.groundwork, required, feedback: [], kind: "first" as const };
    const large = planQuestioner({ ...base, large: true }).text;
    expect(large).toContain("Do not add questions");
    expect(large).not.toContain("split-function, complexity-coverage or other");
    expect(planQuestioner(base).text).toContain("You may add questions");
  });

  const items = (sections: string[]): ViewItem[] => sections.map((section, i) => ({ id: `R${i + 1}`, section, text: `item ${i + 1}`, cites: [{ path: `pkg/f${i}.go`, side: "head" as const, start: 1, end: 2, symbol: "" }], facts: [] }));

  it("uses the report's coarsest items, features first, at most five, as the changes when the briefing kept none", () => {
    const changes = coarsestChanges(items(["config", "interfaces", "features", "background", "features", "schema", "claims", "other"]));
    expect(changes.map((c) => [c.id, c.text.match(/report item (R\d+)/)![1]])).toEqual([["W1", "R3"], ["W2", "R5"], ["W3", "R1"], ["W4", "R2"], ["W5", "R4"]]);
    expect(changes[0]!.text).toContain("the claim check kept no capability");
    expect(coarsestChanges([])).toEqual([]);
  });

  it("asks purpose, reuse and missing-test for each of them alike, not purpose alone", () => {
    const sections = ["features", "features", "config"];
    const changes = coarsestChanges(items(sections));
    const qs = requiredQuestions({ view: { ...complex.ctx.view, items: items(sections), changes }, groundwork: complex.ctx.groundwork, large: true }, new Map());
    expect(qs).toHaveLength(9);
    for (const c of changes) expect(qs.filter((q) => q.item === c.id).map((q) => q.type).sort()).toEqual(["existing-reuse-common", "missing-test", "purpose"]);
  });
});
