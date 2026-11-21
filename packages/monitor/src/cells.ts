// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

import stringWidth from 'string-width';

export type Tone = 'neutral' | 'good' | 'active' | 'warning' | 'error' | 'muted';
export interface Cell { text: string; tone: Tone; continuation?: boolean }
export interface Line { text: string; tone?: Tone }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Child output is data, including OSC hyperlinks, CSI commands, C1 controls and bidi overrides. */
export function cleanText(value: string): string {
  return value
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)/g, '')
    .replace(/\u001b[P^_X][\s\S]*?(?:\u001b\\|$)/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '    ');
}

export function widthOf(value: string): number { return stringWidth(cleanText(value)); }
export function graphemes(value: string): string[] { return Array.from(segmenter.segment(value), part => part.segment); }

export function clipText(value: string, width: number): string {
  const text = cleanText(value).replace(/\n/g, ' ');
  if (widthOf(text) <= width) return text;
  let result = '';
  for (const piece of graphemes(text)) {
    if (widthOf(result + piece) > Math.max(0, width - 1)) break;
    result += piece;
  }
  return width > 0 ? `${result}…` : '';
}

export function wrapText(value: string, width: number): string[] {
  if (width < 2) throw new Error('Text wrapping needs at least two cells');
  const lines: string[] = [];
  for (const logical of cleanText(value).split('\n')) {
    let line = '';
    let used = 0;
    for (const piece of graphemes(logical)) {
      const size = stringWidth(piece);
      if (used + size > width && line) { lines.push(line); line = ''; used = 0; }
      line += piece; used += size;
    }
    lines.push(line);
  }
  return lines;
}

export function toneFor(status: string): Tone {
  if (/^(accepted|succeeded|success|complete|completed|valid)$/.test(status)) return 'good';
  if (/^(running|active|in-progress)$/.test(status)) return 'active';
  if (/^(failed|error|invalid|cancelled)$/.test(status)) return 'error';
  if (/^(waiting|paused|queued|pending|stale|blocked|unknown)$/.test(status)) return 'warning';
  return 'neutral';
}

const ansi: Record<Tone, string> = { neutral: '', good: '\u001b[32m', active: '\u001b[36m', warning: '\u001b[33m', error: '\u001b[31m', muted: '\u001b[90m' };
export function colorize(value: string, tone: Tone, color: boolean): string {
  return color && ansi[tone] ? `${ansi[tone]}${value}\u001b[0m` : value;
}

/** Cell canvas understands grapheme widths; wide glyph continuation cells cannot be overwritten. */
export class Canvas {
  readonly cells: Cell[][];
  constructor(readonly width: number, readonly height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 100_000) throw new Error('Canvas bounds exceeded');
    this.cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: ' ', tone: 'neutral' })));
  }
  put(x: number, y: number, value: string, tone: Tone = 'neutral'): boolean {
    const row = this.cells[y];
    if (!row || x < 0 || !Number.isInteger(x)) return false;
    let column = x;
    for (const part of graphemes(cleanText(value).replace(/\n/g, ' '))) {
      const size = stringWidth(part);
      if (column + size > this.width || row[column]?.continuation) return false;
      if (size === 0) { if (column > 0 && row[column - 1]) row[column - 1]!.text += part; continue; }
      // Replacing a wide glyph must release its old continuation cells.
      for (let target = column; target < column + size; target++) {
        let tail = target + 1;
        while (row[tail]?.continuation) { row[tail] = { text: ' ', tone: 'neutral' }; tail++; }
      }
      row[column] = { text: part, tone };
      for (let i = 1; i < size; i++) row[column + i] = { text: '', tone, continuation: true };
      column += size;
    }
    return true;
  }
  lines(color = false): string[] {
    return this.cells.map(row => {
      let out = ''; let run = ''; let tone: Tone = 'neutral';
      for (const cell of row) {
        if (cell.continuation) continue;
        if (cell.tone !== tone) { out += colorize(run, tone, color); run = ''; tone = cell.tone; }
        run += cell.text;
      }
      return out + colorize(run, tone, color);
    });
  }
}

export function box(title: string, lines: Line[], width: number, color: boolean): string {
  const inner = width - 4;
  const heading = ` ${clipText(title, width - 6)} `;
  const top = `┌${heading}${'─'.repeat(Math.max(0, width - 2 - widthOf(heading)))}┐`;
  return [top, ...lines.flatMap(line => wrapText(line.text, inner).map(part => `│ ${colorize(part, line.tone ?? 'neutral', color)}${' '.repeat(Math.max(0, inner - widthOf(part)))} │`)), `└${'─'.repeat(width - 2)}┘`].join('\n');
}
