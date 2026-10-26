// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceRecord,
  ExecutorInputShape,
  GraphDefinition,
  JobSpec,
  OutstandingOperation,
  Receipt,
  StageAttempt,
  ValidatorBinding,
} from "@graphloom/sdk";
import type { SupervisorEpisodeRecord } from "@graphloom/supervisor";
import type { IntakePin } from "./intake.js";
import { bookBudgetUsage, rebaseBudgetUsage, type BudgetUsage } from "./budget-usage.js";
import { withDirectoryLock } from "./lock.js";

export type RunStatus = "running" | "succeeded" | "stopped" | "failed";

/**
 * A remedy the controller or the supervisor host applied without a model
 * decision: what failed, what was done about it, and any wait it charged.
 */
export interface RemedyRecord {
  at: string;
  /** What failed, e.g. `supervisor provider quota`, `executor acme/x failed`, `stalled`. */
  condition: string;
  /** What was done, e.g. `waited 30s and retried the turn`. */
  remedy: string;
  /** The provider's or executor's own message, bounded. */
  detail?: string;
  episodeId?: string;
  /** Milliseconds charged to the run's waitMs budget. */
  waitedMs?: number;
}

/**
 * The stop reason of the controller's own pause after a bounded number of loop
 * steps: nothing failed, and resume continues where the run was.
 */
export const STEP_LIMIT_STOP_REASON = "step limit";

/**
 * The stop reason of the controller's guard against a loop that spends nothing:
 * consecutive steps that charged no finite budget. Retryable; resume starts over.
 */
export const NO_PROGRESS_STOP_REASON = "no-progress loop";

/** Remedy records kept in run state; older ones are dropped. */
export const MAX_REMEDY_RECORDS = 100;

export function recordRemedy(state: DurableRunState, record: Omit<RemedyRecord, "at"> & { at?: string }): DurableRunState {
  const entry: RemedyRecord = { ...record, at: record.at ?? new Date().toISOString() };
  return { ...state, remedies: [...(state.remedies ?? []), entry].slice(-MAX_REMEDY_RECORDS) };
}

export interface PendingDispatch {
  operationId: string;
  generation: number;
  stageId: string;
  job: JobSpec;
  /** `waiting` from admission until the job is handed to the runner (after any `notBefore`); then `pending`. */
  status: "waiting" | "pending" | "completed" | "failed";
  /** Durable pin recorded at admission (before effects). */
  executor?: import("@graphloom/sdk").ExecutorPin;
  /** Model requests the job reserved against the run's agent-invocation budget. */
  modelCalls?: number;
  /** The job starts no earlier than this (an executor asked for a wait before retrying). */
  notBefore?: string;
  /** Session directory given to an agent job, and the session it continues. */
  session?: import("@graphloom/sdk").ExecutorSession;
  /**
   * Set when this dispatch is a controller retry of a failure its executor
   * declared retryable. A retry dropped before it reached the runner (Stop or
   * a crash during its backoff) is queued again on resume, not lost.
   */
  retry?: { attempt: number; limit: number; graphCorrectionTrial: boolean; supervisorWorkDispatch: boolean; reason?: string; timeoutChain?: string };
}

/** A supervisor-originated job that was allowed to change the host beyond the run's scope. */
export interface HostChangeRecord {
  operationId: string;
  stageId: string;
  executorId?: string;
  at: string;
  /** Why it was unconfined: the grant that allowed it. */
  reason: string;
}

/** Most host-change records a run keeps. */
export const MAX_HOST_CHANGE_RECORDS = 50;

/**
 * An agent session a settled dispatch returned. A later dispatch of the same
 * stage and dispatch key may continue it with `continueFrom`.
 */
export interface AgentSessionRecord {
  operationId: string;
  stageId: string;
  attempt: number;
  generation: number;
  dispatchKey: string;
  executorId: string;
  status: "ok" | "failed" | "conflict";
  /** Executor-defined identity of the saved session inside `sessionDir`. */
  sessionRef: string;
  sessionDir: string;
  continuedFrom?: string;
  /** The job ran out of its wall clock; a continuation tells the agent so. */
  timedOut?: true;
  settledAt: string;
}

/**
 * An executor the run pinned at intake: identity plus the digest of the code
 * it runs. Dispatches carry the digest, and resume checks it still matches.
 */
export interface ExecutorCatalogEntry {
  id: string;
  digest: string;
  /** Package root, module file, or `in-process` the digest covers. */
  source: string;
  /** Present when `source` is a package root that can be copied for repair. */
  entryModule?: string;
  isolation: "sandbox" | "unrestricted" | "in-process";
  builtin: boolean;
  /** The input shape the executor declared at intake, carried as data for the supervisor; never read by the controller. */
  inputShape?: ExecutorInputShape;
  /** Set once a qualified repair of this executor's package is activated; `digest` is then the copy's. */
  repair?: { artifactId: string; root: string; entryModule: string; baseDigest: string };
}

/** An operator re-pin of an executor to its installed bytes, at the generation it took effect. */
export interface ExecutorTransitionRecord {
  id: string;
  fromDigest: string;
  toDigest: string;
  /** Where it was served from before and after (absent in records made before location moves were recorded). */
  fromSource?: string;
  toSource?: string;
  generation: number;
  at: string;
}

/**
 * A tool call an agent job made, admitted as a child operation. Recorded
 * before the child runs; settled results are replayed for the same stage
 * attempt and tool-call id instead of running again.
 */
export interface ChildOperationRecord {
  childOperationId: string;
  parentOperationId: string;
  toolCallId: string;
  tool: string;
  stageId: string;
  attempt: number;
  generation: number;
  executor: import("@graphloom/sdk").ExecutorPin;
  effect: import("@graphloom/sdk").ExecutorEffect;
  input: unknown;
  /**
   * `fenced`: settled after the run stopped or the parent ended; not delivered.
   *   Keeps `result` when the child finished, so a retry replays it.
   * `abandoned`: a read interrupted by a crash; the call may run again.
   * `ambiguous`: a write interrupted by a crash or stop; never replayed.
   */
  status: "pending" | "ok" | "failed" | "conflict" | "fenced" | "abandoned" | "ambiguous";
  result?: import("@graphloom/sdk").ToolCallResult;
  admittedAt: string;
  settledAt?: string;
}

/** The state a final stop depends on, recorded when the run stopped (stop-class.ts). */
export interface StopMark {
  /** The stop reason it was recorded for; a different current reason ignores it. */
  stopReason?: string;
  activeVersion: string;
  manifestDigest: string;
  entryDigest: string;
  /** The live workspace change when the run stopped. */
  candidateDigest?: string;
  budgets: IntakePin["budgets"];
}

export interface DurableRunState {
  runId: string;
  status: RunStatus;
  stopReason?: string;
  blocker?: string;
  /** Recorded evidence the stop cites, such as the failing validation of an opaque gate. */
  stopEvidenceRefs?: string[];
  /**
   * How the graph or supervisor classified its own stop (`StopSpec.retryable`,
   * default retryable). Absent when the controller stopped the run: its own
   * reasons are classified by stop-class.ts. Cleared when the run runs again.
   */
  stopClass?: { by: "graph" | "supervisor"; retryable: boolean; /** The stop reason it classifies; a different current reason ignores it. */ reason?: string };
  /**
   * What a final stop depends on, as it was when the run stopped: a resume
   * surfaces the same blocker until one of these changes (stop-class.ts).
   * Absent in runs that stopped before it existed; they are retried.
   */
  stopMark?: StopMark;
  /** The operator's latest resume, shown to the graph as `RunView.resume`. Absent until the first resume. */
  lastResume?: import("@graphloom/sdk").ResumeView;
  generation: number;
  stateRevision: number;
  activeVersion: string;
  mode: "normal" | "recovery";
  current: StageAttempt;
  receipts: Receipt[];
  evidence: EvidenceRecord[];
  outstanding: OutstandingOperation[];
  pendingDispatch?: PendingDispatch;
  childOperations?: ChildOperationRecord[];
  agentSessions?: AgentSessionRecord[];
  /** Executors pinned at intake (absent for runs whose runner cannot describe its executors). */
  executorCatalog?: ExecutorCatalogEntry[];
  /** Executors the operator moved onto installed code with `resume --update-executors`, oldest first. */
  executorTransitions?: ExecutorTransitionRecord[];
  /**
   * Jobs the supervisor ran with the operator's `hostRepair` grant, outside the
   * run's confinement, oldest first (bounded). Recorded before the job starts.
   */
  hostChanges?: HostChangeRecord[];
  /** Earliest time each executor may run again, from a failure's retry timing. */
  executorRetryAt?: Record<string, string>;
  /** A recovery episode that opens only once this time has passed (a harness quota reset); cleared when it does. */
  quotaHold?: { until: string };
  /**
   * A job a harness usage limit cut off after possible effects, with no
   * session to continue: a resume must not run the graph (which would replay
   * it) until a supervisor episode settled it or the operator acknowledged it
   * (`resume --reconciled`).
   */
  reconciliationRequired?: { operationId: string; stageId: string; reason: string; since: string };
  /**
   * A failed job its executor declared retryable (`retryLimit`), queued to run
   * again unchanged before the graph or supervisor is asked anything.
   */
  executorRetry?: {
    job: JobSpec;
    /** 1-based retry number this dispatch is. */
    attempt: number;
    limit: number;
    graphCorrectionTrial: boolean;
    supervisorWorkDispatch: boolean;
    /** Why the controller runs it again, when not a declared-retryable failure (a timed-out session continued). */
    reason?: string;
    /** The attempt whose timeout-continuation allowance this run shares (see `timeoutContinuations`). */
    timeoutChain?: string;
  };
  /** Per `${stageId}:${purpose}:${executorId}`, consecutive retryable failures retried so far. */
  executorRetryCounts?: Record<string, number>;
  /**
   * Per attempt, agent sessions the controller continued after a timeout that
   * changed the worktree (`JobSpec.timeoutContinuations`). Keyed by the
   * operation id of the attempt's first dispatch, the one the graph or
   * supervisor made; the continuations and controller retries chained from it
   * carry that id (`timeoutChain`) and share its allowance.
   */
  timeoutContinuations?: Record<string, number>;
  /**
   * Deterministic remedies applied without asking the model what to do
   * (design-supervisor-robustness.md §4.3), newest last, bounded.
   */
  remedies?: RemedyRecord[];
  /**
   * Progress mark (escalation.ts) at the last recovery episode's decision,
   * whether the supervisor's or a deterministic remedy's. A `stalled` trigger
   * whose run has progressed past it returns to normal without a model call.
   */
  lastEpisodeMark?: string;
  privateState?: string;
  definition: GraphDefinition;
  validatorBindings: ValidatorBinding[];
  /** What the run has left of each budget; an operator raises one by editing it while the run is stopped. */
  budgets: IntakePin["budgets"];
  /**
   * What the run has used of each budget, booked by saveRunState and re-based
   * on operator edits by loadRunState (budget-usage.ts). Absent in runs saved
   * before it existed; loading one estimates it.
   */
  budgetUsage?: BudgetUsage;
  intake: IntakePin;
  worktreePath: string;
  worktreeBranch: string;
  artifactDir: string;
  stateDir: string;
  sourceDirtyBefore: string[];
  evidenceSeq: number;
  receiptSeq: number;
  /** Hash of last Observe workspace snapshot; Validate must match live worktree. */
  workspaceRevision?: string;
  /** Digest of the workspace change after the last job or Observe (see `candidateChange`). */
  candidateDigest?: string;
  /**
   * Set when the files the graph's environment declaration pins no longer
   * match: normal jobs stay blocked until a repair changes the active version.
   */
  environmentBlock?: { activeVersion: string; reason: string };
  /**
   * Probes the supervisor has run in its current recovery episode, so a proposal
   * may cite one across turns of the episode and after a resume. Replaced when
   * a new episode runs its first probe; never counted in `stateRevision`.
   */
  probeLog?: {
    episodeId: string;
    /** Probes that ran. */
    ids: string[];
    /** Probes started, run or not: the episode cap counts these. */
    attempts: number;
    /**
     * What each probe that ran found, bounded (see inspection.ts), so a
     * proposal citing a probe id carries its result to whoever judges it,
     * such as the independent repair reviewer. Only the latest are kept.
     */
    results?: Record<string, ProbeRecord>;
  };
  /** Last successful work-purpose dispatch; used for separate-reviewer checks. */
  lastWorkOperationId?: string;
  /**
   * The supervisor's memory across recovery episodes (case-file.ts): verified
   * facts, refuted claims, settled attempts, open questions. Absent in runs
   * that never recorded one. (Older runs may also carry a
   * `resumedSinceLastDecision` flag; it is no longer read: every episode, and
   * the first one after resume, starts a fresh supervisor session instead.)
   */
  caseFile?: import("@graphloom/sdk").CaseFile;
  /** Last id number given to a case-file fact or refutation. */
  caseFileSeq?: number;
  /** Per stage, whether a work-purpose dispatch has ever been admitted for it. Never cleared. */
  workDispatched?: Record<string, true>;
  /**
   * Per stage, a graph-authored correction-eligible work dispatch has settled
   * (succeeded or failed) and is awaiting the next validation of that stage
   * to learn whether it resolved anything. Set in applyDispatchResult,
   * consumed (and cleared) by the next validate of that stage.
   */
  correctionPendingTrial?: Record<string, true>;
  /**
   * Normal-mode graph decisions (by action hash) made since the progress mark
   * last changed. A decision made twice without progress starts recovery.
   */
  noProgress?: { mark: string; counts: Record<string, number> };
  /**
   * Per stage: key presence means an unresolved correction streak is open
   * since that stage's last upstream acceptance or supervisor-authorized
   * trial; the value counts trials confirmed-unresolved within it. Settles
   * (key deleted, along with any `handoff` entry) when the stage's target
   * requirement next validates passing, or when a supervisor work dispatch
   * for that stage settles regardless of outcome.
   */
  correctionTrials?: Record<string, number>;
  /** Per stage: the correction-limit handoff the supervisor must clear. */
  handoff?: Record<string, import("@graphloom/sdk").CorrectionHandoff>;
  /**
   * Supervisor proposals (by trigger code, stage, action type, and action
   * spec hash) made since the progress mark last changed. Persists across
   * resume and mode transitions; only progress or acceptance clears it.
   */
  repeatedProposals?: { mark: string; entries: Record<string, import("@graphloom/sdk").SupervisorRepeatEntry> };
  /**
   * Stages reenter() opened that have not yet had a work-purpose dispatch
   * settle in the current attempt. Set unconditionally by reenter, regardless
   * of whether any receipt actually invalidates; cleared on settlement, not
   * on receipt validity, so stage-selection can tell "this stage's execution
   * needs another attempt" apart from "its evidence went stale."
   */
  openAttempt?: Record<string, boolean>;
  /**
   * Per stage, the highest attempt number it has run under. A stage that is
   * re-opened (reentry, or invalidation sending the run back to it) takes the
   * next number even when the run arrives from another stage, so a plugin
   * that tells a fresh attempt by its number sees the change. Absent in runs
   * saved before it existed; see nextStageAttempt for the fallback.
   */
  stageAttempts?: Record<string, number>;
  /**
   * Per stage, dispatches settled since its last receipt (agent dispatches
   * counted separately from the total of every kind). Reset to `{agent: 0,
   * total: 0, since: <now>}` when admit.ts mints a receipt for that stage.
   * Independent of any plugin evidence lookup — unlike a plugin's own round
   * cap, which reads the plugin's ledger and can be fooled by the same
   * mismatch it exists to catch. See docs/design-agent-contract-robustness.md §4.6.
   */
  dispatchesSinceReceipt?: Record<string, { agent: number; total: number; since: string }>;
  /**
   * Per `${stageId}:${purpose}`, consecutive agent results recorded with
   * `contract.status: "invalid"`. Reset to 0 by a valid or repaired result
   * for the same key; never by an unrelated job. See §4.5(b).
   */
  contractViolationStreak?: Record<string, number>;
  /**
   * Per stage, model calls reserved (children.ts's reserveModelCall) by jobs
   * dispatched for it. Never reset — the §4.7 pacing check compares a
   * stage's running total against the run's whole agent budget.
   */
  agentInvocationsByStage?: Record<string, number>;
  /** Recorded active-version transitions (intake + generation fences). */
  versionHistory: VersionRecord[];
  /** Active recovery episode when mode is recovery. */
  recoveryEpisodeId?: string;
  /** Why the controller entered the current recovery episode. */
  recoveryTrigger?: {
    code: string;
    message: string;
    /** Recorded evidence the escalation cited. */
    evidenceRefs?: string[];
  };
  /**
   * Durable Pi supervisor session identity (session file + active model).
   * On resume, when no supervisor is supplied, the controller restores from
   * this binding (see ResumeRequest.restoreSupervisor / default Pi restore).
   */
  supervisorBinding?: {
    sessionId: string;
    sessionFile?: string;
    provider: string;
    modelId: string;
    switchJournal: Array<{
      at: string;
      from: { provider: string; modelId: string };
      to: { provider: string; modelId: string };
      reason: string;
      status: "intent" | "committed" | "failed";
      error?: string;
    }>;
    configuredModels?: Array<{ provider: string; modelId: string }>;
  };
  /**
   * The supervisor's last proposal and the run as it stood when it was taken.
   * The next recovery prompt opens with what changed since (the settlement).
   */
  supervisorMark?: SupervisorMark;
  /** Supervisor turns that ended without an admitted proposal, newest last (bounded). */
  supervisorOutcomes?: SupervisorOutcomeRecord[];
  /**
   * One record per supervisor decide() call: its input, the tool calls and
   * results, the proposal and the admission outcome (see @graphloom/supervisor
   * episode.ts). Newest last, bounded in count and in each record's size; the
   * input of a replay (`replayEpisodes`).
   */
  supervisorEpisodes?: SupervisorEpisodeRecord[];
  /** Isolated repair candidates for this run (never the live install). */
  repairCandidates?: import("./repair.js").QualifiedRepairArtifact[];
  /** Crash-safe activation journal; cleared after successful switch. */
  activationIntent?: {
    artifactId: string;
    fromVersion: string;
    toVersion: string;
    generation: number;
    at: string;
    status: "intent" | "committed" | "aborted";
  };
}

export interface SupervisorMark {
  action: string;
  reason: string;
  episodeId?: string;
  stageId: string;
  attempt: number;
  generation: number;
  evidenceRefs: string[];
  receiptIds: string[];
  candidates: Record<string, string>;
  /** Outcomes the controller recorded directly, such as a refused model switch. */
  notes: string[];
  /** Set when this proposal repeated an earlier one with no progress since. */
  repeat?: { count: number; triggerCode: string };
  /** The recovery trigger the proposal answered. */
  triggerCode?: string;
  /** The run's candidate digest when it was taken (`null`: no candidate change yet). */
  candidateDigest?: string | null;
  /** Set once its settlement was written to the case file's attempts. */
  attemptRecorded?: true;
}

/**
 * A supervisor outcome the operator can see. `supervisor_inadmissible`: a turn
 * reached the inadmissible-proposal limit and the controller applied the
 * trigger's safe default. `inadmissible`: a proposal that passed the
 * pre-admission check failed a precondition only admission could see (such as
 * a candidate digest on disk); the run stayed in recovery.
 */
export interface SupervisorOutcomeRecord {
  at: string;
  episodeId?: string;
  triggerCode?: string;
  outcome: "supervisor_inadmissible" | "inadmissible";
  /** Each rejection as `<precondition>: <current value>`, oldest first. */
  rejections: string[];
  /** What the controller did: returned to the graph, stopped, or stayed in recovery. */
  applied: "return" | "stop" | "recovery";
}

export interface VersionRecord {
  activeVersion: string;
  generation: number;
  reason: string;
  at: string;
}

/** The cited refs that name evidence this run recorded, deduplicated in order. */
/** A probe's durable result: the check it ran and what it found. */
export interface ProbeRecord {
  check: "check_validate" | "check_activation" | "check_checkout";
  accepted: boolean;
  reason: string;
  stateRevision: number;
  evaluated?: boolean;
  requirements?: Array<{ requirementId: string; status: string; reason: string }>;
}

export function citedEvidence(state: DurableRunState, refs: readonly string[] | undefined): string[] {
  const known = new Set(state.evidence.map((e) => e.ref));
  return [...new Set((refs ?? []).filter((ref) => known.has(ref)))];
}

/**
 * Persist `state`. Any change in its remaining budgets since it was loaded or
 * created is booked as the controller's own spending (or refund) in
 * `budgetUsage`; an operator who raises a budget edits state.json instead,
 * which loadRunState books as a raise.
 */
export async function saveRunState(input: DurableRunState): Promise<void> {
  const state = bookBudgetUsage(input);
  await withDirectoryLock(state.stateDir, "state.lock", async () => {
    await mkdir(state.stateDir, { recursive: true });
    const target = path.join(state.stateDir, "state.json");
    const tmp = path.join(state.stateDir, `state.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(state, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, target);
    // Best-effort sync of the directory entry after rename.
    const dir = await open(state.stateDir, "r");
    try {
      await dir.sync();
    } catch {
      /* some FS do not support directory fsync */
    } finally {
      await dir.close();
    }
  });
}

export async function loadRunState(stateDir: string): Promise<DurableRunState> {
  return withDirectoryLock(stateDir, "state.lock", async () => {
    const raw = await readFile(path.join(stateDir, "state.json"), "utf8");
    return rebaseBudgetUsage(JSON.parse(raw) as DurableRunState);
  });
}

export async function removeStaleTmp(stateDir: string): Promise<void> {
  // no-op helper reserved for cleanup hooks
  void unlink;
}

/**
 * The attempt number a re-opened stage runs under: one past the highest it
 * has run before. A run saved before `stageAttempts` existed falls back to the
 * attempts its agent sessions recorded for the stage, and to the current
 * attempt when the run is still on that stage.
 */
export function nextStageAttempt(state: DurableRunState, stageId: string): number {
  const recorded = state.stageAttempts?.[stageId] ?? 0;
  const fromSessions = Math.max(0, ...(state.agentSessions ?? []).filter((r) => r.stageId === stageId).map((r) => r.attempt));
  const current = state.current.stageId === stageId ? state.current.attempt : 0;
  return Math.max(recorded, fromSessions, current) + 1;
}
