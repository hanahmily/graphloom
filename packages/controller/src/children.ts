import { randomUUID } from "node:crypto";
import {
  assertBoundedJson,
  type EvidenceRecord,
  type JobSpec,
  type ToolBinding,
  type ToolCallRequest,
  type ToolCallResult,
} from "@graphloom/sdk";
import type { ChildOperationPort, JobResult, Runner } from "@graphloom/runner";
import { newEvidenceRef, type EvidenceProducer } from "./admit.js";
import { resolveExecutorPin } from "./executor-catalog.js";
import { boundedRetryAfter, recordExecutorFailure } from "./executor-failure.js";
import { withDirectoryLock } from "./lock.js";
import { loadRunState, saveRunState, type ChildOperationRecord, type DurableRunState } from "./state.js";

const MAX_TOOL_CALL_ID = 128;

export interface ParentJob {
  job: JobSpec;
  operationId: string;
  generation: number;
}

export interface ChildPortDeps {
  stateDir: string;
  runner: Runner;
  shouldStop: () => Promise<boolean>;
  /** Aborted when the run stops; forwarded to child jobs. */
  signal: AbortSignal;
}

function failed(summary: string): ToolCallResult {
  return { status: "failed", summary };
}

function withRunLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  return withDirectoryLock(stateDir, "run.exec.lock", fn);
}

/** JSON with sorted object keys, so equal inputs compare equal regardless of key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Controller side of the child-operation protocol for one outstanding agent
 * job. Each tool call is admitted under the run lock, journaled before it
 * runs, executed as a leaf job with the parent's scope, and settled into the
 * run's evidence and budgets. The parent waits, so calls are serviced one at
 * a time and never reenter graph routing.
 */
export interface ControllerChildPort extends ChildOperationPort {
  /**
   * Called once the parent job has returned, normally or not. Refuses further
   * calls, cancels a child still in flight, and resolves once it has settled.
   */
  close(): Promise<void>;
}

export function createChildPort(parent: ParentJob, deps: ChildPortDeps): ControllerChildPort {
  const bindings = new Map((parent.job.tools ?? []).map((t) => [t.name, t]));
  const canWrite =
    parent.job.readOnly !== true && parent.job.writeScope !== undefined && parent.job.writeScope.length > 0;
  const cancel = new AbortController();
  const onStop = () => cancel.abort();
  if (deps.signal.aborted) cancel.abort();
  else deps.signal.addEventListener("abort", onStop, { once: true });
  let closed = false;
  let busy = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  async function fence(state: DurableRunState): Promise<string | undefined> {
    if (closed) return "parent job ended";
    if (state.status !== "running") return "run is not running";
    if (state.generation !== parent.generation) return `generation ${parent.generation} != ${state.generation}`;
    const pending = state.pendingDispatch;
    if (pending?.operationId !== parent.operationId || pending.status !== "pending") {
      return "parent job is no longer outstanding";
    }
    if (await deps.shouldStop()) return "stop requested";
    return undefined;
  }

  async function admit(
    binding: ToolBinding,
    req: ToolCallRequest,
  ): Promise<{ done: ToolCallResult } | { record: ChildOperationRecord; state: DurableRunState }> {
    return withRunLock(deps.stateDir, async () => {
      const state = await loadRunState(deps.stateDir);
      const fenced = await fence(state);
      if (fenced) return { done: failed(`tool call fenced: ${fenced}`) };

      const attempt = state.current.attempt;
      const prior = [...(state.childOperations ?? [])]
        .reverse()
        .find((c) => c.stageId === parent.job.stageId && c.attempt === attempt && c.toolCallId === req.toolCallId);
      if (prior && prior.tool !== req.tool) {
        return { done: failed(`tool call ${req.toolCallId} was recorded for tool ${prior.tool}`) };
      }
      if (prior && canonicalJson(prior.input) !== canonicalJson(req.input)) {
        return { done: failed(`tool call ${req.toolCallId} was recorded with different input`) };
      }
      if (prior?.result && prior.status !== "pending") {
        return { done: { ...prior.result, replayed: true } };
      }
      if (prior?.status === "ambiguous") {
        return { done: failed(`tool call ${req.toolCallId} has an unreconciled outcome`) };
      }
      // The same retry time gates an executor whether the graph or an agent's tool calls it.
      const executorId = binding.executor.id;
      const retryAt = state.executorRetryAt?.[executorId];
      const waitMs = retryAt !== undefined ? Date.parse(retryAt) - Date.now() : 0;
      if (waitMs > 0) {
        return {
          done: { ...failed(`executor ${executorId} asked not to be called before ${retryAt}`), retryAfterMs: Math.ceil(waitMs) },
        };
      }
      const { [executorId]: _elapsed, ...otherRetries } = state.executorRetryAt ?? {};
      void _elapsed;
      // One job is reserved for the parent's own settlement.
      if (state.budgets.jobs < 2) return { done: failed("jobs budget exhausted") };

      const record: ChildOperationRecord = {
        childOperationId: `child-${state.stateRevision}-${randomUUID().slice(0, 8)}`,
        parentOperationId: parent.operationId,
        toolCallId: req.toolCallId,
        tool: req.tool,
        stageId: parent.job.stageId,
        attempt,
        generation: state.generation,
        executor: binding.executor,
        effect: binding.effect,
        input: req.input,
        status: "pending",
        admittedAt: new Date().toISOString(),
      };
      const next: DurableRunState = {
        ...state,
        ...(retryAt !== undefined ? { executorRetryAt: otherRetries } : {}),
        childOperations: [...(state.childOperations ?? []), record],
        outstanding: [
          ...state.outstanding,
          { operationId: record.childOperationId, kind: "child", stageId: record.stageId },
        ],
        stateRevision: state.stateRevision + 1,
      };
      await saveRunState(next);
      return { record, state: next };
    });
  }

  async function settle(
    record: ChildOperationRecord,
    job: JobSpec,
    result: JobResult,
    cutShort: boolean,
  ): Promise<ToolCallResult> {
    return withRunLock(deps.stateDir, async () => {
      const state = await loadRunState(deps.stateDir);
      const identity =
        result.runId !== state.runId || result.operationId !== record.childOperationId || result.generation !== record.generation
          ? "stale child result identity"
          : undefined;
      const fenced = identity ?? (await fence(state));
      const settledAt = new Date().toISOString();
      const others = (state.childOperations ?? []).filter((c) => c.childOperationId !== record.childOperationId);
      const outstanding = state.outstanding.filter((o) => o.operationId !== record.childOperationId);

      const retryAfterMs = result.status !== "ok" ? boundedRetryAfter(result.retryAfterMs) : undefined;
      const delivered: ToolCallResult = {
        status: result.status,
        summary: result.summary,
        childOperationId: record.childOperationId,
        ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };

      if (fenced) {
        // A child cut short has no trustworthy result; a write may still have
        // reached the service. One that finished keeps its result for replay.
        const settledRecord: ChildOperationRecord = cutShort
          ? { ...record, status: record.effect === "read" ? "fenced" : "ambiguous", settledAt }
          : { ...record, status: "fenced", result: delivered, settledAt };
        await saveRunState({
          ...state,
          childOperations: [...others, settledRecord],
          outstanding,
          stateRevision: state.stateRevision + 1,
        });
        return failed(`tool call fenced: ${fenced}`);
      }

      const working: DurableRunState = { ...state };
      const producer: EvidenceProducer = {
        operationId: record.childOperationId,
        stageId: record.stageId,
        purpose: job.purpose,
        readOnly: job.readOnly === true,
        kind: job.kind,
        executorId: record.executor.id,
        parentOperationId: record.parentOperationId,
        toolCallId: record.toolCallId,
      };
      const added: EvidenceRecord[] = (result.evidence ?? []).map((item) => ({
        ref: newEvidenceRef(working),
        kind: item.kind,
        generation: working.generation,
        payload:
          item.payload !== null && typeof item.payload === "object" && !Array.isArray(item.payload)
            ? { ...(item.payload as Record<string, unknown>), producer }
            : { value: item.payload, producer },
        ...(item.fingerprint !== undefined ? { fingerprint: item.fingerprint } : {}),
      }));
      let next: DurableRunState = {
        ...working,
        evidence: [...working.evidence, ...added],
        budgets: { ...working.budgets, jobs: working.budgets.jobs - 1 },
        childOperations: [...others, { ...record, status: result.status, result: delivered, settledAt }],
        outstanding,
        stateRevision: working.stateRevision + 1,
      };
      if (result.status !== "ok") {
        next = recordExecutorFailure(next, {
          producer,
          stageId: record.stageId,
          attempt: record.attempt,
          executor: job.executor,
          status: result.status,
          summary: result.summary,
          retryAfterMs,
        });
      }
      await saveRunState(next);
      return delivered;
    });
  }

  return {
    async callTool(req) {
      if (typeof req.toolCallId !== "string" || req.toolCallId.length === 0 || req.toolCallId.length > MAX_TOOL_CALL_ID) {
        return failed(`toolCallId must be a non-empty string of at most ${MAX_TOOL_CALL_ID} characters`);
      }
      const binding = bindings.get(req.tool);
      if (!binding) return failed(`tool ${String(req.tool)} is not admitted for this job`);
      if (binding.effect !== "read" && !canWrite) {
        return failed(`tool ${binding.name} has effect ${binding.effect}, but this job has no write scope`);
      }
      let input: unknown;
      try {
        input = JSON.parse(assertBoundedJson(req.input ?? null));
      } catch (err) {
        return failed(err instanceof Error ? err.message : String(err));
      }
      if (busy) return failed("another tool call is in progress; tools run one at a time");
      busy = true;
      const call = run(binding, req, input);
      inFlight = call.catch(() => undefined);
      return call;
    },

    async close() {
      closed = true;
      cancel.abort();
      deps.signal.removeEventListener("abort", onStop);
      await inFlight;
    },

    async reserveModelCall() {
      return withRunLock(deps.stateDir, async () => {
        const state = await loadRunState(deps.stateDir);
        if ((await fence(state)) !== undefined || state.budgets.agentInvocations <= 0) return false;
        const pending = state.pendingDispatch!;
        await saveRunState({
          ...state,
          budgets: { ...state.budgets, agentInvocations: state.budgets.agentInvocations - 1 },
          pendingDispatch: { ...pending, modelCalls: (pending.modelCalls ?? 0) + 1 },
          stateRevision: state.stateRevision + 1,
        });
        return true;
      });
    },
  };

  async function run(binding: ToolBinding, req: ToolCallRequest, input: unknown): Promise<ToolCallResult> {
    try {
      const admitted = await admit(binding, { ...req, input });
      if ("done" in admitted) return admitted.done;
      const { record, state } = admitted;
      const resolved = resolveExecutorPin(state, record.executor);
      const job: JobSpec = {
        stageId: record.stageId,
        kind: "command",
        purpose: "check",
        instruction: `tool ${record.tool} (${record.toolCallId}) for ${record.parentOperationId}`,
        executor: "error" in resolved ? record.executor : resolved.pin,
        effect: record.effect,
        input,
        // Children inherit the parent's worktree scope, never a broader one.
        ...(canWrite ? { writeScope: [...parent.job.writeScope!] } : { readOnly: true }),
      };
      let result: JobResult;
      let cutShort = false;
      try {
        if ("error" in resolved) throw new Error(resolved.error);
        result = await deps.runner.runJob(job, {
          runId: state.runId,
          operationId: record.childOperationId,
          generation: record.generation,
          worktreePath: state.worktreePath,
          artifactDir: state.artifactDir,
          signal: cancel.signal,
          ...(resolved.source !== undefined ? { executorSource: resolved.source } : {}),
        });
        cutShort = cancel.signal.aborted;
      } catch (err) {
        cutShort = cancel.signal.aborted;
        result = {
          status: "failed",
          summary: err instanceof Error ? err.message : String(err),
          runId: state.runId,
          operationId: record.childOperationId,
          generation: record.generation,
        };
      }
      return await settle(record, job, result, cutShort);
    } finally {
      busy = false;
    }
  }
}

/**
 * Settle child operations a crash left pending, before the parent is resumed
 * or retried. An interrupted read may run again; an interrupted write or
 * ambiguous effect may already have reached an external service, so it is
 * kept for reconciliation and the run stops.
 */
export function reconcileChildOperations(
  state: DurableRunState,
): { state: DurableRunState; settled: boolean; reason: string } {
  const pending = (state.childOperations ?? []).filter((c) => c.status === "pending");
  if (pending.length === 0) return { state, settled: true, reason: "no pending child operations" };
  const at = new Date().toISOString();
  const unresolved = pending.filter((c) => c.effect !== "read");
  const ids = new Set(pending.map((c) => c.childOperationId));
  const next: DurableRunState = {
    ...state,
    childOperations: (state.childOperations ?? []).map((c) =>
      ids.has(c.childOperationId)
        ? { ...c, status: c.effect === "read" ? ("abandoned" as const) : ("ambiguous" as const), settledAt: at }
        : c,
    ),
    outstanding: state.outstanding.filter((o) => !ids.has(o.operationId)),
  };
  if (unresolved.length > 0) {
    const list = unresolved.map((c) => `${c.childOperationId} (${c.tool}, ${c.effect})`).join(", ");
    return {
      state: next,
      settled: false,
      reason: `child operation may have reached an external service: ${list}`,
    };
  }
  return {
    state: next,
    settled: true,
    reason: `abandoned interrupted reads: ${pending.map((c) => c.childOperationId).join(", ")}`,
  };
}
