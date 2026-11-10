// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { definitionFor } from "../src/graph.js";
import { parseProfile, ROUNDS } from "../src/profile.js";
import { ledgerJson } from "../src/ledger.js";
import { ROUNDS_SKIP_NOTE, ROUNDS_SKIP_REASON, roundsSkipJson } from "../src/necessity.js";
import { REHEARSAL_REQUEST } from "../src/rehearsal.js";
import { recordedNecessityJson } from "../src/parts.js";
import { recordedRound1, writtenDraftFiles } from "../src/reviewdraft.js";
import { validatorById } from "../src/validators.js";
import { BANYANDB, candidateEvidence, profileOf, simulate } from "./support.js";

const REVIEW_REQUEST = REHEARSAL_REQUEST.replace("Report on", "Review on");
const REVIEW_ONLY = { rounds: "review-only" };
const stopOf = (s: ReturnType<typeof simulate>) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const stages = (s: ReturnType<typeof simulate>): string[] => [...new Set(s.jobs.map((j) => j.stageId))];
const agentSchemas = (s: ReturnType<typeof simulate>, stage: string): string[] => s.jobs.filter((j) => j.stageId === stage && j.kind === "agent").map((j) => j.resultSchema!);
const evaluate = (id: string, evidence: EvidenceRecord[], config: Record<string, unknown>) =>
  validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, "d1"), candidateDigest: "d1", config });
const beforeStage = (evidence: EvidenceRecord[], stage: string): EvidenceRecord[] => evidence.slice(0, evidence.findIndex((e) => (e.payload as { producer?: { stageId: string } }).producer?.stageId === stage));

describe("the rounds profile key", () => {
  it("is both by default, and review-only when the profile says so", () => {
    expect([...ROUNDS]).toEqual(["both", "review-only"]);
    expect(profileOf().rounds).toBe("both");
    expect(profileOf({ rounds: "both" }).rounds).toBe("both");
    expect(profileOf(REVIEW_ONLY).rounds).toBe("review-only");
  });

  it("refuses an unknown value", () => {
    for (const rounds of ["round2", "review", "", 2, null, ["both"]]) expect(() => parseProfile({ ...BANYANDB, rounds }), JSON.stringify(rounds)).toThrow(/rounds must be "both" or "review-only"/);
  });

  it("keeps the step set, names, order and required outcomes the same: only the statements of the skipped stages say more", () => {
    const both = definitionFor(profileOf());
    const only = definitionFor(profileOf(REVIEW_ONLY));
    expect(only.stages).toEqual(both.stages);
    expect(only.requirements.map((r) => r.id)).toEqual(both.requirements.map((r) => r.id));
    expect(only.defaultValidators).toEqual(both.defaultValidators);
    for (const id of ["questions-complete", "answers-complete", "answers-grounded", "round1-gated"]) {
      const statement = (d: typeof both) => d.requirements.find((r) => r.id === id)!.statement;
      expect(statement(both), id).not.toContain(ROUNDS_SKIP_REASON);
      expect(statement(only), id).toContain(`"${ROUNDS_SKIP_REASON}"`);
    }
  });
});

describe("rounds: review-only runs the report, then round 2", () => {
  const sim = simulate({ scenarioName: "review-layer", request: REVIEW_REQUEST, config: REVIEW_ONLY, through: "end", maxSteps: 400 });

  it("goes Fetch, Report, the skipped Questions, Answers and Round 1, then Review, Draft and Publish, in the same run", () => {
    expect(stopOf(sim), JSON.stringify(sim.final).slice(0, 600)).toMatchObject({ reason: "complete", retryable: false });
    expect(stopOf(sim)!.blocker).toMatch(/^round 2: changes requested: 1 open on apache\/skywalking-banyandb#7 at 0123456789ab; the review is posted \(https:/);
    // Every requirement is received, in the fixed order, so no step was added or dropped.
    expect(sim.receipts.filter((r) => r.valid).map((r) => r.requirementId)).toEqual([
      "pr-snapshot", "head-checked-out", "prior-ledger", "change-report", "measurements", "claims-checked", "questions-complete", "answers-complete", "answers-grounded", "round1-gated", "code-review", "findings-proven", "draft-composed", "review-published",
    ]);
    expect(stages(sim)).toEqual(expect.arrayContaining(["fetch", "report", "questions", "answers", "review", "draft", "publish"]));
    expect(sim.github.creates).toHaveLength(1);
  });

  it("asks no question and runs no answerer or checker: Questions and Answers only record, and the Report and Review agents run", () => {
    expect(agentSchemas(sim, "questions")).toEqual([]);
    expect(agentSchemas(sim, "answers")).toEqual([]);
    expect(sim.jobs.filter((j) => j.resultSchema === "necessity-v1" || j.resultSchema === "questions-v1" || j.resultSchema === "answers-v1" || j.resultSchema === "answer-check-v1")).toEqual([]);
    expect(agentSchemas(sim, "report").length).toBeGreaterThan(0);
    expect(agentSchemas(sim, "review")).toContain("pr-code-review-v1");
  });

  it("records the skip with its reason in necessity.json, and zero issues with the same reason in round 1", () => {
    const w = recordedNecessityJson(sim.evidence);
    expect(w).toMatchObject({ state: "read", value: roundsSkipJson() });
    expect(JSON.parse((w as { value: string }).value)).toMatchObject({ conclusion: "not asked", decision: { action: "skip", reason: ROUNDS_SKIP_REASON, by: "operator" } });
    const r1 = recordedRound1(sim.evidence);
    expect(r1).toMatchObject({ state: "read", value: { necessity: "skipped", issues: [], skipped: ROUNDS_SKIP_REASON } });
    expect((r1 as { value: { prior?: unknown } }).value.prior).toBeUndefined();
  });

  it("says in qa.json and review.md that the Q&A was skipped by the operator's choice, not that nothing was asked", () => {
    const qa = JSON.parse(sim.qa!.json) as { questions: unknown[]; roundsSkipped: { reason: string; note: string }; necessity?: unknown };
    expect(qa.questions).toEqual([]);
    expect(qa.necessity).toBeUndefined();
    expect(qa.roundsSkipped).toEqual({ reason: ROUNDS_SKIP_REASON, note: ROUNDS_SKIP_NOTE });
    expect(sim.qa!.markdown).toContain(ROUNDS_SKIP_NOTE);
    expect(sim.qa!.markdown).toContain("- N1, is it necessary: not asked (skipped by the operator's choice, rounds: review-only)");
    expect(sim.qa!.markdown).toContain("Questions and answers were skipped by the operator's choice");
    expect(sim.qa!.markdown).not.toContain("No question needs a person.");
    expect(sim.qa!.markdown).not.toContain("Pending:");
  });

  it("says so in review.html and the appendix, final after the Review section", () => {
    const files = writtenDraftFiles(sim.evidence);
    for (const page of [files.html, files.appendix]) {
      expect(page.state).toBe("read");
      const html = (page as { value: string }).value;
      expect(html).toContain("skipped");
      expect(html).toContain("by the operator&#39;s choice");
      expect(html).not.toContain("no question needs a person");
    }
    expect((files.html as { value: string }).value).toContain("Review");
    expect((files.markdown as { value: string }).value).toContain(ROUNDS_SKIP_NOTE);
  });

  it("posts round 2's verdict, and the body says round 1 was skipped by the operator", () => {
    const body = String(sim.github.creates[0]!.body);
    expect(body.split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body).toContain("Round 1 (design and architecture, from the change report and its questions) was skipped by the operator's choice (rounds: review-only)");
    expect(body).toContain("not re-checked and are not counted");
    expect(body).toContain("Round 2 (details, functionality, algorithms)");
    expect(body).not.toContain("no open issue");
  });

  it("is accepted by the validators on its evidence, and by the skip alone", () => {
    for (const id of ["questions-complete", "answers-complete", "answers-grounded", "round1-gated"]) expect(evaluate(id, sim.evidence, { ...BANYANDB, ...REVIEW_ONLY }), id).toMatchObject({ status: "passed" });
  });

  it("is not accepted as a default (both) run's evidence: the skip is admissible only with the option set", () => {
    expect(evaluate("questions-complete", sim.evidence, BANYANDB)).toMatchObject({ status: "failed", reason: expect.stringContaining("only with rounds: review-only") });
    expect(evaluate("answers-grounded", sim.evidence, BANYANDB)).toMatchObject({ status: "failed" });
    expect(evaluate("answers-complete", sim.evidence, BANYANDB).status).not.toBe("passed");
  });
});

describe("rounds: both (the default) is unchanged", () => {
  const sim = simulate({ scenarioName: "review-layer", request: REVIEW_REQUEST, through: "end", maxSteps: 400 });

  it("asks N1 and the questions, answers and checks them, and records round 1 with no skip", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(agentSchemas(sim, "questions")).toEqual(["necessity-v1", "answer-check-v1", "questions-v1"]);
    expect(agentSchemas(sim, "answers")).toContain("answers-v1");
    const r1 = recordedRound1(sim.evidence);
    expect(r1).toMatchObject({ state: "read", value: { necessity: "necessary", issues: [] } });
    expect((r1 as { value: { skipped?: unknown } }).value.skipped).toBeUndefined();
    expect(sim.qa!.json).not.toContain("roundsSkipped");
    expect(String(sim.github.creates[0]!.body)).toContain("Round 1 (design and architecture, from the change report and its questions): no open issue.");
  });

  it("does not accept the skip: a review-only record fails the default profile's validators and the stage's own recomputation", () => {
    const only = simulate({ scenarioName: "review-layer", request: REVIEW_REQUEST, config: REVIEW_ONLY, through: "end", maxSteps: 400 });
    expect(evaluate("questions-complete", beforeStage(only.evidence, "answers"), BANYANDB)).toMatchObject({ status: "failed" });
    // And the other way: a default run's evidence is not the skip.
    expect(evaluate("questions-complete", beforeStage(sim.evidence, "answers"), { ...BANYANDB, ...REVIEW_ONLY })).toMatchObject({ status: "failed" });
    expect(evaluate("answers-complete", sim.evidence, { ...BANYANDB, ...REVIEW_ONLY })).toMatchObject({ status: "failed" });
  });
});

describe("re-review continuity with review-only (design 9): earlier round-1 items are left as they were", () => {
  it("carries the earlier heads' questions, ids and posted items into the ledger, and adds none", () => {
    const prior = {
      schema: "graphloom-pr-ledger-v1",
      heads: [{ sha: "a".repeat(40), reported: true, reviewed: false }],
      qa: [{ id: "Q4", type: "purpose", key: "purpose|item|pkg/a.go", symbol: null, item: "C1", status: "needs author", answer: "", state: "open", history: [] }],
      findings: [{ id: "Q4", origin: "round1", status: "open", comment: 77 }],
    };
    const pr = { mode: "review" as const, owner: "apache", repo: "skywalking-banyandb", number: 7, head: "b".repeat(40) };
    const out = JSON.parse(ledgerJson({ pr, base: undefined, files: 1, commits: 1, facts: 0, questions: [], answers: [], purposes: [] }, prior)) as { qa: Array<{ id: string; status: string }>; findings: unknown[]; heads: Array<{ sha: string }> };
    expect(out.qa).toEqual(prior.qa);
    expect(out.findings).toEqual(prior.findings);
    expect(out.heads.map((h) => h.sha)).toEqual(["a".repeat(40), "b".repeat(40)]);
  });
});

describe("task new with a profile copy that sets rounds", () => {
  it("accepts a copy with rounds review-only, plans the same task, and refuses an unknown value", async () => {
    const { prepareTask } = await import("../src/index.js");
    const base = { args: ["apache/skywalking-banyandb#7"], repo: { remotes: [], head: "a".repeat(40) }, options: { dryRun: false } };
    const plain = prepareTask({ ...base, profile: BANYANDB });
    expect(prepareTask({ ...base, profile: { ...BANYANDB, ...REVIEW_ONLY } })).toEqual(plain);
    expect(prepareTask({ ...base, profile: { ...BANYANDB, rounds: "round2" } })).toMatchObject({ refused: expect.stringContaining("rounds must be") });
  });
});
