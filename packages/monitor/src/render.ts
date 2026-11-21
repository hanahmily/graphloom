// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { MonitorPage, MonitorPanel } from '@graphloom/sdk';
import { box, cleanText, graphemes, toneFor } from './cells.js';
import type { Line } from './cells.js';
import { areaChart, numeric } from './chart.js';
import { mathSummary } from './katex.js';
import { drawTopology } from './topology.js';
import type { RenderOptions, RenderedReport } from './types.js';

function pageLines(page: MonitorPage): Line[] {
  return [
    ...(page.notice ? [{ text: page.notice, tone: 'warning' as const }] : []),
    ...(page.omitted ? [{ text: `Showing ${page.offset + 1}..${page.offset + page.shown} of ${page.total}; ${page.omitted} outside this page.`, tone: 'warning' as const }] : []),
    ...(page.nextCursor ? [{ text: `Next: --cursor ${page.nextCursor}` }] : []),
  ];
}

function commonLines(panel: MonitorPanel): Line[] {
  return [
    { text: `Run: ${panel.runId}` }, { text: `Observed: ${panel.observedAt}; frame: ${panel.frameId}`, tone: 'muted' },
    ...panel.sources.map(source => ({ text: `Source ${source.id}: ${source.status}; at ${source.observedAt ?? 'unknown'}${source.revision ? `; revision ${source.revision}` : ''}${source.detail ? `; ${source.detail}` : ''}`, tone: source.status === 'available' ? 'muted' as const : 'warning' as const })),
  ];
}

async function panelLines(panel: MonitorPanel, width: number, fallbackReasons: string[]): Promise<Line[]> {
  switch (panel.kind) {
    case 'overview': {
      const { run, hub } = panel.content;
      return [
        { text: `Status: ${run.status}`, tone: toneFor(run.status) },
        { text: `Graph: ${run.graph ?? 'unknown'}; submission: ${run.submissionId ?? 'unmanaged/unknown'}` },
        { text: `Current: ${run.currentStage ?? 'unknown'}; attempt: ${run.currentAttempt ?? 'unknown'}` },
        { text: `Controller revision: ${run.controllerRevision ?? 'unknown'}` },
        { text: `Blocker: ${run.blocker ?? 'none reported'}`, tone: run.blocker ? 'warning' : 'neutral' },
        { text: `Next eligible: ${run.nextEligibleAt ?? 'not reported'}` },
        { text: hub ? `Hub slots: ${hub.occupied}/${hub.limit}; queued: ${hub.queued}; state: ${hub.state ?? 'unknown'}; observation: ${hub.observationId ?? 'unknown'}` : 'Hub: unmanaged or unavailable' },
      ];
    }
    case 'topology': {
      const { topology, stages, items, page, hiddenEdges, hiddenNodes, missingEndpoints } = panel.content;
      const drawing = await drawTopology(panel, width - 4);
      if (drawing.fallbackReason) fallbackReasons.push(drawing.fallbackReason);
      const lines: Line[] = [
        { text: `Topology: ${topology.source}; revision ${topology.revision}` },
        { text: `Current: ${topology.current ?? 'unknown'}; path tail: ${topology.path?.at(-1)?.stageId ?? 'unknown'}` },
        { text: `Live path: ${topology.path ? topology.path.map(visit => `${visit.stageId}${visit.visit === undefined ? '' : ` visit ${visit.visit}`}${visit.attempt === undefined ? '' : ` attempt ${visit.attempt}`}`).join(' -> ') || '(empty)' : 'unknown'}` },
        { text: `Supervisor side visit: ${topology.sideVisit === undefined ? 'unknown' : topology.sideVisit === null ? 'none' : `${topology.sideVisit.stageId}${topology.sideVisit.visit === undefined ? '' : ` visit ${topology.sideVisit.visit}`}${topology.sideVisit.reason ? `; ${topology.sideVisit.reason}` : ''}`}` },
        { text: `Start: ${topology.start ?? 'unknown'}; terminal: ${topology.terminal?.join(', ') ?? 'unknown'}` },
        ...drawing.lines.map(text => ({ text })),
        ...(drawing.fallbackReason ? [{ text: drawing.fallbackReason, tone: 'warning' as const }] : []),
        { text: `${topology.source === 'legacy' ? 'Stage inventory' : 'Declared node/edge inventory'} (${hiddenNodes} hidden nodes, ${hiddenEdges} hidden edges):` },
      ];
      for (const item of items) {
        if (item.kind === 'edge') lines.push({ text: `${item.from} -> ${item.to} [${item.id}]` });
        else {
          const node = topology.nodes.find(value => value.id === item.id);
          const stage = stages.find(value => value.id === item.id);
          lines.push({ text: `${item.id}${node?.label && node.label !== item.id ? ` (${node.label})` : ''}: ${stage?.status ?? 'unknown'}; receipt ${stage?.accepted === null || stage?.accepted === undefined ? 'unknown' : stage.accepted ? 'valid' : 'not valid'}; ${stage?.path ?? 'path unknown'}${node?.entry === 'supervisor' ? '; supervisor-only' : ''}${node?.maxVisits == null ? '' : `; max visits ${node.maxVisits}`}`, tone: toneFor(stage?.status ?? 'unknown') });
        }
      }
      if (missingEndpoints.length) lines.push({ text: `Unreported endpoint nodes: ${missingEndpoints.join(', ')}`, tone: 'warning' });
      if (panel.selection.stageId) lines.push({ text: 'Selected neighbourhood only; omit --stage for the full inventory.' });
      return [...lines, ...pageLines(page)];
    }
    case 'stages': return [
      { text: 'Stage counts are inventory, not a branching-graph completion percentage.' },
      ...(panel.content.available ? panel.content.stages.flatMap(stage => [
        { text: `${stage.id}${stage.name ? ` (${stage.name})` : ''}: ${stage.status}; attempt ${stage.attempt ?? 'unknown'}; visits ${stage.visits ?? 'unknown'}${stage.maxVisits == null ? '' : `/${stage.maxVisits}`}`, tone: toneFor(stage.status) },
        { text: `Receipt: ${stage.accepted === null ? 'unknown' : stage.accepted ? 'valid' : 'not valid'}; ${stage.path ?? 'path unknown'}; entry ${stage.entry ?? 'unknown'}` },
        ...(stage.requirement ? [{ text: `Required outcome: ${stage.requirement}` }] : []),
      ]) : [{ text: 'Stages: unknown (observations unavailable)', tone: 'warning' as const }]),
      ...pageLines(panel.content.page),
    ];
    case 'jobs': return [
      { text: 'Job success does not establish stage acceptance.' },
      ...(panel.content.available ? panel.content.jobs.map(job => ({ text: `${job.stageId} / attempt ${job.attempt} / ${job.id}: ${job.status}; ${job.label ?? 'no label'}; harness ${job.harness ?? 'unknown'}; executor ${job.executor ?? 'unknown'}; sessions ${(job.sessions ?? []).join(', ') || 'not reported'}`, tone: toneFor(job.status) })) : [{ text: 'Jobs: unknown (observations unavailable)', tone: 'warning' as const }]),
      ...pageLines(panel.content.page),
    ];
    case 'activity': return [
      ...(panel.content.available ? panel.content.events.flatMap(event => [{ text: `${event.observedAt} [${event.id}] ${event.kind}: ${event.summary}`, tone: toneFor(event.kind) }, ...(event.evidence ?? []).map(ref => ({ text: `Evidence: ${ref}` }))]) : [{ text: 'Activity: unknown (observations unavailable)', tone: 'warning' as const }]),
      ...pageLines(panel.content.page),
    ];
    case 'job': {
      const { job, reason, followingCurrent } = panel.content;
      if (!job) return [{ text: reason ?? 'Job: unknown', tone: 'warning' }];
      return [
        { text: `Selection: ${followingCurrent ? 'FOLLOW CURRENT (explicit)' : 'fixed operation and attempt'}` },
        { text: `Operation: ${job.id}; stage ${job.stageId}; attempt ${job.attempt}; ${job.status}`, tone: toneFor(job.status) },
        { text: `Harness: ${job.harness ?? 'unknown'}; executor ${job.executor ?? 'unknown'}; model ${job.model ?? 'unknown'}` },
        { text: `Instruction: ${job.instruction ?? 'not reported'}` },
        { text: `Scope: ${job.scope?.join(', ') ?? 'not reported'}` },
        { text: `Workspace: ${job.workspace ?? 'not reported'}` },
        { text: `Sessions: ${job.sessions?.join(', ') ?? 'not reported'}` },
        ...(job.evidence ?? []).map(ref => ({ text: `Evidence: ${ref}` })),
      ];
    }
    case 'usage': {
      const usage = panel.content.usage;
      if (!usage) return [{ text: 'Usage: unknown (observations unavailable)', tone: 'warning' }];
      return [
        ...usage.metrics.map(metric => ({ text: `${metric.label}: ${numeric(metric.value)} ${metric.unit}; ${metric.exactness ?? 'reported'}; source ${metric.source}${metric.window ? `; window ${metric.window.from} -> ${metric.window.to}` : ''}`, tone: metric.value === null ? 'warning' as const : 'neutral' as const })),
        ...(usage.budgets ?? []).map(budget => ({ text: `Budget ${budget.label}: ${numeric(budget.used)}/${numeric(budget.limit)} ${budget.unit}`, tone: budget.used !== null && budget.limit !== null && budget.limit > 0 && budget.used / budget.limit >= 0.8 ? 'warning' as const : 'neutral' as const })),
        { text: usage.context ? `Context: ${numeric(usage.context.used)}/${numeric(usage.context.limit)} tokens; session ${usage.context.sessionId}; at ${usage.context.observedAt}` : 'Context occupancy: unknown (lifetime token totals are not context occupancy)' },
        { text: `Resource coverage: ${usage.coverage ?? 'unknown'}` },
        ...(usage.series ?? []).flatMap(series => areaChart(series, width - 4).lines),
        ...pageLines(panel.content.page),
      ];
    }
    case 'output': return [
      { text: `Output is read-only; operation ${panel.content.selectedJob?.id ?? 'unselected'}; attempt ${panel.content.selectedJob?.attempt ?? 'unknown'}` },
      ...(panel.content.notice ? [{ text: panel.content.notice, tone: 'warning' as const }] : []),
      ...(!panel.content.available ? [{ text: 'Output unavailable; no live telemetry was reported.', tone: 'warning' as const }] : []),
      ...panel.content.entries.map(entry => ({ text: `${entry.observedAt} #${entry.sequence} ${entry.kind}: ${entry.text}`, tone: entry.kind === 'gap' ? 'warning' as const : 'neutral' as const })),
      ...pageLines(panel.content.page),
    ];
  }
}

function markdownEscape(value: string): string { return cleanText(value).replace(/[\\`*_{}\[\]()<>#+.!|$]/g, '\\$&').replace(/\n/g, ' '); }
function fence(value: string): string {
  const longest = (pattern: RegExp): number => (value.match(pattern) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const backticks = longest(/`+/g); const tildes = longest(/~+/g);
  const character = backticks <= tildes ? '`' : '~';
  const delimiter = character.repeat(Math.max(3, Math.min(backticks, tildes) + 1));
  return `${delimiter}text\n${value}\n${delimiter}`;
}
function boundedFence(value: string, budget: number): { output: string; truncated: boolean } {
  let fitted = fitPlain(value, Math.max(64, budget - 16));
  for (let i = 0; i < 8; i++) {
    const output = fence(fitted.output);
    if (Buffer.byteLength(output) <= budget) return { output, truncated: fitted.truncated };
    fitted = fitPlain(value, Math.max(64, Buffer.byteLength(fitted.output) - (Buffer.byteLength(output) - budget) - 16));
  }
  return { output: fence('[bounded output; request a smaller page]'), truncated: true };
}
function fitPlain(value: string, budget: number): { output: string; truncated: boolean } {
  if (Buffer.byteLength(value) <= budget) return { output: value, truncated: false };
  const marker = '\n[bounded output; use a smaller page and continuation cursor]';
  const available = Math.max(0, budget - Buffer.byteLength(marker));
  let output = ''; let bytes = 0;
  for (const part of graphemes(value)) { const next = Buffer.byteLength(part); if (bytes + next > available) break; output += part; bytes += next; }
  return { output: output + marker, truncated: true };
}

/** Pure asynchronous rendering: ELK computes geometry locally; no reads, scheduling or delivery occur here. */
export async function renderPanels(panels: MonitorPanel[], options: RenderOptions = {}): Promise<RenderedReport> {
  if (!panels.length) throw new Error('At least one panel is required');
  const frameId = panels[0]!.frameId;
  if (panels.some(panel => panel.frameId !== frameId || panel.runId !== panels[0]!.runId)) throw new Error('A report must use one run and one monitor frame');
  const format = options.format ?? 'text';
  if (!['text', 'ansi', 'markdown', 'json'].includes(format)) throw new Error('Unknown monitor output format');
  if (options.chatRenderer !== undefined && format !== 'markdown') throw new Error('chatRenderer is valid only with Markdown');
  const requestedRenderer = options.chatRenderer ?? 'auto';
  if (!['auto', 'plain', 'katex'].includes(requestedRenderer)) throw new Error('Unknown chat renderer');
  const width = Math.max(16, Math.min(180, Math.trunc(options.width ?? 88) || 88));
  const budget = Math.min(options.maxBytes ?? 32768, options.capabilityProfile?.maxBytes ?? 32768);
  if (!Number.isFinite(budget) || budget < 512) throw new Error('Monitor output budget must be at least 512 bytes');
  const maxBytes = Math.min(262144, Math.trunc(budget));
  const fallbackReasons: string[] = [];
  const continuation = panels.flatMap(panel => 'page' in panel.content && panel.content.page.nextCursor ? [`${panel.kind}: --cursor ${panel.content.page.nextCursor}`] : []);
  const base: RenderedReport = { frameId, format, requestedRenderer, usedRenderer: format === 'ansi' ? 'ansi' : format === 'json' ? 'json' : 'plain', fallbackReasons, output: '', truncated: false, continuation };
  if (format === 'json') {
    const kept: MonitorPanel[] = []; const omittedPanels: string[] = [];
    for (const panel of panels) {
      const candidate = JSON.stringify({ schemaVersion: 1, frameId, panels: [...kept, panel], omittedPanels: panels.filter(value => !kept.includes(value) && value !== panel).map(value => value.kind) });
      if (Buffer.byteLength(candidate) < maxBytes - 200) kept.push(panel); else omittedPanels.push(panel.kind);
    }
    if (omittedPanels.length) { base.truncated = true; fallbackReasons.push('JSON size budget omitted named panels; request them separately with a smaller page.'); continuation.push(...omittedPanels.map(kind => `${kind}: --page-size 1`)); }
    base.output = JSON.stringify({ schemaVersion: 1, frameId, panels: kept, omittedPanels, ...(omittedPanels.length ? { notice: fallbackReasons[0] } : {}) }, null, 0);
    if (Buffer.byteLength(base.output) > maxBytes) throw new Error('Frame identity alone exceeds output budget');
    return base;
  }
  const profile = options.capabilityProfile;
  const capable = profile?.qualified === true && profile.renderer === 'katex' && profile.subset === 'graphloom-v1' && Boolean(profile.version);
  const useMath = format === 'markdown' && (requestedRenderer === 'katex' || requestedRenderer === 'auto' && capable);
  if (format === 'markdown' && requestedRenderer === 'auto' && !capable) fallbackReasons.push('No qualified capability profile for this surface; plain Markdown selected.');
  const chunks: string[] = [];
  let mathCount = 0;
  for (const panel of panels) {
    const lines = [...commonLines(panel), ...await panelLines(panel, width, fallbackReasons)];
    const panelBudget = Math.max(128, Math.floor((maxBytes - 256) / panels.length));
    if (format === 'markdown') {
      const identity = `${markdownEscape(panel.title)} · ${markdownEscape(panel.runId)} · ${markdownEscape(panel.observedAt)}`;
      const summary = useMath ? mathSummary(panel, { ...options, width }) : {};
      if (summary.fallbackReason) fallbackReasons.push(summary.fallbackReason);
      // Math is atomic: omit an oversized fragment rather than cutting its syntax.
      const math = summary.math && Buffer.byteLength(summary.math) < panelBudget / 2 ? summary.math : '';
      if (summary.math && !math) fallbackReasons.push(`${panel.kind}: report budget requires plain output.`);
      const plain = box(panel.title, lines, width, false);
      const reserved = Buffer.byteLength(identity + math) + 128;
      const fitted = fitPlain(plain, Math.max(64, panelBudget - reserved));
      if (fitted.truncated) { base.truncated = true; continuation.push(`${panel.kind}: --page-size 1 (full frame ${frameId})`); }
      const fenced = boundedFence(fitted.output, Math.max(128, panelBudget - Buffer.byteLength(identity + math) - 8));
      if (fenced.truncated) base.truncated = true;
      chunks.push(`${identity}\n\n${math ? `${math}\n\n` : ''}${fenced.output}`);
      if (math) mathCount++;
    } else {
      // Limit in plain form first: cutting ANSI bytes could leave an unterminated control sequence.
      const plain = box(panel.title, lines, width, false);
      const fitted = fitPlain(plain, panelBudget);
      if (fitted.truncated) { base.truncated = true; chunks.push(fitted.output); continuation.push(`${panel.kind}: --page-size 1 (full frame ${frameId})`); }
      else chunks.push(box(panel.title, lines, width, format === 'ansi' && !options.noColor));
    }
  }
  base.output = chunks.join('\n\n');
  if (format === 'markdown' && mathCount) base.usedRenderer = mathCount === panels.length ? 'katex' : 'hybrid';
  if (base.truncated) fallbackReasons.push('Report size budget reached; omitted content is labelled. Request individual panels with smaller pages.');
  // ANSI overhead or unusually long identities must never defeat the byte budget.
  if (Buffer.byteLength(base.output) > maxBytes) {
    if (format === 'markdown') {
      base.output = boundedFence(cleanText(chunks.join('\n\n')), maxBytes).output;
      base.usedRenderer = 'plain';
    } else { base.output = fitPlain(cleanText(base.output), maxBytes).output; base.usedRenderer = 'plain'; }
    base.truncated = true;
    fallbackReasons.push('Final size guard selected bounded plain output.');
  }
  return base;
}
