import path from "node:path";
import type { GraphDefinition, QualifyRepairSpec, ActivateRepairSpec } from "@graphloom/sdk";
import type { Supervisor } from "@graphloom/supervisor";
import { invalidateFromStage, type AdmissionValidator } from "./admit.js";
import {
  assertCandidateStepsUnchanged,
  digestDirectoryTree,
  snapshotRepairCandidate,
  type QualifiedRepairArtifact,
} from "./repair.js";
import type { DurableRunState } from "./state.js";
import { bumpGeneration } from "./generation.js";

export interface RepairPatchAuthor {
  /** Must equal the run supervisor session id for every repair round. */
  sessionId: string;
  patch(args: {
    candidateRoot: string;
    target: "plugin" | "validator";
    reason: string;
  }): Promise<{ summary: string }>;
}

export interface RepairReviewer {
  /** Must differ from the patch author / supervisor session id. */
  sessionId: string;
  review(args: {
    candidateRoot: string;
    baseDigest: string;
    candidateDigest: string;
    target: "plugin" | "validator";
  }): Promise<{ approved: boolean; reason: string }>;
}

export interface RepairDeps {
  patchAuthor: RepairPatchAuthor;
  reviewer: RepairReviewer;
  /**
   * Optional: after activation, replace in-process validators from the candidate.
   * Child hosts rely on recreateHost + new bundle path instead.
   */
  materializeValidators?: (
    candidateRoot: string,
  ) => Record<string, AdmissionValidator> | undefined;
}

export async function applyQualifyRepair(
  state: DurableRunState,
  qualify: QualifyRepairSpec,
  deps: {
    supervisor?: Supervisor;
    repair: RepairDeps;
    validators: Record<string, AdmissionValidator>;
  },
): Promise<DurableRunState> {
  if (state.mode !== "recovery") {
    return {
      ...state,
      status: "stopped",
      stopReason: "qualify_repair outside recovery",
      blocker: qualify.reason,
    };
  }
  if (state.budgets.corrections <= 0) {
    return {
      ...state,
      status: "stopped",
      stopReason: "corrections budget exhausted",
      blocker: "qualify_repair",
    };
  }

  const supervisorSessionId = readSupervisorSessionId(deps.supervisor);
  if (!supervisorSessionId) {
    return {
      ...state,
      status: "stopped",
      stopReason: "qualify_repair requires a durable supervisor session",
      blocker: "no supervisor session id",
    };
  }
  if (deps.repair.patchAuthor.sessionId !== supervisorSessionId) {
    return {
      ...state,
      status: "stopped",
      stopReason: "patch author must use the run supervisor session",
      blocker: `patch=${deps.repair.patchAuthor.sessionId} supervisor=${supervisorSessionId}`,
    };
  }
  if (deps.repair.reviewer.sessionId === supervisorSessionId) {
    return {
      ...state,
      status: "stopped",
      stopReason: "independent review cannot use the supervisor session",
      blocker: deps.repair.reviewer.sessionId,
    };
  }

  const repairsDir = path.join(state.stateDir, "repairs");
  const snap = await snapshotRepairCandidate({
    bundlePath: state.intake.bundle.bundlePath,
    repairsDir,
    baseActiveVersion: state.activeVersion,
    target: qualify.target,
    reason: qualify.reason,
  });
  await writeStagesPin(snap.candidateRoot, state.definition);

  // Same logical supervisor session for every repair round.
  await deps.supervisor?.grantCandidateCoding?.(snap.candidateRoot);

  try {
    await deps.repair.patchAuthor.patch({
      candidateRoot: snap.candidateRoot,
      target: qualify.target,
      reason: qualify.reason,
    });

    await assertCandidateStepsUnchanged({
      baseDefinitionStages: state.definition.stages.map((s) => ({
        id: s.id,
        name: s.name,
        requirementIds: [...s.requirementIds],
      })),
      candidateRoot: snap.candidateRoot,
    });

    // Write a stages pin from the active definition so future edits are checked.
    // (Snapshot may not include this file; patch authors must not invent stages.)

    const candidateDigest = await digestDirectoryTree(snap.candidateRoot);
    const review = await deps.repair.reviewer.review({
      candidateRoot: snap.candidateRoot,
      baseDigest: snap.baseDigest,
      candidateDigest,
      target: qualify.target,
    });

    const artifact: QualifiedRepairArtifact = {
      ...snap,
      status: review.approved ? "qualified" : "rejected",
      candidateDigest,
      patchAuthorSessionId: supervisorSessionId,
      reviewerSessionId: deps.repair.reviewer.sessionId,
      reviewReason: review.reason,
      ...(review.approved
        ? { qualifiedAt: new Date().toISOString() }
        : { rejectionReason: review.reason }),
    };

    const candidates = [...(state.repairCandidates ?? []), artifact];
    if (!review.approved) {
      return {
        ...state,
        repairCandidates: candidates,
        budgets: {
          ...state.budgets,
          corrections: state.budgets.corrections - 1,
        },
        // Stay in recovery so the same supervisor session can try another round.
      };
    }

    return {
      ...state,
      repairCandidates: candidates,
      budgets: {
        ...state.budgets,
        corrections: state.budgets.corrections - 1,
      },
    };
  } finally {
    await deps.supervisor?.revokeCandidateCoding?.();
  }
}

export async function applyActivateRepair(
  state: DurableRunState,
  activate: ActivateRepairSpec,
  deps: {
    repair: RepairDeps;
    validators: Record<string, AdmissionValidator>;
    recreateHost?: () => Promise<unknown>;
  },
): Promise<{ state: DurableRunState; validators: Record<string, AdmissionValidator> }> {
  if (state.mode !== "recovery") {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "activate_repair outside recovery",
        blocker: activate.reason,
      },
      validators: deps.validators,
    };
  }

  const candidates = [...(state.repairCandidates ?? [])];
  const idx = candidates.findIndex((c) => c.artifactId === activate.qualifiedArtifactId);
  const artifact = idx >= 0 ? candidates[idx] : undefined;
  if (!artifact || artifact.status !== "qualified") {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "activate_repair missing qualified artifact",
        blocker: activate.qualifiedArtifactId,
      },
      validators: deps.validators,
    };
  }

  // Base must still match the live install; concurrent activation of another candidate
  // would have moved the pin / changed the tree digest.
  const liveDigest = await digestDirectoryTree(state.intake.bundle.bundlePath);
  if (liveDigest !== artifact.baseDigest) {
    candidates[idx] = { ...artifact, status: "superseded" };
    return {
      state: {
        ...state,
        repairCandidates: candidates,
        status: "stopped",
        stopReason: "activate_repair base mismatch",
        blocker: "active pin no longer matches candidate base snapshot",
      },
      validators: deps.validators,
    };
  }

  const toVersion = `${state.intake.bundle.graphId}@repair-${artifact.artifactId}`;
  const intent = {
    artifactId: artifact.artifactId,
    fromVersion: state.activeVersion,
    toVersion,
    generation: state.generation + 1,
    at: new Date().toISOString(),
    status: "intent" as const,
  };

  let next: DurableRunState = {
    ...state,
    activationIntent: intent,
  };

  const materialized = deps.repair.materializeValidators?.(artifact.candidateRoot);
  let validators = deps.validators;
  if (materialized) {
    validators = { ...deps.validators, ...materialized };
  }

  // Commit version switch + invalidate bindings under the same state revision.
  candidates[idx] = { ...artifact, status: "activated" };
  // Supersede other qualified peers so only one activation owns the run.
  for (let i = 0; i < candidates.length; i++) {
    if (i !== idx && candidates[i]?.status === "qualified") {
      candidates[i] = { ...candidates[i]!, status: "superseded" };
    }
  }

  next = {
    ...next,
    repairCandidates: candidates,
    activeVersion: toVersion,
    activationIntent: { ...intent, status: "committed" },
    intake: {
      ...next.intake,
      bundle: {
        ...next.intake.bundle,
        // Point the run at the candidate tree for subsequent child loads.
        bundlePath: artifact.candidateRoot,
      },
    },
  };

  // Validator repairs typically invalidate Write and everything after.
  const earliest = next.definition.stages[0]?.id ?? next.current.stageId;
  next = invalidateFromStage(next, earliest, next.definition);
  next = {
    ...next,
    current: { stageId: earliest, attempt: 1 },
  };
  next = bumpGeneration(next, `activate_repair:${artifact.artifactId}`);

  if (deps.recreateHost) {
    await deps.recreateHost();
  }

  return { state: next, validators };
}

function readSupervisorSessionId(supervisor: Supervisor | undefined): string | undefined {
  if (!supervisor) return undefined;
  const withBinding = supervisor as Supervisor & {
    binding?: { sessionId?: string };
    sessionId?: string;
  };
  return withBinding.binding?.sessionId ?? withBinding.sessionId;
}

/** Ensure a stages pin exists so step-mutation checks apply after the first qualify. */
export async function writeStagesPin(
  candidateRoot: string,
  definition: GraphDefinition,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    path.join(candidateRoot, "graphloom.stages.json"),
    JSON.stringify(
      {
        stages: definition.stages.map((s) => ({
          id: s.id,
          name: s.name,
          requirementIds: s.requirementIds,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
}
