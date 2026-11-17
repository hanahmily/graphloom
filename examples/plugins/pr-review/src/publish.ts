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
 *
 * On a later head (design §9.3, §9.4) the review also says what became of the items an earlier head posted: each one fixed (in
 * which commit) or still open (with a link to its earlier comment). A still-open item is not posted again, unless its old thread is
 * outdated; it counts toward the verdict, so `Review passed` means no round-1 issue and no round-2 finding is open, earlier ones included.
 */
import { MAX_EXECUTOR_INPUT_BYTES, type EnvironmentCommand, type EvidenceRecord } from "@graphloom/sdk";
import { COMMAND, CREATE_PULL_REVIEW, GET_VIEWER, LEDGER_MOVED, PART_BASE, PUBLISH_PATCH_FILE, PUBLISH_STAGE, ledgerRef } from "./constants.js";
import { fitParts, type ItemParts } from "./answertext.js";
import { clip, clipKeep, withoutFences } from "./escape.js";
import { partCommands, readParts } from "./parts.js";
import { anchored, severityLabel, type Draft, type DraftEntry } from "./draft.js";
import { commandRuns, isObject, producer, reportText, succeeded, type CommandRun } from "./evidence.js";
import type { Analysis } from "./analysis.js";
import { ledgerRead, oldValue, parseSectionRecord, priorState, readBaselines, SECTION_PRELUDE, SECTION_RECORD } from "./ledger.js";
import { LEDGER_V2, REVIEW_SCHEMA, reviewMarkdown, SKIPPED_NOTE, type Section } from "./ledgerv2.js";
import { pinnedBase } from "./commands.js";
import { draftWrites, recordedRound1 } from "./reviewdraft.js";
import { anchorInfo, findingKey, registryFromEvidence, type PriorItem, type PriorRegistry } from "./prior.js";
import { ASPECTS } from "./aspects.js";
import { findingsOf, type AspectRecord } from "./review.js";
import { recordedAspect } from "./reviewdraft.js";
import type { PullFile } from "./snapshot.js";
import { MAX_ITEM_TEXT, type Round1Covered, type Round1Record } from "./round1.js";
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
/** What one item may take before it is shortened: its text (`MAX_ITEM_TEXT`) and, for a finding, its suggestion block. Far below the 65,536 characters GitHub accepts in a comment. */
const MAX_ITEM_BODY = MAX_ITEM_TEXT + 2_000;
/** The least text a compacted item keeps: a one-liner shorter than this says too little to act on. */
const MIN_ONE_LINER = 80;
/** Room kept in the executor input for what the plan does not measure (the idempotency key and the like). */
const INPUT_MARGIN = 1_000;

export const findingMarker = (id: string): string => `<!-- graphloom-finding: ${id} -->`;
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
/** The marker of this run's review of `head`: the head and a nonce of the run (its viewer read's operation), which a stranger cannot know. */
export const reviewMarker = (head: string, nonce: string): string => `<!-- graphloom-review: ${head} ${nonce} -->`;
/** The same for a post of round 1's items, the design review's (design-pr-review-split §5.3): a post of either round is told apart by its marker before its nonce. */
export const designReviewMarker = (head: string, nonce: string): string => `<!-- graphloom-design-review: ${head} ${nonce} -->`;
/** The head marker of a post of round `round`, the body's second line: round 1 posts as the design review, round 2 as the PR review. */
export const headMarker = (round: 1 | 2, head: string, nonce: string): string => (round === 1 ? designReviewMarker(head, nonce) : reviewMarker(head, nonce));
/** The marker publication appends: the last thing in a body. Marker-looking text in an item's content is neutralized and never matches. */
const MARKER = /<!-- graphloom-finding: ([A-Z][0-9]+) -->$/;
/** The same marker as the first thing in a body: a read cuts a body at 4,000 characters, so a longer body also leads with it. */
const LEADING_MARKER = /^<!-- graphloom-finding: ([A-Z][0-9]+) -->(?:\n|$)/;
/** A body longer than this has lost its trailing marker when read back (the read keeps 4,000 characters). */
const READ_WINDOW = 3_900;
/** Content that looks like one of this graph's markers (or any HTML comment) is made inert, so it cannot be taken for a marker or hide text. */
export const neutralize = (text: string): string => text.replace(/<!--/g, "&lt;!--");
const SUGGESTION_OMITTED = "(suggested change omitted for size; see the report)";
/** A posted text shortened to `n` characters: its fenced blocks (a suggestion) go whole, with a note, before its prose is cut at a sentence end or a word boundary; no fence is ever left open. */
function shrinkPlain(text: string, n: number): string {
  const noted = text.endsWith(SUGGESTION_OMITTED);
  const w = noted ? { text: text.slice(0, text.length - SUGGESTION_OMITTED.length).trim(), dropped: true } : withoutFences(text);
  if (!w.dropped) return clipKeep(text, n);
  const room = n - SUGGESTION_OMITTED.length - 2;
  return `${w.text.length <= room ? w.text : clipKeep(w.text, Math.max(1, room))}\n\n${SUGGESTION_OMITTED}`;
}
const neutralParts = (p: ItemParts): ItemParts => ({ ...p, head: neutralize(p.head), answer: neutralize(p.answer), cites: p.cites.map(neutralize), proposal: neutralize(p.proposal), ...(p.tail !== undefined ? { tail: neutralize(p.tail) } : {}) });

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
  /** The item's whole text (without its marker) when `body` was compacted to a one-line text to fit the review body; the ledger records it. */
  full?: string;
  /** The item's text as parts (an answer, its citations, its proposal), which a shortened item is cut by; not part of what is posted or recorded. */
  parts?: ItemParts;
  /** What the ledger keeps of the item so a later head can find it again (design §9.1). */
  meta?: ItemMeta;
  /** An earlier head's item posted again, because its old thread is outdated. */
  repost?: boolean;
  /** The other round-1 questions this issue stands for. */
  covers?: string[];
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

/** What became of an item an earlier head posted, as this head's review says it. */
export interface PriorLine {
  id: string;
  origin: "round1" | "round2";
  status: "fixed" | "open";
  reason: string;
  /** Still open without being re-checked on this head (round 2 did not run, or its file was outside the scope). */
  carried: boolean;
  /** The earlier comment, or the review that holds it. */
  link?: string;
  /** The item's old thread is outdated: it is posted again as a new comment, where `place` says. */
  repost: boolean;
  /** Where a reposted round-2 item goes on this head, and whether that place lies in the diff. */
  place?: { path: string; line: number; endLine: number; side: "RIGHT" | "LEFT"; anchored: boolean };
  /** A still-open round-2 item whose anchor was not found again on this head: it is listed in the body, and the ledger marks it outdated. */
  outdated?: boolean;
  /** A still-open round-2 item whose place on this head was found again (or which is posted again): where it is now, and its anchor recomputed against this head's patch, which the ledger persists in place of the earlier head's. */
  moved?: { path: string; line: number; endLine: number; meta: ItemMeta };
  item: PriorItem;
  /** A still-open round-1 issue that stands for other questions on this head: who, and with which equivalent each. */
  covered?: readonly Round1Covered[];
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
  round: 1 | 2;
  /** Round 1 was skipped by the operator's choice (`rounds: review-only`, design §3.2): the ledger records the head's round 1 as skipped, not clean. */
  round1Skipped?: true;
  verdict: "passed" | "changes-requested";
  /** The items still open: round 1's issues when it found any, else round 2's postable findings. */
  open: number;
  /** The review body: the verdict first, then the head's marker, the rounds and the items that are not inline. */
  body: string;
  comments: Array<{ path: string; line: number; side: "RIGHT" | "LEFT"; startLine?: number; body: string }>;
  items: PublishItem[];
  /** The verdict's first line of the body. */
  firstLine: string;
  /** What became of the earlier heads' items, which the body lists and the ledger records. */
  priors: PriorLine[];
  /** Findings dismissed on this head, recorded closed in the ledger. */
  closed: ClosedFinding[];
  /** Why the review cannot be posted so that every item is readable (they fit neither inline nor as one-line texts); the stage escalates instead of posting ids only. */
  problem?: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The first line of the review: the verdict, and what is open. */
export const verdictLine = (open: number): string => (open === 0 ? "Review passed" : `Changes requested: ${open} open`);

function findingBody(e: DraftEntry): { text: string; full?: string } {
  const aspects = e.aspects.length > 0 ? ` · ${e.aspects.join(", ")}` : "";
  const tags = [e.proof?.state === "non-behavioral" ? "non-behavioral" : e.proof?.state === "proven" ? "proven by a failing test" : undefined, e.principle !== undefined ? `breaks principle ${e.principle}` : undefined].filter((t): t is string => t !== undefined);
  const label = `**${e.severity !== undefined ? severityLabel(e.severity) : "[finding]"}**${aspects}${tags.length > 0 ? ` · ${tags.join(" · ")}` : ""}`;
  const text = `${label}\n\n${clipKeep(neutralize(e.body), MAX_ITEM_TEXT)}`;
  const suggestion = e.suggestion !== undefined && e.anchored && e.side === "RIGHT" ? `\n\n\`\`\`suggestion\n${e.suggestion}\n\`\`\`` : "";
  const posted = text.length + suggestion.length <= MAX_ITEM_BODY - 60 ? `${text}${suggestion}` : text;
  // What was cut (the text, or a suggestion that did not fit) is kept whole for the ledger.
  return posted === `${label}\n\n${neutralize(e.body)}${suggestion}` ? { text: posted } : { text: posted, full: `${label}\n\n${neutralize(e.body)}${suggestion}` };
}

/**
 * The review for this run: round 1's issues when it found any, otherwise round 2's postable findings (the draft's comments
 * that are findings). The verdict is `Review passed` only when round 1 has no open issue and round 2 no open postable finding.
 * Inline comments are the items with a diff anchor, up to what one review carries; the rest are in the body.
 */
export function planReview(i: {
  pull: Pick<PullRequest, "owner" | "repo" | "number">;
  head: string;
  nonce: string;
  round1: Round1Record;
  draft?: Draft | undefined;
  /** What became of the earlier heads' items (none for a first run). */
  prior?: readonly PriorLine[] | undefined;
  /** What the ledger keeps of each new round-2 finding, by id. */
  meta?: ReadonlyMap<string, ItemMeta> | undefined;
  closed?: readonly ClosedFinding[] | undefined;
  /** The executor input bound in bytes the whole create-pull-review input must fit (default: the executor input bound). */
  maxInputBytes?: number | undefined;
}): ReviewPlan {
  const issues = i.round1.issues;
  const priors = [...(i.prior ?? [])];
  const round: 1 | 2 = issues.length > 0 || i.draft === undefined ? 1 : 2;
  // A still-open issue is not posted again while its old thread is live; it is listed in the body with a link.
  const listed = new Set(priors.filter((l) => l.origin === "round1" && l.status === "open" && !l.repost).map((l) => l.id));
  const reposts: PublishItem[] = priors
    .filter((l) => l.origin === "round2" && l.status === "open" && l.repost && l.place !== undefined && round === 2)
    .map((l) => {
      const text = neutralize(`**Still open** (first raised on ${l.item.head.slice(0, 7)}).\n\n${l.item.text ?? ""}`.trim());
      const posted = clipKeep(text, MAX_ITEM_TEXT);
      const place = l.place!;
      return { id: l.id, origin: "round2" as const, body: markedBody(l.id, posted), ...(posted !== text ? { full: text } : {}), path: place.path, line: place.endLine, ...(place.endLine > place.line ? { startLine: place.line } : {}), side: place.side, inline: false, repost: true, meta: l.moved?.meta ?? metaOf(l.item) };
    });
  const items: PublishItem[] =
    round === 1
      ? issues.filter((x) => !listed.has(x.id)).map((x) => {
          const text = neutralize(x.body);
          const parts = x.parts !== undefined ? neutralParts(x.parts) : undefined;
          const posted = text.length <= MAX_ITEM_TEXT ? text : parts !== undefined ? fitParts(parts, MAX_ITEM_TEXT) : clipKeep(text, MAX_ITEM_TEXT);
          return { id: x.id, origin: "round1" as const, body: markedBody(x.id, posted), ...(posted !== text ? { full: text } : {}), ...(parts !== undefined ? { parts } : {}), ...(x.path !== undefined && x.line !== undefined ? { path: x.path, line: x.line } : {}), side: "RIGHT" as const, inline: false, ...(x.covers !== undefined ? { covers: x.covers } : {}), meta: { key: x.key ?? "", ...(x.path !== undefined ? { side: "RIGHT" as const } : {}) } };
        })
      : [
          ...(i.draft?.comments ?? []).filter((c) => c.kind === "finding").map((e) => { const b = findingBody(e); return ({ id: e.id, origin: "round2" as const, body: markedBody(e.id, b.text), ...(b.full !== undefined ? { full: b.full } : {}), path: e.path, line: e.line, ...(e.startLine !== undefined ? { startLine: e.startLine } : {}), side: e.side, inline: false, ...(i.meta?.has(e.id) ? { meta: i.meta.get(e.id)! } : {}) }); }),
          ...reposts,
        ];
  const anchoredIds = new Set<string>([
    ...(round === 1 ? issues.filter((x) => x.anchored).map((x) => x.id) : (i.draft?.comments ?? []).filter((c) => c.kind === "finding" && c.anchored).map((c) => c.id)),
    ...reposts.filter((x) => priors.find((l) => l.id === x.id)?.place?.anchored === true).map((x) => x.id),
  ]);
  let inline = 0;
  for (const it of items) {
    if (anchoredIds.has(it.id) && it.path !== undefined && it.line !== undefined && inline < MAX_INLINE_COMMENTS) {
      it.inline = true;
      inline += 1;
    }
  }
  // What is open: the items posted now (new ones and reposts of one still open) and the earlier ones still open and listed. An earlier item that is open is one item, posted again or not.
  const stillOpen = priors.filter((l) => l.status === "open");
  const stillIds = new Set(stillOpen.map((l) => l.id));
  for (const x of items) if (stillIds.has(x.id)) x.repost = true;
  const open = items.filter((x) => !stillIds.has(x.id)).length + stillOpen.length;
  const verdict = open === 0 ? "passed" : "changes-requested";
  const firstLine = verdictLine(open);
  const rest = items.filter((x) => !x.inline);
  const round1Line = i.round1.skipped !== undefined ? `Round 1 (design and architecture, from the change report and its questions) was skipped by the operator's choice (${i.round1.skipped}): no question was asked, and earlier round-1 items, if any, were not re-checked and are not counted here.` : issues.length > 0 ? `Round 1 (design and architecture, from the change report and its questions): ${issues.length} issue${issues.length === 1 ? "" : "s"} to resolve. The detailed review (round 2) runs after they are fixed.` : "Round 1 (design and architecture, from the change report and its questions): no open issue.";
  const round2Line = round === 2 ? `Round 2 (details, functionality, algorithms): ${i.draft !== undefined && open > 0 ? `${open} open finding${open === 1 ? "" : "s"}.` : "no open finding."}${i.draft !== undefined && i.draft.summary !== "" ? ` ${oneLine(i.draft.summary)}` : ""}` : undefined;
  const sections = [
    `${firstLine}\n${headMarker(round, i.head, i.nonce)}`,
    [round1Line, ...(round2Line !== undefined ? [round2Line] : [])].join("\n\n"),
    ...(priors.length > 0 ? [priorSection(priors, i.pull, i.head)] : []),
    ...(inline > 0 ? [`${inline} item${inline === 1 ? " is" : "s are"} commented on the diff.`] : []),
  ];
  // The items that are not inline follow, whole, while they all fit. When they do not, an item with an anchor moves inline (room allowing),
  // and the rest shrink evenly to one-line texts (every item keeps its text and its marker, none is reduced to an id); when even that
  // cannot fit, the plan says so and the stage escalates.
  const budget = MAX_REVIEW_BODY - 200 - sections.join("\n\n").length;
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
    body: [...sections, ...items.filter((x) => !x.inline).map((x) => x.body)].join("\n\n"),
    comments: items.filter((x) => x.inline).map((x) => ({ path: x.path!, line: x.line!, side: x.side, ...(x.startLine !== undefined && x.startLine < x.line! ? { startLine: x.startLine } : {}), body: x.body })),
  });
  // The executor takes at most `maxInputBytes` of JSON for the whole input: body, every inline comment and the envelope. Items,
  // inline ones included, are shortened largest first by the rules of an item that does not fit (the proposal, the end of the
  // answer at a sentence end or a word boundary with its note, citations last) until the input fits; none is dropped.
  if (problem === undefined) {
    const maxBytes = (i.maxInputBytes ?? MAX_EXECUTOR_INPUT_BYTES) - INPUT_MARGIN;
    const inputBytes = (): number => {
      const a = assemble();
      return Buffer.byteLength(JSON.stringify(createInput({ ...i.pull, head: i.head }, { round, body: a.body, comments: a.comments } as ReviewPlan)), "utf8");
    };
    const exhausted = new Set<string>();
    let bytes = inputBytes();
    for (let guard = 0; bytes > maxBytes && guard < 10_000; guard += 1) {
      const candidates = items.filter((x) => !exhausted.has(x.id));
      const biggest = candidates.reduce<PublishItem | undefined>((m, x) => (m === undefined || Buffer.byteLength(x.body, "utf8") > Buffer.byteLength(m.body, "utf8") ? x : m), undefined);
      if (biggest === undefined) break;
      const text = unmarkedText(biggest.id, biggest.body);
      const target = Math.floor(text.length * 0.85);
      const shorter = biggest.parts !== undefined ? fitParts(biggest.parts, target) : target >= MIN_ONE_LINER ? shrinkPlain(text, target) : text;
      if (shorter.length >= text.length) {
        exhausted.add(biggest.id);
        continue;
      }
      biggest.full ??= text;
      biggest.body = markedBody(biggest.id, shorter);
      // A parts item is cut from its parts, so the next cut starts from the whole again, not from this one.
      bytes = inputBytes();
    }
    if (bytes > maxBytes) problem = `the review's input is ${bytes} bytes, over the ${maxBytes} the executor takes, with every one of its ${items.length} item${items.length === 1 ? "" : "s"} shortened as far as it goes: posting fewer items or ids only would hide what is requested`;
  }
  const { body, comments } = assemble();
  return { round, ...(i.round1.skipped !== undefined ? { round1Skipped: true as const } : {}), verdict, open, body, comments, items, firstLine, priors, closed: [...(i.closed ?? [])], ...(problem !== undefined ? { problem } : {}) };
}

/** What the ledger keeps of an item an earlier head posted, which a repost carries on unchanged. */
function metaOf(x: PriorItem): ItemMeta {
  return { key: x.key, ...(x.aspect !== undefined ? { aspect: x.aspect } : {}), ...(x.severity !== undefined ? { severity: x.severity } : {}), ...(x.kind !== undefined ? { kind: x.kind } : {}), ...(x.side !== undefined ? { side: x.side } : {}), ...(x.endLine !== undefined ? { endLine: x.endLine } : {}), ...(x.anchorText !== undefined ? { anchorText: x.anchorText } : {}), ...(x.patchId !== undefined ? { patchId: x.patchId } : {}), ...(x.hunk !== undefined ? { hunk: x.hunk } : {}) };
}

/** The review body's account of the earlier heads' items: fixed in which commit, or still open with a link to the earlier comment. */
function priorSection(priors: readonly PriorLine[], pull: Pick<PullRequest, "owner" | "repo" | "number">, head: string): string {
  const lines = priors.map((l) => {
    const why = l.reason !== "" ? ` (${clip(oneLine(neutralize(l.reason)), 160)})` : "";
    if (l.status === "fixed") return `- ${l.id}: fixed in ${head.slice(0, 7)}${why}`;
    const added = l.repost ? [] : (l.covered ?? []).filter((c) => !(l.item.covers ?? []).includes(c.id));
    const more = added.map((c) => `\n  - ${l.id} (still open) now also covers ${c.id} ${c.symbol}: ${c.equivalents.map((e) => `\`${e.replace(/^dependency:/, "")}\``).join(", ")}${c.excerpt !== "" ? ` (${clip(oneLine(neutralize(c.excerpt)), 160)})` : ""}`).join("");
    return `- ${l.id}: still open${l.repost ? "; its old thread is outdated, so it is commented again" : l.link !== undefined ? ` ([earlier comment](${l.link}))` : ""}${why}${more}`;
  });
  const fixed = priors.filter((l) => l.status === "fixed").length;
  return [`Earlier items (${fixed} fixed, ${priors.length - fixed} still open):`, ...lines].join("\n");
}

/** The link to an earlier comment on the pull request, or to the review that holds it. */
export function commentLink(pull: Pick<PullRequest, "owner" | "repo" | "number">, item: Pick<PriorItem, "commentId" | "reviewId" | "inline">): string | undefined {
  const base = `https://github.com/${pull.owner}/${pull.repo}/pull/${pull.number}`;
  if (item.commentId !== undefined && item.commentId !== null) return `${base}#discussion_r${item.commentId}`;
  return item.reviewId !== undefined ? `${base}#pullrequestreview-${item.reviewId}` : undefined;
}

/** The meta of a new round-2 finding the draft posts: the aspect that raised it, its place and what the file's patch shows there. */
export function findingMeta(f: { id: string; raisedBy: string; severity: string; kind: string; path: string; side: "RIGHT" | "LEFT"; startLine: number; endLine: number }, files: readonly PullFile[]): ItemMeta {
  const a = anchorInfo(files.find((x) => x.path === f.path), f.side, f.startLine);
  return { key: findingKey(f.raisedBy, f.path, f.startLine, a.anchorText), aspect: f.raisedBy, severity: f.severity, kind: f.kind, side: f.side, endLine: f.endLine, ...a };
}

/** The input of the create-pull-review call: one `COMMENT` review at the pinned head. */
export function createInput(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, plan: ReviewPlan): Record<string, unknown> {
  return { owner: pr.owner, repo: pr.repo, number: pr.number, event: "COMMENT", body: plan.body, comments: plan.comments, commitId: pr.head, idempotencyKey: idempotencyKey(plan.round, pr.head) };
}

/** The reads the stage makes of the pull request's reviews and their comments. */
const spec = (key: ReadSpec["key"]): ReadSpec => READS.find((r) => r.key === key)!;
export const REVIEWS_READ = spec("reviews");
export const COMMENTS_READ = spec("reviewComments");

/**
 * A review of this head that this run posted: authored by the login the credential authenticates as, in state COMMENTED, and carrying
 * this run's head marker for the round it posts (the body's second line). The marker alone proves nothing (the head sha is public),
 * so a review by anyone else is ignored, and a review with the other round's marker is not this post (design-pr-review-split §5.3).
 */
export function findPosted(items: readonly unknown[], head: string, nonce: string, login: string, round: 1 | 2): { id: number; url: string | null } | undefined {
  const marker = headMarker(round, head, nonce);
  for (const r of items) {
    if (!isObject(r) || typeof r.id !== "number" || r.commitId !== head || r.user !== login || r.state !== "COMMENTED") continue;
    if (typeof r.body === "string" && r.body.split("\n")[1]?.trim() === marker) return { id: r.id, url: typeof r.url === "string" ? r.url : null };
  }
  return undefined;
}

/** The key the executor reconciles a post by (design-pr-review-split §5.3): `design-<head12>` for round 1's, `review-<head12>` for round 2's. */
export const idempotencyKey = (round: 1 | 2, head: string): string => `${round === 1 ? "design" : "review"}-${head.slice(0, 12)}`;

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

/** What the ledger records of the published review: patched into `ledger.json` by `ledger-published`. */
export interface LedgerPatch {
  schema: typeof PUBLISH_SCHEMA;
  head: string;
  round: 1 | 2;
  round1Skipped?: true;
  /** This head's pinned base, which the review section's head records. */
  base?: string;
  verdict: ReviewPlan["verdict"];
  open: number;
  /** Round 1's items still open after this head, which the design section's head records: the ones posted now and the earlier ones still open. */
  round1Open: number;
  reviewId: number;
  url: string | null;
  items: Array<{ id: string; origin: PublishItem["origin"]; path: string | null; line: number | null; endLine?: number; inline: boolean; commentId: number | null; /** The whole text of an item whose posted text was compacted. */ body?: string; /** The item's text as posted (whole), without its marker. */ text: string; repost?: boolean; covers?: string[]; meta?: ItemMeta }>;
  /** What became of the earlier heads' items on this head. */
  priors: Array<{ id: string; origin: PriorLine["origin"]; status: PriorLine["status"]; carried: boolean; reason: string; outdated?: boolean; /** Where a still-open item is on this head, with its anchor recomputed against this head's patch. */ moved?: PriorLine["moved"]; /** The round-1 questions a still-open issue stands for on this head. */ covers?: string[] }>;
  /** Findings dismissed on this head, recorded closed. */
  closed: Array<{ id: string; path: string; line: number; endLine: number; side: "RIGHT" | "LEFT"; text: string; meta: ItemMeta }>;
}

export function ledgerPatch(pr: Pick<PullRequest, "head"> & { base?: string | undefined }, plan: ReviewPlan, posted: Posted, ids: ReadonlyMap<string, number>): LedgerPatch {
  const round1Open = new Set([...plan.items.filter((x) => x.origin === "round1").map((x) => x.id), ...plan.priors.filter((l) => l.origin === "round1" && l.status === "open").map((l) => l.id)]).size;
  return {
    schema: PUBLISH_SCHEMA,
    head: pr.head,
    round: plan.round,
    ...(plan.round1Skipped === true ? { round1Skipped: true as const } : {}),
    ...(pr.base !== undefined ? { base: pr.base } : {}),
    verdict: plan.verdict,
    open: plan.open,
    round1Open,
    reviewId: posted.reviewId,
    url: posted.url,
    items: plan.items.map((x) => ({ id: x.id, origin: x.origin, path: x.path ?? null, /** The item's first line (a range's last is `endLine`; GitHub's own convention is the end, kept for the posted comment only). */ line: x.startLine ?? x.line ?? null, ...(x.line !== undefined ? { endLine: x.line } : {}), inline: x.inline, commentId: x.inline ? ids.get(x.id) ?? null : null, ...(x.full !== undefined ? { body: x.full } : {}), text: x.full ?? unmarkedText(x.id, x.body), ...(x.repost === true ? { repost: true } : {}), ...(x.covers !== undefined ? { covers: x.covers } : {}), ...(x.meta !== undefined ? { meta: x.meta } : {}) })),
    priors: plan.priors.map((l) => ({ id: l.id, origin: l.origin, status: l.status, carried: l.carried, reason: l.reason, ...(l.outdated !== undefined ? { outdated: l.outdated } : {}), ...(l.moved !== undefined ? { moved: l.moved } : {}), ...(l.covered !== undefined && l.covered.length > 0 ? { covers: l.covered.map((c) => c.id) } : {}) })),
    closed: plan.closed.map((c) => ({ id: c.id, path: c.path, line: c.line, endLine: c.endLine, side: c.side, text: c.text, meta: c.meta })),
  };
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

export type PublishFlow =
  | { state: "viewer"; why: string }
  | { state: "reviews"; cursor?: string; why: string }
  | { state: "create"; why: string }
  | { state: "comments"; reviewId: number; cursor?: string; why: string }
  | { state: "ledger"; posted: Posted; patch: LedgerPatch; /** The section write that records it. */ command: EnvironmentCommand; /** The commands that write the patch file, a part set, before the ledger command reads it. */ parts: EnvironmentCommand[]; run?: CommandRun }
  | { state: "done"; posted: Posted; patch: LedgerPatch }
  | { state: "supervise"; reason: string; refs: string[] };

const at = (evidence: readonly EvidenceRecord[], ref: string): number => evidence.findIndex((e) => e.ref === ref);

/**
 * Where the stage stands, from the evidence alone. Reads and the write are the publish stage's own records. The latest read of
 * the reviews decides whether a review of this head exists; a create after it (an attempt that failed or whose outcome is not
 * known) means the reviews are read again before anything is posted, so an ambiguous attempt is reconciled, never repeated blind.
 */
export function publishFlow(evidence: readonly EvidenceRecord[], plan: ReviewPlan, pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">): PublishFlow {
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
    const found = findPosted(reviews.items, pr.head, viewer.nonce, viewer.login, plan.round);
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
  if (!comments.complete) return { state: "supervise", reason: "the review's comments could not be read whole, so their ids cannot be recorded", refs: comments.refs };
  const ids = commentIds(comments.items, posted.reviewId);
  const missing = plan.items.filter((x) => x.inline && !ids.has(x.id)).map((x) => x.id);
  if (missing.length > 0) {
    // A read can lag the post: read again (a whole read each time), and escalate when the ids are still missing, never accept a null id.
    const reads = later.filter((e) => producer(e)?.executorId === COMMENTS_READ.pin.id && isObject(e.payload) && isObject(e.payload.github) && (!isObject(e.payload.github.page) || [undefined, "1", "start"].includes(e.payload.github.page.startCursor as string | undefined))).length;
    if (reads >= MAX_COMMENT_READS) return { state: "supervise", reason: `${reads} reads of the review's comments did not show the inline comment${missing.length === 1 ? "" : "s"} of ${missing.join(", ")}, so their ids cannot be recorded`, refs: comments.refs };
    return { state: "comments", reviewId: posted.reviewId, why: `the read of the review's comments lacks ${missing.join(", ")}: read them again` };
  }
  const patch = ledgerPatch({ head: pr.head, base: pinnedBase(evidence) }, plan, posted, ids);
  const baselines = publishBaselines(evidence, pr);
  if ("problem" in baselines) return { state: "supervise", reason: `the published review cannot be recorded in the ledger: ${baselines.problem}`, refs: [] };
  const command = ledgerPublishedCommand(pr, patch, baselines, process.execPath);
  const run = commandRuns(evidence, COMMAND.ledgerPublished).at(-1);
  const json = JSON.stringify(patch);
  const written = readParts(evidence, PART_BASE.publishPatch, PUBLISH_PATCH_FILE);
  const wroteAt = written.state === "read" ? written.at : -1;
  const readsAt = Math.max(...comments.refs.map((r) => at(evidence, r)));
  const current = written.state === "read" && written.value === json && wroteAt > readsAt;
  // The write recorded is the one recomputed: the same patch file, sections and baselines (`ledger-cas`, design-pr-review-split §5.2).
  const same = run !== undefined && run.command.argv.length === command.argv.length && run.command.argv.every((a, k) => a === command.argv[k]);
  if (current && run !== undefined && succeeded(run.command) && at(evidence, run.record.ref) > wroteAt && same) return { state: "done", posted, patch };
  return { state: "ledger", posted, patch, command, parts: partCommands(PART_BASE.publishPatch, PUBLISH_PATCH_FILE, json), ...(run !== undefined && current && same && at(evidence, run.record.ref) > wroteAt ? { run } : {}) };
}

// ---- the ledger ----

/** The head a design section records of a post: round 1's outcome on it, and the review id when round 1 posted it. Prints `SAME` when nothing changes. */
const MERGE_DESIGN = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{
const v=JSON.parse(s);const before=JSON.stringify(v);const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const heads=Array.isArray(v.heads)?v.heads:[];const h=heads.find((x)=>x.sha===p.head);
if(h){h.round1=p.round===1?"items":"clean";h.open=p.round1Open;if(p.round1Skipped)h.note="${SKIPPED_NOTE}";if(p.round===1){h.reviewId=p.reviewId;if(p.url)h.reviewUrl=p.url}}
const gh=(it)=>({head:p.head,reviewId:p.reviewId,commentId:it.commentId,inline:it.inline});
const items=Array.isArray(v.items)?v.items:[];const qa=Array.isArray(v.qa)?v.qa:[];
const note=(f,status,extra)=>{const keep=(Array.isArray(f.history)?f.history:[]).filter((x)=>x.head!==p.head);f.history=keep.concat([Object.assign({head:p.head,status:status},extra||{})])};
const mine=p.items.filter((it)=>it.origin==="round1");
for(const it of mine){
const fields=Object.assign({origin:it.origin,path:it.path,line:it.line,text:it.text},it.covers?{covers:it.covers}:{},it.endLine?{endLine:it.endLine}:{},it.body?{body:it.body}:{},it.meta||{});
let f=items.find((x)=>x.id===it.id);
if(f)Object.assign(f,fields);else{f=Object.assign({head:p.head,id:it.id},fields);items.push(f)}
f.state="open";delete f.reason;f.github=gh(it);note(f,"open",it.repost?{reposted:true}:{});
const q=qa.find((x)=>x.id===it.id);if(q){q.state="open";q.github=gh(it)}
}
for(const pr of (p.priors||[]).filter((x)=>x.origin==="round1")){
const f=items.find((x)=>x.id===pr.id);if(!f)continue;
if(pr.status==="fixed"){f.state="fixed";f.fixedIn=p.head;note(f,"fixed",{reason:pr.reason})}
else if(!mine.some((it)=>it.id===pr.id)){note(f,"open",{reason:pr.reason,carried:pr.carried});if(pr.covers)f.covers=pr.covers;else delete f.covers}
const q=qa.find((x)=>x.id===pr.id);if(q&&pr.status==="fixed")q.state="fixed";
}
v.heads=heads;v.items=items;v.qa=qa;const out=JSON.stringify(v);process.stdout.write(out===before?"SAME":out)})`;

/** The review section's record of a round-2 post: this head, its findings and what became of the earlier ones. Prints `SAME` when nothing changes. */
const MERGE_REVIEW = String.raw`let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{
const v=JSON.parse(s);const before=JSON.stringify(v);const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
if(!v.schema)v.schema="${REVIEW_SCHEMA}";
const heads=Array.isArray(v.heads)?v.heads:[];
const e=Object.assign({sha:p.head,base:p.base,context:p.round1Skipped?{source:"prelude"}:{source:"design-review",head:p.head},round1:p.round1Skipped?null:{head:p.head,open:p.round1Open},reviewId:p.reviewId},p.url?{reviewUrl:p.url}:{},{verdict:p.verdict,open:p.open,leads:{given:0,raised:0}});
const i=heads.findIndex((x)=>x.sha===p.head);if(i>=0)heads[i]=e;else heads.push(e);
const gh=(it)=>({head:p.head,reviewId:p.reviewId,commentId:it.commentId,inline:it.inline});
const findings=Array.isArray(v.findings)?v.findings:[];
const note=(f,status,extra)=>{const keep=(Array.isArray(f.history)?f.history:[]).filter((x)=>x.head!==p.head);f.history=keep.concat([Object.assign({head:p.head,status:status},extra||{})])};
const mine=p.items.filter((it)=>it.origin==="round2");
for(const it of mine){
const fields=Object.assign({origin:it.origin,path:it.path,line:it.line,text:it.text},it.endLine?{endLine:it.endLine}:{},it.body?{body:it.body}:{},it.meta||{});
let f=findings.find((x)=>x.id===it.id);
if(f){if(it.meta){delete f.anchorText;delete f.patchId;delete f.hunk;delete f.outdated}Object.assign(f,fields)}else{f=Object.assign({head:p.head,id:it.id},fields);findings.push(f)}
f.state="open";f.github=gh(it);note(f,"open",it.repost?{reposted:true}:{});
}
for(const pr of (p.priors||[]).filter((x)=>x.origin==="round2")){
const f=findings.find((x)=>x.id===pr.id);if(!f)continue;
if(pr.status==="fixed"){f.state="fixed";f.fixedIn=p.head;note(f,"fixed",{reason:pr.reason})}
else if(!mine.some((it)=>it.id===pr.id)){note(f,"open",{reason:pr.reason,carried:pr.carried});if(pr.moved){delete f.anchorText;delete f.patchId;delete f.hunk;Object.assign(f,{path:pr.moved.path,line:pr.moved.line,endLine:pr.moved.endLine},pr.moved.meta)}if(pr.outdated===true)f.outdated=true;else if(pr.outdated===false)delete f.outdated}
}
for(const c of p.closed||[]){if(findings.some((x)=>x.id===c.id))continue;findings.push(Object.assign({head:p.head,id:c.id,origin:"round2",path:c.path,line:c.line,endLine:c.endLine,side:c.side,text:c.text,state:"withdrawn",history:[{head:p.head,status:"withdrawn"}]},c.meta||{}))}
v.heads=heads;v.findings=findings;const out=JSON.stringify(v);process.stdout.write(out===before?"SAME":out)})`;

/**
 * The write of the published review (design-pr-review-split §5.2): each section the post records (`$secs`) is merged from the ref's
 * current value; a section the merge leaves unchanged already holds this review and is skipped, any other must be exactly its
 * baseline (`$bd`, `$br`), and the sections it does not write are carried from the current value. A section the ledger does not
 * have yet starts empty, with the section's `ledger.md` (`$rmd`). A lost `update-ref` race starts again, at most three times.
 */
const PUBLISHED_WRITE =
  String.raw`set -eu; ref="$1"; msg="$2"; patch="$3"; node="$4"; secs="$5"; bd="$6"; br="$7"; md="$8"; mr="$9"; shift 9; rmd="$1"
` +
  SECTION_PRELUDE +
  String.raw`while :; do
cur=$(g rev-parse --verify "$ref^{commit}")
if ! v2 "$cur"; then echo "ledger moved: $cur is not a ${LEDGER_V2} ledger" >&2; exit ${LEDGER_MOVED}; fi
root=$(g ls-tree "$cur"); changed=""
for s in $secs; do
if [ "$s" = design ]; then want="$bd"; code="$md"; else want="$br"; code="$mr"; fi
have=$(g rev-parse --verify --quiet "$cur:$s" || echo absent)
out=$({ if [ "$have" = absent ]; then printf '{}'; else g cat-file blob "$cur:$s/ledger.json"; fi; } | "$node" -e "$code" "$patch")
if [ "$out" = SAME ]; then continue; fi
if [ "$have" != "$want" ]; then echo "ledger moved: its $s section is $have, not the baseline $want" >&2; exit ${LEDGER_MOVED}; fi
a=$(printf '%s' "$out" | g hash-object -w --stdin)
if [ "$have" = absent ]; then b=$(printf '%s' "$rmd" | g hash-object -w --stdin); sub=$(printf '100644 blob %s\tledger.json\n100644 blob %s\tledger.md\n' "$a" "$b" | g mktree)
else sub=$({ g ls-tree "$have" | grep -v "$tab"'ledger.json$' || true; printf '100644 blob %s\tledger.json\n' "$a"; } | g mktree); fi
root=$({ printf '%s\n' "$root" | grep -v -e "$tab$s\$" -e '^$' || true; printf '040000 tree %s\t%s\n' "$sub" "$s"; })
changed="$changed $s"
done
if [ -z "$changed" ]; then echo "already recorded"; exit 0; fi
tree=$(printf '%s\n' "$root" | g mktree)
new=$(g commit-tree "$tree" -p "$cur" -m "$msg")
if g update-ref "$ref" "$new" "$cur" 2>/dev/null; then ` +
  SECTION_RECORD +
  String.raw`; exit 0; fi
try=$((try + 1)); if [ "$try" -gt 3 ]; then echo "ledger moved: the compare-and-swap lost $try races" >&2; exit ${LEDGER_MOVED}; fi
done`;

/** The sections a post records: round 1's is the design review's; round 2's records round 1's outcome on the head too. */
export const publishedSections = (round: 1 | 2): Section[] => (round === 1 ? ["design"] : ["design", "review"]);

/**
 * Records the published review in the ledger: on the design section, round 1's outcome on the head (and a round-1 post's review id)
 * and the `github` entry (review and comment ids) of each round-1 item posted; on the review section, for a round-2 post, the head
 * with its review id, verdict and context, and its findings. Each section is advanced from its baseline: the design section from this
 * run's Answers write, the review section from what the ledger read saw (design-pr-review-split §5.2). A review the ledger already
 * holds is a no-op. `node` is the Node binary to run.
 */
export function ledgerPublishedCommand(pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">, patch: LedgerPatch, baselines: Record<Section, string>, node = "node"): EnvironmentCommand {
  return {
    id: COMMAND.ledgerPublished,
    argv: ["sh", "-c", PUBLISHED_WRITE, COMMAND.ledgerPublished, ledgerRef(pr.owner, pr.repo, pr.number), `pr-review ${pr.owner}/${pr.repo}#${pr.number} at ${pr.head.slice(0, 12)}: published review ${patch.reviewId}`, PUBLISH_PATCH_FILE, node, publishedSections(patch.round).join(" "), baselines.design, baselines.review, MERGE_DESIGN, MERGE_REVIEW, reviewMarkdown(pr)],
  };
}

/**
 * The baselines the published review's write swaps from (design-pr-review-split §5.2): the design section this run's latest accepted
 * Answers write produced, as its record names it, and the review section as the latest ledger read saw it (a v1 ledger's migrated one).
 */
export function publishBaselines(evidence: readonly EvidenceRecord[], pr: Pick<PullRequest, "owner" | "repo" | "number" | "head">): Record<Section, string> | { problem: string } {
  const lw = commandRuns(evidence, COMMAND.ledgerWrite).filter((r) => succeeded(r.command)).at(-1);
  if (lw === undefined) return { problem: "the ledger has not been advanced with this head's report and Q&A" };
  const design = parseSectionRecord(reportText(lw).text)?.sections.design;
  if (design === undefined) return { problem: "the ledger write's record does not name the design section it wrote" };
  const read = ledgerRead(evidence);
  if (read === undefined) return { problem: "the ledger value Fetch read is not in the evidence" };
  const review = readBaselines(read.ledger, priorState(evidence, oldValue(read.ledger)), pr)?.review;
  if (review === undefined) return { problem: "the prior ledger's sections have not been read" };
  return { design, review };
}

// ---- what the stage posts, from the records ----

export type PublishPlan = { state: "ready"; plan: ReviewPlan; round1: Round1Record } | { state: "pending"; reason: string } | { state: "failed"; reason: string; refs: string[] };

/** Whether the thread that holds comment `commentId` is outdated on GitHub (the lines it was left on changed). */
function threadOutdated(threads: readonly unknown[], commentId: number | null | undefined): boolean {
  if (commentId === undefined || commentId === null) return false;
  return threads.some((t) => isObject(t) && t.isOutdated === true && Array.isArray(t.comments) && t.comments.some((c) => isObject(c) && c.id === commentId));
}

/**
 * What became of each item an earlier head posted: round 1's from the recorded round 1 (fixed, or still an issue), round 2's from the
 * aspects' records (judged by the sweep, settled, or carried when round 2 did not run on this head). An item still open is posted again
 * only when its old thread is outdated on GitHub or its anchor was not found again on this head.
 */
export function priorLines(registry: PriorRegistry, pull: Pick<PullRequest, "owner" | "repo" | "number">, round1: Round1Record, records: readonly AspectRecord[] | undefined, files: readonly PullFile[], threads: readonly unknown[]): PriorLine[] {
  const out: PriorLine[] = [];
  const idKey = (id: string): number => Number(id.slice(1)) || 0;
  for (const r of round1.prior ?? []) {
    const item = registry.items.find((x) => x.id === r.id);
    if (item === undefined) continue;
    const link = commentLink(pull, item);
    const covered = round1.issues.find((x) => x.id === r.id)?.covered;
    out.push({ id: r.id, origin: "round1", status: r.status, reason: r.reason, ...(covered !== undefined ? { covered } : {}), carried: r.status === "open" && r.reason.startsWith("not re-checked"), ...(link !== undefined ? { link } : {}), repost: r.status === "open" && !r.reason.startsWith("not re-checked") && threadOutdated(threads, item.commentId), item });
  }
  const outcomes = new Map((records ?? []).flatMap((r) => r.prior ?? []).map((o) => [o.id, o] as const));
  for (const item of registry.items.filter((x) => x.origin === "round2" && x.status === "open")) {
    const o = outcomes.get(item.id);
    const link = commentLink(pull, item);
    const base = { id: item.id, origin: "round2" as const, ...(link !== undefined ? { link } : {}), item };
    if (o === undefined) {
      out.push({ ...base, status: "open", reason: "not re-checked on this head: round 1 has open issues, so round 2 did not run", carried: true, repost: false });
      continue;
    }
    // Posted again only at a place found again on this head: one whose anchor was not found is listed in the body, with its stored anchor left as it was.
    const repost = o.status === "open" && o.how !== "carried" && !o.outdated && threadOutdated(threads, item.commentId);
    const file = files.find((f) => f.path === o.path);
    const place = { path: o.path, line: o.line, endLine: o.endLine, side: o.side, anchored: anchored(file, o.side, o.line, o.endLine) };
    // Its anchor is recomputed against this head's patch and its own range, so the next head re-anchors from where it is now and not from where it was
    // (an item whose anchor was not found again, and is not posted again, keeps the earlier head's coordinates, which agree with each other).
    const info = o.status === "open" && o.how !== "carried" && !o.outdated ? anchorInfo(file, o.side, o.line) : {};
    const { anchorText: _a, patchId: _p, hunk: _h, ...rest } = metaOf(item);
    const moved = info.patchId !== undefined ? { path: o.path, line: o.line, endLine: o.endLine, meta: { ...rest, ...info, side: o.side, endLine: o.endLine } } : undefined;
    out.push({ ...base, status: o.status, reason: o.reason, carried: o.how === "carried", repost, ...(o.status === "open" && o.how !== "carried" ? { outdated: o.outdated } : {}), ...(repost ? { place } : {}), ...(moved !== undefined ? { moved } : {}) });
  }
  return out.sort((a, b) => (a.origin === b.origin ? idKey(a.id) - idKey(b.id) : a.origin === "round1" ? -1 : 1));
}

/** The review the run posts, recomputed from the recorded round 1 and (when round 1 found no issue) the draft the Draft stage composed. */
export function publishPlan(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest, base: string | undefined): PublishPlan {
  const round1 = recordedRound1(evidence);
  if (round1.state === "none") return { state: "pending", reason: "round 1 was not recorded" };
  if (round1.state === "failed") return round1;
  const nonce = viewerOf(evidence)?.nonce ?? "pending";
  const registry = registryFromEvidence(evidence);
  const files = analysis.snapshot.files;
  if (round1.value.issues.length > 0) {
    const prior = priorLines(registry, pr, round1.value, undefined, files, analysis.snapshot.threads);
    return { state: "ready", round1: round1.value, plan: planReview({ pull: pr, head: pr.head, nonce, round1: round1.value, prior }) };
  }
  const w = draftWrites(evidence, analysis, pr, base);
  if (w.state === "pending") return { state: "pending", reason: `the draft cannot be composed: ${w.reason}` };
  if (w.state === "failed") return w;
  const records: AspectRecord[] = [];
  for (const a of ASPECTS) {
    const r = recordedAspect(evidence, a);
    if (r.state === "read") records.push(r.value);
  }
  const all = findingsOf(records);
  // A posted finding's place is its draft entry's range (which can cover several findings): the anchor is read at its first line and the range is recorded whole.
  const entries = new Map(w.writes.draft.comments.filter((c) => c.kind === "finding").map((c) => [c.id, c] as const));
  const meta = new Map(
    all
      .filter((f) => f.state === "confirmed" || f.state === "disputed")
      .map((f) => {
        const e = entries.get(f.id);
        return [f.id, findingMeta(e === undefined ? f : { ...f, path: e.path, side: e.side, startLine: e.startLine ?? e.line, endLine: e.line }, files)] as const;
      }),
  );
  const closed = all.filter((f) => f.state === "dismissed").map((f): ClosedFinding => ({ id: f.id, path: f.path, line: f.startLine, endLine: f.endLine, side: f.side, text: clipKeep(neutralize(f.content), MAX_ITEM_TEXT), meta: findingMeta(f, files) }));
  const prior = priorLines(registry, pr, round1.value, records, files, analysis.snapshot.threads);
  return { state: "ready", round1: round1.value, plan: planReview({ pull: pr, head: pr.head, nonce, round1: round1.value, draft: w.writes.draft, prior, meta, closed }) };
}
