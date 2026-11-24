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
export type HubAutomaticCause = "provider-cooldown" | "executor-retry" | "transient-provider" | "transient-launch" | "controller-crash" | "service-interruption" | "initialization-failed";
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
  /**
   * The bundle the run is pinned to (resolved). After a hub `--update-plugin` the
   * controller accepted, the hub records the new bundle here.
   */
  bundlePath: string;
  bundleDigest: string;
  /**
   * The operator's task's plugin link, unresolved (`<task dir>/plugins/<graph>`).
   * A hub `--update-plugin` re-resolves it; absent on older submissions, which derive it from `taskPath`.
   */
  pluginLink?: string;
  runtimePath: string;
  runtimeNode?: string;
  runtimeRoot?: string;
  runtimeVersion?: string;
  runtimeDigest: string;
  runtimeConfig?: { runner?: { path: string; digest: string }; supervisor?: { path: string; digest: string } };
  configDigest?: string;
  /**
   * Present on a rehearsal submission only (docs/design-run-hub.md §12): its run
   * runs on `graphloom rehearse`'s stand-ins, never on a real model. Part of the
   * captured input, so of the request digest and the idempotency key's scope.
   */
  rehearsal?: HubRehearsal;
}
/** A rehearsal submission's settings: what `graphloom rehearse` takes for one run. */
export interface HubRehearsal {
  /** The bundle's scenario; `happy` when absent. */
  scenario?: string;
  /** Quick mode (`stub`, the default) answers command jobs from the scenario; `run` runs them. */
  commands?: "stub" | "run";
  /** Replays the scenario's recorded GitHub reads instead of asking GitHub. */
  offline?: boolean;
}
/** The idempotency-key scope of a rehearsal submission: a rehearsal and a real submission never share a key. */
export const HUB_REHEARSAL_KEY_PREFIX = "rehearsal:";
/**
 * A rehearsal submission's recorded verdict (docs/design-run-hub.md §12.3), written
 * by its managed launch beside the run: the rehearsal's own evaluation, with each
 * boundary check's status.
 */
export interface HubRehearsalVerdict {
  verdict: "ready" | "not-ready" | "inconclusive";
  /** Each boundary check (B1 to B10) and its status. */
  boundaries: Record<string, "passed" | "failed" | "unverified" | "unexercised">;
  blocker?: { boundary: string; reason: string };
  /** Whether the run met the scenario's expectation. */
  convergence: boolean;
  /** The run's status and stop reason when the verdict was taken. */
  runStatus: string;
  stopReason?: string;
  /** The launch that took it, and when. */
  launchId: string;
  evaluatedAt: string;
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
  /**
   * Set by the hub service, never by a client: with `updatePlugin`, the bundle the
   * operator's plugin link resolved to when the hub accepted the resume.
   */
  plugin?: { bundlePath: string; bundleDigest: string };
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
/**
 * Why a managed launch refused its request before changing the run
 * (docs/design-run-hub.md §6.1): a structured cause, never read from text.
 * Retrying the same request is refused the same way, so the hub blocks at once.
 */
export type HubRefusalCause = "invalid-task" | "invalid-scenario" | "invalid-remedy" | "upgrade-refused";
/**
 * A request refused before it changed the run, with its structured cause: a
 * managed launch reports it as a refusal the hub does not retry.
 */
export class RequestRefusedError extends Error {
  constructor(message: string, readonly refusal: HubRefusalCause) {
    super(message);
    this.name = "RequestRefusedError";
  }
}
/**
 * What a managed launch reports about its own end, written to
 * `<hub>/submissions/<s>/launches/<launchId>.json` before it exits
 * (docs/design-run-hub.md §6.1). A report, never authority: drainage is still
 * verified, and a launch that was killed writes none.
 */
export interface HubLaunchReport {
  protocolVersion: 1;
  launchId: string;
  generation: number;
  /** `completed`: the command returned a run report; `refused`: it refused its request with a structured cause; `error`: it failed otherwise. */
  outcome: "completed" | "refused" | "error";
  refusal?: { cause: HubRefusalCause; reason: string };
  /** The failure's message, for display only (an `error` outcome). */
  error?: string;
  /** The operator command the launch carried, and whether the run applied it. */
  command?: { id: string; applied: boolean };
  endedAt: string;
}
/**
 * What became of a submission's latest operator resume (docs/design-run-hub.md §3.2).
 * `pending`: accepted, not yet launched (or held by a pause); `launched`: the
 * current launch carries it; `applied`: the run took it; `refused`: the run
 * refused it (`reason`); `withdrawn`: it ended unapplied, and resending the
 * same command ID applies it.
 */
export interface HubResumeOutcome {
  commandId: string;
  status: "pending" | "launched" | "applied" | "refused" | "withdrawn";
  reason?: string;
  at: string;
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
  /** A failed launch stays authoritative through polling until its reservation drains. */
  failure?: { occurredAt: string; message: string };
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
  /** The latest operator resume and what became of it. */
  lastResume?: HubResumeOutcome;
  /** The last failure an automatic retry answered: its cause and, when known, what the launch reported. */
  lastFailure?: string;
  /** True until the next reservation; a planned service recovery does not spend failure allowance. */
  automaticPending?: boolean;
  reconciliationPending?: boolean;
  journalBytes: number;
}
export interface HubArchivedSubmission { archived: true; id: string; runId: string; requestDigest: string; contentDigest: string; key?: string; }
/** What a task asked for, read from its captured task file: never authority, only search text. */
export interface HubRequestSummary {
  /** The task's graph id, when the captured task could be read. */
  graph?: string;
  /** SHA-256 of the task's request text. */
  digest: string;
  /** The request's first nonblank line, at most 200 characters. */
  firstLine: string;
}
/**
 * One archived submission in the bounded archive index (docs/design-run-hub.md §4.1).
 * History only: the idempotency tombstone in the snapshot, not this entry, reserves the key.
 */
export interface HubArchiveEntry {
  archived: true;
  id: string;
  runId: string;
  key?: string;
  graph?: string;
  repoPath: string;
  taskPath: string;
  /** The submission's request digest (its captured inputs), as in its tombstone. */
  requestDigest: string;
  request?: HubRequestSummary;
  acceptedAt: string;
  /** The terminal record's last update. */
  settledAt: string;
  archivedAt: string;
  state: "succeeded" | "failed" | "canceled";
  /** The run's state directory, when the hub runtime knows it. */
  stateDir?: string;
  blocker?: string;
  /** A rehearsal submission's settings and its verdict, when one was recorded. */
  rehearsal?: HubRehearsal;
  rehearsalVerdict?: HubRehearsalVerdict["verdict"];
}
export interface HubStatus {
  hubId: string;
  maxConcurrentRuns: number;
  occupiedSlots: number;
  submissions: HubSubmission[];
  fault?: string;
  /** Search replies only: what each listed live submission asked for, by submission id. */
  summaries?: Record<string, HubRequestSummary>;
  /** Search replies with archived entries requested: matching archive index entries. */
  archived?: HubArchiveEntry[];
  /** Search replies only: matches before `limit` applied. */
  matched?: number;
  /** Each listed rehearsal submission's recorded verdict, by submission id. */
  rehearsals?: Record<string, HubRehearsalVerdict>;
}
/** `GET /v1/health`: the hub's status with aggregate counts and service health. */
export interface HubHealth extends HubStatus {
  /** The running hub's GraphLoom version, when its installation records one. */
  version?: string;
  socket?: string;
  counts?: Partial<Record<HubSchedulingState, number>>;
  /** The rehearsal submissions among `counts`, by state (docs/design-run-hub.md §12). */
  rehearsalCounts?: Partial<Record<HubSchedulingState, number>>;
  archivedEntries?: number;
  archiveIndexError?: string;
  monitoringError?: string;
  retentionError?: string;
  closing?: boolean;
  /** The hub process's environment, which its runs inherit (docs/design-run-hub.md §9). */
  environment?: HubEnvironmentSummary;
}
/**
 * What the hub's own environment provides to its runs: the head of `PATH`,
 * where each tool resolves, and whether each named variable is set. Names
 * only: no variable's value but `PATH` is ever reported.
 */
export interface HubEnvironmentSummary {
  /** The first `PATH` entries, in order. */
  pathHead: string[];
  /** How many entries `PATH` has. */
  pathEntries: number;
  tools: HubEnvironmentTool[];
  /** Variables runs read, by name: the runner config's token variables and the agents' login locations. */
  variables: HubEnvironmentVariable[];
  /** One line per tool a configured harness needs but the hub cannot find. */
  warnings: string[];
  /** Why part of the summary could not be read (an unreadable runner config, say). */
  error?: string;
}
export interface HubEnvironmentTool {
  name: string;
  /** The command looked up: a name on `PATH`, or a configured path. */
  command: string;
  /** The absolute path it resolves to; null when not found. */
  path: string | null;
  /** What needs it, when something configured does (`runner config enables claude-code`). */
  neededBy?: string[];
}
export interface HubEnvironmentVariable {
  name: string;
  set: boolean;
  /** Where the name comes from (`github.tokenEnv`, `Claude Code login`). */
  source: string;
}
