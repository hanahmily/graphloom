// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The change report (design-pr-review-graph.md §6): the reporter's result
 * contract `change-report-v1`, its deterministic validation (§6.5), and the
 * assembled report once the claim check has removed what it could not
 * support (§6.4). The report opens with a summary (the purpose and an
 * overview); its items are conceptual changes, each with the lifecycle of the
 * state it introduces and a before/after table where behavior changes. The
 * contract has no severity, finding or verdict field and refuses unknown
 * properties; judgement words are allowed (§6.5).
 */
import { validateResultShape } from "@graphloom/sdk";
import { ARCHITECTURE_SCHEMA, architectureProblems, assembleArchitecture, EMPTY_ARCHITECTURE, renderArchitectureMarkdown, type Architecture } from "./architecture.js";
import type { Fact } from "./detectors.js";
import { sideLines, type Side } from "./patch.js";
import { quoteInPinned, type PinnedText } from "./questions.js";
import { nameCovers, type StateCandidate } from "./statecandidates.js";
import { fileNames, type PullFile } from "./snapshot.js";
import type { Section } from "./template.js";

export const REPORT_SCHEMA = "pr-change-report-v1";
export const MAX_ITEMS_PER_SECTION = 40;
export const MAX_ITEM_CHARS = 600;
export const MAX_REPORT_BYTES = 256 * 1024;
export const MAX_PURPOSE_CHARS = 400;
export const MAX_OVERVIEW_CHARS = 900;
export const MAX_STATE_PER_ITEM = 6;
export const MAX_STEPS_PER_ENTRY = 8;
export const MAX_BEHAVIOR_PER_ITEM = 8;
/** The longest `initial`, `when`, `effect`, `where`, `decision`, `case`, `before` or `after` text of a lifecycle or behavior entry. */
export const MAX_PART_CHARS = 240;
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 400;

export interface Cite {
  path: string;
  side: Side;
  /** First and last line on `side`; 0 and 0 cite the file as a whole, which only a file with no patch text may do. */
  start: number;
  end: number;
  /** A symbol that appears in the file's patch; empty when none. */
  symbol: string;
}

/** Why the change is made: quoted from the pull request's text, or marked as inferred from the diff. */
export interface Purpose {
  text: string;
  source: "stated" | "inferred";
  /** For `stated`, an excerpt of the title, body or a commit message; empty for `inferred`. */
  quote: string;
}

export interface Transition {
  when: string;
  effect: string;
  cite: Cite;
}

export interface StateRead {
  where: string;
  decision: string;
  cite: Cite;
}

/** The lifecycle of one new or changed piece of state: a field, counter, flag, cached value or accumulator. */
export interface StateEntry {
  name: string;
  /** "per call", "per request/batch", "per instance", "global", or other text. */
  scope: string;
  initial: string;
  transitions: Transition[];
  reads: StateRead[];
}

/** One case whose behavior the change alters, or deliberately leaves as it was. */
export interface BehaviorRow {
  case: string;
  before: string;
  after: string;
}

export interface ReportItem {
  text: string;
  cites: Cite[];
  /** Detector fact ids this item accounts for. */
  facts: string[];
  /** The lifecycle of every new or changed piece of state this change introduces; empty when none. */
  state: StateEntry[];
  /** Before and after, per case, where the change alters behavior; empty when it does not. */
  behavior: BehaviorRow[];
}

export interface ReporterSection {
  id: string;
  none: boolean;
  items: ReportItem[];
}

export interface ReporterOutput {
  purpose: Purpose;
  /** Two to four sentences on the mechanism of the whole change. */
  overview: string;
  sections: ReporterSection[];
  notes: string[];
  /** The components the change adds or modifies, and how they connect (design §6.10); an area report in large mode leaves it empty. */
  architecture: Architecture;
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

const text = { type: "string" };
const strict = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, required, properties });

/** The reporter's result (`change-report-v1`): every property required, none extra, and no field for a severity, finding or verdict. */
export const CHANGE_REPORT_SCHEMA = strict(["purpose", "overview", "sections", "notes", "architecture"], {
  architecture: ARCHITECTURE_SCHEMA,
  purpose: strict(["text", "source", "quote"], { text, source: { type: "string", enum: ["stated", "inferred"] }, quote: text }),
  overview: text,
  sections: {
    type: "array",
    items: strict(["id", "none", "items"], {
      id: text,
      none: { type: "boolean" },
      items: {
        type: "array",
        items: strict(["text", "cites", "facts", "state", "behavior"], {
          text,
          cites: { type: "array", items: CITE_SCHEMA },
          facts: { type: "array", items: text },
          state: {
            type: "array",
            items: strict(["name", "scope", "initial", "transitions", "reads"], {
              name: text,
              scope: text,
              initial: text,
              transitions: { type: "array", items: strict(["when", "effect", "cite"], { when: text, effect: text, cite: CITE_SCHEMA }) },
              reads: { type: "array", items: strict(["where", "decision", "cite"], { where: text, decision: text, cite: CITE_SCHEMA }) },
            }),
          },
          behavior: { type: "array", items: strict(["case", "before", "after"], { case: text, before: text, after: text }) },
        }),
      },
    }),
  },
  notes: { type: "array", items: text },
});

export interface ReportContext {
  /** The sections the reporter writes (the template without Measurements). */
  sections: readonly Section[];
  files: readonly PullFile[];
  facts: readonly Fact[];
  /** The pull request's title, body and commit messages, which a stated purpose must quote. */
  pinned?: readonly PinnedText[];
  /** State the patches introduce: each must have a lifecycle entry in an item that cites its file. */
  candidates?: readonly StateCandidate[];
  /** Large mode's merged report holds the items of every area, so its bounds grow with them (design §6.9); absent means the standard bounds. */
  maxItemsPerSection?: number;
  maxBytes?: number;
  /** Large mode: files no agent read as patches (generated, or no patch from GitHub), by path, with what the report says of each. */
  unread?: ReadonlyMap<string, string>;
  /** The pinned base commit, which the architecture diagram's tree check reads (design §6.10). */
  base?: string;
}

/** What the deterministic rules judge: a reporter's output, or a final report in its shape (no summary check). */
export type ReportLike = Pick<ReporterOutput, "sections" | "notes"> & Partial<Pick<ReporterOutput, "purpose" | "overview" | "architecture">>;

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

const SENTENCE_SPLIT = /[.!?]+(?:\s+|$)/;

/** Every deterministic problem with `report` (§6.5), each naming where. Empty when it passes. `final` skips what only the reporter's own result owes: the summary, cite ranges and the state candidates. */
export function reportProblems(report: ReportLike, ctx: ReportContext, opts: { final?: boolean; summary?: boolean } = {}): string[] {
  const problems: string[] = [];
  const final = opts.final === true;
  const maxItems = ctx.maxItemsPerSection ?? MAX_ITEMS_PER_SECTION;
  const maxBytes = ctx.maxBytes ?? MAX_REPORT_BYTES;
  // An area's report leaves the summary to the synthesis job (design §6.9).
  if (!final && opts.summary !== false) summaryProblems(report, ctx, problems);
  // The diagram's structural rules (design §6.10); its tree check is a command the graph runs (`architecturePlan`).
  if (report.architecture !== undefined) problems.push(...architectureProblems(report.architecture, ctx.files));
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
  const stateNames: Array<{ path: string; name: string }> = [];
  let bytes = 0;
  for (const s of report.sections) {
    bytes += Buffer.byteLength(JSON.stringify(s), "utf8");
    if (s.none && s.items.length > 0) problems.push(`section ${s.id} says none but lists ${s.items.length} item(s)`);
    if (!s.none && s.items.length === 0) problems.push(`section ${s.id} has no items and does not say "none": true`);
    if (s.items.length > maxItems) problems.push(`section ${s.id} has ${s.items.length} items, more than ${maxItems}`);
    if (s.none) {
      const routed = ctx.facts.filter((f) => f.section === s.id);
      if (routed.length > 0) problems.push(`section ${s.id} says none, but detector fact(s) ${routed.slice(0, 5).map((f) => f.id).join(", ")} route to it`);
    }
    s.items.forEach((item, i) => {
      const at = `${s.id} item ${i + 1}`;
      if (item.text.trim() === "") problems.push(`${at}: the text is empty`);
      if (item.text.length > MAX_ITEM_CHARS) problems.push(`${at}: the text is ${item.text.length} characters, more than ${MAX_ITEM_CHARS}`);
      if (item.cites.length === 0) problems.push(`${at}: it cites nothing; every item cites the diff`);
      for (const c of item.cites) citeProblem(c, ctx.files, at, problems, !final);
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
      partProblems(item, ctx.files, at, problems);
      for (const e of item.state) for (const c of item.cites) stateNames.push({ path: c.path, name: e.name });
    });
  }
  if (bytes > maxBytes) problems.push(`the report is ${bytes} bytes, more than ${maxBytes}`);
  const uncited = ctx.files.flatMap((f) => fileNames(f)).filter((n) => !cited.has(n));
  if (uncited.length > 0) problems.push(`changed file(s) no item cites: ${uncited.slice(0, 10).join(", ")}${uncited.length > 10 ? `, and ${uncited.length - 10} more` : ""}; put each in a section, or in "other"`);
  const unaccounted = ctx.facts.filter((f) => known.has(f.section) && !accounted.has(f.id));
  if (unaccounted.length > 0) {
    problems.push(`detector fact(s) no item of their section lists: ${unaccounted.slice(0, 8).map((f) => `${f.id} (${f.section}: ${f.text})`).join("; ")}${unaccounted.length > 8 ? `; and ${unaccounted.length - 8} more` : ""}`);
  }
  if (!final) {
    const missing = (ctx.candidates ?? []).filter((c) => !stateNames.some((s) => (s.path === c.path || findFile(ctx.files, s.path) === findFile(ctx.files, c.path)) && nameCovers(s.name, c.name)));
    if (missing.length > 0) {
      problems.push(
        `state the patch introduces has no lifecycle entry: ${missing.slice(0, 6).map((c) => `${c.name} (${c.path}:${c.line}, ${c.kind === "field" ? "a new field" : `declared, then changed at line ${c.mutatedAt}`})`).join("; ")}${missing.length > 6 ? `; and ${missing.length - 6} more` : ""}; add a "state" entry named for each to the item that cites its file (a name that is not real state still needs its entry, saying so in "initial")`,
      );
    }
  }
  if (report.notes.length > MAX_NOTES) problems.push(`notes has ${report.notes.length} entries, more than ${MAX_NOTES}`);
  report.notes.forEach((n, i) => {
    if (n.length > MAX_NOTE_CHARS) problems.push(`note ${i + 1} is ${n.length} characters, more than ${MAX_NOTE_CHARS}`);
  });
  return problems;
}

const isStated = (p: Purpose): boolean => p.source === "stated";

/** The summary's rules: a stated purpose quotes the pull request's own text; an inferred one quotes nothing. */
export function summaryProblems(report: Partial<Pick<ReporterOutput, "purpose" | "overview">>, ctx: { pinned?: readonly PinnedText[] | undefined }, problems: string[]): void {
  const p = report.purpose;
  if (p === undefined) problems.push("the purpose is missing");
  else {
    if (p.text.trim() === "") problems.push("the purpose text is empty");
    if (p.text.length > MAX_PURPOSE_CHARS) problems.push(`the purpose text is ${p.text.length} characters, more than ${MAX_PURPOSE_CHARS}`);
    if (isStated(p)) {
      const sources: PinnedText["source"][] = ["title", "body", "commit"];
      if (!sources.some((s) => quoteInPinned(p.quote, s, ctx.pinned ?? []))) {
        problems.push("the purpose says it is stated, but its quote is not in the pull request's title, body or commit messages (copy an excerpt of at least 12 characters exactly, or set the source to \"inferred\" with an empty quote)");
      }
    } else if (p.quote.trim() !== "") problems.push("an inferred purpose has no quote: leave quote empty");
  }
  const o = report.overview;
  if (o === undefined || o.trim() === "") problems.push("the overview is missing or empty");
  else {
    if (o.length > MAX_OVERVIEW_CHARS) problems.push(`the overview is ${o.length} characters, more than ${MAX_OVERVIEW_CHARS}`);
    const sentences = o.split(SENTENCE_SPLIT).filter((x) => x.trim() !== "").length;
    if (sentences > 6) problems.push(`the overview has ${sentences} sentences; two to four describe the mechanism of the whole change`);
  }
}

const bounded = (value: string, max: number, at: string, what: string, problems: string[]): void => {
  if (value.trim() === "") problems.push(`${at}: ${what} is empty`);
  else if (value.length > max) problems.push(`${at}: ${what} is ${value.length} characters, more than ${max}`);
};

/** Lifecycle and before/after rules for one item: bounds, and every lifecycle citation inside the diff. */
export function partProblems(item: ReportItem, files: readonly PullFile[], at: string, problems: string[]): void {
  if (item.state.length > MAX_STATE_PER_ITEM) problems.push(`${at}: ${item.state.length} state entries, more than ${MAX_STATE_PER_ITEM}`);
  const names = new Set<string>();
  item.state.forEach((e, si) => {
    const here = `${at} state ${si + 1}`;
    bounded(e.name, 120, here, "the name", problems);
    bounded(e.scope, 80, here, "the scope", problems);
    bounded(e.initial, MAX_PART_CHARS, here, "the initial value", problems);
    if (names.has(e.name)) problems.push(`${here}: ${JSON.stringify(e.name)} appears twice in this item`);
    names.add(e.name);
    if (e.transitions.length + e.reads.length === 0) problems.push(`${here}: no transitions and no reads; say when it changes and where it is read`);
    if (e.transitions.length > MAX_STEPS_PER_ENTRY) problems.push(`${here}: ${e.transitions.length} transitions, more than ${MAX_STEPS_PER_ENTRY}`);
    if (e.reads.length > MAX_STEPS_PER_ENTRY) problems.push(`${here}: ${e.reads.length} reads, more than ${MAX_STEPS_PER_ENTRY}`);
    e.transitions.forEach((t, i) => {
      const where = `${here} transition ${i + 1}`;
      bounded(t.when, MAX_PART_CHARS, where, "when", problems);
      bounded(t.effect, MAX_PART_CHARS, where, "effect", problems);
      citeProblem(t.cite, files, where, problems, true);
    });
    e.reads.forEach((r, i) => {
      const where = `${here} read ${i + 1}`;
      bounded(r.where, MAX_PART_CHARS, where, "where", problems);
      bounded(r.decision, MAX_PART_CHARS, where, "decision", problems);
      citeProblem(r.cite, files, where, problems, true);
    });
  });
  if (item.behavior.length > MAX_BEHAVIOR_PER_ITEM) problems.push(`${at}: ${item.behavior.length} behavior rows, more than ${MAX_BEHAVIOR_PER_ITEM}`);
  item.behavior.forEach((b, i) => {
    const where = `${at} behavior ${i + 1}`;
    bounded(b.case, MAX_PART_CHARS, where, "the case", problems);
    bounded(b.before, MAX_PART_CHARS, where, "before", problems);
    bounded(b.after, MAX_PART_CHARS, where, "after", problems);
  });
}

function citeProblem(c: Cite, files: readonly PullFile[], at: string, problems: string[], rangeRequired: boolean): void {
  const file = findFile(files, c.path);
  if (file === undefined) {
    problems.push(`${at}: cites ${c.path}, which is not a file of the pull request`);
    return;
  }
  const where = `${at}: ${c.path}`;
  const hasPatch = file.parsed.lines.length > 0;
  if (c.start === 0 && c.end === 0) {
    if (hasPatch && rangeRequired) problems.push(`${where}: the file has patch text, so cite the lines (start and end on the ${c.side} side, inside a hunk), not 0 and 0 or a symbol alone; 0 and 0 is only for a file with no patch text`);
  } else if (!Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 1 || c.end < c.start) {
    problems.push(`${where}: the lines ${c.start}-${c.end} are not a range (use 0 and 0 to cite a file with no patch text as a whole)`);
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

/** A part of the report the claim check could not support, dropped while its item stays. */
export interface RemovedPart {
  /** The claim-check id: `purpose`, `overview`, `R3.s1` (a state entry, whole), `R3.b2` (a behavior row), `M2` (a merge, large mode), `A.store` (a diagram node), `A.e3` (a diagram edge). */
  id: string;
  kind: "purpose" | "overview" | "state" | "behavior" | "merge" | "node" | "edge";
  /** The item it belonged to; empty for the summary. */
  item: string;
  /** What was dropped, in a few words: the entry's name or the row's case. */
  label: string;
  reason: string;
}

export interface FinalSummary {
  /** Null when the claim check removed it. */
  purpose: Purpose | null;
  overview: string | null;
}

export interface FinalReport {
  summary: FinalSummary;
  sections: FinalSection[];
  notes: string[];
  removed: RemovedItem[];
  removedParts: RemovedPart[];
  /** The architecture diagram the claim check left standing (design §6.10). */
  architecture: Architecture;
}

/** The ids the report's items carry: `R1…` over the sections in template order. */
export function numbered(report: Pick<ReporterOutput, "sections">, ctx: Pick<ReportContext, "sections">): Array<{ id: string; section: string; item: ReportItem }> {
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

/** The claim-check ids of an item's state entries and their transitions and reads: `R3.s1`, `R3.s1.t2`, `R3.s1.r1`. */
export const stateId = (item: string, entry: number): string => `${item}.s${entry + 1}`;
export const transitionId = (item: string, entry: number, n: number): string => `${stateId(item, entry)}.t${n + 1}`;
export const readId = (item: string, entry: number, n: number): string => `${stateId(item, entry)}.r${n + 1}`;
export const behaviorId = (item: string, row: number): string => `${item}.b${row + 1}`;

/**
 * The report as it stands once `removed` (claim-check id to reason) is dropped:
 * an item the check could not support leaves; a state entry (with any weak
 * transition or read, since half a lifecycle would mislead) or a behavior row
 * leaves while its item stays, recorded in `removedParts`; a purpose or an
 * overview it could not support is null. Every file that became uncited is
 * listed in `other` as "changed (+a −d lines); not summarised", and a
 * detector fact left without an item gets a plugin-written one, so coverage
 * holds without trusting a model (§6.4).
 */
export function assembleReport(report: Pick<ReporterOutput, "sections" | "notes"> & Partial<Pick<ReporterOutput, "purpose" | "overview" | "architecture">>, removed: ReadonlyMap<string, string>, ctx: ReportContext): FinalReport {
  const items = numbered(report, ctx);
  const gone: RemovedItem[] = [];
  const parts: RemovedPart[] = [];
  const bySection = new Map<string, FinalItem[]>(ctx.sections.map((s) => [s.id, []]));
  for (const { id, section, item } of items) {
    const reason = removed.get(id);
    if (reason !== undefined) {
      gone.push({ id, section, text: item.text, cites: item.cites, reason });
      continue;
    }
    const state: StateEntry[] = [];
    item.state.forEach((e, si) => {
      const ids = [stateId(id, si), ...e.transitions.map((_, n) => transitionId(id, si, n)), ...e.reads.map((_, n) => readId(id, si, n))];
      const weak = ids.find((x) => removed.has(x));
      if (weak === undefined) state.push(e);
      else parts.push({ id: weak, kind: "state", item: id, label: e.name, reason: removed.get(weak)! });
    });
    const behavior: BehaviorRow[] = [];
    item.behavior.forEach((b, bi) => {
      const reason = removed.get(behaviorId(id, bi));
      if (reason === undefined) behavior.push(b);
      else parts.push({ id: behaviorId(id, bi), kind: "behavior", item: id, label: b.case, reason });
    });
    bySection.get(section)!.push({ id, ...item, state, behavior });
  }
  const purposeReason = removed.get("purpose");
  const overviewReason = removed.get("overview");
  if (purposeReason !== undefined) parts.push({ id: "purpose", kind: "purpose", item: "", label: report.purpose?.text ?? "", reason: purposeReason });
  if (overviewReason !== undefined) parts.push({ id: "overview", kind: "overview", item: "", label: report.overview ?? "", reason: overviewReason });
  const arch = assembleArchitecture(report.architecture ?? EMPTY_ARCHITECTURE, removed);
  parts.push(...arch.parts);
  let next = items.length;
  const cited = new Set(ctx.sections.flatMap((s) => bySection.get(s.id)!.flatMap((i) => i.cites.map((c) => c.path))));
  const accounted = new Set(ctx.sections.flatMap((s) => bySection.get(s.id)!.flatMap((i) => i.facts)));
  /**
   * Appends plugin-written items to a section. Past the section's bound they are grouped, several to an item,
   * so assembly never produces a report the deterministic rules would refuse.
   */
  const place = (section: string, autos: Array<Omit<FinalItem, "id">>, label: string): void => {
    const target = bySection.get(section)!;
    const limit = ctx.maxItemsPerSection ?? MAX_ITEMS_PER_SECTION;
    const room = limit - target.length;
    if (autos.length <= room) {
      for (const a of autos) {
        next += 1;
        target.push({ id: `R${next}`, ...a });
      }
      return;
    }
    const size = Math.ceil(autos.length / Math.max(1, room));
    for (let i = 0; i < autos.length; i += size) {
      const chunk = autos.slice(i, i + size);
      const joined = `${label === "" ? "" : `${label}: `}${chunk.map((a) => a.text).join("; ")}`;
      next += 1;
      target.push({
        id: `R${next}`,
        text: joined.length <= MAX_ITEM_CHARS ? joined : `${joined.slice(0, MAX_ITEM_CHARS - 1)}…`,
        cites: chunk.flatMap((a) => a.cites),
        facts: chunk.flatMap((a) => a.facts),
        state: [],
        behavior: [],
        auto: chunk[0]!.auto!,
      });
    }
  };
  const factItems = new Map<string, Array<Omit<FinalItem, "id">>>();
  for (const fact of ctx.facts) {
    if (accounted.has(fact.id) || !bySection.has(fact.section)) continue;
    const whole = fact.line < 1;
    const list = factItems.get(fact.section) ?? [];
    list.push({
      text: ctx.unread?.has(fact.path) === true ? `Detected: ${fact.text}. ${ctx.unread.get(fact.path)}.` : `Detected: ${fact.text}. The reported item for it was removed by the claim check.`,
      cites: [{ path: fact.path, side: fact.side, start: whole ? 0 : fact.line, end: whole ? 0 : fact.line, symbol: "" }],
      facts: [fact.id],
      state: [],
      behavior: [],
      auto: "fact",
    });
    factItems.set(fact.section, list);
    // A file no agent read keeps its own entry in "other" (design §6.9), whatever a detector fact made of it.
    if (ctx.unread?.has(fact.path) !== true) cited.add(fact.path);
  }
  for (const [section, list] of factItems) place(section, list, "");
  if (bySection.has("other")) {
    const uncovered: Array<Omit<FinalItem, "id">> = [];
    for (const file of ctx.files) {
      const names = fileNames(file);
      if (names.every((n) => cited.has(n))) continue;
      uncovered.push({
        text: `${file.path} changed (+${file.additions} −${file.deletions} lines); ${ctx.unread?.get(file.path) ?? "not summarised"}`,
        cites: names.map((n) => ({ path: n, side: (n === file.path && file.status !== "removed" ? "head" : "base") as Side, start: 0, end: 0, symbol: "" })),
        facts: [],
        state: [],
        behavior: [],
        auto: "coverage",
      });
      for (const n of names) cited.add(n);
    }
    place("other", uncovered, "Changed, not summarised");
  }
  return {
    summary: { purpose: purposeReason === undefined ? (report.purpose ?? null) : null, overview: overviewReason === undefined ? (report.overview ?? null) : null },
    sections: ctx.sections.map((s) => ({ id: s.id, title: s.title, none: bySection.get(s.id)!.length === 0, items: bySection.get(s.id)! })),
    notes: report.notes,
    removed: gone,
    removedParts: parts,
    architecture: arch.architecture,
  };
}

/** A final report in the reporter's shape (without its summary), so the same deterministic rules judge it. */
export function asReporterOutput(final: FinalReport): Pick<ReporterOutput, "sections" | "notes" | "architecture"> {
  return {
    sections: final.sections.map((s) => ({ id: s.id, none: s.none, items: s.items.map(({ text, cites, facts, state, behavior }) => ({ text, cites, facts, state, behavior })) })),
    notes: final.notes,
    architecture: final.architecture,
  };
}

/** The lines a cite names, resolved from the file's patch when it gives none: a symbol to the lines that mention it, a whole file to its changed lines. */
export function citedLines(c: Cite, files: readonly PullFile[]): { start: number; end: number; side: Side } | undefined {
  if (c.start >= 1 && c.end >= c.start) return { start: c.start, end: c.end, side: c.side };
  const file = findFile(files, c.path);
  if (file === undefined || file.parsed.lines.length === 0) return undefined;
  const number = (l: PullFile["parsed"]["lines"][number], side: Side): number | undefined => (side === "head" ? (l.kind === "del" ? undefined : l.line) : l.kind === "del" ? l.line : l.baseLine);
  /** The range on `side`, with that side named: a resolved range keeps the tree its numbers belong to. */
  const range = (pool: PullFile["parsed"]["lines"], side: Side): { start: number; end: number; side: Side } | undefined => {
    const ns = pool.map((l) => number(l, side)).filter((n): n is number => n !== undefined);
    return ns.length === 0 ? undefined : { start: Math.min(...ns), end: Math.max(...ns), side };
  };
  const lines = file.parsed.lines;
  if (c.symbol !== "") {
    const named = range(lines.filter((l) => l.text.includes(c.symbol)), c.side);
    if (named !== undefined) return named;
  }
  const other: Side = c.side === "head" ? "base" : "head";
  const changed = lines.filter((l) => l.kind !== "ctx");
  return range(changed, c.side) ?? range(changed, other) ?? range(lines, c.side);
}

/**
 * `path:3-9`, `path:7` (and `(base)` for the base side). With `files`, a cite that names no lines is resolved
 * from the patch, so every citation of a file with patch text reads as `path:line`; a file with none reads as `path`.
 * Without them, a symbol shows as `#symbol`.
 */
export function citeLabel(c: Cite, files?: readonly PullFile[]): string {
  const at = files !== undefined ? citedLines(c, files) : c.start >= 1 && c.end >= c.start ? { start: c.start, end: c.end, side: c.side } : undefined;
  const lines = at === undefined ? "" : at.start === at.end ? `:${at.start}` : `:${at.start}-${at.end}`;
  const symbol = files === undefined && at === undefined && c.symbol !== "" ? ` #${c.symbol}` : "";
  return `${c.path}${lines}${(at?.side ?? c.side) === "base" ? " (base)" : ""}${symbol}`;
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

const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();
const cell = (s: string): string => oneLine(s).replace(/\|/g, "\\|");
const short = (s: string, n: number): string => (oneLine(s).length <= n ? oneLine(s) : `${oneLine(s).slice(0, n - 1)}…`);

/** The summary at the top of the Report part: the purpose (stated with its quote, or marked inferred) and the overview. */
function summaryLines(summary: FinalSummary, removedParts: readonly RemovedPart[]): string[] {
  const why = (id: string): string => short(removedParts.find((p) => p.id === id)?.reason ?? "", 120);
  const p = summary.purpose;
  return [
    "## Summary",
    p === null ? `**Purpose:** not given: the claim check could not support it (${why("purpose")}).` : p.source === "stated" ? `**Purpose** (stated: "${oneLine(p.quote)}"): ${oneLine(p.text)}` : `**Purpose** (inferred from the diff; the pull request does not state it): ${oneLine(p.text)}`,
    summary.overview === null ? `**Overview:** not given: the claim check could not support it (${why("overview")}).` : `**Overview:** ${oneLine(summary.overview)}`,
    "",
  ];
}

/** An item's lifecycle block, behavior table and removed-part notes, indented under its line. */
function itemDetail(i: FinalItem, files: readonly PullFile[], removedParts: readonly RemovedPart[]): string[] {
  const out: string[] = [];
  for (const e of i.state) {
    out.push(`  - State \`${e.name}\` (${oneLine(e.scope)}); starts: ${oneLine(e.initial)}`);
    for (const t of e.transitions) out.push(`    - when ${oneLine(t.when)} → ${oneLine(t.effect)} (${citeLabel(t.cite, files)})`);
    for (const r of e.reads) out.push(`    - read ${oneLine(r.where)}: ${oneLine(r.decision)} (${citeLabel(r.cite, files)})`);
  }
  if (i.behavior.length > 0) {
    out.push("  - Behavior:", "", "    | Case | Before | After |", "    |---|---|---|", ...i.behavior.map((b) => `    | ${cell(b.case)} | ${cell(b.before)} | ${cell(b.after)} |`), "");
  }
  for (const p of removedParts.filter((x) => x.item === i.id)) {
    out.push(`  - Removed by the claim check: ${p.kind === "state" ? `the lifecycle of \`${p.label}\`` : `the before/after row "${short(p.label, 60)}"`} (${short(p.reason, 140)}).`);
  }
  return out;
}

/** The Report part of `review.md` (design §6.6). */
export function renderReport(final: FinalReport, header: ReportHeader): string {
  const added = header.files.reduce((n, f) => n + f.additions, 0);
  const deleted = header.files.reduce((n, f) => n + f.deletions, 0);
  const lines = [
    "# Report",
    `${header.files.length} files, +${added} −${deleted}. Commits: ${header.commits}. GitHub checks at head: ${describeChecks(header.checks)}.`,
    "",
    ...summaryLines(final.summary, final.removedParts),
    ...renderArchitectureMarkdown(final.architecture),
  ];
  for (const s of final.sections) {
    if (s.id === "measurements") continue;
    lines.push(`## ${s.title}`);
    if (s.items.length === 0) lines.push("- None");
    for (const i of s.items) {
      const where = i.cites.map((c) => citeLabel(c, header.files)).join(", ");
      lines.push(`- ${i.id}. ${oneLine(i.text)} — ${where}${i.facts.length > 0 ? ` [${i.facts.join(", ")}]` : ""}`);
      lines.push(...itemDetail(i, header.files, final.removedParts));
    }
    lines.push("");
  }
  for (const p of final.removedParts.filter((x) => x.kind === "merge")) lines.push(`Merge not applied: the claim check could not support joining ${short(p.label, 120)} (${short(p.reason, 140)}); its items stay separate.`);
  const dropped = final.removedParts.filter((x) => x.kind === "node" || x.kind === "edge");
  if (dropped.length > 0) {
    lines.push("## Removed by the claim check", ...dropped.map((p) => `- Architecture ${p.kind === "node" ? "component" : "connection"} \`${p.id}\` ${short(p.label, 80)}: ${short(p.reason, 160)}`), "");
  }
  lines.push(`Notes: ${final.notes.length === 0 ? "none" : final.notes.map(oneLine).join(" | ")}`, "");
  return lines.join("\n");
}
