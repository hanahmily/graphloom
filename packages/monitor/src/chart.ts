// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import type { MonitorSeries } from '@graphloom/sdk';
import type { Line } from './cells.js';

export interface AreaChart { lines: Line[]; buckets: Array<number | null>; range: { min: number; max: number } | null; gaps: number }
export function numeric(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'unknown' : String(value);
}

/** Area values are quantitative. A missing bucket is explicit and never filled from its neighbours. */
export function areaChart(series: MonitorSeries, width: number, height = 4): AreaChart {
  const columns = Math.max(2, Math.min(160, Math.trunc(width)));
  const rows = Math.max(2, Math.min(12, Math.trunc(height)));
  const points = series.samples.map((sample, order) => ({ at: Date.parse(sample.at), value: sample.value !== null && Number.isFinite(sample.value) ? sample.value : null, order }))
    .filter(point => Number.isFinite(point.at)).sort((a, b) => a.at - b.at || a.order - b.order);
  // At equal timestamps the last observation supersedes the earlier sample, including a gap.
  const samples = points.filter((point, i) => points[i + 1]?.at !== point.at);
  const first = samples[0]; const last = samples.at(-1);
  const from = series.window ? Date.parse(series.window.from) : first?.at;
  const to = series.window ? Date.parse(series.window.to) : last?.at;
  if (!first || !last || from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return { lines: [{ text: `${series.label}: unknown ${series.unit}; no valid samples`, tone: 'warning' }], buckets: [], range: null, gaps: 0 };
  }
  const measured = samples.filter(sample => sample.at >= from && sample.at <= to && sample.value !== null).map(sample => sample.value!);
  const range = measured.length ? measured.reduce((range, value) => ({ min: Math.min(range.min, value), max: Math.max(range.max, value) }), { min: Infinity, max: -Infinity }) : null;
  const buckets: Array<number | null> = [];
  const span = to - from;
  for (let column = 0; column < columns; column++) {
    const low = from + span * column / columns; const high = from + span * (column + 1) / columns;
    if (span === 0) { buckets.push(column === columns - 1 ? last.value : null); continue; }
    if (series.aggregation !== 'time-weighted') {
      const entries = samples.filter(sample => sample.at >= low && (sample.at < high || column === columns - 1 && sample.at === high));
      if (!entries.length || entries.some(entry => entry.value === null)) buckets.push(null);
      else {
        const values = entries.map(entry => entry.value!);
        buckets.push(series.aggregation === 'max' ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0) / values.length);
      }
      continue;
    }
    let weighted = 0; let covered = 0; let gap = false;
    for (let i = 0; i < samples.length - 1; i++) {
      const sample = samples[i]!; const next = samples[i + 1]!;
      const duration = Math.max(0, Math.min(high, next.at) - Math.max(low, sample.at));
      if (!duration) continue;
      if (sample.value === null || next.value === null) gap = true;
      else { weighted += sample.value * duration; covered += duration; }
    }
    buckets.push(gap || covered < (high - low) * 0.999999 ? null : weighted / covered);
  }
  const domainMin = Math.min(0, range?.min ?? 0);
  const domainMax = Math.max(0, range?.max ?? 1);
  const scale = domainMax - domainMin || 1;
  const zero = Math.round((domainMax - 0) / scale * (rows - 1));
  const plot = Array.from({ length: rows }, (_, row) => buckets.map(value => {
    if (value === null) return '·';
    const level = Math.round((domainMax - value) / scale * (rows - 1));
    if (row === zero && value === 0) return '─';
    return row >= Math.min(level, zero) && row <= Math.max(level, zero) ? '█' : ' ';
  }).join(''));
  const gaps = buckets.filter(value => value === null).length;
  return { buckets, range, gaps, lines: [
    { text: `${series.label}: last ${numeric(last.value)} ${series.unit}; range ${numeric(range?.min)}..${numeric(range?.max)}` },
    { text: `${new Date(from).toISOString()} -> ${new Date(to).toISOString()}`, tone: 'muted' },
    { text: `scale ${numeric(domainMin)}..${numeric(domainMax)} ${series.unit}; baseline 0; ${series.aggregation}` },
    ...plot.map(text => ({ text, tone: 'active' as const })),
    { text: `gaps ${gaps}/${columns} columns (·); source ${series.source}${series.coverage ? `; coverage ${series.coverage}` : ''}`, tone: gaps ? 'warning' : 'muted' },
  ] };
}
