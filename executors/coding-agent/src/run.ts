import { defineExecutor, jsonSchemaProblem, type ExecutorContext, type ExecutorDefinition, type ToolCallResult } from "@graphloom/sdk";
import type { CodingHarness, CodingSession, CodingTool } from "./harness.js";

export const CODING_AGENT_RUN_ID = "graphloom.coding-agent/run";

const MAX_ASSIGNMENT_CHARS = 64_000;

/** Opens the assignment of a continued session, whose earlier turns may be out of date. */
export const CONTINUATION_NOTICE = [
  "GraphLoom is continuing your earlier session for a new attempt at this stage.",
  "The worktree and external services may have changed since your last turn, and earlier tool results belong to an earlier attempt: observe again before relying on them.",
  "Only this assignment's scope, tools, and budget apply now. Tool calls from earlier turns are not repeated; make new calls when you need them.",
].join(" ");

export interface CodingAgentInput {
  assignment: string;
  resultSchema?: string;
  /** Passed to the harness session unchanged. */
  harnessOptions?: Record<string, unknown>;
  /** The dispatching job's own stageId/purpose (§4.1, §4.7); `cli-runner.ts` sets these, a plugin never declares them itself. */
  stageId?: string;
  purpose?: string;
}

interface ToolCallSummary {
  toolCallId: string;
  tool: string;
  status: ToolCallResult["status"];
  childOperationId: string | null;
  replayed: boolean;
}

/**
 * The input a job names as `input`, as data. A harness choice and the job's own
 * stageId/purpose are the router's, not part of this shape.
 */
export const CODING_AGENT_INPUT_SHAPE = {
  schema: {
    type: "object",
    required: ["assignment"],
    properties: {
      assignment: { type: "string", minLength: 1, maxLength: MAX_ASSIGNMENT_CHARS, description: "The instruction the agent works from; there is no prompt or instruction field." },
      resultSchema: { type: "string", description: "Name of a result contract the graph declared." },
      harnessOptions: { type: "object", description: "Passed to the harness session unchanged." },
    },
  },
  example: { assignment: "Create GREETING.txt containing the greeting." },
} as const;

function inputProblem(v: unknown): string | undefined {
  return jsonSchemaProblem(CODING_AGENT_INPUT_SHAPE.schema, v);
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
      (o.harnessOptions !== null && typeof o.harnessOptions === "object" && !Array.isArray(o.harnessOptions))) &&
    (o.stageId === undefined || typeof o.stageId === "string") &&
    (o.purpose === undefined || typeof o.purpose === "string")
  );
}

/**
 * The coding-agent executor: opens a harness session in the run worktree with
 * the job's admitted tools (or restores the one `ctx.session.resume` names),
 * runs the assignment, and reports the agent's result. The result is the
 * agent's claim; tool calls it made are recorded by the controller as child
 * operations with their own evidence.
 */
export function createCodingAgentExecutor(
  harness: CodingHarness | (() => Promise<CodingHarness>),
): ExecutorDefinition<CodingAgentInput> {
  return defineExecutor<CodingAgentInput, unknown>({
    id: CODING_AGENT_RUN_ID,
    version: "1",
    effect: "write",
    inputSchema: isInput,
    inputProblem,
    inputShape: CODING_AGENT_INPUT_SHAPE,
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
      const resume = ctx.session?.resume;
      if (resume !== undefined && h.resumable !== true) {
        return { status: "failed", summary: `harness ${h.name} cannot continue agent session ${resume}` };
      }
      let session: CodingSession;
      try {
        session = await h.createSession({
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
          ...(ctx.session !== undefined ? { sessionDir: ctx.session.dir } : {}),
          ...(resume !== undefined ? { resume } : {}),
        });
      } catch (err) {
        if (resume === undefined) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        return { status: "failed", summary: `agent session ${resume} could not be restored: ${reason}` };
      }
      // ctx.resultContract (resolved by the controller from the run's own
      // declared contracts) is the schema the model is actually constrained
      // to and validated against; input.resultSchema is a deprecated bare
      // name/inline-JSON fallback for callers outside a GraphLoom run. The
      // schema travels unnarrowed: a harness that validates a submission
      // itself (Pi's submit_result) needs the raw value to reconcile a
      // reference miss against a shown description (§4.3); one that can only
      // constrain the model up front (Claude, Codex) narrows it itself.
      const resultContract =
        ctx.resultContract !== undefined
          ? {
              name: ctx.resultContract.name,
              schema: ctx.resultContract.schema,
              ...(ctx.resultContract.references !== undefined ? { references: ctx.resultContract.references } : {}),
              ...(ctx.resultContract.knownReferences !== undefined ? { knownReferences: ctx.resultContract.knownReferences } : {}),
            }
          : undefined;
      try {
        const identity = {
          operationId: ctx.operationId,
          ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        };
        const result = await session.run({
          assignment: resume !== undefined ? `${CONTINUATION_NOTICE}\n\n${input.assignment}` : input.assignment,
          ...(resultContract !== undefined
            ? { resultContract }
            : input.resultSchema !== undefined
              ? { resultSchema: input.resultSchema }
              : {}),
          identity,
        });
        const sessionRef = ctx.session !== undefined ? result.sessionRef : undefined;
        return {
          status: result.status === "completed" ? "ok" : "failed",
          summary: result.summary,
          ...(sessionRef !== undefined ? { sessionRef } : {}),
          ...(result.failureKind !== undefined ? { failureKind: result.failureKind } : {}),
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
                  usage: result.usage ?? null,
                  sessionRef: sessionRef ?? null,
                  continued: resume !== undefined,
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
