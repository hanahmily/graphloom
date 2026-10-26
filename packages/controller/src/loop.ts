import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CaseFinding,
  CaseFindingOutcome,
  EvidenceRecord,
  ExecutorSession,
  GraphDecision,
  GraphDefinition,
  JobSpec,
  ObserveSpec,
  RunView,
} from "@graphloom/sdk";
import {
  assertGraphDecision,
  BUILTIN_COMMAND_EXECUTOR_ID,
  checkReferences,
  dispatch,
  MAX_TIMEOUT_CONTINUATIONS,
  returnToNormal,
  pinJobExecutor,
  validateResultShape,
  writeScopeProblem,
  type CheckoutSpec,
  type EnvironmentDeclaration,
} from "@graphloom/sdk";
import type { ExecutorSourceOverride, JobConfinement, JobContext, Runner } from "@graphloom/runner";
import type { PluginHost } from "@graphloom/plugin-host";
import {
  buildEpisodeRecord,
  createEpisodeRecorder,
  isModelSwitchRequest,
  isSupervisorProviderError,
  type AdmissionCheck,
  type RecoveryTrigger,
  type SupervisorRejection,
  type Supervisor,
  type SupervisorInspection,
  type SupervisorProposal,
} from "@graphloom/supervisor";
import { markProposal, noteOutcome, settleProposal } from "./settlement.js";
import { appendEpisode, nextEpisodeTurn, settleEpisode } from "./episodes.js";
import { budgetGranted, freshBudgetUsage } from "./budget-usage.js";
import { liveCaseFile, recordAttempt, recordFinding, refreshCaseFile } from "./case-file.js";
import {
  applyModelSwitch,
  clearSwitchRequest,
  readBinding,
  readSwitchRequest,
  type PendingSwitchRequest,
} from "./supervisor-switch.js";
import { catalogEntry, describeInputShape, executorViews, isKindDefaultExecutor, resolveExecutorPin } from "./executor-catalog.js";
import { recordExecutorFailure } from "./executor-failure.js";
import {
  admitValidation,
  deliveryDrift,
  earliestIncompleteStage,
  freshEvidence,
  invalidateFromStage,
  liveCandidateDigest,
  newEvidenceRef,
  stageRequirementsMet,
  type AdmissionValidator,
  type EvidenceProducer,
} from "./admit.js";
import { HostObservationError } from "./host-validators.js";
import { manifestRepairContract, type IntakePin } from "./intake.js";
import { startActiveClock, type ActiveClock } from "./active-time.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import {
  claimRunOwner,
  clearOwnerClaim,
  renewRunOwner,
  updateOwnerChildPid,
  type RunOwnerClaim,
} from "./owner.js";
import { isUnsettled, reconcilePendingDispatch } from "./reconcile.js";
import { createChildPort, reconcileChildOperations } from "./children.js";
import { agentSessionViews, continuationRefusal, recordAgentSession, sessionForDispatch, wipeAgentSessions } from "./agent-sessions.js";
import { citedEvidence, loadRunState, nextStageAttempt, type ProbeRecord, NO_PROGRESS_STOP_REASON, MAX_HOST_CHANGE_RECORDS, recordRemedy, type DurableRunState, saveRunState } from "./state.js";
import { stopMarkOf } from "./stop-class.js";
import { bumpGeneration } from "./generation.js";
import { noteGraphDecision, noteSupervisorProposal, progressMark, settleCorrectionTrial, settleSupervisorCorrection } from "./escalation.js";
import {
  applyActivateRepair,
  applyQualifyRepair,
  type RecreateHostFn,
  type RepairDeps,
} from "./repair-lifecycle.js";
import {
  changedPaths,
  pathsOutsideWriteScope,
  trackedAtHead,
  readWorktreeFile,
  workspaceChangeManifest,
  worktreeChangeFingerprints,
} from "./worktree.js";
import { clearCheckouts, runInCheckout } from "./checkout.js";
import {
  citedProbeEvidence,
  createRecoveryFence,
  createSupervisorInspection,
  DEFAULT_EPISODE_PROBES,
  episodeProbeAttempts,
  episodeProbeIds,
  episodeProbeResults,
  keepProbeResult,
} from "./inspection.js";
import { checkEnvironment, declaresEnvironment, type EnvironmentOutcome } from "./environment.js";
import {
  activateRefusal,
  admissionFacts,
  checkoutSpecRefusal,
  describeInadmissible,
  groundingRefusal,
  inadmissible,
  MAX_INADMISSIBLE_PER_TURN,
  qualifyRefusal,
  recordSupervisorOutcome,
  repeatRefusal,
  returnRefusal,
  safeDefault,
  type Inadmissible,
} from "./inadmissible.js";
import { citedRefs, needsReview, runReview, type OpenReviewInspection, type ProposalReviewer, type ReviewOutcome } from "./proposal-review.js";

/**
 * Consecutive controller steps that charge no finite budget before the loop
 * stops itself. Every step that asks the graph or the supervisor for a decision
 * charges `decisions`, and every job charges `jobs` and `agentInvocations`, so
 * the finite budgets bound a healthy run and there is no cap on charged steps.
 * The steps that charge nothing are the environment check (no setup commands),
 * a plugin host failure that enters recovery, and a supervisor model switch;
 * a legitimate run strings together two or three of them (a host failure, then
 * a switch, then the restarted episode's first decision). 16 leaves several
 * times that room and still ends a real loop within moments.
 */
const MAX_UNCHARGED_STEPS = 16;

/** What the count budgets still hold; a step that charged one lowers it. Time budgets tick with the clock, so they do not count. */
function chargeableRemaining(budgets: DurableRunState["budgets"]): number {
  return budgets.agentInvocations + budgets.jobs + budgets.decisions + budgets.corrections + (budgets.probes ?? 0);
}

export interface LoopDeps {
  /** Plugin decisions go through the host seam (in-process scripted or child). */
  host: PluginHost;
  runner: Runner;
  validators: Record<string, AdmissionValidator>;
  /** Optional recovery decision source; required to continue past Supervise / host failure. */
  supervisor?: Supervisor;
  /** Qualified repair patch/review hooks (same supervisor session for patches). */
  repair?: RepairDeps;
  /** Independent review of a `stop` or validator/executor `qualify_repair` before admission (#121). */
  proposalReviewer?: ProposalReviewer;
  /**
   * Replace a dead child plugin process after crash/timeout, or after
   * ActivateRepair points the run at a candidate bundle.
   * Required when recovering past a host that exposes `childPid`.
   */
  recreateHost?: RecreateHostFn;
  /** Throwaway host on a candidate bundle, so QualifyRepair can check its describe(). */
  openCandidateHost?: RecreateHostFn;
  /** Operator stop: checked each loop turn before advance (sync or async). */
  shouldStop?: () => boolean | Promise<boolean>;
  /** Live revision bridge for host-backed validators. */
  revisionBridge?: { current: number };
  /** Set by runNormalLoop for the time this controller runs the run. */
  activeClock?: ActiveClock;
}

async function stopRequested(deps: LoopDeps): Promise<boolean> {
  return activeTimeExhausted(deps) || Boolean(await Promise.resolve(deps.shouldStop?.() ?? false));
}

function syncRevision(deps: LoopDeps, state: DurableRunState): void {
  if (deps.revisionBridge) {
    deps.revisionBridge.current = state.stateRevision;
  }
}

export async function runNormalLoop(
  state: DurableRunState,
  deps: LoopDeps,
): Promise<DurableRunState> {
  // Per-step lock so Stop can coordinate during long runner jobs.
  // Durable run.owner.json serializes which controller owns the loop.
  const timing: { clock?: ActiveClock } = {};
  let final: DurableRunState | undefined;
  try {
    final = await runNormalLoopSteps(state, deps, timing);
    final = await recordFinalAttempt(final);
  } finally {
    if (timing.clock !== undefined) {
      // Also on a throw: the time spent must not be given back on resume.
      const recorded = await recordActiveTime(final ?? state, timing.clock).catch(() => undefined);
      if (final !== undefined && recorded !== undefined) final = recorded;
      await timing.clock.close();
    }
    if (final !== undefined) final = await recordStopMark(final);
    await clearOwnerClaim(state.stateDir);
  }
  await wipeAgentSessions(final);
  return final;
}

/**
 * §8: what a stop depends on, recorded once the run has stopped, so a resume
 * can tell whether anything changed since a final stop.
 */
async function recordStopMark(state: DurableRunState): Promise<DurableRunState> {
  if (state.status !== "stopped" || state.stopMark !== undefined) return state;
  return withRunLock(state.stateDir, async () => {
    const saved = await loadRunState(state.stateDir).catch(() => undefined);
    if (saved === undefined || saved.status !== "stopped" || saved.stopMark !== undefined) return state;
    const live = await liveCandidateDigest(saved).catch(() => saved.candidateDigest);
    const stopMark = stopMarkOf(saved, live);
    await saveRunState({ ...saved, stopMark });
    return { ...state, stopMark };
  });
}

/**
 * The supervisor's last proposal is otherwise settled into the case file only
 * before its next decision. When the loop ends first (a stop it proposed, or a
 * return after which the graph finished), settle it here, once, so the
 * durable case file and `inspect` show what came of it.
 */
async function recordFinalAttempt(state: DurableRunState): Promise<DurableRunState> {
  if (state.supervisorMark === undefined || state.supervisorMark.attemptRecorded === true) return state;
  return withRunLock(state.stateDir, async () => {
    const next = recordAttempt(state, settleProposal(state));
    await saveRunState(next);
    return next;
  });
}

function chargeActiveTime(state: DurableRunState, deps: LoopDeps): DurableRunState {
  if (deps.activeClock === undefined) return state;
  return { ...state, budgets: { ...state.budgets, activeMs: deps.activeClock.remaining() } };
}

/** Persist the time this controller spent before it gives up ownership. */
async function recordActiveTime(state: DurableRunState, clock: ActiveClock): Promise<DurableRunState> {
  return withRunLock(state.stateDir, async () => {
    const saved = await loadRunState(state.stateDir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined;
      throw err;
    });
    const activeMs = clock.remaining();
    if (saved !== undefined) await saveRunState({ ...saved, budgets: { ...saved.budgets, activeMs } });
    return { ...state, budgets: { ...state.budgets, activeMs } };
  });
}

function activeTimeExhausted(deps: LoopDeps): boolean {
  return deps.activeClock !== undefined && deps.activeClock.remaining() === 0;
}

/** Why a run that was asked to stop, or ran out of time, stopped. */
function stopCause(deps: LoopDeps): { stopReason: string; blocker: string } {
  return activeTimeExhausted(deps)
    ? { stopReason: "active time budget exhausted", blocker: "no active execution time remains" }
    : { stopReason: "operator stop", blocker: "stop requested" };
}

async function withRunLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withDirectoryLock(stateDir, "run.exec.lock", fn);
}

async function runNormalLoopSteps(
  state: DurableRunState,
  deps: LoopDeps,
  timing: { clock?: ActiveClock },
): Promise<DurableRunState> {
  let owner: RunOwnerClaim | undefined;
  state = await withRunLock(state.stateDir, async () => {
    owner = await claimRunOwner(state.stateDir, {
      ...(deps.host.childPid !== undefined ? { childPid: deps.host.childPid } : {}),
    });
    timing.clock = await startActiveClock(state);
    deps = { ...deps, activeClock: timing.clock };
    const children = reconcileChildOperations(state);
    if (children.state !== state) {
      state = children.state;
      if (!children.settled) {
        state = { ...state, status: "stopped", stopReason: "reconcile required", blocker: children.reason };
        await saveRunState(state);
        return state;
      }
      await saveRunState(state);
    }
    if (state.pendingDispatch !== undefined && isUnsettled(state.pendingDispatch)) {
      const reconciled = await reconcilePendingDispatch(state);
      state = reconciled.state;
      if (!reconciled.settled) {
        state = {
          ...state,
          status: "stopped",
          stopReason: "reconcile required",
          blocker: reconciled.reason,
        };
        await saveRunState(state);
        return state;
      }
      await saveRunState(state);
    }
    await clearCheckouts(state.stateDir);
    const digest = await liveCandidateDigest(state);
    if (digest !== state.candidateDigest) {
      state = withCandidateDigest(state, digest);
      await saveRunState(state);
    }
    syncRevision(deps, state);
    return state;
  });

  // The environment is checked once per loop and active version: at the start
  // of a run, on every resume, and after a repair changes the version.
  let environmentReadyFor: string | undefined;
  let lastRemaining: number | undefined;
  let unchargedSteps = 0;
  let lastAction = "start";
  for (let step = 0; ; step += 1) {
    const remaining = chargeableRemaining(state.budgets);
    unchargedSteps = lastRemaining !== undefined && remaining >= lastRemaining ? unchargedSteps + 1 : 0;
    lastRemaining = remaining;
    if (unchargedSteps >= MAX_UNCHARGED_STEPS) {
      return withRunLock(state.stateDir, async () => {
        state = {
          ...state,
          status: "stopped",
          stopReason: NO_PROGRESS_STOP_REASON,
          blocker: `${unchargedSteps} consecutive controller steps charged no budget; last action: ${lastAction}`,
        };
        await saveRunState(state);
        syncRevision(deps, state);
        return state;
      });
    }
    if (
      state.status === "running" &&
      state.mode === "normal" &&
      environmentReadyFor !== state.activeVersion &&
      declaresEnvironment(state.definition.environment)
    ) {
      lastAction = "environment check";
      state = await preflightEnvironment(state, deps);
      if (state.status !== "running") return state;
      if (state.mode === "normal") environmentReadyFor = state.activeVersion;
      continue;
    }
    let holdElapsed = false;
    if (state.status === "running" && state.quotaHold !== undefined) {
      // A recovery episode held for a harness quota reset: wait it out (stop interrupts), then open it.
      lastAction = "quota hold";
      const abort = new AbortController();
      const stopWatch = watchForStop(state.stateDir, deps, abort);
      // The wait is charged to waitMs, not to the active-time budget.
      const resumeClock = deps.activeClock?.pause();
      try {
        await sleepUntil(state.quotaHold.until, abort.signal);
      } finally {
        resumeClock?.();
        stopWatch();
      }
      holdElapsed = !abort.signal.aborted;
    }
    const turn = await withRunLock(state.stateDir, async () => {
      // Reload before renewing: Stop may have cleared the owner claim and
      // persisted stopped while a runner job held no lock.
      state = chargeActiveTime(await reloadRunState(state), deps);
      syncRevision(deps, state);

      if (state.status !== "running") {
        return { done: true as const, state };
      }
      if (await stopRequested(deps)) {
        state = {
          ...state,
          status: "stopped",
          ...stopCause(deps),
        };
        await saveRunState(state);
        return { done: true as const, state };
      }

      const renewed = await tryRenewOwner(state.stateDir, owner, deps.host.childPid);
      if (!renewed) {
        state = {
          ...state,
          status: "stopped",
          stopReason: "operator stop",
          blocker: "run owner lease cleared",
        };
        await saveRunState(state);
        return { done: true as const, state };
      }
      owner = renewed;
      await updateOwnerChildPid(state.stateDir, owner.ownerId, deps.host.childPid);

      // A supervisor that returned the run to its graph has settled the partial job a usage limit left;
      // cleared from the reloaded state, so a stop that arrived meanwhile is not overwritten.
      if (state.mode === "normal" && state.reconciliationRequired !== undefined) {
        const { reconciliationRequired: _settled, ...settled } = state;
        void _settled;
        state = { ...settled, stateRevision: state.stateRevision + 1 };
        await saveRunState(state);
      }
      // The quota wait is over: release the hold from the reloaded state, which a stop that arrived meanwhile has already ended.
      if (holdElapsed && state.quotaHold !== undefined) {
        const { quotaHold: _held, ...released } = state;
        void _held;
        state = { ...released, stateRevision: state.stateRevision + 1 };
        await saveRunState(state);
      }

      // A finite decisions budget: once it is spent, neither the graph nor the
      // supervisor is asked for another decision.
      if (state.budgets.decisions <= 0) {
        state = {
          ...state,
          status: "stopped",
          stopReason: "decisions budget exhausted",
          blocker:
            state.mode === "recovery"
              ? `supervisor decision for the ${state.recoveryTrigger?.code ?? "unhandled"} trigger at stage ${state.current.stageId}`
              : `graph decision at stage ${state.current.stageId}`,
        };
        await saveRunState(state);
        syncRevision(deps, state);
        return { done: true as const, state };
      }

      let decision: GraphDecision;
      let priorNoProgress = state.noProgress;
      let retryFlags: RetryFlags | undefined;
      const queuedRetry = state.executorRetry;
      if (queuedRetry !== undefined) {
        // §4.3: a failure its executor declared retryable runs again unchanged,
        // before the graph or the supervisor is asked anything.
        const { executorRetry: _queued, ...rest } = state;
        void _queued;
        state = rest;
        decision = dispatch(
          queuedRetry.job,
          queuedRetry.reason ?? `retry ${queuedRetry.attempt} of ${queuedRetry.limit} after a failure the executor declared retryable`,
        );
        retryFlags = {
          attempt: queuedRetry.attempt,
          limit: queuedRetry.limit,
          graphCorrectionTrial: queuedRetry.graphCorrectionTrial,
          supervisorWorkDispatch: queuedRetry.supervisorWorkDispatch,
          ...(queuedRetry.reason !== undefined ? { reason: queuedRetry.reason } : {}),
          ...(queuedRetry.timeoutChain !== undefined ? { timeoutChain: queuedRetry.timeoutChain } : {}),
        };
      } else if (state.mode === "recovery" && deps.supervisor !== undefined && stalledWithFreshEvidence(state)) {
        // §4.3: the run progressed since the last episode, so the stall the
        // trigger reports is already past; hand the run back to its graph.
        decision = returnToNormal(
          { summary: "the run produced new evidence since the last recovery episode" },
          "stalled trigger with new evidence since the last episode",
        );
        state = recordRemedy(
          { ...state, lastEpisodeMark: progressMark(state) },
          {
            condition: "stalled",
            remedy: "returned to normal without a model call: new evidence since the last recovery episode",
            detail: boundText(state.recoveryTrigger?.message ?? "stalled"),
            ...(state.recoveryEpisodeId !== undefined ? { episodeId: state.recoveryEpisodeId } : {}),
          },
        );
      } else if (state.mode === "recovery") {
        if (!deps.supervisor) {
          state = {
            ...state,
            status: "stopped",
            stopReason: state.recoveryTrigger?.message ?? "recovery required",
            blocker: "no supervisor configured",
          };
          await saveRunState(state);
          return { done: true as const, state };
        }
        if (!state.recoveryEpisodeId) {
          state = {
            ...state,
            recoveryEpisodeId: `ep-${randomUUID().slice(0, 8)}`,
          };
        }
        const episodeId = state.recoveryEpisodeId!;
        const trigger = state.recoveryTrigger ?? {
          code: "unhandled",
          message: "recovery",
        };
        const supervisor = deps.supervisor;
        state = await applyOperatorSwitch(state, supervisor);

        // A metered supervisor spends agent invocations; never prompt it without one left.
        const metered = supervisor.drainProviderCalls !== undefined;
        if (metered && state.budgets.agentInvocations <= 0) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "agentInvocations budget exhausted",
            blocker: "supervisor decide",
          };
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: true as const, state };
        }

        // The case file is the supervisor's only memory of earlier episodes
        // (each episode, and the first after a resume, starts a fresh model
        // session): findings made against a since-changed candidate or plugin
        // version are marked stale here, and the last proposal's settlement
        // becomes an attempt, written by the controller, not the model.
        const executors = executorViews(state);
        const view = { ...toRunView(state), ...(executors !== undefined ? { executors } : {}) };
        const lastSettlement = settleProposal(state);
        state = recordAttempt(refreshCaseFile(state), lastSettlement);
        const caseFile = liveCaseFile(state);
        // Every save during the supervisor's turn writes the latest state, one save after
        // another: probes, findings and rejections can overlap, and a save that runs late
        // must never put an older snapshot over a newer reservation.
        let turnSaves: Promise<void> = Promise.resolve();
        const saveLatest = (): Promise<void> => {
          const next = turnSaves.then(() => saveRunState(state));
          turnSaves = next.catch(() => undefined);
          return next;
        };
        const recordCaseFinding = async (finding: CaseFinding): Promise<CaseFindingOutcome> => {
          const kept = recordFinding(state, finding, episodeId);
          if (kept.outcome.kept) {
            state = { ...kept.state, stateRevision: state.stateRevision + 1 };
            await saveLatest();
            syncRevision(deps, state);
          }
          return kept.outcome;
        };
        // Admission feedback within the turn: the controller's own check, run
        // by the supervisor's tools before a proposal ends the turn and again
        // here on whatever decide() returns. Nothing in the run changes during
        // the turn, so the check reads the state as it stands now.
        const admittedAgainst = state;
        const rejections: SupervisorRejection[] = [];
        // Every inadmissible proposal this turn is charged here, whether the
        // controller's check found it or the supervisor's own tools did: to
        // the turn's allowance, and to the run's decisions budget, persisted
        // before the supervisor hears the rejection so a crash refunds nothing.
        let decisionsExhausted = false;
        const refuse = async (action: string, reason: string): Promise<SupervisorRejection> => {
          state = {
            ...state,
            budgets: { ...state.budgets, decisions: Math.max(0, state.budgets.decisions - 1) },
            stateRevision: state.stateRevision + 1,
          };
          await saveLatest();
          syncRevision(deps, state);
          if (state.budgets.decisions <= 0) decisionsExhausted = true;
          const rejection: SupervisorRejection = {
            action,
            reason,
            remaining: decisionsExhausted ? 0 : Math.max(0, MAX_INADMISSIBLE_PER_TURN - rejections.length - 1),
          };
          rejections.push(rejection);
          return rejection;
        };
        // Dry-run probes: each runs the real admission code on a copy of state.
        // Charged to budgets.probes when the task sets one (saved without a
        // revision bump: the probe itself changes nothing else), otherwise
        // capped per episode.
        let turnSignal: AbortSignal | undefined;
        let recoveryFence = createRecoveryFence();
        // The reservation is durable before the probe runs, so a probe that
        // throws still counts against the episode's cap and the run's budget.
        const reserveProbe = async (): Promise<{ id: string } | { refused: string }> => {
          const attempts = episodeProbeAttempts(state, episodeId);
          const left = state.budgets.probes;
          if (left === undefined && attempts >= DEFAULT_EPISODE_PROBES) {
            return { refused: `${DEFAULT_EPISODE_PROBES} probes already started this episode` };
          }
          if (left !== undefined && left <= 0) return { refused: "the run's probes budget is exhausted" };
          const id = `probe-${attempts + 1}`;
          state = {
            ...state,
            ...(left !== undefined ? { budgets: { ...state.budgets, probes: left - 1 } } : {}),
            probeLog: { episodeId, ids: [...episodeProbeIds(state, episodeId)], attempts: attempts + 1, ...episodeProbeResults(state, episodeId) },
          };
          await saveLatest();
          return { id };
        };
        // The log is durable (without a revision bump) so a later turn of the
        // episode, or a resume, can still cite what an earlier turn probed.
        const recordProbe = async (id: string, record: ProbeRecord): Promise<void> => {
          const ids = [...episodeProbeIds(state, episodeId), id];
          const results = keepProbeResult(episodeProbeResults(state, episodeId).results, id, record);
          state = { ...state, probeLog: { episodeId, ids, attempts: episodeProbeAttempts(state, episodeId), results } };
          await saveLatest();
        };
        // Alive until the run is stopped, through the fallback check after decide() returns.
        let reviewSignal: AbortSignal | undefined;
        const inspectionHooks: Parameters<typeof createSupervisorInspection>[0] = {
          state: () => state,
          validators: deps.validators,
          hasRepairHooks: deps.repair !== undefined,
          reserveProbe,
          recordProbe,
          signal: () => turnSignal,
          recoverHost: async (code) => {
            // Only while the supervisor's turn is running, and finished before the turn is
            // torn down: the fence is closed (and drained) when the turn ends.
            const running = recoveryFence.runOnce("plugin-host", async () => {
              const restarted = await restartDeadChildHost(state, deps, mapHostFailureCode(code));
              return restarted.ok ? undefined : restarted.blocker;
            });
            return running ?? "the supervisor's turn is over";
          },
        };
        const inspection = createSupervisorInspection(inspectionHooks);
        // The reviewer's tools are opened per review: they end with the run's stop, the review's
        // timeout and the review itself (not with the supervisor's turn: the fallback check runs
        // after decide() has returned), and every call is drained before the review returns.
        const openReviewInspection: OpenReviewInspection = (signal) => {
          const reviewFence = createRecoveryFence();
          const handle = createSupervisorInspection({
            ...inspectionHooks,
            signal: () => signal,
            // The supervisor's fence while its turn runs (so one dead host is replaced once);
            // this review's own once that turn is over, as in the fallback check.
            recoverHost: async (code) => {
              const replace = async () => {
                const restarted = await restartDeadChildHost(state, deps, mapHostFailureCode(code));
                return restarted.ok ? undefined : restarted.blocker;
              };
              const running = recoveryFence.runOnce("plugin-host", replace) ?? reviewFence.runOnce("plugin-host", replace);
              return running ?? "the review is over";
            },
          });
          const inFlight = new Set<Promise<unknown>>();
          const tracked = Object.fromEntries(
            Object.entries(handle.inspection).map(([name, fn]) => [
              name,
              (...args: unknown[]) => {
                const result = (fn as (...a: unknown[]) => unknown)(...args);
                if (result instanceof Promise) {
                  inFlight.add(result);
                  const done = () => inFlight.delete(result);
                  result.then(done, done);
                }
                return result;
              },
            ]),
          ) as unknown as SupervisorInspection;
          return {
            inspect: tracked,
            drain: async () => {
              while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
              await reviewFence.close();
            },
          };
        };
        // Whether the supervisor's prompt is still running: its calls are settled only when it ends.
        let turnRunning = false;
        // Confirmations are noted once the proposal is marked, which resets the notes.
        const confirmations: string[] = [];
        const noteConfirmations = () => {
          for (const note of confirmations.splice(0)) state = noteOutcome(state, note);
        };
        // #121: a high-impact proposal is reviewed once per turn (the supervisor's tools and
        // this loop both run the check), and a reviewer that cannot answer ends the turn.
        const reviews = new Map<string, Promise<ReviewOutcome>>();
        let reviewBlocker: string | undefined;
        // Provider calls reviews spent this turn: the running prompt's cap shrinks by them.
        let reviewSpent = 0;
        const review = async (candidate: GraphDecision): Promise<Inadmissible | { blocker: string } | undefined> => {
          const reviewer = deps.proposalReviewer;
          if (reviewer === undefined || !needsReview(candidate)) return undefined;
          const key = JSON.stringify([candidate.reason, candidate.action, candidate.evidence ?? []]);
          let pending = reviews.get(key);
          if (pending === undefined) {
            const refs = citedRefs(candidate);
            const cited = new Set(refs);
            const metered = reviewer.drainProviderCalls !== undefined;
            pending = (async (): Promise<ReviewOutcome> => {
              if (metered) {
                // What the supervisor has spent so far is charged first, so the reviewer is
                // never granted an invocation the supervisor already used this turn.
                const settled = settleSupervisorUsage(state, supervisor);
                if (settled !== state) {
                  state = settled;
                  await saveLatest();
                  syncRevision(deps, state);
                }
              }
              // A prompt still running has spent calls it has not reported yet; after settling,
              // only what is still outstanding is reserved, never also granted to the reviewer.
              const outstanding =
                metered && turnRunning && supervisor.drainProviderCalls !== undefined
                  ? Math.max(0, supervisor.outstandingProviderCalls?.() ?? 1)
                  : 0;
              const allowance = state.budgets.agentInvocations - outstanding;
              if (metered && allowance <= 0) {
                return { kind: "unavailable", reason: "no agentInvocations left in the run's budget for a review" };
              }
              const outcome = await runReview(
                reviewer,
                {
                  runId: state.runId,
                  episodeId,
                  triggerCode: trigger.code,
                  decision: candidate,
                  evidence: [...state.evidence.filter((e) => cited.has(e.ref)), ...citedProbeEvidence(state, refs)],
                  openInspection: openReviewInspection,
                  ...(metered ? { maxProviderCalls: allowance } : {}),
                },
                reviewSignal,
                supervisor.sessionId,
              );
              const spent = metered ? Math.max(0, reviewer.drainProviderCalls!()) : 0;
              reviewSpent += spent;
              if (spent > 0) {
                state = {
                  ...state,
                  budgets: { ...state.budgets, agentInvocations: Math.max(0, state.budgets.agentInvocations - spent) },
                  stateRevision: state.stateRevision + 1,
                };
                await saveLatest();
                syncRevision(deps, state);
              }
              return outcome;
            })();
            reviews.set(key, pending);
          }
          const outcome = await pending;
          if (outcome.kind === "unavailable") return { blocker: outcome.reason };
          const by = outcome.model !== undefined ? ` (${outcome.model})` : "";
          if (outcome.kind === "confirmed") {
            confirmations.push(`reviewer${by} confirmed ${candidate.action.type}: ${outcome.reason}`);
            return undefined;
          }
          const refs = outcome.evidenceRefs.length > 0 ? `; evidence: ${outcome.evidenceRefs.join(", ")}` : "";
          return { precondition: `${candidate.action.type} refuted by the independent reviewer${by}`, detail: `${outcome.reason}${refs}` };
        };
        const check: AdmissionCheck = async (candidate) => {
          if (reviewBlocker !== undefined) return { action: candidate.action.type, reason: reviewBlocker, remaining: 0 };
          // The grounding rule (#119) and the executor-input pre-check (#132)
          // share this one check, so either refusal is charged the same way.
          const refusal =
            supervisorAdmissionRefusal(
              admittedAgainst,
              candidate,
              deps,
              trigger.code,
              supervisor.requiresCitedEvidence === true ? episodeProbeIds(state, episodeId) : undefined,
            ) ??
            (await executorInputRefusal(admittedAgainst, candidate, deps.runner)) ??
            (await hostScopeRefusal(admittedAgainst, candidate, deps.runner));
          if (refusal !== undefined) return refuse(candidate.action.type, describeInadmissible(refusal));
          const reviewed = await review(candidate);
          if (reviewed === undefined) return undefined;
          if ("blocker" in reviewed) {
            reviewBlocker = reviewed.blocker;
            return { action: candidate.action.type, reason: reviewBlocker, remaining: 0 };
          }
          const refused = await refuse(candidate.action.type, describeInadmissible(reviewed));
          // The running prompt cannot be told its allowance shrank, so a refute that spent the
          // last of it ends the turn here (`remaining: 0`) instead of inviting another call.
          if (
            refused.remaining > 0 &&
            turnRunning &&
            deps.proposalReviewer?.drainProviderCalls !== undefined &&
            supervisor.drainProviderCalls !== undefined &&
            state.budgets.agentInvocations - Math.max(0, supervisor.outstandingProviderCalls?.() ?? 1) <= 0
          ) {
            const ended = { ...refused, remaining: 0 };
            rejections[rejections.length - 1] = ended;
            return ended;
          }
          return refused;
        };
        // Input paths the supervisor normalized this decide() call; reset with each turn.
        let normalizedPaths: string[] = [];
        const admission = {
          facts: admissionFacts(state, deps.repair !== undefined),
          check,
          refuse,
          normalized: (paths: string[]) => {
            normalizedPaths.push(...paths);
          },
          reservedProviderCalls: () => reviewSpent,
        };
        let decided: SupervisorProposal | undefined;
        let decideError: unknown;
        let rejection: SupervisorRejection | undefined;
        // The decide() call being recorded (see episodes.ts); 0 until the first returns.
        let episodeTurn = 0;
        const episodeRejections = (from: number) => rejections.slice(from).map((r) => `${r.action}: ${r.reason}`);
        for (;;) {
          const recorder = createEpisodeRecorder();
          const rejectedBefore = rejections.length;
          const budgetBefore = state.budgets.agentInvocations;
          const waitBefore = state.budgets.waitMs ?? 0;
          const abort = new AbortController();
          // Ends with the run's stop and with this turn, so a probe still running afterwards is cancelled.
          const turnEnded = new AbortController();
          turnSignal = AbortSignal.any([abort.signal, turnEnded.signal]);
          reviewSignal = abort.signal;
          recoveryFence = createRecoveryFence();
          const fence = recoveryFence;
          const stopWatch = watchForStop(state.stateDir, deps, abort);
          decided = undefined;
          decideError = undefined;
          normalizedPaths = [];
          // maxProviderCalls below is the balance now, which already has earlier reviews' spend.
          reviewSpent = 0;
          turnRunning = true;
          try {
            const proposal = await supervisor.decide({
              runId: state.runId,
              episodeId,
              trigger: {
                code: trigger.code as RecoveryTrigger["code"],
                message: trigger.message,
                ...(trigger.evidenceRefs !== undefined ? { evidenceRefs: [...trigger.evidenceRefs] } : {}),
              },
              view,
              signal: abort.signal,
              admission,
              ...(rejection !== undefined ? { rejection } : {}),
              ...(lastSettlement !== undefined ? { lastSettlement } : {}),
              ...(metered ? { maxProviderCalls: state.budgets.agentInvocations } : {}),
              maxWaitMs: state.budgets.waitMs ?? 0,
              caseFile,
              recordFinding: recorder.recordFinding(recordCaseFinding),
              inspect: recorder.inspect(inspection.inspection),
            });
            decided = isModelSwitchRequest(proposal) ? proposal : assertGraphDecision(proposal);
          } catch (err) {
            decideError = err;
          } finally {
            turnRunning = false;
            turnEnded.abort();
            // A host replacement the supervisor's probe began is finished before anything tears the run down.
            await fence.close();
            // Saves a probe or finding began are finished before the turn's own saves follow.
            await turnSaves;
            stopWatch();
            state = settleSupervisorUsage(state, supervisor);
            state = settleSupervisorRemedies(state, supervisor, episodeId);
            // Recorded for every decide() call, however it ended; the controller's
            // admission outcome is settled onto the record below.
            episodeTurn = nextEpisodeTurn(state, episodeId);
            state = appendEpisode(
              state,
              buildEpisodeRecord({
                episodeId,
                turn: episodeTurn,
                runId: state.runId,
                trigger: { code: trigger.code as RecoveryTrigger["code"], message: trigger.message, ...(trigger.evidenceRefs !== undefined ? { evidenceRefs: [...trigger.evidenceRefs] } : {}) },
                view,
                ...(caseFile !== undefined ? { caseFile } : {}),
                ...(lastSettlement !== undefined ? { lastSettlement } : {}),
                ...(rejection !== undefined ? { rejection } : {}),
                ...(metered ? { maxProviderCalls: budgetBefore } : {}),
                maxWaitMs: waitBefore,
                recorder,
                ...(decided !== undefined ? { proposal: decided } : {}),
                ...(decideError !== undefined ? { error: decideError } : {}),
                admission: {
                  facts: admission.facts,
                  rejections: episodeRejections(rejectedBefore),
                  ...(normalizedPaths.length > 0 ? { normalized: [...normalizedPaths] } : {}),
                  outcome:
                    decided !== undefined
                      ? isModelSwitchRequest(decided)
                        ? "model_switch"
                        : "pending"
                      : abort.signal.aborted
                        ? "aborted"
                        : rejections.length > rejectedBefore
                          ? "inadmissible"
                          : "error",
                },
                providerCalls: metered ? Math.max(0, budgetBefore - state.budgets.agentInvocations - reviewSpent) : 0,
              }),
            );
            const binding = readBinding(supervisor);
            if (binding) {
              state = { ...state, supervisorBinding: binding };
            }
          }
          if (abort.signal.aborted || (await stopRequested(deps))) {
            state = settleEpisode(state, episodeId, episodeTurn, "aborted", episodeRejections(rejectedBefore));
            state = {
              ...state,
              status: "stopped",
              ...stopCause(deps),
            };
            await saveRunState(state);
            syncRevision(deps, state);
            return { done: true as const, state };
          }
          if (decisionsExhausted || rejections.length >= MAX_INADMISSIBLE_PER_TURN) break;
          if (decideError !== undefined || decided === undefined || isModelSwitchRequest(decided)) break;
          // A supervisor that ran the check in its tools only returns proposals
          // that passed it; any other (scripted, or one ignoring the check) is
          // re-asked here, within the same turn, with the rejection.
          // A review in this check must end with the operator's stop too, so the watch outlives decide().
          const reviewWatch = watchForStop(state.stateDir, deps, abort);
          const refused = await check(decided).finally(reviewWatch);
          state = settleEpisode(state, episodeId, episodeTurn, refused === undefined ? "admitted" : "inadmissible", episodeRejections(rejectedBefore));
          if (refused === undefined || refused.remaining <= 0) break;
          rejection = refused;
          if (metered && state.budgets.agentInvocations <= 0) {
            state = {
              ...state,
              status: "stopped",
              stopReason: "agentInvocations budget exhausted",
              blocker: "supervisor decide",
            };
            await saveRunState(state);
            syncRevision(deps, state);
            return { done: true as const, state };
          }
        }
        // A turn that ended before the fallback check ran (the rejection limit, an
        // exhausted decisions budget, an unavailable reviewer) admitted nothing.
        if (episodeTurn > 0 && (decisionsExhausted || reviewBlocker !== undefined || rejections.length >= MAX_INADMISSIBLE_PER_TURN)) {
          const last = state.supervisorEpisodes?.find((r) => r.episodeId === episodeId && r.turn === episodeTurn);
          if (last?.admission.outcome === "pending") state = settleEpisode(state, episodeId, episodeTurn, "inadmissible");
        }
        if (reviewBlocker !== undefined && ((await stopRequested(deps)) || reviewSignal?.aborted === true)) {
          // The operator's stop cancelled the review: the run is stopped, not blocked on a reviewer.
          state = { ...state, status: "stopped", ...stopCause(deps) };
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: true as const, state };
        }
        if (reviewBlocker !== undefined) {
          // Never a silent approval: with no verdict the proposal is not admitted and the run stops.
          state = {
            ...state,
            status: "stopped",
            stopReason: "reviewer_unavailable",
            blocker: boundText(`independent reviewer unavailable, proposal not admitted: ${reviewBlocker}`),
          };
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: true as const, state };
        }
        if (decisionsExhausted) {
          // A blocking stop: the rejections spent the last of the decisions budget.
          const last = rejections[rejections.length - 1]!;
          state = {
            ...state,
            status: "stopped",
            stopReason: "decisions budget exhausted",
            blocker: boundText(`supervisor proposal rejected with no decisions left: ${last.action}: ${last.reason}`),
          };
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: true as const, state };
        }
        if (rejections.length >= MAX_INADMISSIBLE_PER_TURN) {
          // The episode ends with the trigger's safe default, recorded for the operator.
          const last = rejections[rejections.length - 1]!;
          const outcome = safeDefault(state, trigger.code);
          state = recordSupervisorOutcome(state, {
            outcome: "supervisor_inadmissible",
            rejections: rejections.map((r) => `${r.action}: ${r.reason}`),
            applied: outcome,
          });
          if (outcome === "stop") {
            state = {
              ...state,
              status: "stopped",
              stopReason: "supervisor_inadmissible",
              blocker: boundText(`${rejections.length} inadmissible proposals this turn; last: ${last.action}: ${last.reason}`),
            };
            await saveRunState(state);
            syncRevision(deps, state);
            return { done: true as const, state };
          }
          decided = {
            reason: `controller safe default: ${rejections.length} inadmissible supervisor proposals this turn`,
            action: {
              type: "return",
              return: { summary: `supervisor_inadmissible; last rejection: ${last.action}: ${last.reason}` },
            },
          };
          state = markProposal({ ...state, lastEpisodeMark: progressMark(state) }, decided);
          for (const r of rejections) state = noteOutcome(state, `inadmissible, not applied: ${r.action}: ${r.reason}`);
          noteConfirmations();
          decision = decided;
        } else {
          if (decideError !== undefined || decided === undefined) {
            state = {
              ...state,
              status: "stopped",
              // A refuted review that spent the turn's last call ends it without a decision.
              ...(metered && state.budgets.agentInvocations <= 0 && rejections.length > 0
                ? { stopReason: "agentInvocations budget exhausted", blocker: "supervisor decide" }
                : decideFailureStop(decideError)),
            };
            await saveRunState(state);
            syncRevision(deps, state);
            return { done: true as const, state };
          }
          if (isModelSwitchRequest(decided)) {
            lastAction = "supervisor switch_model";
            state = markProposal(state, decided);
            state = await applyModelSwitch(state, supervisor, decided, "supervisor");
            await saveRunState(state);
            syncRevision(deps, state);
            return { done: false as const, state };
          }
          const notedProposal = noteSupervisorProposal({ ...state, lastEpisodeMark: progressMark(state) }, trigger.code, decided);
          state = markProposal(
            notedProposal.state,
            decided,
            notedProposal.count >= 2 ? { count: notedProposal.count, triggerCode: trigger.code } : undefined,
          );
          // The next turn's settlement says what this turn refused before admitting it.
          for (const r of rejections) state = noteOutcome(state, `refused earlier this turn: ${r.action}: ${r.reason}`);
          noteConfirmations();
          decision = decided;
        }
      } else {
        // A graph may check the input it composes against the limits an executor declares.
        const declared = executorViews(state);
        const view = { ...toRunView(state), ...(declared !== undefined ? { executors: declared } : {}) };
        const advanced = await deps.host.advance(
          {
            runId: state.runId,
            operationId: `adv-${state.stateRevision}-${step}`,
            expectedStateRevision: state.stateRevision,
          },
          view,
        );
        if (!advanced.ok) {
          lastAction = `plugin host failure (${advanced.observation.code})`;
          const contained = await containHostFailure(
            state,
            deps,
            advanced.observation.code,
            advanced.observation.message,
          );
          await saveRunState(contained.state);
          syncRevision(deps, contained.state);
          return { done: contained.done, state: contained.state };
        }
        decision = assertGraphDecision(advanced.value);
        const noted = noteGraphDecision(state, decision);
        state = noted.state;
        if (noted.stalled !== undefined) {
          state = enterRecovery(
            {
              ...state,
              budgets: { ...state.budgets, decisions: Math.max(0, state.budgets.decisions - 1) },
              stateRevision: state.stateRevision + 1,
            },
            "stalled",
            noted.stalled,
          );
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: false as const, state };
        }
      }

      lastAction = `${state.mode === "recovery" ? "supervisor" : "graph"} ${decision.action.type}`;
      // The callback that proposed this decision may have used up the time left.
      if (activeTimeExhausted(deps)) {
        state = { ...chargeActiveTime(state, deps), status: "stopped", ...stopCause(deps) };
        await saveRunState(state);
        syncRevision(deps, state);
        return { done: true as const, state };
      }

      if (decision.action.type === "dispatch") {
        const prepared = await prepareDispatch(state, decision, deps, retryFlags);
        await saveRunState(prepared.state);
        syncRevision(deps, prepared.state);
        if (prepared.state.status !== "running") {
          return { done: true as const, state: prepared.state };
        }
        if (!prepared.pending) {
          return { done: false as const, state: prepared.state };
        }
        return {
          done: false as const,
          state: prepared.state,
          pendingJob: prepared.pending,
        };
      }

      // A qualified repair's patch is a long supervisor episode; Stop must abort it.
      const applyAbort = new AbortController();
      const applyWatch =
        decision.action.type === "qualify_repair" ? watchForStop(state.stateDir, deps, applyAbort) : undefined;
      try {
        state = await applyDecision(state, decision, deps, applyAbort.signal);
      } catch (err) {
        if (err instanceof HostObservationError) {
          // The decision never took effect, so proposing it again is not a repeat.
          const { noProgress: _counted, ...uncounted } = state;
          void _counted;
          const contained = await containHostFailure(
            priorNoProgress !== undefined ? { ...uncounted, noProgress: priorNoProgress } : uncounted,
            deps,
            err.code,
            err.message,
          );
          await saveRunState(contained.state);
          syncRevision(deps, contained.state);
          return { done: contained.done, state: contained.state };
        }
        throw err;
      } finally {
        applyWatch?.();
      }
      syncRevision(deps, state);
      if ((await stopRequested(deps)) && state.status === "running") {
        state = {
          ...state,
          status: "stopped",
          ...stopCause(deps),
        };
      }
      await saveRunState(state);
      return { done: state.status !== "running", state };
    });

    state = turn.state;
    if (turn.done) {
      return state;
    }

    if (turn.pendingJob) {
      const { job, operationId, generation, isCorrection, graphCorrectionTrial, supervisorWorkDispatch, confined, hostChange, source, notBefore, session } =
        turn.pendingJob;
      const abort = new AbortController();
      const stopWatch = watchForStop(state.stateDir, deps, abort);
      let result: Awaited<ReturnType<Runner["runJob"]>>;
      let children: ReturnType<typeof createChildPort> | undefined;
      let before: Map<string, string> | undefined;
      let checkedDigest: string | undefined;
      let staleIdentity: string | undefined;
      try {
        if (notBefore !== undefined) {
          // A wait on the clock is charged to waitMs when admitted, not to active time.
          const resumeClock = deps.activeClock?.pause();
          try {
            await sleepUntil(notBefore, abort.signal);
          } finally {
            resumeClock?.();
          }
        }
        const unchanged = abort.signal.aborted ? undefined : await worktreeChangeFingerprints(state.worktreePath);
        if (!abort.signal.aborted && !(await startDispatch(state, operationId, deps))) abort.abort();
        if (abort.signal.aborted) {
          result = { status: "failed", summary: "executor cancelled before start", runId: state.runId, operationId, generation };
        } else {
          before = unchanged;
          const confinement = confined ? await jobConfinement(state) : undefined;
          children =
            job.kind === "agent" || job.tools !== undefined
              ? createChildPort(
                  { job, operationId, generation },
                  {
                    stateDir: state.stateDir,
                    runner: deps.runner,
                    shouldStop: () => stopRequested(deps),
                    signal: abort.signal,
                    ...(confinement !== undefined ? { confinement } : {}),
                  },
                )
              : undefined;
          if (job.checkout !== undefined) {
            const ran = await runInCheckout({
              job: job as JobSpec & { checkout: CheckoutSpec },
              operationId,
              generation,
              runId: state.runId,
              repoPath: state.intake.repoPath,
              worktreePath: state.worktreePath,
              pinnedHead: state.intake.pinnedHead,
              stateDir: state.stateDir,
              artifactDir: state.artifactDir,
              ...(confined ? { scratchDir: scratchDirOf(state) } : {}),
              checks: state.definition.environment?.checks ?? [],
              prepare: state.definition.environment?.prepare ?? [],
              runner: deps.runner,
              signal: abort.signal,
              ...(source !== undefined ? { source } : {}),
            });
            result = ran.result;
            checkedDigest = ran.candidateDigest;
            staleIdentity = ran.staleIdentity;
          } else {
            const resultContract = resolveResultContract(state, job);
            result = await deps.runner.runJob(job, {
              runId: state.runId,
              operationId,
              generation,
              worktreePath: state.worktreePath,
              artifactDir: state.artifactDir,
              signal: abort.signal,
              ...(confinement !== undefined ? { confinement } : {}),
              ...(children !== undefined ? { children } : {}),
              ...(source !== undefined ? { executorSource: source } : {}),
              ...(session !== undefined ? { session } : {}),
              ...(resultContract !== undefined ? { resultContract } : {}),
            });
          }
        }
      } finally {
        // A parent that stopped, timed out, or returned early can leave a child running.
        await children?.close();
        stopWatch();
      }
      if (hostChange) {
        result = {
          ...result,
          evidence: [
            ...(result.evidence ?? []),
            {
              kind: "other",
              payload: {
                hostChange: { operationId, executorId: job.executor?.id ?? job.kind, reason: "ran outside the run's scope under the operator's hostRepair grant" },
              },
            },
          ],
        };
      }
      // Executors may run unconfined, so scope is checked against what actually changed.
      let outOfScope: string[] = [];
      // Whether the job changed the worktree at all: a timed-out agent that did made progress worth continuing.
      let worktreeChanged: boolean | undefined;
      if (before !== undefined) {
        const changed = changedPaths(before, await worktreeChangeFingerprints(state.worktreePath));
        worktreeChanged = changed.length > 0;
        // New means absent before the job: neither dirty in the pre-job
        // snapshot nor a clean file tracked at HEAD.
        const tracked = job.readOnly === true ? await trackedAtHead(state.worktreePath, changed) : new Set<string>();
        outOfScope = pathsOutsideWriteScope(changed, job, (rel) => !before.has(rel) && !tracked.has(rel));
      }
      const afterDigest = await liveCandidateDigest(state);

      state = await withRunLock(state.stateDir, async () => {
        state = chargeActiveTime(await reloadRunState(state), deps);
        syncRevision(deps, state);
        if (await stopRequested(deps) || state.status !== "running") {
          if (state.status === "running") {
            state = {
              ...state,
              status: "stopped",
              ...stopCause(deps),
            };
            await saveRunState(state);
          }
          return state;
        }

        const renewed = await tryRenewOwner(state.stateDir, owner, deps.host.childPid);
        if (!renewed) {
          if (state.status === "running") {
            state = {
              ...state,
              status: "stopped",
              stopReason: "operator stop",
              blocker: "run owner lease cleared",
            };
            await saveRunState(state);
          }
          return state;
        }
        owner = renewed;

        if (state.generation !== generation) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "stale job result identity",
            blocker: `generation ${generation} != ${state.generation}`,
          };
          await saveRunState(state);
          return state;
        }
        if (staleIdentity !== undefined) {
          const { pendingDispatch, ...rest } = state;
          state = {
            ...rest,
            ...(pendingDispatch ? { pendingDispatch: { ...pendingDispatch, status: "failed" as const } } : {}),
            status: "stopped",
            stopReason: "stale job result identity",
            blocker: staleIdentity,
          };
          await saveRunState(state);
          return state;
        }
        state = applyDispatchResult(withCandidateDigest(state, afterDigest), {
          job,
          operationId,
          generation,
          isCorrection,
          graphCorrectionTrial,
          supervisorWorkDispatch,
          result: outOfScope.length > 0 ? scopeViolation(result, job, outOfScope) : result,
          canRecover: deps.supervisor !== undefined,
          candidateDigest: checkedDigest ?? afterDigest,
          worktreeChanged,
        });
        syncRevision(deps, state);
        if ((await stopRequested(deps)) && state.status === "running") {
          state = {
            ...state,
            status: "stopped",
            ...stopCause(deps),
          };
        }
        await saveRunState(state);
        return state;
      });

      if (state.status !== "running") {
        return state;
      }
    }
  }
}

const STOP_POLL_MS = 200;

/** Resolve at `until`, or as soon as the run stops. */
function sleepUntil(until: string, signal: AbortSignal): Promise<void> {
  const target = Date.parse(until);
  if (!(target - Date.now() > 0) || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    // Sleep in steps no longer than MAX_TIMER_MS: Node fires a longer timer after 1ms.
    const arm = () => {
      const left = target - Date.now();
      if (!(left > 0)) return done();
      timer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
    };
    arm();
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The longest delay setTimeout honours; a longer one is replaced by 1ms. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Mark an admitted dispatch as handed to the runner, while it is still the
 * run's outstanding job and the run may still act. Until then a restart may
 * drop it as never started.
 */
async function startDispatch(state: DurableRunState, operationId: string, deps: LoopDeps): Promise<boolean> {
  return withRunLock(state.stateDir, async () => {
    const current = await reloadRunState(state);
    const pending = current.pendingDispatch;
    if (current.status !== "running" || pending?.operationId !== operationId || pending.status !== "waiting") {
      return false;
    }
    if (await stopRequested(deps)) return false;
    const started: DurableRunState = { ...current, pendingDispatch: { ...pending, status: "pending" } };
    await saveRunState(started);
    syncRevision(deps, started);
    return true;
  });
}

/** Environment checks and preparation commands the graph declares. */
function setupCommands(env: EnvironmentDeclaration | undefined): number {
  return (env?.checks?.length ?? 0) + (env?.prepare?.length ?? 0);
}

/** A checkout job's own checks and preparation run before its commands, and count as a job of their own. */
function jobCost(state: DurableRunState, job: JobSpec): number {
  return job.checkout !== undefined && setupCommands(state.definition.environment) > 0 ? 2 : 1;
}

/**
 * B1/B2: resolves `job.resultSchema` against the run's own plugin-declared
 * contracts, so the executor receives real schema text (and any reference id
 * sets the job supplied) instead of a bare name. Admission already refused a
 * name the plugin did not declare, so a miss here just means no contract
 * applies to this job.
 */
function resolveResultContract(state: DurableRunState, job: JobSpec): JobContext["resultContract"] {
  if (job.resultSchema === undefined) return undefined;
  const contract = state.definition.resultContracts?.find((c) => c.name === job.resultSchema);
  if (contract === undefined) return undefined;
  return {
    name: contract.name,
    schema: contract.schema,
    ...(contract.references !== undefined ? { references: contract.references } : {}),
    ...(job.knownReferences !== undefined ? { knownReferences: job.knownReferences } : {}),
  };
}

function withCandidateDigest(state: DurableRunState, digest: string | undefined): DurableRunState {
  if (digest === undefined) {
    const { candidateDigest: _dropped, ...rest } = state;
    void _dropped;
    return refreshCaseFile(rest);
  }
  // A finding the supervisor made against the previous candidate goes stale now.
  return refreshCaseFile({ ...state, candidateDigest: digest });
}

/**
 * Check the graph's declared environment before normal work, outside the run
 * lock so Stop is not held up by slow preparation. A missing tool or failed
 * preparation stops the run; a changed pinned file blocks normal jobs and
 * hands the run to the supervisor, once per active version.
 */
async function preflightEnvironment(state: DurableRunState, deps: LoopDeps): Promise<DurableRunState> {
  const env = state.definition.environment!;
  if (setupCommands(env) > 0) {
    // Reserved and saved before anything runs, so a crash or another resume cannot run it for free.
    state = await withRunLock(state.stateDir, async () => {
      let next = chargeActiveTime(await reloadRunState(state), deps);
      syncRevision(deps, next);
      if (next.status !== "running") return next;
      next =
        next.budgets.jobs <= 0
          ? { ...next, status: "stopped", stopReason: "budgets exhausted", blocker: "jobs" }
          : { ...next, budgets: { ...next.budgets, jobs: next.budgets.jobs - 1 } };
      await saveRunState(next);
      return next;
    });
    if (state.status !== "running") return state;
  }
  const abort = new AbortController();
  const stopWatch = watchForStop(state.stateDir, deps, abort);
  let outcome: EnvironmentOutcome;
  try {
    outcome = await checkEnvironment({ state, env, runner: deps.runner, signal: abort.signal });
  } catch (err) {
    outcome = {
      kind: "failed",
      operationId: `env-${state.stateRevision}`,
      evidence: [],
      stopReason: "environment check failed",
      blocker: err instanceof Error ? err.message : String(err),
    };
  } finally {
    stopWatch();
  }
  return withRunLock(state.stateDir, async () => {
    state = chargeActiveTime(await reloadRunState(state), deps);
    syncRevision(deps, state);
    if (state.status !== "running") return state;
    if (abort.signal.aborted || (await stopRequested(deps))) {
      state = { ...state, status: "stopped", ...stopCause(deps) };
      await saveRunState(state);
      return state;
    }
    const job: JobSpec = {
      stageId: state.current.stageId,
      kind: "command",
      purpose: "diagnostic",
      instruction: "environment check",
      readOnly: true,
    };
    const producer: EvidenceProducer = {
      operationId: outcome.operationId,
      stageId: job.stageId,
      purpose: job.purpose,
      readOnly: true,
      kind: job.kind,
      executorId: BUILTIN_COMMAND_EXECUTOR_ID,
    };
    const before = state.evidence.length;
    state = recordJobEvidence(state, job, producer, outcome.evidence, state.candidateDigest);
    const refs = state.evidence.slice(before).map((e) => e.ref);
    const { environmentBlock, ...unblocked } = state;
    switch (outcome.kind) {
      case "ready":
        state = unblocked;
        break;
      case "failed":
        state = { ...state, status: "stopped", stopReason: outcome.stopReason, blocker: boundText(outcome.blocker), stopEvidenceRefs: refs };
        break;
      case "changed":
        if (environmentBlock?.activeVersion === state.activeVersion) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "environment changed",
            blocker: boundText(`no repair updated the environment declaration: ${outcome.reason}`),
            stopEvidenceRefs: refs,
          };
        } else if (deps.supervisor === undefined) {
          state = { ...state, status: "stopped", stopReason: "environment changed", blocker: boundText(outcome.reason), stopEvidenceRefs: refs };
        } else {
          state = enterRecovery(
            { ...state, environmentBlock: { activeVersion: state.activeVersion, reason: outcome.reason } },
            "environment_changed",
            boundText(outcome.reason),
            refs,
          );
        }
        break;
    }
    state = { ...state, stateRevision: state.stateRevision + 1 };
    await saveRunState(state);
    syncRevision(deps, state);
    return state;
  });
}

/** Abort an outstanding job, and any child it is waiting on, once the run stops or its time runs out. Returns the disposer. */
function watchForStop(stateDir: string, deps: LoopDeps, abort: AbortController): () => void {
  // Timers can fire before the monotonic deadline, so recheck before aborting.
  let deadline: NodeJS.Timeout | undefined;
  const armDeadline = (clock: ActiveClock) => {
    const left = clock.remaining();
    if (left === 0) return abort.abort();
    // Node fires a timer whose delay exceeds MAX_TIMER_MS after 1ms; a long
    // budget re-arms in steps instead (the clock is rechecked each time).
    deadline = setTimeout(() => armDeadline(clock), Math.min(left + 1, MAX_TIMER_MS));
    deadline.unref();
  };
  if (deps.activeClock !== undefined) armDeadline(deps.activeClock);
  let checking = false;
  const timer = setInterval(() => {
    if (checking || abort.signal.aborted) return;
    checking = true;
    void (async () => {
      try {
        const stopped =
          (await stopRequested(deps)) || (await loadRunState(stateDir)).status !== "running";
        if (stopped) abort.abort();
      } catch {
        /* state briefly unavailable during an atomic rename; check again */
      } finally {
        checking = false;
      }
    })();
  }, STOP_POLL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(deadline);
  };
}

async function tryRenewOwner(
  stateDir: string,
  owner: RunOwnerClaim | undefined,
  childPid: number | undefined,
): Promise<RunOwnerClaim | undefined> {
  if (!owner) {
    return undefined;
  }
  try {
    return await renewRunOwner(stateDir, owner.ownerId, {
      ...(childPid !== undefined ? { childPid } : {}),
    });
  } catch {
    // Stop may clear the durable claim while a runner job is in flight.
    return undefined;
  }
}

async function reloadRunState(state: DurableRunState): Promise<DurableRunState> {
  try {
    return await loadRunState(state.stateDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return state;
    }
    throw err;
  }
}

function enterRecovery(
  state: DurableRunState,
  code: string,
  message: string,
  evidenceRefs: string[] = [],
): DurableRunState {
  return {
    ...state,
    mode: "recovery",
    status: "running",
    recoveryEpisodeId: `ep-${randomUUID().slice(0, 8)}`,
    recoveryTrigger: { code, message, ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}) },
  };
}

/**
 * After crash/timeout the child process is dead. Replace it before recovery
 * continues so Return can advance again. In-process hosts need no restart.
 */
async function restartDeadChildHost(
  state: DurableRunState,
  deps: LoopDeps,
  code: "plugin_crash" | "plugin_timeout" | "plugin_malformed" | "unhandled",
): Promise<{ ok: true } | { ok: false; stopReason: string; blocker: string }> {
  if (code !== "plugin_crash" && code !== "plugin_timeout") {
    return { ok: true };
  }
  if (deps.host.childPid === undefined) {
    return { ok: true };
  }
  if (!deps.recreateHost) {
    return {
      ok: false,
      stopReason: `plugin host: ${code === "plugin_crash" ? "crash" : "timeout"}`,
      blocker: "host restart unavailable after child failure",
    };
  }
  await deps.host.close().catch(() => undefined);
  try {
    deps.host = await deps.recreateHost({
      intake: state.intake,
      activeVersion: state.activeVersion,
      generation: state.generation,
    });
  } catch (err) {
    return {
      ok: false,
      stopReason: "plugin host restart failed",
      blocker: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true };
}

/** Shared advance/evaluate host-failure containment → recovery or concrete stop. */
async function containHostFailure(
  state: DurableRunState,
  deps: LoopDeps,
  observationCode: string,
  message: string,
): Promise<{ done: boolean; state: DurableRunState }> {
  if (await stopRequested(deps)) {
    return {
      done: true,
      state: {
        ...state,
        status: "stopped",
        ...stopCause(deps),
      },
    };
  }
  const code = mapHostFailureCode(observationCode);
  if (deps.supervisor) {
    const restarted = await restartDeadChildHost(state, deps, code);
    if (!restarted.ok) {
      return {
        done: true,
        state: {
          ...state,
          status: "stopped",
          stopReason: restarted.stopReason,
          blocker: restarted.blocker,
        },
      };
    }
    return {
      done: false,
      state: enterRecovery(state, code, message),
    };
  }
  return {
    done: true,
    state: {
      ...state,
      status: "stopped",
      stopReason: `plugin host: ${observationCode}`,
      blocker: message,
    },
  };
}

function mapHostFailureCode(
  code: string,
): "plugin_crash" | "plugin_timeout" | "plugin_malformed" | "unhandled" {
  switch (code) {
    case "crash":
      return "plugin_crash";
    case "timeout":
      return "plugin_timeout";
    case "malformed":
      return "plugin_malformed";
    default:
      return "unhandled";
  }
}

export function toRunView(state: DurableRunState): RunView {
  const view: RunView = {
    runId: state.runId,
    task: {
      request: state.intake.task.request,
      repo: state.intake.task.repo,
    },
    current: structuredClone(state.current),
    receipts: structuredClone(state.receipts),
    evidence: structuredClone(state.evidence),
    outstanding: structuredClone(state.outstanding),
    budgets: { ...state.budgets },
    validatorBindings: structuredClone(state.validatorBindings),
    generation: state.generation,
    stateRevision: state.stateRevision,
    activeVersion: state.activeVersion,
  };
  if (state.candidateDigest !== undefined) {
    view.candidateDigest = state.candidateDigest;
  }
  if (state.privateState !== undefined) {
    view.privateState = state.privateState;
  }
  if (state.recoveryEpisodeId !== undefined) {
    view.recoveryEpisodeId = state.recoveryEpisodeId;
  }
  if (state.openAttempt !== undefined && Object.keys(state.openAttempt).length > 0) {
    view.openAttempt = { ...state.openAttempt };
  }
  if (state.lastResume !== undefined) {
    view.resume = { ...state.lastResume };
  }
  const correctionTrials = state.correctionTrials ?? {};
  const handoff = state.handoff ?? {};
  const mark = progressMark(state);
  const repeatedProposals = state.repeatedProposals?.mark === mark ? state.repeatedProposals.entries : {};
  if (Object.keys(correctionTrials).length > 0 || Object.keys(handoff).length > 0 || Object.keys(repeatedProposals).length > 0) {
    view.escalation = {
      correctionTrials: { ...correctionTrials },
      handoff: structuredClone(handoff),
      repeatedProposals: structuredClone(repeatedProposals),
    };
  }
  if (state.repairCandidates !== undefined && state.repairCandidates.length > 0) {
    view.repairCandidates = state.repairCandidates.map((c) => ({
      artifactId: c.artifactId,
      status: c.status,
      target: c.target,
      ...(c.executorId !== undefined ? { executorId: c.executorId } : {}),
      reason: c.reason,
      ...(c.candidateDigest !== undefined ? { candidateDigest: c.candidateDigest } : {}),
      ...(c.qualifiedAt !== undefined ? { qualifiedAt: c.qualifiedAt } : {}),
      ...(c.rejectionReason !== undefined ? { rejectionReason: c.rejectionReason } : {}),
      ...(c.preflightSummary !== undefined ? { preflightSummary: c.preflightSummary } : {}),
      ...(c.patchSummary !== undefined ? { patchSummary: c.patchSummary } : {}),
    }));
  }
  const sessions = agentSessionViews(state);
  if (sessions !== undefined) view.agentSessions = sessions;
  const { grants } = state.intake;
  view.repairAuthority = {
    contract: manifestRepairContract(state.intake.bundle.manifestRaw),
    grants: {
      sourceRepair: grants.sourceRepair,
      validatorSubstitution: grants.validatorSubstitution,
      executorRepair: grants.executorRepair === true,
      hostRepair: grants.hostRepair === true,
    },
  };
  return view;
}

function settleSupervisorUsage(
  state: DurableRunState,
  supervisor: Supervisor,
): DurableRunState {
  const calls = supervisor.drainProviderCalls?.() ?? 0;
  if (calls <= 0) {
    return state;
  }
  return {
    ...state,
    budgets: {
      ...state.budgets,
      agentInvocations: Math.max(0, state.budgets.agentInvocations - calls),
    },
    stateRevision: state.stateRevision + 1,
  };
}

/**
 * Record the remedies the supervisor host applied to failed provider turns,
 * charging any time it spent waiting out a quota reset or a transient-error
 * backoff to `waitMs`.
 */
function settleSupervisorRemedies(state: DurableRunState, supervisor: Supervisor, episodeId: string): DurableRunState {
  const applied = supervisor.drainRemedies?.() ?? [];
  if (applied.length === 0) return state;
  let next = state;
  let waited = 0;
  for (const r of applied) {
    const waitedMs = r.waitedMs !== undefined && r.waitedMs > 0 ? Math.ceil(r.waitedMs) : undefined;
    if (waitedMs !== undefined) waited += waitedMs;
    next = recordRemedy(next, {
      at: r.at,
      condition: `supervisor provider ${r.failureClass}`,
      remedy:
        r.remedy === "wait_and_retry"
          ? r.waitBasis === "operator"
            ? `waited ${Math.ceil((waitedMs ?? 0) / 1000)}s (the operator's quotaRetryMs; the provider gave no reset time) and retried the turn`
            : `waited ${Math.ceil((waitedMs ?? 0) / 1000)}s for the provider's reset and retried the turn`
          : r.remedy === "backoff_and_retry"
            ? r.waitBasis === "provider"
              ? `waited ${Math.ceil((waitedMs ?? 0) / 1000)}s for the provider's stated retry time after a transient error and retried the turn`
              : `backed off ${Math.ceil((waitedMs ?? 0) / 1000)}s after a transient provider error and retried the turn`
          : r.remedy === "compact_and_retry"
            ? "compacted the supervisor session and retried the turn"
            : r.remedy === "fresh_session_retry"
              ? "retried the turn once in a fresh supervisor session"
              : r.remedy === "resend_interrupted"
                ? "resent the identical prompt after the provider dropped the reply's output"
                : r.remedy === "model_retry"
                  ? `retried the turn once on the next configured model${r.model !== undefined ? ` ${r.model.provider}/${r.model.modelId}` : ""}`
                  : "re-asked the supervisor once to call exactly one tool",
      detail: boundText(r.message),
      episodeId,
      ...(waitedMs !== undefined ? { waitedMs } : {}),
    });
  }
  if (waited > 0) {
    next = { ...next, budgets: { ...next.budgets, waitMs: Math.max(0, (next.budgets.waitMs ?? 0) - waited) } };
  }
  return { ...next, stateRevision: next.stateRevision + 1 };
}

/**
 * Why a decide() call stopped the run. A classified provider failure names
 * its class and the provider's own message (and why no remedy applied);
 * anything else keeps the generic reason.
 */
function decideFailureStop(err: unknown): { stopReason: string; blocker: string } {
  if (isSupervisorProviderError(err)) {
    const named = `supervisor provider ${err.failureClass}: ${err.providerMessage}`;
    return {
      stopReason: boundText(named),
      blocker: boundText(err.unremedied !== undefined ? `${named} (not remedied: ${err.unremedied})` : named),
    };
  }
  return { stopReason: "supervisor decide failed", blocker: err instanceof Error ? err.message : String(err) };
}

/**
 * §4.3: a `stalled` episode's first turn, when the run's progress mark has
 * moved since the last recovery episode decided anything. Only the episode's
 * first turn qualifies, so a supervisor already working the episode keeps it.
 */
function stalledWithFreshEvidence(state: DurableRunState): boolean {
  if (state.recoveryTrigger?.code !== "stalled") return false;
  if (state.lastEpisodeMark === undefined) return false;
  if (state.supervisorMark?.episodeId !== undefined && state.supervisorMark.episodeId === state.recoveryEpisodeId) return false;
  return progressMark(state) !== state.lastEpisodeMark;
}

/** Most consecutive retries the controller grants one executor, whatever it declares. */
const MAX_EXECUTOR_RETRY_LIMIT = 10;
const EXECUTOR_RETRY_BASE_MS = 1_000;
const EXECUTOR_RETRY_MAX_BACKOFF_MS = 60_000;

function retryKey(job: JobSpec): string {
  return `${job.stageId}:${job.purpose}:${job.executor?.id ?? job.kind}`;
}

function clearRetryCount(state: DurableRunState, job: JobSpec): DurableRunState {
  const key = retryKey(job);
  if (state.executorRetryCounts?.[key] === undefined) return state;
  const { [key]: _cleared, ...rest } = state.executorRetryCounts;
  void _cleared;
  return { ...state, executorRetryCounts: rest };
}

/**
 * §4.3: a failure the executor declared retryable (`retryLimit`) is queued to
 * run again unchanged, waiting the executor's own `retryAfterMs` or an
 * exponential backoff, charged to `waitMs` when the retry is admitted.
 * `exhausted` says why a declared-retryable failure is not retried again.
 */
function scheduleExecutorRetry(
  state: DurableRunState,
  job: JobSpec,
  result: Awaited<ReturnType<Runner["runJob"]>>,
  operationId: string,
  flags: Omit<RetryFlags, "attempt" | "limit">,
): { state?: DurableRunState; exhausted?: string; cleared: DurableRunState } {
  const declared = result.retryLimit;
  if (result.status !== "failed" || result.failureKind !== undefined || declared === undefined || !(declared > 0)) {
    return { cleared: state };
  }
  const limit = Math.min(Math.floor(declared), MAX_EXECUTOR_RETRY_LIMIT);
  const key = retryKey(job);
  const done = state.executorRetryCounts?.[key] ?? 0;
  const cleared = clearRetryCount(state, job);
  if (done >= limit) return { exhausted: `after ${done} retries, the executor's limit`, cleared };
  const attempt = done + 1;
  const executorId = job.executor?.id ?? job.kind;
  const askedFor = state.executorRetryAt?.[executorId];
  const retryAt =
    askedFor ?? new Date(Date.now() + Math.min(EXECUTOR_RETRY_BASE_MS * 2 ** (attempt - 1), EXECUTOR_RETRY_MAX_BACKOFF_MS)).toISOString();
  const waitMs = Math.max(0, Date.parse(retryAt) - Date.now());
  const remaining = state.budgets.waitMs ?? 0;
  if (waitMs > remaining) {
    return {
      exhausted: `retry ${attempt} needs a ${Math.ceil(waitMs / 1000)}s wait; ${Math.floor(remaining / 1000)}s of the run's wait budget remain`,
      cleared,
    };
  }
  const queued = queueRetry(state, job, operationId, { key, attempt, limit, executorId, retryAt, flags });
  return {
    cleared,
    state: recordRemedy(queued, {
      condition: `executor ${executorId} ${result.status} (declared retryable)`,
      remedy: `retry ${attempt} of ${limit} after ${Math.ceil(waitMs / 1000)}s, without a model call`,
      detail: boundText(result.summary),
      ...(state.recoveryEpisodeId !== undefined ? { episodeId: state.recoveryEpisodeId } : {}),
      ...(waitMs > 0 ? { waitedMs: waitMs } : {}),
    }),
  };
}

/** Queue `job` to run again unchanged, no earlier than `retryAt` (charged to `waitMs` when it is admitted). */
function queueRetry(
  state: DurableRunState,
  job: JobSpec,
  operationId: string,
  q: { key: string; attempt: number; limit: number; executorId: string; retryAt?: string; flags: Omit<RetryFlags, "attempt" | "limit"> },
): DurableRunState {
  // A continued agent job that failed with a session of its own became that
  // session's successor; continuing the same predecessor again would fork the
  // chain, so the retry continues the failed attempt's session instead.
  const continuedByFailure =
    job.continueFrom !== undefined && (state.agentSessions ?? []).some((r) => r.operationId === operationId);
  const retryJob: JobSpec = continuedByFailure ? { ...job, continueFrom: operationId } : job;
  return {
    ...state,
    executorRetryCounts: { ...state.executorRetryCounts, [q.key]: q.attempt },
    executorRetry: { job: retryJob, attempt: q.attempt, limit: q.limit, ...q.flags },
    ...(q.retryAt !== undefined ? { executorRetryAt: { ...state.executorRetryAt, [q.executorId]: q.retryAt } } : {}),
  };
}

/**
 * A job that asked for it (`JobSpec.timeoutContinuations`) and ran out of its
 * wall clock after changing the worktree has its own agent session continued
 * (`continueFrom` the timed-out operation) instead of going to recovery: the
 * agent made progress and its transcript holds what is left. At most the
 * job's count (and `MAX_TIMEOUT_CONTINUATIONS`) per attempt: the dispatch the
 * graph or supervisor made and every continuation or retry the controller
 * chained from it (`flags.timeoutChain`) share one allowance, counted in run
 * state under the attempt's operation id, so a later attempt of the same
 * stage gets its own and a resume never resets one. The
 * continuation is queued like a retry: it is admitted through the same
 * budget checks as any dispatch, and continues, not repeats, a correction
 * the timed-out try already counted. `declined` says why an opted-in
 * timeout still goes to recovery.
 */
function continueAfterTimeout(
  state: DurableRunState,
  job: JobSpec,
  result: Awaited<ReturnType<Runner["runJob"]>>,
  operationId: string,
  flags: Omit<RetryFlags, "attempt" | "limit">,
  worktreeChanged: boolean | undefined,
): { state?: DurableRunState; declined?: string } {
  if (result.failureKind !== "timeout" || job.kind !== "agent") return {};
  const allowed = Math.min(job.timeoutContinuations ?? 0, MAX_TIMEOUT_CONTINUATIONS);
  if (!(allowed > 0)) return {};
  const key = flags.timeoutChain ?? operationId;
  const used = state.timeoutContinuations?.[key] ?? 0;
  if (worktreeChanged !== true) {
    return { declined: worktreeChanged === false ? "the timed-out try left the worktree unchanged" : "whether the timed-out try changed the worktree is unknown" };
  }
  if (!(state.agentSessions ?? []).some((r) => r.operationId === operationId)) {
    return { declined: "the executor kept no resumable session while it stopped" };
  }
  if (used >= allowed) {
    return { declined: `the attempt dispatched as ${key} already continued ${used} timed-out ${used === 1 ? "session" : "sessions"}, its limit` };
  }
  const executorId = job.executor?.id ?? job.kind;
  const attempt = used + 1;
  const reason = `continue the agent session of ${operationId}, which ran out of time after changing the worktree (continuation ${attempt} of ${allowed})`;
  return {
    state: recordRemedy(
      {
        ...state,
        timeoutContinuations: { ...state.timeoutContinuations, [key]: attempt },
        executorRetry: { job: { ...job, continueFrom: operationId }, attempt, limit: allowed, ...flags, timeoutChain: key, reason },
      },
      {
        condition: `executor ${executorId} timed out after changing the worktree`,
        remedy: `continuing its agent session (${attempt} of ${allowed}) instead of opening a recovery episode`,
        detail: boundText(result.summary),
        ...(state.recoveryEpisodeId !== undefined ? { episodeId: state.recoveryEpisodeId } : {}),
      },
    ),
  };
}

/** Slack after a stated reset time before the job runs again. */
const QUOTA_RESET_MARGIN_MS = 30_000;
/** Consecutive pauses for one job; a reset that keeps passing without relief is not the environment waiting. */
const QUOTA_PAUSE_LIMIT = 3;
export const QUOTA_STOP_PREFIX = "harness quota exhausted until ";
export const QUOTA_RECONCILE_STOP_REASON = "harness quota hit after possible effects; reconcile before resuming";

/** Opens the instruction of a job continued after a usage limit. */
export const QUOTA_CONTINUATION_NOTE =
  "You hit the harness usage limit partway through this job, and it has since reset. Continue where you stopped: observe the worktree and re-check external state before relying on earlier results.";

type QuotaPause = { state?: DurableRunState; stop?: { stopReason: string; blocker: string }; cleared: DurableRunState };

/**
 * A harness out of usage allowance is a condition of the environment, not
 * something recovery can fix: the executor reports `failureKind: "quota"`,
 * when it renews and whether the failed try may have had effects (as data).
 * After the reset (when the run's remaining `waitMs` covers it) the job:
 * - no effects: runs again unchanged;
 * - possible effects, agent session resumable: continues that session, not
 *   its original assignment;
 * - possible effects, not resumable: one recovery episode (`quota_partial`).
 * Otherwise the run stops retryable and a resume applies the same rule. No
 * supervisor episode is opened for the limit itself.
 */
function pauseForQuota(
  state: DurableRunState,
  job: JobSpec,
  result: Awaited<ReturnType<Runner["runJob"]>>,
  operationId: string,
  flags: Omit<RetryFlags, "attempt" | "limit">,
  canRecover: boolean,
): QuotaPause {
  const key = retryKey(job);
  const done = state.executorRetryCounts?.[key] ?? 0;
  const executorId = job.executor?.id ?? job.kind;
  const resetAt = result.resetAt;
  const stopReason = `${QUOTA_STOP_PREFIX}${resetAt ?? "unknown"}`;
  const clean = (result.effects ?? "unknown") === "none";
  const resumable = !clean && job.kind === "agent" && (state.agentSessions ?? []).some((r) => r.operationId === operationId);
  const continued: JobSpec = { ...job, continueFrom: operationId, instruction: `${QUOTA_CONTINUATION_NOTE}\n\n${job.instruction}` };
  // What a resume must not replay: recorded durably wherever the job cannot be continued.
  const cleared: DurableRunState = {
    ...clearRetryCount(state, job),
    ...(!clean && !resumable
      ? {
          reconciliationRequired: {
            operationId,
            stageId: job.stageId,
            reason: boundText(`executor ${executorId} hit a usage limit after a try that may have had effects: ${result.summary}`),
            since: new Date().toISOString(),
          },
        }
      : {}),
  };
  // A partial effect with no session to continue goes to the supervisor (a run already in recovery returns it to that
  // episode as the settlement); the job is never replayed from its original assignment.
  const recovers = !clean && !resumable && canRecover;
  const partial = `executor ${executorId} hit a usage limit after a try that ${result.effects === "some" ? "had" : "may have had"} effects, and its session cannot be continued: ${result.summary}`;
  const stopWith = (blocker: string): QuotaPause => {
    const base = { stopReason, blocker: boundText(blocker) };
    // A resume applies the same rule to the partial effects, with no wait: the operator resumes when ready.
    if (resumable) {
      const queued = queueRetry(cleared, continued, operationId, { key, attempt: 1, limit: QUOTA_PAUSE_LIMIT, executorId, flags });
      return { cleared, stop: base, state: { ...queued, status: "stopped", ...base } };
    }
    if (recovers) return { cleared, stop: base, state: { ...enterRecovery(cleared, "quota_partial", boundText(partial)), status: "stopped", ...base } };
    return { cleared, stop: base };
  };
  if (!clean && !resumable && !canRecover) {
    return {
      cleared,
      stop: {
        stopReason: QUOTA_RECONCILE_STOP_REASON,
        blocker: boundText(`executor ${executorId} hit a usage limit after a try that may have had effects (reset ${resetAt ?? "unknown"}): ${result.summary}`),
      },
    };
  }
  if (resetAt === undefined) {
    return stopWith(`executor ${executorId} reported a usage limit with no reset time: ${result.summary}`);
  }
  const retryAt = new Date(Date.parse(resetAt) + QUOTA_RESET_MARGIN_MS).toISOString();
  const waitMs = Math.max(0, Date.parse(retryAt) - Date.now());
  const remaining = state.budgets.waitMs ?? 0;
  if (done >= QUOTA_PAUSE_LIMIT || waitMs > remaining) {
    const why =
      done >= QUOTA_PAUSE_LIMIT
        ? `still limited after ${done} waits`
        : `the ${Math.ceil(waitMs / 1000)}s wait exceeds the ${Math.floor(remaining / 1000)}s of waitMs left`;
    return stopWith(`executor ${executorId} usage limit (${why}): ${result.summary}`);
  }
  const remedy = (what: string, next: DurableRunState): DurableRunState =>
    recordRemedy(next, {
      condition: `harness quota (executor ${executorId})`,
      remedy: `waiting ${Math.ceil(waitMs / 1000)}s until the harness quota resets at ${resetAt}, then ${what}, without a model call`,
      detail: boundText(result.summary),
      ...(state.recoveryEpisodeId !== undefined ? { episodeId: state.recoveryEpisodeId } : {}),
      ...(waitMs > 0 ? { waitedMs: waitMs } : {}),
    });
  if (recovers) {
    // The episode starts once the loop has waited out the reset.
    const held = enterRecovery(
      { ...cleared, quotaHold: { until: retryAt }, budgets: { ...cleared.budgets, waitMs: remaining - waitMs } },
      "quota_partial",
      boundText(partial),
    );
    return { cleared, state: remedy("opening one recovery episode (the try's effects are unknown and its session cannot be continued)", held) };
  }
  const queued = queueRetry(state, resumable ? continued : job, operationId, { key, attempt: done + 1, limit: QUOTA_PAUSE_LIMIT, executorId, retryAt, flags });
  return { cleared, state: remedy(resumable ? "continuing the agent session" : "running the job again", queued) };
}

/** Apply a pending operator model switch before the next supervisor prompt. */
async function applyOperatorSwitch(state: DurableRunState, supervisor: Supervisor): Promise<DurableRunState> {
  let pending: PendingSwitchRequest | undefined;
  try {
    pending = await readSwitchRequest(state.stateDir);
  } catch (err) {
    await clearSwitchRequest(state.stateDir);
    return noteOutcome(state, `operator model switch request ignored: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (pending === undefined) return state;
  const { id, ...order } = pending;
  if (state.supervisorMark === undefined) {
    state = markProposal(state, { type: "switch_model", ...order, reason: `operator request: ${order.reason}` });
  }
  const stateDir = state.stateDir;
  state = await applyModelSwitch(state, supervisor, order, "operator", () => clearSwitchRequest(stateDir, id));
  await saveRunState(state);
  return state;
}

async function applyDecision(
  state: DurableRunState,
  decision: GraphDecision,
  deps: LoopDeps,
  signal?: AbortSignal,
): Promise<DurableRunState> {
  // Recovery decisions must not overwrite graph-owned private bookkeeping.
  if (decision.privateState !== undefined && state.mode !== "recovery") {
    state = { ...state, privateState: decision.privateState };
  }

  state = {
    ...state,
    budgets: {
      ...state.budgets,
      decisions: Math.max(0, state.budgets.decisions - 1),
    },
    stateRevision: state.stateRevision + 1,
  };

  const action = decision.action;
  switch (action.type) {
    case "dispatch":
      // Handled by prepareDispatch / applyDispatchResult in the loop so the
      // exec lock is not held across runner.runJob.
      throw new Error("dispatch must be prepared outside applyDecision");
    case "observe":
      return observeWorkspace(state, action.observe);
    case "validate": {
      // A recovery proposal that names no stage means the one it is recovering;
      // a graph-authored action always names its own, so this never masks a
      // real plugin bug — only normal mode's own stopForUndeclaredStage does.
      const stageId = action.validate.stageId || (state.mode === "recovery" ? state.current.stageId : action.validate.stageId);
      const undeclared = stopForUndeclaredStage(state, stageId);
      if (undeclared) return undeclared;
      const result = await admitValidation(state, { ...action.validate, stageId }, deps.validators);
      const settled = settleCorrectionTrial(result.state, stageId, {
        evaluated: result.evaluated,
        accepted: result.accepted,
      });
      return clearOpenAttempt(settled, stageId);
    }
    case "reenter": {
      const stageId = action.reenter.stageId || (state.mode === "recovery" ? state.current.stageId : action.reenter.stageId);
      const undeclared = stopForUndeclaredStage(state, stageId);
      if (undeclared) return undeclared;
      if (state.budgets.corrections <= 0) {
        return {
          ...state,
          status: "stopped",
          stopReason: "corrections budget exhausted",
          blocker: "reenter",
        };
      }
      let next = await invalidateFromStage(state);
      const { workspaceRevision: _wr, ...withoutRev } = next;
      void _wr;
      next = {
        ...withoutRev,
        budgets: {
          ...withoutRev.budgets,
          corrections: withoutRev.budgets.corrections - 1,
        },
        current: { stageId, attempt: nextStageAttempt(state, stageId) },
        stageAttempts: { ...withoutRev.stageAttempts, [stageId]: nextStageAttempt(state, stageId) },
        // Reentry means this stage's execution needs another attempt,
        // regardless of whether anything above actually invalidated — stage
        // selection must dispatch its work again rather than trust an
        // unchanged candidate's still-valid receipts.
        openAttempt: { ...withoutRev.openAttempt, [stageId]: true },
      };
      return bumpGeneration(next, "reenter");
    }
    case "supervise": {
      if (!deps.supervisor) {
        return {
          ...state,
          status: "stopped",
          mode: "recovery",
          stopReason: action.supervise.reason,
          blocker: "no supervisor configured",
        };
      }
      return enterRecovery(
        state,
        "supervise",
        action.supervise.reason,
        citedEvidence(state, action.supervise.evidenceRefs),
      );
    }
    case "return": {
      const outside = returnRefusal(state);
      if (outside !== undefined) return inadmissible(state, { ...outside, detail: action.return.summary });
      const {
        recoveryEpisodeId: _ep,
        recoveryTrigger: _tr,
        stopReason: _sr,
        blocker: _bl,
        stopEvidenceRefs: _se,
        stopClass: _sc,
        stopMark: _sm,
        ...rest
      } = state;
      void _sc;
      void _sm;
      void _ep;
      void _tr;
      void _sr;
      void _bl;
      void _se;
      return {
        ...rest,
        mode: "normal",
        status: "running",
      };
    }
    case "qualify_repair": {
      if (!deps.repair) {
        return inadmissible(state, { precondition: "qualify_repair requires repair hooks", detail: "this controller has no repair hooks configured" });
      }
      // What the supervisor cited anywhere on the proposal reaches the independent reviewer.
      const cited = [...new Set([...(Array.isArray(action.qualify.evidenceRefs) ? action.qualify.evidenceRefs : []), ...(decision.evidence ?? [])])];
      return applyQualifyRepair(state, cited.length > 0 ? { ...action.qualify, evidenceRefs: cited } : action.qualify, {
        ...(deps.supervisor !== undefined ? { supervisor: deps.supervisor } : {}),
        repair: deps.repair,
        validators: deps.validators,
        ...(signal !== undefined ? { signal } : {}),
        ...(deps.openCandidateHost !== undefined ? { openCandidateHost: deps.openCandidateHost } : {}),
      });
    }
    case "activate_repair": {
      if (!deps.repair) {
        return inadmissible(state, { precondition: "activate_repair requires repair hooks", detail: "this controller has no repair hooks configured" });
      }
      const activated = await applyActivateRepair(state, action.activate, {
        repair: deps.repair,
        validators: deps.validators,
        ...(deps.recreateHost !== undefined
          ? { recreateHost: deps.recreateHost }
          : {}),
      });
      // Swap validators in place for the remainder of this loop.
      if (activated.validators !== deps.validators) {
        const next = { ...activated.validators };
        for (const key of Object.keys(deps.validators)) {
          delete deps.validators[key];
        }
        Object.assign(deps.validators, next);
      }
      if (activated.host) {
        await deps.host.close().catch(() => undefined);
        deps.host = activated.host;
      }
      return activated.state;
    }
    case "stop": {
      const complete =
        action.stop.reason === "complete" &&
        state.definition.stages.every((s) =>
          stageRequirementsMet(state, s.id, s.requirementIds),
        );
      // What admitted the stop is what the report shows: recorded evidence and probes of this episode.
      const named = [...(Array.isArray(action.stop.evidenceRefs) ? action.stop.evidenceRefs : []), ...(decision.evidence ?? [])];
      const probed = new Set(state.probeLog?.episodeId === state.recoveryEpisodeId ? state.probeLog?.ids : []);
      const cited = [...new Set([...citedEvidence(state, named), ...named.filter((ref) => probed.has(ref))])];
      const drift = complete ? await deliveryDrift(state) : undefined;
      if (drift !== undefined) {
        return {
          ...state,
          status: "stopped",
          stopReason: "delivery changed after acceptance",
          blocker: drift,
          ...(cited.length > 0 ? { stopEvidenceRefs: cited } : {}),
        };
      }
      return {
        ...state,
        status: complete ? "succeeded" : "stopped",
        stopReason: action.stop.reason,
        blocker: action.stop.blocker,
        ...(cited.length > 0 ? { stopEvidenceRefs: cited } : {}),
        // §8: the graph or supervisor classifies its own stop; unmarked, it is retryable.
        ...(complete ? {} : { stopClass: { by: state.mode === "recovery" ? ("supervisor" as const) : ("graph" as const), retryable: action.stop.retryable !== false, reason: action.stop.reason } }),
      };
    }
    default: {
      const unexpected = action as { type: string };
      return {
        ...state,
        status: "stopped",
        stopReason: `unsupported action in ${state.mode} mode: ${unexpected.type}`,
        blocker: unexpected.type,
      };
    }
  }
}

interface PendingJob {
  job: JobSpec;
  operationId: string;
  generation: number;
  isCorrection: boolean;
  /** Was a graph-authored (not supervisor) correction-eligible work dispatch at admission. */
  graphCorrectionTrial: boolean;
  /** Was a supervisor-authored work dispatch at admission. */
  supervisorWorkDispatch: boolean;
  /** The supervisor originated it without a `hostRepair` grant: the runner confines its writes to the run's scope. */
  confined: boolean;
  /** The supervisor originated it under the `hostRepair` grant: it runs unconfined and is recorded as a host change. */
  hostChange: boolean;
  source?: ExecutorSourceOverride;
  notBefore?: string;
  session?: ExecutorSession;
}

/**
 * A controller retry of a failed dispatch carries the original's correction
 * flags: it is the same attempt run again, not a new correction to charge.
 */
interface RetryFlags {
  attempt: number;
  limit: number;
  graphCorrectionTrial: boolean;
  supervisorWorkDispatch: boolean;
  /** The dispatch reason, when the controller runs the job again for another cause than a declared-retryable failure. */
  reason?: string;
  /**
   * The operation id of the attempt this run belongs to, for a job that may
   * have its timed-out session continued: the continuations and retries
   * chained from one dispatch share its `timeoutContinuations` allowance.
   */
  timeoutChain?: string;
}

async function prepareDispatch(
  state: DurableRunState,
  decision: GraphDecision,
  _deps: LoopDeps,
  retry?: RetryFlags,
): Promise<{ state: DurableRunState; pending?: PendingJob }> {
  const priorPrivateState = state.privateState;
  // Recovery decisions must not overwrite graph-owned private bookkeeping.
  if (decision.privateState !== undefined && state.mode !== "recovery") {
    state = { ...state, privateState: decision.privateState };
  }
  state = {
    ...state,
    budgets: {
      ...state.budgets,
      decisions: Math.max(0, state.budgets.decisions - 1),
    },
    stateRevision: state.stateRevision + 1,
  };

  const rawJob = decision.action.type === "dispatch" ? decision.action.job : undefined;
  if (!rawJob) {
    throw new Error("prepareDispatch requires dispatch action");
  }

  const admitted = dispatchPreconditions(state, rawJob);
  if ("precondition" in admitted) return { state: inadmissible(state, admitted) };
  let job = admitted.job;
  const source = admitted.source;

  // An executor that asked for a wait runs no earlier than that, and the wait spends the run's budget.
  const executorId = job.executor!.id;
  const retryAt = state.executorRetryAt?.[executorId];
  let notBefore: string | undefined;
  if (retryAt !== undefined) {
    const waitMs = Math.max(0, Date.parse(retryAt) - Date.now());
    const remaining = state.budgets.waitMs ?? 0;
    if (waitMs > remaining) {
      return {
        state: {
          ...state,
          status: "stopped",
          stopReason: "wait budget exhausted",
          blocker: `executor ${executorId} asks to wait ${Math.ceil(waitMs / 1000)}s; ${Math.floor(remaining / 1000)}s of the run's wait budget remain`,
        },
      };
    }
    const { [executorId]: _waited, ...otherRetries } = state.executorRetryAt!;
    void _waited;
    state = {
      ...state,
      budgets: { ...state.budgets, waitMs: remaining - waitMs },
      executorRetryAt: otherRetries,
    };
    if (waitMs > 0) notBefore = retryAt;
  }

  if (state.budgets.jobs < jobCost(state, job)) {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "budgets exhausted",
        blocker: "jobs",
      },
    };
  }
  if (job.kind === "agent" && state.budgets.agentInvocations <= 0) {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "budgets exhausted",
        blocker: budgetExhaustionBlocker(state, job.stageId, job.purpose),
      },
    };
  }
  // §4.7: a normal-mode agent dispatch must not spend into the reserve
  // children.ts's own reserveModelCall floor protects (recovery, including a
  // metered supervisor decide() call, may spend down to zero) — refused here,
  // before any pendingDispatch exists, so a denied reservation never reaches
  // applyDispatchResult's fallback charge (which cannot tell "the floor
  // refused this" from "the executor failed before ever trying," and would
  // otherwise spend one of the reserved invocations on a dispatch children.ts
  // never actually let happen).
  if (job.kind === "agent" && state.mode === "normal" && state.budgets.agentInvocations <= (state.budgets.recoveryReserve ?? 0)) {
    return {
      state: enterRecovery(
        state,
        "recovery_budget_reached",
        `agentInvocations (${state.budgets.agentInvocations}) has reached the recovery reserve (${state.budgets.recoveryReserve ?? 0}); normal-mode dispatch stops here so recovery still has budget to act`,
      ),
    };
  }

  // A correction is a work dispatch while its stage's own target requirement
  // is still unresolved — a fact about current requirement state, not about
  // whether a validate call has run: a plugin that recognizes a known defect
  // itself and redispatches without ever asking the controller to validate
  // it is still correcting. The graph's own first-ever attempt at a stage is
  // not a correction (nothing has been tried yet to redo); a supervisor's
  // work dispatch has no such exemption — recovery-mode work is exceptional
  // repair by construction, charged even as the stage's very first attempt
  // (e.g. recovering from a launch failure the graph never got to attempt
  // normal work for).
  const correctionStage = job.purpose === "work" ? state.definition.stages.find((s) => s.id === job.stageId) : undefined;
  const isCorrection =
    retry === undefined &&
    correctionStage !== undefined &&
    !stageRequirementsMet(state, job.stageId, correctionStage.requirementIds) &&
    (state.mode === "recovery" || state.workDispatched?.[job.stageId] === true);
  if (isCorrection && state.budgets.corrections <= 0) {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "corrections budget exhausted",
        blocker: "dispatch correction",
      },
    };
  }
  const graphCorrection = retry?.graphCorrectionTrial ?? (isCorrection && state.mode === "normal");
  const handoff = graphCorrection && retry === undefined ? state.handoff?.[job.stageId] : undefined;
  if (handoff !== undefined) {
    const observed = freshEvidence(state).filter((e) => e.kind === "file" || e.kind === "workspace").map((e) => e.ref);
    // The graph's bookkeeping for a dispatch that never happened is not kept.
    const { privateState: _proposed, ...refused } = state;
    void _proposed;
    const restored = priorPrivateState !== undefined ? { ...refused, privateState: priorPrivateState } : refused;
    return { state: enterRecovery(restored, "correction_limit", handoff.reason, observed.slice(-10)) };
  }
  const supervisorWorkDispatch = retry?.supervisorWorkDispatch ?? (job.purpose === "work" && state.mode === "recovery");
  // Recovery is the supervisor's, so every job dispatched in it is the supervisor's, whatever its purpose.
  const supervisorOriginated = state.mode === "recovery";
  const hostGranted = state.intake.grants.hostRepair === true;
  const hostChange = supervisorOriginated && hostGranted;

  const shapeProblem = jobShapeRefusal(job);
  if (shapeProblem !== undefined) return { state: inadmissible(state, shapeProblem) };

  const operationId = `op-${state.stateRevision}-${randomUUID().slice(0, 8)}`;
  const session = sessionForDispatch(state, job, operationId);
  const next: DurableRunState = {
    ...state,
    outstanding: [
      ...state.outstanding,
      { operationId, kind: "dispatch", stageId: job.stageId },
    ],
    pendingDispatch: {
      operationId,
      generation: state.generation,
      stageId: job.stageId,
      job,
      status: "waiting",
      ...(job.executor !== undefined ? { executor: job.executor } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(session !== undefined ? { session } : {}),
      ...(retry !== undefined ? { retry: { ...retry } } : {}),
    },
    current: { stageId: job.stageId, attempt: state.current.attempt },
    stageAttempts: { ...state.stageAttempts, [job.stageId]: Math.max(state.stageAttempts?.[job.stageId] ?? 0, state.current.attempt) },
    ...(job.purpose === "work" ? { workDispatched: { ...state.workDispatched, [job.stageId]: true as const } } : {}),
    ...(hostChange
      ? {
          hostChanges: [
            ...(state.hostChanges ?? []),
            {
              operationId,
              stageId: job.stageId,
              ...(job.executor !== undefined ? { executorId: job.executor.id } : {}),
              at: new Date().toISOString(),
              reason: "supervisor-originated job ran outside the run's scope under the hostRepair grant",
            },
          ].slice(-MAX_HOST_CHANGE_RECORDS),
        }
      : {}),
  };

  return {
    state: next,
    pending: {
      job,
      operationId,
      generation: state.generation,
      isCorrection,
      graphCorrectionTrial: graphCorrection,
      supervisorWorkDispatch,
      confined: supervisorOriginated && !hostGranted,
      hostChange,
      ...(source !== undefined ? { source } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(session !== undefined ? { session } : {}),
    },
  };
}

/**
 * Dispatch preconditions decided by state alone: the executor pin resolves,
 * the stage is declared (and current, in recovery), the contract and
 * continuation are admissible. Budgets are checked after, as blocking.
 */
function dispatchPreconditions(
  state: DurableRunState,
  rawJob: JobSpec,
): { job: JobSpec; source?: ExecutorSourceOverride } | Inadmissible {
  let job: JobSpec;
  let source: ExecutorSourceOverride | undefined;
  try {
    job = pinJobExecutor(rawJob);
    const resolved = resolveExecutorPin(state, job.executor!);
    if ("error" in resolved) throw new Error(resolved.error);
    job = { ...job, executor: resolved.pin };
    source = resolved.source;
  } catch (err) {
    return { precondition: "executor pin rejected", detail: err instanceof Error ? err.message : String(err) };
  }
  const undeclared = undeclaredStage(state, job.stageId);
  if (undeclared !== undefined) return undeclared;
  const contractProblem = contractAdmissionRefusal(state, job);
  if (contractProblem !== undefined) return { precondition: "contract rejected", detail: contractProblem };
  if (state.mode === "recovery") {
    const refused = recoveryDispatchRefusal(state, job);
    if (refused !== undefined) return { precondition: "recovery dispatch rejected", detail: refused };
  }
  const discontinued = continuationRefusal(state, job);
  if (discontinued !== undefined) return { precondition: "continuation rejected", detail: discontinued };
  return { job, ...(source !== undefined ? { source } : {}) };
}

/** Write scope and checkout shape: mutable work declares non-empty paths; read-only must not. */
function jobShapeRefusal(job: JobSpec): Inadmissible | undefined {
  if (job.readOnly === true) {
    if (job.writeScope !== undefined && job.writeScope.length > 0) {
      return { precondition: "scope rejected", detail: "readOnly jobs must not declare writeScope" };
    }
  } else if (job.purpose === "work") {
    if (!job.writeScope || job.writeScope.length === 0) {
      return { precondition: "scope rejected", detail: "work jobs require a non-empty writeScope" };
    }
  }
  const scopeProblem = job.writeScope !== undefined && job.writeScope.length > 0 ? writeScopeProblem(job.writeScope) : undefined;
  if (scopeProblem !== undefined) return { precondition: "scope rejected", detail: scopeProblem };
  const checkoutProblem = job.checkout !== undefined ? checkoutRefusal(job) : undefined;
  if (checkoutProblem !== undefined) return { precondition: "checkout rejected", detail: checkoutProblem };
  return undefined;
}

/**
 * The controller's pre-admission check for a supervisor proposal: the first
 * precondition that fails, with its current value, or undefined. Pure; the
 * supervisor's tools run it within the turn, and the controller runs it again
 * on whatever decide() returns. Budgets are not preconditions: running out
 * stays blocking at admission.
 */
export function supervisorAdmissionRefusal(
  state: DurableRunState,
  decision: GraphDecision,
  deps: Pick<LoopDeps, "repair">,
  triggerCode: string,
  /** The probes that ran this episode; given only for a supervisor that must ground its claims. */
  probeIds?: ReadonlySet<string>,
): Inadmissible | undefined {
  const repeated = repeatRefusal(state, triggerCode, decision);
  if (repeated !== undefined) return repeated;
  const ungrounded = probeIds !== undefined ? groundingRefusal(state, decision, probeIds) : undefined;
  if (ungrounded !== undefined) return ungrounded;
  const action = decision.action;
  const hasRepair = deps.repair !== undefined;
  switch (action.type) {
    case "dispatch": {
      const admitted = dispatchPreconditions(state, action.job);
      if ("precondition" in admitted) return admitted;
      return jobShapeRefusal(admitted.job);
    }
    case "observe": {
      const escaping = (action.observe.paths ?? []).find((p) => path.isAbsolute(p) || p.split(/[/\\]/).includes(".."));
      return escaping === undefined
        ? undefined
        : { precondition: "observe rejected", detail: `observe paths are relative to the run worktree; ${escaping} is not` };
    }
    case "validate":
      return undeclaredStage(state, action.validate.stageId || state.current.stageId);
    case "reenter":
      return undeclaredStage(state, action.reenter.stageId || state.current.stageId);
    case "return":
      return returnRefusal(state);
    case "qualify_repair":
      return qualifyRefusal(state, action.qualify, hasRepair);
    case "activate_repair":
      return activateRefusal(state, action.activate, hasRepair);
    case "stop":
      return undefined;
    default:
      return { precondition: "unsupported action", detail: `${action.type} is not a supervisor action in ${state.mode} mode` };
  }
}

const execFileAsync = promisify(execFile);

/** Run-scoped temp and cache directory every confined job of the run shares. */
function scratchDirOf(state: DurableRunState): string {
  return path.join(state.stateDir, "scratch");
}

/**
 * Where a supervisor-originated job may write: the run's worktree (and the git
 * administrative directory of that worktree, so git works in it) and the
 * run's scratch directory. Everything else stays read-only for it.
 */
async function jobConfinement(state: DurableRunState): Promise<JobConfinement> {
  const writablePaths = [state.worktreePath];
  const dirs = await worktreeGitDirs(state.intake.repoPath, state.worktreePath);
  if (dirs !== undefined) writablePaths.push(dirs.admin);
  return { scratchDir: scratchDirOf(state), writablePaths, ...(dirs !== undefined ? { readPaths: [dirs.common] } : {}) };
}

/**
 * The administrative directory of the run's linked worktree, derived from the
 * source repository and the worktree path the controller chose, never from the
 * worktree's own `.git` file, which a job can rewrite to point anywhere. It
 * must be `<commonDir>/worktrees/<name>` and name this worktree back.
 */
async function worktreeGitDirs(repoPath: string, worktreePath: string): Promise<{ admin: string; common: string } | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd: repoPath });
    const common = await realpath(path.resolve(repoPath, stdout.trim()));
    const admin = path.join(common, "worktrees", path.basename(worktreePath));
    const owner = (await readFile(path.join(admin, "gitdir"), "utf8")).trim();
    return (await realpath(owner)) === (await realpath(path.join(worktreePath, ".git"))) ? { admin, common } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A supervisor dispatch whose effect would leave the run's scope is
 * inadmissible in-turn unless the operator granted `hostRepair`: the runner
 * says whether it can confine the job and the executor whether its input names
 * a change outside the scope, so the controller reads no executor field. Even
 * without this check the runner confines the job when it runs.
 */
export async function hostScopeRefusal(
  state: DurableRunState,
  decision: GraphDecision,
  runner: Runner,
): Promise<Inadmissible | undefined> {
  if (state.mode !== "recovery" || state.intake.grants.hostRepair === true) return undefined;
  if (decision.action.type !== "dispatch" || runner.checkJob === undefined) return undefined;
  const admitted = dispatchPreconditions(state, decision.action.job);
  if ("precondition" in admitted) return undefined;
  let refused: string | undefined;
  try {
    refused = await runner.checkJob(admitted.job, {
      confinement: await jobConfinement(state),
      ...(admitted.source !== undefined ? { executorSource: admitted.source } : {}),
    });
  } catch {
    return undefined;
  }
  if (refused === undefined) return undefined;
  return {
    precondition: "host change needs the operator",
    detail: `${refused}; the job was not run. Jobs you originate may change only the run's worktree and run-scoped directories. Report this as a blocker with evidence (stop with retryable false) instead of repairing the host: the operator may grant hostRepair.`,
  };
}

/** Most characters of a declared input shape a refusal repeats. */
const MAX_REFUSAL_SHAPE_CHARS = 2_000;

/**
 * A supervisor dispatch whose pinned executor would refuse it (its input
 * fails the executor's own schema, say) is inadmissible in-turn, instead of
 * being admitted and failing inside the executor as executor_failed. The
 * runner asks the executor, so the controller learns no executor field
 * names; a runner that cannot tell admits the job as before, and the
 * executor still checks its input when the job runs.
 */
export async function executorInputRefusal(
  state: DurableRunState,
  decision: GraphDecision,
  runner: Runner,
): Promise<Inadmissible | undefined> {
  if (decision.action.type !== "dispatch" || runner.checkJob === undefined) return undefined;
  const admitted = dispatchPreconditions(state, decision.action.job);
  if ("precondition" in admitted) return undefined;
  let refused: string | undefined;
  try {
    refused = await runner.checkJob(admitted.job, admitted.source !== undefined ? { executorSource: admitted.source } : {});
  } catch {
    return undefined;
  }
  if (refused === undefined) return undefined;
  // The executor's own reason (first failing path and rule), then the shape it
  // declared at intake, passed through as data: the controller reads no field of it.
  const shape = catalogEntry(state, admitted.job.executor!.id)?.inputShape;
  return {
    precondition: "executor input rejected",
    detail: `${refused}; the job was not run: compose its input as ${admitted.job.executor!.id} requires${
      shape !== undefined ? `. Declared input shape: ${describeInputShape(shape, MAX_REFUSAL_SHAPE_CHARS)}` : ""
    }`,
  };
}

/**
 * The supervisor may retry the current stage's work or pick another admitted
 * executor for it, but cannot add steps or run code the run did not pin.
 */
function recoveryDispatchRefusal(state: DurableRunState, job: JobSpec): string | undefined {
  if (state.environmentBlock !== undefined) {
    return `jobs are blocked until a qualified repair updates the environment declaration: ${state.environmentBlock.reason}`;
  }
  if (job.stageId !== state.current.stageId) {
    return `recovery may only dispatch work for the current stage ${state.current.stageId}, not ${job.stageId}`;
  }
  const pins = [job.executor!, ...(job.tools ?? []).map((t) => t.executor)];
  for (const pin of pins) {
    if (!isKindDefaultExecutor(pin.id) && catalogEntry(state, pin.id) === undefined) {
      return state.executorCatalog === undefined
        ? `executor ${pin.id} cannot be used in recovery: the runner did not describe its executors, so none were pinned`
        : `executor ${pin.id} is not pinned for this run`;
    }
  }
  return undefined;
}

/** Only read-only command jobs run in a disposable checkout; agents and tools stay in the worktree. */
function checkoutRefusal(job: JobSpec): string | undefined {
  if (job.kind !== "command" || job.readOnly !== true || job.tools !== undefined || job.continueFrom !== undefined) {
    return "only read-only command jobs without tools or continuations may run in a checkout";
  }
  return checkoutSpecRefusal(job.checkout);
}

/** A job that changed paths it was not allowed to write fails, whatever it reported; the changes stay for recovery to handle. */
function scopeViolation(
  result: Awaited<ReturnType<Runner["runJob"]>>,
  job: JobSpec,
  paths: string[],
): Awaited<ReturnType<Runner["runJob"]>> {
  const shown = paths.slice(0, 10).join(", ") + (paths.length > 10 ? ` (+${paths.length - 10} more)` : "");
  const violation = job.readOnly === true ? `read-only job modified or removed ${shown}` : `changed paths outside the job's write scope: ${shown}`;
  const reported = result.status === "ok" ? "" : `; the executor also reported ${result.status}: ${result.summary}`;
  // The controller found this failure, not the executor: whatever the
  // executor declared retryable, rerunning the job unchanged would repeat it.
  // A usage limit the agent hit after the violation is not what stopped the job either: scope recovery comes first.
  // Nor is a timeout: a session that wrote out of scope is not continued.
  const { retryLimit: _declared, resetAt: _reset, ...kept } = result;
  void _declared;
  void _reset;
  const { failureKind, ...rest } = kept;
  const failure = failureKind === "quota" || failureKind === "timeout" ? {} : failureKind !== undefined ? { failureKind } : {};
  return { ...rest, ...failure, status: "failed", summary: boundText(`${violation}${reported}`) };
}

function applyDispatchResult(
  state: DurableRunState,
  args: {
    job: JobSpec;
    operationId: string;
    generation: number;
    isCorrection: boolean;
    graphCorrectionTrial: boolean;
    supervisorWorkDispatch: boolean;
    result: Awaited<ReturnType<Runner["runJob"]>>;
    /** A supervisor can take over; failures enter recovery instead of stopping. */
    canRecover: boolean;
    /** The workspace change the job ran against, stamped on its evidence. */
    candidateDigest?: string | undefined;
    /** Whether the job changed the worktree; undefined when it could not be observed. */
    worktreeChanged?: boolean | undefined;
  },
): DurableRunState {
  const { job, operationId, generation, isCorrection, result, candidateDigest } = args;
  let next = state;

  if (
    result.runId !== state.runId ||
    result.operationId !== operationId ||
    result.generation !== generation
  ) {
    const { pendingDispatch, ...rest } = next;
    return {
      ...rest,
      ...(pendingDispatch
        ? { pendingDispatch: { ...pendingDispatch, status: "failed" as const } }
        : {}),
      status: "stopped",
      stopReason: "stale job result identity",
      blocker: `${result.runId}/${result.operationId}/g${result.generation}`,
    };
  }

  // Jobs that reserved their actual model requests were charged per request
  // (and counted for their stage then); any other agent job costs one call
  // here, which is its stage's too, so per-stage counts stay complete.
  const settlementCall = job.kind === "agent" && !((next.pendingDispatch?.modelCalls ?? 0) > 0);
  next = {
    ...next,
    ...(settlementCall
      ? { agentInvocationsByStage: { ...next.agentInvocationsByStage, [job.stageId]: (next.agentInvocationsByStage?.[job.stageId] ?? 0) + 1 } }
      : {}),
    budgets: {
      ...next.budgets,
      jobs: next.budgets.jobs - jobCost(next, job),
      agentInvocations: settlementCall ? next.budgets.agentInvocations - 1 : next.budgets.agentInvocations,
      corrections: isCorrection
        ? next.budgets.corrections - 1
        : next.budgets.corrections,
    },
    ...(next.pendingDispatch
      ? { pendingDispatch: { ...next.pendingDispatch, status: "completed" as const } }
      : {}),
    outstanding: next.outstanding.filter((o) => o.operationId !== operationId),
  };
  // A failed attempt's session is worth continuing too: its transcript is the context a retry lacks.
  const session = next.pendingDispatch?.session;
  if (session !== undefined) {
    next = recordAgentSession(next, { job, operationId, generation, session, result });
  }

  const producer: EvidenceProducer = {
    operationId,
    stageId: job.stageId,
    purpose: job.purpose,
    readOnly: job.readOnly === true,
    kind: job.kind,
    ...(job.executor?.id !== undefined ? { executorId: job.executor.id } : {}),
  };

  // A work dispatch settling — success or failure both count — is this
  // attempt's chance at the stage's own work. A graph-authored correction
  // trial awaits the next validate to learn whether it resolved anything; a
  // supervisor-authored one clears the streak immediately, regardless of
  // outcome, handing the stage back to the graph.
  if (args.graphCorrectionTrial) {
    next = { ...next, correctionPendingTrial: { ...next.correctionPendingTrial, [job.stageId]: true as const } };
  }
  if (args.supervisorWorkDispatch) {
    next = settleSupervisorCorrection(next, job.stageId);
  }

  // §4.6: every settlement, success or failure, counts toward its stage's
  // own dispatch-without-acceptance clock — independent of any plugin
  // evidence lookup, unlike the plugin's own round caps.
  next = recordDispatchSettlement(next, job);

  if (result.status !== "ok") {
    next = recordExecutorFailure(recordJobEvidence(next, job, producer, result.evidence, candidateDigest), {
      producer,
      stageId: job.stageId,
      attempt: next.current.attempt,
      executor: job.executor,
      status: result.status,
      summary: result.summary,
      retryAfterMs: result.retryAfterMs,
      failureKind: result.failureKind,
      resetAt: result.resetAt,
    });
    // A run that failed outright (a quota stop, a crash) produced no result to
    // judge: its null output is the executor's failure, handled below, not a
    // contract-invalid answer, so it neither extends nor clears the streak.
    const { pendingDispatch, ...unsettled } = next;
    // Whatever the controller queues next for this job (a continuation, a
    // retry, a resume after a usage limit) belongs to the same attempt and
    // shares its timeout-continuation allowance: the attempt is the dispatch
    // the graph or supervisor made, whose operation id the chain carries.
    const timeoutChain =
      job.kind === "agent" && (job.timeoutContinuations ?? 0) > 0 ? (pendingDispatch?.retry?.timeoutChain ?? operationId) : undefined;
    const retryFlags = {
      graphCorrectionTrial: args.graphCorrectionTrial,
      supervisorWorkDispatch: args.supervisorWorkDispatch,
      ...(timeoutChain !== undefined ? { timeoutChain } : {}),
    };
    if (result.failureKind === "quota") {
      const paused = pauseForQuota(unsettled, job, result, operationId, retryFlags, args.canRecover);
      if (paused.state !== undefined) return paused.state;
      return {
        ...paused.cleared,
        ...(pendingDispatch ? { pendingDispatch: { ...pendingDispatch, status: "failed" as const } } : {}),
        status: "stopped",
        stopReason: paused.stop!.stopReason,
        blocker: paused.stop!.blocker,
      };
    }
    const timedOut = continueAfterTimeout(unsettled, job, result, operationId, retryFlags, args.worktreeChanged);
    if (timedOut.state !== undefined) return timedOut.state;
    const retried = scheduleExecutorRetry(unsettled, job, result, operationId, retryFlags);
    if (retried.state !== undefined) return retried.state;
    const rest = retried.cleared;
    if (args.canRecover) {
      const executorId = job.executor?.id ?? job.kind;
      if (timedOut.declined !== undefined) {
        return enterRecovery(
          rest,
          "executor_failed",
          boundText(`executor ${executorId} ${result.status} (its session was not continued: ${timedOut.declined}): ${result.summary}`),
        );
      }
      if (retried.exhausted !== undefined) {
        return enterRecovery(
          rest,
          "executor_failed",
          boundText(`executor ${executorId} ${result.status} (${retried.exhausted}): ${result.summary}`),
        );
      }
      if (result.failureKind === "contract_violation") {
        return enterRecovery(
          rest,
          "contract_violation",
          boundText(`executor ${executorId} could not produce a result satisfying its declared contract (${job.resultSchema ?? "unknown"}): ${result.summary}`),
        );
      }
      return enterRecovery(rest, "executor_failed", boundText(`executor ${executorId} ${result.status}: ${result.summary}`));
    }
    return {
      ...rest,
      ...(pendingDispatch
        ? { pendingDispatch: { ...pendingDispatch, status: "failed" as const } }
        : {}),
      status: "stopped",
      stopReason: `job failed: ${result.summary}`,
      blocker: result.status,
    };
  }

  next = clearRetryCount(recordJobEvidence(next, job, producer, result.evidence, candidateDigest), job);
  next = recordContractStreak(next, job, result.evidence);

  if (job.purpose === "work") {
    next = { ...next, lastWorkOperationId: operationId };
  }

  // §4.5(b)/§4.6/§4.7: a success can still be the mismatch these exist to
  // catch — a contract-invalid or merely unaccepted result recorded as
  // "ok". Checked only in normal mode: a recovery episode already has the
  // run's attention, and the supervisor's own repeat detection applies there.
  if (state.mode === "normal" && args.canRecover) {
    const { pendingDispatch, ...rest } = next;
    void pendingDispatch;
    const contractMessage = contractViolationStreakMessage(next, job);
    if (contractMessage !== undefined) return enterRecovery(rest, "contract_violation", contractMessage);
    const pacingMessage = stagePacingMessage(next, job);
    if (pacingMessage !== undefined) return enterRecovery(rest, "stalled", pacingMessage);
  }

  const { pendingDispatch: _done, ...cleared } = next;
  void _done;
  return cleared;
}

/** §4.6: per-stage dispatch count since its last receipt, kept whether the dispatch succeeded or failed. */
function recordDispatchSettlement(state: DurableRunState, job: JobSpec): DurableRunState {
  const prior = state.dispatchesSinceReceipt?.[job.stageId];
  return {
    ...state,
    dispatchesSinceReceipt: {
      ...state.dispatchesSinceReceipt,
      [job.stageId]: {
        agent: (prior?.agent ?? 0) + (job.kind === "agent" ? 1 : 0),
        total: (prior?.total ?? 0) + 1,
        since: prior?.since ?? new Date().toISOString(),
      },
    },
  };
}

/** §4.5(b): consecutive contract-invalid agent results for this stage and purpose. */
function recordContractStreak(
  state: DurableRunState,
  job: JobSpec,
  evidence: Awaited<ReturnType<Runner["runJob"]>>["evidence"],
): DurableRunState {
  const outcomes = (evidence ?? [])
    .map((item) => classifyAgentResult(state.definition, job, item))
    .filter((c): c is ContractOutcome => c !== undefined);
  if (outcomes.length === 0) return state;
  const key = `${job.stageId}:${job.purpose}`;
  if (outcomes.some((c) => c.contract.status === "invalid")) {
    const streak = (state.contractViolationStreak?.[key] ?? 0) + 1;
    return { ...state, contractViolationStreak: { ...state.contractViolationStreak, [key]: streak } };
  }
  if (state.contractViolationStreak?.[key] === undefined) return state;
  const { [key]: _cleared, ...rest } = state.contractViolationStreak;
  void _cleared;
  return { ...state, contractViolationStreak: rest };
}

const CONTRACT_VIOLATION_STREAK_LIMIT = 2;

function contractViolationStreakMessage(state: DurableRunState, job: JobSpec): string | undefined {
  const key = `${job.stageId}:${job.purpose}`;
  // Only a job held to a contract can be the one that just broke it; a command
  // or free-form job settling in the same stage and purpose proves nothing.
  if (job.resultSchema === undefined) return undefined;
  const streak = state.contractViolationStreak?.[key];
  if (streak === undefined || streak < CONTRACT_VIOLATION_STREAK_LIMIT) return undefined;
  return boundText(
    `stage ${job.stageId}: ${streak} consecutive contract-invalid results for purpose ${job.purpose} (contract ${job.resultSchema})`,
  );
}

const STAGE_BUDGET_SHARE = 0.5;

/** §4.7 pacing: a stage spending more than its share of the run's whole agent budget with nothing accepted, while budget remains to act on it. */
function stagePacingMessage(state: DurableRunState, job: JobSpec): string | undefined {
  // The run's agent budget as it stands — used plus left, so an operator's
  // raise counts — not the intake copy it started with.
  const total = budgetGranted(state, "agentInvocations") ?? state.intake.budgets.agentInvocations;
  const spent = state.agentInvocationsByStage?.[job.stageId] ?? 0;
  if (total <= 0 || spent <= total * STAGE_BUDGET_SHARE) return undefined;
  const receipts = state.receipts.filter((r) => r.stageId === job.stageId && r.valid).length;
  return boundText(
    `stage ${job.stageId} has spent ${spent} of the run's ${total} agent invocations (over ${Math.round(STAGE_BUDGET_SHARE * 100)}%) with ${receipts} receipts`,
  );
}

/** A route naming a step outside the pinned definition stops the run instead of adding it. */
/**
 * Reentry's openAttempt has done its job once the stage is actually
 * re-validated — accepted or rejected both count — not merely once its work
 * dispatch settles. Clearing it earlier, at dispatch settlement, leaves a gap
 * where a stale receipt (not yet invalidated — invalidation is lazy, inside
 * admitValidation) still reads as valid and openAttempt no longer forces the
 * stage open, so stage-selection skips straight past freshly rewritten work
 * to a later stage.
 */
function clearOpenAttempt(state: DurableRunState, stageId: string): DurableRunState {
  if (state.openAttempt?.[stageId] === undefined) return state;
  const { [stageId]: _cleared, ...rest } = state.openAttempt;
  void _cleared;
  return { ...state, openAttempt: rest };
}

function undeclaredStage(state: DurableRunState, stageId: string): Inadmissible | undefined {
  if (state.definition.stages.some((s) => s.id === stageId)) return undefined;
  return {
    precondition: "undeclared stage",
    detail: `stageId ${stageId} is not in the pinned graph definition; stages are ${state.definition.stages.map((s) => s.id).join(", ")}`,
  };
}

function stopForUndeclaredStage(state: DurableRunState, stageId: string): DurableRunState | undefined {
  const undeclared = undeclaredStage(state, stageId);
  return undeclared === undefined ? undefined : inadmissible(state, undeclared);
}

/**
 * §4.4: a job naming a contract its own plugin did not declare is refused
 * before it runs, and so is one dispatched for a stage whose requirement
 * consumes that contract when the job's purpose/readOnly flags are not ones
 * the controller may trust to self-report that contract's evidenceKind (the
 * same gate `selfReportedKind` applies after the fact, applied here first).
 * Every name compared here is one the plugin itself declared.
 */
function contractAdmissionRefusal(state: DurableRunState, job: JobSpec): string | undefined {
  if (job.resultSchema === undefined) return undefined;
  const contract = state.definition.resultContracts?.find((c) => c.name === job.resultSchema);
  if (contract === undefined) {
    return `job names ${job.resultSchema}, which the plugin did not declare`;
  }
  const stage = state.definition.stages.find((s) => s.id === job.stageId);
  const consuming = stage?.requirementIds
    .map((id) => state.definition.requirements.find((r) => r.id === id))
    .find((r) => r?.evidenceSchema === contract.name);
  if (consuming !== undefined && selfReportedKind(job, contract.evidenceKind) !== undefined) {
    return `stage ${job.stageId}'s requirement ${consuming.id} consumes ${contract.name} (kind ${JSON.stringify(contract.evidenceKind)}), which this job (purpose ${JSON.stringify(job.purpose)}, readOnly ${job.readOnly === true}) may not produce`;
  }
  return undefined;
}

/** What spent the stage's share of the run's agent budget, for a budget-exhaustion stop. */
function budgetExhaustionBlocker(state: DurableRunState, stageId: string, purpose?: string): string {
  const spent = state.agentInvocationsByStage?.[stageId] ?? 0;
  const total = budgetGranted(state, "agentInvocations") ?? state.intake.budgets.agentInvocations;
  const dispatches = state.dispatchesSinceReceipt?.[stageId]?.agent ?? 0;
  const receipts = state.receipts.filter((r) => r.stageId === stageId && r.valid).length;
  const kind = purpose !== undefined ? `${purpose} dispatches` : "agent dispatches";
  return `agentInvocations exhausted: stage ${stageId} spent ${spent} of ${total} across ${dispatches} ${kind}, ${receipts} receipts`;
}

const MAX_TRIGGER_CHARS = 500;

export function boundText(text: string): string {
  return text.length <= MAX_TRIGGER_CHARS ? text : `${text.slice(0, MAX_TRIGGER_CHARS - 1)}…`;
}

type EvidenceItem = NonNullable<Awaited<ReturnType<Runner["runJob"]>>["evidence"]>[number];

export interface ContractOutcome {
  kind: EvidenceRecord["kind"];
  payload: unknown;
  contract: NonNullable<EvidenceRecord["contract"]>;
}

/**
 * When `job.resultSchema` names a contract its own plugin declared in
 * `definition.resultContracts` and `item` carries a coding-agent result,
 * validates `codingAgent.output` against the contract's schema and (when the
 * contract lists reference paths and the job supplied `knownReferences`) its
 * ids, and returns the recordable kind, payload with any §4.3 repairs
 * applied, and the outcome to show on the record. Returns undefined for
 * every other evidence item, which records exactly as it always has: the
 * controller only ever compares strings the plugin itself handed it.
 *
 * Exported so L0's static check (§3.1) can classify a scenario's own scripted
 * replies exactly this way, not a second, hand-maintained copy that could
 * silently drift from what a real dispatch would actually record.
 */
export function classifyAgentResult(definition: GraphDefinition, job: JobSpec, item: EvidenceItem): ContractOutcome | undefined {
  if (job.resultSchema === undefined) return undefined;
  const contract = definition.resultContracts?.find((c) => c.name === job.resultSchema);
  if (contract === undefined) return undefined;
  const payload = item.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const codingAgent = (payload as Record<string, unknown>).codingAgent;
  if (codingAgent === null || typeof codingAgent !== "object" || Array.isArray(codingAgent)) return undefined;
  const agent = codingAgent as Record<string, unknown>;
  let value = agent.output;
  let problems = validateResultShape(value, contract.schema);
  let repairs: string[] = [];
  if (problems.length === 0 && contract.references !== undefined && job.knownReferences !== undefined) {
    const checked = checkReferences(value, contract.references, job.knownReferences);
    problems = checked.problems;
    repairs = checked.repairs;
    value = checked.value;
  }
  const status: "valid" | "invalid" | "repaired" = problems.length > 0 ? "invalid" : repairs.length > 0 ? "repaired" : "valid";
  // A valid/repaired "review" result flattens to the validated output itself
  // (the shape a review parser has always read a payload as, following the
  // one precedent this generalises); every other kind keeps the executor's
  // own wrapper intact (what agentRuns-style lookups have always read,
  // unrelated to this run's declared contracts) with any §4.3 repair applied
  // to its output. An invalid result always keeps the wrapper, so nothing is
  // lost even though it cannot satisfy anything.
  const flatten = status !== "invalid" && contract.evidenceKind === "review";
  return {
    kind: status === "invalid" ? "other" : contract.evidenceKind,
    payload: flatten ? value : { ...(payload as Record<string, unknown>), codingAgent: { ...agent, output: value } },
    contract: { name: contract.name, status, problems, ...(repairs.length > 0 ? { repairs } : {}) },
  };
}

function recordJobEvidence(
  next: DurableRunState,
  job: JobSpec,
  producer: EvidenceProducer,
  evidence: Awaited<ReturnType<Runner["runJob"]>>["evidence"],
  candidateDigest?: string,
): DurableRunState {
  if (evidence) {
    const added: EvidenceRecord[] = [];
    for (const item of evidence) {
      const ref = newEvidenceRef(next);
      const classified = classifyAgentResult(next.definition, job, item);
      const claimed = classified === undefined ? selfReportedKind(job, item.kind) : undefined;
      const record: EvidenceRecord = {
        ref,
        kind: classified !== undefined ? classified.kind : claimed === undefined ? item.kind : "other",
        generation: next.generation,
        ...(candidateDigest !== undefined ? { candidateDigest } : {}),
        ...(job.resultSchema !== undefined ? { resultSchema: job.resultSchema } : {}),
        ...(classified !== undefined ? { contract: classified.contract } : {}),
      };
      record.payload = attachProducer(
        classified !== undefined
          ? classified.payload
          : claimed === undefined
            ? item.payload
            : { selfReported: claimed, claim: item.payload ?? null },
        producer,
      );
      if (item.fingerprint !== undefined) {
        record.fingerprint = item.fingerprint;
      }
      added.push(record);
    }
    next = {
      ...next,
      evidence: [...next.evidence, ...added],
      evidenceSeq: next.evidenceSeq,
      stateRevision: next.stateRevision + 1,
    };
  }
  return next;
}

/**
 * Validation evidence an agent reports about its own work is only a claim.
 * Command results come from command executors (including an agent's tool
 * calls), file and workspace evidence from controller Observe, and review
 * verdicts from read-only review jobs. Returns the claimed kind to record
 * as `other`, or undefined when the job may produce that kind.
 */
function selfReportedKind(job: JobSpec, kind: EvidenceRecord["kind"]): EvidenceRecord["kind"] | undefined {
  if (job.kind !== "agent") return undefined;
  if (kind === "command" || kind === "file" || kind === "workspace") return kind;
  if (kind === "review" && !(job.purpose === "review" && job.readOnly === true)) return kind;
  return undefined;
}

function attachProducer(payload: unknown, producer: EvidenceProducer): unknown {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), producer };
  }
  return { value: payload, producer };
}

async function observeWorkspace(
  state: DurableRunState,
  spec: ObserveSpec,
): Promise<DurableRunState> {
  const added: EvidenceRecord[] = [];
  const digest = await liveCandidateDigest(state);
  let next = withCandidateDigest(state, digest);
  const stamp = digest !== undefined ? { candidateDigest: digest } : {};
  let workspaceFp: string | undefined;

  for (const rel of spec.paths ?? []) {
    let bytes: string | undefined;
    try {
      bytes = await readWorktreeFile(state.worktreePath, rel);
    } catch (err) {
      return inadmissible(state, { precondition: "observe rejected", detail: err instanceof Error ? err.message : String(err) });
    }
    const ref = newEvidenceRef(next);
    added.push({
      ref,
      kind: "file",
      generation: next.generation,
      payload: { path: rel, bytes: bytes ?? "" },
      fingerprint: bytes === undefined ? "missing" : hash(bytes),
      ...stamp,
    });
  }

  if (spec.includeWorkspaceManifest) {
    const changedPaths = await workspaceChangeManifest(state.worktreePath);
    workspaceFp = hash(JSON.stringify(changedPaths));
    const ref = newEvidenceRef(next);
    added.push({
      ref,
      kind: "workspace",
      generation: next.generation,
      payload: { changedPaths },
      fingerprint: workspaceFp,
      ...stamp,
    });
  }

  const out: DurableRunState = {
    ...next,
    evidence: [...next.evidence, ...added],
    evidenceSeq: next.evidenceSeq,
    stateRevision: next.stateRevision + 1,
  };
  if (workspaceFp !== undefined) {
    out.workspaceRevision = workspaceFp;
  }
  return out;
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function initialState(args: {
  runId: string;
  intake: IntakePin;
  definition: GraphDefinition;
  worktreePath: string;
  worktreeBranch: string;
  stateRoot: string;
  sourceDirtyBefore: string[];
}): DurableRunState {
  const runId = assertSafeRunId(args.runId);
  const stateDir = path.join(args.stateRoot, runId);
  const artifactDir = path.join(stateDir, "artifacts");
  const firstStage = args.definition.stages[0];
  if (!firstStage) {
    throw new Error("graph definition has no stages");
  }
  const activeVersion = `${args.intake.bundle.graphId}@${args.intake.bundle.version}`;
  return {
    runId,
    status: "running",
    generation: 1,
    stateRevision: 0,
    activeVersion,
    mode: "normal",
    current: { stageId: firstStage.id, attempt: 1 },
    receipts: [],
    evidence: [],
    outstanding: [],
    definition: args.definition,
    validatorBindings: structuredClone(args.definition.defaultValidators),
    budgets: { ...args.intake.budgets },
    budgetUsage: freshBudgetUsage(args.intake.budgets),
    intake: args.intake,
    worktreePath: args.worktreePath,
    worktreeBranch: args.worktreeBranch,
    artifactDir,
    stateDir,
    sourceDirtyBefore: args.sourceDirtyBefore,
    evidenceSeq: 0,
    receiptSeq: 0,
    versionHistory: [
      {
        activeVersion,
        generation: 1,
        reason: "intake",
        at: new Date().toISOString(),
      },
    ],
  };
}

export async function ensureArtifactDir(state: DurableRunState): Promise<void> {
  await mkdir(state.artifactDir, { recursive: true });
  await mkdir(state.stateDir, { recursive: true });
}

/** Exported for restart tests: bump generation so prior evidence is stale. */
export { bumpGeneration } from "./generation.js";

export { freshEvidence, earliestIncompleteStage };
export { candidateEvidence } from "./admit.js";
