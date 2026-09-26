/** Supervisor package — Pi SDK session adapter and recovery protocol. */

export {
  resolveMiniMaxCredential,
  type MiniMaxCredentialSource,
  type ResolvedMiniMaxCredential,
} from "./credentials.js";

export {
  parseSupervisorDecision,
} from "./decision.js";

export {
  createPiSupervisorSession,
  ensureProviderCredentials,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SUPERVISOR_PROVIDER,
  isMiniMaxProvider,
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
} from "./pi-session.js";

export {
  buildRecoveryPrompt,
  buildRepairPrompt,
  createPiSupervisor,
  type CreatePiSupervisorOptions,
  type ModelSwitchRecord,
  type PiSupervisor,
  type PiSupervisorSessionPort,
  type SupervisorBinding,
  type SupervisorModelRef,
} from "./pi-supervisor.js";

export {
  assertAdmittedCandidateRoot,
  CANDIDATE_CODING_TOOL_NAMES,
} from "./candidate-tools.js";

export {
  reconcileSupervisorBinding,
  restorePiSupervisorFromBinding,
  type RestorePiSupervisorOptions,
} from "./restore.js";

export {
  createAdmissionTools,
  GRAPHLOOM_SUPERVISOR_ACTIONS,
  SWITCH_MODEL_TOOL,
  type AdmissionToolbox,
  type GraphLoomSupervisorAction,
} from "./tools.js";

export {
  createScriptedSupervisor,
  isModelSwitchRequest,
  type CandidatePatchRequest,
  type ModelRef,
  type ModelSwitchRequest,
  type RecoveryTrigger,
  type ScriptedRecoveryStep,
  type ScriptedSupervisorOptions,
  type Supervisor,
  type SupervisorInput,
  type SupervisorProposal,
  type SupervisorSettlement,
} from "./types.js";
