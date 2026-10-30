// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What the Questions and Answers stages share, derived from the evidence
 * alone so the graph and the validators judge the same thing: the context
 * (the finished report, the groundwork), the question set, and the output
 * files the Answers stage writes.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { analyze, type Analysis } from "./analysis.js";
import { answersFlow, NECESSITY_KIND, type AnswerContext, type AnswersFlow, type FinalAnswer } from "./answers.js";
import { pinnedBase } from "./commands.js";
import { COMMAND } from "./constants.js";
import { commandRuns, succeeded, type CommandRun } from "./evidence.js";
import { necessityJson, necessityQuestion, parseNecessityRecord, type NecessityRecord } from "./necessity.js";
import { ledgerJson, ledgerMarkdown, ledgerRead, ledgerWriteCommand, oldValue, priorState, type PriorLedger } from "./ledger.js";
import { withQa } from "./output.js";
import { necessityWriteCommand, qaWriteCommand, writtenNecessity, writtenReport } from "./write.js";
import { groundworkState, type Groundwork, type GroundworkState } from "./groundwork.js";
import { effectivePacks } from "./packs.js";
import type { Profile } from "./profile.js";
import { qaJson, renderNecessity, renderQa, type QaInput } from "./qa.js";
import { finalQuestions, itemOfSymbol, pinnedTexts, questionerProblems, questionsFlow, requiredQuestions, statedPurposes, type PinnedText, type PurposeRecord, type Question, type QuestionerOutput, type QuestionsFlow } from "./questions.js";
import { changeItems, reportView, type ReportView } from "./reportview.js";
import type { PullRequest } from "./request.js";

export interface QaContext {
  analysis: Analysis;
  pr: PullRequest;
  base: string;
  view: ReportView;
  groundwork: Groundwork;
  pinned: PinnedText[];
  packs: ReturnType<typeof effectivePacks>;
  refs: string[];
  /** The profile's design-document globs and context documents, which N1's answerer and checker search (design §7.5). */
  designDocs: string[];
  context: Profile["context"];
}

export type QaContextState =
  | { state: "pending"; reason: string }
  | { state: "groundwork"; step: Exclude<GroundworkState, { state: "ready" }> }
  | { state: "ready"; ctx: QaContext };

/** The context the Questions and Answers stages work in, or what the groundwork still needs. */
export function qaContext(evidence: readonly EvidenceRecord[], profile: Profile, pr: PullRequest, retryable?: (r: CommandRun) => boolean): QaContextState {
  const a = analyze(evidence, profile, pr);
  if (a.state === "pending") return { state: "pending", reason: a.reason };
  if (a.state === "incompatible") return { state: "pending", reason: a.problem };
  const base = pinnedBase(evidence);
  if (base === undefined) return { state: "pending", reason: "the checkout recorded no pinned base" };
  const view = reportView(evidence);
  if (view === undefined) return { state: "pending", reason: "the report was not written" };
  const g = groundworkState({ evidence, files: a.analysis.snapshot.files, profile, base, ...(retryable !== undefined ? { retryable } : {}) });
  if (g.state !== "ready") return { state: "groundwork", step: g };
  const symbols = g.groundwork.symbols.map((s) => ({ ...s, ...(itemOfSymbol(s, view.items) !== undefined ? { item: itemOfSymbol(s, view.items)! } : {}) }));
  const groundwork: Groundwork = { ...g.groundwork, symbols };
  return { state: "ready", ctx: { analysis: a.analysis, pr, base, view, groundwork, pinned: pinnedTexts(a.analysis.snapshot.pull, a.analysis.snapshot.commits), packs: effectivePacks(profile), refs: g.refs, designDocs: profile.questions.designDocs, context: profile.context } };
}

/** The questioner's flow: its result checked by the deterministic rules. */
export function questionerFlow(evidence: readonly EvidenceRecord[], ctx: QaContext): QuestionsFlow {
  const allPurposeKeys = requiredQuestions({ view: ctx.view, groundwork: ctx.groundwork }, new Map());
  return questionsFlow(evidence, (output) => questionerProblems(output, ctx.view, ctx.groundwork, allPurposeKeys));
}

export interface QuestionSet {
  /** N1 first, then (unless skipped) the required questions and the questioner's. */
  questions: Question[];
  purposes: PurposeRecord[];
  /** Stated purposes the questioner gave whose quotes are not in the pull request's text. */
  rejected: string[];
  /** N1 concluded unnecessary and the checker supports it: no other question is asked (design §7.5). */
  skipped: boolean;
}

/**
 * The questions the Q&A asks, from the questioner's result (none yet means the plugin's own wording throughout).
 * N1, the necessity question, is always first; when it is skipped past, it is the only one.
 */
export function questionSet(ctx: QaContext, output: QuestionerOutput | undefined, skipped = false): QuestionSet {
  if (skipped) return { questions: [necessityQuestion()], purposes: [], rejected: [], skipped: true };
  const { stated, rejected } = statedPurposes(output, ctx.view, ctx.pinned);
  const required = requiredQuestions({ view: ctx.view, groundwork: ctx.groundwork }, stated);
  const purposes: PurposeRecord[] = changeItems(ctx.view).map((i) => stated.get(i.id) ?? { item: i.id, status: "asked" });
  return { questions: [necessityQuestion(), ...finalQuestions(required, output, ctx.groundwork)], purposes, rejected, skipped: false };
}

export const answerContext = (ctx: QaContext, questions: readonly Question[]): AnswerContext => ({ questions, groundwork: ctx.groundwork, view: ctx.view, packs: ctx.packs, pinned: ctx.pinned });

/** The questions the answerer answers after N1: every one but N1, which has its own flow and its own answerer job. */
export const afterNecessity = (set: QuestionSet): Question[] => set.questions.filter((q) => q.type !== "necessity");

/** N1's flow: its answerer, the verification of its citations, and the checker (design §7.5), over the necessity contract. */
export function necessityFlow(evidence: readonly EvidenceRecord[], ctx: QaContext, retryable?: (r: CommandRun) => boolean): AnswersFlow {
  return answersFlow(evidence, answerContext(ctx, [necessityQuestion()]), ctx.base, retryable, NECESSITY_KIND, COMMAND.citeNecessity);
}

export type RecordedNecessity = { state: "missing" } | { state: "failed"; reason: string; ref: string } | { state: "read"; record: NecessityRecord; ref: string };

/** The recorded outcome of N1: the latest `necessity-write` that ran. It is what the Answers stage and its validators read. */
export function recordedNecessity(evidence: readonly EvidenceRecord[]): RecordedNecessity {
  const run = commandRuns(evidence, COMMAND.necessityWrite).at(-1);
  if (run === undefined) return { state: "missing" };
  if (!succeeded(run.command)) return { state: "failed", reason: `necessity-write exited ${run.command.exitCode ?? "on a signal"}`, ref: run.record.ref };
  const json = writtenNecessity(run.command.argv);
  const record = json === undefined ? undefined : parseNecessityRecord(json);
  return record === undefined ? { state: "failed", reason: "the necessity-write command carries no necessity record", ref: run.record.ref } : { state: "read", record, ref: run.record.ref };
}

/** The command that records N1's outcome, or undefined when it does not fit one command. */
export const necessityRecordCommand = (record: NecessityRecord): EnvironmentCommand | undefined => necessityWriteCommand(necessityJson(record));

/** `qa.json`, the Q&A part and the Necessity part of `review.md` the answers recompute to. */
export function qaOutputs(ctx: QaContext, set: QuestionSet, answers: FinalAnswer[], necessity?: NecessityRecord): { json: string; markdown: string; necessity?: string } {
  const input: QaInput = { pr: ctx.pr, base: ctx.base, view: ctx.view, groundwork: ctx.groundwork, purposes: set.purposes, questions: set.questions, answers, skipped: set.skipped, ...(necessity !== undefined ? { necessity } : {}) };
  return { json: qaJson(input), markdown: renderQa(input), ...(necessity !== undefined ? { necessity: renderNecessity(necessity) } : {}) };
}

export interface AnswerWrites {
  /** The `qa-write` command: `qa.json` and the whole `review.md`. */
  qa?: EnvironmentCommand;
  /** The `ledger-write` command, once the ledger value is read (and the prior ledger.json, when one is there to read). */
  ledger?: EnvironmentCommand;
  /** The value the ledger write swaps from: what Fetch (or a later read) saw. */
  old?: string;
  /** The prior ledger.json, read from the commit the ledger write swaps from. */
  prior?: PriorLedger;
  /** Why a write cannot be built. */
  problem?: string;
}

/** The writes the Answers stage makes, recomputed from the evidence: what `qa-write` and `ledger-write` must carry. */
export function answerWrites(evidence: readonly EvidenceRecord[], ctx: QaContext, set: QuestionSet, final: FinalAnswer[], necessity?: NecessityRecord): AnswerWrites {
  const out = qaOutputs(ctx, set, final, necessity);
  const report = commandRuns(evidence, COMMAND.reportWrite).filter((r) => succeeded(r.command)).at(-1);
  const written = report !== undefined ? writtenReport(report.command.argv) : undefined;
  if (written === undefined) return { problem: "the report was not written" };
  const qa = qaWriteCommand(out.json, withQa(written.markdown, out.markdown, out.necessity));
  if (qa === undefined) return { problem: `the Q&A is too large for one write command (${out.json.length} characters of JSON)` };
  const read = ledgerRead(evidence);
  if (read === undefined) return { qa, problem: "the ledger value Fetch read is not in the evidence" };
  const old = oldValue(read.ledger);
  const prior = priorState(evidence, old);
  if (prior.state === "missing") return { qa, old, prior, problem: "the prior ledger's ledger.json has not been read" };
  if (prior.state === "unreadable") return { qa, old, prior, problem: `the prior ledger's ledger.json cannot be read (${prior.reason}); the ledger is not overwritten` };
  const input = { pr: ctx.pr, base: ctx.base, files: ctx.analysis.snapshot.files.length, commits: ctx.analysis.snapshot.commits.length, facts: ctx.analysis.facts.length, questions: set.questions, answers: final, purposes: set.purposes };
  const ledger = ledgerWriteCommand(ctx.pr, old, ledgerJson(input, prior.state === "read" ? prior.value : undefined), ledgerMarkdown(input));
  return ledger === undefined ? { qa, old, prior, problem: "the ledger files are too large for one command" } : { qa, ledger, old, prior };
}
