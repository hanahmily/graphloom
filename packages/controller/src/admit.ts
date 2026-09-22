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

export function candidateFingerprint(evidence: EvidenceRecord[]): string {
  const h = createHash("sha256");
  for (const e of evidence) {
    h.update(e.ref);
    h.update(e.kind);
    h.update(JSON.stringify(e.payload ?? null));
  }
  return h.digest("hex");
}

/**
 * Controller-owned Validate → optional Accept (receipt).
 * Never called from plugin/supervisor decisions directly as Accept.
 */
export function admitValidation(
  state: DurableRunState,
  spec: ValidateSpec,
  validators: Record<string, Validator>,
): { state: DurableRunState; accepted: boolean; reason: string } {
  const stage = state.definition.stages.find((s) => s.id === spec.stageId);
  if (!stage) {
    throw new AdmissionError(`unknown stage ${spec.stageId}`);
  }

  const reqIds = spec.requirementIds ?? stage.requirementIds;
  const evidence = freshEvidence(state);
  if (evidence.length === 0) {
    return { state, accepted: false, reason: "no fresh evidence for validation" };
  }

  const fingerprint =
    spec.candidateFingerprint ?? candidateFingerprint(evidence);

  const newReceipts: Receipt[] = [];
  for (const requirementId of reqIds) {
    const requirement = state.definition.requirements.find((r) => r.id === requirementId);
    if (!requirement) {
      throw new AdmissionError(`unknown requirement ${requirementId}`);
    }
    const binding = bindingFor(state, requirementId);
    if (!binding) {
      throw new AdmissionError(`no validator binding for ${requirementId}`);
    }
    const validator = validators[binding.validatorId];
    if (!validator) {
      throw new AdmissionError(`validator not registered: ${binding.validatorId}`);
    }

    const result = validator.evaluate({
      requirementId,
      statement: requirement.statement,
      evidence,
      candidateFingerprint: fingerprint,
    });

    if (result.status !== "passed") {
      return {
        state: bumpRevision(state),
        accepted: false,
        reason: `validation ${result.status}: ${result.reason}`,
      };
    }

    state.receiptSeq += 1;
    newReceipts.push({
      id: `rcpt-${state.receiptSeq}`,
      stageId: spec.stageId,
      requirementId,
      validatorBinding: binding,
      candidateFingerprint: fingerprint,
      evidenceRefs: evidence.map((e) => e.ref),
      valid: true,
    });
  }

  // Predecessor receipts: earlier stages must still be valid.
  const stageIndex = state.definition.stages.findIndex((s) => s.id === spec.stageId);
  for (let i = 0; i < stageIndex; i += 1) {
    const pred = state.definition.stages[i]!;
    if (!state.receipts.some((r) => r.stageId === pred.id && r.valid)) {
      return {
        state: bumpRevision(state),
        accepted: false,
        reason: `missing valid predecessor receipt for ${pred.id}`,
      };
    }
  }

  return {
    state: bumpRevision({
      ...state,
      receipts: [...state.receipts, ...newReceipts],
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

function bumpRevision(state: DurableRunState): DurableRunState {
  return { ...state, stateRevision: state.stateRevision + 1 };
}

export function newEvidenceRef(state: DurableRunState): string {
  state.evidenceSeq += 1;
  return `ev-g${state.generation}-${state.evidenceSeq}-${randomUUID().slice(0, 8)}`;
}
