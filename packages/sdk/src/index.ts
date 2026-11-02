// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

export type {
  ContractCheck,
  ReferenceSet,
  ResultContract,
} from "./result-contract.js";
export { applyReferenceEnums, checkContract, checkReferences, unsupportedSchemaKeywords, validateResultShape } from "./result-contract.js";

export type {
  AdversarialMutation,
  AdversarialResult,
  GraphRehearsal,
  GraphRehearsalExport,
  RehearsalBudgets,
  RehearsalCommandResult,
  RehearsalExpectation,
  RehearsalFailure,
  RehearsalReply,
  RehearsalScenario,
} from "./rehearsal.js";
export {
  assignmentNamesField,
  checkAssignmentFidelity,
  isRehearsalRunId,
  mutateAdversarially,
  REHEARSAL_RUN_ID_PREFIX,
  rehearsalBranchScope,
  synthesizeFromSchema,
} from "./rehearsal.js";

export type { RecordedAssignment, RecordedCall } from "./rehearsal-client.js";
export {
  adversarialMutationOnly,
  nextCommandOutcome,
  nextReply,
  nextRead,
  readCallLog,
  readRecordedAssignment,
  readUnverifiedReads,
  recordAssignment,
  recordCall,
  recordUnverifiedRead,
  rehearsalHomeDir,
  REHEARSAL_ADVERSARIAL_ENV,
  REHEARSAL_GITHUB_TOKEN_ENV,
  REHEARSAL_HOME_ENV,
  REHEARSAL_ONLY_ENV,
  REHEARSAL_SCENARIO_ENV,
  REHEARSAL_SYNTHESIZED_ENV,
  requireScenario,
  resetRehearsalScenarioCache,
  synthesizedRepliesOnly,
  withoutRehearsalEnv,
} from "./rehearsal-client.js";

export type {
  ActivateRepairSpec,
  AgentSessionView,
  ApprovalDeclaration,
  ApprovalInputDeclaration,
  ExecutorView,
  BudgetRemaining,
  BwrapBind,
  BwrapConfinement,
  CheckoutSpec,
  ConfinementSpec,
  CorrectionHandoff,
  DockerConfinement,
  EnvironmentCommand,
  EnvironmentDeclaration,
  EvidenceRecord,
  ExternalizedPart,
  EvidenceRef,
  Fingerprint,
  GraphAction,
  GraphDecision,
  GraphBudgetDefaults,
  AgentRoleDeclaration,
  SupervisorHarnessId,
  SupervisorPreference,
  GraphDefinition,
  GraphPlugin,
  JobId,
  JobKind,
  JobPurpose,
  JobSpec,
  ObserveSpec,
  OutstandingOperation,
  QualifyRepairSpec,
  RepairAuthorityView,
  RepairTarget,
  Receipt,
  ReenterSpec,
  Requirement,
  RequirementId,
  ResumeView,
  ReturnSpec,
  RunView,
  StageAttempt,
  StageDefinition,
  StageId,
  StopSpec,
  SuperviseSpec,
  SupervisorRepeatEntry,
  TaskInputs,
  ValidateSpec,
  ValidationInput,
  ValidationResult,
  ValidationStatus,
  Validator,
  ValidatorBinding,
  WireEnvelope,
  WireRequest,
  WireResponse,
} from "./types.js";

export type {
  DefineExecutorOptions,
  ExecutorBinding,
  ExecutorContext,
  ExecutorCredentials,
  ExecutorDefinition,
  ExecutorEffect,
  ExecutorId,
  ExecutorInputShape,
  ExecutorPackageManifest,
  ExecutorPin,
  ExecutorScope,
  ExecutorSession,
  ExecutorTools,
  ExecutorUsage,
  JsonSchemaValidator,
  ToolBinding,
  ToolCallEvidence,
  ToolCallRequest,
  ToolCallResult,
} from "./executor.js";

export { GRAPH_BUDGET_KEYS, PLUGIN_ROOT_ENV, PROTOCOL_VERSION, SUPERVISOR_HARNESSES } from "./types.js";

export {
  BUILTIN_AGENT_EXECUTOR_ID,
  BUILTIN_COMMAND_EXECUTOR_ID,
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_SESSION_REF_CHARS,
  MAX_JOB_TIMEOUT_MS,
  MAX_TIMEOUT_CONTINUATIONS,
  MAX_TOOL_BINDINGS,
  assertBoundedJson,
  assertToolBindings,
  assertExecutorId,
  assertExecutorPin,
  builtinPinForKind,
  defineExecutor,
  pinJobExecutor,
  validateExecutorInput,
  checkExecutorInput,
  boundedInputShape,
  MAX_INPUT_SHAPE_BYTES,
} from "./executor.js";
export { jsonSchemaProblem } from "./input-problem.js";
export { assertConfinement, confinementProblem, READONLY_SANDBOX_ENV, SCRATCH_MOUNT_PREFIX } from "./confinement.js";

export {
  activateRepair,
  dispatch,
  observe,
  qualifyRepair,
  reenter,
  returnToNormal,
  stop,
  supervise,
  validate,
} from "./operations.js";

export {
  ACTION_SPEC_KEYS,
  WireValidationError,
  assertGraphAction,
  assertGraphDecision,
  assertGraphDefinition,
  assertGraphRehearsal,
  assertRunView,
  assertWireRequest,
  assertWireResponse,
  MAX_APPROVAL_FILE_BYTES,
  MAX_APPROVAL_INPUT_CHARS,
  MAX_APPROVAL_INPUTS,
  assertValidationInput,
  assertValidationResult,
  maxWireBytes,
  parseJsonBounded,
} from "./validate.js";

export type { PrepareTaskInput, PrepareTaskReply, TaskPlan, TaskPlanRefusal, TaskPlanStep } from "./task-plan.js";
export {
  isTaskPlanRefusal,
  MAX_TASK_FIELD_BYTES,
  MAX_TASK_PLAN_BYTES,
  MAX_TASK_PLAN_NAMES,
  MAX_TASK_PLAN_STEPS,
  planReferences,
  refFormatProblem,
  substitutePlan,
  TASK_PLAN_FIELDS,
  taskPlanNamespace,
  TaskPlanError,
  validateTaskPlan,
} from "./task-plan.js";

export { executorFailureOf, failuresSinceResume, isStaleFailure, type ExecutorFailureEvidence } from "./resume.js";

export { createScriptedGraph, type ScriptedAdvance, type ScriptedGraphOptions } from "./scripted.js";

export { writeScopeAllows, writeScopeExceptions, writeScopeExcludes, writeScopeIncludes, writeScopeProblem } from "./scope.js";

export { stableHash, stableJson } from "./stable-hash.js";

export {
  DEFAULT_EXTERNALIZE_THRESHOLD,
  EVIDENCE_STORE_ENV,
  EvidenceUnavailableError,
  evidenceBlobName,
  evidenceBlobPath,
  assertDisjointParts,
  evidenceStoreReader,
  overlappingParts,
  externalizePayload,
  hydrateRecord,
  installLazyPayload,
  isEvidenceUnavailable,
  parseEvidenceBlob,
  readEvidencePart,
  writeEvidenceBlobs,
  type EvidenceBlob,
  type EvidenceFs,
  type EvidencePartReader,
  type ExternalizedPayload,
} from "./evidence-store.js";

export type {
  CaseAttempt,
  CaseDependency,
  CaseFact,
  CaseFile,
  CaseFinding,
  CaseFindingOutcome,
  CaseOpenQuestion,
  CaseRefutation,
  CaseStaleness,
} from "./case-file.js";
export {
  emptyCaseFile,
  MAX_CASE_ATTEMPTS,
  MAX_CASE_FACTS,
  MAX_CASE_OPEN,
  MAX_CASE_REFS,
  MAX_CASE_REFUTED,
  MAX_CASE_TEXT,
} from "./case-file.js";
