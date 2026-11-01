// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Where the report stands (design §6.4), read from the evidence alone: the
 * reporter writes, deterministic validation corrects (at most
 * MAX_REPORT_CORRECTIONS times, then the supervisor), a checker on another
 * harness judges every item, the reporter revises once what was not
 * supported, and what is still not supported leaves the report.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { CLAIM_CHECK_SCHEMA_NAME, claimTargets, readClaimCheck, type ClaimReading, type ClaimTarget } from "./claims.js";
import { MAX_CHECK_RETRIES, MAX_REPORT_CORRECTIONS } from "./constants.js";
import { agentRuns, type AgentRun } from "./evidence.js";
import type { PullFile } from "./snapshot.js";
import type { LargeInfo } from "./large.js";
import { assembleReport, asReporterOutput, numbered, parseReporterOutput, reportProblems, type BehaviorRow, type Cite, type FinalReport, type ReportContext, type ReportItem, type ReporterOutput, type StateEntry } from "./report.js";

export const REPORTER_SCHEMA_NAME = "change-report-v1";
/**
 * The same shape, asked again after the claim check (design §6.4 step 4). A second name, so the evidence
 * itself says which result is the revision: the controller keeps only the latest review evidence for a
 * validator, so an earlier claim check cannot be what tells a revision from a correction.
 */
export const REVISION_SCHEMA_NAME = "change-report-revision-v1";

export type ReportFlow =
  | { state: "reporter"; kind: "first" | "correction" | "revision"; feedback: string[]; schema: string }
  | { state: "checker"; report: ReporterOutput; retry: boolean }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; report: ReporterOutput; final: FinalReport; reading: ClaimReading; refs: string[]; /** Large mode: the areas, the unread files and the merges (design §6.9). */ info?: LargeInfo };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What can be read of a result the contract refused (an extra property, a
 * missing one), so one correction can name every problem at once: the
 * contract's own and the deterministic ones in what is readable.
 */
function salvage(output: unknown): ReporterOutput | undefined {
  if (!isObject(output) || !Array.isArray(output.sections)) return undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const string = (v: unknown): string => (typeof v === "string" ? v : "");
  const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);
  const cite = (c: unknown): Cite[] => (isObject(c) && typeof c.path === "string" ? [{ path: c.path, side: c.side === "base" ? "base" : "head", start: int(c.start), end: int(c.end), symbol: string(c.symbol) }] : []);
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const entry = (e: unknown): StateEntry[] =>
    isObject(e) && typeof e.name === "string"
      ? [
          {
            name: e.name,
            scope: string(e.scope),
            initial: string(e.initial),
            transitions: list(e.transitions).flatMap((t) => (isObject(t) ? cite(t.cite).map((c) => ({ when: string(t.when), effect: string(t.effect), cite: c })) : [])),
            reads: list(e.reads).flatMap((r) => (isObject(r) ? cite(r.cite).map((c) => ({ where: string(r.where), decision: string(r.decision), cite: c })) : [])),
          },
        ]
      : [];
  const row = (b: unknown): BehaviorRow[] => (isObject(b) ? [{ case: string(b.case), before: string(b.before), after: string(b.after) }] : []);
  const item = (i: unknown): ReportItem[] =>
    isObject(i) && typeof i.text === "string" && Array.isArray(i.cites) ? [{ text: i.text, cites: i.cites.flatMap(cite), facts: strings(i.facts), state: list(i.state).flatMap(entry), behavior: list(i.behavior).flatMap(row) }] : [];
  const p = isObject(output.purpose) ? output.purpose : {};
  return {
    purpose: { text: string(p.text), source: p.source === "stated" ? "stated" : "inferred", quote: string(p.quote) },
    overview: string(output.overview),
    sections: output.sections.flatMap((s) => (isObject(s) && typeof s.id === "string" && Array.isArray(s.items) ? [{ id: s.id, none: s.none === true, items: s.items.flatMap(item) }] : [])),
    notes: strings(output.notes),
  };
}

/** What a reporter run gives: a valid result, the problems with it, or nothing (its job did not complete). `check` replaces the standard deterministic rules (an area's report has no summary). */
export function reporterResult(run: AgentRun, ctx: ReportContext, check: (output: ReporterOutput) => string[] = (o) => reportProblems(o, ctx)): { output: ReporterOutput } | { problems: string[] } | undefined {
  if (run.status !== "completed") return undefined;
  if (run.contract?.status === "invalid") {
    const readable = salvage(run.output);
    return { problems: [...run.contract.problems, ...(readable !== undefined ? check(readable) : [])].slice(0, 30) };
  }
  const parsed = parseReporterOutput(run.output);
  if ("problems" in parsed) return parsed;
  const problems = check(parsed.output);
  return problems.length > 0 ? { problems } : { output: parsed.output };
}

/** The items of a report with their `R<n>` ids, for the checker. */
export function itemsOf(report: ReporterOutput, ctx: Pick<ReportContext, "sections">): Array<{ id: string; section: string; item: ReporterOutput["sections"][number]["items"][number] }> {
  return numbered(report, ctx);
}

/** One step of a flow's history: a reporter's run, or a checker's. */
export interface StageEvent {
  kind: "reporter" | "checker";
  run: AgentRun;
}

/**
 * The reporter and checker runs of the given result schemas that came after evidence position `from`, oldest
 * first. A large report's areas and its synthesis each look at the runs after the previous record (design §6.9).
 */
export function stageEvents(evidence: readonly EvidenceRecord[], reporterSchemas: readonly string[], from = -1): StageEvent[] {
  const index = new Map(evidence.map((e, i) => [e.ref, i]));
  const at = (run: AgentRun): number => index.get(run.record.ref) ?? 0;
  const reporters = reporterSchemas.flatMap((schema) => agentRuns(evidence, schema).map((run) => ({ kind: "reporter" as const, run })));
  const checkers = agentRuns(evidence, CLAIM_CHECK_SCHEMA_NAME).map((run) => ({ kind: "checker" as const, run }));
  return [...reporters, ...checkers].filter((e) => at(e.run) > from).sort((a, b) => at(a.run) - at(b.run));
}

/** What a stage (a report, an area's report, the synthesis) is judged by: how to read a reporter run, what claims its output makes, and which files its quotes may come from. */
export interface StageSpec<T> {
  result(run: AgentRun): { output: T } | { problems: string[] } | undefined;
  targets(output: T): ClaimTarget[];
  files: readonly PullFile[];
}

/** Where a stage stands after its events: the latest valid output, and what the checker said of it. */
export interface StageReplay<T> {
  output?: T;
  revised: boolean;
  reading?: ClaimReading;
  /** The checker's output that `reading` was read from, which a large report records. */
  checked?: unknown;
  pending?: { problems: string[]; revision: boolean };
  detProblems: number;
  checkTries: number;
  ignored: string[];
  refs: string[];
}

/** Replays a stage's events (design §6.4): the reporter writes, deterministic validation corrects, the checker judges, the reporter revises once. */
export function replayStage<T>(events: readonly StageEvent[], spec: StageSpec<T>): StageReplay<T> {
  const rep: StageReplay<T> = { revised: false, detProblems: 0, checkTries: 0, ignored: [], refs: [] };
  for (const ev of events) {
    rep.refs.push(ev.run.record.ref);
    if (ev.kind === "reporter") {
      const revision = ev.run.record.resultSchema?.endsWith("revision-v1") === true;
      const result = spec.result(ev.run);
      if (result === undefined) continue;
      if ("problems" in result) {
        rep.detProblems += 1;
        rep.pending = { problems: result.problems, revision };
        continue;
      }
      rep.output = result.output;
      rep.revised = revision;
      delete rep.pending;
      delete rep.reading;
      delete rep.checked;
      rep.checkTries = 0;
      continue;
    }
    if (rep.output === undefined || rep.pending !== undefined || ev.run.status !== "completed") continue;
    const read = ev.run.contract?.status === "invalid" ? { problems: ev.run.contract.problems } : readClaimCheck(ev.run.output, spec.targets(rep.output), spec.files);
    if ("problems" in read || read.unchecked.length > 0) {
      rep.checkTries += 1;
      rep.ignored = "problems" in read ? [] : read.ignored;
      continue;
    }
    rep.reading = read;
    rep.checked = ev.run.output;
  }
  return rep;
}

export type StageStep<T> =
  | { state: "reporter"; kind: "first" | "correction" | "revision"; feedback: string[]; schema: string }
  | { state: "checker"; output: T; retry: boolean }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "finished"; output: T; reading: ClaimReading; revised: boolean; checked: unknown; refs: string[] };

export interface StageNames {
  first: string;
  revision: string;
  /** Prefix of the supervisor's reasons, for a stage that is not the whole report (`area A2: `). */
  scope?: string;
}

/** The next step of a stage, from its replay. */
export function stageStep<T>(rep: StageReplay<T>, spec: StageSpec<T>, names: StageNames): StageStep<T> {
  const tail = rep.refs.slice(-10);
  const scope = names.scope ?? "";
  if (rep.pending !== undefined) {
    if (rep.detProblems > MAX_REPORT_CORRECTIONS) {
      return { state: "supervise", reason: `${scope}the reporter's result still fails deterministic validation after ${MAX_REPORT_CORRECTIONS} corrections: ${rep.pending.problems.slice(0, 3).join("; ")}`, refs: tail };
    }
    return { state: "reporter", kind: "correction", feedback: rep.pending.problems, schema: rep.pending.revision ? names.revision : names.first };
  }
  if (rep.output === undefined) return { state: "reporter", kind: "first", feedback: [], schema: names.first };
  if (rep.reading === undefined) {
    if (rep.checkTries > MAX_CHECK_RETRIES) {
      return { state: "supervise", reason: `${scope}the report checker did not judge every item after ${rep.checkTries} tries${rep.ignored.length > 0 ? `; verdict ids that matched no claim: ${rep.ignored.slice(0, 4).join(", ")}` : ""}`, refs: tail };
    }
    return { state: "checker", output: rep.output, retry: rep.checkTries > 0 };
  }
  if (rep.reading.weak.size > 0 && !rep.revised) {
    const byId = new Map(spec.targets(rep.output).map((t) => [t.id, t] as const));
    const feedback = [...rep.reading.weak].map(([id, why]) => `${id}: "${(byId.get(id)?.text ?? "").slice(0, 200)}" — the claim check: ${why}`);
    return { state: "reporter", kind: "revision", feedback, schema: names.revision };
  }
  return { state: "finished", output: rep.output, reading: rep.reading, revised: rep.revised, checked: rep.checked, refs: tail };
}

/** The standard report's stage: one reporter, one checker, over the whole pull request. */
export function reportSpec(ctx: ReportContext): StageSpec<ReporterOutput> {
  return { result: (run) => reporterResult(run, ctx), targets: (output) => claimTargets(output, ctx), files: ctx.files };
}

export function reportFlow(evidence: readonly EvidenceRecord[], ctx: ReportContext): ReportFlow {
  const spec = reportSpec(ctx);
  const rep = replayStage(stageEvents(evidence, [REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME]), spec);
  const step = stageStep(rep, spec, { first: REPORTER_SCHEMA_NAME, revision: REVISION_SCHEMA_NAME });
  switch (step.state) {
    case "supervise":
      return step;
    case "reporter":
      return step;
    case "checker":
      return { state: "checker", report: step.output, retry: step.retry };
    case "finished":
      break;
  }
  const { output: report, reading } = step;
  const removed = new Map([...reading.weak].map(([id, why]) => [id, why] as const));
  const final = assembleReport(report, removed, ctx);
  const problems = reportProblems(asReporterOutput(final), ctx, { final: true });
  if (problems.length > 0) {
    return { state: "supervise", reason: `the assembled report fails its own validation: ${problems.slice(0, 3).join("; ")}`, refs: step.refs };
  }
  return { state: "done", report, final, reading, refs: step.refs };
}
