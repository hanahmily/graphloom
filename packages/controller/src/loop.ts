import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
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
  pinJobExecutor,
  writeScopeProblem,
  type CheckoutSpec,
  type EnvironmentDeclaration,
} from "@graphloom/sdk";
import type { ExecutorSourceOverride, Runner } from "@graphloom/runner";
import type { PluginHost } from "@graphloom/plugin-host";
import {
  isModelSwitchRequest,
  type RecoveryTrigger,
  type Supervisor,
  type SupervisorProposal,
} from "@graphloom/supervisor";
import { markProposal, noteOutcome, settleProposal } from "./settlement.js";
import {
  applyModelSwitch,
  clearSwitchRequest,
  readBinding,
  readSwitchRequest,
  type PendingSwitchRequest,
} from "./supervisor-switch.js";
import { catalogEntry, isKindDefaultExecutor, resolveExecutorPin } from "./executor-catalog.js";
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
import { citedEvidence, loadRunState, type DurableRunState, saveRunState } from "./state.js";
import { bumpGeneration } from "./generation.js";
import { clearResolvedTrials, correctionHandoff, countCorrectionTrial, noteGraphDecision } from "./escalation.js";
import {
  applyActivateRepair,
  applyQualifyRepair,
  type RecreateHostFn,
  type RepairDeps,
} from "./repair-lifecycle.js";
import {
  changedPaths,
  pathsOutsideWriteScope,
  readWorktreeFile,
  workspaceChangeManifest,
  worktreeChangeFingerprints,
} from "./worktree.js";
import { clearCheckouts, runInCheckout } from "./checkout.js";
import { checkEnvironment, declaresEnvironment, type EnvironmentOutcome } from "./environment.js";

const MAX_STEPS = 64;

export interface LoopDeps {
  /** Plugin decisions go through the host seam (in-process scripted or child). */
  host: PluginHost;
  runner: Runner;
  validators: Record<string, AdmissionValidator>;
  /** Optional recovery decision source; required to continue past Supervise / host failure. */
  supervisor?: Supervisor;
  /** Qualified repair patch/review hooks (same supervisor session for patches). */
  repair?: RepairDeps;
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
  } finally {
    if (timing.clock !== undefined) {
      // Also on a throw: the time spent must not be given back on resume.
      const recorded = await recordActiveTime(final ?? state, timing.clock).catch(() => undefined);
      if (final !== undefined && recorded !== undefined) final = recorded;
      await timing.clock.close();
    }
    await clearOwnerClaim(state.stateDir);
  }
  await wipeAgentSessions(final);
  return final;
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
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (
      state.status === "running" &&
      state.mode === "normal" &&
      environmentReadyFor !== state.activeVersion &&
      declaresEnvironment(state.definition.environment)
    ) {
      state = await preflightEnvironment(state, deps);
      if (state.status !== "running") return state;
      if (state.mode === "normal") environmentReadyFor = state.activeVersion;
      continue;
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

      let decision: GraphDecision;
      let priorNoProgress = state.noProgress;
      if (state.mode === "recovery") {
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

        const view = toRunView(state);
        const lastSettlement = settleProposal(state);
        const abort = new AbortController();
        const stopWatch = watchForStop(state.stateDir, deps, abort);
        let decided: SupervisorProposal | undefined;
        let decideError: unknown;
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
            ...(lastSettlement !== undefined ? { lastSettlement } : {}),
            ...(metered ? { maxProviderCalls: state.budgets.agentInvocations } : {}),
          });
          decided = isModelSwitchRequest(proposal) ? proposal : assertGraphDecision(proposal);
        } catch (err) {
          decideError = err;
        } finally {
          stopWatch();
          state = settleSupervisorUsage(state, supervisor);
          const binding = readBinding(supervisor);
          if (binding) {
            state = { ...state, supervisorBinding: binding };
          }
        }
        if (abort.signal.aborted || (await stopRequested(deps))) {
          state = {
            ...state,
            status: "stopped",
            ...stopCause(deps),
          };
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: true as const, state };
        }
        if (decideError !== undefined || decided === undefined) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "supervisor decide failed",
            blocker:
              decideError instanceof Error
                ? decideError.message
                : String(decideError),
          };
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: true as const, state };
        }
        state = markProposal(state, decided);
        if (isModelSwitchRequest(decided)) {
          state = await applyModelSwitch(state, supervisor, decided, "supervisor");
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: false as const, state };
        }
        decision = decided;
      } else {
        const view = toRunView(state);
        const advanced = await deps.host.advance(
          {
            runId: state.runId,
            operationId: `adv-${state.stateRevision}-${step}`,
            expectedStateRevision: state.stateRevision,
          },
          view,
        );
        if (!advanced.ok) {
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

      // The callback that proposed this decision may have used up the time left.
      if (activeTimeExhausted(deps)) {
        state = { ...chargeActiveTime(state, deps), status: "stopped", ...stopCause(deps) };
        await saveRunState(state);
        syncRevision(deps, state);
        return { done: true as const, state };
      }

      if (decision.action.type === "dispatch") {
        const prepared = await prepareDispatch(state, decision, deps);
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
      const { job, operationId, generation, isCorrection, source, notBefore, session } = turn.pendingJob;
      const abort = new AbortController();
      const stopWatch = watchForStop(state.stateDir, deps, abort);
      let result: Awaited<ReturnType<Runner["runJob"]>>;
      let children: ReturnType<typeof createChildPort> | undefined;
      let before: Map<string, string> | undefined;
      let checkedDigest: string | undefined;
      let staleIdentity: string | undefined;
      try {
        if (notBefore !== undefined) await sleepUntil(notBefore, abort.signal);
        const unchanged = abort.signal.aborted ? undefined : await worktreeChangeFingerprints(state.worktreePath);
        if (!abort.signal.aborted && !(await startDispatch(state, operationId, deps))) abort.abort();
        if (abort.signal.aborted) {
          result = { status: "failed", summary: "executor cancelled before start", runId: state.runId, operationId, generation };
        } else {
          before = unchanged;
          children =
            job.kind === "agent" || job.tools !== undefined
              ? createChildPort(
                  { job, operationId, generation },
                  {
                    stateDir: state.stateDir,
                    runner: deps.runner,
                    shouldStop: () => stopRequested(deps),
                    signal: abort.signal,
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
            result = await deps.runner.runJob(job, {
              runId: state.runId,
              operationId,
              generation,
              worktreePath: state.worktreePath,
              artifactDir: state.artifactDir,
              signal: abort.signal,
              ...(children !== undefined ? { children } : {}),
              ...(source !== undefined ? { executorSource: source } : {}),
              ...(session !== undefined ? { session } : {}),
            });
          }
        }
      } finally {
        // A parent that stopped, timed out, or returned early can leave a child running.
        await children?.close();
        stopWatch();
      }
      // Executors may run unconfined, so scope is checked against what actually changed.
      const outOfScope =
        before !== undefined
          ? pathsOutsideWriteScope(changedPaths(before, await worktreeChangeFingerprints(state.worktreePath)), job)
          : [];
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
          result: outOfScope.length > 0 ? scopeViolation(result, job, outOfScope) : result,
          canRecover: deps.supervisor !== undefined,
          candidateDigest: checkedDigest ?? afterDigest,
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

  state = await withRunLock(state.stateDir, async () => {
    state = {
      ...state,
      status: "stopped",
      stopReason: "step limit",
      blocker: `exceeded ${MAX_STEPS} controller steps`,
    };
    await saveRunState(state);
    return state;
  });
  return state;
}

const STOP_POLL_MS = 200;

/** Resolve at `until`, or as soon as the run stops. */
function sleepUntil(until: string, signal: AbortSignal): Promise<void> {
  const ms = Date.parse(until) - Date.now();
  if (!(ms > 0) || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

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

function withCandidateDigest(state: DurableRunState, digest: string | undefined): DurableRunState {
  if (digest === undefined) {
    const { candidateDigest: _dropped, ...rest } = state;
    void _dropped;
    return rest;
  }
  return { ...state, candidateDigest: digest };
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
    deadline = setTimeout(() => armDeadline(clock), left + 1);
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
      const undeclared = stopForUndeclaredStage(state, action.validate.stageId);
      if (undeclared) return undeclared;
      const result = await admitValidation(state, action.validate, deps.validators);
      return clearResolvedTrials(result.state);
    }
    case "reenter": {
      const undeclared = stopForUndeclaredStage(state, action.reenter.stageId);
      if (undeclared) return undeclared;
      if (state.budgets.corrections <= 0) {
        return {
          ...state,
          status: "stopped",
          stopReason: "corrections budget exhausted",
          blocker: "reenter",
        };
      }
      let next = invalidateFromStage(state, action.reenter.stageId, state.definition);
      const { workspaceRevision: _wr, ...withoutRev } = next;
      void _wr;
      next = {
        ...withoutRev,
        budgets: {
          ...withoutRev.budgets,
          corrections: withoutRev.budgets.corrections - 1,
        },
        current: {
          stageId: action.reenter.stageId,
          attempt:
            state.current.stageId === action.reenter.stageId
              ? state.current.attempt + 1
              : 1,
        },
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
      if (state.mode !== "recovery") {
        return {
          ...state,
          status: "stopped",
          stopReason: "return outside recovery",
          blocker: action.return.summary,
        };
      }
      const {
        recoveryEpisodeId: _ep,
        recoveryTrigger: _tr,
        stopReason: _sr,
        blocker: _bl,
        stopEvidenceRefs: _se,
        ...rest
      } = state;
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
        return {
          ...state,
          status: "stopped",
          stopReason: "qualify_repair requires repair hooks",
          blocker: action.qualify.reason,
        };
      }
      return applyQualifyRepair(state, action.qualify, {
        ...(deps.supervisor !== undefined ? { supervisor: deps.supervisor } : {}),
        repair: deps.repair,
        validators: deps.validators,
        ...(signal !== undefined ? { signal } : {}),
        ...(deps.openCandidateHost !== undefined ? { openCandidateHost: deps.openCandidateHost } : {}),
      });
    }
    case "activate_repair": {
      if (!deps.repair) {
        return {
          ...state,
          status: "stopped",
          stopReason: "activate_repair requires repair hooks",
          blocker: action.activate.reason,
        };
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
      const cited = citedEvidence(state, action.stop.evidenceRefs);
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
  source?: ExecutorSourceOverride;
  notBefore?: string;
  session?: ExecutorSession;
}

async function prepareDispatch(
  state: DurableRunState,
  decision: GraphDecision,
  _deps: LoopDeps,
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

  let job: JobSpec;
  let source: ExecutorSourceOverride | undefined;
  try {
    job = pinJobExecutor(rawJob);
    const resolved = resolveExecutorPin(state, job.executor!);
    if ("error" in resolved) throw new Error(resolved.error);
    job = { ...job, executor: resolved.pin };
    source = resolved.source;
  } catch (err) {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "executor pin rejected",
        blocker: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const undeclared = stopForUndeclaredStage(state, job.stageId);
  if (undeclared) return { state: undeclared };

  if (state.mode === "recovery") {
    const refused = recoveryDispatchRefusal(state, job);
    if (refused !== undefined) {
      return {
        state: { ...state, status: "stopped", stopReason: "recovery dispatch rejected", blocker: refused },
      };
    }
  }

  const discontinued = continuationRefusal(state, job);
  if (discontinued !== undefined) {
    return { state: { ...state, status: "stopped", stopReason: "continuation rejected", blocker: discontinued } };
  }

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
        blocker: "agentInvocations",
      },
    };
  }

  const isCorrection =
    job.purpose === "work" && (state.mode === "recovery" || state.current.attempt > 1 || redoesStageWork(state, job.stageId));
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
  const graphCorrection = isCorrection && state.mode === "normal";
  const handoff = graphCorrection ? correctionHandoff(state, job.stageId) : undefined;
  if (handoff !== undefined) {
    const observed = freshEvidence(state).filter((e) => e.kind === "file" || e.kind === "workspace").map((e) => e.ref);
    // The graph's bookkeeping for a dispatch that never happened is not kept.
    const { privateState: _proposed, ...refused } = state;
    void _proposed;
    const restored = priorPrivateState !== undefined ? { ...refused, privateState: priorPrivateState } : refused;
    return { state: enterRecovery(restored, "correction_limit", handoff, observed.slice(-10)) };
  }

  // Write scope: mutable work must declare non-empty paths; read-only must not.
  if (job.readOnly === true) {
    if (job.writeScope !== undefined && job.writeScope.length > 0) {
      return {
        state: {
          ...state,
          status: "stopped",
          stopReason: "scope rejected",
          blocker: "readOnly jobs must not declare writeScope",
        },
      };
    }
  } else if (job.purpose === "work") {
    if (!job.writeScope || job.writeScope.length === 0) {
      return {
        state: {
          ...state,
          status: "stopped",
          stopReason: "scope rejected",
          blocker: "work jobs require a non-empty writeScope",
        },
      };
    }
  }
  const scopeProblem = job.writeScope !== undefined && job.writeScope.length > 0 ? writeScopeProblem(job.writeScope) : undefined;
  if (scopeProblem !== undefined) {
    return { state: { ...state, status: "stopped", stopReason: "scope rejected", blocker: scopeProblem } };
  }
  const checkoutProblem = job.checkout !== undefined ? checkoutRefusal(job) : undefined;
  if (checkoutProblem !== undefined) {
    return { state: { ...state, status: "stopped", stopReason: "checkout rejected", blocker: checkoutProblem } };
  }

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
    },
    current: { stageId: job.stageId, attempt: state.current.attempt },
    ...(job.purpose === "work"
      ? { workDispatchEvidence: { ...state.workDispatchEvidence, [job.stageId]: state.evidence.length } }
      : {}),
    ...(graphCorrection ? { correctionTrials: countCorrectionTrial(state, job.stageId) } : {}),
  };

  return {
    state: next,
    pending: {
      job,
      operationId,
      generation: state.generation,
      isCorrection,
      ...(source !== undefined ? { source } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(session !== undefined ? { session } : {}),
    },
  };
}

/**
 * Whether a work dispatch for `stageId` follows fresh observations of that
 * stage's own earlier work. Observations left by an earlier, accepted stage do
 * not make the next stage's first job a correction.
 */
function redoesStageWork(state: DurableRunState, stageId: string): boolean {
  const observed = (e: EvidenceRecord) => (e.kind === "file" || e.kind === "workspace") && e.generation === state.generation;
  if (state.workDispatchEvidence === undefined) {
    // State written before work dispatches were recorded: keep the rule it was charged under.
    return state.lastWorkOperationId !== undefined && state.evidence.some(observed);
  }
  const since = state.workDispatchEvidence[stageId];
  return since !== undefined && state.evidence.slice(since).some(observed);
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
  const checkout = job.checkout as unknown;
  if (job.kind !== "command" || job.readOnly !== true || job.tools !== undefined || job.continueFrom !== undefined) {
    return "only read-only command jobs without tools or continuations may run in a checkout";
  }
  if (typeof checkout !== "object" || checkout === null) return "checkout must be an object";
  const spec = checkout as { from?: unknown; paths?: unknown };
  if (spec.from === "candidate") return spec.paths === undefined ? undefined : "a candidate checkout takes no paths";
  if (spec.from !== "base") return `checkout.from must be "candidate" or "base"`;
  if (!Array.isArray(spec.paths) || spec.paths.length === 0 || !spec.paths.every((p) => typeof p === "string")) {
    return "a base checkout must list the changed paths to apply";
  }
  const problem = writeScopeProblem(spec.paths as string[]);
  return problem === undefined ? undefined : `checkout paths: ${problem}`;
}

/** A job that changed paths it was not allowed to write fails, whatever it reported; the changes stay for recovery to handle. */
function scopeViolation(
  result: Awaited<ReturnType<Runner["runJob"]>>,
  job: JobSpec,
  paths: string[],
): Awaited<ReturnType<Runner["runJob"]>> {
  const shown = paths.slice(0, 10).join(", ") + (paths.length > 10 ? ` (+${paths.length - 10} more)` : "");
  const violation = job.readOnly === true ? `read-only job changed ${shown}` : `changed paths outside the job's write scope: ${shown}`;
  const reported = result.status === "ok" ? "" : `; the executor also reported ${result.status}: ${result.summary}`;
  return { ...result, status: "failed", summary: boundText(`${violation}${reported}`) };
}

function applyDispatchResult(
  state: DurableRunState,
  args: {
    job: JobSpec;
    operationId: string;
    generation: number;
    isCorrection: boolean;
    result: Awaited<ReturnType<Runner["runJob"]>>;
    /** A supervisor can take over; failures enter recovery instead of stopping. */
    canRecover: boolean;
    /** The workspace change the job ran against, stamped on its evidence. */
    candidateDigest?: string | undefined;
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

  next = {
    ...next,
    budgets: {
      ...next.budgets,
      jobs: next.budgets.jobs - jobCost(next, job),
      // Jobs that reserved their actual model requests were charged per request.
      agentInvocations:
        job.kind === "agent" && !((next.pendingDispatch?.modelCalls ?? 0) > 0)
          ? next.budgets.agentInvocations - 1
          : next.budgets.agentInvocations,
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

  if (result.status !== "ok") {
    next = recordExecutorFailure(recordJobEvidence(next, job, producer, result.evidence, candidateDigest), {
      producer,
      stageId: job.stageId,
      attempt: next.current.attempt,
      executor: job.executor,
      status: result.status,
      summary: result.summary,
      retryAfterMs: result.retryAfterMs,
    });
    const { pendingDispatch, ...rest } = next;
    if (args.canRecover) {
      const executorId = job.executor?.id ?? job.kind;
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

  next = recordJobEvidence(next, job, producer, result.evidence, candidateDigest);

  if (job.purpose === "work") {
    next = { ...next, lastWorkOperationId: operationId };
  }

  const { pendingDispatch: _done, ...cleared } = next;
  void _done;
  return cleared;
}

/** A route naming a step outside the pinned definition stops the run instead of adding it. */
function stopForUndeclaredStage(state: DurableRunState, stageId: string): DurableRunState | undefined {
  if (state.definition.stages.some((s) => s.id === stageId)) return undefined;
  return {
    ...state,
    status: "stopped",
    stopReason: "undeclared stage",
    blocker: `stageId ${stageId} is not in the pinned graph definition`,
  };
}

const MAX_TRIGGER_CHARS = 500;

function boundText(text: string): string {
  return text.length <= MAX_TRIGGER_CHARS ? text : `${text.slice(0, MAX_TRIGGER_CHARS - 1)}…`;
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
      const claimed = selfReportedKind(job, item.kind);
      const record: EvidenceRecord = {
        ref,
        kind: claimed === undefined ? item.kind : "other",
        generation: next.generation,
        ...(candidateDigest !== undefined ? { candidateDigest } : {}),
      };
      record.payload = attachProducer(
        claimed === undefined ? item.payload : { selfReported: claimed, claim: item.payload ?? null },
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
      return { ...state, status: "stopped", stopReason: "observe rejected", blocker: err instanceof Error ? err.message : String(err) };
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
