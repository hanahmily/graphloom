// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The draft review (design §8.4, §10): composed by plugin code from the aspects' records, the verdicts and the Q&A, never by
 * a model. `draft.json` (`pr-review-draft-v1`) is canonical; `draft.md` is its rendering, for whoever wants to read it. The Publish
 * stage (`publish.ts`) posts the draft's comments that are findings; nothing here writes to GitHub. The summary is plain text
 * from the ledger, at most 1,200 characters.
 */
import { ASPECTS, DRAFT_ORDER, type Aspect } from "./aspects.js";
import { proofOf, type Proof } from "./proof.js";
import { findingsOf, keptSuggestion, MAX_SWEEP_PASSES, SEVERITIES, type AspectRecord, type Finding, type Severity } from "./review.js";
import type { ScopeRecord } from "./reviewscope.js";
import { sideLines, parsePatch } from "./patch.js";
import type { PullFile } from "./snapshot.js";

export const DRAFT_SCHEMA = "pr-review-draft-v1";
export const MAX_SUMMARY_CHARS = 1_200;
export type Verdict = "approve" | "comment" | "request-changes";

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What a posted comment must not carry: a path inside `.graphloom/` (bookkeeping of this tool). */
export const scrub = (text: string): string => text.replace(/\.graphloom\/[^\s)`'"<>:]*/g, "[a review file]");

export interface DraftEntry {
  /** `F3` for a finding, `Q3` for a question. */
  id: string;
  kind: "finding" | "question";
  /** Every aspect of the findings linked into this entry (the first sits first); empty for a question. */
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

/** What the report sections render: the scope and base, the aspects and every finding with its verdict. */
export interface ReviewDoc {
  scope: { mode: "standard" | "large"; source: string; areas: ScopeRecord["areas"]; files: number };
  context: ScopeRecord["context"];
  aspects: AspectView[];
  findings: Finding[];
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
  comments: DraftEntry[];
  judgment: DraftEntry[];
  notSelected: DraftEntry[];
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
  // Only a proven finding may be drafted as P0 or P1 (design §8.2); a non-behavioral one claims no wrong behavior, so it is at most P2.
  const severity: Severity = proof.state === "proven" ? best : sevIndex(best) < sevIndex("P2") ? "P2" : best;
  const kept = draftable ? keptSuggestion(primary) : undefined;
  const aspects = [...new Set(members.map((f) => f.aspect))];
  const file = files.find((x) => x.path === primary.path);
  const isAnchored = anchored(file, primary.side, primary.startLine, primary.endLine);
  const notes = [...new Set(members.flatMap((f) => f.notes))];
  const principle = members.find((f) => f.principle !== undefined)?.principle;
  const test = draftTestOf(primary);
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
    body: scrub([primary.content, ...(principle !== undefined ? [`Breaks the project's design principle \`${principle}\`.`] : []), ...(primary.verdict !== undefined && primary.verdict.verdict === "confirmed" && primary.verdict.witness !== "" ? [`Verified independently: ${oneLine(primary.verdict.reason)} (${primary.verdict.witness}).`] : []), ...(proof.state === "proven" && test !== undefined ? [provenLine(test)] : []), ...(reason !== undefined && notes.length > 0 ? [`Note: ${notes.join("; ")}.`] : [])].join("\n\n")),
    ...(kept !== undefined && "text" in kept ? { suggestion: kept.text } : {}),
    ...(test !== undefined ? { test } : {}),
    ...(members.length > 1 ? { linked: members.filter((f) => f !== primary).map((f) => f.id) } : {}),
  };
}

// ---- the Q&A items ----

export interface QaInput {
  questions: Array<{ id: string; type: string; item?: string; symbol?: string; functionPath?: string; text: string; answer?: { answer?: string; status?: string } }>;
  symbols: Array<{ id: string; path: string; startLine: number; endLine: number }>;
}

/** The report's change items by id, with the first head cite of each, which anchors a question that names no symbol. */
export interface ItemCites {
  [item: string]: { path: string; start: number; end: number } | undefined;
}

export function qaInputFrom(json: string | undefined): QaInput | undefined {
  if (json === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(json);
    if (!isObj(v) || !Array.isArray(v.questions)) return undefined;
    return { questions: v.questions.filter(isObj) as unknown as QaInput["questions"], symbols: (Array.isArray(v.symbols) ? v.symbols.filter(isObj) : []) as unknown as QaInput["symbols"] };
  } catch {
    return undefined;
  }
}

function questionEntries(qa: QaInput | undefined, cites: ItemCites, files: readonly PullFile[]): { selected: DraftEntry[]; rest: DraftEntry[] } {
  const selected: DraftEntry[] = [];
  const rest: DraftEntry[] = [];
  for (const q of qa?.questions ?? []) {
    if (q.type === "necessity" || q.answer?.status === undefined) continue;
    const sym = q.symbol !== undefined ? qa!.symbols.find((s) => s.id === q.symbol) : undefined;
    const cite = q.item !== undefined ? cites[q.item] : undefined;
    const at = sym !== undefined ? { path: sym.path, line: sym.startLine } : q.functionPath !== undefined ? { path: q.functionPath, line: 1 } : cite !== undefined ? { path: cite.path, line: cite.start } : undefined;
    if (at === undefined) continue;
    const file = files.find((f) => f.path === at.path);
    const entry: DraftEntry = {
      id: q.id,
      kind: "question",
      aspects: [],
      path: at.path,
      side: "RIGHT",
      line: at.line,
      anchored: anchored(file, "RIGHT", at.line, at.line),
      body: scrub(`${oneLine(q.text)}\n\n${q.answer.status === "needs author" ? "What was checked" : `Answer (${q.answer.status})`}: ${clip(oneLine(q.answer.answer ?? ""), 600)}`),
    };
    (q.answer.status === "needs author" ? selected : rest).push(entry);
  }
  return { selected, rest };
}

// ---- composing ----

export interface DraftInput {
  pull: { owner: string; repo: string; number: number };
  head: string;
  base?: string | undefined;
  files: readonly PullFile[];
  scope: ScopeRecord;
  records: readonly AspectRecord[];
  qa?: QaInput | undefined;
  itemCites?: ItemCites | undefined;
  /** N1's conclusion as one line, for the maintainer section. */
  necessity?: string | undefined;
}

const SEV_LABEL: Record<Severity, string> = { P0: "critical", P1: "major", P2: "minor", P3: "nit" };
export const severityLabel = (s: Severity): string => `[${s}] ${SEV_LABEL[s]}`;

/** The draft, from the recorded review: comments (confirmed findings that need no test, the Q&A items that need the author), judgment, not selected, for the maintainer. */
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
  const q = questionEntries(i.qa, i.itemCites ?? {}, i.files);
  const dismissed = findings.filter((f) => f.state === "dismissed");
  const nits = i.records.reduce((n, r) => n + r.passes.reduce((m, p) => m + p.nits, 0), 0);
  const unsaturated = i.records.filter((r) => r.unsaturated).map((r) => r.aspect);
  const maintainer = [
    ...(i.necessity !== undefined ? [i.necessity] : []),
    `Review scope: ${scopeLine(i.scope)}. ${i.scope.context.reason[0]!.toUpperCase()}${i.scope.context.reason.slice(1)}.`,
    ...(unsaturated.length > 0 ? [`Not saturated: the ${unsaturated.join(", ")} sweep${unsaturated.length === 1 ? "" : "s"} reached ${MAX_SWEEP_PASSES} passes with findings still surviving verification; more may be there.`] : []),
    ...(nits > 0 ? [`${nits} nit${nits === 1 ? "" : "s"} (P3) raised and not verified or drafted.`] : []),
    ...dismissed.map((f) => `Dismissed ${f.id} (${f.aspect}, ${f.path}:${f.startLine}): refuted by the verifier — ${clip(f.verdict?.reason ?? "", 240)}${f.verdict !== undefined ? ` Quotes: ${f.verdict.quotes.map((x) => `${x.path}:${x.line}`).join(", ")}.` : ""}`),
    ...i.records.filter((r) => r.findings.some((f) => f.notes.some((n) => n.startsWith("merged")))).map((r) => `The ${r.aspect} pass merged comments on overlapping lines into one finding.`),
    ...(i.scope.mode === "large" ? [`Large pull request: only the files of ${i.scope.areas.map((a) => a.id).join(", ")} were reviewed; the other areas were not.`] : []),
  ];
  // The recommendation (design §10.3): request-changes needs a proven P0 or P1; approve only when nothing is open.
  const blocking = comments.some((c) => c.proof?.state === "proven" && (c.severity === "P0" || c.severity === "P1"));
  const open = comments.length > 0 || judgment.length > 0 || q.selected.length > 0;
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
  const review: ReviewDoc = {
    scope: { mode: i.scope.mode, source: i.scope.source, areas: i.scope.areas, files: i.scope.files.length },
    context: i.scope.context,
    aspects: views,
    findings,
  };
  const summary = summaryText(i.scope, confirmed.filter((f) => f.principle !== undefined), views, comments, judgment, q.selected.length, dismissed.length, recommended);
  return {
    schema: DRAFT_SCHEMA,
    pull: i.pull,
    head: i.head,
    ...(i.base !== undefined ? { base: i.base } : {}),
    verdict: recommended === "approve" ? "comment" : recommended,
    recommended,
    summary,
    comments: [...comments, ...q.selected],
    judgment,
    notSelected: q.rest,
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

function summaryText(scope: ScopeRecord, principled: readonly Finding[], aspects: readonly AspectView[], comments: readonly DraftEntry[], judgment: readonly DraftEntry[], questions: number, dismissed: number, recommended: Verdict): string {
  const confirmed = aspects.reduce((n, a) => n + a.confirmed, 0);
  const text = [
    `Reviewed ${scopeLine(scope)} for ${ASPECTS.join(", ")}, with every finding verified by an independent reader.`,
    `${confirmed} finding${confirmed === 1 ? "" : "s"} confirmed: ${comments.filter((c) => c.kind === "finding").length} drafted as comments, ${comments.filter((c) => c.proof?.state === "proven").length} of them proven by a failing test the graph ran, ${judgment.filter((j) => j.proof?.state === "unproven").length} confirmed but unproven (each says why).`,
    ...(principled.length > 0 ? [`Confirmed breaks of the project's design principles: ${principled.map((f) => `${f.id} breaks ${f.principle}`).join(", ")}.`] : []),
    `${judgment.filter((j) => j.reason?.startsWith("disputed")).length} disputed, ${dismissed} dismissed, ${questions} question${questions === 1 ? "" : "s"} for the author.`,
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
  const head = [e.id, e.kind === "question" ? "question" : e.reason === undefined ? e.severity ?? "" : "", ...(e.aspects.length > 0 ? [e.aspects.join(", ")] : []), ...(e.principle !== undefined ? [`breaks principle ${e.principle}`] : []), ...(e.proof?.state === "non-behavioral" ? ["non-behavioral"] : []), ...(e.reason !== undefined ? [e.reason] : []), `${e.path}:${lines(e)}`, e.side].filter((x) => x !== "");
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
  const findings = d.comments.filter((c) => c.kind === "finding");
  const questions = d.comments.filter((c) => c.kind === "question");
  const out: string[] = [
    `# Review of ${d.pull.owner}/${d.pull.repo}#${d.pull.number} at ${d.head.slice(0, 12)}`,
    `Verdict: ${d.verdict}        <!-- recommended: ${d.recommended} -->`,
    "",
    "## Summary",
    d.summary,
    "",
    "## Comments",
  ];
  for (const a of DRAFT_ORDER) {
    const mine = findings.filter((c) => c.aspects[0] === a);
    if (mine.length === 0) continue;
    out.push(`### ${aspectTitle(a)}`, ...mine.flatMap((e) => entryMarkdown(e, "####")));
  }
  if (findings.length === 0) out.push("No finding is drafted as a comment.");
  if (questions.length > 0) out.push("### Questions", ...questions.flatMap((e) => entryMarkdown(e, "####")));
  out.push("", "## Needs your judgment (move an entry into Comments to post it)");
  if (d.judgment.length === 0) out.push("None.");
  for (const e of d.judgment) out.push(...entryMarkdown(e, "###"));
  out.push("", "## Not selected (move an entry into Comments to post it)");
  if (d.notSelected.length === 0) out.push("None.");
  for (const e of d.notSelected) out.push(...entryMarkdown(e, "###"));
  out.push("", "## For the maintainer (never posted)", ...d.maintainer.map((m) => `- ${m}`), "");
  return out.join("\n");
}

// ---- review.md: the Review section and its appendix part ----

const countBy = (fs: readonly Finding[], state: Finding["state"]): number => fs.filter((f) => f.state === state).length;

const findingLine = (f: Finding, reviewerOf: (a: Aspect) => string): string => {
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
    `Findings: ${countBy(d.review.findings, "confirmed")} confirmed, ${countBy(d.review.findings, "disputed")} disputed, ${countBy(d.review.findings, "dismissed")} dismissed; ${d.comments.filter((c) => c.kind === "question").length} question(s) for the author.`,
  ];
  for (const sev of SEVERITIES) {
    const at = f.filter((x) => x.severity === sev);
    if (at.length === 0) continue;
    out.push("", `### ${sev} (${at.length})`, ...at.map((x) => `- ${findingLine(x, verifier)}`));
  }
  if (f.length === 0) out.push("", "No finding survived verification.");
  out.push("");
  return out.join("\n");
}

/** The appendix part: every finding in full with its verdict and the draft. */
export function reviewAppendixMarkdown(d: Draft): string {
  const out = ["## Review: findings and draft", "", "### Findings"];
  for (const f of d.review.findings) {
    out.push(`#### ${f.id} · ${f.aspect} · ${f.severity} · ${f.kind} · ${f.state}${f.principle !== undefined ? ` · breaks principle ${f.principle}` : ""}`, `${f.path}:${f.startLine}-${f.endLine} (${f.side === "RIGHT" ? "head" : "base"}), raised in pass ${f.pass} of the ${f.raisedBy} sweep.`, f.content);
    if (f.evidence !== "") out.push(`The reviewer read: ${f.evidence}`);
    if (f.verdict !== undefined) out.push(`Verifier: ${f.verdict.verdict}${f.verdict.witness !== "" ? ` at ${f.verdict.witness}` : ""}: ${f.verdict.reason}${f.verdict.quotes.length > 0 ? ` Quotes: ${f.verdict.quotes.map((q) => `${q.path}:${q.line} "${clip(oneLine(q.text), 80)}"`).join("; ")}.` : ""}`);
    if (f.notes.length > 0) out.push(`Notes: ${f.notes.join("; ")}.`);
    out.push("");
  }
  if (d.review.findings.length === 0) out.push("None raised.", "");
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
