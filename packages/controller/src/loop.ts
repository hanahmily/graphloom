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
import type { IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
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
  /** Operator stop: checked each loop turn before advance (sync or async). */
  shouldStop?: () => boolean | Promise<boolean>;
}

async function stopRequested(deps: LoopDeps): Promise<boolean> {
  return Boolean(await Promise.resolve(deps.shouldStop?.() ?? false));
}

export async function runNormalLoop(
  state: DurableRunState,
  deps: LoopDeps,
): Promise<DurableRunState> {
  // Per-step lock so Stop/Resume can coordinate during long runner jobs.
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
  state = await withRunLock(state.stateDir, async () => {
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
    return state;
  });

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const turn = await withRunLock(state.stateDir, async () => {
      // Reload in case Stop mutated durable state while we were unlocked.
      state = await reloadIfPresent(state);

      if (state.status !== "running") {
        await saveRunState(state);
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
        if (await stopRequested(deps)) {
          state = {
            ...state,
            status: "stopped",
            stopReason: "operator stop",
            blocker: "stop requested",
          };
        } else {
          state = {
            ...state,
            status: "stopped",
            stopReason: `plugin host: ${advanced.observation.code}`,
            blocker: advanced.observation.message,
          };
        }
        await saveRunState(state);
        return { done: true as const, state };
      }
      const decision = assertGraphDecision(advanced.value);

      if (decision.action.type === "dispatch") {
        const prepared = await prepareDispatch(state, decision, deps);
        await saveRunState(prepared.state);
        if (prepared.state.status !== "running" || !prepared.pending) {
          return { done: true as const, state: prepared.state };
        }
        return {
          done: false as const,
          state: prepared.state,
          pendingJob: prepared.pending,
        };
      }

      state = await applyDecision(state, decision, deps);
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
        state = await reloadIfPresent(state);
        if (await stopRequested(deps) || state.status !== "running") {
          // Operator stop won the lock; keep durable stopped / pending for reconcile.
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
}

async function reloadIfPresent(state: DurableRunState): Promise<DurableRunState> {
  try {
    return await loadRunState(state.stateDir);
  } catch {
    return state;
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
  return view;
}

async function applyDecision(
  state: DurableRunState,
  decision: GraphDecision,
  deps: LoopDeps,
): Promise<DurableRunState> {
  if (decision.privateState !== undefined) {
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
        generation: state.generation + 1,
      };
      return next;
    }
    case "supervise":
      return {
        ...state,
        status: "stopped",
        mode: "recovery",
        stopReason: action.supervise.reason,
        blocker: "supervisor not implemented in this ticket",
      };
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
        stopReason: `unsupported action in normal mode: ${action.type}`,
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
  if (decision.privateState !== undefined) {
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
    (state.current.attempt > 1 ||
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
