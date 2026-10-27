// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/**
 * What one investigation step did, as GraphLoom observed it in a harness's own
 * event stream (design-supervisor-harnesses.md §5.2): a native tool call and
 * its result, a shell command, a file read or change, a subagent call.
 */
export type InvestigationStepKind = "tool" | "command" | "file_read" | "file_change" | "subagent";

/**
 * One investigation step. GraphLoom records it from the CLI's output, so it is
 * an observation, not the model's claim. The id `inv-<n>` is unique within its
 * episode and is what a proposal cites.
 */
export interface InvestigationStep {
  id: string;
  harness: string;
  kind: InvestigationStepKind;
  /** The tool or command name (`Bash`, `Read`, `command_execution`, ...). */
  tool: string;
  input: unknown;
  /** The result, bounded (MAX_EPISODE_TOOL_RESULT_CHARS) with its shape kept. */
  output: unknown;
  exitCode?: number;
  at: string;
}

const STEP_ID = /^inv-[1-9][0-9]*$/;

/** Whether `ref` has the form of an investigation step id (`inv-<n>`). */
export function isInvestigationStepId(ref: string): boolean {
  return STEP_ID.test(ref);
}

const MAX_LISTED_STEPS = 30;
const MAX_STEP_SUMMARY_CHARS = 120;

/**
 * The steps a follow-up prompt lists so the agent can cite them, one line
 * each: `inv-3: Bash "go test ./pkg/x" exit 1`. Nothing when there are none,
 * so a harness that records no steps (Pi) gets no extra prompt text.
 */
export function investigationLines(steps: readonly InvestigationStep[]): string[] {
  if (steps.length === 0) return [];
  const shown = steps.slice(-MAX_LISTED_STEPS);
  return [
    "Investigation steps GraphLoom recorded this episode (cite their ids as evidence for claims about code or the environment):",
    ...(steps.length > shown.length ? [`- (${steps.length - shown.length} earlier steps not listed)`] : []),
    ...shown.map((s) => `- ${s.id}: ${s.tool} ${JSON.stringify(stepSummary(s.input))}${s.exitCode !== undefined ? ` exit ${s.exitCode}` : ""}`),
  ];
}

function stepSummary(input: unknown): string {
  const obj = input as Record<string, unknown> | null;
  const text =
    typeof input === "string"
      ? input
      : obj !== null && typeof obj === "object"
        ? typeof obj.command === "string"
          ? obj.command
          : typeof obj.file_path === "string"
            ? obj.file_path
            : typeof obj.path === "string"
              ? obj.path
              : typeof obj.pattern === "string"
                ? obj.pattern
                : (JSON.stringify(obj) ?? "")
        : String(input);
  return text.length <= MAX_STEP_SUMMARY_CHARS ? text : `${text.slice(0, MAX_STEP_SUMMARY_CHARS)}…`;
}
