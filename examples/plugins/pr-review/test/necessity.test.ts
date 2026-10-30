// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { checkAssignmentFidelity, type EvidenceRecord } from "@graphloom/sdk";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProfile } from "../src/profile.js";
import { requestedPull } from "../src/request.js";
import { REHEARSAL_HEAD_FILES, REHEARSAL_REQUEST, rehearsal } from "../src/rehearsal.js";
import { defaultNecessity } from "../src/rehearsal-qa.js";
import { STREAM_PATH, STREAM_WRITE_BASE_GO, STREAM_WRITE_GO, WRITE_PATH_DOC } from "../src/rehearsal-fixtures.js";
import { admissibleDecision, effectiveConclusion, necessityAnswer, necessityDecision, necessityJson, necessityProblems, type Necessity } from "../src/necessity.js";
import { necessityRecordCommand } from "../src/qaflow.js";
import { validatorById } from "../src/validators.js";
import { assignmentOf, BANYANDB, candidateEvidence, scenarioWith, simulate, type Simulation } from "./support.js";

interface QaFile {
  questions: Array<{ id: string; type: string; text: string; answer?: { status: string; answer: string; check: { verdict: string; note: string }; history: unknown[]; necessity?: Necessity } }>;
  necessity?: { conclusion: string; skipped: boolean; note?: string; decision: { action: string; reason: string; override?: boolean } };
  purposes: unknown[];
}
const qaOf = (s: Simulation): QaFile => JSON.parse(s.qa!.json) as QaFile;
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const qaJobs = (s: Simulation) => s.jobs.filter((j) => j.stageId === "questions" || j.stageId === "answers");
const agents = (s: Simulation): string[] => qaJobs(s).flatMap((j) => (j.kind === "agent" ? [j.resultSchema!] : []));
const askAll = REHEARSAL_REQUEST.replace(/\.$/, ", asking every question.");
const pinned = [{ source: "title" as const, text: "Parse retention durations" }, { source: "body" as const, text: "A write batch whose events all fail used to be acknowledged as a success." }];

const base = (over: Partial<Necessity> = {}): Necessity => ({ ...defaultNecessity("Parse retention durations"), ...over });
const unnecessaryByDesign = (): Necessity =>
  base({
    conclusion: "unnecessary",
    design: { statements: [{ path: "docs/concept/tsdb.md", tree: "base", start: 172, end: 172, quote: "background worker" }], changed: [{ path: "a.go", tree: "head", start: 3, end: 4, quote: "x" }], effect: "breaks", explanation: "it waits on the flush", searches: [{ pattern: "flush", scope: "base", hits: 2 }] },
  });

describe("the necessity answer's deterministic rules (design 7.5)", () => {
  it("accepts a necessary answer with a stated problem, a trace, and no broken design statement", () => {
    expect(necessityProblems(base(), pinned)).toEqual([]);
  });

  it("requires every quoted problem to be in the pull request's own text, as a stated purpose must be", () => {
    const n = base({ problem: { ...base().problem, quotes: [{ source: "body", quote: "the failure is invented here by the answerer" }] } });
    expect(necessityProblems(n, pinned).join(" ")).toMatch(/problem quote 1: the quote is not in the pull request's body/);
  });

  it("needs a trace through the base whenever it says the failure can or cannot happen, and only base citations in it", () => {
    const none = base({ problem: { ...base().problem, trace: [] } });
    expect(necessityProblems(none, pinned).join(" ")).toMatch(/needs a trace through the base code/);
    const head = base({ problem: { ...base().problem, trace: [{ ...base().problem.trace[0]!, tree: "head" }] } });
    expect(necessityProblems(head, pinned).join(" ")).toMatch(/the tree is head; it must be base/);
    expect(necessityProblems(base({ conclusion: "questionable", problem: { ...base().problem, canHappen: "unclear", trace: [] } }), pinned)).toEqual([]);
  });

  it("lets unnecessary stand only on a ground it cites: the failure cannot happen, a design statement is broken, or an existing way", () => {
    expect(necessityProblems(unnecessaryByDesign(), pinned)).toEqual([]);
    const noGround = base({ conclusion: "unnecessary" });
    expect(necessityProblems(noGround, pinned).join(" ")).toMatch(/"unnecessary" rests on a ground with evidence/);
    const cannot = base({ conclusion: "unnecessary", problem: { ...base().problem, canHappen: "no" } });
    expect(necessityProblems(cannot, pinned)).toEqual([]);
    const existing = base({ conclusion: "unnecessary", alternatives: { exists: true, explanation: "the liaison does it", citations: [{ path: "banyand/liaison/x.go", tree: "base", start: 1, end: 2, quote: "x" }] } });
    expect(necessityProblems(existing, pinned)).toEqual([]);
  });

  it("refuses a design verdict without the statement and the changed lines, and a conclusion without a stated problem", () => {
    const bare = base({ design: { ...base().design, effect: "breaks" } });
    expect(necessityProblems(bare, pinned).join(" ")).toMatch(/"breaks" cites the design statement and the changed lines/);
    const unstated = base({ problem: { ...base().problem, quotes: [] } });
    expect(necessityProblems(unstated, pinned).join(" ")).toMatch(/states no problem to judge, so the conclusion is "questionable" or "needs author"/);
    expect(necessityProblems({ ...unstated, conclusion: "needs author" }, pinned)).toEqual([]);
    expect(necessityProblems(base({ design: { ...base().design, searches: [] } }), pinned).join(" ")).toMatch(/list the searches of the design and architecture documents/);
  });

  it("makes necessary need a possible failure, no broken design statement and no existing way", () => {
    expect(necessityProblems(base({ problem: { ...base().problem, canHappen: "unclear" } }), pinned).join(" ")).toMatch(/"necessary" needs the failure shown possible/);
    expect(necessityProblems({ ...unnecessaryByDesign(), conclusion: "necessary" }, pinned).join(" ")).toMatch(/"necessary" needs/);
  });

  it("turns into an ordinary answer: the trace, the design statements, the changed lines and the alternatives are its citations", () => {
    const a = necessityAnswer(unnecessaryByDesign());
    expect(a).toMatchObject({ question: "N1", status: "answered", none_found: false });
    expect(a.citations.map((c) => `${c.tree}:${c.path}`)).toEqual(["base:pkg/timestamp/duration.go", "base:docs/concept/tsdb.md", "head:a.go"]);
    expect(a.searches.map((s) => s.pattern)).toEqual(["flush", "callers of the touched code"]);
  });
});

describe("what N1's checked answer decides", () => {
  const final = (conclusion: Necessity["conclusion"], verdict: string) => ({ ...necessityAnswer(base({ conclusion })), check: { verdict, note: "", searches: [] }, history: [] }) as never;

  it("skips the other questions only for an unnecessary conclusion the checker supports", () => {
    expect(necessityDecision(final("unnecessary", "supported"), false)).toMatchObject({ action: "skip" });
    for (const [conclusion, verdict] of [["unnecessary", "partial"], ["unnecessary", "downgraded"], ["questionable", "supported"], ["necessary", "supported"], ["needs author", "supported"]] as const) {
      expect(necessityDecision(final(conclusion, verdict), false), `${conclusion} ${verdict}`).toMatchObject({ action: "ask-all" });
    }
  });

  it("makes a conclusion the checker still refuses after one correction questionable", () => {
    expect(effectiveConclusion(final("unnecessary", "downgraded"))).toBe("questionable");
    expect(effectiveConclusion(final("needs author", "downgraded"))).toBe("needs author");
    expect(effectiveConclusion(final("necessary", "supported"))).toBe("necessary");
  });

  it("lets the operator ask everything anyway, and records that the skip was overridden", () => {
    const d = necessityDecision(final("unnecessary", "supported"), true);
    expect(d).toMatchObject({ action: "ask-all", override: true });
    expect(admissibleDecision(final("unnecessary", "supported"), d)).toBe(true);
    expect(admissibleDecision(final("unnecessary", "supported"), { action: "skip", reason: "x" })).toBe(false);
    // An override of a decision that never skipped is not a decision the rule allows.
    expect(admissibleDecision(final("necessary", "supported"), { action: "ask-all", reason: "x", override: true })).toBe(false);
  });
});

describe("necessity-unnecessary: a #1443-like change that breaks the write path design", () => {
  const sim = simulate({ scenarioName: "necessity-unnecessary" });
  const qa = qaOf(sim);

  it("stops report ready with every receipt valid, asking no question and giving no answer but N1's", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "report ready", retryable: false });
    expect(sim.receipts.filter((r) => r.valid)).toHaveLength(9);
    expect(agents(sim)).toEqual(["necessity-v1", "answer-check-v1"]);
    expect(qa.questions.map((q) => q.id)).toEqual(["N1"]);
    expect(qa.purposes).toEqual([]);
  });

  it("records N1 with its conclusion, the checker's support, and the skip", () => {
    expect(qa.necessity).toMatchObject({ conclusion: "unnecessary", skipped: true, note: "Remaining questions skipped: the change was judged unnecessary (see N1).", decision: { action: "skip" } });
    expect(qa.questions[0]!.answer).toMatchObject({ status: "answered", check: { verdict: "supported" } });
  });

  it("renders N1 at the top of review.md, before the Report, then Report, Measurements and the skip note", () => {
    const md = sim.qa!.markdown;
    expect(md.indexOf("# Necessity")).toBeGreaterThan(0);
    expect(md.indexOf("# Necessity")).toBeLessThan(md.indexOf("# Report"));
    expect(md.indexOf("# Report")).toBeLessThan(md.indexOf("# Measurements"));
    expect(md.indexOf("# Measurements")).toBeLessThan(md.indexOf("# Q&A"));
    expect(md).toContain("Contents: Necessity · Report · Measurements · Q&A");
    expect(md).toContain("**N1 — Is this change necessary?** Conclusion: **unnecessary**.");
    expect(md).toContain("## 1. Is the problem real on the base?");
    expect(md).toContain("## 2. Does the fix fit the system's design?");
    expect(md).toContain("## 3. Is there a simpler or existing way?");
    expect(md).toContain("Effect: **breaks**.");
    expect(md).toContain(`\`${WRITE_PATH_DOC.path}:${WRITE_PATH_DOC.line}\` "${WRITE_PATH_DOC.quote}"`);
    expect(md.trimEnd().endsWith("Remaining questions skipped: the change was judged unnecessary (see N1).")).toBe(true);
    expect(md).not.toMatch(/\*\*Q\d+ \[/);
  });

  it("cites a design statement the fixture's document has, and changed lines and a trace its files have", () => {
    const n = qa.questions[0]!.answer!.necessity!;
    expect(WRITE_PATH_DOC.text).toContain(n.design.statements[0]!.quote);
    const head = STREAM_WRITE_GO.split("\n");
    const baseLines = STREAM_WRITE_BASE_GO.split("\n");
    for (const c of n.design.changed) expect(head.slice(c.start - 1, c.end).join("\n")).toContain(c.quote);
    for (const t of n.problem.trace) expect(baseLines.slice(t.start - 1, t.end).join("\n")).toContain(t.quote.replace(/\\"/g, '"'));
    expect(n.design.changed[0]!.path).toBe(STREAM_PATH);
  });

  it("verifies N1's citations in the trees they name, apart from the other answers' commands", () => {
    const ids = qaJobs(sim).flatMap((j) => ((j.input as { commands?: Array<{ id: string }> } | undefined)?.commands ?? []).map((c) => c.id));
    expect(ids).toContain("cite-n-1");
    expect(ids).not.toContain("cite-1");
    expect(ids.filter((id) => id === "necessity-write")).toHaveLength(1);
  });

  it("gives the checker N1's trace steps, design statements and changed lines to verify, on a harness other than the answerer's", () => {
    const [answerer, checker] = qaJobs(sim).filter((j) => j.kind === "agent");
    expect([answerer!, checker!].map((j) => (j.input as { harness: string }).harness)).toEqual(["claude-code", "codex"]);
    expect(checker).toMatchObject({ purpose: "review", readOnly: true, resultSchema: "answer-check-v1" });
    const text = assignmentOf(checker!);
    expect(text).toMatch(/T1 trace step/);
    expect(text).toMatch(/D1 design statement/);
    expect(text).toMatch(/C1 changed lines/);
    expect(text).toContain("the conclusion: does the evidence support it");
  });

  it("hands the answerer the profile's design documents and the three parts to answer, and no reproduction mechanism to rely on", () => {
    const text = assignmentOf(qaJobs(sim).find((j) => j.resultSchema === "necessity-v1")!);
    for (const glob of parseProfile(BANYANDB).questions.designDocs) expect(text).toContain(glob);
    expect(text).toContain("Part 1, the problem");
    expect(text).toContain("Part 2, the design");
    expect(text).toContain("Part 3, a simpler or existing way");
    expect(text).toContain("no reproduction mechanism in this version");
  });

  it("passes the validators, each on the evidence its stage is judged on", () => {
    const evaluate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
    const atQuestions = sim.evidence.slice(0, sim.evidence.findIndex((e) => (e.payload as { producer?: { stageId: string } }).producer?.stageId === "answers"));
    const r = evaluate("questions-complete", atQuestions);
    expect(r).toMatchObject({ status: "passed" });
    expect(r.reason).toContain("no other question is required: only N1");
    expect(evaluate("answers-complete", sim.evidence)).toMatchObject({ status: "passed" });
    expect(evaluate("answers-grounded", sim.evidence)).toMatchObject({ status: "passed" });
  });

  it("rejects a skip the recorded answer does not allow (a forged decision), and a record that is not N1's checked answer", () => {
    const evaluate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
    const disputed = simulate({ scenarioName: "necessity-disputed" });
    // The disputed run's N1 (questionable) forged into a skip.
    const forged = disputed.evidence.map((e) => {
      const c = (e.payload as { command?: { id: string; argv: string[] } }).command;
      if (c?.id !== "necessity-write") return e;
      const text = JSON.parse(c.argv.slice(5, 5 + Number(c.argv[4])).join("")) as { decision: { action: string; reason: string } };
      text.decision = { action: "skip", reason: "forged" };
      const cmd = necessityRecordCommand({ final: (text as unknown as { answer: never }).answer, decision: text.decision as never })!;
      return { ...e, payload: { ...(e.payload as object), command: { ...c, argv: cmd.argv } } } as EvidenceRecord;
    });
    const atQuestions = forged.slice(0, forged.findIndex((e) => (e.payload as { producer?: { stageId: string } }).producer?.stageId === "answers"));
    expect(evaluate("questions-complete", atQuestions)).toMatchObject({ status: "failed", reason: expect.stringMatching(/decides skip, which N1's conclusion \(questionable\)/) });
    expect(evaluate("answers-complete", forged)).toMatchObject({ status: "failed" });
    // A record whose answer is not the one the evidence recomputes.
    const wrong = sim.evidence.map((e) => {
      const c = (e.payload as { command?: { id: string; argv: string[] } }).command;
      if (c?.id !== "necessity-write") return e;
      const text = JSON.parse(c.argv.slice(5, 5 + Number(c.argv[4])).join("")) as { answer: { necessity: { rationale: string } } };
      text.answer.necessity.rationale = "something else";
      const cmd = necessityRecordCommand({ final: text.answer as never, decision: { action: "skip", reason: "N1 concluded unnecessary and the answer checker supports it" } })!;
      return { ...e, payload: { ...(e.payload as object), command: { ...c, argv: cmd.argv } } } as EvidenceRecord;
    });
    const atQ = wrong.slice(0, wrong.findIndex((e) => (e.payload as { producer?: { stageId: string } }).producer?.stageId === "answers"));
    expect(evaluate("questions-complete", atQ)).toMatchObject({ status: "failed", reason: expect.stringMatching(/not N1's checked answer/) });
  });
});

describe("necessity-disputed: the checker refutes the unnecessary conclusion twice", () => {
  const sim = simulate({ scenarioName: "necessity-disputed" });
  const qa = qaOf(sim);

  it("asks the answerer for one correction, checks again, and then asks every question", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(agents(sim)).toEqual(["necessity-v1", "answer-check-v1", "necessity-revision-v1", "answer-check-v1", "questions-v1", "answers-v1", "answer-check-v1"]);
    const revision = qaJobs(sim).find((j) => j.resultSchema === "necessity-revision-v1")!;
    expect(revision.continueFrom).toBeDefined();
    expect(assignmentOf(revision)).toContain("the answer checker found it unsupported");
    expect(qa.questions.length).toBeGreaterThan(1);
    expect(qa.questions[0]!.id).toBe("N1");
  });

  it("downgrades N1 to questionable, with both statements recorded, and never skips", () => {
    expect(qa.necessity).toMatchObject({ conclusion: "questionable", skipped: false, decision: { action: "ask-all" } });
    expect(qa.necessity!.decision.reason).toContain("stayed unsupported after one correction");
    expect(qa.questions[0]!.answer).toMatchObject({ status: "needs author", check: { verdict: "downgraded" } });
    expect(qa.questions[0]!.answer!.history).toHaveLength(2);
    const md = sim.qa!.markdown;
    expect(md).toContain("Conclusion: **questionable**.");
    expect(md).toContain("The answerer concluded unnecessary; its evidence did not hold after one correction, so the conclusion is questionable.");
    expect(md).not.toContain("Remaining questions skipped");
    expect(md).toMatch(/\*\*Q1 \[/);
  });

  it("does not pass the other answers' check for N1: the answers' checker is asked about the questions after N1 only", () => {
    const checker = qaJobs(sim).filter((j) => j.resultSchema === "answer-check-v1").at(-1)!;
    expect(assignmentOf(checker)).not.toContain("N1 [necessity]");
  });
});

describe("necessity-necessary: the normal flow", () => {
  const sim = simulate({ scenarioName: "necessity-necessary" });

  it("asks N1 first, then every other question, and does not skip", () => {
    expect(agents(sim)).toEqual(["necessity-v1", "answer-check-v1", "questions-v1", "answers-v1", "answer-check-v1"]);
    const qa = qaOf(sim);
    expect(qa.questions[0]).toMatchObject({ id: "N1", type: "necessity" });
    expect(qa.questions.slice(1).every((q) => q.id.startsWith("Q"))).toBe(true);
    expect(qa.necessity).toMatchObject({ conclusion: "necessary", skipped: false, decision: { action: "ask-all" } });
    expect(sim.qa!.markdown).toContain("N1 (necessity) is answered above, under Necessity: necessary;");
  });
});

describe("every scenario asks N1 first", () => {
  for (const name of Object.keys(rehearsal(BANYANDB).scenarios)) {
    it(name, () => {
      const sim = simulate({ scenarioName: name });
      const order = qaJobs(sim).flatMap((j) => (j.kind === "agent" ? [j.resultSchema!] : []));
      expect(order[0]).toBe("necessity-v1");
      expect(order.indexOf("necessity-v1")).toBeLessThan(order.indexOf("questions-v1") < 0 ? Infinity : order.indexOf("questions-v1"));
      expect(qaOf(sim).questions[0]).toMatchObject({ id: "N1", type: "necessity" });
    });
  }

  it("keeps the assignments in step with the fields the stand-in agents reply with", () => {
    for (const name of ["necessity-unnecessary", "necessity-disputed"]) {
      const sim = simulate({ scenarioName: name });
      const scenario = rehearsal(BANYANDB).scenarios[name]!;
      for (const job of sim.jobs.filter((j) => j.kind === "agent" && (j.resultSchema === "necessity-v1" || j.resultSchema === "necessity-revision-v1"))) {
        for (const reply of scenario.results[job.resultSchema!]!) expect(checkAssignmentFidelity(assignmentOf(job), reply.output), name).toEqual([]);
      }
    }
  });
});

describe("the operator override: task new --all-questions asks every question anyway", () => {
  const sim = simulate({ scenarioName: "necessity-unnecessary", request: askAll });

  it("parses the request and carries the flag, and refuses nothing else", () => {
    expect(requestedPull(askAll, { project: "apache/skywalking-banyandb" })).toMatchObject({ mode: "report", number: 7, askAll: true });
    expect(requestedPull(REHEARSAL_REQUEST, { project: "apache/skywalking-banyandb" })).not.toHaveProperty("askAll");
    expect(requestedPull(`${REHEARSAL_REQUEST.slice(0, -1)}, and then some.`, { project: "apache/skywalking-banyandb" })).toHaveProperty("problem");
  });

  it("asks every question even though N1 is unnecessary and supported, and records the override", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(agents(sim)).toEqual(["necessity-v1", "answer-check-v1", "questions-v1", "answers-v1", "answer-check-v1"]);
    const qa = qaOf(sim);
    expect(qa.necessity).toMatchObject({ conclusion: "unnecessary", skipped: false, decision: { action: "ask-all", override: true } });
    expect(qa.questions.length).toBeGreaterThan(1);
    expect(sim.qa!.markdown).toContain("Override: the operator asked for every question, so none was skipped.");
    expect(sim.qa!.markdown).not.toContain("Remaining questions skipped");
  });

  it("is accepted by the validators on that evidence", () => {
    const evaluate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config: BANYANDB });
    const atQuestions = sim.evidence.slice(0, sim.evidence.findIndex((e) => (e.payload as { producer?: { stageId: string } }).producer?.stageId === "answers"));
    expect(evaluate("questions-complete", atQuestions)).toMatchObject({ status: "passed" });
    expect(evaluate("answers-complete", sim.evidence)).toMatchObject({ status: "passed" });
  });
});

describe("a citation of N1 that names no file is corrected, then handed to the supervisor", () => {
  it("sends N1 back with the citation, and stops for the supervisor after two corrections", () => {
    const scenario = scenarioWith("necessity-unnecessary", (s) => {
      s.commands!["cite-n-1"] = { exitCode: 0, stdout: "1 ok\n2 missing\n3 ok\n4 ok\nchecked 4\n" };
    });
    const sim = simulate({ scenario });
    const answerers = qaJobs(sim).filter((j) => j.resultSchema === "necessity-v1");
    expect(answerers.length).toBeGreaterThan(1);
    expect(assignmentOf(answerers[1]!)).toMatch(/N1: citation base:banyand\/stream\/write_standalone\.go:\d+-\d+ names no such file in that tree/);
    expect(sim.final.action.type).toBe("supervise");
  });
});

describe("the design-document globs", () => {
  it("are a profile field of the questions group, listed for the answerer and the checker", () => {
    const profile = parseProfile(BANYANDB);
    expect(profile.questions.designDocs).toContain("docs/concept/tsdb.md");
    expect(profile.questions.designDocs.length).toBeGreaterThanOrEqual(5);
    expect(parseProfile({ ...BANYANDB, questions: { designDocs: ["docs/design/**"] } }).questions.designDocs).toEqual(["docs/design/**"]);
    expect(parseProfile({ ...BANYANDB, questions: {} }).questions.designDocs).toEqual([]);
    expect(() => parseProfile({ ...BANYANDB, questions: { designDocs: ["/etc/passwd"] } })).toThrow(/repository-relative/);
    expect(() => parseProfile({ ...BANYANDB, questions: { designDocs: ["../x"] } })).toThrow(/repository-relative/);
    expect(() => parseProfile({ ...BANYANDB, questions: { designDocs: "docs" } })).toThrow(/list of repository-relative globs/);
  });

  it("name real BanyanDB documents when a checkout of the repository is at hand", () => {
    const repo = "/mnt/d/skywalking-banyandb";
    if (!existsSync(repo)) return;
    for (const doc of parseProfile(BANYANDB).questions.designDocs) expect(existsSync(`${repo}/${doc}`), doc).toBe(true);
  });

  it("ships the three necessity scenarios beside the others", () => {
    expect(Object.keys(rehearsal(BANYANDB).scenarios)).toEqual(expect.arrayContaining(["necessity-unnecessary", "necessity-disputed", "necessity-necessary"]));
    expect(REHEARSAL_HEAD_FILES[STREAM_PATH]).toBeDefined();
  });

  it("does not make a questioner able to add or drop N1", () => {
    const sim = simulate({ scenarioName: "necessity-necessary" });
    const questioner = qaJobs(sim).find((j) => j.resultSchema === "questions-v1")!;
    expect(assignmentOf(questioner)).not.toContain('type necessity');
    expect(necessityJson({ final: { ...necessityAnswer(base()), check: { verdict: "supported", note: "", searches: [] }, history: [] } as never, decision: { action: "ask-all", reason: "x" } })).toContain('"schema":"pr-necessity-v1"');
  });
});
