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
  Validator,
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
  type EvidenceProducer,
} from "./admit.js";
import type { IntakePin } from "./intake.js";
import { assertSafeRunId } from "./ids.js";
import { withDirectoryLock } from "./lock.js";
import { type DurableRunState, saveRunState } from "./state.js";
import {
  readWorktreeFile,
  workspaceChangeManifest,
} from "./worktree.js";

const MAX_STEPS = 64;

export interface LoopDeps {
  /** Plugin decisions go through the host seam (in-process scripted or child). */
  host: PluginHost;
  runner: Runner;
  validators: Record<string, Validator>;
  /** Operator stop: checked each loop turn before advance. */
  shouldStop?: () => boolean;
}

export async function runNormalLoop(
  state: DurableRunState,
  deps: LoopDeps,
): Promise<DurableRunState> {
  // Hold a run-scoped execution lock for the whole loop so concurrent
  // controller processes cannot dual-dispatch the same revision.
  return withDirectoryLock(state.stateDir, "run.exec.lock", async () => {
    return runNormalLoopLocked(state, deps);
  });
}

async function runNormalLoopLocked(
  state: DurableRunState,
  deps: LoopDeps,
): Promise<DurableRunState> {
  if (state.pendingDispatch?.status === "pending") {
    state = {
      ...state,
      status: "stopped",
      stopReason: "reconcile required",
      blocker: `pending dispatch ${state.pendingDispatch.operationId} after restart`,
    };
    await saveRunState(state);
    return state;
  }

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (state.status !== "running") {
      await saveRunState(state);
      return state;
    }
    if (deps.shouldStop?.()) {
      state = {
        ...state,
        status: "stopped",
        stopReason: "operator stop",
        blocker: "stop requested",
      };
      await saveRunState(state);
      return state;
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
      if (deps.shouldStop?.()) {
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
      return state;
    }
    const decision = assertGraphDecision(advanced.value);
    state = await applyDecision(state, decision, deps);
    if (deps.shouldStop?.() && state.status === "running") {
      state = {
        ...state,
        status: "stopped",
        stopReason: "operator stop",
        blocker: "stop requested",
      };
    }
    await saveRunState(state);
  }

  state = {
    ...state,
    status: "stopped",
    stopReason: "step limit",
    blocker: `exceeded ${MAX_STEPS} controller steps`,
  };
  await saveRunState(state);
  return state;
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
      return dispatchJob(state, action.job, deps.runner);
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

async function dispatchJob(
  state: DurableRunState,
  job: JobSpec,
  runner: Runner,
): Promise<DurableRunState> {
  if (state.budgets.jobs <= 0) {
    return {
      ...state,
      status: "stopped",
      stopReason: "budgets exhausted",
      blocker: "jobs",
    };
  }
  if (job.kind === "agent" && state.budgets.agentInvocations <= 0) {
    return {
      ...state,
      status: "stopped",
      stopReason: "budgets exhausted",
      blocker: "agentInvocations",
    };
  }

  const isCorrection =
    job.purpose === "work" &&
    (state.current.attempt > 1 ||
      freshEvidence(state).some((e) => e.kind === "file" || e.kind === "workspace"));
  if (isCorrection && state.budgets.corrections <= 0) {
    return {
      ...state,
      status: "stopped",
      stopReason: "corrections budget exhausted",
      blocker: "dispatch correction",
    };
  }

  const operationId = `op-${state.stateRevision}-${randomUUID().slice(0, 8)}`;
  let next: DurableRunState = {
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
  // Persist intent before side effects so restart can reconcile instead of replay.
  await saveRunState(next);

  const result = await runner.runJob(job, {
    runId: state.runId,
    operationId,
    generation: state.generation,
    worktreePath: state.worktreePath,
    artifactDir: state.artifactDir,
  });

  if (
    result.runId !== state.runId ||
    result.operationId !== operationId ||
    result.generation !== state.generation
  ) {
    return {
      ...next,
      pendingDispatch: { ...next.pendingDispatch!, status: "failed" },
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
    pendingDispatch: { ...next.pendingDispatch!, status: "completed" },
    outstanding: next.outstanding.filter((o) => o.operationId !== operationId),
  };

  if (result.status !== "ok") {
    return {
      ...next,
      pendingDispatch: { ...next.pendingDispatch!, status: "failed" },
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

  // Clear completed intent after successful apply.
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
