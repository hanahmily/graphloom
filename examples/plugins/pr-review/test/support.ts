// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateResultShape, type EvidenceRecord, type GraphDecision, type JobSpec, type Receipt, type RehearsalScenario, type RunView } from "@graphloom/sdk";
import { advancePullRequest, definitionFor } from "../src/graph.js";
import { CODING_AGENT } from "../src/constants.js";
import { parseProfile, type Profile } from "../src/profile.js";
import { REHEARSAL_HEAD_FILES, REHEARSAL_REQUEST, rehearsal } from "../src/rehearsal.js";
import { validatorById } from "../src/validators.js";
import { writtenQa, writtenReport } from "../src/write.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BANYANDB: Record<string, unknown> = JSON.parse(readFileSync(path.join(root, "profiles", "banyandb.json"), "utf8"));
export const profileOf = (over: Record<string, unknown> = {}): Profile => parseProfile({ ...BANYANDB, ...over });

export interface Simulation {
  decisions: GraphDecision[];
  jobs: JobSpec[];
  evidence: EvidenceRecord[];
  receipts: Receipt[];
  final: GraphDecision;
  /** What the report-write command wrote. */
  written?: { json: string; markdown: string };
  /** What the qa-write command wrote: qa.json and the whole review.md. */
  qa?: { json: string; markdown: string };
}

interface Options {
  config?: Record<string, unknown>;
  scenario?: RehearsalScenario;
  scenarioName?: string;
  request?: string;
  /** Replace the files the worktree holds, by path (the stubbed checkout writes none). */
  files?: Record<string, string>;
  maxSteps?: number;
  /** Evidence the run already holds when the graph first runs: an operator's approval, a recorded conversation. */
  seed?: EvidenceRecord[];
  /** Agent sessions the run already holds (a conversation's row), before any job settles. */
  sessions?: NonNullable<RunView["agentSessions"]>;
  /** The budgets the run has left, over the generous defaults of the simulation. */
  budgets?: Partial<RunView["budgets"]>;
  /**
   * Also hand the graph (every `every` steps) and each validator the same evidence in another form (externalized
   * with lazy getters, as the plugin worker presents it), and record both answers in `compared`.
   */
  shadow?: { records: (records: EvidenceRecord[]) => EvidenceRecord[]; every: number; compared: Array<{ step: number; what: string; recorded: string; shadow: string }> };
  /** Change a job's recorded result before the graph sees it. */
  tamper?: (job: JobSpec, evidence: EvidenceRecord[]) => EvidenceRecord[] | undefined;
}

const environment = (id: string, out: string): EvidenceRecord => ({
  ref: `env-${id}`,
  kind: "command",
  candidateDigest: "d0",
  generation: 1,
  payload: { environment: { check: id }, command: { id, argv: ["sh", "-c", id], exitCode: 0, stdoutTail: out, stderrTail: "" } },
});

/**
 * What the controller hands a validator (packages/controller/src/admit.ts candidateEvidence): the latest
 * observation of each file, and only the latest review and workspace evidence. Everything else stays.
 */
export function candidateEvidence(evidence: EvidenceRecord[], digest: string): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  const files = new Set<string>();
  const kinds = new Set<string>();
  for (let i = evidence.length - 1; i >= 0; i -= 1) {
    const e = evidence[i]!;
    if (e.candidateDigest !== undefined && e.candidateDigest !== digest) continue;
    if (e.kind === "file") {
      const p = (e.payload as { path?: string }).path;
      if (p === undefined || files.has(p)) continue;
      files.add(p);
    } else if (e.kind === "review" || e.kind === "workspace") {
      if (kinds.has(e.kind)) continue;
      kinds.add(e.kind);
    }
    out.unshift(e);
  }
  return out;
}

/** Runs the real graph against a scenario's recorded reads, command results and agent replies: a scripted controller. */
/** One simulation as a generator that yields between steps, so a long one can give its event loop back. */
function* simulationSteps(options: Options = {}): Generator<undefined, Simulation, undefined> {
  const config = { ...BANYANDB, ...(options.config ?? {}) };
  const scenario = options.scenario ?? rehearsal(config).scenarios[options.scenarioName ?? "report"]!;
  const definition = definitionFor(parseProfile(config));
  const files = options.files ?? { ...REHEARSAL_HEAD_FILES };
  const evidence: EvidenceRecord[] = [environment("worktree", "/work/tree\n"), environment("plugin-root", "/plugin\n"), environment("go-root", "/usr/local/go\n")];
  const receipts: Receipt[] = [];
  const decisions: GraphDecision[] = [];
  const jobs: JobSpec[] = [];
  const cursors = new Map<string, number>();
  const sessions: NonNullable<RunView["agentSessions"]> = [...(options.sessions ?? [])];
  evidence.push(...(options.seed ?? []));
  let n = 0;
  const next = (kind: string, key: string): unknown => {
    const list = (kind === "reads" ? scenario.reads?.[key] : scenario.results[key]) ?? [];
    const i = Math.min(cursors.get(`${kind}:${key}`) ?? 0, list.length - 1);
    cursors.set(`${kind}:${key}`, i + 1);
    return list[i];
  };
  let written: Simulation["written"];
  let qa: Simulation["qa"];
  let lastWork: string | undefined;
  let digest = "d0";
  for (let step = 0; step < (options.maxSteps ?? 60); step += 1) {
    yield;
    const view: RunView = {
      runId: "rehearsal-sim",
      task: { request: options.request ?? REHEARSAL_REQUEST },
      current: { stageId: "fetch", attempt: 1 },
      receipts,
      evidence,
      outstanding: [],
      budgets: { agentInvocations: 100, jobs: 100, decisions: 100, corrections: 12, ...(options.budgets ?? {}) },
      validatorBindings: [],
      generation: 1,
      stateRevision: step,
      activeVersion: "0.2.0",
      candidateDigest: digest,
      config,
      agentSessions: sessions,
    };
    const decision = advancePullRequest(view);
    if (options.shadow !== undefined && step % options.shadow.every === 0) {
      const shadowDecision = advancePullRequest({ ...view, evidence: options.shadow.records(evidence) });
      options.shadow.compared.push({ step, what: "advance", recorded: JSON.stringify(decision), shadow: JSON.stringify(shadowDecision) });
    }
    decisions.push(decision);
    const action = decision.action;
    if (action.type === "stop" || action.type === "supervise") return { decisions, jobs, evidence, receipts, final: decision, ...(written !== undefined ? { written } : {}), ...(qa !== undefined ? { qa } : {}) };
    if (action.type === "observe") {
      for (const p of action.observe.paths ?? []) {
        const bytes = files[p];
        evidence.push({ ref: `e${(n += 1)}`, kind: "file", candidateDigest: digest, ...(bytes === undefined ? { fingerprint: "missing" } : {}), payload: { path: p, bytes: bytes ?? "" } });
      }
      continue;
    }
    if (action.type === "validate") {
      const stage = definition.stages.find((s) => s.id === action.validate.stageId)!;
      for (const id of stage.requirementIds) {
        const binding = definition.defaultValidators.find((b) => b.requirementId === id)!;
        if (binding.independence === "separate-reviewer") {
          // The controller's own admission rule (packages/controller/src/admit.ts assertSeparateReviewer).
          const review = [...evidence].reverse().find((e) => e.kind === "review");
          const who = (review?.payload as { producer?: { readOnly: boolean; purpose: string; operationId: string } } | undefined)?.producer;
          if (who === undefined || !who.readOnly || who.purpose !== "review" || who.operationId === lastWork) throw new Error(`the controller would refuse ${id}: no independent review evidence`);
        }
        const result = validatorById(binding.validatorId)!.evaluate({ requirementId: id, statement: "", evidence: candidateEvidence(evidence, digest), candidateDigest: digest, config });
        if (options.shadow !== undefined) {
          const shadowResult = validatorById(binding.validatorId)!.evaluate({ requirementId: id, statement: "", evidence: options.shadow.records(candidateEvidence(evidence, digest)), history: [], candidateDigest: digest, config });
          options.shadow.compared.push({ step, what: `validate ${id}`, recorded: JSON.stringify(result), shadow: JSON.stringify(shadowResult) });
        }
        receipts.push({ id: `r${(n += 1)}`, stageId: stage.id, requirementId: id, validatorBinding: binding, candidateFingerprint: "x", evidenceRefs: [], valid: result.status === "passed", candidateDigest: digest });
      }
      continue;
    }
    if (action.type !== "dispatch") throw new Error(`unexpected ${action.type}`);
    const job = action.job;
    jobs.push(job);
    const producer = { operationId: `op${(n += 1)}`, stageId: job.stageId, purpose: job.purpose, readOnly: job.readOnly === true, kind: job.kind, ...(job.executor !== undefined ? { executorId: job.executor.id } : {}) };
    if (job.purpose === "work") {
      lastWork = producer.operationId;
      // A job that changes the worktree changes the workspace digest, and its own evidence carries the new one.
      digest = "d1";
    }
    if (job.kind === "command" && job.executor !== undefined) {
      const read = next("reads", job.executor.id);
      evidence.push({ ref: `e${(n += 1)}`, kind: "other", candidateDigest: digest, payload: { producer, github: read } });
    } else if (job.kind === "command") {
      const input = job.input as { commands: Array<{ id: string; argv: string[] }>; continueOnFailure?: boolean };
      let stopped = false;
      for (const c of input.commands) {
        // As the command executor does: after a failing command, the rest do not run unless the job says to continue.
        if (stopped) break;
        const stub = scenario.commands?.[c.id];
        if ((stub?.exitCode ?? 0) !== 0 && input.continueOnFailure !== true) stopped = true;
        if (c.id === "report-write") written = writtenReport(c.argv);
        if (c.id === "qa-write") qa = writtenQa(c.argv);
        evidence.push({ ref: `e${(n += 1)}`, kind: "command", candidateDigest: digest, payload: { producer, command: { id: c.id, argv: c.argv, exitCode: stub?.exitCode ?? 0, stdoutTail: stub?.stdout ?? "", stderrTail: stub?.stderr ?? "" } } });
      }
    } else {
      const reply = next("results", job.resultSchema!) as { output?: unknown } | undefined;
      const contract = definition.resultContracts!.find((c) => c.name === job.resultSchema)!;
      const problems = validateResultShape(reply?.output, contract.schema);
      // As the controller records it: a contract-valid "review" result is flattened to its output, anything else keeps the executor's wrapper.
      const flat = problems.length === 0 && contract.evidenceKind === "review";
      const who = { ...producer, executorId: CODING_AGENT.id };
      let record: EvidenceRecord = {
        ref: `e${(n += 1)}`,
        kind: flat ? "review" : "other",
        candidateDigest: digest,
        resultSchema: job.resultSchema!,
        contract: { name: contract.name, status: problems.length > 0 ? "invalid" : "valid", problems },
        payload: flat ? { ...(reply!.output as object), producer: who } : { producer: who, codingAgent: { status: "completed", output: reply?.output } },
      };
      const tampered = options.tamper?.(job, [record]);
      if (tampered !== undefined) record = tampered[0]!;
      evidence.push(record);
      sessions.push({ operationId: producer.operationId, stageId: job.stageId, attempt: 1, generation: 1, dispatchKey: job.jobId ?? `${job.purpose}:${CODING_AGENT.id}`, executorId: CODING_AGENT.id, status: "ok", sessionRef: `claude-${producer.operationId}`, settledAt: `2026-01-01T00:00:${String(sessions.length % 60).padStart(2, "0")}.000Z` });
    }
  }
  throw new Error("the simulation did not settle");
}

/** Runs a simulation to its end. */
export function simulate(options: Options = {}): Simulation {
  const steps = simulationSteps(options);
  for (;;) {
    const r = steps.next();
    if (r.done === true) return r.value;
  }
}

/**
 * Runs a simulation to its end, giving the event loop back every `every` steps: a simulation at the scale of
 * #1445 runs for over a minute, and a test worker that never yields misses its own RPC deadlines.
 */
export async function simulateYielding(options: Options = {}, every = 10): Promise<Simulation> {
  const steps = simulationSteps(options);
  for (let n = 0; ; n += 1) {
    const r = steps.next();
    if (r.done === true) return r.value;
    if (n % every === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The agent assignment of a job. */
export const assignmentOf = (job: JobSpec): string => (job.input as { assignment: string }).assignment;

/** A copy of a scenario with changes made to it. */
export function scenarioWith(name: string, change: (s: RehearsalScenario) => void, config: Record<string, unknown> = {}): RehearsalScenario {
  const s = structuredClone(rehearsal({ ...BANYANDB, ...config }).scenarios[name]!);
  change(s);
  return s;
}

/** A run view over a simulation's evidence, as the controller hands it to the graph again. */
export function viewOf(sim: Simulation, over: Partial<RunView> = {}, config: Record<string, unknown> = BANYANDB): RunView {
  return {
    runId: "rehearsal-sim",
    task: { request: REHEARSAL_REQUEST },
    current: { stageId: "fetch", attempt: 1 },
    receipts: sim.receipts,
    evidence: sim.evidence,
    outstanding: [],
    budgets: { agentInvocations: 100, jobs: 100, decisions: 100, corrections: 12 },
    validatorBindings: [],
    generation: 1,
    stateRevision: 99,
    activeVersion: "0.2.0",
    candidateDigest: sim.evidence.flatMap((e) => (e.candidateDigest !== undefined ? [e.candidateDigest] : [])).at(-1) ?? "d0",
    config,
    ...over,
  };
}

/** The jobs of a simulation whose instruction starts with `text`. */
export const jobsOf = (sim: Simulation, text: string): JobSpec[] => sim.jobs.filter((j) => j.instruction.startsWith(text));
