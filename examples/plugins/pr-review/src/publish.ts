// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Publish (design §8.5, §10; design-pr-review-split §4.5): the last stage posts the review to the pull request as **one** `COMMENT`
 * review through the `graphloom.github/create-pull-review` executor, whose credential binding the plugin never sees. The review is
 * never `APPROVE` or `REQUEST_CHANGES`; its body's first line is the verdict (`Review passed`, or `Changes requested: <n> open`),
 * its second the head marker `<!-- graphloom-review: <head> <nonce> -->`, and the idempotency key is `review-<head12>`. It carries
 * round 2's postable findings (the draft's comments), each ending with its `<!-- graphloom-finding: F3 -->` marker, inline when
 * anchored and the rest in the body; a "Design review (round 1)" section lists round 1's open items with links to their comments, or
 * says round 1 was not run. Nothing of round 1 is posted again. The verdict counts the open `F` findings, earlier ones included, and
 * the open round-1 items listed. The post itself (the reconcile before posting, the read-back of the comment ids) is the review
 * kit's (`kit/post.ts`); a review of this head that carries `graphloom-design-review` is never this graph's.
 *
 * The posted review's id, its comments' ids, this head's context source and the round-1 head it counted are recorded in the ledger's
 * `review` section only, advanced from this run's Draft write (`ledger-published`).
 *
 * On a later head the review also says what became of the findings an earlier head posted: each one fixed (in which commit) or still
 * open (with a link to its earlier comment). A still-open finding is not posted again, unless its old thread is outdated.
 */
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import { COMMAND, PART_BASE, PUBLISH_PATCH_FILE, ledgerRef } from "./kit/constants.js";
import { clip, clipKeep, withoutFences } from "./kit/escape.js";
import { partCommands, readParts } from "./kit/parts.js";
import { anchored, severityLabel, type Draft, type DraftEntry } from "./draft.js";
import { commandRuns, isObject, succeeded, type CommandRun } from "./kit/evidence.js";
import type { Analysis } from "./kit/analysis.js";
import { publishBaselines, PUBLISHED_WRITE } from "./kit/ledger.js";
import { REVIEW_SCHEMA, reviewMarkdown, type Section } from "./kit/ledgerv2.js";
import { pinnedBase } from "./kit/commands.js";
import { draftWrites, recordedAspect } from "./reviewdraft.js";
import { anchorInfo, findingKey, registryFromEvidence, type PriorItem, type PriorRegistry } from "./prior.js";
import { ASPECTS } from "./kit/aspects.js";
import type { AspectRecord } from "./review.js";
import type { PullFile } from "./kit/snapshot.js";
import type { PullRequest } from "./kit/request.js";
import type { MeasurementState } from "./kit/measurements.js";
import type { CommentsConfig, Profile } from "./kit/profile.js";
import { commentLink, round1Lines, type ContextRecord, type ContextSource, type Round1Status } from "./context.js";
import { findingMarker, findPostedBy, markedBody, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY, neutralize, postFlow, reviewMarker, unmarkedText, verdictLine, viewerOf, type Posted, type PostFlow } from "./kit/post.js";

export const PUBLISH_SCHEMA = "pr-review-publish-v2";
export { publishBaselines } from "./kit/ledger.js";
export { commentIds, designReviewMarker, findingMarker, markedBody, MAX_COMMENT_READS, MAX_CREATE_ATTEMPTS, MAX_INLINE_COMMENTS, MAX_REVIEW_BODY, neutralize, reviewMarker, unmarkedText, verdictLine, viewerOf, COMMENTS_READ, REVIEWS_READ, type Posted } from "./kit/post.js";
export { commentLink } from "./context.js";
/** The longest text one posted item keeps, far below the 65,536 characters GitHub accepts in a comment. */
export const MAX_ITEM_TEXT = 12_000;
/** What one item may take before it is shortened: its text and its suggestion block. */
const MAX_ITEM_BODY = MAX_ITEM_TEXT + 2_000;
/** The least text a compacted item keeps: a one-liner shorter than this says too little to act on. */
const MIN_ONE_LINER = 80;
/** Room kept in the executor input for what the plan does not measure (the idempotency key and the like). */
const INPUT_MARGIN = 1_000;

const SUGGESTION_OMITTED = "(suggested change omitted for size; see the report)";
/** A posted text shortened to `n` characters: its fenced blocks (a suggestion) go whole, with a note, before its prose is cut at a sentence end or a word boundary; no fence is ever left open. */
function shrinkPlain(text: string, n: number): string {
  const noted = text.endsWith(SUGGESTION_OMITTED);
  const w = noted ? { text: text.slice(0, text.length - SUGGESTION_OMITTED.length).trim(), dropped: true } : withoutFences(text);
  if (!w.dropped) return clipKeep(text, n);
  const room = n - SUGGESTION_OMITTED.length - 2;
  return `${w.text.length <= room ? w.text : clipKeep(w.text, Math.max(1, room))}\n\n${SUGGESTION_OMITTED}`;
}

export interface PublishItem {
  /** `F3`: the id its marker carries. */
  id: string;
  origin: "round2";
  /** The comment's text, ending with its marker. */
  body: string;
  path?: string;
  line?: number;
  startLine?: number;
  side: "RIGHT" | "LEFT";
  /** An inline comment on the diff; the others are listed in the review body. */
  inline: boolean;
  /** The item's whole text (without its marker) when `body` was compacted; the ledger records it. */
  full?: string;
  /** What the ledger keeps of the item so a later head can find it again (design §9.1). */
  meta?: ItemMeta;
  /** An earlier head's item posted again, because its old thread is outdated. */
  repost?: boolean;
}

/** What the ledger records of a posted item beyond its id: the stable key, the place and the text. */
export interface ItemMeta {
  key: string;
  aspect?: string;
  severity?: string;
  kind?: string;
  side?: "RIGHT" | "LEFT";
  endLine?: number;
  anchorText?: string;
  patchId?: string;
  hunk?: [number, number, number];
}

/** What became of a finding an earlier head posted, as this head's review says it. */
export interface PriorLine {
  id: string;
  origin: "round2";
  status: "fixed" | "open";
  reason: string;
  /** Still open without being re-checked on this head (its file was outside the scope). */
  carried: boolean;
  /** The earlier comment, or the review that holds it. */
  link?: string;
  /** The item's old thread is outdated: it is posted again as a new comment, where `place` says. */
  repost: boolean;
  /** Where a reposted item goes on this head, and whether that place lies in the diff. */
  place?: { path: string; line: number; endLine: number; side: "RIGHT" | "LEFT"; anchored: boolean };
  /** A still-open item whose anchor was not found again on this head: it is listed in the body, and the ledger marks it outdated. */
  outdated?: boolean;
  /** A still-open item whose place on this head was found again (or which is posted again): where it is now, with its anchor recomputed. */
  moved?: { path: string; line: number; endLine: number; meta: ItemMeta };
  item: PriorItem;
}

/** A finding a verifier dismissed (never posted): it is recorded closed, so a later head does not raise it again. */
export interface ClosedFinding {
  id: string;
  path: string;
  line: number;
  endLine: number;
  side: "RIGHT" | "LEFT";
  meta: ItemMeta;
  text: string;
}

export interface ReviewPlan {
  verdict: "passed" | "changes-requested";
  /** What is open: the open `F` findings (earlier ones included) and the open round-1 items the body lists. */
  open: number;
  /** The open `F` findings alone. */
  openFindings: number;
  /** The review body: the verdict first, then the head's marker, round 2's line, round 1's section and the items that are not inline. */
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; startLine?: number; body: string }>;
  items: PublishItem[];
  /** The verdict's first line of the body. */
  firstLine: string;
  /** What became of the earlier heads' findings, which the body lists and the ledger records. */
  priors: PriorLine[];
  /** Findings dismissed on this head, recorded closed in the ledger. */
  closed: ClosedFinding[];
  /** Round 1 as the body lists it (design-pr-review-split §4.5). */
  round1: Round1Status | null;
  /** Why the review cannot be posted so that every item is readable; the stage escalates instead of posting ids only. */
  problem?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function findingBody(e: DraftEntry): { text: string; full?: string } {
  const aspects = e.aspects.length > 0 ? ` · ${e.aspects.join(", ")}` : "";
  const tags = [e.proof?.state === "non-behavioral" ? "non-behavioral" : e.proof?.state === "proven" ? "proven by a failing test" : undefined, e.lead?.kind === "untested-feature" ? "a new feature with no test" : undefined, e.principle !== undefined ? `breaks principle ${e.principle}` : undefined].filter((t): t is string => t !== undefined);
  const label = `**${e.severity !== undefined ? severityLabel(e.severity) : "[finding]"}**${aspects}${tags.length > 0 ? ` · ${tags.join(" · ")}` : ""}`;
  const text = `${label}\n\n${clipKeep(neutralize(e.body), MAX_ITEM_TEXT)}`;
  const suggestion = e.suggestion !== undefined && e.anchored && e.side === "RIGHT" ? `\n\n\`\`\`suggestion\n${e.suggestion}\n\`\`\`` : "";
  const posted = text.length + suggestion.length <= MAX_ITEM_BODY - 60 ? `${text}${suggestion}` : text;
  // What was cut (the text, or a suggestion that did not fit) is kept whole for the ledger.
  return posted === `${label}\n\n${neutralize(e.body)}${suggestion}` ? { text: posted } : { text: posted, full: `${label}\n\n${neutralize(e.body)}${suggestion}` };
}

/**
 * The review for this run (design-pr-review-split §4.5): round 2's postable findings (the draft's comments) and the earlier findings
 * still open whose old thread is outdated, with round 1's open items listed and counted. The verdict is `Review passed` only when no
 * `F` finding (new or earlier) is open and no round-1 item is open. Inline comments are the items with a diff anchor, up to what one
 * review carries; the rest are in the body.
 */
export function planReview(i: {
  pull: Pick<PullRequest, "owner" | "repo" | "number">;
  head: string;
  nonce: string;
  draft: Draft;
  round1: Round1Status | null;
  /** What became of the earlier heads' findings (none for a first run). */
  prior?: readonly PriorLine[] | undefined;
  /** What the ledger keeps of each new finding, by id. */
  meta?: ReadonlyMap<string, ItemMeta> | undefined;
  closed?: readonly ClosedFinding[] | undefined;
  comments?: Pick<CommentsConfig, "footer"> | undefined;
  /** The executor input bound in bytes the whole create-pull-review input must fit (default: the executor input bound). */
  maxInputBytes?: number | undefined;
}): ReviewPlan {
  const priors = [...(i.prior ?? [])];
  const reposts: PublishItem[] = priors
    .filter((l) => l.status === "open" && l.repost && l.place !== undefined)
    .map((l) => {
      const text = neutralize(`**Still open** (first raised on ${l.item.head.slice(0, 7)}).\n\n${l.item.text ?? ""}`.trim());
      const posted = clipKeep(text, MAX_ITEM_TEXT);
      const place = l.place!;
      return { id: l.id, origin: "round2" as const, body: markedBody(l.id, posted), ...(posted !== text ? { full: text } : {}), path: place.path, line: place.endLine, ...(place.endLine > place.line ? { startLine: place.line } : {}), side: place.side, inline: false, repost: true, meta: l.moved?.meta ?? metaOf(l.item) };
    });
  const items: PublishItem[] = [
    ...i.draft.comments.map((e) => {
      const b = findingBody(e);
      return { id: e.id, origin: "round2" as const, body: markedBody(e.id, b.text), ...(b.full !== undefined ? { full: b.full } : {}), path: e.path, line: e.line, ...(e.startLine !== undefined ? { startLine: e.startLine } : {}), side: e.side, inline: false, ...(i.meta?.has(e.id) ? { meta: i.meta.get(e.id)! } : {}) };
    }),
    ...reposts,
  ];
  const anchoredIds = new Set<string>([...i.draft.comments.filter((c) => c.anchored).map((c) => c.id), ...reposts.filter((x) => priors.find((l) => l.id === x.id)?.place?.anchored === true).map((x) => x.id)]);
  let inline = 0;
  for (const it of items) {
    if (anchoredIds.has(it.id) && it.path !== undefined && it.line !== undefined && inline < MAX_INLINE_COMMENTS) {
      it.inline = true;
      inline += 1;
    }
  }
  // What is open: the items posted now (new ones and reposts of one still open) and the earlier ones still open and listed; an earlier
  // item that is open is one item, posted again or not. The round-1 items listed count too (design-pr-review-split §4.5).
  const stillOpen = priors.filter((l) => l.status === "open");
  const stillIds = new Set(stillOpen.map((l) => l.id));
  for (const x of items) if (stillIds.has(x.id)) x.repost = true;
  const openFindings = items.filter((x) => !stillIds.has(x.id)).length + stillOpen.length;
  const open = openFindings + (i.round1?.open.length ?? 0);
  const verdict = open === 0 ? "passed" : "changes-requested";
  const firstLine = verdictLine(open);
  const round2Line = `Round 2 (the PR review: correctness, maintainability and security, every finding verified): ${openFindings > 0 ? `${openFindings} open finding${openFindings === 1 ? "" : "s"}.` : "no open finding."}${i.draft.summary !== "" ? ` ${oneLine(i.draft.summary)}` : ""}`;
  const footer = i.comments?.footer !== undefined ? [neutralize(i.comments.footer)] : [];
  const sections = [
    `${firstLine}\n${reviewMarker(i.head, i.nonce)}`,
    round2Line,
    ["Design review (round 1):", ...round1Lines(i.round1, i.head).map(neutralize)].join("\n"),
    ...(priors.length > 0 ? [priorSection(priors, i.head)] : []),
    ...(inline > 0 ? [`${inline} item${inline === 1 ? " is" : "s are"} commented on the diff.`] : []),
  ];
  // The items that are not inline follow, whole, while they all fit. When they do not, an item with an anchor moves inline (room
  // allowing), and the rest shrink evenly to one-line texts; when even that cannot fit, the plan says so and the stage escalates.
  const budget = MAX_REVIEW_BODY - 200 - [...sections, ...footer].join("\n\n").length;
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
    const compacted = (l: number): string[] => pending.map((x) => `${clip(oneLine(textOf(x)), l)} ${findingMarker(x.id)}`);
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
    body: [...sections, ...items.filter((x) => !x.inline).map((x) => x.body), ...footer].join("\n\n"),
    comments: items.filter((x) => x.inline).map((x) => ({ path: x.path!, line: x.line!, side: x.side, ...(x.startLine !== undefined && x.startLine < x.line! ? { startLine: x.startLine } : {}), body: x.body })),
  });
  // The executor takes at most `maxInputBytes` of JSON for the whole input: items, inline ones included, are shortened largest first
  // until the input fits; none is dropped.
  if (problem === undefined) {
    const maxBytes = (i.maxInputBytes ?? MAX_EXECUTOR_INPUT_BYTES) - INPUT_MARGIN;
    const inputBytes = (): number => {
      const a = assemble();
      return Buffer.byteLength(JSON.stringify(createInput({ ...i.pull, head: i.head }, a)), "utf8");
    };
    const exhausted = new Set<string>();
    let bytes = inputBytes();
    for (let guard = 0; bytes > maxBytes && guard < 10_000; guard += 1) {
      const candidates = items.filter((x) => !exhausted.has(x.id));
      const biggest = candidates.reduce<PublishItem | undefined>((m, x) => (m === undefined || Buffer.byteLength(x.body, "utf8") > Buffer.byteLength(m.body, "utf8") ? x : m), undefined);
      if (biggest === undefined) break;
      const text = unmarkedText(biggest.id, biggest.body);
      const target = Math.floor(text.length * 0.85);
      const shorter = target >= MIN_ONE_LINER ? shrinkPlain(text, target) : text;
      if (shorter.length >= text.length) {
        exhausted.add(biggest.id);
        continue;
      }
      biggest.full ??= text;
      biggest.body = markedBody(biggest.id, shorter);
      bytes = inputBytes();
    }
    if (bytes > maxBytes) problem = `the review's input is ${bytes} bytes, over the ${maxBytes} the executor takes, with every one of its ${items.length} item${items.length === 1 ? "" : "s"} shortened as far as it goes: posting fewer items or ids only would hide what is requested`;
  }
  const { body, comments } = assemble();
  return { verdict, open, openFindings, body, comments, items, firstLine, priors, closed: [...(i.closed ?? [])], round1: i.round1, ...(problem !== undefined ? { problem } : {}) };
}

/** What the ledger keeps of an item an earlier head posted, which a repost carries on unchanged. */
function metaOf(x: PriorItem): ItemMeta {
  return { key: x.key, ...(x.aspect !== undefined ? { aspect: x.aspect } : {}), ...(x.severity !== undefined ? { severity: x.severity } : {}), ...(x.kind !== undefined ? { kind: x.kind } : {}), ...(x.side !== undefined ? { side: x.side } : {}), ...(x.endLine !== undefined ? { endLine: x.endLine } : {}), ...(x.anchorText !== undefined ? { anchorText: x.anchorText } : {}), ...(x.patchId !== undefined ? { patchId: x.patchId } : {}), ...(x.hunk !== undefined ? { hunk: x.hunk } : {}) };
}

/** The review body's account of the earlier heads' findings: fixed in which commit, or still open with a link to the earlier comment. */
function priorSection(priors: readonly PriorLine[], head: string): string {
  const lines = priors.map((l) => {
    const why = l.reason !== "" ? ` (${clip(oneLine(neutralize(l.reason)), 160)})` : "";
    if (l.status === "fixed") return `- ${l.id}: fixed in ${head.slice(0, 7)}${why}`;
    return `- ${l.id}: still open${l.repost ? "; its old thread is outdated, so it is commented again" : l.link !== undefined ? ` ([earlier comment](${l.link}))` : ""}${why}`;
  });
  const fixed = priors.filter((l) => l.status === "fixed").length;
  return [`Earlier items (${fixed} fixed, ${priors.length - fixed} still open):`, ...lines].join("\n");
}

/** The meta of a new finding the draft posts: the aspect that raised it, its place and what the file's patch shows there. */
export function findingMeta(f: { id: string; raisedBy: string; severity?: string | undefined; kind: string; path: string; side: "RIGHT" | "LEFT"; startLine: number; endLine: number }, files: readonly PullFile[]): ItemMeta {
  const a = anchorInfo(files.find((x) => x.path === f.path), f.side, f.startLine);
  return { key: findingKey(f.raisedBy, f.path, f.startLine, a.anchorText), aspect: f.raisedBy, ...(f.severity !== undefined ? { severity: f.severity } : {}), kind: f.kind, side: f.side, endLine: f.endLine, ...a };
}

/** The key the executor reconciles a post by (design-pr-review-split §5.3). */
export const idempotencyKey = (head: string): string => `review-${head.slice(0, 12)}`;

/** The input of the create-pull-review call: one `COMMENT` review at the pinned head. */
export function createInput(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, plan: Pick<ReviewPlan, "body" | "comments">): Record<string, unknown> {
  return { owner: pr.owner, repo: pr.repo, number: pr.number, event: "COMMENT", body: plan.body, comments: plan.comments, commitId: pr.head, idempotencyKey: idempotencyKey(pr.head) };
}

/** A review of this head that this run posted, carrying the PR review's head marker (design-pr-review-split §5.3). */
export function findPosted(items: readonly unknown[], head: string, nonce: string, login: string): { id: number; url: string | null } | undefined {
  return findPostedBy(items, head, login, reviewMarker(head, nonce));
}

/** What the ledger records of the published review: patched into the review section's `ledger.json` by `ledger-published`. */
export interface LedgerPatch {
  schema: typeof PUBLISH_SCHEMA;
  head: string;
  /** This head's pinned base. */
  base?: string;
  verdict: ReviewPlan["verdict"];
  open: number;
  /** The context the reviewers started from, and the round-1 head the verdict counted (design-pr-review-split §5.1). */
  context: { source: ContextSource; head?: string };
  round1: { head: string; open: number } | null;
  leads: { given: number; raised: number };
  reviewId: number;
  url: string | null;
  items: Array<{ id: string; origin: "round2"; path: string | null; line: number | null; endLine?: number; inline: boolean; commentId: number | null; /** The whole text of an item whose posted text was compacted. */ body?: string; /** The item's text as posted (whole), without its marker. */ text: string; repost?: boolean; meta?: ItemMeta }>;
  /** What became of the earlier heads' findings on this head. */
  priors: Array<{ id: string; origin: "round2"; status: PriorLine["status"]; carried: boolean; reason: string; outdated?: boolean; moved?: PriorLine["moved"] }>;
  /** Findings dismissed on this head, recorded closed. */
  closed: Array<{ id: string; path: string; line: number; endLine: number; side: "RIGHT" | "LEFT"; text: string; meta: ItemMeta }>;
}

export function ledgerPatch(pr: Pick<PullRequest, "head"> & { base?: string | undefined }, plan: ReviewPlan, draft: Pick<Draft, "context" | "leads">, posted: Posted, ids: ReadonlyMap<string, number>): LedgerPatch {
  return {
    schema: PUBLISH_SCHEMA,
    head: pr.head,
    ...(pr.base !== undefined ? { base: pr.base } : {}),
    verdict: plan.verdict,
    open: plan.open,
    context: draft.context,
    round1: plan.round1 === null ? null : { head: plan.round1.head, open: plan.round1.open.length },
    leads: draft.leads,
    reviewId: posted.reviewId,
    url: posted.url,
    items: plan.items.map((x) => ({ id: x.id, origin: x.origin, path: x.path ?? null, /** The item's first line (a range's last is `endLine`). */ line: x.startLine ?? x.line ?? null, ...(x.line !== undefined ? { endLine: x.line } : {}), inline: x.inline, commentId: x.inline ? ids.get(x.id) ?? null : null, ...(x.full !== undefined ? { body: x.full } : {}), text: x.full ?? unmarkedText(x.id, x.body), ...(x.repost === true ? { repost: true } : {}), ...(x.meta !== undefined ? { meta: x.meta } : {}) })),
    priors: plan.priors.map((l) => ({ id: l.id, origin: l.origin, status: l.status, carried: l.carried, reason: l.reason, ...(l.outdated !== undefined ? { outdated: l.outdated } : {}), ...(l.moved !== undefined ? { moved: l.moved } : {}) })),
    closed: plan.closed.map((c) => ({ id: c.id, path: c.path, line: c.line, endLine: c.endLine, side: c.side, text: c.text, meta: c.meta })),
  };
}

export type PublishFlow =
  | Exclude<PostFlow, { state: "posted" }>
  | { state: "ledger"; posted: Posted; patch: LedgerPatch; /** The section write that records it. */ command: EnvironmentCommand; /** The commands that write the patch file, a part set, before the ledger command reads it. */ parts: EnvironmentCommand[]; run?: CommandRun }
  | { state: "done"; posted: Posted; patch: LedgerPatch };

const at = (evidence: readonly EvidenceRecord[], ref: string): number => evidence.findIndex((e) => e.ref === ref);

/**
 * Where the stage stands, from the evidence alone: the post (the kit's `postFlow`: the reviews read, the one create, the comments
 * read back, each reconciled before anything is posted again), then the ledger write that records it in the review section.
 */
export function publishFlow(evidence: readonly EvidenceRecord[], plan: ReviewPlan, draft: Pick<Draft, "context" | "leads">, pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">): PublishFlow {
  const post = postFlow(evidence, { marker: reviewMarker, firstLine: plan.firstLine, inline: plan.items.filter((x) => x.inline).map((x) => x.id) }, pr);
  if (post.state !== "posted") return post;
  const { posted, ids, readsAt } = post;
  const patch = ledgerPatch({ head: pr.head, base: pinnedBase(evidence) }, plan, draft, posted, ids);
  const baselines = publishBaselines(evidence, pr, "review");
  if ("problem" in baselines) return { state: "supervise", reason: `the published review cannot be recorded in the ledger: ${baselines.problem}`, refs: [] };
  const command = ledgerPublishedCommand(pr, patch, baselines, process.execPath);
  const run = commandRuns(evidence, COMMAND.ledgerPublished).at(-1);
  const json = JSON.stringify(patch);
  const written = readParts(evidence, PART_BASE.publishPatch, PUBLISH_PATCH_FILE);
  const wroteAt = written.state === "read" ? written.at : -1;
  const current = written.state === "read" && written.value === json && wroteAt > readsAt;
  // The write recorded is the one recomputed: the same patch file, section and baselines (`ledger-cas`, design-pr-review-split §5.2).
  const same = run !== undefined && run.command.argv.length === command.argv.length && run.command.argv.every((a, k) => a === command.argv[k]);
  if (current && run !== undefined && succeeded(run.command) && at(evidence, run.record.ref) > wroteAt && same) return { state: "done", posted, patch };
  return { state: "ledger", posted, patch, command, parts: partCommands(PART_BASE.publishPatch, PUBLISH_PATCH_FILE, json), ...(run !== undefined && current && same && at(evidence, run.record.ref) > wroteAt ? { run } : {}) };
}

/**
 * Where the ledger patch the evidence holds records a priority the recomputation does not give: a posted item, an earlier finding
 * that moved, or a withdrawn one (design §9.1: the ledger keeps a finding's final priority, or none). Undefined when they agree or
 * no patch is written yet.
 */
export function ledgerPriorityMismatch(evidence: readonly EvidenceRecord[], plan: ReviewPlan): string | undefined {
  const written = readParts(evidence, PART_BASE.publishPatch, PUBLISH_PATCH_FILE);
  if (written.state !== "read") return undefined;
  let p: unknown;
  try {
    p = JSON.parse(written.value);
  } catch {
    return undefined;
  }
  if (!isObject(p)) return undefined;
  const sev = (m: unknown): string => (isObject(m) && typeof m.severity === "string" ? m.severity : "none");
  const want = new Map<string, string>([
    ...plan.items.filter((x) => x.meta !== undefined).map((x) => [`item ${x.id}`, sev(x.meta)] as const),
    ...plan.priors.filter((l) => l.moved !== undefined).map((l) => [`earlier ${l.id}`, sev(l.moved!.meta)] as const),
    ...plan.closed.map((c) => [`withdrawn ${c.id}`, sev(c.meta)] as const),
  ]);
  const got: Array<[string, string]> = [
    ...(Array.isArray(p.items) ? p.items : []).filter((x): x is Record<string, unknown> => isObject(x) && x.meta !== undefined).map((x) => [`item ${String(x.id)}`, sev(x.meta)] as [string, string]),
    ...(Array.isArray(p.priors) ? p.priors : []).filter((x): x is Record<string, unknown> => isObject(x) && isObject(x.moved)).map((x) => [`earlier ${String(x.id)}`, sev((x.moved as Record<string, unknown>).meta)] as [string, string]),
    ...(Array.isArray(p.closed) ? p.closed : []).filter(isObject).map((x) => [`withdrawn ${String(x.id)}`, sev(x.meta)] as [string, string]),
  ];
  for (const [k, s] of got) if (want.has(k) && want.get(k) !== s) return `the ledger records ${k} at ${s}, but the draft rules give ${want.get(k)}`;
  return undefined;
}

// ---- the ledger ----

/** The review section's record of a post: this head, its findings and what became of the earlier ones. Prints `SAME` when nothing changes. */
const MERGE_REVIEW = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{
const v=JSON.parse(s);const before=JSON.stringify(v);const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(!v.schema)v.schema="${REVIEW_SCHEMA}";
const heads=Array.isArray(v.heads)?v.heads:[];
const e=Object.assign({sha:p.head,base:p.base,context:p.context,round1:p.round1,reviewId:p.reviewId},p.url?{reviewUrl:p.url}:{},{verdict:p.verdict,open:p.open,leads:p.leads});
const i=heads.findIndex((x)=>x.sha===p.head);if(i>=0)heads[i]=e;else heads.push(e);
const gh=(it)=>({head:p.head,reviewId:p.reviewId,commentId:it.commentId,inline:it.inline});
const findings=Array.isArray(v.findings)?v.findings:[];
const note=(f,status,extra)=>{const keep=(Array.isArray(f.history)?f.history:[]).filter((x)=>x.head!==p.head);f.history=keep.concat([Object.assign({head:p.head,status:status},extra||{})])};
for(const it of p.items){
const fields=Object.assign({origin:it.origin,path:it.path,line:it.line,text:it.text},it.endLine?{endLine:it.endLine}:{},it.body?{body:it.body}:{},it.meta||{});
let f=findings.find((x)=>x.id===it.id);
if(f){if(it.meta){delete f.anchorText;delete f.patchId;delete f.hunk;delete f.outdated}Object.assign(f,fields)}else{f=Object.assign({head:p.head,id:it.id},fields);findings.push(f)}
f.state="open";f.github=gh(it);note(f,"open",it.repost?{reposted:true}:{});
}
for(const pr of p.priors||[]){
const f=findings.find((x)=>x.id===pr.id);if(!f)continue;
if(pr.status==="fixed"){f.state="fixed";f.fixedIn=p.head;note(f,"fixed",{reason:pr.reason})}
else if(!p.items.some((it)=>it.id===pr.id)){note(f,"open",{reason:pr.reason,carried:pr.carried});if(pr.moved){delete f.anchorText;delete f.patchId;delete f.hunk;Object.assign(f,{path:pr.moved.path,line:pr.moved.line,endLine:pr.moved.endLine},pr.moved.meta)}if(pr.outdated===true)f.outdated=true;else if(pr.outdated===false)delete f.outdated}
}
for(const c of p.closed||[]){if(findings.some((x)=>x.id===c.id))continue;findings.push(Object.assign({head:p.head,id:c.id,origin:"round2",path:c.path,line:c.line,endLine:c.endLine,side:c.side,text:c.text,state:"withdrawn",history:[{head:p.head,status:"withdrawn"}]},c.meta||{}))}
v.heads=heads;v.findings=findings;const out=JSON.stringify(v);process.stdout.write(out===before?"SAME":out)})`;

/** pr-review writes the review section only (design-pr-review-split §5.2). */
export const PUBLISHED_SECTIONS: Section[] = ["review"];

/**
 * Records the published review in the ledger's review section: the head with its review id, verdict, context source and the round-1
 * head it counted, its findings' `github` ids, and what became of the earlier findings. The section is advanced from this run's Draft
 * write; the design section is carried from the ref's current value, never written. A review the ledger already holds is a no-op.
 */
export function ledgerPublishedCommand(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, patch: LedgerPatch, baselines: Record<Section, string>, node = "node"): EnvironmentCommand {
  return {
    id: COMMAND.ledgerPublished,
    argv: ["sh", "-c", PUBLISHED_WRITE, COMMAND.ledgerPublished, ledgerRef(pr.owner, pr.repo, pr.number), `pr-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: published review ${patch.reviewId}`, PUBLISH_PATCH_FILE, node, PUBLISHED_SECTIONS.join(" "), baselines.design, baselines.review, "", MERGE_REVIEW, reviewMarkdown(pr)],
  };
}

// ---- what the stage posts, from the records ----

export type PublishPlan = { state: "ready"; plan: ReviewPlan; draft: Draft } | { state: "pending"; reason: string } | { state: "failed"; reason: string; refs: string[] };

/** Whether the thread that holds comment `commentId` is outdated on GitHub (the lines it was left on changed). */
function threadOutdated(threads: readonly unknown[], commentId: number | null | undefined): boolean {
  if (commentId === undefined || commentId === null) return false;
  return threads.some((t) => isObject(t) && t.isOutdated === true && Array.isArray(t.comments) && t.comments.some((c) => isObject(c) && c.id === commentId));
}

/**
 * What became of each finding an earlier head posted, from the aspects' records (judged by the sweep, or settled). A finding still open
 * is posted again only when its old thread is outdated on GitHub and its anchor was found again on this head. Round 1's items are the
 * design review's: never re-checked or posted here.
 */
export function priorLines(registry: PriorRegistry, pull: Pick<PullRequest, "owner" | "repo" | "number">, records: readonly AspectRecord[], files: readonly PullFile[], threads: readonly unknown[]): PriorLine[] {
  const out: PriorLine[] = [];
  const outcomes = new Map(records.flatMap((r) => r.prior ?? []).map((o) => [o.id, o] as const));
  for (const item of registry.items.filter((x) => x.origin === "round2" && x.status === "open")) {
    const o = outcomes.get(item.id);
    const link = commentLink(pull, item);
    const base = { id: item.id, origin: "round2" as const, ...(link !== undefined ? { link } : {}), item };
    if (o === undefined) {
      out.push({ ...base, status: "open", reason: "not re-checked on this head", carried: true, repost: false });
      continue;
    }
    const repost = o.status === "open" && o.how !== "carried" && !o.outdated && threadOutdated(threads, item.commentId);
    const file = files.find((f) => f.path === o.path);
    const place = { path: o.path, line: o.line, endLine: o.endLine, side: o.side, anchored: anchored(file, o.side, o.line, o.endLine) };
    const info = o.status === "open" && o.how !== "carried" && !o.outdated ? anchorInfo(file, o.side, o.line) : {};
    const { anchorText: _a, patchId: _p, hunk: _h, ...rest } = metaOf(item);
    const moved = info.patchId !== undefined ? { path: o.path, line: o.line, endLine: o.endLine, meta: { ...rest, ...info, side: o.side, endLine: o.endLine } } : undefined;
    out.push({ ...base, status: o.status, reason: o.reason, carried: o.how === "carried", repost, ...(o.status === "open" && o.how !== "carried" ? { outdated: o.outdated } : {}), ...(repost ? { place } : {}), ...(moved !== undefined ? { moved } : {}) });
  }
  return out.sort((a, b) => (Number(a.id.slice(1)) || 0) - (Number(b.id.slice(1)) || 0));
}

/**
 * What the ledger keeps of this head's findings, from the draft: each finding's meta (for a posted one, its draft entry's range) and
 * the dismissed ones, recorded withdrawn. A finding's priority is its final one, the draft's (design §8.4, §9.1), never the one its
 * reviewer proposed; a dismissed finding is in no draft entry and records none.
 */
export function draftLedgerMeta(draft: Pick<Draft, "comments" | "review">, files: readonly PullFile[]): { meta: Map<string, ItemMeta>; closed: ClosedFinding[] } {
  const all = draft.review.findings;
  // A posted finding's place is its draft entry's range (which can cover several findings): the anchor is read at its first line and the range is recorded whole.
  const entries = new Map(draft.comments.map((c) => [c.id, c] as const));
  const meta = new Map(
    all
      .filter((f) => f.state === "confirmed" || f.state === "disputed")
      .map((f) => {
        const e = entries.get(f.id);
        return [f.id, findingMeta(e === undefined ? f : { ...f, path: e.path, side: e.side, startLine: e.startLine ?? e.line, endLine: e.line }, files)] as const;
      }),
  );
  const closed = all.filter((f) => f.state === "dismissed").map((f): ClosedFinding => ({ id: f.id, path: f.path, line: f.startLine, endLine: f.endLine, side: f.side, text: clipKeep(neutralize(f.content), MAX_ITEM_TEXT), meta: findingMeta(f, files) }));
  return { meta, closed };
}

/** The review the run posts, recomputed from the draft the Draft stage composed, the aspects' records, the ledger and round 1's status. */
export function publishPlan(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, base: string | undefined, context: ContextRecord, m: MeasurementState, profile: Pick<Profile, "metrics" | "comments">): PublishPlan {
  const w = draftWrites(evidence, analysis, pr, base, context, m, profile);
  if (w.state === "pending") return { state: "pending", reason: `the draft cannot be composed: ${w.reason}` };
  if (w.state === "failed") return w;
  const nonce = viewerOf(evidence)?.nonce ?? "pending";
  const registry = registryFromEvidence(evidence);
  const files = analysis.snapshot.files;
  const records: AspectRecord[] = [];
  for (const a of ASPECTS) {
    const r = recordedAspect(evidence, a);
    if (r.state === "read") records.push(r.value);
  }
  const draft = w.writes.draft;
  const { meta, closed } = draftLedgerMeta(draft, files);
  const prior = priorLines(registry, pr, records, files, analysis.snapshot.threads);
  return { state: "ready", draft, plan: planReview({ pull: pr, head: pr.head, nonce, draft, round1: draft.round1, prior, meta, closed, comments: profile.comments }) };
}
