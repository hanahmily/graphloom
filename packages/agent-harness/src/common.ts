// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Provider token usage one run reported, as totals over all its model requests. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

/** A tool the agent ran on its own (shell, edit, ...), as seen in its output for one run. */
export interface NativeToolUse {
  name: string;
}

/** Summary text a driver reports when the caller's budget refuses a model request. */
export const BUDGET_EXHAUSTED = "model request budget exhausted";

/** Summary text a driver reports when its run is stopped through the caller's signal. */
export const SESSION_ABORTED = "agent session aborted";

export function bounded(text: string, max = 4_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
