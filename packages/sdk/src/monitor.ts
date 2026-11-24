// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Hongtao Gao and the GraphLoom contributors

/** Read-only monitoring values. These are not controller observations or acceptance evidence. */
export type MonitorPanelKind = 'overview' | 'topology' | 'stages' | 'jobs' | 'activity' | 'job' | 'usage' | 'output';

export interface MonitorSource {
  id: string;
  status: 'available' | 'stale' | 'unavailable';
  observedAt: string | null;
  revision?: string;
  detail?: string;
}

export interface MonitorRun {
  id: string;
  status: string;
  graph?: string;
  submissionId?: string;
  controllerRevision?: string;
  currentStage?: string | null;
  currentAttempt?: number | null;
  blocker?: string | null;
  nextEligibleAt?: string | null;
}

export interface MonitorHub {
  occupied: number;
  limit: number;
  queued: number;
  state?: string;
  observationId?: string;
  /** A rehearsal submission's one-line summary: its settings and recorded verdict. */
  rehearsal?: string;
}

export interface MonitorStage {
  id: string;
  name?: string;
  status: string;
  /** null means the owning runtime did not report receipt validity. */
  accepted: boolean | null;
  attempt?: number | null;
  requirement?: string;
  path?: 'on-path' | 'off-path' | 'unknown';
  entry?: 'normal' | 'supervisor';
  visits?: number | null;
  maxVisits?: number | null;
}

/** A structural projection of the owning SDK topology, not a second graph declaration. */
export interface MonitorTopology {
  revision: string;
  source: 'declared' | 'implicit' | 'legacy';
  nodes: Array<{ id: string; label?: string; entry?: 'normal' | 'supervisor'; maxVisits?: number | null }>;
  edges: Array<{ id: string; from: string; to: string }>;
  start?: string | null;
  terminal?: string[];
  path?: Array<{ stageId: string; visit?: number; attempt?: number }>;
  current?: string | null;
  sideVisit?: { stageId: string; visit?: number; reason?: string } | null;
}

export interface MonitorJob {
  id: string;
  stageId: string;
  attempt: number;
  status: string;
  label?: string;
  harness?: string;
  executor?: string;
  model?: string;
  instruction?: string;
  scope?: string[];
  workspace?: string;
  evidence?: string[];
  sessions?: string[];
}

export interface MonitorActivity {
  id: string;
  observedAt: string;
  kind: string;
  summary: string;
  evidence?: string[];
}

export interface MonitorMetric {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  source: string;
  exactness?: 'reported' | 'estimated' | 'settled';
  window?: { from: string; to: string };
}

export interface MonitorSeries {
  id: string;
  label: string;
  unit: string;
  source: string;
  /** null is a gap; never interpolate through it. Rates are weighted by time. */
  samples: Array<{ at: string; value: number | null }>;
  aggregation: 'time-weighted' | 'mean' | 'max';
  window?: { from: string; to: string };
  coverage?: string;
}

export interface MonitorUsage {
  metrics: MonitorMetric[];
  budgets?: Array<{ label: string; used: number | null; limit: number | null; unit: string }>;
  series?: MonitorSeries[];
  context?: { used: number | null; limit: number | null; sessionId: string; observedAt: string };
  coverage?: string;
}

export interface MonitorOutput {
  operationId: string;
  attempt: number;
  sequence: number;
  observedAt: string;
  kind: 'message' | 'tool' | 'log' | 'gap';
  text: string;
}

export interface MonitorSnapshot {
  schemaVersion: 1;
  frameId: string;
  observedAt: string;
  run: MonitorRun;
  sources: MonitorSource[];
  hub?: MonitorHub;
  topology?: MonitorTopology;
  stages?: MonitorStage[];
  jobs?: MonitorJob[];
  activity?: MonitorActivity[];
  usage?: MonitorUsage;
  output?: MonitorOutput[];
}

export interface PanelSelection {
  kinds?: MonitorPanelKind[];
  stageId?: string;
  operationId?: string;
  attempt?: number;
  followCurrent?: boolean;
  /** Opaque continuation returned by a previous projection of this same view. */
  cursor?: string;
  pageSize?: number;
}

export interface MonitorPage {
  total: number;
  offset: number;
  shown: number;
  omitted: number;
  nextCursor?: string;
  notice?: string;
}

export interface MonitorPanelBase {
  kind: MonitorPanelKind;
  frameId: string;
  runId: string;
  observedAt: string;
  title: string;
  sources: MonitorSource[];
  selection: PanelSelection;
}

export interface OverviewPanel extends MonitorPanelBase {
  kind: 'overview';
  content: { run: MonitorRun; hub: MonitorHub | null };
}
export interface TopologyPanel extends MonitorPanelBase {
  kind: 'topology';
  content: {
    topology: MonitorTopology;
    stages: MonitorStage[];
    /** Every declared node and edge appears on exactly one page of these items. */
    items: Array<{ kind: 'node'; id: string } | { kind: 'edge'; id: string; from: string; to: string }>;
    page: MonitorPage;
    hiddenNodes: number;
    hiddenEdges: number;
    missingEndpoints: string[];
  };
}
export interface StagesPanel extends MonitorPanelBase {
  kind: 'stages'; content: { stages: MonitorStage[]; page: MonitorPage; available: boolean };
}
export interface JobsPanel extends MonitorPanelBase {
  kind: 'jobs'; content: { jobs: MonitorJob[]; page: MonitorPage; available: boolean };
}
export interface ActivityPanel extends MonitorPanelBase {
  kind: 'activity'; content: { events: MonitorActivity[]; page: MonitorPage; available: boolean };
}
export interface JobPanel extends MonitorPanelBase {
  kind: 'job'; content: { job: MonitorJob | null; reason: string | null; followingCurrent: boolean };
}
export interface UsagePanel extends MonitorPanelBase {
  kind: 'usage'; content: { usage: MonitorUsage | null; page: MonitorPage };
}
export interface OutputPanel extends MonitorPanelBase {
  kind: 'output'; content: { entries: MonitorOutput[]; page: MonitorPage; available: boolean; selectedJob: MonitorJob | null; notice: string | null };
}
export type MonitorPanel = OverviewPanel | TopologyPanel | StagesPanel | JobsPanel | ActivityPanel | JobPanel | UsagePanel | OutputPanel;
