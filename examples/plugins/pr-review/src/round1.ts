// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Round 1 (design §9.4): the report and the Q&A, the architecture and design level. Its issues are computed by plugin code from
 * `necessity.json` and `qa.json`, with no model and no human: the conclusion of N1 when it is not `necessary`, every question
 * that needs the author or is only partially answered, every answer that found an existing equivalent, a reusable library
 * or common logic, and every missing-test question whose answer finds no covering test, even when it is fully answered. Any
 * issue blocks round 2, so the run publishes round 1 and ends; none lets the same run continue into the review layer.
 * The computation is a pure function over the two artifacts, recorded once as `round1.json`; the validator recomputes it.
 */
import { isTestPath } from "./answers.js";
import { clip } from "./escape.js";
import { citationLinks, composeParts, proposalText, type GithubPin, type ItemParts, type ProposalLike } from "./answertext.js";
import { anchored, scrub, type ItemCites } from "./draft.js";
import type { FullPack } from "./packs.js";
import { effectiveConclusion, brokenNote, parseNecessityRecord, NECESSITY_ID, ROUNDS_SKIP_REASON } from "./necessity.js";
import type { PriorItem } from "./prior.js";
import type { PullFile } from "./snapshot.js";

export const ROUND1_SCHEMA = "pr-review-round1-v1";
export const ROUND1_RECORD_ID = "round1";
export const ROUND1_DIR = "round1";

export type Round1Kind = "necessity" | "needs-author" | "partial" | "existing" | "missing-test";

/** What each kind of issue says to the author, the first words of its comment. */
export const ROUND1_LABEL: Record<Round1Kind, string> = {
  necessity: "necessity",
  "needs-author": "needs the author",
  partial: "partially answered",
  existing: "something equivalent already exists",
  "missing-test": "no covering test",
};

export interface Round1Issue {
  /** `N1` or the question's id (`Q3`): the id the posted comment's marker carries. */
  id: string;
  /** The stable key of its question (design §9.4), which ties the same issue on a later head to this id. */
  key: string;
  kinds: Round1Kind[];
  /** The Q&A status of the answer behind it (N1's follows its conclusion). */
  status: string;
  /** The comment text, without its marker. */
  body: string;
  /** The body as parts (the answer whole, its citations, its proposal), so that publishing shortens by them when the review body has no room. */
  parts?: ItemParts;
  path?: string;
  line?: number;
  /** The place lies inside a hunk of the file's patch at the head; otherwise the issue goes in the review body. */
  anchored: boolean;
  /** The ids of other questions this issue stands for, because they cite the same equivalent outside the change (design §9.4). */
  covers?: string[];
  /** What each of those questions answered: its symbol, its own outside equivalents and a line of its answer. */
  covered?: Round1Covered[];
}

export interface Round1Covered {
  id: string;
  symbol: string;
  equivalents: string[];
  excerpt: string;
}

/** An `existing-reuse-common` answer set aside, not an issue: every equivalent it names lies in code the pull request changes. */
export interface Round1Noted {
  id: string;
  key: string;
  note: string;
}

/** What this head's round 1 says of an issue an earlier head's round 1 left open (design §9.4, item 4). */
export interface Round1Prior {
  id: string;
  key: string;
  /** `fixed`: it is no longer an issue on this head; `open`: it still is, or could not be re-checked. */
  status: "fixed" | "open";
  reason: string;
}

export interface Round1Record {
  schema: typeof ROUND1_SCHEMA;
  head: string;
  /** N1's conclusion as the Q&A shows it. */
  necessity: string;
  /** Every issue open on this head: the earlier ones that still stand and the new ones. */
  issues: Round1Issue[];
  /** The issues earlier heads left open, each judged on this head; absent for a run with none. */
  prior?: Round1Prior[];
  /** Answers about an existing equivalent that are not issues because the equivalent is the code this pull request changes. */
  noted?: Round1Noted[];
  /** Why round 1 did not run (`rounds: review-only`, design §3.2): it records no issue, and earlier round-1 items are left as they were. */
  skipped?: string;
}

/** Round 1 of a `review-only` run: skipped by the operator's choice, so no issue (and round 2 runs in the same run). */
export const round1Skipped = (head: string): Round1Record => ({ schema: ROUND1_SCHEMA, head, necessity: "skipped", issues: [], skipped: ROUNDS_SKIP_REASON });

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

interface QaQuestion {
  id: string;
  type: string;
  item: string;
  stable: string;
  symbol?: string;
  functionPath?: string;
  text: string;
  answer?: { answer: string; status: string; none_found: boolean; citations: Array<{ path: string; start: number; end: number; tree: string }>; inventory: Array<{ name: string; version: string }>; proposal?: ProposalLike };
}

function qaOf(json: string): { questions: QaQuestion[]; symbols: Array<{ id: string; path: string; startLine: number; qualified: string }> } | undefined {
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
      ...(typeof q.symbol === "string" ? { symbol: q.symbol } : {}),
      ...(typeof q.functionPath === "string" ? { functionPath: q.functionPath } : {}),
      text: str(q.text),
      ...(a !== undefined && typeof a.status === "string"
        ? { answer: { answer: str(a.answer), status: a.status, none_found: a.none_found === true, citations: (Array.isArray(a.citations) ? a.citations.filter(isObj) : []).map((c) => ({ path: str(c.path), start: Number(c.start) || 0, end: Number(c.end) || 0, tree: str(c.tree) })), inventory: (Array.isArray(a.inventory) ? a.inventory.filter(isObj) : []).map((d) => ({ name: str(d.name), version: str(d.version) })), ...(isObj(a.proposal) ? { proposal: a.proposal as ProposalLike } : {}) } }
        : {}),
    };
  });
  const symbols = (Array.isArray(v.symbols) ? v.symbols.filter(isObj) : []).map((s) => ({ id: str(s.id), path: str(s.path), startLine: Number(s.startLine) || 1, qualified: str(s.qualified) }));
  return { questions, symbols };
}

const NOTED_REASON = "the equivalent it names is the code this pull request changes";

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
 * Several symbols citing the same outside equivalent are one issue that lists them. Only issues that are solely an
 * `existing` issue merge: the first of a group (in question order) carries it and `covers` the rest.
 */
/**
 * The longest item text the review posts (publish shortens beyond it), so a merged comment is built to fit it. A maximal
 * answer (4,000 characters), up to twelve citation links of about 250 characters, and a proposal of eight split functions fit
 * whole, and it stays far under the 65,536 characters GitHub accepts in one comment.
 */
export const MAX_ITEM_TEXT = 12_000;
const BODY_ROOM = MAX_ITEM_TEXT - 50;

const equivText = (c: Round1Covered, n: number): string => c.equivalents.slice(0, n).map((e) => `\`${e.replace(/^dependency:/, "")}\``).join(", ");

/**
 * The host's body with one line per covered question, built to fit the posted item's budget: each excerpt shrunk evenly,
 * then one compact line per question (id, symbol, first equivalent), then ids only. A question that still does not fit is
 * left out of the result, never clipped away silently; the returned `covered` is exactly what the body names.
 */
function coveredBody(hostBody: string, covered: readonly Round1Covered[]): { body: string; covered: Round1Covered[] } {
  const head = (n: number): string => `${hostBody}\n\nThe same issue applies to ${n} more, each with its own answer:\n`;
  const full = (c: Round1Covered, room: number): string => `- ${c.symbol} (${c.id}): ${equivText(c, 3)}${room > 0 && c.excerpt !== "" ? `: ${clip(c.excerpt, room)}` : ""}`;
  const compact = (c: Round1Covered, sym: number): string => `- ${clip(c.symbol, sym)} (${c.id}): ${equivText(c, 1)}`;
  const tries: Array<(n: number) => string[]> = [
    (n) => {
      const fixed = covered.map((c) => full(c, 0).length + 1).reduce((a, b) => a + b, 0);
      const room = Math.floor((BODY_ROOM - head(n).length - fixed) / n) - 2;
      return room >= 20 ? covered.map((c) => full(c, room)) : [];
    },
    () => covered.map((c) => compact(c, 60)),
    () => covered.map((c) => compact(c, 24)),
  ];
  for (const t of tries) {
    const lines = t(covered.length);
    if (lines.length > 0 && head(covered.length).length + lines.join("\n").length <= BODY_ROOM) return { body: head(covered.length) + lines.join("\n"), covered: [...covered] };
  }
  // Ids only, as many as fit.
  const kept: Round1Covered[] = [];
  const ids = (list: readonly Round1Covered[]): string => `${hostBody}\n\nThe same issue also applies to: ${list.map((c) => c.id).join(", ")}.`;
  for (const c of covered) {
    if (ids([...kept, c]).length > BODY_ROOM) break;
    kept.push(c);
  }
  return kept.length > 0 ? { body: ids(kept), covered: kept } : { body: hostBody, covered: [] };
}

const idOrder = (a: string, b: string): number => (Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, ""))) || a.localeCompare(b);

function mergeSharedEquivalents(issues: Round1Issue[], outsideOf: ReadonlyMap<string, string[]>, qa: { questions: QaQuestion[]; symbols: Array<{ id: string; qualified: string }> }): void {
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
    const id = qa.questions.find((z) => z.id === x.id)?.symbol;
    const q = id !== undefined ? qa.symbols.find((s) => s.id === id)?.qualified : undefined;
    return q !== undefined && q !== "" ? `\`${q}\`` : x.id;
  };
  const merged = new Set<Round1Issue>();
  for (const g of groups) {
    const [host, ...rest] = [...g.members].sort((m, n) => idOrder(m.id, n.id));
    if (host === undefined || rest.length === 0) continue;
    const all = rest.map((x): { issue: Round1Issue; covered: Round1Covered } => {
      const q = qa.questions.find((z) => z.id === x.id);
      return { issue: x, covered: { id: x.id, symbol: nameOf(x), equivalents: (outsideOf.get(x.id) ?? []).slice(0, 3), excerpt: clip(oneLine(q?.answer?.answer ?? ""), 200) } };
    });
    const fit = coveredBody(host.body, all.map((c) => c.covered));
    const tail = fit.body.slice(host.body.length).trim();
    if (host.parts !== undefined && tail !== "") host.parts = { ...host.parts, tail, tailIds: fit.covered.map((c) => c.id) };
    host.body = fit.body;
    host.covered = fit.covered;
    host.covers = fit.covered.map((c) => c.id);
    // A question whose line could not fit stays its own issue: `covers` names only what the body shows.
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
  files: readonly PullFile[];
  /** The first head cite of each change item of the report, which anchors a question that names no symbol. */
  itemCites: ItemCites;
  /** The effective language packs: a cited path is a test by their `testFiles` convention, as answer validation judges it. */
  packs: readonly FullPack[];
  /** The round-1 issues earlier heads left open, as the ledger holds them (empty for a first run). */
  prior?: readonly PriorItem[];
  /** The pinned commits a citation is linked at (the pull request and its head and base); without it citations are named, not linked. */
  github?: GithubPin;
}

/**
 * The issues of round 1 from the artifacts, in question order (N1 first). Undefined when `qa.json` is not a Q&A file. An
 * answer can match several kinds at once; it is one issue with all of them, and its status is the answer's own.
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
    if (q.type === "existing-reuse-common" && !a.none_found) {
      outside = outsideEquivalents(a.citations, changedPaths);
      // No citation at all cannot show the equivalent is the changed code, so it stays an issue.
      if (outside.length > 0 || a.citations.every((c) => c.path === "")) kinds.push("existing");
      else noted.push({ id: q.id, key: q.stable, note: NOTED_REASON });
    }
    if (q.type === "missing-test" && (a.none_found || !a.citations.some((c) => c.tree !== "dependency" && isTestPath(i.packs, c.path)))) kinds.push("missing-test");
    if (kinds.length === 0) continue;
    const sym = q.symbol !== undefined ? qa.symbols.find((s) => s.id === q.symbol) : undefined;
    const cite = i.itemCites[q.item];
    const at = sym !== undefined ? { path: sym.path, line: sym.startLine } : q.functionPath !== undefined ? { path: q.functionPath, line: 1 } : cite !== undefined ? { path: cite.path, line: cite.start } : undefined;
    if (outside.length > 0) outsideOf.set(q.id, outside);
    const parts: ItemParts = {
      id: q.id,
      head: scrub(`**${kinds.map((k) => ROUND1_LABEL[k]).join("; ")}** (${q.id}). ${oneLine(q.text)}`),
      label: a.status === "needs author" ? "What was checked" : `Answer (${a.status})`,
      answer: scrub(oneLine(a.answer)),
      cites: citationLinks(a.citations, i.github, a.inventory).map(scrub),
      proposal: scrub(proposalText(a.proposal)),
    };
    issues.push({
      id: q.id,
      key: q.stable,
      kinds,
      status: a.status,
      body: composeParts(parts),
      parts,
      ...(at !== undefined ? place(at.path, at.line) : { anchored: false }),
    });
  }
  mergeSharedEquivalents(issues, outsideOf, qa);
  const open = (i.prior ?? []).filter((p) => p.origin === "round1" && p.status === "open");
  const askedOnlyN1 = qa.questions.every((q) => q.type === "necessity");
  const prior = open.map((p): Round1Prior => {
    const host = issues.find((x) => x.covers?.includes(p.id));
    if (host !== undefined) return { id: p.id, key: p.key, status: "open", reason: `it is still an issue on this head, listed with ${host.id}` };
    if (issues.some((x) => x.id === p.id)) return { id: p.id, key: p.key, status: "open", reason: "it is still an issue on this head" };
    if (p.id !== NECESSITY_ID && askedOnlyN1) return { id: p.id, key: p.key, status: "open", reason: "not re-checked: N1 was judged unnecessary, so the other questions were skipped" };
    const q = qa.questions.find((x) => x.id === p.id);
    return { id: p.id, key: p.key, status: "fixed", reason: p.id === NECESSITY_ID ? `N1 now concludes ${conclusion}` : q !== undefined ? `its question is now ${q.answer?.status ?? "answered"}, with no blocking category` : "its subject is no longer in the change" };
  });
  return { schema: ROUND1_SCHEMA, head: i.head, necessity: conclusion, issues, ...(open.length > 0 ? { prior } : {}), ...(noted.length > 0 ? { noted } : {}) };
}

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
