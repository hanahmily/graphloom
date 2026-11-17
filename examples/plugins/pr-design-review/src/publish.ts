// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Publish (design-pr-review-split §3.7): the design review posts round 1's open items, when there are any, as **one** `COMMENT`
 * review through the `graphloom.github/create-pull-review` executor, whose credential binding the plugin never sees. Its body's
 * first line is `Changes requested: <n> open`, its second the head marker `<!-- graphloom-design-review: <head> <nonce> -->`, its
 * third says it is the design review (round 1) and that the PR review (`pr-review`) reviews the details; the idempotency key is
 * `design-<head12>`. A clean round 1 posts nothing: the stage records the head in the ledger's `design` section as `clean`, with
 * no GitHub write and no write grant. A profile that sets `comments.designPassedNote` has a clean round 1 post one review with no
 * item instead (`Design review passed`, the marker, a line saying the PR review follows), posted, reconciled and recorded like any.
 * The post itself (the reconcile before posting, the read-back of the comment ids) is the review kit's (`kit/post.ts`).
 *
 * On a later head the body also says what became of the items an earlier head posted (fixed, or still open with a link to its
 * earlier comment), and lists once each item the v1 migration closed as `moved` or `superseded` (§5.4).
 */
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import { COMMAND, PART_BASE, PUBLISH_PATCH_FILE, ledgerRef } from "./kit/constants.js";
import { fitParts, type ItemParts } from "./kit/answertext.js";
import { clip, clipKeep } from "./kit/escape.js";
import { partCommands, readParts } from "./kit/parts.js";
import { commandRuns, isObject, succeeded, type CommandRun } from "./kit/evidence.js";
import type { Analysis } from "./kit/analysis.js";
import { publishBaselines, PUBLISHED_WRITE } from "./kit/ledger.js";
import { reviewMarkdown, type Section } from "./kit/ledgerv2.js";
import { pinnedBase } from "./kit/commands.js";
import { designReviewMarker, findingMarker, markedBody, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY, neutralize, postFlow, unmarkedText, verdictLine, viewerOf, type Posted, type PostFlow } from "./kit/post.js";
import type { CommentsConfig } from "./kit/profile.js";
import type { PullRequest } from "./kit/request.js";
import { registryFromEvidence, type PriorItem, type PriorRegistry } from "./prior.js";
import { MAX_ITEM_TEXT, recordedRound1, type Round1Covered, type Round1Record } from "./round1.js";

export { commentIds, designReviewMarker, findingMarker, markedBody, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY, neutralize, unmarkedText, verdictLine, viewerOf, type Posted } from "./kit/post.js";

export const PUBLISH_SCHEMA = "pr-design-review-publish-v1";
/** The first line of a clean round 1's note (§3.7). */
export const PASSED_LINE = "Design review passed";
/** The third line of a post: which review this is, and who reviews the rest. */
export const ROUND_LINE = "This is the design review (round 1: is the change necessary, what each feature is for, does the codebase already have it). The PR review (`pr-review`) reviews the details: correctness, maintainability, security, tests and complexity.";
/** The note's third line. */
export const NOTE_LINE = "The design review found no open item on this head. The PR review (`pr-review`) follows: it reviews the details.";

/** What one item may take before it is shortened. Far below the 65,536 characters GitHub accepts in a comment. */
const MAX_ITEM_BODY = MAX_ITEM_TEXT + 2_000;
/** The least text a compacted item keeps: a one-liner shorter than this says too little to act on. */
const MIN_ONE_LINER = 80;
/** Room kept in the executor input for what the plan does not measure (the idempotency key and the like). */
const INPUT_MARGIN = 1_000;

const neutralParts = (p: ItemParts): ItemParts => ({ ...p, head: neutralize(p.head), answer: neutralize(p.answer), cites: p.cites.map(neutralize), proposal: neutralize(p.proposal), ...(p.tail !== undefined ? { tail: neutralize(p.tail) } : {}) });
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface PublishItem {
  /** `N1` or `Q3`: the id its marker carries. */
  id: string;
  /** The comment's text, ending with its marker. */
  body: string;
  path?: string;
  line?: number;
  side: "RIGHT";
  /** An inline comment on the diff; the others are listed in the review body. */
  inline: boolean;
  /** The item's whole text (without its marker) when `body` was compacted; the ledger records it. */
  full?: string;
  /** The item's text as parts, which a shortened item is cut by; not part of what is posted or recorded. */
  parts?: ItemParts;
  /** The stable key the ledger keeps, so a later head finds the item again. */
  key: string;
  /** An earlier head's item posted again, because its old thread is outdated. */
  repost?: boolean;
  /** The other questions this item stands for. */
  covers?: string[];
}

/** What became of an item an earlier head posted, as this head's review says it. */
export interface PriorLine {
  id: string;
  status: "fixed" | "open";
  reason: string;
  /** Still open without being re-checked on this head (N1 skipped the other questions). */
  carried: boolean;
  /** The earlier comment, or the review that holds it. */
  link?: string;
  /** The item's old thread is outdated: it is posted again as a new comment. */
  repost: boolean;
  item: PriorItem;
  /** A still-open item that stands for other questions on this head. */
  covered?: readonly Round1Covered[];
}

/** An item the v1 migration closed as `moved` or `superseded`, listed once in a posted review's Earlier items (§5.4). */
export interface ClosedLine {
  id: string;
  state: "moved" | "superseded";
  reason: string;
  link?: string;
}

export interface ReviewPlan {
  verdict: "passed" | "changes-requested";
  /** The open round-1 items: the ones posted now and the earlier ones still open. */
  open: number;
  /** Whether a review is posted: open items, or a clean round 1 with the profile's note. */
  post: boolean;
  /** A clean round 1's note (`comments.designPassedNote`). */
  note: boolean;
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT"; body: string }>;
  items: PublishItem[];
  firstLine: string;
  priors: PriorLine[];
  /** The closed items this post lists, recorded so they are never listed again. */
  listed: ClosedLine[];
  /** Why the review cannot be posted so that every item is readable; the stage escalates instead of posting ids only. */
  problem?: string;
}

/** The link to an earlier comment on the pull request, or to the review that holds it. */
export function commentLink(pull: Pick<PullRequest, "owner" | "repo" | "number">, item: Pick<PriorItem, "commentId" | "reviewId" | "inline">): string | undefined {
  const base = `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`;
  if (item.commentId !== undefined && item.commentId !== null) return `${base}#discussion_r${item.commentId}`;
  return item.reviewId !== undefined ? `${base}#pullrequestreview-${item.reviewId}` : undefined;
}

/** The body's account of the earlier heads' items: fixed, still open with a link, and the closed ones listed once. */
function priorSection(priors: readonly PriorLine[], closed: readonly ClosedLine[], head: string): string {
  const lines = priors.map((l) => {
    const why = l.reason !== "" ? ` (${clip(oneLine(neutralize(l.reason)), 160)})` : "";
    if (l.status === "fixed") return `- ${l.id}: fixed in ${head.slice(0, 7)}${why}`;
    const added = l.repost ? [] : (l.covered ?? []).filter((c) => !(l.item.covers ?? []).includes(c.id));
    const more = added.map((c) => `\n  - ${l.id} (still open) now also covers ${c.id} ${c.symbol}: ${c.equivalents.map((e) => `\`${e.replace(/^dependency:/, "")}\``).join(", ")}${c.excerpt !== "" ? ` (${clip(oneLine(neutralize(c.excerpt)), 160)})` : ""}`).join("");
    return `- ${l.id}: still open${l.repost ? "; its old thread is outdated, so it is commented again" : l.link !== undefined ? ` ([earlier comment](${l.link}))` : ""}${why}${more}`;
  });
  const shut = closed.map((c) => `- ${c.id}: closed (${c.state}): ${clip(oneLine(neutralize(c.reason)), 200)}${c.link !== undefined ? ` ([earlier comment](${c.link}))` : ""}`);
  const fixed = priors.filter((l) => l.status === "fixed").length;
  return [`Earlier items (${fixed} fixed, ${priors.length - fixed} still open${closed.length > 0 ? `, ${closed.length} closed by the split` : ""}):`, ...lines, ...shut].join("\n");
}

/**
 * The review for this head (§3.7): round 1's open items, or, for a clean round 1, nothing (`post` false) or the note. Inline
 * comments are the items with a diff anchor, up to what one review carries; the rest are in the body, whole while they fit, else
 * shortened evenly by their parts; an input past the executor's bound shortens the largest items first. None is dropped.
 */
export function planReview(i: {
  pull: Pick<PullRequest, "owner" | "repo" | "number">;
  head: string;
  nonce: string;
  round1: Round1Record;
  prior?: readonly PriorLine[] | undefined;
  closed?: readonly ClosedLine[] | undefined;
  comments?: CommentsConfig | undefined;
  maxInputBytes?: number | undefined;
}): ReviewPlan {
  const priors = [...(i.prior ?? [])];
  // A still-open item is not posted again while its old thread is live; it is listed in the body with a link.
  const listedIds = new Set(priors.filter((l) => l.status === "open" && !l.repost).map((l) => l.id));
  const items: PublishItem[] = i.round1.issues
    .filter((x) => !listedIds.has(x.id))
    .map((x) => {
      const text = neutralize(x.body);
      const parts = x.parts !== undefined ? neutralParts(x.parts) : undefined;
      const posted = text.length <= MAX_ITEM_TEXT ? text : parts !== undefined ? fitParts(parts, MAX_ITEM_TEXT) : clipKeep(text, MAX_ITEM_TEXT);
      return { id: x.id, body: markedBody(x.id, posted), ...(posted !== text ? { full: text } : {}), ...(parts !== undefined ? { parts } : {}), ...(x.path !== undefined && x.line !== undefined ? { path: x.path, line: x.line } : {}), side: "RIGHT" as const, inline: false, key: x.key, ...(x.covers !== undefined ? { covers: x.covers } : {}) };
    });
  const anchoredIds = new Set(i.round1.issues.filter((x) => x.anchored).map((x) => x.id));
  let inline = 0;
  for (const it of items) {
    if (anchoredIds.has(it.id) && it.path !== undefined && it.line !== undefined && inline < MAX_INLINE_COMMENTS) {
      it.inline = true;
      inline += 1;
    }
  }
  const stillOpen = priors.filter((l) => l.status === "open");
  const stillIds = new Set(stillOpen.map((l) => l.id));
  for (const x of items) if (stillIds.has(x.id)) x.repost = true;
  const open = items.filter((x) => !stillIds.has(x.id)).length + stillOpen.length;
  const verdict = open === 0 ? "passed" : "changes-requested";
  const note = open === 0 && i.comments?.designPassedNote === true;
  const post = open > 0 || note;
  const closed = post && open > 0 ? [...(i.closed ?? [])] : [];
  const footer = i.comments?.footer !== undefined ? [neutralize(i.comments.footer)] : [];
  if (!post) return { verdict, open, post, note, body: "", comments: [], items: [], firstLine: verdictLine(0), priors, listed: [] };
  if (note) {
    const marker = designReviewMarker(i.head, i.nonce);
    return { verdict, open, post, note, body: [`${PASSED_LINE}\n${marker}\n${NOTE_LINE}`, ...footer].join("\n\n"), comments: [], items: [], firstLine: PASSED_LINE, priors, listed: [] };
  }
  const firstLine = verdictLine(open);
  const sections = [
    `${firstLine}\n${designReviewMarker(i.head, i.nonce)}\n${ROUND_LINE}`,
    ...(priors.length > 0 || closed.length > 0 ? [priorSection(priors, closed, i.head)] : []),
    ...(inline > 0 ? [`${inline} item${inline === 1 ? " is" : "s are"} commented on the diff.`] : []),
  ];
  const tail = footer;
  const budget = MAX_REVIEW_BODY - 200 - [...sections, ...tail].join("\n\n").length;
  const size = (xs: readonly PublishItem[]): number => xs.reduce((n, x) => n + x.body.length + 2, 0);
  let problem: string | undefined;
  let pending = items.filter((x) => !x.inline);
  if (size(pending) > budget) {
    for (const x of pending) {
      if (inline < MAX_INLINE_COMMENTS && x.path !== undefined && x.line !== undefined && anchoredIds.has(x.id) && !x.inline) {
        x.inline = true;
        inline += 1;
      }
    }
    pending = items.filter((x) => !x.inline);
  }
  if (size(pending) > budget) {
    const textOf = (x: PublishItem): string => unmarkedText(x.id, x.body);
    let limit = MAX_ITEM_BODY;
    const compacted = (l: number): string[] => pending.map((x) => (x.parts !== undefined ? markedBody(x.id, fitParts(x.parts, l)) : `${clip(oneLine(textOf(x)), l)} ${findingMarker(x.id)}`));
    while (limit >= MIN_ONE_LINER && compacted(limit).reduce((n, b) => n + b.length + 2, 0) > budget) limit -= 50;
    if (limit < MIN_ONE_LINER) problem = `${pending.length} items fit neither inline nor as one-line texts in the review body (${pending.map((x) => x.id).join(", ")}): posting their ids only would hide what is requested`;
    else {
      const lines = compacted(limit);
      pending.forEach((x, k) => {
        if (lines[k] !== x.body) {
          x.full ??= textOf(x);
          x.body = lines[k]!;
        }
      });
    }
  }
  const assemble = (): { body: string; comments: ReviewPlan["comments"] } => ({
    body: [...sections, ...items.filter((x) => !x.inline).map((x) => x.body), ...tail].join("\n\n"),
    comments: items.filter((x) => x.inline).map((x) => ({ path: x.path!, line: x.line!, side: x.side, body: x.body })),
  });
  if (problem === undefined) {
    const maxBytes = (i.maxInputBytes ?? MAX_EXECUTOR_INPUT_BYTES) - INPUT_MARGIN;
    const inputBytes = (): number => {
      const a = assemble();
      return Buffer.byteLength(JSON.stringify(createInput({ ...i.pull, head: i.head }, { body: a.body, comments: a.comments })), "utf8");
    };
    const exhausted = new Set<string>();
    let bytes = inputBytes();
    for (let guard = 0; bytes > maxBytes && guard < 10_000; guard += 1) {
      const candidates = items.filter((x) => !exhausted.has(x.id));
      const biggest = candidates.reduce<PublishItem | undefined>((m, x) => (m === undefined || Buffer.byteLength(x.body, "utf8") > Buffer.byteLength(m.body, "utf8") ? x : m), undefined);
      if (biggest === undefined) break;
      const text = unmarkedText(biggest.id, biggest.body);
      const target = Math.floor(text.length * 0.85);
      const shorter = biggest.parts !== undefined ? fitParts(biggest.parts, target) : target >= MIN_ONE_LINER ? clipKeep(text, target) : text;
      if (shorter.length >= text.length) {
        exhausted.add(biggest.id);
        continue;
      }
      biggest.full ??= text;
      biggest.body = markedBody(biggest.id, shorter);
      bytes = inputBytes();
    }
    if (bytes > maxBytes) problem = `the review's input is ${bytes} bytes, over the ${maxBytes} the executor takes, with every one of its ${items.length} item${items.length === 1 ? "" : "s"} shortened as far as it goes`;
  }
  const { body, comments } = assemble();
  return { verdict, open, post, note, body, comments, items, firstLine, priors, listed: closed, ...(problem !== undefined ? { problem } : {}) };
}

/** The key the executor reconciles a post by (design-pr-review-split §5.3). */
export const idempotencyKey = (head: string): string => `design-${head.slice(0, 12)}`;

/** The input of the create-pull-review call: one `COMMENT` review at the pinned head. */
export function createInput(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, plan: Pick<ReviewPlan, "body" | "comments">): Record<string, unknown> {
  return { owner: pr.owner, repo: pr.repo, number: pr.number, event: "COMMENT", body: plan.body, comments: plan.comments, commitId: pr.head, idempotencyKey: idempotencyKey(pr.head) };
}

/** What the ledger records of this head's outcome: patched into the design section's `ledger.json` by `ledger-published`. */
export interface LedgerPatch {
  schema: typeof PUBLISH_SCHEMA;
  head: string;
  base?: string;
  verdict: ReviewPlan["verdict"];
  open: number;
  /** The review posted for this head, when one was (open items, or the note). */
  reviewId?: number;
  url?: string | null;
  note?: true;
  items: Array<{ id: string; origin: "round1"; path: string | null; line: number | null; endLine?: number; inline: boolean; commentId: number | null; body?: string; text: string; repost?: boolean; covers?: string[]; meta: { key: string; side?: "RIGHT" } }>;
  priors: Array<{ id: string; origin: "round1"; status: PriorLine["status"]; carried: boolean; reason: string; covers?: string[] }>;
  /** The closed items the post listed, recorded so they are never listed again. */
  listed: string[];
}

export function ledgerPatch(pr: Pick<PullRequest, "head"> & { base?: string | undefined }, plan: ReviewPlan, posted: Posted | undefined, ids: ReadonlyMap<string, number>): LedgerPatch {
  return {
    schema: PUBLISH_SCHEMA,
    head: pr.head,
    ...(pr.base !== undefined ? { base: pr.base } : {}),
    verdict: plan.verdict,
    open: plan.open,
    ...(posted !== undefined ? { reviewId: posted.reviewId, url: posted.url } : {}),
    ...(plan.note ? { note: true as const } : {}),
    items: plan.items.map((x) => ({ id: x.id, origin: "round1" as const, path: x.path ?? null, line: x.line ?? null, ...(x.line !== undefined ? { endLine: x.line } : {}), inline: x.inline, commentId: x.inline ? ids.get(x.id) ?? null : null, ...(x.full !== undefined ? { body: x.full } : {}), text: x.full ?? unmarkedText(x.id, x.body), ...(x.repost === true ? { repost: true } : {}), ...(x.covers !== undefined ? { covers: x.covers } : {}), meta: { key: x.key, ...(x.path !== undefined ? { side: "RIGHT" as const } : {}) } })),
    priors: plan.priors.map((l) => ({ id: l.id, origin: "round1" as const, status: l.status, carried: l.carried, reason: l.reason, ...(l.covered !== undefined && l.covered.length > 0 ? { covers: l.covered.map((c) => c.id) } : {}) })),
    listed: plan.listed.map((c) => c.id),
  };
}

/** What the note records on its head. */
export const NOTE_RECORDED = "the design-review-passed note was posted (comments.designPassedNote)";

/**
 * The design section's record of this head: round 1's outcome (`items` or `clean`, the open count, the review id when one was
 * posted), each posted item with its `github` ids, what became of the earlier items, and the closed items listed. Prints `SAME`
 * when nothing changes.
 */
const MERGE_DESIGN = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{
const v=JSON.parse(s);const before=JSON.stringify(v);const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const heads=Array.isArray(v.heads)?v.heads:[];const h=heads.find((x)=>x.sha===p.head);
if(h){h.round1=p.open>0?"items":"clean";h.open=p.open;if(p.reviewId!==undefined){h.reviewId=p.reviewId;if(p.url)h.reviewUrl=p.url}if(p.note)h.note="${NOTE_RECORDED}"}
const gh=(it)=>({head:p.head,reviewId:p.reviewId,commentId:it.commentId,inline:it.inline});
const items=Array.isArray(v.items)?v.items:[];const qa=Array.isArray(v.qa)?v.qa:[];
const note=(f,status,extra)=>{const keep=(Array.isArray(f.history)?f.history:[]).filter((x)=>x.head!==p.head);f.history=keep.concat([Object.assign({head:p.head,status:status},extra||{})])};
for(const it of p.items){
const fields=Object.assign({origin:it.origin,path:it.path,line:it.line,text:it.text},it.covers?{covers:it.covers}:{},it.endLine?{endLine:it.endLine}:{},it.body?{body:it.body}:{},it.meta||{});
let f=items.find((x)=>x.id===it.id);
if(f)Object.assign(f,fields);else{f=Object.assign({head:p.head,id:it.id},fields);items.push(f)}
f.state="open";delete f.reason;f.github=gh(it);note(f,"open",it.repost?{reposted:true}:{});
const q=qa.find((x)=>x.id===it.id);if(q){q.state="open";q.github=gh(it)}
}
for(const pr of p.priors||[]){
const f=items.find((x)=>x.id===pr.id);if(!f)continue;
if(pr.status==="fixed"){f.state="fixed";f.fixedIn=p.head;note(f,"fixed",{reason:pr.reason})}
else if(!p.items.some((it)=>it.id===pr.id)){note(f,"open",{reason:pr.reason,carried:pr.carried});if(pr.covers)f.covers=pr.covers;else delete f.covers}
const q=qa.find((x)=>x.id===pr.id);if(q&&pr.status==="fixed")q.state="fixed";
}
for(const id of p.listed||[]){const f=items.find((x)=>x.id===id);if(f&&!f.listed)f.listed=p.head}
v.heads=heads;v.items=items;v.qa=qa;const out=JSON.stringify(v);process.stdout.write(out===before?"SAME":out)})`;

/** The design review writes the design section only (design-pr-review-split §5.2). */
export const PUBLISHED_SECTIONS: Section[] = ["design"];

/**
 * Records this head's outcome in the ledger's design section, advanced by compare-and-swap from this run's Answers write (the
 * review section is carried from the ref's current value, never written). `node` is the Node binary to run.
 */
export function ledgerPublishedCommand(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, patch: LedgerPatch, baselines: Record<Section, string>, node = "node"): EnvironmentCommand {
  const what = patch.reviewId !== undefined ? `published review ${patch.reviewId}` : "clean, nothing posted";
  return {
    id: COMMAND.ledgerPublished,
    argv: ["sh", "-c", PUBLISHED_WRITE, COMMAND.ledgerPublished, ledgerRef(pr.owner, pr.repo, pr.number), `pr-design-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: ${what}`, PUBLISH_PATCH_FILE, node, PUBLISHED_SECTIONS.join(" "), baselines.design, baselines.review, MERGE_DESIGN, "", reviewMarkdown(pr)],
  };
}

export type PublishFlow =
  | Exclude<PostFlow, { state: "posted" }>
  | { state: "ledger"; posted: Posted | undefined; patch: LedgerPatch; command: EnvironmentCommand; parts: EnvironmentCommand[]; run?: CommandRun }
  | { state: "done"; posted: Posted | undefined; patch: LedgerPatch };

const at = (evidence: readonly EvidenceRecord[], ref: string): number => evidence.findIndex((e) => e.ref === ref);

/**
 * Where the stage stands, from the evidence alone: the post when there is one (the kit's `postFlow`), then the ledger write that
 * records this head. A clean round 1 with no note posts nothing and goes straight to the ledger write.
 */
export function publishFlow(evidence: readonly EvidenceRecord[], plan: ReviewPlan, pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">): PublishFlow {
  let posted: Posted | undefined;
  let ids: Map<string, number> = new Map();
  let after = -1;
  if (plan.post) {
    const post = postFlow(evidence, { marker: designReviewMarker, firstLine: plan.firstLine, inline: plan.items.filter((x) => x.inline).map((x) => x.id) }, pr);
    if (post.state !== "posted") return post;
    ({ posted, ids } = post);
    after = post.readsAt;
  }
  const patch = ledgerPatch({ head: pr.head, base: pinnedBase(evidence) }, plan, posted, ids);
  const baselines = publishBaselines(evidence, pr);
  if ("problem" in baselines) return { state: "supervise", reason: `this head's outcome cannot be recorded in the ledger: ${baselines.problem}`, refs: [] };
  const command = ledgerPublishedCommand(pr, patch, baselines, process.execPath);
  const run = commandRuns(evidence, COMMAND.ledgerPublished).at(-1);
  const json = JSON.stringify(patch);
  const written = readParts(evidence, PART_BASE.publishPatch, PUBLISH_PATCH_FILE);
  const wroteAt = written.state === "read" ? written.at : -1;
  const current = written.state === "read" && written.value === json && wroteAt > after;
  const same = run !== undefined && run.command.argv.length === command.argv.length && run.command.argv.every((a, k) => a === command.argv[k]);
  if (current && run !== undefined && succeeded(run.command) && at(evidence, run.record.ref) > wroteAt && same) return { state: "done", posted, patch };
  return { state: "ledger", posted, patch, command, parts: partCommands(PART_BASE.publishPatch, PUBLISH_PATCH_FILE, json), ...(run !== undefined && current && same && at(evidence, run.record.ref) > wroteAt ? { run } : {}) };
}

// ---- what the stage posts, from the records ----

export type PublishPlan = { state: "ready"; plan: ReviewPlan; round1: Round1Record } | { state: "pending"; reason: string } | { state: "failed"; reason: string; refs: string[] };

/** Whether the thread that holds comment `commentId` is outdated on GitHub (the lines it was left on changed). */
function threadOutdated(threads: readonly unknown[], commentId: number | null | undefined): boolean {
  if (commentId === undefined || commentId === null) return false;
  return threads.some((t) => isObject(t) && t.isOutdated === true && Array.isArray(t.comments) && t.comments.some((c) => isObject(c) && c.id === commentId));
}

/** What became of each round-1 item an earlier head posted, from this head's round 1 (judged by key, §3.5). */
export function priorLines(registry: PriorRegistry, pull: Pick<PullRequest, "owner" | "repo" | "number">, round1: Round1Record, threads: readonly unknown[]): PriorLine[] {
  const out: PriorLine[] = [];
  for (const r of round1.prior ?? []) {
    const item = registry.items.find((x) => x.id === r.id);
    if (item === undefined) continue;
    const link = commentLink(pull, item);
    const covered = round1.issues.find((x) => x.id === r.id)?.covered;
    const carried = r.status === "open" && r.reason.startsWith("not re-checked");
    out.push({ id: r.id, status: r.status, reason: r.reason, ...(covered !== undefined ? { covered } : {}), carried, ...(link !== undefined ? { link } : {}), repost: r.status === "open" && !carried && threadOutdated(threads, item.commentId), item });
  }
  return out.sort((a, b) => (Number(a.id.slice(1)) || 0) - (Number(b.id.slice(1)) || 0));
}

/** The items the v1 migration closed as `moved` or `superseded` that no posted review has listed yet (§5.4). */
export function closedLines(registry: PriorRegistry, pull: Pick<PullRequest, "owner" | "repo" | "number">): ClosedLine[] {
  return registry.items
    .filter((x) => x.origin === "round1" && (x.status === "moved" || x.status === "superseded") && x.listed === undefined)
    .map((x) => {
      const link = commentLink(pull, x);
      return { id: x.id, state: x.status as ClosedLine["state"], reason: x.reason ?? "", ...(link !== undefined ? { link } : {}) };
    });
}

/** The review the run posts (or the head it records clean), recomputed from the recorded round 1 and the ledger's earlier items. */
export function publishPlan(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, comments: CommentsConfig): PublishPlan {
  const round1 = recordedRound1(evidence);
  if (round1.state === "none") return { state: "pending", reason: "round 1 was not recorded" };
  if (round1.state === "failed") return round1;
  const nonce = viewerOf(evidence)?.nonce ?? "pending";
  const registry = registryFromEvidence(evidence);
  const prior = priorLines(registry, pr, round1.value, analysis.snapshot.threads);
  return { state: "ready", round1: round1.value, plan: planReview({ pull: pr, head: pr.head, nonce, round1: round1.value, prior, closed: closedLines(registry, pr), comments }) };
}
