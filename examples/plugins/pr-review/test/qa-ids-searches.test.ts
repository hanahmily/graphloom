// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { applyReferenceEnums, checkContract, type EvidenceRecord, type JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { evidencePull } from "../src/analysis.js";
import { answerProblems, parseAnswers, readAnswerCheck, searchItems, unmeasuredAbsences, verificationPlan, type Answer, type FinalAnswer } from "../src/answers.js";
import { readClaimCheck, type ClaimTarget } from "../src/claims.js";
import { definitionFor } from "../src/graph.js";
import { resolveId } from "../src/ids.js";
import { parseProfile } from "../src/profile.js";
import { answerContext, qaContext, questionSet, afterNecessity, type QaContext } from "../src/qaflow.js";
import { REHEARSAL_MERGE_BASE, rehearsal } from "../src/rehearsal.js";
import { ereProblem, MAX_RERUN_SEARCHES, pathProblem, readSearchReport, searchProblems, type Search } from "../src/searches.js";
import { searchLine } from "../src/searchview.js";
import { assignmentOf, BANYANDB, jobsOf, profileOf, scenarioWith, simulate, type Simulation } from "./support.js";

const search = (pattern: string, over: Partial<Search> = {}): Search => ({ pattern, tree: "base", paths: [], ignoreCase: false, hits: 0, ...over });
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const superviseOf = (s: Simulation) => (s.final.action.type === "supervise" ? s.final.action.supervise : undefined);
const SEARCH_ID = /^cite(-n)?-s-[0-9a-f]{10}$/;

function contextOf(name: string): QaContext {
  const sim = simulate({ scenarioName: name });
  const profile = profileOf();
  const c = qaContext(sim.evidence, profile, evidencePull(sim.evidence, profile)!);
  if (c.state !== "ready") throw new Error(`context is ${c.state}`);
  return c.ctx;
}

describe("reading an id an agent wrote (design 7.3: the tolerant second line of defence)", () => {
  const listed = new Set(["N1", "Q1", "Q2", "Q12", "R3", "R3.s1", "purpose"]);

  it("takes an exact id as it is, and says nothing", () => {
    expect(resolveId("Q1", listed)).toEqual({ id: "Q1" });
    expect(resolveId("R3.s1", listed)).toEqual({ id: "R3.s1" });
  });

  it("accepts an id with a type or the question's text after it, and says it normalized", () => {
    expect(resolveId("Q1 [split-function]", listed)).toMatchObject({ id: "Q1", note: expect.stringContaining("read as Q1") });
    const text = "Q1 [split-function] Could stream.(*writeCallback).Rev be split into smaller functions with one intent each?";
    expect(resolveId(text, listed)).toMatchObject({ id: "Q1" });
    expect(resolveId("Q2: does the codebase already have one?", listed)).toMatchObject({ id: "Q2" });
    expect(resolveId("R3.s1 [state] State stored, scope per call", listed)).toMatchObject({ id: "R3.s1" });
    expect(resolveId("R3 (item)", listed)).toMatchObject({ id: "R3" });
    expect(resolveId("  Q1  ", listed)).toMatchObject({ id: "Q1" });
  });

  it("reads Q12 as Q12 and not as Q1, and never reads a longer token as a shorter listed id", () => {
    expect(resolveId("Q12 [x]", listed)).toMatchObject({ id: "Q12" });
    expect(resolveId("Q13 [x]", listed)).toEqual({ id: undefined, why: "unknown" });
    expect(resolveId("Q1x", listed)).toEqual({ id: undefined, why: "unknown" });
    expect(resolveId("R3.s2 [state]", listed)).toEqual({ id: undefined, why: "unknown" });
    expect(resolveId("R3.x", listed)).toEqual({ id: undefined, why: "unknown" });
  });

  it("leaves an unknown id and an ambiguous one unjudged", () => {
    expect(resolveId("Q9 [split-function] text", listed)).toEqual({ id: undefined, why: "unknown" });
    expect(resolveId("the whole question text with no id", listed)).toEqual({ id: undefined, why: "unknown" });
    expect(resolveId("", listed)).toEqual({ id: undefined, why: "unknown" });
    for (const text of ["Q1, Q2", "Q1/Q2", "Q1 and Q2", "Q1 & Q2", "Q1-Q2", "Q1 or Q2", "Q1 to Q2"]) expect(resolveId(text, listed), text).toEqual({ id: undefined, why: "ambiguous" });
  });
});

describe("the answer checker's and the answerer's ids are read tolerantly, and never silently", () => {
  const ctx = contextOf("missing-test");
  const questions = afterNecessity(questionSet(ctx, undefined));
  const answers = new Map(questions.map((x) => [x.id, { question: x.id, none_found: false } as Answer] as const));
  const verdict = (question: string, over: object = {}) => ({ question, verdict: "supported", note: "", searches: [search("x", { hits: 0 })], principles: [], ...over });

  it("matches verdicts keyed with the type or the whole text after the id, and records the normalization", () => {
    const verdicts = questions.map((x) => verdict(`${x.id} [${x.type}] ${x.text}`));
    const reading = readAnswerCheck({ verdicts }, questions, answers);
    if ("problems" in reading) throw new Error(reading.problems.join(";"));
    expect(reading.unchecked).toEqual([]);
    expect([...reading.supported].sort()).toEqual(questions.map((x) => x.id).sort());
    expect(reading.notes.get(questions[0]!.id)![0]).toMatch(/the checker's id .* is not a bare id; read as /);
    expect(reading.ignored).toEqual([]);
  });

  it("does not match an unknown id or an ambiguous one: the question stays unchecked, and the reading says which keys it ignored", () => {
    const [first, second, ...rest] = questions;
    const verdicts = [verdict("Q99 [purpose] something"), verdict(`${first!.id}, ${second!.id}`), ...rest.map((x) => verdict(x.id))];
    const reading = readAnswerCheck({ verdicts }, questions, answers);
    if ("problems" in reading) throw new Error(reading.problems.join(";"));
    expect(reading.unchecked).toEqual([first!.id, second!.id]);
    expect(reading.ignored).toEqual([expect.stringContaining("(unknown)"), expect.stringContaining("(ambiguous)")]);
  });

  it("reads the answerer's answers keyed with the text after the id, and records it", () => {
    const base = { answer: "a", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" } };
    const out = { answers: questions.map((x) => ({ ...base, question: `${x.id} [${x.type}] ${x.text}` })) };
    const parsed = parseAnswers(out, new Set(questions.map((x) => x.id)));
    if ("problems" in parsed) throw new Error(parsed.problems.join(";"));
    expect(parsed.answers.map((a) => a.question)).toEqual(questions.map((x) => x.id));
    expect(parsed.notes.get(questions[0]!.id)![0]).toMatch(/the answerer's id/);
    // An id it cannot read stays as written, and the deterministic checks refuse it.
    const bad = parseAnswers({ answers: [{ ...base, question: "Q99 [purpose] x" }] }, new Set(questions.map((x) => x.id)));
    if ("problems" in bad) throw new Error("shape");
    expect(bad.answers[0]!.question).toBe("Q99 [purpose] x");
    expect(answerProblems(bad.answers, answerContext(ctx, questions)).join("|")).toMatch(/"Q99 \[purpose\] x" is not a question id/);
  });

  it("reads the claim checker's verdicts keyed with the claim's text, and leaves an unknown claim unjudged", () => {
    const targets: ClaimTarget[] = ["purpose", "overview", "R1", "R1.s1"].map((id) => ({ id, text: id, cites: undefined, quotes: "none" as const }));
    const verdicts = [
      { item: "purpose", verdict: "supported", note: "", quotes: [] },
      { item: "overview [overview] The change…", verdict: "supported", note: "", quotes: [] },
      { item: "R1 [features] Adds the thing", verdict: "supported", note: "", quotes: [] },
      { item: "R1.s9 [state]", verdict: "supported", note: "", quotes: [] },
    ];
    const reading = readClaimCheck({ verdicts }, targets, []);
    if ("problems" in reading) throw new Error(reading.problems.join(";"));
    expect(reading.unchecked).toEqual(["R1.s1"]);
    expect([...reading.supported]).toEqual(["purpose", "overview", "R1"]);
    expect(reading.notes).toHaveLength(2);
    expect(reading.ignored).toEqual([expect.stringContaining("(unknown)")]);
  });
});

describe("a search is a structured, valid, re-runnable record", () => {
  it("accepts extended regular expressions git grep -E reads, and refuses the ones it does not", () => {
    for (const ok of ["flush", "func \\w+\\(", "^func .*\\(.*string.*\\).*int", "a|b", "[[:alpha:]]+", "[]a]", "x{2,3}", "\\(literal\\)", "(a|b)*c", "docs/concept/.*\\.md"]) expect(ereProblem(ok), ok).toBeUndefined();
    for (const bad of ["", "(unclosed", "unopened)", "[abc", "*leading", "a|*b", "x{2", "x{3,2}", "x{2000}", "trailing\\", "line\nbreak", "a".repeat(301), "[[:alpha:", "^*"]) expect(ereProblem(bad), JSON.stringify(bad)).toEqual(expect.any(String));
  });

  it("refuses paths that leave the tree or that git would read as magic, and checks a dependency's against the mounted directories", () => {
    expect(pathProblem("pkg/**/*.go", "base", [])).toBeUndefined();
    expect(pathProblem("*_test.go", "head", [])).toBeUndefined();
    expect(pathProblem("../etc", "base", [])).toMatch(/\.\./);
    expect(pathProblem("pkg/../../x", "head", [])).toMatch(/\.\./);
    expect(pathProblem("/etc/passwd", "base", [])).toMatch(/absolute/);
    expect(pathProblem(":(top)x", "base", [])).toMatch(/magic/);
    expect(pathProblem("", "base", [])).toMatch(/empty/);
    expect(pathProblem("a\nb", "base", [])).toMatch(/newline/);
    expect(pathProblem("/mod/x/y", "dependency", ["/mod/x"])).toBeUndefined();
    expect(pathProblem("/etc", "dependency", ["/mod/x"])).toMatch(/inventory/);
    expect(pathProblem("/mod/x/../../etc", "dependency", ["/mod/x"])).toMatch(/\.\./);
    expect(pathProblem("rel", "dependency", ["/mod/x"])).toMatch(/inventory/);
  });

  it("accepts an exclusion pathspec, whose glob is checked like any path, and no other magic", () => {
    for (const ok of [":!*_test.go", ":!*.pb.go", ":^vendor/**", ":(exclude)docs/**"]) expect(pathProblem(ok, "base", []), ok).toBeUndefined();
    expect(pathProblem(":!", "base", [])).toMatch(/excludes a path that is empty/);
    expect(pathProblem(":!../x", "head", [])).toMatch(/excludes a path that has a \.\. segment/);
    expect(pathProblem(":!/etc", "base", [])).toMatch(/excludes a path that is absolute/);
    expect(pathProblem(":(glob)*.go", "base", [])).toMatch(/only an exclusion/);
    expect(pathProblem(":!*_test.go", "dependency", ["/mod/x"])).toMatch(/inventory/);
  });

  it("names every problem of a search in the answer's deterministic check, and so sends it back", () => {
    const ctx = contextOf("complex-function");
    const set = questionSet(ctx, undefined);
    const actx = answerContext(ctx, set.questions);
    const q = set.questions.find((x) => x.type === "split-function")!;
    const answer = (searches: Search[]): Answer => ({
      question: q.id,
      answer: "a",
      status: "answered",
      none_found: false,
      citations: [],
      searches,
      inventory: [],
      metrics: [],
      proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" },
    });
    const text = (searches: Search[]) => answerProblems([answer(searches)], actx, new Set([q.id])).join("|");
    expect(text([search("(unclosed")])).toMatch(/not a valid extended regular expression.*unmatched \(/);
    expect(text([search("ok", { paths: ["../secret"] })])).toMatch(/has the path "\.\.\/secret", which has a \.\. segment/);
    expect(text([search("ok", { tree: "dependency", paths: ["/etc"] })])).toMatch(/absolute directory inside one of the inventory/);
    expect(searchProblems(search("ok"), "Q1", [])).toEqual([]);
    expect(text([search("ok")])).not.toMatch(/regular expression|path/);
    expect(text([search("ok", { paths: ["pkg/**", ":!*_test.go", ":!*.pb.go"] })])).not.toMatch(/path/);
    // The existence/reuse/common-logic answer covers three concerns in one statement: it has twice the room.
    const reuse = set.questions.find((x) => x.type === "existing-reuse-common");
    expect(reuse).toBeDefined();
    const sized = (id: string, n: number) => answerProblems([{ ...answer([search("ok")]), question: id, answer: "x".repeat(n) }], actx, new Set([id])).join("|");
    expect(sized(reuse!.id, 3_000)).not.toMatch(/characters, more than/);
    expect(sized(reuse!.id, 4_100)).toMatch(/4100 characters, more than 4000/);
    expect(sized(q.id, 2_100)).toMatch(/2100 characters, more than 2000/);
  });
});

describe("re-running the reported searches", () => {
  it("runs each distinct base or head search once, under a content-addressed id, however many answers report it", () => {
    const items = searchItems([{ question: "Q1", search: search("flush", { hits: 0 }) }, { question: "Q2", search: search("flush", { hits: 3 }) }, { question: "Q2", search: search("flush", { tree: "head" }) }], REHEARSAL_MERGE_BASE, "cite", []);
    expect(items).toHaveLength(2);
    expect(items[0]!.command.id).toMatch(SEARCH_ID);
    expect(items[0]!.reported).toEqual([{ question: "Q1", hits: 0 }, { question: "Q2", hits: 3 }]);
    expect(items[0]!.command.argv.slice(3)).toEqual([items[0]!.command.id, REHEARSAL_MERGE_BASE, "base", "0", "flush"]);
    expect(items[1]!.command.argv.slice(5, 7)).toEqual(["head", "0"]);
    expect(searchItems([{ question: "Q1", search: search("flush") }], REHEARSAL_MERGE_BASE, "cite-n", [])[0]!.command.id).toMatch(/^cite-n-s-/);
  });

  it("does not run a dependency search or an invalid one, and bounds the searches run per result, those behind none-found answers first", () => {
    const list = [{ question: "Q1", search: search("a", { tree: "dependency", paths: ["/mod/x"] }) }, { question: "Q1", search: search("(bad") }];
    expect(searchItems(list, REHEARSAL_MERGE_BASE, "cite", ["/mod/x"])).toEqual([]);
    const many = Array.from({ length: MAX_RERUN_SEARCHES + 20 }, (_, i) => ({ question: "Q1", search: search(`token${i}`) }));
    const items = searchItems(many, REHEARSAL_MERGE_BASE, "cite", []);
    expect(items).toHaveLength(MAX_RERUN_SEARCHES);
    for (const item of items) {
      expect(item.command.argv.length).toBeLessThanOrEqual(64);
      expect(item.command.argv.every((a) => a.length <= 4096)).toBe(true);
    }
    const ctx = contextOf("complex-function");
    const actx = answerContext(ctx, questionSet(ctx, undefined).questions);
    const mk = (id: string, none: boolean, pattern: string): Answer => ({ question: id, answer: "a", status: "answered", none_found: none, citations: [], searches: [search(pattern)], inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" } });
    const plan = verificationPlan([mk("Q1", false, "later"), mk("Q2", true, "first")], actx, REHEARSAL_MERGE_BASE).filter((p) => p.kind === "search");
    expect(plan.map((p) => p.search!.pattern)).toEqual(["first", "later"]);
  });

  it("reads what the command reports: a count, or the error git gave", () => {
    expect(readSearchReport("count 54 9\nchecked 1\n")).toEqual({ measured: 54, files: 9 });
    expect(readSearchReport("error fatal: -e option, '(x': Unmatched ( or \\(\nchecked 1\n")).toEqual({ error: "fatal: -e option, '(x': Unmatched ( or \\(" });
    expect(readSearchReport("checked 1\n")).toBeUndefined();
  });

  it("shows the measured count as the fact, and flags a reported one that differs", () => {
    expect(searchLine({ ...search("flush", { hits: 54 }), measured: 54, files: 9 }, 80)).toBe("`flush` (base) → 54 hits (measured)");
    expect(searchLine({ ...search("flush", { hits: 0 }), measured: 54, files: 9 }, 80)).toBe("`flush` (base) → measured 54 hits in 9 files (reported 0: mismatch)");
    expect(searchLine({ ...search("flush", { hits: 1, paths: ["docs/*.md"], ignoreCase: true }), measured: 1, files: 1 }, 80)).toBe("`flush` (base docs/*.md, -i) → 1 hit (measured)");
    expect(searchLine({ ...search("x", { tree: "dependency", hits: 2 }), note: "not re-run: the dependency's source lies outside the repository" }, 80)).toMatch(/→ reported 2 hits, not measured \(not re-run/);
  });
});

/** Every canned search command of a scenario reports this many hits. */
const measuring = (s: { commands?: Record<string, { exitCode: number; stdout?: string }> }, lines: number, files: number, only: RegExp = SEARCH_ID): void => {
  for (const id of Object.keys(s.commands ?? {})) if (only.test(id)) s.commands![id] = { exitCode: 0, stdout: `count ${lines} ${files}\nchecked 1\n` };
};
const finalOf = (sim: Simulation) => (JSON.parse(sim.qa!.json) as { questions: Array<{ id: string; type: string; answer?: FinalAnswer }> }).questions;

describe("the graph re-runs the searches and records what it measured", () => {
  /** The answerer reports this many hits for every search of every answer. */
  const reporting = (sc: { results: Record<string, Array<{ output?: unknown }>> }, hits: number): void => {
    for (const key of ["answers-v1", "answers-revision-v1"]) for (const r of sc.results[key] ?? []) for (const a of (r.output as { answers: Answer[] }).answers) for (const x of a.searches) x.hits = hits;
  };

  it("shows the measured count in qa.json and review.md, and flags the mismatch with the one the answerer reported", () => {
    const s = scenarioWith("answer-no-library-with-whole-repo-search", (sc) => {
      measuring(sc, 54, 9);
      reporting(sc, 3);
    });
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    const searches = finalOf(sim).filter((q) => q.id !== "N1").flatMap((q) => q.answer?.searches ?? []);
    expect(searches.length).toBeGreaterThan(0);
    // An answer that reported hits is not contradicted by more: its count is replaced by the measured one, and flagged.
    for (const x of searches) expect(x).toMatchObject({ hits: 3, measured: 54, files: 9 });
    expect(sim.qa!.markdown).toMatch(/measured 54 hits in 9 files \(reported 3: mismatch\)/);
    expect(sim.qa!.markdown).not.toMatch(/→ 3 hits/);
  });

  it("sends a none-found answer back when its search measures hits, and says what it measured", () => {
    const s = scenarioWith("answer-no-library-with-whole-repo-search", (sc) => measuring(sc, 54, 9));
    const sim = simulate({ scenario: s });
    // The scenario's none-found answer reported 0 hits for \b…\b; the re-run measured 54, so the answerer is asked again.
    const answerers = jobsOf(sim, "Answer the questions");
    expect(answerers.length).toBeGreaterThanOrEqual(2);
    expect(assignmentOf(answerers[1]!)).toMatch(/is reported as finding nothing \(hits 0\), but re-running it measured 54 hits in 9 files/);
    expect(assignmentOf(answerers[1]!)).toContain("an answer cannot rest on it as an absence");
  });

  it("keeps a none-found answer whose searches measure zero, and records the zero as measured", () => {
    const s = scenarioWith("answer-no-library-with-whole-repo-search", (sc) => measuring(sc, 0, 0));
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(jobsOf(sim, "Answer the questions")).toHaveLength(1);
    const none = finalOf(sim).filter((q) => q.answer?.none_found);
    expect(none.length).toBeGreaterThan(0);
    for (const q of none) for (const x of q.answer!.searches) expect(x.measured).toBe(0);
  });

  it("gives the supervisor a none-found answer that stays contradicted after the corrections", () => {
    const s = scenarioWith("answer-no-library-with-whole-repo-search", (sc) => {
      measuring(sc, 54, 9);
      // The answerer keeps reporting 0 hits for every search.
      for (const r of sc.results["answers-v1"]!) for (const a of (r.output as { answers: Answer[] }).answers) for (const x of a.searches) x.hits = 0;
    });
    const sim = simulate({ scenario: s });
    expect(superviseOf(sim)?.reason).toMatch(/still fail deterministic validation after 2 corrections.*re-running it measured 54/);
  });

  it("accepts a corrected answer that reports the measured count", () => {
    const s = scenarioWith("answer-no-library-with-whole-repo-search", (sc) => {
      measuring(sc, 54, 9);
      const first = sc.results["answers-v1"]![0]!.output as { answers: Answer[] };
      const fixed = structuredClone(first);
      for (const a of fixed.answers) for (const x of a.searches) x.hits = 54;
      sc.results["answers-v1"] = [{ output: first }, { output: fixed }];
    });
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(sim.qa!.markdown).toMatch(/→ 54 hits \(measured\)/);
    expect(sim.qa!.markdown).not.toMatch(/reported 54: mismatch/);
  });

  it("measures the checker's own searches too, and shows them beside the checker's verdict", () => {
    const s = scenarioWith("answer-finds-existing-helper", (sc) => {
      measuring(sc, 7, 2);
      reporting(sc, 7);
    });
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    const checked = finalOf(sim).flatMap((q) => q.answer?.check.searches ?? []);
    expect(checked.length).toBeGreaterThan(0);
    for (const x of checked) expect(x).toMatchObject({ measured: 7, files: 2 });
    expect(sim.qa!.markdown).toMatch(/Its own searches: .*measured 7 hits in 2 files/);
  });

  it("measures N1's searches, shows them in the Necessity part, and does not accept a design search reported as empty that matches", () => {
    const s = scenarioWith("necessity-necessary", (sc) => measuring(sc, 54, 9, /^cite-n-s-/));
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(sim.qa!.markdown).toMatch(/Searched: .*measured 54 hits in 9 files \(reported 4: mismatch\)/);
    const empty = scenarioWith("necessity-necessary", (sc) => {
      measuring(sc, 54, 9, /^cite-n-s-/);
      for (const key of ["necessity-v1", "necessity-revision-v1"]) for (const r of sc.results[key] ?? []) for (const x of (r.output as { design: { searches: Search[] } }).design.searches) x.hits = 0;
    });
    const sim2 = simulate({ scenario: empty });
    expect(jobsOf(sim2, "Answer the necessity").length).toBeGreaterThanOrEqual(2);
    expect(assignmentOf(jobsOf(sim2, "Answer the necessity")[1]!)).toMatch(/N1: the search .* is reported as finding nothing \(hits 0\), but re-running it measured 54 hits/);
  });

  it("rejects an answer whose pattern is not a valid regular expression, before any re-run", () => {
    const s = scenarioWith("answer-no-library-with-whole-repo-search", (sc) => {
      const first = sc.results["answers-v1"]![0]!.output as { answers: Answer[] };
      first.answers[0]!.searches[0]!.pattern = "(unclosed";
    });
    const sim = simulate({ scenario: s });
    const answerers = jobsOf(sim, "Answer the questions");
    expect(answerers.length).toBeGreaterThanOrEqual(2);
    expect(assignmentOf(answerers[1]!)).toMatch(/not a valid extended regular expression \(git grep -E\)/);
  });
});

describe("the live run's failure: verdicts keyed with the type and the question's text (run 485ea8ea-e73, evidence ev-g1-89..91)", () => {
  const rekey = (sc: { results: Record<string, Array<{ output?: unknown }>> }, key: (v: { question: string }) => string): void => {
    for (const r of sc.results["answer-check-v1"]!) for (const v of (r.output as { verdicts: Array<{ question: string }> }).verdicts) if (v.question !== "N1") v.question = key(v);
  };

  it("matches the verdicts and finishes, noting each normalization in review.md and qa.json", () => {
    const s = scenarioWith("answer-finds-existing-helper", (sc) => rekey(sc, (v) => `${v.question} [split-function] Could stream.(*writeCallback).Rev be split into smaller functions?`));
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(sim.qa!.markdown).toMatch(/Note: the checker's id "Q1 \[split-function\] Could stream/);
    const notes = finalOf(sim).flatMap((q) => q.answer?.notes ?? []);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("matches the answerer's answers keyed the same way", () => {
    const s = scenarioWith("answer-finds-existing-helper", (sc) => {
      for (const key of ["answers-v1", "answers-revision-v1"]) for (const r of sc.results[key] ?? []) for (const a of (r.output as { answers: Answer[] }).answers) a.question = `${a.question} [existing-reuse-common] Does the codebase already have one?`;
    });
    const sim = simulate({ scenario: s });
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(sim.qa!.markdown).toMatch(/Note: the answerer's id "Q1 \[existing-reuse-common\]/);
  });

  it("does not match an ambiguous or unknown key: the checker's verdicts stay unjudged, and the escalation names the keys", () => {
    const s = scenarioWith("answer-finds-existing-helper", (sc) => rekey(sc, (v) => `${v.question}, Q2`));
    const sim = simulate({ scenario: s });
    expect(superviseOf(sim)?.reason).toMatch(/the answer checker did not judge every answer after 3 tries; verdict ids that matched no question: "Q\d+, Q2" \(ambiguous\)/);
    const unknown = simulate({ scenario: scenarioWith("answer-finds-existing-helper", (sc) => rekey(sc, () => "Q99 [purpose] nothing")) });
    expect(superviseOf(unknown)?.reason).toMatch(/\(unknown\)/);
  });
});

describe("a result the controller classed invalid because of an id", () => {
  const defn = definitionFor(parseProfile(BANYANDB));
  /** What the controller records when a result's ids are off the job's enum: the contract invalid, kind other, the wrapper kept. */
  const classify = (job: JobSpec, [record]: EvidenceRecord[]): EvidenceRecord[] | undefined => {
    const contract = defn.resultContracts!.find((c) => c.name === job.resultSchema);
    if (contract === undefined || job.knownReferences === undefined) return undefined;
    if (record === undefined) return undefined;
    const payload = record.payload as { producer: unknown; codingAgent?: { status: string; output: unknown } } & Record<string, unknown>;
    const output = payload.codingAgent !== undefined ? payload.codingAgent.output : (({ producer: _p, ...rest }) => rest)(payload);
    const checked = checkContract(output, contract, job.knownReferences);
    if (checked.status !== "invalid") return undefined;
    return [{ ...record, kind: "other", contract: { name: contract.name, status: "invalid", problems: checked.problems }, payload: { producer: payload.producer, codingAgent: { status: "completed", output } } }];
  };

  it("still reads the answerer's answers when only an id is off, and notes it", () => {
    const s = scenarioWith("answer-finds-existing-helper", (sc) => {
      for (const key of ["answers-v1", "answers-revision-v1"]) for (const r of sc.results[key] ?? []) for (const a of (r.output as { answers: Answer[] }).answers) a.question = `${a.question} [existing-reuse-common] Does the codebase already have one?`;
    });
    const sim = simulate({ scenario: s, tamper: classify });
    expect(sim.evidence.some((e) => e.contract?.status === "invalid")).toBe(true);
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(sim.qa!.markdown).toMatch(/Note: the answerer's id "Q1 \[existing-reuse-common\]/);
  });

  it("does not read the checker's: its review evidence is not admitted when invalid, so it is asked again, and then escalated", () => {
    const s = scenarioWith("answer-finds-existing-helper", (sc) => {
      for (const r of sc.results["answer-check-v1"]!) for (const v of (r.output as { verdicts: Array<{ question: string }> }).verdicts) if (v.question !== "N1") v.question = `${v.question} [existing-reuse-common] text`;
    });
    const sim = simulate({ scenario: s, tamper: classify });
    expect(superviseOf(sim)?.reason).toMatch(/the answer checker did not judge every answer after 3 tries/);
    expect(jobsOf(sim, "Check the answers against")).toHaveLength(3);
  });
});

describe("only a search of the whole base tree grounds an absence", () => {
  const ctx = contextOf("complex-function");
  const set = questionSet(ctx, undefined);
  const actx = answerContext(ctx, set.questions);
  const q = set.questions.find((x) => x.type === "existing-reuse-common")!;
  const none = (searches: Search[]): Answer => ({ question: q.id, answer: "a", status: "partially answered", none_found: true, citations: [], searches, inventory: [], metrics: [], proposal: { kind: "none", splits: [], testFile: "", testName: "", cases: [], assertion: "" } });
  const problems = (searches: Search[]) => answerProblems([none(searches)], actx, new Set([q.id])).join("|");

  it("sends a none-found answer back when its required searches fall beyond the bound of re-runs, and accepts it when they are re-run", () => {
    const mine = [search("alpha"), search("beta"), search("gamma")];
    const filler = Array.from({ length: MAX_RERUN_SEARCHES }, (_, i) => ({ question: "Qx", search: search(`filler${i}`) }));
    const crowded = searchItems([...filler, ...mine.map((s) => ({ question: q.id, search: s }))], REHEARSAL_MERGE_BASE, "cite", []);
    expect(crowded).toHaveLength(MAX_RERUN_SEARCHES);
    expect(unmeasuredAbsences([none(mine)], actx, crowded).join("|")).toMatch(new RegExp(`${q.id}: its "none found" answer rests on 0 of the 3 whole-tree searches the plugin re-runs.*at most ${MAX_RERUN_SEARCHES} distinct searches`));
    const roomy = searchItems(mine.map((s) => ({ question: q.id, search: s })), REHEARSAL_MERGE_BASE, "cite", []);
    expect(unmeasuredAbsences([none(mine)], actx, roomy)).toEqual([]);
    // Two of the three re-run is not enough.
    expect(unmeasuredAbsences([none(mine)], actx, roomy.slice(0, 2))[0]).toMatch(/rests on 2 of the 3/);
  });

  it("does not count a search scoped to paths, nor a head or dependency one, toward the whole-repository searches", () => {
    const scoped = [search("a", { paths: ["README.md"] }), search("b", { paths: ["pkg/**"] }), search("c", { paths: ["nowhere/*"] })];
    expect(problems(scoped)).toMatch(/3 or more over the whole base tree, with no paths.*not 0/);
    expect(problems([search("a"), search("b"), search("c", { tree: "head" })])).toMatch(/not 2/);
    expect(problems([search("a"), search("b"), search("c"), search("d", { paths: ["x/*"] })])).toBe("");
  });
});

describe("the ids of every Q&A contract are constrained to the ids the job lists", () => {
  const defn = definitionFor(parseProfile(BANYANDB));
  const contract = (name: string) => defn.resultContracts!.find((c) => c.name === name)!;
  const sim = simulate({ scenarioName: "answer-finds-existing-helper" });

  it("declares the id paths on each contract", () => {
    expect(contract("answers-v1").references).toEqual(["answers[].question"]);
    expect(contract("answers-revision-v1").references).toEqual(["answers[].question"]);
    expect(contract("answer-check-v1").references).toEqual(["verdicts[].question", "verdicts[].principles[].id"]);
    expect(contract("claim-check-v1").references).toEqual(["verdicts[].item"]);
    expect(contract("questions-v1").references).toEqual(["purposes[].item", "questions[].item", "questions[].symbol"]);
  });

  const refsOf = (job: JobSpec) => job.knownReferences ?? {};

  it("passes the answerer exactly the ids of its questions, and the checker the same", () => {
    const answerer = jobsOf(sim, "Answer the questions")[0]!;
    const ids = Object.keys(JSON.parse(JSON.stringify(refsOf(answerer)["answers[].question"]!.descriptions)));
    expect(refsOf(answerer)["answers[].question"]!.ids).toEqual(ids);
    expect(ids[0]).toBe("Q1");
    const checker = jobsOf(sim, "Check the answers against")[0]!;
    expect(refsOf(checker)["verdicts[].question"]!.ids).toEqual(ids);
    const narrowed = applyReferenceEnums(contract("answer-check-v1").schema, contract("answer-check-v1").references, refsOf(checker)) as { properties: { verdicts: { items: { properties: { question: { enum: string[] } } } } } };
    expect(narrowed.properties.verdicts.items.properties.question.enum).toEqual(ids);
  });

  it("puts the enum into the schema the harness constrains the answerer's output to, and tells the agent to use the bare id", () => {
    const answerer = jobsOf(sim, "Answer the questions")[0]!;
    const narrowed = applyReferenceEnums(contract("answers-v1").schema, contract("answers-v1").references, refsOf(answerer)) as { properties: { answers: { items: { properties: { question: { enum: string[] } } } } } };
    expect(narrowed.properties.answers.items.properties.question.enum).toEqual(refsOf(answerer)["answers[].question"]!.ids);
    expect(assignmentOf(answerer)).toMatch(/bare id exactly as listed/);
    expect(assignmentOf(jobsOf(sim, "Check the answers against")[0]!)).toMatch(/bare id exactly as listed/);
  });

  it("constrains N1's checker to N1, the claim checker to the claim ids, and the questioner to the report's items and symbols", () => {
    expect(refsOf(jobsOf(sim, "Check the necessity answer").find((j) => j.kind === "agent")!)["verdicts[].question"]!.ids).toEqual(["N1"]);
    const claim = jobsOf(sim, "Check the report's claims")[0]!;
    expect(refsOf(claim)["verdicts[].item"]!.ids).toEqual(expect.arrayContaining(["purpose", "overview", "R1"]));
    expect(assignmentOf(claim)).toMatch(/bare claim id exactly as listed/);
    const q = sim.jobs.find((j) => j.jobId === "questioner")!;
    expect(refsOf(q)["questions[].symbol"]!.ids).toContain("");
    expect(refsOf(q)["questions[].item"]!.ids).toContain("R1");
  });

  it("limits a revision to the questions asked again", () => {
    const sim2 = simulate({ scenarioName: "answer-checker-contradicts" });
    const answerers = jobsOf(sim2, "Answer the questions");
    expect(answerers).toHaveLength(2);
    expect(refsOf(answerers[1]!)["answers[].question"]!.ids).toEqual(["Q1"]);
  });

  for (const name of Object.keys(rehearsal(BANYANDB).scenarios)) {
    it(`${name}: every reply of the stand-in agents satisfies its contract and its enums`, () => {
      const scenario = rehearsal(BANYANDB).scenarios[name]!;
      const run = simulate({ scenarioName: name });
      const next = new Map<string, number>();
      for (const job of run.jobs.filter((j) => j.kind === "agent")) {
        const i = next.get(job.resultSchema!) ?? 0;
        next.set(job.resultSchema!, i + 1);
        const list = scenario.results[job.resultSchema!]!;
        const reply = list[Math.min(i, list.length - 1)]!;
        expect(checkContract(reply.output, contract(job.resultSchema!), job.knownReferences), `${name}: ${job.resultSchema}`).toMatchObject({ status: expect.stringMatching(/^(valid|repaired)$/) });
      }
    });
  }
});
