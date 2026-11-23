// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { livePath, loadRunState, managedObservation, nodeAccepted, type DurableRunState } from "@graphloom/controller";
import type { HubObservation, HubStatus, HubSubmission, MonitorActivity, MonitorJob, MonitorMetric, MonitorSnapshot, MonitorTopology } from "@graphloom/sdk";
import { normalizeTopology, stableHash } from "@graphloom/sdk";
import { runStats } from "./stats.js";

export interface OwnedMonitorResult { observation: HubObservation; snapshot?: MonitorSnapshot; monitoringError?: string; }

/** This command runs on the owning runtime; the hub consumes only versioned values. */
export async function observeOwnedRun(stateDir: string, executionOnly = false): Promise<OwnedMonitorResult> {
  const state = await loadRunState(stateDir);
  const observation = managedObservation(state);
  if (executionOnly) return { observation };
  try {
    const snapshot = snapshotOf(state, observation.observedAt);
    // Leave room for the authoritative observation below the runtime transport's 8 MiB cap.
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 6 * 1024 * 1024) throw new Error("monitor snapshot exceeds its 6 MiB transport budget");
    return { observation, snapshot };
  } catch (error) {
    return { observation, monitoringError: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
  }
}

/** Pure projection of settled controller facts. Absence never becomes zero or live telemetry. */
export function snapshotOf(state: DurableRunState, observedAt: string): MonitorSnapshot {
  const stats = runStats(state);
  const traversal = traversalOf(state);
  const topology = topologyOf(state, traversal);
  const jobs: MonitorJob[] = (state.agentSessions ?? []).map((session) => ({
    id: session.operationId, stageId: session.stageId, attempt: session.attempt, status: session.status,
    executor: session.executorId, ...(session.harness !== undefined ? { harness: session.harness } : {}),
    ...(session.summary !== undefined ? { instruction: session.summary } : {}),
    workspace: state.worktreePath, ...(typeof session.sessionRef === "string" && session.sessionRef.length > 0 ? { sessions: [session.sessionRef] } : {}),
  }));
  const pending = state.pendingDispatch;
  if (pending !== undefined && !jobs.some((job) => job.id === pending.operationId)) jobs.push({
    id: pending.operationId, stageId: pending.stageId, attempt: state.current.attempt, status: pending.status,
    label: pending.job.purpose, instruction: pending.job.instruction, workspace: state.worktreePath,
    ...(pending.job.executor !== undefined ? { executor: pending.job.executor.id } : {}),
    ...(pending.job.writeScope !== undefined ? { scope: pending.job.writeScope } : {}),
  });
  const activity: MonitorActivity[] = (state.remedies ?? []).map((remedy, i) => ({
    id: `remedy:${remedy.at}:${i}`, observedAt: remedy.at, kind: remedy.condition, summary: remedy.remedy,
  }));
  for (const session of state.agentSessions ?? []) activity.push({
    id: `session:${session.operationId}`, observedAt: session.settledAt, kind: "job-settled", summary: `${session.stageId}: ${session.status}${session.summary ? ` — ${session.summary}` : ""}`,
  });
  activity.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const metrics: MonitorMetric[] = [{
    id: "model-calls", label: "Recorded model calls", value: stats.agentInvocations.total ?? null,
    unit: "calls", source: stats.usageSource.kind, exactness: stats.agentInvocations.exactness === "exact" ? "reported" : "estimated",
  }, { id: "tokens", label: "All-job token usage", value: null, unit: "tokens", source: "not reported uniformly by the runtime" }];
  for (const harness of stats.supervisor.byHarness) {
    if (harness.usage === undefined) continue;
    for (const [key, value] of Object.entries(harness.usage)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      metrics.push({ id: `supervisor:${harness.harness}:${key}`, label: `Supervisor ${harness.harness} ${key}`, value, unit: key.toLowerCase().includes("cost") ? "USD" : "tokens", source: "settled supervisor episode records", exactness: "settled" });
    }
  }
  const pathNodes = topology.path === undefined ? undefined : new Set(topology.path.map((visit) => visit.stageId));
  return {
    schemaVersion: 1, frameId: `${state.runId}:${state.stateRevision}:${observedAt}`, observedAt,
    run: {
      id: state.runId, graph: state.definition.graphId, status: state.status, controllerRevision: String(state.stateRevision),
      currentStage: state.current.stageId, currentAttempt: state.current.attempt, blocker: state.blocker ?? state.stopReason ?? null,
    },
    sources: [
      { id: "controller", status: "available", observedAt, revision: String(state.stateRevision) },
      { id: "traversal", status: traversal.path === undefined ? "unavailable" : "available", observedAt, ...(traversal.detail === undefined ? {} : { detail: traversal.detail }) },
      { id: "live-output", status: "unavailable", observedAt: null, detail: "settled session records are available; live harness output is not uniformly reported" },
      { id: "process", status: "unavailable", observedAt: null, detail: "process measurements are supplied by the hub's launch cgroup" },
    ],
    topology,
    stages: state.definition.stages.map((stage) => {
      // Match Controller.inspect: receipt validity off the live path is not accepted run progress.
      const onPath = pathNodes?.has(stage.id);
      const accepted = onPath === undefined ? null : onPath && nodeAccepted(state, stage.id);
      const active = state.status === "running" && stage.id === state.current.stageId;
      return {
        id: stage.id, name: stage.name, status: active ? "running" : onPath === false ? "off-path" : accepted === null ? "unknown" : accepted ? "accepted" : "unaccepted", accepted,
        attempt: stage.id === state.current.stageId ? state.current.attempt : stats.stages.find((row) => row.stageId === stage.id)?.attempts ?? null,
        requirement: stage.requirementIds.map((id) => state.definition.requirements.find((r) => r.id === id)?.statement ?? id).join("; "),
        path: pathNodes === undefined ? "unknown" : pathNodes.has(stage.id) ? "on-path" : "off-path",
        entry: topology.nodes.find((node) => node.id === stage.id)?.entry ?? "normal",
        ...(traversal.counts === undefined ? {} : { visits: traversal.counts.get(stage.id) ?? 0 }),
        ...(topology.nodes.find((node) => node.id === stage.id)?.maxVisits === undefined ? {} : { maxVisits: topology.nodes.find((node) => node.id === stage.id)!.maxVisits! }),
      };
    }),
    jobs, activity,
    usage: {
      metrics,
      budgets: stats.budgets.map((budget) => ({ label: `${budget.budget} (${budget.exactness})`, used: budget.used ?? null, limit: budget.granted ?? null, unit: budget.budget.endsWith("Ms") ? "ms" : "count" })),
      coverage: "Controller budget ledger and settled supervisor usage; unavailable harness totals are unknown, not zero.",
    },
    output: (state.agentSessions ?? []).filter((session) => session.summary !== undefined).map((session, i) => ({
      operationId: session.operationId, attempt: session.attempt, sequence: i, observedAt: session.settledAt, kind: "message", text: session.summary!,
    })),
  };
}

interface TraversalProjection {
  path?: MonitorTopology["path"];
  sideVisit?: MonitorTopology["sideVisit"];
  counts?: Map<string, number>;
  detail?: string;
}

/** Project recorded visits, or explicitly label the owning controller's legacy migration view. */
function traversalOf(state: DurableRunState): TraversalProjection {
  if (state.path === undefined && state.visits === undefined && state.sideVisit === undefined) {
    return {
      path: livePath(state).map(visit => ({ stageId: visit.stageId, attempt: visit.attempt })),
      detail: "Live path derived by the owning controller from legacy state; historical visit IDs, counts and side visits were not recorded.",
    };
  }
  const unknown = { detail: "Persisted traversal is incomplete or inconsistent; path acceptance is unknown." };
  if (!Array.isArray(state.visits) || !Array.isArray(state.path) || state.path.length === 0) return unknown;
  const knownStages = new Set(state.definition.stages.map(stage => stage.id));
  const visits = new Map<number, NonNullable<DurableRunState["visits"]>[number]>();
  const counts = new Map<string, number>();
  for (const record of state.visits) {
    if (typeof record !== "object" || record === null || typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 1 ||
      typeof record.stageId !== "string" || !knownStages.has(record.stageId) || typeof record.attempt !== "number" || !Number.isInteger(record.attempt) || record.attempt < 1 || visits.has(record.seq)) return unknown;
    visits.set(record.seq, record);
    counts.set(record.stageId, (counts.get(record.stageId) ?? 0) + 1);
  }
  if (!state.path.every(seq => typeof seq === "number" && visits.has(seq))) return { ...unknown, counts };
  const path = livePath(state);
  const supervisorOnly = new Set(state.definition.stages.filter(stage => stage.entry === "supervisor").map(stage => stage.id));
  if (new Set(path.map(visit => visit.stageId)).size !== path.length || path.some(visit => visit.ended !== undefined || supervisorOnly.has(visit.stageId))) return { ...unknown, counts };
  const result: TraversalProjection = { counts, path: path.map(visit => ({ stageId: visit.stageId, visit: visit.seq, attempt: visit.attempt })) };
  if (state.sideVisit !== undefined) {
    const side = visits.get(state.sideVisit);
    if (side === undefined || side.ended !== undefined || !supervisorOnly.has(side.stageId) || state.path.includes(side.seq)) return { ...unknown, counts };
    result.sideVisit = { stageId: side.stageId, visit: side.seq };
  } else result.sideVisit = null;
  return result;
}

function topologyOf(state: DurableRunState, traversal: TraversalProjection): MonitorTopology {
  const normalized = normalizeTopology(state.definition);
  const source = normalized.implicit ? "implicit" : "declared";
  const nodes = state.definition.stages.map(stage => ({ id: stage.id, label: stage.name,
    entry: stage.entry === "supervisor" ? "supervisor" as const : "normal" as const,
    ...(stage.maxVisits === undefined ? {} : { maxVisits: stage.maxVisits }) }));
  const edges: MonitorTopology["edges"] = normalized.edges.map((edge, i) => {
      if (typeof edge !== "object" || edge === null || !("from" in edge) || !("to" in edge) || typeof edge.from !== "string" || typeof edge.to !== "string") throw new Error("owning runtime returned malformed topology edge");
      return { id: `${source}:${i}`, from: edge.from, to: edge.to };
    });
  return { revision: stableHash({ nodes, edges }), source, nodes, edges,
    current: state.current.stageId,
    ...(traversal.path === undefined ? {} : { path: traversal.path }),
    ...(traversal.sideVisit === undefined ? {} : { sideVisit: traversal.sideVisit }),
    start: normalized.start, terminal: normalized.terminal,
  };
}

export function withHubSnapshot(snapshot: MonitorSnapshot | undefined, submission: HubSubmission, status: HubStatus, now = new Date().toISOString(), unavailable?: string): MonitorSnapshot {
  const base: MonitorSnapshot = snapshot ?? {
    schemaVersion: 1, frameId: `${submission.id}:${now}`, observedAt: now,
    run: { id: submission.runId, status: submission.generation === 0 && submission.launch === undefined ? "not-created" : "unknown" }, sources: [],
  };
  return {
    ...base, frameId: `${base.frameId}:hub:${submission.updatedAt}`, observedAt: now,
    run: { ...base.run, submissionId: submission.id, nextEligibleAt: submission.eligibleAt ?? null, blocker: submission.blocker ?? base.run.blocker ?? null },
    sources: [
      ...base.sources.map((source) => unavailable !== undefined && source.status === "available" ? { ...source, status: "stale" as const, detail: unavailable } : source),
      ...(snapshot === undefined ? [{ id: "controller", status: "unavailable" as const, observedAt: null, detail: unavailable ?? (submission.generation === 0 ? "run has not started" : "owning-runtime observation unavailable") }] : []),
      { id: "hub", status: "available", observedAt: now, revision: submission.updatedAt },
    ],
    hub: { occupied: status.occupiedSlots, limit: status.maxConcurrentRuns, queued: status.submissions.filter((item) => item.state === "queued").length, state: submission.state, observationId: submission.updatedAt },
  };
}
