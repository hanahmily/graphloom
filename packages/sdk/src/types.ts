/** Public value contracts for GraphLoom plugins. No Accept operation exists. */

export const PROTOCOL_VERSION = 1 as const;

export type StageId = string;
export type RequirementId = string;
export type JobId = string;
export type EvidenceRef = string;
export type Fingerprint = string;

export type ValidationStatus = "passed" | "failed" | "inconclusive";

export interface Requirement {
  id: RequirementId;
  /** Human-readable statement independent of the checking predicate. */
  statement: string;
  evidenceSchema: string;
}

export interface ValidatorBinding {
  requirementId: RequirementId;
  validatorId: string;
  version: string;
  independence?: "none" | "separate-reviewer";
}

export interface StageDefinition {
  id: StageId;
  name: string;
  requirementIds: RequirementId[];
}

export interface GraphDefinition {
  graphId: string;
  version: string;
  stages: StageDefinition[];
  requirements: Requirement[];
  defaultValidators: ValidatorBinding[];
  privateStateSchema?: string;
}

export interface TaskInputs {
  request: string;
  repo?: string;
  options?: Record<string, unknown>;
}

export interface StageAttempt {
  stageId: StageId;
  attempt: number;
}

export interface Receipt {
  id: string;
  stageId: StageId;
  requirementId: RequirementId;
  validatorBinding: ValidatorBinding;
  candidateFingerprint: Fingerprint;
  evidenceRefs: EvidenceRef[];
  valid: boolean;
}

export interface EvidenceRecord {
  ref: EvidenceRef;
  kind: "file" | "command" | "workspace" | "review" | "other";
  fingerprint?: Fingerprint;
  payload?: unknown;
  /** Controller generation that produced this evidence; used for freshness admission. */
  generation?: number;
}

export interface OutstandingOperation {
  operationId: string;
  kind: string;
  stageId?: StageId;
}

export interface BudgetRemaining {
  agentInvocations: number;
  jobs: number;
  decisions: number;
  corrections: number;
  /** Milliseconds the controller may still spend waiting out executor retry timing. */
  waitMs?: number;
}

export interface RunView {
  runId: string;
  task: TaskInputs;
  current: StageAttempt;
  receipts: Receipt[];
  evidence: EvidenceRecord[];
  outstanding: OutstandingOperation[];
  budgets: BudgetRemaining;
  validatorBindings: ValidatorBinding[];
  recoveryEpisodeId?: string;
  privateState?: string;
  generation: number;
  stateRevision: number;
  activeVersion: string;
  /**
   * Qualified / rejected repair candidates visible to the supervisor for
   * ActivateRepair decisions (artifact ids and status only).
   */
  repairCandidates?: Array<{
    artifactId: string;
    status: string;
    target: RepairTarget;
    executorId?: string;
    reason: string;
    candidateDigest?: string;
    qualifiedAt?: string;
    rejectionReason?: string;
    preflightSummary?: string;
    patchSummary?: string;
  }>;
}

export type JobKind = "agent" | "command";
export type JobPurpose = "work" | "check" | "review" | "repair" | "diagnostic";

export interface JobSpec {
  jobId?: JobId;
  stageId: StageId;
  kind: JobKind;
  purpose: JobPurpose;
  /** Agent prompt or command argv description. */
  instruction: string;
  resultSchema?: string;
  writeScope?: string[];
  readOnly?: boolean;
  /**
   * Pinned executor identity for durable admission.
   * When omitted, the controller pins a built-in agent/command executor from `kind`.
   */
  executor?: import("./executor.js").ExecutorPin;
  /** Bounded JSON-serializable input for the pinned executor. */
  input?: unknown;
  /** Declared effect; the runner refuses an executor whose effect differs. */
  effect?: import("./executor.js").ExecutorEffect;
  /** Tools the job's agent may call; each call is admitted as a child operation. */
  tools?: import("./executor.js").ToolBinding[];
}

export interface ObserveSpec {
  paths?: string[];
  includeWorkspaceManifest?: boolean;
  commandId?: string;
}

export interface ValidateSpec {
  stageId: StageId;
  candidateFingerprint?: Fingerprint;
  requirementIds?: RequirementId[];
}

export interface ReenterSpec {
  stageId: StageId;
  reason: string;
  evidenceRefs?: EvidenceRef[];
}

export interface SuperviseSpec {
  reason: string;
  evidenceRefs?: EvidenceRef[];
}

export type RepairTarget = "plugin" | "validator" | "executor";

export interface QualifyRepairSpec {
  target: RepairTarget;
  /** Required for `executor`: a pinned executor id; its whole package is copied and repaired. */
  executorId?: string;
  reason: string;
  evidenceRefs?: EvidenceRef[];
}

export interface ActivateRepairSpec {
  qualifiedArtifactId: string;
  reason: string;
}

export interface ReturnSpec {
  summary: string;
  evidenceRefs?: EvidenceRef[];
}

export interface StopSpec {
  reason: string;
  blocker: string;
  evidenceRefs?: EvidenceRef[];
}

export type GraphAction =
  | { type: "dispatch"; job: JobSpec }
  | { type: "observe"; observe: ObserveSpec }
  | { type: "validate"; validate: ValidateSpec }
  | { type: "reenter"; reenter: ReenterSpec }
  | { type: "supervise"; supervise: SuperviseSpec }
  | { type: "qualify_repair"; qualify: QualifyRepairSpec }
  | { type: "activate_repair"; activate: ActivateRepairSpec }
  | { type: "return"; return: ReturnSpec }
  | { type: "stop"; stop: StopSpec };

export interface GraphDecision {
  action: GraphAction;
  reason: string;
  privateState?: string;
}

export interface ValidationInput {
  requirementId: RequirementId;
  statement: string;
  evidence: EvidenceRecord[];
  candidateFingerprint?: Fingerprint;
}

export interface ValidationResult {
  status: ValidationStatus;
  reason: string;
  evidenceRefs?: EvidenceRef[];
}

export interface GraphPlugin {
  describe(): GraphDefinition;
  advance(view: RunView): GraphDecision;
}

export interface Validator {
  evaluate(input: ValidationInput): ValidationResult;
}

/** Envelope fields for cross-process messages (host ↔ plugin). */
export interface WireEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  runId: string;
  operationId: string;
  generation: number;
  expectedStateRevision: number;
  activeVersion: string;
  recoveryEpisodeId?: string;
}

export type WireRequest =
  | (WireEnvelope & { kind: "describe" })
  | (WireEnvelope & { kind: "advance"; view: RunView })
  | (WireEnvelope & {
      kind: "evaluate";
      validatorId: string;
      input: ValidationInput;
    });

export type WireResponse =
  | (WireEnvelope & { kind: "describe_ok"; definition: GraphDefinition })
  | (WireEnvelope & { kind: "advance_ok"; decision: GraphDecision })
  | (WireEnvelope & { kind: "evaluate_ok"; result: ValidationResult })
  | (WireEnvelope & {
      kind: "error";
      code: "malformed" | "stale" | "oversized" | "unknown" | "internal";
      message: string;
    });
