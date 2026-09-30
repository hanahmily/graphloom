import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  ActivateRepairSpec,
  EvidenceRecord,
  GraphDefinition,
  QualifyRepairSpec,
  RepairTarget,
  Requirement,
  ValidatorBinding,
} from "@graphloom/sdk";
import type { Supervisor } from "@graphloom/supervisor";
import type { PluginHost } from "@graphloom/plugin-host";
import { invalidateFromStage, type AdmissionValidator } from "./admit.js";
import { resolveBundleEntryFromManifest } from "./bundle.js";
import { manifestRepairContract } from "./intake.js";
import {
  assertCandidateFullyReviewed,
  assertCandidateStepsUnchanged,
  changedBaseFiles,
  digestDirectoryTree,
  assertDependenciesUnchanged,
  linkDependencies,
  snapshotRepairCandidate,
  type QualifiedRepairArtifact,
} from "./repair.js";
import type { DurableRunState } from "./state.js";
import { bumpGeneration } from "./generation.js";
import { activateExecutorRepair, executorRepairSubject } from "./executor-repair.js";
import { citedEvidence, saveRunState } from "./state.js";
import { worktreeChangeFingerprints } from "./worktree.js";

export interface RepairPatchAuthor {
  /** Must equal the run supervisor session id for every repair round. */
  sessionId: string;
  patch(args: {
    candidateRoot: string;
    target: RepairTarget;
    reason: string;
    maxProviderCalls?: number;
    /** Aborted when the operator stops the run mid-patch. */
    signal?: AbortSignal;
  }): Promise<{ summary: string }>;
}

export interface RepairReviewer {
  /** Must differ from the patch author / supervisor session id. */
  sessionId: string;
  review(args: {
    candidateRoot: string;
    baseDigest: string;
    candidateDigest: string;
    target: RepairTarget;
    /** Why the supervisor requested this repair. */
    reason: string;
    /** The run's original task request. */
    task: string;
    /** The disputed requirement's statement, when the repair targets one. */
    requirement?: string;
    /** The patch author's own summary of what it changed and why. */
    patchSummary?: string;
    /** Evidence the supervisor cited for the repair. */
    evidence: EvidenceRecord[];
    /**
     * Caps the reviewer's own provider calls, present only when the reviewer
     * implements `drainProviderCalls`: the controller then reserves this many
     * `agentInvocations` before calling `review` and refunds through it. A cap
     * of 0 means no budget remains: refuse instead of prompting. Absent for a
     * reviewer that does not report its usage; the controller then trusts it
     * to account for itself, as it does an unmetered patch author.
     */
    maxProviderCalls?: number;
  }): Promise<{ approved: boolean; reason: string }>;
  /** Provider calls this review spent; settles through here. Omit to charge the full `maxProviderCalls`. */
  drainProviderCalls?(): number;
}

export interface RepairPreflightResult {
  ok: boolean;
  summary: string;
  /** Optional describe() of the candidate for contract comparison. */
  definition?: GraphDefinition;
}

export interface RepairDeps {
  /**
   * Test seam for the patch step. When omitted, the run supervisor's own
   * `patchCandidate` authors the patch in the same session (the live Pi path).
   */
  patchAuthor?: RepairPatchAuthor;
  reviewer: RepairReviewer;
  /**
   * Controller-mediated build/test/contract checks before independent review.
   * Required so a reviewer cannot approve an uncompilable or contract-breaking candidate.
   */
  preflight: (args: {
    candidateRoot: string;
    target: RepairTarget;
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
    signal?: AbortSignal;
    /**
     * Opens a throwaway host on a candidate bundle pin so qualification can
     * compare its describe() with the pinned contract. The caller closes it.
     */
    openCandidateHost?: RecreateHostFn;
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
  if (
    qualify.requirementId !== undefined &&
    !state.definition.requirements.some((r) => r.id === qualify.requirementId)
  ) {
    return {
      ...state,
      status: "stopped",
      stopReason: "qualify_repair rejected",
      blocker: `requirement ${qualify.requirementId} is not pinned by this run`,
    };
  }
  const opaque = opaqueGateRefusal(state, qualify);
  if (opaque !== undefined) {
    const cited = opaqueGateEvidence(state, qualify);
    return {
      ...state,
      status: "stopped",
      stopReason: "opaque gate",
      blocker: opaque,
      ...(cited.length > 0 ? { stopEvidenceRefs: cited } : {}),
    };
  }

  const grant =
    qualify.target === "plugin"
      ? { ok: state.intake.grants.sourceRepair, name: "sourceRepair" }
      : qualify.target === "validator"
        ? { ok: state.intake.grants.validatorSubstitution, name: "validatorSubstitution" }
        : { ok: state.intake.grants.executorRepair === true, name: "executorRepair" };
  if (!grant.ok) {
    return {
      ...state,
      status: "stopped",
      stopReason: "qualify_repair missing operator grant",
      blocker: `${grant.name} grant is false`,
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
  const patchAuthor = resolvePatchAuthor(deps.repair, deps.supervisor, supervisorSessionId);
  if (!patchAuthor) {
    return {
      ...state,
      status: "stopped",
      stopReason: "qualify_repair requires a patch author",
      blocker:
        "no repair.patchAuthor, and the supervisor lacks patchCandidate with grant/revoke and provider-call accounting",
    };
  }
  const meteredPatch = patchAuthor !== deps.repair.patchAuthor;
  // A reviewer opts into metering by implementing drainProviderCalls, the same
  // signal the run's own supervisor uses (loop.ts); one that does not is trusted
  // to account for itself, the same way a caller-supplied patchAuthor is.
  const meteredReview = deps.repair.reviewer.drainProviderCalls !== undefined;
  if (patchAuthor.sessionId !== supervisorSessionId) {
    return {
      ...state,
      status: "stopped",
      stopReason: "patch author must use the run supervisor session",
      blocker: `patch=${patchAuthor.sessionId} supervisor=${supervisorSessionId}`,
    };
  }
  if ((meteredPatch || meteredReview) && state.budgets.agentInvocations <= 0) {
    return {
      ...state,
      status: "stopped",
      stopReason: "agentInvocations budget exhausted",
      blocker: meteredPatch ? "supervisor candidate patch" : "independent repair review",
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

  const subject =
    qualify.target === "executor" ? await executorRepairSubject(state, qualify) : await bundleRepairSubject(state, qualify);
  if ("error" in subject) {
    return { ...state, status: "stopped", stopReason: "qualify_repair rejected", blocker: subject.error };
  }

  // Reserve the correction and record the attempt durably before any effect so a
  // crash or thrown patch/review cannot replay the repair for free. A metered patch
  // also reserves the remaining invocations as its turn cap; unused calls are
  // refunded once the patch settles, and a crash keeps the whole reservation spent.
  // A metered independent review reserves whatever the patch leaves behind (computed
  // once the patch has settled, not from this pre-patch snapshot, so a metered patch's
  // full reservation does not leave the review with nothing regardless of what the
  // patch actually spent) and is refused outright once that reaches zero.
  const patchAllowance = meteredPatch ? state.budgets.agentInvocations : 0;
  const repairsDir = path.join(state.stateDir, "repairs");
  const artifactId = `repair-${randomUUID().slice(0, 8)}`;
  const reserved: QualifiedRepairArtifact = {
    artifactId,
    candidateRoot: path.join(repairsDir, artifactId, "candidate"),
    baseDigest: subject.baseDigest,
    baseActiveVersion: state.activeVersion,
    target: qualify.target,
    ...(qualify.executorId !== undefined && qualify.target === "executor" ? { executorId: qualify.executorId } : {}),
    reason: qualify.reason,
    createdAt: new Date().toISOString(),
    status: "qualifying",
    patchAuthorSessionId: supervisorSessionId,
    reviewerSessionId: deps.repair.reviewer.sessionId,
  };
  const reservedState: DurableRunState = {
    ...state,
    repairCandidates: [...(state.repairCandidates ?? []), reserved],
    budgets: {
      ...state.budgets,
      corrections: state.budgets.corrections - 1,
      agentInvocations: state.budgets.agentInvocations - patchAllowance,
    },
  };
  await saveRunState(reservedState);

  let patchRefund = patchAllowance;
  // Negative once a metered review reports spend: a deduction from what the patch
  // left behind, not a pre-reserved allowance (there is nothing to reserve for it
  // until the patch has settled and its actual leftover is known).
  let reviewRefund = 0;
  let patchSummary: string | undefined;
  const settle = (artifact: QualifiedRepairArtifact): DurableRunState => ({
    ...reservedState,
    budgets: {
      ...reservedState.budgets,
      agentInvocations: reservedState.budgets.agentInvocations + patchRefund + reviewRefund,
    },
    repairCandidates: (reservedState.repairCandidates ?? []).map((c) =>
      c.artifactId === artifactId
        ? { ...artifact, ...(patchSummary !== undefined ? { patchSummary } : {}) }
        : c,
    ),
  });
  const reject = async (reason: string): Promise<DurableRunState> =>
    settle({
      ...reserved,
      status: "rejected",
      rejectionReason: reason,
      ...(await digestDirectoryTree(reserved.candidateRoot)
        .then((candidateDigest) => ({ candidateDigest }))
        .catch(() => ({}))),
    });

  let granted = false;
  try {
    const snap = await subject.snapshot({ repairsDir, artifactId });
    if (snap.baseDigest !== reserved.baseDigest) {
      return await reject(`${subject.label} changed while snapshotting the candidate`);
    }
    if (snap.candidateEntryModule !== undefined) {
      reserved.candidateEntryModule = snap.candidateEntryModule;
    }

    // Same logical supervisor session for every repair round.
    await deps.supervisor?.grantCandidateCoding?.(snap.candidateRoot);
    granted = true;

    const outside = await patchSurroundings(state);
    let patchError: { error: unknown } | undefined;
    try {
      const patched = await patchAuthor.patch({
        candidateRoot: snap.candidateRoot,
        target: qualify.target,
        reason: qualify.reason,
        ...(meteredPatch ? { maxProviderCalls: patchAllowance } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      patchSummary = boundPatchSummary(patched?.summary);
    } catch (error) {
      patchError = { error };
    } finally {
      if (meteredPatch) {
        const spent = deps.supervisor?.drainProviderCalls?.() ?? patchAllowance;
        patchRefund = patchAllowance - Math.min(patchAllowance, Math.max(0, spent));
      }
    }

    // The patch author's tools are not confined to the candidate, so a change
    // elsewhere stops the run before anything builds or runs the candidate.
    const escaped = [
      ...((await subject.liveDigest().catch(() => undefined)) !== reserved.baseDigest ? [subject.label] : []),
      ...(await patchSurroundings(state).then((after) => changedSurroundings(outside, after))),
    ];
    if (escaped.length > 0) {
      const rejected = await reject(`the patch changed files outside the candidate: ${escaped.join(", ")}`);
      return {
        ...rejected,
        status: "stopped",
        stopReason: "repair patch changed files outside the candidate",
        blocker: escaped.join(", "),
      };
    }
    if (patchError !== undefined) throw patchError.error;

    await subject.checkCandidate(snap);

    const preflight = await deps.repair.preflight({
      candidateRoot: snap.candidateRoot,
      target: qualify.target,
      baseDefinition: state.definition,
    });
    if (!preflight.ok) {
      return settle({
        ...reserved,
        status: "rejected",
        candidateDigest: await digestDirectoryTree(snap.candidateRoot),
        rejectionReason: preflight.summary,
        preflightSummary: preflight.summary,
      });
    }
    if (preflight.definition) {
      assertCandidateDefinitionCompatible(preflight.definition, state.definition);
    }
    if (qualify.target !== "executor" && deps.openCandidateHost) {
      assertCandidateDefinitionCompatible(
        await describeCandidate(state, snap.candidateRoot, artifactId, deps.openCandidateHost),
        state.definition,
      );
    }

    // Computed now, from the patch's actual leftover (reservedState already withheld
    // patchAllowance; patchRefund gives back what the patch did not spend), not from
    // the pre-patch budget: a metered patch's full reservation must not leave the
    // review with nothing regardless of what the patch actually used.
    const reviewAllowance = meteredReview ? Math.max(0, reservedState.budgets.agentInvocations + patchRefund) : 0;
    if (meteredReview && reviewAllowance <= 0) {
      return settle({
        ...reserved,
        status: "rejected",
        candidateDigest: await digestDirectoryTree(snap.candidateRoot),
        rejectionReason: "no agentInvocations budget remains for independent review",
      });
    }

    const candidateDigest = await digestDirectoryTree(snap.candidateRoot);
    const requirement =
      qualify.requirementId !== undefined
        ? state.definition.requirements.find((r) => r.id === qualify.requirementId)?.statement
        : undefined;
    const evidence: EvidenceRecord[] = state.evidence.filter((e) => (qualify.evidenceRefs ?? []).includes(e.ref));
    const review = await deps.repair.reviewer.review({
      candidateRoot: snap.candidateRoot,
      baseDigest: snap.baseDigest,
      candidateDigest,
      target: qualify.target,
      reason: qualify.reason,
      task: state.intake.task.request,
      ...(requirement !== undefined ? { requirement } : {}),
      ...(patchSummary !== undefined ? { patchSummary } : {}),
      evidence,
      ...(meteredReview ? { maxProviderCalls: reviewAllowance } : {}),
    });
    if (meteredReview) {
      const reviewSpent = deps.repair.reviewer.drainProviderCalls!() ?? reviewAllowance;
      // A deduction from the patch's leftover, not a refund from a pre-reservation.
      reviewRefund = -Math.min(reviewAllowance, Math.max(0, reviewSpent));
    }

    return settle({
      ...reserved,
      status: review.approved ? "qualified" : "rejected",
      candidateDigest,
      reviewReason: review.reason,
      preflightSummary: preflight.summary,
      ...(review.approved
        ? { qualifiedAt: new Date().toISOString() }
        : { rejectionReason: review.reason }),
    });
  } catch (err) {
    // Stay in recovery with the correction spent; the supervisor may try another round.
    return await reject(err instanceof Error ? err.message : String(err));
  } finally {
    if (granted) {
      await deps.supervisor?.revokeCandidateCoding?.();
    }
  }
}

/**
 * Why an opaque bundle cannot take this repair, or undefined when it can.
 * Its code is never patched; a validator may be substituted only under the
 * operator's grant, for a requirement the manifest pins readably.
 */
function opaqueGateRefusal(state: DurableRunState, qualify: QualifyRepairSpec): string | undefined {
  if (qualify.target === "executor") return undefined;
  if (manifestRepairContract(state.intake.bundle.manifestRaw) !== "opaque") return undefined;
  if (qualify.target === "plugin") {
    return "the graph bundle is opaque: its code cannot be patched";
  }
  if (!state.intake.grants.validatorSubstitution) {
    return "the graph bundle is opaque and validator substitution is not authorized";
  }
  if (qualify.requirementId === undefined) {
    return "validator substitution on an opaque bundle must name the disputed requirement";
  }
  const pinned = (JSON.parse(state.intake.bundle.manifestRaw) as { requirements?: unknown }).requirements;
  const readable =
    Array.isArray(pinned) &&
    pinned.some(
      (r: unknown) =>
        typeof r === "object" &&
        r !== null &&
        (r as Requirement).id === qualify.requirementId &&
        typeof (r as Requirement).statement === "string" &&
        (r as Requirement).statement.trim() !== "",
    );
  if (!readable) {
    return `requirement ${qualify.requirementId} has no readable statement pinned in the manifest`;
  }
  return undefined;
}

/** The refs the supervisor cited, plus those the escalation into recovery cited. */
function opaqueGateEvidence(state: DurableRunState, qualify: QualifyRepairSpec): string[] {
  return citedEvidence(state, [...(qualify.evidenceRefs ?? []), ...(state.recoveryTrigger?.evidenceRefs ?? [])]);
}

/** What the patch author must leave alone: the run worktree and the saved run state. */
async function patchSurroundings(state: DurableRunState): Promise<{ worktree: Map<string, string>; runState: string }> {
  return {
    worktree: await worktreeChangeFingerprints(state.worktreePath),
    runState: await readFile(path.join(state.stateDir, "state.json"), "utf8").catch(() => ""),
  };
}

function changedSurroundings(
  before: { worktree: Map<string, string>; runState: string },
  after: { worktree: Map<string, string>; runState: string },
): string[] {
  const worktree = [...new Set([...before.worktree.keys(), ...after.worktree.keys()])].some(
    (rel) => before.worktree.get(rel) !== after.worktree.get(rel),
  );
  return [...(worktree ? ["run worktree"] : []), ...(before.runState !== after.runState ? ["run state"] : [])];
}

/** What a qualification round copies, digests, and checks, per repair target. */
export interface RepairSubject {
  /** Names the repaired code in rejection reasons. */
  label: string;
  baseDigest: string;
  /** Digests the installed code again, to compare with `baseDigest`. */
  liveDigest(): Promise<string>;
  snapshot(args: { repairsDir: string; artifactId: string }): Promise<{
    candidateRoot: string;
    baseDigest: string;
    candidateEntryModule?: string;
  }>;
  /** Throws when the patched candidate breaks what the run pinned. */
  checkCandidate(snap: { candidateRoot: string; candidateEntryModule?: string }): Promise<void>;
}

/** Plugin and validator repairs copy the active graph bundle and must keep its steps. */
async function bundleRepairSubject(state: DurableRunState, qualify: QualifyRepairSpec): Promise<RepairSubject> {
  return {
    label: "active bundle",
    baseDigest: await digestDirectoryTree(await realpath(state.intake.bundle.bundlePath)),
    liveDigest: async () => digestDirectoryTree(await realpath(state.intake.bundle.bundlePath)),
    async snapshot({ repairsDir, artifactId }) {
      const snap = await snapshotRepairCandidate({
        bundlePath: state.intake.bundle.bundlePath,
        repairsDir,
        baseActiveVersion: state.activeVersion,
        target: qualify.target,
        reason: qualify.reason,
        artifactId,
      });
      await writeStagesPin(snap.candidateRoot, state.definition);
      // Linked beside the candidate, not inside it, so the reviewed tree stays unchanged.
      await linkDependencies(
        await realpath(state.intake.bundle.bundlePath),
        path.dirname(snap.candidateRoot),
      );
      return snap;
    },
    async checkCandidate({ candidateRoot }) {
      await assertCandidateFullyReviewed(candidateRoot);
      await assertCandidateStepsUnchanged({
        baseDefinitionStages: stagePins(state.definition),
        candidateRoot,
      });
      await assertCandidateManifestCompatible(candidateRoot, state);
      const baseReal = await realpath(state.intake.bundle.bundlePath);
      await assertDependenciesUnchanged(baseReal, candidateRoot);
      if (manifestRepairContract(state.intake.bundle.manifestRaw) === "opaque") {
        // The controller rewrites the stages pin in every candidate.
        const changed = await changedBaseFiles(baseReal, candidateRoot, new Set(["graphloom.stages.json"]));
        if (changed.length > 0) {
          const shown = changed.slice(0, 5).join(", ");
          throw new Error(
            `validator substitution on an opaque bundle may only add files; changed ${shown}${changed.length > 5 ? ", …" : ""}`,
          );
        }
      }
    },
  };
}

/** Resume checks the loaded plugin against the activated manifest, so it must keep the pin. */
async function assertCandidateManifestCompatible(
  candidateRoot: string,
  state: DurableRunState,
): Promise<void> {
  const fields = ["graphId", "version", "sdkProtocol", "privateStateSchema", "repairContract"] as const;
  type Manifest = Record<(typeof fields)[number] | "requirements", unknown>;
  const manifest = JSON.parse(
    await readFile(path.join(candidateRoot, "graphloom.manifest.json"), "utf8"),
  ) as Manifest;
  const pinned = JSON.parse(state.intake.bundle.manifestRaw) as Manifest;
  for (const field of fields) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(pinned[field])) {
      throw new Error(`candidate manifest alters pinned ${field}`);
    }
  }
  if (manifest.requirements === undefined) {
    if (pinned.requirements !== undefined) {
      throw new Error("candidate manifest removes pinned requirements");
    }
    return;
  }
  if (
    !Array.isArray(manifest.requirements) ||
    !manifest.requirements.every((r) => typeof r === "object" && r !== null)
  ) {
    throw new Error("candidate manifest requirements are malformed");
  }
  const changes = requirementChanges(manifest.requirements as Requirement[], state.definition.requirements);
  if (changes.length > 0) {
    throw new Error(`candidate manifest alters pinned requirements: ${changes.join(", ")}`);
  }
}

async function describeCandidate(
  state: DurableRunState,
  candidateRoot: string,
  artifactId: string,
  openHost: RecreateHostFn,
): Promise<GraphDefinition> {
  const host = await openHost({
    intake: { ...state.intake, bundle: await readCandidateBundlePin(candidateRoot, state.intake) },
    activeVersion: `${state.intake.bundle.graphId}@candidate-${artifactId}`,
    generation: state.generation,
  });
  try {
    const described = await host.describe({
      runId: state.runId,
      operationId: `describe-qualify-${artifactId}`,
      expectedStateRevision: state.stateRevision,
    });
    if (!described.ok) {
      throw new Error(`candidate describe failed: ${described.observation.message}`);
    }
    return described.value;
  } finally {
    await host.close().catch(() => undefined);
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

  if (artifact.target === "executor") {
    return { state: await activateExecutorRepair(state, candidates, idx, artifact), validators: deps.validators };
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
  const liveDigest = await digestDirectoryTree(state.intake.bundle.bundlePath).catch(() => undefined);
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
  const liveCandidateDigest = await digestDirectoryTree(artifact.candidateRoot).catch(() => undefined);
  if (liveCandidateDigest !== artifact.candidateDigest) {
    candidates[idx] = { ...artifact, status: "superseded" };
    return {
      state: {
        ...state,
        repairCandidates: candidates,
        status: "stopped",
        stopReason: "activate_repair candidate digest mismatch",
        blocker:
          liveCandidateDigest === undefined
            ? "candidate is missing or unreadable"
            : "candidate changed after independent review",
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

  // Persist intent before effects; resume aborts an intent that never committed.
  await saveRunState({ ...state, activationIntent: intent });

  let host: PluginHost | undefined;
  try {
    // The digest cannot see entries added after review under node_modules or .git.
    await assertCandidateFullyReviewed(artifact.candidateRoot);
    // Stages pin must still match — cannot be deleted after review.
    await assertCandidateStepsUnchanged({
      baseDefinitionStages: stagePins(state.definition),
      candidateRoot: artifact.candidateRoot,
    });

    const materialized = deps.repair.materializeValidators?.(artifact.candidateRoot);
    const validators = materialized
      ? { ...deps.validators, ...materialized }
      : deps.validators;

    candidates[idx] = { ...artifact, status: "activated" };
    // Supersede other qualified peers so only one activation owns the run.
    for (let i = 0; i < candidates.length; i++) {
      if (i !== idx && candidates[i]?.status === "qualified") {
        candidates[i] = { ...candidates[i]!, status: "superseded" };
      }
    }

    const candidatePin = await readCandidateBundlePin(artifact.candidateRoot, state.intake);
    let next: DurableRunState = {
      ...state,
      repairCandidates: candidates,
      activeVersion: toVersion,
      activationIntent: { ...intent, status: "committed" },
      intake: { ...state.intake, bundle: candidatePin },
    };

    // Validator repairs typically invalidate Write and everything after.
    const earliest = next.definition.stages[0]?.id ?? next.current.stageId;
    next = invalidateFromStage(next, earliest, next.definition);
    next = { ...next, current: { stageId: earliest, attempt: 1 } };
    next = bumpGeneration(next, `activate_repair:${artifact.artifactId}`);

    if (deps.recreateHost) {
      host = await deps.recreateHost({
        intake: next.intake,
        activeVersion: next.activeVersion,
        generation: next.generation,
      });
      // The loaded candidate, not the controller-written sidecar, must preserve
      // the pinned graph contract before the run switches to it.
      const described = await host.describe({
        runId: next.runId,
        operationId: `describe-activate-${artifact.artifactId}`,
        expectedStateRevision: next.stateRevision,
      });
      if (!described.ok) {
        throw new Error(`candidate describe failed: ${described.observation.message}`);
      }
      assertCandidateDefinitionCompatible(described.value, state.definition);
      // A repair may update what the environment needs (the checks rerun before
      // normal work continues); the stages and requirements stay pinned.
      const { environment: _previous, ...pinned } = next.definition;
      void _previous;
      const { environment } = described.value;
      next = { ...next, definition: environment !== undefined ? { ...pinned, environment } : pinned };
    }

    return { state: next, validators, ...(host !== undefined ? { host } : {}) };
  } catch (err) {
    await host?.close().catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    const failed = [...(state.repairCandidates ?? [])];
    failed[idx] = { ...artifact, status: "rejected", rejectionReason: reason };
    return {
      state: {
        ...state,
        repairCandidates: failed,
        activationIntent: { ...intent, status: "aborted" },
        status: "stopped",
        stopReason: "activate_repair candidate rejected",
        blocker: reason,
      },
      validators: deps.validators,
    };
  }
}

/**
 * Reconcile repair journals left by a crashed controller: an uncommitted
 * activation intent is aborted (the atomic commit never landed), and attempts
 * still `qualifying` are rejected with their correction already spent.
 */
export function reconcileRepairJournal(state: DurableRunState): DurableRunState {
  let next = state;
  if (next.activationIntent?.status === "intent") {
    next = { ...next, activationIntent: { ...next.activationIntent, status: "aborted" } };
  }
  if (next.repairCandidates?.some((c) => c.status === "qualifying")) {
    next = {
      ...next,
      repairCandidates: next.repairCandidates.map((c) =>
        c.status === "qualifying"
          ? {
              ...c,
              status: "rejected" as const,
              rejectionReason: "abandoned before qualification (controller restart)",
            }
          : c,
      ),
    };
  }
  return next;
}

/** Validators bound to the active repaired candidate, for resume. */
export function activeRepairValidators(
  state: DurableRunState,
  repair: RepairDeps | undefined,
): { ok: true; validators?: Record<string, AdmissionValidator> } | { ok: false; reason: string } {
  const active = state.repairCandidates?.find(
    (c) => c.status === "activated" && state.activeVersion.endsWith(`@repair-${c.artifactId}`),
  );
  if (!active) return { ok: true };
  const materialized = repair?.materializeValidators?.(active.candidateRoot);
  if (materialized) return { ok: true, validators: materialized };
  if (active.target === "validator") {
    return {
      ok: false,
      reason: `active validator repair ${active.artifactId} cannot be rehydrated (repair.materializeValidators missing)`,
    };
  }
  return { ok: true };
}

function stagePins(definition: GraphDefinition) {
  return definition.stages.map((s) => ({
    id: s.id,
    name: s.name,
    requirementIds: [...s.requirementIds],
  }));
}

function resolvePatchAuthor(
  repair: RepairDeps,
  supervisor: Supervisor | undefined,
  supervisorSessionId: string,
): RepairPatchAuthor | undefined {
  if (repair.patchAuthor) return repair.patchAuthor;
  // The controller must be able to scope, revoke, and meter the supervisor's patch.
  if (
    !supervisor?.patchCandidate ||
    !supervisor.grantCandidateCoding ||
    !supervisor.revokeCandidateCoding ||
    !supervisor.drainProviderCalls
  ) {
    return undefined;
  }
  return {
    sessionId: supervisorSessionId,
    patch: (args) => supervisor.patchCandidate!(args),
  };
}

const MAX_PATCH_SUMMARY_CHARS = 2_000;

/** Every patch author's summary obeys the same bound before it becomes durable. */
function boundPatchSummary(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const summary = raw.trim().slice(0, MAX_PATCH_SUMMARY_CHARS);
  return summary === "" ? undefined : summary;
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
  if (candidate.version !== base.version) {
    throw new Error(`candidate version ${candidate.version} != pinned ${base.version}`);
  }
  if (candidate.privateStateSchema !== base.privateStateSchema) {
    throw new Error("candidate describe() alters pinned privateStateSchema");
  }
  if (JSON.stringify(candidate.stages) !== JSON.stringify(base.stages)) {
    throw new Error("candidate describe() alters pinned stages");
  }
  if (JSON.stringify(candidate.requirements) !== JSON.stringify(base.requirements)) {
    const changes = requirementChanges(candidate.requirements, base.requirements);
    throw new Error(
      `candidate describe() alters pinned requirements: ${changes.length > 0 ? changes.join(", ") : "order"}`,
    );
  }
  if (
    JSON.stringify(candidate.defaultValidators) !== JSON.stringify(base.defaultValidators)
  ) {
    const changes = bindingChanges(candidate.defaultValidators, base.defaultValidators);
    throw new Error(
      `candidate describe() alters pinned defaultValidators: ${changes.length > 0 ? changes.join(", ") : "order"}`,
    );
  }
}

/** Requirement ids added, removed, or whose statement or evidence schema changed. */
function requirementChanges(candidate: Requirement[], base: Requirement[]): string[] {
  const changes: string[] = [];
  for (const want of base) {
    const got = candidate.find((r) => r.id === want.id);
    if (!got) {
      changes.push(`${want.id} removed`);
      continue;
    }
    for (const field of ["statement", "evidenceSchema"] as const) {
      if (got[field] !== want[field]) changes.push(`${want.id} ${field}`);
    }
  }
  for (const got of candidate) {
    if (!base.some((r) => r.id === got.id)) changes.push(`${got.id} added`);
  }
  return changes;
}

/** Requirement ids whose default validator bindings differ. */
function bindingChanges(candidate: ValidatorBinding[], base: ValidatorBinding[]): string[] {
  const ids = [...new Set([...base, ...candidate].map((b) => b.requirementId))];
  const bindingsFor = (list: ValidatorBinding[], id: string) =>
    JSON.stringify(list.filter((b) => b.requirementId === id));
  return ids.filter((id) => bindingsFor(candidate, id) !== bindingsFor(base, id));
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
  target: RepairTarget;
  baseDefinition: GraphDefinition;
}): Promise<RepairPreflightResult> {
  // Executor candidates carry no stages pin; the controller checks their executor contract.
  if (args.target !== "executor") {
    await assertCandidateStepsUnchanged({
      baseDefinitionStages: stagePins(args.baseDefinition),
      candidateRoot: args.candidateRoot,
    });
  }

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
