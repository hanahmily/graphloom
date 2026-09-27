import type { ExecutorCredentials, ExecutorEffect, ToolCallResult } from "@graphloom/sdk";

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
  /** Paths the graph admitted for writing (relative to `cwd`). Advisory: the harness runs unrestricted. */
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

export interface CodingRunRequest {
  assignment: string;
  resultSchema?: string;
}

/** Provider token usage one run reported, as totals over all its model requests. */
export interface CodingUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

export interface CodingRunResult {
  status: "completed" | "failed";
  summary: string;
  /** Structured output matching `resultSchema`, when requested. */
  output?: unknown;
  /** Identifies the saved session in `sessionDir`, so a later job can continue it. */
  sessionRef?: string;
  /** Token usage, when the harness can report it. */
  usage?: CodingUsage;
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
