import type { ActivateRepairSpec, GraphDecision, JobSpec, ObserveSpec, QualifyRepairSpec, ReenterSpec, ReturnSpec, StopSpec, SuperviseSpec, ValidateSpec } from "./types.js";
export declare function dispatch(job: JobSpec, reason: string, privateState?: string): GraphDecision;
export declare function observe(observeSpec: ObserveSpec, reason: string, privateState?: string): GraphDecision;
export declare function validate(validateSpec: ValidateSpec, reason: string, privateState?: string): GraphDecision;
export declare function reenter(reenterSpec: ReenterSpec, reason: string, privateState?: string): GraphDecision;
export declare function supervise(superviseSpec: SuperviseSpec, reason: string, privateState?: string): GraphDecision;
export declare function qualifyRepair(qualify: QualifyRepairSpec, reason: string, privateState?: string): GraphDecision;
export declare function activateRepair(activate: ActivateRepairSpec, reason: string, privateState?: string): GraphDecision;
export declare function returnToNormal(returnSpec: ReturnSpec, reason: string, privateState?: string): GraphDecision;
export declare function stop(stopSpec: StopSpec, reason: string, privateState?: string): GraphDecision;
//# sourceMappingURL=operations.d.ts.map