// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { randomUUID } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyCaseFile,
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
import { bindingHarness, reconcileSupervisorBinding } from "@graphloom/supervisor";
import type { ProposalReviewer } from "./proposal-review.js";
import { readBinding, writeSwitchRequest, type ModelSwitchOrder } from "./supervisor-switch.js";
import { refreshCaseFile } from "./case-file.js";
import {
  activeRepairValidators,
  reconcileRepairJournal,
  type RecreateHostFn,
  type RepairDeps,
} from "./repair-lifecycle.js";
import { admitValidation, assertLiveWorkspaceMatchesEvidence, deliveryDrift, invalidateStageAndAfter, liveCandidateDigest } from "./admit.js";
import type { AdmissionValidator } from "./admit.js";
import { resolveBundleEntry } from "./bundle.js";
import { createHostValidators } from "./host-validators.js";
import { applyGraphDefaultBudgets, intakeTask, taskConfigValue, type IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import { deleteRun, type DeleteReport } from "./delete-run.js";
import {
  bumpGeneration,
  ensureArtifactDir,
  boundText,
  initialState,
  QUOTA_RECONCILE_STOP_REASON,
  runNormalLoop,
} from "./loop.js";
import { sanitizedPluginEnv } from "./plugin-env.js";
import { assertPinnedBundleUnchanged, readInstalledBundlePin } from "./pin.js";
import {
  claimRunOwner,
  clearOwnerClaim,
  isClaimStale,
  readOwnerClaim,
  reapOwnerProcesses,
} from "./owner.js";
import { isUnsettled, reconcilePendingDispatch } from "./reconcile.js";
import { reconcileChildOperations } from "./children.js";
import { wipeAgentSessions } from "./agent-sessions.js";
import { applyExecutorRepin, pinExecutorCatalog, verifyExecutorCatalog, type ExecutorRepin } from "./executor-catalog.js";
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
  nextStageAttempt,
  recordRemedy,
  saveRunState,
  type DurableRunState,
  type RemedyRecord,
  type HostChangeRecord,
  type RunStatus,
  type SupervisorOutcomeRecord,
  type ExecutorCatalogEntry,
  type ExecutorTransitionRecord,
  type InstallRecord,
  type InstallTransitionRecord,
  type StateMigrationRecord,
  type VersionRecord,
} from "./state.js";
import { returnToGraphOnResume } from "./resume-recovery.js";
import { CURRENT_STATE_FORMAT, STATE_FORMATS, stateFormatOf, type StateFormatRegistry } from "./state-migrations/index.js";
import { upgradeRun, type UpgradeRequest } from "./upgrade.js";
import { classifyStop, decideResume, FINAL_STOP_HELD_REMEDY, resumeView, stopMarkOf } from "./stop-class.js";
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
   * Independent reviewer of a supervisor `stop` or validator/executor
   * `qualify_repair`: a refute returns the proposal in-turn, no verdict blocks the run.
   */
  proposalReviewer?: ProposalReviewer;
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
  /**
   * The gate in `run` (docs/design-graph-rehearsal.md §3.5): the CLI's own
   * L0+L1 outcome before this run was intaken, pinned onto the run's own
   * `IntakePin` so `inspect` can show whether (and how) it was rehearsed.
   * The controller does not run the gate itself — a caller that skips this
   * runs un-gated, same as always.
   */
  rehearsalGate?: IntakePin["rehearsalGate"];
  /** Called once the run's id and state directory are durable, before the first job. */
  onRunCreated?: (run: { runId: string; stateDir: string }) => void | Promise<void>;
  /** The GraphLoom that owns the run (docs/design-release.md §5.1), recorded in its state. */
  install?: InstallRecord;
  /**
   * A test hook (`rehearse --stop-at`): stop the run as an operator stop once
   * every requirement of this stage (by id or name) has a valid receipt,
   * before the graph is asked for its next step.
   */
  stopAfterStage?: string;
}

export interface ResumeRequest {
  /**
   * The operator reconciled the job a harness usage limit cut off after possible effects:
   * the run's graph may run again. Without a supervisor, a resume refuses to otherwise.
   */
  reconciled?: boolean;
  /** Absolute state directory, or runId under stateRoot. */
  runRef: string;
  runner: Runner;
  validators?: Record<string, AdmissionValidator>;
  plugin?: GraphPlugin;
  host?: PluginHost;
  supervisor?: Supervisor;
  repair?: RepairDeps;
  proposalReviewer?: ProposalReviewer;
  /**
   * When `supervisor` is omitted and durable `supervisorBinding` exists,
   * restore the run's logical supervisor on the harness the binding names
   * (`binding.harness`; absent reads as `pi`). The controller has no default:
   * the composition root passes the restore for the bound harness, and a
   * resume with a binding but no restore refuses rather than guess one.
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
  /**
   * Pin the installed executors whose bytes changed since the run started,
   * recording each old -> new digest. Refused for an executor that is no
   * longer installed, whose isolation or built-in status changed, or whose
   * active repair the installed bytes moved past. Accepted receipts and
   * evidence are not changed.
   */
  updateExecutors?: boolean;
  /**
   * `resume --upgrade` (docs/design-release.md §5.2): move the stopped run to
   * this GraphLoom first, migrating its state format and re-pinning its
   * executors. Refused, with the run unchanged, on a downgrade, a major
   * crossing, an unknown format, a missing migrator, an unsettled repair, a
   * plugin protocol change without `updatePlugin`, or an executor re-pin the
   * update would refuse.
   */
  upgrade?: UpgradeRequest;
  /** The state formats this controller writes and migrates (tests); defaults to the release's own. */
  stateFormats?: StateFormatRegistry;
}

export interface RunReport {
  runId: string;
  status: RunStatus;
  stopReason?: string;
  blocker?: string;
  /** The stop's class (docs §8): retryable, so a resume runs the graph again, or final, so a resume surfaces the same blocker until something it depends on changes (the operator's own stop is final, and the resume answers it). */
  stopRetryable?: boolean;
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
  /** The gate in `run` (docs/design-graph-rehearsal.md §3.5): whether (and how) this run was rehearsed before it was intaken. Absent for runs intaken un-gated. */
  rehearsalGate?: IntakePin["rehearsalGate"];
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
  /** Executors the operator re-pinned to installed code (`resume --update-executors`): old -> new digest at the generation it took effect. */
  executorTransitions: ExecutorTransitionRecord[];
  /** The GraphLoom that owns the run; absent for runs created before ownership was recorded. */
  install?: InstallRecord;
  /** The durable state format (1 for runs saved before it was recorded). */
  stateFormat: number;
  /** Moves to another GraphLoom (`resume --upgrade`), oldest first. */
  installHistory: InstallTransitionRecord[];
  /** State-format migrations `resume --upgrade` applied, oldest first. */
  stateMigrations: StateMigrationRecord[];
  /** Supervisor jobs run with the operator's `hostRepair` grant, outside the run's scope, oldest first. */
  hostChanges: HostChangeRecord[];
  activeVersion: string;
  generation: number;
  worktreePath: string;
  stateDir: string;
  stopReason?: string;
  blocker?: string;
  /** The stop's class (docs §8): retryable, so a resume runs the graph again, or final, so a resume surfaces the same blocker until something it depends on changes (the operator's own stop is final, and the resume answers it). */
  stopRetryable?: boolean;
  /** Recorded evidence the stop cites. */
  stopEvidenceRefs?: string[];
  /** The operator's latest resume, as the graph sees it (`RunView.resume`). */
  lastResume?: import("@graphloom/sdk").ResumeView;
  /** Agent results checked against a declared result contract (§4.1), by outcome and by contract name. */
  contracts: {
    valid: number;
    invalid: number;
    repaired: number;
    byName: Record<string, { valid: number; invalid: number; repaired: number }>;
  };
  /** Per stage, dispatches settled since its last receipt (§4.6). */
  dispatchesSinceReceipt: Record<string, { agent: number; total: number; since: string }>;
  /** The task config intake pinned (path and digest; its content stays with the run). */
  config?: { path: string; sha256: string };
  /** Deterministic remedies applied without a model decision (quota waits, compactions, re-asks, retries), newest last. */
  remedies: RemedyRecord[];
  /** Supervisor turns that ended without an admitted proposal (#117), such as `supervisor_inadmissible`. */
  supervisorOutcomes: SupervisorOutcomeRecord[];
  /** The supervisor's case file (#120), stale entries included and marked; empty when none was kept. */
  caseFile: import("@graphloom/sdk").CaseFile;
  /** The gate in `run` (docs/design-graph-rehearsal.md §3.5): whether (and how) this run was rehearsed before it was intaken. Absent for runs intaken un-gated. */
  rehearsalGate?: IntakePin["rehearsalGate"];
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
    deps: Pick<RunRequest, "plugin" | "host" | "runner" | "validators" | "supervisor" | "proposalReviewer">,
  ): Promise<RunReport>;
}

/** Where durable run state lives when a caller names no `stateRoot` of its own. */
export function defaultStateRoot(repoPath: string): string {
  return path.join(repoPath, "graphloom-state");
}

export function createController(): Controller {
  return {
    async run(request: RunRequest): Promise<RunReport> {
      const taskIntake = await intakeTask(request.taskPath);
      const intake = request.rehearsalGate !== undefined ? { ...taskIntake, rehearsalGate: request.rehearsalGate } : taskIntake;
      const runId = assertSafeRunId(request.runId ?? randomUUID().slice(0, 12));
      const stateRoot = request.stateRoot ?? defaultStateRoot(intake.repoPath);
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
        const stopAfter = request.stopAfterStage !== undefined ? stageNamed(definition, request.stopAfterStage) : undefined;
        // Controller defaults < the graph's declared defaultBudgets < task budgets.
        const budgeted = applyGraphDefaultBudgets(intake, definition);

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
          intake: budgeted,
          definition,
          worktreePath,
          worktreeBranch: branchName,
          stateRoot,
          sourceDirtyBefore,
        });
        state = { ...state, stateFormat: CURRENT_STATE_FORMAT, ...(request.install !== undefined ? { install: { ...request.install } } : {}) };
        const executorCatalog = await pinExecutorCatalog(request.runner);
        if (executorCatalog !== undefined) state = { ...state, executorCatalog };
        revisionBridge.current = state.stateRevision;
        session.stateDir = state.stateDir;
        registerSession(session);
        await ensureArtifactDir(state);
        await clearStopRequest(state.stateDir);
        // Own the run before durable state says `running`, so a reader never sees
        // a running run without a live owner claim, however slow startup is.
        await claimRunOwner(state.stateDir);
        await saveRunState(state);
        await request.onRunCreated?.({ runId, stateDir: state.stateDir });
        if (supervisor === undefined && request.supervisorFactory !== undefined) {
          supervisor = await request.supervisorFactory({ runId, stateDir: state.stateDir });
        }

        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators,
          shouldStop: async () =>
            (await sessionStop(session)) ||
            (stopAfter !== undefined && stageComplete(await loadRunState(session.stateDir), stopAfter)),
          revisionBridge,
          ...(supervisor !== undefined ? { supervisor } : {}),
          ...(request.repair !== undefined ? { repair: request.repair } : {}),
          ...(request.proposalReviewer !== undefined ? { proposalReviewer: request.proposalReviewer } : {}),
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

      const stateFormats = request.stateFormats ?? STATE_FORMATS;
      // An upgrade reads the state in its own format, under the lock, before anything loads it as this release's.
      let state: DurableRunState =
        request.upgrade !== undefined ? (undefined as unknown as DurableRunState) : await loadCurrentFormat(stateDir, stateFormats);
      if (request.upgrade === undefined && (state.status === "succeeded" || state.status === "failed")) {
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
      // Whether `--upgrade` re-pinned executors (they then count as updated for the final-stop decision).
      let upgradeRepinned = false;
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
        if (request.upgrade !== undefined) {
          upgradeRepinned = await upgradeRun(stateDir, request.upgrade, {
            runner: request.runner,
            updatePlugin: request.updatePlugin === true,
            stateFormats,
            checkPluginUpdate: (current) => checkPluginUpdate(current, request),
          });
        }
        state = await loadCurrentFormat(stateDir, stateFormats);
        if (state.status === "succeeded" || state.status === "failed") {
          return;
        }
        // Evidence belongs to the stop being resumed; any stop from here on is a new one.
        // A pre-#120 run may carry `resumedSinceLastDecision`; nothing reads it
        // now, since the supervisor's first episode after resume starts a fresh
        // session and the case file marks what the resume made stale.
        // So are its class and mark (§8): a stop recorded from here on (a
        // preflight mismatch) is a new one, classified on its own, and they come
        // back only if this resume holds the original final stop.
        const heldStop = { stopEvidenceRefs: state.stopEvidenceRefs, stopClass: state.stopClass, stopMark: state.stopMark };
        const {
          stopEvidenceRefs: _staleEvidence,
          stopClass: _staleClass,
          stopMark: _staleMark,
          resumedSinceLastDecision: _resumed,
          ...resumable
        } = state as DurableRunState & { resumedSinceLastDecision?: boolean };
        void _staleEvidence;
        void _staleClass;
        void _staleMark;
        void _resumed;
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
          // The pinned config must still match its digest; the file on disk is never reread.
          taskConfigValue(state.intake);
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
        // §8: a retryable stop runs again; a final one surfaces the same
        // blocker until something it depends on changed.
        const pluginUpdated = pluginUpdate !== undefined;
        // An executor update that would re-pin something answers a final stop like a plugin update does.
        // One the check refuses runs on too, so the executor pin mismatch naming the executor surfaces instead of the old stop.
        // An upgrade that re-pinned executors already consumed their differences; it lifts a final stop the same way.
        const executorsUpdated =
          upgradeRepinned ||
          (request.updateExecutors === true &&
          (await verifyExecutorCatalog(state, request.runner, true).then(
            (check) => check !== undefined && ("blocker" in check || check.repins.length > 0),
            () => true,
          )));
        const live = await liveCandidateDigest(state).catch(() => state.candidateDigest);
        const asStopped: DurableRunState = {
          ...state,
          ...(heldStop.stopClass !== undefined ? { stopClass: heldStop.stopClass } : {}),
          ...(heldStop.stopMark !== undefined ? { stopMark: heldStop.stopMark } : {}),
        };
        const decided = decideResume(asStopped, { pluginUpdated, executorsUpdated, mark: stopMarkOf(state, live) });
        if (!decided.run) {
          state = recordRemedy(
            { ...asStopped, ...(heldStop.stopEvidenceRefs !== undefined ? { stopEvidenceRefs: heldStop.stopEvidenceRefs } : {}) },
            {
              condition: `resumed after a final stop (${decided.previous.kind}: ${state.stopReason ?? "stopped"})`,
              remedy: FINAL_STOP_HELD_REMEDY,
              ...(state.blocker !== undefined ? { detail: state.blocker.slice(0, 500) } : {}),
            },
          );
          await saveRunState(state);
          return;
        }
        if (decided.lifted !== undefined && decided.previous !== undefined) {
          state = recordRemedy(state, {
            condition: `resumed after a final stop (${decided.previous.kind}: ${state.stopReason ?? "stopped"})`,
            remedy: `ran the graph again: ${decided.lifted}`,
          });
        }
        // Refused before the run is claimed and marked running again.
        assertSupervisorRestorable(request, state);
        if (state.reconciliationRequired !== undefined) {
          const owed = state.reconciliationRequired;
          if (request.reconciled === true) {
            const { reconciliationRequired: _owed, ...rest } = state;
            void _owed;
            state = recordRemedy(rest, {
              condition: "harness quota hit after possible effects",
              remedy: `the operator reconciled job ${owed.operationId} (stage ${owed.stageId}) and resumed the graph`,
            });
          } else if (request.supervisor === undefined && request.supervisorFactory === undefined && state.supervisorBinding?.sessionFile === undefined) {
            state = {
              ...state,
              status: "stopped",
              stopReason: QUOTA_RECONCILE_STOP_REASON,
              blocker: boundText(`job ${owed.operationId} (stage ${owed.stageId}) may have had effects before the usage limit; reconcile it, then \`graphloom resume --reconciled\`: ${owed.reason}`),
            };
            await saveRunState(state);
            return;
          }
        }
        const stopped = state;
        // A trigger recorded before the stop is not current evidence: the
        // graph retries first, and recovery fires afresh if the failure recurs.
        state = returnToGraphOnResume(state);
        // The operator's resume restarts the graph, so its replayed decisions are not repeats.
        // The previous stop's reason and blocker are history once the run runs again (lastResume
        // keeps previousStopReason; remedies keep the condition), so they are not shown as current.
        const {
          noProgress: _repeats,
          stopClass: _class,
          stopMark: _mark,
          stopReason: _stopReason,
          blocker: _blocker,
          ...resumed
        } = state;
        void _stopReason;
        void _blocker;
        void _repeats;
        void _class;
        void _mark;
        state = bumpGeneration({ ...resumed, status: "running" }, "resume");
        state = {
          ...state,
          lastResume: resumeView(stopped, {
            generation: state.generation,
            pluginUpdated,
            ...(decided.previous !== undefined ? { previous: decided.previous } : {}),
          }),
        };
        await clearStopRequest(stateDir);
        // Own the run before durable state says `running` again (see `run`).
        await claimRunOwner(stateDir);
        try {
          await saveRunState(state);
        } catch (err) {
          // No later cleanup scope exists yet; a live claim would fence this process's later resumes.
          await clearOwnerClaim(stateDir);
          throw err;
        }

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
          assertDefinitionUnchanged(described.value, state.definition, pluginUpdate !== undefined);
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
        const executorCheck = await verifyExecutorCatalog(state, request.runner, request.updateExecutors === true).catch(
          (err: unknown) => ({ blocker: `executor catalog unreadable: ${err instanceof Error ? err.message : String(err)}` }),
        );
        if (executorCheck !== undefined && "blocker" in executorCheck) {
          state = { ...state, status: "stopped", stopReason: "executor pin mismatch", blocker: executorCheck.blocker };
          await saveRunState(state);
          return toReport(state, await listDirtyPaths(state.intake.repoPath));
        }
        const executorUpdate: { catalog: ExecutorCatalogEntry[]; repins: ExecutorRepin[] } | undefined = executorCheck;

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
          const versionNote =
            pluginUpdate.version !== state.intake.bundle.version ? `, version ${state.intake.bundle.version} -> ${pluginUpdate.version}` : "";
          const reason = `operator plugin update: manifest ${state.intake.bundle.manifestDigest.slice(0, 12)} -> ${pluginUpdate.manifestDigest.slice(0, 12)}${versionNote}${updated.note}`;
          // Findings the supervisor made about the old plugin code go stale here.
          state = refreshCaseFile({
            ...updated.state,
            intake: { ...updated.state.intake, bundle: pluginUpdate },
            activeVersion: `${pluginUpdate.graphId}@${pluginUpdate.version}`,
            definition: { ...updated.state.definition, version: pluginUpdate.version },
            versionHistory: [...(state.versionHistory ?? []), { activeVersion: state.activeVersion, generation: state.generation, reason, at: new Date().toISOString() }],
          });
          revisionBridge.current = state.stateRevision;
          await saveRunState(state);
        }

        if (executorUpdate !== undefined && executorUpdate.repins.length > 0) {
          state = applyExecutorRepin(state, executorUpdate.catalog, executorUpdate.repins);
          revisionBridge.current = state.stateRevision;
          await saveRunState(state);
        }

        const supervisor = await resolveResumeSupervisor(request, state, stateDir);
        if (supervisor && !request.supervisor) {
          restoredSupervisor = supervisor;
        }
        // A restored supervisor runs in a new episode session with its own
        // transcript. Record it before anything (a pending operator model
        // switch) journals against the binding: reconciling a crash reads the
        // transcript the switch actually changed.
        const restoredBinding = supervisor !== undefined ? readBinding(supervisor) : undefined;
        if (restoredBinding !== undefined && state.supervisorBinding !== undefined) {
          state = {
            ...state,
            supervisorBinding: {
              ...state.supervisorBinding,
              sessionId: restoredBinding.sessionId,
              provider: restoredBinding.provider,
              modelId: restoredBinding.modelId,
              ...(restoredBinding.sessionFile !== undefined ? { sessionFile: restoredBinding.sessionFile } : {}),
              ...(restoredBinding.configuredModels !== undefined ? { configuredModels: restoredBinding.configuredModels } : {}),
              ...(restoredBinding.harness !== undefined ? { harness: restoredBinding.harness } : {}),
            },
          };
          await saveRunState(state);
        }

        state = await runNormalLoop(state, {
          host,
          runner: request.runner,
          validators,
          shouldStop: () => sessionStop(session!),
          revisionBridge,
          ...(supervisor !== undefined ? { supervisor } : {}),
          ...(request.repair !== undefined ? { repair: request.repair } : {}),
          ...(request.proposalReviewer !== undefined ? { proposalReviewer: request.proposalReviewer } : {}),
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
      if (deps.proposalReviewer !== undefined) {
        resumeReq.proposalReviewer = deps.proposalReviewer;
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

      const invalidated = invalidateStageAndAfter(snapshot, stage.id, state.definition);
      // Discard routing state that may assume the invalidated prerequisites.
      // Resume's generation fence makes historical observations unavailable to
      // validation while preserving them for audit.
      const { privateState: _privateState, ...next } = invalidated;
      void _privateState;
      return {
        ...next,
        current: { stageId: stage.id, attempt: nextStageAttempt(state, stage.id) },
        stageAttempts: { ...state.stageAttempts, [stage.id]: nextStageAttempt(state, stage.id) },
      };
    }
  }
  const last = state.definition.stages.at(-1);
  if (last !== undefined && (await deliveryDrift(snapshot)) !== undefined) {
    const { privateState: _privateState, ...next } = invalidateStageAndAfter(snapshot, last.id, state.definition);
    void _privateState;
    return {
      ...next,
      current: { stageId: last.id, attempt: nextStageAttempt(state, last.id) },
      stageAttempts: { ...state.stageAttempts, [last.id]: nextStageAttempt(state, last.id) },
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
      const { privateState: _privateState, ...next } = invalidateStageAndAfter(state, stage.id, state.definition);
      void _privateState;
      return {
        state: {
          ...next,
          current: { stageId: stage.id, attempt: nextStageAttempt(state, stage.id) },
          stageAttempts: { ...state.stageAttempts, [stage.id]: nextStageAttempt(state, stage.id) },
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
  assertSupervisorRestorable(request, state);
  return request.restoreSupervisor!(binding, { runId: state.runId, stateDir });
}

/**
 * A run with a supervisor binding resumes only with a supervisor or a restore
 * for the bound harness: the controller has none of its own to fall back on.
 */
function assertSupervisorRestorable(request: ResumeRequest, state: DurableRunState): void {
  const binding = state.supervisorBinding;
  if (request.supervisor !== undefined || binding?.sessionFile === undefined || request.restoreSupervisor !== undefined) return;
  throw new Error(
    `run ${state.runId} has a ${bindingHarness(binding)} supervisor binding (session ${binding.sessionId}) but no restoreSupervisor was given to restore it`,
  );
}

function toSupervisorBinding(b: NonNullable<DurableRunState["supervisorBinding"]>): SupervisorBinding {
  return {
    sessionId: b.sessionId,
    sessionFile: b.sessionFile,
    provider: b.provider,
    modelId: b.modelId,
    switchJournal: b.switchJournal,
    ...(b.configuredModels !== undefined ? { configuredModels: b.configuredModels } : {}),
    ...(b.harness !== undefined ? { harness: b.harness } : {}),
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
  // The pinned copy, never the file on disk: every host this run opens,
  // including on resume and for a repair candidate, sees the same config.
  const config = taskConfigValue(args.intake);
  if (args.plugin) {
    return createInProcessPluginHost(args.plugin, {
      activeVersion: args.activeVersion,
      generation: args.generation,
      ...(config !== undefined ? { config } : {}),
    });
  }
  const entryModule = resolveBundleEntry(args.intake);
  return createChildPluginHost({
    entryModule,
    activeVersion: args.activeVersion,
    generation: args.generation,
    cwd: args.intake.bundle.bundlePath,
    env: sanitizedPluginEnv(args.intake.bundle.bundlePath),
    ...(config !== undefined ? { config } : {}),
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

/** §4.8: how many agent results checked against a declared contract landed valid, invalid, or repaired — overall and by contract name. */
function contractSummary(evidence: DurableRunState["evidence"]): InspectReport["contracts"] {
  const byName: Record<string, { valid: number; invalid: number; repaired: number }> = {};
  const totals = { valid: 0, invalid: 0, repaired: 0 };
  for (const e of evidence) {
    const contract = e.contract;
    if (contract === undefined) continue;
    const bucket = (byName[contract.name] ??= { valid: 0, invalid: 0, repaired: 0 });
    bucket[contract.status] += 1;
    totals[contract.status] += 1;
  }
  return { ...totals, byName };
}

/** Loads run state written in the format this controller writes; any other format is refused, unchanged. */
async function loadCurrentFormat(stateDir: string, formats: StateFormatRegistry): Promise<DurableRunState> {
  const raw = JSON.parse(await readFile(path.join(stateDir, "state.json"), "utf8")) as { runId?: string; stateFormat?: unknown };
  const format = stateFormatOf(raw);
  if (format > formats.current) {
    throw new Error(`run ${raw.runId ?? stateDir} is in state format ${format}, written by a newer GraphLoom; this one writes format ${formats.current}`);
  }
  if (format < formats.current) {
    throw new Error(`run ${raw.runId ?? stateDir} is in state format ${format}; resume it on the GraphLoom that owns it, or move it here with resume --upgrade`);
  }
  return loadRunState(stateDir);
}

/** A stage by id, or by name; refused when the definition has neither. */
function stageNamed(definition: GraphDefinition, ref: string): GraphDefinition["stages"][number] {
  const stage = definition.stages.find((s) => s.id === ref) ?? definition.stages.find((s) => s.name === ref);
  if (stage === undefined) {
    throw new Error(`no stage ${JSON.stringify(ref)} in graph ${definition.graphId}; its stages are ${definition.stages.map((s) => s.name).join(", ")}`);
  }
  return stage;
}

/** Every requirement of `stage` has a valid receipt. */
function stageComplete(state: DurableRunState, stage: GraphDefinition["stages"][number]): boolean {
  return stage.requirementIds.every((reqId) => state.receipts.some((r) => r.stageId === stage.id && r.requirementId === reqId && r.valid));
}

/**
 * `--upgrade --update-plugin`: the installed bundle must pass the
 * describe-compatibility checks a plugin update does on resume, decided
 * before the move commits. Returns why not, or undefined.
 */
async function checkPluginUpdate(state: DurableRunState, request: ResumeRequest): Promise<string | undefined> {
  let host: PluginHost | undefined;
  try {
    const installed = await readInstalledBundlePin(state.intake.bundle);
    const manifest = JSON.parse(installed.manifestRaw) as { sdkProtocol?: unknown };
    if (manifest.sdkProtocol !== PROTOCOL_VERSION) {
      return `the installed bundle speaks sdkProtocol ${String(manifest.sdkProtocol)}, not ${PROTOCOL_VERSION}`;
    }
    const intake: IntakePin = { ...state.intake, bundle: installed };
    host = await openHost({
      intake,
      activeVersion: state.activeVersion,
      generation: state.generation,
      ...(request.plugin !== undefined ? { plugin: request.plugin } : {}),
      ...(request.host !== undefined ? { host: request.host } : {}),
    });
    const described = await host.describe({ runId: state.runId, operationId: "describe-upgrade", expectedStateRevision: state.stateRevision });
    if (!described.ok) return `plugin describe failed: ${described.observation.message}`;
    assertDefinitionMatchesPin(described.value, intake);
    assertDefinitionUnchanged(described.value, state.definition, true);
    if (described.value.privateStateSchema !== state.definition.privateStateSchema) return "plugin privateStateSchema changed since run start";
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    // A caller's own host serves the resume after this; only a host opened here is closed.
    if (host !== undefined && request.host === undefined) await host.close().catch(() => undefined);
  }
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
    executorTransitions: structuredClone(state.executorTransitions ?? []),
    ...(state.install !== undefined ? { install: { ...state.install } } : {}),
    stateFormat: state.stateFormat ?? 1,
    installHistory: structuredClone(state.installHistory ?? []),
    stateMigrations: structuredClone(state.stateMigrations ?? []),
    hostChanges: structuredClone(state.hostChanges ?? []),
    activeVersion: state.activeVersion,
    generation: state.generation,
    worktreePath: state.worktreePath,
    stateDir: state.stateDir,
    contracts: contractSummary(state.evidence),
    dispatchesSinceReceipt: structuredClone(state.dispatchesSinceReceipt ?? {}),
    remedies: structuredClone(state.remedies ?? []),
    supervisorOutcomes: structuredClone(state.supervisorOutcomes ?? []),
    caseFile: structuredClone(state.caseFile ?? emptyCaseFile()),
  };
  if (state.status !== "running" && state.stopReason !== undefined) {
    report.stopReason = state.stopReason;
  }
  const stopClass = classifyStop(state);
  if (stopClass !== undefined) {
    report.stopRetryable = stopClass.retryable;
  }
  if (state.status !== "running" && state.blocker !== undefined) {
    report.blocker = state.blocker;
  }
  if (state.stopEvidenceRefs !== undefined) {
    report.stopEvidenceRefs = [...state.stopEvidenceRefs];
  }
  if (state.lastResume !== undefined) {
    report.lastResume = { ...state.lastResume };
  }
  if (state.intake.config !== undefined) {
    report.config = { path: state.intake.config.path, sha256: state.intake.config.sha256 };
  }
  if (state.intake.rehearsalGate !== undefined) {
    report.rehearsalGate = structuredClone(state.intake.rehearsalGate);
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

function assertDefinitionUnchanged(live: GraphDefinition, pinned: GraphDefinition, updating = false): void {
  // An operator plugin update may move to a new version of the same graph
  // (its version is checked against the newly pinned bundle instead).
  if (live.graphId !== pinned.graphId || (!updating && live.version !== pinned.version)) {
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
  const stopClass = classifyStop(state);
  if (stopClass !== undefined) {
    report.stopRetryable = stopClass.retryable;
  }
  if (state.blocker !== undefined) {
    report.blocker = state.blocker;
  }
  if (state.stopEvidenceRefs !== undefined) {
    report.stopEvidenceRefs = [...state.stopEvidenceRefs];
  }
  if (state.intake.rehearsalGate !== undefined) {
    report.rehearsalGate = structuredClone(state.intake.rehearsalGate);
  }
  return report;
}

export { applyGraphDefaultBudgets, CONTROLLER_DEFAULT_BUDGETS, defaultRecoveryReserve, intakeTask, parseTaskYaml, resolveRunBudgets, resolveUnderBase, taskConfigValue, IntakeError, MAX_TASK_CONFIG_BYTES } from "./intake.js";
export { admitValidation, freshEvidence } from "./admit.js";
export { toRunView, bumpGeneration, classifyAgentResult } from "./loop.js";
export type { ContractOutcome } from "./loop.js";
export { loadRunState, saveRunState } from "./state.js";
export type { DurableRunState, ExecutorTransitionRecord, HostChangeRecord, RemedyRecord, RunStatus, SupervisorOutcomeRecord, VersionRecord } from "./state.js";
export type { DeleteReport } from "./delete-run.js";
export type { IntakePin, TaskConfigPin } from "./intake.js";
export type {
  RepairDeps,
  RepairPatchAuthor,
  RepairReviewer,
  RepairPreflightResult,
  RecreateHostFn,
} from "./repair-lifecycle.js";
export { defaultRepairPreflight } from "./repair-lifecycle.js";
export { assertSafeRunId, assertSafeGraphId } from "./ids.js";
export { resolveBundleEntry, resolveBundleEntryFromManifest, resolveBundleRehearsalEntry } from "./bundle.js";

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
