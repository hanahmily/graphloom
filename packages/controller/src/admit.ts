import { createHash, randomUUID } from "node:crypto";
import type {
  EvidenceRecord,
  GraphDefinition,
  Receipt,
  ValidateSpec,
  Validator,
  ValidatorBinding,
} from "@graphloom/sdk";
import type { DurableRunState } from "./state.js";
import { readWorktreeFile, workspaceChangeManifest } from "./worktree.js";

export class AdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdmissionError";
  }
}

/** Fresh evidence only: matching controller generation. */
export function freshEvidence(state: DurableRunState): EvidenceRecord[] {
  return state.evidence.filter((e) => e.generation === state.generation);
}

/**
 * Latest observation per file path / kind within the current generation.
 * Older same-generation observes (e.g. pre-correction) are superseded.
 */
export function candidateEvidence(state: DurableRunState): EvidenceRecord[] {
  const fresh = freshEvidence(state);
  const latest: EvidenceRecord[] = [];
  const seenFiles = new Set<string>();
  const seenKinds = new Set<string>();
  for (let i = fresh.length - 1; i >= 0; i -= 1) {
    const e = fresh[i]!;
    if (e.kind === "file") {
      const filePath = (e.payload as { path?: unknown } | undefined)?.path;
      if (typeof filePath !== "string" || seenFiles.has(filePath)) {
        continue;
      }
      seenFiles.add(filePath);
      latest.unshift(e);
      continue;
    }
    if (e.kind === "workspace" || e.kind === "review") {
      if (seenKinds.has(e.kind)) {
        continue;
      }
      seenKinds.add(e.kind);
      latest.unshift(e);
      continue;
    }
    latest.unshift(e);
  }
  return latest;
}

export function candidateFingerprint(evidence: EvidenceRecord[]): string {
  const h = createHash("sha256");
  for (const e of evidence) {
    h.update(e.ref);
    h.update(e.kind);
    h.update(e.fingerprint ?? "");
    h.update(JSON.stringify(e.payload ?? null));
  }
  return h.digest("hex");
}

export function stageRequirementsMet(
  state: DurableRunState,
  stageId: string,
  requirementIds: string[],
): boolean {
  return requirementIds.every((requirementId) =>
    state.receipts.some(
      (r) => r.stageId === stageId && r.requirementId === requirementId && r.valid,
    ),
  );
}

export function earliestIncompleteStage(
  state: DurableRunState,
): GraphDefinition["stages"][number] | undefined {
  return state.definition.stages.find(
    (s) => !stageRequirementsMet(state, s.id, s.requirementIds),
  );
}

/** Re-read worktree and ensure Observe fingerprints still match. */
export async function assertLiveWorkspaceMatchesEvidence(
  state: DurableRunState,
  evidence: EvidenceRecord[],
): Promise<string | undefined> {
  for (const e of evidence) {
    if (e.kind === "file") {
      const payload = e.payload as { path?: string } | undefined;
      if (!payload?.path || typeof payload.path !== "string") {
        return "malformed file evidence";
      }
      const live = await readWorktreeFile(state.worktreePath, payload.path);
      const liveFp = live === undefined ? "missing" : sha256(live);
      if (liveFp !== e.fingerprint) {
        return `workspace file changed since observe: ${payload.path}`;
      }
    }
    if (e.kind === "workspace") {
      const livePaths = await workspaceChangeManifest(state.worktreePath);
      const liveFp = sha256(JSON.stringify(livePaths));
      if (liveFp !== e.fingerprint) {
        return "workspace manifest changed since observe";
      }
      if (state.workspaceRevision && state.workspaceRevision !== liveFp) {
        return "workspace revision mismatch";
      }
    }
  }
  return undefined;
}

/**
 * Controller-owned Validate → optional Accept (receipt).
 * Never called from plugin/supervisor decisions directly as Accept.
 */
export async function admitValidation(
  state: DurableRunState,
  spec: ValidateSpec,
  validators: Record<string, Validator>,
): Promise<{ state: DurableRunState; accepted: boolean; reason: string }> {
  const stage = state.definition.stages.find((s) => s.id === spec.stageId);
  if (!stage) {
    throw new AdmissionError(`unknown stage ${spec.stageId}`);
  }

  const needed = earliestIncompleteStage(state);
  if (!needed || needed.id !== spec.stageId) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: `stage ${spec.stageId} is not the next incomplete stage`,
    };
  }

  const reqIds = spec.requirementIds ?? stage.requirementIds;
  const allowed = new Set(stage.requirementIds);
  if (reqIds.some((id) => !allowed.has(id))) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: "requirementIds must be a subset of the stage requirements",
    };
  }
  // Admission mints receipts only when the full stage requirement set is covered.
  if (
    reqIds.length !== stage.requirementIds.length ||
    !stage.requirementIds.every((id) => reqIds.includes(id))
  ) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: "Validate must cover every requirement declared by the stage",
    };
  }

  const evidence = candidateEvidence(state);
  if (evidence.length === 0) {
    return { state, accepted: false, reason: "no fresh evidence for validation" };
  }

  const drift = await assertLiveWorkspaceMatchesEvidence(state, evidence);
  if (drift) {
    return { state: bumpRevision(state), accepted: false, reason: drift };
  }

  const fingerprint = spec.candidateFingerprint ?? candidateFingerprint(evidence);
  if (spec.candidateFingerprint && spec.candidateFingerprint !== candidateFingerprint(evidence)) {
    return {
      state: bumpRevision(state),
      accepted: false,
      reason: "candidateFingerprint does not match current evidence",
    };
  }

  // Predecessor receipts: every requirement on earlier stages must be valid.
  const stageIndex = state.definition.stages.findIndex((s) => s.id === spec.stageId);
  for (let i = 0; i < stageIndex; i += 1) {
    const pred = state.definition.stages[i]!;
    if (!stageRequirementsMet(state, pred.id, pred.requirementIds)) {
      return {
        state: bumpRevision(state),
        accepted: false,
        reason: `missing valid predecessor receipts for ${pred.id}`,
      };
    }
  }

  const newReceipts: Receipt[] = [];
  let working = { ...state, receiptSeq: state.receiptSeq };
  for (const requirementId of reqIds) {
    const requirement = working.definition.requirements.find((r) => r.id === requirementId);
    if (!requirement) {
      throw new AdmissionError(`unknown requirement ${requirementId}`);
    }
    const binding = bindingFor(working, requirementId);
    if (!binding) {
      throw new AdmissionError(`no validator binding for ${requirementId}`);
    }
    const validator = validators[binding.validatorId];
    if (!validator) {
      throw new AdmissionError(`validator not registered: ${binding.validatorId}`);
    }

    if (binding.independence === "separate-reviewer") {
      const independenceError = assertSeparateReviewer(working, evidence);
      if (independenceError) {
        return {
          state: bumpRevision(working),
          accepted: false,
          reason: independenceError,
        };
      }
    }

    const result = validator.evaluate({
      requirementId,
      statement: requirement.statement,
      evidence,
      candidateFingerprint: fingerprint,
    });

    if (result.status !== "passed") {
      return {
        state: bumpRevision(working),
        accepted: false,
        reason: `validation ${result.status}: ${result.reason}`,
      };
    }

    working.receiptSeq += 1;
    newReceipts.push({
      id: `rcpt-${working.receiptSeq}`,
      stageId: spec.stageId,
      requirementId,
      validatorBinding: binding,
      candidateFingerprint: fingerprint,
      evidenceRefs: evidence.map((e) => e.ref),
      valid: true,
    });
  }

  // If this stage/candidate changes, invalidate this stage and successors first.
  let receipts = working.receipts.map((r) => {
    const stageIdx = working.definition.stages.findIndex((s) => s.id === r.stageId);
    if (stageIdx >= stageIndex && r.valid) {
      if (
        r.stageId === spec.stageId &&
        r.candidateFingerprint !== fingerprint
      ) {
        return { ...r, valid: false };
      }
      if (stageIdx > stageIndex) {
        return { ...r, valid: false };
      }
    }
    return r;
  });

  // Replace any prior valid receipts for the same stage requirements.
  receipts = receipts.map((r) =>
    r.stageId === spec.stageId &&
    reqIds.includes(r.requirementId) &&
    r.valid
      ? { ...r, valid: false }
      : r,
  );

  return {
    state: bumpRevision({
      ...working,
      receipts: [...receipts, ...newReceipts],
      current: { stageId: spec.stageId, attempt: working.current.attempt },
    }),
    accepted: true,
    reason: `accepted ${spec.stageId}`,
  };
}

export function invalidateFromStage(
  state: DurableRunState,
  stageId: string,
  definition: GraphDefinition,
): DurableRunState {
  const idx = definition.stages.findIndex((s) => s.id === stageId);
  if (idx < 0) {
    throw new AdmissionError(`reenter unknown stage ${stageId}`);
  }
  const doomed = new Set(definition.stages.slice(idx).map((s) => s.id));
  return bumpRevision({
    ...state,
    receipts: state.receipts.map((r) =>
      doomed.has(r.stageId) ? { ...r, valid: false } : r,
    ),
  });
}

function bindingFor(
  state: DurableRunState,
  requirementId: string,
): ValidatorBinding | undefined {
  return (
    state.validatorBindings.find((b) => b.requirementId === requirementId) ??
    state.definition.defaultValidators.find((b) => b.requirementId === requirementId)
  );
}

export interface EvidenceProducer {
  operationId: string;
  stageId: string;
  purpose: string;
  readOnly: boolean;
  kind: string;
}

function assertSeparateReviewer(
  state: DurableRunState,
  evidence: EvidenceRecord[],
): string | undefined {
  const review = [...evidence].reverse().find((e) => e.kind === "review");
  if (!review) {
    return "missing review evidence for separate-reviewer requirement";
  }
  const producer = (review.payload as { producer?: EvidenceProducer } | undefined)?.producer;
  if (!producer) {
    return "review evidence missing producer identity";
  }
  if (!producer.readOnly || producer.purpose !== "review") {
    return "review evidence must come from a read-only review job";
  }
  if (!state.lastWorkOperationId) {
    return "no prior work operation for separate-reviewer check";
  }
  if (producer.operationId === state.lastWorkOperationId) {
    return "reviewer operation must be distinct from the writer";
  }
  return undefined;
}

function bumpRevision(state: DurableRunState): DurableRunState {
  return { ...state, stateRevision: state.stateRevision + 1 };
}

export function newEvidenceRef(state: DurableRunState): string {
  state.evidenceSeq += 1;
  return `ev-g${state.generation}-${state.evidenceSeq}-${randomUUID().slice(0, 8)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
