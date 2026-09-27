import { rm } from "node:fs/promises";
import path from "node:path";
import type { AgentSessionView, ExecutorSession, JobSpec } from "@graphloom/sdk";
import type { JobResult } from "@graphloom/runner";
import type { AgentSessionRecord, ChildOperationRecord, DurableRunState } from "./state.js";

/** Jobs that continue one another's sessions share this key: `jobId`, or `purpose:executorId`. */
export function dispatchKey(job: JobSpec): string {
  return job.jobId ?? `${job.purpose}:${job.executor?.id ?? job.kind}`;
}

/** Why a dispatch may not continue the session it names, if it may not. */
export function continuationRefusal(state: DurableRunState, job: JobSpec): string | undefined {
  const from = job.continueFrom;
  if (from === undefined) return undefined;
  if (job.kind !== "agent") return `only agent jobs carry sessions; a ${job.kind} job cannot continue ${from}`;
  const sessions = state.agentSessions ?? [];
  const record = sessions.find((r) => r.operationId === from);
  if (record === undefined) {
    return state.outstanding.some((o) => o.operationId === from)
      ? `operation ${from} has not settled`
      : `no agent session was recorded for operation ${from} in run ${state.runId}`;
  }
  if (record.stageId !== job.stageId) {
    return `operation ${from} ran stage ${record.stageId}, not ${job.stageId}`;
  }
  const key = dispatchKey(job);
  if (record.dispatchKey !== key) {
    return `operation ${from} has dispatch key ${record.dispatchKey}, not ${key}`;
  }
  if (record.generation > state.generation) {
    return `operation ${from} was recorded by a later generation (${record.generation} > ${state.generation})`;
  }
  const successor = sessions.find((r) => r.continuedFrom === from);
  if (successor !== undefined) {
    return `operation ${from} was already continued by ${successor.operationId}; continue from that one`;
  }
  return undefined;
}

/**
 * The session directory for an agent job: its own for a fresh session, the
 * continued session's otherwise. Call after `continuationRefusal` passed.
 */
export function sessionForDispatch(
  state: DurableRunState,
  job: JobSpec,
  operationId: string,
): ExecutorSession | undefined {
  if (job.kind !== "agent") return undefined;
  if (job.continueFrom !== undefined) {
    const record = state.agentSessions!.find((r) => r.operationId === job.continueFrom)!;
    return { dir: record.sessionDir, resume: record.sessionRef };
  }
  return { dir: path.join(agentSessionsDir(state.stateDir), operationId) };
}

function agentSessionsDir(stateDir: string): string {
  return path.join(stateDir, "agent-sessions");
}

/**
 * Remove a finished run's saved agent sessions: nothing can continue them,
 * and transcripts with subagents grow large. The records stay in run state.
 */
export async function wipeAgentSessions(state: DurableRunState): Promise<void> {
  if (state.status !== "succeeded" && state.status !== "failed") return;
  await rm(agentSessionsDir(state.stateDir), { recursive: true, force: true });
}

export function recordAgentSession(
  state: DurableRunState,
  args: { job: JobSpec; operationId: string; generation: number; session: ExecutorSession; result: JobResult },
): DurableRunState {
  const { job, operationId, generation, session, result } = args;
  if (job.kind !== "agent" || result.sessionRef === undefined) return state;
  const record: AgentSessionRecord = {
    operationId,
    stageId: job.stageId,
    attempt: state.current.attempt,
    generation,
    dispatchKey: dispatchKey(job),
    executorId: job.executor?.id ?? job.kind,
    status: result.status,
    sessionRef: result.sessionRef,
    sessionDir: session.dir,
    ...(job.continueFrom !== undefined ? { continuedFrom: job.continueFrom } : {}),
    settledAt: new Date().toISOString(),
  };
  return { ...state, agentSessions: [...(state.agentSessions ?? []), record] };
}

export function agentSessionViews(state: DurableRunState): AgentSessionView[] | undefined {
  const sessions = state.agentSessions ?? [];
  if (sessions.length === 0) return undefined;
  return sessions.map((r) => ({
    operationId: r.operationId,
    stageId: r.stageId,
    attempt: r.attempt,
    generation: r.generation,
    dispatchKey: r.dispatchKey,
    executorId: r.executorId,
    status: r.status,
    ...(r.continuedFrom !== undefined ? { continuedFrom: r.continuedFrom } : {}),
  }));
}

/** Operations whose session `continueFrom` carries on: it and everything it continued. */
export function continuedOperations(state: DurableRunState, continueFrom: string | undefined): Set<string> {
  const lineage = new Set<string>();
  let next = continueFrom;
  while (next !== undefined && !lineage.has(next)) {
    lineage.add(next);
    next = state.agentSessions?.find((r) => r.operationId === next)?.continuedFrom;
  }
  return lineage;
}

/**
 * A continued session's transcript holds the earlier turns' tool calls. The
 * agent must make new calls rather than repeat those, and an earlier write
 * with an unknown outcome blocks the same write until it is reconciled.
 */
export function earlierToolCallRefusal(
  children: readonly ChildOperationRecord[],
  lineage: ReadonlySet<string>,
  call: { toolCallId: string; tool: string; inputKey: string },
  canonical: (value: unknown) => string,
): string | undefined {
  if (lineage.size === 0) return undefined;
  const earlier = children.filter((c) => lineage.has(c.parentOperationId));
  const unresolved = earlier.find(
    (c) =>
      (c.status === "ambiguous" || c.status === "pending") &&
      (c.toolCallId === call.toolCallId || (c.tool === call.tool && canonical(c.input) === call.inputKey)),
  );
  if (unresolved !== undefined) {
    return `tool call ${call.toolCallId} repeats ${unresolved.tool} call ${unresolved.toolCallId} from an earlier attempt, whose outcome is unreconciled`;
  }
  if (earlier.some((c) => c.toolCallId === call.toolCallId)) {
    return `tool call ${call.toolCallId} belongs to an earlier attempt; make a new call`;
  }
  return undefined;
}
