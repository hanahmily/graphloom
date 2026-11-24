// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, GraphDecision, JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { attemptEvidence, noteAttempt, readAttempts, type AttemptState } from "../src/kit/attempt.js";
import { advancePullRequest } from "../src/graph.js";
import { REVIEW_SCHEMA_NAME } from "../src/review.js";
import { analyze, evidencePull, reportFlowOf } from "../src/kit/analysis.js";
import { diagramsOf, measurementsOf, outputsOf } from "../src/validators.js";
import { REVIEWED, assignmentOf, candidateEvidence, profileOf, scenarioWith, simulate, viewOf, type Reentry, type Simulation } from "./support.js";

/** The correctness reviewer's first pass of the review-layer scenario with one comment on a file outside the review's scope, which the deterministic rules refuse. */
const PROBLEM = /is not a file in the review's scope/;

/** A scenario whose correctness reviewer gives an unusable first pass `times` times in a row, then a usable one. */
const overBound = (times: number) =>
  scenarioWith("review-layer", (sc) => {
    const passes = sc.results[REVIEW_SCHEMA_NAME]!;
    const good = passes[0]!.output as { comments: Array<Record<string, unknown>> };
    const bad = { ...good, comments: [...good.comments, { ...good.comments[0]!, path: "outside/scope.go" }] };
    sc.results[REVIEW_SCHEMA_NAME] = [...Array.from({ length: times }, () => ({ output: bad })), ...passes];
  });

const kindOf = (d: GraphDecision): string => d.action.type;
const jobOf = (d: GraphDecision): JobSpec => (d.action.type === "dispatch" ? d.action.job : (undefined as never));
const answerers = (sim: Simulation) => sim.jobs.filter((j) => j.instruction === "Review the correctness aspect (pass 1)");
const firstSupervise = (sim: Simulation): number => sim.decisions.findIndex((d) => d.action.type === "supervise");

describe("the review stage reentered after the correctness reviewer kept failing its rules", () => {
  it("escalates after the answerer's two corrections, as the live run did", () => {
    const sim = simulate({ through: "review", scenario: overBound(3) });
    expect(sim.final.action.type).toBe("supervise");
    expect(sim.final.action.type === "supervise" ? sim.final.action.supervise.reason : "").toMatch(PROBLEM);
    expect(answerers(sim)).toHaveLength(3);
  });

  it("starts a fresh reviewer in the new attempt, with no corrections spent, and accepts a compliant answer", () => {
    const sim = simulate({ through: "review", scenario: overBound(3), reentries: [{ stageId: "review" }], maxSteps: 400 });
    const at = firstSupervise(sim);
    expect(at).toBeGreaterThan(0);
    // The next proposal is the stage's own reviewer, in a fresh session, not another escalation of the same problem.
    const next = sim.decisions[at + 1]!;
    expect(kindOf(next)).toBe("dispatch");
    const job = jobOf(next);
    expect(job.resultSchema).toBe(REVIEW_SCHEMA_NAME);
    expect(job.continueFrom).toBeUndefined();
    expect(assignmentOf(job)).not.toMatch(PROBLEM);
    // Three passes before the reentry, one after: a compliant one, which passes.
    expect(answerers(sim)).toHaveLength(4);
    expect(sim.final).toMatchObject({ action: { stop: { reason: REVIEWED } } });
    expect(sim.decisions.filter((d) => d.action.type === "supervise")).toHaveLength(1);
  });

  it("counts corrections per attempt: a second attempt that fails again gets its own two corrections", () => {
    const sim = simulate({ through: "review", scenario: overBound(6), reentries: [{ stageId: "review" }], maxSteps: 400 });
    expect(sim.final.action.type).toBe("supervise");
    expect(answerers(sim)).toHaveLength(6);
    const corrections = answerers(sim).slice(3).map((j) => PROBLEM.test(assignmentOf(j)));
    expect(corrections).toEqual([false, true, true]);
    // A correction goes back to the same session; the attempt's first pass starts a fresh one.
    expect(answerers(sim).slice(3).map((j) => j.continueFrom !== undefined)).toEqual([false, true, true]);
  });

  it("keeps a repeated reentry converging", () => {
    const sim = simulate({ through: "review", scenario: overBound(6), reentries: [{ stageId: "review" }, { stageId: "review" }], maxSteps: 400 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: REVIEWED } } });
    expect(answerers(sim)).toHaveLength(7);
  });
});

describe("a reentry back to fetch after a repair changed the candidate", () => {
  // As a live run would go: the review stage is reentered and fails again, then the supervisor, whose repair wrote into the worktree, sends the run back to fetch.
  const sim = simulate({ through: "review", scenario: overBound(6), reentries: [{ stageId: "review" }, { stageId: "fetch", changesCandidate: true }], maxSteps: 800 });
  const supervises = sim.decisions.flatMap((d, i) => (d.action.type === "supervise" ? [i] : []));

  it("has the graph run fetch's own jobs again instead of escalating", () => {
    expect(supervises).toHaveLength(2);
    const next = sim.decisions[supervises[1]! + 1]!;
    expect(kindOf(next)).toBe("dispatch");
    expect(jobOf(next)).toMatchObject({ stageId: "fetch", purpose: "work", writeScope: ["."] });
    expect(sim.final).toMatchObject({ action: { stop: { reason: REVIEWED } } });
  });

  it("checks the head out again and reads the pull request again, from evidence the validators accept", () => {
    expect(sim.jobs.filter((j) => j.stageId === "fetch" && j.purpose === "work")).toHaveLength(2);
    const reads = sim.jobs.filter((j) => j.stageId === "fetch" && j.kind === "command" && j.executor !== undefined);
    expect(reads.length).toBeGreaterThanOrEqual(2 * 7);
    for (const stage of ["fetch", "report", "review"]) {
      expect(sim.receipts.filter((r) => r.stageId === stage && r.valid).length).toBeGreaterThan(0);
    }
  });

  it("runs the report stage's own agents again, and then the reviewer once more", () => {
    expect(sim.jobs.filter((j) => j.resultSchema === "change-report-v1")).toHaveLength(2);
    expect(sim.jobs.filter((j) => j.resultSchema === "claim-check-v1")).toHaveLength(2);
    expect(answerers(sim)).toHaveLength(7);
  });
});

describe("a reentry to fetch that left the candidate unchanged", () => {
  // The Review stage's reviewer passes are the latest review evidence of the candidate, so the report's validators no longer see the
  // claim checks; the graph's record of them puts them back, and the Report stage is accepted again without a second report.
  it("reuses what the candidate already earned: no second checkout, no second report or claim check, and Report is accepted again", () => {
    const sim = simulate({ through: "review", scenario: overBound(3), reentries: [{ stageId: "fetch" }, { stageId: "review" }], maxSteps: 800 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: REVIEWED } } });
    expect(sim.jobs.filter((j) => j.stageId === "fetch" && j.purpose === "work")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "change-report-v1")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "claim-check-v1")).toHaveLength(1);
    expect(sim.receipts.filter((r) => r.stageId === "report" && r.valid).map((r) => r.requirementId).sort()).toEqual(["change-report", "claims-checked", "measurements", "review-context"]);
  });
});

describe("the attempt scoping of evidence", () => {
  const agent = (ref: string, stage: string, generation: number, digest = "d1", schema = "necessity-v1"): EvidenceRecord => ({
    ref,
    kind: "other",
    generation,
    candidateDigest: digest,
    resultSchema: schema,
    payload: { producer: { operationId: ref, stageId: stage, purpose: "diagnostic", readOnly: true, kind: "agent" } },
  });
  const command = (ref: string, generation: number, digest = "d1"): EvidenceRecord => ({ ref, kind: "command", generation, candidateDigest: digest, payload: { command: { id: ref, argv: [], exitCode: 0, stdoutTail: "", stderrTail: "" } } });
  const environment = (ref: string): EvidenceRecord => ({ ref, kind: "command", generation: 1, candidateDigest: "d0", payload: { environment: { check: ref }, command: { id: ref, argv: [], exitCode: 0, stdoutTail: "", stderrTail: "" } } });
  const refs = (list: EvidenceRecord[]): string[] => list.map((e) => e.ref);
  const state = (stages: AttemptState["stages"]): AttemptState => ({ v: 1, stages });

  it("notes the first attempt of a stage as predating nothing, and a later one at the generation that first saw it", () => {
    const first = noteAttempt(readAttempts(undefined), { current: { stageId: "questions", attempt: 1 }, generation: 3 });
    expect(first.stages.questions).toEqual({ attempt: 1, generation: 0 });
    const again = noteAttempt(first, { current: { stageId: "questions", attempt: 1 }, generation: 5 });
    expect(again).toBe(first);
    const reentered = noteAttempt(first, { current: { stageId: "questions", attempt: 2 }, generation: 5 });
    expect(reentered.stages.questions).toEqual({ attempt: 2, generation: 5 });
    // A resume keeps the attempt, so it keeps where the attempt began.
    expect(noteAttempt(reentered, { current: { stageId: "questions", attempt: 2 }, generation: 9 }).stages.questions).toEqual({ attempt: 2, generation: 5 });
    // A run whose saved state was discarded sees a later attempt for the first time: it began now.
    expect(noteAttempt(readAttempts(undefined), { current: { stageId: "report", attempt: 3 }, generation: 7 }).stages.report).toEqual({ attempt: 3, generation: 7 });
  });

  it("reads back what it saved, and nothing from an older or damaged state", () => {
    const saved = state({ questions: { attempt: 2, generation: 4 } });
    expect(readAttempts(JSON.stringify(saved))).toEqual(saved);
    expect(readAttempts('{"v":1}')).toEqual(state({}));
    expect(readAttempts("not json")).toEqual(state({}));
    expect(readAttempts(JSON.stringify({ v: 1, stages: { a: { attempt: "x", generation: 1 } } }))).toEqual(state({}));
  });

  it("drops a stage's agent results that predate its attempt, and keeps its commands and every other stage's results", () => {
    const evidence = [agent("old", "questions", 1), command("cmd", 1), agent("same", "questions", 3), agent("other", "report", 1), agent("late", "questions", 4)];
    expect(refs(attemptEvidence(evidence, "d1", state({ questions: { attempt: 2, generation: 3 } })))).toEqual(["cmd", "same", "other", "late"]);
    expect(refs(attemptEvidence(evidence, "d1", state({})))).toEqual(refs(evidence));
  });

  it("drops what was made for another candidate, as a validator does, but keeps the environment checks", () => {
    const evidence = [environment("env"), command("old", 1, "d1"), command("live", 2, "d2"), agent("judged", "questions", 2, "d1"), agent("fresh", "questions", 2, "d2")];
    expect(refs(attemptEvidence(evidence, "d2", state({})))).toEqual(["env", "live", "fresh"]);
    expect(refs(attemptEvidence(evidence, undefined, state({})))).toEqual(refs(evidence));
  });

  it("keeps the attempts across calls of the graph in the private state it returns", () => {
    const sim = simulate({ through: "review", scenario: overBound(3), reentries: [{ stageId: "review" }], maxSteps: 400 });
    const at = firstSupervise(sim);
    expect(readAttempts(sim.decisions[at]!.privateState).stages).toEqual({ fetch: { attempt: 1, generation: 0 } });
    expect(readAttempts(sim.decisions[at + 1]!.privateState).stages.review).toEqual({ attempt: 2, generation: 2 });
    expect(readAttempts(sim.decisions.at(-2)!.privateState).stages.review).toEqual({ attempt: 2, generation: 2 });
  });

  it("is a no-op for a view the run has not reentered", () => {
    const sim = simulate({ through: "review", scenario: overBound(3) });
    const plain = advancePullRequest(viewOf(sim));
    const stamped = advancePullRequest(viewOf(sim, { evidence: sim.evidence.map((e) => ({ ...e, generation: 1 })), generation: 1 }));
    expect(stamped.action).toEqual(plain.action);
  });
});

/**
 * The feature-data-flow scenario with a diagram job that draws differently in each attempt of the Report stage: the first
 * attempt's drawing, then (after the run is sent back to Report) a second one that only adds an empty rectangle to each
 * document, so both pass every check.
 */
const redrawn = (html: string): string => html.replace("</svg>", '<rect x="0" y="0" width="1" height="1" fill="#ffffff"/></svg>');
const twoDrawings = () =>
  scenarioWith("feature-data-flow", (sc) => {
    const first = sc.results["diagrams-v1"]![0]!.output as { diagrams: Array<{ id: string; html: string }> };
    sc.results["diagrams-v1"] = [{ output: first }, { output: { diagrams: first.diagrams.map((d) => ({ ...d, html: redrawn(d.html) })) } }];
  });

describe("the Report stage reentered after its diagram job drew in an earlier attempt", () => {
  // As in the live run hub-bad193fb (pr-design-review from 0.1.6, the same kit): the validator replayed the first attempt's drawings
  // while the graph wrote the latest, so report.json never recomputed and the Report stage could not be accepted again.
  const wroteReport = (job: JobSpec): boolean => ((job.input as { commands?: Array<{ id: string }> } | undefined)?.commands ?? []).some((c) => c.id === "report-write");
  const cases: Array<[string, Reentry]> = [
    ["a reentry with the candidate unchanged", { stageId: "report", afterJob: wroteReport }],
    ["a resume with a plugin update", { stageId: "report", afterJob: wroteReport, resume: { pluginRoot: "/plugin-updated" } }],
  ];
  for (const [name, reentry] of cases) {
    it(`writes the latest attempt's drawings, which the validator recomputes byte for byte: ${name}`, () => {
      const sim = simulate({ through: "review", scenario: twoDrawings(), reentries: [reentry], maxSteps: 900 });
      expect(sim.final).toMatchObject({ action: { stop: { reason: REVIEWED } } });
      expect(sim.jobs.filter((j) => j.resultSchema === "diagrams-v1")).toHaveLength(2);
      const written = JSON.parse(sim.written!.json) as { diagrams: { features: Record<string, { via: string; svg?: string }> } };
      const drawings = Object.values(written.diagrams.features);
      expect(drawings.length).toBeGreaterThan(0);
      for (const d of drawings) expect(d).toMatchObject({ via: "diagram-design", svg: expect.stringContaining('width="1" height="1"') });
      // The validator, which also sees the first attempt's drawing, recomputes the bytes the graph wrote.
      const profile = profileOf();
      const digest = sim.receipts.at(-1)!.candidateDigest!;
      const lastState = [...sim.decisions].reverse().find((d) => d.privateState !== undefined)?.privateState;
      const of = (evidence: EvidenceRecord[]) => {
        const pr = evidencePull(evidence, profile)!;
        const a = analyze(evidence, profile, pr);
        if (a.state !== "ready") throw new Error(a.state);
        const flow = reportFlowOf(evidence, a.analysis);
        if (flow.state !== "done") throw new Error(flow.state);
        return { drawn: diagramsOf(evidence, flow), json: outputsOf(evidence, profile, pr, a.analysis, flow, measurementsOf(evidence, a.analysis, profile)).json };
      };
      const validator = of(candidateEvidence(sim.evidence, digest));
      const graph = of(attemptEvidence(sim.evidence, digest, readAttempts(lastState)));
      expect(validator.drawn).toEqual(graph.drawn);
      expect(validator.json).toBe(sim.written!.json);
      expect(graph.json).toBe(sim.written!.json);
      expect(sim.receipts.filter((r) => r.stageId === "report" && r.valid).map((r) => r.requirementId).sort()).toEqual(["change-report", "claims-checked", "measurements", "review-context"]);
    });
  }
});
