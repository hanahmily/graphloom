// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The change report of a large pull request (design §6.9). It is the standard report flow with a high-level reporter:
 * one reporter job over a bounded digest of the pull request (`digest.ts`), one claim check whose quotes are verified
 * against the trees the items cite, and the same diagram job. The area partition (`areas.ts`) is kept: it feeds the
 * digest and the change map. This module holds what is particular to the large report: its context, the account of
 * the areas that `report.json` carries, and the budget pre-check.
 */
import type { EvidenceRecord } from "@graphloom/sdk";
import { areaFiles, GENERATED_AREA, type Partition } from "./areas.js";
import { QUESTION_BATCH_SIZE } from "./constants.js";
import type { CommandRun } from "./evidence.js";
import { reportFlow, type ReportFlow } from "./flow.js";
import type { FinalReport, ReportContext } from "./report.js";

/** Why a file the reporter is told not to cite is in `other`, as its item says. */
export const GENERATED_NOTE = "generated code, not summarised";
export const OMITTED_NOTE = "patch not provided by GitHub";

/** What `report.json` says of the areas of a large report: each area's size, and how many items cite its files. */
export interface LargeInfo {
  areas: Array<{ id: string; name: string; kind: "read" | "generated"; paths: string[]; bytes: number; additions: number; deletions: number; items: number; removed: number }>;
  /** Files whose patch GitHub did not give; each is listed in `other`. */
  omitted: string[];
}

/** The report's context in large mode: high level (design §6.9), with the files no item is expected to cite accounted for by what the report says of each. */
export function largeContext(ctx: ReportContext, partition: Partition): ReportContext {
  const generated = partition.areas.find((a) => a.id === GENERATED_AREA);
  const unread = new Map<string, string>([...(generated?.paths ?? []).map((p) => [p, GENERATED_NOTE] as const), ...partition.omitted.map((p) => [p, OMITTED_NOTE] as const)]);
  const { candidates: _lifecycle, ...rest } = ctx;
  return { ...rest, large: true, unread, areaIds: partition.areas.map((a) => a.id) };
}

/** The areas of a finished large report, with the items that cite their files and the items the claim check removed. */
export function largeInfo(final: FinalReport, partition: Partition, ctx: Pick<ReportContext, "files">): LargeInfo {
  const items = final.sections.flatMap((s) => s.items).filter((i) => i.auto === undefined);
  return {
    areas: partition.areas.map((a) => {
      const mine = new Set(areaFiles(a, ctx.files).flatMap((f) => [f.path, ...(f.previousPath !== null ? [f.previousPath] : [])]));
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        paths: a.paths,
        bytes: a.bytes,
        additions: areaFiles(a, ctx.files).reduce((n, f) => n + f.additions, 0),
        deletions: areaFiles(a, ctx.files).reduce((n, f) => n + f.deletions, 0),
        items: items.filter((i) => i.cites.some((c) => mine.has(c.path))).length,
        removed: final.removed.filter((r) => r.cites.some((c) => mine.has(c.path))).length,
      };
    }),
    omitted: partition.omitted,
  };
}

/** Where a large report stands: the standard flow over the large context, and when it is done, the account of the areas. `ctx` is the large context. */
export function largeReportFlow(evidence: readonly EvidenceRecord[], ctx: ReportContext, partition: Partition, retryable?: (r: CommandRun) => boolean): ReportFlow {
  const flow = reportFlow(evidence, ctx, retryable);
  return flow.state === "done" ? { ...flow, info: largeInfo(flow.final, partition, ctx) } : flow;
}

// ---- budgets ----

/** What large mode needs of a run's budgets, in the pre-check before the reporter job (design §6.9, "Budgets"). */
export interface LargeNeeds {
  areas: number;
  /** The Q&A estimate, made before the groundwork exists: `ASSUMED_ITEMS_PER_AREA` items of `ASSUMED_QUESTIONS_PER_ITEM` questions an area, in batches. */
  questions: number;
  batches: number;
  agentInvocations: number;
  jobs: number;
  decisions: number;
}

/** A high-level report has about one item per area or subsystem. */
export const ASSUMED_ITEMS_PER_AREA = 2;
/** Per item in large mode: purpose, the one combined existing-reuse-common question and missing-test (design §7.6). */
export const ASSUMED_QUESTIONS_PER_ITEM = 3;
/**
 * Jobs the stages around the agents need in any run (measurements, coverage, the groundwork's reads, the quote check of the
 * claims, the writes with review.html and its appendix, the ledger, and the writes of the files the agents read instead of an
 * assignment that is too long: the claims, the groundwork, the required questions). A multi-part write adds a job per part on top.
 */
const FIXED_JOBS = 34;
/** The diagram job's agent invocations: the drawing and its one correction (design §6.10). */
const DIAGRAM_INVOCATIONS = 2;
/** The report's agent invocations: the reporter and its one claim check (a revision and corrections come on top). */
const REPORT_INVOCATIONS = 2;
/** The report's command jobs: the checker's quotes are verified against the trees by one job in the usual case. */
const REPORT_COMMAND_JOBS = 1;
const FIXED_DECISIONS = 12;

/**
 * The agent invocations, jobs and decisions large mode needs at least, for `areas` read areas: the reporter and its
 * check (and the commands that verify the quotes against the trees); the diagram job; the questioner; N1 (answerer and
 * checker, with their record); and per batch of questions an answerer, a citation check, a checker, a record and the file of the answers the checker reads.
 * Corrections and retries come on top, which is why this is a floor and not a promise.
 */
export function largeNeeds(areas: number): LargeNeeds {
  const questions = areas * ASSUMED_ITEMS_PER_AREA * ASSUMED_QUESTIONS_PER_ITEM;
  const batches = Math.max(1, Math.ceil(questions / QUESTION_BATCH_SIZE));
  const agentInvocations = REPORT_INVOCATIONS + 1 + 2 + batches * 2 + DIAGRAM_INVOCATIONS;
  const jobs = REPORT_INVOCATIONS + REPORT_COMMAND_JOBS + 1 + 4 + batches * 5 + FIXED_JOBS + DIAGRAM_INVOCATIONS * 2;
  return { areas, questions, batches, agentInvocations, jobs, decisions: jobs + FIXED_DECISIONS };
}

/** The sentence that stops the run when `remaining` cannot cover `needs`, or undefined when it can. */
export function budgetShortfall(needs: LargeNeeds, remaining: { agentInvocations: number; jobs: number; decisions: number }): string | undefined {
  const short: string[] = [];
  if (remaining.agentInvocations < needs.agentInvocations) short.push("agentInvocations");
  if (remaining.jobs < needs.jobs) short.push("jobs");
  if (remaining.decisions < needs.decisions) short.push("decisions");
  if (short.length === 0) return undefined;
  return `large mode needs at least ${needs.agentInvocations} agent invocations, ${needs.jobs} jobs and ${needs.decisions} decisions for ${needs.areas} area(s) (one reporter and one claim check with the commands that verify its quotes, the diagrams (a drawing, its checks and one correction), and about ${needs.questions} questions in ${needs.batches} batch(es) of ${QUESTION_BATCH_SIZE}), and the run has ${remaining.agentInvocations}, ${remaining.jobs} and ${remaining.decisions} left; raise the profile's budgets (${short.map((k) => `budgets.${k}`).join(", ")}) and run again, rather than lose the run halfway`;
}
