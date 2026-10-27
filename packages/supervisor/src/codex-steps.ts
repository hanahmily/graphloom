// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Codex's `exec --json` events as investigation steps
 * (design-supervisor-harnesses.md §5.2): each item Codex ran on its own, a
 * shell command, a file change, an MCP tool call, a web search, paired from
 * `item.started` to its `item.completed`. Codex 0.162 has no file-read tool:
 * it reads files with shell commands, so a read is a `command` step with the
 * file's content as its output (§11). GraphLoom reads these from the CLI's
 * output, so they are observations, not the model's claims. Reasoning items
 * are never read; agent messages and plans are not steps.
 */
import { boundValue, MAX_EPISODE_TOOL_RESULT_CHARS } from "./episode.js";
import type { InvestigationStep, InvestigationStepKind } from "./investigation.js";

/** Items that are the agent talking, thinking, or planning, not doing. */
const NOT_STEPS = new Set(["agent_message", "reasoning", "todo_list", "error"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** What a Codex item does, for the step's kind. */
export function codexStepKind(itemType: string): InvestigationStepKind {
  if (itemType === "command_execution") return "command";
  if (itemType === "file_change") return "file_change";
  if (itemType === "collab_tool_call") return "subagent";
  return "tool";
}

/** The step a completed (or, at `flush`, unfinished) item makes: its tool name, input, output, and exit code. */
function stepOf(item: Record<string, unknown>): { tool: string; input: unknown; output: unknown; exitCode?: number } {
  const type = typeof item.type === "string" ? item.type : "unknown";
  switch (type) {
    case "command_execution": {
      const exit = typeof item.exit_code === "number" && Number.isInteger(item.exit_code) ? item.exit_code : undefined;
      const output = typeof item.aggregated_output === "string" ? item.aggregated_output : null;
      // A command Codex declined or that never reported a status has no exit code; the status says why.
      return {
        tool: type,
        input: { command: typeof item.command === "string" ? item.command : null },
        output: exit === undefined && typeof item.status === "string" && item.status !== "completed" ? { status: item.status, output } : output,
        ...(exit !== undefined ? { exitCode: exit } : {}),
      };
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObject).map((c) => ({ path: c.path ?? null, kind: c.kind ?? null })) : [];
      return {
        tool: type,
        input: { path: changes.map((c) => String(c.path)).join(", "), changes },
        output: { status: item.status ?? null },
      };
    }
    case "mcp_tool_call":
      return {
        tool: `mcp:${String(item.server ?? "?")}/${String(item.tool ?? "?")}`,
        input: item.arguments ?? null,
        output: item.error !== undefined && item.error !== null ? { status: item.status ?? null, error: item.error } : (item.result ?? { status: item.status ?? null }),
      };
    case "web_search":
      return { tool: type, input: { query: item.query ?? null }, output: item.action ?? { status: item.status ?? null } };
    default: {
      // Whatever else Codex runs is recorded as it reports it, without its id and type.
      const { id: _id, type: _type, ...rest } = item;
      return { tool: type, input: rest, output: { status: item.status ?? null } };
    }
  }
}

export interface CodexStepRecorder {
  /** Read one `exec --json` event; anything that is not a tool item is ignored. */
  observe(event: Readonly<Record<string, unknown>>): void;
  /** Record the items still waiting for completion (the turn ended or was stopped first). */
  flush(): void;
  /** Every step recorded so far, oldest first, numbered `inv-<n>` within this recorder. */
  steps(): InvestigationStep[];
}

/** Records the investigation steps one Codex session streams, across its prompts. */
export function codexStepRecorder(harness: string, now: () => Date = () => new Date()): CodexStepRecorder {
  const pending = new Map<string, { item: Record<string, unknown>; at: string }>();
  const recorded: InvestigationStep[] = [];
  const add = (item: Record<string, unknown>, at: string, unfinished: boolean) => {
    const step = stepOf(item);
    recorded.push({
      id: `inv-${recorded.length + 1}`,
      harness,
      kind: codexStepKind(typeof item.type === "string" ? item.type : "unknown"),
      tool: step.tool,
      input: boundValue(step.input, MAX_EPISODE_TOOL_RESULT_CHARS).value,
      output: boundValue(unfinished ? "(no result: the turn ended before the item completed)" : step.output, MAX_EPISODE_TOOL_RESULT_CHARS).value,
      ...(step.exitCode !== undefined && !unfinished ? { exitCode: step.exitCode } : {}),
      at,
    });
  };
  return {
    observe(event) {
      if (event.type !== "item.started" && event.type !== "item.completed") return;
      const item = event.item;
      if (!isObject(item) || typeof item.type !== "string" || NOT_STEPS.has(item.type)) return;
      const id = typeof item.id === "string" ? item.id : undefined;
      // Item ids restart in each process (`item_0`, `item_1`, ...): an id is paired only within one prompt (`flush` ends it).
      if (event.type === "item.started") {
        if (id !== undefined && !pending.has(id)) pending.set(id, { item, at: now().toISOString() });
        return;
      }
      const started = id !== undefined ? pending.get(id) : undefined;
      if (id !== undefined) pending.delete(id);
      add(item, started?.at ?? now().toISOString(), false);
    },
    flush() {
      for (const { item, at } of pending.values()) add(item, at, true);
      pending.clear();
    },
    steps() {
      return recorded.map((s) => ({ ...s }));
    },
  };
}
