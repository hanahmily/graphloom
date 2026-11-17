// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidenceRecord, JobSpec, RehearsalScenario } from "@graphloom/sdk";
import { describe, expect, it } from "vitest";
import { composeDraft, draftMarkdown, type DraftInput } from "../src/draft.js";
import { readParts } from "../src/kit/parts.js";
import { principlesContext, type PrinciplesRead } from "../src/kit/principles.js";
import { REHEARSAL_MERGE_BASE, REHEARSAL_REQUEST } from "../src/rehearsal.js";
import { designFileText } from "../src/context.js";
import { PRINCIPLES_FILE, PRINCIPLES_PATH } from "../src/rehearsal-fixtures.js";
import { parsePass, REVIEW_SCHEMA_NAME, type AspectRecord, type Finding } from "../src/review.js";
import { planReviewer, planVerifier } from "../src/reviewprompts.js";
import { scenarioWith, simulate, assignmentOf, type Simulation } from "./support.js";

const read: PrinciplesRead = { path: PRINCIPLES_PATH, commit: "c".repeat(40), file: "present", text: PRINCIPLES_FILE, truncated: false };
const SYNC = "pkg/offline/sync.go";
const base = { pr: { mode: "review" as const, owner: "o", repo: "r", number: 1, head: "a".repeat(40) }, snapshot: { pull: { title: "t", body: "b" }, commits: [] } as never, aspect: "correctness" as const, pass: 1, files: [SYNC, "docs/x.md"], scopeLine: "the whole pull request", groups: [], known: [], feedback: [], reviewDir: "/work/.graphloom/review", source: "design-review" as const };

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

  it("says round 1 was not run beside each principle when the design review is not the context (design-pr-review-split §4.2)", () => {
    const principles = principlesContext(read, [{ path: SYNC }]);
    const text = planReviewer({ ...base, source: "prelude", principles }).text;
    expect(text).toContain("- offline-idempotent [round 1: not run]: Offline sync must be safe to repeat");
    expect(text).toContain("- small-steps [round 1: not run]: A change does one thing");
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
  const record = (findings: Finding[]): AspectRecord => ({ schema: "pr-review-aspect-v2", aspect: "correctness", reviewer: "claude-code", verifier: "codex", context: { kind: "seeded", reason: "r" }, scopeFiles: 1, passes: [{ n: 1, reviewed: 1, raised: findings.map((f) => f.id), reaffirmed: [], nits: 0, merged: 0 }], findings, unsaturated: false, leads: [] });
  const scope = { schema: "pr-review-scope-v2" as const, mode: "standard" as const, source: "whole" as const, areas: [], files: [SYNC], context: { kind: "seeded" as const, reason: "r" }, contextSource: "prelude" as const, harnesses: {} };
  const input = (findings: Finding[]): DraftInput => ({ pull: { owner: "o", repo: "r", number: 7 }, head: "a".repeat(40), files: files as never, scope, records: [record(findings), { ...record([]), aspect: "maintainability" }, { ...record([]), aspect: "security" }], context: { source: "prelude" }, round1: null });

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
  const PRESENT = { "principles-read": { exitCode: 0, stdout: `commit ${REHEARSAL_MERGE_BASE}\npresent\n${PRINCIPLES_FILE}` } };
  // A change to pkg/offline/sync.go, reviewed from a report-only prelude, with the repository's principles file at the pinned base.
  const withPrinciple = (principle: string): RehearsalScenario =>
    scenarioWith("crap-upper-bound", (s) => {
      const first = s.results[REVIEW_SCHEMA_NAME]![0]!.output as { comments: Array<Record<string, unknown>> };
      first.comments[0]!.principle = principle;
      s.commands = { ...s.commands, ...PRESENT };
    });
  const run = (scenario: RehearsalScenario): Simulation => simulate({ scenario, request: REHEARSAL_REQUEST, maxSteps: 500, through: "end" });
  const reviewers = (sim: Simulation): JobSpec[] => sim.jobs.filter((j) => j.stageId === "review" && j.jobId === "reviewer-correctness");

  it("lists the applicable principles, with round 1 not run beside them, and records the finding's principle", () => {
    const sim = run(withPrinciple("offline-idempotent"));
    const text = assignmentOf(reviewers(sim)[0]!);
    expect(text).toContain("- offline-idempotent [round 1: not run]:");
    expect(text).toContain("- small-steps [round 1: not run]:");
    expect(text).not.toContain("proto-compatible");
    const verifier = sim.jobs.find((j) => j.stageId === "review" && j.jobId === "verifier-correctness")!;
    expect(assignmentOf(verifier)).toContain("Says it breaks the design principle offline-idempotent");
    expect(sim.jobs.find((j) => j.jobId === "reviewer-correctness")!.knownReferences?.["comments[].principle"]?.ids).toEqual(["", "small-steps", "offline-idempotent"]);
  });

  it("gives N1's verdicts and the checker's beside each principle when the design review is the context", () => {
    const scenario = scenarioWith("design-review", (s) => {
      const stub = s.commands!["ledger-prior-nec"]!.stdout!;
      const nec = JSON.parse(stub.slice(stub.indexOf("\n") + 1)) as { answer: { necessity: { principles: unknown[] }; check: { principles: unknown[] } } };
      nec.answer.necessity.principles = [{ id: "small-steps", verdict: "preserves", explanation: "one thing", citations: [] }];
      nec.answer.check.principles = [{ id: "small-steps", verdict: "supported", note: "" }];
      s.commands = { ...s.commands, ...PRESENT, "ledger-prior-nec": { exitCode: 0, stdout: designFileText(JSON.stringify(nec), 0) } };
    });
    const sim = run(scenario);
    const text = assignmentOf(reviewers(sim)[0]!);
    expect(text).toContain("- small-steps [round 1: preserves; checker: supported]:");
    expect(text).toContain("- proto-compatible [round 1: no verdict]:");
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
