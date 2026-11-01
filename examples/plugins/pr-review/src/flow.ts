// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Where the report stands (design §6.4), read from the evidence alone: the
 * reporter writes, deterministic validation corrects (at most
 * MAX_REPORT_CORRECTIONS times, then the supervisor), a checker on another
 * harness judges every item, the reporter revises once what was not
 * supported, and what is still not supported leaves the report.
 */
import type { EnvironmentCommand, EvidenceRecord } from "@graphloom/sdk";
import { architecturePlan, readArchitectureCheck, readTreeQuotes, treeQuotePlan, type ArchCheck, type ArchPlan, type Architecture, type TreeQuotePlan } from "./architecture.js";
import { CLAIM_CHECK_SCHEMA_NAME, claimTargets, readClaimCheck, type ClaimReading, type ClaimTarget } from "./claims.js";
import { COMMAND, MAX_CHECK_RETRIES, MAX_REPORT_CORRECTIONS } from "./constants.js";
import { agentRuns, commandRuns, reportText, succeeded, type AgentRun, type CommandRun } from "./evidence.js";
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
  | { state: "verify"; commands: EnvironmentCommand[] }
  | { state: "checker"; report: ReporterOutput; retry: boolean; /** The plugin's import notes for the architecture claims, by claim id (design §6.10). */ archNotes: ReadonlyMap<string, string> }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "done"; report: ReporterOutput; final: FinalReport; reading: ClaimReading; refs: string[]; /** Large mode: the areas and the files without a patch (design §6.9). */ info?: LargeInfo };

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
  const arch = isObject(output.architecture) ? output.architecture : {};
  const archCite = (c: unknown): ArchNodeCite[] => (isObject(c) && typeof c.path === "string" ? [{ path: c.path, side: c.side === "base" ? "base" : "head", start: int(c.start), end: int(c.end) }] : []);
  const architecture: Architecture = {
    nodes: list(arch.nodes).flatMap((n) =>
      isObject(n) && typeof n.id === "string" && typeof n.label === "string" ? archCite(n.cite).map((cite) => ({ id: n.id as string, label: n.label as string, kind: n.kind as Architecture["nodes"][number]["kind"], change: n.change as Architecture["nodes"][number]["change"], paths: strings(n.paths), cite })) : [],
    ),
    edges: list(arch.edges).flatMap((e) =>
      isObject(e) && typeof e.from === "string" && typeof e.to === "string" ? archCite(e.cite).map((cite) => ({ from: e.from as string, to: e.to as string, label: string(e.label), kind: e.kind as Architecture["edges"][number]["kind"], change: e.change as Architecture["edges"][number]["change"], cite })) : [],
    ),
  };
  return {
    architecture,
    purpose: { text: string(p.text), source: p.source === "stated" ? "stated" : "inferred", quote: string(p.quote) },
    overview: string(output.overview),
    sections: output.sections.flatMap((s) => (isObject(s) && typeof s.id === "string" && Array.isArray(s.items) ? [{ id: s.id, none: s.none === true, items: s.items.flatMap(item) }] : [])),
    notes: strings(output.notes),
  };
}

/** What a reporter run gives: a valid result, the problems with it, or nothing (its job did not complete). */
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

type ArchNodeCite = Architecture["nodes"][number]["cite"];

/** One step of a flow's history: a reporter's run, a checker's, or a run of the architecture tree check (design §6.10). */
export type StageEvent = { kind: "reporter" | "checker"; run: AgentRun } | { kind: "verify"; run: CommandRun };

/**
 * The reporter and checker runs of the given result schemas that came after evidence position `from`, oldest
 * first.
 */
export function stageEvents(evidence: readonly EvidenceRecord[], reporterSchemas: readonly string[], from = -1): StageEvent[] {
  const index = new Map(evidence.map((e, i) => [e.ref, i]));
  const at = (run: { record: EvidenceRecord }): number => index.get(run.record.ref) ?? 0;
  const reporters = reporterSchemas.flatMap((schema) => agentRuns(evidence, schema).map((run) => ({ kind: "reporter" as const, run })));
  const checkers = agentRuns(evidence, CLAIM_CHECK_SCHEMA_NAME).map((run) => ({ kind: "checker" as const, run }));
  const verifies = commandRuns(evidence)
    .filter((r) => r.command.id.startsWith(`${COMMAND.archCheck}-`) || r.command.id.startsWith(`${COMMAND.archQuote}-`))
    .map((run) => ({ kind: "verify" as const, run }));
  const events: StageEvent[] = [...reporters, ...checkers, ...verifies];
  return events.filter((e) => at(e.run) > from).sort((a, b) => at(a.run) - at(b.run));
}

/** What a stage (the report) is judged by: how to read a reporter run, what claims its output makes, and which files its quotes may come from. */
export interface StageSpec<T> {
  result(run: AgentRun): { output: T } | { problems: string[] } | undefined;
  targets(output: T, archNotes?: ReadonlyMap<string, string>): ClaimTarget[];
  files: readonly PullFile[];
  /** The tree check of the output's architecture diagram (design §6.10): undefined when the stage draws none. */
  verify?(output: T): ArchPlan | undefined;
  /** The check of the supported architecture claims' quotes against the trees their cites name (design §6.10). */
  quotes?(treeQuotes: ClaimReading["treeQuotes"]): TreeQuotePlan;
}

const sameArgv = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export type Verification = { state: "missing"; commands: EnvironmentCommand[] } | { state: "failed"; reason: string; refs: string[] } | { state: "checked"; check: ArchCheck };

type Outputs = { state: "missing"; commands: EnvironmentCommand[] } | { state: "failed"; reason: string; refs: string[] } | { state: "ready"; texts: string[] };

/** What the recorded runs of a plan's commands printed: commands still to run, a command that failed, or every output. A run counts for the command whose argv it has exactly. */
function outputsOfRuns(plan: { unavailable?: string | undefined; commands: readonly EnvironmentCommand[] }, runs: readonly CommandRun[], retryable: (r: CommandRun) => boolean): Outputs {
  if (plan.unavailable !== undefined) return { state: "failed", reason: plan.unavailable, refs: [] };
  const missing: EnvironmentCommand[] = [];
  const texts: string[] = [];
  for (const c of plan.commands) {
    const run = runs.filter((r) => r.command.id === c.id && sameArgv(r.command.argv, c.argv)).at(-1);
    if (run === undefined || (!succeeded(run.command) && retryable(run))) {
      missing.push(c);
      continue;
    }
    if (!succeeded(run.command)) return { state: "failed", reason: `${c.id} did not run: exit ${run.command.exitCode ?? "signal"}: ${(run.command.stderrTail || run.command.stdoutTail).slice(-300)}`, refs: [run.record.ref] };
    texts.push(reportText(run).text);
  }
  return missing.length > 0 ? { state: "missing", commands: missing } : { state: "ready", texts };
}

/** What the recorded runs say of a diagram's tree check: commands still to run, a command that failed, or the problems and notes found. */
export function verification(plan: ArchPlan, runs: readonly CommandRun[], retryable: (r: CommandRun) => boolean = () => false): Verification {
  const o = outputsOfRuns(plan, runs, retryable);
  return o.state === "ready" ? { state: "checked", check: readArchitectureCheck(plan, o.texts) } : o;
}

/** What the recorded runs say of the architecture claims' quotes: commands still to run, a command that failed, or the claims whose quotes the tree does not show. */
export function quoteVerification(plan: TreeQuotePlan, runs: readonly CommandRun[], retryable: (r: CommandRun) => boolean = () => false): { state: "missing"; commands: EnvironmentCommand[] } | { state: "failed"; reason: string; refs: string[] } | { state: "checked"; weak: Map<string, string> } {
  const o = outputsOfRuns(plan, runs, retryable);
  return o.state === "ready" ? { state: "checked", weak: readTreeQuotes(plan, o.texts) } : o;
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
  /** Results of the revision (after the claim check) that failed deterministic validation: the revision has corrections of its own. */
  revisionProblems: number;
  /** Outputs whose architecture tree check found problems, each sent back for a correction (design §6.10). */
  treeCorrections: number;
  /** The runs of the tree check seen so far; a run counts for the output whose plan has exactly its argv. */
  verifyRuns: CommandRun[];
  checkTries: number;
  ignored: string[];
  refs: string[];
}

/** Replays a stage's events (design §6.4): the reporter writes, deterministic validation corrects, the checker judges, the reporter revises once. */
export function replayStage<T>(events: readonly StageEvent[], spec: StageSpec<T>): StageReplay<T> {
  const rep: StageReplay<T> = { revised: false, detProblems: 0, revisionProblems: 0, treeCorrections: 0, verifyRuns: [], checkTries: 0, ignored: [], refs: [] };
  for (const ev of events) {
    rep.refs.push(ev.run.record.ref);
    if (ev.kind === "verify") {
      rep.verifyRuns.push(ev.run);
      continue;
    }
    if (ev.kind === "reporter") {
      const revision = ev.run.record.resultSchema?.endsWith("revision-v1") === true;
      const result = spec.result(ev.run);
      if (result === undefined) continue;
      if ("problems" in result) {
        if (revision) rep.revisionProblems += 1;
        else rep.detProblems += 1;
        rep.pending = { problems: result.problems, revision };
        continue;
      }
      // An output the tree check sent back counts as one correction, whatever it was replaced by.
      if (rep.output !== undefined && rep.reading === undefined && rep.pending === undefined && spec.verify !== undefined) {
        const plan = spec.verify(rep.output);
        if (plan !== undefined && plan.commands.length > 0) {
          const v = verification(plan, rep.verifyRuns);
          if (v.state === "checked" && v.check.problems.length > 0) rep.treeCorrections += 1;
        }
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
  | { state: "verify"; commands: EnvironmentCommand[] }
  | { state: "checker"; output: T; retry: boolean; archNotes: ReadonlyMap<string, string> }
  | { state: "supervise"; reason: string; refs: string[] }
  | { state: "finished"; output: T; reading: ClaimReading; revised: boolean; checked: unknown; refs: string[]; /** Claims whose quotes the tree did not show: already in `reading.weak`, kept for a large run's record. */ treeWeak: Record<string, string> };

export interface StageNames {
  first: string;
  revision: string;
  /** Prefix of the supervisor's reasons, for a stage that is not the whole report (`area A2: `). */
  scope?: string;
}

/** The next step of a stage, from its replay. */
export function stageStep<T>(rep: StageReplay<T>, spec: StageSpec<T>, names: StageNames, retryable?: (r: CommandRun) => boolean): StageStep<T> {
  const tail = rep.refs.slice(-10);
  const scope = names.scope ?? "";
  if (rep.pending !== undefined) {
    // The revision answers the claim check with new text, which deterministic validation judges again: it gets
    // MAX_REPORT_CORRECTIONS corrections of its own rather than whatever the first result left.
    const used = rep.pending.revision ? rep.revisionProblems : rep.detProblems;
    if (used > MAX_REPORT_CORRECTIONS) {
      return { state: "supervise", reason: `${scope}the reporter's ${rep.pending.revision ? "revision" : "result"} still fails deterministic validation after ${MAX_REPORT_CORRECTIONS} corrections: ${rep.pending.problems.slice(0, 3).join("; ")}`, refs: tail };
    }
    return { state: "reporter", kind: "correction", feedback: rep.pending.problems, schema: rep.pending.revision ? names.revision : names.first };
  }
  if (rep.output === undefined) return { state: "reporter", kind: "first", feedback: [], schema: names.first };
  if (rep.reading === undefined) {
    // The diagram's tree check (design §6.10) comes before the claim check: its problems are corrections, its notes go to the checker.
    let archNotes: ReadonlyMap<string, string> = new Map();
    const plan = spec.verify?.(rep.output);
    if (plan !== undefined && (plan.commands.length > 0 || plan.unavailable !== undefined)) {
      const v = verification(plan, rep.verifyRuns, retryable);
      if (v.state === "failed") return { state: "supervise", reason: `${scope}the architecture diagram's tree check could not run: ${v.reason}`, refs: [...v.refs, ...tail].slice(-10) };
      if (v.state === "missing") return { state: "verify", commands: v.commands };
      if (v.check.problems.length > 0) {
        if (rep.detProblems + rep.treeCorrections + 1 > MAX_REPORT_CORRECTIONS) {
          return { state: "supervise", reason: `${scope}the architecture diagram still fails the tree check after ${MAX_REPORT_CORRECTIONS} corrections: ${v.check.problems.slice(0, 3).join("; ")}`, refs: tail };
        }
        return { state: "reporter", kind: "correction", feedback: v.check.problems, schema: rep.revised ? names.revision : names.first };
      }
      archNotes = v.check.notes;
    }
    if (rep.checkTries > MAX_CHECK_RETRIES) {
      return { state: "supervise", reason: `${scope}the report checker did not judge every item after ${rep.checkTries} tries${rep.ignored.length > 0 ? `; verdict ids that matched no claim: ${rep.ignored.slice(0, 4).join(", ")}` : ""}`, refs: tail };
    }
    return { state: "checker", output: rep.output, retry: rep.checkTries > 0, archNotes };
  }
  // The architecture claims' quotes are verified against their trees (design §6.10); a quote the tree does not show makes the claim unsupported.
  let reading = rep.reading;
  const treeWeak: Record<string, string> = {};
  if (reading.treeQuotes.length > 0 && spec.quotes !== undefined) {
    const q = quoteVerification(spec.quotes(reading.treeQuotes), rep.verifyRuns, retryable);
    if (q.state === "failed") return { state: "supervise", reason: `${scope}the architecture claims' quotes could not be checked against the trees: ${q.reason}`, refs: [...q.refs, ...tail].slice(-10) };
    if (q.state === "missing") return { state: "verify", commands: q.commands };
    for (const [id, why] of q.weak) treeWeak[id] = why;
    reading = { ...reading, weak: new Map([...reading.weak, ...q.weak]), supported: new Set([...reading.supported].filter((id) => !q.weak.has(id))) };
  }
  if (reading.weak.size > 0 && !rep.revised) {
    const byId = new Map(spec.targets(rep.output).map((t) => [t.id, t] as const));
    const feedback = [...reading.weak].map(([id, why]) => `${id}: "${(byId.get(id)?.text ?? "").slice(0, 200)}" — the claim check: ${why}`);
    return { state: "reporter", kind: "revision", feedback, schema: names.revision };
  }
  return { state: "finished", output: rep.output, reading, revised: rep.revised, checked: rep.checked, refs: tail, treeWeak };
}

/** The standard report's stage: one reporter, one checker, over the whole pull request. */
export function reportSpec(ctx: ReportContext): StageSpec<ReporterOutput> {
  return {
    result: (run) => reporterResult(run, ctx),
    targets: (output, archNotes) => claimTargets(output, ctx, { ...(archNotes !== undefined ? { archNotes } : {}), ...(ctx.large === true ? { treeQuotes: true } : {}) }),
    files: ctx.files,
    verify: (output) => architecturePlan(output.architecture, ctx.base),
    quotes: (treeQuotes) => treeQuotePlan(treeQuotes, ctx.base),
  };
}

export function reportFlow(evidence: readonly EvidenceRecord[], ctx: ReportContext, retryable?: (r: CommandRun) => boolean): ReportFlow {
  const spec = reportSpec(ctx);
  const rep = replayStage(stageEvents(evidence, [REPORTER_SCHEMA_NAME, REVISION_SCHEMA_NAME]), spec);
  const step = stageStep(rep, spec, { first: REPORTER_SCHEMA_NAME, revision: REVISION_SCHEMA_NAME }, retryable);
  switch (step.state) {
    case "supervise":
      return step;
    case "reporter":
      return step;
    case "verify":
      return step;
    case "checker":
      return { state: "checker", report: step.output, retry: step.retry, archNotes: step.archNotes };
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
