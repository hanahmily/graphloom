import { randomUUID } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  type BudgetRemaining,
  type GraphDefinition,
  type GraphPlugin,
  type StageAttempt,
} from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import {
  createChildPluginHost,
  createInProcessPluginHost,
  type PluginHost,
} from "@graphloom/plugin-host";
import type { Supervisor, SupervisorBinding } from "@graphloom/supervisor";
import { reconcileSupervisorBinding, restorePiSupervisorFromBinding } from "@graphloom/supervisor";
import { writeSwitchRequest, type ModelSwitchOrder } from "./supervisor-switch.js";
import {
  activeRepairValidators,
  reconcileRepairJournal,
  type RecreateHostFn,
  type RepairDeps,
} from "./repair-lifecycle.js";
import { admitValidation, assertLiveWorkspaceMatchesEvidence, deliveryDrift, invalidateFromStage } from "./admit.js";
import type { AdmissionValidator } from "./admit.js";
import { resolveBundleEntry } from "./bundle.js";
import { createHostValidators } from "./host-validators.js";
import { intakeTask, type IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import { deleteRun, type DeleteReport } from "./delete-run.js";
import {
  bumpGeneration,
  ensureArtifactDir,
  initialState,
  runNormalLoop,
} from "./loop.js";
import { sanitizedPluginEnv } from "./plugin-env.js";
import { assertPinnedBundleUnchanged, readInstalledBundlePin } from "./pin.js";
import {
  clearOwnerClaim,
  isClaimStale,
  readOwnerClaim,
  reapOwnerProcesses,
} from "./owner.js";
import { isUnsettled, reconcilePendingDispatch } from "./reconcile.js";
import { reconcileChildOperations } from "./children.js";
import { wipeAgentSessions } from "./agent-sessions.js";
import { pinExecutorCatalog, verifyExecutorCatalog } from "./executor-catalog.js";
import {
  getSession,
  registerSession,
  reapSession,
  type ActiveSession,
} from "./sessions.js";
import {
  clearStopRequest,
  hasStopRequest,
  writeStopRequest,
} from "./stop-request.js";
import {
  loadRunState,
  saveRunState,
  type DurableRunState,
  type RunStatus,
  type VersionRecord,
} from "./state.js";
import {
  assertWorktreeMatches,
  createRunWorktree,
  listDirtyPaths,
} from "./worktree.js";

export interface RunRequest {
  taskPath: string;
  runner: Runner;
  /**
   * Optional validators. When omitted with a child host, evaluate runs in the
   * plugin child. Required when using an in-process host that cannot evaluate.
   */
  validators?: Record<string, AdmissionValidator>;
  /**
   * Scripted/CI seam: wrapped in an in-process PluginHost.
   * When omitted (and `host` omitted), the controller loads the pinned
   * bundle in an isolated child process.
   */
  plugin?: GraphPlugin;
  /** Optional pre-built host; when set, overrides plugin/child loading. */
  host?: PluginHost;
  /**
   * Recovery decision owner for Supervise / host crash containment.
   * Scripted in CI; Pi-backed sessions in live runs.
   * One session identity is reused for every repair round in the run.
   */
  supervisor?: Supervisor;
  /**
   * Create the run's supervisor once the run id and state directory exist, so
   * its session transcript lives with the run. Ignored when `supervisor` is set.
   */
  supervisorFactory?: (ctx: { runId: string; stateDir: string }) => Promise<Supervisor>;
  /** Qualified repair patch author + independent reviewer hooks. */
  repair?: RepairDeps;
  /**
   * Replace a dead child host after crash/timeout, or after ActivateRepair.
   * Defaults to spawning a fresh child for controller-owned bundles; pass
   * explicitly for custom hosts. Receives the current intake pin so activation
   * can open the candidate bundle. QualifyRepair also calls it for a throwaway
   * host that describes the candidate, then closes that host.
   */
  recreateHost?: RecreateHostFn;
  /** Directory for durable run state (default: <repo>/graphloom-state). */
  stateRoot?: string;
  runId?: string;
}

export interface ResumeRequest {
  /** Absolute state directory, or runId under stateRoot. */
  runRef: string;
  runner: Runner;
  validators?: Record<string, AdmissionValidator>;
  plugin?: GraphPlugin;
  host?: PluginHost;
  supervisor?: Supervisor;
  repair?: RepairDeps;
  /**
   * When `supervisor` is omitted and durable `supervisorBinding` exists,
   * restore the logical Pi session. Defaults to `restorePiSupervisorFromBinding`.
   */
  restoreSupervisor?: (
    binding: NonNullable<DurableRunState["supervisorBinding"]>,
    ctx: { runId: string; stateDir: string },
  ) => Promise<Supervisor>;
  /**
   * A fresh supervisor when there is no session to restore: the run stopped
   * before its supervisor made a decision, or started without one.
   */
  supervisorFactory?: (ctx: { runId: string; stateDir: string }) => Promise<Supervisor>;
  recreateHost?: RecreateHostFn;
  stateRoot?: string;
  /**
   * Pin the installed plugin bundle when its bytes changed since the run
   * started. Refused unless the graph keeps its stages, requirements,
   * validator bindings and private-state schema. Adopts the updated
   * environment declaration and rechecks accepted receipts with the updated
   * validators.
   */
  updatePlugin?: boolean;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  stopReason?: string;
  blocker?: string;
  /** Recorded evidence the stop cites. */
  stopEvidenceRefs?: string[];
  receipts: DurableRunState["receipts"];
  evidence: DurableRunState["evidence"];
  generation: number;
  worktreePath: string;
  pinnedHead: string;
  bundlePath: string;
  sourceDirtyBefore: string[];
  sourceDirtyAfter: string[];
  stateDir: string;
}

export interface InspectReport {
  runId: string;
  status: RunStatus;
  mode: "normal" | "recovery";
  stages: Array<{
    id: string;
    name: string;
    requirementIds: string[];
    complete: boolean;
  }>;
  current: StageAttempt;
  /** Validation receipts; a stage is complete when each of its requirements has a valid one. */
  receipts: Array<{ stageId: string; requirementId: string; validatorId: string; valid: boolean; evidenceRefs: string[] }>;
  evidenceRefs: string[];
  budgets: BudgetRemaining;
  versionHistory: VersionRecord[];
  activeVersion: string;
  generation: number;
  worktreePath: string;
  stateDir: string;
  stopReason?: string;
  blocker?: string;
  /** Recorded evidence the stop cites. */
  stopEvidenceRefs?: string[];
}

export interface Controller {
  run(request: RunRequest): Promise<RunReport>;
  stop(runRef: string, options?: { stateRoot?: string }): Promise<InspectReport>;
  /**
   * Ask the run's supervisor to continue on another operator-configured model.
   * Applied before the next supervisor prompt, including after resume.
   */
  switchModel(runRef: string, order: ModelSwitchOrder, options?: { stateRoot?: string }): Promise<void>;
  resume(request: ResumeRequest): Promise<RunReport>;
  inspect(runRef: string, options?: { stateRoot?: string }): Promise<InspectReport>;
  /**
   * Delete a stopped or finished run: its worktree, branch, and state
   * directory. Refuses a run a controller is driving, and discards uncommitted
   * changes or branch commits only with `force`.
   */
  delete(runRef: string, options?: { stateRoot?: string; force?: boolean }): Promise<DeleteReport>;
  /** @deprecated Prefer resume(); retained for #25 tests. */
  continueAfterRestart(
    stateDir: string,
    deps: Pick<RunRequest, "plugin" | "host" | "runner" | "validators" | "supervisor">,
  ): Promise<RunReport>;
}

export function createController(): Controller {
  return {
    async run(request: RunRequest): Promise<RunReport> {
      const intake = await intakeTask(request.taskPath);
      const runId = assertSafeRunId(request.runId ?? randomUUID().slice(0, 12));
      const stateRoot = request.stateRoot ?? path.join(intake.repoPath, "graphloom-state");
      const activeVersion = `${intake.bundle.graphId}@${intake.bundle.version}`;

      const host = await openHost({
        intake,
        activeVersion,
        generation: 1,
        ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
        ...(request.host !== undefined ? { host: request.host } : {}),
      });

      const session: ActiveSession = {
        runId,
        stateDir: path.join(stateRoot, runId),
        host,
        stopRequested: false,
      };
      registerSession(session);
      let supervisor = request.supervisor;

      try {
        const described = await host.describe({
          runId,
          operationId: "describe",
          expectedStateRevision: 0,
        });
        if (!described.ok) {
          throw new Error(`plugin describe failed: ${described.observation.message}`);
        }
        const definition = described.value;
        assertDefinitionMatchesPin(definition, intake);

        const revisionBridge = { current: 0 };
        const validators = resolveValidators(
          request.validators,
          () => session.host,
          definition.defaultValidators.map((b) => b.validatorId),
          {
            runId,
            getStateRevision: () => revisionBridge.current,
          },
        );

        const sourceDirtyBefore = await listDirtyPaths(intake.repoPath);
        const { worktreePath, branchName } = await createRunWorktree(
          intake.repoPath,
          runId,
          intake.pinnedHead,
          session.stateDir,
        );

        let state = initialState({
          runId,
          intake,
          definition,
          worktreePath,
          worktreeBranch: branchName,
          stateRoot,
          sourceDirtyBefore,
        });
        const executorCatalog = await pinExecutorCatalog(request.runner);
        if (executorCatalog !== undefined) state = { ...state, executorCatalog };
        revisionBridge.current = state.stateRevision;
        session.stateDir = state.stateDir;
        registerSession(session);
        await ensureArtifactDir(state);
        await clearStopRequest(state.stateDir);
        await saveRunState(state);
        if (supervisor === undefined && request.supervisorFactory !== undefined) {
          supervisor = await request.supervisorFactory({ runId, stateDir: state.stateDir });
        }

        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators,
          shouldStop: () => sessionStop(session),
          revisionBridge,
          ...(supervisor !== undefined ? { supervisor } : {}),
          ...(request.repair !== undefined ? { repair: request.repair } : {}),
          ...resolveCandidateHost(request),
          ...resolveRecreateHost(session, {
            intake,
            activeVersion,
            generation: host.generation,
            ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
            ...(request.host !== undefined ? { host: request.host } : {}),
            ...(request.recreateHost !== undefined
              ? { recreateHost: request.recreateHost }
              : {}),
          }),
        });

        const sourceDirtyAfter = await listDirtyPaths(intake.repoPath);
        return toReport(state, sourceDirtyAfter);
      } finally {
        await clearStopRequest(session.stateDir);
        await supervisor?.close?.().catch(() => undefined);
        await reapSession(session);
        await clearOwnerClaim(session.stateDir);
      }
    },

    async stop(runRef, options): Promise<InspectReport> {
      const stateDir = await resolveStateDir(runRef, options?.stateRoot);
      await writeStopRequest(stateDir);

      const session = getSession(stateDir) ?? getSession(runRef);
      if (session) {
        session.stopRequested = true;
        await session.host.close().catch(() => undefined);
      }

      // Cross-process: the owner handles SIGTERM cooperatively so its abort
      // reaches executor children, including detached agent process groups.
      await reapOwnerProcesses(stateDir);
      if (!session) {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const owner = await readOwnerClaim(stateDir);
          if (!owner || isClaimStale(owner)) break;
          if (Date.now() >= deadline) {
            throw new Error("stop requested, but controller cleanup is still pending; ownership retained, retry stop");
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      // Serialize the final stopped write with the owner loop (lock is not held
      // across runner jobs, so this can proceed during an in-flight dispatch).
      return withDirectoryLock(stateDir, "run.exec.lock", async () => {
        let state = await loadRunState(stateDir);
        if (state.status === "running") {
          state = bumpGeneration(
            {
              ...state,
              status: "stopped",
              stopReason: "operator stop",
              blocker: "stop requested",
            },
            "operator stop",
          );
          await saveRunState(state);
        }
        await clearStopRequest(stateDir);
        // In-process stop can return before a custom runner observes abort.
        // Its loop retains ownership until all execution has actually ended.
        if (!session) await clearOwnerClaim(stateDir);
        return toInspect(state);
      });
    },

    async delete(runRef, options): Promise<DeleteReport> {
      const stateDir = await resolveStateDir(runRef, options?.stateRoot);
      if (getSession(stateDir) || getSession(runRef)) {
        const { runId } = await loadRunState(stateDir);
        throw new Error(`cannot delete run ${runId}: it has an active controller session; stop it first`);
      }
      return deleteRun(stateDir, { force: options?.force === true });
    },

    async switchModel(runRef, order, options): Promise<void> {
      const stateDir = await resolveStateDir(runRef, options?.stateRoot);
      const state = await loadRunState(stateDir);
      if (state.status === "succeeded" || state.status === "failed") {
        throw new Error(`cannot switch model: run ${state.runId} is ${state.status}`);
      }
      await writeSwitchRequest(stateDir, order);
    },

    async resume(request: ResumeRequest): Promise<RunReport> {
      const stateDir = await resolveStateDir(request.runRef, request.stateRoot);
      if (getSession(stateDir) || getSession(request.runRef)) {
        throw new Error("cannot resume: run has an active controller session; stop first");
      }

      let state = await loadRunState(stateDir);
      if (state.status === "succeeded" || state.status === "failed") {
        // A crash after the finished state was saved can leave them behind.
        await wipeAgentSessions(state);
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      }

      // Claim the run under the exec lock, then release before the loop
      // (which re-acquires the same lock).
      let session: ActiveSession | undefined;
      let restoredSupervisor: Supervisor | undefined;
      // The operator's plugin update is committed only after the updated graph keeps the pinned contract.
      let pluginUpdate: IntakePin["bundle"] | undefined;
      await withDirectoryLock(stateDir, "run.exec.lock", async () => {
        if (getSession(stateDir) || getSession(request.runRef)) {
          throw new Error("cannot resume: run has an active controller session; stop first");
        }
        const owner = await readOwnerClaim(stateDir);
        if (owner && !isClaimStale(owner)) {
          throw new Error(
            `cannot resume: run owned by live controller pid ${owner.controllerPid}; stop first`,
          );
        }
        state = await loadRunState(stateDir);
        if (state.status === "succeeded" || state.status === "failed") {
          return;
        }
        // Evidence belongs to the stop being resumed; any stop from here on is a new one.
        const { stopEvidenceRefs: _staleEvidence, ...resumable } = state;
        void _staleEvidence;
        state = resumable;

        try {
          await assertWorktreeMatches(
            state.intake.repoPath,
            state.worktreePath,
            state.worktreeBranch,
            state.intake.pinnedHead,
          );
        } catch (err) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "worktree mismatch",
            blocker: err instanceof Error ? err.message : String(err),
          };
          await saveRunState(state);
          return;
        }

        try {
          if (request.updatePlugin === true) {
            const { graphId, version } = state.intake.bundle;
            if (state.activeVersion !== `${graphId}@${version}`) {
              throw new Error(`an activated repair (${state.activeVersion}) owns this run's plugin; only the installed bundle can be updated`);
            }
            const installed = await readInstalledBundlePin(state.intake.bundle);
            if (installed.manifestDigest !== state.intake.bundle.manifestDigest || installed.entryDigest !== state.intake.bundle.entryDigest) {
              pluginUpdate = installed;
            }
          }
          await assertPinnedBundleUnchanged(pluginUpdate !== undefined ? { ...state.intake, bundle: pluginUpdate } : state.intake);
        } catch (err) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "pin mismatch",
            blocker: err instanceof Error ? err.message : String(err),
          };
          await saveRunState(state);
          return;
        }

        const children = reconcileChildOperations(state);
        state = children.state;
        if (!children.settled) {
          state = { ...state, status: "stopped", stopReason: "reconcile required", blocker: children.reason };
          await saveRunState(state);
          return;
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
            return;
          }
        }

        state = reconcileRepairJournal(state);
        state = await reconcileSwitchJournal(state);
        state = await reassessAcceptedWorkspace(state);
        // The operator's resume restarts the graph, so its replayed decisions are not repeats.
        const { noProgress: _repeats, ...resumed } = state;
        void _repeats;
        state = bumpGeneration({ ...resumed, status: "running" }, "resume");
        await clearStopRequest(stateDir);
        await saveRunState(state);

        // Placeholder host until openHost completes after the lock is released.
        session = {
          runId: state.runId,
          stateDir: state.stateDir,
          host: claimPlaceholderHost(state.activeVersion, state.generation),
          stopRequested: false,
        };
        registerSession(session);
      });

      if (state.status !== "running" || !session) {
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      }

      try {
        const host = await openHost({
          intake: pluginUpdate !== undefined ? { ...state.intake, bundle: pluginUpdate } : state.intake,
          activeVersion: state.activeVersion,
          generation: state.generation,
          ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
          ...(request.host !== undefined ? { host: request.host } : {}),
        });
        session.host = host;

        const described = await host.describe({
          runId: state.runId,
          operationId: "describe-resume",
          expectedStateRevision: state.stateRevision,
        });
        if (!described.ok) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "pin mismatch",
            blocker: `plugin describe failed on resume: ${described.observation.message}`,
          };
          await saveRunState(state);
          return toReport(state, await listDirtyPaths(state.intake.repoPath));
        }
        try {
          assertDefinitionMatchesPin(described.value, pluginUpdate !== undefined ? { ...state.intake, bundle: pluginUpdate } : state.intake);
          assertDefinitionUnchanged(described.value, state.definition);
          if (pluginUpdate !== undefined && described.value.privateStateSchema !== state.definition.privateStateSchema) {
            // Saved private state was written for the pinned schema.
            throw new Error("plugin privateStateSchema changed since run start");
          }
        } catch (err) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "pin mismatch",
            blocker: err instanceof Error ? err.message : String(err),
          };
          await saveRunState(state);
          return toReport(state, await listDirtyPaths(state.intake.repoPath));
        }
        const executorBlocker = await verifyExecutorCatalog(state, request.runner).catch(
          (err: unknown) => `executor catalog unreadable: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (executorBlocker !== undefined) {
          state = { ...state, status: "stopped", stopReason: "executor pin mismatch", blocker: executorBlocker };
          await saveRunState(state);
          return toReport(state, await listDirtyPaths(state.intake.repoPath));
        }

        // Host-backed validators already evaluate in the active (repaired) bundle;
        // explicit in-process validators must be rebound to the repaired candidate.
        const rehydrated: ReturnType<typeof activeRepairValidators> =
          request.validators !== undefined
            ? activeRepairValidators(state, request.repair)
            : { ok: true };
        if (!rehydrated.ok) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "repair rehydration required",
            blocker: rehydrated.reason,
          };
          await saveRunState(state);
          return toReport(state, await listDirtyPaths(state.intake.repoPath));
        }

        const revisionBridge = { current: state.stateRevision };
        const baseValidators = resolveValidators(
          request.validators,
          () => session!.host,
          state.definition.defaultValidators.map((b) => b.validatorId),
          {
            runId: state.runId,
            getStateRevision: () => revisionBridge.current,
          },
        );
        const validators = rehydrated.validators
          ? { ...baseValidators, ...rehydrated.validators }
          : baseValidators;

        if (pluginUpdate !== undefined) {
          // Same stages, requirements and validator bindings, but the validators' code may differ.
          const { environment: _previous, ...pinned } = state.definition;
          void _previous;
          const { environment } = described.value;
          const updated = await recheckReceipts(
            {
              ...state,
              intake: { ...state.intake, bundle: pluginUpdate },
              definition: environment !== undefined ? { ...pinned, environment } : pinned,
            },
            validators,
          );
          const reason = `operator plugin update: manifest ${state.intake.bundle.manifestDigest.slice(0, 12)} -> ${pluginUpdate.manifestDigest.slice(0, 12)}${updated.note}`;
          state = {
            ...updated.state,
            versionHistory: [...(state.versionHistory ?? []), { activeVersion: state.activeVersion, generation: state.generation, reason, at: new Date().toISOString() }],
          };
          revisionBridge.current = state.stateRevision;
          await saveRunState(state);
        }

        const supervisor = await resolveResumeSupervisor(request, state, stateDir);
        if (supervisor && !request.supervisor) {
          restoredSupervisor = supervisor;
        }

        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators,
          shouldStop: () => sessionStop(session!),
          revisionBridge,
          ...(supervisor !== undefined ? { supervisor } : {}),
          ...(request.repair !== undefined ? { repair: request.repair } : {}),
          ...resolveCandidateHost(request),
          ...resolveRecreateHost(session, {
            intake: state.intake,
            activeVersion: state.activeVersion,
            generation: host.generation,
            ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
            ...(request.host !== undefined ? { host: request.host } : {}),
            ...(request.recreateHost !== undefined
              ? { recreateHost: request.recreateHost }
              : {}),
          }),
        });
        return toReport(state, await listDirtyPaths(state.intake.repoPath));
      } finally {
        await clearStopRequest(stateDir);
        await request.supervisor?.close?.().catch(() => undefined);
        await restoredSupervisor?.close?.().catch(() => undefined);
        await reapSession(session);
        await clearOwnerClaim(stateDir);
      }
    },

    async inspect(runRef, options): Promise<InspectReport> {
      const stateDir = await resolveStateDir(runRef, options?.stateRoot);
      const state = await loadRunState(stateDir);
      return toInspect(state);
    },

    async continueAfterRestart(stateDir, deps): Promise<RunReport> {
      const resumeReq: ResumeRequest = {
        runRef: stateDir,
        runner: deps.runner,
      };
      if (deps.validators !== undefined) {
        resumeReq.validators = deps.validators;
      }
      if (deps.plugin !== undefined) {
        resumeReq.plugin = deps.plugin;
      }
      if (deps.host !== undefined) {
        resumeReq.host = deps.host;
      }
      if (deps.supervisor !== undefined) {
        resumeReq.supervisor = deps.supervisor;
      }
      return this.resume(resumeReq);
    },
  };
}

/** Accepted evidence survives restart only while its observed inputs still match. */
async function reassessAcceptedWorkspace(state: DurableRunState): Promise<DurableRunState> {
  // The last Observe revision may belong to a later candidate; each receipt is
  // assessed against its own immutable evidence, not that global revision.
  const { workspaceRevision: _revision, ...snapshot } = state;
  void _revision;
  for (const stage of state.definition.stages) {
    for (const receipt of state.receipts.filter((r) => r.valid && r.stageId === stage.id)) {
      const evidence = receipt.evidenceRefs.map((ref) => state.evidence.find((e) => e.ref === ref));
      const missing = evidence.some((e) => e === undefined);
      const drift = missing || await assertLiveWorkspaceMatchesEvidence(
        snapshot,
        evidence.filter((e) => e !== undefined),
      ).catch(() => "accepted evidence is no longer readable");
      if (!drift) continue;

      const invalidated = invalidateFromStage(snapshot, stage.id, state.definition);
      // Discard routing state that may assume the invalidated prerequisites.
      // Resume's generation fence makes historical observations unavailable to
      // validation while preserving them for audit.
      const { privateState: _privateState, ...next } = invalidated;
      void _privateState;
      return {
        ...next,
        current: {
          stageId: stage.id,
          attempt: state.current.stageId === stage.id ? state.current.attempt + 1 : 1,
        },
      };
    }
  }
  const last = state.definition.stages.at(-1);
  if (last !== undefined && (await deliveryDrift(snapshot)) !== undefined) {
    const { privateState: _privateState, ...next } = invalidateFromStage(snapshot, last.id, state.definition);
    void _privateState;
    return {
      ...next,
      current: { stageId: last.id, attempt: state.current.stageId === last.id ? state.current.attempt + 1 : 1 },
    };
  }
  return state;
}

/**
 * Rechecks each accepted receipt with the current validators on the evidence it
 * was accepted on; the first one that no longer passes invalidates its stage and
 * every later one, and the run returns to that stage.
 */
async function recheckReceipts(
  state: DurableRunState,
  validators: Record<string, AdmissionValidator>,
): Promise<{ state: DurableRunState; note: string }> {
  for (const stage of state.definition.stages) {
    for (const receipt of state.receipts.filter((r) => r.valid && r.stageId === stage.id)) {
      const requirement = state.definition.requirements.find((r) => r.id === receipt.requirementId);
      const validator = validators[receipt.validatorBinding.validatorId];
      const evidence = receipt.evidenceRefs.map((ref) => state.evidence.find((e) => e.ref === ref));
      let failure: string | undefined;
      if (requirement === undefined || validator === undefined || evidence.some((e) => e === undefined)) {
        failure = "cannot be rechecked";
      } else {
        const result = await Promise.resolve(
          validator.evaluate({
            requirementId: receipt.requirementId,
            statement: requirement.statement,
            evidence: evidence.filter((e) => e !== undefined),
            candidateFingerprint: receipt.candidateFingerprint,
            ...(receipt.candidateDigest !== undefined ? { candidateDigest: receipt.candidateDigest } : {}),
          }),
        ).catch((err: unknown) => ({ status: "failed" as const, reason: err instanceof Error ? err.message : String(err) }));
        if (result.status !== "passed") failure = `${result.status}: ${result.reason}`;
      }
      if (failure === undefined) continue;
      // Discard routing state that may assume the invalidated prerequisites.
      const { privateState: _privateState, ...next } = invalidateFromStage(state, stage.id, state.definition);
      void _privateState;
      return {
        state: {
          ...next,
          current: { stageId: stage.id, attempt: state.current.stageId === stage.id ? state.current.attempt + 1 : 1 },
        },
        note: `; invalidated from ${stage.id}: ${receipt.requirementId} ${failure}`,
      };
    }
  }
  return { state, note: "" };
}

function resolveValidators(
  explicit: Record<string, AdmissionValidator> | undefined,
  getHost: () => PluginHost,
  ids: string[],
  ctx: { runId: string; getStateRevision: () => number },
): Record<string, AdmissionValidator> {
  if (explicit) {
    // Activation swaps validators in place; never mutate the caller's map.
    return { ...explicit };
  }
  if (getHost().evaluate) {
    return createHostValidators(getHost, ids, ctx);
  }
  throw new Error(
    "validators required when the plugin host cannot evaluate (pass validators or use a child host)",
  );
}

async function resolveResumeSupervisor(
  request: ResumeRequest,
  state: DurableRunState,
  stateDir: string,
): Promise<Supervisor | undefined> {
  if (request.supervisor) {
    return request.supervisor;
  }
  const binding = state.supervisorBinding;
  if (!binding?.sessionFile) {
    return request.supervisorFactory?.({ runId: state.runId, stateDir });
  }
  const restore =
    request.restoreSupervisor ??
    (async (b, ctx) =>
      restorePiSupervisorFromBinding({
        runId: ctx.runId,
        binding: toSupervisorBinding(b),
        sessionDir: path.dirname(b.sessionFile!),
        repairsDir: path.join(ctx.stateDir, "repairs"),
      }));
  return restore(binding, { runId: state.runId, stateDir });
}

function toSupervisorBinding(b: NonNullable<DurableRunState["supervisorBinding"]>): SupervisorBinding {
  return {
    sessionId: b.sessionId,
    sessionFile: b.sessionFile,
    provider: b.provider,
    modelId: b.modelId,
    switchJournal: b.switchJournal,
    ...(b.configuredModels !== undefined ? { configuredModels: b.configuredModels } : {}),
  };
}

/** Settle a model switch interrupted by a crash, from the Pi session file. */
async function reconcileSwitchJournal(state: DurableRunState): Promise<DurableRunState> {
  const binding = state.supervisorBinding;
  if (binding === undefined || !binding.switchJournal.some((r) => r.status === "intent")) return state;
  const settled = await reconcileSupervisorBinding(toSupervisorBinding(binding));
  return {
    ...state,
    supervisorBinding: {
      ...binding,
      provider: settled.provider,
      modelId: settled.modelId,
      switchJournal: settled.switchJournal,
    },
  };
}

async function sessionStop(session: ActiveSession): Promise<boolean> {
  return session.stopRequested || (await hasStopRequest(session.stateDir));
}

function claimPlaceholderHost(activeVersion: string, generation: number): PluginHost {
  const fail = async <T>(): Promise<
    { ok: false; observation: { kind: "child_observation"; code: "internal"; message: string } }
  > => ({
    ok: false,
    observation: {
      kind: "child_observation",
      code: "internal",
      message: "resume claim host is not ready",
    },
  });
  return {
    activeVersion,
    generation,
    describe: async () => fail(),
    advance: async () => fail(),
    close: async () => undefined,
  };
}

async function openHost(args: {
  plugin?: GraphPlugin;
  host?: PluginHost;
  intake: IntakePin;
  activeVersion: string;
  generation: number;
}): Promise<PluginHost> {
  if (args.host) {
    return args.host;
  }
  if (args.plugin) {
    return createInProcessPluginHost(args.plugin, {
      activeVersion: args.activeVersion,
      generation: args.generation,
    });
  }
  const entryModule = resolveBundleEntry(args.intake);
  return createChildPluginHost({
    entryModule,
    activeVersion: args.activeVersion,
    generation: args.generation,
    cwd: args.intake.bundle.bundlePath,
    env: sanitizedPluginEnv(args.intake.bundle.bundlePath),
  });
}

/**
 * Prefer an explicit recreate hook; otherwise spawn a fresh child for
 * controller-owned bundles. Caller-supplied hosts/plugins are left alone
 * unless they pass recreateHost.
 *
 * The returned closure reads intake/version/generation from the call args so
 * ActivateRepair can point the next host at the candidate pin.
 */
function resolveRecreateHost(
  session: ActiveSession,
  args: {
    intake: IntakePin;
    activeVersion: string;
    generation: number;
    plugin?: GraphPlugin;
    host?: PluginHost;
    recreateHost?: (ctx: {
      intake: IntakePin;
      activeVersion: string;
      generation: number;
    }) => Promise<PluginHost>;
  },
): { recreateHost: RecreateHostFn } | Record<string, never> {
  if (args.recreateHost) {
    return {
      recreateHost: async (ctx) => {
        const next = await args.recreateHost!(ctx);
        session.host = next;
        return next;
      },
    };
  }
  if (args.host !== undefined || args.plugin !== undefined) {
    return {};
  }
  return {
    recreateHost: async (ctx) => {
      const next = await openHost({
        intake: ctx.intake,
        activeVersion: ctx.activeVersion,
        generation: ctx.generation,
      });
      session.host = next;
      return next;
    },
  };
}

/**
 * Hosts for describing repair candidates at qualification: the explicit
 * recreate hook, else a child for controller-owned bundles. Unlike
 * recreateHost, these never replace the session's live host.
 */
function resolveCandidateHost(request: {
  plugin?: GraphPlugin;
  host?: PluginHost;
  recreateHost?: RecreateHostFn;
}): { openCandidateHost: RecreateHostFn } | Record<string, never> {
  if (request.recreateHost) return { openCandidateHost: request.recreateHost };
  if (request.host !== undefined || request.plugin !== undefined) return {};
  return { openCandidateHost: (ctx) => openHost(ctx) };
}

/** Resolve a run reference (absolute state directory, or bare run id under `stateRoot`) to its state directory. */
export async function resolveStateDir(runRef: string, stateRoot?: string): Promise<string> {
  if (path.isAbsolute(runRef)) {
    await access(path.join(runRef, "state.json"));
    return runRef;
  }
  if (!stateRoot) {
    throw new Error("stateRoot required when runRef is not an absolute state directory");
  }
  const dir = path.join(stateRoot, assertSafeRunId(runRef));
  await access(path.join(dir, "state.json"));
  return dir;
}

function toInspect(state: DurableRunState): InspectReport {
  const report: InspectReport = {
    runId: state.runId,
    status: state.status,
    mode: state.mode,
    stages: state.definition.stages.map((s) => ({
      id: s.id,
      name: s.name,
      requirementIds: [...s.requirementIds],
      complete: s.requirementIds.every((reqId) =>
        state.receipts.some(
          (r) => r.stageId === s.id && r.requirementId === reqId && r.valid,
        ),
      ),
    })),
    current: structuredClone(state.current),
    receipts: state.receipts.map((r) => ({
      stageId: r.stageId,
      requirementId: r.requirementId,
      validatorId: r.validatorBinding.validatorId,
      valid: r.valid,
      evidenceRefs: [...r.evidenceRefs],
    })),
    evidenceRefs: state.evidence.map((e) => e.ref),
    budgets: { ...state.budgets },
    versionHistory: structuredClone(state.versionHistory ?? []),
    activeVersion: state.activeVersion,
    generation: state.generation,
    worktreePath: state.worktreePath,
    stateDir: state.stateDir,
  };
  if (state.stopReason !== undefined) {
    report.stopReason = state.stopReason;
  }
  if (state.blocker !== undefined) {
    report.blocker = state.blocker;
  }
  if (state.stopEvidenceRefs !== undefined) {
    report.stopEvidenceRefs = [...state.stopEvidenceRefs];
  }
  return report;
}

function assertDefinitionMatchesPin(definition: GraphDefinition, intake: IntakePin): void {
  if (definition.graphId !== intake.bundle.graphId) {
    throw new Error(
      `plugin graphId ${definition.graphId} != pinned bundle ${intake.bundle.graphId}`,
    );
  }
  if (definition.version !== intake.bundle.version) {
    throw new Error(
      `plugin version ${definition.version} != pinned bundle ${intake.bundle.version}`,
    );
  }
  if (intake.bundle.sdkProtocol !== PROTOCOL_VERSION) {
    throw new Error(`pinned sdkProtocol ${intake.bundle.sdkProtocol} != ${PROTOCOL_VERSION}`);
  }
  const manifestReqs = (
    JSON.parse(intake.bundle.manifestRaw) as {
      requirements?: Array<{ id: string; statement: string; evidenceSchema: string }>;
    }
  ).requirements;
  if (manifestReqs) {
    if (manifestReqs.length !== definition.requirements.length) {
      throw new Error("plugin requirements length != manifest");
    }
    for (const req of manifestReqs) {
      const live = definition.requirements.find((r) => r.id === req.id);
      if (!live || live.statement !== req.statement || live.evidenceSchema !== req.evidenceSchema) {
        throw new Error(`requirement mismatch for ${req.id}`);
      }
    }
  }
}

function assertDefinitionUnchanged(live: GraphDefinition, pinned: GraphDefinition): void {
  if (live.graphId !== pinned.graphId || live.version !== pinned.version) {
    throw new Error("plugin graphId/version changed since run start");
  }
  if (JSON.stringify(live.stages) !== JSON.stringify(pinned.stages)) {
    throw new Error("plugin stages changed since run start");
  }
  if (JSON.stringify(live.requirements) !== JSON.stringify(pinned.requirements)) {
    throw new Error("plugin requirements changed since run start");
  }
  if (JSON.stringify(live.defaultValidators) !== JSON.stringify(pinned.defaultValidators)) {
    throw new Error("plugin defaultValidators changed since run start");
  }
}

function toReport(state: DurableRunState, sourceDirtyAfter: string[]): RunReport {
  const report: RunReport = {
    runId: state.runId,
    status: state.status,
    receipts: state.receipts,
    evidence: state.evidence,
    generation: state.generation,
    worktreePath: state.worktreePath,
    pinnedHead: state.intake.pinnedHead,
    bundlePath: state.intake.bundle.bundlePath,
    sourceDirtyBefore: state.sourceDirtyBefore,
    sourceDirtyAfter,
    stateDir: state.stateDir,
  };
  if (state.stopReason !== undefined) {
    report.stopReason = state.stopReason;
  }
  if (state.blocker !== undefined) {
    report.blocker = state.blocker;
  }
  if (state.stopEvidenceRefs !== undefined) {
    report.stopEvidenceRefs = [...state.stopEvidenceRefs];
  }
  return report;
}

export { intakeTask, parseTaskYaml, resolveUnderBase, IntakeError } from "./intake.js";
export { admitValidation, freshEvidence } from "./admit.js";
export { toRunView, bumpGeneration } from "./loop.js";
export { loadRunState, saveRunState } from "./state.js";
export type { DurableRunState, RunStatus, VersionRecord } from "./state.js";
export type { DeleteReport } from "./delete-run.js";
export type { IntakePin } from "./intake.js";
export type {
  RepairDeps,
  RepairPatchAuthor,
  RepairReviewer,
  RepairPreflightResult,
  RecreateHostFn,
} from "./repair-lifecycle.js";
export { defaultRepairPreflight } from "./repair-lifecycle.js";
export { assertSafeRunId, assertSafeGraphId } from "./ids.js";
export { resolveBundleEntry } from "./bundle.js";

/** Test helper: attempt Validate using only current-generation evidence. */
export async function tryAdmit(
  state: DurableRunState,
  stageId: string,
  validators: Record<string, AdmissionValidator>,
) {
  return admitValidation(state, { stageId }, validators);
}

/** Test helper: write a sidecar file beside the source repo without touching worktree. */
export async function writeSourceSidecar(repoPath: string, name: string, body: string): Promise<void> {
  await writeFile(path.join(repoPath, name), body, "utf8");
}
