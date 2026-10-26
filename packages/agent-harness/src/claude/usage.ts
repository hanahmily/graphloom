// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { count, type AgentUsage } from "../common.js";

/** Usage totals; Claude Code's `modelUsage` and `total_cost_usd` span the whole session, subagents included. */
export interface ClaudeTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}

/** A stream-json `result` event. */
export interface ClaudeResultEvent {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: unknown;
  total_cost_usd?: unknown;
}

/**
 * This run's usage. Streamed per-message counts are partial, and a result's
 * `usage` covers only its turn's main thread, so prefer the session totals in
 * `modelUsage`, which include subagents, less what Claude Code restored.
 */
export function claudeUsage(results: ClaudeResultEvent[], baseline: ClaudeTotals | undefined): AgentUsage | undefined {
  const last = results.at(-1);
  const totals = last !== undefined ? modelTotals(last.modelUsage, last.total_cost_usd) : undefined;
  if (totals !== undefined) {
    // Totals below the baseline mean Claude Code started this run from zero.
    return baseline !== undefined && covers(totals, baseline) ? less(totals, baseline) : totals;
  }
  const usage = last?.usage;
  if (usage === undefined || usage === null || typeof usage !== "object") return undefined;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
    ...(typeof last!.total_cost_usd === "number" ? { costUsd: last!.total_cost_usd } : {}),
  };
}

/** Sum Claude Code's per-model `modelUsage`; undefined when it reports none. */
function modelTotals(modelUsage: unknown, costUsd: unknown): ClaudeTotals | undefined {
  if (modelUsage === null || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return undefined;
  const models = Object.values(modelUsage as Record<string, Record<string, unknown> | null>).filter(
    (m): m is Record<string, unknown> => m !== null && typeof m === "object",
  );
  if (models.length === 0) return undefined;
  const sum = (key: string) => models.reduce((total, m) => total + count(m[key]), 0);
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadInputTokens"),
    cacheWriteTokens: sum("cacheCreationInputTokens"),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

/** The session totals in a transcript's last `cost-state` record, which Claude Code restores on resume. */
export function costState(transcript: string): ClaudeTotals | undefined {
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]!.includes('"cost-state"')) continue;
    try {
      const entry = JSON.parse(lines[i]!) as { type?: unknown; modelUsage?: unknown; totalCostUSD?: unknown };
      if (entry.type === "cost-state") return modelTotals(entry.modelUsage, entry.totalCostUSD);
    } catch {
      // Not a record.
    }
  }
  return undefined;
}

const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;

function covers(totals: ClaudeTotals, baseline: ClaudeTotals): boolean {
  return (
    TOKEN_KEYS.every((k) => totals[k] >= baseline[k]) &&
    (totals.costUsd === undefined || baseline.costUsd === undefined || totals.costUsd >= baseline.costUsd)
  );
}

function less(totals: ClaudeTotals, baseline: ClaudeTotals): AgentUsage {
  const usage: AgentUsage = {
    inputTokens: totals.inputTokens - baseline.inputTokens,
    outputTokens: totals.outputTokens - baseline.outputTokens,
    cacheReadTokens: totals.cacheReadTokens - baseline.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens - baseline.cacheWriteTokens,
  };
  if (totals.costUsd !== undefined) usage.costUsd = totals.costUsd - (baseline.costUsd ?? 0);
  return usage;
}
