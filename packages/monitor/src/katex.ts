// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { MonitorPanel } from '@graphloom/sdk';
import { cleanText, toneFor } from './cells.js';
import type { Tone } from './cells.js';
import { numeric } from './chart.js';
import type { RenderOptions } from './types.js';

const palette: Record<Tone, string> = { neutral: '#617482', good: '#33804d', active: '#3377bb', warning: '#997000', error: '#bb4444', muted: '#617482' };
const escapes: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
export function escapeTex(value: string): string { return cleanText(value).replace(/\n/g, ' ').replace(/[\\{}$%&#_^~]/g, character => escapes[character]!); }

/** Fixed syntax only: graph-controlled text can never create a command, macro or resource request. */
export function mathSummary(panel: MonitorPanel, options: RenderOptions): { math?: string; fallbackReason?: string } {
  const rows: Array<{ text: string; tone: Tone }> = [{ text: panel.title, tone: 'neutral' }];
  const add = (text: string, tone: Tone = 'neutral'): void => { rows.push({ text: cleanText(text).replace(/\n/g, ' '), tone }); };
  switch (panel.kind) {
    case 'overview': {
      const { run, hub } = panel.content;
      add(`Status: ${run.status}`, toneFor(run.status));
      add(`Stage: ${run.currentStage ?? 'unknown'} / attempt ${run.currentAttempt ?? 'unknown'}`);
      if (hub) add(`Slots: ${hub.occupied}/${hub.limit}; queued: ${hub.queued}`, hub.queued ? 'warning' : 'active');
      if (run.blocker) add('Blocker: see details', 'warning');
      break;
    }
    case 'topology': {
      const { topology, hiddenEdges, hiddenNodes } = panel.content;
      add(`Topology: ${topology.source}`);
      add(`Visible: ${topology.nodes.length} nodes, ${topology.edges.length} edges`);
      add(`Current: ${topology.current ?? 'unknown'}`, 'active');
      if (hiddenEdges || hiddenNodes) add(`Hidden: ${hiddenNodes} nodes, ${hiddenEdges} edges`, 'warning');
      break;
    }
    case 'stages':
      for (const stage of panel.content.stages.slice(0, 5)) add(`${stage.name ?? stage.id}: ${stage.status}; receipt ${stage.accepted === null ? 'unknown' : stage.accepted ? 'valid' : 'not valid'}`, toneFor(stage.status));
      break;
    case 'jobs':
      for (const job of panel.content.jobs.slice(0, 5)) add(`${job.label ?? job.id}: ${job.status}`, toneFor(job.status));
      if (!panel.content.available) add('Jobs: unknown', 'warning');
      break;
    case 'activity':
      for (const event of panel.content.events.slice(0, 5)) add(event.kind, toneFor(event.kind));
      if (!panel.content.available) add('Activity: unknown', 'warning');
      break;
    case 'job': {
      const job = panel.content.job;
      add(job ? `Operation: ${job.id}` : 'Operation: unknown');
      if (job) { add(`Status: ${job.status}`, toneFor(job.status)); add(`Stage: ${job.stageId}; attempt ${job.attempt}`); }
      break;
    }
    case 'usage': {
      const usage = panel.content.usage;
      if (!usage) add('Usage: unknown', 'warning');
      else for (const metric of usage.metrics.slice(0, 5)) add(`${metric.label}: ${numeric(metric.value)} ${metric.unit}`, metric.value === null ? 'warning' : 'active');
      break;
    }
    case 'output': add(`Operation: ${panel.content.selectedJob?.id ?? 'unknown'}`); add('Output: read-only plain text', 'muted'); break;
  }
  const maxColumns = Math.max(12, Math.min(64, options.capabilityProfile?.maxColumns ?? Math.min(48, options.width ?? 48)));
  // Unicode remains fully available in plain details; do not depend on host font fallback inside math.
  if (rows.some(row => /[^\x20-\x7e]/.test(row.text))) return { fallbackReason: `${panel.kind}: unsupported math glyph; plain detail retained.` };
  if (rows.some(row => row.text.length > maxColumns)) return { fallbackReason: `${panel.kind}: summary exceeds qualified math width; plain detail retained.` };
  const math = `\\boxed{\\begin{array}{l}${rows.map(row => {
    const text = `\\texttt{${escapeTex(row.text)}}`;
    return options.noColor ? text : `\\textcolor{${palette[row.tone]}}{${text}}`;
  }).join('\\\\[3pt]')}\\end{array}}`;
  if (Buffer.byteLength(math) > Math.min(8192, options.capabilityProfile?.maxMathBytes ?? 8192)) return { fallbackReason: `${panel.kind}: math fragment exceeds size budget; plain detail retained.` };
  return { math: `$$\n${math}\n$$` };
}
