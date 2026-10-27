// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * The supervisor harness contract (design-supervisor-harnesses.md §4.1): the
 * host (`createSupervisorHost`) drives a `HarnessSession` that a
 * `SupervisorHarness` opens. Nothing here knows which agent is behind it.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { InvestigationStep } from "./investigation.js";
import type { ProviderFailure } from "./provider-failure.js";
import type { Supervisor, SupervisorRemedy } from "./types.js";

/** The supervisor harnesses GraphLoom knows, in the built-in selection order. */
export const SUPERVISOR_HARNESS_NAMES = ["pi", "claude-code", "codex"] as const;
export type SupervisorHarnessName = (typeof SUPERVISOR_HARNESS_NAMES)[number];

/** The harness a binding recorded before harnesses existed ran on. */
export const DEFAULT_SUPERVISOR_HARNESS: SupervisorHarnessName = "pi";

/** The harness a durable binding names; a binding without one reads as `pi` (§4.3). */
export function bindingHarness(binding: { harness?: string | undefined }): string {
  return binding.harness ?? DEFAULT_SUPERVISOR_HARNESS;
}

/**
 * Mirrors `@earendil-works/pi-agent-core`'s own `ThinkingLevel` (not re-exported
 * from the package's public surface), so callers need no deeper import path.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SupervisorModelRef {
  /** The Pi provider; for a CLI harness, the harness name (`claude-code/opus`). */
  provider: string;
  modelId: string;
  /** Reasoning level this model needs; omit for the "off" default. */
  thinkingLevel?: ThinkingLevel;
}

export interface ModelSwitchRecord {
  at: string;
  from: SupervisorModelRef;
  to: SupervisorModelRef;
  reason: string;
  status: "intent" | "committed" | "failed";
  error?: string;
}

/** Durable identity restored across controller restarts. */
export interface SupervisorBinding {
  sessionId: string;
  /** GraphLoom's copy of the latest episode transcript; never reopened. */
  sessionFile: string | undefined;
  provider: string;
  modelId: string;
  switchJournal: ModelSwitchRecord[];
  /** Models the operator configured; switches outside this set are refused. */
  configuredModels?: SupervisorModelRef[];
  /** The harness the run's supervisor is pinned to; absent reads as `pi`. */
  harness?: string;
}

/**
 * What a harness can do. The host uses these to choose its decision protocol
 * and to skip remedies a harness cannot apply; each missing one falls back to a
 * remedy that already exists (§8).
 */
export interface HarnessCapabilities {
  /**
   * GraphLoom's own tools (admission, inspection, record_finding) can be
   * offered to the model. Without it the decision protocol is the JSON reply
   * (`parseSupervisorReply`), and `inspect` replies stand in for the tools.
   */
  toolCalling: boolean;
  /** `setModel` keeps the chat; otherwise a switch opens a fresh session. */
  inSessionModelSwitch: boolean;
  /** `compact` can shrink the session's context (overflow recovery). */
  compaction: boolean;
  /** `omitLastExchange` can take a prompt out of the context for an identical resend. */
  exactResend: boolean;
  /** Provider calls are counted as they start, not reserved from the stream. */
  exactProviderCalls: boolean;
  /** The raw provider stream can be recorded. */
  rawStreamCapture: boolean;
}

export interface HarnessPromptOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxTurns?: number;
  /** Provider calls others spent against `maxTurns` during this prompt (read at each turn); shrinks the cap. */
  reservedTurns?: () => number;
  /** GraphLoom's tools for this prompt only; used only by a harness with `toolCalling`. */
  tools?: ToolDefinition[];
  /** A turn that would start once this is true is not sent; the prompt resolves with the reply so far. */
  done?: () => boolean;
}

/** Token usage of the last prompt, as the harness reports it; recorded, never charged. */
export interface HarnessUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/**
 * One episode's agent session (formerly the Pi-only `PiSupervisorSession`
 * port). `prompt` returns the final message text; the rest is what the host's
 * remedies, accounting, and grants need.
 */
export interface HarnessSession {
  readonly provider: string;
  readonly modelId: string;
  readonly sessionId: string;
  /** GraphLoom's copy of the session transcript, if it keeps one. */
  readonly sessionFile: string | undefined;
  /**
   * Send a prompt and wait until it settles. Returns the final message text
   * only (no thinking). Rejects with a `timeout` SupervisorProviderError when
   * the session goes silent past its limit or outlasts `timeoutMs`.
   */
  prompt(text: string, options?: HarnessPromptOptions): Promise<string>;
  /** Provider turns (model calls) started since the last drain, including tool turns. */
  drainTurnCount?(): number;
  /** Non-destructive count of provider turns started and not yet drained. */
  peekTurnCount?(): number;
  /** Why the last prompt's final message carries no usable reply; undefined when it did. */
  lastReplyFailure?(): ProviderFailure | undefined;
  /** Take the last single-turn exchange out of the context for an identical resend; returns whether it was. */
  omitLastExchange?(): boolean;
  /** Compact the session's history now (overflow recovery); its provider calls count as turns. */
  compact?(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void>;
  /** Switch the model of this session (the host checks it is configured and the session idle). */
  setModel(ref: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel }): Promise<void>;
  /** Make a controller-issued repair candidate root writable for the patch turn. */
  grantCandidateCoding?(candidateRoot: string): Promise<void>;
  revokeCandidateCoding?(): Promise<void>;
  /**
   * The investigation steps this session observed, oldest first, ids unique
   * within the episode (§5.2). A harness that records none (Pi, whose
   * inspection calls the controller already records) returns none.
   */
  investigation?(): InvestigationStep[];
  /** Usage of the last prompt, when the harness reports it. */
  lastUsage?(): HarnessUsage | undefined;
  close(): Promise<void>;
}

export type HarnessProbe = { ok: true } | { ok: false; reason: string };

/** What a session is for: deciding (and patching) for the run, or an independent review. */
export type HarnessSessionRole = "decide" | "review";

/** The supervisor host a harness builds or restores (see createSupervisorHost). */
export interface SupervisorHost extends Supervisor {
  readonly binding: SupervisorBinding;
  /** Provider/model calls since the last drain (turns that started). */
  drainProviderCalls(): number;
  /** Calls started by the running prompt and not yet settled; 1 when the session cannot count. */
  outstandingProviderCalls(): number;
  /** Deterministic remedies applied to failed provider turns since the last drain. */
  drainRemedies(): SupervisorRemedy[];
  /** Investigation steps the harness recorded since the last drain (none for Pi). */
  drainInvestigation(): InvestigationStep[];
  /** Token usage the harness reported for decide prompts since the last drain, summed (none for Pi). */
  drainUsage(): HarnessUsage | undefined;
  /** Every investigation step of the current episode, oldest first (non-destructive). */
  investigationSteps(): InvestigationStep[];
  switchModel(args: { provider: string; modelId: string; reason: string }): Promise<void>;
  grantCandidateCoding(candidateRoot: string): Promise<void>;
  revokeCandidateCoding(): Promise<void>;
  /** Last granted candidate coding root, if any. */
  candidateCodingRoot(): string | undefined;
  close(): Promise<void>;
}

/**
 * One agent backend for the supervisor: Pi in-process, or a CLI harness.
 */
export interface SupervisorHarness {
  readonly name: string;
  readonly capabilities: HarnessCapabilities;
  /** Whether the harness can run here, with no provider call (credentials, binaries, confinement). */
  probe(): Promise<HarnessProbe>;
  /**
   * A fresh session on `model`, with no earlier chat. Absent only for a
   * harness that cannot open sessions (tests): every episode then shares the
   * host's first session, and the remedies that need a fresh one are skipped.
   */
  openSession?(opts: { model: SupervisorModelRef; role: HarnessSessionRole }): Promise<HarnessSession>;
  /** The run's logical supervisor from its durable binding, on the bound model, in a fresh session. */
  restore(binding: SupervisorBinding): Promise<SupervisorHost>;
}

/**
 * How `start` begins a logical supervisor. Both are set when the run's pin
 * moved to this harness (`resume --supervisor`, design-supervisor-harnesses.md
 * §7.4): the supervisor keeps the run's logical session id and its switch
 * journal as history, on this harness's first configured model.
 */
export interface HarnessStartOptions {
  logicalSessionId?: string;
  switchJournal?: ModelSwitchRecord[];
}

/** Pi's capabilities: everything the host can use (design-supervisor-harnesses.md §8). */
export const PI_HARNESS_CAPABILITIES: HarnessCapabilities = Object.freeze({
  toolCalling: true,
  inSessionModelSwitch: true,
  compaction: true,
  exactResend: true,
  exactProviderCalls: true,
  rawStreamCapture: true,
});
