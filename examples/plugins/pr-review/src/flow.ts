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
import { CLAIM_CHECK_SCHEMA_NAME, readClaimCheck, type ClaimReading } from "./claims.js";
import { MAX_CHECK_RETRIES, MAX_REPORT_CORRECTIONS } from "./constants.js";
import { agentRuns, type AgentRun } from "./evidence.js";
import { assembleReport, asReporterOutput, numbered, parseReporterOutput, reportProblems, type FinalReport, type ReportContext, type ReporterOutput } from "./report.js";

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
  | { state: "done"; report: ReporterOutput; final: FinalReport; reading: ClaimReading; refs: string[] };

interface Event {
  at: number;
  kind: "reporter" | "checker";
  run: AgentRun;
}

function events(evidence: readonly EvidenceRecord[]): Event[] {
  const index = new Map(evidence.map((e, i) => [e.ref, i]));
  const reporters = [REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME].flatMap((schema) => agentRuns(evidence, schema).map((run) => ({ at: index.get(run.record.ref) ?? 0, kind: "reporter" as const, run })));
  const checkers = agentRuns(evidence, CLAIM_CHECK_SCHEMA_NAME).map((run) => ({ at: index.get(run.record.ref) ?? 0, kind: "checker" as const, run }));
  return [...reporters, ...checkers].sort((a, b) => a.at - b.at);
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What can be read of a result the contract refused (an extra property, a
 * missing one), so one correction can name every problem at once: the
 * contract's own and the deterministic ones in what is readable.
 */
function salvage(output: unknown): ReporterOutput | undefined {
  if (!isObject(output) || !Array.isArray(output.sections)) return undefined;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);
  const cite = (c: unknown): ReporterOutput["sections"][number]["items"][number]["cites"] =>
    isObject(c) && typeof c.path === "string" ? [{ path: c.path, side: c.side === "base" ? "base" : "head", start: int(c.start), end: int(c.end), symbol: typeof c.symbol === "string" ? c.symbol : "" }] : [];
  const item = (i: unknown): ReporterOutput["sections"][number]["items"] =>
    isObject(i) && typeof i.text === "string" && Array.isArray(i.cites) ? [{ text: i.text, cites: i.cites.flatMap(cite), facts: strings(i.facts) }] : [];
  return {
    sections: output.sections.flatMap((s) => (isObject(s) && typeof s.id === "string" && Array.isArray(s.items) ? [{ id: s.id, none: s.none === true, items: s.items.flatMap(item) }] : [])),
    notes: strings(output.notes),
  };
}

/** What a reporter run gives: a valid result, the problems with it, or nothing (its job did not complete). */
export function reporterResult(run: AgentRun, ctx: ReportContext): { output: ReporterOutput } | { problems: string[] } | undefined {
  if (run.status !== "completed") return undefined;
  if (run.contract?.status === "invalid") {
    const readable = salvage(run.output);
    return { problems: [...run.contract.problems, ...(readable !== undefined ? reportProblems(readable, ctx) : [])].slice(0, 30) };
  }
  const parsed = parseReporterOutput(run.output);
  if ("problems" in parsed) return parsed;
  const problems = reportProblems(parsed.output, ctx);
  return problems.length > 0 ? { problems } : { output: parsed.output };
}

/** The items of a report with their `R<n>` ids, for the checker. */
export function itemsOf(report: ReporterOutput, ctx: Pick<ReportContext, "sections">): Array<{ id: string; section: string; item: ReporterOutput["sections"][number]["items"][number] }> {
  return numbered(report, ctx);
}

export function reportFlow(evidence: readonly EvidenceRecord[], ctx: ReportContext): ReportFlow {
  let report: ReporterOutput | undefined;
  let revised = false;
  let reading: ClaimReading | undefined;
  let pending: { problems: string[]; revision: boolean } | undefined;
  let detProblems = 0;
  let checkTries = 0;
  const refs: string[] = [];
  for (const ev of events(evidence)) {
    refs.push(ev.run.record.ref);
    if (ev.kind === "reporter") {
      const revision = ev.run.record.resultSchema === REVISION_SCHEMA_NAME;
      const result = reporterResult(ev.run, ctx);
      if (result === undefined) continue;
      if ("problems" in result) {
        detProblems += 1;
        pending = { problems: result.problems, revision };
        continue;
      }
      report = result.output;
      revised = revision;
      pending = undefined;
      reading = undefined;
      checkTries = 0;
      continue;
    }
    if (report === undefined || pending !== undefined || ev.run.status !== "completed") continue;
    const read = ev.run.contract?.status === "invalid" ? { problems: ev.run.contract.problems } : readClaimCheck(ev.run.output, itemsOf(report, ctx), ctx.files);
    if ("problems" in read || read.unchecked.length > 0) {
      checkTries += 1;
      continue;
    }
    reading = read;
  }
  const tail = refs.slice(-10);
  if (pending !== undefined) {
    if (detProblems > MAX_REPORT_CORRECTIONS) {
      return { state: "supervise", reason: `the reporter's result still fails deterministic validation after ${MAX_REPORT_CORRECTIONS} corrections: ${pending.problems.slice(0, 3).join("; ")}`, refs: tail };
    }
    return { state: "reporter", kind: "correction", feedback: pending.problems, schema: pending.revision ? REVISION_SCHEMA_NAME : REPORTER_SCHEMA_NAME };
  }
  if (report === undefined) return { state: "reporter", kind: "first", feedback: [], schema: REPORTER_SCHEMA_NAME };
  if (reading === undefined) {
    if (checkTries > MAX_CHECK_RETRIES) {
      return { state: "supervise", reason: `the report checker did not judge every item after ${checkTries} tries`, refs: tail };
    }
    return { state: "checker", report, retry: checkTries > 0 };
  }
  if (reading.weak.size > 0 && !revised) {
    const byId = new Map(itemsOf(report, ctx).map((i) => [i.id, i]));
    const feedback = [...reading.weak].map(([id, why]) => `${id} (${byId.get(id)?.section ?? "?"}): "${(byId.get(id)?.item.text ?? "").slice(0, 160)}" — the claim check: ${why}`);
    return { state: "reporter", kind: "revision", feedback, schema: REVISION_SCHEMA_NAME };
  }
  const removed = new Map([...reading.weak].map(([id, why]) => [id, why] as const));
  const final = assembleReport(report, removed, ctx);
  const problems = reportProblems(asReporterOutput(final), ctx);
  if (problems.length > 0) {
    return { state: "supervise", reason: `the assembled report fails its own validation: ${problems.slice(0, 3).join("; ")}`, refs: tail };
  }
  return { state: "done", report, final, reading, refs: tail };
}
