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
import { ANSWER_KIND, answerProblems, answersFlow, NECESSITY_KIND, verificationOutcome, verificationPlan, type AnswerContext, type AnswersFlow, type FinalAnswer } from "./answers.js";
import { pinnedBase } from "./commands.js";
import { isLarge, questionsMode, type ReviewMode } from "./mode.js";
import { COMMAND, QUESTION_BATCH_SIZE, REVIEW_DIR } from "./constants.js";
import { commandRuns, succeeded, type CommandRun } from "./evidence.js";
import { necessityDecision, necessityJson, necessityQuestion, parseNecessityRecord, type NecessityRecord } from "./necessity.js";
import { principlesContext, principlesReading, principlesRecord, type PrinciplesContext } from "./principles.js";
import { continueIds, questionKeys, registryFromEvidence, type PriorRegistry } from "./prior.js";
import { ledgerJson, ledgerMarkdown, ledgerRead, ledgerWriteCommands, oldValue, priorState, type PriorLedger } from "./ledger.js";
import { htmlPagesFrom } from "./html.js";
import { appendixWriteCommands, htmlWriteCommands, necessityWriteCommands, qaWriteCommands, readParts, recordedNecessityJson, recordedReport } from "./parts.js";
import { withQa } from "./output.js";
import { necessityWriteCommand, writtenRecord } from "./write.js";
import { groundworkState, type Groundwork, type GroundworkState } from "./groundwork.js";
import { effectivePacks } from "./packs.js";
import type { Profile } from "./profile.js";
import { briefingQa, qaJson, renderNecessity, renderQa, type QaInput } from "./qa.js";
import { finalQuestions, itemOfSymbol, pinnedTexts, questionerProblems, questionsFlow, requiredQuestions, statedPurposes, type PinnedText, type PurposeRecord, type Question, type QuestionerOutput, type QuestionsFlow } from "./questions.js";
import { changeItems, reportView, type ReportView } from "./reportview.js";
import type { PullRequest } from "./request.js";

export interface QaContext {
  analysis: Analysis;
  /** The mode the questions and answers run in: the report's, or large when the new symbols are over the limit (design §7.6). */
  mode: ReviewMode;
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
  /** The project's design principles as N1 judges the change against them, when the profile names a file (design §7.5.1). */
  principles?: PrinciplesContext;
  /** What earlier runs left in the ledger (design §9): the ids to continue from and the posted items; empty for a first run. */
  prior: PriorRegistry;
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
  let principles: PrinciplesContext | undefined;
  const configured = profile.questions.principles;
  if (configured !== undefined) {
    const reading = principlesReading(evidence, configured, base);
    if (reading.state === "missing") return { state: "pending", reason: "the design principles file has not been read" };
    if (reading.state === "failed") return { state: "pending", reason: reading.reason };
    principles = principlesContext(reading.read, a.analysis.snapshot.files);
  }
  const symbols = g.groundwork.symbols.map((s) => ({ ...s, ...(itemOfSymbol(s, view.items) !== undefined ? { item: itemOfSymbol(s, view.items)! } : {}) }));
  const groundwork: Groundwork = { ...g.groundwork, symbols };
  const mode = questionsMode(a.analysis.snapshot.mode, groundwork.symbols.filter((s) => s.change === "new").length, profile.limits);
  return { state: "ready", ctx: { analysis: a.analysis, mode, pr, base, view, groundwork, pinned: pinnedTexts(a.analysis.snapshot.pull, a.analysis.snapshot.commits), packs: effectivePacks(profile), refs: g.refs, prior: registryFromEvidence(evidence), designDocs: profile.questions.designDocs, context: profile.context, ...(principles !== undefined ? { principles } : {}) } };
}

/** The questioner's flow: its result checked by the deterministic rules. */
export function questionerFlow(evidence: readonly EvidenceRecord[], ctx: QaContext): QuestionsFlow {
  const allPurposeKeys = requiredQuestions({ view: ctx.view, groundwork: ctx.groundwork, large: isLarge(ctx.mode) }, new Map());
  return questionsFlow(evidence, (output) => questionerProblems(output, ctx.view, ctx.groundwork, allPurposeKeys, isLarge(ctx.mode)));
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
  if (skipped) return { questions: [{ ...necessityQuestion(), stable: "necessity|N1" }], purposes: [], rejected: [], skipped: true };
  const { stated, rejected } = statedPurposes(output, ctx.view, ctx.pinned, isLarge(ctx.mode));
  const required = requiredQuestions({ view: ctx.view, groundwork: ctx.groundwork, large: isLarge(ctx.mode) }, stated);
  const purposes: PurposeRecord[] = changeItems(ctx.view, isLarge(ctx.mode)).map((i) => stated.get(i.id) ?? { item: i.id, status: "asked" });
  return { questions: continued(ctx, [necessityQuestion(), ...finalQuestions(required, output, ctx.groundwork, isLarge(ctx.mode))]), purposes, rejected, skipped: false };
}

/** The first head cite's path of each report item and high-level change: the subject a question about it keeps from head to head. */
function itemPaths(view: ReportView): (item: string) => string | undefined {
  const all = [...view.items, ...(view.changes ?? [])];
  return (item) => {
    const cites = all.find((i) => i.id === item)?.cites ?? [];
    return (cites.find((c) => c.side === "head") ?? cites[0])?.path;
  };
}

/**
 * The questions with their stable keys, and the ids the ledger gives them (design §9.4): a question whose key an earlier head's ledger
 * holds keeps that id, a new one numbers on from the ledger's last, and a first run's ids are Q1, Q2, ... as they always were.
 */
function continued(ctx: QaContext, questions: Question[]): Question[] {
  const keys = questionKeys(questions, ctx.groundwork.symbols, itemPaths(ctx.view));
  const ids = continueIds(questions, keys, ctx.prior);
  return questions.map((q) => ({ ...q, id: ids.get(q.id) ?? q.id, stable: keys.get(q.id) ?? "" }));
}

export const answerContext = (ctx: QaContext, questions: readonly Question[]): AnswerContext => ({ questions, groundwork: ctx.groundwork, view: ctx.view, packs: ctx.packs, pinned: ctx.pinned });

/** N1's own answer context: the principles that apply to the change must each be judged once. */
export const necessityContext = (ctx: QaContext): AnswerContext => ({ ...answerContext(ctx, [necessityQuestion()]), principles: ctx.principles?.applicable ?? [] });

/** N1's checked answer with its decision and the principles file it was judged against: what `necessity.json` records. */
export const necessityRecordOf = (ctx: QaContext, final: FinalAnswer, askAll: boolean): NecessityRecord => ({ final, decision: necessityDecision(final, askAll), ...(ctx.principles !== undefined ? { principles: principlesRecord(ctx.principles) } : {}) });

/** The questions the answerer answers after N1: every one but N1, which has its own flow and its own answerer job. */
export const afterNecessity = (set: QuestionSet): Question[] => set.questions.filter((q) => q.type !== "necessity");

/** N1's flow: its answerer, the verification of its citations, and the checker (design §7.5), over the necessity contract. */
export function necessityFlow(evidence: readonly EvidenceRecord[], ctx: QaContext, retryable?: (r: CommandRun) => boolean): AnswersFlow {
  return answersFlow(evidence, necessityContext(ctx), ctx.base, retryable, NECESSITY_KIND, COMMAND.citeNecessity);
}

export type RecordedNecessity = { state: "missing" } | { state: "failed"; reason: string; ref: string } | { state: "read"; record: NecessityRecord; ref: string };

/** The recorded outcome of N1: the latest `necessity-write` that ran. It is what the Answers stage and its validators read. */
export function recordedNecessity(evidence: readonly EvidenceRecord[]): RecordedNecessity {
  const w = recordedNecessityJson(evidence);
  if (w.state === "none") return { state: "missing" };
  const ref = w.refs.at(-1) ?? "";
  if (w.state === "failed") return { state: "failed", reason: w.reason, ref };
  const record = parseNecessityRecord(w.value);
  return record === undefined ? { state: "failed", reason: "the necessity-write command carries no necessity record", ref } : { state: "read", record, ref };
}

/** The single command that records N1's outcome, or undefined when it does not fit one command (then `necessityRecordCommands` writes it in parts). */
export const necessityRecordCommand = (record: NecessityRecord): EnvironmentCommand | undefined => necessityWriteCommand(necessityJson(record));

/** The commands that record N1's outcome: one command, or a part set when it does not fit one (design §6.6). */
export const necessityRecordCommands = (record: NecessityRecord): EnvironmentCommand[] => necessityWriteCommands(necessityJson(record));

/** `qa.json`, the Q&A part and the Necessity part of `review.md` the answers recompute to. */
export function qaOutputs(ctx: QaContext, set: QuestionSet, answers: FinalAnswer[], necessity?: NecessityRecord): { json: string; markdown: string; verdict: string; open: string; necessity?: string } {
  const large = isLarge(ctx.mode) && !set.skipped;
  const input: QaInput = { pr: ctx.pr, base: ctx.base, view: ctx.view, groundwork: ctx.groundwork, purposes: set.purposes, questions: set.questions, answers, skipped: set.skipped, mode: ctx.mode, ...(large ? { batches: answerBatches(afterNecessity(set)).length } : {}), ...(necessity !== undefined ? { necessity } : {}) };
  return { json: qaJson(input), markdown: renderQa(input), ...briefingQa(input), ...(necessity !== undefined ? { necessity: renderNecessity(necessity) } : {}) };
}

export interface AnswerWrites {
  /** The commands that write `qa.json`, the whole `review.md`, `review.html` and `review-appendix.html`: each a single command when it fits one, else a part set (design §6.6). */
  qa?: EnvironmentCommand[];
  /** What those commands write, recomputed: the validators compare the artifacts reconstructed from the evidence with these. */
  texts?: { json: string; markdown: string; html: string; appendix: string };
  /** The commands that first write ledger.json and ledger.md as part sets, when they do not fit the ledger write's one command. */
  ledgerParts?: EnvironmentCommand[];
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
  const report = recordedReport(evidence);
  if (report.state !== "read") return { problem: report.state === "failed" ? `the report was not written whole: ${report.reason}` : "the report was not written" };
  const markdown = withQa(report.value.markdown, { markdown: out.markdown, verdict: out.verdict, open: out.open }, out.necessity);
  // review.html and review-appendix.html are rendered from report.json as written, qa.json and necessity.json (design §6.11).
  const pages = htmlPagesFrom(report.value.json, out.json, necessity !== undefined ? necessityJson(necessity) : undefined);
  if (pages === undefined) return { problem: "review.html cannot be rendered: report.json is not a change report" };
  const html = pages.review;
  const appendix = pages.appendix;
  const texts = { json: out.json, markdown, html, appendix };
  const qa = [...qaWriteCommands(out.json, markdown), ...htmlWriteCommands(html, true), ...appendixWriteCommands(appendix, true)];
  const read = ledgerRead(evidence);
  if (read === undefined) return { qa, texts, problem: "the ledger value Fetch read is not in the evidence" };
  const old = oldValue(read.ledger);
  const prior = priorState(evidence, old);
  if (prior.state === "missing") return { qa, texts, old, prior, problem: "the prior ledger's ledger.json has not been read" };
  if (prior.state === "unreadable") return { qa, texts, old, prior, problem: `the prior ledger's ledger.json cannot be read (${prior.reason}); the ledger is not overwritten` };
  const input = { pr: ctx.pr, base: ctx.base, files: ctx.analysis.snapshot.files.length, commits: ctx.analysis.snapshot.commits.length, facts: ctx.analysis.facts.length, questions: set.questions, answers: final, purposes: set.purposes };
  const ledger = ledgerWriteCommands(ctx.pr, old, ledgerJson(input, prior.state === "read" ? prior.value : undefined), ledgerMarkdown(input));
  return { qa, texts, ledgerParts: ledger.parts, ledger: ledger.write, old, prior };
}

// ---- large mode: the answers in batches (design §7.6) ----

/**
 * The questions the answerer takes in each job: the questions of a few change items, at most `QUESTION_BATCH_SIZE`.
 * Consecutive questions of one item stay together; an item with more than a batch's worth is cut into runs.
 */
export function answerBatches(questions: readonly Question[]): Question[][] {
  const groups: Question[][] = [];
  for (const q of questions) {
    const last = groups.at(-1);
    if (last !== undefined && last[0]!.item === q.item) last.push(q);
    else groups.push([q]);
  }
  const batches: Question[][] = [];
  let cur: Question[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.length; i += QUESTION_BATCH_SIZE) {
      const part = g.slice(i, i + QUESTION_BATCH_SIZE);
      if (cur.length > 0 && cur.length + part.length > QUESTION_BATCH_SIZE) {
        batches.push(cur);
        cur = [];
      }
      cur.push(...part);
    }
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export const BATCH_RECORD_SCHEMA = "pr-review-answers-batch-v1";
export const batchRecordId = (index: number): string => `answers-record-${index + 1}`;
/** The id prefix of a batch's citation checks, so batches never share a command id. */
export const batchCitePrefix = (index: number): string => `${COMMAND.cite}-b${index + 1}`;

/** One answered batch, recorded as evidence once its checker has judged it. */
export interface BatchRecord {
  schema: typeof BATCH_RECORD_SCHEMA;
  batch: number;
  questions: string[];
  final: FinalAnswer[];
}

export const batchRecordJson = (r: BatchRecord): string => JSON.stringify(r);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** What a batch's record shows when the deterministic rules and the citation checks are applied to it again, or why it does not stand. */
function checkBatchRecord(evidence: readonly EvidenceRecord[], value: unknown, index: number, batch: readonly Question[], actx: AnswerContext, base: string): FinalAnswer[] | { problem: string } {
  if (!isObj(value) || value.schema !== BATCH_RECORD_SCHEMA || value.batch !== index + 1 || !Array.isArray(value.questions) || !Array.isArray(value.final)) return { problem: "it is not the record of this batch" };
  if (JSON.stringify(value.questions) !== JSON.stringify(batch.map((q) => q.id))) return { problem: `it covers ${JSON.stringify(value.questions)}, not the batch's ${batch.map((q) => q.id).join(", ")}` };
  const final = value.final as FinalAnswer[];
  if (JSON.stringify(final.map((a) => a.question)) !== JSON.stringify(batch.map((q) => q.id))) return { problem: "its answers are not the batch's questions in order" };
  // The deterministic rules judge what the answerer said: a downgraded answer is judged as it was before the downgrade
  // (its proposal fits that status), and the downgrade itself is checked apart: needs author, the statement kept.
  const shown = final.map((a) => (a.check.verdict === "downgraded" ? { ...a, status: a.history.at(-1)?.status ?? a.status } : a));
  const downgrade = final.filter((a) => a.check.verdict === "downgraded" && (a.status !== "needs author" || a.history.length === 0 || a.history.at(-1)!.answer !== a.answer));
  if (downgrade.length > 0) return { problem: `answer(s) ${downgrade.map((a) => a.question).join(", ")} are marked downgraded without being needs author with their statement recorded` };
  const problems = answerProblems(shown, actx);
  if (problems.length > 0) return { problem: `its answers fail the deterministic rules: ${problems.slice(0, 3).join("; ")}` };
  const verified = verificationOutcome(evidence, verificationPlan(final, actx, base, batchCitePrefix(index)));
  if (verified.state === "failed") return { problem: verified.reason };
  if (verified.state === "missing") return { problem: "its citations were not checked against the trees" };
  if (verified.problems.length > 0) return { problem: `its citations fail the checks: ${verified.problems.slice(0, 3).join("; ")}` };
  const bad = final.filter((a) => a.check.verdict !== "supported" && a.check.verdict !== "partial" && !(a.check.verdict === "downgraded" && a.status === "needs author"));
  if (bad.length > 0) return { problem: `answer(s) ${bad.map((a) => a.question).join(", ")} stand without a supported or partial verdict` };
  return final;
}

export type BatchedAnswers =
  | { state: "batch"; index: number; total: number; questions: Question[]; flow: Exclude<AnswersFlow, { state: "done" }> }
  | { state: "record"; index: number; record: BatchRecord }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; final: FinalAnswer[]; batches: number };

/**
 * Where the answers stand in large mode, from the evidence alone: the batches in order, each answered by the
 * answerer (which continues its own session from the batch before) and checked in a fresh session, then recorded.
 * A batch looks only at the agent runs after the previous batch's record, and at its own citation checks.
 */
export function batchedAnswers(evidence: readonly EvidenceRecord[], ctx: QaContext, questions: readonly Question[], retryable?: (r: CommandRun) => boolean): BatchedAnswers {
  const batches = answerBatches(questions);
  const final: FinalAnswer[] = [];
  let from = -1;
  for (const [index, batch] of batches.entries()) {
    const actx = answerContext(ctx, batch);
    const id = batchRecordId(index);
    const run = commandRuns(evidence, id).filter((r) => succeeded(r.command)).at(-1);
    // A record too large for one command was written as a part set (design §6.6), reconstructed and checked against its digest.
    const parts = run === undefined ? readParts(evidence, id, `${REVIEW_DIR}/answers/${id}.json`) : undefined;
    if (run !== undefined || parts?.state === "read") {
      let value: unknown;
      try {
        const json = run !== undefined ? writtenRecord(run.command.argv, id) : parts?.state === "read" ? parts.value : undefined;
        value = json === undefined ? undefined : JSON.parse(json);
      } catch {
        value = undefined;
      }
      const ref = run !== undefined ? run.record.ref : (parts as Extract<typeof parts, { state: "read" }>).refs.at(-1)!;
      const checked = checkBatchRecord(evidence, value, index, batch, actx, ctx.base);
      if ("problem" in checked) return { state: "supervise", reason: `the record of answer batch ${index + 1} does not validate: ${checked.problem}`, refs: [ref] };
      final.push(...checked);
      from = evidence.findIndex((e) => e.ref === ref);
      continue;
    }
    const flow = answersFlow(evidence.slice(from + 1), actx, ctx.base, retryable, ANSWER_KIND, batchCitePrefix(index));
    if (flow.state === "done") return { state: "record", index, record: { schema: BATCH_RECORD_SCHEMA, batch: index + 1, questions: batch.map((q) => q.id), final: flow.final } };
    if (flow.state === "supervise") return { state: "supervise", reason: `answer batch ${index + 1} of ${batches.length}: ${flow.reason}`, refs: flow.refs };
    return { state: "batch", index, total: batches.length, questions: batch, flow };
  }
  return { state: "done", final, batches: batches.length };
}
