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
import { commentIds, createInput, findPosted, findingMarker, ledgerPatch, ledgerPublishedCommand, planReview, publishFlow, publishPlan, reviewMarker, verdictLine, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY } from "../src/publish.js";
import { analyze, evidencePull } from "../src/analysis.js";
import { REHEARSAL_HEAD } from "../src/rehearsal.js";
import { pinnedBase } from "../src/commands.js";
import { recordedRound1 } from "../src/reviewdraft.js";
import { ROUND1_SCHEMA, type Round1Issue, type Round1Record } from "../src/round1.js";
import { reviewPublished, round1Gated } from "../src/reviewvalidators.js";
import { BANYANDB, candidateEvidence, profileOf, simulate, type FakeReview, type Simulation } from "./support.js";

const sh = promisify(execFile);
const HEAD = REHEARSAL_HEAD;
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7, head: HEAD };

const issue = (id: string, over: Partial<Round1Issue> = {}): Round1Issue => ({ id, kinds: ["needs-author"], status: "needs author", body: `**needs the author** (${id}). Why?`, anchored: false, ...over });
const round1 = (issues: Round1Issue[]): Round1Record => ({ schema: ROUND1_SCHEMA, head: HEAD, necessity: "necessary", issues });
const entry = (id: string, over: Partial<DraftEntry> = {}): DraftEntry => ({ id, kind: "finding", aspects: ["correctness"], severity: "P2", proof: { state: "non-behavioral" }, path: "pkg/a.go", side: "RIGHT", line: 12, anchored: true, body: "The loop drops the error.", ...over });
const draft = (comments: DraftEntry[], summary = "Reviewed the whole pull request."): Draft => ({ comments, summary }) as unknown as Draft;

describe("the review the Publish stage posts", () => {
  it("is one COMMENT review at the pinned head, never APPROVE or REQUEST_CHANGES, with the verdict as the first line", () => {
    const plan = planReview({ pull: PULL, head: HEAD, round1: round1([issue("N1"), issue("Q3")]) });
    expect(plan).toMatchObject({ round: 1, verdict: "changes-requested", open: 2, firstLine: "Changes requested: 2 open" });
    expect(plan.body.split("\n")[0]).toBe("Changes requested: 2 open");
    expect(plan.body.split("\n")[1]).toBe(reviewMarker(HEAD));
    const input = createInput(PULL, plan);
    expect(input).toMatchObject({ owner: "apache", repo: "skywalking-banyandb", number: 7, event: "COMMENT", commitId: HEAD, idempotencyKey: `publish-${HEAD.slice(0, 12)}-r1` });
    expect(JSON.stringify(input)).not.toMatch(/APPROVE|REQUEST_CHANGES/);
  });

  it("says Review passed only when round 1 has no open issue and round 2 no open postable finding", () => {
    expect(verdictLine(0)).toBe("Review passed");
    expect(verdictLine(3)).toBe("Changes requested: 3 open");
    const passed = planReview({ pull: PULL, head: HEAD, round1: round1([]), draft: draft([]) });
    expect(passed).toMatchObject({ round: 2, verdict: "passed", open: 0, firstLine: "Review passed", comments: [] });
    expect(passed.body).toContain("Round 1 (design and architecture, from the change report and its questions): no open issue.");
    expect(passed.body).toContain("Round 2 (details, functionality, algorithms): no open finding.");
    // Round 1's open issues decide the verdict, whatever a draft would say; a draft is not even read.
    expect(planReview({ pull: PULL, head: HEAD, round1: round1([issue("Q1")]), draft: draft([]) })).toMatchObject({ round: 1, verdict: "changes-requested", open: 1 });
    // Round 2's postable findings are the draft's finding comments: a question it carries is round 1's, never posted twice.
    const open = planReview({ pull: PULL, head: HEAD, round1: round1([]), draft: draft([entry("F3"), entry("Q9", { kind: "question", aspects: [] })]) });
    expect(open).toMatchObject({ round: 2, verdict: "changes-requested", open: 1, firstLine: "Changes requested: 1 open" });
    expect(open.items.map((i) => i.id)).toEqual(["F3"]);
  });

  it("makes an anchored item an inline comment and puts the others in the body, each ending with its marker", () => {
    const plan = planReview({ pull: PULL, head: HEAD, round1: round1([issue("N1", { path: "pkg/a.go", line: 4, anchored: true }), issue("Q3", { path: "pkg/a.go", line: 90, anchored: false }), issue("Q4")]) });
    expect(plan.comments).toEqual([{ path: "pkg/a.go", line: 4, side: "RIGHT", body: expect.stringMatching(/<!-- graphloom-finding: N1 -->$/) }]);
    expect(plan.items.map((i) => [i.id, i.inline])).toEqual([["N1", true], ["Q3", false], ["Q4", false]]);
    expect(plan.body).toContain(`(Q3). Why?\n\n${findingMarker("Q3")}`);
    expect(plan.body).toContain(findingMarker("Q4"));
    expect(plan.body).not.toContain(findingMarker("N1"));
    expect(plan.body).toContain("1 item is commented on the diff.");
    for (const i of plan.items) expect(i.body.endsWith(findingMarker(i.id))).toBe(true);
  });

  it("labels a round-2 finding with its severity and aspects, keeps a suggestion for its exact RIGHT range, and marks it F<n>", () => {
    const plan = planReview({ pull: PULL, head: HEAD, round1: round1([]), draft: draft([entry("F3", { suggestion: "return err", startLine: 10, line: 12, aspects: ["correctness", "security"], severity: "P1", proof: { state: "proven" } }), entry("F4", { anchored: false, line: 400 })]) });
    expect(plan.comments).toHaveLength(1);
    expect(plan.comments[0]).toMatchObject({ path: "pkg/a.go", startLine: 10, line: 12, side: "RIGHT" });
    expect(plan.comments[0]!.body).toBe(`**[P1] major** · correctness, security\n\nThe loop drops the error.\n\n\`\`\`suggestion\nreturn err\n\`\`\`\n\n${findingMarker("F3")}`);
    expect(plan.body).toContain(`**[P2] minor** · correctness · non-behavioral\n\nThe loop drops the error.\n\n${findingMarker("F4")}`);
  });

  it("keeps every item's marker readable (a read cuts a body at 4,000 characters), and every comment inside what a review carries", () => {
    const long = entry("F1", { body: "x".repeat(20_000), suggestion: "y".repeat(5_000) });
    const plan = planReview({ pull: PULL, head: HEAD, round1: round1([]), draft: draft([long]) });
    expect(plan.comments[0]!.body.length).toBeLessThan(4_000);
    expect(plan.comments[0]!.body).not.toContain("```suggestion");
    expect(plan.comments[0]!.body.endsWith(findingMarker("F1"))).toBe(true);
    const many = planReview({ pull: PULL, head: HEAD, round1: round1([]), draft: draft(Array.from({ length: 80 }, (_, i) => entry(`F${i + 1}`, { line: i + 1 }))) });
    expect(many.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(many.items.filter((i) => !i.inline)).toHaveLength(30);
    expect(many.body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    const huge = planReview({ pull: PULL, head: HEAD, round1: round1(Array.from({ length: 60 }, (_, i) => issue(`Q${i + 1}`, { body: "z".repeat(3_000) }))) });
    expect(huge.body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    expect(huge.body).toMatch(/more items? did not fit this body: /);
    expect(huge.firstLine).toBe("Changes requested: 60 open");
  });

  it("finds a review of this head by its marker, and the ids of a review's comments by theirs", () => {
    const marked = { id: 41, commitId: HEAD, body: `Review passed\n${reviewMarker(HEAD)}\n\nx`, url: "https://github.com/o/r/pull/7#pullrequestreview-41" };
    expect(findPosted([marked], HEAD)).toEqual({ id: 41, url: marked.url });
    expect(findPosted([{ ...marked, commitId: "b".repeat(40) }], HEAD)).toBeUndefined();
    expect(findPosted([{ ...marked, body: "Review passed" }], HEAD)).toBeUndefined();
    expect(findPosted([{ ...marked, body: `x\n${reviewMarker("c".repeat(40))}` }], HEAD)).toBeUndefined();
    const comments = [{ id: 5, reviewId: 41, body: `a ${findingMarker("N1")}` }, { id: 6, reviewId: 42, body: `a ${findingMarker("Q3")}` }, { id: 7, reviewId: 41, body: `b ${findingMarker("Q4")}` }, { id: 8, reviewId: 41, body: "no marker" }];
    expect([...commentIds(comments, 41)]).toEqual([["N1", 5], ["Q4", 7]]);
  });
});

/** A clean round-1 scenario's run, whole, and the scenario with issues, with the fake GitHub's view of it. */
const clean = (over: Parameters<typeof simulate>[0] = {}): Simulation => simulate({ scenarioName: "review-layer", maxSteps: 600, through: "end", ...over });
const issues = (over: Parameters<typeof simulate>[0] = {}): Simulation => simulate({ scenarioName: "complex-function", maxSteps: 600, through: "end", ...over });
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const publishJobs = (s: Simulation) => s.jobs.filter((j) => j.stageId === "publish").map((j) => j.executor?.id ?? ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id).join(","));
const ledgerPatchOf = (s: Simulation) => {
  const job = s.jobs.find((j) => ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).some((c) => c.id === "ledger-published"));
  const argv = (job!.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv;
  return JSON.parse(argv[6]!) as { head: string; round: number; verdict: string; reviewId: number; items: Array<{ id: string; origin: string; inline: boolean; commentId: number | null }> };
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
    expect(publishJobs(sim)).toEqual(["graphloom.github/list-pull-reviews", "graphloom.github/create-pull-review", "graphloom.github/list-pull-review-comments", "ledger-published"]);
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
  const marked = (over: Partial<FakeReview> = {}): FakeReview => ({ id: 99, body: `Changes requested: 1 open\n${reviewMarker(HEAD)}\n\nearlier`, commitId: HEAD, state: "COMMENTED", url: "https://github.com/apache/skywalking-banyandb/pull/7#pullrequestreview-99", comments: [{ id: 990, path: "pkg/schema/ttl.go", line: 1, body: `earlier ${findingMarker("Q1")}` }], ...over });

  it("posts nothing when a review of this head already carries the marker, and records that review", () => {
    const sim = issues({ reviews: [marked()] });
    expect(sim.github.creates).toEqual([]);
    expect(sim.github.reviews).toHaveLength(1);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(ledgerPatchOf(sim).reviewId).toBe(99);
    expect(publishJobs(sim)).toEqual(["graphloom.github/list-pull-reviews", "graphloom.github/list-pull-review-comments", "ledger-published"]);
  });

  it("posts when the review there is of another head, or carries no marker of this graph", () => {
    const sim = issues({ reviews: [marked({ commitId: "b".repeat(40), id: 98 }), marked({ body: "Looks good to me", id: 97 })] });
    expect(sim.github.creates).toHaveLength(1);
    expect(sim.github.reviews).toHaveLength(3);
  });

  it("reconciles an attempt whose outcome is unknown: the reviews are read again, the review that reached GitHub is found, and nothing is posted twice", () => {
    const sim = issues({ create: ["posted-then-failed"] });
    expect(sim.github.creates).toHaveLength(1);
    expect(sim.github.reviews).toHaveLength(1);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(publishJobs(sim).slice(0, 4)).toEqual(["graphloom.github/list-pull-reviews", "graphloom.github/create-pull-review", "graphloom.github/list-pull-reviews", "graphloom.github/list-pull-review-comments"]);
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
  const patchOf = (over: Partial<ReturnType<typeof ledgerPatch>> = {}) => ({ ...ledgerPatch({ head: HEAD }, planReview({ pull: PULL, head: HEAD, round1: round1([issue("Q1", { path: "pkg/a.go", line: 4, anchored: true }), issue("N1")]) }), { reviewId: 4242, url: "https://github.com/o/r/pull/7#pullrequestreview-4242", how: "created" }, new Map([["Q1", 777]])), ...over });
  const run = async (dir: string, patch: ReturnType<typeof ledgerPatch>) => {
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
