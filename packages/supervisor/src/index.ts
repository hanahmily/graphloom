// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

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
  DEFAULT_PROMPT_INACTIVITY_MS,
  DEFAULT_PROMPT_TOTAL_TIMEOUT_MS,
  DEFAULT_SUPERVISOR_MODEL,
  DEFAULT_SUPERVISOR_PROVIDER,
  isMiniMaxProvider,
  type CreatePiSupervisorSessionOptions,
  type PiSupervisorSession,
  type ThinkingLevel,
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
  createCandidateReviewTools,
  CANDIDATE_CODING_TOOL_NAMES,
  CANDIDATE_REVIEW_TOOL_NAMES,
} from "./candidate-tools.js";

export {
  piEpisodeSessionOpener,
  reconcileSupervisorBinding,
  restorePiSupervisorFromBinding,
  type RestorePiSupervisorOptions,
} from "./restore.js";

export {
  createAdmissionTools,
  offeredActions,
  GRAPHLOOM_SUPERVISOR_ACTIONS,
  INSPECTION_TOOL_NAMES,
  RECORD_FINDING_TOOL,
  SWITCH_MODEL_TOOL,
  type AdmissionToolbox,
  type GraphLoomSupervisorAction,
} from "./tools.js";

export {
  createScriptedSupervisor,
  isModelSwitchRequest,
  type AdmissionCheck,
  type AdmissionFacts,
  type SupervisorAdmission,
  type SupervisorRejection,
  type CandidatePatchRequest,
  type EvidenceFilter,
  type ModelRef,
  type ModelSwitchRequest,
  type ProbeResult,
  type RecoveryTrigger,
  type ScriptedRecoveryStep,
  type ScriptedSupervisorOptions,
  type Supervisor,
  type SupervisorInput,
  type SupervisorInspection,
  type SupervisorProposal,
  type SupervisorRemedy,
  type SupervisorSettlement,
} from "./types.js";

export {
  classifyAssistantMessage,
  isSupervisorProviderError,
  retryAtFromMessage,
  SupervisorProviderError,
  type ProviderFailure,
  type ProviderFailureClass,
} from "./provider-failure.js";

export {
  boundValue,
  shrinkJson,
  boundRejections,
  buildEpisodeRecord,
  fitEpisodeRecord,
  createEpisodeRecorder,
  inspectionToolInput,
  toolInputKey,
  MAX_EPISODE_RECORDS,
  MAX_EPISODE_RECORD_CHARS,
  MAX_EPISODE_TOOL_CALLS,
  MAX_EPISODE_TOOL_RESULT_CHARS,
  type EpisodeAdmission,
  type EpisodeOutcome,
  type EpisodeRecorder,
  type EpisodeToolCall,
  type SupervisorEpisodeRecord,
} from "./episode.js";

export {
  isAcceptable,
  replayRefusal,
  loadReplayFixtures,
  replayEpisodes,
  DEFAULT_FIXTURE_DIR,
  type AcceptableAction,
  type EpisodeLabel,
  type ReplayEpisodeResult,
  type ReplayOptions,
  type ReplayScore,
} from "./episode-replay.js";
