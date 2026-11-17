// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Posting one review (design-pr-review-graph.md §8.5, design-pr-review-split §5.3), as both review graphs do it: the item and
 * head markers, the reconcile that finds a review this run already posted before anything is posted again, and the read-back
 * of the posted review's comment ids. Which head marker a post carries is the graph's (`<!-- graphloom-review: … -->` for the
 * PR review, `<!-- graphloom-design-review: … -->` for the design review), so a post of one graph is never taken for the
 * other's. What a review holds, and what the ledger records of it, stay with each graph.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { CREATE_PULL_REVIEW, GET_VIEWER, PUBLISH_STAGE } from "./constants.js";
import { isObject, producer } from "./evidence.js";
import type { PullRequest } from "./request.js";
import { READS, readResult, type ReadSpec } from "./snapshot.js";

/**
 * GitHub caps a review body at 65,536 characters, the executor takes at most 50 inline comments and one executor input at
 * most 256,000 bytes, and the reads of the review and its comments cut a body at 4,000 characters, so an item's marker, at the
 * end of its body, must lie within that to be found again.
 */
export const MAX_REVIEW_BODY = 40_000;
export const MAX_INLINE_COMMENTS = 50;

export const findingMarker = (id: string): string => `<!-- graphloom-finding: ${id} -->`;
/** A body longer than this has lost its trailing marker when read back (the read keeps 4,000 characters). */
export const READ_WINDOW = 3_900;
/** An item's posted body: its text, then its marker; a body past what a read keeps leads with the marker too, so the id is still found. */
export function markedBody(id: string, text: string): string {
  const m = findingMarker(id);
  const body = `${text}\n\n${m}`;
  return body.length > READ_WINDOW ? `${m}\n${body}` : body;
}
/** An item's text without its marker or markers. */
export function unmarkedText(id: string, body: string): string {
  const m = findingMarker(id);
  const lead = body.startsWith(`${m}\n`) ? body.slice(m.length + 1) : body;
  return (lead.endsWith(m) ? lead.slice(0, lead.length - m.length) : lead).trim();
}
/** The marker of a PR review (round 2) of `head`: the head and a nonce of the run (its viewer read's operation), which a stranger cannot know. */
export const reviewMarker = (head: string, nonce: string): string => `<!-- graphloom-review: ${head} ${nonce} -->`;
/** The same for a design review (round 1, design-pr-review-split §5.3): a post of either graph is told apart by its marker before its nonce. */
export const designReviewMarker = (head: string, nonce: string): string => `<!-- graphloom-design-review: ${head} ${nonce} -->`;
/** The marker publication appends: the last thing in a body. Marker-looking text in an item's content is neutralized and never matches. */
const MARKER = /<!-- graphloom-finding: ([A-Z][0-9]+) -->$/;
/** The same marker as the first thing in a body: a read cuts a body at 4,000 characters, so a longer body also leads with it. */
const LEADING_MARKER = /^<!-- graphloom-finding: ([A-Z][0-9]+) -->(?:\n|$)/;
/** Content that looks like one of the graphs' markers (or any HTML comment) is made inert, so it cannot be taken for a marker or hide text. */
export const neutralize = (text: string): string => text.replace(/<!--/g, "&lt;!--");

/** The first line of a review: the verdict, and what is open. */
export const verdictLine = (open: number): string => (open === 0 ? "Review passed" : `Changes requested: ${open} open`);

/** The reads a post makes of the pull request's reviews and their comments. */
const spec = (key: ReadSpec["key"]): ReadSpec => READS.find((r) => r.key === key)!;
export const REVIEWS_READ = spec("reviews");
export const COMMENTS_READ = spec("reviewComments");

/**
 * A review of this head that this run posted: authored by the login the credential authenticates as, in state COMMENTED, and carrying
 * `marker` (this graph's head marker with this run's nonce) as the body's second line. The marker alone proves nothing (the head sha is
 * public), so a review by anyone else is ignored, and a review with another graph's marker is not this post.
 */
export function findPostedBy(items: readonly unknown[], head: string, login: string, marker: string): { id: number; url: string | null } | undefined {
  for (const r of items) {
    if (!isObject(r) || typeof r.id !== "number" || r.commitId !== head || r.user !== login || r.state !== "COMMENTED") continue;
    if (typeof r.body === "string" && r.body.split("\n")[1]?.trim() === marker) return { id: r.id, url: typeof r.url === "string" ? r.url : null };
  }
  return undefined;
}

/** The ids of the comments of review `reviewId`, by the finding marker each ends with. */
export function commentIds(items: readonly unknown[], reviewId: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of items) {
    if (!isObject(c) || c.reviewId !== reviewId || typeof c.id !== "number" || typeof c.body !== "string") continue;
    const m = MARKER.exec(c.body.trimEnd()) ?? LEADING_MARKER.exec(c.body);
    if (m !== null && !out.has(m[1]!)) out.set(m[1]!, c.id);
  }
  return out;
}

export interface Posted {
  reviewId: number;
  url: string | null;
  /** How it was established: this attempt created it, the executor reconciled it, or the stage found it before posting. */
  how: "created" | "reconciled" | "found";
}

export const MAX_CREATE_ATTEMPTS = 3;
/** Whole reads of a posted review's comments before a missing inline id goes to the supervisor. */
export const MAX_COMMENT_READS = 3;

/** Who the credential is and this run's nonce, from the viewer read the stage made first (`get-viewer`; its operation id is the nonce). */
export function viewerOf(evidence: readonly EvidenceRecord[]): { login: string; nonce: string } | undefined {
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    const p = producer(e);
    if (p?.stageId !== PUBLISH_STAGE || p.executorId !== GET_VIEWER.id) continue;
    const g = isObject(e.payload) && isObject(e.payload.github) ? e.payload.github : {};
    const item = isObject(g.item) ? g.item : {};
    if (typeof item.login === "string" && item.login !== "") return { login: item.login, nonce: p.operationId.replace(/[^A-Za-z0-9._:-]/g, "_") };
  }
  return undefined;
}

/** What a post needs of the review it posts: its head marker (with the run's nonce), its verdict line and the ids of its inline items. */
export interface PostSpec {
  marker: (head: string, nonce: string) => string;
  firstLine: string;
  inline: readonly string[];
}

export type PostFlow =
  | { state: "viewer"; why: string }
  | { state: "reviews"; cursor?: string; why: string }
  | { state: "create"; why: string }
  | { state: "comments"; reviewId: number; cursor?: string; why: string }
  | { state: "supervise"; reason: string; refs: string[] }
  /** The review is on the pull request, with its comments' ids read back; `readsAt` is where the last read of them is in the evidence. */
  | { state: "posted"; posted: Posted; ids: Map<string, number>; readsAt: number };

const at = (evidence: readonly EvidenceRecord[], ref: string): number => evidence.findIndex((e) => e.ref === ref);

/**
 * Where a post stands, from the evidence alone. Reads and the write are the publish stage's own records. The latest read of the
 * reviews decides whether a review of this head exists; a create after it (an attempt that failed or whose outcome is not known)
 * means the reviews are read again before anything is posted, so an ambiguous attempt is reconciled, never repeated blind.
 */
export function postFlow(evidence: readonly EvidenceRecord[], post: PostSpec, pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">): PostFlow {
  const mine = evidence.filter((e) => producer(e)?.stageId === PUBLISH_STAGE);
  const viewer = viewerOf(evidence);
  if (viewer === undefined) return { state: "viewer", why: "read who the credential authenticates as, so only a review this graph authored is taken for its own" };
  const reviews = readResult(mine, REVIEWS_READ);
  const creates = mine.filter((e) => producer(e)?.executorId === CREATE_PULL_REVIEW.id);
  const lastCreate = creates.at(-1);
  const readAt = reviews === undefined ? -1 : Math.max(...reviews.refs.map((r) => at(evidence, r)));
  if (reviews === undefined || (reviews.complete === false && reviews.nextCursor !== null)) {
    return { state: "reviews", ...(reviews?.nextCursor != null ? { cursor: reviews.nextCursor } : {}), why: reviews === undefined ? "read the pull request's reviews, to find one this graph already posted for this head" : "read the next page of the pull request's reviews" };
  }
  if (!reviews.complete) return { state: "supervise", reason: "the pull request's reviews could not be read whole, so a review already posted for this head cannot be ruled out", refs: reviews.refs };
  let posted: Posted | undefined;
  let postedAt = readAt;
  if (lastCreate !== undefined && at(evidence, lastCreate.ref) > readAt) {
    const g = isObject(lastCreate.payload) && isObject(lastCreate.payload.github) ? lastCreate.payload.github : {};
    const review = isObject(g.review) ? g.review : undefined;
    if ((g.outcome === "created" || g.outcome === "reconciled") && review !== undefined && typeof review.id === "number") {
      posted = { reviewId: review.id, url: typeof review.url === "string" ? review.url : null, how: g.outcome };
      postedAt = at(evidence, lastCreate.ref);
    } else {
      return { state: "reviews", why: "the attempt to post the review did not complete: read the reviews again, so a review that reached GitHub is found and not posted twice" };
    }
  } else {
    const found = findPostedBy(reviews.items, pr.head, viewer.login, post.marker(pr.head, viewer.nonce));
    if (found !== undefined) posted = { reviewId: found.id, url: found.url, how: "found" };
  }
  if (posted === undefined) {
    if (creates.length >= MAX_CREATE_ATTEMPTS) return { state: "supervise", reason: `${creates.length} attempts to post the review did not produce a review of this head`, refs: creates.map((e) => e.ref) };
    return { state: "create", why: `post the review (${post.firstLine}) as one COMMENT review at head ${pr.head.slice(0, 12)}` };
  }
  const later = mine.filter((e) => at(evidence, e.ref) > postedAt);
  const comments = readResult(later, COMMENTS_READ);
  if (comments === undefined || (comments.complete === false && comments.nextCursor !== null)) {
    return { state: "comments", reviewId: posted.reviewId, ...(comments?.nextCursor != null ? { cursor: comments.nextCursor } : {}), why: comments === undefined ? "read the review's comments back, to record their ids" : "read the next page of the review's comments" };
  }
  if (!comments.complete) return { state: "supervise", reason: "the review's comments could not be read whole, so their ids cannot be recorded", refs: comments.refs };
  const ids = commentIds(comments.items, posted.reviewId);
  const missing = post.inline.filter((id) => !ids.has(id));
  if (missing.length > 0) {
    // A read can lag the post: read again (a whole read each time), and escalate when the ids are still missing, never accept a null id.
    const reads = later.filter((e) => producer(e)?.executorId === COMMENTS_READ.pin.id && isObject(e.payload) && isObject(e.payload.github) && (!isObject(e.payload.github.page) || [undefined, "1", "start"].includes(e.payload.github.page.startCursor as string | undefined))).length;
    if (reads >= MAX_COMMENT_READS) return { state: "supervise", reason: `${reads} reads of the review's comments did not show the inline comment${missing.length === 1 ? "" : "s"} of ${missing.join(", ")}, so their ids cannot be recorded`, refs: comments.refs };
    return { state: "comments", reviewId: posted.reviewId, why: `the read of the review's comments lacks ${missing.join(", ")}: read them again` };
  }
  return { state: "posted", posted, ids, readsAt: Math.max(...comments.refs.map((r) => at(evidence, r))) };
}
