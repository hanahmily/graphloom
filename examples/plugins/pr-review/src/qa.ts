// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The Q&A as output (design §7.4): `qa.json` (`pr-qa-v1`), which the
 * validators, the ledger and the review layer read, and the Q&A part of
 * `review.md`, grouped by change item and then by symbol. `needs author`
 * entries are marked so they stand out, proposals follow their answers, and
 * an unexported helper's "none found" answers are shown compactly under its
 * item, each with its searches.
 */
import type { FinalAnswer } from "./answers.js";
import type { Groundwork } from "./groundwork.js";
import type { PurposeRecord, Question } from "./questions.js";
import type { ReportView } from "./reportview.js";
import type { PullRequest } from "./request.js";
import type { SymbolDef } from "./symbols.js";

export const QA_FILE_SCHEMA = "pr-qa-v1";
/** What the Q&A says of weak-test questions, which a surviving mutant raises and mutation testing (a later version) produces. */
export const WEAK_TEST_NOTE = "none: mutation testing is not available in this version, so no mutant survived to ask about";

export interface QaInput {
  pr: PullRequest;
  base: string | undefined;
  view: ReportView;
  groundwork: Groundwork;
  purposes: PurposeRecord[];
  questions: Question[];
  answers: FinalAnswer[];
}

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();
const short = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** `qa.json`: the symbols, the purposes, the inventory, and every question with its answer. */
export function qaJson(i: QaInput): string {
  const answers = new Map(i.answers.map((a) => [a.question, a] as const));
  const inv = i.groundwork.inventory;
  return JSON.stringify({
    schema: QA_FILE_SCHEMA,
    pull: { owner: i.pr.owner, repo: i.pr.repo, number: i.pr.number, head: i.pr.head, ...(i.base !== undefined ? { base: i.base } : {}) },
    symbols: i.groundwork.symbols.map((s) => ({
      id: s.id,
      path: s.path,
      qualified: s.qualified,
      kind: s.kind,
      change: s.change,
      exported: s.exported,
      startLine: s.startLine,
      endLine: s.endLine,
      ...(s.item !== undefined ? { item: s.item } : {}),
      similar: i.groundwork.candidates.filter((c) => c.symbol === s.id && c.similarity > 0).map((c) => ({ path: c.path, line: c.line, score: c.similarity })),
      tests: (i.groundwork.testMap.get(s.id) ?? []).length,
    })),
    purposes: i.purposes,
    inventory: { dependencies: inv.dependencies, packages: inv.packages.length, truncated: inv.truncated },
    weakTest: WEAK_TEST_NOTE,
    questions: i.questions.map((q) => {
      const a = answers.get(q.id);
      const { question: _id, ...rest } = a ?? ({} as Partial<FinalAnswer>);
      return { id: q.id, type: q.type, item: q.item, ...(q.symbol !== undefined ? { symbol: q.symbol } : {}), ...(q.fn !== undefined ? { function: q.fn } : {}), ...(q.fnPath !== undefined ? { functionPath: q.fnPath } : {}), text: q.text, origin: q.origin, ...(a !== undefined ? { answer: rest } : {}) };
    }),
  });
}

function evidenceLine(a: FinalAnswer): string {
  const parts: string[] = [];
  if (a.citations.length > 0) parts.push(`cites ${a.citations.map((c) => `${c.tree === "base" ? "" : `${c.tree} `}\`${c.path}:${c.start === c.end ? c.start : `${c.start}-${c.end}`}\`${c.quote.trim() !== "" ? ` "${short(oneLine(c.quote), 70)}"` : ""}`).join(", ")}`);
  if (a.searches.length > 0) parts.push(`searches ${a.searches.map((s) => `\`${short(oneLine(s.pattern), 80)}\` (${s.scope}) → ${s.hits} hit${s.hits === 1 ? "" : "s"}`).join("; ")}`);
  if (a.inventory.length > 0) parts.push(`inventory ${a.inventory.map((d) => `${d.name}@${d.version}`).join(", ")}`);
  if (a.metrics.length > 0) parts.push(`metrics ${a.metrics.map((m) => `${m.function} ${m.name} ${m.value}`).join(", ")}`);
  const check = a.check.verdict === "downgraded" ? `downgraded to needs author${a.check.note !== "" ? ` (${oneLine(a.check.note)})` : ""}` : `${a.check.verdict}${a.check.note !== "" ? `: ${oneLine(a.check.note)}` : ""}`;
  return `  Evidence: ${parts.length === 0 ? "none" : parts.join("; ")}. Checker: ${check}.${a.check.searches.length > 0 ? ` Its own searches: ${a.check.searches.map((s) => `\`${short(oneLine(s.pattern), 60)}\` (${s.scope}) → ${s.hits}`).join("; ")}.` : ""}`;
}

function proposalLines(a: FinalAnswer): string[] {
  const p = a.proposal;
  if (p.kind === "split") return [`  Proposal: ${p.splits.map((s) => `\`${s.name}\` (lines ${s.startLine}–${s.endLine}): ${oneLine(s.responsibility)}`).join("; ")}.`];
  if (p.kind === "test") return [`  Proposal: \`${p.testName}\` in ${p.testFile}${p.cases.length > 0 ? `, cases ${p.cases.map((c) => `${oneLine(c.input)} (${oneLine(c.branches)})`).join("; ")}` : ""}.`];
  if (p.kind === "assertion") return [`  Proposal: ${oneLine(p.assertion)}`];
  return [];
}

function questionLines(q: Question, a: FinalAnswer | undefined): string[] {
  const mark = a?.status === "needs author" ? " ▶ needs author" : "";
  const lines = [`- **${q.id} [${q.type}]${mark}** ${oneLine(q.text)}`];
  if (a === undefined) return [...lines, "  **A — not answered.**"];
  lines.push(`  **A — ${a.status}${a.proposal.kind === "split" && a.status === "answered" ? " (proposal)" : ""}.** ${oneLine(a.answer)}`, evidenceLine(a), ...proposalLines(a));
  if (a.history.length > 1) lines.push(`  Statements before the ${a.check.verdict === "downgraded" ? "downgrade" : "correction"}: ${a.history.map((h, n) => `${n === 0 ? "first" : "corrected"} (${h.status}): "${short(oneLine(h.answer), 160)}"`).join("; ")}.`);
  return lines;
}

const COMPACT: ReadonlySet<string> = new Set(["existing-equivalent", "reuse-library", "common-logic"]);

/** The Q&A part of `review.md` (design §7.4). */
export function renderQa(i: QaInput): string {
  const answers = new Map(i.answers.map((a) => [a.question, a] as const));
  const by = (s: FinalAnswer["status"]): number => i.answers.filter((a) => a.status === s).length;
  const lines = [
    "# Q&A",
    `${i.questions.length} question${i.questions.length === 1 ? "" : "s"} (${i.questions.filter((q) => q.origin === "required").length} required, ${i.questions.filter((q) => q.origin === "added").length} added by the questioner): ${by("answered")} answered, ${by("partially answered")} partially answered, ${by("needs author")} needs author. Weak-test questions: ${WEAK_TEST_NOTE}.`,
    `Dependency inventory: ${i.groundwork.inventory.dependencies.length} declared dependencies (${i.groundwork.inventory.dependencies.filter((d) => d.source !== undefined).length} with source available, ${i.groundwork.inventory.dependencies.filter((d) => d.source === undefined).length} source unavailable), ${i.groundwork.inventory.packages.length} internal directories${i.groundwork.inventory.truncated.length > 0 ? `; ${i.groundwork.inventory.truncated.join("; ")}` : ""}.`,
    "",
  ];
  const symbols = new Map(i.groundwork.symbols.map((s) => [s.id, s] as const));
  const itemIds = [...new Set([...i.view.items.map((x) => x.id)].filter((id) => i.questions.some((q) => q.item === id) || i.purposes.some((p) => p.item === id && p.status === "stated")))];
  const itemById = new Map(i.view.items.map((x) => [x.id, x] as const));
  for (const id of itemIds) {
    const item = itemById.get(id)!;
    lines.push(`### ${id}. ${short(oneLine(item.text), 140)}`);
    const purpose = i.purposes.find((p) => p.item === id && p.status === "stated");
    if (purpose !== undefined) lines.push(`Purpose: stated — "${purpose.quote ?? ""}" (pull request ${purpose.source ?? "text"})`);
    lines.push("");
    const here = i.questions.filter((q) => q.item === id);
    const own = here.filter((q) => q.symbol === undefined && q.fn === undefined);
    for (const q of own) lines.push(...questionLines(q, answers.get(q.id)));
    if (own.length > 0) lines.push("");
    // A symbol's questions, with an unexported helper's "none found" answers set apart.
    const compact: Array<{ sym: SymbolDef; searches: string[] }> = [];
    const symbolIds = [...new Set(here.filter((q) => q.symbol !== undefined).map((q) => q.symbol!))];
    for (const sid of symbolIds.sort((a, b) => i.groundwork.symbols.findIndex((s) => s.id === a) - i.groundwork.symbols.findIndex((s) => s.id === b))) {
      const sym = symbols.get(sid);
      if (sym === undefined) continue;
      const qs = here.filter((q) => q.symbol === sid);
      const quiet = (q: Question): boolean => !sym.exported && COMPACT.has(q.type) && answers.get(q.id)?.none_found === true && answers.get(q.id)?.status !== "needs author";
      const quietQs = qs.filter(quiet);
      if (quietQs.length > 0) compact.push({ sym, searches: [...new Set(quietQs.flatMap((q) => answers.get(q.id)!.searches.map((s) => `\`${short(oneLine(s.pattern), 60)}\``)))] });
      const shown = qs.filter((q) => !quiet(q));
      if (shown.length === 0) continue;
      lines.push(`#### \`${sym.qualified}\` — ${sym.path}:${sym.startLine} (${sym.change})`);
      for (const q of shown) lines.push(...questionLines(q, answers.get(q.id)));
      lines.push("");
    }
    const fnQs = here.filter((q) => q.symbol === undefined && q.fn !== undefined);
    for (const q of fnQs) {
      lines.push(`#### \`${q.fn}\``);
      lines.push(...questionLines(q, answers.get(q.id)), "");
    }
    if (compact.length > 0) {
      lines.push("<details>", `<summary>Unexported helpers with no existing equivalent, library or shared logic found (${compact.length})</summary>`, "");
      for (const c of compact) lines.push(`- \`${c.sym.name}\` (${c.sym.path}:${c.sym.startLine}): searched ${c.searches.length > 0 ? c.searches.join(", ") : "the base tree"}; the ${i.groundwork.inventory.dependencies.length} declared dependencies: ${i.groundwork.inventory.dependencies.filter((d) => d.source === undefined).length} with source unavailable → none.`);
      lines.push("", "</details>", "");
    }
  }
  const orphans = i.questions.filter((q) => !itemById.has(q.item));
  if (orphans.length > 0) {
    lines.push("### Other questions");
    for (const q of orphans) lines.push(...questionLines(q, answers.get(q.id)));
    lines.push("");
  }
  if (i.groundwork.notes.length > 0) lines.push(`Notes on the groundwork: ${i.groundwork.notes.join(" | ")}`, "");
  return lines.join("\n");
}

