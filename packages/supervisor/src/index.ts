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
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SUPERVISOR_PROVIDER,
  isMiniMaxProvider,
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
} from "./pi-session.js";

export {
  buildRecoveryPrompt,
  createPiSupervisor,
  type CreatePiSupervisorOptions,
  type ModelSwitchRecord,
  type PiSupervisor,
  type PiSupervisorSessionPort,
  type SupervisorBinding,
  type SupervisorModelRef,
} from "./pi-supervisor.js";

export {
  GRAPHLOOM_SUPERVISOR_ACTIONS,
  PROPOSE_DECISION_TOOL,
  type GraphLoomSupervisorAction,
} from "./tools.js";

export {
  createScriptedSupervisor,
  type RecoveryTrigger,
  type ScriptedRecoveryStep,
  type ScriptedSupervisorOptions,
  type Supervisor,
  type SupervisorInput,
} from "./types.js";
