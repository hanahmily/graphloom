// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * Claude Code's stream-json events as investigation steps
 * (design-supervisor-harnesses.md §5.2): each `tool_use` the agent made, its
 * own and its subagents' (forwarded with `parent_tool_use_id`), paired with
 * the `tool_result` that answered it. GraphLoom reads these from the CLI's
 * output, so they are observations, not the model's claims. Thinking blocks
 * are never read.
 */
import { boundValue, MAX_EPISODE_TOOL_RESULT_CHARS } from "./episode.js";
import type { InvestigationStep, InvestigationStepKind } from "./investigation.js";

const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "PowerShell"]);
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
/** The file-writing tools the supervisor's permission policy scopes (§5.1). */
export const CLAUDE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/** What a tool call does, for the step's kind. */
export function claudeStepKind(tool: string): InvestigationStepKind {
  if (COMMAND_TOOLS.has(tool)) return "command";
  if (READ_TOOLS.has(tool)) return "file_read";
  if (CLAUDE_WRITE_TOOLS.has(tool)) return "file_change";
  if (SUBAGENT_TOOLS.has(tool)) return "subagent";
  return "tool";
}

interface Pending {
  tool: string;
  input: unknown;
  at: string;
}

export interface ClaudeStepRecorder {
  /** Read one stream event; anything that is not a tool call or result is ignored. */
  observe(event: Readonly<Record<string, unknown>>): void;
  /** Record the calls still waiting for a result (the turn ended or was stopped first). */
  flush(): void;
  /** Every step recorded so far, oldest first, numbered `inv-<n>` within this recorder. */
  steps(): InvestigationStep[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A tool result's text: a string, or the text blocks of a content array. */
function resultText(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.filter((c) => isObject(c) && c.type === "text" && typeof c.text === "string").map((c) => (c as { text: string }).text);
    return texts.length === content.length ? texts.join("\n") : content;
  }
  return content ?? null;
}

const EXIT_CODE = /^Exit code (\d+)/;

/** A shell command's exit status as Claude Code reports it: 0, or the `Exit code <n>` an error result starts with. */
function commandExitCode(isError: boolean, output: unknown): number {
  if (!isError) return 0;
  const code = typeof output === "string" ? EXIT_CODE.exec(output.trim())?.[1] : undefined;
  return code !== undefined ? Number(code) : 1;
}

/** Records the investigation steps one Claude Code session streams, across its prompts. */
export function claudeStepRecorder(harness: string, now: () => Date = () => new Date()): ClaudeStepRecorder {
  const pending = new Map<string, Pending>();
  const recorded: InvestigationStep[] = [];
  const add = (tool: string, input: unknown, output: unknown, at: string, exitCode?: number) => {
    recorded.push({
      id: `inv-${recorded.length + 1}`,
      harness,
      kind: claudeStepKind(tool),
      tool,
      input: boundValue(input, MAX_EPISODE_TOOL_RESULT_CHARS).value,
      output: boundValue(output, MAX_EPISODE_TOOL_RESULT_CHARS).value,
      ...(exitCode !== undefined ? { exitCode } : {}),
      at,
    });
  };
  return {
    observe(event) {
      if (event.type !== "assistant" && event.type !== "user") return;
      const message = event.message;
      if (!isObject(message) || !Array.isArray(message.content)) return;
      for (const block of message.content) {
        if (!isObject(block)) continue;
        if (event.type === "assistant" && block.type === "tool_use" && typeof block.id === "string") {
          // One response may arrive as several events repeating a block.
          if (pending.has(block.id)) continue;
          pending.set(block.id, { tool: typeof block.name === "string" ? block.name : "unknown", input: block.input ?? null, at: now().toISOString() });
        } else if (event.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const call = pending.get(block.tool_use_id);
          if (call === undefined) continue;
          pending.delete(block.tool_use_id);
          const output = resultText(block.content);
          const exitCode = claudeStepKind(call.tool) === "command" ? commandExitCode(block.is_error === true, output) : undefined;
          add(call.tool, call.input, output, call.at, exitCode);
        }
      }
    },
    flush() {
      for (const call of pending.values()) add(call.tool, call.input, "(no result: the turn ended before the tool returned)", call.at);
      pending.clear();
    },
    steps() {
      return recorded.map((s) => ({ ...s }));
    },
  };
}
