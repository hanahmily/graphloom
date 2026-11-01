// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The change report of a large pull request (design §6.9). One reporter job per area, each with its own
 * deterministic validation and claim check, then one synthesis job that writes the summary and merges the items
 * that are one conceptual change across areas, checked in one job of its own. Every checked step is recorded as
 * evidence (`area-record-<id>`, `synthesis-record`): the controller shows a validator only the newest review, so
 * the record is what the validators recompute the report from. The graph and the validators call the same
 * function, `largeReportFlow`, over the same evidence.
 */
import { validateResultShape } from "@graphloom/sdk";
import type { EvidenceRecord } from "@graphloom/sdk";
import type { EnvironmentCommand } from "@graphloom/sdk";
import { architecturePlan, architectureProblems, architectureTargets, ARCHITECTURE_SCHEMA, assembleArchitecture, EMPTY_ARCHITECTURE, isEmptyArchitecture, type Architecture } from "./architecture.js";
import { areaFiles, GENERATED_AREA, type Area, type Partition } from "./areas.js";
import { QUESTION_BATCH_SIZE, REVIEW_DIR } from "./constants.js";
import { claimTargets, collapse, readClaimCheck, summaryTargets, type ClaimReading, type ClaimTarget } from "./claims.js";
import { commandRuns, succeeded, type AgentRun, type CommandRun } from "./evidence.js";
import { REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME, replayStage, reporterResult, stageEvents, stageStep, type StageSpec } from "./flow.js";
import {
  assembleReport,
  asReporterOutput,
  CHANGE_REPORT_SCHEMA,
  MAX_BEHAVIOR_PER_ITEM,
  MAX_ITEM_CHARS,
  MAX_ITEMS_PER_SECTION,
  MAX_REPORT_BYTES,
  MAX_STATE_PER_ITEM,
  partProblems,
  reportProblems,
  summaryProblems,
  type BehaviorRow,
  type Cite,
  type FinalItem,
  type FinalReport,
  type FinalSection,
  type Purpose,
  type RemovedItem,
  type RemovedPart,
  type ReportContext,
  type ReporterOutput,
  type StateEntry,
} from "./report.js";
import { fileNames } from "./snapshot.js";
import { readParts } from "./parts.js";
import { writtenRecord } from "./write.js";

export const AREA_RECORD_SCHEMA = "pr-review-area-v1";
export const SYNTHESIS_RECORD_SCHEMA = "pr-review-synthesis-v1";
export const SYNTHESIS_SCHEMA_NAME = "change-synthesis-v1";
export const SYNTHESIS_REVISION_SCHEMA_NAME = "change-synthesis-revision-v1";
/** An area's reporter session key (`reporter-A3`), so its corrections and revision continue its own session. */
export const areaJobId = (area: string): string => `reporter-${area}`;
export const SYNTHESIS_JOB = "synthesis";
export const areaRecordId = (area: string): string => `area-record-${area}`;
export const SYNTHESIS_RECORD = "synthesis-record";
/** The notes a merged report keeps: the report's own bound. */
const MAX_NOTES = 10;
const MAX_NOTE_CHARS = 400;

const text = { type: "string" };
const strict = (required: string[], properties: Record<string, unknown>): Record<string, unknown> => ({ type: "object", additionalProperties: false, required, properties });

export interface SynthesisOutput {
  purpose: Purpose;
  overview: string;
  /** Groups of item ids (`A1.R3`) that are one conceptual change across areas, with the merged item's rewritten text. */
  merges: Array<{ items: string[]; text: string }>;
  notes: string[];
  /** The architecture diagram of the whole pull request (design §6.10), drawn here because no area sees the others. */
  architecture: Architecture;
}

/**
 * The synthesis job's result (`change-synthesis-v1`, design §6.9 step 3). Large mode returns `purpose`, `overview`
 * and `merges`, and the architecture diagram of the whole pull request (§6.10), with its own deterministic
 * validation, tree check and claim targets (`A.<node id>`, `A.e<n>`).
 */
export const CHANGE_SYNTHESIS_SCHEMA = strict(["purpose", "overview", "merges", "notes", "architecture"], {
  architecture: ARCHITECTURE_SCHEMA,
  purpose: strict(["text", "source", "quote"], { text, source: { type: "string", enum: ["stated", "inferred"] }, quote: text }),
  overview: text,
  merges: { type: "array", items: strict(["items", "text"], { items: { type: "array", items: text }, text }) },
  notes: { type: "array", items: text },
});

/** An area's context: the report's, restricted to the area's files, with the facts and state candidates that lie in them. */
export function areaContext(ctx: ReportContext, area: Pick<Area, "paths">): ReportContext {
  const files = areaFiles(area, ctx.files);
  const names = new Set(files.flatMap(fileNames));
  return {
    sections: ctx.sections,
    files,
    facts: ctx.facts.filter((f) => names.has(f.path)),
    ...(ctx.pinned !== undefined ? { pinned: ctx.pinned } : {}),
    ...(ctx.candidates !== undefined ? { candidates: ctx.candidates.filter((c) => names.has(c.path)) } : {}),
  };
}

/** The deterministic rules for an area's report: the report's own, without a summary, which the area leaves empty. */
export function areaProblems(output: ReporterOutput, ctx: ReportContext): string[] {
  const problems = reportProblems(output, ctx, { summary: false });
  if (output.purpose.text.trim() !== "" || output.purpose.quote.trim() !== "" || output.purpose.source !== "inferred" || output.overview.trim() !== "") {
    problems.unshift('an area report leaves the summary empty: purpose.text "", purpose.source "inferred", purpose.quote "" and overview ""; the synthesis job writes the summary');
  }
  if (!isEmptyArchitecture(output.architecture)) problems.unshift('an area report leaves the architecture empty: {"nodes": [], "edges": []}; the synthesis job draws the diagram of the whole pull request');
  return problems;
}

/** How an area's report is read and judged: the same stage as the whole report's, over the area's files and without a summary. */
export function areaSpec(actx: ReportContext): StageSpec<ReporterOutput> {
  return { result: (run) => reporterResult(run, actx, (o) => areaProblems(o, actx)), targets: (o) => claimTargets(o, actx, { summary: false }), files: actx.files };
}

// ---- the records ----

export interface AreaRecord {
  schema: typeof AREA_RECORD_SCHEMA;
  area: string;
  report: ReporterOutput;
  revised: boolean;
  /** The claim checker's own output, so the record recomputes. */
  check: unknown;
}

export interface SynthesisRecord {
  schema: typeof SYNTHESIS_RECORD_SCHEMA;
  synthesis: SynthesisOutput;
  revised: boolean;
  check: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The latest successful record command `id` ran, parsed, with its evidence position. */
function readRecord(evidence: readonly EvidenceRecord[], id: string): { value: unknown; ref: string; at: number } | undefined {
  const run = commandRuns(evidence, id).filter((r) => succeeded(r.command)).at(-1);
  let json: string | undefined;
  let ref: string;
  let at: number;
  if (run !== undefined) {
    json = writtenRecord(run.command.argv, id);
    ref = run.record.ref;
    at = evidence.findIndex((e) => e.ref === run.record.ref);
  } else {
    // A record too large for one command was written as a part set (design §6.6): reconstructed, and checked against its digest.
    const parts = readParts(evidence, id, `${REVIEW_DIR}/areas/${id}.json`);
    if (parts.state !== "read") return undefined;
    json = parts.value;
    ref = parts.refs.at(-1)!;
    at = parts.at;
  }
  if (json === undefined) return undefined;
  try {
    return { value: JSON.parse(json), ref, at };
  } catch {
    return undefined;
  }
}

export const recordJson = (record: AreaRecord | SynthesisRecord): string => JSON.stringify(record);

// ---- an area's recorded result ----

export interface AreaDone {
  area: Area;
  record: AreaRecord;
  final: FinalReport;
  reading: ClaimReading;
}

/** What an area's record shows when the deterministic rules and the claim check are applied to it again. */
export function checkAreaRecord(value: unknown, area: Area, actx: ReportContext): AreaDone | { problem: string } {
  if (!isObject(value) || value.schema !== AREA_RECORD_SCHEMA || value.area !== area.id || typeof value.revised !== "boolean") return { problem: "it is not an area record of this area" };
  const shape = validateResultShape(value.report, reporterSchema());
  if (shape.length > 0) return { problem: `its report breaks the contract: ${shape[0]}` };
  const report = value.report as ReporterOutput;
  const problems = areaProblems(report, actx);
  if (problems.length > 0) return { problem: `its report fails the deterministic rules: ${problems.slice(0, 3).join("; ")}` };
  const reading = readClaimCheck(value.check, claimTargets(report, actx, { summary: false }), actx.files);
  if ("problems" in reading) return { problem: `its claim check is unreadable: ${reading.problems[0]}` };
  if (reading.unchecked.length > 0) return { problem: `its claim check left ${reading.unchecked.slice(0, 4).join(", ")} unjudged` };
  if (reading.weak.size > 0 && value.revised !== true) return { problem: "its claim check found claims unsupported and the report was not revised" };
  const final = assembleReport(report, new Map(reading.weak), actx);
  return { area, record: value as unknown as AreaRecord, final, reading };
}

const reporterSchema = (): Record<string, unknown> => CHANGE_REPORT_SCHEMA as unknown as Record<string, unknown>;

// ---- the synthesis ----

/** An item an area's checked report holds, which the synthesis may merge: plugin-written items are never merged. */
export interface SynthItem {
  /** `A1.R3`: the area and the item's id in its own report. */
  key: string;
  area: string;
  section: string;
  item: FinalItem;
}

export function synthItems(done: readonly AreaDone[]): SynthItem[] {
  return done.flatMap((d) => d.final.sections.flatMap((s) => s.items.filter((i) => i.auto === undefined).map((item) => ({ key: `${d.area.id}.${item.id}`, area: d.area.id, section: s.id, item }))));
}

const sameCite = (a: Cite, b: Cite): boolean => a.path === b.path && a.side === b.side && a.start === b.start && a.end === b.end && a.symbol === b.symbol;

/** The item a merge makes: its cites, facts, state and behavior are the union of the members'; state names that collide are told apart by their area. */
export function mergedItem(members: readonly SynthItem[], textOf: string): Omit<FinalItem, "id"> {
  const cites: Cite[] = [];
  for (const m of members) for (const c of m.item.cites) if (!cites.some((x) => sameCite(x, c))) cites.push(c);
  const facts = [...new Set(members.flatMap((m) => m.item.facts))];
  const taken = new Set<string>();
  const state: StateEntry[] = [];
  for (const m of members) {
    for (const e of m.item.state) {
      // A collision is told apart by the member's area, then by its item, then by a number: no two entries of a merge share a name.
      let name = e.name;
      for (const suffix of [m.area, m.key]) {
        if (!taken.has(name)) break;
        name = `${e.name} [${suffix}]`;
      }
      for (let n = 2; taken.has(name); n += 1) name = `${e.name} [${m.key}#${n}]`;
      taken.add(name);
      state.push(name === e.name ? e : { ...e, name });
    }
  }
  const behavior: BehaviorRow[] = members.flatMap((m) => m.item.behavior);
  return { text: textOf, cites, facts, state, behavior };
}

/** Every deterministic problem with a synthesis result; empty when it passes. */
export function synthesisProblems(output: SynthesisOutput, items: readonly SynthItem[], pinned: ReportContext["pinned"], files?: ReportContext["files"]): string[] {
  const problems: string[] = [];
  summaryProblems(output, { pinned }, problems);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const used = new Set<string>();
  output.merges.forEach((m, n) => {
    const at = `merge ${n + 1}`;
    if (m.items.length < 2) problems.push(`${at}: a merge joins at least two items`);
    const members: SynthItem[] = [];
    for (const key of m.items) {
      const found = byKey.get(key);
      if (found === undefined) problems.push(`${at}: ${JSON.stringify(key)} is not an item id of the areas (they look like A1.R3)`);
      else if (used.has(key)) problems.push(`${at}: ${key} is already in another merge`);
      else members.push(found);
      used.add(key);
    }
    if (m.text.trim() === "") problems.push(`${at}: the text is empty`);
    if (m.text.length > MAX_ITEM_CHARS) problems.push(`${at}: the text is ${m.text.length} characters, more than ${MAX_ITEM_CHARS}`);
    if (members.length === m.items.length && members.length >= 2) {
      if (new Set(members.map((x) => x.section)).size > 1) problems.push(`${at}: it joins items of different sections (${[...new Set(members.map((x) => x.section))].join(", ")}); a merge stays inside one section`);
      if (new Set(members.map((x) => x.area)).size < 2) problems.push(`${at}: it joins items of one area; a merge joins one change that spans areas`);
      const merged = mergedItem(members, m.text);
      if (merged.state.length > MAX_STATE_PER_ITEM) problems.push(`${at}: the merged item would have ${merged.state.length} state entries, more than ${MAX_STATE_PER_ITEM}; merge fewer items`);
      if (merged.behavior.length > MAX_BEHAVIOR_PER_ITEM) problems.push(`${at}: the merged item would have ${merged.behavior.length} behavior rows, more than ${MAX_BEHAVIOR_PER_ITEM}; merge fewer items`);
      // The rules the assembled report applies to an item, so a bad merge is corrected before the synthesis is recorded.
      if (files !== undefined) partProblems({ ...merged }, files, at, problems);
    }
  });
  if (output.notes.length > MAX_NOTES) problems.push(`notes has ${output.notes.length} entries, more than ${MAX_NOTES}`);
  output.notes.forEach((n, i) => {
    if (n.length > MAX_NOTE_CHARS) problems.push(`note ${i + 1} is ${n.length} characters, more than ${MAX_NOTE_CHARS}`);
  });
  if (files !== undefined) problems.push(...architectureProblems(output.architecture, files));
  return problems;
}

/** The claims of a synthesis: the summary's, each merge (`M1`...), and the architecture diagram's nodes and edges (`A.<id>`, `A.e<n>`). */
export function synthesisTargets(output: SynthesisOutput, items: readonly SynthItem[], archNotes?: ReadonlyMap<string, string>): ClaimTarget[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  return [
    ...summaryTargets(output),
    ...output.merges.map((m, n) => {
      const members = m.items.map((k) => byKey.get(k)).filter((x): x is SynthItem => x !== undefined);
      const own = members.map((x) => `${x.key} "${collapse(x.item.text).slice(0, 160)}"`).join(" | ");
      return { id: `M${n + 1}`, text: `Merge M${n + 1}, one change that spans areas: ${collapse(m.text)} (it joins ${own})`, cites: mergedItem(members, m.text).cites, quotes: "required" as const };
    }),
    ...architectureTargets(output.architecture, archNotes),
  ];
}

/** A synthesis run: a valid result, the problems with it, or nothing (its job did not complete). */
function synthesisResult(run: AgentRun, items: readonly SynthItem[], pinned: ReportContext["pinned"], files: ReportContext["files"]): { output: SynthesisOutput } | { problems: string[] } | undefined {
  if (run.status !== "completed") return undefined;
  if (run.contract?.status === "invalid") return { problems: run.contract.problems.slice(0, 20) };
  const shape = validateResultShape(run.output, CHANGE_SYNTHESIS_SCHEMA);
  if (shape.length > 0) return { problems: shape.slice(0, 20) };
  const output = run.output as SynthesisOutput;
  const problems = synthesisProblems(output, items, pinned, files);
  return problems.length > 0 ? { problems: problems.slice(0, 30) } : { output };
}

export function synthesisSpec(items: readonly SynthItem[], ctx: ReportContext): StageSpec<SynthesisOutput> {
  return {
    result: (run) => synthesisResult(run, items, ctx.pinned, ctx.files),
    targets: (o, archNotes) => synthesisTargets(o, items, archNotes),
    files: ctx.files,
    verify: (o) => architecturePlan(o.architecture, ctx.base),
  };
}

export interface SynthesisDone {
  record: SynthesisRecord;
  reading: ClaimReading;
}

export function checkSynthesisRecord(value: unknown, items: readonly SynthItem[], ctx: ReportContext): SynthesisDone | { problem: string } {
  if (!isObject(value) || value.schema !== SYNTHESIS_RECORD_SCHEMA || typeof value.revised !== "boolean") return { problem: "it is not a synthesis record" };
  const shape = validateResultShape(value.synthesis, CHANGE_SYNTHESIS_SCHEMA);
  if (shape.length > 0) return { problem: `its synthesis breaks the contract: ${shape[0]}` };
  const synthesis = value.synthesis as SynthesisOutput;
  const problems = synthesisProblems(synthesis, items, ctx.pinned, ctx.files);
  if (problems.length > 0) return { problem: `its synthesis fails the deterministic rules: ${problems.slice(0, 3).join("; ")}` };
  const reading = readClaimCheck(value.check, synthesisTargets(synthesis, items), ctx.files);
  if ("problems" in reading) return { problem: `its claim check is unreadable: ${reading.problems[0]}` };
  if (reading.unchecked.length > 0) return { problem: `its claim check left ${reading.unchecked.slice(0, 4).join(", ")} unjudged` };
  if (reading.weak.size > 0 && value.revised !== true) return { problem: "its claim check found claims unsupported and the synthesis was not revised" };
  return { record: value as unknown as SynthesisRecord, reading };
}

// ---- the merged report ----

export interface LargeInfo {
  areas: Array<{ id: string; name: string; kind: "read" | "generated"; paths: string[]; bytes: number; items: number; removed: number }>;
  /** Files whose patch GitHub did not give; each is listed in `other`. */
  omitted: string[];
  merges: Array<{ id: string; items: string[]; into: string | null; reason?: string }>;
}

/** Why a file no agent read as a patch is in `other`, as its item says. */
export const GENERATED_NOTE = "generated code, not read by an agent";
export const OMITTED_NOTE = "patch not provided by GitHub";

/** The report's context for the merged report: bounds that grow with the areas, and the unread files with what the report says of each. */
export function wholeContext(ctx: ReportContext, partition: Partition): ReportContext {
  const generated = partition.areas.find((a) => a.id === GENERATED_AREA);
  const unread = new Map<string, string>([...(generated?.paths ?? []).map((p) => [p, GENERATED_NOTE] as const), ...partition.omitted.map((p) => [p, OMITTED_NOTE] as const)]);
  const readAreas = partition.areas.filter((a) => a.kind === "read").length;
  return { ...ctx, maxItemsPerSection: MAX_ITEMS_PER_SECTION * (readAreas + 1), maxBytes: MAX_REPORT_BYTES * (readAreas + 1), unread };
}

const clipNote = (n: string): string => (n.length <= MAX_NOTE_CHARS ? n : `${n.slice(0, MAX_NOTE_CHARS - 1)}…`);

/**
 * The report once every area is checked and the synthesis is read: the areas' items in section order, each merge
 * applied (an unsupported one is not, and is recorded), the unread files accounted for in `other`, the summary the
 * synthesis wrote, and every item numbered `R1`... in section order.
 */
export function assembleLarge(done: readonly AreaDone[], synthesis: SynthesisDone | undefined, ctx: ReportContext, partition: Partition): { final: FinalReport; info: LargeInfo; report: ReporterOutput } {
  const whole = wholeContext(ctx, partition);
  const items = synthItems(done);
  const byKey = new Map(items.map((i) => [i.key, i] as const));
  const weak = synthesis?.reading.weak ?? new Map<string, string>();
  const merges: Array<{ id: string; keys: string[]; text: string }> = (synthesis?.record.synthesis.merges ?? []).map((m, n) => ({ id: `M${n + 1}`, keys: m.items, text: m.text }));
  const applied = merges.filter((m) => !weak.has(m.id));
  const mergeOf = new Map<string, (typeof merges)[number]>();
  for (const m of applied) for (const k of m.keys) mergeOf.set(k, m);

  // Per section: the areas' items in area order, each merge standing where its first member stood.
  type Slot = { keys: string[]; item: Omit<FinalItem, "id">; auto?: FinalItem["auto"] };
  const placed = new Set<string>();
  const bySection = new Map<string, Slot[]>(ctx.sections.map((s) => [s.id, []]));
  for (const d of done) {
    for (const s of d.final.sections) {
      for (const item of s.items) {
        const key = `${d.area.id}.${item.id}`;
        const target = bySection.get(s.id);
        if (target === undefined) continue;
        const m = mergeOf.get(key);
        if (m === undefined) {
          const { id: _id, ...rest } = item;
          target.push({ keys: [key], item: rest, ...(item.auto !== undefined ? { auto: item.auto } : {}) });
        } else if (!placed.has(m.id)) {
          placed.add(m.id);
          const members = m.keys.map((k) => byKey.get(k)!);
          target.push({ keys: m.keys, item: mergedItem(members, m.text) });
        }
      }
    }
  }

  // The unread files: accounted for by plugin-written items, as a report with no items of its own is.
  const generated = partition.areas.find((a) => a.id === GENERATED_AREA);
  const unreadPaths = new Set([...(generated?.paths ?? []), ...partition.omitted]);
  const unreadFiles = ctx.files.filter((f) => unreadPaths.has(f.path));
  const unreadNames = new Set(unreadFiles.flatMap(fileNames));
  const unreadFinal = assembleReport({ sections: ctx.sections.map((s) => ({ id: s.id, none: true, items: [] })), notes: [] }, new Map(), { ...whole, files: unreadFiles, facts: ctx.facts.filter((f) => unreadNames.has(f.path)) });
  for (const s of unreadFinal.sections) {
    for (const item of s.items) {
      const { id: _id, ...rest } = item;
      bySection.get(s.id)?.push({ keys: [], item: rest, ...(item.auto !== undefined ? { auto: item.auto } : {}) });
    }
  }

  // Number R1... in section order, and remember where each area item went.
  const newId = new Map<string, string>();
  let n = 0;
  const sections: FinalSection[] = ctx.sections.map((def) => ({
    id: def.id,
    title: def.title,
    none: (bySection.get(def.id) ?? []).length === 0,
    items: (bySection.get(def.id) ?? []).map((slot): FinalItem => {
      n += 1;
      const id = `R${n}`;
      for (const k of slot.keys) newId.set(k, id);
      return { id, ...slot.item, ...(slot.auto !== undefined ? { auto: slot.auto } : {}) };
    }),
  }));

  const removed: RemovedItem[] = [];
  const parts: RemovedPart[] = [];
  for (const d of done) {
    for (const r of d.final.removed) removed.push({ ...r, id: `${d.area.id}.${r.id}` });
    for (const p of d.final.removedParts) parts.push({ ...p, id: `${d.area.id}.${p.id}`, item: p.item === "" ? "" : (newId.get(`${d.area.id}.${p.item}`) ?? `${d.area.id}.${p.item}`) });
  }
  const output = synthesis?.record.synthesis;
  for (const m of merges) {
    const reason = weak.get(m.id);
    if (reason !== undefined) parts.push({ id: m.id, kind: "merge", item: "", label: m.keys.join(" + "), reason });
  }
  const purposeReason = weak.get("purpose");
  const overviewReason = weak.get("overview");
  if (output !== undefined && purposeReason !== undefined) parts.push({ id: "purpose", kind: "purpose", item: "", label: output.purpose.text, reason: purposeReason });
  if (output !== undefined && overviewReason !== undefined) parts.push({ id: "overview", kind: "overview", item: "", label: output.overview, reason: overviewReason });

  // The diagram is the synthesis job's; a node or an edge the claim check could not support is dropped (design §6.10).
  const arch = assembleArchitecture(output?.architecture ?? EMPTY_ARCHITECTURE, weak);
  parts.push(...arch.parts);

  const allNotes = [...new Set([...done.flatMap((d) => d.final.notes), ...(output?.notes ?? [])].map(clipNote))];
  const notes = allNotes.length <= MAX_NOTES ? allNotes : [...allNotes.slice(0, MAX_NOTES - 1), `${allNotes.length - (MAX_NOTES - 1)} more note(s) were left out; see the areas' records`];

  const final: FinalReport = {
    summary: { purpose: output === undefined || purposeReason !== undefined ? null : output.purpose, overview: output === undefined || overviewReason !== undefined ? null : output.overview },
    sections,
    notes,
    removed,
    removedParts: parts,
    architecture: arch.architecture,
  };
  const info: LargeInfo = {
    areas: partition.areas.map((a) => {
      const d = done.find((x) => x.area.id === a.id);
      return { id: a.id, name: a.name, kind: a.kind, paths: a.paths, bytes: a.bytes, items: d === undefined ? 0 : d.final.sections.reduce((k, s) => k + s.items.length, 0), removed: d === undefined ? 0 : d.final.removed.length };
    }),
    omitted: partition.omitted,
    merges: merges.map((m) => {
      const reason = weak.get(m.id);
      return { id: m.id, items: m.keys, into: reason === undefined ? (newId.get(m.keys[0]!) ?? null) : null, ...(reason !== undefined ? { reason } : {}) };
    }),
  };
  const report: ReporterOutput = {
    purpose: output?.purpose ?? { text: "", source: "inferred", quote: "" },
    overview: output?.overview ?? "",
    ...asReporterOutput(final),
  };  return { final, info, report };
}

// ---- the flow ----

export type LargeFlow =
  | { state: "area"; area: Area; index: number; kind: "first" | "correction" | "revision"; feedback: string[]; schema: string }
  | { state: "area-checker"; area: Area; report: ReporterOutput; retry: boolean }
  | { state: "area-record"; area: Area; record: AreaRecord }
  | { state: "synthesis"; kind: "first" | "correction" | "revision"; feedback: string[]; schema: string; items: SynthItem[]; areas: AreaDone[] }
  | { state: "synthesis-checker"; output: SynthesisOutput; retry: boolean; items: SynthItem[]; areas: AreaDone[]; archNotes: ReadonlyMap<string, string> }
  | { state: "verify"; commands: EnvironmentCommand[] }
  | { state: "synthesis-record"; record: SynthesisRecord }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; report: ReporterOutput; final: FinalReport; reading: ClaimReading; info: LargeInfo; refs: string[] };

/**
 * Where a large report stands, from the evidence alone: the areas in order (each its reporter, its deterministic
 * validation and corrections, its claim check and one revision, then its record), then the synthesis the same way,
 * then the merged report. `partition` is the snapshot's own.
 */
export function largeReportFlow(evidence: readonly EvidenceRecord[], ctx: ReportContext, partition: Partition, retryable?: (r: CommandRun) => boolean): LargeFlow {
  const readAreas = partition.areas.filter((a) => a.kind === "read");
  const done: AreaDone[] = [];
  let from = -1;
  let last: string | undefined;
  for (const [index, area] of readAreas.entries()) {
    const actx = areaContext(ctx, area);
    const rec = readRecord(evidence, areaRecordId(area.id));
    if (rec !== undefined) {
      const checked = checkAreaRecord(rec.value, area, actx);
      if ("problem" in checked) return { state: "supervise", reason: `the record of area ${area.id} does not validate: ${checked.problem}`, refs: [rec.ref] };
      done.push(checked);
      from = rec.at;
      last = rec.ref;
      continue;
    }
    const spec = areaSpec(actx);
    const rep = replayStage(stageEvents(evidence, [REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME], from), spec);
    const step = stageStep(rep, spec, { first: REPORTER_SCHEMA_NAME, revision: REVISION_SCHEMA_NAME, scope: `area ${area.id}: ` }, retryable);
    switch (step.state) {
      case "supervise":
        return step;
      case "reporter":
        return { state: "area", area, index, kind: step.kind, feedback: step.feedback, schema: step.schema };
      case "checker":
        return { state: "area-checker", area, report: step.output, retry: step.retry };
      case "verify":
        return { state: "supervise", reason: `area ${area.id}: an area report carries no architecture, so no tree check is due`, refs: [] };
      case "finished":
        return { state: "area-record", area, record: { schema: AREA_RECORD_SCHEMA, area: area.id, report: step.output, revised: step.revised, check: step.checked } };
    }
  }
  const items = synthItems(done);
  const rec = readRecord(evidence, SYNTHESIS_RECORD);
  let synthesis: SynthesisDone | undefined;
  if (rec !== undefined) {
    const checked = checkSynthesisRecord(rec.value, items, ctx);
    if ("problem" in checked) return { state: "supervise", reason: `the synthesis record does not validate: ${checked.problem}`, refs: [rec.ref] };
    synthesis = checked;
    last = rec.ref;
  } else {
    const spec = synthesisSpec(items, ctx);
    const rep = replayStage(stageEvents(evidence, [SYNTHESIS_SCHEMA_NAME, SYNTHESIS_REVISION_SCHEMA_NAME], from), spec);
    const step = stageStep(rep, spec, { first: SYNTHESIS_SCHEMA_NAME, revision: SYNTHESIS_REVISION_SCHEMA_NAME, scope: "the synthesis: " }, retryable);
    switch (step.state) {
      case "supervise":
        return step;
      case "reporter":
        return { state: "synthesis", kind: step.kind, feedback: step.feedback, schema: step.schema, items, areas: done };
      case "checker":
        return { state: "synthesis-checker", output: step.output, retry: step.retry, items, areas: done, archNotes: step.archNotes };
      case "verify":
        return step;
      case "finished":
        return { state: "synthesis-record", record: { schema: SYNTHESIS_RECORD_SCHEMA, synthesis: step.output, revised: step.revised, check: step.checked } };
    }
  }
  const { final, info, report } = assembleLarge(done, synthesis, ctx, partition);
  const problems = reportProblems(asReporterOutput(final), wholeContext(ctx, partition), { final: true });
  if (problems.length > 0) return { state: "supervise", reason: `the assembled large report fails its own validation: ${problems.slice(0, 3).join("; ")}`, refs: last !== undefined ? [last] : [] };
  const supported = new Set(final.sections.flatMap((s) => s.items).filter((i) => i.auto === undefined).map((i) => i.id));
  const reading: ClaimReading = { unchecked: [], supported, weak: new Map(), notes: [...new Set([...done.flatMap((d) => d.reading.notes), ...(synthesis?.reading.notes ?? [])])], ignored: [] };
  return { state: "done", report, final, reading, info, refs: last !== undefined ? [last] : [] };
}

// ---- budgets ----

/** What large mode needs of a run's budgets, in the pre-check before the first reporter job (design §6.9, "Budgets"). */
export interface LargeNeeds {
  areas: number;
  /** The Q&A estimate, made before the groundwork exists: `ITEMS_PER_AREA` items of `QUESTIONS_PER_ITEM` questions an area, in batches. */
  questions: number;
  batches: number;
  agentInvocations: number;
  jobs: number;
  decisions: number;
}

export const ASSUMED_ITEMS_PER_AREA = 3;
export const ASSUMED_QUESTIONS_PER_ITEM = 5;
/** Jobs the stages around the agents need in any run (measurements, coverage, the groundwork's reads, the architecture tree check, the writes with review.html, the ledger). A multi-part write adds a job per part on top. */
const FIXED_JOBS = 24;
const FIXED_DECISIONS = 12;

/**
 * The agent invocations, jobs and decisions large mode needs at least, for `areas` read areas: per area a reporter,
 * a checker and a record; the synthesis and its check and record; the questioner; N1 (answerer, checker, record);
 * and per batch of questions an answerer, a citation check, a checker and a record. Corrections and retries come on
 * top, which is why this is a floor and not a promise.
 */
export function largeNeeds(areas: number): LargeNeeds {
  const questions = areas * ASSUMED_ITEMS_PER_AREA * ASSUMED_QUESTIONS_PER_ITEM;
  const batches = Math.max(1, Math.ceil(questions / QUESTION_BATCH_SIZE));
  const agentInvocations = areas * 2 + 2 + 1 + 2 + batches * 2;
  const jobs = areas * 3 + 3 + 1 + 4 + batches * 4 + FIXED_JOBS;
  return { areas, questions, batches, agentInvocations, jobs, decisions: jobs + FIXED_DECISIONS };
}

/** The sentence that stops the run when `remaining` cannot cover `needs`, or undefined when it can. */
export function budgetShortfall(needs: LargeNeeds, remaining: { agentInvocations: number; jobs: number; decisions: number }): string | undefined {
  const short: string[] = [];
  if (remaining.agentInvocations < needs.agentInvocations) short.push("agentInvocations");
  if (remaining.jobs < needs.jobs) short.push("jobs");
  if (remaining.decisions < needs.decisions) short.push("decisions");
  if (short.length === 0) return undefined;
  return `large mode needs at least ${needs.agentInvocations} agent invocations, ${needs.jobs} jobs and ${needs.decisions} decisions for ${needs.areas} area(s) (areas × (reporter + checker + record), the synthesis with its check, and about ${needs.questions} questions in ${needs.batches} batch(es) of ${QUESTION_BATCH_SIZE}), and the run has ${remaining.agentInvocations}, ${remaining.jobs} and ${remaining.decisions} left; raise the profile's budgets (${short.map((k) => `budgets.${k}`).join(", ")}) and run again, rather than lose the run halfway`;
}
