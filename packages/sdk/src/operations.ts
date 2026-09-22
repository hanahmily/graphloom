import type {
  ActivateRepairSpec,
  GraphAction,
  GraphDecision,
  JobSpec,
  ObserveSpec,
  QualifyRepairSpec,
  ReenterSpec,
  ReturnSpec,
  StopSpec,
  SuperviseSpec,
  ValidateSpec,
} from "./types.js";

export function dispatch(job: JobSpec, reason: string, privateState?: string): GraphDecision {
  return decide({ type: "dispatch", job }, reason, privateState);
}

export function observe(
  observeSpec: ObserveSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "observe", observe: observeSpec }, reason, privateState);
}

export function validate(
  validateSpec: ValidateSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "validate", validate: validateSpec }, reason, privateState);
}

export function reenter(
  reenterSpec: ReenterSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "reenter", reenter: reenterSpec }, reason, privateState);
}

export function supervise(
  superviseSpec: SuperviseSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "supervise", supervise: superviseSpec }, reason, privateState);
}

export function qualifyRepair(
  qualify: QualifyRepairSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "qualify_repair", qualify }, reason, privateState);
}

export function activateRepair(
  activate: ActivateRepairSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "activate_repair", activate }, reason, privateState);
}

export function returnToNormal(
  returnSpec: ReturnSpec,
  reason: string,
  privateState?: string,
): GraphDecision {
  return decide({ type: "return", return: returnSpec }, reason, privateState);
}

export function stop(stopSpec: StopSpec, reason: string, privateState?: string): GraphDecision {
  return decide({ type: "stop", stop: stopSpec }, reason, privateState);
}

function decide(action: GraphAction, reason: string, privateState?: string): GraphDecision {
  const decision: GraphDecision = { action, reason };
  if (privateState !== undefined) {
    decision.privateState = privateState;
  }
  return decision;
}
