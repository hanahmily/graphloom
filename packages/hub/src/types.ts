// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { HubArchiveEntry, HubConfig, HubInput, HubLaunch, HubObservation, HubProcessIdentity, HubSubmission } from "@graphloom/sdk";

export interface HubExecutionObservation {
  execution: "live" | "drained" | "uncertain";
  /** All three conditions must be affirmative before a reservation is released. */
  ownerGone: boolean;
  externalStopped: boolean;
  observation?: HubObservation;
  reason?: string;
}
export interface HubDriver {
  /** Fail closed when managed execution cannot be contained and verified. */
  probe(context?: { lockPid: number }): Promise<void>;
  /** Start a gated bootstrap in the deterministic launch containment. No graph work yet. */
  prepare(launch: HubLaunch, submission: HubSubmission): Promise<HubProcessIdentity>;
  /** Called only after durable identity and grant intent have been synced. */
  grant(launch: HubLaunch, submission: HubSubmission): Promise<void>;
  inspect(launch: HubLaunch, submission: HubSubmission): Promise<HubExecutionObservation>;
  stop(launch: HubLaunch, submission: HubSubmission, reason: "pause" | "cancel" | "service-interruption", commandId: string): Promise<void>;
  kill(launch: HubLaunch, submission: HubSubmission): Promise<void>;
  /**
   * Called once a launch has drained, before its record settles: reconciles input
   * the launch preparation changed (a plugin update). A returned bundle replaces the
   * submission's recorded plugin; a throw blocks the submission with the reason.
   */
  settleInput?(launch: HubLaunch, submission: HubSubmission): Promise<{ bundlePath: string; bundleDigest: string } | undefined>;
  close?(): Promise<void>;
}
export interface OpenHubOptions {
  directory: string;
  config?: Partial<Omit<HubConfig, "retry">> & { retry?: Partial<HubConfig["retry"]> };
  driver: HubDriver;
  /** Tests may supply a controlled clock; production uses Date.now/performance.now. */
  now?: () => number;
  monotonic?: () => number;
  random?: () => number;
  autoPoll?: boolean;
  /**
   * What an archive index entry records beyond the queue record: the task's graph and
   * request, read by the caller from the captured task, and the run's state directory.
   * A failure leaves those fields out; it never blocks the archive.
   */
  describeArchive?: (submission: HubSubmission) => Promise<Pick<HubArchiveEntry, "graph" | "request" | "stateDir" | "rehearsalVerdict">>;
  /** Tests shrink the archive index's retention bounds. */
  archiveIndexBounds?: { entries: number; bytes: number };
}
export interface HubSubmitRequest { key?: string; requestDigest: string; input: HubInput; }
