import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceRecord,
  GraphDecision,
  GraphPlugin,
  JobSpec,
  ObserveSpec,
  RunView,
  Validator,
} from "@graphloom/sdk";
import { assertGraphDecision } from "@graphloom/sdk";
import type { Runner } from "@graphloom/runner";
import {
  admitValidation,
  freshEvidence,
  invalidateFromStage,
  newEvidenceRef,
} from "./admit.js";
import type { IntakePin } from "./intake.js";
import { type DurableRunState, saveRunState } from "./state.js";
import {
  readWorktreeFile,
  workspaceChangeManifest,
} from "./worktree.js";

const MAX_STEPS = 64;

export interface LoopDeps {
  plugin: GraphPlugin;
  runner: Runner;
  validators: Record<string, Validator>;
}

export async function runNormalLoop(
  state: DurableRunState,
  deps: LoopDeps,
): Promise<DurableRunState> {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (state.status !== "running") {
      await saveRunState(state);
      return state;
    }

    const view = toRunView(state);
    const decision = assertGraphDecision(deps.plugin.advance(view));
    state = await applyDecision(state, decision, deps);
    await saveRunState(state);
  }

  return {
    ...state,
    status: "stopped",
    stopReason: "step limit",
    blocker: `exceeded ${MAX_STEPS} controller steps`,
  };
}

export function toRunView(state: DurableRunState): RunView {
  const view: RunView = {
    runId: state.runId,
    task: {
      request: state.intake.task.request,
      repo: state.intake.task.repo,
    },
    current: state.current,
    receipts: structuredClone(state.receipts),
    evidence: structuredClone(state.evidence),
    outstanding: [],
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
      const result = admitValidation(state, action.validate, deps.validators);
      return result.state;
    }
    case "reenter": {
      let next = invalidateFromStage(state, action.reenter.stageId, state.definition);
      next = {
        ...next,
        current: {
          stageId: action.reenter.stageId,
          attempt:
            state.current.stageId === action.reenter.stageId
              ? state.current.attempt + 1
              : 1,
        },
        // Drop stale evidence from prior generation for freshness after reentry.
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
          state.receipts.some((r) => r.stageId === s.id && r.valid),
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
  if (state.budgets.jobs <= 0 || state.budgets.agentInvocations <= 0) {
    return {
      ...state,
      status: "stopped",
      stopReason: "budgets exhausted",
      blocker: "jobs or agentInvocations",
    };
  }

  const result = await runner.runJob(job, {
    runId: state.runId,
    generation: state.generation,
    worktreePath: state.worktreePath,
    artifactDir: state.artifactDir,
  });

  let next: DurableRunState = {
    ...state,
    budgets: {
      ...state.budgets,
      jobs: state.budgets.jobs - 1,
      agentInvocations: state.budgets.agentInvocations - 1,
    },
    current: { stageId: job.stageId, attempt: state.current.attempt },
  };

  if (result.status !== "ok") {
    return {
      ...next,
      status: "stopped",
      stopReason: `job failed: ${result.summary}`,
      blocker: result.status,
    };
  }

  if (result.evidence) {
    const added: EvidenceRecord[] = [];
    for (const item of result.evidence) {
      const ref = newEvidenceRef(next);
      const record: EvidenceRecord = {
        ref,
        kind: item.kind,
        generation: next.generation,
      };
      if (item.payload !== undefined) {
        record.payload = item.payload;
      }
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

async function observeWorkspace(
  state: DurableRunState,
  spec: ObserveSpec,
): Promise<DurableRunState> {
  const added: EvidenceRecord[] = [];
  let next = { ...state };

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
    const ref = newEvidenceRef(next);
    added.push({
      ref,
      kind: "workspace",
      generation: next.generation,
      payload: { changedPaths },
      fingerprint: hash(JSON.stringify(changedPaths)),
    });
  }

  return {
    ...next,
    evidence: [...next.evidence, ...added],
    evidenceSeq: next.evidenceSeq,
    stateRevision: next.stateRevision + 1,
  };
}

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function initialState(args: {
  runId: string;
  intake: IntakePin;
  definition: ReturnType<GraphPlugin["describe"]>;
  worktreePath: string;
  worktreeBranch: string;
  stateRoot: string;
  sourceDirtyBefore: string[];
}): DurableRunState {
  const stateDir = path.join(args.stateRoot, args.runId);
  const artifactDir = path.join(stateDir, "artifacts");
  const firstStage = args.definition.stages[0];
  if (!firstStage) {
    throw new Error("graph definition has no stages");
  }
  return {
    runId: args.runId,
    status: "running",
    generation: 1,
    stateRevision: 0,
    activeVersion: `${args.intake.bundle.graphId}@${args.intake.bundle.version}`,
    mode: "normal",
    current: { stageId: firstStage.id, attempt: 1 },
    receipts: [],
    evidence: [],
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
  };
}

export async function ensureArtifactDir(state: DurableRunState): Promise<void> {
  await mkdir(state.artifactDir, { recursive: true });
  await mkdir(state.stateDir, { recursive: true });
}

/** Exported for restart tests: bump generation so prior evidence is stale. */
export function bumpGeneration(state: DurableRunState): DurableRunState {
  return {
    ...state,
    generation: state.generation + 1,
    stateRevision: state.stateRevision + 1,
  };
}

export { freshEvidence };
