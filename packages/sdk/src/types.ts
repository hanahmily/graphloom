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
  /**
   * Requirement IDs whose evidence this requirement's validator reads as
   * context. Their currently admitted bindings are pinned into this
   * requirement's receipt as prerequisiteBindings, so a later qualified
   * replacement of any of them invalidates this receipt too.
   */
  prerequisiteRequirementIds?: RequirementId[];
  /**
   * When this requirement's evidence is not workspace bytes (e.g. a decision
   * record an agent can revise before any code changes), the resultSchema of
   * the job output whose digest anchors this requirement's receipt in
   * acceptedIdentity, keyed by this same string.
   */
  identityArtifactSchema?: string;
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
  /** What the run's workspace needs before any stage runs; the controller enforces it. */
  environment?: EnvironmentDeclaration;
  /**
   * Shapes this graph's own agent jobs ask for, by the name it gives each in
   * JobSpec.resultSchema and a requirement's evidenceSchema. The SDK and
   * controller carry these opaquely; see docs/design-agent-contract-robustness.md.
   */
  resultContracts?: import("./result-contract.js").ResultContract[];
}

/** A command the controller runs with the built-in command executor. */
export interface EnvironmentCommand {
  id: string;
  argv: string[];
  timeoutMs?: number;
}

export interface EnvironmentDeclaration {
  /**
   * Tools the run needs. The controller runs them in the worktree before any
   * job at the start of a run, on every resume, and after a repair is
   * activated. A failing check stops the run.
   */
  checks?: EnvironmentCommand[];
  /**
   * Preparation such as code generation, run after the checks in the worktree
   * and in every disposable checkout. It may change only files Git ignores.
   */
  prepare?: EnvironmentCommand[];
  /**
   * Files this declaration was written against, by SHA-256 of their bytes at
   * the pinned base commit. A mismatch blocks normal jobs; only a qualified
   * repair that updates the declaration lets the run continue.
   */
  pinnedFiles?: Array<{ path: string; sha256: string }>;
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
  /** The workspace change this receipt accepted; the run cannot complete once it changes. */
  candidateDigest?: Fingerprint;
  /**
   * Component digests that must stay unchanged for this receipt to stay
   * valid: "workspace" plus, for a requirement whose evidence is not
   * workspace bytes, a named artifact digest keyed by its
   * Requirement.identityArtifactSchema.
   */
  acceptedIdentity?: Record<string, Fingerprint>;
  /**
   * Full validator identity (validatorId and version) of every other
   * requirement this receipt's evidence depended on at acceptance time.
   * A requirement's own Requirement.prerequisiteRequirementIds names them.
   */
  prerequisiteBindings?: Record<RequirementId, ValidatorBinding>;
}

export interface EvidenceRecord {
  ref: EvidenceRef;
  kind: "file" | "command" | "workspace" | "review" | "other";
  fingerprint?: Fingerprint;
  payload?: unknown;
  /** Controller generation that produced this evidence: producer metadata and a version-transition/crash-recovery fence, not a freshness boundary. */
  generation?: number;
  /**
   * Digest of the workspace change (every path that differs from the pinned
   * base commit, with its content) the evidence was produced against.
   */
  candidateDigest?: Fingerprint;
  /** The producing job's declared JobSpec.resultSchema, stamped by the controller; anchors a non-workspace requirement's acceptedIdentity component. */
  resultSchema?: string;
  /** Outcome of checking this evidence against its producing job's declared result contract, when it named one. */
  contract?: {
    name: string;
    status: "valid" | "invalid" | "repaired";
    problems: string[];
    repairs?: string[];
  };
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
  /** Milliseconds of execution the run has left; it runs down only while a controller is running the run. */
  activeMs?: number;
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
  /** Digest of the current workspace change; compare with `EvidenceRecord.candidateDigest`. */
  candidateDigest?: Fingerprint;
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
  /** Settled dispatches whose agent session a later job of the same stage may continue. */
  agentSessions?: AgentSessionView[];
  /** What repair the operator authorized and the bundle's code permits. */
  repairAuthority?: RepairAuthorityView;
  /**
   * Stages reentered but not yet settled by a fresh work-purpose dispatch in
   * the current attempt. Stage-selection must treat these as still open
   * regardless of receipt validity: a reentry whose candidate has not
   * changed yet leaves receipts valid, and without this a stage-selection
   * rule that reads receipts alone would skip the reentered stage entirely.
   */
  openAttempt?: Record<StageId, boolean>;
  /**
   * Correction-escalation and repeat-proposal state the supervisor needs.
   * Present only when at least one of the three is non-empty.
   */
  escalation?: {
    correctionTrials: Record<string, number>;
    handoff: Record<string, CorrectionHandoff>;
    repeatedProposals: Record<string, SupervisorRepeatEntry>;
  };
}

/** Why a stage's correction trials are handed off to the supervisor. */
export interface CorrectionHandoff {
  since: string;
  reason: string;
  trials: number;
}

/** A supervisor proposal repeated with no progress since it was last made. */
export interface SupervisorRepeatEntry {
  triggerCode: string;
  stageId?: string;
  actionType: string;
  count: number;
}

export interface RepairAuthorityView {
  /** `opaque`: the bundle's code cannot be patched; only validator substitution may apply. */
  contract: "source-repairable" | "opaque";
  grants: { sourceRepair: boolean; validatorSubstitution: boolean; executorRepair: boolean };
}

export interface AgentSessionView {
  operationId: string;
  stageId: StageId;
  attempt: number;
  generation: number;
  /** A continuation must have the same key: `jobId`, or `purpose:executorId`. */
  dispatchKey: string;
  executorId: string;
  status: "ok" | "failed" | "conflict";
  /** Operation this session continued, when it was not fresh. */
  continuedFrom?: string;
}

export type JobKind = "agent" | "command";
export type JobPurpose = "work" | "check" | "review" | "repair" | "diagnostic" | "verify";

export interface JobSpec {
  jobId?: JobId;
  stageId: StageId;
  kind: JobKind;
  purpose: JobPurpose;
  /** Agent prompt or command argv description. */
  instruction: string;
  resultSchema?: string;
  /** Paths the job may change: `path`, `.` for the whole workspace, `!path` to forbid one. */
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
  /**
   * Operation id of an earlier dispatch in this run (see `RunView.agentSessions`)
   * whose agent session this job continues. Omit to start a fresh session.
   */
  continueFrom?: string;
  /**
   * Run a read-only command job in a disposable checkout instead of the
   * worktree. The controller commits the checkout's contents, runs the graph's
   * environment checks and preparation there, and records any file the
   * preparation or the job changed.
   */
  checkout?: CheckoutSpec;
  /**
   * Per-dispatch valid id sets for this job's declared result contract's own
   * `references` paths (e.g. "findings[].finding"), keyed by that same path.
   * The harness constrains the model to these ids and validates the result
   * against them; absent when the contract names no references, or this
   * dispatch has none open yet.
   */
  knownReferences?: Record<string, import("./result-contract.js").ReferenceSet>;
}

/**
 * `candidate`: the pinned base commit plus the whole current workspace change.
 * `base`: the pinned base commit plus only the listed changed paths, such as
 * new tests, to show they fail without the rest of the change.
 */
export type CheckoutSpec = { from: "candidate" } | { from: "base"; paths: string[] };

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
  /**
   * The disputed requirement. Required for a `validator` target on an opaque
   * bundle: substitution needs that requirement pinned readably in the manifest.
   */
  requirementId?: RequirementId;
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
  /**
   * Evidence of earlier generations, oldest first. Context only: a receipt
   * rests on `evidence`, so a validator must not pass from history alone.
   */
  history?: EvidenceRecord[];
  candidateFingerprint?: Fingerprint;
  /** Digest of the live workspace change being accepted. */
  candidateDigest?: Fingerprint;
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
