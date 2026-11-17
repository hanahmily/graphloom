// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { rm } from "node:fs/promises";
import type { JobSpec, RehearsalScenario } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { Answer } from "../src/answers.js";
import { priorFileCommand, priorFileText } from "../src/incremental.js";
import type { Question } from "../src/questions.js";
import { incrementalRehearsal, REHEARSAL_HEAD } from "../src/rehearsal.js";
import { recordedRound1 } from "../src/round1.js";
import { answersComplete, questionsComplete } from "../src/validators.js";
import { LedgerRepo, withLedger, type LedgerState } from "./ledgerrepo.js";
import { BANYANDB, candidateEvidence, qaOf, simulate, type Simulation } from "./support.js";

const HEAD1 = "1".repeat(40);
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const partial = (id: string) => (q: Question, _s: unknown, _r: unknown, dflt: Answer): Answer => (q.id === id ? { ...dflt, status: "partially answered" } : dflt);
const cut = (text: string): string => text.split("\n").filter(Boolean).join("\n");
const deltaOf = (...files: string[]): string => `${cut(files.join("\n"))}\ngraphloom-delta-end\n`;
const hunkFile = (p: string, ...hunks: string[]): string => [`diff --git a/${p} b/${p}`, ...hunks].join("\n");

/** A later head's Fetch reads: the ledger ref and its registry, the earlier Q&A and necessity record, and the delta over N1's citations. */
function onLedger(scenario: RehearsalScenario, at: LedgerState, delta = deltaOf()): RehearsalScenario {
  const s = structuredClone(scenario);
  const c = s.commands!;
  withLedger(s, at);
  const parts = (file: "qa" | "necessity", text: string): void => {
    const n = Number(/^graphloom-prior 0 (\d+) /.exec(priorFileText(text, 0))![1]);
    for (let k = 0; k < n; k += 1) c[priorFileCommand(file, at.sha, process.execPath, k).id] = { exitCode: 0, stdout: priorFileText(text, k) };
  };
  parts("qa", at.qa);
  parts("necessity", at.necessity);
  c["ledger-delta"] = { exitCode: 0, stdout: delta };
  return s;
}

const end = (scenario: RehearsalScenario, config: Record<string, unknown> = {}): Simulation => simulate({ scenario, config, maxSteps: 900, through: "end" });
const agentJobs = (s: Simulation, stage: string): string[] => s.jobs.filter((j) => j.kind === "agent" && j.stageId === stage).map((j) => j.instruction);
const idsOf = (j: JobSpec, field: string): string[] => ((j.knownReferences ?? {}) as Record<string, { ids?: string[] }>)[field]?.ids ?? [];
const askedIds = (s: Simulation): string[] => {
  const j = s.jobs.find((x) => x.kind === "agent" && x.stageId === "answers" && x.instruction.startsWith("Answer the questions"));
  return j === undefined ? [] : idsOf(j, "answers[].question");
};

describe("a later head (design-pr-review-split §3.5): every question is asked again, N1 keeps its carry rule", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const config = BANYANDB;
  const state: { head1?: LedgerState; fixed?: Simulation; repo?: LedgerRepo } = {};

  it("head 1: Q1 (existing-feature) is partially answered, so round 1 posts it; the ledger's design section holds the Q&A and N1's record", async () => {
    const sim = end(incrementalRehearsal(config, { answer: partial("Q1") }));
    expect(stopOf(sim)).toMatchObject({ reason: "complete", blocker: expect.stringMatching(/^design review: changes requested: 1 open/) });
    expect(qaOf(sim).questions.map((q) => [q.id, q.type])).toEqual([["N1", "necessity"], ["Q1", "existing-feature"]]);
    expect(qaOf(sim).incremental).toBeUndefined();
    state.repo = await new LedgerRepo().init(dirs);
    state.head1 = await state.repo.advance(sim, HEAD1);
    expect(state.head1.design.heads).toEqual([expect.objectContaining({ sha: HEAD1, round1: "items", open: 1 })]);
    expect(state.head1.review).toBeUndefined();
  });

  it("head 2: N1 is carried (no N1 job), Q1 is asked again although its subject did not change, it is fixed by key, and nothing is posted", async () => {
    const sim = end(onLedger(incrementalRehearsal(config, { necessityCarried: true }), state.head1!));
    state.fixed = sim;
    expect(stopOf(sim)).toMatchObject({ reason: "complete", blocker: expect.stringMatching(/^design review clean at 0123456; nothing posted\. Next: graphloom task new pr-review /) });
    expect(agentJobs(sim, "questions")).toEqual(["Ask the questions (ask only; never answer)"]);
    expect(agentJobs(sim, "answers")).toEqual(["Answer the questions from the whole codebase", "Check the answers against the trees"]);
    expect(askedIds(sim)).toEqual(["Q1"]);
    const qa = qaOf(sim);
    expect(qa.questions.filter((q) => q.carried !== undefined).map((q) => [q.id, q.carried!.head])).toEqual([["N1", HEAD1]]);
    expect(qa.necessity?.carried).toEqual({ head: HEAD1 });
    expect(qa.incremental).toEqual({ from: HEAD1, to: REHEARSAL_HEAD, asked: 1, rechecks: 1, carried: 1 });
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues).toEqual([]);
    expect(r1.state === "read" && r1.value.prior).toEqual([{ id: "Q1", key: "existing-feature|item|pkg/quota/limit.go", status: "fixed", reason: "its question is now answered, with no open kind" }]);
    expect(sim.github.creates).toEqual([]);
    // The ledger records the head clean and the earlier item fixed, with no review.
    const after = await state.repo!.advance(sim, "2".repeat(40));
    expect(after.design.heads.at(-1)).toMatchObject({ sha: "2".repeat(40), round1: "clean", open: 0 });
    expect(after.design.heads.at(-1)!.reviewId).toBeUndefined();
  });

  it("the validators recompute the carried N1 and the full set of questions", () => {
    const sim = state.fixed!;
    const upto = sim.evidence.findIndex((e) => (e.payload as { command?: { id?: string } }).command?.id === "ledger-write");
    const check = [questionsComplete, answersComplete].map((v) => v.evaluate({ requirementId: "x", statement: "", evidence: candidateEvidence(sim.evidence.slice(0, upto + 1), "d1"), candidateDigest: "d1", config }));
    expect(check.map((r) => r.status)).toEqual(["passed", "passed"]);
  });

  it("head 2 with the item still open: it is listed under Earlier items with a link, counted, and not posted again", () => {
    const sim = end(onLedger(incrementalRehearsal(config, { necessityCarried: true, answer: partial("Q1") }), state.head1!));
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.prior).toEqual([{ id: "Q1", key: "existing-feature|item|pkg/quota/limit.go", status: "open", reason: "it is still an open item on this head" }]);
    const body = String(sim.github.creates[0]!.body);
    expect(body.split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body).toContain("- Q1: still open");
    expect(body).not.toContain("<!-- graphloom-finding: Q1 -->");
  });

  it("an update that changes a line N1 cites, or questions.incremental false, asks N1 again", () => {
    const changed = end(onLedger(incrementalRehearsal(config), state.head1!, deltaOf(hunkFile("pkg/quota/limit.go", "@@ -1 +1 @@"))), { questions: { ...(BANYANDB.questions as object), incremental: false } });
    expect(agentJobs(changed, "questions")[0]).toBe("Answer the necessity question N1 from the whole codebase");
    expect(qaOf(changed).incremental).toMatchObject({ full: expect.stringContaining("questions.incremental is false") });
  });
});
