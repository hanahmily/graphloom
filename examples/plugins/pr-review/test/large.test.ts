// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, JobSpec } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { analyze, evidencePull } from "../src/analysis.js";
import { LIST_CHECK_RUNS, GET_PULL, LIST_PULL_COMMITS, LIST_PULL_FILES, LIST_PULL_REVIEWS, LIST_PULL_REVIEW_COMMENTS, LIST_REVIEW_THREADS } from "../src/constants.js";
import { definitionFor } from "../src/graph.js";
import { assembleLarge, budgetShortfall, largeNeeds, mergedItem, synthesisProblems, type SynthItem } from "../src/large.js";
import { ProfileError, parseProfile } from "../src/profile.js";
import { answerBatches } from "../src/qaflow.js";
import { LARGE_LIMITS, REHEARSAL_HEAD } from "../src/rehearsal.js";
import type { Question } from "../src/questions.js";
import { readResult, READS, snapshotState } from "../src/snapshot.js";
import { recordCommand, writeChunks } from "../src/write.js";
import { validatorById } from "../src/validators.js";
import { BANYANDB, assignmentOf, candidateEvidence, profileOf, scenarioWith, simulate, type Simulation } from "./support.js";

const LARGE = { limits: LARGE_LIMITS };
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const run = (change?: (s: Parameters<typeof scenarioWith>[1] extends (s: infer S) => void ? S : never) => void, config: Record<string, unknown> = LARGE, extra: { budgets?: Record<string, number> } = {}): Simulation =>
  simulate({ scenario: scenarioWith("large-pull-request", change ?? (() => undefined), config), config, maxSteps: 250, ...(extra.budgets !== undefined ? { budgets: extra.budgets } : {}) });
const report = (sim: Simulation) => JSON.parse(sim.written!.json) as Record<string, any>;
const qa = (sim: Simulation) => JSON.parse(sim.qa!.json) as Record<string, any>;
const agents = (sim: Simulation, schema: string): JobSpec[] => sim.jobs.filter((j) => j.resultSchema === schema);
const harnessOf = (j: JobSpec): string => (j.input as { harness: string }).harness;
const commandIds = (j: JobSpec): string[] => ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id);
const items = (r: Record<string, any>): Array<Record<string, any>> => r.sections.flatMap((s: { items: unknown[] }) => s.items);

describe("a large pull request, reported area by area (design §6.9)", () => {
  const sim = run();

  it("runs to the end: every receipt valid, one report", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "report ready" });
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
    expect(sim.receipts.map((r) => r.stageId).filter((s, i, a) => a.indexOf(s) === i)).toEqual(["fetch", "report", "questions", "answers"]);
  });

  it("asks one reporter job per area, each a fresh read-only session with its own key, then one synthesis job, then the checks", () => {
    const reporters = agents(sim, "change-report-v1");
    expect(reporters.map((j) => j.jobId)).toEqual(["reporter-A1", "reporter-A2", "reporter-A3"]);
    for (const j of reporters) {
      expect(j.continueFrom).toBeUndefined();
      expect(j.readOnly).toBe(true);
      expect(harnessOf(j)).toBe(profileOf(LARGE).roles.reporter);
    }
    const synthesis = agents(sim, "change-synthesis-v1");
    expect(synthesis.map((j) => j.jobId)).toEqual(["synthesis"]);
    expect(synthesis[0]!.continueFrom).toBeUndefined();
    expect(harnessOf(synthesis[0]!)).toBe(profileOf(LARGE).roles.reporter);
    // The checks: one per area and one for the synthesis, on the report checker's harness, never continued.
    const checks = sim.jobs.filter((j) => j.stageId === "report" && j.resultSchema === "claim-check-v1");
    expect(checks).toHaveLength(4);
    for (const j of checks) {
      expect(j.purpose).toBe("review");
      expect(j.continueFrom).toBeUndefined();
      expect(j.jobId).toBeUndefined();
      expect(harnessOf(j)).toBe(profileOf(LARGE).roles["report-checker"]);
    }
    // The order: an area is reported, checked and recorded before the next one starts; the synthesis comes after the last.
    const order = sim.jobs.filter((j) => j.stageId === "report").map((j) => j.resultSchema ?? commandIds(j)[0]).filter((x) => x !== undefined && /^(change-|claim-|area-record|synthesis-record)/.test(x));
    expect(order).toEqual(["change-report-v1", "claim-check-v1", "area-record-A1", "change-report-v1", "claim-check-v1", "area-record-A2", "change-report-v1", "claim-check-v1", "area-record-A3", "change-synthesis-v1", "claim-check-v1", "synthesis-record"]);
  });

  it("gives an area reporter its own files as patches to read, the whole file list as context, and an empty summary to return", () => {
    const [, a2] = agents(sim, "change-report-v1").map(assignmentOf);
    expect(a2).toContain("You report area A2 (pkg/alpha) only");
    const own = a2!.slice(a2!.indexOf("Changed files of your area A2"), a2!.indexOf("Other files of the pull request"));
    expect(own).toContain("pkg/alpha/alpha.go");
    expect(own).not.toContain("pkg/beta/beta.go");
    expect(a2).toMatch(/Other files of the pull request, for context only \(4;/);
    expect(a2).toContain("pkg/beta/beta.go — added, +13 −0");
    expect(a2).toContain('Leave "purpose" empty');
    // The synthesis reads the checked items, not the patches.
    const synth = assignmentOf(agents(sim, "change-synthesis-v1")[0]!);
    expect(synth).toContain("A2.R1 [features]");
    expect(synth).toContain("A3.R1 [features]");
    expect(synth).not.toContain("+\treturn x + 1");
  });

  it("records every checked area and the synthesis as evidence the validators recompute from", () => {
    const written = sim.evidence.filter((e) => e.kind === "command" && /area-record-A\d|synthesis-record/.test(JSON.stringify((e.payload as { command?: { id?: string } }).command?.id))).map((e) => (e.payload as { command: { id: string } }).command.id);
    expect(written).toEqual(["area-record-A1", "area-record-A2", "area-record-A3", "synthesis-record"]);
  });

  it("merges the items that are one change across areas: the union of their cites and facts, renumbered R1... in section order", () => {
    const r = report(sim);
    const features = r.sections.find((s: { id: string }) => s.id === "features").items;
    expect(features).toHaveLength(1);
    expect(features[0].cites.map((c: { path: string }) => c.path).sort()).toEqual(["pkg/alpha/alpha.go", "pkg/beta/beta.go"]);
    expect(features[0].text).toContain("Alpha1 to Alpha6");
    expect(features[0].text).toContain("Beta");
    expect(r.merges).toEqual([{ id: "M1", items: ["A2.R1", "A3.R1"], into: features[0].id }]);
    expect(items(r).map((i) => i.id)).toEqual(items(r).map((_, n) => `R${n + 1}`));
    expect(r.summary.purpose).toMatchObject({ source: "stated", quote: "Add alpha and beta helpers" });
    expect(r.summary.overview).toContain("one change");
    expect(r.removed).toEqual([]);
  });

  it("records the mode and its reason in report.json, the areas, and shows it in the header of review.md", () => {
    const r = report(sim);
    expect(r.mode).toBe("large");
    expect(r.modeReasons).toEqual([{ limit: "maxFiles", value: 5, max: 2 }]);
    expect(r.areas.map((a: { id: string; name: string; kind: string; items: number }) => [a.id, a.name, a.kind])).toEqual([
      ["A1", "docs", "read"],
      ["A2", "pkg/alpha", "read"],
      ["A3", "pkg/beta", "read"],
      ["generated", "generated", "generated"],
    ]);
    expect(sim.written!.markdown.split("\n")[2]).toBe("Mode: large (5 files, over the limit of 2): reported in 3 areas, then one synthesis; generated files are listed in Other, not read; 1 file(s) without a patch from GitHub are listed in Other.");
  });

  it("lists the generated files and a file GitHub gave no patch for in other, never failing", () => {
    const r = report(sim);
    const other = r.sections.find((s: { id: string }) => s.id === "other").items.map((i: { text: string }) => i.text);
    expect(other).toContain("api/gen/types.pb.go changed (+5 −0 lines); generated code, not read by an agent");
    expect(other).toContain("assets/logo.png changed (+1 −0 lines); patch not provided by GitHub");
    expect(r.omitted).toEqual(["assets/logo.png"]);
    expect(stopOf(sim)!.reason).toBe("report ready");
  });

  it("asks the questions in large mode and answers them in batches of at most 15 that continue one session, checked in fresh sessions", () => {
    const q = qa(sim);
    expect(q.mode).toBe("large");
    expect(q.modeReasons).toEqual([{ limit: "maxFiles", value: 5, max: 2 }]);
    const answerers = agents(sim, "answers-v1");
    expect(answerers).toHaveLength(2);
    const sizes = answerers.map((j) => Number(/Questions \((\d+)\):/.exec(assignmentOf(j))![1]));
    expect(sizes).toEqual([15, 10]);
    expect(answerers[0]!.continueFrom).toBeUndefined();
    const firstOp = ((sim.evidence.find((e) => e.resultSchema === "answers-v1")!.payload as { producer: { operationId: string } }).producer.operationId);
    expect(answerers[1]!.continueFrom).toBe(firstOp);
    const checkers = sim.jobs.filter((j) => j.stageId === "answers" && j.resultSchema === "answer-check-v1");
    expect(checkers).toHaveLength(2);
    for (const j of checkers) {
      expect(j.continueFrom).toBeUndefined();
      expect(j.jobId).toBeUndefined();
    }
    // qa.json and review.md are written once, after the last batch.
    const writes = sim.jobs.filter((j) => commandIds(j).includes("qa-write"));
    expect(writes).toHaveLength(1);
    const at = (id: string): number => sim.jobs.findIndex((j) => commandIds(j).includes(id));
    expect(at("answers-record-1")).toBeLessThan(at("answers-record-2"));
    expect(at("answers-record-2")).toBeLessThan(at("qa-write"));
    expect(q.questions.filter((x: { id: string }) => x.id !== "N1")).toHaveLength(25);
    expect(sim.qa!.markdown).toContain("answered in 2 batch(es) of at most 15 questions");
    expect(sim.receipts.filter((r) => r.stageId === "answers").every((r) => r.valid)).toBe(true);
  });

  it("asks the large-mode questions: the trio once per change item and per new exported symbol, one missing-test per item", () => {
    const q = qa(sim);
    const questions = q.questions as Array<{ id: string; type: string; item: string; symbol?: string; text: string }>;
    const symbols = q.symbols as Array<{ id: string; qualified: string; exported: boolean; change: string }>;
    expect(symbols.filter((s) => s.change === "new")).toHaveLength(8);
    const exported = symbols.filter((s) => s.exported);
    expect(exported).toHaveLength(7);
    const count = (type: string, pick: (x: (typeof questions)[number]) => boolean): number => questions.filter((x) => x.type === type && pick(x)).length;
    for (const type of ["existing-equivalent", "reuse-library", "common-logic"]) {
      expect(count(type, (x) => x.symbol === undefined)).toBe(1);
      expect(count(type, (x) => x.symbol !== undefined)).toBe(7);
      for (const s of exported) expect(count(type, (x) => x.symbol === s.id)).toBe(1);
    }
    const twice = symbols.find((s) => s.qualified === "beta.twice")!;
    expect(questions.some((x) => x.symbol === twice.id)).toBe(false);
    const itemTrio = questions.find((x) => x.type === "existing-equivalent" && x.symbol === undefined)!;
    expect(itemTrio.text).toContain("beta.twice");
    expect(itemTrio.text).toContain("alpha.Alpha1");
    const missing = questions.filter((x) => x.type === "missing-test");
    expect(missing).toHaveLength(1);
    for (const s of symbols) expect(missing[0]!.text).toContain(s.qualified);
    expect(questions.filter((x) => x.type === "split-function" || x.type === "complexity-coverage")).toEqual([]);
  });

  it("keeps the questions a standard run asks, per symbol, when the pull request is small", () => {
    const standard = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, {}), config: {}, maxSteps: 250 });
    expect(stopOf(standard)!.reason).toBe("report ready");
    const q = qa(standard);
    expect(q.mode).toBe("standard");
    expect(q.questions.filter((x: { type: string }) => x.type === "existing-equivalent")).toHaveLength(8);
    expect(q.questions.filter((x: { type: string }) => x.type === "missing-test")).toHaveLength(8);
  });
});

describe("standard mode is what it was", () => {
  it("records mode standard only, with no areas, no records, no header line and no synthesis", () => {
    const sim = simulate({});
    const r = report(sim);
    expect(r.mode).toBe("standard");
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(["areas"]));
    expect(sim.written!.markdown).not.toContain("Mode: large");
    expect(sim.jobs.some((j) => commandIds(j).some((c) => c.startsWith("area-record") || c === "synthesis-record" || c.startsWith("answers-record")))).toBe(false);
    expect(sim.jobs.some((j) => j.resultSchema === "change-synthesis-v1")).toBe(false);
    expect(agents(sim, "change-report-v1").map((j) => j.jobId)).toEqual(["reporter"]);
    expect(JSON.parse(sim.qa!.json).mode).toBe("standard");
  });
});

describe("an area's report is validated and checked like a report", () => {
  it("corrects an area report that cites a file outside its area, continuing that area's own session", () => {
    const sim = run((s) => {
      const replies = s.results["change-report-v1"]!;
      const bad = structuredClone(replies[1]!) as { output: { sections: Array<{ items: Array<{ cites: Array<{ path: string }> }> }> } };
      bad.output.sections.flatMap((x) => x.items)[0]!.cites[0]!.path = "pkg/beta/beta.go";
      s.results["change-report-v1"] = [replies[0]!, bad as never, replies[1]!, replies[2]!];
    });
    const reporters = agents(sim, "change-report-v1");
    expect(reporters.map((j) => j.jobId)).toEqual(["reporter-A1", "reporter-A2", "reporter-A2", "reporter-A3"]);
    expect(reporters[1]!.continueFrom).toBeUndefined();
    expect(reporters[2]!.continueFrom).toMatch(/^op\d+$/);
    expect(assignmentOf(reporters[2]!)).toMatch(/failed deterministic validation[\s\S]*pkg\/beta\/beta.go, which is not a file of the pull request/);
    expect(report(sim).mode).toBe("large");
  });

  it("refuses an area report that writes a summary", () => {
    const sim = run((s) => {
      const replies = s.results["change-report-v1"]!;
      const bad = structuredClone(replies[0]!) as { output: { purpose: { text: string } } };
      bad.output.purpose.text = "A purpose the synthesis should have written.";
      s.results["change-report-v1"] = [bad as never, replies[0]!, replies[1]!, replies[2]!];
    });
    expect(assignmentOf(agents(sim, "change-report-v1")[1]!)).toContain("an area report leaves the summary empty");
  });

  it("revises an item the claim check does not support, and removes it, with its file in other, when the revision is not supported either", () => {
    const sim = run((s) => {
      const checks = s.results["claim-check-v1"]!;
      const unsupported = structuredClone(checks[2]!) as { output: { verdicts: Array<{ item: string; verdict: string; note: string; quotes: unknown[] }> } };
      const v = unsupported.output.verdicts.find((x) => x.item === "R1")!;
      v.verdict = "unsupported";
      v.note = "the diff does not show this";
      v.quotes = [];
      s.results["claim-check-v1"] = [checks[0]!, checks[1]!, unsupported as never, unsupported as never, checks[3]!];
      s.results["change-report-revision-v1"] = [s.results["change-report-v1"]![2]!];
      const synthesis = structuredClone(s.results["change-synthesis-v1"]![0]!) as { output: { merges: unknown[] } };
      synthesis.output.merges = [];
      s.results["change-synthesis-v1"] = [synthesis as never];
    });
    const revision = agents(sim, "change-report-revision-v1");
    expect(revision).toHaveLength(1);
    expect(revision[0]!.jobId).toBe("reporter-A3");
    expect(revision[0]!.continueFrom).toMatch(/^op\d+$/);
    const r = report(sim);
    expect(r.removed.map((x: { id: string; reason: string }) => x.id)).toEqual(["A3.R1"]);
    expect(r.removed[0].reason).toContain("unsupported: the diff does not show this");
    const other = r.sections.find((x: { id: string }) => x.id === "other").items.map((i: { text: string }) => i.text);
    expect(other).toContain("pkg/beta/beta.go changed (+13 −0 lines); not summarised");
    expect(r.merges).toEqual([]);
    expect(r.sections.find((x: { id: string }) => x.id === "features").items).toHaveLength(1);
  });
});

describe("the synthesis is validated and checked", () => {
  it("corrects a synthesis that merges an item no area reported, continuing its own session", () => {
    const sim = run((s) => {
      const good = s.results["change-synthesis-v1"]![0]! as { output: { merges: Array<{ items: string[] }> } };
      const bad = structuredClone(good);
      bad.output.merges[0]!.items = ["A2.R1", "A9.R4"];
      s.results["change-synthesis-v1"] = [bad as never, good as never];
    });
    const synthesis = agents(sim, "change-synthesis-v1");
    expect(synthesis).toHaveLength(2);
    expect(synthesis[1]!.jobId).toBe("synthesis");
    expect(synthesis[1]!.continueFrom).toMatch(/^op\d+$/);
    expect(assignmentOf(synthesis[1]!)).toContain('"A9.R4" is not an item id of the areas');
    expect(report(sim).merges).toHaveLength(1);
  });

  it("does not apply a merge the check does not support after one revision, and records it; the items stay separate", () => {
    const sim = run((s) => {
      const checks = s.results["claim-check-v1"]!;
      const unsupported = structuredClone(checks[3]!) as { output: { verdicts: Array<{ item: string; verdict: string; note: string }> } };
      const m = unsupported.output.verdicts.find((x) => x.item === "M1")!;
      m.verdict = "unsupported";
      m.note = "beta does not call alpha in the cited lines";
      s.results["claim-check-v1"] = [checks[0]!, checks[1]!, checks[2]!, unsupported as never, unsupported as never];
      s.results["change-synthesis-revision-v1"] = [s.results["change-synthesis-v1"]![0]!];
    });
    expect(agents(sim, "change-synthesis-revision-v1")).toHaveLength(1);
    const r = report(sim);
    expect(r.sections.find((x: { id: string }) => x.id === "features").items).toHaveLength(2);
    expect(r.merges).toEqual([{ id: "M1", items: ["A2.R1", "A3.R1"], into: null, reason: "unsupported: beta does not call alpha in the cited lines" }]);
    expect(r.removedParts).toEqual([{ id: "M1", kind: "merge", item: "", label: "A2.R1 + A3.R1", reason: "unsupported: beta does not call alpha in the cited lines" }]);
    expect(sim.written!.markdown).toContain("Merge not applied: the claim check could not support joining A2.R1 + A3.R1");
  });

  it("removes a purpose the check does not support, keeping the rest", () => {
    const sim = run((s) => {
      const checks = s.results["claim-check-v1"]!;
      const unsupported = structuredClone(checks[3]!) as { output: { verdicts: Array<{ item: string; verdict: string; note: string }> } };
      const p = unsupported.output.verdicts.find((x) => x.item === "overview")!;
      p.verdict = "partial";
      p.note = "names a mechanism no item has";
      s.results["claim-check-v1"] = [checks[0]!, checks[1]!, checks[2]!, unsupported as never, unsupported as never];
      s.results["change-synthesis-revision-v1"] = [s.results["change-synthesis-v1"]![0]!];
    });
    const r = report(sim);
    expect(r.summary.overview).toBeNull();
    expect(r.summary.purpose).not.toBeNull();
    expect(r.removedParts.map((x: { id: string }) => x.id)).toEqual(["overview"]);
  });
});

describe("the budget pre-check before the first reporter job (design §6.9)", () => {
  it("stops with the numbers when the run's remaining budgets cannot cover large mode, before any agent runs", () => {
    const sim = run(undefined, LARGE, { budgets: { jobs: 10 } });
    expect(stopOf(sim)).toMatchObject({ reason: "budgets exhausted", retryable: false });
    const blocker = stopOf(sim)!.blocker!;
    const need = largeNeeds(3);
    expect(blocker).toContain(`large mode needs at least ${need.agentInvocations} agent invocations, ${need.jobs} jobs and ${need.decisions} decisions for 3 area(s)`);
    expect(blocker).toContain("the run has 100, 10 and 100 left");
    expect(blocker).toContain("raise the profile's budgets (budgets.jobs)");
    expect(sim.jobs.some((j) => j.kind === "agent")).toBe(false);
  });

  it("runs when the budgets cover it, and names every budget that falls short", () => {
    expect(budgetShortfall(largeNeeds(3), { agentInvocations: 100, jobs: 100, decisions: 100 })).toBeUndefined();
    expect(budgetShortfall(largeNeeds(3), { agentInvocations: 1, jobs: 1, decisions: 1 })).toContain("budgets.agentInvocations, budgets.jobs, budgets.decisions");
  });

  it("is covered by the plugin's default budgets for a ten-area pull request, and stops a very large one", () => {
    const defaults = definitionFor(profileOf()).defaultBudgets!;
    const ten = largeNeeds(10);
    expect(ten).toMatchObject({ areas: 10, questions: 150, batches: 10, agentInvocations: 45, jobs: 98, decisions: 110 });
    expect(budgetShortfall(ten, { agentInvocations: defaults.agentInvocations!, jobs: defaults.jobs!, decisions: defaults.decisions! })).toBeUndefined();
    expect(budgetShortfall(largeNeeds(60), { agentInvocations: defaults.agentInvocations!, jobs: defaults.jobs!, decisions: defaults.decisions! })).toContain("budgets.jobs");
  });
});

describe("the limits (design §6.9)", () => {
  const refused = (limits: Record<string, unknown>): string => {
    try {
      parseProfile({ ...BANYANDB, limits });
      return "";
    } catch (err) {
      if (err instanceof ProfileError) return err.message;
      throw err;
    }
  };
  it("validates the new limits: positive integers, a max never over its hard cap, a minimum never over the area maximum", () => {
    expect(refused({ hardMaxFiles: 0 })).toMatch(/limits.hardMaxFiles must be a positive integer/);
    expect(refused({ maxFiles: 2000 })).toMatch(/limits.maxFiles \(2000\) must not exceed limits.hardMaxFiles \(1000\)/);
    expect(refused({ maxPatchBytes: 9 * 1024 * 1024 })).toMatch(/limits.maxPatchBytes .* must not exceed limits.hardMaxPatchBytes/);
    expect(refused({ maxNewSymbols: 3000 })).toMatch(/limits.maxNewSymbols \(3000\) must not exceed limits.hardMaxNewSymbols \(2000\)/);
    expect(refused({ areaMinBytes: 300_000 })).toMatch(/limits.areaMinBytes \(300000\) must not exceed limits.areaMaxBytes \(262144\)/);
    expect(refused({ areaMaxBytes: 0 })).toMatch(/limits.areaMaxBytes must be a positive integer/);
    expect(refused({ nope: 1 })).toMatch(/limits.nope/);
    expect(refused({ maxFiles: 5, hardMaxFiles: 5, areaMaxBytes: 10, areaMinBytes: 10 })).toBe("");
  });

  it("goes large, not refused, over maxFiles or maxPatchBytes, and refuses only over the hard caps", () => {
    const over = simulate({ config: { limits: { maxFiles: 3 } }, maxSteps: 250 });
    expect(stopOf(over)?.reason).toBe("report ready");
    expect(over.jobs.some((j) => j.resultSchema === "change-report-v1" && j.jobId?.startsWith("reporter-A"))).toBe(true);
    expect(report(over).modeReasons).toEqual([{ limit: "maxFiles", value: 5, max: 3 }]);
    const bytes = simulate({ config: { limits: { maxPatchBytes: 100 } }, maxSteps: 250 });
    expect(stopOf(bytes)?.reason).toBe("report ready");
    expect(report(bytes).modeReasons).toEqual([{ limit: "maxPatchBytes", value: expect.any(Number), max: 100 }]);
    expect(stopOf(simulate({ config: { limits: { maxFiles: 3, hardMaxFiles: 4 } } }))!.blocker).toMatch(/5 files, past the profile's limits.hardMaxFiles of 4/);
    expect(stopOf(simulate({ config: { limits: { maxPatchBytes: 50, hardMaxPatchBytes: 50 } } }))!.blocker).toMatch(/patches are \d+ bytes, past the profile's limits.hardMaxPatchBytes of 50/);
  });

  it("goes large for the questions alone over maxNewSymbols, keeping the standard report", () => {
    const sim = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, { limits: { maxNewSymbols: 3 } }), config: { limits: { maxNewSymbols: 3 } }, maxSteps: 250 });
    expect(stopOf(sim)!.reason).toBe("report ready");
    expect(report(sim).mode).toBe("standard");
    expect(agents(sim, "change-report-v1").map((j) => j.jobId)).toEqual(["reporter"]);
    const q = qa(sim);
    expect(q.mode).toBe("large");
    expect(q.modeReasons).toEqual([{ limit: "maxNewSymbols", value: 8, max: 3 }]);
    expect(q.questions.filter((x: { type: string; symbol?: string }) => x.type === "existing-equivalent" && x.symbol === undefined)).toHaveLength(2);
  });
});

/** The evidence a read leaves: one record per page of a list, with the producer the plugin matches. */
function page(pin: { id: string }, items: unknown[], p: { startCursor: string; nextCursor: string | null; complete: boolean }): EvidenceRecord {
  return { ref: `r-${pin.id}-${p.startCursor}`, kind: "other", payload: { producer: { operationId: "op", stageId: "fetch", purpose: "diagnostic", readOnly: true, kind: "command", executorId: pin.id }, github: { items, page: p } } };
}
const emptyList = (pin: { id: string }): EvidenceRecord => page(pin, [], { startCursor: "1", nextCursor: null, complete: true });
const fileItem = (path: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ path, status: "added", previousPath: null, additions: 1, deletions: 0, sha: null, patch: "@@ -0,0 +1 @@\n+x", patchOmitted: false, ...over });
const pullRecord: EvidenceRecord = {
  ref: "r-pull",
  kind: "other",
  payload: { producer: { operationId: "op", stageId: "fetch", purpose: "diagnostic", readOnly: true, kind: "command", executorId: GET_PULL.id }, github: { item: { number: 7, title: "t", state: "open", url: "u", body: "", author: "a", labels: [], head: { ref: "h", sha: REHEARSAL_HEAD }, base: { ref: "main", sha: "b".repeat(40) } } } },
};

describe("Fetch reads every file of a large pull request", () => {
  const pr = { mode: "report" as const, owner: "apache", repo: "skywalking-banyandb", number: 7, head: REHEARSAL_HEAD };
  const others = [LIST_PULL_COMMITS, LIST_PULL_REVIEWS, LIST_PULL_REVIEW_COMMENTS, LIST_REVIEW_THREADS, LIST_CHECK_RUNS].map(emptyList);
  const files = (from: number, n: number): unknown[] => Array.from({ length: n }, (_, i) => fileItem(`pkg/d${(from + i) % 9}/f${from + i}.go`));
  const limits = profileOf().limits;

  it("asks for the next page of the file list until the list is complete, then reads the pull request", () => {
    const first = page(LIST_PULL_FILES, files(0, 100), { startCursor: "1", nextCursor: "2", complete: false });
    expect(snapshotState([first], pr, limits)).toMatchObject({ state: "reading", cursor: "2", next: { key: "files" } });
    const second = page(LIST_PULL_FILES, files(100, 60), { startCursor: "2", nextCursor: null, complete: true });
    const s = snapshotState([first, second, ...others, pullRecord], pr, limits);
    expect(s.state).toBe("ready");
    if (s.state !== "ready") return;
    expect(s.snapshot.files).toHaveLength(160);
    expect(s.snapshot.mode).toEqual({ mode: "large", reasons: [{ limit: "maxFiles", value: 160, max: 150 }] });
    expect(s.snapshot.partition!.areas.flatMap((a) => a.paths)).toHaveLength(160);
    expect(readResult([first, second], READS[0]!)!.items).toHaveLength(160);
  });

  it("is standard, with no partition, at the limit", () => {
    const s = snapshotState([page(LIST_PULL_FILES, files(0, 100), { startCursor: "1", nextCursor: null, complete: true }), ...others, pullRecord], pr, limits);
    expect(s.state === "ready" && s.snapshot.mode.mode === "standard" && s.snapshot.partition === undefined).toBe(true);
  });

  it("records a file GitHub gave no patch for, never failing", () => {
    const omitted = fileItem("assets/big.bin", { patch: null, patchOmitted: true, additions: 9000 });
    const s = snapshotState([page(LIST_PULL_FILES, [...files(0, 3), omitted], { startCursor: "1", nextCursor: null, complete: true }), ...others, pullRecord], pr, { ...limits, maxFiles: 2, hardMaxFiles: 10 });
    expect(s.state).toBe("ready");
    if (s.state !== "ready") return;
    expect(s.snapshot.partition!.omitted).toEqual(["assets/big.bin"]);
    expect(s.snapshot.partition!.areas.flatMap((a) => a.paths)).not.toContain("assets/big.bin");
  });

  it("refuses only past a hard cap, naming it", () => {
    const s = snapshotState([page(LIST_PULL_FILES, files(0, 5), { startCursor: "1", nextCursor: null, complete: true }), ...others, pullRecord], pr, { ...limits, maxFiles: 2, hardMaxFiles: 4 });
    expect(s).toMatchObject({ state: "incompatible", problem: expect.stringContaining("5 files, past the profile's limits.hardMaxFiles of 4") });
  });
});

describe("the records the validators recompute a large report from", () => {
  const sim = run();
  const view = (evidence: EvidenceRecord[]): EvidenceRecord[] => candidateEvidence(evidence, "d1");
  const validate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: view(evidence), candidateDigest: "d1", config: { ...BANYANDB, ...LARGE } } as never);

  it("pass with only the newest review in view, as the controller hands them over", () => {
    expect(validate("change-report", sim.evidence).status).toBe("passed");
    expect(validate("claims-checked", sim.evidence).status).toBe("passed");
    expect(sim.evidence.filter((e) => e.kind === "review").length).toBeGreaterThan(view(sim.evidence).filter((e) => e.kind === "review").length);
  });

  it("fail when an area's recorded claim check no longer supports its report", () => {
    const evidence = sim.evidence.map((e): EvidenceRecord => {
      const command = (e.payload as { command?: { id: string; argv: string[] } }).command;
      if (e.kind !== "command" || command?.id !== "area-record-A2") return e;
      const record = JSON.parse(command.argv.slice(6, 6 + Number(command.argv[5])).join(""));
      record.check.verdicts[0].verdict = "unsupported";
      const next = recordCommand("area-record-A2", "areas", JSON.stringify(record))!;
      return { ...e, payload: { ...(e.payload as object), command: { ...command, argv: next.argv } } };
    });
    const result = validate("change-report", evidence);
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/the record of area A2 does not validate: its claim check found claims unsupported and the report was not revised/);
  });

  it("is not finished while a record is missing", () => {
    const evidence = sim.evidence.filter((e) => (e.payload as { command?: { id: string } }).command?.id !== "synthesis-record");
    expect(validate("change-report", evidence).status).toBe("inconclusive");
  });

  it("recomputes the report written to report.json", () => {
    const a = analyze(sim.evidence, profileOf(LARGE), evidencePull(sim.evidence, profileOf(LARGE))!);
    expect(a.state).toBe("ready");
  });

  it("round-trips a record through the write command's chunks", () => {
    const json = JSON.stringify({ text: "é".repeat(5000) });
    const command = recordCommand("area-record-A9", "areas", json)!;
    expect(command.argv.slice(6).join("")).toBe(json);
    expect(writeChunks(json).length).toBeGreaterThan(1);
  });
});

describe("batches of questions", () => {
  const q = (id: number, item: string): Question => ({ id: `Q${id}`, type: "other", item, text: "t", origin: "required", key: `k${id}` });
  const ids = (b: Question[][]): string[][] => b.map((x) => x.map((y) => y.id));

  it("groups the questions of a few items per batch, at most 15", () => {
    const qs = [...Array.from({ length: 6 }, (_, i) => q(i + 1, "R1")), ...Array.from({ length: 6 }, (_, i) => q(i + 7, "R2")), ...Array.from({ length: 6 }, (_, i) => q(i + 13, "R3"))];
    expect(ids(answerBatches(qs)).map((b) => b.length)).toEqual([12, 6]);
    expect(answerBatches(qs).map((b) => [...new Set(b.map((x) => x.item))])).toEqual([["R1", "R2"], ["R3"]]);
  });

  it("cuts an item with more than a batch's worth into runs, and keeps every question once, in order", () => {
    const qs = Array.from({ length: 40 }, (_, i) => q(i + 1, "R1"));
    expect(answerBatches(qs).map((b) => b.length)).toEqual([15, 15, 10]);
    expect(answerBatches(qs).flat().map((x) => x.id)).toEqual(qs.map((x) => x.id));
    expect(answerBatches([])).toEqual([]);
  });
});

describe("what the synthesis may merge", () => {
  const item = (key: string, section: string, over: Record<string, unknown> = {}): SynthItem => ({
    key,
    area: key.split(".")[0]!,
    section,
    item: { id: key.split(".")[1]!, text: `item ${key}`, cites: [{ path: `${key}.go`, side: "head", start: 1, end: 2, symbol: "" }], facts: [], state: [], behavior: [], ...over },
  });
  const summary = { purpose: { text: "p", source: "inferred" as const, quote: "" }, overview: "One sentence." };
  const all = [item("A1.R1", "features"), item("A2.R1", "features"), item("A2.R2", "config"), item("A1.R2", "features")];
  const problems = (merges: Array<{ items: string[]; text: string }>): string[] => synthesisProblems({ ...summary, merges, notes: [] }, all, []);

  it("accepts a merge of items of two areas in one section", () => {
    expect(problems([{ items: ["A1.R1", "A2.R1"], text: "joined" }])).toEqual([]);
  });

  it("refuses an unknown id, one id in two merges, a merge across sections or inside one area, and a lone item", () => {
    expect(problems([{ items: ["A1.R1", "A7.R1"], text: "x" }]).join("|")).toContain('"A7.R1" is not an item id');
    expect(problems([{ items: ["A1.R1", "A2.R1"], text: "x" }, { items: ["A2.R1", "A1.R2"], text: "y" }]).join("|")).toContain("A2.R1 is already in another merge");
    expect(problems([{ items: ["A1.R1", "A2.R2"], text: "x" }]).join("|")).toContain("different sections (features, config)");
    expect(problems([{ items: ["A1.R1", "A1.R2"], text: "x" }]).join("|")).toContain("joins items of one area");
    expect(problems([{ items: ["A1.R1"], text: "x" }]).join("|")).toContain("at least two items");
  });

  it("makes the merged item from the union of its members' cites, facts, state and behavior, telling colliding state names apart", () => {
    const entry = (name: string) => ({ name, scope: "per call", initial: "0", transitions: [], reads: [{ where: "w", decision: "d", cite: { path: "a.go", side: "head" as const, start: 1, end: 1, symbol: "" } }] });
    const a = item("A1.R1", "features", { facts: ["F1"], state: [entry("n")], behavior: [{ case: "c", before: "b", after: "a" }] });
    const b = item("A2.R1", "features", { facts: ["F1", "F2"], state: [entry("n"), entry("m")], behavior: [{ case: "d", before: "b", after: "a" }] });
    const m = mergedItem([a, b], "joined");
    expect(m.cites.map((c) => c.path)).toEqual(["A1.R1.go", "A2.R1.go"]);
    expect(m.facts).toEqual(["F1", "F2"]);
    expect(m.state.map((e) => e.name)).toEqual(["n", "n [A2]", "m"]);
    expect(m.behavior.map((r) => r.case)).toEqual(["c", "d"]);
  });

  it("refuses a merge whose union would pass the item's bounds", () => {
    const entry = (name: string) => ({ name, scope: "s", initial: "i", transitions: [], reads: [] });
    const many = (area: string): SynthItem => item(`${area}.R1`, "features", { state: Array.from({ length: 4 }, (_, i) => entry(`${area}${i}`)) });
    const list = [many("A1"), many("A2")];
    expect(synthesisProblems({ ...summary, merges: [{ items: ["A1.R1", "A2.R1"], text: "x" }], notes: [] }, list, []).join("|")).toContain("8 state entries, more than 6");
  });

  it("numbers the merged report R1... after the merges, with each removed part under its new id", () => {
    expect(assembleLarge).toBeTypeOf("function");
  });
});

describe("the requirements say what large mode does", () => {
  const d = definitionFor(profileOf());
  const text = (id: string): string => d.requirements.find((r) => r.id === id)!.statement;
  it("describes the snapshot, the report, the claim check, the questions and the answers", () => {
    expect(text("pr-snapshot")).toMatch(/hardMaxFiles|1000 files/);
    expect(text("pr-snapshot")).toContain("reviewed in large mode");
    expect(text("pr-snapshot")).toContain("partitioned into areas by a deterministic rule");
    expect(text("change-report")).toContain("one reporter job in a fresh read-only session for each area");
    expect(text("change-report")).toContain("change-synthesis-v1");
    expect(text("change-report")).toContain("stops with those numbers");
    expect(text("claims-checked")).toContain("a merge it does not support after one revision is not applied");
    expect(text("questions-complete")).toContain("once for each new exported symbol");
    expect(text("questions-complete")).toContain("missing-test is required once for each change item");
    expect(text("answers-complete")).toContain("batches of at most 15");
    expect(text("answers-complete")).toContain("written once, after the last batch");
    expect(text("answers-grounded")).toContain("fresh session");
  });
});
