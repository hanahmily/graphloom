import type { ExecutorCredentials, ExecutorEffect, ReferenceSet, ToolCallResult } from "@graphloom/sdk";

/**
 * Names the result contract (or bare `resultSchema`) a spawned-process
 * harness's job carries, set on the child's own environment only. Claude
 * Code and Codex's wire protocols hand the child the schema itself (an
 * inline `--json-schema` argument; an `--output-schema` file) but never its
 * name, which a rehearsal stand-in replacing that child needs to look up the
 * right scripted reply (docs/design-graph-rehearsal.md §4.1). Harmless to a
 * real `claude`/`codex` binary, which never reads it.
 */
export const JOB_CONTRACT_ENV = "GRAPHLOOM_JOB_CONTRACT";

/**
 * JSON-encodes the dispatching job's own identity (`operationId`, `stageId`,
 * `purpose`) on the child's own environment only, for the same reason
 * `JOB_CONTRACT_ENV` exists: a rehearsal stand-in replacing Claude Code or
 * Codex needs it to log which job it actually answered, so B3 (§4.1, §4.7)
 * can tell a reply that landed under a different job than the one that asked
 * from one that did not. Harmless to a real `claude`/`codex` binary, which
 * never reads it.
 */
export const JOB_IDENTITY_ENV = "GRAPHLOOM_JOB_IDENTITY";

/**
 * JSON-encodes the dispatching job's own `resultContract.knownReferences` on
 * the child's own environment only, for the same reason `JOB_CONTRACT_ENV`
 * exists: the wire schema the child actually receives has already had
 * `applyReferenceEnums` bake these ids into `enum` constraints, not a
 * separately readable structure, so a rehearsal stand-in recording this
 * dispatch for `graphloom probe` (§3.4) needs its own copy to record.
 * Harmless to a real `claude`/`codex` binary, which never reads it.
 */
export const JOB_REFERENCES_ENV = "GRAPHLOOM_JOB_REFERENCES";

/** The dispatching job's own identity, threaded through for B3's provenance check (§4.1); absent outside a rehearsal, and ignored by a real harness either way. */
export interface JobIdentity {
  operationId?: string;
  stageId?: string;
  purpose?: string;
}

/**
 * A tool the harness may expose to its model. Calling it submits a child
 * operation to the controller and waits for the recorded result.
 */
export interface CodingTool {
  name: string;
  effect: ExecutorEffect;
  description?: string;
  /** `toolCallId` is the harness's own call identity; repeating it replays the recorded result. */
  call(toolCallId: string, input: unknown): Promise<ToolCallResult>;
}

export interface CodingSessionOptions {
  /** Run worktree the agent works in. */
  cwd: string;
  /** Paths the graph admitted for writing (relative to `cwd`). Claude checks file-tool permissions; shell execution remains unrestricted. */
  writeScope?: string[];
  readOnly: boolean;
  tools: CodingTool[];
  /** Reserve one provider request against the run budget before making it; false means stop. */
  reserveModelCall(): Promise<boolean>;
  credentials?: ExecutorCredentials;
  signal?: AbortSignal;
  /** Harness-specific options from the job input (model, limits, scripted steps). */
  options?: Record<string, unknown>;
  /** Controller-owned directory for the session transcript, when the job may be continued later. */
  sessionDir?: string;
  /**
   * A `sessionRef` an earlier run returned. The harness restores that session
   * or throws; it must never start a fresh one in its place.
   */
  resume?: string;
}

/**
 * A structured-result contract already resolved by the controller (schema
 * narrowed with any reference enums, §4.3): the harness constrains the model
 * to it (B2), validates the submission against it, and gives the model a
 * chance to correct a violation in-turn (§4.2) before the job fails.
 */
export interface CodingResultContract {
  name: string;
  schema: Record<string, unknown>;
  references?: string[];
  knownReferences?: Record<string, ReferenceSet>;
}

export interface CodingRunRequest {
  assignment: string;
  /**
   * @deprecated A bare schema name or inline JSON Schema text, forwarded
   * as-is with no constraint or validation beyond "some object was
   * submitted". Prefer `resultContract`, which the executor builds from the
   * run's own declared contracts; kept for callers outside a GraphLoom run
   * (direct executor tests, pre-migration jobs).
   */
  resultSchema?: string;
  resultContract?: CodingResultContract;
  /** The dispatching job's own identity (§4.1, §4.7); set by the executor from its own `ctx`/`input`, read only by a rehearsal stand-in. */
  identity?: JobIdentity;
}

/** Provider token usage one run reported, as totals over all its model requests. */
export interface CodingUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

/** A tool the harness ran on its own (not through graph tools), as seen in its output for one run. Any such tool, read-only or not, blocks a transient retry. */
export interface NativeToolUse {
  name: string;
}

export interface CodingRunResult {
  status: "completed" | "failed";
  summary: string;
  /** Structured output matching `resultSchema`/`resultContract`, when requested. */
  output?: unknown;
  /** Identifies the saved session in `sessionDir`, so a later job can continue it. */
  sessionRef?: string;
  /** Token usage, when the harness can report it. */
  usage?: CodingUsage;
  /**
   * Native tools (shell, edit, ...) the harness ran during this run, from its
   * own output. Absent when the harness cannot tell or its output could not be
   * parsed; a transient failure is retried only when this is present and
   * empty (any native tool, read-only or not, blocks a retry).
   */
  nativeTools?: NativeToolUse[];
  /** Set when `status: "failed"` because the model could not produce a contract-valid result within the §4.2 retry bound. */
  failureKind?: "contract_violation";
}

export interface CodingSession {
  run(request: CodingRunRequest): Promise<CodingRunResult>;
  dispose?(): Promise<void>;
}

/** Adapter for one agent harness (a Pi coding agent, another CLI agent, or a scripted test harness). */
export interface CodingHarness {
  readonly name: string;
  /** True when the harness saves sessions and honors `resume`. */
  readonly resumable?: boolean;
  createSession(options: CodingSessionOptions): Promise<CodingSession>;
}
