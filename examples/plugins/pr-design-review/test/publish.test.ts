// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { rm } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { findPostedBy, reviewMarker } from "../src/kit/post.js";
import { partCommands } from "../src/kit/parts.js";
import type { PullRequest } from "../src/kit/request.js";
import { closedLines, createInput, designReviewMarker, ledgerPatch, ledgerPublishedCommand, NOTE_LINE, PASSED_LINE, planReview, ROUND_LINE } from "../src/publish.js";
import { registryOf } from "../src/prior.js";
import { ROUND1_SCHEMA, type Round1Issue, type Round1Record } from "../src/round1.js";
import { LEDGER_PULL, LEDGER_REF, LedgerRepo, v2Ledger } from "./ledgerrepo.js";

const HEAD = "5".repeat(40);
const PULL = { owner: "apache", repo: "skywalking-banyandb", number: 7 };
const PR = { ...PULL, head: HEAD, mode: "review" } as PullRequest;
const issue = (id: string): Round1Issue => ({ id, key: `purpose|item|pkg/${id}.go`, kinds: ["needs-author"], status: "needs author", body: `**needs the author** (${id}). Why?`, anchored: false });
const r1 = (...issues: Round1Issue[]): Round1Record => ({ schema: ROUND1_SCHEMA, head: HEAD, necessity: "necessary", issues });

describe("what the design review posts (design-pr-review-split §3.7)", () => {
  it("nothing for a clean round 1", () => {
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1() });
    expect(plan).toMatchObject({ post: false, note: false, verdict: "passed", open: 0, body: "", items: [] });
  });

  it("the note for a clean round 1 when the profile asks for it, with the footer", () => {
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1(), comments: { designPassedNote: true, footer: "Reviewed by GraphLoom." } });
    expect(plan).toMatchObject({ post: true, note: true, items: [], comments: [] });
    expect(plan.body).toBe(`${PASSED_LINE}\n${designReviewMarker(HEAD, "n")}\n${NOTE_LINE}\n\nReviewed by GraphLoom.`);
  });

  it("the open items, under the verdict, the design marker and the line that names the PR review", () => {
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1(issue("Q1"), issue("Q2")) });
    expect(plan.body.split("\n").slice(0, 3)).toEqual(["Changes requested: 2 open", designReviewMarker(HEAD, "n"), ROUND_LINE]);
    expect(createInput(PR, plan)).toMatchObject({ event: "COMMENT", idempotencyKey: `design-${HEAD.slice(0, 12)}`, commitId: HEAD });
  });

  it("a review carrying the PR review's marker is never this graph's post", () => {
    const review = (marker: string) => ({ id: 1, commitId: HEAD, user: "bot", state: "COMMENTED", body: `Changes requested: 1 open\n${marker}\nx`, url: null });
    expect(findPostedBy([review(reviewMarker(HEAD, "n"))], HEAD, "bot", designReviewMarker(HEAD, "n"))).toBeUndefined();
    expect(findPostedBy([review(designReviewMarker(HEAD, "n"))], HEAD, "bot", designReviewMarker(HEAD, "n"))).toEqual({ id: 1, url: null });
  });

  it("lists the items the v1 migration closed as moved or superseded once, in a post, with their reason and earlier comment", () => {
    const registry = registryOf({
      schema: "graphloom-pr-ledger-v2",
      design: {
        items: [
          { id: "Q4", origin: "round1", key: "missing-test|sym|pkg/a.go|a.F", state: "moved", reason: "a detail question since the split; the PR review judges it as a lead", github: { reviewId: 11, commentId: 21, inline: true } },
          { id: "Q5", origin: "round1", key: "purpose|item|pkg/b.go", state: "superseded", reason: "round 1 now asks per high-level change", listed: "e".repeat(40) },
        ],
      },
    });
    const closed = closedLines(registry, PULL);
    expect(closed).toEqual([{ id: "Q4", state: "moved", reason: "a detail question since the split; the PR review judges it as a lead", link: "https://github.com/apache/skywalking-banyandb/pull/7#discussion_r21" }]);
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1(issue("Q1")), closed });
    expect(plan.body).toContain("- Q4: closed (moved): a detail question since the split; the PR review judges it as a lead ([earlier comment](https://github.com/apache/skywalking-banyandb/pull/7#discussion_r21))");
    expect(plan.listed.map((c) => c.id)).toEqual(["Q4"]);
    // A clean round 1 posts nothing, so nothing is listed and they wait for the next post.
    expect(planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1(), closed }).listed).toEqual([]);
  });
});

describe("the ledger records this head in the design section only (real Git)", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("a clean head: round1 clean with no review id, the earlier item fixed, the review section untouched", async () => {
    const repo = await new LedgerRepo().init(dirs);
    const review = { schema: "pr-review-ledger-v1", heads: [{ sha: "9".repeat(40) }], findings: [{ id: "F1", origin: "round2", state: "open" }] };
    const at = await v2Ledger(repo.dir, { design: { schema: "pr-design-review-ledger-v1", heads: [{ sha: HEAD }], qa: [{ id: "Q1", state: "open" }], items: [{ id: "Q1", origin: "round1", state: "open", history: [] }, { id: "Q4", origin: "round1", state: "moved" }] }, review });
    const design = await repo.git("rev-parse", `${at}:design`);
    const reviewTree = await repo.git("rev-parse", `${at}:review`);
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1(), prior: [{ id: "Q1", status: "fixed", reason: "its question is now answered", carried: false, repost: false, item: { id: "Q1", origin: "round1", key: "k", status: "open", head: "1".repeat(40), history: [] } }] });
    const patch = ledgerPatch({ head: HEAD, base: "b".repeat(40) }, plan, undefined, new Map());
    for (const p of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", JSON.stringify(patch))) await repo.exec(p.argv);
    await repo.exec(ledgerPublishedCommand(PR, patch, { design, review: reviewTree }, process.execPath).argv);
    const now = await repo.git("rev-parse", LEDGER_REF);
    expect(now).not.toBe(at);
    expect(await repo.git("rev-parse", `${now}:review`)).toBe(reviewTree);
    const doc = JSON.parse(await repo.git("show", `${now}:design/ledger.json`)) as { heads: Array<Record<string, unknown>>; items: Array<Record<string, unknown>>; qa: Array<Record<string, unknown>> };
    expect(doc.heads).toEqual([{ sha: HEAD, round1: "clean", open: 0 }]);
    expect(doc.items.find((x) => x.id === "Q1")).toMatchObject({ state: "fixed", fixedIn: HEAD });
    expect(doc.qa).toEqual([{ id: "Q1", state: "fixed" }]);
    expect(await repo.git("log", "-1", "--format=%s", LEDGER_REF)).toBe(`pr-design-review apache/skywalking-banyandb#7 at ${HEAD.slice(0, 12)}: clean, nothing posted`);
  });

  it("a post: the review id on the head, the item with its comment id, and the closed items it listed marked so they are not listed again", async () => {
    const repo = await new LedgerRepo().init(dirs);
    const at = await v2Ledger(repo.dir, { design: { schema: "pr-design-review-ledger-v1", heads: [{ sha: HEAD }], qa: [], items: [{ id: "Q4", origin: "round1", state: "moved", reason: "moved" }] } });
    const design = await repo.git("rev-parse", `${at}:design`);
    const plan = planReview({ pull: PULL, head: HEAD, nonce: "n", round1: r1(issue("Q1")), closed: [{ id: "Q4", state: "moved", reason: "moved" }] });
    const patch = ledgerPatch({ head: HEAD }, plan, { reviewId: 77, url: "https://x/77", how: "created" }, new Map());
    for (const p of partCommands("publish-patch", ".graphloom/review/ledger/publish-patch.json", JSON.stringify(patch))) await repo.exec(p.argv);
    await repo.exec(ledgerPublishedCommand(PR, patch, { design, review: "absent" }, process.execPath).argv);
    const doc = JSON.parse(await repo.git("show", `${LEDGER_REF}:design/ledger.json`)) as { heads: Array<Record<string, unknown>>; items: Array<Record<string, unknown>> };
    expect(doc.heads).toEqual([{ sha: HEAD, round1: "items", open: 1, reviewId: 77, reviewUrl: "https://x/77" }]);
    expect(doc.items.find((x) => x.id === "Q1")).toMatchObject({ state: "open", github: { head: HEAD, reviewId: 77, commentId: null, inline: false } });
    expect(doc.items.find((x) => x.id === "Q4")).toMatchObject({ state: "moved", listed: HEAD });
    expect(closedLines(registryOf({ schema: "graphloom-pr-ledger-v2", design: doc }), LEDGER_PULL)).toEqual([]);
    // The ledger has no review section: this graph never creates one.
    expect((await repo.git("ls-tree", "--name-only", LEDGER_REF)).split("\n")).not.toContain("review");
  });
});
