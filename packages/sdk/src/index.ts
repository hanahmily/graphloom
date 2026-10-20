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
export { assignmentNamesField, checkAssignmentFidelity, mutateAdversarially, synthesizeFromSchema } from "./rehearsal.js";

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
  REHEARSAL_HOME_ENV,
  REHEARSAL_SCENARIO_ENV,
  REHEARSAL_SYNTHESIZED_ENV,
  requireScenario,
  resetRehearsalScenarioCache,
  synthesizedRepliesOnly,
} from "./rehearsal-client.js";

export type {
  ActivateRepairSpec,
  AgentSessionView,
  ExecutorView,
  BudgetRemaining,
  CheckoutSpec,
  CorrectionHandoff,
  EnvironmentCommand,
  EnvironmentDeclaration,
  EvidenceRecord,
  EvidenceRef,
  Fingerprint,
  GraphAction,
  GraphDecision,
  GraphBudgetDefaults,
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
  ExecutorSession,
  ExecutorTools,
  ExecutorUsage,
  JsonSchemaValidator,
  ToolBinding,
  ToolCallEvidence,
  ToolCallRequest,
  ToolCallResult,
} from "./executor.js";

export { GRAPH_BUDGET_KEYS, PROTOCOL_VERSION } from "./types.js";

export {
  BUILTIN_AGENT_EXECUTOR_ID,
  BUILTIN_COMMAND_EXECUTOR_ID,
  MAX_EXECUTOR_INPUT_BYTES,
  MAX_SESSION_REF_CHARS,
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
  assertValidationInput,
  assertValidationResult,
  parseJsonBounded,
} from "./validate.js";

export { executorFailureOf, failuresSinceResume, isStaleFailure, type ExecutorFailureEvidence } from "./resume.js";

export { createScriptedGraph, type ScriptedAdvance, type ScriptedGraphOptions } from "./scripted.js";

export { writeScopeAllows, writeScopeExcludes, writeScopeIncludes, writeScopeProblem } from "./scope.js";

export { stableHash, stableJson } from "./stable-hash.js";

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
