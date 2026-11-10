// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EnvironmentCommand, JobSpec } from "@graphloom/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { recordedQa } from "../src/parts.js";
import { assignmentProblem, ASSIGNMENT_BUDGET_CHARS, ASSIGNMENT_MARGIN_CHARS, fitLines, MAX_ASSIGNMENT_CHARS, shrinkToFit } from "../src/fit.js";
import { diagramSpecs, MAX_DIAGRAM_DATA_CHARS } from "../src/diagrams.js";
import type { Fact } from "../src/detectors.js";
import type { ClaimTarget } from "../src/claims.js";
import { planChecker, planReporter, pullText } from "../src/prompts.js";
import type { Answer } from "../src/answers.js";
import { planAnswerChecker, planAnswerer, planNecessity, planNecessityChecker } from "../src/qaprompts.js";
import { reporterSections } from "../src/template.js";
import type { Question } from "../src/questions.js";
import type { Groundwork } from "../src/groundwork.js";

import { hugeRehearsal } from "../src/rehearsal.js";
import { HUGE_AREAS, HUGE_LIMITS, hugeSymbolNames } from "../src/rehearsal-huge.js";
import { BANYANDB, assignmentOf, profileOf, simulateYielding, type Simulation } from "./support.js";
import { hugePath, HUGE_FILES_PER_AREA } from "../src/rehearsal-huge.js";
import { passReply, verifyReply } from "../src/rehearsal-review.js";
import { REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME } from "../src/review.js";
import { recordedScope } from "../src/reviewdraft.js";
import { REHEARSAL_REQUEST } from "../src/rehearsal.js";

const CONFIG = { limits: HUGE_LIMITS };
/** What the briefing of the huge pull request cites, so what its default review scope is (areas and files). */
const HUGE_SCOPE_FILES = HUGE_FILES_PER_AREA;

/** The run's agent jobs, with what each was for. */
const agentJobs = (sim: Simulation): JobSpec[] => sim.jobs.filter((j) => j.kind === "agent");
const WORKTREE = "/work/tree";
const pathsOf = (assignment: string): string[] => [...new Set([...assignment.matchAll(/\/work\/tree\/\.graphloom\/review\/[A-Za-z0-9_./-]+/g)].map((m) => m[0].replace(/[.,;:)]+$/, "")))].filter((p) => !p.includes("/base"));
/** The files a command writes, by the paths its part argv names. */
const writtenBy = (c: EnvironmentCommand): string | undefined => (/-p\d+$/.test(c.id) ? `${WORKTREE}/${c.argv[4]}` : undefined);

describe("every agent assignment fits the executor's bound on a pull request at the scale of #1445", () => {
  const { scenario, headFiles } = hugeRehearsal({ ...BANYANDB, ...CONFIG });
  // The run takes tens of seconds; yielding keeps the worker answering vitest's RPC (simulateYielding).
  let sim: Simulation;
  beforeAll(async () => {
    sim = await simulateYielding({ scenario, config: CONFIG, files: headFiles, maxSteps: 2_500, budgets: { agentInvocations: 400, jobs: 2_000, decisions: 4_000, corrections: 40 } });
  }, 900_000);

  it("is a pull request of that size", () => {
    expect(Object.keys(headFiles).length).toBeGreaterThanOrEqual(200);
    expect(hugeSymbolNames().length).toBeGreaterThanOrEqual(800);
    expect(HUGE_AREAS).toBeGreaterThanOrEqual(24);
  });

  it("runs through Report, N1, Questions and Answers", () => {
    expect(sim.final.action.type === "stop" ? sim.final.action.stop : sim.final.action).toMatchObject({ reason: "answers accepted" });
    const schemas = new Set(agentJobs(sim).map((j) => j.resultSchema));
    for (const s of ["change-report-v1", "claim-check-v1", "diagrams-v1", "necessity-v1", "questions-v1", "answers-v1", "answer-check-v1"]) expect(schemas.has(s)).toBe(true);
  });

  it("asks per high-level change, so the questions stay at about sixteen however many areas and symbols there are", () => {
    const written = recordedQa(sim.evidence);
    if (written.state !== "read") throw new Error("qa.json was not written whole");
    const qa = JSON.parse(written.value.json) as { questions: Array<{ id: string; item: string }> };
    expect(qa.questions.length).toBeLessThanOrEqual(16);
    expect(qa.questions[0]!.id).toBe("N1");
    for (const q of qa.questions.slice(1)) expect(q.item).toMatch(/^W[1-5]$/);
  });

  it("dispatches every agent job with an assignment within the bound", () => {
    const sizes = agentJobs(sim).map((j) => ({ what: `${j.stageId}/${j.resultSchema}${j.jobId !== undefined ? `/${j.jobId}` : ""}`, chars: assignmentOf(j).length }));
    const over = sizes.filter((s) => s.chars > MAX_ASSIGNMENT_CHARS);
    expect(over, JSON.stringify(sizes.reduce<Record<string, number>>((m, s) => ({ ...m, [s.what]: Math.max(m[s.what] ?? 0, s.chars) }), {}))).toEqual([]);
    expect(Math.max(...sizes.map((s) => s.chars))).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
  });

  it("writes every workspace file an assignment names before the job that names it", () => {
    const written = new Set<string>();
    const referenced = new Set<string>();
    for (const j of sim.jobs) {
      const commands = (j.input as { commands?: EnvironmentCommand[] }).commands;
      if (j.kind === "command" && Array.isArray(commands)) for (const c of commands) {
        const p = writtenBy(c);
        if (p !== undefined) written.add(p);
        // The one-command writes of the report.
        if (c.id === "report-write") for (const n of ["report.json", "review.md"]) written.add(`${WORKTREE}/.graphloom/review/${n}`);
      }
      if (j.kind !== "agent") continue;
      for (const p of pathsOf(assignmentOf(j))) {
        referenced.add(p);
        expect(written.has(p), `${p} is named by the ${j.resultSchema} job before any command wrote it`).toBe(true);
      }
    }
    // The report's files and each kind of file the plugin writes for an agent are named by some job.
    const names = [...referenced].map((p) => p.slice(p.lastIndexOf("/") + 1));
    for (const stem of ["review.md", "report.json", "groundwork-", "claims-"]) expect(names.some((n) => n.startsWith(stem)), `no job names a ${stem} file`).toBe(true);
  });
});

const PR = { mode: "report" as const, owner: "o", repo: "r", number: 1, head: "a".repeat(40) };
const pull = { pull: { title: "t", body: "b" }, commits: [] } as never;
const DIR = "/work/tree/.graphloom/review";

describe("the guard and the fitting helpers", () => {
  it("names the job and what to shrink when an assignment is over the bound less its margin", () => {
    expect(assignmentProblem("a job", "x".repeat(ASSIGNMENT_BUDGET_CHARS))).toBeUndefined();
    const problem = assignmentProblem("ask the questions", "x".repeat(ASSIGNMENT_BUDGET_CHARS + 1))!;
    expect(problem).toContain("ask the questions");
    expect(problem).toContain(String(ASSIGNMENT_BUDGET_CHARS + 1));
    expect(problem).toMatch(/workspace file|cut it with a note/);
    expect(MAX_ASSIGNMENT_CHARS - ASSIGNMENT_BUDGET_CHARS).toBe(ASSIGNMENT_MARGIN_CHARS);
  });

  it("keeps the lines that fit and counts the rest", () => {
    const out = fitLines(["aaaa", "bbbb", "cccc"], 10, (n) => `${n} more`);
    expect(out).toEqual(["aaaa", "bbbb", "1 more"]);
    expect(fitLines(["aaaa"], 10, () => "never")).toEqual(["aaaa"]);
  });

  it("shrinks the variable parts until the assignment fits, and stops at scale 0", () => {
    const seen: number[] = [];
    const out = shrinkToFit((scale) => {
      seen.push(scale);
      return { text: "x".repeat(Math.round(200_000 * scale)), spills: [] };
    });
    expect(out.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    expect(seen.at(-1)).toBeLessThan(1);
    const never = shrinkToFit((scale) => ({ text: "y".repeat(70_000 + Math.round(scale * 10)), spills: [] }));
    expect(never.text.length).toBe(70_000);
  });

  it("cuts a pull request's body and commit list, and says how much was left out", () => {
    const text = pullText({ pull: { title: "t".repeat(2_000), body: "b".repeat(65_000) }, commits: Array.from({ length: 80 }, (_, i) => ({ sha: "c".repeat(40), message: `commit ${i} ${"m".repeat(500)}` })) } as never);
    expect(text.length).toBeLessThan(16_000);
    expect(text).toMatch(/the body is cut here: 57000 more characters of 65000/);
    expect(text).toContain("and 60 more commits");
  });
});

describe("a job that would not fit points to a file the plugin writes first", () => {
  it("gives the standard reporter its files and facts as a file past the inline budget, and inlines them below it", () => {
    const sections = reporterSections(profileOf());
    const file = (i: number) => ({ path: `pkg/dir${i % 40}/file${i}.go`, previousPath: null, status: "added", additions: 10, deletions: 0, parsed: { lines: [1] } });
    const facts = (n: number): Fact[] => Array.from({ length: n }, (_, i) => ({ id: `F${i + 1}`, section: "features", path: `pkg/dir${i % 40}/file${i}.go`, side: "head", line: 3, text: `adds a function that does thing number ${i} in a way a long fact text spells out in detail` }));
    const base = { pr: PR, snapshot: { ...(pull as object), files: Array.from({ length: 150 }, (_, i) => file(i)) } as never, sections, candidates: [], kind: "first" as const, feedback: [], reviewDir: DIR };
    const small = planReporter({ ...base, facts: facts(5) });
    expect(small.spills).toEqual([]);
    expect(small.text).toContain("F5 [features]");
    const big = planReporter({ ...base, facts: facts(900) });
    expect(big.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    expect(big.spills).toHaveLength(1);
    const spill = big.spills[0]!;
    expect(big.text).toContain(`${DIR}/${spill.name}`);
    expect(spill.name).toMatch(/^reporter-input-[0-9a-f]{8}\.md$/);
    // The file holds every changed file and every fact whole.
    expect(spill.text).toContain("Changed files (150):");
    expect(spill.text).toContain("pkg/dir29/file149.go");
    expect(spill.text).toContain("F900 [features] pkg/dir19/file899.go:3 (head): adds a function");
    expect(big.text).not.toContain("adds a function that does thing number 899");
  });

  it("gives the claim checker an index and a file of every claim past the inline budget", () => {
    const targets: ClaimTarget[] = Array.from({ length: 400 }, (_, i) => ({ id: `R${i + 1}`, text: `item ${i + 1} ${"does a thing in detail ".repeat(20)}`, cites: [{ path: `a${i}.go`, side: "head", start: 1, end: 2, symbol: "" }], quotes: "required" }));
    const plan = planChecker({ pr: PR, snapshot: pull, report: {} as never, targets, retry: false, reviewDir: DIR });
    expect(plan.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    const spill = plan.spills[0]!;
    expect(plan.text).toContain(`${DIR}/${spill.name}`);
    for (const t of targets) expect(spill.text).toContain(`${t.id} ${t.text}`);
    // Every claim id is told to the checker, here or in the file.
    expect(plan.text).toContain("R1 item 1");
    const few = planChecker({ pr: PR, snapshot: pull, report: {} as never, targets: targets.slice(0, 3), retry: false, reviewDir: DIR });
    expect(few.spills).toEqual([]);
  });

  it("gives the answerer a file of the questions it cannot list, with every id there", () => {
    const questions: Question[] = Array.from({ length: 900 }, (_, i) => ({ id: `Q${i + 1}`, type: "existing-reuse-common", item: "R1", text: `Is there an equivalent of function number ${i + 1} that the base already has?`, origin: "required", key: `k${i}` }));
    const groundwork = { symbols: [], searches: new Map(), candidates: [], prSimilar: [], inventory: { dependencies: [], packages: [], truncated: [] }, testMap: new Map(), notes: [] } as unknown as Groundwork;
    const plan = planAnswerer({ pr: PR, snapshot: pull, view: { items: [], records: [] }, groundwork, questions, kind: "first", feedback: [], mountedDirs: [], reviewDir: DIR });
    expect(plan.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    const spill = plan.spills.find((x) => x.name.startsWith("questions-"))!;
    expect(plan.text).toContain(`${DIR}/${spill.name}`);
    expect(spill.text).toContain("Q900 [existing-reuse-common]");
    expect(plan.text).toContain("Questions (900):");
  });

  it("gives the answer checker a batch of 15 existence/reuse/common-logic questions, each answered with full evidence, within the bound, the answers as a file", () => {
    const questions: Question[] = Array.from({ length: 15 }, (_, i) => ({ id: `Q${i + 1}`, type: "existing-reuse-common", item: `W${i + 1}`, text: `For the new functions and features of this change, W${i + 1} "the capability" (pkg/name.go:10): is there an equivalent, a library, common logic? ${"It cites pkg.Name (pkg/name.go:10), ".repeat(12)}`, origin: "required", key: `k${i}` }));
    const search = (n: number) => ({ pattern: `pattern-${n}-${"x".repeat(150)}`, tree: "base" as const, paths: [], ignoreCase: false as const, hits: 0 });
    const answers = new Map(questions.map((q) => [q.id, { question: q.id, answer: "No equivalent was found; the searches show none. ".repeat(30), status: "answered" as const, none_found: true, citations: Array.from({ length: 12 }, (_, k) => ({ path: `pkg/file${k}.go`, tree: "base" as const, start: 1, end: 9, quote: "q".repeat(300) })), searches: Array.from({ length: 12 }, (_, k) => search(k)), inventory: [], metrics: [], proposal: { kind: "none" as const, splits: [], testFile: "", testName: "", cases: [], assertion: "" } }] as [string, Answer]));
    const groundwork = { symbols: [], searches: new Map(), candidates: [], prSimilar: [], inventory: { dependencies: [], packages: [], truncated: [] }, testMap: new Map(), notes: [] } as unknown as Groundwork;
    const plan = planAnswerChecker({ pr: PR, snapshot: pull, groundwork, questions, answers, retry: false, mountedDirs: [], reviewDir: DIR });
    expect(plan.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    const spill = plan.spills.find((x) => x.name.startsWith("answers-"))!;
    expect(plan.text).toContain(`${DIR}/${spill.name}`);
    expect(spill.text).toContain("Q15 [existing-reuse-common]");
    const asked = planAnswerer({ pr: PR, snapshot: pull, view: { items: [], records: [] }, groundwork, questions, kind: "first", feedback: [], mountedDirs: [], reviewDir: DIR });
    expect(asked.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    expect(asked.text).toContain("Q15 [existing-reuse-common]");
  });

  it("gives N1's checker the whole answer as a file when it is long", () => {
    const step = (i: number) => ({ step: `step ${i} ${"shows what the base does here ".repeat(8)}`, path: "a.go", tree: "base" as const, start: 1, end: 2, quote: "q".repeat(100) });
    const answer = { question: "N1", answer: "", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { kind: "none" }, necessity: { conclusion: "necessary", rationale: "r", problem: { claim: "c", quotes: [], trace: Array.from({ length: 120 }, (_, i) => step(i)), canHappen: "yes", explanation: "e" }, reproduction: "none", principles: [], design: { statements: [], changed: [], effect: "unrelated", explanation: "e", searches: [] }, alternatives: { exists: false, explanation: "e", citations: [] }, searches: [] } } as never;
    const plan = planNecessityChecker({ pr: PR, snapshot: pull, question: { id: "N1", type: "necessity", item: "", text: "Is it necessary?", origin: "required", key: "" } as Question, answer, designDocs: [], context: [], retry: false, reviewDir: DIR });
    expect(plan.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    expect(plan.spills).toHaveLength(1);
    expect(plan.spills[0]!.text).toContain("T120 trace step");
    expect(plan.text).toContain(`${DIR}/${plan.spills[0]!.name}`);
  });

  it("leaves to the plugin the diagrams whose data does not fit one assignment", () => {
    const entry = (n: number) => ({ id: `state:R${n}:s`, item: `R${n}`, entry: { name: `state ${n}`, scope: "per call", initial: "0", transitions: Array.from({ length: 8 }, (_, i) => ({ when: `condition ${i} ${"w".repeat(230)}`, effect: `effect ${i} ${"e".repeat(230)}`, cite: { path: "a.go", side: "head" as const, start: 1, end: 1, symbol: "" } })), reads: [] } });
    const { drawn, overflow } = diagramSpecs({ features: [], states: Array.from({ length: 12 }, (_, i) => entry(i + 1)) });
    expect(drawn.length).toBeLessThan(12);
    expect(drawn.length + overflow.length).toBe(12);
    expect(overflow[0]).toBe(`state:R${drawn.length + 1}:s`);
    expect(MAX_DIAGRAM_DATA_CHARS).toBeLessThan(ASSIGNMENT_BUDGET_CHARS);
  });
});

describe("principles past the inline budget", () => {
  it("tell the agents to read them at the commit they were recorded from, not HEAD, when the profile names a ref", async () => {
    const { fitPrinciples } = await import("../src/qaprompts.js");
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `p-${i}`, statement: "x".repeat(400), why: "", applies: [], source: "maintainer" }));
    const ctx = { read: { path: "skills/design-principles/SKILL.md", ref: "docs/design-principles", commit: "13c5f4fb80df012a73c646a8e63a67d492e1c683", file: "present", text: "", truncated: false }, parsed: { principles: many, notes: [] }, applicable: many, inapplicable: [], changed: false } as never;
    const lines = fitPrinciples(ctx, (p: { id: string; statement: string }) => `- ${p.id}: ${p.statement}`, 1);
    const tail = lines.at(-1)!;
    expect(tail).toContain("more principles that apply");
    expect(tail).toContain("git show 13c5f4fb80df012a73c646a8e63a67d492e1c683:skills/design-principles/SKILL.md");
    expect(tail).not.toContain("git show HEAD:");
  });
});

describe("a repair keeps every problem and every statement it is given", () => {
  const sections = reporterSections(profileOf());
  const snapshot = { ...(pull as object), files: [] } as never;
  const reporter = { pr: PR, snapshot, sections, facts: [], candidates: [], reviewDir: DIR };
  const problems = (n: number): string[] => Array.from({ length: n }, (_, i) => `R${i + 1}: unsupported, ${"the diff does not show this claim; ".repeat(9)}(problem ${i + 1})`);

  it("lists the problems of a revision whole while they fit", () => {
    const plan = planReporter({ ...reporter, kind: "revision", feedback: problems(5) });
    expect(plan.spills).toEqual([]);
    expect(plan.text).toContain("(problem 5)");
  });

  it("writes every problem of a revision to a file past the inline budget, and tells the reporter to address each", () => {
    const feedback = problems(120);
    const plan = planReporter({ ...reporter, kind: "revision", feedback });
    expect(plan.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    const spill = plan.spills.find((x) => x.name.startsWith("feedback-"))!;
    expect(plan.text).toContain(`${DIR}/${spill.name}`);
    expect(plan.text).toMatch(/address every problem in it, none left out/);
    expect(plan.text).not.toContain("the check reports the rest again");
    for (const f of feedback) expect(spill.text).toContain(f);
    expect(plan.spills.filter((x) => x.name.startsWith("feedback-"))).toHaveLength(1);
    // A first assignment has no feedback to write.
    expect(planReporter({ ...reporter, kind: "first", feedback }).spills.some((x) => x.name.startsWith("feedback-"))).toBe(false);
  });

  it("does the same for N1's corrections", () => {
    const feedback = problems(120);
    const n1 = planNecessity({ pr: PR, snapshot, view: { items: [], records: [] }, designDocs: [], context: [], kind: "correction", feedback, reviewDir: DIR });
    expect(n1.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    expect(n1.spills.some((x) => x.name.startsWith("feedback-") && x.text.includes("(problem 120)"))).toBe(true);
  });

  const principle = (i: number, n: number) => ({ id: `p-${i}`, statement: `${"s".repeat(n - 4)}#${String(i).padStart(2, "0")}`, why: "", applies: [], source: "maintainer" });
  const ctxOf = (many: ReturnType<typeof principle>[]) => ({ read: { path: "skills/design-principles/SKILL.md", ref: "r", commit: "13c5f4fb80df012a73c646a8e63a67d492e1c683", file: "present", text: "", truncated: false }, parsed: { principles: many, notes: [] }, applicable: many, inapplicable: [], changed: false }) as never;
  const checkerBase = { pr: PR, snapshot, question: { id: "N1", type: "necessity", item: "", text: "Is it necessary?", origin: "required", key: "" } as Question, answer: { question: "N1", answer: "", status: "answered", none_found: false, citations: [], searches: [], inventory: [], metrics: [], proposal: { kind: "none" } } as never, designDocs: [], context: [], retry: false, reviewDir: DIR };

  it("keeps principle statements whole when the assignment fits, in N1's answerer and checker", () => {
    const many = Array.from({ length: 8 }, (_, i) => principle(i, 1_000));
    const answerer = planNecessity({ pr: PR, snapshot, view: { items: [], records: [] }, designDocs: [], context: [], kind: "first", feedback: [], principles: ctxOf(many), reviewDir: DIR });
    const checker = planNecessityChecker({ ...checkerBase, principles: ctxOf(many) });
    for (const text of [answerer.text, checker.text]) for (const p of many) expect(text).toContain(p.statement);
    expect(answerer.text).not.toContain("[shortened");
  });

  it("shortens statements only when it must, and gives every shortened one its full-text source", () => {
    const many = Array.from({ length: 40 }, (_, i) => principle(i, 1_000));
    const texts = [planNecessity({ pr: PR, snapshot, view: { items: [], records: [] }, designDocs: [], context: [], kind: "first", feedback: [], principles: ctxOf(many), reviewDir: DIR }).text, planNecessityChecker({ ...checkerBase, principles: ctxOf(many) }).text];
    for (const text of texts) {
      const lines = text.split("\n").filter((l) => /^\s*- p-\d+:/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l.length).toBeLessThan(1_000);
        expect(l).toContain("git show 13c5f4fb80df012a73c646a8e63a67d492e1c683:skills/design-principles/SKILL.md");
      }
    }
  });
});

describe("a review pass on a few areas of a pull request at the scale of #1445 fits the executor's bound", () => {
  // Round 1 raises nothing on this pull request's Q&A, so the same run goes on into the review layer over the areas the briefing
  // cites; their assignments carry the rule groups and the file list, none of which may push an assignment past the bound.
  const { scenario, headFiles } = hugeRehearsal({ ...BANYANDB, ...CONFIG });
  const total = HUGE_SCOPE_FILES;
  const path = hugePath(3, 1);
  const finding = { path, start_line: 2, end_line: 3, severity: "P1", content: "The function returns y times the module number, which is zero for a module that was never numbered." };
  const picked = {
    ...scenario,
    results: {
      ...scenario.results,
      [REVIEW_SCHEMA_NAME]: [passReply(total, [finding]), passReply(total, []), passReply(total, []), passReply(total, []), passReply(total, [])] as never,
      [VERIFY_SCHEMA_NAME]: [verifyReply([{ finding: "F1", verdict: "confirmed", witness: `${path}:3` }])] as never,
    },
  };

  it("runs round 1, the review and the draft, and publishes, and records the scope", async () => {
    const sim = await simulateYielding({ scenario: picked, config: CONFIG, files: headFiles, request: REHEARSAL_REQUEST.replace("Report on", "Review on"), through: "end", maxSteps: 3_000, budgets: { agentInvocations: 400, jobs: 2_000, decisions: 4_000, corrections: 40 } }, 10);
    expect(sim.final.action.type === "stop" ? sim.final.action.stop : sim.final.action, JSON.stringify(sim.final).slice(0, 500)).toMatchObject({ reason: "complete" });
    const scope = recordedScope(sim.evidence);
    expect(scope.state === "read" && [scope.value.source, scope.value.areas.length, scope.value.files.length]).toEqual(["default", 1, total]);
    const reviewJobs = sim.jobs.filter((j) => j.stageId === "review" && j.kind === "agent");
    expect(reviewJobs.length).toBeGreaterThanOrEqual(4);
    const sizes = reviewJobs.map((j) => assignmentOf(j).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    // Every file an assignment names was written by a command before the job.
    const written = new Set<string>();
    for (const j of sim.jobs) {
      const commands = (j.input as { commands?: EnvironmentCommand[] }).commands;
      if (j.kind === "command" && Array.isArray(commands)) for (const c of commands) {
        const w = writtenBy(c);
        if (w !== undefined) written.add(w);
        if (c.id === "report-write") for (const n of ["report.json", "review.md"]) written.add(`${WORKTREE}/.graphloom/review/${n}`);
        if (c.id === "qa-write") for (const n of ["qa.json", "review.md"]) written.add(`${WORKTREE}/.graphloom/review/${n}`);
      }
      if (j.kind === "agent" && j.stageId === "review") for (const f of pathsOf(assignmentOf(j))) expect(written.has(f), `${f} is named by a review job before any command wrote it`).toBe(true);
    }
  }, 900_000);
});
