import { defineExecutor, jsonSchemaProblem, type ExecutorContext, type ExecutorDefinition, type ToolCallResult } from "@graphloom/sdk";
import type { CodingHarness, CodingRunResult, CodingUsage, CodingSession, CodingTool } from "./harness.js";
import { abortableSleep, backoffMs, classifyTransient, resolveRetryPolicy, worktreeDigest, type TransientRetryPolicy } from "./transient.js";

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

export interface CodingAgentExecutorOptions {
  /** Bounds for retrying transient harness failures; unset fields fall back to the GRAPHLOOM_CODING_RETRY_* environment, then the defaults (3 tries, 10s to 60s). */
  retry?: Partial<TransientRetryPolicy>;
  /** Wait between tries; resolves false when the job's signal aborted first. Tests replace it; the default is a real timer. */
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<boolean>;
}

function addUsage(total: CodingUsage | undefined, next: CodingUsage | undefined): CodingUsage | undefined {
  if (next === undefined) return total;
  if (total === undefined) return { ...next };
  const costUsd = total.costUsd === undefined && next.costUsd === undefined ? undefined : (total.costUsd ?? 0) + (next.costUsd ?? 0);
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/** One transient failure the executor waited out, recorded in the job's evidence. */
interface RetryRecord {
  /** The try that failed (1-based). */
  attempt: number;
  reason: string;
  delayMs: number;
  /** The harness's own failure text for that try. */
  failure: string;
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
  executorOptions: CodingAgentExecutorOptions = {},
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
      let toolAttempts = 0;
      let modelCalls = 0;
      const tools: CodingTool[] = (ctx.tools?.bindings ?? []).map((b) => ({
        name: b.name,
        effect: b.effect,
        ...(b.description !== undefined ? { description: b.description } : {}),
        async call(toolCallId, toolInput) {
          // Counted before dispatch: a call that throws may still have had its effect.
          toolAttempts += 1;
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
        const request = {
          assignment: resume !== undefined ? `${CONTINUATION_NOTICE}\n\n${input.assignment}` : input.assignment,
          ...(resultContract !== undefined
            ? { resultContract }
            : input.resultSchema !== undefined
              ? { resultSchema: input.resultSchema }
              : {}),
          identity,
        };
        const policy = resolveRetryPolicy(executorOptions.retry);
        const sleep = executorOptions.sleep ?? abortableSleep;
        const retries: RetryRecord[] = [];
        // Tries actually run: a retry scheduled but cancelled during its backoff never ran.
        let executed = 0;
        let result: CodingRunResult;
        let usage: CodingUsage | undefined;
        for (let attempt = 1; ; attempt++) {
          // A retry re-runs the whole assignment, so it needs proof the failed
          // try had no effect: no graph tool call attempted, no native tool use
          // in the harness's own report (which must be available), and a
          // readable worktree fingerprint identical before and after.
          const before = policy.maxAttempts > 1 ? await worktreeDigest(ctx.worktreePath) : undefined;
          const attemptsBefore = toolAttempts;
          executed += 1;
          result = await session.run(request);
          usage = addUsage(usage, result.usage);
          const transient = result.status === "failed" ? classifyTransient(h.name, result.summary) : undefined;
          if (transient === undefined) break;
          const calledGraphTool = toolAttempts > attemptsBefore;
          const nativeUse = result.nativeTools === undefined ? undefined : result.nativeTools[0]?.name;
          const blocked =
            attempt >= policy.maxAttempts
              ? `retries exhausted after ${attempt} ${attempt === 1 ? "try" : "tries"}`
              : calledGraphTool
                ? "not retried: the failed try called a graph tool"
                : result.nativeTools === undefined
                  ? "not retried: the harness did not report which native tools the failed try ran"
                  : nativeUse !== undefined
                    ? `not retried: the failed try ran a native tool (${nativeUse})`
                    : before === undefined
                      ? "not retried: the worktree cannot be fingerprinted (not a readable git worktree), so changes by the failed try cannot be ruled out"
                      : (await worktreeDigest(ctx.worktreePath)) === undefined
                        ? "not retried: the worktree could not be fingerprinted after the failed try"
                        : undefined;
          const changed = blocked === undefined && before !== undefined && (await worktreeDigest(ctx.worktreePath)) !== before;
          if (blocked !== undefined || changed) {
            result = { ...result, summary: `Transient harness failure (${transient.reason}); ${blocked ?? "not retried: the failed try changed the worktree"}: ${result.summary}` };
            break;
          }
          const delayMs = backoffMs(policy, attempt, transient.retryAfterMs);
          retries.push({ attempt, reason: transient.reason, delayMs, failure: result.summary });
          if (!(await sleep(delayMs, ctx.signal))) {
            result = {
              status: "failed",
              summary: `agent session aborted while waiting to retry after a transient harness failure (${transient.reason})`,
              ...(result.sessionRef !== undefined ? { sessionRef: result.sessionRef } : {}),
            };
            break;
          }
        }
        result = usage !== undefined ? { ...result, usage } : result;
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
                  attempts: executed,
                  retries,
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
