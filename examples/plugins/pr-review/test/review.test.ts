// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { checkAssignmentFidelity, type EvidenceRecord, type JobSpec, type RehearsalScenario } from "@graphloom/sdk";
import { REHEARSAL_HEAD, REHEARSAL_MERGE_BASE, rehearsal } from "../src/rehearsal.js";
import { htmlProblems } from "../src/html.js";
import { describe, expect, it } from "vitest";
import { LARGE_LIMITS, REHEARSAL_REQUEST } from "../src/rehearsal.js";
import { parseDraft } from "../src/draft.js";
import { passReply, verifyReply } from "../src/rehearsal-review.js";
import { recordedAspect, recordedRound1, recordedScope } from "../src/reviewdraft.js";
import { readParts } from "../src/parts.js";
import { quotePrefix, REVIEW_SCHEMA_NAME, VERIFY_SCHEMA_NAME } from "../src/review.js";
import { codeReview, draftComposed } from "../src/reviewvalidators.js";
import { BANYANDB, assignmentOf, candidateEvidence, scenarioWith, simulate, type Simulation } from "./support.js";

export const REVIEW_REQUEST = REHEARSAL_REQUEST.replace("Report on", "Review on");
export const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const jobsFor = (sim: Simulation, schema: string): JobSpec[] => sim.jobs.filter((j) => j.resultSchema === schema);
const agentKeys = (sim: Simulation): string[] => sim.jobs.filter((j) => j.stageId === "review" && j.kind === "agent").map((j) => `${j.jobId}`);

const scopeOf = (sim: Simulation) => {
  const r = recordedScope(sim.evidence);
  if (r.state !== "read") throw new Error(`scope ${r.state}`);
  return r.value;
};

describe("the review layer, entered in the same run when round 1 found no issue", () => {
  const sim = simulate({ scenarioName: "review-layer", request: REVIEW_REQUEST, through: "end", maxSteps: 400 });

  it("runs Round 1, Review, Draft and Publish in one run, with no pause for a human, and ends with the posted verdict", () => {
    expect(stopOf(sim), JSON.stringify(sim.final).slice(0, 600)).toMatchObject({ reason: "complete", retryable: false });
    expect(stopOf(sim)!.blocker).toMatch(/^round 2: changes requested: 1 open on apache\/skywalking-banyandb#7 at 0123456789ab; the review is posted \(https:/);
    expect(sim.receipts.filter((r) => r.valid).map((r) => r.requirementId)).toEqual([
      "pr-snapshot", "head-checked-out", "prior-ledger", "change-report", "measurements", "claims-checked", "questions-complete", "answers-complete", "answers-grounded", "round1-gated", "code-review", "findings-proven", "draft-composed", "review-published",
    ]);
  });

  it("dispatches the three aspects in order, each pass with its verifier after it, all fresh sessions", () => {
    expect(agentKeys(sim)).toEqual([
      "reviewer-correctness", "verifier-correctness", "reviewer-correctness",
      "reviewer-maintainability", "verifier-maintainability", "reviewer-maintainability",
      "reviewer-security",
    ]);
    expect(jobsFor(sim, REVIEW_SCHEMA_NAME)).toHaveLength(5);
    for (const j of sim.jobs.filter((x) => x.stageId === "review" && x.kind === "agent")) {
      expect(j.continueFrom).toBeUndefined();
      expect(j.readOnly).toBe(true);
      expect(j.purpose).toBe("review");
    }
  });

  it("runs the reviewers on Claude Code with the role's model and effort and the verifiers on Codex, another harness", () => {
    const harness = (j: JobSpec) => (j.input as { harness: string; harnessOptions?: { model?: string; effort?: string } });
    for (const j of jobsFor(sim, REVIEW_SCHEMA_NAME)) expect(harness(j)).toMatchObject({ harness: "claude-code", harnessOptions: { model: "opus", effort: "high" } });
    for (const j of jobsFor(sim, VERIFY_SCHEMA_NAME)) {
      expect(harness(j).harness).toBe("codex");
      expect(harness(j).harnessOptions).toEqual({ effort: "medium" });
    }
  });

  it("records the scope and that every reviewer starts a fresh session seeded with review.md only, whatever conversation was recorded", () => {
    const s = scopeOf(sim);
    expect(s.context).toEqual({ kind: "seeded", reason: "every reviewer starts a fresh session seeded with review.md only" });
    expect(s).toMatchObject({ source: "whole", mode: "standard", files: ["pkg/schema/ttl.go"] });
    expect(s).not.toHaveProperty("base");
    expect(s).not.toHaveProperty("summary");
    expect(s.harnesses.security).toEqual({ reviewer: "claude-code", verifier: "codex" });
    const rec = recordedAspect(sim.evidence, "security");
    expect(rec.state === "read" && rec.value.context).toEqual({ kind: "seeded", reason: "every reviewer starts a fresh session seeded with review.md only" });
    for (const j of jobsFor(sim, REVIEW_SCHEMA_NAME)) {
      const a = assignmentOf(j);
      expect(a).not.toContain("<conversation>");
      expect(a).not.toMatch(/Maintainer:|maintainer's conversation/);
    }
  });

  it("writes the rule files and tells each reviewer which rule its files fall under", () => {
    const rules = readParts(sim.evidence, "review-rules-security", ".graphloom/review/rules/security.json");
    expect(rules.state).toBe("read");
    expect(rules.state === "read" && JSON.parse(rules.value)).toMatchObject({ merge_system_rule: false, rules: [{ path: "**/*.go" }, { path: "**/*.ts" }, { path: "**/*.tsx" }, { path: "**" }] });
    const a = assignmentOf(jobsFor(sim, REVIEW_SCHEMA_NAME).at(-1)!);
    expect(a).toContain("security reviewer");
    expect(a).toContain("Rule for **/*.go (1 file): Aspect: security. Go code:");
    expect(a).toContain("/work/tree/.graphloom/review/review.md");
    expect(a).toContain("total_files (1)");
    expect(a).toContain("<untrusted");
  });

  it("keeps the verdicts: F1 confirmed, F2 dismissed by its refutation, F3 confirmed", () => {
    const rec = (a: "correctness" | "maintainability" | "security") => {
      const r = recordedAspect(sim.evidence, a);
      if (r.state !== "read") throw new Error(`${a}: ${r.state}`);
      return r.value;
    };
    expect(rec("correctness").findings.map((f) => [f.id, f.state, f.kind])).toEqual([["F1", "confirmed", "behavioral"], ["F2", "dismissed", "behavioral"]]);
    expect(rec("correctness").passes.map((p) => p.raised)).toEqual([["F1", "F2"], []]);
    expect(rec("maintainability").findings.map((f) => [f.id, f.state])).toEqual([["F3", "confirmed"]]);
    expect(rec("security").findings).toEqual([]);
    expect(rec("security").unsaturated).toBe(false);
  });

  it("gives the later passes the findings already raised, and the verifier the findings of one pass", () => {
    const passes = jobsFor(sim, REVIEW_SCHEMA_NAME).map(assignmentOf);
    expect(passes[0]).not.toContain("Findings already raised");
    expect(passes[1]).toContain("Findings already raised in this review");
    expect(passes[1]).toContain("F1 [correctness, behavioral, P1, confirmed]");
    expect(passes[1]).toContain("F2 [correctness, behavioral, P2, dismissed]");
    expect(passes[2]).toContain("F1 [correctness");
    const verify = assignmentOf(jobsFor(sim, VERIFY_SCHEMA_NAME)[0]!);
    expect(verify).toContain("Findings (2):");
    expect(verify).toContain("verdicts");
  });

  it("checks the refutation's quotes against the head, with command ids of the pass", () => {
    const ids = sim.jobs.filter((j) => j.kind === "command").flatMap((j) => ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id));
    expect(ids).toContain(`${quotePrefix("correctness", 1)}-1`);
    expect(ids.filter((id) => id.startsWith("rvq-"))).toEqual([`${quotePrefix("correctness", 1)}-1`]);
  });

  it("writes the draft: the behavioral finding is for the maintainer's judgment, the non-behavioral one is a comment", () => {
    const w = readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json");
    expect(w.state).toBe("read");
    if (w.state !== "read") return;
    const d = parseDraft(w.value)!;
    expect(d.comments.filter((c) => c.kind === "finding").map((c) => [c.id, c.severity, c.aspects])).toEqual([["F3", "P2", ["maintainability"]]]);
    expect(d.judgment.map((j) => [j.id, j.reason])).toEqual([["F1", "unproven: no test"]]);
    expect(d.verdict).toBe("comment");
    expect(d.recommended).toBe("comment");
    expect(d.maintainer.join("\n")).toContain("Dismissed F2");
    expect(d.review).not.toHaveProperty("base");
    const md = readParts(sim.evidence, "draft-md", ".graphloom/review/draft.md");
    expect(md.state === "read" && md.value).toContain("## Needs your judgment (move an entry into Comments to post it)\n### F1 · correctness · unproven:");
  });

  it("writes review.md, review.html and the appendix again with the Review section", () => {
    const md = readParts(sim.evidence, "review-md-final", ".graphloom/review/review.md");
    const html = readParts(sim.evidence, "review-html-final", ".graphloom/review/review.html");
    const appendix = readParts(sim.evidence, "review-appendix-html-final", ".graphloom/review/review-appendix.html");
    expect([md.state, html.state, appendix.state]).toEqual(["read", "read", "read"]);
    if (md.state !== "read" || html.state !== "read" || appendix.state !== "read") return;
    expect(md.value).toContain("## Review\nRecommended verdict: comment.");
    expect(md.value).toMatch(/### P1 \(1\)\n- F1 · correctness · pkg\/schema\/ttl\.go:26-30 · confirmed \(verifier codex: confirmed\) · unproven:/);
    expect(md.value).toContain("## Review: findings and draft");
    expect(md.value.indexOf("## Review\n")).toBeLessThan(md.value.indexOf("## Open questions"));
    // review.html: the findings that stand as a grid of aspect by severity, coloured by state, each tile linking to its finding in the appendix.
    expect(html.value).toContain("<h2>Review</h2>");
    expect(html.value.indexOf("<h2>Review</h2>")).toBeGreaterThan(html.value.indexOf("<h2>Questions</h2>"));
    expect(html.value).toMatch(/<a class="tile grey cell" href="review-appendix.html#f-F1" title="P1 correctness\nF1 unproven: [^"]*"><strong>1<\/strong><\/a>/);
    expect(html.value).toMatch(/<a class="tile bad cell" href="review-appendix.html#f-F3" title="P2 maintainability\nF3 confirmed: [^"]*"><strong>1<\/strong><\/a>/);
    expect(html.value).toContain("<span class=\"fh\">correctness</span>");
    expect(html.value).toMatch(/<span class="key"><span class="sw bad"><\/span>confirmed 1<\/span><span class="key"><span class="sw warn"><\/span>disputed 0<\/span><span class="key"><span class="sw grey"><\/span>unproven 1<\/span>/);
    expect(html.value).not.toContain("#f-F2");
    expect(html.value).not.toMatch(/<(ul|table)\b/);
    expect(htmlProblems(html.value, { owner: "apache", repo: "skywalking-banyandb", head: REHEARSAL_HEAD, base: REHEARSAL_MERGE_BASE })).toEqual([]);
    // The appendix holds the findings in text, by severity with the P1 that stands open, and in full with the draft; each has the id a tile links to.
    expect(appendix.value).toMatch(/<h3>P1 <span class="muted">\(1\)<\/span><\/h3><details open class="qa">/);
    expect(appendix.value).toMatch(/<h3>P2 <span class="muted">\(1\)<\/span><\/h3><details class="qa">/);
    expect(appendix.value).toContain("Checker (codex): <strong>confirmed</strong>");
    expect(appendix.value).toContain('<span class="badge grey">correctness</span>');
    expect(appendix.value).toMatch(/<details id="f-F1"[^>]*class="qa">/);
    expect(appendix.value).toMatch(/<details id="f-F3"[^>]*class="qa">/);
    expect(appendix.value.match(/id="f-F1"/g)).toHaveLength(1);
    expect(appendix.value).toContain("<h2>Review: findings and draft</h2>");
    expect(appendix.value).toContain("Dismissed F2");
    expect(appendix.value).toContain("F2</span>");
  });

  it("passes both stages' validators on the recorded evidence and fails them when a record is tampered with", () => {
    const evidence = candidateEvidence(sim.evidence, "d1");
    expect(codeReview.evaluate({ requirementId: "code-review", statement: "", evidence, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed" });
    expect(draftComposed.evaluate({ requirementId: "draft-composed", statement: "", evidence, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed" });
    const tamper = (id: string, change: (json: Record<string, unknown>) => void): EvidenceRecord[] =>
      evidence.map((e) => {
        const c = (e.payload as { command?: { id: string; argv: string[] } } | undefined)?.command;
        if (c?.id !== id) return e;
        const argv = [...c.argv];
        const json = JSON.parse(argv.slice(6).join("")) as Record<string, unknown>;
        change(json);
        return { ...e, payload: { ...(e.payload as object), command: { ...c, argv: [...argv.slice(0, 5), String(1), JSON.stringify(json)].slice(0, 7) } } };
      });
    const dismissedWithoutRefutation = tamper("review-aspect-correctness", (j) => {
      (j.findings as Array<{ verdict?: unknown }>)[1]!.verdict = undefined;
    });
    expect(codeReview.evaluate({ requirementId: "code-review", statement: "", evidence: dismissedWithoutRefutation, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "failed", reason: expect.stringContaining("F2 is dismissed without a refutation") });
    const sameHarness = tamper("review-aspect-security", (j) => {
      j.verifier = "claude-code";
    });
    expect(codeReview.evaluate({ requirementId: "code-review", statement: "", evidence: sameHarness, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "failed", reason: expect.stringMatching(/security: the recorded harnesses/) });
    const unseeded = tamper("review-scope", (j) => {
      (j.context as { reason: string }).reason = "";
    });
    expect(codeReview.evaluate({ requirementId: "code-review", statement: "", evidence: unseeded, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "failed", reason: expect.stringContaining("fresh session seeded with review.md only") });
    const noFindings = tamper("review-aspect-maintainability", (j) => {
      j.findings = [];
    });
    expect(draftComposed.evaluate({ requirementId: "draft-composed", statement: "", evidence: noFindings, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "failed", reason: expect.stringContaining("is not what the evidence recomputes") });
  });
});

describe("the review jobs' assignments and commands", () => {
  const sim = simulate({ scenarioName: "review-layer", request: REVIEW_REQUEST, through: "end", maxSteps: 400 });
  it("name every field the stand-in agents reply with", () => {
    const scenario = rehearsal(BANYANDB).scenarios["review-layer"]!;
    for (const job of sim.jobs.filter((j) => j.kind === "agent" && j.stageId === "review")) {
      for (const reply of scenario.results[job.resultSchema!]!) expect(checkAssignmentFidelity(assignmentOf(job), reply.output), `${job.jobId}`).toEqual([]);
    }
  });
  it("fit the command executor's input contract", () => {
    for (const job of sim.jobs.filter((j) => j.kind === "command" && j.executor === undefined && (j.stageId === "review" || j.stageId === "draft"))) {
      const input = job.input as { commands: Array<{ id: string; argv: string[] }> };
      expect(input.commands.length).toBeLessThanOrEqual(16);
      for (const c of input.commands) {
        expect(c.argv.length, c.id).toBeLessThanOrEqual(64);
        for (const arg of c.argv) expect(arg.length, `${c.id} argument`).toBeLessThanOrEqual(4096);
      }
      expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThanOrEqual(256_000);
    }
  });
  it("write everything the review leaves in the worktree with one job per command, the scope record after the rule files", () => {
    const ids = sim.jobs.filter((j) => j.stageId === "review" && j.kind === "command").flatMap((j) => ((j.input as { commands: Array<{ id: string }> }).commands ?? []).map((c) => c.id));
    expect(ids.slice(0, 4)).toEqual(["review-rules-correctness-p1", "review-rules-maintainability-p1", "review-rules-security-p1", "review-scope"]);
  });
});

/** A scenario whose review replies are the given passes and verdicts, in the order the graph asks for them. */
const withReplies = (passes: unknown[], verdicts: unknown[], commands: RehearsalScenario["commands"] = {}): RehearsalScenario =>
  scenarioWith("review-layer", (s) => {
    s.results[REVIEW_SCHEMA_NAME] = passes as never;
    s.results[VERIFY_SCHEMA_NAME] = verdicts as never;
    s.commands = { ...s.commands, ...commands };
  });
const PATH = "pkg/schema/ttl.go";
const find = (extra: Record<string, unknown> = {}) => ({ path: PATH, start_line: 10, end_line: 12, severity: "P1", content: "wrong result", ...extra });
const run = (scenario: RehearsalScenario): Simulation => simulate({ scenario, request: REVIEW_REQUEST, through: "end", maxSteps: 400 });

describe("the findings contract and the sweep", () => {
  it("sends a pass back with every problem when it breaks the contract or the rules, then goes on", () => {
    const bad = passReply(1, [find({ path: "pkg/other.go" }), find({ end_line: 2 })]);
    const sim = run(withReplies([bad, passReply(1, []), passReply(1, []), passReply(1, [])], []));
    const passes = jobsFor(sim, REVIEW_SCHEMA_NAME).map(assignmentOf);
    expect(passes).toHaveLength(4);
    expect(passes[1]).toContain("correct every problem");
    expect(passes[1]).toMatch(/comments\[0\]\.path "pkg\/other\.go" is not a file in the review's scope/);
    expect(passes[1]).toMatch(/comments\[1\] needs 1 <= start_line/);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
  });

  it("hands the unresolved review to the supervisor after the retries are spent", () => {
    const bad = passReply(1, [find({ path: "pkg/other.go" })]);
    const sim = run(withReplies([bad, bad, bad, bad], []));
    expect(sim.final.action.type).toBe("supervise");
    expect(JSON.stringify(sim.final)).toMatch(/correctness reviewer's result still fails the contract or the deterministic rules after 2 retries/);
  });

  it("counts P3 nits and neither verifies nor drafts them", () => {
    const sim = run(withReplies([passReply(1, [find({ severity: "P3" })]), passReply(1, []), passReply(1, [])], []));
    const rec = recordedAspect(sim.evidence, "correctness");
    expect(rec.state === "read" && [rec.value.findings.length, rec.value.passes[0]!.nits]).toEqual([0, 1]);
    expect(jobsFor(sim, VERIFY_SCHEMA_NAME)).toEqual([]);
    expect(stopOf(sim)!.reason).toBe("complete");
  });

  it("disputes a finding the verifier left uncertain, or confirmed without a witness, or gave no verdict, and sweeps again", () => {
    const passes = [passReply(1, [find(), find({ start_line: 20, end_line: 21 }), find({ start_line: 30, end_line: 31 })]), passReply(1, []), passReply(1, []), passReply(1, [])];
    const verdicts = [verifyReply([{ finding: "F1", verdict: "uncertain" }, { finding: "F2", verdict: "confirmed", witness: "somewhere in the function" }])];
    const sim = run(withReplies(passes, verdicts));
    const rec = recordedAspect(sim.evidence, "correctness");
    if (rec.state !== "read") throw new Error(rec.state);
    expect(rec.value.findings.map((f) => [f.id, f.state, f.notes.at(-1)])).toEqual([
      ["F1", "disputed", "the verifier could not decide"],
      ["F2", "disputed", "the verifier confirmed it without a path:line witness of its own"],
      ["F3", "disputed", "the verifier gave no verdict for it"],
    ]);
    expect(rec.value.passes).toHaveLength(2);
    const d = parseDraft(readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json").state === "read" ? (readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json") as { value: string }).value : "")!;
    expect(d.judgment.map((j) => j.reason?.split(":")[0])).toEqual(["disputed", "disputed", "disputed"]);
    expect(d.recommended).toBe("comment");
  });

  it("disputes a refutation whose quotes the head does not show, instead of dismissing the finding", () => {
    const passes = [passReply(1, [find()]), passReply(1, []), passReply(1, []), passReply(1, [])];
    const verdicts = [verifyReply([{ finding: "F1", verdict: "refuted", quotes: [{ path: PATH, line: 7, text: "a line that is not there" }], reason: "the lock is held" }])];
    const sim = run(withReplies(passes, verdicts, { [`${quotePrefix("correctness", 1)}-1`]: { exitCode: 0, stdout: "1 nomatch\nchecked 1\n" } }));
    const rec = recordedAspect(sim.evidence, "correctness");
    expect(rec.state === "read" && rec.value.findings[0]).toMatchObject({ state: "disputed", notes: [expect.stringMatching(/the refutation's quotes do not match the head/)] });
  });

  it("stops the sweep at four passes while findings still stand, notes it unsaturated, and does not fail the stage", () => {
    const again = (n: number) => passReply(1, [find({ start_line: 10 + n * 3, end_line: 11 + n * 3 })]);
    const confirm = (id: string) => verifyReply([{ finding: id, verdict: "confirmed", witness: `${PATH}:${10}` }]);
    const sim = run(withReplies([again(0), again(1), again(2), again(3), passReply(1, []), passReply(1, [])], [confirm("F1"), confirm("F2"), confirm("F3"), confirm("F4")]));
    const rec = recordedAspect(sim.evidence, "correctness");
    if (rec.state !== "read") throw new Error(rec.state);
    expect(rec.value.passes).toHaveLength(4);
    expect(rec.value.unsaturated).toBe(true);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    const d = parseDraft((readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json") as { value: string }).value)!;
    expect(d.maintainer.join("\n")).toContain("Not saturated: the correctness sweep reached 4 passes");
  });

  it("reclassifies a non-behavioral finding that claims wrong behavior, so it is unproven and not drafted as a comment", () => {
    const passes = [passReply(1, []), passReply(1, [find({ aspect: "maintainability", kind: "non-behavioral", content: "dereferences a nil", severity: "P2" })]), passReply(1, []), passReply(1, [])];
    // correctness: one empty pass; maintainability: the comment above, whose verifier calls it behavioral.
    const sim = run(withReplies(passes, [verifyReply([{ finding: "F1", verdict: "confirmed", kind: "behavioral", witness: `${PATH}:11` }])]));
    const rec = recordedAspect(sim.evidence, "maintainability");
    expect(rec.state === "read" && rec.value.findings[0]).toMatchObject({ kind: "behavioral", state: "confirmed", notes: [expect.stringContaining("reclassified it as behavioral")] });
    const d = parseDraft((readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json") as { value: string }).value)!;
    expect(d.comments.filter((c) => c.kind === "finding")).toEqual([]);
    expect(d.judgment[0]).toMatchObject({ id: "F1", proof: { state: "unproven" } });
  });

  it("keeps a verified suggestion of a non-behavioral finding in the draft, as a suggestion block", () => {
    const passes = [passReply(1, []), passReply(1, [find({ aspect: "maintainability", kind: "non-behavioral", severity: "P2", suggestion: "\tn = 0\n" })]), passReply(1, []), passReply(1, [])];
    const sim = run(withReplies(passes, [verifyReply([{ finding: "F1", verdict: "confirmed", kind: "non-behavioral", witness: `${PATH}:11`, fixes: true }])]));
    const md = readParts(sim.evidence, "draft-md", ".graphloom/review/draft.md");
    expect(md.state === "read" && md.value).toContain("```suggestion\n\tn = 0\n```");
  });

  it("verifies each pass's findings on a verifier harness other than the reviewer's, in a fresh session of its own", () => {
    const sim = simulate({ scenarioName: "review-layer", request: REVIEW_REQUEST, through: "end", maxSteps: 400, config: { harnesses: { ...(BANYANDB.harnesses as object), "verifier-correctness": { harness: "codex" } } } });
    const harnessOf = (j: JobSpec) => (j.input as { harness: string }).harness;
    expect(sim.jobs.filter((j) => j.jobId === "verifier-correctness").map(harnessOf)).toEqual(["codex"]);
    expect(sim.jobs.filter((j) => j.jobId === "reviewer-correctness").map(harnessOf)).toEqual(["claude-code", "claude-code"]);
  });
});

describe("a large pull request: only the areas the briefing cites are reviewed", () => {
  const config = { limits: LARGE_LIMITS };
  const scenario = scenarioWith("large-review-layer", (s) => {
    s.results[REVIEW_SCHEMA_NAME] = [passReply(1, []), passReply(1, []), passReply(1, [])] as never;
  }, config);
  const sim = simulate({ scenario, config, request: REVIEW_REQUEST, through: "end", maxSteps: 700 });

  it("is large, with a Q&A round 1 raises nothing on, so the same run goes on into the review layer", () => {
    expect(stopOf(simulate({ scenarioName: "large-pull-request", config, maxSteps: 600 }))).toMatchObject({ reason: "answers accepted" });
    expect(recordedRound1(sim.evidence)).toMatchObject({ state: "read", value: { issues: [] } });
  });

  it("reviews the files of the areas the briefing's risks, behavior and compatibility entries cite, with no operator input, and tells the reviewers so", () => {
    expect(stopOf(sim), JSON.stringify(sim.final).slice(0, 400)).toMatchObject({ reason: "complete" });
    const s = scopeOf(sim);
    expect(s).toMatchObject({ mode: "large", source: "default", areas: [{ id: "A2", files: 1 }], files: ["pkg/alpha/alpha.go"] });
    expect(s).not.toHaveProperty("areasInput");
    expect(s).not.toHaveProperty("approvalRef");
    const a = assignmentOf(jobsFor(sim, REVIEW_SCHEMA_NAME)[0]!);
    expect(a).toContain("the areas the briefing's risks, behavior and compatibility entries cite (A2), 1 file");
    expect(a).toContain("pkg/alpha/alpha.go");
    expect(a).not.toContain("pkg/beta/beta.go");
    const d = parseDraft((readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json") as { value: string }).value)!;
    expect(d.maintainer.join("\n")).toContain("only the files of A2 were reviewed");
  });

  it("publishes a review that passes, as the first line says, when nothing is open", () => {
    expect(stopOf(sim)!.blocker).toMatch(/^review passed on /);
    expect(sim.github.creates).toHaveLength(1);
    expect(String(sim.github.creates[0]!.body).split("\n")[0]).toBe("Review passed");
  });
});
