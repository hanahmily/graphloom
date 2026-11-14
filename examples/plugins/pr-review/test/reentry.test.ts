// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, GraphDecision, JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { attemptEvidence, noteAttempt, readAttempts, type AttemptState } from "../src/attempt.js";
import { advancePullRequest } from "../src/graph.js";
import type { Necessity } from "../src/necessity.js";
import { ANSWERED, assignmentOf, scenarioWith, simulate, viewOf, type Simulation } from "./support.js";

/** The N1 answer of the default scenario with its design explanation past the 800-character bound (the live run's 814). */
function tooLong(good: Necessity, chars = 814): Necessity {
  return { ...good, design: { ...good.design, explanation: "x".repeat(chars) } };
}

/** A scenario whose N1 answerer exceeds the bound `times` times in a row, then answers within it. */
const overBound = (times: number) =>
  scenarioWith("necessity-necessary", (sc) => {
    const good = sc.results["necessity-v1"]![0]!.output as Necessity;
    sc.results["necessity-v1"] = [...Array.from({ length: times }, () => ({ output: tooLong(good) })), { output: good }];
  });

const kindOf = (d: GraphDecision): string => d.action.type;
const jobOf = (d: GraphDecision): JobSpec => (d.action.type === "dispatch" ? d.action.job : (undefined as never));
const answerers = (sim: Simulation) => sim.jobs.filter((j) => j.resultSchema === "necessity-v1");
const firstSupervise = (sim: Simulation): number => sim.decisions.findIndex((d) => d.action.type === "supervise");

describe("the questions stage reentered after N1 exceeded its bound", () => {
  it("escalates after the answerer's two corrections, as the live run did", () => {
    const sim = simulate({ scenario: overBound(3) });
    expect(sim.final.action.type).toBe("supervise");
    expect(sim.final.action.type === "supervise" ? sim.final.action.supervise.reason : "").toMatch(/N1: the design explanation is 814 characters, more than 800/);
    expect(answerers(sim)).toHaveLength(3);
  });

  it("starts a fresh answerer in the new attempt, with no corrections spent, and accepts a compliant answer", () => {
    const sim = simulate({ scenario: overBound(3), reentries: [{ stageId: "questions" }], maxSteps: 400 });
    const at = firstSupervise(sim);
    expect(at).toBeGreaterThan(0);
    // The next proposal is the stage's own answerer, not another escalation of the same 814.
    const next = sim.decisions[at + 1]!;
    expect(kindOf(next)).toBe("dispatch");
    const job = jobOf(next);
    expect(job.resultSchema).toBe("necessity-v1");
    expect(job.continueFrom).toBeUndefined();
    expect(assignmentOf(job)).not.toMatch(/814 characters/);
    // Three answers before the reentry, one after: a compliant one, which passes.
    expect(answerers(sim)).toHaveLength(4);
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    expect(sim.decisions.filter((d) => d.action.type === "supervise")).toHaveLength(1);
  });

  it("counts corrections per attempt: a second attempt that fails again gets its own two corrections", () => {
    const sim = simulate({ scenario: overBound(6), reentries: [{ stageId: "questions" }], maxSteps: 400 });
    expect(sim.final.action.type).toBe("supervise");
    expect(answerers(sim)).toHaveLength(6);
    const corrections = answerers(sim).slice(3).map((j) => assignmentOf(j).includes("814 characters"));
    expect(corrections).toEqual([false, true, true]);
  });

  it("keeps a repeated reentry converging", () => {
    const sim = simulate({ scenario: overBound(6), reentries: [{ stageId: "questions" }, { stageId: "questions" }], maxSteps: 400 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    expect(answerers(sim)).toHaveLength(7);
  });
});

describe("a reentry back to fetch after a repair changed the candidate", () => {
  // As the live run went: the questions stage is reentered and fails again, then the supervisor, whose repair wrote into the worktree, sends the run back to fetch.
  const sim = simulate({ scenario: overBound(6), reentries: [{ stageId: "questions" }, { stageId: "fetch", changesCandidate: true }], maxSteps: 800 });
  const supervises = sim.decisions.flatMap((d, i) => (d.action.type === "supervise" ? [i] : []));

  it("has the graph run fetch's own jobs again instead of escalating", () => {
    expect(supervises).toHaveLength(2);
    const next = sim.decisions[supervises[1]! + 1]!;
    expect(kindOf(next)).toBe("dispatch");
    expect(jobOf(next)).toMatchObject({ stageId: "fetch", purpose: "work", writeScope: ["."] });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
  });

  it("checks the head out again and reads the pull request again, from evidence the validators accept", () => {
    expect(sim.jobs.filter((j) => j.stageId === "fetch" && j.purpose === "work")).toHaveLength(2);
    const reads = sim.jobs.filter((j) => j.stageId === "fetch" && j.kind === "command" && j.executor !== undefined);
    expect(reads.length).toBeGreaterThanOrEqual(2 * 7);
    for (const stage of ["fetch", "report", "questions", "answers"]) {
      expect(sim.receipts.filter((r) => r.stageId === stage && r.valid).length).toBeGreaterThan(0);
    }
  });

  it("runs the report stage's own agents again, and then the answerer once more", () => {
    expect(sim.jobs.filter((j) => j.resultSchema === "change-report-v1")).toHaveLength(2);
    expect(sim.jobs.filter((j) => j.resultSchema === "claim-check-v1")).toHaveLength(2);
    expect(answerers(sim)).toHaveLength(7);
  });
});

describe("a reentry to fetch that left the candidate unchanged", () => {
  it("reuses what the candidate already earned: no second checkout, no second report", () => {
    const sim = simulate({ scenario: overBound(3), reentries: [{ stageId: "fetch" }, { stageId: "questions" }], maxSteps: 800 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    expect(sim.jobs.filter((j) => j.stageId === "fetch" && j.purpose === "work")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "change-report-v1")).toHaveLength(1);
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
    const sim = simulate({ scenario: overBound(3), reentries: [{ stageId: "questions" }], maxSteps: 400 });
    const at = firstSupervise(sim);
    expect(readAttempts(sim.decisions[at]!.privateState).stages).toEqual({ fetch: { attempt: 1, generation: 0 } });
    expect(readAttempts(sim.decisions[at + 1]!.privateState).stages.questions).toEqual({ attempt: 2, generation: 2 });
    expect(readAttempts(sim.decisions.at(-2)!.privateState).stages.questions).toEqual({ attempt: 2, generation: 2 });
  });

  it("is a no-op for a view the run has not reentered", () => {
    const sim = simulate({ scenario: overBound(3) });
    const plain = advancePullRequest(viewOf(sim));
    const stamped = advancePullRequest(viewOf(sim, { evidence: sim.evidence.map((e) => ({ ...e, generation: 1 })), generation: 1 }));
    expect(stamped.action).toEqual(plain.action);
  });
});
