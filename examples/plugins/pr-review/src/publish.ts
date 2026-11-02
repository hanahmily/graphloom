// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Publish (design §8.5, §10): the last stage posts the review to the pull request as **one** `COMMENT` review through the
 * `graphloom.github/create-pull-review` executor, whose credential binding the plugin never sees. The review is never
 * `APPROVE` or `REQUEST_CHANGES`; its body's first line is the verdict (`Review passed`, or `Changes requested: <n> open`).
 * What it carries follows from where the run stands (design §9.4): when round 1 found issues, those issues (and the run ends);
 * otherwise round 2's postable findings. Every item ends with its `<!-- graphloom-finding: F3 -->` marker, an issue with a diff
 * anchor is an inline comment and the rest are in the body, and the body carries a marker of the head too, so a review already
 * posted for this head (by an earlier attempt, or an earlier run) is found and never posted twice: before it posts, the stage
 * reads the pull request's reviews, and after an attempt that may or may not have reached GitHub it reads them again.
 * The posted review's id and its comments' ids are recorded in the ledger (`reviewId`, `github` on each item).
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { COMMAND, CREATE_PULL_REVIEW, GET_VIEWER, PUBLISH_STAGE, ledgerRef } from "./constants.js";
import { severityLabel, type Draft, type DraftEntry } from "./draft.js";
import { commandRuns, isObject, producer, succeeded, type CommandRun } from "./evidence.js";
import type { Analysis } from "./analysis.js";
import { GIT_IDENTITY } from "./ledger.js";
import { draftWrites, recordedRound1 } from "./reviewdraft.js";
import type { Round1Record } from "./round1.js";
import type { PullRequest } from "./request.js";
import { READS, readResult, type ReadSpec } from "./snapshot.js";

export const PUBLISH_SCHEMA = "pr-review-publish-v1";
/**
 * GitHub caps a review body at 65,536 characters, the executor takes at most 50 inline comments and one executor input at
 * most 256,000 bytes, and the reads of the review and its comments cut a body at 4,000 characters, so an item's marker, at the
 * end of its body, must lie within that to be found again.
 */
export const MAX_REVIEW_BODY = 40_000;
export const MAX_INLINE_COMMENTS = 50;
const MAX_ITEM_TEXT = 1_800;
const MAX_ITEM_BODY = 3_800;

export const findingMarker = (id: string): string => `<!-- graphloom-finding: ${id} -->`;
/** The marker of this run's review of `head`: the head and a nonce of the run (its viewer read's operation), which a stranger cannot know. */
export const reviewMarker = (head: string, nonce: string): string => `<!-- graphloom-review: ${head} ${nonce} -->`;
const MARKER = /<!-- graphloom-finding: ([A-Z][0-9]+) -->/;

export interface PublishItem {
  /** `N1`, `Q3` or `F3`: the id its marker carries. */
  id: string;
  /** Round 1 (the report and the Q&A) or round 2 (the aspect reviewers). */
  origin: "round1" | "round2";
  /** The comment's text, ending with its marker. */
  body: string;
  path?: string;
  line?: number;
  startLine?: number;
  side: "RIGHT" | "LEFT";
  /** An inline comment on the diff; the others are listed in the review body. */
  inline: boolean;
}

export interface ReviewPlan {
  round: 1 | 2;
  verdict: "passed" | "changes-requested";
  /** The items still open: round 1's issues when it found any, else round 2's postable findings. */
  open: number;
  /** The review body: the verdict first, then the head's marker, the rounds and the items that are not inline. */
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; startLine?: number; body: string }>;
  items: PublishItem[];
  /** The verdict's first line of the body. */
  firstLine: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The first line of the review: the verdict, and what is open. */
export const verdictLine = (open: number): string => (open === 0 ? "Review passed" : `Changes requested: ${open} open`);

function findingBody(e: DraftEntry): string {
  const aspects = e.aspects.length > 0 ? ` · ${e.aspects.join(", ")}` : "";
  const tags = [e.proof?.state === "non-behavioral" ? "non-behavioral" : undefined, e.principle !== undefined ? `breaks principle ${e.principle}` : undefined].filter((t): t is string => t !== undefined);
  const label = `**${e.severity !== undefined ? severityLabel(e.severity) : "[finding]"}**${aspects}${tags.length > 0 ? ` · ${tags.join(" · ")}` : ""}`;
  const text = `${label}\n\n${clip(e.body, MAX_ITEM_TEXT)}`;
  const suggestion = e.suggestion !== undefined && e.anchored && e.side === "RIGHT" ? `\n\n\`\`\`suggestion\n${e.suggestion}\n\`\`\`` : "";
  return text.length + suggestion.length <= MAX_ITEM_BODY - 60 ? `${text}${suggestion}` : text;
}

/**
 * The review for this run: round 1's issues when it found any, otherwise round 2's postable findings (the draft's comments
 * that are findings). The verdict is `Review passed` only when round 1 has no open issue and round 2 no open postable finding.
 * Inline comments are the items with a diff anchor, up to what one review carries; the rest are in the body.
 */
export function planReview(i: { pull: Pick<PullRequest, "owner" | "repo" | "number">; head: string; nonce: string; round1: Round1Record; draft?: Draft | undefined }): ReviewPlan {
  const issues = i.round1.issues;
  const round: 1 | 2 = issues.length > 0 || i.draft === undefined ? 1 : 2;
  const items: PublishItem[] =
    round === 1
      ? issues.map((x) => ({ id: x.id, origin: "round1", body: `${x.body}\n\n${findingMarker(x.id)}`, ...(x.path !== undefined && x.line !== undefined ? { path: x.path, line: x.line } : {}), side: "RIGHT", inline: false }))
      : (i.draft?.comments ?? []).filter((c) => c.kind === "finding").map((e) => ({ id: e.id, origin: "round2", body: `${findingBody(e)}\n\n${findingMarker(e.id)}`, path: e.path, line: e.line, ...(e.startLine !== undefined ? { startLine: e.startLine } : {}), side: e.side, inline: false }));
  const anchoredIds = new Set<string>(round === 1 ? issues.filter((x) => x.anchored).map((x) => x.id) : (i.draft?.comments ?? []).filter((c) => c.kind === "finding" && c.anchored).map((c) => c.id));
  let inline = 0;
  for (const it of items) {
    if (anchoredIds.has(it.id) && it.path !== undefined && it.line !== undefined && inline < MAX_INLINE_COMMENTS) {
      it.inline = true;
      inline += 1;
    }
  }
  const open = items.length;
  const verdict = open === 0 ? "passed" : "changes-requested";
  const firstLine = verdictLine(open);
  const rest = items.filter((x) => !x.inline);
  const round1Line = issues.length > 0 ? `Round 1 (design and architecture, from the change report and its questions): ${issues.length} issue${issues.length === 1 ? "" : "s"} to resolve. The detailed review (round 2) runs after they are fixed.` : "Round 1 (design and architecture, from the change report and its questions): no open issue.";
  const round2Line = round === 2 ? `Round 2 (details, functionality, algorithms): ${i.draft !== undefined && open > 0 ? `${open} open finding${open === 1 ? "" : "s"}.` : "no open finding."}${i.draft !== undefined && i.draft.summary !== "" ? ` ${oneLine(i.draft.summary)}` : ""}` : undefined;
  const sections = [
    `${firstLine}\n${reviewMarker(i.head, i.nonce)}`,
    [round1Line, ...(round2Line !== undefined ? [round2Line] : [])].join("\n\n"),
    ...(inline > 0 ? [`${inline} item${inline === 1 ? " is" : "s are"} commented on the diff.`] : []),
  ];
  // The items that are not inline follow, whole, while they fit; the ones past the bound are named, and are in the ledger.
  let used = sections.join("\n\n").length;
  const listed: string[] = [];
  const omitted: string[] = [];
  for (const x of rest) {
    if (used + x.body.length + 2 <= MAX_REVIEW_BODY - 200) {
      listed.push(x.body);
      used += x.body.length + 2;
    } else omitted.push(x.id);
  }
  const body = [...sections, ...listed, ...(omitted.length > 0 ? [`${omitted.length} more item${omitted.length === 1 ? "" : "s"} did not fit this body: ${omitted.join(", ")}.`] : [])].join("\n\n");
  const comments = items.filter((x) => x.inline).map((x) => ({ path: x.path!, line: x.line!, side: x.side, ...(x.startLine !== undefined && x.startLine < x.line! ? { startLine: x.startLine } : {}), body: x.body }));
  return { round, verdict, open, body, comments, items, firstLine };
}

/** The input of the create-pull-review call: one `COMMENT` review at the pinned head. */
export function createInput(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, plan: ReviewPlan): Record<string, unknown> {
  return { owner: pr.owner, repo: pr.repo, number: pr.number, event: "COMMENT", body: plan.body, comments: plan.comments, commitId: pr.head, idempotencyKey: `publish-${pr.head.slice(0, 12)}-r${plan.round}` };
}

/** The reads the stage makes of the pull request's reviews and their comments. */
const spec = (key: ReadSpec["key"]): ReadSpec => READS.find((r) => r.key === key)!;
export const REVIEWS_READ = spec("reviews");
export const COMMENTS_READ = spec("reviewComments");

/**
 * A review of this head that this run posted: authored by the login the credential authenticates as, in state COMMENTED, and carrying
 * this run's marker. The marker alone proves nothing (the head sha is public), so a review by anyone else is ignored.
 */
export function findPosted(items: readonly unknown[], head: string, nonce: string, login: string): { id: number; url: string | null } | undefined {
  for (const r of items) {
    if (!isObject(r) || typeof r.id !== "number" || r.commitId !== head || r.user !== login || r.state !== "COMMENTED") continue;
    if (typeof r.body === "string" && r.body.includes(reviewMarker(head, nonce))) return { id: r.id, url: typeof r.url === "string" ? r.url : null };
  }
  return undefined;
}

/** The ids of the comments of review `reviewId`, by the finding marker each ends with. */
export function commentIds(items: readonly unknown[], reviewId: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of items) {
    if (!isObject(c) || c.reviewId !== reviewId || typeof c.id !== "number" || typeof c.body !== "string") continue;
    const m = MARKER.exec(c.body);
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

/** What the ledger records of the published review: patched into `ledger.json` by `ledger-published`. */
export interface LedgerPatch {
  schema: typeof PUBLISH_SCHEMA;
  head: string;
  round: 1 | 2;
  verdict: ReviewPlan["verdict"];
  open: number;
  reviewId: number;
  url: string | null;
  items: Array<{ id: string; origin: PublishItem["origin"]; path: string | null; line: number | null; inline: boolean; commentId: number | null }>;
}

export function ledgerPatch(pr: Pick<PullRequest, "head">, plan: ReviewPlan, posted: Posted, ids: ReadonlyMap<string, number>): LedgerPatch {
  return {
    schema: PUBLISH_SCHEMA,
    head: pr.head,
    round: plan.round,
    verdict: plan.verdict,
    open: plan.open,
    reviewId: posted.reviewId,
    url: posted.url,
    items: plan.items.map((x) => ({ id: x.id, origin: x.origin, path: x.path ?? null, line: x.line ?? null, inline: x.inline, commentId: x.inline ? ids.get(x.id) ?? null : null })),
  };
}

export const MAX_CREATE_ATTEMPTS = 3;

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

export type PublishFlow =
  | { state: "viewer"; why: string }
  | { state: "reviews"; cursor?: string; why: string }
  | { state: "create"; why: string }
  | { state: "comments"; reviewId: number; cursor?: string; why: string }
  | { state: "ledger"; posted: Posted; patch: LedgerPatch; run?: CommandRun }
  | { state: "done"; posted: Posted; patch: LedgerPatch }
  | { state: "supervise"; reason: string; refs: string[] };

const at = (evidence: readonly EvidenceRecord[], ref: string): number => evidence.findIndex((e) => e.ref === ref);

/**
 * Where the stage stands, from the evidence alone. Reads and the write are the publish stage's own records. The latest read of
 * the reviews decides whether a review of this head exists; a create after it (an attempt that failed or whose outcome is not
 * known) means the reviews are read again before anything is posted, so an ambiguous attempt is reconciled, never repeated blind.
 */
export function publishFlow(evidence: readonly EvidenceRecord[], plan: ReviewPlan, pr: Pick<PullRequest, "head">): PublishFlow {
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
    const found = findPosted(reviews.items, pr.head, viewer.nonce, viewer.login);
    if (found !== undefined) posted = { reviewId: found.id, url: found.url, how: "found" };
  }
  if (posted === undefined) {
    if (creates.length >= MAX_CREATE_ATTEMPTS) return { state: "supervise", reason: `${creates.length} attempts to post the review did not produce a review of this head`, refs: creates.map((e) => e.ref) };
    return { state: "create", why: `post the review (${plan.firstLine}) as one COMMENT review at head ${pr.head.slice(0, 12)}` };
  }
  const later = mine.filter((e) => at(evidence, e.ref) > postedAt);
  const comments = readResult(later, COMMENTS_READ);
  if (comments === undefined || (comments.complete === false && comments.nextCursor !== null)) {
    return { state: "comments", reviewId: posted.reviewId, ...(comments?.nextCursor != null ? { cursor: comments.nextCursor } : {}), why: comments === undefined ? "read the review's comments back, to record their ids" : "read the next page of the review's comments" };
  }
  const patch = ledgerPatch(pr, plan, posted, commentIds(comments.items, posted.reviewId));
  const run = commandRuns(evidence, COMMAND.ledgerPublished).at(-1);
  const argvPatch = run?.command.argv[6];
  if (run !== undefined && succeeded(run.command) && at(evidence, run.record.ref) > Math.max(...comments.refs.map((r) => at(evidence, r))) && argvPatch === JSON.stringify(patch)) return { state: "done", posted, patch };
  return { state: "ledger", posted, patch, ...(run !== undefined ? { run } : {}) };
}

// ---- the ledger ----

/** The code `ledger-published` runs over the ledger's `ledger.json` and the patch: `SAME` when the ledger already holds this review. */
const MERGE =
  'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{const v=JSON.parse(s);const p=JSON.parse(process.argv[1]);' +
  'const heads=Array.isArray(v.heads)?v.heads:[];const h=heads.find((x)=>x.sha===p.head);' +
  'if(h&&h.reviewId===p.reviewId){process.stdout.write("SAME");return}' +
  'if(h){h.reviewId=p.reviewId;h.reviewed=p.round===2;h.round1=p.round===1?"issues":"clean";h.verdict=p.verdict;h.open=p.open;if(p.url)h.reviewUrl=p.url}' +
  'const github=(it)=>({head:p.head,reviewId:p.reviewId,commentId:it.commentId,inline:it.inline});' +
  'const kept=(Array.isArray(v.findings)?v.findings:[]).filter((f)=>!(f.head===p.head&&p.items.some((it)=>it.id===f.id)));' +
  'for(const it of p.items){kept.push({head:p.head,id:it.id,origin:it.origin,path:it.path,line:it.line,state:"open",github:github(it)});' +
  'const q=(Array.isArray(v.qa)?v.qa:[]).find((x)=>x.id===it.id);if(q){q.state="open";q.github=github(it)}}' +
  'v.heads=heads;v.findings=kept;process.stdout.write(JSON.stringify(v))})';

const PUBLISHED_WRITE =
  String.raw`set -eu; ref="$1"; msg="$2"; patch="$3"; node="$4"; merge="$5"
` +
  GIT_IDENTITY +
  String.raw`
tab=$(printf '\t')
old=$(git -c core.hooksPath=/dev/null rev-parse --verify "$ref")
out=$(git -c core.hooksPath=/dev/null show "$old:ledger.json" | "$node" -e "$merge" "$patch")
if [ "$out" = SAME ]; then echo "already recorded"; exit 0; fi
a=$(printf '%s' "$out" | git -c core.hooksPath=/dev/null hash-object -w --stdin)
rest=$(git -c core.hooksPath=/dev/null ls-tree "$old" | grep -v "$tab"'ledger.json$' || true)
tree=$({ printf '%s\n' "$rest"; printf '100644 blob %s\tledger.json\n' "$a"; } | git -c core.hooksPath=/dev/null mktree)
new=$(git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit-tree "$tree" -p "$old" -m "$msg")
if git -c core.hooksPath=/dev/null update-ref "$ref" "$new" "$old"; then echo "advanced $new"; else echo "ledger moved" >&2; exit 4; fi`;

/**
 * Records the published review in the ledger: the head's `reviewId`, and a `github` entry (review and comment ids) on each
 * item posted, from the ledger the Answers stage advanced. It reads the ref itself and swaps from what it read, so a ledger
 * another run advanced since is built upon, and a review the ledger already holds is a no-op. `node` is the Node binary to run.
 */
export function ledgerPublishedCommand(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, patch: LedgerPatch, node = "node"): EnvironmentCommand {
  return { id: COMMAND.ledgerPublished, argv: ["sh", "-c", PUBLISHED_WRITE, COMMAND.ledgerPublished, ledgerRef(pr.owner, pr.repo, pr.number), `pr-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: published review ${patch.reviewId}`, JSON.stringify(patch), node, MERGE] };
}

// ---- what the stage posts, from the records ----

export type PublishPlan = { state: "ready"; plan: ReviewPlan; round1: Round1Record } | { state: "pending"; reason: string } | { state: "failed"; reason: string; refs: string[] };

/** The review the run posts, recomputed from the recorded round 1 and (when round 1 found no issue) the draft the Draft stage composed. */
export function publishPlan(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, base: string | undefined): PublishPlan {
  const round1 = recordedRound1(evidence);
  if (round1.state === "none") return { state: "pending", reason: "round 1 was not recorded" };
  if (round1.state === "failed") return round1;
  const nonce = viewerOf(evidence)?.nonce ?? "pending";
  if (round1.value.issues.length > 0) return { state: "ready", round1: round1.value, plan: planReview({ pull: pr, head: pr.head, nonce, round1: round1.value }) };
  const w = draftWrites(evidence, analysis, pr, base);
  if (w.state === "pending") return { state: "pending", reason: `the draft cannot be composed: ${w.reason}` };
  if (w.state === "failed") return w;
  return { state: "ready", round1: round1.value, plan: planReview({ pull: pr, head: pr.head, nonce, round1: round1.value, draft: w.writes.draft }) };
}
