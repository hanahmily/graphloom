// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateResultShape, type EvidenceRecord, type GraphDecision, type JobSpec, type Receipt, type RehearsalScenario, type RunView } from "@graphloom/sdk";
import { advancePullRequest, definitionFor } from "../src/graph.js";
import { CODING_AGENT, CREATE_PULL_REVIEW, GET_VIEWER, LIST_PULL_REVIEWS, LIST_PULL_REVIEW_COMMENTS, PUBLISH_STAGE } from "../src/constants.js";
import { parseProfile, type Profile } from "../src/profile.js";
import { REHEARSAL_HEAD_FILES, REHEARSAL_REQUEST, rehearsal } from "../src/rehearsal.js";
import { validatorById } from "../src/validators.js";
import { writtenQa, writtenReport } from "../src/write.js";

/** The login the fake GitHub's credential authenticates as. */
export const FAKE_LOGIN = "graphloom-bot";

/** The reason the default simulation ends with: Fetch, Report, Questions and Answers are accepted, and round 1 is next. */
export const ANSWERED = "answers accepted";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BANYANDB: Record<string, unknown> = JSON.parse(readFileSync(path.join(root, "profiles", "banyandb.json"), "utf8"));
export const profileOf = (over: Record<string, unknown> = {}): Profile => parseProfile({ ...BANYANDB, ...over });

/** One review the fake GitHub holds: what `list-pull-reviews` shows of it, and the comments it carries. */
export interface FakeReview {
  id: number;
  body: string;
  commitId: string;
  /** The author; the credential's own login when absent. */
  user?: string;
  state: string;
  url: string;
  comments: Array<{ id: number; path: string; line: number; body: string }>;
}

/** What the simulation's fake GitHub saw during the Publish stage. */
export interface FakeGithub {
  /** Every input a `create-pull-review` job carried, in order. */
  creates: Array<Record<string, unknown>>;
  /** The reviews the pull request holds: seeded ones, and the ones the creates posted. */
  reviews: FakeReview[];
}

export interface Simulation {
  /** The Publish stage's fake GitHub. */
  github: FakeGithub;
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
  /**
   * How far to run: `answers` (the default) ends the simulation when the graph is about to decide round 1, after Answers
   * were accepted (what most tests of Fetch, Report, Questions and Answers look at); `end` runs every stage.
   */
  through?: "answers" | "end";
  /** How many pages the Publish stage's read of the reviews takes (the pages after the first start at the cursor the previous one gave). */
  reviewPages?: number;
  /** How many whole reads of a review's comments show none of them (a read that lags the post); every later read shows them. */
  hideComments?: number;
  /** Reviews of the pull request that are already on GitHub when the run starts. */
  reviews?: FakeReview[];
  /** What the Publish stage's `create-pull-review` does: `post` (the default); `lost` fails without posting; `posted-then-failed` posts and then reports an ambiguous failure. A list gives one outcome per attempt. */
  create?: Array<"post" | "lost" | "posted-then-failed">;
  /** The executors the run view declares (what the controller reports of the runner's grants); absent: none, as for a runner that reports nothing. */
  executors?: RunView["executors"];
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
  const github: FakeGithub = { creates: [], reviews: [...(options.reviews ?? [])] };
  let nextReviewId = 7000;
  let commentReads = 0;
  let nextCommentId = 9000;
  let written: Simulation["written"];
  let qa: Simulation["qa"];
  let lastWork: string | undefined;
  let digest = "d0";
  for (let step = 0; step < (options.maxSteps ?? 60); step += 1) {
    yield;
    // Through Answers only: the stages up to Answers are accepted, and the run would decide round 1 next.
    if ((options.through ?? "answers") === "answers" && ["fetch", "report", "questions", "answers"].every((id) => definition.stages.find((st) => st.id === id)!.requirementIds.every((r) => receipts.some((x) => x.stageId === id && x.requirementId === r && x.valid)))) {
      const stop: GraphDecision = { action: { type: "stop", stop: { reason: ANSWERED, blocker: "Fetch, Report, Questions and Answers are accepted", retryable: false } }, reason: "the simulation ends after Answers" };
      decisions.push(stop);
      return { decisions, jobs, evidence, receipts, final: stop, github, ...(written !== undefined ? { written } : {}), ...(qa !== undefined ? { qa } : {}) };
    }
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
      ...(options.executors !== undefined ? { executors: options.executors } : {}),
    };
    const decision = advancePullRequest(view);
    if (options.shadow !== undefined && step % options.shadow.every === 0) {
      const shadowDecision = advancePullRequest({ ...view, evidence: options.shadow.records(evidence) });
      options.shadow.compared.push({ step, what: "advance", recorded: JSON.stringify(decision), shadow: JSON.stringify(shadowDecision) });
    }
    decisions.push(decision);
    const action = decision.action;
    if (action.type === "stop" || action.type === "supervise") return { decisions, jobs, evidence, receipts, final: decision, github, ...(written !== undefined ? { written } : {}), ...(qa !== undefined ? { qa } : {}) };
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
    if (job.kind === "command" && job.executor !== undefined && job.stageId === PUBLISH_STAGE) {
      // The Publish stage's GitHub: the reviews of the pull request, the one write, and the comments of a review.
      const page = { complete: true, nextCursor: null, startCursor: "1" };
      let out: Record<string, unknown>;
      if (job.executor.id === GET_VIEWER.id) {
        out = { item: { login: FAKE_LOGIN } };
      } else if (job.executor.id === LIST_PULL_REVIEWS.id) {
        const pages = options.reviewPages ?? 1;
        const at = Number((job.input as { cursor?: string }).cursor ?? "1");
        const last = at >= pages;
        const mine = github.reviews.filter((_, i) => i % pages === at - 1);
        out = { items: mine.map((r) => ({ id: r.id, user: r.user ?? FAKE_LOGIN, state: r.state, body: r.body.slice(0, 4000), bodyTruncated: false, commitId: r.commitId, submittedAt: null, url: r.url })), page: last ? { complete: true, nextCursor: null, startCursor: String(at) } : { complete: false, nextCursor: String(at + 1), startCursor: String(at) } };
      } else if (job.executor.id === LIST_PULL_REVIEW_COMMENTS.id) {
        commentReads += 1;
        out = { items: commentReads <= (options.hideComments ?? 0) ? [] : github.reviews.flatMap((r) => r.comments.map((c) => ({ id: c.id, reviewId: r.id, path: c.path, line: c.line, side: "RIGHT", body: c.body.slice(0, 4000), bodyTruncated: false }))), page };
      } else if (job.executor.id === CREATE_PULL_REVIEW.id) {
        const input = job.input as Record<string, unknown>;
        github.creates.push(input);
        const how = options.create?.[Math.min(github.creates.length - 1, (options.create?.length ?? 1) - 1)] ?? "post";
        const marker = `<!-- graphloom-op: rehearsal-sim/${String(input.idempotencyKey)} -->`;
        if (how !== "lost") {
          const id = (nextReviewId += 1);
          github.reviews.push({ id, body: `${String(input.body)}\n\n${marker}`, commitId: String(input.commitId), state: "COMMENTED", url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`, comments: ((input.comments ?? []) as Array<{ path: string; line: number; body: string }>).map((c) => ({ id: (nextCommentId += 1), path: c.path, line: c.line, body: c.body })) });
        }
        const last = github.reviews.at(-1)!;
        out = how === "post" ? { outcome: "created", review: { id: last.id, state: last.state, url: last.url, commitId: last.commitId, author: "graphloom-bot" } } : { outcome: "ambiguous" };
      } else throw new Error(`the publish stage dispatched ${job.executor.id}`);
      evidence.push({ ref: `e${(n += 1)}`, kind: "other", candidateDigest: digest, payload: { producer, github: out } });
    } else if (job.kind === "command" && job.executor !== undefined) {
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
