// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

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
  /**
   * The agent roles this graph's jobs play (for the task config it was
   * described with), for the operator's `graphloom doctor --task`
   * (docs/design-release.md §4.4). Returned from code like `defaultBudgets`.
   * The SDK checks the shape only; the controller never reads it, and the
   * CLI treats `role` and `setting` as opaque text.
   */
  agentRoles?: AgentRoleDeclaration[];
  /**
   * Which supervisor harness this graph prefers for its recovery
   * (docs/design-supervisor-harnesses.md §7.1), for the task config it was
   * described with. Returned from code like `defaultBudgets`. The SDK checks
   * the shape only; the controller stores it with the run, read at intake and
   * never compared on resume or repair, and the CLI resolves it against the
   * operator's enabled harnesses.
   */
  supervisor?: SupervisorPreference;
  /**
   * Decisions the graph asks the operator to make with `graphloom resume
   * <run> --approve <id>` or `--decline <id>`, as data. The controller
   * records each decision as `operator-approval` evidence under the run lock
   * and never reads what an approval means; the graph's `advance` does.
   */
  approvals?: ApprovalDeclaration[];
}

/** One operator decision a graph declares (`GraphDefinition.approvals`; docs/design-pr-review-graph.md section 11). */
export interface ApprovalDeclaration {
  /** The id `--approve` and `--decline` name: `[a-z][a-z0-9-]{0,63}`. */
  id: string;
  /** The stage the approval opens, shown as is; the controller does not look it up. */
  stageId?: string;
  /** One line telling the operator what approving means. */
  description?: string;
  /**
   * Worktree-relative files whose bytes an approval pins (path, SHA-256,
   * size) in its evidence; at most 256 KiB together.
   */
  files?: string[];
  /**
   * Set when this version cannot act on an approval (for example, the stage
   * it opens does not exist yet): `--approve` is refused with this message,
   * and `--decline` still records.
   */
  unavailable?: string;
  /**
   * Named values the operator may give with `--approve <id> --input
   * <name>=<value>`, as data. The controller checks each against its
   * declaration (declared name, `pattern`, `MAX_APPROVAL_INPUT_CHARS`), records
   * the values in the `operator-approval` evidence and never reads what one
   * means; the graph's `advance` does.
   */
  inputs?: ApprovalInputDeclaration[];
}

/** One operator input of an approval (`ApprovalDeclaration.inputs`). */
export interface ApprovalInputDeclaration {
  /** The name `--input` gives: `[a-z][a-z0-9-]{0,31}`, unique within the approval. */
  name: string;
  /** One line telling the operator what the value is. */
  description?: string;
  /** A regular expression the whole value must match (the controller anchors it); absent, any value of up to `MAX_APPROVAL_INPUT_CHARS`. */
  pattern?: string;
}

/** The supervisor harnesses a graph may name (docs/design-supervisor-harnesses.md §7.1). */
export const SUPERVISOR_HARNESSES = ["pi", "claude-code", "codex"] as const;
export type SupervisorHarnessId = (typeof SUPERVISOR_HARNESSES)[number];

/** A graph's supervisor preference (`GraphDefinition.supervisor`). */
export interface SupervisorPreference {
  /** The graph's order; the first one the operator enabled and that is available here is used. */
  harnesses: SupervisorHarnessId[];
  /**
   * Model hints per harness, best first. Each is honored only when the
   * operator configured that model for the harness, and then reorders the
   * operator's models; an unconfigured hint is ignored.
   */
  models?: Partial<Record<SupervisorHarnessId, string[]>>;
  /** Refuse the run instead of falling back to the operator's order; default false. */
  required?: boolean;
}

/** One agent role a graph declares (`GraphDefinition.agentRoles`). */
export interface AgentRoleDeclaration {
  /** The plugin's own name for the role, shown as is. */
  role: string;
  /** The harness the resolved profile assigns, such as `claude-code`. */
  harness: string;
  /** Whether the role's jobs change the workspace. */
  access: "read" | "write";
  /** Roles whose harness this one must not share. */
  distinctFrom?: string[];
  /** Where the operator changes the harness, such as `harnesses.verifier`. */
  setting?: string;
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

/**
 * Environment variable the controller sets for every environment check and
 * preparation command: the absolute path of the graph bundle's root directory
 * (the directory holding `graphloom.manifest.json`). A check runs in the
 * worktree, so this is how it finds what the bundle ships, such as a tool from
 * the bundle's own dependencies or a script of its own.
 */
export const PLUGIN_ROOT_ENV = "GRAPHLOOM_PLUGIN_ROOT";

export interface EnvironmentDeclaration {
  /**
   * Tools the run needs. The controller runs them in the worktree before any
   * job at the start of a run, on every resume, and after a repair is
   * activated. A failing check stops the run. Checks and preparation see the
   * bundle's root in `$GRAPHLOOM_PLUGIN_ROOT` (PLUGIN_ROOT_ENV).
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

/**
 * A part of an evidence payload the controller moved out into a content-addressed blob
 * (`<stateDir>/evidence/sha256/<hex>.json`); the payload holds `null` where it was.
 */
export interface ExternalizedPart {
  /** Keys and indexes from the payload root to the part; never empty. */
  path: Array<string | number>;
  /** SHA-256 (hex) of the part's JSON text, which is also the blob's name. */
  sha256: string;
  /** Size of that JSON text in bytes. */
  bytes: number;
}

export interface EvidenceRecord {
  ref: EvidenceRef;
  kind: "file" | "command" | "workspace" | "review" | "other";
  fingerprint?: Fingerprint;
  payload?: unknown;
  /** Large payload parts stored outside the record; each is `null` in `payload` at its path. Absent when the payload is inline. */
  externalized?: ExternalizedPart[];
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
   * Executors the run pinned that declare an input shape, as declared data
   * the controller does not read. The supervisor composes dispatch input
   * against them; a graph may check the input it composes against the limits
   * they declare (`jsonSchemaProblem`) before it dispatches.
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
  /** The declared input shape; absent for an executor that declares none. */
  inputShape?: ExecutorInputShape;
  /**
   * The effect the executor declares and whether the operator's grants allow
   * it now (the runner refuses its jobs when not). Declared data the controller
   * does not interpret: a plugin checks it before it dispatches an executor
   * whose effect may be withheld, instead of learning of the refusal from a
   * failed job. Both absent when the runner does not report them.
   */
  effect?: import("./executor.js").ExecutorEffect;
  effectGranted?: boolean;
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
  /** The harness's own id of the session (`claude-<uuid>`, `codex-<uuid>`), which an `operator-conversation` evidence record names as its `forkSession`. */
  sessionRef?: string;
  /** When the session's last turn settled (ISO 8601); a conversation's `endedAt`. */
  settledAt?: string;
  /** Operation this session continued, when it was not fresh. */
  continuedFrom?: string;
  /** The harness that ran the session (`claude-code`, `codex`, `pi`). */
  harness?: string;
  /** `operator` for a conversation an operator had with a fork (`graphloom session open`); absent for a job's session. */
  origin?: "operator";
  /** A conversation's parent: the `operationId` of the session it forked. */
  parent?: string;
  /** The input context of the session's last model call (a conversation's); a plugin compares it with its own bound. */
  contextTokens?: number;
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
   * Wall-clock limit (ms) this job asks for, instead of the operator's default
   * for its executor; at most `MAX_JOB_TIMEOUT_MS`. Bounded twice: the runner
   * clamps it to the operator's ceiling for the executor
   * (`ExecutorBinding.maxTimeoutMs`), and the controller aborts any job when
   * the run's active-time budget runs out. A job may also ask for less.
   */
  timeoutMs?: number;
  /**
   * Agent jobs: how many times the controller continues this job's own
   * agent session (`continueFrom` the timed-out operation) when the job runs
   * out of its wall clock after changing the worktree, before the timeout
   * goes to recovery. The allowance is per attempt: each dispatch the graph
   * or supervisor makes gets its own, and the continuations (and controller
   * retries) chained from it share it, durably across a resume. Each
   * continuation is a dispatch charged to the run's budgets like any other.
   * A timeout without a worktree change or a resumable session, or past
   * this bound, goes to recovery as before. Default 0; at most
   * `MAX_TIMEOUT_CONTINUATIONS`.
   */
  timeoutContinuations?: number;
  /**
   * Run a read-only command job in a disposable checkout instead of the
   * worktree. The controller commits the checkout's contents, runs the graph's
   * environment checks and preparation there, and records any file the
   * preparation or the job changed.
   */
  checkout?: CheckoutSpec;
  /**
   * How the runner confines this job beyond the run's own scope; the job is
   * refused, never run unconfined, where the machine cannot enforce it.
   * `bwrap`: a bubblewrap sandbox for an agent or tool. `docker`: a container
   * for a command job that runs untrusted code (the commands run inside it).
   */
  confinement?: ConfinementSpec;
  /**
   * Per-dispatch valid id sets for this job's declared result contract's own
   * `references` paths (e.g. "findings[].finding"), keyed by that same path.
   * The harness constrains the model to these ids and validates the result
   * against them; absent when the contract names no references, or this
   * dispatch has none open yet.
   */
  knownReferences?: Record<string, import("./result-contract.js").ReferenceSet>;
}

/** A path bound into a bubblewrap sandbox; `~` stands for the operator's home. */
export interface BwrapBind {
  path: string;
  readOnly: boolean;
}

/**
 * Bubblewrap confinement: the root filesystem is read-only, the home
 * directory is replaced by an empty tmpfs (holes only for the executor's own
 * state, such as an agent's login, and the paths the executor needs to start),
 * `mask` paths are hidden, `binds` are added, and `network: false` leaves the
 * job with no network at all. Absolute paths, or `~`-relative ones.
 */
export interface BwrapConfinement {
  kind: "bwrap";
  network: boolean;
  mask: string[];
  binds: BwrapBind[];
}

/**
 * Docker confinement for a command job: each command runs inside one
 * `docker run` of `image` (pinned by `@sha256:` digest, never pulled by the
 * run) with no network, a read-only root, a user-owned `tmp`, dropped
 * capabilities and these limits. `writable` and `readOnly` name the only host
 * paths mounted, each at the same path: absolute, `.` (the job's workspace),
 * a path relative to it, or `@scratch/<dir>` under the run's scratch
 * directory. `env` is the whole environment the commands see.
 */
export interface DockerConfinement {
  kind: "docker";
  image: string;
  cpus: number;
  /** Memory and swap limit, such as `8g`. */
  memory: string;
  pids: number;
  /** Size of `/tmp`, such as `1g`. */
  tmp: string;
  /** Wall clock (ms) of each command's container. */
  wallClockMs: number;
  writable: string[];
  readOnly: string[];
  env: Record<string, string>;
}

export type ConfinementSpec = BwrapConfinement | DockerConfinement;

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
  /**
   * Optional: turn the arguments of `graphloom task new` into a task plan,
   * or refuse them (docs/design-typescript-core.md section 16). Pure over its
   * input: it reads no file, runs no process and has no network.
   */
  prepareTask?(input: import("./task-plan.js").PrepareTaskInput): import("./task-plan.js").PrepareTaskReply;
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
  | (WireEnvelope & { kind: "rehearsal"; entry: string; config?: unknown })
  | (WireEnvelope & { kind: "prepare_task"; input: import("./task-plan.js").PrepareTaskInput });

export type WireResponse =
  | (WireEnvelope & { kind: "describe_ok"; definition: GraphDefinition })
  | (WireEnvelope & { kind: "advance_ok"; decision: GraphDecision })
  | (WireEnvelope & { kind: "evaluate_ok"; result: ValidationResult })
  | (WireEnvelope & { kind: "rehearsal_ok"; rehearsal?: GraphRehearsal })
  | (WireEnvelope & { kind: "prepare_task_ok"; reply?: import("./task-plan.js").PrepareTaskReply })
  | (WireEnvelope & {
      kind: "error";
      code: "malformed" | "stale" | "oversized" | "unknown" | "internal" | "evidence_unavailable";
      message: string;
    });
