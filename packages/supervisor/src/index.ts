/** Supervisor package — Pi SDK session adapter and recovery protocol. */

export {
  resolveMiniMaxCredential,
  type MiniMaxCredentialSource,
  type ResolvedMiniMaxCredential,
} from "./credentials.js";

export {
  createPiSupervisorSession,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SUPERVISOR_PROVIDER,
  isMiniMaxProvider,
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
} from "./pi-session.js";

export {
  createScriptedSupervisor,
  type RecoveryTrigger,
  type ScriptedRecoveryStep,
  type ScriptedSupervisorOptions,
  type Supervisor,
  type SupervisorInput,
} from "./types.js";
