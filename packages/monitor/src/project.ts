// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { createHash } from 'node:crypto';
import type { MonitorJob, MonitorPage, MonitorPanel, MonitorPanelBase, MonitorPanelKind, MonitorSnapshot, MonitorTopology, PanelSelection } from '@graphloom/sdk';

const kinds: MonitorPanelKind[] = ['overview', 'topology', 'stages', 'jobs', 'activity', 'job', 'usage', 'output'];

function keyFor(kind: MonitorPanelKind, revision: string, selection: PanelSelection): string {
  return createHash('sha256').update(JSON.stringify([kind, revision, selection.stageId, selection.operationId, selection.attempt, selection.followCurrent])).digest('hex').slice(0, 20);
}

function page<T>(items: T[], kind: MonitorPanelKind, revision: string, selection: PanelSelection): { values: T[]; page: MonitorPage } {
  const size = Math.max(1, Math.min(200, Math.trunc(selection.pageSize ?? 32) || 32));
  const key = keyFor(kind, revision, selection);
  let offset = 0;
  let notice: string | undefined;
  if (selection.cursor) {
    const match = /^([a-z]+)\.([a-f0-9]{20})\.(\d{1,10})$/.exec(selection.cursor);
    if (!match || match[1] !== kind || match[2] !== key || Number(match[3]) >= Math.max(1, items.length)) {
      notice = 'Cursor no longer matches this revision or selection; showing the first page.';
    } else offset = Number(match[3]);
  }
  const values = items.slice(offset, offset + size);
  return { values, page: { total: items.length, offset, shown: values.length, omitted: items.length - values.length,
    ...(offset + values.length < items.length ? { nextCursor: `${kind}.${key}.${offset + values.length}` } : {}),
    ...(notice ? { notice } : {}) } };
}

function selectedJob(frame: MonitorSnapshot, selection: PanelSelection): { job: MonitorJob | null; reason: string | null; followingCurrent: boolean } {
  const jobs = frame.jobs ?? [];
  let matches: MonitorJob[];
  if (selection.operationId) {
    matches = jobs.filter(job => job.id === selection.operationId && (selection.attempt === undefined || job.attempt === selection.attempt));
    if (matches.length > 1) return { job: null, reason: 'Operation has multiple recorded attempts; select an explicit attempt.', followingCurrent: false };
  } else if (selection.followCurrent) {
    matches = jobs.filter(job => job.stageId === frame.run.currentStage && job.attempt === frame.run.currentAttempt && ['running', 'pending', 'active'].includes(job.status));
    if (matches.length > 1) return { job: null, reason: 'Multiple current operations; select an operation and attempt.', followingCurrent: true };
  } else return { job: null, reason: 'Select an operation and attempt, or explicitly follow current.', followingCurrent: false };
  const job = matches[0] ?? null;
  return { job, reason: job ? null : frame.jobs ? 'Selected operation is not present in this frame.' : 'Job observations unavailable.', followingCurrent: selection.followCurrent === true && !selection.operationId };
}

function legacyTopology(frame: MonitorSnapshot): MonitorTopology {
  return { revision: frame.run.controllerRevision ?? frame.frameId, source: 'legacy', nodes: (frame.stages ?? []).map(stage => ({ id: stage.id, ...(stage.name ? { label: stage.name } : {}) })), edges: [] };
}

/** Deterministic, read-only projections; selection never changes execution or follows a retry implicitly. */
export function projectPanels(frame: MonitorSnapshot, selection: PanelSelection = {}): MonitorPanel[] {
  if (frame.schemaVersion !== 1) throw new Error('Unsupported monitoring schema version');
  if (!frame.frameId || !frame.run.id) throw new Error('Monitoring frame and run identities are required');
  const requested: MonitorPanelKind[] = [...new Set<MonitorPanelKind>(selection.kinds ?? ['overview'])];
  if (requested.length === 0 || requested.some(kind => !kinds.includes(kind))) throw new Error('Select at least one known monitoring panel');
  if (selection.attempt !== undefined && (!Number.isInteger(selection.attempt) || selection.attempt < 0)) throw new Error('Attempt must be a non-negative integer');
  const selected = selectedJob(frame, selection);
  const result = requested.map((kind): MonitorPanel => {
    const base: MonitorPanelBase = { kind, frameId: frame.frameId, runId: frame.run.id, observedAt: frame.observedAt, title: `GraphLoom ${kind}`, sources: frame.sources, selection };
    switch (kind) {
      case 'overview': return { ...base, kind, content: { run: frame.run, hub: frame.hub ?? null } };
      case 'topology': {
        const original = frame.topology ?? legacyTopology(frame);
        const allEdges = selection.stageId ? original.edges.filter(edge => edge.from === selection.stageId || edge.to === selection.stageId) : original.edges;
        const related = new Set([...(selection.stageId ? [selection.stageId] : original.nodes.map(node => node.id)), ...allEdges.flatMap(edge => [edge.from, edge.to])]);
        const allNodes = original.nodes.filter(node => related.has(node.id));
        const items: Extract<MonitorPanel, { kind: 'topology' }>['content']['items'] = [
          ...allNodes.map(node => ({ kind: 'node' as const, id: node.id })),
          ...allEdges.map(edge => ({ kind: 'edge' as const, ...edge })),
        ];
        const scoped = page(items, kind, original.revision, selection);
        const ids = new Set(scoped.values.flatMap(item => item.kind === 'node' ? [item.id] : [item.from, item.to]));
        const nodes = original.nodes.filter(node => ids.has(node.id));
        const edgeIds = new Set(scoped.values.filter(item => item.kind === 'edge').map(item => item.id));
        const edges = original.edges.filter(edge => edgeIds.has(edge.id));
        const known = new Set(original.nodes.map(node => node.id));
        const missingEndpoints = [...new Set(edges.flatMap(edge => [edge.from, edge.to]).filter(id => !known.has(id)))];
        return { ...base, kind, content: { topology: { ...original, nodes, edges }, stages: (frame.stages ?? []).filter(stage => ids.has(stage.id)), items: scoped.values, page: scoped.page,
          hiddenNodes: original.nodes.length - nodes.length, hiddenEdges: original.edges.length - edges.length, missingEndpoints } };
      }
      case 'stages': {
        const scoped = page((frame.stages ?? []).filter(stage => !selection.stageId || selection.stageId === stage.id), kind, frame.frameId, selection);
        return { ...base, kind, content: { stages: scoped.values, page: scoped.page, available: frame.stages !== undefined } };
      }
      case 'jobs': {
        const scoped = page((frame.jobs ?? []).filter(job => !selection.stageId || selection.stageId === job.stageId), kind, frame.frameId, selection);
        return { ...base, kind, content: { jobs: scoped.values, page: scoped.page, available: frame.jobs !== undefined } };
      }
      case 'activity': {
        const scoped = page([...(frame.activity ?? [])].reverse(), kind, frame.frameId, selection);
        return { ...base, kind, content: { events: scoped.values, page: scoped.page, available: frame.activity !== undefined } };
      }
      case 'job': return { ...base, kind, content: selected };
      case 'usage': {
        const usage = frame.usage;
        const rows = usage ? [...usage.metrics.map(value => ({ kind: 'metric' as const, value })), ...(usage.budgets ?? []).map(value => ({ kind: 'budget' as const, value })), ...(usage.series ?? []).map(value => ({ kind: 'series' as const, value }))] : [];
        const scoped = page(rows, kind, frame.frameId, selection);
        return { ...base, kind, content: { usage: usage ? { ...usage, metrics: scoped.values.flatMap(row => row.kind === 'metric' ? [row.value] : []), budgets: scoped.values.flatMap(row => row.kind === 'budget' ? [row.value] : []), series: scoped.values.flatMap(row => row.kind === 'series' ? [row.value] : []) } : null, page: scoped.page } };
      }
      case 'output': {
        const entries = selected.job ? (frame.output ?? []).filter(entry => entry.operationId === selected.job?.id && entry.attempt === selected.job.attempt) : [];
        const scoped = page([...entries].reverse(), kind, frame.frameId, selection);
        return { ...base, kind, content: { entries: scoped.values, page: scoped.page, available: frame.output !== undefined, selectedJob: selected.job, notice: selected.reason } };
      }
    }
  });
  // Projections have value semantics: a viewer cannot mutate an owning runtime's snapshot.
  return structuredClone(result);
}
