// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { GraphDecision, GraphDefinition, GraphRehearsal, RunView, ValidationInput, ValidationResult } from "@graphloom/sdk";

/** Non-durable observation returned instead of applying a plugin result. */
export interface ChildObservation {
  kind: "child_observation";
  code:
    | "crash"
    | "timeout"
    | "malformed"
    | "stale"
    | "oversized"
    | "unknown"
    | "internal";
  message: string;
  exitCode?: number | null | undefined;
}

export type HostResult<T> =
  | { ok: true; value: T }
  | { ok: false; observation: ChildObservation };

export interface CallContext {
  runId: string;
  operationId: string;
  expectedStateRevision: number;
  recoveryEpisodeId?: string;
}

/**
 * Host-facing plugin session. Either in-process (scripted) or an isolated child.
 * Closing/disposing always starts a fresh process on the next createChildPluginHost call.
 */
export interface PluginHost {
  readonly activeVersion: string;
  readonly generation: number;
  /** OS pid of the plugin child when hosted out-of-process. */
  readonly childPid?: number | undefined;
  describe(ctx: CallContext): Promise<HostResult<GraphDefinition>>;
  advance(ctx: CallContext, view: RunView): Promise<HostResult<GraphDecision>>;
  evaluate?(
    ctx: CallContext,
    validatorId: string,
    input: ValidationInput,
  ): Promise<HostResult<ValidationResult>>;
  /** Loads the bundle's declared rehearsal entry inside this same sandbox, never the caller's own process. */
  rehearsal?(ctx: CallContext, entry: string): Promise<HostResult<GraphRehearsal | undefined>>;
  close(): Promise<void>;
}

export interface ChildPluginHostOptions {
  /** Absolute or resolvable path to the plugin module exporting createGraph(). */
  entryModule: string;
  activeVersion: string;
  generation: number;
  /** Default 10_000 per design §10. */
  callbackTimeoutMs?: number;
  /** Override worker entry (tests). Defaults to package worker. */
  workerModule?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * The run's pinned task config, attached to every describe, advance
   * (`RunView.config`), evaluate (`ValidationInput.config`) and rehearsal
   * request. Opaque: the host never reads a field of it.
   */
  config?: unknown;
}

export interface InProcessPluginHostOptions {
  activeVersion: string;
  generation?: number;
  /** The run's pinned task config, passed to describe and attached to every advance view. */
  config?: unknown;
}
