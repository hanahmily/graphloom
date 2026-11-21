// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Hub scheduling contracts. These describe observations, never controller authority. */
export interface HubRetryPolicy {
  automatic: boolean;
  maxAutomaticResumes: number;
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export interface HubConfig {
  maxConcurrentRuns: number;
  retry: HubRetryPolicy;
  pollIntervalMs: number;
  shutdownGraceMs: number;
}
export type HubAutomaticCause = "provider-cooldown" | "executor-retry" | "transient-provider" | "transient-launch" | "controller-crash" | "service-interruption";
export type HubOperatorCause = "approval" | "authority" | "budget" | "pin-drift" | "reconciliation" | "unknown" | "operator-stop";
export type HubContinuation =
  | { kind: "complete" }
  | { kind: "automatic"; cause: HubAutomaticCause; notBefore?: string; fingerprint: string; stateRevision: number; interruptionCommandId?: string }
  | { kind: "operator"; cause: HubOperatorCause; evidenceRefs: string[] }
  | { kind: "terminal"; cause: "failed" | "initialization-failed" };
export interface HubObservation {
  protocolVersion: 1;
  observedAt: string;
  stateRevision: number;
  /** Changes only when the controller accepts progress, not on polling/retry timestamps. */
  progressRevision: number;
  status: string;
  continuation?: HubContinuation;
  blocker?: string;
}
/** Files are captured by read-only CLI intake. Relative task paths are resolved before submission. */
export interface HubInput {
  task: string;
  taskDigest?: string;
  config?: string;
  taskPath: string;
  repoPath: string;
  baseCommit: string;
  bundlePath: string;
  bundleDigest: string;
  runtimePath: string;
  runtimeNode?: string;
  runtimeRoot?: string;
  runtimeVersion?: string;
  runtimeDigest: string;
  runtimeConfig?: { runner?: { path: string; digest: string }; supervisor?: { path: string; digest: string } };
  configDigest?: string;
}
export type HubStoredInput = Omit<HubInput, "task" | "config"> & { taskFile: string; configFile?: string };
export interface HubResumeRemedy {
  reconciled?: boolean;
  approve?: string;
  decline?: string;
  inputs?: Record<string, string>;
  updateExecutors?: boolean;
  updatePlugin?: boolean;
  upgrade?: boolean;
  supervisor?: string;
  reason?: string;
}
export type HubDesiredAction = "execute" | "hold" | "cancel";
export type HubSchedulingState = "queued" | "starting" | "running" | "stopping" | "waiting" | "paused" | "blocked" | "succeeded" | "failed" | "canceled";
export interface HubProcessIdentity { bootId: string; pid: number; startTime: string; }
export interface HubCommand {
  id: string;
  kind: "resume" | "pause" | "cancel" | "service-interruption" | "policy";
  acceptedAt: string;
  remedy?: HubResumeRemedy;
}
export interface HubLaunch {
  id: string;
  generation: number;
  mode: "initial" | "resume" | "reconcile";
  phase: "reserved" | "prepared" | "granted";
  reservedAt: string;
  grantedAt?: string;
  identity?: HubProcessIdentity;
  command?: HubCommand;
  automatic: boolean;
  continuationFingerprint?: string;
  stopRequestedAt?: string;
  stopReason?: "pause" | "cancel" | "service-interruption";
  stopCommandId?: string;
}
export interface HubSubmission {
  id: string;
  runId: string;
  hubId: string;
  acceptedAt: string;
  updatedAt: string;
  requestDigest: string;
  contentDigest: string;
  key?: string;
  input: HubStoredInput;
  desiredAction: HubDesiredAction;
  state: HubSchedulingState;
  queueSequence: number;
  eligibleAt?: string;
  generation: number;
  automaticResumes: number;
  retry: HubRetryPolicy;
  retryStartedAt?: string;
  failureFingerprint?: string;
  failureRepeats: number;
  progressRevision: number;
  launch?: HubLaunch;
  pendingCommand?: HubCommand;
  observation?: HubObservation;
  blocker?: string;
  /** True until the next reservation; a planned service recovery does not spend failure allowance. */
  automaticPending?: boolean;
  reconciliationPending?: boolean;
  journalBytes: number;
}
export interface HubArchivedSubmission { archived: true; id: string; runId: string; requestDigest: string; contentDigest: string; key?: string; }
export interface HubStatus {
  hubId: string;
  maxConcurrentRuns: number;
  occupiedSlots: number;
  submissions: HubSubmission[];
  fault?: string;
}
