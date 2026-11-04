// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { Draft, DraftEntry } from "../src/draft.js";
import { readParts, partCommands } from "../src/parts.js";
import { commentIds, createInput, findPosted, findingMarker, ledgerPatch, ledgerPublishedCommand, planReview, publishFlow, publishPlan, reviewMarker, viewerOf, verdictLine, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY } from "../src/publish.js";
import { analyze, evidencePull } from "../src/analysis.js";
import { REHEARSAL_HEAD } from "../src/rehearsal.js";
import { pinnedBase } from "../src/commands.js";
import { recordedRound1, writtenDraftFiles } from "../src/reviewdraft.js";
import { ROUND1_SCHEMA, type Round1Issue, type Round1Record } from "../src/round1.js";
import { reviewPublished, round1Gated } from "../src/reviewvalidators.js";
import { BANYANDB, candidateEvidence, profileOf, simulate, type FakeReview, type Simulation } from "./support.js";

const sh = promisify(execFile);
const HEAD = REHEARSAL_HEAD;
const NONCE = "op42";
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7, head: HEAD };

const issue = (id: string, over: Partial<Round1Issue> = {}): Round1Issue => ({ id, key: `needs-author|item|${id}`, kinds: ["needs-author"], status: "needs author", body: `**needs the author** (${id}). Why?`, anchored: false, ...over });
const round1 = (issues: Round1Issue[]): Round1Record => ({ schema: ROUND1_SCHEMA, head: HEAD, necessity: "necessary", issues });
const entry = (id: string, over: Partial<DraftEntry> = {}): DraftEntry => ({ id, kind: "finding", aspects: ["correctness"], severity: "P2", proof: { state: "non-behavioral" }, path: "pkg/a.go", side: "RIGHT", line: 12, anchored: true, body: "The loop drops the error.", ...over });
const draft = (comments: DraftEntry[], summary = "Reviewed the whole pull request."): Draft => ({ comments, summary }) as unknown as Draft;

describe("the review the Publish stage posts", () => {
  it("is one COMMENT review at the pinned head, never APPROVE or REQUEST_CHANGES, with the verdict as the first line", () => {
    const plan = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("N1"), issue("Q3")]) });
    expect(plan).toMatchObject({ round: 1, verdict: "changes-requested", open: 2, firstLine: "Changes requested: 2 open" });
    expect(plan.body.split("\n")[0]).toBe("Changes requested: 2 open");
    expect(plan.body.split("\n")[1]).toBe(reviewMarker(HEAD, NONCE));
    const input = createInput(PULL, plan);
    expect(input).toMatchObject({ owner: "apache", repo: "skywalking-banyandb", number: 7, event: "COMMENT", commitId: HEAD, idempotencyKey: `publish-${HEAD.slice(0, 12)}-r1` });
    expect(JSON.stringify(input)).not.toMatch(/APPROVE|REQUEST_CHANGES/);
  });

  it("says Review passed only when round 1 has no open issue and round 2 no open postable finding", () => {
    expect(verdictLine(0)).toBe("Review passed");
    expect(verdictLine(3)).toBe("Changes requested: 3 open");
    const passed = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([]), draft: draft([]) });
    expect(passed).toMatchObject({ round: 2, verdict: "passed", open: 0, firstLine: "Review passed", comments: [] });
    expect(passed.body).toContain("Round 1 (design and architecture, from the change report and its questions): no open issue.");
    expect(passed.body).toContain("Round 2 (details, functionality, algorithms): no open finding.");
    // Round 1's open issues decide the verdict, whatever a draft would say; a draft is not even read.
    expect(planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("Q1")]), draft: draft([]) })).toMatchObject({ round: 1, verdict: "changes-requested", open: 1 });
    // Round 2's postable findings are the draft's finding comments: a question it carries is round 1's, never posted twice.
    const open = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([]), draft: draft([entry("F3"), entry("Q9", { kind: "question", aspects: [] })]) });
    expect(open).toMatchObject({ round: 2, verdict: "changes-requested", open: 1, firstLine: "Changes requested: 1 open" });
    expect(open.items.map((i) => i.id)).toEqual(["F3"]);
  });

  it("makes an anchored item an inline comment and puts the others in the body, each ending with its marker", () => {
    const plan = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("N1", { path: "pkg/a.go", line: 4, anchored: true }), issue("Q3", { path: "pkg/a.go", line: 90, anchored: false }), issue("Q4")]) });
    expect(plan.comments).toEqual([{ path: "pkg/a.go", line: 4, side: "RIGHT", body: expect.stringMatching(/<!-- graphloom-finding: N1 -->$/) }]);
    expect(plan.items.map((i) => [i.id, i.inline])).toEqual([["N1", true], ["Q3", false], ["Q4", false]]);
    expect(plan.body).toContain(`(Q3). Why?\n\n${findingMarker("Q3")}`);
    expect(plan.body).toContain(findingMarker("Q4"));
    expect(plan.body).not.toContain(findingMarker("N1"));
    expect(plan.body).toContain("1 item is commented on the diff.");
    for (const i of plan.items) expect(i.body.endsWith(findingMarker(i.id))).toBe(true);
  });

  it("labels a round-2 finding with its severity and aspects, keeps a suggestion for its exact RIGHT range, and marks it F<n>", () => {
    const plan = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([]), draft: draft([entry("F3", { suggestion: "return err", startLine: 10, line: 12, aspects: ["correctness", "security"], severity: "P1", proof: { state: "proven" } }), entry("F4", { anchored: false, line: 400 })]) });
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]).toMatchObject({ path: "pkg/a.go", startLine: 10, line: 12, side: "RIGHT" });
    expect(plan.comments[0]!.body).toBe(`**[P1] major** · correctness, security\n\nThe loop drops the error.\n\n\`\`\`suggestion\nreturn err\n\`\`\`\n\n${findingMarker("F3")}`);
    expect(plan.body).toContain(`**[P2] minor** · correctness · non-behavioral\n\nThe loop drops the error.\n\n${findingMarker("F4")}`);
  });

  it("keeps every item's marker readable (a read cuts a body at 4,000 characters), and every comment inside what a review carries", () => {
    const long = entry("F1", { body: "x".repeat(20_000), suggestion: "y".repeat(5_000) });
    const plan = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([]), draft: draft([long]) });
    expect(plan.comments[0]!.body.length).toBeLessThan(4_000);
    expect(plan.comments[0]!.body).not.toContain("```suggestion");
    expect(plan.comments[0]!.body.endsWith(findingMarker("F1"))).toBe(true);
    const many = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([]), draft: draft(Array.from({ length: 80 }, (_, i) => entry(`F${i + 1}`, { line: i + 1 }))) });
    expect(many.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(many.items.filter((i) => !i.inline)).toHaveLength(30);
    expect(many.body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    const huge = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1(Array.from({ length: 60 }, (_, i) => issue(`Q${i + 1}`, { body: "z".repeat(3_000) }))) });
    expect(huge.body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    expect(huge.firstLine).toBe("Changes requested: 60 open");
    // Nothing is reduced to an id: every item keeps a clipped one-line text and its marker, and its whole text goes to the ledger.
    expect(huge.problem).toBeUndefined();
    for (const x of huge.items) {
      expect(x.body).toMatch(new RegExp(`^\\S.*z+.* <!-- graphloom-finding: ${x.id} -->$`));
      expect(x.body).not.toContain("\n");
      expect(huge.body).toContain(x.body);
      expect(x.full).toContain("z".repeat(3_000));
    }
    expect(huge.body).not.toMatch(/did not fit this body/);
    const patch = ledgerPatch({ head: HEAD }, huge, { reviewId: 1, url: null, how: "created" }, new Map());
    expect(patch.items.every((i) => (i.body ?? "").includes("z".repeat(3_000)))).toBe(true);
  });

  it("moves an anchored item inline before it shrinks the others, and escalates rather than post ids only", () => {
    const mixed = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([...Array.from({ length: 25 }, (_, i) => issue(`Q${i + 1}`, { body: "y".repeat(3_000), path: "pkg/a.go", line: i + 1, anchored: true })), ...Array.from({ length: 25 }, (_, i) => issue(`Q${i + 30}`, { body: "w".repeat(3_000) }))]) });
    expect(mixed.problem).toBeUndefined();
    expect(mixed.items.filter((x) => x.inline)).toHaveLength(25);
    const impossible = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1(Array.from({ length: 700 }, (_, i) => issue(`Q${i + 1}`, { body: "v".repeat(300) }))) });
    expect(impossible.problem).toMatch(/^700 items fit neither inline nor as one-line texts/);
  });

  it("clips every posted body, round 1 and round 2, inline or not, before the marker, and keeps the whole text for the ledger", () => {
    const long = "m".repeat(9_000);
    const r1 = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("Q1", { body: long, path: "pkg/a.go", line: 4, anchored: true }), issue("Q2", { body: long })]) });
    for (const x of r1.items) {
      expect(x.body.length).toBeLessThan(4_000);
      expect(x.body.endsWith(findingMarker(x.id))).toBe(true);
      expect(x.full).toBe(long);
    }
    expect(r1.comments[0]!.body.length).toBeLessThan(4_000);
    const r2 = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([]), draft: draft([entry("F1", { body: long })]) });
    expect(r2.items[0]!.body.length).toBeLessThan(4_000);
    expect(r2.items[0]!.full).toContain(long);
    expect(ledgerPatch({ head: HEAD }, r1, { reviewId: 1, url: null, how: "created" }, new Map()).items[0]!.body).toBe(long);
  });

  it("matches only the terminal marker, and neutralizes marker-looking text in an item's content", () => {
    const quoted = `see ${findingMarker("Q9")} in the thread`;
    const plan = planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("Q1", { body: quoted, path: "pkg/a.go", line: 4, anchored: true }), issue("Q2", { body: `${findingMarker("Q8")} first` })]) });
    for (const x of plan.items) expect([...x.body.matchAll(/<!-- graphloom-finding: /g)]).toHaveLength(1);
    expect(plan.body).not.toContain(findingMarker("Q9"));
    expect(plan.body).not.toContain(findingMarker("Q8"));
    const comments = [{ id: 1, reviewId: 5, body: plan.comments[0]!.body }, { id: 2, reviewId: 5, body: `${findingMarker("Q7")} quoted at the start\n\n${findingMarker("Q3")}\n` }, { id: 3, reviewId: 5, body: `${findingMarker("Q6")} and then nothing at the end` }];
    expect([...commentIds(comments, 5)]).toEqual([["Q1", 1], ["Q3", 2]]);
    // A review's head marker typed into content is inert too.
    expect(planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("Q1", { body: reviewMarker(HEAD, "x") })]) }).items[0]!.body).not.toContain("<!-- graphloom-review");
  });

  it("finds a review of this head only when this credential's login authored it, as COMMENTED, with this run's marker", () => {
    const marked = { id: 41, commitId: HEAD, user: "graphloom-bot", state: "COMMENTED", body: `Review passed\n${reviewMarker(HEAD, NONCE)}\n\nx`, url: "https://github.com/o/r/pull/7#pullrequestreview-41" };
    const find = (r: object, nonce = NONCE) => findPosted([{ ...marked, ...r }], HEAD, nonce, "graphloom-bot");
    expect(find({})).toEqual({ id: 41, url: marked.url });
    expect(find({ commitId: "b".repeat(40) })).toBeUndefined();
    expect(find({ body: "Review passed" })).toBeUndefined();
    expect(find({ body: `x\n${reviewMarker("c".repeat(40), NONCE)}` })).toBeUndefined();
    // The marker is public once posted and the head sha always was: a review by anybody else is not ours.
    expect(find({ user: "mallory" })).toBeUndefined();
    expect(find({ state: "APPROVED" })).toBeUndefined();
    expect(find({ state: "PENDING" })).toBeUndefined();
    // Another run's review of the same head is not this run's.
    expect(find({}, "op7")).toBeUndefined();
    const comments = [{ id: 5, reviewId: 41, body: `a ${findingMarker("N1")}` }, { id: 6, reviewId: 42, body: `a ${findingMarker("Q3")}` }, { id: 7, reviewId: 41, body: `b ${findingMarker("Q4")}` }, { id: 8, reviewId: 41, body: "no marker" }];
    expect([...commentIds(comments, 41)]).toEqual([["N1", 5], ["Q4", 7]]);
  });
});

/** A clean round-1 scenario's run, whole, and the scenario with issues, with the fake GitHub's view of it. */
const clean = (over: Parameters<typeof simulate>[0] = {}): Simulation => simulate({ scenarioName: "review-layer", maxSteps: 600, through: "end", ...over });
/** This run's nonce (the viewer read's operation id): the same in a second simulation of the same scenario, which is how a test seeds a review "of this run". */
const nonceOf = (s: Simulation): string => viewerOf(s.evidence)!.nonce;
const issues = (over: Parameters<typeof simulate>[0] = {}): Simulation => simulate({ scenarioName: "complex-function", maxSteps: 600, through: "end", ...over });
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const publishJobs = (s: Simulation) => s.jobs.filter((j) => j.stageId === "publish").map((j) => j.executor?.id ?? ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id).join(","));
const ledgerPatchOf = (s: Simulation) => {
  const written = readParts(s.evidence, "publish-patch", ".graphloom/review/ledger/publish-patch.json");
  if (written.state !== "read") throw new Error(`the ledger patch was not written: ${written.state}`);
  return JSON.parse(written.value) as { head: string; round: number; verdict: string; reviewId: number; items: Array<{ id: string; origin: string; inline: boolean; commentId: number | null }> };
};

describe("the gate after Answers: issues publish round 1 and end the run, none continue into round 2", () => {
  const sim = issues();

  it("ends the run, complete, after publishing round 1 when round 1 has issues, without any review job", () => {
    const r = recordedRound1(sim.evidence);
    expect(r.state === "read" && r.value.issues.length).toBeGreaterThan(0);
    expect(stopOf(sim)).toMatchObject({ reason: "complete", retryable: false });
    expect(stopOf(sim)!.blocker).toMatch(/^round 1: changes requested: \d+ issues? open on apache\/skywalking-banyandb#7 at 0123456789ab; the review is posted \(https:.*\), and round 2 \(the aspect reviewers\) runs on a later head/);
    expect(sim.jobs.filter((j) => j.stageId === "review" || j.stageId === "draft")).toEqual([]);
    expect(sim.receipts.filter((x) => x.valid).map((x) => x.requirementId).slice(-4)).toEqual(["round1-gated", "code-review", "draft-composed", "review-published"]);
  });

  it("posts exactly one review, whose event is COMMENT and whose first line counts the open issues", () => {
    const n = (recordedRound1(sim.evidence) as { value: Round1Record }).value.issues.length;
    expect(sim.github.creates).toHaveLength(1);
    const c = sim.github.creates[0]!;
    expect(c).toMatchObject({ event: "COMMENT", commitId: HEAD, idempotencyKey: `publish-${HEAD.slice(0, 12)}-r1` });
    expect(String(c.body).split("\n")[0]).toBe(`Changes requested: ${n} open`);
    expect(sim.github.reviews).toHaveLength(1);
  });

  it("reads the reviews before posting, posts, reads the comments back, then records the ids in the ledger", () => {
    expect(publishJobs(sim)).toEqual(["graphloom.github/get-viewer", "graphloom.github/list-pull-reviews", "graphloom.github/create-pull-review", "graphloom.github/list-pull-review-comments", "publish-patch-p1", "ledger-published"]);
    const reads = sim.jobs.filter((j) => j.stageId === "publish" && j.executor !== undefined && j.executor.id !== "graphloom.github/create-pull-review");
    for (const j of reads) expect(j.readOnly).toBe(true);
    const write = sim.jobs.find((j) => j.executor?.id === "graphloom.github/create-pull-review")!;
    expect(write).toMatchObject({ effect: "write", purpose: "diagnostic" });
    expect(write.readOnly).not.toBe(true);
    expect(write.writeScope).toBeUndefined();
  });

  it("records the review id and each item's comment id in the ledger", () => {
    const patch = ledgerPatchOf(sim);
    const review = sim.github.reviews[0]!;
    expect(patch).toMatchObject({ head: HEAD, round: 1, verdict: "changes-requested", reviewId: review.id });
    const inline = patch.items.filter((i) => i.inline);
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.map((i) => i.commentId)).toEqual(review.comments.map((c) => c.id));
    expect(patch.items.filter((i) => !i.inline).every((i) => i.commentId === null)).toBe(true);
    expect(patch.items.every((i) => i.origin === "round1")).toBe(true);
  });

  it("continues into the review layer in the same run when round 1 has none, and publishes round 2's findings", () => {
    const run = clean();
    expect(recordedRound1(run.evidence)).toMatchObject({ state: "read", value: { issues: [] } });
    expect(run.jobs.some((j) => j.stageId === "review" && j.kind === "agent")).toBe(true);
    expect(run.github.creates).toHaveLength(1);
    expect(run.github.creates[0]).toMatchObject({ event: "COMMENT", idempotencyKey: `publish-${HEAD.slice(0, 12)}-r2` });
    const body = String(run.github.creates[0]!.body);
    expect(body.split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body).toContain("Round 1 (design and architecture, from the change report and its questions): no open issue.");
    const patch = ledgerPatchOf(run);
    expect(patch).toMatchObject({ round: 2, verdict: "changes-requested", items: [{ id: "F3", origin: "round2", inline: true, commentId: run.github.reviews[0]!.comments[0]!.id }] });
  });
});

describe("publishing is idempotent across retries and runs: the reviews are read before anything is posted", () => {
  const marked = (nonce: string, over: Partial<FakeReview> = {}): FakeReview => ({ id: 99, body: `Changes requested: 1 open\n${reviewMarker(HEAD, nonce)}\n\nearlier`, commitId: HEAD, state: "COMMENTED", url: "https://github.com/apache/skywalking-banyandb/pull/7#pullrequestreview-99", comments: issues().github.reviews[0]!.comments.map((c, k) => ({ ...c, id: 990 + k })), ...over });

  it("posts nothing when a review of this head already carries the marker, and records that review", () => {
    const sim = issues({ reviews: [marked(nonceOf(issues()))] });
    expect(sim.github.creates).toEqual([]);
    expect(sim.github.reviews).toHaveLength(1);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(ledgerPatchOf(sim).reviewId).toBe(99);
    expect(publishJobs(sim)).toEqual(["graphloom.github/get-viewer", "graphloom.github/list-pull-reviews", "graphloom.github/list-pull-review-comments", "publish-patch-p1", "ledger-published"]);
  });

  it("posts when the review there is of another head, or carries no marker of this graph", () => {
    const sim = issues({ reviews: [marked(nonceOf(issues()), { commitId: "b".repeat(40), id: 98 }), marked(nonceOf(issues()), { body: "Looks good to me", id: 97 })] });
    expect(sim.github.creates).toHaveLength(1);
    expect(sim.github.reviews).toHaveLength(3);
  });

  it("ignores a review that forges the marker: by another author, not COMMENTED, or from another run, and posts its own", () => {
    const n = nonceOf(issues());
    const sim = issues({ reviews: [marked(n, { id: 90, user: "mallory" }), marked(n, { id: 91, state: "APPROVED" }), marked("op1", { id: 92 })] });
    expect(sim.github.creates).toHaveLength(1);
    expect(sim.github.reviews).toHaveLength(4);
    expect([90, 91, 92]).not.toContain(ledgerPatchOf(sim).reviewId);
  });

  it("reconciles an attempt whose outcome is unknown: the reviews are read again, the review that reached GitHub is found, and nothing is posted twice", () => {
    const sim = issues({ create: ["posted-then-failed"] });
    expect(sim.github.creates).toHaveLength(1);
    expect(sim.github.reviews).toHaveLength(1);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(publishJobs(sim).slice(0, 5)).toEqual(["graphloom.github/get-viewer", "graphloom.github/list-pull-reviews", "graphloom.github/create-pull-review", "graphloom.github/list-pull-reviews", "graphloom.github/list-pull-review-comments"]);
    expect(ledgerPatchOf(sim).reviewId).toBe(sim.github.reviews[0]!.id);
  });

  it("posts again after a read that shows the lost attempt left nothing there, and hands a stage that keeps failing to the supervisor", () => {
    const retried = issues({ create: ["lost", "post"] });
    expect(retried.github.creates).toHaveLength(2);
    expect(retried.github.reviews).toHaveLength(1);
    expect(stopOf(retried)).toMatchObject({ reason: "complete" });
    const stuck = issues({ create: ["lost"] });
    expect(stuck.github.creates).toHaveLength(3);
    expect(stuck.final.action.type).toBe("supervise");
    expect(JSON.stringify(stuck.final)).toMatch(/3 attempts to post the review did not produce a review of this head/);
  });

  it("needs the posting job to be read back before the stage validates", () => {
    const sim = issues();
    const evidence = candidateEvidence(sim.evidence, "d1");
    const pull = evidencePull(evidence, profileOf())!;
    const a = analyze(evidence, profileOf(), pull);
    if (a.state !== "ready") throw new Error("not ready");
    const plan = publishPlan(evidence, a.analysis, pull, pinnedBase(evidence));
    if (plan.state !== "ready") throw new Error(plan.state);
    expect(publishFlow(evidence, plan.plan, pull).state).toBe("done");
    // Without the ledger write the stage is not done, and its validator is inconclusive.
    const without = evidence.filter((e) => (e.payload as { command?: { id?: string } } | undefined)?.command?.id !== "ledger-published");
    expect(publishFlow(without, plan.plan, pull).state).toBe("ledger");
    expect(reviewPublished.evaluate({ requirementId: "review-published", statement: "", evidence: without, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "inconclusive" });
    expect(reviewPublished.evaluate({ requirementId: "review-published", statement: "", evidence, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed", reason: expect.stringMatching(/one COMMENT review \(\d+, created\) at head 0123456789ab: Changes requested: \d+ open; round 1/) });
  });
});

describe("the read-back of the posted comments must recover every inline item's id", () => {
  it("reads again when a read lags the post, and records the ids once they show", () => {
    const sim = issues({ hideComments: 1 });
    expect(publishJobs(sim).filter((j) => j === "graphloom.github/list-pull-review-comments")).toHaveLength(2);
    expect(ledgerPatchOf(sim).items.filter((i) => i.inline).every((i) => i.commentId !== null)).toBe(true);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
  });

  it("goes to the supervisor, naming the items, after three reads that lack one, and never records a null id", () => {
    const sim = issues({ hideComments: 9 });
    expect(publishJobs(sim).filter((j) => j === "graphloom.github/list-pull-review-comments")).toHaveLength(3);
    expect(sim.final.action.type).toBe("supervise");
    expect(JSON.stringify(sim.final)).toMatch(/3 reads of the review's comments did not show the inline comments? of /);
    expect(publishJobs(sim)).not.toContain("ledger-published");
  });

  it("is rejected by the validator when the ledger would hold a null id for an inline item", () => {
    const sim = issues();
    const evidence = candidateEvidence(sim.evidence, "d1");
    const pull = evidencePull(evidence, profileOf())!;
    const a = analyze(evidence, profileOf(), pull);
    if (a.state !== "ready") throw new Error("not ready");
    const plan = publishPlan(evidence, a.analysis, pull, pinnedBase(evidence));
    if (plan.state !== "ready") throw new Error(plan.state);
    // The comments the read showed, with the first inline comment taken away: the stage is not done.
    const inline = plan.plan.items.find((x) => x.inline)!;
    const cut = evidence.map((e): EvidenceRecord => {
      const g = (e.payload as { github?: { items?: Array<{ body?: string }> } } | undefined)?.github;
      if (g?.items === undefined || !g.items.some((c) => c.body?.includes(`graphloom-finding: ${inline.id} `))) return e;
      return { ...e, payload: { ...(e.payload as object), github: { ...g, items: g.items.filter((c) => !c.body?.includes(`graphloom-finding: ${inline.id} `)) } } };
    });
    expect(publishFlow(cut, plan.plan, pull).state).not.toBe("done");
    expect(reviewPublished.evaluate({ requirementId: "review-published", statement: "", evidence: cut, candidateDigest: "d1", config: BANYANDB }).status).not.toBe("passed");
  });
});

describe("the validators of the gate and of Publish recompute their records", () => {
  const sim = issues();
  const evidence = candidateEvidence(sim.evidence, "d1");

  it("passes round 1 on the recorded issues and fails it when the record is not what the Q&A recomputes", () => {
    expect(round1Gated.evaluate({ requirementId: "round1-gated", statement: "", evidence, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed", reason: expect.stringMatching(/^round 1 found \d+ issues?/) });
    const tampered = evidence.map((e): EvidenceRecord => {
      const c = (e.payload as { command?: { id: string; argv: string[] } } | undefined)?.command;
      if (c?.id !== "round1") return e;
      const json = JSON.parse(c.argv.slice(6).join("")) as { issues: unknown[] };
      json.issues = json.issues.slice(1);
      return { ...e, payload: { ...(e.payload as object), command: { ...c, argv: [...c.argv.slice(0, 5), "1", JSON.stringify(json)] } } };
    });
    expect(round1Gated.evaluate({ requirementId: "round1-gated", statement: "", evidence: tampered, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "failed", reason: expect.stringContaining("not what necessity.json and qa.json recompute") });
    const unrecorded = evidence.filter((e) => (e.payload as { command?: { id?: string } } | undefined)?.command?.id !== "round1");
    expect(round1Gated.evaluate({ requirementId: "round1-gated", statement: "", evidence: unrecorded, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "inconclusive" });
  });

  it("passes round 1 with no issue and says the same run goes on", () => {
    const run = clean();
    expect(round1Gated.evaluate({ requirementId: "round1-gated", statement: "", evidence: candidateEvidence(run.evidence, "d1"), candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed", reason: expect.stringContaining("the same run continues into the review layer") });
  });
});

describe("the ledger advance that records the published review, against a real repository", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const REF = "refs/graphloom/pr-review/apache/skywalking-banyandb/7/ledger";
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = async (cwd: string, ...args: string[]): Promise<string> => (await sh("git", args, { cwd, env })).stdout.trim();

  /** A repository whose ledger ref holds the Answers stage's commit: ledger.json (this head, one Q&A item), ledger.md, qa.json and report.json. */
  async function ledgerRepo(): Promise<{ dir: string; first: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-ledger-"));
    dirs.push(dir);
    await sh("git", ["init", "-q", "-b", "main", dir], { env });
    const ledger = { schema: "graphloom-pr-ledger-v1", pull: { owner: "apache", repo: "skywalking-banyandb", number: 7 }, heads: [{ sha: "a".repeat(40), reviewed: false }, { sha: HEAD, base: "b".repeat(40), reported: true, reviewed: false }], purposes: [], qa: [{ id: "Q1", type: "purpose", state: "open", history: [] }, { id: "Q2", type: "purpose", state: "open", history: [] }], findings: [] };
    for (const [name, text] of Object.entries({ "ledger.json": JSON.stringify(ledger), "ledger.md": "# apache/skywalking-banyandb#7\n", "qa.json": "{\"q\":1}", "report.json": "{\"r\":1}" })) await writeFile(path.join(dir, name), text);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "answers");
    const first = await git(dir, "rev-parse", "HEAD");
    await git(dir, "update-ref", REF, first);
    return { dir, first };
  }
  const patchOf = (over: Partial<ReturnType<typeof ledgerPatch>> = {}) => ({ ...ledgerPatch({ head: HEAD }, planReview({ pull: PULL, head: HEAD, nonce: NONCE, round1: round1([issue("Q1", { path: "pkg/a.go", line: 4, anchored: true }), issue("N1")]) }), { reviewId: 4242, url: "https://github.com/o/r/pull/7#pullrequestreview-4242", how: "created" }, new Map([["Q1", 777]])), ...over });
  /** As the stage does: the patch is written as a part set with a digest, then the ledger command reads the file. */
  const run = async (dir: string, patch: ReturnType<typeof ledgerPatch>) => {
    for (const part of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", JSON.stringify(patch))) await sh(part.argv[0]!, part.argv.slice(1), { cwd: dir, env });
    const c = ledgerPublishedCommand(PULL, patch, process.execPath);
    return sh(c.argv[0]!, c.argv.slice(1), { cwd: dir, env });
  };

  it("adds one commit that records reviewId on the head and github ids on the items, keeping the other heads and the other files", async () => {
    const { dir, first } = await ledgerRepo();
    const out = await run(dir, patchOf());
    expect(out.stdout).toMatch(/^advanced [0-9a-f]{40}/);
    const now = await git(dir, "rev-parse", REF);
    expect(now).not.toBe(first);
    expect(await git(dir, "rev-parse", `${now}^`)).toBe(first);
    const ledger = JSON.parse(await git(dir, "show", `${now}:ledger.json`)) as { heads: Array<Record<string, unknown>>; qa: Array<Record<string, unknown>>; findings: Array<Record<string, unknown>> };
    expect(ledger.heads[0]).toEqual({ sha: "a".repeat(40), reviewed: false });
    expect(ledger.heads[1]).toMatchObject({ sha: HEAD, reviewId: 4242, reviewed: false, round1: "issues", verdict: "changes-requested", open: 2, reviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-4242" });
    expect(ledger.qa[0]).toMatchObject({ id: "Q1", state: "open", github: { head: HEAD, reviewId: 4242, commentId: 777, inline: true } });
    expect(ledger.qa[1]).not.toHaveProperty("github");
    expect(ledger.findings.map((f) => [f.id, f.origin, f.state, (f.github as { commentId: number | null }).commentId])).toEqual([["Q1", "round1", "open", 777], ["N1", "round1", "open", null]]);
    expect(await git(dir, "show", `${now}:qa.json`)).toBe("{\"q\":1}");
    expect(await git(dir, "show", `${now}:report.json`)).toBe("{\"r\":1}");
    expect(await git(dir, "show", `${now}:ledger.md`)).toContain("apache/skywalking-banyandb#7");
    expect(await git(dir, "log", "-1", "--format=%s", REF)).toBe(`pr-review apache/skywalking-banyandb#7 at ${HEAD.slice(0, 12)}: published review 4242`);
  });

  it("records a patch of about 200 KiB, written as a part set that fits the executor input and read from its file, not an argument", async () => {
    const { dir } = await ledgerRepo();
    const big = patchOf({ items: Array.from({ length: 140 }, (_, i) => ({ id: `Q${i + 1}`, origin: "round1" as const, path: null, line: null, inline: false, commentId: null, body: `${i}:${"b".repeat(2_000)}`, text: `${i}:${"b".repeat(2_000)}` })) });
    const json = JSON.stringify(big);
    expect(json.length).toBeGreaterThan(200_000);
    const parts = partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", json);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(Buffer.byteLength(JSON.stringify({ commands: [part] }), "utf8")).toBeLessThan(256_000);
    const command = ledgerPublishedCommand(PULL, big, process.execPath);
    expect(JSON.stringify(command.argv).length).toBeLessThan(10_000);
    expect(command.argv[6]).toBe(".graphloom/review/ledger/publish-patch.json");
    const out = await run(dir, big);
    expect(out.stdout).toMatch(/^advanced /);
    const ledger = JSON.parse(await git(dir, "show", `${REF}:ledger.json`)) as { findings: Array<{ id: string; body: string }> };
    expect(ledger.findings).toHaveLength(140);
    expect(ledger.findings[139]!.body).toBe(`139:${"b".repeat(2_000)}`);
  });

  it("is a no-op when the ledger already holds that review, so a retry or a resume changes nothing", async () => {
    const { dir } = await ledgerRepo();
    await run(dir, patchOf());
    const once = await git(dir, "rev-parse", REF);
    const again = await run(dir, patchOf());
    expect(again.stdout).toContain("already recorded");
    expect(await git(dir, "rev-parse", REF)).toBe(once);
  });

  it("builds on a ledger another run advanced since, keeping what it added, and a round-2 review marks the head reviewed", async () => {
    const { dir } = await ledgerRepo();
    const other = { schema: "graphloom-pr-ledger-v1", heads: [{ sha: "c".repeat(40), reviewed: true, reviewId: 5 }, { sha: HEAD, reviewed: false }], qa: [], findings: [] };
    await writeFile(path.join(dir, "ledger.json"), JSON.stringify(other));
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "another run");
    await git(dir, "update-ref", REF, await git(dir, "rev-parse", "HEAD"));
    await run(dir, patchOf({ round: 2, verdict: "passed", open: 0, items: [] }));
    const ledger = JSON.parse(await git(dir, "show", `${REF}:ledger.json`)) as { heads: Array<Record<string, unknown>> };
    expect(ledger.heads[0]).toEqual({ sha: "c".repeat(40), reviewed: true, reviewId: 5 });
    expect(ledger.heads[1]).toMatchObject({ sha: HEAD, reviewed: true, round1: "clean", verdict: "passed", reviewId: 4242 });
  });

  it("fails, leaving the ref where it is, when the ledger ref does not exist", async () => {
    const { dir } = await ledgerRepo();
    await git(dir, "update-ref", "-d", REF);
    await expect(run(dir, patchOf())).rejects.toBeTruthy();
    await expect(git(dir, "rev-parse", "--verify", REF)).rejects.toBeTruthy();
  });
});

describe("the Publish stage's paginated reads are its own flow", () => {
  it("do not replace Fetch's complete chain in the pull request snapshot, even when its last page is incomplete", () => {
    const sim = issues();
    const evidence = candidateEvidence(sim.evidence, "d1");
    const pull = evidencePull(evidence, profileOf())!;
    const before = analyze(evidence, profileOf(), pull);
    expect(before.state).toBe("ready");
    const producerOf = (e: EvidenceRecord) => (e.payload as { producer?: { stageId?: string } }).producer;
    const incomplete: EvidenceRecord = { ref: "e-publish-page", kind: "other", candidateDigest: "d1", payload: { producer: { operationId: "opx", stageId: "publish", purpose: "diagnostic", readOnly: true, kind: "command", executorId: "graphloom.github/list-pull-reviews" }, github: { items: [{ id: 1 }], page: { complete: false, nextCursor: "2", startCursor: "1" } } } };
    expect(producerOf(incomplete)!.stageId).toBe("publish");
    const after = analyze([...evidence, incomplete], profileOf(), pull);
    expect(after.state).toBe("ready");
    // Still the whole of Fetch's reviews, not the page that Publish has read so far.
    expect(after.state === "ready" && after.analysis.snapshot.reviews).toEqual(before.state === "ready" ? before.analysis.snapshot.reviews : []);
  });

  it("let the stage ask for the next cursor of a long list of reviews", () => {
    const sim = issues({ reviewPages: 3 });
    expect(sim.jobs.filter((j) => j.executor?.id === "graphloom.github/list-pull-reviews" && j.stageId === "publish")).toHaveLength(3);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
  });
});

describe("posting is the operator's to enable: without the write grant the run ends at Publish with the review ready", () => {
  const withheld = { executors: [{ id: "graphloom.github/create-pull-review", effect: "write" as const, effectGranted: false }] };
  const granted = { executors: [{ id: "graphloom.github/create-pull-review", effect: "write" as const, effectGranted: true }] };

  it("stops before it dispatches anything when the run view says the write is withheld, with no supervisor episode", () => {
    const sim = clean(withheld);
    expect(sim.final.action.type).toBe("stop");
    expect(stopOf(sim)).toMatchObject({ reason: "posting not enabled", retryable: false });
    expect(stopOf(sim)!.blocker).toMatch(/^draft ready; posting is not enabled \(set the runner config's github\.writeTokenEnv and resume to post\)\. The draft is \.graphloom\/review\/draft\.md and the report \.graphloom\/review\/review\.html/);
    // Round 2 path: the files it names exist.
    const files = writtenDraftFiles(sim.evidence);
    expect(files.draftMd.state).toBe("read");
    expect(files.html.state).toBe("read");
    expect(publishJobs(sim)).toEqual([]);
    expect(sim.github.creates).toEqual([]);
    expect(sim.decisions.some((d) => d.action.type === "supervise")).toBe(false);
    // The other work stays: every stage before Publish is accepted.
    expect(sim.receipts.filter((r) => r.valid).map((r) => r.requirementId)).not.toContain("review-published");
    expect(sim.receipts.filter((r) => r.valid).map((r) => r.requirementId)).toContain("round1-gated");
  });

  it("names what exists when round 1 found issues: there is no draft, the report and the round-1 record are the result", () => {
    const sim = issues({ executors: withheld.executors });
    // The complex-function scenario is the round-1 path; the other is the round-2 path.
    const r1 = recordedRound1(sim.evidence);
    expect(r1.state === "read" && r1.value.issues.length).toBeGreaterThan(0);
    const n = (r1 as { value: Round1Record }).value.issues.length;
    expect(stopOf(sim)).toMatchObject({ reason: "posting not enabled", retryable: false });
    expect(stopOf(sim)!.blocker).toBe(`round 1 found ${n} issue${n === 1 ? "" : "s"}; posting is not enabled (set the runner config's github.writeTokenEnv and resume to post). The report is .graphloom/review/review.html and the round-1 record .graphloom/review/round1/round1.json, in the run's worktree`);
    expect(stopOf(sim)!.blocker).not.toContain("draft");
    expect(readParts(sim.evidence, "review-html-qa", ".graphloom/review/review.html").state).toBe("read");
    expect(writtenDraftFiles(sim.evidence).draftMd.state).not.toBe("read");
    expect(sim.jobs.filter((j) => j.stageId === "review" || j.stageId === "draft")).toEqual([]);
  });

  it("posts as before when the write is granted", () => {
    const sim = issues(granted);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(sim.github.creates).toHaveLength(1);
  });

  it("posts as before when the runner reports nothing of its grants", () => {
    expect(stopOf(issues())).toMatchObject({ reason: "complete" });
  });
});
