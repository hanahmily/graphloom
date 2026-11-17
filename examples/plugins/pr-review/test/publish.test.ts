// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { EvidenceRecord } from "@graphloom/sdk";
import { afterAll, describe, expect, it } from "vitest";
import type { Draft, DraftEntry } from "../src/draft.js";
import { readParts, partCommands } from "../src/kit/parts.js";
import { commentIds, createInput, findPosted, findingMarker, ledgerPatch, ledgerPublishedCommand, MAX_ITEM_TEXT, planReview, publishFlow, publishPlan, designReviewMarker, reviewMarker, viewerOf, verdictLine, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY, type PublishPlan } from "../src/publish.js";
import { analyze, evidencePull } from "../src/kit/analysis.js";
import { measurementState } from "../src/kit/measurements.js";
import { REHEARSAL_HEAD } from "../src/rehearsal.js";
import { pinnedBase } from "../src/kit/commands.js";
import { writtenDraftFiles } from "../src/reviewdraft.js";
import { recordedContext } from "../src/runcontext.js";
import { reviewPublished } from "../src/reviewvalidators.js";
import type { Round1Status } from "../src/context.js";
import { BANYANDB, candidateEvidence, profileOf, simulate, type FakeReview, type Simulation } from "./support.js";

const sh = promisify(execFile);
const HEAD = REHEARSAL_HEAD;
const NONCE = "op42";
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7, head: HEAD };

const entry = (id: string, over: Partial<DraftEntry> = {}): DraftEntry => ({ id, kind: "finding", aspects: ["correctness"], severity: "P2", proof: { state: "non-behavioral" }, path: "pkg/a.go", side: "RIGHT", line: 12, anchored: true, body: "The loop drops the error.", ...over });
const draft = (comments: DraftEntry[], summary = "Reviewed the whole pull request."): Draft => ({ comments, summary, context: { source: "prelude" }, leads: { given: 0, raised: 0 } }) as unknown as Draft;
const plan = (comments: DraftEntry[], round1: Round1Status | null = null, over: Partial<Parameters<typeof planReview>[0]> = {}) => planReview({ pull: PULL, head: HEAD, nonce: NONCE, draft: draft(comments), round1, ...over });
const POSTED = { reviewId: 1, url: null, how: "created" as const };

describe("the review the Publish stage posts", () => {
  it("is one COMMENT review at the pinned head with the PR review's marker and key, never APPROVE or REQUEST_CHANGES, with the verdict as the first line", () => {
    const p = plan([entry("F1"), entry("F2", { line: 20 })]);
    expect(p).toMatchObject({ verdict: "changes-requested", open: 2, openFindings: 2, firstLine: "Changes requested: 2 open" });
    expect(p.body.split("\n")[0]).toBe("Changes requested: 2 open");
    expect(p.body.split("\n")[1]).toBe(reviewMarker(HEAD, NONCE));
    const input = createInput(PULL, p);
    expect(input).toMatchObject({ owner: "apache", repo: "skywalking-banyandb", number: 7, event: "COMMENT", commitId: HEAD, idempotencyKey: `review-${HEAD.slice(0, 12)}` });
    expect(JSON.stringify(input)).not.toMatch(/APPROVE|REQUEST_CHANGES/);
  });

  it("says Review passed only when no finding is open and no round-1 item is open", () => {
    expect(verdictLine(0)).toBe("Review passed");
    expect(verdictLine(3)).toBe("Changes requested: 3 open");
    const passed = plan([]);
    expect(passed).toMatchObject({ verdict: "passed", open: 0, firstLine: "Review passed", comments: [] });
    expect(passed.body).toContain("no open finding.");
    expect(passed.body).toContain("Round 1 (the design review) was not run on this pull request; the verdict counts this review's findings only.");
    expect(plan([], { head: HEAD, open: [] }).firstLine).toBe("Review passed");
    expect(plan([], { head: HEAD, open: [{ id: "Q1" }] })).toMatchObject({ verdict: "changes-requested", open: 1, openFindings: 0 });
  });

  it("makes an anchored finding an inline comment and puts the others in the body, each ending with its marker", () => {
    const p = plan([entry("F1", { line: 4 }), entry("F2", { anchored: false, line: 90 }), entry("F3", { anchored: false })]);
    expect(p.comments).toEqual([{ path: "pkg/a.go", line: 4, side: "RIGHT", body: expect.stringMatching(/<!-- graphloom-finding: F1 -->$/) }]);
    expect(p.items.map((i) => [i.id, i.inline])).toEqual([["F1", true], ["F2", false], ["F3", false]]);
    expect(p.body).toContain(findingMarker("F2"));
    expect(p.body).toContain(findingMarker("F3"));
    expect(p.body).not.toContain(findingMarker("F1"));
    expect(p.body).toContain("1 item is commented on the diff.");
    for (const i of p.items) expect(i.body.endsWith(findingMarker(i.id))).toBe(true);
  });

  it("labels a finding with its severity and aspects, keeps a suggestion for its exact RIGHT range, and marks it F<n>", () => {
    const p = plan([entry("F3", { suggestion: "return err", startLine: 10, line: 12, aspects: ["correctness", "security"], severity: "P1", proof: { state: "proven" } }), entry("F4", { anchored: false, line: 400 })]);
    expect(p.comments).toHaveLength(1);
    expect(p.comments[0]).toMatchObject({ path: "pkg/a.go", startLine: 10, line: 12, side: "RIGHT" });
    expect(p.comments[0]!.body).toBe(`**[P1] major** · correctness, security · proven by a failing test\n\nThe loop drops the error.\n\n\`\`\`suggestion\nreturn err\n\`\`\`\n\n${findingMarker("F3")}`);
    expect(p.body).toContain(`**[P2] minor** · correctness · non-behavioral\n\nThe loop drops the error.\n\n${findingMarker("F4")}`);
  });

  it("labels a confirmed untested-feature finding as a new feature with no test", () => {
    const p = plan([entry("F5", { severity: "P1", aspects: ["maintainability"], lead: { id: "L1", kind: "untested-feature" } })]);
    expect(p.comments[0]!.body.split("\n")[0]).toBe("**[P1] major** · maintainability · non-behavioral · a new feature with no test");
  });

  it("keeps every item's marker readable, and every comment and the body inside what a review carries", () => {
    const long = entry("F1", { body: "x".repeat(20_000), suggestion: "y".repeat(5_000) });
    const p = plan([long]);
    expect(p.comments[0]!.body.length).toBeLessThanOrEqual(MAX_ITEM_TEXT + 300);
    expect(p.comments[0]!.body).not.toContain("```suggestion");
    expect(p.comments[0]!.body.endsWith(findingMarker("F1"))).toBe(true);
    expect(commentIds([{ reviewId: 1, id: 77, body: p.comments[0]!.body.slice(0, 4_000) + "…" }], 1).get("F1")).toBe(77);
    const many = plan(Array.from({ length: 80 }, (_, i) => entry(`F${i + 1}`, { line: i + 1 })));
    expect(many.comments).toHaveLength(MAX_INLINE_COMMENTS);
    expect(many.items.filter((i) => !i.inline)).toHaveLength(30);
    expect(many.body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    const huge = plan(Array.from({ length: 60 }, (_, i) => entry(`F${i + 1}`, { anchored: false, body: "zz ".repeat(1_000).trim() })));
    expect(huge.body.length).toBeLessThanOrEqual(MAX_REVIEW_BODY);
    expect(huge.firstLine).toBe("Changes requested: 60 open");
    // Nothing is reduced to an id: every item keeps a clipped one-line text and its marker, and its whole text goes to the ledger.
    expect(huge.problem).toBeUndefined();
    for (const x of huge.items) {
      expect(x.body).toMatch(new RegExp(`^\\S.*z+.* <!-- graphloom-finding: ${x.id} -->$`));
      expect(huge.body).toContain(x.body);
      expect(x.full).toContain("zz ".repeat(999));
    }
    const patch = ledgerPatch({ head: HEAD }, huge, draft([]), POSTED, new Map());
    expect(patch.items.every((i) => (i.body ?? "").includes("zz ".repeat(999)))).toBe(true);
  });

  it("moves an anchored item inline before it shrinks the others, and escalates rather than post ids only", () => {
    const mixed = plan([...Array.from({ length: 25 }, (_, i) => entry(`F${i + 1}`, { body: "y".repeat(3_000), line: i + 1, anchored: true })), ...Array.from({ length: 25 }, (_, i) => entry(`F${i + 30}`, { body: "w".repeat(3_000), anchored: false }))]);
    expect(mixed.problem).toBeUndefined();
    expect(mixed.items.filter((x) => x.inline)).toHaveLength(25);
    const impossible = plan(Array.from({ length: 700 }, (_, i) => entry(`F${i + 1}`, { body: "v".repeat(300), anchored: false })));
    expect(impossible.problem).toMatch(/^700 items fit neither inline nor as one-line texts/);
  });

  it("matches only the terminal marker, and neutralizes marker-looking text in an item's content", () => {
    const quoted = `see ${findingMarker("F9")} in the thread`;
    const p = plan([entry("F1", { body: quoted, line: 4 }), entry("F2", { body: `${findingMarker("F8")} first`, anchored: false })]);
    for (const x of p.items) expect([...x.body.matchAll(/<!-- graphloom-finding: /g)]).toHaveLength(1);
    expect(p.body).not.toContain(findingMarker("F9"));
    expect(p.body).not.toContain(findingMarker("F8"));
    const comments = [{ id: 1, reviewId: 5, body: p.comments[0]!.body }, { id: 2, reviewId: 5, body: `${findingMarker("F7")} quoted at the start\n\n${findingMarker("F3")}\n` }, { id: 3, reviewId: 5, body: `${findingMarker("F6")} and then nothing at the end` }];
    expect([...commentIds(comments, 5)]).toEqual([["F1", 1], ["F3", 2]]);
    expect(plan([entry("F1", { body: `${reviewMarker(HEAD, "x")} ${designReviewMarker(HEAD, "x")}` })]).items[0]!.body).not.toMatch(/<!-- graphloom-(design-)?review/);
  });

  it("appends the profile's footer, neutralized", () => {
    const p = plan([], null, { comments: { footer: "Reviewed by GraphLoom." } });
    expect(p.body.endsWith("\n\nReviewed by GraphLoom.")).toBe(true);
  });

  it("finds a review of this head only when this credential's login authored it, as COMMENTED, with this run's marker", () => {
    const marked = { id: 41, commitId: HEAD, user: "graphloom-bot", state: "COMMENTED", body: `Review passed\n${reviewMarker(HEAD, NONCE)}\n\nx`, url: "https://github.com/o/r/pull/7#pullrequestreview-41" };
    const find = (r: object, nonce = NONCE) => findPosted([{ ...marked, ...r }], HEAD, nonce, "graphloom-bot");
    expect(find({})).toEqual({ id: 41, url: marked.url });
    expect(find({ commitId: "b".repeat(40) })).toBeUndefined();
    expect(find({ body: "Review passed" })).toBeUndefined();
    expect(find({ user: "mallory" })).toBeUndefined();
    expect(find({ state: "APPROVED" })).toBeUndefined();
    expect(find({}, "op7")).toBeUndefined();
    // The design review's post of this head, even with this run's nonce, is never this graph's (design-pr-review-split §5.3).
    expect(find({ body: `Changes requested: 1 open\n${designReviewMarker(HEAD, NONCE)}\n\nx` })).toBeUndefined();
    expect(find({ body: `Review passed\n\n${reviewMarker(HEAD, NONCE)}` })).toBeUndefined();
  });
});

/** A whole run of the review-layer scenario, with the fake GitHub's view of it. */
const run = (over: Parameters<typeof simulate>[0] = {}): Simulation => simulate({ scenarioName: "review-layer", maxSteps: 600, through: "end", ...over });
/** This run's nonce (the viewer read's operation id): the same in a second simulation of the same scenario, which is how a test seeds a review "of this run". */
const nonceOf = (s: Simulation): string => viewerOf(s.evidence)!.nonce;
const stopOf = (s: Simulation) => (s.final.action.type === "stop" ? s.final.action.stop : undefined);
const publishJobs = (s: Simulation) => s.jobs.filter((j) => j.stageId === "publish").map((j) => j.executor?.id ?? ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).map((c) => c.id).join(","));
const ledgerPatchOf = (s: Simulation) => {
  const written = readParts(s.evidence, "publish-patch", ".graphloom/review/ledger/publish-patch.json");
  if (written.state !== "read") throw new Error(`the ledger patch was not written: ${written.state}`);
  return JSON.parse(written.value) as { head: string; verdict: string; reviewId: number; context: unknown; round1: unknown; items: Array<{ id: string; origin: string; inline: boolean; commentId: number | null }> };
};
/** What the Publish stage plans and where it stands, recomputed from a run's evidence as the validator sees it. */
function planned(evidence: EvidenceRecord[]): { plan: Extract<PublishPlan, { state: "ready" }>; pull: ReturnType<typeof evidencePull> & object } {
  const pull = evidencePull(evidence, profileOf())!;
  const a = analyze(evidence, profileOf(), pull);
  if (a.state !== "ready") throw new Error("not ready");
  const c = recordedContext(evidence);
  if (c.state !== "read") throw new Error("no context");
  const p = publishPlan(evidence, a.analysis, pull, pinnedBase(evidence), c.value, measurementState(evidence, a.analysis.snapshot.files, profileOf()), profileOf());
  if (p.state !== "ready") throw new Error(p.state);
  return { plan: p, pull };
}

describe("a run posts round 2 once and records it in the review section", () => {
  const sim = run();

  it("ends complete with the verdict, after one COMMENT review under the PR review's key", () => {
    expect(stopOf(sim)).toMatchObject({ reason: "complete", retryable: false });
    expect(stopOf(sim)!.blocker).toMatch(/^changes requested: 1 open on apache\/skywalking-banyandb#7 at 0123456789ab; the review is posted \(https:/);
    expect(sim.github.creates).toHaveLength(1);
    expect(sim.github.creates[0]).toMatchObject({ event: "COMMENT", commitId: HEAD, idempotencyKey: `review-${HEAD.slice(0, 12)}` });
    const body = String(sim.github.creates[0]!.body);
    expect(body.split("\n")[0]).toBe("Changes requested: 1 open");
    expect(body.split("\n")[1]).toBe(reviewMarker(HEAD, nonceOf(sim)));
    expect(body).toContain("Round 1 (the design review) was not run on this pull request");
  });

  it("reads the reviews before posting, posts, reads the comments back, then records the ids in the ledger", () => {
    expect(publishJobs(sim)).toEqual(["graphloom.github/get-viewer", "graphloom.github/list-pull-reviews", "graphloom.github/create-pull-review", "graphloom.github/list-pull-review-comments", "publish-patch-p1", "ledger-published"]);
    for (const j of sim.jobs.filter((x) => x.stageId === "publish" && x.executor !== undefined && x.executor.id !== "graphloom.github/create-pull-review")) expect(j.readOnly).toBe(true);
    const write = sim.jobs.find((j) => j.executor?.id === "graphloom.github/create-pull-review")!;
    expect(write).toMatchObject({ effect: "write", purpose: "diagnostic" });
    expect(write.readOnly).not.toBe(true);
  });

  it("records the review id, the context source, the round-1 head (none) and each item's comment id", () => {
    const patch = ledgerPatchOf(sim);
    expect(patch).toMatchObject({ head: HEAD, verdict: "changes-requested", reviewId: sim.github.reviews[0]!.id, context: { source: "prelude" }, round1: null });
    expect(patch.items).toEqual([expect.objectContaining({ id: "F3", origin: "round2", inline: true, commentId: sim.github.reviews[0]!.comments[0]!.id })]);
    const c = sim.jobs.find((j) => ((j.input as { commands?: Array<{ id: string }> }).commands ?? []).some((x) => x.id === "ledger-published"))!;
    // The review section only: the design section is never written by this graph.
    expect((c.input as { commands: Array<{ argv: string[] }> }).commands[0]!.argv[8]).toBe("review");
  });

  it("needs the ledger write before the stage validates", () => {
    const evidence = candidateEvidence(sim.evidence, "d1");
    const { plan: p, pull } = planned(evidence);
    expect(publishFlow(evidence, p.plan, p.draft, pull).state).toBe("done");
    const without = evidence.filter((e) => (e.payload as { command?: { id?: string } } | undefined)?.command?.id !== "ledger-published");
    expect(publishFlow(without, p.plan, p.draft, pull).state).toBe("ledger");
    expect(reviewPublished.evaluate({ requirementId: "review-published", statement: "", evidence: without, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "inconclusive" });
    expect(reviewPublished.evaluate({ requirementId: "review-published", statement: "", evidence, candidateDigest: "d1", config: BANYANDB })).toMatchObject({ status: "passed", reason: expect.stringMatching(/one COMMENT review \(\d+, created\) at head 0123456789ab: Changes requested: 1 open \(1 open finding\(s\); round 1 not run\)/) });
  });
});

describe("publishing is idempotent across retries and runs: the reviews are read before anything is posted", () => {
  const first = run();
  const marked = (nonce: string, over: Partial<FakeReview> = {}): FakeReview => ({ id: 99, body: `Changes requested: 1 open\n${reviewMarker(HEAD, nonce)}\n\nearlier`, commitId: HEAD, state: "COMMENTED", url: "https://github.com/apache/skywalking-banyandb/pull/7#pullrequestreview-99", comments: first.github.reviews[0]!.comments.map((c, k) => ({ ...c, id: 990 + k })), ...over });

  it("posts nothing when a review of this head already carries the marker, and records that review", () => {
    const sim = run({ reviews: [marked(nonceOf(first))] });
    expect(sim.github.creates).toEqual([]);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(ledgerPatchOf(sim).reviewId).toBe(99);
    expect(publishJobs(sim)).toEqual(["graphloom.github/get-viewer", "graphloom.github/list-pull-reviews", "graphloom.github/list-pull-review-comments", "publish-patch-p1", "ledger-published"]);
  });

  it("posts when the review there is of another head, carries no marker of this graph, or is the design review's", () => {
    const n = nonceOf(first);
    const sim = run({ reviews: [marked(n, { commitId: "b".repeat(40), id: 98 }), marked(n, { body: "Looks good to me", id: 97 }), marked(n, { id: 96, body: `Changes requested: 1 open\n${designReviewMarker(HEAD, n)}\n\nround 1`, comments: [] })] });
    expect(sim.github.creates).toHaveLength(1);
    expect([96, 97, 98]).not.toContain(ledgerPatchOf(sim).reviewId);
  });

  it("ignores a review that forges the marker: by another author, not COMMENTED, or from another run", () => {
    const n = nonceOf(first);
    const sim = run({ reviews: [marked(n, { id: 90, user: "mallory" }), marked(n, { id: 91, state: "APPROVED" }), marked("op1", { id: 92 })] });
    expect(sim.github.creates).toHaveLength(1);
    expect([90, 91, 92]).not.toContain(ledgerPatchOf(sim).reviewId);
  });

  it("reconciles an attempt whose outcome is unknown, and posts again only after a read shows nothing there", () => {
    const sim = run({ create: ["posted-then-failed"] });
    expect(sim.github.creates).toHaveLength(1);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
    expect(ledgerPatchOf(sim).reviewId).toBe(sim.github.reviews[0]!.id);
    const retried = run({ create: ["lost", "post"] });
    expect(retried.github.creates).toHaveLength(2);
    expect(retried.github.reviews).toHaveLength(1);
    const stuck = run({ create: ["lost"] });
    expect(stuck.github.creates).toHaveLength(3);
    expect(stuck.final.action.type).toBe("supervise");
  });

  it("reads the comments again when a read lags the post, and goes to the supervisor after three that lack one", () => {
    const lag = run({ hideComments: 1 });
    expect(publishJobs(lag).filter((j) => j === "graphloom.github/list-pull-review-comments")).toHaveLength(2);
    expect(ledgerPatchOf(lag).items.filter((i) => i.inline).every((i) => i.commentId !== null)).toBe(true);
    const lost = run({ hideComments: 9 });
    expect(lost.final.action.type).toBe("supervise");
    expect(publishJobs(lost)).not.toContain("ledger-published");
  });

  it("asks for the next page with the cursor of a long list of reviews", () => {
    const sim = run({ reviewPages: 3 });
    expect(sim.jobs.filter((j) => j.executor?.id === "graphloom.github/list-pull-reviews" && j.stageId === "publish")).toHaveLength(3);
    expect(stopOf(sim)).toMatchObject({ reason: "complete" });
  });
});

describe("posting is the operator's to enable", () => {
  it("stops before it dispatches anything when the write is withheld, naming the draft and the report", () => {
    const sim = run({ executors: [{ id: "graphloom.github/create-pull-review", effect: "write", effectGranted: false }] });
    expect(stopOf(sim)).toMatchObject({ reason: "posting not enabled", retryable: false });
    expect(stopOf(sim)!.blocker).toBe("draft ready; posting is not enabled (set the runner config's github.writeTokenEnv and resume to post). The draft is .graphloom/review/draft.md and the report .graphloom/review/review.html, in the run's worktree");
    expect(writtenDraftFiles(sim.evidence).html.state).toBe("read");
    expect(publishJobs(sim)).toEqual([]);
    expect(sim.decisions.some((d) => d.action.type === "supervise")).toBe(false);
  });

  it("names review.md as the report when there is none (--no-report)", async () => {
    const { REHEARSAL_REQUEST_NO_REPORT } = await import("../src/rehearsal.js");
    const sim = simulate({ scenarioName: "no-report", request: REHEARSAL_REQUEST_NO_REPORT, executors: [{ id: "graphloom.github/create-pull-review", effect: "write", effectGranted: false }] });
    expect(stopOf(sim)!.blocker).toContain("the report .graphloom/review/review.md");
    expect(writtenDraftFiles(sim.evidence).html.state).toBe("none");
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
  const TOP = JSON.stringify({ schema: "graphloom-pr-ledger-v2", pull: { owner: "apache", repo: "skywalking-banyandb", number: 7 }, sections: ["design", "review"] });
  const DESIGN = JSON.stringify({ schema: "pr-design-review-ledger-v1", heads: [{ sha: "a".repeat(40), round1: "clean", open: 0 }], purposes: [], qa: [], items: [] });

  /** A repository whose ledger ref holds the Draft stage's commit: the v2 ledger.json, a design section, and the review section with this head. */
  async function ledgerRepo(): Promise<{ dir: string; first: string; baselines: { design: string; review: string } }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr-review-ledger-"));
    dirs.push(dir);
    await sh("git", ["init", "-q", "-b", "main", dir], { env });
    const review = { schema: "pr-review-ledger-v1", heads: [{ sha: "c".repeat(40), reviewId: 5 }, { sha: HEAD, base: "b".repeat(40), context: { source: "prelude" }, round1: null, leads: { given: 1, raised: 0 } }], findings: [] };
    await mkdir(path.join(dir, "design"));
    await mkdir(path.join(dir, "review"));
    for (const [name, text] of Object.entries({ "ledger.json": TOP, "design/ledger.json": DESIGN, "design/ledger.md": "# d\n", "review/ledger.json": JSON.stringify(review), "review/ledger.md": "# apache/skywalking-banyandb#7: the PR review\n" })) await writeFile(path.join(dir, name), text);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "draft");
    const first = await git(dir, "rev-parse", "HEAD");
    await git(dir, "update-ref", REF, first);
    return { dir, first, baselines: { design: await git(dir, "rev-parse", `${first}:design`), review: await git(dir, "rev-parse", `${first}:review`) } };
  }
  /** Another run's commit on the ref: `files` replace the paths they name in the ref's current tree. */
  async function advance(dir: string, files: Record<string, string>): Promise<string> {
    await git(dir, "checkout", "-q", "--detach", REF);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "another run");
    const sha = await git(dir, "rev-parse", "HEAD");
    await git(dir, "update-ref", REF, sha);
    return sha;
  }
  const round1: Round1Status = { head: "a".repeat(40), open: [{ id: "Q1", link: "https://github.com/o/r/pull/7#discussion_r1" }] };
  const patchOf = (over: Partial<ReturnType<typeof ledgerPatch>> = {}) => ({ ...ledgerPatch({ head: HEAD, base: "b".repeat(40) }, plan([entry("F1", { line: 4 }), entry("F2", { anchored: false })], round1), draft([]), { reviewId: 4242, url: "https://github.com/o/r/pull/7#pullrequestreview-4242", how: "created" }, new Map([["F1", 777]])), ...over });
  const write = async (dir: string, patch: ReturnType<typeof ledgerPatch>, baselines: { design: string; review: string }) => {
    for (const part of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", JSON.stringify(patch))) await sh(part.argv[0]!, part.argv.slice(1), { cwd: dir, env });
    const c = ledgerPublishedCommand(PULL, patch, baselines, process.execPath);
    return sh(c.argv[0]!, c.argv.slice(1), { cwd: dir, env });
  };
  type ReviewDoc = { heads: Array<Record<string, unknown>>; findings: Array<Record<string, unknown>> };

  it("adds one commit that records the review on the review section's head and findings, keeping the other heads, the design section and the top-level ledger.json", async () => {
    const { dir, first, baselines } = await ledgerRepo();
    const out = await write(dir, patchOf(), baselines);
    expect(out.stdout).toMatch(/^advanced [0-9a-f]{40}/);
    const now = await git(dir, "rev-parse", REF);
    expect(await git(dir, "rev-parse", `${now}^`)).toBe(first);
    const review = JSON.parse(await git(dir, "show", `${now}:review/ledger.json`)) as ReviewDoc;
    expect(review.heads[0]).toEqual({ sha: "c".repeat(40), reviewId: 5 });
    expect(review.heads[1]).toEqual({ sha: HEAD, base: "b".repeat(40), context: { source: "prelude" }, round1: { head: "a".repeat(40), open: 1 }, reviewId: 4242, reviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-4242", verdict: "changes-requested", open: 3, leads: { given: 0, raised: 0 } });
    expect(review.findings.map((f) => [f.id, f.origin, f.state, (f.github as { commentId: number | null }).commentId])).toEqual([["F1", "round2", "open", 777], ["F2", "round2", "open", null]]);
    expect(await git(dir, "rev-parse", `${now}:design`)).toBe(baselines.design);
    expect(await git(dir, "show", `${now}:ledger.json`)).toBe(TOP);
    expect(await git(dir, "log", "-1", "--format=%s", REF)).toBe(`pr-review apache/skywalking-banyandb#7 at ${HEAD.slice(0, 12)}: published review 4242`);
  });

  it("records a patch of about 200 KiB, written as a part set and read from its file, not an argument", async () => {
    const { dir, baselines } = await ledgerRepo();
    const big = patchOf({ items: Array.from({ length: 140 }, (_, i) => ({ id: `F${i + 1}`, origin: "round2" as const, path: null, line: null, inline: false, commentId: null, body: `${i}:${"b".repeat(2_000)}`, text: `${i}:${"b".repeat(2_000)}` })) });
    const json = JSON.stringify(big);
    expect(json.length).toBeGreaterThan(200_000);
    const parts = partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", json);
    expect(parts.length).toBeGreaterThan(1);
    const command = ledgerPublishedCommand(PULL, big, baselines, process.execPath);
    for (const a of command.argv) expect(a.length).toBeLessThanOrEqual(4_096);
    expect((await write(dir, big, baselines)).stdout).toMatch(/^advanced /);
    const review = JSON.parse(await git(dir, "show", `${REF}:review/ledger.json`)) as ReviewDoc;
    expect(review.findings).toHaveLength(140);
  });

  it("is a no-op when the ledger already holds that review", async () => {
    const { dir, baselines } = await ledgerRepo();
    await write(dir, patchOf(), baselines);
    const once = await git(dir, "rev-parse", REF);
    expect((await write(dir, patchOf(), baselines)).stdout).toContain("already recorded");
    expect(await git(dir, "rev-parse", REF)).toBe(once);
  });

  it("carries the design section when the design review moved it in between", async () => {
    const { dir, baselines } = await ledgerRepo();
    const other = await advance(dir, { "design/ledger.json": JSON.stringify({ schema: "pr-design-review-ledger-v1", heads: [{ sha: "d".repeat(40) }] }) });
    expect((await write(dir, patchOf(), baselines)).stdout).toMatch(/^advanced /);
    const now = await git(dir, "rev-parse", REF);
    expect(await git(dir, "rev-parse", `${now}^`)).toBe(other);
    expect(await git(dir, "rev-parse", `${now}:design`)).toBe(await git(dir, "rev-parse", `${other}:design`));
  });

  it("stops \"ledger moved\" when the review section is not its baseline, leaving the ref where the other run put it", async () => {
    const { dir, baselines } = await ledgerRepo();
    const moved = await advance(dir, { "review/ledger.json": JSON.stringify({ schema: "pr-review-ledger-v1", heads: [], findings: [{ id: "F1" }] }) });
    await expect(write(dir, patchOf(), baselines)).rejects.toMatchObject({ code: 4, stderr: expect.stringContaining("ledger moved: its review section") });
    expect(await git(dir, "rev-parse", REF)).toBe(moved);
  });

  it("fails, leaving the ref where it is, when the ledger ref does not exist", async () => {
    const { dir, baselines } = await ledgerRepo();
    await git(dir, "update-ref", "-d", REF);
    await expect(write(dir, patchOf(), baselines)).rejects.toBeTruthy();
    await expect(git(dir, "rev-parse", "--verify", REF)).rejects.toBeTruthy();
  });
});
