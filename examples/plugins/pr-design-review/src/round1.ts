// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The gate of the design review (design-pr-review-split §3.6). Round 1's open items are computed by plugin code from
 * `necessity.json` and `qa.json`, with no model and no human: N1's conclusion when it is not `necessary` (a supported broken
 * principle included), every question whose answer needs the author or is only partially answered, and every `existing-feature`
 * answer that names an equivalent outside the code the pull request changes (answers citing one outside equivalent merge into one
 * item with `covers`). A missing test is not a round-1 item any more: the kinds are `necessity`, `needs-author`, `partial` and
 * `existing`. Earlier open items are judged against this head by their stable key (§3.5). The computation is a pure function over
 * the two artifacts, recorded once as `round1.json`; the validator recomputes it.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import type { Analysis } from "./kit/analysis.js";
import { citationLinks, composeParts, fitParts, proposalText, type GithubPin, type ItemParts, type ProposalLike } from "./kit/answertext.js";
import { pinnedBase } from "./kit/commands.js";
import { clip } from "./kit/escape.js";
import { recordedNecessityJson, recordedQa, recordedRecord, recordedReport, type Written } from "./kit/parts.js";
import { parsePatch, sideLines } from "./kit/patch.js";
import type { PullRequest } from "./kit/request.js";
import type { PullFile } from "./kit/snapshot.js";
import { coarsestChanges, highLevelId, type ViewItem } from "./kit/reportview.js";
import type { Cite } from "./kit/report.js";
import { effectiveConclusion, brokenNote, parseNecessityRecord, NECESSITY_ID } from "./necessity.js";
import { registryFromEvidence, type PriorItem } from "./prior.js";
import { FEATURE_TYPE } from "./questions.js";

export const ROUND1_SCHEMA = "pr-design-review-round1-v1";
export const ROUND1_RECORD_ID = "round1";
export const ROUND1_DIR = "round1";

export type Round1Kind = "necessity" | "needs-author" | "partial" | "existing";

/** What each kind of item says to the author, the first words of its comment. */
export const ROUND1_LABEL: Record<Round1Kind, string> = {
  necessity: "necessity",
  "needs-author": "needs the author",
  partial: "partially answered",
  existing: "the codebase or a declared library already has this",
};

export interface Round1Issue {
  /** `N1` or the question's id (`Q3`): the id the posted comment's marker carries. */
  id: string;
  /** The stable key of its question (design §9.4), which ties the same item on a later head to this id. */
  key: string;
  kinds: Round1Kind[];
  /** The Q&A status of the answer behind it (N1's follows its conclusion). */
  status: string;
  /** The comment text, without its marker. */
  body: string;
  /** The body as parts (the answer whole, its citations), so that publishing shortens by them when the review body has no room. */
  parts?: ItemParts;
  path?: string;
  line?: number;
  /** The place lies inside a hunk of the file's patch at the head; otherwise the item goes in the review body. */
  anchored: boolean;
  /** The ids of other questions this item stands for, because they cite the same equivalent outside the change. */
  covers?: string[];
  /** What each of those questions answered: its subject, its own outside equivalents and a line of its answer. */
  covered?: Round1Covered[];
}

export interface Round1Covered {
  id: string;
  symbol: string;
  equivalents: string[];
  excerpt: string;
}

/** An `existing-feature` answer set aside, not an item: it found nothing to reuse, or every equivalent it names lies in code the pull request changes. */
export interface Round1Noted {
  id: string;
  key: string;
  note: string;
}

/** What this head's round 1 says of an item an earlier head's round 1 left open, judged by its stable key (§3.5). */
export interface Round1Prior {
  id: string;
  key: string;
  /** `fixed`: the question with its key is no longer an open item on this head; `open`: it still is. */
  status: "fixed" | "open";
  reason: string;
}

export interface Round1Record {
  schema: typeof ROUND1_SCHEMA;
  head: string;
  /** N1's conclusion as the Q&A shows it. */
  necessity: string;
  /** Every item open on this head: the earlier ones that still stand (under this head's id for their key) and the new ones. */
  issues: Round1Issue[];
  /** The items earlier heads left open, each judged on this head; absent for a run with none. */
  prior?: Round1Prior[];
  /** `existing-feature` answers that are not items. */
  noted?: Round1Noted[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Paths into the review's own files are not shown to the author. */
export const scrub = (text: string): string => text.replace(/\.graphloom\/[^\s)`'"<>:]*/g, "[a review file]");

/**
 * A changed file as the gate reads it: its paths decide what the change touches (an `existing` item's equivalent outside it), its
 * patch where an item anchors. Without a patch nothing in it anchors, which is all the briefing's count needs.
 */
export type GateFile = Pick<PullFile, "path" | "previousPath"> & Partial<Pick<PullFile, "patch" | "parsed">>;

/** Whether every line of the range lies in a hunk of the file's patch on the side. */
export function anchored(file: GateFile | undefined, side: "RIGHT" | "LEFT", start: number, end: number): boolean {
  if (file === undefined || file.patch === undefined || file.patch === null) return false;
  const lines = sideLines(file.parsed ?? parsePatch(file.patch), side === "RIGHT" ? "head" : "base");
  for (let n = start; n <= end; n += 1) if (!lines.has(n)) return false;
  return true;
}

/** The report's change items and high-level changes by id, with the first head cite of each, which anchors a question about it. */
export interface ItemCites {
  [item: string]: { path: string; start: number; end: number } | undefined;
}

/**
 * The first head cite of every report item and of every high-level change (the briefing's `whatsNew`, or the coarsest change
 * items standing in for them), from `report.json` as written: what anchors an item on the diff.
 */
export function itemCitesOf(reportJson: string): ItemCites {
  let v: unknown;
  try {
    v = JSON.parse(reportJson);
  } catch {
    return {};
  }
  if (!isObj(v)) return {};
  const out: ItemCites = {};
  const first = (cites: readonly Cite[]): { path: string; start: number; end: number } | undefined => {
    const c = cites.find((x) => x.side === "head" && x.start > 0);
    return c === undefined ? undefined : { path: c.path, start: c.start, end: c.end };
  };
  const items: ViewItem[] = [];
  for (const s of Array.isArray(v.sections) ? v.sections.filter(isObj) : []) {
    for (const i of Array.isArray(s.items) ? s.items.filter(isObj) : []) {
      if (typeof i.id !== "string" || !Array.isArray(i.cites)) continue;
      items.push({ id: i.id, section: str(s.id), text: str(i.text), cites: i.cites as Cite[], facts: [] });
      const c = first(i.cites as Cite[]);
      if (c !== undefined) out[i.id] = c;
    }
  }
  const whatsNew = isObj(v.briefing) && Array.isArray(v.briefing.whatsNew) ? v.briefing.whatsNew : [];
  const changes: ViewItem[] = whatsNew.flatMap((w, n) => (isObj(w) && Array.isArray(w.cites) ? [{ id: highLevelId(n + 1), section: "highlevel", text: str(w.text), cites: w.cites as Cite[], facts: [] }] : []));
  for (const c of changes.length > 0 ? changes : coarsestChanges(items)) {
    const at = first(c.cites);
    if (at !== undefined) out[c.id] = at;
  }
  return out;
}

interface QaQuestion {
  id: string;
  type: string;
  item: string;
  stable: string;
  text: string;
  answer?: { answer: string; status: string; none_found: boolean; reusable?: boolean; citations: Array<{ path: string; start: number; end: number; tree: string }>; inventory: Array<{ name: string; version: string }>; proposal?: ProposalLike };
}

function qaOf(json: string): { questions: QaQuestion[] } | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isObj(v) || !Array.isArray(v.questions)) return undefined;
  const questions = v.questions.filter(isObj).map((q): QaQuestion => {
    const a = isObj(q.answer) ? q.answer : undefined;
    return {
      id: str(q.id),
      type: str(q.type),
      item: str(q.item),
      stable: str(q.stable),
      text: str(q.text),
      ...(a !== undefined && typeof a.status === "string"
        ? { answer: { answer: str(a.answer), status: a.status, none_found: a.none_found === true, ...(typeof a.reusable === "boolean" ? { reusable: a.reusable } : {}), citations: (Array.isArray(a.citations) ? a.citations.filter(isObj) : []).map((c) => ({ path: str(c.path), start: Number(c.start) || 0, end: Number(c.end) || 0, tree: str(c.tree) })), inventory: (Array.isArray(a.inventory) ? a.inventory.filter(isObj) : []).map((d) => ({ name: str(d.name), version: str(d.version) })), ...(isObj(a.proposal) ? { proposal: a.proposal as ProposalLike } : {}) } }
        : {}),
    };
  });
  return { questions };
}

const NOTED_REASON = "the equivalent it names is the code this pull request changes";
const NOTED_NONE = "the answer found no existing feature, mechanism or library the change could use";

/**
 * The cited equivalents that lie outside the change, as `path:start` keys: a library's source, or a base or head file the
 * pull request does not add, modify, rename or delete. Deterministic: no model judges it.
 */
function outsideEquivalents(citations: ReadonlyArray<{ path: string; start: number; tree: string }>, changed: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const c of citations) {
    if (c.path === "") continue;
    if (c.tree === "dependency") out.add(`dependency:${c.path}:${c.start}`);
    else if (!changed.has(c.path)) out.add(`${c.path}:${c.start}`);
  }
  return [...out];
}

/**
 * The longest item text the review posts (publish shortens beyond it), so a merged comment is built to fit it, far under the
 * 65,536 characters GitHub accepts in one comment.
 */
export const MAX_ITEM_TEXT = 12_000;
const BODY_ROOM = MAX_ITEM_TEXT - 50;

const equivText = (c: Round1Covered, n: number): string => c.equivalents.slice(0, n).map((e) => `\`${e.replace(/^dependency:/, "")}\``).join(", ");

/**
 * The host's body followed by each covered question as the host is: its question, its whole answer and its citation links. Only
 * when that does not fit is each one shortened by the rule publication uses (`fitParts`); when even that leaves too little of
 * each, one compact line per question, then ids only. The returned `covered` is exactly what the body names.
 */
const MIN_SECTION = 500;
function coveredBody(hostBody: string, covered: ReadonlyArray<{ covered: Round1Covered; parts: ItemParts }>): { body: string; covered: Round1Covered[] } {
  const list = covered.map((c) => c.covered);
  const head = (n: number, lead: string): string => `${hostBody}\n\nThe same item applies to ${n} more${lead}:\n\n`;
  const section = (c: { covered: Round1Covered; parts: ItemParts }, limit: number): string => {
    const parts = { ...c.parts, head: `**${c.covered.symbol} (${c.covered.id})**. ${c.parts.head.replace(/^\*\*[^*]*\*\* \([^)]*\)\. /, "")}` };
    return limit === Infinity ? composeParts(parts) : fitParts(parts, limit);
  };
  const whole = covered.map((c) => section(c, Infinity));
  const lead = ", each with its own question and answer";
  if (head(list.length, lead).length + whole.join("\n\n").length <= BODY_ROOM) return { body: head(list.length, lead) + whole.join("\n\n"), covered: list };
  const share = Math.floor((BODY_ROOM - head(list.length, lead).length - 2 * (list.length - 1)) / list.length);
  if (share >= MIN_SECTION) {
    const shortened = covered.map((c) => section(c, share));
    if (head(list.length, lead).length + shortened.join("\n\n").length <= BODY_ROOM) return { body: head(list.length, lead) + shortened.join("\n\n"), covered: list };
  }
  const compactLead = " (each answer is in the report's Q&A)";
  const compact = (c: Round1Covered, sym: number): string => `- ${clip(c.symbol, sym)} (${c.id}): ${equivText(c, 1)}`;
  for (const sym of [60, 24]) {
    const lines = list.map((c) => compact(c, sym));
    if (head(list.length, compactLead).length + lines.join("\n").length <= BODY_ROOM) return { body: head(list.length, compactLead).replace(/:\n\n$/, ":\n") + lines.join("\n"), covered: list };
  }
  const kept: Round1Covered[] = [];
  const ids = (l: readonly Round1Covered[]): string => `${hostBody}\n\nThe same item also applies to: ${l.map((c) => c.id).join(", ")}.`;
  for (const c of list) {
    if (ids([...kept, c]).length > BODY_ROOM) break;
    kept.push(c);
  }
  return kept.length > 0 ? { body: ids(kept), covered: kept } : { body: hostBody, covered: [] };
}

const idOrder = (a: string, b: string): number => (Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))) || a.localeCompare(b);

/** Several `existing-feature` answers citing the same outside equivalent are one item that lists them; only items that are solely `existing` merge. */
function mergeSharedEquivalents(issues: Round1Issue[], outsideOf: ReadonlyMap<string, string[]>, qa: { questions: QaQuestion[] }): void {
  const groups: Array<{ keys: Set<string>; members: Round1Issue[] }> = [];
  for (const x of issues) {
    const keys = outsideOf.get(x.id);
    if (keys === undefined || x.kinds.length !== 1 || x.kinds[0] !== "existing") continue;
    // Join every group this one shares an equivalent with (a bridge joins two), so grouping does not depend on order.
    const hit = groups.filter((y) => keys.some((k) => y.keys.has(k)));
    const g = hit[0] ?? { keys: new Set<string>(), members: [] };
    if (hit.length === 0) groups.push(g);
    for (const o of hit.slice(1)) {
      o.keys.forEach((k) => g.keys.add(k));
      g.members.push(...o.members);
      groups.splice(groups.indexOf(o), 1);
    }
    keys.forEach((k) => g.keys.add(k));
    g.members.push(x);
  }
  const nameOf = (x: Round1Issue): string => {
    const item = qa.questions.find((z) => z.id === x.id)?.item;
    return item !== undefined && item !== "" ? `the change ${item}` : x.id;
  };
  const merged = new Set<Round1Issue>();
  for (const g of groups) {
    const [host, ...rest] = [...g.members].sort((m, n) => idOrder(m.id, n.id));
    if (host === undefined || rest.length === 0) continue;
    const all = rest.map((x): { issue: Round1Issue; covered: Round1Covered; parts: ItemParts } => {
      const q = qa.questions.find((z) => z.id === x.id);
      return { issue: x, covered: { id: x.id, symbol: nameOf(x), equivalents: (outsideOf.get(x.id) ?? []).slice(0, 3), excerpt: oneLine(q?.answer?.answer ?? "") }, parts: x.parts ?? { id: x.id, head: x.body, label: "Answer", answer: "", cites: [], proposal: "" } };
    });
    const fit = coveredBody(host.body, all);
    const tail = fit.body.slice(host.body.length).trim();
    if (host.parts !== undefined && tail !== "") host.parts = { ...host.parts, tail, tailIds: fit.covered.map((c) => c.id) };
    host.body = fit.body;
    host.covered = fit.covered;
    host.covers = fit.covered.map((c) => c.id);
    const kept = new Set(host.covers);
    all.filter((c) => kept.has(c.issue.id)).forEach((c) => merged.add(c.issue));
  }
  if (merged.size > 0) issues.splice(0, issues.length, ...issues.filter((x) => !merged.has(x)));
}

export interface Round1Input {
  head: string;
  /** `necessity.json` as written, when the run has one. */
  necessity: string | undefined;
  /** `qa.json` as written. */
  qa: string;
  files: readonly GateFile[];
  /** The first head cite of each report item and high-level change, which anchors a question about it when its answer cites no line of the diff. */
  itemCites: ItemCites;
  /** The round-1 items earlier heads left open, as the ledger holds them (empty for a first run). */
  prior?: readonly PriorItem[];
  /** The pinned commits a citation is linked at (the pull request and its head and base); without it citations are named, not linked. */
  github?: GithubPin;
}

/**
 * Where an answer's evidence lies in the diff: the first line, in the answer's citation order, of the first head citation that has a
 * line inside a hunk of its file's patch at the head. Undefined when no citation reaches into the diff (a base, dependency or
 * unchanged-line citation does not). Deterministic: the order is the answer's own, no model judges it.
 */
export function evidenceAnchor(citations: ReadonlyArray<{ path: string; start: number; end: number; tree: string }>, files: readonly GateFile[]): { path: string; line: number } | undefined {
  for (const c of citations) {
    if (c.tree !== "head" || c.path === "" || c.start < 1) continue;
    const file = files.find((f) => f.path === c.path);
    for (let n = c.start; n <= Math.max(c.start, c.end); n += 1) if (anchored(file, "RIGHT", n, n)) return { path: c.path, line: n };
  }
  return undefined;
}

/**
 * The open items of round 1 from the artifacts, in question order (N1 first). Undefined when `qa.json` is not a Q&A file. An answer
 * can match several kinds at once; it is one item with all of them, and its status is the answer's own. A question's item anchors
 * where its answer's evidence lies in the diff (`evidenceAnchor`), else at the first head cite of the change it is about, which puts
 * it in the review body when that cite is outside the diff.
 */
export function round1Record(i: Round1Input): Round1Record | undefined {
  const qa = qaOf(i.qa);
  if (qa === undefined) return undefined;
  const record = i.necessity !== undefined ? parseNecessityRecord(i.necessity) : undefined;
  const conclusion = record !== undefined ? effectiveConclusion(record.final) : "needs author";
  const issues: Round1Issue[] = [];
  const place = (path: string, line: number): { path: string; line: number; anchored: boolean } => ({ path, line, anchored: anchored(i.files.find((f) => f.path === path), "RIGHT", line, line) });
  if (conclusion !== "necessary") {
    const n = record?.final.necessity;
    const changed = n?.design.changed.find((c) => c.tree === "head");
    const note = record !== undefined ? brokenNote(record.final) : "";
    issues.push({
      id: NECESSITY_ID,
      key: "necessity|N1",
      kinds: ["necessity"],
      status: record?.final.status ?? "needs author",
      body: scrub([`**Necessity: ${conclusion}.** ${clip(oneLine(n?.rationale ?? "N1 has no recorded answer."), 700)}`, ...(note !== "" ? [note] : []), `Please say why this change is needed, or what in the system's design it follows.`].join("\n\n")),
      ...(changed !== undefined ? place(changed.path, changed.start) : { anchored: false }),
    });
  }
  const changedPaths = new Set(i.files.flatMap((f) => (f.previousPath !== null ? [f.path, f.previousPath] : [f.path])));
  const noted: Round1Noted[] = [];
  const outsideOf = new Map<string, string[]>();
  for (const q of qa.questions) {
    if (q.type === "necessity" || q.answer === undefined) continue;
    const a = q.answer;
    const kinds: Round1Kind[] = [];
    if (a.status === "needs author") kinds.push("needs-author");
    if (a.status === "partially answered") kinds.push("partial");
    let outside: string[] = [];
    if (q.type === FEATURE_TYPE && !a.none_found && a.reusable === false) {
      // The answer says it found nothing the change could use (what it cites is related code), so it is noted, never an item.
      noted.push({ id: q.id, key: q.stable, note: NOTED_NONE });
    } else if (q.type === FEATURE_TYPE && !a.none_found) {
      outside = outsideEquivalents(a.citations, changedPaths);
      // No citation at all cannot show the equivalent is the changed code, so it stays an item.
      if (outside.length > 0 || a.citations.every((c) => c.path === "")) kinds.push("existing");
      else noted.push({ id: q.id, key: q.stable, note: NOTED_REASON });
    }
    if (kinds.length === 0) continue;
    const evidence = evidenceAnchor(a.citations, i.files);
    const cite = i.itemCites[q.item];
    if (outside.length > 0) outsideOf.set(q.id, outside);
    const parts: ItemParts = {
      id: q.id,
      head: scrub(`**${kinds.map((k) => ROUND1_LABEL[k]).join("; ")}** (${q.id}). ${oneLine(q.text)}`),
      label: a.status === "needs author" ? "What was checked" : `Answer (${a.status})`,
      answer: scrub(oneLine(a.answer)),
      cites: citationLinks(a.citations, i.github, a.inventory).map(scrub),
      proposal: scrub(proposalText(a.proposal)),
    };
    issues.push({ id: q.id, key: q.stable, kinds, status: a.status, body: composeParts(parts), parts, ...(evidence !== undefined ? { ...evidence, anchored: true } : cite !== undefined ? place(cite.path, cite.start) : { anchored: false }) });
  }
  mergeSharedEquivalents(issues, outsideOf, qa);
  // Earlier open items are judged by their stable key (§3.5): open when this head has an open item with that key, or one that covers it.
  const open = (i.prior ?? []).filter((p) => p.origin === "round1" && p.status === "open");
  const askedOnlyN1 = qa.questions.every((q) => q.type === "necessity");
  const keyOf = new Map(qa.questions.map((q) => [q.id, q.stable] as const));
  const prior = open.map((p): Round1Prior => {
    const same = issues.find((x) => x.key !== "" && x.key === p.key);
    if (same !== undefined) return { id: p.id, key: p.key, status: "open", reason: "it is still an open item on this head" };
    const host = issues.find((x) => (x.covers ?? []).some((c) => c === p.id || (keyOf.get(c) ?? "") === p.key));
    if (host !== undefined) return { id: p.id, key: p.key, status: "open", reason: `it is still an open item on this head, listed with ${host.id}` };
    if (p.id !== NECESSITY_ID && askedOnlyN1) return { id: p.id, key: p.key, status: "open", reason: "not re-checked: N1 was judged unnecessary, so the other questions were skipped" };
    const q = qa.questions.find((x) => x.stable === p.key);
    return { id: p.id, key: p.key, status: "fixed", reason: p.id === NECESSITY_ID ? `N1 now concludes ${conclusion}` : q !== undefined ? `its question is now ${q.answer?.status ?? "answered"}, with no open kind` : "no question has its key on this head: its subject is no longer in the change" };
  });
  return { schema: ROUND1_SCHEMA, head: i.head, necessity: conclusion, issues, ...(open.length > 0 ? { prior } : {}), ...(noted.length > 0 ? { noted } : {}) };
}

/**
 * Round 1's open items as the gate computes them, for the briefing, which is written before the gate runs: the same pure function
 * over the same `qa.json`, `necessity.json` and changed paths, so `review.md`, `review.html` and the posted review count the same
 * items. Undefined when `qa.json` is not a Q&A file.
 */
export function openItems(i: { qa: string; necessity: string | undefined; files: readonly GateFile[] }): Round1Issue[] | undefined {
  return round1Record({ head: "", necessity: i.necessity, qa: i.qa, files: i.files.map((f) => ({ path: f.path, previousPath: f.previousPath })), itemCites: {} })?.issues;
}

/** How the briefing names round 1's open items, in `review.md` and both HTML files. */
export const OPEN_ITEMS_LABEL = "Open items for the author";
export const NO_OPEN_ITEMS = "No open item for the author.";

/** The question ids an open item stands for: its own and those it covers. */
export const itemIds = (x: Pick<Round1Issue, "id" | "covers">): string[] => [x.id, ...(x.covers ?? [])];

export const round1Json = (r: Round1Record): string => JSON.stringify(r);

export function parseRound1Record(json: string): Round1Record | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObj(v) || v.schema !== ROUND1_SCHEMA || typeof v.head !== "string" || typeof v.necessity !== "string" || !Array.isArray(v.issues)) return undefined;
    return v as unknown as Round1Record;
  } catch {
    return undefined;
  }
}

export type Recorded<T> = { state: "none" } | { state: "failed"; reason: string; refs: string[] } | { state: "read"; value: T; refs: string[] };

function decoded<T>(w: Written<string>, what: string, parse: (json: string) => T | undefined): Recorded<T> {
  if (w.state === "none") return { state: "none" };
  if (w.state === "failed") return w;
  const value = parse(w.value);
  return value === undefined ? { state: "failed", reason: `${what} is not a record of this review`, refs: w.refs } : { state: "read", value, refs: w.refs };
}

/** The round-1 record (§3.6): the open items of the report and the Q&A, as the evidence holds them. */
export const recordedRound1 = (evidence: readonly EvidenceRecord[]): Recorded<Round1Record> => decoded(recordedRecord(evidence, ROUND1_RECORD_ID, ROUND1_DIR), ROUND1_RECORD_ID, parseRound1Record);

/** The round-1 items recomputed from the recorded `necessity.json` and `qa.json` and the report's cites: what the record must hold. */
export function round1Computed(evidence: readonly EvidenceRecord[], analysis: Analysis, pr: PullRequest): { state: "ready"; record: Round1Record } | { state: "pending"; reason: string } {
  const qa = recordedQa(evidence);
  if (qa.state !== "read") return { state: "pending", reason: "qa.json was not written" };
  const report = recordedReport(evidence);
  if (report.state !== "read") return { state: "pending", reason: "report.json was not written" };
  const necessity = recordedNecessityJson(evidence);
  if (necessity.state === "failed") return { state: "pending", reason: `necessity.json does not read back: ${necessity.reason}` };
  const record = round1Record({ head: pr.head, necessity: necessity.state === "read" ? necessity.value : undefined, qa: qa.value.json, files: analysis.snapshot.files, itemCites: itemCitesOf(report.value.json), prior: registryFromEvidence(evidence).items, github: { owner: pr.owner, repo: pr.repo, head: pr.head, base: pinnedBase(evidence) } });
  return record === undefined ? { state: "pending", reason: "qa.json is not a Q&A file" } : { state: "ready", record };
}
