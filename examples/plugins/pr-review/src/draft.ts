// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The draft review (design §8.4, §10; design-pr-review-split §4.5): composed by plugin code from the aspects' records and the
 * verdicts, never by a model. No Q&A item is drafted: round 1 is the design review's (pr-design-review), and the draft lists its
 * open items, or says it was not run. `draft.json` (`pr-review-draft-v2`) is canonical; `draft.md` is its rendering, for whoever wants
 * to read it. The Publish stage (`publish.ts`) posts the draft's comments; nothing here writes to GitHub. The summary is plain text,
 * at most 1,200 characters.
 *
 * Only a proven behavioral finding may be drafted as P0 or P1, with two exceptions (design §7.3): a confirmed finding raised from an
 * `untested-feature` lead, whose proof is the recorded test map and coverage, may be drafted at P1; and a confirmed finding raised
 * from a `weak-test`, `split-function`, `crap` or `reuse` lead, whose proof is its recomputed lead, is drafted at P0 whatever
 * priority the reviewer proposed (an unproven behavioral one still is not: it goes to "Needs your judgment").
 *
 * That drafted priority is a finding's only one (design §8.4): the draft's report part (`review.findings`), review.md, the HTML
 * report, the posted review and the ledger show it; a dismissed finding has none. The proposed one stays in the aspect record.
 */
import { ASPECTS, DRAFT_ORDER, type Aspect } from "./kit/aspects.js";
import { clip } from "./kit/escape.js";
import { contextLine, round1Entry, round1Lines, type ContextSource, type Round1Status } from "./context.js";
import { fixedP0Lead, leadLine, type LeadKind, type LeadRecord } from "./leads.js";
import { proofOf, type Proof } from "./proof.js";
import { correctedContent, findingsOf, keptSuggestion, MAX_SWEEP_PASSES, SEVERITIES, spanMatches, type AspectRecord, type Correction, type Finding, type FindingVerdict, type Severity } from "./review.js";
import type { ScopeRecord } from "./reviewscope.js";
import { sideLines, parsePatch } from "./kit/patch.js";
import type { PullFile } from "./kit/snapshot.js";

export const DRAFT_SCHEMA = "pr-review-draft-v2";
export const MAX_SUMMARY_CHARS = 1_200;
export type Verdict = "approve" | "comment" | "request-changes";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What a posted comment must not carry: a path inside `.graphloom/` (bookkeeping of this tool). */
export const scrub = (text: string): string => text.replace(/\.graphloom\/[^\s)`'"<>:]*/g, "[a review file]");

export interface DraftEntry {
  /** `F3`. */
  id: string;
  kind: "finding";
  /** Every aspect of the findings linked into this entry (the first sits first). */
  aspects: Aspect[];
  severity?: Severity;
  /** The finding's proof state and, for an unproven one, why. */
  proof?: { state: Proof["state"]; reason?: string };
  /** Why the entry is under "Needs your judgment". */
  reason?: string;
  path: string;
  side: "RIGHT" | "LEFT";
  startLine?: number;
  line: number;
  /** The range lies inside a hunk of the file's patch on its side; otherwise the comment goes in the review body. */
  anchored: boolean;
  body: string;
  suggestion?: string;
  /** Other findings of other aspects on overlapping lines, linked into this entry. */
  linked?: string[];
  /** The design principle the finding says the change breaks (design §8.1). */
  principle?: string;
  /** The reviewer's test and what the graph's run of it recorded (design §8.2), when the finding has one: the maintainer can run it. */
  test?: DraftTest;
  /** The lead the finding was raised from (design-pr-review-split §4.3). */
  lead?: { id: string; kind: LeadKind };
}

/** A finding's reproducing test as the draft carries it: the exact text the graph ran, and its recorded result. */
export interface DraftTest {
  language: "go" | "typescript";
  dir: string;
  name: string;
  expect: "assertion" | "panic";
  oracle: string;
  sha256: string;
  text: string;
  /** The two runs' outcomes, and where and how the first failing run failed. */
  runs: string[];
  at?: string;
  failure?: string;
}

export function draftTestOf(f: Finding): DraftTest | undefined {
  const r = f.repro;
  if (r === undefined || r.text.trim() === "") return undefined;
  const rec = f.proof?.record;
  return {
    language: rec?.language ?? (f.path.endsWith(".go") ? "go" : "typescript"),
    dir: r.dir,
    name: r.name,
    expect: r.expect,
    oracle: r.oracle,
    sha256: rec?.sha256 ?? "",
    text: r.text,
    runs: rec?.runs ?? [],
    ...(rec?.at !== undefined ? { at: rec.at } : {}),
    ...(rec?.failure !== undefined ? { failure: rec.failure } : {}),
  };
}

/** The line a proven finding's comment carries, and the one it opens its test block with. */
export const provenLine = (t: DraftTest): string => `Proven by a failing test the graph ran twice in a sandbox: \`${t.name}\` (${t.language}, in \`${t.dir}\`) failed${t.at !== undefined ? ` at \`${t.at}\`` : ""}${t.failure !== undefined ? `: ${clip(oneLine(t.failure), 300)}` : ""}. The expected value comes from: ${clip(oneLine(t.oracle), 240)}`;

export interface AspectView {
  aspect: Aspect;
  reviewer: string;
  verifier: string;
  passes: number;
  nits: number;
  merged: number;
  unsaturated: boolean;
  confirmed: number;
  disputed: number;
  dismissed: number;
}

/**
 * A finding as every surface outside its aspect record shows it (review.md, the HTML report, draft.json): its priority is the final
 * one the draft rules give it, the priority of the draft entry it is in (as primary or linked), or none when it is in no entry (a
 * dismissed finding). The reviewer's proposed priority stays in the aspect record only (design §8.4).
 */
export type ReviewFinding = Omit<Finding, "severity"> & { severity?: Severity };

/** What the report sections render: the scope and base, the aspects and every finding with its verdict. */
export interface ReviewDoc {
  scope: { mode: "standard" | "large"; source: string; areas: ScopeRecord["areas"]; files: number };
  context: ScopeRecord["context"];
  aspects: AspectView[];
  /** Every finding, at its final priority or with none: never the reviewer's proposed one. */
  findings: ReviewFinding[];
  /** Every lead with its status (design-pr-review-split §4.3); the appendix lists them. */
  leads: LeadRecord[];
}

export interface Draft {
  schema: typeof DRAFT_SCHEMA;
  pull: { owner: string; repo: string; number: number };
  head: string;
  base?: string;
  /** What the review would post: `comment` where `approve` is recommended. */
  verdict: Verdict;
  recommended: Verdict;
  summary: string;
  /** The context the reviewers started from (design-pr-review-split §4.2). */
  context: { source: ContextSource; head?: string };
  /** Round 1 on the pull request (§4.5): the design review's open items, or null when round 1 was not run. */
  round1: Round1Status | null;
  /** How many leads the maintainability reviewer was given, and how many it raised (§4.3). */
  leads: { given: number; raised: number };
  comments: DraftEntry[];
  judgment: DraftEntry[];
  /** Existing human threads shown as already raised: not read in this version. */
  earlier: never[];
  /** Lines for the maintainer, never posted. */
  maintainer: string[];
  review: ReviewDoc;
}

// ---- anchors ----

/** Whether every line of the range lies in a hunk of the file's patch on the side. */
export function anchored(file: PullFile | undefined, side: "RIGHT" | "LEFT", start: number, end: number): boolean {
  if (file === undefined || file.patch === null) return false;
  const lines = sideLines(file.parsed ?? parsePatch(file.patch), side === "RIGHT" ? "head" : "base");
  for (let n = start; n <= end; n += 1) if (!lines.has(n)) return false;
  return true;
}

// ---- the findings ----

const sevIndex = (s: Severity): number => SEVERITIES.indexOf(s);
const aspectIndex = (a: Aspect): number => DRAFT_ORDER.indexOf(a);
const idNumber = (id: string): number => Number(id.slice(1));

/** Confirmed findings of different aspects on overlapping lines of one file and side are one problem, unless a reviewer marked them distinct. */
export function clusters(confirmed: readonly Finding[]): Finding[][] {
  const parent = confirmed.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < confirmed.length; i += 1) {
    for (let j = i + 1; j < confirmed.length; j += 1) {
      const a = confirmed[i]!;
      const b = confirmed[j]!;
      if (a.aspect === b.aspect || a.distinct || b.distinct || a.path !== b.path || a.side !== b.side) continue;
      if (a.startLine <= b.endLine && b.startLine <= a.endLine) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, Finding[]>();
  confirmed.forEach((f, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), f]));
  return [...groups.values()].map((g) => g.sort((a, b) => aspectIndex(a.aspect) - aspectIndex(b.aspect) || idNumber(a.id) - idNumber(b.id))).sort((a, b) => idNumber(a[0]!.id) - idNumber(b[0]!.id));
}

function entryOf(members: readonly Finding[], files: readonly PullFile[], reason: string | undefined, draftable: boolean): DraftEntry {
  const pool = draftable ? members.filter((f) => proofOf(f).state !== "unproven") : members;
  const primary = pool[0] ?? members[0]!;
  const proof = proofOf(primary);
  const best = pool.reduce((s, f) => (sevIndex(f.severity) < sevIndex(s) ? f.severity : s), primary.severity);
  // A confirmed finding raised from a weak-test, split-function, crap or reuse lead is P0, whatever was proposed (design §7.3).
  const fixed = pool.find(fixedP0Finding);
  // Otherwise only a proven finding may be drafted as P0 or P1 (design §8.2); a non-behavioral one claims no wrong behavior, so it is
  // at most P2, except a confirmed untested-feature finding, which may be P1 (design §7.3).
  const ceiling: Severity = proof.state === "proven" ? "P0" : untestedFeature(primary) ? "P1" : "P2";
  const severity: Severity = fixed !== undefined ? "P0" : sevIndex(best) < sevIndex(ceiling) ? ceiling : best;
  const led = fixed ?? primary;
  const kept = draftable ? keptSuggestion(primary) : undefined;
  const aspects = [...new Set(members.map((f) => f.aspect))];
  const file = files.find((x) => x.path === primary.path);
  const isAnchored = anchored(file, primary.side, primary.startLine, primary.endLine);
  const notes = [...new Set(members.flatMap((f) => f.notes))];
  const principle = members.find((f) => f.principle !== undefined)?.principle;
  const test = draftTestOf(primary);
  // The verifier's factual corrections reach the posted text (design §8.4): applied in place, or stated when one cannot be.
  const corrected = correctedContent(primary);
  return {
    id: primary.id,
    kind: "finding",
    aspects,
    severity,
    proof: { state: proof.state, ...(proof.state === "unproven" ? { reason: proof.reason } : {}) },
    ...(reason !== undefined ? { reason } : {}),
    path: primary.path,
    side: primary.side,
    ...(primary.endLine > primary.startLine ? { startLine: primary.startLine } : {}),
    line: primary.endLine,
    anchored: isAnchored,
    ...(principle !== undefined ? { principle } : {}),
    body: scrub([corrected.text, ...(corrected.unapplied.length > 0 ? [correctedLine(corrected.unapplied)] : []), ...(principle !== undefined ? [`Breaks the project's design principle \`${principle}\`.`] : []), ...(primary.verdict !== undefined && primary.verdict.verdict === "confirmed" && primary.verdict.witness !== "" ? [`Verified independently: ${oneLine(primary.verdict.reason)} (${primary.verdict.witness}).`] : []), ...(proof.state === "proven" && test !== undefined ? [provenLine(test)] : []), ...(reason !== undefined && notes.length > 0 ? [`Note: ${notes.join("; ")}.`] : [])].join("\n\n")),
    ...(kept !== undefined && "text" in kept ? { suggestion: kept.text } : {}),
    ...(test !== undefined ? { test } : {}),
    ...(members.length > 1 ? { linked: members.filter((f) => f !== primary).map((f) => f.id) } : {}),
    ...(led.lead !== undefined && led.leadKind !== undefined ? { lead: { id: led.lead, kind: led.leadKind } } : {}),
  };
}

/** The final priority of every finding in a draft entry: the entry's own, for its primary and its linked findings (design §7.3, §8.4). */
export function finalPriorities(entries: readonly DraftEntry[]): Map<string, Severity> {
  const out = new Map<string, Severity>();
  for (const e of entries) {
    if (e.severity === undefined) continue;
    for (const id of [e.id, ...(e.linked ?? [])]) if (!out.has(id)) out.set(id, e.severity);
  }
  return out;
}

/**
 * Where a written draft's priorities differ from the recomputed draft's: an entry, or a finding of the report part, at a priority
 * other than the one the draft rules give it (a reviewer's proposed one copied, say). Undefined when they agree.
 */
export function priorityMismatch(written: unknown, want: Draft): string | undefined {
  if (!isObj(written)) return undefined;
  const sev = (v: unknown): string => (isObj(v) && typeof v.severity === "string" ? v.severity : "none");
  const wantEntries = new Map([...want.comments, ...want.judgment].map((e) => [e.id, e.severity ?? "none"] as const));
  for (const e of [...(Array.isArray(written.comments) ? written.comments : []), ...(Array.isArray(written.judgment) ? written.judgment : [])]) {
    if (!isObj(e) || typeof e.id !== "string" || !wantEntries.has(e.id)) continue;
    if (sev(e) !== wantEntries.get(e.id)) return `${e.id} is drafted at ${sev(e)}, but the draft rules give ${wantEntries.get(e.id)}`;
  }
  const wantFindings = new Map(want.review.findings.map((f) => [f.id, f.severity ?? "none"] as const));
  const review = isObj(written.review) && Array.isArray(written.review.findings) ? written.review.findings : [];
  for (const f of review) {
    if (!isObj(f) || typeof f.id !== "string" || !wantFindings.has(f.id)) continue;
    if (sev(f) !== wantFindings.get(f.id)) return `the report shows ${f.id} at ${sev(f)}, but the draft rules give ${wantFindings.get(f.id)}`;
  }
  return undefined;
}

/** A finding as shown outside its aspect record: at its final priority, or with none, and with its verifier's corrections applied. */
export function shownFinding(f: Finding, final: ReadonlyMap<string, Severity>): ReviewFinding {
  const { severity: _proposed, ...rest } = f;
  const s = final.get(f.id);
  const shown = { ...rest, content: correctedContent(f).text };
  return s !== undefined ? { ...shown, severity: s } : shown;
}

/** The corrections as one sentence: `"9 drop sites" should read "6 drop sites"`. */
const correctionsText = (cs: readonly Correction[]): string => cs.map((c) => `"${oneLine(c.original)}" should read "${oneLine(c.corrected)}"`).join("; ");

/** The line a finding's text carries for a verifier's correction that could not be applied in place. */
export const correctedLine = (cs: readonly Correction[]): string => `Corrected by the verifier: ${correctionsText(cs)}.`;

/** What the report appendices say of a verdict's corrections (the shown text already has them applied); "" for none. */
export const correctionsNote = (v: Pick<FindingVerdict, "verdict" | "corrections"> | undefined): string => (v?.verdict === "confirmed" && (v.corrections ?? []).length > 0 ? ` The verifier corrected the reviewer's text (applied above): ${correctionsText(v.corrections!)}.` : "");

/**
 * Where a written draft ignores a verifier's correction the recomputed draft applies (design §8.4): an entry whose body still holds a
 * corrected span's original text where the recomputed body does not, or lacks its corrected text. Undefined when they agree.
 */
export function correctionMismatch(written: unknown, want: Draft): string | undefined {
  if (!isObj(written)) return undefined;
  const byId = new Map(want.review.findings.map((f) => [f.id, f] as const));
  const wantBody = new Map([...want.comments, ...want.judgment].map((e) => [e.id, e.body] as const));
  for (const e of [...(Array.isArray(written.comments) ? written.comments : []), ...(Array.isArray(written.judgment) ? written.judgment : [])]) {
    if (!isObj(e) || typeof e.id !== "string" || typeof e.body !== "string") continue;
    const f = byId.get(e.id);
    const body = wantBody.get(e.id);
    if (f === undefined || body === undefined || f.verdict?.verdict !== "confirmed") continue;
    for (const c of f.verdict.corrections ?? []) {
      const kept = spanMatches(e.body, c.original).length > spanMatches(body, c.original).length;
      const lost = body.includes(c.corrected) && !e.body.includes(c.corrected);
      if (kept || lost) return `${e.id} ignores its verifier's correction of "${clip(oneLine(c.original), 60)}" to "${clip(oneLine(c.corrected), 60)}"`;
    }
  }
  return undefined;
}

/** A confirmed non-behavioral finding raised from an `untested-feature` lead: the one that may be drafted at P1 (§4.3). */
export const untestedFeature = (f: Pick<Finding, "leadKind" | "kind" | "state">): boolean => f.leadKind === "untested-feature" && f.kind === "non-behavioral" && f.state === "confirmed";

/** A confirmed finding raised from a `weak-test`, `split-function`, `crap` or `reuse` lead that is not an unproven behavioral one: drafted at P0 (§7.3). */
export const fixedP0Finding = (f: Pick<Finding, "leadKind" | "kind" | "state" | "proof">): boolean => fixedP0Lead(f.leadKind) && f.state === "confirmed" && proofOf(f).state !== "unproven";

// ---- composing ----

export interface DraftInput {
  pull: { owner: string; repo: string; number: number };
  head: string;
  base?: string | undefined;
  files: readonly PullFile[];
  scope: ScopeRecord;
  records: readonly AspectRecord[];
  context: { source: ContextSource; head?: string | undefined };
  round1: Round1Status | null;
}

const SEV_LABEL: Record<Severity, string> = { P0: "critical", P1: "major", P2: "minor", P3: "nit" };
export const severityLabel = (s: Severity): string => `[${s}] ${SEV_LABEL[s]}`;

/** The draft, from the recorded review: comments (confirmed findings that need no test, or are proven), judgment, for the maintainer. */
export function composeDraft(i: DraftInput): Draft {
  const findings = findingsOf(i.records);
  const confirmed = findings.filter((f) => f.state === "confirmed");
  const comments: DraftEntry[] = [];
  const judgment: DraftEntry[] = [];
  for (const group of clusters(confirmed)) {
    const draftable = group.some((f) => proofOf(f).state !== "unproven");
    if (draftable) comments.push(entryOf(group, i.files, undefined, true));
    else judgment.push(entryOf(group, i.files, `unproven: ${proofOf(group[0]!).state === "unproven" ? (proofOf(group[0]!) as { reason: string }).reason : ""}`, false));
  }
  for (const f of findings.filter((x) => x.state === "disputed")) judgment.push(entryOf([f], i.files, `disputed: ${f.notes.at(-1) ?? "the verifier could not decide"}`, false));
  // Findings are grouped by aspect in the order correctness, security, maintainability; a linked finding sits under the first.
  const byAspect = (a: DraftEntry, b: DraftEntry): number => aspectIndex(a.aspects[0]!) - aspectIndex(b.aspects[0]!) || Number(a.id.slice(1)) - Number(b.id.slice(1));
  comments.sort(byAspect);
  judgment.sort(byAspect);
  const dismissed = findings.filter((f) => f.state === "dismissed");
  const nits = i.records.reduce((n, r) => n + r.passes.reduce((m, p) => m + p.nits, 0), 0);
  const unsaturated = i.records.filter((r) => r.unsaturated).map((r) => r.aspect);
  const leads = i.records.flatMap((r) => r.leads ?? []);
  const given = leads.filter((l) => l.given);
  const raisedLeads = given.filter((l) => l.status === "raised").length;
  const maintainer = [
    `Context: ${contextLine(i.context, i.head)}.`,
    round1Entry(i.round1, i.head),
    `Review scope: ${scopeLine(i.scope)}. ${i.scope.context.reason[0]!.toUpperCase()}${i.scope.context.reason.slice(1)}.`,
    ...(leads.length > 0 ? [`Leads: ${given.length} given to the maintainability reviewer, ${raisedLeads} raised as findings, ${given.length - raisedLeads} judged not an issue${leads.length > given.length ? `; ${leads.length - given.length} not given (over the bound)` : ""}.`] : []),
    ...(unsaturated.length > 0 ? [`Not saturated: the ${unsaturated.join(", ")} sweep${unsaturated.length === 1 ? "" : "s"} reached ${MAX_SWEEP_PASSES} passes with findings still surviving verification; more may be there.`] : []),
    ...(nits > 0 ? [`${nits} nit${nits === 1 ? "" : "s"} (P3) raised and not verified or drafted.`] : []),
    ...dismissed.map((f) => `Dismissed ${f.id} (${f.aspect}, ${f.path}:${f.startLine}): refuted by the verifier — ${clip(f.verdict?.reason ?? "", 240)}${f.verdict !== undefined ? ` Quotes: ${f.verdict.quotes.map((x) => `${x.path}:${x.line}`).join(", ")}.` : ""}`),
    ...i.records.filter((r) => r.findings.some((f) => f.notes.some((n) => n.startsWith("merged")))).map((r) => `The ${r.aspect} pass merged comments on overlapping lines into one finding.`),
    ...(i.scope.mode === "large" ? [`Large pull request: only the files of ${i.scope.areas.map((a) => a.id).join(", ")} were reviewed; the other areas were not.`] : []),
  ];
  // The recommendation (design §10.3): request-changes needs a proven P0 or P1, a confirmed untested-feature finding at P1, or a
  // confirmed weak-test, split-function, crap or reuse finding at P0 (design §7.3); approve only when nothing is open.
  const blocking = comments.some((c) => (c.proof?.state === "proven" && (c.severity === "P0" || c.severity === "P1")) || (c.lead?.kind === "untested-feature" && c.severity === "P1") || (fixedP0Lead(c.lead?.kind) && c.severity === "P0"));
  const open = comments.length > 0 || judgment.length > 0;
  const recommended: Verdict = blocking ? "request-changes" : open ? "comment" : "approve";
  const views: AspectView[] = i.records.map((r) => ({
    aspect: r.aspect,
    reviewer: r.reviewer,
    verifier: r.verifier,
    passes: r.passes.length,
    nits: r.passes.reduce((n, p) => n + p.nits, 0),
    merged: r.passes.reduce((n, p) => n + p.merged, 0),
    unsaturated: r.unsaturated,
    confirmed: r.findings.filter((f) => f.state === "confirmed").length,
    disputed: r.findings.filter((f) => f.state === "disputed").length,
    dismissed: r.findings.filter((f) => f.state === "dismissed").length,
  }));
  // Every surface shows a finding's final priority (its entry's), or none; the proposed one stays in the aspect record (design §8.4).
  const final = finalPriorities([...comments, ...judgment]);
  const review: ReviewDoc = {
    scope: { mode: i.scope.mode, source: i.scope.source, areas: i.scope.areas, files: i.scope.files.length },
    context: i.scope.context,
    aspects: views,
    findings: findings.map((f) => shownFinding(f, final)),
    leads,
  };
  const summary = summaryText(i.scope, confirmed.filter((f) => f.principle !== undefined), views, comments, judgment, dismissed.length, recommended);
  return {
    schema: DRAFT_SCHEMA,
    pull: i.pull,
    head: i.head,
    ...(i.base !== undefined ? { base: i.base } : {}),
    verdict: recommended === "approve" ? "comment" : recommended,
    recommended,
    summary,
    context: { source: i.context.source, ...(i.context.head !== undefined ? { head: i.context.head } : {}) },
    round1: i.round1,
    leads: { given: given.length, raised: raisedLeads },
    comments,
    judgment,
    earlier: [],
    maintainer,
    review,
  };
}

const sourceText: Record<ScopeRecord["source"], string> = {
  whole: "the whole pull request",
  default: "the areas the briefing's risks, behavior and compatibility entries cite",
  "all-areas": "every readable area (the briefing's risks, behavior and compatibility entries cite none)",
};

export function scopeLine(s: { source: ScopeRecord["source"]; areas: ScopeRecord["areas"]; files: { length: number } }): string {
  const areas = s.areas.length > 0 ? ` (${s.areas.map((a) => a.id).join(", ")})` : "";
  return `${sourceText[s.source]}${areas}, ${s.files.length} file${s.files.length === 1 ? "" : "s"}`;
}

function summaryText(scope: ScopeRecord, principled: readonly Finding[], aspects: readonly AspectView[], comments: readonly DraftEntry[], judgment: readonly DraftEntry[], dismissed: number, recommended: Verdict): string {
  const confirmed = aspects.reduce((n, a) => n + a.confirmed, 0);
  const text = [
    `Reviewed ${scopeLine(scope)} for ${ASPECTS.join(", ")}, with every finding verified by an independent reader.`,
    `${confirmed} finding${confirmed === 1 ? "" : "s"} confirmed: ${comments.filter((c) => c.kind === "finding").length} drafted as comments, ${comments.filter((c) => c.proof?.state === "proven").length} of them proven by a failing test the graph ran, ${judgment.filter((j) => j.proof?.state === "unproven").length} confirmed but unproven (each says why).`,
    ...(principled.length > 0 ? [`Confirmed breaks of the project's design principles: ${principled.map((f) => `${f.id} breaks ${f.principle}`).join(", ")}.`] : []),
    `${judgment.filter((j) => j.reason?.startsWith("disputed")).length} disputed, ${dismissed} dismissed.`,
    `Recommended verdict: ${recommended}${recommended === "approve" ? " (drafted as comment)" : ""}.`,
  ].join(" ");
  return clip(text, MAX_SUMMARY_CHARS);
}

export const draftJson = (d: Draft): string => `${JSON.stringify(d, null, 2)}\n`;

export function parseDraft(json: string): Draft | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObj(v) || v.schema !== DRAFT_SCHEMA || !Array.isArray(v.comments) || !isObj(v.review)) return undefined;
    return v as unknown as Draft;
  } catch {
    return undefined;
  }
}

// ---- draft.md ----

const aspectTitle = (a: Aspect): string => `${a.charAt(0).toUpperCase()}${a.slice(1)}`;
const lines = (e: DraftEntry): string => (e.startLine !== undefined ? `${e.startLine}-${e.line}` : `${e.line}`);

function entryMarkdown(e: DraftEntry, level: "####" | "###"): string[] {
  const head = [e.id, e.reason === undefined ? e.severity ?? "" : "", ...(e.aspects.length > 0 ? [e.aspects.join(", ")] : []), ...(e.principle !== undefined ? [`breaks principle ${e.principle}`] : []), ...(e.proof?.state === "non-behavioral" ? ["non-behavioral"] : []), ...(e.lead !== undefined ? [`from lead ${e.lead.id} (${e.lead.kind})`] : []), ...(e.reason !== undefined ? [e.reason] : []), `${e.path}:${lines(e)}`, e.side].filter((x) => x !== "");
  const out = [`${level} ${head.join(" · ")}${e.anchored ? "" : " · not in the diff (goes in the review body)"}`, e.body];
  if (e.suggestion !== undefined) out.push("```suggestion", e.suggestion, "```");
  if (e.test !== undefined) {
    const t = e.test;
    out.push(`The test${e.proof?.state === "proven" ? " that proves it" : " (it does not prove the finding)"}: ${t.name} (${t.language}, in ${t.dir}; expects ${t.expect}; runs: ${t.runs.length > 0 ? t.runs.join(", ") : "none"}; SHA-256 ${t.sha256 !== "" ? t.sha256.slice(0, 12) : "not recorded"})`, `\`\`\`${t.language === "go" ? "go" : "ts"}`, t.text.replace(/\n$/, ""), "```");
  }
  if (e.linked !== undefined && e.linked.length > 0) out.push(`Also raised as ${e.linked.join(", ")}.`);
  return out;
}

/** The readable rendering (design §10.1). `draft.json` is what the plugin wrote, and what Publish posts from. */
export function draftMarkdown(d: Draft): string {
  const findings = d.comments;
  const out: string[] = [
    `# Review of ${d.pull.owner}/${d.pull.repo}#${d.pull.number} at ${d.head.slice(0, 12)}`,
    `Verdict: ${d.verdict}        <!-- recommended: ${d.recommended} -->`,
    "",
    "## Summary",
    d.summary,
    "",
    "## Design review (round 1)",
    ...round1Lines(d.round1, d.head),
    "",
    "## Comments",
  ];
  for (const a of DRAFT_ORDER) {
    const mine = findings.filter((c) => c.aspects[0] === a);
    if (mine.length === 0) continue;
    out.push(`### ${aspectTitle(a)}`, ...mine.flatMap((e) => entryMarkdown(e, "####")));
  }
  if (findings.length === 0) out.push("No finding is drafted as a comment.");
  out.push("", "## Needs your judgment (move an entry into Comments to post it)");
  if (d.judgment.length === 0) out.push("None.");
  for (const e of d.judgment) out.push(...entryMarkdown(e, "###"));
  out.push("", "## For the maintainer (never posted)", ...d.maintainer.map((m) => `- ${m}`), "");
  return out.join("\n");
}

// ---- review.md: the Review section and its appendix part ----

const countBy = (fs: readonly ReviewFinding[], state: Finding["state"]): number => fs.filter((f) => f.state === state).length;

const findingLine = (f: ReviewFinding, reviewerOf: (a: Aspect) => string): string => {
  const proof = proofOf(f);
  return `${f.id} · ${f.aspect} · ${f.path}:${f.startLine}${f.endLine > f.startLine ? `-${f.endLine}` : ""}${f.side === "LEFT" ? " (base)" : ""} · ${f.state}${f.principle !== undefined ? ` · breaks principle ${f.principle}` : ""}${f.verdict !== undefined ? ` (verifier ${reviewerOf(f.raisedBy)}: ${f.verdict.verdict})` : ""} · ${proof.state === "unproven" ? `unproven: ${proof.reason}` : proof.state}: ${clip(oneLine(f.content), 160)}`;
};

/** The Review part of the briefing in `review.md`: findings by severity with counts, each one line. */
export function reviewBriefingMarkdown(d: Draft): string {
  const f = d.review.findings.filter((x) => x.state !== "dismissed");
  const verifier = (a: Aspect): string => d.review.aspects.find((x) => x.aspect === a)?.verifier ?? "?";
  const out = [
    "## Review",
    `Recommended verdict: ${d.recommended}${d.recommended === "approve" ? " (drafted as comment)" : ""}. Scope: ${scopeLine({ source: d.review.scope.source as ScopeRecord["source"], areas: d.review.scope.areas, files: { length: d.review.scope.files } })}. Draft: draft.md in .graphloom/review/ (the Publish stage posts its comments).`,
    `Findings: ${countBy(d.review.findings, "confirmed")} confirmed, ${countBy(d.review.findings, "disputed")} disputed, ${countBy(d.review.findings, "dismissed")} dismissed; leads: ${d.leads.given} given, ${d.leads.raised} raised.`,
    ...round1Lines(d.round1, d.head),
  ];
  for (const sev of SEVERITIES) {
    const at = f.filter((x) => x.severity === sev);
    if (at.length === 0) continue;
    out.push("", `### ${sev} (${at.length})`, ...at.map((x) => `- ${findingLine(x, verifier)}`));
  }
  const unranked = f.filter((x) => x.severity === undefined);
  if (unranked.length > 0) out.push("", `### Not drafted (${unranked.length})`, ...unranked.map((x) => `- ${findingLine(x, verifier)}`));
  if (f.length === 0) out.push("", "No finding survived verification.");
  out.push("");
  return out.join("\n");
}

/** The appendix part: every finding in full with its verdict and the draft. */
export function reviewAppendixMarkdown(d: Draft): string {
  const out = ["## Review: findings and draft", "", "### Findings"];
  for (const f of d.review.findings) {
    out.push(`#### ${f.id} · ${f.aspect} · ${f.severity !== undefined ? `${f.severity} · ` : ""}${f.kind} · ${f.state}${f.principle !== undefined ? ` · breaks principle ${f.principle}` : ""}`, `${f.path}:${f.startLine}-${f.endLine} (${f.side === "RIGHT" ? "head" : "base"}), raised in pass ${f.pass} of the ${f.raisedBy} sweep.`, f.content);
    if (f.evidence !== "") out.push(`The reviewer read: ${f.evidence}`);
    if (f.verdict !== undefined) out.push(`Verifier: ${f.verdict.verdict}${f.verdict.witness !== "" ? ` at ${f.verdict.witness}` : ""}: ${f.verdict.reason}${f.verdict.quotes.length > 0 ? ` Quotes: ${f.verdict.quotes.map((q) => `${q.path}:${q.line} "${clip(oneLine(q.text), 80)}"`).join("; ")}.` : ""}${correctionsNote(f.verdict)}`);
    if (f.notes.length > 0) out.push(`Notes: ${f.notes.join("; ")}.`);
    out.push("");
  }
  if (d.review.findings.length === 0) out.push("None raised.", "");
  out.push("### Leads", ...(d.review.leads.length === 0 ? ["None: no lead was computed for the review's scope."] : d.review.leads.map((l) => `- ${leadLine(l)} → ${l.status}${l.reason !== undefined ? `: ${l.reason}` : ""}${l.finding !== undefined ? ` (${l.finding})` : ""}`)), "");
  out.push("### Draft", ...draftMarkdown(d).split("\n").map((l) => (l.startsWith("#") ? `##${l}` : l)), "");
  return out.join("\n");
}

/** `review.md` with the Review part before the open questions and the appendix part at the end. */
export function withReview(markdown: string, d: Draft): string {
  const briefing = reviewBriefingMarkdown(d);
  const at = markdown.indexOf("\n## Open questions");
  const withBriefing = at < 0 ? `${markdown.trimEnd()}\n\n${briefing}` : `${markdown.slice(0, at + 1)}${briefing}\n${markdown.slice(at + 1)}`;
  return `${withBriefing.replace("Contents: Briefing · Appendix", "Contents: Briefing (with Review) · Appendix (with Review)").trimEnd()}\n\n${reviewAppendixMarkdown(d)}`;
}
