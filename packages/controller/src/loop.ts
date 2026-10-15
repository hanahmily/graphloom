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
  checkReferences,
  pinJobExecutor,
  validateResultShape,
  writeScopeProblem,
  type CheckoutSpec,
  type EnvironmentDeclaration,
} from "@graphloom/sdk";
import type { ExecutorSourceOverride, JobContext, Runner } from "@graphloom/runner";
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

        // One-shot: a resumed process may run different controller or plugin
        // code, or carry newly granted authority, than whatever rejected a
        // past proposal still sitting in the supervisor's own history.
        const resumed = state.resumedSinceLastDecision === true;
        if (resumed) state = { ...state, resumedSinceLastDecision: false };
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
            ...(resumed ? { resumed: true } : {}),
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
        if (isModelSwitchRequest(decided)) {
          state = markProposal(state, decided);
          state = await applyModelSwitch(state, supervisor, decided, "supervisor");
          await saveRunState(state);
          syncRevision(deps, state);
          return { done: false as const, state };
        }
        const notedProposal = noteSupervisorProposal(state, trigger.code, decided);
        state = markProposal(
          notedProposal.state,
          decided,
          notedProposal.count >= 2 ? { count: notedProposal.count, triggerCode: trigger.code } : undefined,
        );
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
      const { job, operationId, generation, isCorrection, graphCorrectionTrial, supervisorWorkDispatch, source, notBefore, session } =
        turn.pendingJob;
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
            const resultContract = resolveResultContract(state, job);
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
              ...(resultContract !== undefined ? { resultContract } : {}),
            });
          }
        }
      } finally {
        // A parent that stopped, timed out, or returned early can leave a child running.
        await children?.close();
        stopWatch();
      }
      // Executors may run unconfined, so scope is checked against what actually changed.
      let outOfScope: string[] = [];
      if (before !== undefined) {
        const changed = changedPaths(before, await worktreeChangeFingerprints(state.worktreePath));
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
  if (state.openAttempt !== undefined && Object.keys(state.openAttempt).length > 0) {
    view.openAttempt = { ...state.openAttempt };
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
        current: {
          stageId,
          attempt: state.current.stageId === stageId ? state.current.attempt + 1 : 1,
        },
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
  /** Was a graph-authored (not supervisor) correction-eligible work dispatch at admission. */
  graphCorrectionTrial: boolean;
  /** Was a supervisor-authored work dispatch at admission. */
  supervisorWorkDispatch: boolean;
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

  const contractProblem = contractAdmissionRefusal(state, job);
  if (contractProblem !== undefined) {
    return { state: { ...state, status: "stopped", stopReason: "contract rejected", blocker: contractProblem } };
  }

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
  const graphCorrection = isCorrection && state.mode === "normal";
  const handoff = graphCorrection ? state.handoff?.[job.stageId] : undefined;
  if (handoff !== undefined) {
    const observed = freshEvidence(state).filter((e) => e.kind === "file" || e.kind === "workspace").map((e) => e.ref);
    // The graph's bookkeeping for a dispatch that never happened is not kept.
    const { privateState: _proposed, ...refused } = state;
    void _proposed;
    const restored = priorPrivateState !== undefined ? { ...refused, privateState: priorPrivateState } : refused;
    return { state: enterRecovery(restored, "correction_limit", handoff.reason, observed.slice(-10)) };
  }
  const supervisorWorkDispatch = job.purpose === "work" && state.mode === "recovery";

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
    ...(job.purpose === "work" ? { workDispatched: { ...state.workDispatched, [job.stageId]: true as const } } : {}),
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
      ...(source !== undefined ? { source } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(session !== undefined ? { session } : {}),
    },
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
  const violation = job.readOnly === true ? `read-only job modified or removed ${shown}` : `changed paths outside the job's write scope: ${shown}`;
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
    graphCorrectionTrial: boolean;
    supervisorWorkDispatch: boolean;
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
    });
    next = recordContractStreak(next, job, result.evidence);
    const { pendingDispatch, ...rest } = next;
    if (args.canRecover) {
      const executorId = job.executor?.id ?? job.kind;
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

  next = recordJobEvidence(next, job, producer, result.evidence, candidateDigest);
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
  const streak = state.contractViolationStreak?.[key];
  if (streak === undefined || streak < CONTRACT_VIOLATION_STREAK_LIMIT) return undefined;
  return boundText(
    `stage ${job.stageId}: ${streak} consecutive contract-invalid results for purpose ${job.purpose} (contract ${job.resultSchema ?? "unknown"})`,
  );
}

const STAGE_BUDGET_SHARE = 0.5;

/** §4.7 pacing: a stage spending more than its share of the run's whole agent budget with nothing accepted, while budget remains to act on it. */
function stagePacingMessage(state: DurableRunState, job: JobSpec): string | undefined {
  const total = state.intake.budgets.agentInvocations;
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

function stopForUndeclaredStage(state: DurableRunState, stageId: string): DurableRunState | undefined {
  if (state.definition.stages.some((s) => s.id === stageId)) return undefined;
  return {
    ...state,
    status: "stopped",
    stopReason: "undeclared stage",
    blocker: `stageId ${stageId} is not in the pinned graph definition`,
  };
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
  const total = state.intake.budgets.agentInvocations;
  const dispatches = state.dispatchesSinceReceipt?.[stageId]?.agent ?? 0;
  const receipts = state.receipts.filter((r) => r.stageId === stageId && r.valid).length;
  const kind = purpose !== undefined ? `${purpose} dispatches` : "agent dispatches";
  return `agentInvocations exhausted: stage ${stageId} spent ${spent} of ${total} across ${dispatches} ${kind}, ${receipts} receipts`;
}

const MAX_TRIGGER_CHARS = 500;

function boundText(text: string): string {
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
