// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The HTML report (design §6.11): `review.html`, a one-page briefing, and `review-appendix.html`, everything else, two
 * self-contained files rendered by plugin code from `report.json`, `qa.json`, `necessity.json` and the measurement
 * records, at the points `review.md` is written. No model writes
 * HTML: the only markup of a model's it holds is the `<svg>` of a diagram the diagram-design skill drew, which
 * `diagramsvg.ts` re-serialized from an allow-list (design §6.10). Everything that came from a model or the pull request is escaped; the file has inline CSS and inline SVG,
 * no script, no external stylesheet, image or font, and its only links are `href`s to the pull request, its commits
 * and its files on GitHub at the pinned head and base, and to the other of the two report files. `htmlProblems` enforces that on the written bytes.
 */
import { CHECK_LISTS, CHECK_TITLES, type Bullet, type FinalBriefing, type FinalFeature } from "./briefing.js";
import { featureSvg } from "./flowlayout.js";
import { stateIds, type DiagramsDoc, type DrawnDiagram } from "./diagrams.js";
import type { FinalItem, RemovedItem, RemovedPart, StateEntry } from "./report.js";
import { describeChecks } from "./report.js";
import { clip, esc } from "./escape.js";
import { changeMapSvg, crapBarSvg, stateDiagramSvg, type BarRow } from "./htmlsvg.js";
import { brokenNote, effectiveConclusion, NECESSITY_ID, parseNecessityRecord, SKIPPED_NOTE, type NecessityRecord } from "./necessity.js";
import { DIVE_COLUMNS, DIVE_COMMAND, DIVE_HEADING, DIVE_LINE, DIVE_TEXT, diveRow } from "./dive.js";
import { hotspots, hotspotText, needAuthor, openQuestions, SCOPE_KINDS, SCOPE_TITLES, scopeText, type Scope } from "./scope.js";
import { describeReasons, type ModeReason } from "./mode.js";
import { exceeds, LIMITS, originOf, type Metric } from "./metrics/crap.js";
import { draftMarkdown, parseDraft, scopeLine, type Draft } from "./draft.js";
import { proofOf } from "./proof.js";
import { SEVERITIES, type Finding } from "./review.js";
import type { MetricsRecord } from "./metrics/record.js";
import { isTestPath } from "./metrics/record.js";
import { searchWhere, type MeasuredSearch } from "./searches.js";
import { VISUAL_CSS, visualHeader, visualSections, type VisualLinks } from "./visual.js";

// ---- the documents it renders ----

export interface ReportDoc {
  pull: { owner: string; repo: string; number: number; head: string; base?: string; title: string; url?: string; author?: string | null };
  files: Array<{ path: string; previousPath?: string | null; status?: string | null; additions: number; deletions: number }>;
  commits: number;
  checks: Array<{ name?: string; status: string | null; conclusion: string | null }>;
  mode: "standard" | "large";
  modeReasons?: ModeReason[];
  areas?: Array<{ id: string; name: string; kind: "read" | "generated"; paths: string[]; bytes?: number; additions?: number; deletions?: number; items?: number; removed?: number }>;
  summary: { purpose: { text: string; source: "stated" | "inferred"; quote: string } | null; overview: string | null };
  sections: Array<{ id: string; title: string; none: boolean; items: FinalItem[] }>;
  notes: string[];
  removed: RemovedItem[];
  removedParts: RemovedPart[];
  /** The briefing fields the claim check left standing (design §6.1). */
  briefing: FinalBriefing;
  /** The lines added and deleted by kind of file, counted by plugin code (design §6.1). */
  scope: Scope;
  /** The drawings of the diagram job (design §6.10): the skill's embedded SVGs, or the plugin's note. */
  diagrams?: DiagramsDoc;
  measurements: { tools?: string; coverage?: string[]; mutation?: string; records?: MetricsRecord[]; none?: string };
}

interface QaAnswer {
  answer: string;
  status: string;
  none_found?: boolean;
  citations?: Array<{ path: string; tree: string; start: number; end: number; quote: string }>;
  searches?: MeasuredSearch[];
  inventory?: Array<{ name: string; version: string }>;
  metrics?: Array<{ function: string; path: string; name: string; value: number }>;
  proposal?: { kind: string; splits?: Array<{ name: string; startLine: number; endLine: number; responsibility: string }>; testFile?: string; testName?: string; cases?: Array<{ input: string; branches: string }>; assertion?: string };
  check?: { verdict: string; note: string; searches?: MeasuredSearch[] };
  notes?: string[];
  history?: Array<{ answer: string; status: string }>;
}

export interface QaDoc {
  mode?: string;
  modeReasons?: ModeReason[];
  necessity?: { skipped?: boolean; note?: string };
  /** The operator chose `rounds: review-only` (design §3.2): no question was asked or answered, and the pages say so. */
  roundsSkipped?: { reason: string; note: string };
  questions: Array<{ id: string; type: string; item: string; symbol?: string; function?: string; text: string; origin: string; answer?: QaAnswer }>;
}

export interface HtmlInput {
  report: ReportDoc;
  /** Absent while the Q&A is pending (the Report stage). */
  qa?: QaDoc;
  /** Absent while N1 is pending. */
  necessity?: NecessityRecord;
  /** The draft review with the ledger it was composed from: present once the review layer has run. */
  review?: Draft;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** `report.json` as the document the renderer reads, or undefined when it is not one. */
export function parseReportDoc(json: string): ReportDoc | undefined {
  try {
    const v: unknown = JSON.parse(json);
    if (!isObject(v) || v.schema !== "pr-change-report-v1" || !isObject(v.pull) || !Array.isArray(v.sections) || !Array.isArray(v.files)) return undefined;
    return v as unknown as ReportDoc;
  } catch {
    return undefined;
  }
}

/** `qa.json` as the document the renderer reads. */
export function parseQaDoc(json: string): QaDoc | undefined {
  try {
    const v: unknown = JSON.parse(json);
    return isObject(v) && v.schema === "pr-qa-v1" && Array.isArray(v.questions) ? (v as unknown as QaDoc) : undefined;
  } catch {
    return undefined;
  }
}

// ---- links ----

interface Github {
  owner: string;
  repo: string;
  head: string;
  base?: string | undefined;
  number: number;
}

const root = (g: Github): string => `https://github.com/${g.owner}/${g.repo}`;
const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

const pullHref = (g: Github): string => `${root(g)}/pull/${g.number}`;
const commitHref = (sha: string, g: Github): string => `${root(g)}/commit/${sha}`;

/** A file at the pinned head or base, with its lines; a tree with no pinned commit is not linked. */
function blobHref(g: Github, tree: "head" | "base", path: string, start: number, end: number): string | undefined {
  const sha = tree === "head" ? g.head : g.base;
  if (sha === undefined || !/^[0-9a-f]{7,64}$/.test(sha)) return undefined;
  const lines = start >= 1 ? `#L${start}${end > start ? `-L${end}` : ""}` : "";
  return `${root(g)}/blob/${sha}/${encodePath(path)}${lines}`;
}

function link(href: string | undefined, text: string): string {
  return href === undefined ? `<code>${esc(text)}</code>` : `<a href="${esc(href)}"><code>${esc(text)}</code></a>`;
}

function citeLink(g: Github, c: { path: string; side?: string; tree?: string; start: number; end: number }): string {
  const lines0 = c.start >= 1 ? (c.start === c.end ? `:${c.start}` : `:${c.start}-${c.end}`) : "";
  // Dependency source is not in the reviewed repository: named as such, never linked into it.
  if ((c.side ?? c.tree) === "dependency") return `<code>${esc(`${c.path}${lines0}`)}</code> <span class="muted">(dependency)</span>`;
  const tree = (c.side ?? c.tree) === "base" ? "base" : "head";
  const lines = c.start >= 1 ? (c.start === c.end ? `:${c.start}` : `:${c.start}-${c.end}`) : "";
  return link(blobHref(g, tree, c.path, c.start, c.end), `${c.path}${lines}${tree === "base" ? " (base)" : ""}`);
}

// ---- pieces ----

const badge = (cls: string, text: string): string => `<span class="badge ${cls}">${esc(text)}</span>`;
const CONCLUSION_CLASS: Record<string, string> = { necessary: "ok", questionable: "warn", unnecessary: "bad", "needs author": "grey" };
const STATUS_CLASS: Record<string, string> = { answered: "ok", "partially answered": "warn", "needs author": "bad" };
const VERDICT_CLASS: Record<string, string> = { preserves: "ok", breaks: "bad", "not-applicable": "grey", supported: "ok", partial: "warn", unsupported: "bad" };

function details(summary: string, body: string, open = false, cls = "", id = ""): string {
  return `<details${id !== "" ? ` id="${esc(id)}"` : ""}${open ? " open" : ""}${cls !== "" ? ` class="${cls}"` : ""}><summary>${summary}</summary><div class="body">${body}</div></details>`;
}

const para = (text: string): string => `<p>${esc(text)}</p>`;

// ---- the review layer (design §8, §10) ----

const STATE_CLASS: Record<string, string> = { confirmed: "bad", disputed: "warn", dismissed: "grey", pending: "grey" };

/** A finding that could block a merge: P0 or P1 that stands (confirmed, or still disputed). These are open by default. */
const isBlocking = (f: Finding): boolean => (f.state === "confirmed" || f.state === "disputed") && (f.severity === "P0" || f.severity === "P1");

function findingHtml(f: Finding, d: Draft, g: Github, full: boolean): string {
  const proof = proofOf(f);
  const verifier = d.review.aspects.find((a) => a.aspect === f.raisedBy)?.verifier ?? "?";
  const cite = citeLink(g, { path: f.path, side: f.side === "RIGHT" ? "head" : "base", start: f.startLine, end: f.endLine });
  const summary = `<span class="rid">${esc(f.id)}</span> ${badge("grey", f.aspect)} ${badge(STATE_CLASS[f.state] ?? "grey", f.state)} ${badge(proof.state === "unproven" ? "warn" : "ok", proof.state === "unproven" ? "unproven" : proof.state)} ${f.principle !== undefined ? `${badge("bad", `breaks principle ${f.principle}`)} ` : ""}${esc(clip(f.content.replace(/\s+/g, " "), 140))} <span class="muted">${cite}</span>`;
  const body = [
    `<p>${esc(f.content)}</p>`,
    f.evidence !== "" ? `<p class="muted">The reviewer read: ${esc(f.evidence)}</p>` : "",
    f.verdict !== undefined
      ? `<p>Checker (${esc(verifier)}): <strong>${esc(f.verdict.verdict)}</strong>${f.verdict.witness !== "" ? ` at <code>${esc(f.verdict.witness)}</code>` : ""}: ${esc(f.verdict.reason)}${f.verdict.quotes.length > 0 ? ` Quotes: ${f.verdict.quotes.map((q) => `<code>${esc(`${q.path}:${q.line}`)}</code> <q>${esc(clip(q.text.replace(/\s+/g, " "), 100))}</q>`).join("; ")}.` : ""}</p>`
      : "",
    proof.state === "unproven" ? `<p class="muted">Unproven: ${esc(proof.reason)}; it is listed for your judgment and never drafted as P0 or P1.</p>` : "",
    proof.state === "proven" && f.proof?.state === "proven" ? `<p>${esc(proof.summary)}: it failed in both runs${f.proof.record.at !== undefined ? ` at <code>${esc(f.proof.record.at)}</code>` : ""}${f.proof.record.failure !== undefined ? `: ${esc(f.proof.record.failure.replace(/\s+/g, " ").slice(0, 300))}` : ""}.</p>` : "",
    full && f.repro !== undefined && f.repro.text.trim() !== "" ? `<p>The test (${esc(f.repro.name)}, in <code>${esc(f.repro.dir)}</code>; expected value from: ${esc(f.repro.oracle)}):</p><pre><code>${esc(f.repro.text)}</code></pre>` : "",
    f.notes.length > 0 ? `<p class="muted">${esc(f.notes.join("; "))}.</p>` : "",
    full && f.suggestion.trim() !== "" ? `<p>Suggestion:</p><pre><code>${esc(f.suggestion)}</code></pre>` : "",
  ].join("");
  return details(summary, body, isBlocking(f), "qa", full ? `f-${f.id}` : "");
}

/** The Review part of the briefing: the findings by severity with counts, each collapsed except the blocking ones. */
function reviewHtml(d: Draft | undefined, g: Github): string {
  if (d === undefined) return "";
  const live = d.review.findings.filter((f) => f.state !== "dismissed");
  const counts = `${d.review.findings.filter((f) => f.state === "confirmed").length} confirmed · ${d.review.findings.filter((f) => f.state === "disputed").length} disputed · ${d.review.findings.filter((f) => f.state === "dismissed").length} dismissed`;
  const groups = SEVERITIES.flatMap((sev) => {
    const at = live.filter((f) => f.severity === sev);
    return at.length === 0 ? [] : [`<h3>${esc(sev)} <span class="muted">(${at.length})</span></h3>${at.map((f) => findingHtml(f, d, g, false)).join("")}`];
  });
  const body = [
    `<p>Recommended verdict: <strong>${esc(d.recommended)}</strong>${d.recommended === "approve" ? " (drafted as comment)" : ""}. Scope: ${esc(scopeLine({ source: d.review.scope.source as never, areas: d.review.scope.areas, files: { length: d.review.scope.files } }))}. The draft is draft.md in .graphloom/review/; the Publish stage posts its comments.</p>`,
    `<p class="muted">${esc(counts)} · ${d.comments.filter((c) => c.kind === "question").length} question(s) for the author. ${esc(d.review.context.reason[0]!.toUpperCase() + d.review.context.reason.slice(1))}.</p>`,
    ...(groups.length === 0 ? [para("No finding survived verification.")] : groups),
    ...(d.judgment.length > 0 ? [para(`${d.judgment.length} finding(s) need your judgment: confirmed but not proven by a test, or disputed. The appendix lists them with the draft.`)] : []),
  ].join("");
  return details(`<h2>Review</h2> ${badge(d.recommended === "request-changes" ? "bad" : d.recommended === "comment" ? "warn" : "ok", d.recommended)}`, body, true, "sec");
}

/** The appendix's Review part: every finding in full, with its verdict, and the draft. */
function reviewAppendixHtml(d: Draft | undefined, g: Github): string {
  if (d === undefined) return "";
  const aspects = d.review.aspects.map((a) => `<tr><td>${esc(a.aspect)}</td><td>${esc(a.reviewer)}</td><td>${esc(a.verifier)}</td><td>${a.passes}${a.unsaturated ? " (not saturated)" : ""}</td><td>${a.confirmed}</td><td>${a.disputed}</td><td>${a.dismissed}</td><td>${a.nits}</td></tr>`).join("");
  const body = [
    `<h3>Aspects</h3><div class="scroll"><table><thead><tr><th>Aspect</th><th>Reviewer</th><th>Verifier</th><th>Passes</th><th>Confirmed</th><th>Disputed</th><th>Dismissed</th><th>Nits not verified</th></tr></thead><tbody>${aspects}</tbody></table></div>`,
    `<h3>Findings</h3>${d.review.findings.length === 0 ? para("None raised.") : d.review.findings.map((f) => findingHtml(f, d, g, true)).join("")}`,
    `<h3>Draft</h3><pre><code>${esc(draftMarkdown(d))}</code></pre>`,
  ].join("");
  return details("<h2>Review: findings and draft</h2>", body, false, "sec");
}

// ---- header ----

const APPENDIX_HREF = "review-appendix.html";
const REVIEW_HREF = "review.html";

function headerHtml(i: HtmlInput, g: Github, nav: string): string {
  const r = i.report;
  const added = r.files.reduce((n, f) => n + f.additions, 0);
  const deleted = r.files.reduce((n, f) => n + f.deletions, 0);
  const mode = r.mode === "large" ? `large: ${describeReasons(r.modeReasons ?? [])}` : "standard";
  const checks = describeChecks(r.checks);
  return [
    `<header class="top"><h1>${esc(`${r.pull.owner}/${r.pull.repo}#${r.pull.number}`)} <span class="title">${esc(r.pull.title)}</span></h1>`,
    `<p class="sub">${r.pull.author !== undefined && r.pull.author !== null ? `by ${esc(r.pull.author)} · ` : ""}<a href="${esc(pullHref(g))}">pull request</a> · head <a href="${esc(commitHref(r.pull.head, g))}"><code>${esc(r.pull.head.slice(0, 12))}</code></a>${r.pull.base !== undefined ? ` · base <a href="${esc(commitHref(r.pull.base, g))}"><code>${esc(r.pull.base.slice(0, 12))}</code></a>` : ""}</p>`,
    `<p class="sub">${r.files.length} files · <span class="plus">+${added}</span> <span class="minus">−${deleted}</span> · ${r.commits} commits · GitHub checks: ${esc(checks)} · mode: ${esc(mode)} · ${nav}</p>`,
    `</header>`,
  ].join("\n");
}

// ---- necessity ----

function necessityHtml(n: NecessityRecord | undefined, g: Github, skipped?: QaDoc["roundsSkipped"]): string {
  if (n === undefined && skipped !== undefined) return details(`<h2>Necessity</h2> ${badge("grey", "skipped")}`, para(skipped.note), true, "sec");
  if (n === undefined) return details(`<h2>Necessity</h2> ${badge("grey", "pending")}`, para("N1, the necessity question, is asked after the report; this file is rewritten when it is answered."), false, "sec");
  const a = n.final;
  const nec = a.necessity!;
  const conclusion = effectiveConclusion(a);
  const check = a.check.verdict === "downgraded" ? `downgraded to needs author${a.check.note !== "" ? ` (${a.check.note})` : ""}` : `${a.check.verdict}${a.check.note !== "" ? `: ${a.check.note}` : ""}`;
  const cite = (c: { path: string; tree: string; start: number; end: number; quote: string }): string => `${citeLink(g, c)} <q>${esc(clip(c.quote, 200))}</q>`;
  const principles = n.principles;
  const checks = new Map((a.check.principles ?? []).map((c) => [c.id, c] as const));
  const principleBlock =
    principles === undefined
      ? ""
      : principles.file === "absent"
        ? para(`No principles file at ${principles.ref ?? principles.commit.slice(0, 12)}:${principles.path}.`)
        : [
            `<h4>Design principles</h4>`,
            para(`${principles.path} at ${principles.commit.slice(0, 12)}${principles.ref !== undefined ? ` (${principles.ref})` : ""}`),
            nec.principles.length === 0 ? para("No principle applies to this change.") : "",
            `<ul class="plain">`,
            ...nec.principles.map((p) => {
              const c = checks.get(p.id);
              return `<li>${badge(VERDICT_CLASS[p.verdict] ?? "grey", p.verdict)} <strong>${esc(p.id)}</strong> ${esc(clip(p.explanation, 400))} ${p.citations.map(cite).join(" ")}${c !== undefined ? ` <span class="muted">checker: ${badge(VERDICT_CLASS[c.verdict] ?? "grey", c.verdict)}${c.note !== "" ? ` ${esc(clip(c.note, 200))}` : ""}</span>` : ""}</li>`;
            }),
            `</ul>`,
            principles.principles.some((p) => !p.applicable) ? para(`Principles that did not apply: ${principles.principles.filter((p) => !p.applicable).map((p) => p.id).join(", ")}.`) : "",
            ...principles.notes.map(para),
            principles.changedByPullRequest ? para(`This pull request changes ${principles.path}; it was judged by the version at ${principles.ref ?? principles.commit.slice(0, 12)}.`) : "",
          ].join("");
  const body = [
    `<p class="lead">${badge(CONCLUSION_CLASS[conclusion] ?? "grey", conclusion)} ${esc(nec.rationale)}${brokenNote(a) !== "" ? ` ${esc(brokenNote(a))}` : ""}</p>`,
    para(`Checker: ${check}.${conclusion !== nec.conclusion ? ` The answerer concluded ${nec.conclusion}.` : ""}`),
    `<h3>1. Is the problem real on the base?</h3>`,
    para(`Claimed: ${nec.problem.claim}`),
    nec.problem.quotes.length > 0 ? `<ul class="plain">${nec.problem.quotes.map((q) => `<li><q>${esc(clip(q.quote, 240))}</q> <span class="muted">(pull request ${esc(q.source)})</span></li>`).join("")}</ul>` : "",
    para(`Can the claimed failure happen on the base: ${nec.problem.canHappen}. ${nec.problem.explanation}`),
    nec.problem.trace.length > 0 ? `<ol class="trace">${nec.problem.trace.map((s) => `<li>${esc(s.step)} — ${cite(s)}</li>`).join("")}</ol>` : "",
    para(`Reproduction: ${nec.reproduction}`),
    `<h3>2. Does the fix fit the system's design?</h3>`,
    para(`Effect: ${nec.design.effect}. ${nec.design.explanation}`),
    `<ul class="plain">${nec.design.statements.map((s) => `<li>Design statement: ${cite(s)}</li>`).join("")}${nec.design.changed.map((s) => `<li>Changed lines: ${cite(s)}</li>`).join("")}</ul>`,
    principleBlock,
    `<h3>3. Is there a simpler or existing way?</h3>`,
    para(`${nec.alternatives.exists ? "Yes" : "None found"}. ${nec.alternatives.explanation}`),
    nec.alternatives.citations.length > 0 ? `<ul class="plain">${nec.alternatives.citations.map((s) => `<li>${cite(s)}</li>`).join("")}</ul>` : "",
    n.decision.action === "ask-all" && n.decision.override === true ? para("Override: the operator asked for every question, so none was skipped.") : "",
    ...(a.notes.length > 0 ? [para(`Note: ${a.notes.join("; ")}.`)] : []),
  ].join("\n");
  // The briefing's open questions link N1 here (`#q-N1`), as they link every other question to its answer.
  return details(`<h2>Necessity</h2> ${badge(CONCLUSION_CLASS[conclusion] ?? "grey", conclusion)}`, body, true, "sec", `q-${NECESSITY_ID}`);
}

// ---- briefing ----

const citesHtml = (cites: readonly Bullet["cites"][number][], g: Github): string => `<span class="cites">${cites.map((c) => citeLink(g, c)).join(" ")}</span>`;

function purposeHtml(r: ReportDoc): string {
  const why = (id: string): string => clip(r.removedParts.find((p) => p.id === id)?.reason ?? "", 200);
  const p = r.summary.purpose;
  return p === null
    ? para(`Purpose: not given; the claim check could not support it (${why("purpose")}).`)
    : `<p class="lead"><strong>Purpose</strong> ${badge(p.source === "stated" ? "ok" : "grey", p.source)} ${esc(p.text)}${p.source === "stated" ? ` <span class="muted">“${esc(clip(p.quote, 240))}”</span>` : ""}</p>`;
}

function overviewHtml(r: ReportDoc): string {
  const why = (id: string): string => clip(r.removedParts.find((p) => p.id === id)?.reason ?? "", 200);
  return r.summary.overview === null ? para(`Overview: not given; the claim check could not support it (${why("overview")}).`) : `<p><strong>Overview</strong> ${esc(r.summary.overview)}</p>`;
}

function whatsNewHtml(b: FinalBriefing, g: Github): string {
  return b.whatsNew.length === 0 ? para("None stated.") : `<ul class="plain new">${b.whatsNew.map((w, n) => `<li id="W${n + 1}"><span class="rid">W${n + 1}</span> ${esc(w.text)} ${citesHtml(w.cites, g)}</li>`).join("")}</ul>`;
}

function scopeHtml(sc: Scope): string {
  const total = SCOPE_KINDS.reduce((n, k) => ({ files: n.files + sc[k].files, added: n.added + sc[k].added, deleted: n.deleted + sc[k].deleted }), { files: 0, added: 0, deleted: 0 });
  const rows = SCOPE_KINDS.map((k) => `<tr><th>${esc(SCOPE_TITLES[k])}</th><td>${sc[k].files}</td><td class="plus">+${sc[k].added}</td><td class="minus">−${sc[k].deleted}</td></tr>`);
  return `<table class="scope"><thead><tr><th></th><th>Files</th><th>Added</th><th>Deleted</th></tr></thead><tbody>${rows.join("")}<tr class="total"><th>Total</th><td>${total.files}</td><td class="plus">+${total.added}</td><td class="minus">−${total.deleted}</td></tr></tbody></table>`;
}

/** N1's conclusion, the principles touched with their verdicts (design §7.5.1), and how many questions need the author. */
function verdictHtml(i: HtmlInput): string {
  const n = i.necessity;
  const conclusion = n !== undefined ? effectiveConclusion(n.final) : undefined;
  const principles = n?.final.necessity?.principles ?? [];
  const asked = (i.qa?.questions ?? []).filter((q) => q.id !== NECESSITY_ID);
  const need = needAuthor(asked);
  const skipped = i.qa?.roundsSkipped;
  if (skipped !== undefined) {
    return [`<div class="verdict">`, `<div><span class="label">N1: is it necessary?</span> ${badge("grey", "skipped")}</div>`, `<div><span class="label">Questions and answers</span> ${badge("grey", "skipped")} <span class="muted">by the operator's choice (${esc(skipped.reason)})</span></div>`, `</div>`].join("");
  }
  return [
    `<div class="verdict">`,
    `<div><span class="label">N1: is it necessary?</span> ${conclusion === undefined ? badge("grey", "pending") : badge(CONCLUSION_CLASS[conclusion] ?? "grey", conclusion)}</div>`,
    `<div><span class="label">Principles touched</span> ${n === undefined ? badge("grey", "pending") : principles.length === 0 ? `<span class="muted">none</span>` : principles.map((p) => `<span title="${esc(clip(p.explanation, 200))}">${badge(VERDICT_CLASS[p.verdict] ?? "grey", `${p.id}: ${p.verdict}`)}</span>`).join(" ")}</div>`,
    `<div><span class="label">Questions that need the author</span> ${i.qa === undefined ? badge("grey", "pending") : badge(need > 0 ? "bad" : "ok", String(need))}</div>`,
    `</div>`,
  ].join("");
}

function briefingHtml(i: HtmlInput, g: Github): string {
  const r = i.report;
  const body = [purposeHtml(r), `<h3>What's new</h3>`, whatsNewHtml(r.briefing, g), `<h3>Scope that matters</h3>`, scopeHtml(r.scope), `<h3>Verdict</h3>`, verdictHtml(i)].join("");
  return details("<h2>Briefing</h2>", body, true, "sec");
}

/** A drawing of the skill (inline, in its scrolling wrapper), or the plugin's own with the note of why (design §6.10, §6.11). */
function drawing(d: DrawnDiagram | undefined, own: () => string): { svg: string; note: string } {
  if (d?.via === "diagram-design") return { svg: d.svg, note: "" };
  return { svg: own(), note: d?.via === "plugin" ? para(d.note) : "" };
}

function featureHtml(f: FinalFeature, d: DrawnDiagram | undefined, g: Github, uid: string): string {
  const { svg, note } = drawing(d, () => featureSvg(f, uid));
  const label = new Map(f.stages.map((s) => [s.id, s.label] as const));
  return [
    `<div class="feature" id="${esc(f.id)}"><h4><span class="rid">${esc(f.id)}</span> ${esc(f.name)}</h4>`,
    `<p>${esc(f.summary)}</p>`,
    note,
    `<div class="scroll">${svg}</div>`,
    `<details class="steps"><summary>Stages and flows, with their cites</summary><ul class="plain">${f.stages.map((s) => `<li>${esc(s.label)} <span class="muted">(${esc(s.kind)})</span> ${citeLink(g, s.cite)}</li>`).join("")}${f.flows.map((fl) => `<li>${esc(label.get(fl.from) ?? fl.from)} → ${esc(label.get(fl.to) ?? fl.to)}: ${esc(fl.label)} ${citeLink(g, fl.cite)}</li>`).join("")}</ul></details>`,
    `</div>`,
  ].join("");
}

function featuresHtml(r: ReportDoc, g: Github): string {
  const fs = r.briefing.features;
  const body = fs.length === 0 ? para("None: the report names no new feature with a data path.") : fs.map((f, k) => featureHtml(f, r.diagrams?.features[f.id], g, `fl${k + 1}`)).join("");
  return details(`<h2>Data flow per new feature</h2> <span class="muted">${fs.length} feature${fs.length === 1 ? "" : "s"}</span>`, body, true, "sec");
}

function checkHtml(b: FinalBriefing, g: Github): string {
  const lists = CHECK_LISTS.map((l) => `<h4>${esc(CHECK_TITLES[l])}</h4>${b.check[l].length === 0 ? para("None.") : `<ul class="plain">${b.check[l].map((e) => `<li>${esc(e.text)} ${citesHtml(e.cites, g)}</li>`).join("")}</ul>`}`);
  return details("<h2>What you need to check</h2>", lists.join(""), true, "sec");
}

function hotspotsHtml(r: ReportDoc, g: Github): string {
  const m = r.measurements;
  if (m.none !== undefined) return details("<h2>Hotspots</h2>", para(m.none === "not measured" ? "Not measured: the static metrics did not complete." : `No function is measured: ${m.none}.`), true, "sec");
  const top = hotspots(m.records ?? []);
  const body = top.length === 0 ? para("No production function added or modified.") : `<ol class="plain">${top.map((h) => `<li>${esc(hotspotText(h))} ${link(blobHref(g, "head", h.path, h.startLine, h.startLine), `${h.path}:${h.startLine}`)}</li>`).join("")}</ol>`;
  return details("<h2>Hotspots</h2>", `${para("The five functions with the highest CRAP, then complexity. The full table is in the appendix.")}${body}`, true, "sec");
}

/** The areas of a large report, one line each; for any other report the sections and how many items each holds (design §6.1). */
function areasHtml(r: ReportDoc): string {
  const labels = new Map(r.briefing.areas.map((a) => [a.id, a.label] as const));
  const areas = r.mode === "large" ? (r.areas ?? []) : [];
  if (areas.length > 1) {
    const rows = areas.map((a) => `<tr>${diveRow(a, labels.get(a.id)).map((cellValue) => `<td>${esc(cellValue)}</td>`).join("")}</tr>`);
    const body = [para(DIVE_TEXT), `<pre><code>${esc(DIVE_COMMAND)}</code></pre>`, `<div class="scroll"><table class="dive"><thead><tr>${DIVE_COLUMNS.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`].join("");
    return details(`<h2>Areas</h2> <span class="muted">${esc(DIVE_HEADING.toLowerCase())}</span>`, body, true, "sec");
  }
  const sections = r.sections.filter((s) => s.id !== "measurements" && s.items.length > 0);
  const list = sections.length === 0 ? para("No change item.") : `<ul class="plain">${sections.map((s) => `<li>${esc(s.title)}: ${s.items.length} item${s.items.length === 1 ? "" : "s"}</li>`).join("")}</ul>`;
  return details("<h2>Areas</h2>", `${list}${para(DIVE_LINE)}<pre><code>${esc(DIVE_COMMAND)}</code></pre>`, true, "sec");
}

/** Only the questions that need a person; answered ones are a count, with a link to the appendix. */
function openQuestionsHtml(i: HtmlInput): string {
  const qa = i.qa;
  if (qa === undefined) return details(`<h2>Open questions</h2> ${badge("grey", "pending")}`, para("The Questions and Answers stages follow the report; this file is rewritten when the answers are checked."), true, "sec");
  if (qa.roundsSkipped !== undefined) return details(`<h2>Open questions</h2> ${badge("grey", "skipped")}`, para(qa.roundsSkipped.note), true, "sec");
  const n1 = i.necessity !== undefined ? effectiveConclusion(i.necessity.final) : undefined;
  const sel = openQuestions(qa.questions, { id: NECESSITY_ID, conclusion: n1 });
  const rows = sel.open.map((q) => {
    const status = q.answer?.status ?? "not answered";
    return `<li><a href="${APPENDIX_HREF}#q-${esc(q.id)}"><strong>${esc(q.id)}</strong></a> <span class="muted">[${esc(q.type)}]</span> ${badge(STATUS_CLASS[status] ?? "grey", status)} ${esc(clip(q.text, 200))}${q.answer !== undefined ? ` <div class="muted">${esc(clip(q.answer.answer, 240))}</div>` : ""}</li>`;
  });
  const body = [
    sel.open.length === 0 ? para("No question needs a person.") : `<ul class="plain open">${rows.join("")}</ul>`,
    para(`${sel.answered} answered — see the appendix.`),
  ].join("");
  return details(`<h2>Open questions</h2> <span class="muted">${sel.open.length} of ${sel.total}</span>`, body, true, "sec");
}

// ---- change map ----

function changeMap(r: ReportDoc): BarRow[] {
  if (r.mode === "large" && r.areas !== undefined && r.areas.length > 0) {
    return r.areas.map((a) => {
      const own = new Set(a.paths);
      const files = r.files.filter((f) => own.has(f.path));
      return { label: `${a.id} ${a.name}`, added: files.reduce((n, f) => n + f.additions, 0), deleted: files.reduce((n, f) => n + f.deletions, 0) };
    });
  }
  const byPath = new Map(r.files.map((f) => [f.path, f] as const));
  return r.sections
    .filter((s) => s.id !== "measurements")
    .map((s) => {
      const paths = new Set(s.items.flatMap((i) => i.cites.map((c) => c.path)));
      const files = [...paths].map((p) => byPath.get(p)).filter((f): f is NonNullable<typeof f> => f !== undefined);
      return { label: s.title, added: files.reduce((n, f) => n + f.additions, 0), deleted: files.reduce((n, f) => n + f.deletions, 0) };
    })
    .filter((row) => row.added + row.deleted > 0);
}

function changeMapHtml(r: ReportDoc): string {
  const rows = changeMap(r);
  const svg = changeMapSvg(rows);
  const note = r.mode === "large" ? "Lines added and deleted per area." : "Lines added and deleted per report section (a file cited in several sections counts in each).";
  return details("<h2>Change map</h2>", svg === "" ? para("No changed lines.") : `${para(note)}<div class="scroll">${svg}</div>`, true, "sec");
}

// ---- report items ----

interface Ctx {
  g: Github;
  files: ReportDoc["files"];
  diagrams: number;
  drawn?: DiagramsDoc | undefined;
}

function stateHtml(e: StateEntry, id: string, c: Ctx): string {
  c.diagrams += 1;
  const { svg, note } = drawing(c.drawn?.states[id], () => stateDiagramSvg(e, `sd${c.diagrams}`));
  return [
    `<div class="state"><h5>${esc(e.name)} <span class="muted">${esc(e.scope)}</span></h5>`,
    note,
    `<div class="scroll">${svg}</div>`,
    e.reads.length > 0 ? `<ul class="plain reads">${e.reads.map((r) => `<li>read ${esc(r.where)}: ${esc(r.decision)} ${citeLink(c.g, r.cite)}</li>`).join("")}</ul>` : "",
    `<details class="steps"><summary>Transitions in words</summary><ul class="plain">${e.transitions.map((t) => `<li>when ${esc(t.when)} → ${esc(t.effect)} ${citeLink(c.g, t.cite)}</li>`).join("")}</ul></details>`,
    `</div>`,
  ].join("");
}

function itemHtml(item: FinalItem, parts: readonly RemovedPart[], c: Ctx): string {
  const own = parts.filter((p) => p.item === item.id);
  const ids = stateIds(item.id, item.state);
  return [
    `<div class="item" id="${esc(item.id)}"><h4><span class="rid">${esc(item.id)}</span>${item.auto !== undefined ? ` ${badge("grey", `plugin-written (${item.auto})`)}` : ""}</h4>`,
    `<p>${esc(item.text)}</p>`,
    `<p class="cites">${item.cites.map((x) => citeLink(c.g, x)).join(" ")}${item.facts.length > 0 ? ` ${item.facts.map((f) => badge("grey", f)).join(" ")}` : ""}</p>`,
    ...item.state.map((e, i) => stateHtml(e, ids[i]!, c)),
    item.behavior.length > 0
      ? `<table class="beh"><thead><tr><th>Case</th><th>Before</th><th>After</th></tr></thead><tbody>${item.behavior.map((b) => `<tr><td>${esc(b.case)}</td><td>${esc(b.before)}</td><td>${esc(b.after)}</td></tr>`).join("")}</tbody></table>`
      : "",
    ...own.map((p) => `<p class="removed">Removed by the claim check: ${p.kind === "state" ? `the lifecycle of ${esc(p.label)}` : `the before/after row “${esc(clip(p.label, 80))}”`} (${esc(clip(p.reason, 200))}).</p>`),
    `</div>`,
  ].join("");
}

function itemsHtml(r: ReportDoc, c: Ctx): string {
  const out: string[] = [];
  for (const s of r.sections) {
    if (s.id === "measurements") continue;
    const body = s.items.length === 0 ? para("None") : s.items.map((i) => itemHtml(i, r.removedParts, c)).join("");
    out.push(details(`<h3>${esc(s.title)}</h3> <span class="muted">${s.items.length} item${s.items.length === 1 ? "" : "s"}</span>`, body, s.items.length > 0, "group"));
  }
  return details("<h2>Change items</h2>", out.join(""), true, "sec");
}

// ---- measurements ----

const pct = (n: number): number => Math.round(n * 1000) / 10;

function metricCell(r: MetricsRecord, metric: Metric, limit: number): { cls: string; text: string } {
  const o = originOf(r, metric);
  const head = r[metric];
  const over = exceeds(metric, head);
  if (r.change === "added") return over ? { cls: "bad", text: `${head} (over the limit of ${limit}; new function)` } : { cls: "ok", text: String(head) };
  if (o.origin === "unknown") return { cls: over ? "bad" : "grey", text: `${head}${over ? ` (over the limit of ${limit})` : ""} (base not measured)` };
  const arrow = `${o.base} → ${head}`;
  if (o.origin === "within") return { cls: "ok", text: arrow };
  if (o.origin === "introduced") return { cls: "bad", text: `${arrow} (over the limit of ${limit}: introduced by the pull request)` };
  return { cls: "bad", text: `${arrow} (over the limit of ${limit} at the base${o.origin === "worse" ? "; inherited, made worse" : "; inherited, not raised"})` };
}

function measurementsHtml(r: ReportDoc): string {
  const m = r.measurements;
  const records = m.records ?? [];
  if (m.none !== undefined) return details("<h2>Measurements</h2>", para(m.none === "not measured" ? "Not measured: the static metrics did not complete." : `No function is measured: ${m.none}.`), false, "sec");
  const maxCrap = Math.max(LIMITS.crap * 2, ...records.map((x) => x.crap ?? 0));
  const rows = records.map((x) => {
    const test = x.test || isTestPath(x.path);
    const complexity = metricCell(x, "complexity", LIMITS.complexity);
    const nesting = metricCell(x, "nesting", LIMITS.nesting);
    const measured = x.coverage?.source === "measured" ? x.coverage : undefined;
    const coverage = test
      ? `<td class="grey">n/a (test file)</td>`
      : measured !== undefined
        ? `<td>${measured.total === 0 ? "100% (no executable statements)" : `${pct(measured.covered / measured.total)}% <span class="muted">(${measured.covered}/${measured.total})</span>`}<div class="bar"><div class="fill" style="width:${measured.total === 0 ? 100 : pct(measured.covered / measured.total)}%"></div></div></td>`
        : `<td class="grey">unknown: ${esc(x.coverage?.source === "unknown" ? clip(x.coverage.reason, 120) : "not run")}</td>`;
    const crap =
      test || x.crap === undefined
        ? `<td class="grey">n/a</td>`
        : `<td class="${x.crap >= LIMITS.crap ? "bad" : "ok"}">${x.crap}${measured !== undefined ? "" : " (upper bound, coverage unknown)"}<div>${crapBarSvg(x.crap, LIMITS.crap, maxCrap)}</div></td>`;
    return `<tr><td><code>${esc(x.function)}</code><div class="muted">${esc(`${x.path}:${x.startLine}`)}</div></td><td>${esc(x.change)}</td><td class="${complexity.cls}">${esc(complexity.text)}</td><td class="${nesting.cls}">${esc(nesting.text)}</td>${coverage}${crap}</tr>`;
  });
  const body = [
    para(`Static metrics, parsed over the head tree, read-only, no network. Limits: complexity < ${LIMITS.complexity}, nesting ≤ ${LIMITS.nesting}; CRAP threshold ${LIMITS.crap} (the dark mark in the bar).`),
    ...(m.coverage ?? []).map(para),
    m.mutation !== undefined ? para(`Mutation: ${m.mutation}.`) : "",
    records.length === 0
      ? para("No function added or modified.")
      : `<div class="scroll"><table class="metrics"><thead><tr><th>Function</th><th>Change</th><th>Complexity (&lt; ${LIMITS.complexity})</th><th>Nesting (≤ ${LIMITS.nesting})</th><th>Coverage</th><th>CRAP (threshold ${LIMITS.crap})</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
  ].join("");
  return details("<h2>Measurements</h2>", body, true, "sec");
}

// ---- Q&A ----

function searchHtml(s: MeasuredSearch): string {
  const hits = (n: number): string => `${n} hit${n === 1 ? "" : "s"}`;
  const result = s.measured === undefined ? `reported ${hits(s.hits)}, not measured` : s.measured === s.hits ? `${hits(s.measured)} (measured)` : `measured ${hits(s.measured)} (reported ${s.hits}: mismatch)`;
  return `<li><code>${esc(clip(s.pattern, 120))}</code> <span class="muted">(${esc(searchWhere(s))}) → ${esc(result)}</span></li>`;
}

function answerHtml(a: QaAnswer, g: Github): string {
  const p = a.proposal;
  const proposal =
    p === undefined || p.kind === "none"
      ? ""
      : p.kind === "split"
        ? `<p>Proposal: ${(p.splits ?? []).map((s) => `<code>${esc(s.name)}</code> (lines ${s.startLine}–${s.endLine}): ${esc(s.responsibility)}`).join("; ")}</p>`
        : p.kind === "test"
          ? `<p>Proposal: <code>${esc(p.testName ?? "")}</code> in ${esc(p.testFile ?? "")}${(p.cases ?? []).length > 0 ? `, cases ${(p.cases ?? []).map((c) => `${esc(c.input)} (${esc(c.branches)})`).join("; ")}` : ""}</p>`
          : `<p>Proposal: ${esc(p.assertion ?? "")}</p>`;
  const check = a.check;
  const verdict = check === undefined ? "" : check.verdict === "downgraded" ? `downgraded to needs author${check.note !== "" ? ` (${check.note})` : ""}` : `${check.verdict}${check.note !== "" ? `: ${check.note}` : ""}`;
  return [
    `<p>${esc(a.answer)}</p>`,
    (a.citations ?? []).length > 0 ? `<p class="cites">Cites ${(a.citations ?? []).map((c) => `${citeLink(g, c)}${c.quote.trim() !== "" ? ` <q>${esc(clip(c.quote, 140))}</q>` : ""}`).join(" ")}</p>` : "",
    (a.searches ?? []).length > 0 ? `<details class="steps"><summary>Searches (${(a.searches ?? []).length})</summary><ul class="plain">${(a.searches ?? []).map(searchHtml).join("")}</ul></details>` : "",
    (a.inventory ?? []).length > 0 ? `<p class="muted">Inventory: ${(a.inventory ?? []).map((d) => esc(`${d.name}@${d.version}`)).join(", ")}</p>` : "",
    (a.metrics ?? []).length > 0 ? `<p class="muted">Metrics: ${(a.metrics ?? []).map((m) => esc(`${m.function} ${m.name} ${m.value}`)).join(", ")}</p>` : "",
    proposal,
    check !== undefined ? `<p class="muted">Checker: ${esc(verdict)}.${(check.searches ?? []).length > 0 ? ` Its own searches: ${(check.searches ?? []).map((s) => esc(clip(s.pattern, 60))).join("; ")}.` : ""}</p>` : "",
    (a.notes ?? []).length > 0 ? `<p class="muted">Note: ${esc((a.notes ?? []).join("; "))}.</p>` : "",
    (a.history ?? []).length > 1 ? `<p class="muted">Statements before the correction: ${(a.history ?? []).map((h, n) => `${n === 0 ? "first" : "corrected"} (${esc(h.status)}): “${esc(clip(h.answer, 160))}”`).join("; ")}.</p>` : "",
  ].join("");
}

function qaHtml(r: ReportDoc, qa: QaDoc | undefined, g: Github): string {
  if (qa === undefined) return details(`<h2>Q&amp;A</h2> ${badge("grey", "pending")}`, para("The Questions and Answers stages follow the report; this file is rewritten when the answers are checked."), false, "sec");
  if (qa.roundsSkipped !== undefined) return details(`<h2>Q&amp;A</h2> ${badge("grey", "skipped")}`, para(qa.roundsSkipped.note), true, "sec");
  if (qa.necessity?.skipped === true) return details("<h2>Q&amp;A</h2>", para(`${NECESSITY_ID} is answered above, under Necessity.`) + para(qa.necessity.note ?? SKIPPED_NOTE), true, "sec");
  const asked = qa.questions.filter((q) => q.id !== NECESSITY_ID);
  const count = (s: string): number => asked.filter((q) => q.answer?.status === s).length;
  // The items the questions are about: the report's, and in a large report the high-level changes (W1…, the briefing's bullets).
  const items = new Map([...r.sections.flatMap((s) => s.items).map((i) => [i.id, i] as const), ...r.briefing.whatsNew.map((w, n) => [`W${n + 1}`, w] as const)]);
  const groups = new Map<string, typeof asked>();
  for (const q of asked) groups.set(q.item, [...(groups.get(q.item) ?? []), q]);
  const body = [
    qa.mode === "large" ? para(`Mode: large (${describeReasons(qa.modeReasons ?? [])}).`) : "",
    para(`${asked.length} question${asked.length === 1 ? "" : "s"}: ${count("answered")} answered, ${count("partially answered")} partially answered, ${count("needs author")} needs author.`),
    ...[...groups].map(([item, qs]) => {
      const it = items.get(item);
      const inner = qs
        .map((q) => {
          const status = q.answer?.status ?? "not answered";
          const open = status === "needs author";
          const where = q.symbol !== undefined ? ` <span class="muted">${esc(q.symbol)}</span>` : q.function !== undefined ? ` <span class="muted">${esc(q.function)}</span>` : "";
          return details(`<strong>${esc(q.id)}</strong> <span class="muted">[${esc(q.type)}]</span> ${badge(STATUS_CLASS[status] ?? "grey", status)}${where} ${esc(clip(q.text, 160))}`, `<p class="q">${esc(q.text)}</p>${q.answer !== undefined ? answerHtml(q.answer, g) : para("Not answered.")}`, open, "qa", `q-${q.id}`);
        })
        .join("");
      return `<div class="qgroup"><h4>${item === "" ? "Other questions" : `<span class="rid">${esc(item)}</span> ${esc(clip(it?.text ?? "", 140))}`}</h4>${inner}</div>`;
    }),
  ].join("");
  return details(`<h2>Q&amp;A</h2> <span class="muted">${asked.length} questions</span>`, body, true, "sec");
}

// ---- removed and notes ----

function removedHtml(r: ReportDoc): string {
  const items = r.removed.map((x) => `<li>Item <strong>${esc(x.id)}</strong> [${esc(x.section)}]: ${esc(clip(x.text, 200))} <span class="muted">— ${esc(clip(x.reason, 240))}</span></li>`);
  const parts = r.removedParts.map((p) => `<li>${esc(p.kind)} <strong>${esc(p.id)}</strong> ${esc(clip(p.label, 120))} <span class="muted">— ${esc(clip(p.reason, 240))}</span></li>`);
  const body = [
    items.length + parts.length === 0 ? para("Nothing was removed by the claim check.") : `<ul class="plain">${[...items, ...parts].join("")}</ul>`,
    `<h3>Notes</h3>`,
    r.notes.length === 0 ? para("None.") : `<ul class="plain">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`,
  ].join("");
  return details("<h2>Removed by the claim check, and notes</h2>", body, items.length + parts.length > 0, "sec");
}

// ---- the document ----

const CSS = `
:root{--ink:#1d2733;--muted:#5b6b7b;--line:#d9e0e7;--bg:#f6f8fa;--card:#fff;--ok:#2e8b57;--okbg:#e6f4ec;--warn:#b27300;--warnbg:#fdf1d8;--bad:#b3261e;--badbg:#fbe4e2;--greybg:#eceff1}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:0 0 4px}h1 .title{font-weight:500}
h2{font-size:18px;margin:0;display:inline}h3{font-size:15px;margin:14px 0 6px;display:inline-block}h4{font-size:14px;margin:12px 0 4px}h5{font-size:13px;margin:8px 0 2px}
p{margin:6px 0}code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#eef1f4;padding:1px 4px;border-radius:3px}
a{color:#0b5cad}q{color:#33414f}
.sub,.muted{color:var(--muted)}.sub{margin:0 0 12px}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:120px}
.card .label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}.card .value{font-size:15px;font-weight:600}
.card.ok{border-color:var(--ok)}.card.warn{border-color:var(--warn)}.card.bad{border-color:var(--bad)}.card.grey{border-color:#90a4ae}
.plus{color:var(--ok)}.minus{color:var(--bad)}
details.sec{background:var(--card);border:1px solid var(--line);border-radius:8px;margin:12px 0;padding:0}
details.sec>summary{padding:10px 14px;cursor:pointer}details.sec>.body{padding:0 14px 12px}
details.group{border-top:1px solid var(--line);margin-top:6px}details.group>summary{padding:6px 0;cursor:pointer}
details.qa{border:1px solid var(--line);border-radius:6px;margin:6px 0;background:#fcfdfe}details.qa>summary{padding:6px 10px;cursor:pointer}details.qa>.body{padding:0 12px 8px}
details.steps{margin:4px 0}details.steps>summary{cursor:pointer;color:var(--muted);font-size:13px}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:10px;background:var(--greybg);color:#37474f;vertical-align:1px}
.badge.ok{background:var(--okbg);color:var(--ok)}.badge.warn{background:var(--warnbg);color:var(--warn)}.badge.bad{background:var(--badbg);color:var(--bad)}
.item{border:1px solid var(--line);border-radius:8px;padding:6px 12px 10px;margin:10px 0;background:#fcfdfe}
.rid{display:inline-block;background:#e3ecf5;color:#1f4f82;border-radius:4px;padding:0 6px;font-weight:700}
.cites{font-size:13px}.removed{color:var(--bad);font-size:13px}
.state{border-top:1px dashed var(--line);margin-top:8px;padding-top:2px}
.scroll{overflow-x:auto}svg{max-width:100%;height:auto}svg.dd{max-width:none}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid var(--line);padding:5px 8px;text-align:left;vertical-align:top}th{background:#f0f3f6}
td.ok{background:var(--okbg)}td.bad{background:var(--badbg)}td.warn{background:var(--warnbg)}td.grey{background:var(--greybg);color:var(--muted)}
.bar{height:8px;background:#e1e6ea;border-radius:4px;margin-top:4px;min-width:100px}.bar .fill{height:8px;background:#3f86c9;border-radius:4px}
pre{background:#eef1f4;border:1px solid var(--line);border-radius:6px;padding:8px 12px;overflow-x:auto}pre code{background:none;padding:0}
ul.plain{margin:4px 0;padding-left:20px}ol.trace{padding-left:22px}.lead{font-size:16px}.qgroup{margin:10px 0}.q{font-weight:600}
.verdict{display:flex;flex-wrap:wrap;gap:8px 28px;margin:6px 0}.verdict .label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-right:6px}
table.scope{width:auto;min-width:420px}table.scope th{text-align:left;font-weight:600;background:#f6f8fa}table.scope tr.total th,table.scope tr.total td{border-top:2px solid var(--line);font-weight:600}
.feature{border-top:1px dashed var(--line);margin-top:10px;padding-top:2px}.feature:first-child{border-top:0;margin-top:0}
ul.new li{margin:4px 0}ul.open li{margin:8px 0}.foot{margin:18px 0 0;font-size:15px}
@media (max-width:700px){main{padding:10px 8px}.card{min-width:100px}}
`;

function page(i: HtmlInput, g: Github, nav: string, parts: string[], header?: string): string {
  const r = i.report;
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(`${r.pull.owner}/${r.pull.repo}#${r.pull.number}: ${r.pull.title}`)}</title><style>${CSS}${VISUAL_CSS}</style></head>`,
    `<body><main>`,
    header ?? headerHtml(i, g, nav),
    ...parts,
    `</main></body></html>`,
    "",
  ].join("\n");
}

const githubOf = (r: ReportDoc): Github => ({ owner: r.pull.owner, repo: r.pull.repo, head: r.pull.head, base: r.pull.base, number: r.pull.number });

/** The links of the visual report: the pull request, its commits, and the appendix. */
function visualLinks(r: ReportDoc, g: Github): VisualLinks {
  return { pull: pullHref(g), head: commitHref(r.pull.head, g), ...(r.pull.base !== undefined ? { base: commitHref(r.pull.base, g) } : {}), appendix: APPENDIX_HREF, cite: (c) => citeLink(g, c) };
}

/**
 * The whole `review.html` (design §6.11): the report as diagrams and visual elements only, in order: the header strip,
 * the verdict and scope tiles, the data-flow diagrams, the risk map and the question status grid. Labels, numbers and
 * badges are the only text; the rest is in tooltips and in the appendix.
 */
export function renderReviewHtml(i: HtmlInput): string {
  const r = i.report;
  const g = githubOf(r);
  const l = visualLinks(r, g);
  return page(i, g, "", visualSections(i, l), visualHeader(r, l));
}

/** The whole `review-appendix.html` (design §6.11): everything `review.html` shows as a picture, in text, and the rest. */
export function renderAppendixHtml(i: HtmlInput): string {
  const r = i.report;
  const g = githubOf(r);
  const c: Ctx = { g, files: r.files, diagrams: 0, drawn: r.diagrams };
  return page(i, g, `<a href="${REVIEW_HREF}">briefing</a>`, [
    `<p class="foot"><a href="${REVIEW_HREF}">Back to the briefing</a></p>`,
    briefingHtml(i, g),
    featuresHtml(r, g),
    checkHtml(r.briefing, g),
    hotspotsHtml(r, g),
    areasHtml(r),
    openQuestionsHtml(i),
    reviewHtml(i.review, g),
    details("<h2>Summary</h2>", overviewHtml(r), true, "sec"),
    necessityHtml(i.necessity, g, i.qa?.roundsSkipped),
    changeMapHtml(r),
    itemsHtml(r, c),
    measurementsHtml(r),
    qaHtml(r, i.qa, g),
    reviewAppendixHtml(i.review, g),
    removedHtml(r),
    `<p class="foot"><a href="${REVIEW_HREF}">Back to the briefing</a></p>`,
  ]);
}

/** `review.html` rendered from the text of `report.json`, and of `qa.json` and `necessity.json` once they exist; undefined when `report.json` is not a report. */
export function reviewHtmlFrom(reportJson: string, qaJson?: string, necessityJson?: string, draftJson?: string): string | undefined {
  const input = htmlInputFrom(reportJson, qaJson, necessityJson, draftJson);
  return input === undefined ? undefined : renderReviewHtml(input);
}

/** `review-appendix.html` rendered from the same documents. */
export function appendixHtmlFrom(reportJson: string, qaJson?: string, necessityJson?: string, draftJson?: string): string | undefined {
  const input = htmlInputFrom(reportJson, qaJson, necessityJson, draftJson);
  return input === undefined ? undefined : renderAppendixHtml(input);
}

/** The pages last rendered: the graph and its validators ask for the same pages of the same documents at every step of a write, and rendering is a pure function of them. */
const rendered = new Map<string, { review: string; appendix: string } | undefined>();

/** Both files rendered from the same documents, which are parsed once. */
export function htmlPagesFrom(reportJson: string, qaJson?: string, necessityJson?: string, draftJson?: string): { review: string; appendix: string } | undefined {
  const key = `${reportJson}\u0000${qaJson ?? ""}\u0000${necessityJson ?? ""}\u0000${draftJson ?? ""}`;
  if (rendered.has(key)) return rendered.get(key);
  const input = htmlInputFrom(reportJson, qaJson, necessityJson, draftJson);
  const pages = input === undefined ? undefined : { review: renderReviewHtml(input), appendix: renderAppendixHtml(input) };
  if (rendered.size >= 4) rendered.delete(rendered.keys().next().value!);
  rendered.set(key, pages);
  return pages;
}

function htmlInputFrom(reportJson: string, qaJson?: string, necessityJson?: string, draftJson?: string): HtmlInput | undefined {
  const report = parseReportDoc(reportJson);
  if (report === undefined) return undefined;
  const qa = qaJson === undefined ? undefined : parseQaDoc(qaJson);
  const necessity = necessityJson === undefined ? undefined : parseNecessityRecord(necessityJson);
  const review = draftJson === undefined ? undefined : parseDraft(draftJson);
  return { report, ...(qa !== undefined ? { qa } : {}), ...(necessity !== undefined ? { necessity } : {}), ...(review !== undefined ? { review } : {}) };
}

// ---- the inertness check ----

export const MAX_HTML_BYTES = 8 * 1024 * 1024;

const TAGS = new Set([
  "html", "head", "meta", "title", "style", "body", "main", "header", "section", "div", "span", "h1", "h2", "h3", "h4", "h5", "p", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "code", "q", "pre", "details", "summary", "strong", "em", "small", "br",
  "svg", "g", "rect", "line", "path", "polygon", "polyline", "circle", "ellipse", "text", "tspan", "defs", "marker", "pattern", "desc",
]);
/** The attributes that carry a URL: a scheme is judged there, and not in plain text such as an aria-label or a title. */
const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "srcset", "data", "background", "cite", "longdesc", "manifest", "ping"]);
const ATTRS = new Set([
  "class", "id", "lang", "title", "charset", "name", "content", "open", "colspan", "scope", "role", "aria-label", "style", "href",
  "viewBox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "rx", "ry", "cx", "cy", "r", "d", "fill", "stroke", "stroke-width", "stroke-dasharray", "marker-end", "marker-start", "text-anchor", "font-size", "font-weight", "font-family", "points", "transform", "opacity", "fill-opacity", "orient", "refX", "refY", "markerWidth", "markerHeight", "paint-order",
  // What a drawing of the diagram-design skill adds (design §6.11); `data-*` and `aria-*` are allowed by prefix below.
  "aria-labelledby", "letter-spacing", "markerUnits", "patternUnits", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "dx", "dy", "font-style", "dominant-baseline", "preserveAspectRatio", "textLength", "fill-rule",
]);
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*"[^"<>]*")?)*)\s*(\/?)>/y;
const ATTR = /\s+([^\s"'<>\/=]+)(?:\s*=\s*"([^"<>]*)")?/y;

/**
 * Every problem with the bytes of a `review.html` (design §6.11): markup outside the small set the renderer writes (any
 * `<script`, `<link`, `<img`, `<iframe` and the like), an attribute outside it (every `on…` handler, `src`, `srcset`),
 * a `url(` or `@import` that points anywhere but inside the document, and a link that is not an `href` to this pull
 * request, one of its commits, or one of its files at the pinned head or base on GitHub. Empty when it is inert.
 */
export function htmlProblems(html: string, github: { owner: string; repo: string; head: string; base?: string | undefined }): string[] {
  const problems: string[] = [];
  const add = (p: string): void => {
    if (problems.length < 20 && !problems.includes(p)) problems.push(p);
  };
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) add(`the file is larger than ${MAX_HTML_BYTES} bytes`);
  if (/<\s*script/i.test(html)) add("it holds a <script");
  const rootRe = `https://github\\.com/${github.owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${github.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
  const shas = [github.head, ...(github.base !== undefined ? [github.base] : [])].map((s) => s.replace(/[^0-9a-f]/gi, ""));
  const allowed = new RegExp(`^${rootRe}/(?:pull/\\d+|commit/(?:${shas.join("|")})|blob/(?:${shas.join("|")})/[^\\s"<>]*)$`);
  const local = /^(?:(?:review|review-appendix)\.html(?:#[A-Za-z0-9_.:-]+)?|#[A-Za-z0-9_.:-]+)$/;
  const badCss = (css: string): string | undefined => {
    if (/@import/i.test(css)) return "@import";
    if (/url\(\s*(?!["']?#)/i.test(css)) return "a url( that is not a reference inside the document";
    if (/expression\s*\(|javascript:|behavior\s*:/i.test(css)) return "script in CSS";
    return undefined;
  };
  let at = 0;
  while (at < html.length) {
    const lt = html.indexOf("<", at);
    if (lt < 0) break;
    if (html.startsWith("<!doctype html>", lt)) {
      at = lt + "<!doctype html>".length;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(html);
    if (m === null) {
      add(`malformed markup near ${JSON.stringify(html.slice(lt, lt + 40))}`);
      at = lt + 1;
      continue;
    }
    at = lt + m[0].length;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (!TAGS.has(name)) {
      add(`the element <${name}> is not one the report writes`);
      continue;
    }
    if (closing) continue;
    const attrs = m[3] ?? "";
    let pos = 0;
    const seen = new Map<string, string>();
    while (pos < attrs.length) {
      ATTR.lastIndex = pos;
      const a = ATTR.exec(attrs);
      if (a === null) break;
      pos += a[0].length;
      const key = a[1]!;
      const value = a[2] ?? "";
      seen.set(key, value);
      if (/^on/i.test(key) || !(ATTRS.has(key) || /^(?:data-[a-z][a-z0-9-]*|aria-[a-z]+)$/.test(key))) {
        add(`the attribute ${key} on <${name}> is not one the report writes`);
        continue;
      }
      if (key === "href") {
        if (name !== "a") add(`href on <${name}>`);
        else if (!allowed.test(value.replace(/&amp;/g, "&")) && !local.test(value)) add(`a link to ${JSON.stringify(value.length > 80 ? `${value.slice(0, 79)}…` : value)}, which is not the pull request, a commit or a file of it at the pinned head or base, or the report's own briefing or appendix`);
        continue;
      }
      if (URL_ATTRS.has(key) && /^[\s\u0000-\u001f]*(javascript|data|vbscript):/i.test(value)) add(`the attribute ${key} holds a script or data URL`);
      if (key === "style" || key === "marker-end" || key === "marker-start" || key === "fill" || key === "stroke") {
        const css = badCss(value);
        if (css !== undefined) add(`the attribute ${key} holds ${css}`);
      }
    }
    if (name === "meta" && !(seen.has("charset") || seen.get("name") === "viewport")) add("a <meta> other than the charset and the viewport");
    if (name === "style" && m[4] !== "/") {
      const end = html.indexOf("</style>", at);
      if (end < 0) {
        add("an unclosed <style>");
        break;
      }
      const css = html.slice(at, end);
      if (css.includes("<")) add("markup inside <style>");
      const bad = badCss(css);
      if (bad !== undefined) add(`the stylesheet holds ${bad}`);
      at = end;
    }
  }
  return problems;
}
