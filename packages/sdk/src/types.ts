/** Public value contracts for GraphLoom plugins. No Accept operation exists. */

import type { ExecutorInputShape } from "./executor.js";
import type { GraphRehearsal } from "./rehearsal.js";

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
  /**
   * Budgets this graph (or the task config it was described with) expects a
   * run to need. Intake applies them over the controller's defaults and
   * under the task's own `budgets`; each stays finite and is validated the
   * same way. Not compared on resume or repair: a run keeps the budgets it
   * was intaken with.
   */
  defaultBudgets?: GraphBudgetDefaults;
}

/** Run budget defaults a graph may declare; every value is a positive safe integer. */
export interface GraphBudgetDefaults {
  agentInvocations?: number;
  jobs?: number;
  decisions?: number;
  corrections?: number;
  waitMs?: number;
  activeMs?: number;
  recoveryReserve?: number;
  probes?: number;
}

/** The budget names a graph's `defaultBudgets` may set. */
export const GRAPH_BUDGET_KEYS = [
  "agentInvocations",
  "jobs",
  "decisions",
  "corrections",
  "waitMs",
  "activeMs",
  "recoveryReserve",
  "probes",
] as const satisfies ReadonlyArray<keyof GraphBudgetDefaults>;

/** A command the controller runs with the built-in command executor. */
export interface EnvironmentCommand {
  id: string;
  argv: string[];
  timeoutMs?: number;
  /**
   * Prepare commands only; declared together with `outputs`. Repository-relative
   * globs (`**`, `*`, `?`; a leading `!` excludes) of the files the command's
   * output depends on. The controller keys a run-scoped cache by the digest of
   * these files' contents in the checkout plus `argv`, so list everything the
   * command reads: a file missing from here can leave stale output restored.
   */
  inputs?: string[];
  /**
   * Globs of the files and relative symbolic links the command writes. After a
   * successful run they are saved; a later checkout whose inputs are unchanged
   * gets them copied back and the command does not run. List only what the
   * command writes, and only files the repository ignores.
   */
  outputs?: string[];
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
  /** Dry-run probes the supervisor may still run; absent when the task sets no probe budget. */
  probes?: number;
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
  /**
   * Executors the run pinned that declare an input shape. Carried to the
   * supervisor only (a graph composes its own input), as declared data the
   * controller does not read.
   */
  executors?: ExecutorView[];
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
   * The task's config: the JSON file the task file's `config:` names, as
   * pinned at intake (a resume uses the pinned copy, never the file on disk).
   * Opaque to the controller, which never reads a field of it; the plugin
   * host attaches it to every call. Absent when the task names no config.
   */
  config?: unknown;
  /**
   * Correction-escalation and repeat-proposal state the supervisor needs.
   * Present only when at least one of the three is non-empty.
   */
  escalation?: {
    correctionTrials: Record<string, number>;
    handoff: Record<string, CorrectionHandoff>;
    repeatedProposals: Record<string, SupervisorRepeatEntry>;
  };
  /**
   * The operator's latest resume of this run, filled by the controller on
   * every resume and absent in a run never resumed. Evidence recorded at an
   * earlier generation than `generation` predates it: a failure there is
   * not by itself a reason to stop again (see `isStaleFailure`).
   */
  resume?: ResumeView;
}

/** What the controller tells a graph about the operator's latest resume (docs/design-typescript-core.md §8). */
export interface ResumeView {
  /** The generation the resume started; evidence from an earlier one predates it. */
  generation: number;
  /** When the resume happened (ISO 8601). */
  at: string;
  /** The operator updated the installed plugin bundle with this resume (`--update-plugin`). */
  pluginUpdated: boolean;
  /** Why the run had stopped before this resume; absent when it had not stopped cleanly (a crash). */
  previousStopReason?: string;
  /** How the controller classified that stop: retryable, or final with something since changed. */
  previousStopRetryable?: boolean;
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
  grants: {
    sourceRepair: boolean;
    validatorSubstitution: boolean;
    executorRepair: boolean;
    /** Supervisor-originated jobs may change the operator's machine outside the run's scope. */
    hostRepair?: boolean;
  };
}

export interface ExecutorView {
  id: string;
  inputShape: ExecutorInputShape;
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
export type CheckoutSpec =
  | {
      from: "candidate";
      /**
       * A unified diff (as `git diff` produces) applied in reverse to the
       * candidate checkout before commands run — undoing one specific,
       * already-identified behavioral change while keeping everything else
       * the candidate has (including earlier, already-accepted work the new
       * change may depend on to even build). The `"base"` variant below
       * cannot express this: it can only include or exclude whole paths from
       * the pinned base commit, which fails when the behavioral change and
       * the infrastructure it depends on live in the same file.
       */
      revertPatch?: string;
    }
  | { from: "base"; paths: string[] };

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
  /**
   * What an operator's resume does with this stop (docs/design-typescript-core.md §8).
   * `true` (the default): the stop is retryable, so a resume asks the graph
   * again and it decides from current evidence; a decision made because
   * something failed should then count only failures since the resume
   * (`failuresSinceResume`, `isStaleFailure`). `false`: the stop is final
   * (a maintainer must decide, the task is incompatible, a budget is spent),
   * so a resume surfaces the same blocker without asking the graph until
   * something the stop depends on changes: the plugin bundle or active
   * version, the workspace change, or a budget the operator raised.
   */
  retryable?: boolean;
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
  /**
   * Evidence refs and probe ids this decision rests on. A supervisor's `stop`,
   * `reenter`, or repair that blames a validator or executor must cite at
   * least one; the controller checks that each exists (or ran this episode).
   */
  evidence?: string[];
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
  /** The task's pinned config, as in `RunView.config`; absent when the task names none. */
  config?: unknown;
}

export interface ValidationResult {
  status: ValidationStatus;
  reason: string;
  evidenceRefs?: EvidenceRef[];
}

export interface GraphPlugin {
  /**
   * The run's graph definition. `config` is the task's pinned config (see
   * `RunView.config`), absent when the task names none; a graph whose
   * stages or requirements depend on it must return the same definition for
   * the same config, since the controller pins it for the whole run.
   */
  describe(config?: unknown): GraphDefinition;
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
  | (WireEnvelope & { kind: "describe"; config?: unknown })
  | (WireEnvelope & { kind: "advance"; view: RunView })
  | (WireEnvelope & {
      kind: "evaluate";
      validatorId: string;
      input: ValidationInput;
    })
  | (WireEnvelope & { kind: "rehearsal"; entry: string; config?: unknown });

export type WireResponse =
  | (WireEnvelope & { kind: "describe_ok"; definition: GraphDefinition })
  | (WireEnvelope & { kind: "advance_ok"; decision: GraphDecision })
  | (WireEnvelope & { kind: "evaluate_ok"; result: ValidationResult })
  | (WireEnvelope & { kind: "rehearsal_ok"; rehearsal?: GraphRehearsal })
  | (WireEnvelope & {
      kind: "error";
      code: "malformed" | "stale" | "oversized" | "unknown" | "internal";
      message: string;
    });
