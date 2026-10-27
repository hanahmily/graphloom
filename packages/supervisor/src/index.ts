// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Supervisor package — harness-neutral recovery host, the Pi harness, and the recovery protocol. */

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
  bindingHarness,
  DEFAULT_SUPERVISOR_HARNESS,
  PI_HARNESS_CAPABILITIES,
  SUPERVISOR_HARNESS_NAMES,
  type HarnessCapabilities,
  type HarnessProbe,
  type HarnessPromptOptions,
  type HarnessSession,
  type HarnessSessionRole,
  type HarnessUsage,
  type ModelSwitchRecord,
  type SupervisorBinding,
  type SupervisorHarness,
  type SupervisorHarnessName,
  type SupervisorHost,
  type SupervisorModelRef,
} from "./harness.js";

export {
  CLAUDE_CODE_HARNESS,
  CLAUDE_DEFAULT_MODEL,
  CLAUDE_DEFAULT_PROMPT_TIMEOUT_MS,
  CLAUDE_DEFAULT_PROMPT_TOTAL_TIMEOUT_MS,
  CLAUDE_HARNESS_CAPABILITIES,
  CLAUDE_SUPERVISOR_FLAGS,
  claudeSessionsOpened,
  commandPaths,
  createClaudeSupervisorHarness,
  lastClaudeSessionModel,
  type ClaudeConfinement,
  type ClaudeReviewSessionOptions,
  type ClaudeSessionOpened,
  type ClaudeSessionRecord,
  type ClaudeSupervisorHarness,
  type ClaudeSupervisorHarnessOptions,
} from "./claude-harness.js";

export { classifyClaudeFailure } from "./claude-failure.js";
export { claudeStepKind, claudeStepRecorder, CLAUDE_WRITE_TOOLS, type ClaudeStepRecorder } from "./claude-steps.js";

export {
  buildInspectResultPrompt,
  buildReaskPrompt,
  buildRecoveryPrompt,
  buildRejectionPrompt,
  buildRepairPrompt,
  createSupervisorHost,
  type CreateSupervisorHostOptions,
  type DecisionProtocol,
  type InspectResult,
} from "./host.js";

export {
  createPiSupervisor,
  type CreatePiSupervisorOptions,
  type PiSupervisor,
  type PiSupervisorSessionPort,
} from "./pi-supervisor.js";

export {
  configuredModelsFromBinding,
  createPiHarness,
  type PiHarness,
  type PiHarnessOptions,
  type PiSessionBase,
} from "./pi-harness.js";

export {
  MAX_INSPECT_REQUESTS,
  MAX_INSPECT_ROUNDS,
  parseSupervisorReply,
  type InspectRequest,
  type SupervisorReply,
} from "./reply.js";

export {
  investigationLines,
  isInvestigationStepId,
  type InvestigationStep,
  type InvestigationStepKind,
} from "./investigation.js";

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
  boundInvestigationSteps,
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
