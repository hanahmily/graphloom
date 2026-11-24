// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { analyze, evidencePull, reportFlowOf } from "../src/kit/analysis.js";
import { attemptEvidence, latestAttemptRuns, readAttempts } from "../src/kit/attempt.js";
import type { Producer } from "../src/kit/evidence.js";
import { afterNecessity, qaContext, questionerFlow, questionSet, restFlow } from "../src/qaflow.js";
import { reportWriteCommands } from "../src/kit/parts.js";
import { changeReport, diagramsOf, measurementsOf, outputsOf } from "../src/validators.js";
import { ANSWERED, BANYANDB, candidateEvidence, profileOf, scenarioWith, simulate, type Reentry, type Simulation } from "./support.js";

/** The default scenario with an answerer that returns no answer `times` times in a row, then its own answers. */
const noAnswers = (times: number) =>
  scenarioWith("report", (sc) => {
    const good = sc.results["answers-v1"]!;
    sc.results["answers-v1"] = [...Array.from({ length: times }, () => ({ output: { answers: [] } })), ...good];
  });

describe("a reentry to fetch that left the candidate unchanged, after the answer checker ran", () => {
  // N1's answer checker is the latest review evidence of the candidate, so the report's validators no longer see the claim checks;
  // the graph's record of them puts them back, and the Report stage is accepted again without a second report.
  it("accepts Report again from the recorded claim checks: no second checkout, report or claim check", () => {
    const sim = simulate({ scenario: noAnswers(3), reentries: [{ stageId: "fetch" }, { stageId: "answers" }], maxSteps: 800 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    // Every escalation is the answerer's (the second is the same attempt, which the reentry to fetch did not restart): none is the report's.
    const reasons = sim.decisions.flatMap((d) => (d.action.type === "supervise" ? [d.action.supervise.reason] : []));
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(r).toMatch(/^the answers still fail deterministic validation/);
    expect(sim.jobs.filter((j) => j.stageId === "fetch" && j.purpose === "work")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "change-report-v1")).toHaveLength(1);
    expect(sim.jobs.filter((j) => j.resultSchema === "claim-check-v1")).toHaveLength(1);
    expect(sim.receipts.filter((r) => r.stageId === "report" && r.valid).map((r) => r.requirementId).sort()).toEqual(["change-report", "claims-checked", "measurements"]);
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

/** What the change-report validator recomputes from the evidence the controller hands it, and what the graph's own view gives. */
function recomputed(sim: Simulation) {
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
  return { validator: of(candidateEvidence(sim.evidence, digest)), graph: of(attemptEvidence(sim.evidence, digest, readAttempts(lastState))) };
}

describe("the Report stage reentered after its diagram job drew in an earlier attempt", () => {
  // The live run hub-bad193fb (pr-design-review from 0.1.6): the validator replayed the first attempt's drawings while the graph wrote the
  // latest, so report.json never recomputed and the Report stage could not be accepted again.
  // The run is sent back to Report once the first attempt has written its report, as a supervisor's reentry or a resume would.
  const wroteReport = (job: JobSpec): boolean => ((job.input as { commands?: Array<{ id: string }> } | undefined)?.commands ?? []).some((c) => c.id === "report-write");
  const cases: Array<[string, Reentry]> = [
    ["a reentry with the candidate unchanged", { stageId: "report", afterJob: wroteReport }],
    ["a resume with a plugin update", { stageId: "report", afterJob: wroteReport, resume: { pluginRoot: "/plugin-updated" } }],
  ];
  for (const [name, reentry] of cases) {
    it(`writes the latest attempt's drawings, which the validator recomputes byte for byte: ${name}`, () => {
      const sim = simulate({ scenario: twoDrawings(), reentries: [reentry], maxSteps: 900 });
      expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
      // Both attempts drew; the second attempt's drawing is the one in the report.
      expect(sim.jobs.filter((j) => j.resultSchema === "diagrams-v1")).toHaveLength(2);
      const written = JSON.parse(sim.written!.json) as { diagrams: { features: Record<string, { via: string; svg?: string }> } };
      const drawings = Object.values(written.diagrams.features);
      expect(drawings.length).toBeGreaterThan(0);
      for (const d of drawings) expect(d).toMatchObject({ via: "diagram-design", svg: expect.stringContaining('width="1" height="1"') });
      // The validator, which also sees the first attempt's drawing, recomputes the bytes the graph wrote.
      const { validator, graph } = recomputed(sim);
      expect(validator.drawn).toEqual(graph.drawn);
      expect(validator.json).toBe(sim.written!.json);
      expect(graph.json).toBe(sim.written!.json);
      expect(sim.receipts.filter((r) => r.stageId === "report" && r.valid).map((r) => r.requirementId).sort()).toEqual(["change-report", "claims-checked", "measurements"]);
    });
  }

  it("still refuses a report that carries the earlier attempt's drawing", () => {
    const sim = simulate({ scenario: twoDrawings(), reentries: [cases[0]![1]], maxSteps: 900 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    const digest = sim.receipts.at(-1)!.candidateDigest!;
    const live = candidateEvidence(sim.evidence, digest);
    const evaluate = (evidence: EvidenceRecord[]) => changeReport.evaluate({ requirementId: "change-report", statement: "", evidence, candidateDigest: digest, config: BANYANDB });
    expect(evaluate(live)).toMatchObject({ status: "passed" });
    // The report as the first attempt drew it, written over the latest: the drawing is stale, so the bytes do not recompute.
    const firstDrawings = recomputedWithout(sim, live, (e) => e.resultSchema === "diagrams-v1" && (e.payload as { producer: Producer }).producer.attempt === 2);
    expect(firstDrawings.json).not.toBe(sim.written!.json);
    const forged = reportWriteCommands(firstDrawings.json, sim.written!.markdown).map((c, i): EvidenceRecord => ({ ref: `forged-${i}`, kind: "command", candidateDigest: digest, payload: { command: { id: c.id, argv: c.argv, exitCode: 0, stdoutTail: "", stderrTail: "" } } }));
    expect(evaluate([...live, ...forged])).toMatchObject({ status: "failed", reason: expect.stringContaining("is not the report the evidence recomputes") });
  });
});

/** The report the evidence recomputes with some records left out. */
function recomputedWithout(sim: Simulation, evidence: EvidenceRecord[], drop: (e: EvidenceRecord) => boolean): { json: string } {
  const profile = profileOf();
  const kept = evidence.filter((e) => !drop(e));
  const pr = evidencePull(kept, profile)!;
  const a = analyze(kept, profile, pr);
  if (a.state !== "ready") throw new Error(a.state);
  const flow = reportFlowOf(kept, a.analysis);
  if (flow.state !== "done") throw new Error(`${flow.state} (${sim.evidence.length} records)`);
  return { json: outputsOf(kept, profile, pr, a.analysis, flow, measurementsOf(kept, a.analysis, profile)).json };
}

describe("the Answers stage reentered after its answers were revised", () => {
  // The first attempt's answers were judged unsupported and revised. A new attempt answers afresh and its checker again finds an
  // answer unsupported: the graph, which sees only the new attempt, asks for the revision, and the replay a validator makes over
  // every answer of the candidate must stand at the same place, not take the earlier attempt's revision for this one's.
  it("replays the new attempt's answers to the same step in the graph's view and in a validator's", () => {
    const sim = simulate({ scenarioName: "answer-checker-contradicts", maxSteps: 400 });
    expect(sim.final).toMatchObject({ action: { stop: { reason: ANSWERED } } });
    const isAnswers = (e: EvidenceRecord): boolean => (e.payload as { producer?: Producer } | undefined)?.producer?.stageId === "answers" && e.resultSchema !== undefined;
    const ofSchema = (schema: string): EvidenceRecord => sim.evidence.find((e) => isAnswers(e) && e.resultSchema === schema)!;
    expect(sim.evidence.some((e) => isAnswers(e) && e.resultSchema === "answers-revision-v1")).toBe(true);
    // The new attempt's first answer and its check, as the first attempt's were.
    const again = [ofSchema("answers-v1"), ofSchema("answer-check-v1")].map((e, i) => ({ ...e, ref: `again-${i}`, generation: 2, payload: { ...(e.payload as object), producer: { ...(e.payload as { producer: Producer }).producer, operationId: `again-${i}`, attempt: 2 } } }));
    const all = [...sim.evidence.map((e) => ({ ...e, generation: e.generation ?? 1 })), ...again];
    const graphView = attemptEvidence(all, undefined, { v: 1, stages: { answers: { attempt: 2, generation: 2 } } });
    const validatorView = all.filter((e) => e.kind !== "review" || e.ref === "again-1");
    const profile = profileOf();
    const where = (evidence: EvidenceRecord[]) => {
      const pr = evidencePull(evidence, profile)!;
      const c = qaContext(evidence, profile, pr);
      if (c.state !== "ready") throw new Error(c.state);
      const q = questionerFlow(evidence, c.ctx);
      if (q.state !== "done") throw new Error(q.state);
      const flow = restFlow(evidence, c.ctx, afterNecessity(questionSet(c.ctx, q.output)));
      return flow.state === "answerer" ? `${flow.state} ${flow.kind}` : flow.state;
    };
    expect(where(graphView)).toBe("answerer revision");
    expect(where(validatorView)).toBe(where(graphView));
  });
});

describe("the runs of a stage's latest attempt", () => {
  const run = (ref: string, stageId: string, attempt?: number): { ref: string; producer: Producer } => ({ ref, producer: { operationId: ref, stageId, purpose: "diagnostic", readOnly: true, kind: "agent", ...(attempt !== undefined ? { attempt } : {}) } });
  const refs = (list: ReadonlyArray<{ ref: string }>): string[] => list.map((r) => r.ref);

  it("keeps the runs of the newest run's stage and attempt, in order", () => {
    expect(refs(latestAttemptRuns([run("a", "report", 1), run("b", "report", 1), run("c", "report", 3), run("d", "report", 3)]))).toEqual(["c", "d"]);
    expect(refs(latestAttemptRuns([run("a", "report", 2), run("b", "questions", 2)]))).toEqual(["b"]);
    expect(latestAttemptRuns([])).toEqual([]);
  });

  it("counts the runs an older controller recorded without an attempt as one attempt of their own", () => {
    expect(refs(latestAttemptRuns([run("a", "report"), run("b", "report")]))).toEqual(["a", "b"]);
    expect(refs(latestAttemptRuns([run("a", "report"), run("b", "report", 2)]))).toEqual(["b"]);
  });
});
