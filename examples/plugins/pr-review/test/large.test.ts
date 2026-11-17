// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceRecord, JobSpec } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import { analyze, evidencePull } from "../src/kit/analysis.js";
import { LIST_CHECK_RUNS, GET_PULL, LIST_PULL_COMMITS, LIST_PULL_FILES, LIST_PULL_REVIEWS, LIST_PULL_REVIEW_COMMENTS, LIST_REVIEW_THREADS } from "../src/kit/constants.js";
import { definitionFor } from "../src/graph.js";
import { assembleReport, asReporterOutput, reportProblems } from "../src/kit/report.js";
import { pullFile } from "../src/kit/snapshot.js";
import { appendixHtmlFrom, reviewHtmlFrom } from "../src/html.js";
import { reporterSections } from "../src/kit/template.js";
import { budgetShortfall, largeNeeds } from "../src/kit/large.js";
import { largeReporterInstruction } from "../src/kit/largeprompts.js";
import { reporterInstruction } from "../src/kit/prompts.js";
import { partitionAreas } from "../src/kit/areas.js";
import { claimTargets, readClaimCheck } from "../src/kit/claims.js";
import { emptyBriefing } from "../src/kit/briefing.js";
import { readTreeQuotes, treeQuotePlan } from "../src/kit/treequotes.js";
import { ProfileError, parseProfile } from "../src/kit/profile.js";
import { LARGE_LIMITS, REHEARSAL_HEAD } from "../src/rehearsal.js";
import { readResult, READS, snapshotState } from "../src/kit/snapshot.js";
import { recordCommand, writeChunks } from "../src/kit/write.js";
import { validatorById } from "../src/validators.js";
import { recordedAspect, recordedScope } from "../src/reviewdraft.js";
import { BANYANDB, assignmentOf, candidateEvidence, profileOf, scenarioWith, simulate, type Simulation } from "./support.js";

const LARGE = { limits: LARGE_LIMITS };
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const run = (change?: (s: Parameters<typeof scenarioWith>[1] extends (s: infer S) => void ? S : never) => void, config: Record<string, unknown> = LARGE, extra: { budgets?: Record<string, number> } = {}): Simulation =>
  simulate({ scenario: scenarioWith("large-pull-request", change ?? (() => undefined), config), config, maxSteps: 250, ...(extra.budgets !== undefined ? { budgets: extra.budgets } : {}) });
const report = (sim: Simulation) => JSON.parse(sim.written!.json) as Record<string, any>;
const agents = (sim: Simulation, schema: string): JobSpec[] => sim.jobs.filter((j) => j.resultSchema === schema);
const harnessOf = (j: JobSpec): string => (j.input as { harness: string }).harness;
const commandIds = (j: JobSpec): string[] => ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id);
const items = (r: Record<string, any>): Array<Record<string, any>> => r.sections.flatMap((s: { items: unknown[] }) => s.items);


describe("a large pull request, reported at a high level (design §6.9)", () => {
  const sim = run();

  it("runs to the end: every receipt valid, one report", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
    expect(sim.receipts.map((r) => r.stageId).filter((s, i, a) => a.indexOf(s) === i)).toEqual(["fetch", "report", "review", "draft", "publish"]);
  });

  it("makes exactly one reporter job and one claim check: no area job, no synthesis, no record", () => {
    const reporters = agents(sim, "change-report-v1");
    expect(reporters.map((j) => j.jobId)).toEqual(["reporter"]);
    expect(reporters[0]!.continueFrom).toBeUndefined();
    expect(reporters[0]!.readOnly).toBe(true);
    expect(harnessOf(reporters[0]!)).toBe(profileOf(LARGE).roles.reporter);
    const checks = sim.jobs.filter((j) => j.stageId === "report" && j.resultSchema === "claim-check-v1");
    expect(checks).toHaveLength(1);
    expect(checks[0]!.purpose).toBe("review");
    expect(checks[0]!.continueFrom).toBeUndefined();
    expect(harnessOf(checks[0]!)).toBe(profileOf(LARGE).roles["report-checker"]);
    expect(sim.jobs.some((j) => j.resultSchema === "change-synthesis-v1" || j.resultSchema === "change-synthesis-revision-v1")).toBe(false);
    expect(sim.jobs.some((j) => j.jobId?.startsWith("reporter-A") === true || j.jobId === "synthesis")).toBe(false);
    expect(sim.jobs.some((j) => commandIds(j).some((c) => c.startsWith("area-record") || c === "synthesis-record"))).toBe(false);
    expect(definitionFor(profileOf(LARGE)).resultContracts!.map((c) => c.name)).not.toContain("change-synthesis-v1");
  });

  it("gives the reporter a high-level digest: the PR text, the areas, the file list, the detector facts and the names of the new exported symbols", () => {
    const a = assignmentOf(agents(sim, "change-report-v1")[0]!);
    expect(a).toContain("describe the pull request at a high level");
    expect(a).toContain("They will ask for any area they want to dig into, so do not read the detail of each area");
    expect(a).toContain('<untrusted source="pull request title">');
    expect(a).toContain('<untrusted source="commit messages">');
    expect(a).toMatch(/Areas and changed files \(4 area\(s\), 5 file\(s\)/);
    expect(a).toMatch(/A2 pkg\/alpha — 1 file\(s\), \+\d+ −0, \d+ patch bytes; new exported symbols: Alpha1, Alpha2, Alpha3, Alpha4, Alpha5, Alpha6\n/);
    expect(a).toMatch(/A3 pkg\/beta — 1 file\(s\), \+13 −0, \d+ patch bytes; new exported symbols: Beta\n/);
    expect(a).toContain("  pkg/beta/beta.go — added, +13 −0");
    expect(a).toContain("generated code: do not cite it");
    expect(a).toMatch(/Detector facts \(\d+\)/);
    // The briefing first, then the template sections, no lifecycle required.
    expect(a).toContain("The first fields of your result are a briefing");
    expect(a.indexOf("The first fields of your result are a briefing")).toBeLessThan(a.indexOf("The template."));
    expect(a).not.toContain("architecture");
    expect(a).toContain("State and behavior are not required in this report");
    expect(a).toContain("text is at most 600 characters");
    expect(a).not.toContain("at most 900 characters, which");
    // The reporter may open any file read-only to confirm a claim.
    expect(a).toContain("open any file of the head or of the base, read-only");
  });

  it("gives the patches of the interface files only, not the other patches", () => {
    const a = assignmentOf(agents(sim, "change-report-v1")[0]!);
    expect(a).toContain('<untrusted source="patch of docs/guide.md">');
    expect(a).toContain("Alpha and Beta add numbers.");
    expect(a).toMatch(/Patches of the interface files \(1 of 1;/);
    expect(a).not.toContain("+\treturn x + 1");
    expect(a).not.toContain("alpha.Alpha1(alpha.Alpha1(x))");
    expect(a).not.toContain("<untrusted source=\"patch of pkg/");
  });

  it("asks the checker to quote from the trees the cites name, and verifies the quotes there", () => {
    const check = assignmentOf(sim.jobs.find((j) => j.resultSchema === "claim-check-v1" && j.stageId === "report")!);
    expect(check).toContain("the report below is a high-level one");
    expect(check).toContain("The quotes are matched against that file, not against the diff");
    const verify = sim.jobs.filter((j) => j.stageId === "report" && commandIds(j).some((c) => c.startsWith("tree-quote-")));
    expect(verify.length).toBeGreaterThan(0);
  });

  it("keeps the report's items at one per change, with no merge and no area record, and numbers them R1... in section order", () => {
    const r = report(sim);
    expect(r.merges).toBeUndefined();
    expect(items(r).map((i) => i.id)).toEqual(items(r).map((_, n) => `R${n + 1}`));
    expect(r.summary.purpose).toMatchObject({ source: "stated", quote: "Add alpha and beta helpers" });
    expect(r.removed).toEqual([]);
    expect(r.briefing.features.map((f: { stages: Array<{ id: string }> }) => f.stages.map((st) => st.id))).toEqual([["alpha", "beta"]]);
  });

  it("records the mode and its reason in report.json, the areas with their sizes, and shows it in the header of review.md", () => {
    const r = report(sim);
    expect(r.mode).toBe("large");
    expect(r.modeReasons).toEqual([{ limit: "maxFiles", value: 5, max: 2 }]);
    expect(r.areas.map((a: { id: string; name: string; kind: string }) => [a.id, a.name, a.kind])).toEqual([
      ["A1", "docs", "read"],
      ["A2", "pkg/alpha", "read"],
      ["A3", "pkg/beta", "read"],
      ["generated", "generated", "generated"],
    ]);
    expect(r.areas.find((a: { id: string }) => a.id === "A3")).toMatchObject({ additions: 13, deletions: 0, items: 1 });
    expect(sim.written!.markdown.split("\n")[2]).toBe("Mode: large (5 files, over the limit of 2): reported at a high level from a digest of its 3 areas; generated files are listed in Other, not read; 1 file(s) without a patch from GitHub are listed in Other.");
  });

  it("lists the generated files and a file GitHub gave no patch for in other, never failing", () => {
    const r = report(sim);
    const other = r.sections.find((s: { id: string }) => s.id === "other").items.map((i: { text: string }) => i.text);
    expect(other).toContain("api/gen/types.pb.go changed (+5 −0 lines); generated code, not summarised");
    expect(other).toContain("assets/logo.png changed (+1 −0 lines); patch not provided by GitHub");
    expect(r.omitted).toEqual(["assets/logo.png"]);
    expect(stopOf(sim)!.reason).toBe("complete");
  });

  it("lists the areas in the briefing, with the reporter's label for each and the command that opens the reporter's session", () => {
    const md = sim.written!.markdown;
    expect(md).toContain("## Areas (dive into an area)");
    expect(md).toContain("graphloom session open <run> --stage report");
    expect(md).toContain("already has the pull request's digest and can read any file");
    expect(md).toMatch(/\| Area \| What it is \| Files \| Lines \|\n\|---\|---\|---\|---\|\n\| A1 \| changes under docs \| 1 \|/);
    expect(md).toContain("| generated | generated code (generated) | 1 |");
    // It is part of the briefing: before the open questions and the appendix.
    expect(md.indexOf("## Areas")).toBeGreaterThan(md.indexOf("## What you need to check"));
    expect(md.indexOf("## Areas")).toBeLessThan(md.indexOf("# Appendix"));
    // The areas are text, so they are in the appendix; review.html shows them as the risk map.
    const html = appendixHtmlFrom(sim.written!.json)!;
    expect(html).toContain("<h2>Areas</h2>");
    expect(html).toContain("<pre><code>graphloom session open &lt;run&gt; --stage report</code></pre>");
    expect(html).toContain("<td>A2</td><td>changes under pkg/alpha</td><td>1</td>");
  });

  it("reviews the areas the briefing cites, and computes the leads of their files from the measurements and the test map", () => {
    const scope = recordedScope(sim.evidence);
    if (scope.state !== "read") throw new Error("no scope record");
    expect(scope.value).toMatchObject({ mode: "large", contextSource: "prelude" });
    expect(scope.value.areas.length).toBeGreaterThan(0);
    const m = recordedAspect(sim.evidence, "maintainability");
    if (m.state !== "read") throw new Error("no maintainability record");
    for (const l of m.value.leads) expect(scope.value.files).toContain(l.path);
    expect(m.value.leads.every((l) => l.status === "not-an-issue" || l.status === "raised")).toBe(true);
  });

  it("shows every function in the measurements, the over-limit ones included", () => {
    const m = report(sim).measurements;
    expect(m.records.length).toBeGreaterThanOrEqual(8);
  });

});


describe("standard mode is what it was", () => {
  it("records mode standard only, with no areas, no header line, no dive-in block and no synthesis", () => {
    const sim = simulate({});
    const r = report(sim);
    expect(r.mode).toBe("standard");
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(["areas"]));
    expect(sim.written!.markdown).not.toContain("Mode: large");
    expect(sim.written!.markdown).not.toContain("Dive into an area");
    expect(sim.jobs.some((j) => commandIds(j).some((c) => c.startsWith("area-record") || c === "synthesis-record" || c.startsWith("answers-record")))).toBe(false);
    expect(sim.jobs.some((j) => j.resultSchema === "change-synthesis-v1")).toBe(false);
    expect(agents(sim, "change-report-v1").map((j) => j.jobId)).toEqual(["reporter"]);
  });
});


describe("the large report is validated and checked like a report, with the high-level allowances", () => {
  it("corrects a report that cites a file outside the pull request, continuing the reporter's own session", () => {
    const sim = run((s) => {
      const good = s.results["change-report-v1"]![0]!;
      const bad = structuredClone(good) as { output: { sections: Array<{ items: Array<{ cites: Array<{ path: string }> }> }> } };
      bad.output.sections.flatMap((x) => x.items)[0]!.cites[0]!.path = "pkg/gamma/gamma.go";
      s.results["change-report-v1"] = [bad as never, good];
    });
    const reporters = agents(sim, "change-report-v1");
    expect(reporters.map((j) => j.jobId)).toEqual(["reporter", "reporter"]);
    expect(reporters[0]!.continueFrom).toBeUndefined();
    expect(reporters[1]!.continueFrom).toMatch(/^op\d+$/);
    expect(assignmentOf(reporters[1]!)).toMatch(/failed deterministic validation[\s\S]*pkg\/gamma\/gamma.go, which is not a file of the pull request/);
    expect(report(sim).mode).toBe("large");
  });

  it("does not require a changed file to be cited or a detector fact to be listed, which a standard report does; the plugin accounts for them in other", () => {
    const sections = reporterSections(profileOf(LARGE));
    const files = ["pkg/a.go", "docs/guide.md"].map((path) => pullFile({ path, status: "added", previousPath: null, additions: 1, deletions: 0, sha: null, patch: "@@ -0,0 +1 @@\n+x := 1", patchOmitted: false })!);
    const fact = { id: "D1", section: "other", path: "docs/guide.md", side: "head" as const, line: 1, text: "File routed to this section: docs/guide.md added" };
    const cite = { path: "pkg/a.go", side: "head" as const, start: 1, end: 1, symbol: "" };
    const report = { purpose: { text: "t", source: "inferred" as const, quote: "" }, overview: "One.", sections: sections.map((s, i) => ({ id: s.id, none: i !== 0, items: i === 0 ? [{ text: "adds a", cites: [cite], facts: [], state: [], behavior: [] }] : [] })), notes: [], ...emptyBriefing(), whatsNew: [{ text: "Adds a.", cites: [cite], title: "Package a: adds a", overview: "There was no a; now there is.", coreFiles: ["pkg/a.go"], feature: "" }] };
    const ctx = { sections, files, facts: [fact] };
    expect(reportProblems(report, ctx).join("|")).toMatch(/changed file\(s\) no item cites: docs\/guide.md/);
    expect(reportProblems(report, ctx).join("|")).toMatch(/detector fact\(s\) no item of their section lists/);
    expect(reportProblems(report, { ...ctx, large: true })).toEqual([]);
    const final = assembleReport(report, new Map(), { ...ctx, large: true });
    const other = final.sections.find((x) => x.id === "other")!.items.map((i) => i.text);
    expect(other).toEqual(["Detected: File routed to this section: docs/guide.md added. No item of the high-level report lists it (or its item was removed by the claim check)."]);
    expect(reportProblems(asReporterOutput(final), { ...ctx, large: true }, { final: true })).toEqual([]);
  });

  it("revises an item the claim check does not support, and removes it, with its file in other, when the revision is not supported either", () => {
    const sim = run((s) => {
      const checks = s.results["claim-check-v1"]!;
      const unsupported = structuredClone(checks[0]!) as { output: { verdicts: Array<{ item: string; verdict: string; note: string; quotes: unknown[] }> } };
      const v = unsupported.output.verdicts.find((x) => x.item === "R3")!;
      v.verdict = "unsupported";
      v.note = "the diff does not show this";
      v.quotes = [];
      s.results["claim-check-v1"] = [unsupported as never, unsupported as never];
      s.results["change-report-revision-v1"] = [s.results["change-report-v1"]![0]!];
      // One quote fewer is verified in the tree (the unsupported claim's), so the canned check answers for one fewer.
      for (const [k, c] of Object.entries(s.commands ?? {})) {
        if (!k.startsWith("tree-quote-")) continue;
        const n = Number(/checked (\d+)/.exec(c.stdout ?? "")![1]) - 1;
        s.commands![k] = { ...c, stdout: `${Array.from({ length: n }, (_x, i) => `${i + 1} ok`).join("\n")}\nchecked ${n}\n` };
      }
    });
    const revision = agents(sim, "change-report-revision-v1");
    expect(revision).toHaveLength(1);
    expect(revision[0]!.jobId).toBe("reporter");
    expect(revision[0]!.continueFrom).toMatch(/^op\d+$/);
    const r = report(sim);
    expect(r.removed.map((x: { id: string }) => x.id)).toEqual(["R3"]);
    expect(r.removed[0].reason).toContain("unsupported: the diff does not show this");
    expect(sim.jobs.filter((j) => j.resultSchema === "claim-check-v1" && j.stageId === "report")).toHaveLength(2);
  });
});

describe("the quotes of a large report are verified against the trees its cites name (design §6.9, §6.4)", () => {
  const sections = reporterSections(profileOf(LARGE));
  const file = pullFile({ path: "pkg/a.go", status: "modified", previousPath: null, additions: 1, deletions: 0, sha: null, patch: "@@ -10,2 +10,3 @@\n a\n+b := 1\n c", patchOmitted: false })!;
  const cite = { path: "pkg/a.go", side: "head" as const, start: 11, end: 11, symbol: "" };
  const quoted = {
    purpose: { text: "t", source: "inferred" as const, quote: "" },
    overview: "One.",
    sections: sections.map((s, i) => ({ id: s.id, none: i !== 0, items: i === 0 ? [{ text: "adds b", cites: [cite], facts: [], state: [], behavior: [] }] : [] })),
    notes: [],
    ...emptyBriefing(),
  };
  const reply = (verdicts: unknown[]) => ({ verdicts });
  const supported = (item: string, quotes: unknown[]) => ({ item, verdict: "supported", note: "", quotes });
  const all = (quote: unknown) => reply(claimTargets(quoted, { sections }, { treeQuotes: true }).map((t) => supported(t.id, t.quotes === "none" ? [] : [quote])));

  it("marks every claim that names no tree of its own to be checked against the trees its cites name", () => {
    const targets = claimTargets(quoted, { sections }, { treeQuotes: true });
    expect(targets.filter((t) => t.quotes === "required").every((t) => t.treeByCite === true)).toBe(true);
    expect(claimTargets(quoted, { sections }).some((t) => t.treeByCite === true)).toBe(false);
  });

  it("accepts a citation outside any patch when the tree shows the quote, by the tree and not the patch", () => {
    // The quote's line (99) is in no hunk of the patch: patch matching would refuse it.
    const out = all({ path: "pkg/a.go", line: 99, text: "func outsideThePatch() {" });
    const patchOnly = readClaimCheck(out, claimTargets(quoted, { sections }), [file]);
    expect("problems" in patchOnly ? [] : [...patchOnly.weak.keys()]).toContain("R1");
    const reading = readClaimCheck(out, claimTargets(quoted, { sections }, { treeQuotes: true }), [file]);
    if ("problems" in reading) throw new Error(reading.problems.join());
    expect(reading.weak.size).toBe(0);
    expect(reading.treeQuotes.find((q) => q.id === "R1")).toEqual({ id: "R1", tree: "head", quotes: [{ path: "pkg/a.go", line: 99, text: "func outsideThePatch() {" }] });
    // The tree decides: its check shows the quote (ok) or not (nomatch).
    const plan = treeQuotePlan(reading.treeQuotes, "base0");
    const outputs = (verdict: string): string[] => plan.commands.map((_, k) => `${Array.from({ length: plan.sizes[k]! }, (_x, i) => `${i + 1} ${verdict}`).join("\n")}\nchecked ${plan.sizes[k]}\n`);
    expect(readTreeQuotes(plan, outputs("ok")).size).toBe(0);
    expect([...readTreeQuotes(plan, outputs("nomatch")).keys()]).toContain("R1");
    expect(readTreeQuotes(plan, outputs("nomatch")).get("R1")).toMatch(/unsupported: its quote .* is not in the head tree at pkg\/a.go:99/);
  });

  it("verifies a quote of a base-side cite against the base tree, and refuses a quote from a file the claim does not cite", () => {
    const baseCite = { ...cite, side: "base" as const };
    const r2 = { ...quoted, sections: quoted.sections.map((s, i) => (i === 0 ? { ...s, items: [{ ...s.items[0]!, cites: [baseCite] }] } : s)) };
    const ok = readClaimCheck(reply(claimTargets(r2, { sections }, { treeQuotes: true }).map((t) => supported(t.id, t.quotes === "none" ? [] : [{ path: "pkg/a.go", line: 12, text: "a quote of the base" }]))), claimTargets(r2, { sections }, { treeQuotes: true }), [file]);
    if ("problems" in ok) throw new Error(ok.problems.join());
    expect(ok.treeQuotes.find((q) => q.id === "R1")!.tree).toBe("base");
    const elsewhere = readClaimCheck(all({ path: "pkg/other.go", line: 3, text: "a quote of another file" }), claimTargets(quoted, { sections }, { treeQuotes: true }), [file]);
    if ("problems" in elsewhere) throw new Error(elsewhere.problems.join());
    expect(elsewhere.weak.get("R1")).toMatch(/a quote is not from a file its cite names \(pkg\/other.go\)/);
  });

  it("refuses a supported verdict with no quote, or with a quote that is too short, in the tree check as in the patch check", () => {
    const none = readClaimCheck(reply(claimTargets(quoted, { sections }, { treeQuotes: true }).map((t) => supported(t.id, []))), claimTargets(quoted, { sections }, { treeQuotes: true }), [file]);
    if ("problems" in none) throw new Error(none.problems.join());
    expect(none.weak.get("R1")).toBe("supported without a quote");
    const short = readClaimCheck(all({ path: "pkg/a.go", line: 11, text: "b := 1" }), claimTargets(quoted, { sections }, { treeQuotes: true }), [file]);
    if ("problems" in short) throw new Error(short.problems.join());
    expect(short.weak.get("R1")).toMatch(/shorter than 8/);
  });

  it("makes the large run's claim check unsupported when the tree does not show the quote, through the whole flow", () => {
    const sim = run((s) => {
      for (const [k, v] of Object.entries(s.commands ?? {})) if (k.startsWith("tree-quote-")) s.commands![k] = { ...v, stdout: (v.stdout ?? "").replaceAll(" ok\n", " nomatch\n") };
      s.results["change-report-revision-v1"] = [s.results["change-report-v1"]![0]!];
    });
    expect(agents(sim, "change-report-revision-v1")).toHaveLength(1);
    const r = report(sim);
    expect(r.removed.length).toBeGreaterThan(0);
    expect(r.removed[0].reason).toMatch(/^unsupported: its quote .* is not in the head tree at .* \(within three lines\)/);
  });
});

describe("the budget pre-check before the reporter job (design §6.9)", () => {
  it("stops with the numbers when the run's remaining budgets cannot cover large mode, before any agent runs", () => {
    const sim = run(undefined, LARGE, { budgets: { jobs: 10 } });
    expect(stopOf(sim)).toMatchObject({ reason: "budgets exhausted", retryable: false });
    const blocker = stopOf(sim)!.blocker!;
    const need = largeNeeds(3);
    expect(blocker).toContain(`large mode needs at least ${need.agentInvocations} agent invocations, ${need.jobs} jobs and ${need.decisions} decisions for 3 area(s)`);
    expect(blocker).toContain("one reporter and one claim check");
    expect(blocker).toContain("the run has 100, 10 and 100 left");
    expect(blocker).toContain("raise the profile's budgets (budgets.jobs)");
    expect(sim.jobs.some((j) => j.kind === "agent")).toBe(false);
  });

  it("runs when the budgets cover it, and names every budget that falls short", () => {
    expect(budgetShortfall(largeNeeds(3), { agentInvocations: 100, jobs: 100, decisions: 100 })).toBeUndefined();
    expect(budgetShortfall(largeNeeds(3), { agentInvocations: 1, jobs: 1, decisions: 1 })).toContain("budgets.agentInvocations, budgets.jobs, budgets.decisions");
  });

  it("counts one reporter, one check and the quote commands, not an area's jobs, and is covered by the default budgets for a ten-area pull request", () => {
    const defaults = definitionFor(profileOf()).defaultBudgets!;
    const ten = largeNeeds(10);
    // Three questions per high-level change (purpose, existing-reuse-common, missing-test), at most five changes: 15 questions in one batch,
    // whatever the number of areas. 2 (reporter, check) + 1 questioner + 2 N1 + 1 batch of 2 + 2 diagrams = 9 agent invocations.
    expect(ten).toMatchObject({ areas: 10, questions: 15, batches: 1, agentInvocations: 9, jobs: 51, decisions: 63 });
    expect(largeNeeds(1)).toEqual({ ...ten, areas: 1 });
    expect(budgetShortfall(ten, { agentInvocations: defaults.agentInvocations!, jobs: defaults.jobs!, decisions: defaults.decisions! })).toBeUndefined();
    expect(budgetShortfall(ten, { agentInvocations: 1, jobs: 1, decisions: 1 })).toContain("budgets.jobs");
  });

  it("completes a large simulated run end to end within the plugin's default budgets", () => {
    const defaults = definitionFor(profileOf(LARGE)).defaultBudgets!;
    const sim = run(undefined, LARGE, { budgets: { agentInvocations: defaults.agentInvocations!, jobs: defaults.jobs!, decisions: defaults.decisions! } });
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(sim.receipts.every((r) => r.valid)).toBe(true);
    expect(sim.jobs.filter((j) => j.kind === "agent").length).toBeLessThanOrEqual(defaults.agentInvocations!);
    expect(sim.jobs.length).toBeLessThanOrEqual(defaults.jobs!);
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
    expect(stopOf(over)?.reason).toBe("complete");
    expect(assignmentOf(over.jobs.find((j) => j.resultSchema === "change-report-v1")!)).toContain("describe the pull request at a high level");
    expect(report(over).modeReasons).toEqual([{ limit: "maxFiles", value: 5, max: 3 }]);
    const bytes = simulate({ config: { limits: { maxPatchBytes: 100 } }, maxSteps: 250 });
    expect(stopOf(bytes)?.reason).toBe("complete");
    expect(report(bytes).modeReasons).toEqual([{ limit: "maxPatchBytes", value: expect.any(Number), max: 100 }]);
    expect(stopOf(simulate({ config: { limits: { maxFiles: 3, hardMaxFiles: 4 } } }))!.blocker).toMatch(/5 files, past the profile's limits.hardMaxFiles of 4/);
    expect(stopOf(simulate({ config: { limits: { maxPatchBytes: 50, hardMaxPatchBytes: 50 } } }))!.blocker).toMatch(/patches are \d+ bytes, past the profile's limits.hardMaxPatchBytes of 50/);
  });

  it("runs no search and computes no reuse lead over maxNewSymbols, keeping the standard report", () => {
    const sim = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, { limits: { maxNewSymbols: 3 } }), config: { limits: { maxNewSymbols: 3 } }, maxSteps: 250 });
    expect(stopOf(sim)!.reason).toBe("complete");
    expect(report(sim).mode).toBe("standard");
    expect(agents(sim, "change-report-v1").map((j) => j.jobId)).toEqual(["reporter"]);
    expect(sim.jobs.flatMap(commandIds).filter((id) => id.startsWith("search-"))).toEqual([]);
    const m = recordedAspect(sim.evidence, "maintainability");
    if (m.state !== "read") throw new Error("no maintainability record");
    expect(m.value.leads.filter((l) => l.kind === "reuse")).toEqual([]);
    const within = simulate({ scenario: scenarioWith("large-pull-request", () => undefined, {}), config: {}, maxSteps: 250 });
    expect(within.jobs.flatMap(commandIds).filter((id) => id.startsWith("search-")).length).toBeGreaterThan(0);
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


describe("the evidence the validators recompute a large report from", () => {
  const sim = run();
  const view = (evidence: EvidenceRecord[]): EvidenceRecord[] => candidateEvidence(evidence, "d1");
  const validate = (id: string, evidence: EvidenceRecord[]) => validatorById(id)!.evaluate({ requirementId: id, statement: "", evidence: view(evidence), candidateDigest: "d1", config: { ...BANYANDB, ...LARGE } } as never);

  // What the controller hands the validators when the Report stage is validated: the evidence up to the last Report job.
  const atReport = (evidence: EvidenceRecord[]): EvidenceRecord[] => {
    const last = evidence.map((e, i) => ((e.payload as { producer?: { stageId?: string } } | undefined)?.producer?.stageId === "report" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    return evidence.slice(0, last + 1);
  };

  it("pass with only the newest review in view, as the controller hands them over when the Report stage is validated", () => {
    expect(validate("change-report", atReport(sim.evidence)).status).toBe("passed");
    expect(validate("claims-checked", atReport(sim.evidence)).status).toBe("passed");
  });

  it("fail when the claim check no longer supports the report, and when the written review.md is not the report the evidence recomputes", () => {
    const unsupported = atReport(sim.evidence).map((e): EvidenceRecord => {
      if (e.resultSchema !== "claim-check-v1") return e;
      const p = e.payload as { verdicts: Array<{ verdict: string }> };
      return { ...e, payload: { ...p, verdicts: p.verdicts.map((v, i) => (i === 2 ? { ...v, verdict: "unsupported" } : v)) } };
    });
    expect(validate("claims-checked", unsupported).status).not.toBe("passed");
    const dropped = atReport(sim.evidence).filter((e) => (e.payload as { command?: { id: string } }).command?.id !== "report-write");
    expect(validate("change-report", dropped).status).toBe("inconclusive");
  });

  it("recomputes the report written to report.json", () => {
    const a = analyze(sim.evidence, profileOf(LARGE), evidencePull(sim.evidence, profileOf(LARGE))!);
    expect(a.state).toBe("ready");
    if (a.state === "ready") expect(a.analysis.ctx.large).toBe(true);
  });

  it("round-trips a record through the write command's chunks", () => {
    const json = JSON.stringify({ text: "é".repeat(5000) });
    const command = recordCommand("answers-record-9", "answers", json)!;
    expect(command.argv.slice(6).join("")).toBe(json);
    expect(writeChunks(json).length).toBeGreaterThan(1);
  });
});


describe("the requirements say what large mode does", () => {
  const d = definitionFor(profileOf());
  const text = (id: string): string => d.requirements.find((r) => r.id === id)!.statement;
  it("describes the snapshot, the report and the claim check", () => {
    expect(text("pr-snapshot")).toMatch(/hardMaxFiles|1000 files/);
    expect(text("pr-snapshot")).toContain("reviewed in large mode");
    expect(text("pr-snapshot")).toContain("partitioned into areas by a deterministic rule");
    expect(text("change-report")).toContain("In large mode (over the profile's maxFiles or maxPatchBytes) one reporter job is given a bounded digest");
    expect(text("change-report")).toContain("an item's text is at most 600 characters");
    expect(text("change-report")).not.toContain("change-synthesis-v1");
    expect(text("claims-checked")).toContain("in large mode against the trees its cites name");
    expect(text("code-review")).toContain("in large mode it is the files of the areas");
    expect(text("leads-judged")).toContain("none past 200 new symbols");
  });
});

describe("the unread files of a large report", () => {
  it("lists a generated file with its diffstat and reason in other even when a detector fact on it makes an item", () => {
    const sections = reporterSections(profileOf());
    const file = pullFile({ path: "api/gen/x.pb.go", status: "removed", previousPath: null, additions: 0, deletions: 2, sha: null, patch: "@@ -1,2 +0,0 @@\n-package gen\n-type X struct{}", patchOmitted: false })!;
    const fact = { id: "F1", section: "removed", path: "api/gen/x.pb.go", side: "base" as const, line: 1, text: "deleted api/gen/x.pb.go" };
    const final = assembleReport({ sections: sections.map((s) => ({ id: s.id, none: true, items: [] })), notes: [] }, new Map(), { sections, files: [file], facts: [fact], unread: new Map([["api/gen/x.pb.go", "generated code, not summarised"]]) });
    const text = (id: string) => final.sections.find((s) => s.id === id)!.items.map((i) => i.text);
    expect(text("removed")).toHaveLength(1);
    expect(text("other")).toEqual(["api/gen/x.pb.go changed (+0 −2 lines); generated code, not summarised"]);
  });
});


describe("the item limit and the roles of large mode", () => {
  const sim = run();
  const std = simulate({});
  const options = (j: JobSpec): unknown => (j.input as { harnessOptions?: unknown }).harnessOptions;

  it("states 600 characters in the large-mode prompt as in the standard one: no 900-character limit", () => {
    expect(assignmentOf(agents(sim, "change-report-v1")[0]!)).toContain("text is at most 600 characters");
    expect(assignmentOf(agents(std, "change-report-v1")[0]!)).toContain("text is at most 600 characters");
    expect(assignmentOf(agents(sim, "change-report-v1")[0]!)).not.toMatch(/900 characters, which|text is at most 900/);
    const ctx = { sections: reporterSections(profileOf(LARGE)), files: [pullFile({ path: "pkg/a.go", status: "modified", patch: "@@ -1,1 +1,2 @@\n a\n+b", previousPath: null, additions: 1, deletions: 0, patchOmitted: false })!], facts: [], large: true };
    const item = (n: number) => ({ id: "x", text: "x".repeat(n), cites: [{ path: "pkg/a.go", side: "head" as const, start: 1, end: 1, symbol: "" }], facts: [], state: [], behavior: [] });
    const rep = (n: number) => ({ sections: ctx.sections.map((s, i) => (i === 0 ? { id: s.id, none: false, items: [item(n)] } : { id: s.id, none: true, items: [] })), notes: [] });
    expect(reportProblems(rep(600), ctx, { summary: false }).join()).not.toMatch(/characters, more than/);
    expect(reportProblems(rep(650), ctx, { summary: false }).join()).toMatch(/650 characters, more than 600/);
  });

  it("runs the one reporter job on the reporter role (opus, high) and the check on the report-checker (medium)", () => {
    expect(options(agents(sim, "change-report-v1")[0]!)).toEqual({ model: "opus", effort: "high" });
    for (const j of sim.jobs.filter((x) => x.resultSchema === "claim-check-v1")) expect(options(j)).toEqual({ effort: "medium" });
    expect(options(agents(std, "change-report-v1")[0]!)).toEqual({ model: "opus", effort: "high" });
  });

});

describe("quotes of a file cited on both sides, and of before/after rows (design §6.9)", () => {
  const sections = reporterSections(profileOf(LARGE));
  const file = pullFile({ path: "pkg/a.go", status: "modified", previousPath: null, additions: 1, deletions: 1, sha: null, patch: "@@ -1,2 +1,2 @@\n-old := 1\n+new := 2\n c", patchOmitted: false })!;
  const head = { path: "pkg/a.go", side: "head" as const, start: 1, end: 1, symbol: "" };
  const base = { ...head, side: "base" as const };
  const reportWith = (item: Record<string, unknown>) => ({
    purpose: { text: "t", source: "inferred" as const, quote: "" },
    overview: "One.",
    sections: sections.map((s, i) => ({ id: s.id, none: i !== 0, items: i === 0 ? [{ text: "changes a", cites: [head], facts: [], state: [], behavior: [], ...item }] : [] })),
    notes: [],
    ...emptyBriefing(),
  });
  const read = (r: ReturnType<typeof reportWith>, text: string, claim = "R1") => {
    const targets = claimTargets(r, { sections }, { treeQuotes: true });
    const out = readClaimCheck({ verdicts: targets.map((t) => ({ item: t.id, verdict: "supported", note: "", quotes: t.quotes === "none" ? [] : [{ path: "pkg/a.go", line: 1, text: t.id === claim ? text : "new := 2 line" }] })) }, targets, [file]);
    if ("problems" in out) throw new Error(out.problems.join());
    return out;
  };

  // Runs the plan's real command in a git repo whose base holds "old := 1 line" and whose head file holds "new := 2 line".
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const failing = (reading: ReturnType<typeof read>): string[] => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "gl-quote-"));
    dirs.push(dir);
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    mkdirSync(path.join(dir, "pkg"));
    writeFileSync(path.join(dir, "pkg/a.go"), "old := 1 line\nmore\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const sha = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(path.join(dir, "pkg/a.go"), "new := 2 line\nmore\n");
    const plan = treeQuotePlan(reading.treeQuotes, sha);
    const outputs = plan.commands.map((c) => {
      const out = path.join(dir, "out.txt");
      const r = spawnSync(c.argv[0]!, c.argv.slice(1), { cwd: dir, encoding: "utf8", env: { ...process.env, GRAPHLOOM_REPORT_FILE: out } });
      expect(r.status, r.stderr).toBe(0);
      return readFileSync(out, "utf8");
    });
    return [...readTreeQuotes(plan, outputs).keys()];
  };

  it("accepts a valid quote from either side of a file the item cites on both sides", () => {
    const both = reportWith({ cites: [head, base] });
    expect(read(both, "old := 1 line").treeQuotes.find((q) => q.id === "R1")!.tree).toBe("either");
    expect(failing(read(both, "old := 1 line"))).toEqual([]);
    expect(failing(read(both, "new := 2 line"))).toEqual([]);
    expect(failing(read(both, "nothing like it"))).toEqual(["R1"]);
    // One side only is still one tree: a head-only cite refuses the base text.
    expect(failing(read(reportWith({}), "old := 1 line"))).toEqual(["R1"]);
  });

  it("checks a before/after row's quotes where the file shows them, base text for before and head text for after", () => {
    const row = reportWith({ behavior: [{ case: "c", before: "was old", after: "is new" }] });
    expect(failing(read(row, "old := 1 line", "R1.b1"))).toEqual([]);
    expect(failing(read(row, "new := 2 line", "R1.b1"))).toEqual([]);
    expect(failing(read(row, "nothing like it", "R1.b1"))).toEqual(["R1.b1"]);
  });
});

describe("the sections of the large reporter prompt (design §6.9)", () => {
  it("do not ask for every detector fact to be listed, which the 200-fact digest cap could not honour; the standard prompt does", () => {
    const sim = run();
    const fact = { id: "D1", section: "other", path: "docs/guide.md", side: "head" as const, line: 1, text: "File routed to this section: docs/guide.md added" };
    const sections = reporterSections(profileOf(LARGE));
    const files = [pullFile({ path: "docs/guide.md", status: "added", previousPath: null, additions: 1, deletions: 0, sha: null, patch: "@@ -0,0 +1 @@\n+x", patchOmitted: false })!];
    const partition = partitionAreas(files, profileOf(LARGE).limits, []);
    const base = { pr: { mode: "report" as const, owner: "o", repo: "r", number: 1, head: "h".repeat(40) }, snapshot: { pull: { title: "t", body: "b" } as never, files, commits: [] }, sections, facts: [fact], kind: "first" as const, feedback: [] as string[] };
    const large = largeReporterInstruction({ ...base, partition });
    expect(large).toContain("D1 [other]");
    expect(large).not.toMatch(/each must be listed/);
    expect(large).toContain("the plugin accounts for the facts you leave out");
    expect(assignmentOf(agents(sim, "change-report-v1")[0]!)).not.toMatch(/each must be listed/);
    const standard = reporterInstruction({ ...base, candidates: [] });
    expect(standard).toMatch(/Detector facts for this section \(each must be listed in the "facts" of an item of this section\): D1/);
  });
});
