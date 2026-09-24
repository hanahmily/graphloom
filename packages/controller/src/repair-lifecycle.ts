import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GraphDefinition, QualifyRepairSpec, ActivateRepairSpec } from "@graphloom/sdk";
import type { Supervisor } from "@graphloom/supervisor";
import type { PluginHost } from "@graphloom/plugin-host";
import { invalidateFromStage, type AdmissionValidator } from "./admit.js";
import { resolveBundleEntryFromManifest } from "./bundle.js";
import {
  assertCandidateStepsUnchanged,
  digestDirectoryTree,
  snapshotRepairCandidate,
  type QualifiedRepairArtifact,
} from "./repair.js";
import type { DurableRunState } from "./state.js";
import { bumpGeneration } from "./generation.js";
import { saveRunState } from "./state.js";

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

export interface RepairPreflightResult {
  ok: boolean;
  summary: string;
  /** Optional describe() of the candidate for contract comparison. */
  definition?: GraphDefinition;
}

export interface RepairDeps {
  patchAuthor: RepairPatchAuthor;
  reviewer: RepairReviewer;
  /**
   * Controller-mediated build/test/contract checks before independent review.
   * Required so a reviewer cannot approve an uncompilable or contract-breaking candidate.
   */
  preflight: (args: {
    candidateRoot: string;
    target: "plugin" | "validator";
    baseDefinition: GraphDefinition;
  }) => Promise<RepairPreflightResult>;
  /**
   * Optional: after activation, replace in-process validators from the candidate.
   * Child hosts rely on recreateHost + new bundle path instead.
   */
  materializeValidators?: (
    candidateRoot: string,
  ) => Record<string, AdmissionValidator> | undefined;
}

export type RecreateHostFn = (args: {
  intake: DurableRunState["intake"];
  activeVersion: string;
  generation: number;
}) => Promise<PluginHost>;

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

  const grantOk =
    qualify.target === "plugin"
      ? state.intake.grants.sourceRepair
      : state.intake.grants.validatorSubstitution;
  if (!grantOk) {
    return {
      ...state,
      status: "stopped",
      stopReason: "qualify_repair missing operator grant",
      blocker:
        qualify.target === "plugin"
          ? "sourceRepair grant is false"
          : "validatorSubstitution grant is false",
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

    const preflight = await deps.repair.preflight({
      candidateRoot: snap.candidateRoot,
      target: qualify.target,
      baseDefinition: state.definition,
    });
    if (!preflight.ok) {
      const artifact: QualifiedRepairArtifact = {
        ...snap,
        status: "rejected",
        candidateDigest: await digestDirectoryTree(snap.candidateRoot),
        patchAuthorSessionId: supervisorSessionId,
        reviewerSessionId: deps.repair.reviewer.sessionId,
        reviewReason: preflight.summary,
        rejectionReason: preflight.summary,
        preflightSummary: preflight.summary,
      };
      return {
        ...state,
        repairCandidates: [...(state.repairCandidates ?? []), artifact],
        budgets: {
          ...state.budgets,
          corrections: state.budgets.corrections - 1,
        },
      };
    }

    if (preflight.definition) {
      assertCandidateDefinitionCompatible(preflight.definition, state.definition);
    }

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
      preflightSummary: preflight.summary,
      ...(review.approved
        ? { qualifiedAt: new Date().toISOString() }
        : { rejectionReason: review.reason }),
    };

    const candidates = [...(state.repairCandidates ?? []), artifact];
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
    recreateHost?: RecreateHostFn;
  },
): Promise<{
  state: DurableRunState;
  validators: Record<string, AdmissionValidator>;
  host?: PluginHost;
}> {
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

  if (artifact.baseActiveVersion !== state.activeVersion) {
    candidates[idx] = { ...artifact, status: "superseded" };
    return {
      state: {
        ...state,
        repairCandidates: candidates,
        status: "stopped",
        stopReason: "activate_repair base version mismatch",
        blocker: `expected active ${artifact.baseActiveVersion}, got ${state.activeVersion}`,
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

  if (!artifact.candidateDigest) {
    return {
      state: {
        ...state,
        status: "stopped",
        stopReason: "activate_repair missing candidate digest",
        blocker: artifact.artifactId,
      },
      validators: deps.validators,
    };
  }

  // Recompute so post-review edits cannot activate under a stale approval.
  const liveCandidateDigest = await digestDirectoryTree(artifact.candidateRoot);
  if (liveCandidateDigest !== artifact.candidateDigest) {
    candidates[idx] = { ...artifact, status: "superseded" };
    return {
      state: {
        ...state,
        repairCandidates: candidates,
        status: "stopped",
        stopReason: "activate_repair candidate digest mismatch",
        blocker: "candidate changed after independent review",
      },
      validators: deps.validators,
    };
  }

  // Stages pin must still match — cannot be deleted after review.
  await assertCandidateStepsUnchanged({
    baseDefinitionStages: state.definition.stages.map((s) => ({
      id: s.id,
      name: s.name,
      requirementIds: [...s.requirementIds],
    })),
    candidateRoot: artifact.candidateRoot,
  });

  const toVersion = `${state.intake.bundle.graphId}@repair-${artifact.artifactId}`;
  const intent = {
    artifactId: artifact.artifactId,
    fromVersion: state.activeVersion,
    toVersion,
    generation: state.generation + 1,
    at: new Date().toISOString(),
    status: "intent" as const,
  };

  // Persist intent under the run lock (caller holds it) before effects so resume
  // can reconcile a crash mid-activation.
  let next: DurableRunState = {
    ...state,
    activationIntent: intent,
  };
  await saveRunState(next);

  const materialized = deps.repair.materializeValidators?.(artifact.candidateRoot);
  let validators = deps.validators;
  if (materialized) {
    validators = { ...deps.validators, ...materialized };
  }

  // Commit version switch + validator bindings under the same state revision.
  candidates[idx] = { ...artifact, status: "activated" };
  // Supersede other qualified peers so only one activation owns the run.
  for (let i = 0; i < candidates.length; i++) {
    if (i !== idx && candidates[i]?.status === "qualified") {
      candidates[i] = { ...candidates[i]!, status: "superseded" };
    }
  }

  const candidatePin = await readCandidateBundlePin(artifact.candidateRoot, state.intake);

  next = {
    ...next,
    repairCandidates: candidates,
    activeVersion: toVersion,
    activationIntent: { ...intent, status: "committed" },
    intake: {
      ...next.intake,
      bundle: candidatePin,
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

  let host: PluginHost | undefined;
  if (deps.recreateHost) {
    host = await deps.recreateHost({
      intake: next.intake,
      activeVersion: next.activeVersion,
      generation: next.generation,
    });
  }

  return { state: next, validators, ...(host !== undefined ? { host } : {}) };
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

/** Candidate describe() must preserve pinned stages, requirements, and bindings. */
export function assertCandidateDefinitionCompatible(
  candidate: GraphDefinition,
  base: GraphDefinition,
): void {
  if (candidate.graphId !== base.graphId) {
    throw new Error(
      `candidate graphId ${candidate.graphId} != pinned ${base.graphId}`,
    );
  }
  if (JSON.stringify(candidate.stages) !== JSON.stringify(base.stages)) {
    throw new Error("candidate describe() alters pinned stages");
  }
  if (JSON.stringify(candidate.requirements) !== JSON.stringify(base.requirements)) {
    throw new Error("candidate describe() alters pinned requirements");
  }
  if (
    JSON.stringify(candidate.defaultValidators) !== JSON.stringify(base.defaultValidators)
  ) {
    throw new Error("candidate describe() alters pinned defaultValidators");
  }
}

async function readCandidateBundlePin(
  candidateRoot: string,
  previous: DurableRunState["intake"],
): Promise<DurableRunState["intake"]["bundle"]> {
  const manifestPath = path.join(candidateRoot, "graphloom.manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const entryPath = resolveBundleEntryFromManifest(candidateRoot, manifestRaw);
  const entryBytes = await readFile(entryPath);
  return {
    ...previous.bundle,
    bundlePath: candidateRoot,
    manifestRaw,
    manifestDigest: createHash("sha256").update(manifestRaw, "utf8").digest("hex"),
    entryDigest: createHash("sha256").update(entryBytes).digest("hex"),
  };
}

/** Default preflight: stages pin + optional package build when dependencies exist. */
export async function defaultRepairPreflight(args: {
  candidateRoot: string;
  target: "plugin" | "validator";
  baseDefinition: GraphDefinition;
}): Promise<RepairPreflightResult> {
  await assertCandidateStepsUnchanged({
    baseDefinitionStages: args.baseDefinition.stages.map((s) => ({
      id: s.id,
      name: s.name,
      requirementIds: [...s.requirementIds],
    })),
    candidateRoot: args.candidateRoot,
  });

  const { access } = await import("node:fs/promises");
  const pkgPath = path.join(args.candidateRoot, "package.json");
  try {
    await access(pkgPath);
  } catch {
    return { ok: true, summary: "stages pin ok; no package.json build required" };
  }

  const nm = path.join(args.candidateRoot, "node_modules");
  try {
    await access(nm);
  } catch {
    // Snapshots omit node_modules; callers with a full install should supply preflight.
    return {
      ok: true,
      summary: "stages pin ok; skipped build/test (no node_modules in candidate)",
    };
  }

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync("npm", ["run", "build", "--if-present"], {
      cwd: args.candidateRoot,
      timeout: 120_000,
    });
    await execFileAsync("npm", ["test", "--if-present"], {
      cwd: args.candidateRoot,
      timeout: 120_000,
    });
  } catch (err) {
    return {
      ok: false,
      summary: `candidate build/test failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, summary: "stages pin ok; build/test passed" };
}
