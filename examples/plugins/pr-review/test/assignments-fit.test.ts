// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EnvironmentCommand, JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { assignmentProblem, ASSIGNMENT_BUDGET_CHARS, ASSIGNMENT_MARGIN_CHARS, fitLines, MAX_ASSIGNMENT_CHARS, shrinkToFit } from "../src/fit.js";
import { diagramSpecs, MAX_DIAGRAM_DATA_CHARS } from "../src/diagrams.js";
import type { Fact } from "../src/detectors.js";
import type { ClaimTarget } from "../src/claims.js";
import { planChecker, planReporter, pullText } from "../src/prompts.js";
import { planAnswerer, planNecessityChecker } from "../src/qaprompts.js";
import { reporterSections } from "../src/template.js";
import type { Question } from "../src/questions.js";
import type { Groundwork } from "../src/groundwork.js";

import { hugeRehearsal } from "../src/rehearsal.js";
import { HUGE_AREAS, HUGE_LIMITS, hugeSymbolNames } from "../src/rehearsal-huge.js";
import { BANYANDB, assignmentOf, profileOf, simulate, type Simulation } from "./support.js";

const CONFIG = { limits: HUGE_LIMITS };

/** The run's agent jobs, with what each was for. */
const agentJobs = (sim: Simulation): JobSpec[] => sim.jobs.filter((j) => j.kind === "agent");
const WORKTREE = "/work/tree";
const pathsOf = (assignment: string): string[] => [...new Set([...assignment.matchAll(/\/work\/tree\/\.graphloom\/review\/[A-Za-z0-9_./-]+/g)].map((m) => m[0].replace(/[.,;:)]+$/, "")))].filter((p) => !p.includes("/base"));
/** The files a command writes, by the paths its part argv names. */
const writtenBy = (c: EnvironmentCommand): string | undefined => (/-p\d+$/.test(c.id) ? `${WORKTREE}/${c.argv[4]}` : undefined);

describe("every agent assignment fits the executor's bound on a pull request at the scale of #1445", () => {
  const { scenario, headFiles } = hugeRehearsal({ ...BANYANDB, ...CONFIG });
  const sim = simulate({ scenario, config: CONFIG, files: headFiles, maxSteps: 2_500, budgets: { agentInvocations: 400, jobs: 2_000, decisions: 4_000, corrections: 40 } });

  it("is a pull request of that size", () => {
    expect(Object.keys(headFiles).length).toBeGreaterThanOrEqual(200);
    expect(hugeSymbolNames().length).toBeGreaterThanOrEqual(800);
    expect(HUGE_AREAS).toBeGreaterThanOrEqual(24);
  });

  it("runs through Report, N1, Questions and Answers", () => {
    expect(sim.final.action.type === "stop" ? sim.final.action.stop : sim.final.action).toMatchObject({ reason: "report ready" });
    const schemas = new Set(agentJobs(sim).map((j) => j.resultSchema));
    for (const s of ["change-report-v1", "claim-check-v1", "diagrams-v1", "necessity-v1", "questions-v1", "answers-v1", "answer-check-v1"]) expect(schemas.has(s)).toBe(true);
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
    for (const stem of ["review.md", "report.json", "groundwork-", "claims-", "required-questions-", "answers-"]) expect(names.some((n) => n.startsWith(stem)), `no job names a ${stem} file`).toBe(true);
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
    const questions: Question[] = Array.from({ length: 900 }, (_, i) => ({ id: `Q${i + 1}`, type: "existing-equivalent", item: "R1", text: `Is there an equivalent of function number ${i + 1} that the base already has?`, origin: "required", key: `k${i}` }));
    const groundwork = { symbols: [], searches: new Map(), candidates: [], prSimilar: [], inventory: { dependencies: [], packages: [], truncated: [] }, testMap: new Map(), notes: [] } as unknown as Groundwork;
    const plan = planAnswerer({ pr: PR, snapshot: pull, view: { items: [], records: [] }, groundwork, questions, kind: "first", feedback: [], mountedDirs: [], reviewDir: DIR });
    expect(plan.text.length).toBeLessThanOrEqual(ASSIGNMENT_BUDGET_CHARS);
    const spill = plan.spills.find((x) => x.name.startsWith("questions-"))!;
    expect(plan.text).toContain(`${DIR}/${spill.name}`);
    expect(spill.text).toContain("Q900 [existing-equivalent]");
    expect(plan.text).toContain("Questions (900):");
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
