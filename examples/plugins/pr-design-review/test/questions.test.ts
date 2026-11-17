// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from "vitest";
import type { Groundwork } from "../src/kit/groundwork.js";
import { coarsestChanges, highLevelId, type ReportView, type ViewItem } from "../src/kit/reportview.js";
import { finalQuestions, MAX_ADDED_QUESTIONS, questionerProblems, requiredQuestions, statedPurposes, type QuestionerOutput } from "../src/questions.js";
import { LARGE_LIMITS } from "../src/rehearsal.js";
import { qaOf, simulate, type Simulation } from "./support.js";

const cite = (path: string, start = 3) => ({ path, side: "head" as const, start, end: start + 2, symbol: "" });
const item = (id: string, section: string, path: string): ViewItem => ({ id, section, text: `${section} change in ${path}`, cites: [cite(path)], facts: [] });
const ITEMS = [item("R1", "features", "pkg/a/a.go"), item("R2", "schema", "api/proto/x.proto"), item("R3", "config", "cmd/flags.go"), item("R4", "other", "docs/x.md")];
const view = (changes: ViewItem[] | undefined): ReportView => ({ items: ITEMS, ...(changes !== undefined ? { changes } : {}), records: [] });
const W = (n: number, path: string): ViewItem => ({ id: highLevelId(n), section: "highlevel", text: `capability ${n}`, cites: [cite(path)], facts: [] });
// A groundwork full of symbols, untested functions and over-limit measurements: none of it asks anything any more.
const GROUNDWORK = {
  symbols: [{ id: "S1", name: "Parse", qualified: "a.Parse", path: "pkg/a/a.go", startLine: 1, endLine: 40, change: "new", kind: "func", language: "go", dir: "pkg/a", body: "" }],
  testMap: new Map([["S1", []]]),
} as unknown as Groundwork;
const MOVED = ["missing-test", "split-function", "complexity-coverage", "weak-test", "existing-reuse-common"];

describe("the required questions (design-pr-review-split §3.2)", () => {
  it("are purpose and existing-feature per high-level change, and nothing per symbol, function or measurement", () => {
    const v = view([W(1, "pkg/a/a.go"), W(2, "cmd/flags.go")]);
    v.records = [{ function: "a.Parse", path: "pkg/a/a.go", startLine: 1, endLine: 40, change: "added", complexity: 25, nesting: 6, test: false } as never];
    const req = requiredQuestions({ view: v, groundwork: GROUNDWORK }, new Map());
    expect(req.map((q) => [q.type, q.item])).toEqual([["purpose", "W1"], ["existing-feature", "W1"], ["purpose", "W2"], ["existing-feature", "W2"]]);
    expect(req.every((q) => q.symbol === undefined && q.fn === undefined)).toBe(true);
    expect(req.filter((q) => MOVED.includes(q.type))).toEqual([]);
  });

  it("drop a purpose the pull request's text states, and keep existing-feature", () => {
    const v = view([W(1, "pkg/a/a.go")]);
    const pinned = [{ source: "body" as const, text: "This adds parsing so that the retention is honoured." }];
    const { stated } = statedPurposes({ purposes: [{ item: "W1", source: "body", quote: "so that the retention is honoured" }], questions: [] }, v, pinned);
    expect(requiredQuestions({ view: v, groundwork: GROUNDWORK }, stated).map((q) => q.type)).toEqual(["existing-feature"]);
    // A purpose stated for a change item that is not a high-level change is not taken.
    expect(statedPurposes({ purposes: [{ item: "R1", source: "body", quote: "so that the retention is honoured" }], questions: [] }, v, pinned).rejected).toEqual(["R1 is not a high-level change"]);
  });

  it("fall back to the report's coarsest change items when the briefing keeps no capability", () => {
    const changes = coarsestChanges(ITEMS);
    expect(changes.map((c) => c.id)).toEqual(["W1", "W2", "W3"]);
    expect(changes[0]!.text).toContain("(report item R1; the claim check kept no capability)");
    const req = requiredQuestions({ view: view(changes), groundwork: GROUNDWORK }, new Map());
    expect(req.map((q) => `${q.type}:${q.item}`)).toEqual(["purpose:W1", "existing-feature:W1", "purpose:W2", "existing-feature:W2", "purpose:W3", "existing-feature:W3"]);
  });

  it("are the same in standard and large mode: a run of each asks only per high-level change", () => {
    const types = (s: Simulation) => qaOf(s).questions.map((q) => q.type);
    const standard = simulate({ scenarioName: "happy", maxSteps: 400 });
    const large = simulate({ scenarioName: "large-pull-request", maxSteps: 400, config: { limits: LARGE_LIMITS } });
    for (const s of [standard, large]) {
      expect(s.final.action.type === "stop" && s.final.action.stop.reason, JSON.stringify(s.final).slice(0, 400)).toBe("answers accepted");
      expect(types(s).filter((t) => MOVED.includes(t))).toEqual([]);
      expect(qaOf(s).questions.filter((q) => q.type !== "necessity").every((q) => /^W\d$/.test(q.item) && q.symbol === undefined)).toBe(true);
    }
    expect(qaOf(large).mode).toBe("large");
    expect(qaOf(standard).mode).toBe("standard");
  });
});

describe("the other question (design-pr-review-split §3.3)", () => {
  const v = view([W(1, "pkg/a/a.go")]);
  const required = requiredQuestions({ view: v, groundwork: GROUNDWORK }, new Map());
  const phrased = required.map((r) => ({ key: r.key, type: r.type, item: r.item, symbol: "", text: r.text }));
  const out = (...added: QuestionerOutput["questions"]): QuestionerOutput => ({ purposes: [], questions: [...phrased, ...added] });
  const other = (o: Partial<QuestionerOutput["questions"][number]> = {}) => ({ key: "", type: "other" as const, item: "W1", symbol: "", text: "Does this belong in the storage layer?", ...o });

  it("accepts a design-level addition on a high-level change or a schema, interfaces, config, external or removed item", () => {
    expect(questionerProblems(out(other(), other({ item: "R2" }), other({ item: "R3" })), v, required)).toEqual([]);
  });

  it("refuses an addition of another type", () => {
    expect(questionerProblems(out(other({ type: "purpose" })), v, required)).toEqual([expect.stringContaining("an added question is of type other")]);
  });

  it("refuses an addition that names a symbol", () => {
    expect(questionerProblems(out(other({ symbol: "S1" })), v, required)).toEqual([expect.stringContaining('an added question names no symbol (symbol "")')]);
  });

  it("refuses an addition about a change item of a detail section", () => {
    expect(questionerProblems(out(other({ item: "R1" }), other({ item: "R4" })), v, required)).toEqual([expect.stringContaining('"R1" is not a high-level change'), expect.stringContaining('"R4" is not a high-level change')]);
  });

  it(`refuses more than ${MAX_ADDED_QUESTIONS} additions`, () => {
    const six = Array.from({ length: 6 }, (_, k) => other({ text: `Design question ${k}?` }));
    expect(questionerProblems(out(...six), v, required)).toEqual([`6 questions added, more than ${MAX_ADDED_QUESTIONS}`]);
  });

  it("drops an addition whose type, item and empty symbol repeat a required question, and numbers the rest after the required ones", () => {
    const q = finalQuestions(required, out({ key: "", type: "existing-feature", item: "W1", symbol: "", text: "Is there one already?" }, other()));
    expect(q.map((x) => [x.id, x.type, x.origin])).toEqual([["Q1", "purpose", "required"], ["Q2", "existing-feature", "required"], ["Q3", "other", "added"]]);
  });

  it("a refused addition goes back to the questioner as a correction", () => {
    const sim = simulate({ scenarioName: "other-corrected", maxSteps: 400 });
    const asks = sim.jobs.filter((j) => j.instruction.startsWith("Ask the questions"));
    expect(asks).toHaveLength(2);
    expect((asks[1]!.input as { assignment: string }).assignment).toContain("an added question is of type other");
    expect(qaOf(sim).questions.filter((q) => q.origin === "added").map((q) => q.type)).toEqual(["other"]);
  });

  it("the questioner is told what a design-level question is about, and what it is not", () => {
    const sim = simulate({ scenarioName: "added-other", maxSteps: 400 });
    const ask = sim.jobs.find((j) => j.instruction.startsWith("Ask the questions"))!;
    const text = (ask.input as { assignment: string }).assignment;
    expect(text).toContain("fit with the system's architecture, a data model or storage schema, an interface, a protocol or a configuration surface, compatibility with existing clients or data, where a mechanism belongs");
    expect(text).toContain("never about a function's body, naming, tests, complexity, error handling inside a function");
    expect((ask.knownReferences as Record<string, { ids: string[] }>)["questions[].symbol"]!.ids).toEqual([""]);
    expect(qaOf(sim).questions.find((q) => q.origin === "added")).toMatchObject({ type: "other", item: "W1" });
  });
});
