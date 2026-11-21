// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Throwaway prototype: node apps/graphloom/prototype-monitor-panels/run.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PANEL_KINDS, makeSnapshot, renderPanel } from './panels.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const scenario = option('--state', 'running');
const width = Number(option('--width', '76'));
const snapshot = makeSnapshot(scenario);
const chosen = option('--panel', 'all');
const panels = PANEL_KINDS.filter(({ id }) => chosen === 'all' || chosen === id);
const rendered = panels.map(({ id }) => renderPanel(id, snapshot, { width, selected: option('--node', 'implement') }));
const text = rendered.map(panel => panel.text).join('\n\n');
if (args.includes('--plain') && args.includes('--ansi')) throw new Error('Choose --plain or --ansi, not both.');
if (args.includes('--plain') || args.includes('--ansi')) {
  const outputText = args.includes('--ansi') ? rendered.map(panel => panel.ansi).join('\n\n') : text;
  process.stdout.write(`PROTOTYPE · SAMPLE DATA\n\n${outputText}\n`);
} else {
  const output = path.join(here, 'output');
  await mkdir(output, { recursive: true });
  const [template, renderer, adapter] = await Promise.all(['template.html','panels.mjs','preview.mjs'].map(name => readFile(path.join(here, name), 'utf8')));
  const browserRenderer = renderer.replace(/^export\s+/gm, '');
  const fragment = template.replace('// __PANEL_RENDERER__', () => browserRenderer).replace('// __PREVIEW_ADAPTER__', () => adapter);
  await writeFile(path.join(output, 'graphloom-panels.html'), fragment);
  await writeFile(path.join(output, 'panels.txt'), `PROTOTYPE · SAMPLE DATA\n\n${text}\n`);
  await writeFile(path.join(output, 'sample.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Rendered ${panels.length} sample panels.\n${path.join(output, 'graphloom-panels.html')}\n${path.join(output, 'panels.txt')}`);
}
