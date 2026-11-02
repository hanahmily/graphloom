// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, JobSpec, RehearsalScenario } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { composeDraft, draftMarkdown, type DraftInput } from "../src/draft.js";
import { readParts } from "../src/parts.js";
import { principlesContext, type PrinciplesRead } from "../src/principles.js";
import { REHEARSAL_REQUEST } from "../src/rehearsal.js";
import { PRINCIPLES_FILE, PRINCIPLES_PATH } from "../src/rehearsal-fixtures.js";
import { reviewScenarioParts } from "../src/rehearsal-review.js";
import { parsePass, REVIEW_SCHEMA_NAME, type AspectRecord, type Finding } from "../src/review.js";
import { planReviewer, planVerifier } from "../src/reviewprompts.js";
import { scenarioWith, simulate, assignmentOf, type Simulation } from "./support.js";

const read: PrinciplesRead = { path: PRINCIPLES_PATH, commit: "c".repeat(40), file: "present", text: PRINCIPLES_FILE, truncated: false };
const SYNC = "pkg/offline/sync.go";
const approve: EvidenceRecord = { ref: "ev-approval-approve", kind: "other", generation: 1, payload: { type: "operator-approval", approvalId: "review-layer", decision: "approve", files: [], operator: "tester", at: "2026-10-30T10:00:00.000Z", generation: 1 } };
const base = { pr: { mode: "review" as const, owner: "o", repo: "r", number: 1, head: "a".repeat(40) }, snapshot: { pull: { title: "t", body: "b" }, commits: [] } as never, aspect: "correctness" as const, pass: 1, files: [SYNC, "docs/x.md"], scopeLine: "the whole pull request", groups: [], summary: "", context: { kind: "seeded" as const, reason: "x" }, known: [], feedback: [], reviewDir: "/work/.graphloom/review" };

describe("a reviewer's assignment lists the principles that apply to its scope", () => {
  it("gives each one with its statement, the source and what round 1 concluded, and asks for the principle field", () => {
    const principles = principlesContext(read, [{ path: SYNC }]);
    const round1 = new Map([["offline-idempotent", { verdict: "breaks", checker: "supported" }], ["small-steps", { verdict: "preserves" }]]);
    const text = planReviewer({ ...base, principles, round1 }).text;
    expect(text).toContain(`from ${PRINCIPLES_PATH} at the pinned base ${"c".repeat(12)}`);
    expect(text).toContain("- offline-idempotent [round 1: breaks; checker: supported]: Offline sync must be safe to repeat");
    expect(text).toContain("- small-steps [round 1: preserves; checker: no judgment]: A change does one thing");
    // A principle whose globs match no file of the scope is not listed.
    expect(text).not.toContain("proto-compatible");
    expect(text).toMatch(/not raised again unless you cite a different concrete site/);
    expect(text).toMatch(/principle \(the id of the design principle/);
  });

  it("says nothing of principles when none applies to the scope, and the field is always empty", () => {
    const none = principlesContext(read, [{ path: "docs/x.md" }]);
    // Every principle of this file names globs that match no file of the scope.
    const globbed = principlesContext({ ...read, text: "## proto-compatible\nA field is never renumbered.\n- Applies to: **/*.proto\n" }, [{ path: SYNC }]);
    expect(globbed.applicable).toEqual([]);
    for (const principles of [undefined, globbed, { ...none, read: { ...read, file: "absent" as const } }]) {
      const text = planReviewer({ ...base, principles }).text;
      expect(text).not.toContain("design principles");
      expect(text).not.toContain("round 1:");
      expect(text).toMatch(/principle \(always ""\)/);
    }
  });
});

describe("a comment's principle is one the reviewer was given", () => {
  const scope = new Set([SYNC]);
  const comment = { path: SYNC, side: "RIGHT", start_line: 3, end_line: 5, aspect: "correctness", kind: "behavioral", severity: "P1", content: "wrong", suggestion: "", finding: "", evidence: "read it", distinct: false };
  const summary = { total_files: 1, reviewed_files: 1, skipped: [] };
  const pass = (principle: unknown, principles?: Set<string>) => parsePass({ comments: [{ ...comment, ...(principle !== undefined ? { principle } : {}) }], summary }, { aspect: "correctness", scope, known: new Set(), ...(principles !== undefined ? { principles } : {}) });

  it("accepts an id given, the empty string, and a result without the field", () => {
    const given = new Set(["offline-idempotent"]);
    expect(pass("offline-idempotent", given)).toMatchObject({ comments: [{ principle: "offline-idempotent" }] });
    expect(pass("", given)).toMatchObject({ comments: [{ principle: "" }] });
    expect(pass(undefined, given)).toMatchObject({ comments: [{ path: SYNC }] });
  });

  it("rejects an unknown id with the ids to use, and any id when none was given", () => {
    expect(pass("proto-compatible", new Set(["offline-idempotent"]))).toMatchObject({ problems: [expect.stringMatching(/comments\[0\]\.principle must be "" or one of the principle ids you were given \(offline-idempotent\)/)] });
    expect(pass("small-steps")).toMatchObject({ problems: [expect.stringMatching(/principle must be "" or empty: no design principle was given/)] });
    expect(pass(7, new Set(["a"]))).toMatchObject({ problems: [expect.stringMatching(/principle must be/)] });
  });
});

const finding = (over: Partial<Finding>): Finding => ({ id: "F1", aspect: "correctness", raisedBy: "correctness", pass: 1, path: SYNC, side: "RIGHT", startLine: 10, endLine: 12, severity: "P1", kind: "behavioral", content: "Sync resets on force, so a second run changes the state.", suggestion: "", evidence: "", distinct: false, state: "confirmed", reaffirmed: [], notes: [], verdict: { verdict: "confirmed", kind: "behavioral", witness: `${SYNC}:10`, quotes: [], reason: "yes", fixes: false }, ...over });

describe("the verifier is shown the principle's statement", () => {
  const principles = new Map(principlesContext(read, [{ path: SYNC }]).applicable.map((p) => [p.id, p] as const));
  const verify = (findings: Finding[]) => planVerifier({ pr: base.pr as never, snapshot: base.snapshot, aspect: "correctness", pass: 1, findings, feedback: [], principles, reviewDir: "/review" }).text;

  it("puts the statement in the finding's block and tells the verifier to confirm only a real contradiction", () => {
    const text = verify([finding({ principle: "offline-idempotent" }), finding({ id: "F2" })]);
    expect(text).toContain('Says it breaks the design principle offline-idempotent: "Offline sync must be safe to repeat: running it twice leaves the same state as running it once."');
    expect(text).toMatch(/Confirm it only when the cited code really contradicts the statement as written/);
    expect(text.split("\n").filter((l) => l.includes("Says it breaks"))).toHaveLength(1);
  });

  it("says nothing of principles when no finding names one", () => {
    expect(verify([finding({})])).not.toContain("principle");
  });
});

describe("the draft shows a finding's principle", () => {
  const files = [{ path: SYNC, status: "modified", previousPath: null, additions: 1, deletions: 0, patch: null, patchOmitted: true, parsed: [] }];
  const record = (findings: Finding[]): AspectRecord => ({ schema: "pr-review-aspect-v1", aspect: "correctness", reviewer: "claude-code", verifier: "codex", context: { kind: "seeded", reason: "r" }, scopeFiles: 1, passes: [{ n: 1, reviewed: 1, raised: findings.map((f) => f.id), reaffirmed: [], nits: 0, merged: 0 }], findings, unsaturated: false });
  const scope = { schema: "pr-review-scope-v1" as const, mode: "standard" as const, source: "whole" as const, areas: [], files: [SYNC], base: { kind: "answerer" as const, stageId: "answers", sessionRef: "s", chain: [] }, context: { kind: "seeded" as const, reason: "r" }, summary: { sha256: "x", bytes: 0, cuts: 0, turns: 0 }, harnesses: {} };
  const input = (findings: Finding[]): DraftInput => ({ pull: { owner: "o", repo: "r", number: 7 }, head: "a".repeat(40), files: files as never, scope, records: [record(findings), { ...record([]), aspect: "maintainability" }, { ...record([]), aspect: "security" }] });

  it("names the principle in the entry, draft.md and the summary's principle line", () => {
    const d = composeDraft(input([finding({ principle: "offline-idempotent", kind: "non-behavioral", verdict: { verdict: "confirmed", kind: "non-behavioral", witness: `${SYNC}:10`, quotes: [], reason: "yes", fixes: false } })]));
    expect(d.comments[0]).toMatchObject({ id: "F1", principle: "offline-idempotent" });
    expect(d.comments[0]!.body).toContain("Breaks the project's design principle `offline-idempotent`.");
    expect(d.summary).toContain("Confirmed breaks of the project's design principles: F1 breaks offline-idempotent.");
    expect(draftMarkdown(d)).toContain("breaks principle offline-idempotent");
    expect(JSON.parse(JSON.stringify(d)).review.findings[0].principle).toBe("offline-idempotent");
  });

  it("has no principle line, entry field or mention for a finding that names none (and a record without the field reads the same)", () => {
    const d = composeDraft(input([finding({ kind: "non-behavioral" })]));
    expect(d.comments[0]).not.toHaveProperty("principle");
    expect(d.summary).not.toContain("design principles");
    expect(JSON.stringify(d)).not.toContain("principle");
  });

});

describe("the Review stage gives the reviewers the principles", () => {
  const withPrinciple = (principle: string): RehearsalScenario =>
    scenarioWith("necessity-principles", (s) => {
      const parts = reviewScenarioParts({ total: 1, path: SYNC });
      const passes = parts.results[REVIEW_SCHEMA_NAME]!;
      const first = passes[0]!.output as { comments: Array<Record<string, unknown>> };
      first.comments[0]!.principle = principle;
      s.results = { ...s.results, ...parts.results };
      s.commands = { ...s.commands, ...parts.commands };
    });
  const run = (scenario: RehearsalScenario): Simulation => simulate({ scenario, request: REHEARSAL_REQUEST.replace("Report on", "Review on"), maxSteps: 400, seed: [approve] });
  const reviewers = (sim: Simulation): JobSpec[] => sim.jobs.filter((j) => j.stageId === "review" && j.jobId === "reviewer-correctness");

  it("lists the applicable principles with N1's verdicts and the checker's, and records the finding's principle", () => {
    const sim = run(withPrinciple("offline-idempotent"));
    const text = assignmentOf(reviewers(sim)[0]!);
    expect(text).toContain("- offline-idempotent [round 1: preserves; checker: supported]:");
    expect(text).toContain("- small-steps [round 1: preserves; checker: supported]:");
    expect(text).not.toContain("proto-compatible");
    const verifier = sim.jobs.find((j) => j.stageId === "review" && j.jobId === "verifier-correctness")!;
    expect(assignmentOf(verifier)).toContain("Says it breaks the design principle offline-idempotent");
    expect(sim.jobs.find((j) => j.jobId === "reviewer-correctness")!.knownReferences?.["comments[].principle"]?.ids).toEqual(["", "small-steps", "offline-idempotent"]);
  });

  it("shows it in the review grid, the appendix and review.md", () => {
    const sim = run(withPrinciple("offline-idempotent"));
    const html = readParts(sim.evidence, "review-html-final", ".graphloom/review/review.html");
    const appendix = readParts(sim.evidence, "review-appendix-html-final", ".graphloom/review/review-appendix.html");
    const md = readParts(sim.evidence, "review-md-final", ".graphloom/review/review.md");
    const draft = readParts(sim.evidence, "draft-json", ".graphloom/review/draft.json");
    expect(html.state === "read" && html.value).toContain("(breaks principle offline-idempotent)");
    expect(appendix.state === "read" && appendix.value).toContain("breaks principle offline-idempotent");
    expect(md.state === "read" && md.value).toContain("breaks principle offline-idempotent");
    expect(draft.state === "read" && draft.value).toContain('"principle": "offline-idempotent"');
  });

  it("sends a pass back naming a principle that was not given", () => {
    const sim = run(withPrinciple("proto-compatible"));
    const second = assignmentOf(reviewers(sim)[1]!);
    expect(second).toMatch(/comments\[0\]\.principle/);
  });
});
