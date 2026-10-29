// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The change report (design-pr-review-graph.md §6): the reporter's result
 * contract `change-report-v1`, its deterministic validation (§6.5), and the
 * assembled report once the claim check has removed what it could not
 * support (§6.4). The contract has no severity, finding or verdict field and
 * refuses unknown properties; judgement words are allowed (§6.5).
 */
import { validateResultShape } from "@graphloom/sdk";
import type { Fact } from "./detectors.js";
import { sideLines, type Side } from "./patch.js";
import { fileNames, type PullFile } from "./snapshot.js";
import type { Section } from "./template.js";

export const REPORT_SCHEMA = "pr-change-report-v1";
export const MAX_ITEMS_PER_SECTION = 40;
export const MAX_ITEM_CHARS = 600;
export const MAX_REPORT_BYTES = 256 * 1024;
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 400;

export interface Cite {
  path: string;
  side: Side;
  /** First and last line on `side`; 0 and 0 cite the file as a whole. */
  start: number;
  end: number;
  /** A symbol that appears in the file's patch; empty when none. */
  symbol: string;
}

export interface ReportItem {
  text: string;
  cites: Cite[];
  /** Detector fact ids this item accounts for. */
  facts: string[];
}

export interface ReporterSection {
  id: string;
  none: boolean;
  items: ReportItem[];
}

export interface ReporterOutput {
  sections: ReporterSection[];
  notes: string[];
}

const CITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path", "side", "start", "end", "symbol"],
  properties: {
    path: { type: "string" },
    side: { type: "string", enum: ["head", "base"] },
    start: { type: "integer" },
    end: { type: "integer" },
    symbol: { type: "string" },
  },
};

/** The reporter's result (`change-report-v1`): every property required, none extra, and no field for a severity, finding or verdict. */
export const CHANGE_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sections", "notes"],
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "none", "items"],
        properties: {
          id: { type: "string" },
          none: { type: "boolean" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "cites", "facts"],
              properties: { text: { type: "string" }, cites: { type: "array", items: CITE_SCHEMA }, facts: { type: "array", items: { type: "string" } } },
            },
          },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

export interface ReportContext {
  /** The sections the reporter writes (the template without Measurements). */
  sections: readonly Section[];
  files: readonly PullFile[];
  facts: readonly Fact[];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The reporter's output as typed data, or what the contract refuses in it. */
export function parseReporterOutput(output: unknown): { output: ReporterOutput } | { problems: string[] } {
  const shape = validateResultShape(output, CHANGE_REPORT_SCHEMA as unknown as Record<string, unknown>);
  if (shape.length > 0) return { problems: shape.slice(0, 20) };
  return { output: output as ReporterOutput };
}

function findFile(files: readonly PullFile[], path: string): PullFile | undefined {
  return files.find((f) => f.path === path || f.previousPath === path);
}

/** Every deterministic problem with `report` (§6.5), each naming where. Empty when it passes. */
export function reportProblems(report: ReporterOutput, ctx: ReportContext): string[] {
  const problems: string[] = [];
  const known = new Map(ctx.sections.map((s) => [s.id, s]));
  const seen = new Set<string>();
  for (const s of report.sections) {
    if (!known.has(s.id)) problems.push(`section ${JSON.stringify(s.id)} is not in the template (the sections are ${ctx.sections.map((x) => x.id).join(", ")})`);
    else if (seen.has(s.id)) problems.push(`section ${s.id} appears twice`);
    seen.add(s.id);
  }
  for (const s of ctx.sections) if (!seen.has(s.id)) problems.push(`section ${s.id} is missing: give it items, or "none": true`);
  const factById = new Map(ctx.facts.map((f) => [f.id, f]));
  const cited = new Set<string>();
  const accounted = new Set<string>();
  let bytes = 0;
  for (const s of report.sections) {
    bytes += Buffer.byteLength(JSON.stringify(s), "utf8");
    if (s.none && s.items.length > 0) problems.push(`section ${s.id} says none but lists ${s.items.length} item(s)`);
    if (!s.none && s.items.length === 0) problems.push(`section ${s.id} has no items and does not say "none": true`);
    if (s.items.length > MAX_ITEMS_PER_SECTION) problems.push(`section ${s.id} has ${s.items.length} items, more than ${MAX_ITEMS_PER_SECTION}`);
    if (s.none) {
      const routed = ctx.facts.filter((f) => f.section === s.id);
      if (routed.length > 0) problems.push(`section ${s.id} says none, but detector fact(s) ${routed.slice(0, 5).map((f) => f.id).join(", ")} route to it`);
    }
    s.items.forEach((item, i) => {
      const at = `${s.id} item ${i + 1}`;
      if (item.text.trim() === "") problems.push(`${at}: the text is empty`);
      if (item.text.length > MAX_ITEM_CHARS) problems.push(`${at}: the text is ${item.text.length} characters, more than ${MAX_ITEM_CHARS}`);
      if (item.cites.length === 0) problems.push(`${at}: it cites nothing; every item cites the diff`);
      for (const c of item.cites) citeProblem(c, ctx.files, at, problems);
      for (const c of item.cites) {
        const f = findFile(ctx.files, c.path);
        if (f !== undefined) cited.add(c.path);
      }
      for (const id of item.facts) {
        const fact = factById.get(id);
        if (fact === undefined) problems.push(`${at}: fact ${JSON.stringify(id)} does not exist`);
        else if (fact.section !== s.id) problems.push(`${at}: fact ${id} belongs to section ${fact.section}, not ${s.id}`);
        else if (known.has(s.id)) accounted.add(id);
      }
    });
  }
  if (bytes > MAX_REPORT_BYTES) problems.push(`the report is ${bytes} bytes, more than ${MAX_REPORT_BYTES}`);
  const uncited = ctx.files.flatMap((f) => fileNames(f)).filter((n) => !cited.has(n));
  if (uncited.length > 0) problems.push(`changed file(s) no item cites: ${uncited.slice(0, 10).join(", ")}${uncited.length > 10 ? `, and ${uncited.length - 10} more` : ""}; put each in a section, or in "other"`);
  const unaccounted = ctx.facts.filter((f) => known.has(f.section) && !accounted.has(f.id));
  if (unaccounted.length > 0) {
    problems.push(`detector fact(s) no item of their section lists: ${unaccounted.slice(0, 8).map((f) => `${f.id} (${f.section}: ${f.text})`).join("; ")}${unaccounted.length > 8 ? `; and ${unaccounted.length - 8} more` : ""}`);
  }
  if (report.notes.length > MAX_NOTES) problems.push(`notes has ${report.notes.length} entries, more than ${MAX_NOTES}`);
  report.notes.forEach((n, i) => {
    if (n.length > MAX_NOTE_CHARS) problems.push(`note ${i + 1} is ${n.length} characters, more than ${MAX_NOTE_CHARS}`);
  });
  return problems;
}

function citeProblem(c: Cite, files: readonly PullFile[], at: string, problems: string[]): void {
  const file = findFile(files, c.path);
  if (file === undefined) {
    problems.push(`${at}: cites ${c.path}, which is not a file of the pull request`);
    return;
  }
  const where = `${at}: ${c.path}`;
  const hasPatch = file.parsed.lines.length > 0;
  if (c.start === 0 && c.end === 0) {
    // A whole-file cite names no lines.
  } else if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 1 || c.end < c.start) {
    problems.push(`${where}: the lines ${c.start}-${c.end} are not a range (use 0 and 0 to cite the file as a whole)`);
  } else if (!hasPatch) {
    problems.push(`${where}: the file has no patch text, so no lines of it can be cited; cite it as a whole`);
  } else {
    const lines = sideLines(file.parsed, c.side);
    const missing = [];
    for (let l = c.start; l <= c.end && missing.length < 3; l += 1) if (!lines.has(l)) missing.push(l);
    if (missing.length > 0) problems.push(`${where}: line(s) ${missing.join(", ")} on the ${c.side} side are outside the file's hunks`);
  }
  if (c.symbol !== "") {
    if (!hasPatch) problems.push(`${where}: the symbol ${JSON.stringify(c.symbol)} cannot be found: the file has no patch text`);
    else if (!file.parsed.lines.some((l) => l.text.includes(c.symbol))) problems.push(`${where}: the symbol ${JSON.stringify(c.symbol)} does not appear in the file's patch`);
  }
}

export interface FinalItem extends ReportItem {
  id: string;
  /** Plugin-written, not the reporter's: exempt from the claim check. */
  auto?: "coverage" | "fact";
}

export interface FinalSection {
  id: string;
  title: string;
  none: boolean;
  items: FinalItem[];
}

export interface RemovedItem {
  id: string;
  section: string;
  text: string;
  cites: Cite[];
  reason: string;
}

export interface FinalReport {
  sections: FinalSection[];
  notes: string[];
  removed: RemovedItem[];
}

/** The ids the report's items carry: `R1…` over the sections in template order. */
export function numbered(report: ReporterOutput, ctx: Pick<ReportContext, "sections">): Array<{ id: string; section: string; item: ReportItem }> {
  const out: Array<{ id: string; section: string; item: ReportItem }> = [];
  let n = 0;
  for (const def of ctx.sections) {
    const s = report.sections.find((x) => x.id === def.id);
    for (const item of s?.items ?? []) {
      n += 1;
      out.push({ id: `R${n}`, section: def.id, item });
    }
  }
  return out;
}

/**
 * The report as it stands once `removed` items (id to reason) are dropped:
 * what the claim check could not support leaves, every file that became
 * uncited is listed in `other` as "changed (+a −d lines); not summarised",
 * and a detector fact left without an item gets a plugin-written one, so
 * coverage holds without trusting a model (§6.4).
 */
export function assembleReport(report: ReporterOutput, removed: ReadonlyMap<string, string>, ctx: ReportContext): FinalReport {
  const items = numbered(report, ctx);
  const gone: RemovedItem[] = [];
  const bySection = new Map<string, FinalItem[]>(ctx.sections.map((s) => [s.id, []]));
  for (const { id, section, item } of items) {
    const reason = removed.get(id);
    if (reason !== undefined) gone.push({ id, section, text: item.text, cites: item.cites, reason });
    else bySection.get(section)!.push({ id, ...item });
  }
  let next = items.length;
  const cited = new Set(ctx.sections.flatMap((s) => bySection.get(s.id)!.flatMap((i) => i.cites.map((c) => c.path))));
  const accounted = new Set(ctx.sections.flatMap((s) => bySection.get(s.id)!.flatMap((i) => i.facts)));
  for (const fact of ctx.facts) {
    if (accounted.has(fact.id) || !bySection.has(fact.section)) continue;
    next += 1;
    const whole = fact.line < 1;
    bySection.get(fact.section)!.push({
      id: `R${next}`,
      text: `Detected: ${fact.text}. The reported item for it was removed by the claim check.`,
      cites: [{ path: fact.path, side: fact.side, start: whole ? 0 : fact.line, end: whole ? 0 : fact.line, symbol: "" }],
      facts: [fact.id],
      auto: "fact",
    });
    cited.add(fact.path);
  }
  if (bySection.has("other")) {
    for (const file of ctx.files) {
      const names = fileNames(file);
      if (names.every((n) => cited.has(n))) continue;
      next += 1;
      bySection.get("other")!.push({
        id: `R${next}`,
        text: `${file.path} changed (+${file.additions} −${file.deletions} lines); not summarised`,
        cites: names.map((n) => ({ path: n, side: (n === file.path && file.status !== "removed" ? "head" : "base") as Side, start: 0, end: 0, symbol: "" })),
        facts: [],
        auto: "coverage",
      });
      for (const n of names) cited.add(n);
    }
  }
  return {
    sections: ctx.sections.map((s) => ({ id: s.id, title: s.title, none: bySection.get(s.id)!.length === 0, items: bySection.get(s.id)! })),
    notes: report.notes,
    removed: gone,
  };
}

/** A final report in the reporter's shape, so the same deterministic rules judge it. */
export function asReporterOutput(final: FinalReport): ReporterOutput {
  return {
    sections: final.sections.map((s) => ({ id: s.id, none: s.none, items: s.items.map(({ text, cites, facts }) => ({ text, cites, facts })) })),
    notes: final.notes,
  };
}

/** `path:3-9`, `path:7`, `path` (and `(base)` for the base side; `#symbol` when it names one). */
export function citeLabel(c: Cite): string {
  const lines = c.start === 0 ? "" : c.start === c.end ? `:${c.start}` : `:${c.start}-${c.end}`;
  return `${c.path}${lines}${c.side === "base" ? " (base)" : ""}${c.symbol !== "" ? ` #${c.symbol}` : ""}`;
}

export interface ReportHeader {
  owner: string;
  repo: string;
  number: number;
  head: string;
  base?: string;
  title: string;
  files: readonly PullFile[];
  commits: number;
  checks: ReadonlyArray<{ status: string | null; conclusion: string | null }>;
}

/** The checks' tally for the report's first line. */
export function describeChecks(checks: ReportHeader["checks"]): string {
  if (checks.length === 0) return "none reported";
  const passed = checks.filter((c) => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "neutral" || c.conclusion === "skipped")).length;
  const failed = checks.filter((c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(c.conclusion ?? "")).length;
  const pending = checks.length - passed - failed;
  return [`${passed} passed`, ...(failed > 0 ? [`${failed} failed`] : []), ...(pending > 0 ? [`${pending} pending`] : [])].join(", ");
}

/** The Report part of `review.md` (design §6.6). */
export function renderReport(final: FinalReport, header: ReportHeader): string {
  const added = header.files.reduce((n, f) => n + f.additions, 0);
  const deleted = header.files.reduce((n, f) => n + f.deletions, 0);
  const lines = [
    "# Report",
    `${header.files.length} files, +${added} −${deleted}. Commits: ${header.commits}. GitHub checks at head: ${describeChecks(header.checks)}.`,
    "",
  ];
  for (const s of final.sections) {
    if (s.id === "measurements") continue;
    lines.push(`## ${s.title}`);
    if (s.items.length === 0) lines.push("- None");
    for (const i of s.items) {
      const where = i.cites.map(citeLabel).join(", ");
      lines.push(`- ${i.id}. ${i.text.replace(/\s*\n\s*/g, " ")} — ${where}${i.facts.length > 0 ? ` [${i.facts.join(", ")}]` : ""}`);
    }
    lines.push("");
  }
  lines.push(`Notes: ${final.notes.length === 0 ? "none" : final.notes.map((n) => n.replace(/\s*\n\s*/g, " ")).join(" | ")}`, "");
  return lines.join("\n");
}
