import { defineExecutor, type ExecutorContext, type ExecutorDefinition, type ToolCallResult } from "@graphloom/sdk";
import type { CodingHarness, CodingTool } from "./harness.js";

export const CODING_AGENT_RUN_ID = "graphloom.coding-agent/run";

const MAX_ASSIGNMENT_CHARS = 64_000;

export interface CodingAgentInput {
  assignment: string;
  resultSchema?: string;
  /** Passed to the harness session unchanged. */
  harnessOptions?: Record<string, unknown>;
}

interface ToolCallSummary {
  toolCallId: string;
  tool: string;
  status: ToolCallResult["status"];
  childOperationId: string | null;
  replayed: boolean;
}

function isInput(v: unknown): v is CodingAgentInput {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.assignment === "string" &&
    o.assignment.length > 0 &&
    o.assignment.length <= MAX_ASSIGNMENT_CHARS &&
    (o.resultSchema === undefined || typeof o.resultSchema === "string") &&
    (o.harnessOptions === undefined ||
      (o.harnessOptions !== null && typeof o.harnessOptions === "object" && !Array.isArray(o.harnessOptions)))
  );
}

/**
 * The coding-agent executor: opens a harness session in the run worktree with
 * the job's admitted tools, runs the assignment, and reports the agent's
 * result. The result is the agent's claim; tool calls it made are recorded
 * by the controller as child operations with their own evidence.
 */
export function createCodingAgentExecutor(
  harness: CodingHarness | (() => Promise<CodingHarness>),
): ExecutorDefinition<CodingAgentInput> {
  return defineExecutor<CodingAgentInput, unknown>({
    id: CODING_AGENT_RUN_ID,
    version: "1",
    effect: "write",
    inputSchema: isInput,
    async execute(input, ctx: ExecutorContext) {
      const h = typeof harness === "function" ? await harness() : harness;
      const toolCalls: ToolCallSummary[] = [];
      let modelCalls = 0;
      const tools: CodingTool[] = (ctx.tools?.bindings ?? []).map((b) => ({
        name: b.name,
        effect: b.effect,
        ...(b.description !== undefined ? { description: b.description } : {}),
        async call(toolCallId, toolInput) {
          const result = await ctx.tools!.call({ toolCallId, tool: b.name, input: toolInput });
          toolCalls.push({
            toolCallId,
            tool: b.name,
            status: result.status,
            childOperationId: result.childOperationId ?? null,
            replayed: result.replayed === true,
          });
          return result;
        },
      }));
      const session = await h.createSession({
        cwd: ctx.worktreePath,
        readOnly: ctx.readOnly === true,
        tools,
        async reserveModelCall() {
          // Without host accounting the harness cannot spend a shared budget.
          const granted = ctx.usage ? await ctx.usage.reserveModelCall() : false;
          if (granted) modelCalls += 1;
          return granted;
        },
        ...(ctx.writeScope !== undefined ? { writeScope: ctx.writeScope } : {}),
        ...(ctx.credentials !== undefined ? { credentials: ctx.credentials } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(input.harnessOptions !== undefined ? { options: input.harnessOptions } : {}),
      });
      try {
        const result = await session.run({
          assignment: input.assignment,
          ...(input.resultSchema !== undefined ? { resultSchema: input.resultSchema } : {}),
        });
        return {
          status: result.status === "completed" ? "ok" : "failed",
          summary: result.summary,
          evidence: [
            {
              kind: "other",
              payload: {
                codingAgent: {
                  harness: h.name,
                  status: result.status,
                  output: result.output ?? null,
                  toolCalls,
                  modelCalls,
                },
              },
            },
          ],
        };
      } finally {
        await session.dispose?.();
      }
    },
  });
}
