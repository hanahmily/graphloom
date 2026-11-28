// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { EvidencePartReader, GraphDecision, GraphDefinition, GraphRehearsal, LoopCandidatesInput, PrepareTaskInput, PrepareTaskReply, RunView, ValidationInput, ValidationResult } from "@graphloom/sdk";

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
    | "internal"
    /** A recorded evidence blob the call needed is missing or corrupt; the plugin is not at fault. */
    | "evidence_unavailable";
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
  /**
   * True when this host reads externalized evidence parts itself (a child worker installs lazy getters over the
   * run's evidence store; an in-process host given a reader hydrates eagerly). A host without it is handed
   * hydrated records by the controller.
   */
  readonly hydratesEvidence?: boolean;
  describe(ctx: CallContext): Promise<HostResult<GraphDefinition>>;
  advance(ctx: CallContext, view: RunView): Promise<HostResult<GraphDecision>>;
  evaluate?(
    ctx: CallContext,
    validatorId: string,
    input: ValidationInput,
  ): Promise<HostResult<ValidationResult>>;
  /** Loads the bundle's declared rehearsal entry inside this same sandbox, never the caller's own process. */
  rehearsal?(ctx: CallContext, entry: string): Promise<HostResult<GraphRehearsal | undefined>>;
  /**
   * The graph's `prepareTask` hook (docs/design-typescript-core.md section 16): the reply as the plugin
   * returned it, unvalidated, or undefined when the graph has no such hook.
   */
  prepareTask?(ctx: CallContext, input: PrepareTaskInput): Promise<HostResult<PrepareTaskReply | undefined>>;
  /**
   * The graph's `loopCandidates` hook (docs/design-loop.md section 14): the reply as the plugin returned it,
   * unvalidated, or undefined when the graph has no such hook.
   */
  loopCandidates?(ctx: CallContext, input: LoopCandidatesInput): Promise<HostResult<unknown>>;
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
   * Wraps the command that starts the worker: given `[node, workerModule, entryModule]`, it returns the command
   * to spawn instead (for example a sandbox launcher that ends with those three). The worker protocol stays on
   * the child's stdin and stdout. The host does not know what the wrapper is; unset, the child is the plain
   * worker, as for every caller that does not confine it.
   */
  launcher?: (worker: readonly [string, string, string]) => { command: string; args: readonly string[] };
  /**
   * The run's pinned task config, attached to every describe, advance
   * (`RunView.config`), evaluate (`ValidationInput.config`) and rehearsal
   * request. Opaque: the host never reads a field of it.
   */
  config?: unknown;
}

export interface InProcessPluginHostOptions {
  activeVersion: string;
  /** Reads externalized evidence parts; the host then hydrates each advance view's evidence eagerly. */
  evidenceReader?: EvidencePartReader;
  generation?: number;
  /** The run's pinned task config, passed to describe and attached to every advance view. */
  config?: unknown;
}
