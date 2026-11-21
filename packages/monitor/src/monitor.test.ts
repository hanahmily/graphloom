// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import { describe, expect, it } from 'vitest';
import katex from 'katex';
import type { MonitorPanelKind, MonitorSnapshot, TopologyPanel } from '@graphloom/sdk';
import { projectPanels, renderPanels } from './index.js';
import { areaChart } from './chart.js';
import { Canvas, cleanText, widthOf } from './cells.js';
import { escapeTex } from './katex.js';
import { drawTopology } from './topology.js';

const now = '2026-11-20T12:00:00Z';
const allKinds: MonitorPanelKind[] = ['overview', 'topology', 'stages', 'jobs', 'activity', 'job', 'usage', 'output'];
function snapshot(): MonitorSnapshot {
  return {
    schemaVersion: 1, frameId: 'frame-17', observedAt: now,
    run: { id: 'run-23', status: 'running', graph: 'review', controllerRevision: '17', currentStage: 'A', currentAttempt: 2 },
    sources: [{ id: 'controller', status: 'available', revision: '17', observedAt: now }, { id: 'telemetry', status: 'stale', observedAt: '2026-11-20T11:58:00Z', detail: 'connection gap' }],
    hub: { occupied: 2, limit: 3, queued: 1 },
    stages: [{ id: 'A', status: 'running', accepted: false, attempt: 2, path: 'on-path' }, { id: 'B', status: 'succeeded', accepted: true, attempt: 1, path: 'off-path' }],
    topology: { revision: 'topology-1', source: 'declared', nodes: ['A', 'B', 'C', 'D'].map(id => ({ id })), edges: [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D']].map(([from, to], i) => ({ id: `edge-${i}`, from: from!, to: to! })), path: [{ stageId: 'A', attempt: 1 }, { stageId: 'B', attempt: 1 }], current: 'A', sideVisit: null, start: 'A', terminal: ['D'] },
    jobs: [{ id: 'op-1', stageId: 'A', attempt: 1, status: 'succeeded', harness: 'codex', sessions: ['session-1'] }, { id: 'op-2', stageId: 'A', attempt: 2, status: 'running', harness: 'claude-code' }],
    activity: [{ id: 'event-1', observedAt: now, kind: 'reentry', summary: 'Reentered A; earlier receipt invalidated.' }],
    usage: { metrics: [{ id: 'out', label: 'Output', value: 100, unit: 'tokens', source: 'settlement', exactness: 'settled' }, { id: 'cost', label: 'Cost', value: null, unit: 'USD', source: 'provider' }], budgets: [{ label: 'jobs', used: 2, limit: 5, unit: 'jobs' }] },
    output: [{ operationId: 'op-1', attempt: 1, sequence: 7, observedAt: now, kind: 'message', text: 'All checks passed.' }, { operationId: 'op-2', attempt: 2, sequence: 1, observedAt: now, kind: 'gap', text: 'Telemetry interrupted.' }],
  };
}

function topology(frame = snapshot(), selection = {}): TopologyPanel {
  const panel = projectPanels(frame, { kinds: ['topology'], ...selection })[0]!;
  if (panel.kind !== 'topology') throw new Error('Wrong fixture panel');
  return panel;
}

describe('semantic projections', () => {
  it('keeps source freshness, receipt validity, path tail and current work separate', async () => {
    const frame = snapshot();
    const panels = projectPanels(frame, { kinds: allKinds, operationId: 'op-1', attempt: 1 });
    expect(panels).toHaveLength(8);
    const report = await renderPanels(panels, { width: 100, maxBytes: 100000 });
    expect(report.output).toContain('Current: A; path tail: B');
    expect(report.output).toContain('Receipt: not valid; on-path');
    expect(report.output).toContain('Job success does not establish stage acceptance.');
    expect(report.output).toContain('telemetry: stale');
    expect(report.output).toContain('100 tokens; settled');
    expect(report.output).toContain('Context occupancy: unknown');
    expect(frame.stages![0]!.accepted).toBe(false);
    panels[0]!.sources[0]!.status = 'unavailable';
    expect(frame.sources[0]!.status).toBe('available');
  });

  it('never silently switches a selected operation after retry', () => {
    const frame = snapshot();
    const selected = projectPanels(frame, { kinds: ['job', 'output'], operationId: 'op-1', attempt: 1 });
    expect(selected[0]).toMatchObject({ kind: 'job', content: { job: { id: 'op-1', attempt: 1 }, followingCurrent: false } });
    expect(selected[1]).toMatchObject({ kind: 'output', content: { entries: [{ operationId: 'op-1', sequence: 7 }] } });
    expect(projectPanels(frame, { kinds: ['job'], followCurrent: true })[0]).toMatchObject({ content: { job: { id: 'op-2' }, followingCurrent: true } });
    frame.jobs!.push({ ...frame.jobs![0]!, attempt: 2 });
    expect(projectPanels(frame, { kinds: ['job'], operationId: 'op-1' })[0]).toMatchObject({ content: { job: null, reason: expect.stringContaining('explicit attempt') } });
  });

  it('labels old runtimes and absent telemetry without fabricating graph edges or rates', async () => {
    const frame = snapshot(); delete frame.topology; delete frame.usage; delete frame.output;
    const panels = projectPanels(frame, { kinds: ['topology', 'usage', 'output'], operationId: 'op-1', attempt: 1 });
    expect(panels[0]).toMatchObject({ content: { topology: { source: 'legacy', edges: [] } } });
    const report = await renderPanels(panels);
    expect(report.output).toContain('Legacy stage view');
    expect(report.output).toContain('Usage: unknown');
    expect(report.output).toContain('no live telemetry');
  });

  it('paginates every node and directed edge and rejects a cursor after topology/selection changes', () => {
    const frame = snapshot(); frame.topology!.edges.push({ id: 'return', from: 'D', to: 'A' });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const panel = topology(frame, { pageSize: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...panel.content.items.map(item => `${item.kind}:${item.id}`));
      cursor = panel.content.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['node:A', 'node:B', 'node:C', 'node:D', 'edge:edge-0', 'edge:edge-1', 'edge:edge-2', 'edge:edge-3', 'edge:return']);
    const old = topology(frame, { pageSize: 2 }).content.page.nextCursor;
    frame.frameId = 'frame-new';
    expect(topology(frame, { cursor: old }).content.page.notice).toBeUndefined();
    frame.topology!.revision = 'topology-2';
    expect(topology(frame, { cursor: old }).content.page.notice).toContain('revision or selection');
    expect(topology(frame, { cursor: old, stageId: 'D' }).content.page.notice).toContain('first page');
  });
});

describe('orthogonal topology adapter', () => {
  it('draws a qualified diamond and retains both incoming edges in readable adjacency', async () => {
    const panel = topology();
    const drawing = await drawTopology(panel, 96);
    expect(drawing.fallbackReason).toBeUndefined();
    expect(drawing.lines.join('\n')).toContain('▶');
    const report = await renderPanels([panel], { width: 100 });
    for (const edge of panel.content.topology.edges) expect(report.output).toContain(`${edge.from} -> ${edge.to} [${edge.id}]`);
    expect(report.output).toContain('0 hidden nodes, 0 hidden edges');
  });

  it('preserves return-edge direction, supervisor overlays and exact edges at narrow widths', async () => {
    const frame = snapshot();
    frame.topology!.edges.push({ id: 'return', from: 'D', to: 'A' });
    frame.topology!.nodes.push({ id: 'Repair', entry: 'supervisor', maxVisits: 2 });
    frame.topology!.sideVisit = { stageId: 'Repair', visit: 1, reason: 'repair' };
    const report = await renderPanels([topology(frame)], { width: 30 });
    expect(report.fallbackReasons.join(' ')).toContain('viewport');
    expect(report.output.replace(/│|\n| /g, '')).toContain('D->A[return]');
    expect(report.output.replace(/│|\n| /g, '')).toContain('supervisor-only');
    expect(report.output.replace(/│|\n| /g, '')).not.toContain('A->Repair');
  });

  it('caches static geometry without making status or focus changes move nodes', async () => {
    const frame = snapshot(); const before = await drawTopology(topology(frame), 96);
    frame.stages![0]!.status = 'failed'; frame.topology!.current = 'B';
    expect(await drawTopology(topology(frame), 96)).toEqual(before);
  });
});

describe('quantitative area charts', () => {
  it('distinguishes zero from gaps and does not connect a lost sample', () => {
    const chart = areaChart({ id: 'rate', label: 'Output rate', unit: 'tokens/s', source: 'stream', aggregation: 'time-weighted', samples: [
      { at: '2026-11-20T12:00:00Z', value: 0 }, { at: '2026-11-20T12:00:01Z', value: 0 },
      { at: '2026-11-20T12:00:02Z', value: null }, { at: '2026-11-20T12:00:03Z', value: 10 }, { at: '2026-11-20T12:00:04Z', value: 10 },
    ] }, 4);
    expect(chart.buckets).toEqual([0, null, null, 10]);
    expect(chart.range).toEqual({ min: 0, max: 10 });
    expect(chart.lines.map(line => line.text).join('\n')).toContain('baseline 0; time-weighted');
    expect(chart.gaps).toBe(2);
  });

  it('weights rates by elapsed time and exposes a changed scale and source range', () => {
    const series = { id: 'rate', label: 'Rate', unit: 'tokens/s', source: 'stream', aggregation: 'time-weighted' as const, samples: [
      { at: '2026-11-20T12:00:00Z', value: 2 }, { at: '2026-11-20T12:00:01Z', value: 10 }, { at: '2026-11-20T12:00:04Z', value: 10 },
    ] };
    const chart = areaChart(series, 2);
    expect(chart.buckets).toEqual([6, 10]);
    expect(chart.range).toEqual({ min: 2, max: 10 });
    expect(chart.lines.map(line => line.text).join('\n')).toContain('scale 0..10 tokens/s');
  });
});

describe('safe bounded serializers', () => {
  it('renders the same selected facts in JSON, plain, ANSI and native Markdown', async () => {
    const panels = projectPanels(snapshot(), { kinds: ['overview', 'usage'] });
    for (const format of ['text', 'ansi', 'json', 'markdown'] as const) {
      const report = await renderPanels(panels, { format, ...(format === 'markdown' ? { chatRenderer: 'katex' as const } : {}) });
      expect(report.frameId).toBe('frame-17');
      expect(report.output).toContain('run-23');
      expect(report.output).toContain('100');
      expect(report.output).toContain('tokens');
      expect(report.output).toContain('stale');
      if (format === 'json') expect(JSON.parse(report.output).panels).toHaveLength(2);
      if (format === 'ansi') expect(report.output).toContain('\u001b[36m');
      if (format === 'markdown') {
        expect(report.usedRenderer).toBe('katex');
        const expressions = [...report.output.matchAll(/\$\$\n([\s\S]*?)\n\$\$/g)];
        expect(expressions).toHaveLength(2);
        for (const expression of expressions) expect(() => katex.renderToString(expression[1]!, { displayMode: true, throwOnError: true, trust: false, strict: 'error' })).not.toThrow();
      }
    }
  });

  it('requires an explicit qualified surface for auto and honors NO_COLOR in both routes', async () => {
    const panels = projectPanels(snapshot());
    expect((await renderPanels(panels, { format: 'markdown' })).usedRenderer).toBe('plain');
    const automatic = await renderPanels(panels, { format: 'markdown', capabilityProfile: { renderer: 'katex', version: '0.16.27', surface: 'assistant-markdown', subset: 'graphloom-v1', qualified: true } });
    expect(automatic.usedRenderer).toBe('katex');
    expect((await renderPanels(panels, { format: 'markdown', chatRenderer: 'katex', noColor: true })).output).not.toContain('textcolor');
    expect((await renderPanels(panels, { format: 'ansi', noColor: true })).output).not.toContain('\u001b');
  });

  it('keeps control characters, Markdown fences and TeX commands inert', async () => {
    const frame = snapshot();
    const hostile = '\u001b[31mred\u001b[0m\u001b]8;;https://bad.test\u0007link\u001b]8;;\u0007\n```\n$$\\href{https://bad.test}{click}$$';
    frame.output![0]!.text = hostile;
    const panels = projectPanels(frame, { kinds: ['output'], operationId: 'op-1', attempt: 1 });
    const report = await renderPanels(panels, { format: 'markdown', chatRenderer: 'katex' });
    expect(report.output).not.toContain('\u001b');
    expect(report.output).toContain('~~~text');
    expect(report.output).toContain('redlink');
    expect(report.output).toContain('\\href'); // retained as literal fenced data, never inserted into math
    const escaped = escapeTex('a_#${b}%&~^\\href{evil}');
    expect(() => katex.renderToString(`\\texttt{${escaped}}`, { throwOnError: true, trust: false, strict: 'error' })).not.toThrow();
    expect(escaped).toContain('textbackslash{}href');
  });

  it('preserves CJK and combining character widths while choosing readable math fallback', async () => {
    const frame = snapshot(); frame.run.currentStage = '修复 e\u0301';
    const report = await renderPanels(projectPanels(frame), { format: 'markdown', chatRenderer: 'katex', width: 40 });
    expect(report.usedRenderer).toBe('plain');
    expect(report.fallbackReasons.join(' ')).toContain('unsupported math glyph');
    expect(report.output).toContain('修复 e\u0301');
    const plain = await renderPanels(projectPanels(frame), { width: 40 });
    expect(plain.output.split('\n').every(line => widthOf(line) === 40)).toBe(true);
    const canvas = new Canvas(4, 1);
    expect(canvas.put(0, 0, '修e\u0301')).toBe(true);
    expect(canvas.put(1, 0, '!')).toBe(false);
    expect(widthOf(canvas.lines()[0]!)).toBe(4);
    expect(canvas.put(0, 0, 'X')).toBe(true);
    expect(canvas.lines()[0]).toBe('X e\u0301 ');
    expect(widthOf(canvas.lines()[0]!)).toBe(4);
  });

  it('bounds reports and math atomically and returns actionable continuations', async () => {
    const frame = snapshot(); frame.jobs![0]!.instruction = 'long instruction '.repeat(10000);
    const panels = projectPanels(frame, { kinds: ['job'], operationId: 'op-1', attempt: 1 });
    for (const format of ['text', 'ansi', 'json', 'markdown'] as const) {
      const report = await renderPanels(panels, { format, maxBytes: 1024, ...(format === 'markdown' ? { chatRenderer: 'katex' as const } : {}) });
      expect(Buffer.byteLength(report.output)).toBeLessThanOrEqual(1024);
      expect(report.truncated).toBe(true);
      expect(report.continuation.length).toBeGreaterThan(0);
      if (format === 'json') expect(() => JSON.parse(report.output)).not.toThrow();
      if (format === 'markdown') for (const match of report.output.matchAll(/\$\$\n([\s\S]*?)\n\$\$/g)) expect(() => katex.renderToString(match[1]!, { throwOnError: true, trust: false })).not.toThrow();
    }
    const tiny = await renderPanels(projectPanels(snapshot()), { format: 'markdown', chatRenderer: 'katex', capabilityProfile: { renderer: 'katex', version: 'test', surface: 'assistant-markdown', subset: 'graphloom-v1', qualified: false, maxMathBytes: 10 } });
    expect(tiny.usedRenderer).toBe('plain');
    expect(tiny.fallbackReasons.join(' ')).toContain('math fragment exceeds');
  });

  it('rejects mixed frames and format ambiguity without touching run state', async () => {
    const frame = snapshot(); const panels = projectPanels(frame);
    const second = projectPanels({ ...frame, frameId: 'other' });
    await expect(renderPanels([...panels, ...second])).rejects.toThrow('one monitor frame');
    await expect(renderPanels(panels, { format: 'text', chatRenderer: 'katex' })).rejects.toThrow('only with Markdown');
    expect(cleanText('\u001b[2Jhello\u202eevil')).toBe('helloevil');
  });
});
