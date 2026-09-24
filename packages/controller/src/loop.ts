import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceRecord,
  GraphDecision,
  GraphDefinition,
  JobSpec,
  ObserveSpec,
  RunView,
} from "@graphloom/sdk";
import { assertGraphDecision } from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import type { PluginHost } from "@graphloom/plugin-host";
import type { Supervisor } from "@graphloom/supervisor";
import {
  admitValidation,
  earliestIncompleteStage,
  freshEvidence,
  invalidateFromStage,
  newEvidenceRef,
  stageRequirementsMet,
  type AdmissionValidator,
  type EvidenceProducer,
} from "./admit.js";
import { HostObservationError } from "./host-validators.js";
import type { IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import {
  claimRunOwner,
  clearOwnerClaim,
  renewRunOwner,
  updateOwnerChildPid,
  type RunOwnerClaim,
} from "./owner.js";
import { reconcilePendingDispatch } from "./reconcile.js";
import { loadRunState, type DurableRunState, saveRunState } from "./state.js";
import {
  readWorktreeFile,
  workspaceChangeManifest,
} from "./worktree.js";

const MAX_STEPS = 64;

export interface LoopDeps {
  /** Plugin decisions go through the host seam (in-process scripted or child). */
  host: PluginHost;
  runner: Runner;
  validators: Record<string, AdmissionValidator>;
  /** Optional recovery decision source; required to continue past Supervise / host failure. */
  supervisor?: Supervisor;
  /**
   * Replace a dead child plugin process after crash/timeout.
   * Required when recovering past a host that exposes `childPid`.
   */
  recreateHost?: () => Promise<PluginHost>;
  /** Operator stop: checked each loop turn before advance (sync or async). */
  shouldStop?: () => boolean | Promise<boolean>;
  /** Live revision bridge for host-backed validators. */
  revisionBridge?: { current: number };
}

async function stopRequested(deps: LoopDeps): Promise<boolean> {
  return Boolean(await Promise.resolve(deps.shouldStop?.() ?? false));
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
  return runNormalLoopSteps(state, deps);
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
): Promise<DurableRunState> {
  let owner: RunOwnerClaim | undefined;
  try {
    state = await withRunLock(state.stateDir, async () => {
      owner = await claimRunOwner(state.stateDir, {
        ...(deps.host.childPid !== undefined ? { childPid: deps.host.childPid } : {}),
      });
      if (state.pendingDispatch?.status === "pending") {
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
      syncRevision(deps, state);
      return state;
    });

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const turn = await withRunLock(state.stateDir, async () => {
        // Reload before renewing: Stop may have cleared the owner claim and
        // persisted stopped while a runner job held no lock.
        state = await reloadRunState(state);
        syncRevision(deps, state);

        if (state.status !== "running") {
          return { done: true as const, state };
        }
        if (await stopRequested(deps)) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "operator stop",
            blocker: "stop requested",
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
          const view = toRunView(state);
          const decided = await deps.supervisor.decide({
            runId: state.runId,
            episodeId,
            trigger: {
              code: trigger.code as
                | "supervise"
                | "plugin_crash"
                | "plugin_timeout"
                | "plugin_malformed"
                | "stalled"
                | "unhandled",
              message: trigger.message,
            },
            view,
          });
          decision = assertGraphDecision(decided);
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
        }

        if (decision.action.type === "dispatch") {
          const prepared = await prepareDispatch(state, decision, deps);
          await saveRunState(prepared.state);
          syncRevision(deps, prepared.state);
          if (prepared.state.status !== "running" || !prepared.pending) {
            return { done: true as const, state: prepared.state };
          }
          return {
            done: false as const,
            state: prepared.state,
            pendingJob: prepared.pending,
          };
        }

        try {
          state = await applyDecision(state, decision, deps);
        } catch (err) {
          if (err instanceof HostObservationError) {
            const contained = await containHostFailure(
              state,
              deps,
              err.code,
              err.message,
            );
            await saveRunState(contained.state);
            syncRevision(deps, contained.state);
            return { done: contained.done, state: contained.state };
          }
          throw err;
        }
        syncRevision(deps, state);
        if ((await stopRequested(deps)) && state.status === "running") {
          state = {
            ...state,
            status: "stopped",
            stopReason: "operator stop",
            blocker: "stop requested",
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
        const { job, operationId, generation, isCorrection } = turn.pendingJob;
        const result = await deps.runner.runJob(job, {
          runId: state.runId,
          operationId,
          generation,
          worktreePath: state.worktreePath,
          artifactDir: state.artifactDir,
        });

        state = await withRunLock(state.stateDir, async () => {
          state = await reloadRunState(state);
          syncRevision(deps, state);
          if (await stopRequested(deps) || state.status !== "running") {
            if (state.status === "running") {
              state = {
                ...state,
                status: "stopped",
                stopReason: "operator stop",
                blocker: "stop requested",
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
          state = applyDispatchResult(state, {
            job,
            operationId,
            generation,
            isCorrection,
            result,
          });
          syncRevision(deps, state);
          if ((await stopRequested(deps)) && state.status === "running") {
            state = {
              ...state,
              status: "stopped",
              stopReason: "operator stop",
              blocker: "stop requested",
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
  } finally {
    await clearOwnerClaim(state.stateDir);
  }
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
): DurableRunState {
  return {
    ...state,
    mode: "recovery",
    status: "running",
    recoveryEpisodeId: `ep-${randomUUID().slice(0, 8)}`,
    recoveryTrigger: { code, message },
  };
}

/**
 * After crash/timeout the child process is dead. Replace it before recovery
 * continues so Return can advance again. In-process hosts need no restart.
 */
async function restartDeadChildHost(
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
    deps.host = await deps.recreateHost();
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
        stopReason: "operator stop",
        blocker: "stop requested",
      },
    };
  }
  const code = mapHostFailureCode(observationCode);
  if (deps.supervisor) {
    const restarted = await restartDeadChildHost(deps, code);
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
  if (state.privateState !== undefined) {
    view.privateState = state.privateState;
  }
  if (state.recoveryEpisodeId !== undefined) {
    view.recoveryEpisodeId = state.recoveryEpisodeId;
  }
  return view;
}

async function applyDecision(
  state: DurableRunState,
  decision: GraphDecision,
  deps: LoopDeps,
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
      const result = await admitValidation(state, action.validate, deps.validators);
      return result.state;
    }
    case "reenter": {
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
      return enterRecovery(state, "supervise", action.supervise.reason);
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
        ...rest
      } = state;
      void _ep;
      void _tr;
      void _sr;
      void _bl;
      return {
        ...rest,
        mode: "normal",
        status: "running",
      };
    }
    case "stop": {
      const complete =
        action.stop.reason === "complete" &&
        state.definition.stages.every((s) =>
          stageRequirementsMet(state, s.id, s.requirementIds),
        );
      return {
        ...state,
        status: complete ? "succeeded" : "stopped",
        stopReason: action.stop.reason,
        blocker: action.stop.blocker,
      };
    }
    default:
      return {
        ...state,
        status: "stopped",
        stopReason: `unsupported action in ${state.mode} mode: ${action.type}`,
        blocker: action.type,
      };
  }
}

interface PendingJob {
  job: JobSpec;
  operationId: string;
  generation: number;
  isCorrection: boolean;
}

async function prepareDispatch(
  state: DurableRunState,
  decision: GraphDecision,
  _deps: LoopDeps,
): Promise<{ state: DurableRunState; pending?: PendingJob }> {
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

  const job = decision.action.type === "dispatch" ? decision.action.job : undefined;
  if (!job) {
    throw new Error("prepareDispatch requires dispatch action");
  }

  if (state.budgets.jobs <= 0) {
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
    job.purpose === "work" &&
    (state.mode === "recovery" ||
      state.current.attempt > 1 ||
      freshEvidence(state).some((e) => e.kind === "file" || e.kind === "workspace"));
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

  const operationId = `op-${state.stateRevision}-${randomUUID().slice(0, 8)}`;
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
      status: "pending",
    },
    current: { stageId: job.stageId, attempt: state.current.attempt },
  };

  return {
    state: next,
    pending: { job, operationId, generation: state.generation, isCorrection },
  };
}

function applyDispatchResult(
  state: DurableRunState,
  args: {
    job: JobSpec;
    operationId: string;
    generation: number;
    isCorrection: boolean;
    result: Awaited<ReturnType<Runner["runJob"]>>;
  },
): DurableRunState {
  const { job, operationId, generation, isCorrection, result } = args;
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
      jobs: next.budgets.jobs - 1,
      agentInvocations:
        job.kind === "agent"
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

  if (result.status !== "ok") {
    const { pendingDispatch, ...rest } = next;
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

  if (result.evidence) {
    const added: EvidenceRecord[] = [];
    const producer: EvidenceProducer = {
      operationId,
      stageId: job.stageId,
      purpose: job.purpose,
      readOnly: job.readOnly === true,
      kind: job.kind,
    };
    for (const item of result.evidence) {
      const ref = newEvidenceRef(next);
      const record: EvidenceRecord = {
        ref,
        kind: item.kind,
        generation: next.generation,
      };
      record.payload = attachProducer(item.payload, producer);
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

  if (job.purpose === "work") {
    next = { ...next, lastWorkOperationId: operationId };
  }

  const { pendingDispatch: _done, ...cleared } = next;
  void _done;
  return cleared;
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
  let next = { ...state };
  let workspaceFp: string | undefined;

  for (const rel of spec.paths ?? []) {
    const bytes = await readWorktreeFile(state.worktreePath, rel);
    const ref = newEvidenceRef(next);
    added.push({
      ref,
      kind: "file",
      generation: next.generation,
      payload: { path: rel, bytes: bytes ?? "" },
      fingerprint: bytes === undefined ? "missing" : hash(bytes),
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
export function bumpGeneration(
  state: DurableRunState,
  reason = "generation fence",
): DurableRunState {
  const { workspaceRevision: _wr, ...rest } = state;
  void _wr;
  const generation = state.generation + 1;
  return {
    ...rest,
    generation,
    stateRevision: state.stateRevision + 1,
    versionHistory: [
      ...(state.versionHistory ?? []),
      {
        activeVersion: state.activeVersion,
        generation,
        reason,
        at: new Date().toISOString(),
      },
    ],
  };
}

export { freshEvidence, earliestIncompleteStage };
export { candidateEvidence } from "./admit.js";
