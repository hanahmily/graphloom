// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

// Throwaway review fixture: no controller, telemetry, or chat transport is wired up.
// The cell layout below is hand-placed for these six nodes. It does not qualify
// ELK or provide a general topology layout algorithm. No Troupe code is copied.

export const PANEL_KINDS = [
  { id: 'overview', title: 'Overview' },
  { id: 'topology', title: 'Topology' },
  { id: 'stages', title: 'Stages & outcomes' },
  { id: 'jobs', title: 'Jobs' },
  { id: 'activity', title: 'Activity' },
  { id: 'job', title: 'Job details' },
  { id: 'usage', title: 'Usage' },
  { id: 'output', title: 'Output' },
];

const SYMBOLS = {
  accepted: '✓', active: '●', waiting: '◷', paused: '◐',
  reentered: '↶', pending: '○', unvisited: '·', idle: '◇',
};

const TONES = {
  accepted: 'good', active: 'active', waiting: 'warn', paused: 'warn',
  reentered: 'warn', pending: 'muted', unvisited: 'muted', idle: 'muted',
};

export function makeSnapshot(scenario = 'running') {
  if (!['running', 'recovery', 'waiting', 'complete'].includes(scenario)) {
    scenario = 'running';
  }
  const complete = scenario === 'complete';
  const recovery = scenario === 'recovery';
  const waiting = scenario === 'waiting';
  const implementStatus = complete ? 'accepted' : recovery ? 'paused' : waiting ? 'waiting' : 'active';
  const nodes = [
    { id: 'spec', title: 'Spec', status: 'accepted', attempt: 1, kind: 'stage' },
    { id: 'diagnose', title: 'Diagnose', status: 'unvisited', attempt: null, kind: 'stage' },
    { id: 'implement', title: 'Implement', status: implementStatus, attempt: 3, kind: 'stage' },
    { id: 'verify', title: 'Verify', status: complete ? 'accepted' : 'reentered', attempt: complete ? 3 : 2, kind: 'stage' },
    { id: 'deliver', title: 'Deliver', status: complete ? 'accepted' : 'pending', attempt: complete ? 1 : null, kind: 'stage' },
    { id: 'arbitrate', title: 'Arbitrate', status: recovery ? 'active' : 'idle', attempt: recovery ? 1 : null, kind: 'supervisor' },
  ];
  const edges = [
    { from: 'spec', to: 'implement', kind: 'route' },
    { from: 'spec', to: 'diagnose', kind: 'route' },
    { from: 'diagnose', to: 'implement', kind: 'route' },
    { from: 'implement', to: 'verify', kind: 'route' },
    { from: 'verify', to: 'deliver', kind: 'route' },
    { from: 'verify', to: 'implement', kind: 'reentry' },
    { from: 'arbitrate', to: 'implement', kind: 'supervisor' },
    { from: 'arbitrate', to: 'verify', kind: 'supervisor' },
  ];
  const path = [
    { nodeId: 'spec', attempt: 1, status: 'accepted' },
    { nodeId: 'implement', attempt: 3, status: implementStatus },
    ...(complete ? [
      { nodeId: 'verify', attempt: 3, status: 'accepted' },
      { nodeId: 'deliver', attempt: 1, status: 'accepted' },
    ] : []),
  ];
  return {
    fixture: true,
    scenario,
    status: complete ? 'succeeded' : recovery ? 'recovering' : waiting ? 'cooldown' : 'running',
    runId: 'run-demo-042',
    observedAt: complete ? '2026-11-19T12:08:50Z' : '2026-11-19T12:04:30Z',
    startedAt: '2026-11-19T11:46:10Z',
    elapsed: complete ? '22m 40s' : '18m 20s',
    task: 'Repair stale cache invalidation',
    hub: { occupied: complete || waiting ? 1 : 2, limit: 3, queued: 2 },
    nodes,
    edges,
    path,
    current: scenario === 'running' ? { nodeId: 'implement', attempt: 3, jobId: 'job-impl-03' } : null,
    sideVisit: recovery ? { nodeId: 'arbitrate', attempt: 1, jobId: 'job-arb-01' } : null,
    resumeAt: waiting ? '12:06:00 UTC' : null,
    reason: complete
      ? 'Controller accepted the final result and delivery check.'
      : recovery
        ? 'Supervisor is investigating a validator mismatch.'
        : waiting
          ? 'Provider cooldown; automatic resume at 12:06:00 UTC.'
          : 'Implement #3 is repairing the failing cache assertion.',
    usage: {
      inputTokens: 105120, outputTokens: 43520, tokenBudget: 240000,
      contextTokens: 41800, contextLimit: 200000,
      costUsd: null, cpuPercent: complete || waiting ? 0 : 36,
      memoryMiB: complete || waiting ? 0 : 1280,
      outputRate: [12, 18, 29, 44, 61, 75, 66, null, 35, 49, 58, 68, 54, 47, 42],
      bucketSeconds: 20, windowSeconds: 300, lastRate: 42,
      rateStart: '11:59:30', rateEnd: '12:04:30',
    },
    events: [
      {
        time: complete ? '12:08:50' : '12:04:30',
        tone: complete ? 'good' : recovery || waiting ? 'warn' : 'active',
        title: complete ? 'Run succeeded' : recovery ? 'Recovery entered' : waiting ? 'Cooldown entered' : 'Implement #3 active',
        detail: complete ? 'Final result and delivery check accepted.' : recovery ? 'Arbitrate #1; execution path retained.' : waiting ? 'No active job. Resume queued for 12:06.' : 'Repairing assertion; heartbeat 2s ago.',
      },
      { time: '12:02:10', tone: 'warn', title: 'Reentered Implement', detail: 'Verify #2 rejected cache assertion.' },
      { time: '11:57:40', tone: 'muted', title: 'Verify #2 started', detail: 'Checking the previous implementation.' },
      { time: '11:48:55', tone: 'good', title: 'Spec #1 accepted', detail: 'Required cache behavior recorded.' },
    ],
  };
}

const chars = (text) => Array.from(String(text));
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);
const cells = (text, tone = '') => chars(text).map((char) => ({ char, tone }));
const join = (...parts) => parts.flatMap((part) => typeof part === 'string' ? cells(part) : part);
const padded = (line, width) => [...line.slice(0, width), ...cells(' '.repeat(Math.max(0, width - line.length)))];

function wrapped(line, width) {
  if (!line.length) return [[]];
  const result = [];
  let rest = [...line];
  while (rest.length > width) {
    let end = width;
    while (end > 0 && rest[end]?.char !== ' ') end -= 1;
    if (end === 0) end = width;
    result.push(rest.slice(0, end));
    rest = rest.slice(end);
    while (rest[0]?.char === ' ') rest.shift();
  }
  if (rest.length) result.push(rest);
  return result;
}

function toHtml(line) {
  let result = '';
  let start = 0;
  while (start < line.length) {
    const tone = line[start].tone;
    let end = start + 1;
    while (end < line.length && line[end].tone === tone) end += 1;
    const text = escapeHtml(line.slice(start, end).map((cell) => cell.char).join(''));
    result += tone ? `<span class="gl-tone-${tone}">${text}</span>` : text;
    start = end;
  }
  return result;
}

const ANSI_TONES = { muted: 90, edge: 90, good: 92, active: 96, warn: 93 };

function toAnsi(line) {
  let result = '';
  let start = 0;
  while (start < line.length) {
    const tone = line[start].tone;
    let end = start + 1;
    while (end < line.length && line[end].tone === tone) end += 1;
    const text = line.slice(start, end).map((cell) => cell.char).join('');
    result += tone ? `\u001b[${ANSI_TONES[tone]}m${text}\u001b[0m` : text;
    start = end;
  }
  return `${result}\u001b[0m`;
}

function statusCells(node, { name = true, attempt = true } = {}) {
  return cells(`${SYMBOLS[node.status]}${name ? ` ${node.title}` : ''}${attempt && node.attempt ? ` #${node.attempt}` : ''}`, TONES[node.status]);
}

function graphLines(snapshot) {
  const byId = Object.fromEntries(snapshot.nodes.map((node) => [node.id, node]));
  const lines = Array.from({ length: 8 }, () => cells(' '.repeat(60)));
  const write = (y, x, text, tone = 'edge') => {
    cells(text, tone).forEach((cell, index) => { lines[y][x + index] = cell; });
  };
  const node = (y, x, id) => {
    const value = byId[id];
    write(y, x, `[${value.title} ${SYMBOLS[value.status]}]`, TONES[value.status]);
  };
  node(0, 0, 'spec');
  node(0, 12, 'implement');
  node(0, 29, 'verify');
  node(0, 43, 'deliver');
  write(0, 8, '───▶');
  write(0, 25, '───▶');
  write(0, 39, '───▶');
  write(1, 3, '│'); write(1, 17, '▲'); write(1, 23, '▲'); write(1, 34, '│');
  write(2, 3, '│'); write(2, 17, '│'); write(2, 23, '└─reentry──┘', 'warn');
  write(3, 3, '▼'); write(3, 17, '│');
  node(4, 0, 'diagnose'); write(4, 12, '─────┘');
  node(6, 0, 'arbitrate'); write(6, 13, '┄┄┄▶ Implement  (supervisor-only)', 'muted');
  write(7, 5, '└┄┄┄┄┄┄┄┄┄┄▶ Verify     (supervisor-only)', 'muted');
  return lines.map((line) => {
    while (line.at(-1)?.char === ' ') line.pop();
    return line;
  });
}

function areaChart(snapshot, innerWidth, compact) {
  const usage = snapshot.usage;
  const count = usage.outputRate.length;
  const bucketWidth = Math.max(1, Math.min(3, Math.floor((innerWidth - 6) / count)));
  const plotWidth = count * bucketWidth;
  const height = compact ? 4 : 8;
  const step = 80 / height;
  const result = [];
  for (let y = height; y >= 1; y -= 1) {
    const upper = y * step;
    const lower = upper - step;
    const line = cells(`${String(upper).padStart(2)} ┤ `, 'muted');
    for (const value of usage.outputRate) {
      if (value === null) {
        line.push(...cells(`┆${' '.repeat(bucketWidth - 1)}`, 'warn'));
      } else {
        const fraction = Math.max(0, Math.min(1, (value - lower) / step));
        const fill = fraction === 0 ? ' ' : '▁▂▃▄▅▆▇█'[Math.ceil(fraction * 8) - 1];
        line.push(...cells(fill.repeat(bucketWidth), 'active'));
      }
    }
    result.push(line);
  }
  const axis = cells(` 0 └─${'─'.repeat(plotWidth)}`, 'muted');
  const missingIndex = usage.outputRate.indexOf(null);
  if (missingIndex >= 0) axis[5 + missingIndex * bucketWidth] = { char: '?', tone: 'warn' };
  result.push(axis);
  result.push(cells(innerWidth < 24
    ? `     ${usage.rateStart.slice(0, 5)} → ${usage.rateEnd.slice(0, 5)}`
    : `     ${usage.rateStart}${' '.repeat(Math.max(1, plotWidth - 16))}${usage.rateEnd}`, 'muted'));
  return result;
}

export function renderPanel(id, snapshot, { width = 76, selected = 'implement', compact = false } = {}) {
  const kind = PANEL_KINDS.find((panel) => panel.id === id);
  if (!kind) throw new Error(`Unknown panel: ${id}`);
  width = Math.max(24, Math.min(96, Math.floor(Number(width)) || 76));
  const innerWidth = width - 4;
  const lines = [];
  const add = (...parts) => lines.push(...wrapped(join(...parts), innerWidth));
  const gap = () => lines.push([]);
  const selectedNode = snapshot.nodes.find((node) => node.id === selected) ?? snapshot.nodes.find((node) => node.id === 'implement');
  const byId = Object.fromEntries(snapshot.nodes.map((node) => [node.id, node]));
  add(cells(`SAMPLE · ${snapshot.runId}`, 'muted'));
  add(cells(`Observed ${snapshot.observedAt.slice(11, 19)} UTC`, 'muted'));
  gap();

  if (id === 'overview') {
    add(cells(snapshot.status.toUpperCase(), snapshot.scenario === 'complete' ? 'good' : snapshot.scenario === 'running' ? 'active' : 'warn'), ` · ${snapshot.elapsed}`);
    add(snapshot.task);
    gap();
    add(`Hub slots: ${snapshot.hub.occupied}/${snapshot.hub.limit} occupied · ${snapshot.hub.queued} queued`);
    add(snapshot.reason);
    if (snapshot.scenario === 'waiting') add(cells('This run holds no slot; no active job.', 'muted'));
    if (snapshot.scenario === 'complete') add(cells('This run released its slot.', 'muted'));
  }

  if (id === 'topology') {
    if (width >= 68) {
      lines.push(...graphLines(snapshot));
    } else {
      add(cells('DIRECTED EDGES', 'muted'));
      for (const edge of snapshot.edges) {
        add(`${byId[edge.from].title} → ${byId[edge.to].title}${edge.kind === 'route' ? '' : ` [${edge.kind}]`}`);
      }
    }
    gap();
    add('Live path: ', ...snapshot.path.flatMap((entry, index) => [
      ...(index ? [cells(' → ', 'edge')] : []),
      cells(`${byId[entry.nodeId].title} #${entry.attempt}`, TONES[entry.status]),
    ]));
    if (snapshot.sideVisit) add(cells('Side visit: Arbitrate #1 (supervisor)', 'warn'));
    if (!compact) {
      add(cells('Prior Verify #2 → Implement #3 reentry.', 'muted'));
      add(cells('Diagnose is an optional, unvisited route.', 'muted'));
    }
    add(statusCells(selectedNode), ` · ${selectedNode.status}`);
    if (!compact) add(cells('✓ accepted  ● active  ○ pending  ↶ reentered', 'muted'));
    add(cells('Edges show routes; they do not imply parallel jobs.', 'muted'));
  }

  if (id === 'stages') {
    for (const node of snapshot.nodes.filter((node) => node.kind === 'stage')) {
      add(statusCells(node), ` · ${node.status}${node.id === selectedNode.id ? '  ‹ selected' : ''}`);
      if (!compact) add(cells({
        spec: '  Outcome: cache behavior specified.',
        diagnose: '  Optional branch; no execution recorded.',
        implement: snapshot.scenario === 'complete' ? '  Outcome: repaired implementation accepted.' : '  Outcome pending: repair cache assertion.',
        verify: snapshot.scenario === 'complete' ? '  Outcome: tests and checks accepted.' : '  Prior attempt rejected; reentered Implement.',
        deliver: snapshot.scenario === 'complete' ? '  Outcome: final delivery accepted.' : '  Outcome pending: final delivery check.',
      }[node.id], 'muted'));
    }
    gap();
    add(cells('Unvisited branches are not incomplete work.', 'muted'));
    add(cells('Run success comes from the controller.', 'muted'));
  }

  if (id === 'jobs') {
    const active = snapshot.sideVisit ?? snapshot.current;
    add(active ? cells(`Active: ${byId[active.nodeId].title} #${active.attempt}`, 'active') : cells('No active job', 'muted'));
    gap();
    const jobs = [
      ['job-spec-01', 'Spec #1', 'accepted', '2m 45s'],
      ['job-impl-02', 'Implement #2', 'superseded', '8m 10s'],
      ['job-verify-02', 'Verify #2', 'rejected', '4m 30s'],
      ['job-impl-03', 'Implement #3', snapshot.scenario === 'waiting' ? 'yielded' : byId.implement.status, '2m 20s'],
      ...(snapshot.sideVisit ? [['job-arb-01', 'Arbitrate #1', 'active', '0m 40s']] : []),
      ...(snapshot.scenario === 'complete' ? [
        ['job-verify-03', 'Verify #3', 'accepted', '2m 35s'],
        ['job-deliver-01', 'Deliver #1', 'accepted', '1m 45s'],
      ] : []),
    ];
    for (const [jobId, title, status, elapsed] of jobs) {
      add(cells(title, TONES[status] ?? 'muted'), ` · ${status} · ${elapsed}`);
      if (!compact) add(cells(`  ${jobId}`, 'muted'));
    }
    gap();
    add(cells('Execution history; only one job active in this fixture.', 'muted'));
  }

  if (id === 'activity') {
    add(cells('RECENT EVENTS · newest first', 'muted'));
    for (const event of snapshot.events.slice(0, compact ? 3 : 4)) {
      add(cells(event.time, 'muted'), '  ', cells(event.title, event.tone));
      add(event.detail);
      gap();
    }
    add(cells('Fixture events; not a complete audit log.', 'muted'));
  }

  if (id === 'job') {
    add(statusCells(selectedNode), ` · ${selectedNode.status}`);
    if (!selectedNode.attempt) {
      add('No attempt recorded for this node.');
      add(cells(selectedNode.kind === 'supervisor' ? 'Supervisor-only node; no active recovery.' : 'A declared route may remain unvisited.', 'muted'));
    } else {
      const jobId = { spec: 'job-spec-01', implement: 'job-impl-03', verify: `job-verify-0${selectedNode.attempt}`, deliver: 'job-deliver-01', arbitrate: 'job-arb-01' }[selectedNode.id];
      add(`Job: ${jobId}`);
      add(`Harness: ${selectedNode.kind === 'supervisor' ? 'supervisor' : 'coding agent'} · model: fixture-model`);
      gap();
      add(`Objective: ${{ spec: 'Specify required cache behavior.', implement: 'Repair stale cache invalidation.', verify: 'Validate cache behavior and run checks.', deliver: 'Verify the final delivery.', arbitrate: 'Investigate the validator mismatch.' }[selectedNode.id]}`);
      if (!compact) {
        add('Workspace: /work/cache-fix');
        add('Scope: workspace read/write; no publish');
        add(`Session: fixture-session-${selectedNode.id}`);
      }
      if (selectedNode.id === 'implement') add(cells('Previous attempt: #2 superseded after Verify #2.', 'muted'));
      if (selectedNode.id === 'arbitrate') add(cells('Side visit; live execution path is retained.', 'warn'));
    }
  }

  if (id === 'usage') {
    const usage = snapshot.usage;
    add('OUTPUT RATE · tokens/s');
    lines.push(...areaChart(snapshot, innerWidth, compact).flatMap((line) => wrapped(line, innerWidth)));
    add(cells('┆ / ? = missing bucket; no interpolation', 'warn'));
    add(`Last: ${usage.lastRate} tokens/s · 5m window · 20s buckets`);
    gap();
    const total = usage.inputTokens + usage.outputTokens;
    add(`Reported tokens: ${total.toLocaleString('en-US')} / ${usage.tokenBudget.toLocaleString('en-US')}`);
    add(cells(`${Math.round(total / usage.tokenBudget * 100)}% of token budget · usage may be partial`, 'muted'));
    if (!compact) add(`In: ${usage.inputTokens.toLocaleString('en-US')} · out: ${usage.outputTokens.toLocaleString('en-US')}`);
    add(`Context: ${usage.contextTokens.toLocaleString('en-US')} / ${usage.contextLimit.toLocaleString('en-US')} (${Math.round(usage.contextTokens / usage.contextLimit * 100)}%)`);
    add(cells('Context occupancy, not task completion.', 'muted'));
    add(`Cost: unavailable · CPU: ${usage.cpuPercent}%`);
    add(`Worker memory: ${usage.memoryMiB.toLocaleString('en-US')} MiB`);
    if (snapshot.scenario === 'waiting' || snapshot.scenario === 'complete') add(cells('Rate/context are historical; workers have exited.', 'muted'));
    else add(cells('CPU/memory: latest worker sample.', 'muted'));
  }

  if (id === 'output') {
    add(statusCells(selectedNode));
    if (!selectedNode.attempt) {
      add('No output: this node has no recorded attempt.');
    } else {
      add(cells('BOUNDED EXCERPT · sample messages', 'muted'));
      gap();
      const entries = selectedNode.id === 'implement' ? [
        ['12:03:10', 'agent', 'The stale entry survives the write path.'],
        ['12:03:25', 'tool', 'read src/cache.ts'],
        ['12:03:42', 'tool', 'update invalidation after successful write'],
        ['12:04:12', 'tool', 'run cache regression checks'],
        ['12:04:28', 'result', snapshot.scenario === 'complete' ? 'Checks passed; outcome accepted.' : 'Targeted checks running.'],
      ] : [
        ['12:03:10', 'agent', `Inspecting the ${selectedNode.title.toLowerCase()} outcome.`],
        ['12:03:25', 'tool', 'read recorded evidence'],
        ['12:04:28', 'result', selectedNode.status === 'accepted' ? 'Outcome accepted.' : 'Investigation in progress.'],
      ];
      for (const [time, type, message] of entries.slice(compact ? -3 : 0)) {
        add(cells(`${time} ${type}`, type === 'tool' ? 'active' : 'muted'));
        add(message);
      }
      gap();
      add(cells('Messages and tool results; no private reasoning.', 'muted'));
      add(cells('Excerpt is not the authoritative run state.', 'muted'));
    }
  }

  const title = ` ${kind.title.toUpperCase()} `;
  const top = join(cells('┌─', 'edge'), cells(title), cells(`${'─'.repeat(Math.max(0, width - title.length - 3))}┐`, 'edge'));
  const rows = [top];
  for (const line of lines) rows.push(join(cells('│ ', 'edge'), padded(line, innerWidth), cells(' │', 'edge')));
  rows.push(cells(`└${'─'.repeat(width - 2)}┘`, 'edge'));
  return {
    id,
    title: kind.title,
    text: rows.map((line) => line.map((cell) => cell.char).join('')).join('\n'),
    html: rows.map(toHtml).join('\n'),
    ansi: rows.map(toAnsi).join('\n'),
  };
}
